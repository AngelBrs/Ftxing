import { useEffect, useState } from 'react';
import type { ModeId } from '../protocols/modes';
import { MODES, frameSeconds } from '../protocols/modes';
import type { TxState } from '../hooks/useRadioEngine';
import type { PttStatus } from '../radio/ptt';
import type { ModeChoice } from '../engine/modeSelect';

interface Props {
  tx: TxState;
  activeMode: ModeId;
  modeSetting: ModeId | 'AUTO';
  autoChoice: ModeChoice;
  callsign: string;
  grid: string;
  txFrequency: number;
  pttStatus: PttStatus;
  message: string;
  setMessage: (v: string) => void;
  onTransmit: () => void;
  onTransmitNow: () => void;
  onStop: () => void;
  rxActive: boolean;
}

export function TxPanel({
  tx,
  activeMode,
  modeSetting,
  autoChoice,
  callsign,
  grid,
  txFrequency,
  pttStatus,
  message,
  setMessage,
  onTransmit,
  onTransmitNow,
  onStop,
  rxActive,
}: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const spec = MODES[activeMode];
  const remaining = tx.endsAt ? Math.max(0, (tx.endsAt - now) / 1000) : 0;
  const countdown = tx.scheduledFor ? Math.max(0, (tx.scheduledFor - now) / 1000) : 0;
  const macros = [
    callsign && grid ? `CQ ${callsign} ${grid}` : 'CQ SV1ABC KM17',
    callsign ? `${callsign} TEST` : 'TEST',
    'Hello from Greece',
    '73',
  ];

  return (
    <div className={`panel tx-panel${tx.active ? ' transmitting' : ''}`}>
      <div className="panel-head">
        <h2>Message</h2>
        <div className="row gap">
          <span className="tag">{spec.label}</span>
          <span className="tag dim">{frameSeconds(spec).toFixed(1)} s frame</span>
          <span className="tag dim">{txFrequency} Hz</span>
          <span className={`tag ${pttStatus.keyed ? 'hot' : 'dim'}`}>PTT {pttStatus.mode.toUpperCase()}</span>
        </div>
      </div>

      {modeSetting === 'AUTO' && (
        <div className="auto-explain">
          <strong>AUTO chose {MODES[autoChoice.mode].label}</strong>
          <ul>
            {autoChoice.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        className="message"
        value={message}
        maxLength={spec.family === 'JS8' ? 240 : 13 * 3}
        placeholder={spec.family === 'JS8' ? 'Free text — JS8 splits long messages over consecutive slots' : 'CQ SV1ABC KM17  ·  SV1ABC DL2XYZ -11  ·  13 characters of free text'}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
      />

      <div className="macros">
        {macros.map((m) => (
          <button key={m} className="chip" onClick={() => setMessage(m)}>
            {m}
          </button>
        ))}
      </div>

      <div className="tx-controls">
        <button className="primary" disabled={!message.trim() || tx.active || !rxActive} onClick={onTransmit}>
          TRANSMIT
          <small>at next {spec.slotSeconds}s slot</small>
        </button>
        <button className="secondary" disabled={!message.trim() || tx.active} onClick={onTransmitNow}>
          Transmit now
          <small>unaligned</small>
        </button>
        <button className={`stop${tx.active || tx.scheduledFor ? ' armed' : ''}`} onClick={onStop}>
          STOP TX
        </button>
      </div>

      <div className="tx-status">
        {tx.active ? (
          <div className="tx-active">
            <span className="blink">● TX ACTIVE</span>
            <span>{tx.message}</span>
            <span className="mono">{remaining.toFixed(1)} s remaining</span>
          </div>
        ) : tx.scheduledFor ? (
          <div className="tx-armed">
            <span>◌ ARMED</span>
            <span>{tx.message}</span>
            <span className="mono">starts in {countdown.toFixed(1)} s</span>
          </div>
        ) : (
          <div className="tx-idle">
            <span>TX READY</span>
            <span className="dim">{pttStatus.detail}</span>
          </div>
        )}
        {tx.queued && tx.queued.frames > 1 && <span className="dim">{tx.queued.frames} frames queued (one per slot)</span>}
        {tx.error && <span className="error">{tx.error}</span>}
      </div>
    </div>
  );
}
