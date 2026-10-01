import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine, type AudioDeviceInfo } from '../audio/engine';
import { PttController, type PttStatus } from '../radio/ptt';
import { MODES, frameSeconds, type ModeId } from '../protocols/modes';
import { CallsignHashTable } from '../protocols/message77';
import { ftxEncodeAudio } from '../protocols/ftx';
import { js8EncodeText, js8EncodeTones } from '../protocols/js8';
import { synthesize } from '../protocols/modem';
import type { DecodedMessage, ModeDetection, SignalSighting, SlotResult } from '../engine/decodeSlot';
import { chooseMode, type Conditions, type ModeChoice } from '../engine/modeSelect';
import { appendLog, loadLog, loadSettings, saveSettings, type LogEntry, type Settings } from '../state/settings';
import type { StreamMetrics } from '../dsp/pipeline';

export interface TxState {
  active: boolean;
  mode: ModeId | null;
  message: string;
  startedAt: number | null;
  endsAt: number | null;
  queued: { text: string; frames: number } | null;
  scheduledFor: number | null;
  error: string | null;
}

export interface EngineState {
  rxActive: boolean;
  starting: boolean;
  error: string | null;
  metrics: StreamMetrics | null;
  decodes: DecodedMessage[];
  detections: Record<string, ModeDetection>;
  signals: SignalSighting[];
  diagnostics: string[];
  lastSlot: SlotResult | null;
  slotCount: number;
  cpuMs: number;
}

const MAX_DECODES = 500;

