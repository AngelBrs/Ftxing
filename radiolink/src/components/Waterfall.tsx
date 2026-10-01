import { useEffect, useRef, useState } from 'react';
import type { AudioEngine } from '../audio/engine';
import type { SignalSighting } from '../engine/decodeSlot';
import { MODES, bandwidth, type ModeId } from '../protocols/modes';

interface Props {
  audio: AudioEngine;
  active: boolean;
  signals: SignalSighting[];
  txFrequency: number;
  mode: ModeId;
  onPickFrequency: (hz: number) => void;
  onInspect: (hz: number) => void;
}

const MIN_HZ = 0;
const MAX_HZ = 3500;
const HISTORY = 220;

/** Blue -> cyan -> yellow -> white colour ramp. */
function colourFor(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v));
  if (!Number.isFinite(t)) return [0, 0, 40];
  if (t < 0.25) return [0, 0, Math.round(40 + t * 4 * 160)];
  if (t < 0.5) return [0, Math.round((t - 0.25) * 4 * 220), 200];
  if (t < 0.75) return [Math.round((t - 0.5) * 4 * 255), 220, Math.round(200 - (t - 0.5) * 4 * 200)];
  return [255, 255, Math.round((t - 0.75) * 4 * 255)];
}

export function Waterfall({ audio, active, signals, txFrequency, mode, onPickFrequency, onInspect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const specRef = useRef<Float32Array | null>(null);
  const rowsRef = useRef<Float32Array[]>([]);
  const [hoverHz, setHoverHz] = useState<number | null>(null);
  const floorRef = useRef(-110);
  const peakRef = useRef(-50);
  const [floorDb, setFloorDb] = useState(-110);
  const [peakDb, setPeakDb] = useState(-50);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let last = 0;

    const draw = (ts: number) => {
      rafRef.current = requestAnimationFrame(draw);
      if (ts - last < 55) return;
      last = ts;

      const bins = audio.spectrumBins;
      const width = canvas.width;
      const height = canvas.height;
      if (!bins) {
        // idle pattern so the display still "works" with no audio
        ctx.fillStyle = '#05070c';
        ctx.fillRect(0, 0, width, height);
        return;
      }
      if (!specRef.current || specRef.current.length !== bins) specRef.current = new Float32Array(bins);
      const spec = specRef.current;
      if (!audio.spectrum(spec)) return;
      // digital silence makes the analyser report -Infinity; keep the maths finite
      for (let i = 0; i < spec.length; i++) if (!Number.isFinite(spec[i])) spec[i] = -160;

      const rate = audio.sampleRate;
      const binHz = rate / 2 / bins;
      const loBin = Math.floor(MIN_HZ / binHz);
      const hiBin = Math.min(bins - 1, Math.ceil(MAX_HZ / binHz));

      // rolling noise-floor / peak estimate for auto contrast
      const sorted: number[] = [];
      for (let i = loBin; i <= hiBin; i += 3) sorted.push(spec[i]);
      sorted.sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.25)] ?? -110;
      const top = sorted[Math.floor(sorted.length * 0.995)] ?? -50;
      const nf = floorRef.current * 0.9 + floor * 0.1;
      const pk = Math.max(nf + 12, peakRef.current * 0.9 + top * 0.1);
      floorRef.current = nf;
      peakRef.current = pk;
      if (Math.abs(nf - floorDb) > 0.5) setFloorDb(nf);
      if (Math.abs(pk - peakDb) > 0.5) setPeakDb(pk);

      // scroll down by one pixel row
      ctx.drawImage(canvas, 0, 1);
      const row = ctx.createImageData(width, 1);
      for (let x = 0; x < width; x++) {
        const hz = MIN_HZ + ((MAX_HZ - MIN_HZ) * x) / width;
        const bin = Math.round(hz / binHz);
        let v = -200;
        const b0 = Math.max(0, Math.min(bins - 1, bin));
        const b1 = Math.max(0, Math.min(bins - 1, Math.round((MIN_HZ + ((MAX_HZ - MIN_HZ) * (x + 1)) / width) / binHz)));
        for (let b = b0; b <= Math.max(b0, b1); b++) v = Math.max(v, spec[b]);
        const norm = Number.isFinite(v) ? (v - nf) / Math.max(8, pk - nf) : 0;
        const [r, g, bl] = colourFor(norm);
        row.data[x * 4] = r;
        row.data[x * 4 + 1] = g;
        row.data[x * 4 + 2] = bl;
        row.data[x * 4 + 3] = 255;
      }
      ctx.putImageData(row, 0, 0);

      const keep = spec.slice(loBin, hiBin + 1);
      rowsRef.current.unshift(keep);
      if (rowsRef.current.length > HISTORY) rowsRef.current.pop();
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [audio]);

  // overlay: grid, markers, detected signals, spectrum trace
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const hzToX = (hz: number) => ((hz - MIN_HZ) / (MAX_HZ - MIN_HZ)) * width;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      ctx.clearRect(0, 0, width, height);

      // spectrum trace at the top
      const spec = specRef.current;
      if (spec) {
        const rate = audio.sampleRate;
        const binHz = rate / 2 / spec.length;
        ctx.strokeStyle = 'rgba(120, 230, 180, 0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const traceH = 54;
        for (let x = 0; x < width; x++) {
          const hz = MIN_HZ + ((MAX_HZ - MIN_HZ) * x) / width;
          const bin = Math.max(0, Math.min(spec.length - 1, Math.round(hz / binHz)));
          const v = (spec[bin] - floorRef.current) / Math.max(10, peakRef.current - floorRef.current);
          const y = traceH - Math.max(0, Math.min(1, v)) * traceH;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // noise floor line
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, traceH);
        ctx.lineTo(width, traceH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(`noise floor ${floorRef.current.toFixed(0)} dB`, 6, traceH - 4);
      }

      // frequency grid
      ctx.font = '10px ui-monospace, monospace';
      for (let hz = 0; hz <= MAX_HZ; hz += 250) {
        const x = hzToX(hz);
        ctx.strokeStyle = hz % 500 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        if (hz % 500 === 0) {
          ctx.fillStyle = 'rgba(200,220,255,0.65)';
          ctx.fillText(`${hz}`, x + 3, height - 4);
        }
      }

      // decoder passband
      const spec2 = MODES[mode];
      const bw = bandwidth(spec2);
      ctx.fillStyle = 'rgba(80, 160, 255, 0.10)';
      ctx.fillRect(hzToX(200), 0, hzToX(3000) - hzToX(200), height);

      // TX marker
      const txX = hzToX(txFrequency);
      ctx.fillStyle = 'rgba(255, 70, 70, 0.20)';
      ctx.fillRect(txX, 0, Math.max(2, hzToX(txFrequency + bw) - txX), height);
      ctx.strokeStyle = '#ff4646';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(txX, 0);
      ctx.lineTo(txX, height);
      ctx.stroke();
      ctx.fillStyle = '#ff8a8a';
      ctx.fillText(`TX ${txFrequency.toFixed(0)} Hz`, txX + 4, 12);

      // detected signals
      for (const s of signals) {
        const x = hzToX(s.frequency);
        ctx.fillStyle = s.decoded ? 'rgba(90, 255, 160, 0.9)' : 'rgba(255, 210, 90, 0.85)';
        ctx.beginPath();
        ctx.moveTo(x, 58);
        ctx.lineTo(x - 5, 48);
        ctx.lineTo(x + 5, 48);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = s.decoded ? 'rgba(160,255,200,0.95)' : 'rgba(255,225,160,0.9)';
        ctx.fillText(`${s.mode} ${s.snr.toFixed(0)}dB`, x + 6, 58);
      }

      if (hoverHz !== null) {
        const x = hzToX(hoverHz);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [signals, txFrequency, mode, hoverHz, floorDb, peakDb, audio]);

  const posToHz = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const frac = (ev.clientX - rect.left) / rect.width;
    return Math.round(MIN_HZ + frac * (MAX_HZ - MIN_HZ));
  };

  return (
    <div className="waterfall">
      <canvas ref={canvasRef} width={1200} height={300} className="waterfall-canvas" />
      <canvas
        ref={overlayRef}
        width={1200}
        height={300}
        className="waterfall-overlay"
        onMouseMove={(e) => setHoverHz(posToHz(e))}
        onMouseLeave={() => setHoverHz(null)}
        onClick={(e) => onPickFrequency(posToHz(e))}
        onDoubleClick={(e) => onInspect(posToHz(e))}
      />
      <div className="waterfall-footer">
        <span>{active ? 'RX streaming' : 'receiver stopped'}</span>
        <span>{hoverHz !== null ? `cursor ${hoverHz} Hz` : 'click = set TX frequency · double-click = decode this signal'}</span>
        <span>
          floor {floorDb.toFixed(0)} dB · peak {peakDb.toFixed(0)} dB
        </span>
      </div>
    </div>
  );
}
