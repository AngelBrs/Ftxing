/** Persisted application settings (localStorage). */
import { DEFAULT_DSP, type DspSettings } from '../dsp/pipeline';
import type { ModeId } from '../protocols/modes';
import type { PttMode } from '../radio/ptt';
import type { Purpose } from './../engine/modeSelect';

export interface Settings {
  callsign: string;
  grid: string;
  operator: string;
  inputDeviceId: string;
  outputDeviceId: string;
  mode: ModeId | 'AUTO';
  purpose: Purpose;
  txFrequency: number;
  txLevel: number;
  maxTxSeconds: number;
  pttMode: PttMode;
  companionUrl: string;
  dsp: DspSettings;
  osdOrder: number;
  maxCandidates: number;
  minHz: number;
  maxHz: number;
  allowFt2: boolean;
  decodeModes: ModeId[];
  calibration: {
    done: boolean;
    noiseFloorDb: number | null;
    inputLevelDb: number | null;
    recommendedGain: number | null;
    outputLevel: number | null;
    at: number | null;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  callsign: '',
  grid: '',
  operator: '',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  mode: 'AUTO',
  purpose: 'qso',
  txFrequency: 1500,
  txLevel: 0.35,
  maxTxSeconds: 20,
  pttMode: 'vox',
  companionUrl: 'ws://127.0.0.1:8737',
  dsp: DEFAULT_DSP,
  osdOrder: 1,
  maxCandidates: 24,
  minHz: 200,
  maxHz: 3000,
  allowFt2: false,
  decodeModes: ['FT8', 'FT4', 'JS8A'],
  calibration: { done: false, noiseFloorDb: null, inputLevelDb: null, recommendedGain: null, outputLevel: null, at: null },
};

const KEY = 'radiolink.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      dsp: { ...DEFAULT_DSP, ...(parsed.dsp ?? {}) },
      calibration: { ...DEFAULT_SETTINGS.calibration, ...(parsed.calibration ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export interface LogEntry {
  id: string;
  timeMs: number;
  direction: 'rx' | 'tx';
  mode: ModeId;
  frequency: number;
  snr: number | null;
  text: string;
  callsign?: string;
}

const LOG_KEY = 'radiolink.log.v1';
const LOG_LIMIT = 5000;

export function loadLog(): LogEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function appendLog(entries: LogEntry[]): LogEntry[] {
  const all = [...loadLog(), ...entries].slice(-LOG_LIMIT);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return all;
}

export function clearLog(): void {
  localStorage.removeItem(LOG_KEY);
}

export function exportLogCsv(entries: LogEntry[]): string {
  const rows = [['utc', 'direction', 'mode', 'audio_hz', 'snr_db', 'message']];
  for (const e of entries) {
    rows.push([
      new Date(e.timeMs).toISOString(),
      e.direction.toUpperCase(),
      e.mode,
      e.frequency.toFixed(0),
      e.snr === null ? '' : e.snr.toFixed(0),
      `"${e.text.replace(/"/g, '""')}"`,
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}
