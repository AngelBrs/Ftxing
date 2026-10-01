import { useMemo, useState } from 'react';
import { clearLog, exportLogCsv, type LogEntry } from '../state/settings';

interface Props {
  log: LogEntry[];
  setLog: (l: LogEntry[]) => void;
  onClose: () => void;
}

export function LogPanel({ log, setLog, onClose }: Props) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return [...log].reverse().filter((e) => !q || e.text.toUpperCase().includes(q) || e.mode.includes(q)).slice(0, 1000);
  }, [log, query]);

  const download = () => {
    const blob = new Blob([exportLogCsv(log)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `radiolink-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal log">
        <div className="panel-head">
          <h2>TX / RX log ({log.length})</h2>
          <div className="row gap">
            <input className="search" placeholder="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="mini" onClick={download}>
              export CSV
            </button>
            <button
              className="mini"
              onClick={() => {
                clearLog();
                setLog([]);
              }}
            >
              clear
            </button>
            <button className="mini" onClick={onClose}>
              close
            </button>
          </div>
        </div>
        <div className="modal-body">
          <div className="log-table">
            {rows.map((e) => (
              <div key={e.id} className={`log-row ${e.direction}`}>
                <span className="mono">{new Date(e.timeMs).toISOString().replace('T', ' ').slice(0, 19)}</span>
                <span className={`tag ${e.direction === 'tx' ? 'hot' : 'dim'}`}>{e.direction.toUpperCase()}</span>
                <span className="tag">{e.mode}</span>
                <span className="mono">{e.frequency.toFixed(0)} Hz</span>
                <span className="mono">{e.snr === null ? '' : `${e.snr.toFixed(0)} dB`}</span>
                <span className="msg">{e.text}</span>
              </div>
            ))}
            {rows.length === 0 && <div className="empty">Log is empty.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
