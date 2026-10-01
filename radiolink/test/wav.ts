import * as fs from 'fs';
export function writeWav(path: string, samples: Float32Array, rate: number) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path, buf);
}
export function readWav(path: string): { samples: Float32Array; rate: number } {
  const buf = fs.readFileSync(path);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let off = 12;
  let dataOff = 44, dataLen = buf.length - 44;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  const n = dataLen / (bits / 8);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bits === 16 ? buf.readInt16LE(dataOff + i * 2) / 32768 : buf.readFloatLE(dataOff + i * 4);
  return { samples: out, rate };
}