export function useRadioEngine() {
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [engineState, setEngineState] = useState<EngineState>({
    rxActive: false,
    starting: false,
    error: null,
    metrics: null,
    decodes: [],
    detections: {},
    signals: [],
    diagnostics: [],
    lastSlot: null,
    slotCount: 0,
    cpuMs: 0,
  });
  const [tx, setTx] = useState<TxState>({
    active: false,
    mode: null,
    message: '',
    startedAt: null,
    endsAt: null,
    queued: null,
    scheduledFor: null,
    error: null,
  });
  const [pttStatus, setPttStatus] = useState<PttStatus>({
    mode: 'vox',
    keyed: false,
    available: true,
    detail: 'VOX — the radio keys on transmit audio',
  });
  const [log, setLog] = useState<LogEntry[]>(() => loadLog());

  const audioRef = useRef<AudioEngine | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pttRef = useRef<PttController | null>(null);
  const hashesRef = useRef(new CallsignHashTable());
  const txTimerRef = useRef<number | null>(null);
  const txAbortedRef = useRef(false);
  const txQueueRef = useRef<{ audio: Float32Array; text: string; mode: ModeId }[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  if (!audioRef.current) audioRef.current = new AudioEngine();
  if (!pttRef.current) {
    pttRef.current = new PttController();
    pttRef.current.onChange = (s) => setPttStatus(s);
  }

  const setSettings = useCallback((update: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettingsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      saveSettings(next);
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Worker plumbing                                                   */
  /* ---------------------------------------------------------------- */

  const postOptions = useCallback(() => {
    const s = settingsRef.current;
    const modes: ModeId[] =
      s.mode === 'AUTO' ? (s.allowFt2 ? [...s.decodeModes, 'FT2'] : s.decodeModes) : [s.mode];
    workerRef.current?.postMessage({
      type: 'options',
      options: {
        modes,
        dsp: s.dsp,
        osdOrder: s.osdOrder,
        maxCandidates: s.maxCandidates,
        minHz: s.minHz,
        maxHz: s.maxHz,
        enabled: true,
      },
    });
  }, []);

  useEffect(() => {
    postOptions();
  }, [settings.mode, settings.dsp, settings.osdOrder, settings.maxCandidates, settings.minHz, settings.maxHz, settings.decodeModes, settings.allowFt2, postOptions]);

  const handleSlot = useCallback((result: SlotResult) => {
    setEngineState((prev) => {
      const byKey = new Map(prev.decodes.map((d) => [`${d.mode}|${d.text}|${Math.round(d.frequency / 10)}`, d]));
      const fresh: DecodedMessage[] = [];
      for (const d of result.decodes) {
        const key = `${d.mode}|${d.text}|${Math.round(d.frequency / 10)}`;
        const existing = byKey.get(key);
        if (existing && result.slotStartMs - existing.timeMs < 5 * 60 * 1000) {
          existing.repeats += 1;
          existing.timeMs = d.timeMs;
          existing.snr = d.snr;
        } else {
          fresh.push(d);
        }
      }
      const decodes = [...prev.decodes, ...fresh].slice(-MAX_DECODES);

      // A wide-band FSK signal trips the sync detector of several modes at
      // once. If another mode actually decoded the same carrier, say so
      // instead of reporting a phantom "detected but failed" signal.
      const recent = decodes.filter((d) => Math.abs(d.timeMs - result.slotStartMs) < 20000);
      const explainedBy = (mode: ModeId, hz: number): ModeId | undefined =>
        recent.find((d) => d.mode !== mode && Math.abs(d.frequency - hz) < 30)?.mode;

      const detections = { ...prev.detections };
      for (const det of result.detections) {
        detections[det.mode] = det.decodes
          ? det
          : { ...det, explainedBy: explainedBy(det.mode, det.bestFrequency) };
      }
      const selfExplained =
        !result.decodes.length &&
        result.detections.some((d) => explainedBy(d.mode, d.bestFrequency) !== undefined);
      const diagnostics = selfExplained
        ? result.diagnostics.filter((line) => !/synchronization\/decoding failed|below the decode threshold/.test(line))
        : result.diagnostics;
      return {
        ...prev,
        decodes,
        detections,
        signals: [...result.signals, ...prev.signals.filter((s) => s.mode !== result.mode)].slice(0, 40),
        diagnostics,
        lastSlot: result,
        slotCount: prev.slotCount + 1,
        cpuMs: result.elapsedMs,
      };
    });

    if (result.decodes.length) {
      const entries: LogEntry[] = result.decodes.map((d) => ({
        id: `${d.id}-${Math.random().toString(36).slice(2, 7)}`,
        timeMs: d.timeMs,
        direction: 'rx' as const,
        mode: d.mode,
        frequency: d.frequency,
        snr: d.snr,
        text: d.text,
        callsign: d.callDe,
      }));
      setLog(appendLog(entries));
    }
  }, []);

  const startRx = useCallback(async () => {
    setEngineState((s) => ({ ...s, starting: true, error: null }));
    try {
      const audio = audioRef.current!;
      await audio.startRx(settingsRef.current.inputDeviceId);
      await audio.setOutputDevice(settingsRef.current.outputDeviceId);

      if (!workerRef.current) {
        workerRef.current = new Worker(new URL('../worker/rx.worker.ts', import.meta.url), { type: 'module' });
        workerRef.current.onmessage = (ev) => {
          const msg = ev.data;
          if (msg.type === 'slot') handleSlot(msg.result as SlotResult);
          else if (msg.type === 'metrics') setEngineState((s) => ({ ...s, metrics: msg.metrics }));
          else if (msg.type === 'error') setEngineState((s) => ({ ...s, error: msg.message }));
        };
      }
      workerRef.current.postMessage({
        type: 'init',
        sampleRate: audio.sampleRate,
        options: {
          modes:
            settingsRef.current.mode === 'AUTO'
              ? settingsRef.current.decodeModes
              : [settingsRef.current.mode],
          dsp: settingsRef.current.dsp,
          osdOrder: settingsRef.current.osdOrder,
          maxCandidates: settingsRef.current.maxCandidates,
          minHz: settingsRef.current.minHz,
          maxHz: settingsRef.current.maxHz,
          enabled: true,
        },
      });
      audio.onChunk = (chunk, time) => {
        workerRef.current?.postMessage({ type: 'audio', samples: chunk, time }, [chunk.buffer]);
      };
      const list = await AudioEngine.listDevices();
      setDevices(list);
      setEngineState((s) => ({ ...s, rxActive: true, starting: false }));
    } catch (err) {
      setEngineState((s) => ({ ...s, starting: false, error: (err as Error).message, rxActive: false }));
    }
  }, [handleSlot]);

  const stopRx = useCallback(async () => {
    await audioRef.current?.stopRx();
    setEngineState((s) => ({ ...s, rxActive: false }));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => workerRef.current?.postMessage({ type: 'tick' }), 500);
    return () => window.clearInterval(id);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await AudioEngine.listDevices();
      setDevices(list);
    } catch {
      /* permissions not granted yet */
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Automatic mode selection                                          */
  /* ---------------------------------------------------------------- */

  const conditions: Conditions = useMemo(() => {
    const recent = engineState.decodes.slice(-20);
    const snrs = recent.map((d) => d.snr).sort((a, b) => a - b);
    const activity: Partial<Record<ModeId, number>> = {};
    for (const d of recent) activity[d.mode] = (activity[d.mode] ?? 0) + 1;
    return {
      medianSnr: snrs.length ? snrs[Math.floor(snrs.length / 2)] : null,
      fadingDb: engineState.lastSlot?.report.fadingDb ?? 0,
      clipPercent: engineState.metrics?.clipPercent ?? 0,
      levelDb: engineState.metrics?.levelDb ?? -60,
      activity,
      allowFt2: settings.allowFt2,
    };
  }, [engineState.decodes, engineState.lastSlot, engineState.metrics, settings.allowFt2]);

  const autoChoice: ModeChoice = useMemo(
    () => chooseMode(settings.purpose, conditions),
    [settings.purpose, conditions],
  );

  const activeMode: ModeId = settings.mode === 'AUTO' ? autoChoice.mode : settings.mode;

  /* ---------------------------------------------------------------- */
  /* Transmit                                                          */
  /* ---------------------------------------------------------------- */

  const buildTransmission = useCallback(
    (text: string, mode: ModeId) => {
      const audio = audioRef.current!;
      const rate = audio.sampleRate;
      const spec = MODES[mode];
      const freq = settingsRef.current.txFrequency;
      if (spec.family === 'JS8') {
        const { frames } = js8EncodeText(text);
        return frames.map((f, i) => ({
          audio: synthesize(js8EncodeTones(f, spec), spec, { sampleRate: rate, baseFrequency: freq, amplitude: 0.85 }),
          text: frames.length > 1 ? `${text} [frame ${i + 1}/${frames.length}]` : text,
          mode,
        }));
      }
      const res = ftxEncodeAudio(text, spec, hashesRef.current, rate, freq, 0.85);
      if (!res) return null;
      return [{ audio: res.audio, text: res.sent, mode }];
    },
    [],
  );

  const stopTx = useCallback(async () => {
    txAbortedRef.current = true;
    if (txTimerRef.current) {
      window.clearTimeout(txTimerRef.current);
      txTimerRef.current = null;
    }
    txQueueRef.current = [];
    audioRef.current?.stopTx();
    await pttRef.current?.key(false);
    setTx((t) => ({ ...t, active: false, startedAt: null, endsAt: null, queued: null, scheduledFor: null, mode: null }));
  }, []);

  const runTransmission = useCallback(
    async (item: { audio: Float32Array; text: string; mode: ModeId }) => {
      const s = settingsRef.current;
      const duration = item.audio.length / (audioRef.current?.sampleRate ?? 48000);
      if (duration > s.maxTxSeconds) {
        setTx((t) => ({ ...t, error: `Transmission (${duration.toFixed(1)} s) exceeds the ${s.maxTxSeconds} s limit` }));
        return;
      }
      setTx((t) => ({
        ...t,
        active: true,
        mode: item.mode,
        message: item.text,
        startedAt: Date.now(),
        endsAt: Date.now() + duration * 1000,
        scheduledFor: null,
        error: null,
      }));
      txAbortedRef.current = false;
      await pttRef.current?.key(true);
      // hard safety cut-off
      txTimerRef.current = window.setTimeout(() => {
        void stopTx();
      }, Math.min(s.maxTxSeconds, duration + 1.5) * 1000);
      try {
        await audioRef.current?.play(item.audio, s.txLevel);
      } finally {
        if (txTimerRef.current) {
          window.clearTimeout(txTimerRef.current);
          txTimerRef.current = null;
        }
        await pttRef.current?.key(false);
        setLog(
          appendLog([
            {
              id: `tx-${Date.now()}`,
              timeMs: Date.now(),
              direction: 'tx',
              mode: item.mode,
              frequency: settingsRef.current.txFrequency,
              snr: null,
              text: txAbortedRef.current ? `${item.text}  [stopped early]` : item.text,
              callsign: settingsRef.current.callsign,
            },
          ]),
        );
        setTx((t) => ({ ...t, active: false, startedAt: null, endsAt: null }));
        // send the next queued frame (JS8 multi-frame messages)
        const next = txQueueRef.current.shift();
        if (next) scheduleTransmission(next);
        else setTx((t) => ({ ...t, queued: null }));
      }
    },
    [stopTx],
  );

  const scheduleTransmission = useCallback(
    (item: { audio: Float32Array; text: string; mode: ModeId }) => {
      const spec = MODES[item.mode];
      const slot = spec.slotSeconds * 1000;
      const now = Date.now();
      const nextSlot = Math.ceil(now / slot) * slot + spec.startDelay * 1000;
      const wait = Math.max(0, nextSlot - now);
      setTx((t) => ({ ...t, scheduledFor: nextSlot, mode: item.mode, message: item.text, error: null }));
      txTimerRef.current = window.setTimeout(() => {
        void runTransmission(item);
      }, wait);
    },
    [runTransmission],
  );

  const transmit = useCallback(
    (text: string, modeOverride?: ModeId) => {
      const mode = modeOverride ?? activeMode;
      const built = buildTransmission(text, mode);
      if (!built || built.length === 0) {
        setTx((t) => ({ ...t, error: 'Message cannot be encoded in this mode' }));
        return;
      }
      txQueueRef.current = built.slice(1);
      setTx((t) => ({ ...t, queued: { text, frames: built.length } }));
      scheduleTransmission(built[0]);
    },
    [activeMode, buildTransmission, scheduleTransmission],
  );

  /** Immediate (unaligned) transmission — useful for tuning and tests. */
  const transmitNow = useCallback(
    (text: string, modeOverride?: ModeId) => {
      const mode = modeOverride ?? activeMode;
      const built = buildTransmission(text, mode);
      if (!built) {
        setTx((t) => ({ ...t, error: 'Message cannot be encoded in this mode' }));
        return;
      }
      txQueueRef.current = built.slice(1);
      void runTransmission(built[0]);
    },
    [activeMode, buildTransmission, runTransmission],
  );

  const playTone = useCallback(
    async (seconds = 3) => {
      const audio = audioRef.current!;
      const rate = audio.sampleRate;
      const n = Math.round(rate * seconds);
      const buf = new Float32Array(n);
      const f = settingsRef.current.txFrequency;
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, Math.min(i, n - i) / (0.01 * rate));
        buf[i] = env * Math.sin((2 * Math.PI * f * i) / rate);
      }
      await pttRef.current?.key(true);
      setTx((t) => ({ ...t, active: true, mode: null, message: `Test tone ${f} Hz`, startedAt: Date.now(), endsAt: Date.now() + seconds * 1000 }));
      try {
        await audio.play(buf, settingsRef.current.txLevel);
      } finally {
        await pttRef.current?.key(false);
        setTx((t) => ({ ...t, active: false, startedAt: null, endsAt: null }));
      }
    },
    [],
  );

  useEffect(() => {
    pttRef.current?.setMode(settings.pttMode);
  }, [settings.pttMode]);

  useEffect(() => {
    return () => {
      void audioRef.current?.close();
      workerRef.current?.terminate();
    };
  }, []);

  const decodeNow = useCallback((mode: ModeId, minHz?: number, maxHz?: number) => {
    workerRef.current?.postMessage({ type: 'decodeNow', mode, minHz, maxHz });
  }, []);

  return {
    settings,
    setSettings,
    devices,
    refreshDevices,
    engineState,
    tx,
    stopTx,
    transmit,
    transmitNow,
    playTone,
    pttStatus,
    ptt: pttRef.current!,
    audio: audioRef.current!,
    startRx,
    stopRx,
    activeMode,
    autoChoice,
    conditions,
    log,
    setLog,
    decodeNow,
    frameSeconds: frameSeconds(MODES[activeMode]),
  };
}
