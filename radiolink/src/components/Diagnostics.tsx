import type { EngineState } from '../hooks/useRadioEngine';
import type { PttStatus } from '../radio/ptt';
import type { ModeDetection } from '../engine/decodeSlot';
import { MODES, type ModeId } from '../protocols/modes';

interface Props {
  state: EngineState;
  pttStatus: PttStatus;
  inputLabel: string;
  outputLabel: string;
  sampleRate: number;
  txFrequency: number;
  txLevel: number;
  activeMode: ModeId;
  dspAuto: boolean;
}

function fmt(v: number | null | undefined, digits = 1, unit = ''): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return `${v.toFixed(digits)}${unit}`;
}

function DetectionRow({ d }: { d: ModeDetection }) {
  const pct = Math.round(d.confidence * 100);
  const cls = pct >= 90 ? 'good' : pct >= 40 ? 'weak' : 'dim';
  return (
    <div className="detect-row">
      <span className="tag">{MODES[d.mode].id}</span>
      <span className="mono">{d.bestFrequency ? `${d.bestFrequency.toFixed(0)} Hz` : '—'}</span>
      <span className="mono">sync {fmt(d.syncScore, 1, ' dB')}</span>
      <span className={`conf ${cls}`}>{pct}%</span>
      <span className="dim">{d.decodes
          ? `${d.decodes} decoded`
          : d.explainedBy
            ? `same signal decoded as ${d.explainedBy}`
            : pct >= 40
              ? 'signal present, not decoded'
              : 'no evidence'}</span>
    </div>
  );
}

export function Diagnostics({
  state,
  pttStatus,
  inputLabel,
  outputLabel,
  sampleRate,
  txFrequency,
  txLevel,
  activeMode,
  dspAuto,
}: Props) {
  const report = state.lastSlot?.report;
  const metrics = state.metrics;
  const detections = Object.values(state.detections).sort((a, b) => b.confidence - a.confidence);

  const warnings: string[] = [...(state.diagnostics ?? [])];
  if (metrics && metrics.levelDb > -6) warnings.unshift('RX input is very hot — reduce the radio volume to avoid clipping');
  if (!state.rxActive) warnings.unshift('Receiver is stopped — press START RX');

  return (
    <div className="panel diagnostics">
      <div className="panel-head">
        <h2>Audio health & diagnostics</h2>
        <span className={`tag ${dspAuto ? 'hot' : 'dim'}`}>Adaptive DSP {dspAuto ? 'ACTIVE' : 'MANUAL'}</span>
      </div>

      <div className="diag-grid">
        <section>
          <h3>RX</h3>
          <dl>
            <dt>Input device</dt>
            <dd title={inputLabel}>{inputLabel}</dd>
            <dt>Sample rate</dt>
            <dd>
              {sampleRate} Hz → 12000 Hz decode
            </dd>
            <dt>Audio level</dt>
            <dd className={metrics && metrics.levelDb < -50 ? 'warn' : ''}>{fmt(metrics?.levelDb, 1, ' dBFS')}</dd>
            <dt>Noise floor</dt>
            <dd>{fmt(report?.noiseFloorDb, 1, ' dB')}</dd>
            <dt>Peak signal</dt>
            <dd>{fmt(report?.peakSignalDb, 1, ' dB')}</dd>
            <dt>Wideband SNR</dt>
            <dd>{fmt(report?.snrDb, 1, ' dB')}</dd>
            <dt>Clipping</dt>
            <dd className={metrics && metrics.clipPercent > 0.5 ? 'warn' : ''}>{fmt(metrics?.clipPercent, 2, ' %')}</dd>
            <dt>DC offset</dt>
            <dd>{fmt((report?.dcOffset ?? 0) * 100, 2, ' %')}</dd>
            <dt>Fading</dt>
            <dd>{fmt(report?.fadingDb, 1, ' dB')}</dd>
            <dt>Dropouts</dt>
            <dd>{fmt(report?.dropoutPercent, 0, ' %')}</dd>
            <dt>Response tilt</dt>
            <dd>{fmt(report?.tiltDb, 0, ' dB')}</dd>
            <dt>Auto gain</dt>
            <dd>×{fmt(report?.gainApplied, 1)}</dd>
            <dt>Notches</dt>
            <dd>
              {report && (report.humNotches.length || report.carrierNotches.length)
                ? [...report.humNotches, ...report.carrierNotches.map((f) => Math.round(f))].slice(0, 5).join(', ') + ' Hz'
                : 'none'}
            </dd>
            <dt>Decoder load</dt>
            <dd>
              {state.cpuMs} ms/slot · {state.slotCount} slots
            </dd>
          </dl>
        </section>

        <section>
          <h3>TX</h3>
          <dl>
            <dt>Output device</dt>
            <dd title={outputLabel}>{outputLabel}</dd>
            <dt>Output level</dt>
            <dd>{(txLevel * 100).toFixed(0)} %</dd>
            <dt>TX audio frequency</dt>
            <dd>{txFrequency} Hz</dd>
            <dt>Mode</dt>
            <dd>{MODES[activeMode].label}</dd>
            <dt>PTT method</dt>
            <dd>{pttStatus.mode.toUpperCase()}</dd>
            <dt>PTT state</dt>
            <dd className={pttStatus.keyed ? 'hot' : ''}>{pttStatus.keyed ? 'KEYED' : 'idle'}</dd>
            <dt>PTT detail</dt>
            <dd>{pttStatus.detail}</dd>
            <dt>Waveform</dt>
            <dd>GFSK, BT {MODES[activeMode].bt}, {MODES[activeMode].tones}-FSK</dd>
          </dl>
        </section>

        <section className="detections">
          <h3>Mode detection (this slot)</h3>
          {detections.length === 0 && <p className="dim">Waiting for the first complete slot…</p>}
          {detections.map((d) => (
            <DetectionRow key={d.mode} d={d} />
          ))}
        </section>
      </div>

      <div className="warnings">
        {warnings.length === 0 ? (
          <div className="ok">No problems detected — receive chain looks healthy.</div>
        ) : (
          warnings.map((w) => (
            <div key={w} className="warn-line">
              {w}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
