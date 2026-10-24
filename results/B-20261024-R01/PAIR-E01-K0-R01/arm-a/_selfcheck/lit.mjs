// 临时自检工具(不参与构建):PNG 解码 + 亮度统计 + 双图差异统计
// 用法: node _selfcheck/lit.mjs <a.png> [b.png]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

function stats(img, region) {
  const { w, h, channels, data } = img;
  const x0 = Math.floor((region?.x0 ?? 0) * w), x1 = Math.floor((region?.x1 ?? 1) * w);
  const y0 = Math.floor((region?.y0 ?? 0) * h), y1 = Math.floor((region?.y1 ?? 1) * h);
  let lit = 0, total = 0, sum = 0, maxL = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total++;
      sum += l;
      if (l > maxL) maxL = l;
      if (l > 40) lit++;
    }
  }
  return { litRatio: +(lit / total).toFixed(4), meanLum: +(sum / total).toFixed(1), maxLum: +maxL.toFixed(0) };
}

function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('size mismatch');
  const { w, h } = a;
  const ca = a.channels, cb = b.channels;
  let changed = 0, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ca, j = (y * w + x) * cb;
      const d = Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
      total++;
      if (d > 24) changed++;
    }
  }
  return +(changed / total).toFixed(4);
}

const [f1, f2] = process.argv.slice(2);
const img = decodePng(f1);
console.log(f1, img.w + 'x' + img.h, 'full:', stats(img), 'center80:', stats(img, { x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.9 }), 'hud:', stats(img, { x0: 0.0, x1: 0.22, y0: 0.0, y1: 0.22 }));
if (f2) {
  const img2 = decodePng(f2);
  console.log(f2, img2.w + 'x' + img2.h, 'full:', stats(img2), 'pixelDelta:', diff(img, img2));
}
