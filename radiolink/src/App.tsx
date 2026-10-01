import { useEffect, useState } from 'react';
import { useRadioEngine } from './hooks/useRadioEngine';
import { Waterfall } from './components/Waterfall';
import { DecodeList } from './components/DecodeList';
import { TxPanel } from './components/TxPanel';
import { Diagnostics } from './components/Diagnostics';
import { SetupWizard } from './components/SetupWizard';
import { AdvancedPanel } from './components/AdvancedPanel';
import { LogPanel } from './components/LogPanel';
import { MODES, type ModeId } from './protocols/modes';
import type { DecodedMessage } from './engine/decodeSlot';
import './styles.css';

const MODE_BUTTONS: (ModeId | 'AUTO')[] = ['AUTO', 'FT8', 'FT4', 'FT2', 'JS8A'];

export default function App() {
  const engine = useRadioEngine();
  const {
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
    ptt,
    audio,
    startRx,
    stopRx,
    activeMode,
    autoChoice,
    log,
    setLog,
    decodeNow,
  } = engine;

  const [message, setMessage] = useState('');
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 250);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    if (!settings.calibration.done && !engineState.rxActive) setShowWizard(true);
    // only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slotSeconds = MODES[activeMode].slotSeconds;
  const secondsIntoSlot = (clock.getTime() % (slotSeconds * 1000)) / 1000;
  const slotProgress = secondsIntoSlot / slotSeconds;

  const reply = (d: DecodedMessage) => {
    const me = settings.callsign || 'MYCALL';
    if (MODES[d.mode].family === 'JS8') {
      setMessage(`${d.text.split(':')[0]}: ${me} HELLO`);
    } else if (d.callDe) {
      setMessage(`${d.callDe} ${me} ${settings.grid || '-10'}`);
    } else {
      setMessage(`${me} 73`);
    }
    setSettings({ txFrequency: Math.round(d.frequency) });
  };

  const inputLabel =
    devices.find((d) => d.deviceId === settings.inputDeviceId)?.label ??
    (settings.inputDeviceId === 'default' ? 'System default input' : settings.inputDeviceId);
  const outputLabel =
    devices.find((d) => d.deviceId === settings.outputDeviceId)?.label ??
    (settings.outputDeviceId === 'default' ? 'System default output' : settings.outputDeviceId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▣</span>
          <div>
            <h1>RADIOLINK</h1>
            <small>digital terminal for audio-coupled radios</small>
          </div>
        </div>

        <div className="status-cluster">
          <div className={`status-pill ${engineState.rxActive ? 'on' : 'off'}`}>
            <span className="dot" /> {engineState.rxActive ? 'RX ACTIVE' : 'RX STOPPED'}
          </div>
          <div className={`status-pill ${tx.active ? 'tx' : 'ready'}`}>
            <span className="dot" /> {tx.active ? 'TX ACTIVE' : 'TX READY'}
          </div>
          <div className="status-pill clock">
            <span className="mono">{clock.toISOString().slice(11, 19)} UTC</span>
            <div className="slotbar">
              <div style={{ width: `${slotProgress * 100}%` }} />
            </div>
          </div>
          {settings.callsign && <div className="status-pill call">{settings.callsign}</div>}
        </div>

        <div className="actions">
          {engineState.rxActive ? (
            <button className="secondary" onClick={() => void stopRx()}>
              stop RX
            </button>
          ) : (
            <button className="primary" onClick={() => void startRx()} disabled={engineState.starting}>
              {engineState.starting ? 'starting…' : 'START RX'}
            </button>
          )}
          <button className="secondary" onClick={() => setShowWizard(true)}>
            setup
          </button>
          <button className="secondary" onClick={() => setShowSettings(true)}>
            settings
          </button>
          <button className="secondary" onClick={() => setShowLog(true)}>
            log
          </button>
        </div>
      </header>

      {engineState.error && <div className="banner error">{engineState.error}</div>}
      {!settings.callsign && (
        <div className="banner">
          Set your callsign in <button className="link" onClick={() => setShowSettings(true)}>settings</button> before
          transmitting.
        </div>
      )}

      <div className="mode-bar">
        <span className="label">MODE</span>
        {MODE_BUTTONS.map((m) => (
          <button
            key={m}
            className={`mode-btn${settings.mode === m ? ' active' : ''}${m === 'FT2' ? ' experimental' : ''}`}
            onClick={() => setSettings({ mode: m })}
            title={m === 'AUTO' ? 'Choose automatically from conditions and purpose' : MODES[m as ModeId].description}
          >
            {m === 'AUTO' ? 'AUTO' : MODES[m as ModeId].id}
            {m === 'AUTO' && settings.mode === 'AUTO' && <small>{MODES[activeMode].id}</small>}
          </button>
        ))}
        <span className="mode-desc">{MODES[activeMode].description}</span>
        <div className="grow" />
        <button className="mini" onClick={() => decodeNow(activeMode)}>
          re-decode last slot
        </button>
      </div>

      <main className="layout">
        <section className="left">
          <Waterfall
            audio={audio}
            active={engineState.rxActive}
            signals={engineState.signals}
            txFrequency={settings.txFrequency}
            mode={activeMode}
            onPickFrequency={(hz) => setSettings({ txFrequency: hz })}
            onInspect={(hz) => decodeNow(activeMode, Math.max(150, hz - 120), Math.min(3400, hz + 120))}
          />
          <DecodeList
            decodes={engineState.decodes}
            myCall={settings.callsign}
            onReply={reply}
            onTune={(hz) => setSettings({ txFrequency: hz })}
          />
        </section>

        <section className="right">
          <TxPanel
            tx={tx}
            activeMode={activeMode}
            modeSetting={settings.mode}
            autoChoice={autoChoice}
            callsign={settings.callsign}
            grid={settings.grid}
            txFrequency={settings.txFrequency}
            pttStatus={pttStatus}
            message={message}
            setMessage={setMessage}
            onTransmit={() => transmit(message)}
            onTransmitNow={() => transmitNow(message)}
            onStop={() => void stopTx()}
            rxActive={engineState.rxActive}
          />
          <Diagnostics
            state={engineState}
            pttStatus={pttStatus}
            inputLabel={inputLabel}
            outputLabel={outputLabel}
            sampleRate={audio.sampleRate}
            txFrequency={settings.txFrequency}
            txLevel={settings.txLevel}
            activeMode={activeMode}
            dspAuto={settings.dsp.auto}
          />
        </section>
      </main>

      {tx.active && (
        <button className="tx-overlay" onClick={() => void stopTx()}>
          ● TX ACTIVE — {tx.message} — click anywhere here to STOP
        </button>
      )}

      {showWizard && (
        <SetupWizard
          devices={devices}
          settings={settings}
          setSettings={setSettings}
          state={engineState}
          startRx={startRx}
          refreshDevices={refreshDevices}
          playTone={playTone}
          onClose={() => setShowWizard(false)}
        />
      )}
      {showSettings && (
        <AdvancedPanel
          settings={settings}
          setSettings={setSettings}
          ptt={ptt}
          pttStatus={pttStatus}
          devices={devices}
          refreshDevices={() => void refreshDevices()}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showLog && <LogPanel log={log} setLog={setLog} onClose={() => setShowLog(false)} />}
    </div>
  );
}
