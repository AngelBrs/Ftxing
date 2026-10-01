import { useMemo, useState } from 'react';
import type { DecodedMessage } from '../engine/decodeSlot';
import { MODES } from '../protocols/modes';

interface Props {
  decodes: DecodedMessage[];
  myCall: string;
  onReply: (d: DecodedMessage) => void;
  onTune: (hz: number) => void;
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
}

export function DecodeList({ decodes, myCall, onReply, onTune }: Props) {
  const [query, setQuery] = useState('');
  const [onlyMe, setOnlyMe] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return [...decodes]
      .reverse()
      .filter((d) => (!q || d.text.toUpperCase().includes(q) || d.mode.includes(q)))
      .filter((d) => !onlyMe || (myCall && d.text.toUpperCase().includes(myCall.toUpperCase())))
      .slice(0, 300);
  }, [decodes, query, onlyMe, myCall]);

  return (
    <div className="panel decodes">
      <div className="panel-head">
        <h2>Decoded signals</h2>
        <div className="row gap">
          <input
            className="search"
            placeholder="search callsign / text / mode"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="check">
            <input type="checkbox" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} /> to me
          </label>
        </div>
      </div>
      <div className="decode-table">
        <div className="decode-row head">
          <span>UTC</span>
          <span>SNR</span>
          <span>DT</span>
          <span>Freq</span>
          <span>Mode</span>
          <span>Message</span>
          <span>Conf</span>
          <span />
        </div>
        <div className="decode-scroll">
          {rows.length === 0 && <div className="empty">No decodes yet. The receiver keeps trying every slot.</div>}
          {rows.map((d) => {
            const mine = myCall && d.text.toUpperCase().includes(myCall.toUpperCase());
            const cq = d.text.startsWith('CQ');
            return (
              <div key={`${d.id}-${d.timeMs}`} className={`decode-row${mine ? ' mine' : ''}${cq ? ' cq' : ''}`}>
                <span className="mono">{hhmmss(d.timeMs)}</span>
                <span className="mono">{d.snr >= 0 ? `+${d.snr.toFixed(0)}` : d.snr.toFixed(0)}</span>
                <span className="mono dim">{d.dt.toFixed(1)}</span>
                <button className="link mono" onClick={() => onTune(Math.round(d.frequency))}>
                  {d.frequency.toFixed(0)}
                </button>
                <span className="tag">{MODES[d.mode].id}</span>
                <span className="msg">
                  {d.text}
                  {d.repeats > 1 && <em className="repeat"> ×{d.repeats}</em>}
                </span>
                <span className={`conf ${d.confidence > 0.95 ? 'good' : 'weak'}`}>{(d.confidence * 100).toFixed(0)}%</span>
                <button className="mini" onClick={() => onReply(d)}>
                  reply
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
