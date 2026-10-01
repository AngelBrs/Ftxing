#!/usr/bin/env node
/**
 * RADIOLINK companion service (optional).
 *
 * A browser cannot talk to arbitrary radio hardware. This tiny, dependency-free
 * service runs on the same machine as the browser and bridges:
 *
 *   browser  --WebSocket-->  companion  --TCP-->  rigctld (Hamlib)
 *                                        \--exec-> user command (e.g. gpio, cm108)
 *
 * Supported messages from the browser (JSON over WebSocket):
 *   { "type": "ptt",  "on": true|false }
 *   { "type": "freq", "hz": 14074000 }
 *   { "type": "mode", "mode": "USB" }
 *   { "type": "raw",  "cmd": "f" }         // raw rigctld command
 *   { "type": "ping" }
 *
 * Start rigctld first, e.g.:
 *   rigctld -m 2028 -r /dev/ttyUSB0 -s 38400      (2028 = Yaesu FT-991A, see `rigctl -l`)
 *   rigctld -m 1                                   (dummy rig, for testing)
 *
 * Then:
 *   node companion/server.js --port 8737 --rigctld 127.0.0.1:4532
 *   node companion/server.js --ptt-on "gpioset 0 17=1" --ptt-off "gpioset 0 17=0"
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { exec } = require('child_process');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(getArg('port', 8737));
const RIGCTLD = getArg('rigctld', '127.0.0.1:4532');
const PTT_ON_CMD = getArg('ptt-on', null);
const PTT_OFF_CMD = getArg('ptt-off', null);

const [rigHost, rigPort] = RIGCTLD.split(':');

function rigctl(command) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: rigHost, port: Number(rigPort) }, () => {
      sock.write(command.endsWith('\n') ? command : command + '\n');
    });
    let data = '';
    const done = (result) => {
      try {
        sock.destroy();
      } catch {}
      resolve(result);
    };
    sock.setTimeout(1500, () => done({ ok: false, error: 'rigctld timeout' }));
    sock.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) done({ ok: true, reply: data.trim() });
    });
    sock.on('error', (err) => done({ ok: false, error: err.message }));
  });
}

function shell(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: stderr || err.message } : { ok: true, reply: stdout.trim() });
    });
  });
}

async function handle(msg) {
  switch (msg.type) {
    case 'ptt': {
      if (PTT_ON_CMD || PTT_OFF_CMD) {
        const cmd = msg.on ? PTT_ON_CMD : PTT_OFF_CMD;
        return cmd ? shell(cmd) : { ok: true };
      }
      return rigctl(`T ${msg.on ? 1 : 0}`);
    }
    case 'freq':
      return rigctl(`F ${Math.round(msg.hz)}`);
    case 'mode':
      return rigctl(`M ${msg.mode || 'USB'} 3000`);
    case 'raw':
      return rigctl(String(msg.cmd || ''));
    case 'ping':
      return { ok: true, reply: 'pong' };
    default:
      return { ok: false, error: `unknown message type ${msg.type}` };
  }
}

/* ------------------------------------------------------------------ */
/* Minimal RFC 6455 WebSocket server (text frames only, no deps)       */
/* ------------------------------------------------------------------ */

function sendFrame(socket, text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;
  socket.write(Buffer.concat([header, payload]));
}

function parseFrames(buffer, onText) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let len = buffer[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buffer.length < pos + 2) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buffer.length < pos + 8) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length < pos + 4) break;
      mask = buffer.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buffer.length < pos + len) break;
    const payload = Buffer.from(buffer.subarray(pos, pos + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    offset = pos + len;
    if (opcode === 0x1) onText(payload.toString());
    if (opcode === 0x8) return { rest: buffer.subarray(offset), close: true };
  }
  return { rest: buffer.subarray(offset), close: false };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('RADIOLINK companion service. Connect with a WebSocket.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log('[companion] browser connected');
  sendFrame(socket, JSON.stringify({ type: 'status', detail: `Companion ready (rigctld ${RIGCTLD})` }));

  let buffer = Buffer.alloc(0);
  socket.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { rest, close } = parseFrames(buffer, async (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const result = await handle(msg);
      if (msg.type === 'ptt') console.log(`[companion] PTT ${msg.on ? 'ON' : 'OFF'} -> ${JSON.stringify(result)}`);
      sendFrame(socket, JSON.stringify({ type: 'result', request: msg.type, ...result }));
      if (!result.ok) sendFrame(socket, JSON.stringify({ type: 'status', detail: `Rig error: ${result.error}` }));
    });
    buffer = rest;
    if (close) socket.end();
  });
  socket.on('close', () => console.log('[companion] browser disconnected'));
  socket.on('error', () => socket.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[companion] listening on ws://127.0.0.1:${PORT}`);
  console.log(`[companion] rig control via rigctld at ${RIGCTLD}`);
  if (PTT_ON_CMD) console.log(`[companion] PTT uses shell commands instead of rigctld`);
});
