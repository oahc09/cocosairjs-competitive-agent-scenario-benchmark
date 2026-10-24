// Minimal PNG (8-bit RGBA/RGB, non-interlaced) inspector for self-check diagnostics.
// Usage: node tools/inspect.mjs <png> [rowStart] [rowEnd]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const rowStart = Number(process.argv[3] || 0);
const rowEnd = Number(process.argv[4] || 0);

const buf = fs.readFileSync(file);
let off = 8;
let w = 0, h = 0, bpp = 4, bitDepth = 8, colorType = 6;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    w = data.readUInt32BE(0); h = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9];
    bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  off += 12 + len;
}
if (bitDepth !== 8) throw new Error('only 8-bit supported: ' + bitDepth);
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = w * bpp;
const px = Buffer.alloc(w * h * bpp);
let prev = Buffer.alloc(stride);
let p = 0;
for (let y = 0; y < h; y++) {
  const f = raw[p++];
  const line = raw.subarray(p, p + stride); p += stride;
  const out = px.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? out[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    let v = line[x];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    }
    out[x] = v & 255;
  }
  prev = out;
}

const at = (x, y) => { const i = (y * w + x) * bpp; return [px[i], px[i + 1], px[i + 2]]; };
const y0 = rowStart, y1 = rowEnd > 0 ? rowEnd : h;

// Row band averages (16 bands) + horizontal-anomaly detection (slivers).
console.log(JSON.stringify({ w, h, colorType }));
const bands = 12;
for (let b = 0; b < bands; b++) {
  const ya = Math.floor(y0 + (y1 - y0) * b / bands), yb = Math.floor(y0 + (y1 - y0) * (b + 1) / bands);
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = ya; y < yb; y += 2) for (let x = 0; x < w; x += 2) { const c = at(x, y); r += c[0]; g += c[1]; bl += c[2]; n++; }
  console.log('band', ya + '-' + yb, 'avg', (r / n).toFixed(1), (g / n).toFixed(1), (bl / n).toFixed(1));
}

// horizontal anomaly: pixel differs >18 from both left and right (thin vertical-ish features)
const weird = [];
for (let y = y0; y < y1; y += 1) {
  let run = 0;
  for (let x = 2; x < w - 2; x++) {
    const c = at(x, y), l = at(x - 2, y), r = at(x + 2, y);
    const dl = Math.abs(c[0] - l[0]) + Math.abs(c[1] - l[1]) + Math.abs(c[2] - l[2]);
    const dr = Math.abs(c[0] - r[0]) + Math.abs(c[1] - r[1]) + Math.abs(c[2] - r[2]);
    if (dl > 30 && dr > 30) run++;
  }
  if (run > 3) weird.push([y, run]);
}
console.log('rows with horizontal anomalies:', weird.length);
console.log(weird.slice(0, 30).map((v) => v.join(':')).join(' '));
