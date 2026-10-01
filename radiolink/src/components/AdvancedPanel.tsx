import { useState } from 'react';
import type { Settings } from '../state/settings';
import type { PttController, PttMode, PttStatus } from '../radio/ptt';
import { webSerialSupported } from '../radio/ptt';
import { ALL_MODES, type ModeId } from '../protocols/modes';
import type { AudioDeviceInfo } from '../audio/engine';

interface Props {
  settings: Settings;
  setSettings: (u: Partial<Settings>) => void;
  ptt: PttController;
  pttStatus: PttStatus;
  devices: AudioDeviceInfo[];
  refreshDevices: () => void;
  onClose: () => void;
}

export function AdvancedPanel({ settings, setSettings, ptt, pttStatus, devices, refreshDevices, onClose }: Props) {
  const [tab, setTab] = useState<'station' | 'audio' | 'ptt' | 'dsp' | 'decoder' | 'about'>('station');
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');

  const toggleDecodeMode = (id: ModeId) => {
    const has = settings.decodeModes.includes(id);
    setSettings({
      decodeModes: has ? settings.decodeModes.filter((m) => m !== id) : [...settings.decodeModes, id],
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal advanced">
        <div className="panel-head">
          <h2>Settings</h2>
          <button className="mini" onClick={onClose}>
            close
          </button>
        </div>
        <div className="tabs">
          {(['station', 'audio', 'ptt', 'dsp', 'decoder', 'about'] as const).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'station' && (
            <div className="form">
              <label className="field">
                Callsign
                <input value={settings.callsign} onChange={(e) => setSettings({ callsign: e.target.value.toUpperCase() })} placeholder="SV1ABC" />
              </label>
              {settings.callsign && !/^[A-Z0-9]{0,2}[0-9][A-Z]{1,3}$/.test(settings.callsign) && (
                <div className="note">
                  <strong>{settings.callsign}</strong> is not a standard-format callsign, so the 77-bit FT8/FT4 message
                  format cannot carry it literally. It will be sent as a 22-bit hash written <code>&lt;{settings.callsign}&gt;</code>;
                  stations that have not heard your full call recently will see the hash instead of your callsign. This is
                  normal protocol behaviour, not a bug in this application.
                </div>
              )}
              <label className="field">
                Grid locator
                <input value={settings.grid} onChange={(e) => setSettings({ grid: e.target.value.toUpperCase() })} placeholder="KM17" />
              </label>
              <label className="field">
                Operator name
                <input value={settings.operator} onChange={(e) => setSettings({ operator: e.target.value })} />
              </label>
              <label className="field">
                Purpose (drives AUTO mode selection)
                <select value={settings.purpose} onChange={(e) => setSettings({ purpose: e.target.value as Settings['purpose'] })}>
                  <option value="cq">Calling CQ / being heard</option>
                  <option value="qso">Completing contacts quickly</option>
                  <option value="chat">Conversational messaging</option>
                  <option value="emergency">Emergency / message handling</option>
                </select>
              </label>
              <label className="field">
                Maximum transmission length
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={settings.maxTxSeconds}
                  onChange={(e) => setSettings({ maxTxSeconds: Number(e.target.value) })}
                />
                <span className="dim">seconds — hard cut-off, prevents a stuck transmitter</span>
              </label>
            </div>
          )}

          {tab === 'audio' && (
            <div className="form">
              <label className="field">
                RX input device
                <select value={settings.inputDeviceId} onChange={(e) => setSettings({ inputDeviceId: e.target.value })}>
                  <option value="default">System default</option>
                  {inputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                TX output device
                <select value={settings.outputDeviceId} onChange={(e) => setSettings({ outputDeviceId: e.target.value })}>
                  <option value="default">System default</option>
                  {outputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="mini" onClick={refreshDevices}>
                refresh device list
              </button>
              <label className="field">
                TX audio level
                <input type="range" min={0.05} max={1} step={0.05} value={settings.txLevel} onChange={(e) => setSettings({ txLevel: Number(e.target.value) })} />
                <span className="mono">{(settings.txLevel * 100).toFixed(0)}%</span>
              </label>
              <label className="field">
                TX audio frequency
                <input type="number" min={200} max={3000} step={5} value={settings.txFrequency} onChange={(e) => setSettings({ txFrequency: Number(e.target.value) })} />
                <span className="dim">Hz — where your signal sits inside the radio's passband</span>
              </label>
            </div>
          )}

          {tab === 'ptt' && (
            <div className="form">
              <p className="note">
                <strong>Two different things:</strong> transmit <em>audio</em> always comes out of the sound card.
                Keying the radio is separate. VOX needs no hardware control at all. Real PTT control needs a serial
                interface (Web Serial, desktop Chromium only) or the local companion service.
              </p>
              <label className="field">
                PTT method
                <select value={settings.pttMode} onChange={(e) => setSettings({ pttMode: e.target.value as PttMode })}>
                  <option value="vox">VOX (radio keys on audio)</option>
                  <option value="none">None (key the radio manually)</option>
                  <option value="serial-rts">Serial RTS</option>
                  <option value="serial-dtr">Serial DTR</option>
                  <option value="serial-both">Serial RTS + DTR</option>
                  <option value="cat">Serial CAT (Kenwood TX;/RX;)</option>
                  <option value="companion">Companion service (hamlib / rigctld)</option>
                </select>
              </label>
              <div className="row gap">
                <button className="secondary" disabled={!webSerialSupported()} onClick={() => void ptt.connectSerial()}>
                  {webSerialSupported() ? 'connect serial port…' : 'Web Serial unavailable'}
                </button>
                <button className="secondary" onClick={() => void ptt.connectCompanion(settings.companionUrl)}>
                  connect companion service
                </button>
              </div>
              <label className="field">
                Companion service URL
                <input value={settings.companionUrl} onChange={(e) => setSettings({ companionUrl: e.target.value })} />
              </label>
              <div className="status-line">
                Status: <strong>{pttStatus.detail}</strong>
              </div>
              <div className="row gap">
                <button className="secondary" onClick={() => void ptt.key(true)}>
                  test key ON
                </button>
                <button className="secondary" onClick={() => void ptt.key(false)}>
                  test key OFF
                </button>
              </div>
            </div>
          )}

          {tab === 'dsp' && (
            <div className="form">
              <label className="check">
                <input type="checkbox" checked={settings.dsp.auto} onChange={(e) => setSettings({ dsp: { ...settings.dsp, auto: e.target.checked } })} />
                Automatic DSP (recommended)
              </label>
              <p className="dim">
                The pipeline is deliberately conservative: DC removal, narrow hum/carrier notches, band limiting and
                linear gain normalization. No broadband noise reduction — weak digital signals live below the noise
                floor and would be destroyed by it.
              </p>
              {(['dcBlock', 'humSuppression', 'carrierNotch', 'bandpass', 'normalize'] as const).map((k) => (
                <label key={k} className="check">
                  <input
                    type="checkbox"
                    disabled={settings.dsp.auto}
                    checked={settings.dsp[k]}
                    onChange={(e) => setSettings({ dsp: { ...settings.dsp, [k]: e.target.checked } })}
                  />
                  {k}
                </label>
              ))}
              <label className="field">
                Passband
                <input type="number" value={settings.dsp.bandLowHz} onChange={(e) => setSettings({ dsp: { ...settings.dsp, bandLowHz: Number(e.target.value) } })} />
                <input type="number" value={settings.dsp.bandHighHz} onChange={(e) => setSettings({ dsp: { ...settings.dsp, bandHighHz: Number(e.target.value) } })} />
                <span className="dim">Hz</span>
              </label>
              <label className="field">
                Normalization target
                <input type="number" value={settings.dsp.targetLevelDb} onChange={(e) => setSettings({ dsp: { ...settings.dsp, targetLevelDb: Number(e.target.value) } })} />
                <span className="dim">dBFS</span>
              </label>
            </div>
          )}

          {tab === 'decoder' && (
            <div className="form">
              <div className="field">
                Modes decoded in AUTO
                <div className="row wrap gap">
                  {ALL_MODES.filter((m) => m.id !== 'FT2').map((m) => (
                    <label key={m.id} className="check">
                      <input type="checkbox" checked={settings.decodeModes.includes(m.id)} onChange={() => toggleDecodeMode(m.id)} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>
              <label className="check">
                <input type="checkbox" checked={settings.allowFt2} onChange={(e) => setSettings({ allowFt2: e.target.checked })} />
                Enable FT2 (experimental, non-standard — only decodes in this application)
              </label>
              <label className="field">
                Decoder effort (OSD order)
                <select value={settings.osdOrder} onChange={(e) => setSettings({ osdOrder: Number(e.target.value) })}>
                  <option value={-1}>Belief propagation only (fastest, phones)</option>
                  <option value={1}>BP + ordered statistics order 1 (default)</option>
                  <option value={2}>BP + OSD order 2 (slowest, best weak-signal)</option>
                </select>
              </label>
              <label className="field">
                Candidates per slot
                <input type="number" min={5} max={80} value={settings.maxCandidates} onChange={(e) => setSettings({ maxCandidates: Number(e.target.value) })} />
              </label>
              <label className="field">
                Search range
                <input type="number" value={settings.minHz} onChange={(e) => setSettings({ minHz: Number(e.target.value) })} />
                <input type="number" value={settings.maxHz} onChange={(e) => setSettings({ maxHz: Number(e.target.value) })} />
                <span className="dim">Hz</span>
              </label>
            </div>
          )}

          {tab === 'about' && (
            <div className="form about">
              <h3>What is real here</h3>
              <ul>
                <li>
                  <strong>FT8 and FT4</strong> use the actual WSJT-X source encoding (77-bit messages), CRC-14,
                  LDPC(174,91) and GFSK waveforms. Encoded frames were verified bit-for-bit against the reference
                  implementation, and decoding was verified against reference-generated audio.
                </li>
                <li>
                  <strong>JS8</strong> implements the JS8Call modem exactly (Costas 7×7 arrays, LDPC(174,87),
                  CRC-12 ⊕ 42) plus the Huffman "varicode" free-text frames. JSC-compressed frames are detected but
                  reported as unsupported.
                </li>
                <li>
                  <strong>FT2</strong> is <em>not</em> a published mode. It is implemented here as a clearly marked
                  experimental FT8 variant (4× faster) that only interoperates with this application.
                </li>
                <li>
                  Decoding runs in a Web Worker: FFT symbol spectra, Costas sync search, max-log soft metrics,
                  belief propagation and ordered-statistics decoding, plus re-encode verification to reject false
                  decodes.
                </li>
              </ul>
              <h3>Measured sensitivity (synthetic AWGN, this implementation)</h3>
              <ul>
                <li>FT8 ≈ -18 dB (WSJT-X reference ≈ -21 dB)</li>
                <li>FT4 ≈ -14 dB (reference ≈ -17 dB)</li>
                <li>JS8 Normal ≈ -18 dB</li>
              </ul>
              <h3>Browser limits</h3>
              <ul>
                <li>A browser cannot control arbitrary radio hardware. PTT is VOX, Web Serial RTS/DTR/CAT, or the
                  optional local companion service.</li>
                <li>Output device selection needs Chromium's setSinkId; otherwise use the OS default output.</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
