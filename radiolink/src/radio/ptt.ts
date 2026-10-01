/**
 * Push-to-talk control.
 *
 * Be honest about what a browser can and cannot do:
 *
 *  - "Audio/VOX PTT" needs no hardware control at all: the radio's VOX
 *    circuit keys the transmitter when it hears the generated audio. This
 *    always works, in every browser, on a phone as well as a PC.
 *
 *  - "Serial PTT" uses the Web Serial API to assert RTS and/or DTR on a USB
 *    serial adapter, which is how most home-brew and commercial CAT/PTT
 *    interfaces key a radio. Chromium-based desktop browsers only.
 *
 *  - "CAT PTT" and true rig control (frequency, mode, split) require talking
 *    a vendor protocol or Hamlib. Web Serial can send raw CAT bytes for a few
 *    common families, but for full rig control the optional local companion
 *    service (see companion/) bridges to rigctld over a WebSocket.
 *
 * JavaScript in a browser cannot drive arbitrary radio hardware directly and
 * this application never pretends otherwise.
 */

export type PttMode = 'vox' | 'serial-rts' | 'serial-dtr' | 'serial-both' | 'cat' | 'companion' | 'none';

export interface PttStatus {
  mode: PttMode;
  keyed: boolean;
  available: boolean;
  detail: string;
}

type SerialLike = {
  open: (opts: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  setSignals: (signals: { requestToSend?: boolean; dataTerminalReady?: boolean }) => Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
};

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class PttController {
  private port: SerialLike | null = null;
  private ws: WebSocket | null = null;
  private keyed = false;
  private mode: PttMode = 'vox';
  private detail = 'VOX — the radio keys on transmit audio';
  onChange: ((status: PttStatus) => void) | null = null;

  get status(): PttStatus {
    return {
      mode: this.mode,
      keyed: this.keyed,
      available: this.mode === 'vox' || this.port !== null || this.ws?.readyState === WebSocket.OPEN,
      detail: this.detail,
    };
  }

  setMode(mode: PttMode): void {
    this.mode = mode;
    if (mode === 'vox') this.detail = 'VOX — the radio keys on transmit audio';
    if (mode === 'none') this.detail = 'No PTT — transmit audio only, key the radio manually';
    this.emit();
  }

  /** Ask the user for a serial port (must be called from a user gesture). */
  async connectSerial(baudRate = 9600): Promise<boolean> {
    if (!webSerialSupported()) {
      this.detail = 'Web Serial is not available in this browser — use VOX or the companion service';
      this.emit();
      return false;
    }
    try {
      const serial = (navigator as unknown as { serial: { requestPort: () => Promise<SerialLike> } }).serial;
      const port = await serial.requestPort();
      await port.open({ baudRate });
      await port.setSignals({ requestToSend: false, dataTerminalReady: false });
      this.port = port;
      const info = port.getInfo?.();
      this.detail = info?.usbVendorId
        ? `Serial PTT ready (USB ${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16)})`
        : 'Serial PTT ready';
      this.emit();
      return true;
    } catch (err) {
      this.detail = `Serial port not opened: ${(err as Error).message}`;
      this.emit();
      return false;
    }
  }

  async disconnectSerial(): Promise<void> {
    try {
      await this.port?.setSignals({ requestToSend: false, dataTerminalReady: false });
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.emit();
  }

  /** Connect to the optional local companion service (hamlib / rigctld bridge). */
  async connectCompanion(url = 'ws://127.0.0.1:8737'): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          ws.close();
          this.detail = 'Companion service not reachable — start it with `node companion/server.js`';
          this.emit();
          resolve(false);
        }, 2500);
        ws.onopen = () => {
          clearTimeout(timer);
          this.ws = ws;
          this.detail = `Companion service connected (${url})`;
          this.emit();
          resolve(true);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          this.detail = 'Companion service not reachable';
          this.emit();
          resolve(false);
        };
        ws.onclose = () => {
          if (this.ws === ws) {
            this.ws = null;
            this.detail = 'Companion service disconnected';
            this.emit();
          }
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'status' && msg.detail) {
              this.detail = msg.detail;
              this.emit();
            }
          } catch {
            /* ignore */
          }
        };
      } catch {
        resolve(false);
      }
    });
  }

  async key(on: boolean): Promise<void> {
    this.keyed = on;
    try {
      switch (this.mode) {
        case 'serial-rts':
          await this.port?.setSignals({ requestToSend: on });
          break;
        case 'serial-dtr':
          await this.port?.setSignals({ dataTerminalReady: on });
          break;
        case 'serial-both':
          await this.port?.setSignals({ requestToSend: on, dataTerminalReady: on });
          break;
        case 'cat':
          await this.sendCat(on);
          break;
        case 'companion':
          this.ws?.send(JSON.stringify({ type: 'ptt', on }));
          break;
        case 'vox':
        case 'none':
        default:
          break;
      }
    } catch (err) {
      this.detail = `PTT error: ${(err as Error).message}`;
    }
    this.emit();
  }

  /** Kenwood-style CAT PTT ("TX;" / "RX;"), the most widely supported form. */
  private async sendCat(on: boolean): Promise<void> {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(on ? 'TX;' : 'RX;'));
    } finally {
      writer.releaseLock();
    }
  }

  private emit(): void {
    this.onChange?.(this.status);
  }
}
