#!/usr/bin/env node
// Parse an (A)PNG's chunks back and print what selftest.sh checks, as JSON:
//   { width, height, chunks, frames, plays, delays, seqOk, crcOk, framesOk, size }
// Usage: node apng.cjs <file.png>
const fs = require('fs');
const { crc32 } = require('../skills/ui-diff/scripts/lib.cjs');

const buf = fs.readFileSync(process.argv[2]);
const r = { chunks: [], seqOk: true, crcOk: true, size: buf.length };
if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not a PNG');
const seqs = [];
const fctl = [];
for (let o = 8; o < buf.length;) {
  const len = buf.readUInt32BE(o);
  const type = buf.toString('ascii', o + 4, o + 8);
  const data = buf.subarray(o + 8, o + 8 + len);
  if (crc32(buf.subarray(o + 4, o + 8 + len)) !== buf.readUInt32BE(o + 8 + len)) r.crcOk = false;
  r.chunks.push(type);
  if (type === 'IHDR') { r.width = data.readUInt32BE(0); r.height = data.readUInt32BE(4); }
  if (type === 'acTL') { r.frames = data.readUInt32BE(0); r.plays = data.readUInt32BE(4); }
  if (type === 'fcTL') { seqs.push(data.readUInt32BE(0)); fctl.push({ w: data.readUInt32BE(4), h: data.readUInt32BE(8), x: data.readUInt32BE(12), y: data.readUInt32BE(16), ms: (data.readUInt16BE(20) * 1000) / (data.readUInt16BE(22) || 100), blend: data[25] }); }
  if (type === 'fdAT') seqs.push(data.readUInt32BE(0));
  o += 12 + len;
}
r.seqOk = seqs.every((s, i) => s === i);
r.delays = fctl.map((f) => f.ms);
// One fcTL per frame, inside the image; the first covers it all and its data is the IDAT.
r.framesOk = fctl.length === r.frames && fctl.every((f) => f.x + f.w <= r.width && f.y + f.h <= r.height)
  && fctl[0].w === r.width && fctl[0].h === r.height && r.chunks.indexOf('fcTL') < r.chunks.indexOf('IDAT');
console.log(JSON.stringify(r));
