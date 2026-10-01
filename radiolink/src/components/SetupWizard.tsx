import { useEffect, useRef, useState } from 'react';
import type { AudioDeviceInfo } from '../audio/engine';
import type { EngineState } from '../hooks/useRadioEngine';
import type { Settings } from '../state/settings';

interface Props {
  devices: AudioDeviceInfo[];
  settings: Settings;
  setSettings: (u: Partial<Settings>) => void;
  state: EngineState;
  startRx: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  playTone: (seconds?: number) => Promise<void>;
  onClose: () => void;
}

const STEPS = [
  'Receive input',
  'Transmit output',
  'Background noise',
  'Test signal',
  'Levels',
  'Save',
];

export function SetupWizard({
  devices,
  settings,
  setSettings,
  state,
  startRx,
  refreshDevices,
  playTone,
  onClose,
}: Props) {
  const [step, setStep] = useState(0);
  const [measuring, setMeasuring] = useState(false);
  const [noise, setNoise] = useState<{ level: number; floor: number | null; clip: number } | null>(null);
  const [signal, setSignal] = useState<{ level: number; clip: number } | null>(null);
  const samplesRef = useRef<number[]>([]);

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');

  useEffect(() => {
    if (!measuring || !state.metrics) return;
    samplesRef.current.push(state.metrics.levelDb);
  }, [state.metrics, measuring]);

  const measure = async (seconds: number, target: 'noise' | 'signal') => {
    samplesRef.current = [];
    setMeasuring(true);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    setMeasuring(false);
    const vals = samplesRef.current;
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -99;
    const clip = state.metrics?.clipPercent ?? 0;
    if (target === 'noise') setNoise({ level: avg, floor: state.lastSlot?.report.noiseFloorDb ?? null, clip });
    else setSignal({ level: avg, clip });
  };

  const recommendedGain = (() => {
    if (!signal) return null;
    const target = -18;
    return Math.pow(10, (target - signal.level) / 20);
  })();

  const finish = () => {
    setSettings({
      calibration: {
        done: true,
        noiseFloorDb: noise?.floor ?? null,
        inputLevelDb: signal?.level ?? noise?.level ?? null,
        recommendedGain: recommendedGain,
        outputLevel: settings.txLevel,
        at: Date.now(),
      },
    });
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal wizard">
        <div className="panel-head">
          <h2>Audio setup wizard</h2>
          <button className="mini" onClick={onClose}>
            close
          </button>
        </div>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === 0 && (
            <>
              <p>
                Pick the input the radio's audio is connected to. On a phone this is usually the headset
                microphone jack; on a PC it is the USB codec or line-in.
              </p>
              <div className="row gap">
                <select
                  value={settings.inputDeviceId}
                  onChange={(e) => setSettings({ inputDeviceId: e.target.value })}
                >
                  <option value="default">System default</option>
                  {inputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <button className="mini" onClick={() => void refreshDevices()}>
                  refresh
                </button>
                {!state.rxActive && (
                  <button className="mini" onClick={() => void startRx()}>
                    grant microphone access
                  </button>
                )}
              </div>
              <p className="dim">
                Browser processing (echo cancellation, noise suppression, AGC) is disabled automatically — those
                features destroy weak digital signals.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <p>Pick the output that feeds the radio's microphone / line input.</p>
              <select
                value={settings.outputDeviceId}
                onChange={(e) => setSettings({ outputDeviceId: e.target.value })}
              >
                <option value="default">System default</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
              <p className="dim">
                If your browser does not allow choosing an output device, set the default output in the operating
                system instead.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <p>
                Leave the radio on a quiet frequency (squelch open, no signals) and measure the background noise
                for five seconds.
              </p>
              <button className="secondary" disabled={measuring || !state.rxActive} onClick={() => void measure(5, 'noise')}>
                {measuring ? 'measuring…' : 'measure background noise'}
              </button>
              {noise && (
                <div className="measure">
                  <div>
                    Average level: <strong>{noise.level.toFixed(1)} dBFS</strong>
                  </div>
                  <div>Noise floor: <strong>{noise.floor !== null ? `${noise.floor.toFixed(1)} dB` : 'pending a full slot'}</strong></div>
                  <div className={noise.level > -20 ? 'warn' : noise.level < -55 ? 'warn' : 'ok'}>
                    {noise.level > -20
                      ? 'Noise is very loud — turn the radio volume down.'
                      : noise.level < -55
                        ? 'Very quiet — turn the radio volume up a little.'
                        : 'Good noise level for decoding.'}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p>
                Now measure a real signal. Either tune to an active digital frequency (14.074 MHz FT8 is a good
                choice) for five seconds, or send a test tone into a dummy load and listen to your own audio.
              </p>
              <div className="row gap">
                <button className="secondary" disabled={measuring} onClick={() => void measure(5, 'signal')}>
                  {measuring ? 'measuring…' : 'measure signal level'}
                </button>
                <button className="secondary" onClick={() => void playTone(3)}>
                  play 3 s test tone (TX)
                </button>
              </div>
              {signal && (
                <div className="measure">
                  <div>
                    Average level: <strong>{signal.level.toFixed(1)} dBFS</strong>
                  </div>
                  <div>Clipping: <strong>{signal.clip.toFixed(2)} %</strong></div>
                </div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <p>Recommended settings based on the measurements:</p>
              <ul className="results">
                <li>
                  Input: measured {signal?.level.toFixed(1) ?? noise?.level.toFixed(1) ?? '—'} dBFS.{' '}
                  {recommendedGain
                    ? recommendedGain > 1.6
                      ? `Turn the radio/soundcard level up (about ${(20 * Math.log10(recommendedGain)).toFixed(0)} dB).`
                      : recommendedGain < 0.6
                        ? `Turn the radio/soundcard level down (about ${(-20 * Math.log10(recommendedGain)).toFixed(0)} dB).`
                        : 'Input level is in the ideal range — no change needed.'
                    : 'Run the measurements to get a recommendation.'}
                </li>
                <li>
                  Adaptive DSP compensates for the rest automatically (DC offset, hum, narrow carriers, gain).
                </li>
                <li>
                  TX level: start at {(settings.txLevel * 100).toFixed(0)} % and reduce until the radio's ALC just
                  stops moving.
                </li>
              </ul>
              <label className="field">
                TX output level
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={settings.txLevel}
                  onChange={(e) => setSettings({ txLevel: Number(e.target.value) })}
                />
                <span className="mono">{(settings.txLevel * 100).toFixed(0)}%</span>
              </label>
            </>
          )}

          {step === 5 && (
            <>
              <p>Save this calibration so the application starts up ready to decode.</p>
              <ul className="results">
                <li>Input: {inputs.find((d) => d.deviceId === settings.inputDeviceId)?.label ?? 'system default'}</li>
                <li>Output: {outputs.find((d) => d.deviceId === settings.outputDeviceId)?.label ?? 'system default'}</li>
                <li>Noise floor: {noise?.floor?.toFixed(1) ?? '—'} dB</li>
                <li>Signal level: {signal?.level.toFixed(1) ?? '—'} dBFS</li>
                <li>TX level: {(settings.txLevel * 100).toFixed(0)} %</li>
              </ul>
            </>
          )}
        </div>

        <div className="wizard-nav">
          <button className="mini" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            back
          </button>
          {step < STEPS.length - 1 ? (
            <button className="primary" onClick={() => setStep((s) => s + 1)}>
              next
            </button>
          ) : (
            <button className="primary" onClick={finish}>
              save calibration
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
