#!/usr/bin/env node
// ============================================================================
// analyze-png.mjs — Agent 自建自检辅助:解析截图 PNG(8bit RGB/RGBA/Gray),
// 统计指定区域(比例坐标)内亮像素占比(亮度 > 40/255)等指标。
// 用法: node scripts/analyze-png.mjs <png> [--region fx0,fy0,fx1,fy1]
// 本文件属于 Agent 自建自检工具,不属于冻结模板。
// ============================================================================
import fs from 'node:fs';
import zlib from 'node:zlib';

function readPNG(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace !== 0) throw new Error('interlaced png unsupported');
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : -1;
  if (ch < 0) throw new Error('unsupported color type ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let p = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 255; break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[x] = v;
    }
    prev = cur;
  }
  return { w, h, ch, data: out };
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/analyze-png.mjs <png> [--region fx0,fy0,fx1,fy1]');
  process.exit(2);
}
const img = readPNG(file);
let rx0 = 0, ry0 = 0, rx1 = 1, ry1 = 1;
const ri = process.argv.indexOf('--region');
if (ri > 0) [rx0, ry0, rx1, ry1] = process.argv[ri + 1].split(',').map(Number);
const X0 = Math.floor(rx0 * img.w), X1 = Math.ceil(rx1 * img.w);
const Y0 = Math.floor(ry0 * img.h), Y1 = Math.ceil(ry1 * img.h);
let total = 0, lit = 0, sum = 0;
for (let y = Y0; y < Y1; y++) {
  for (let x = X0; x < X1; x++) {
    const i = (y * img.w + x) * img.ch;
    const l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    total++; sum += l;
    if (l > 40) lit++;
  }
}
console.log(JSON.stringify({
  file,
  w: img.w, h: img.h, ch: img.ch,
  region: [rx0, ry0, rx1, ry1],
  total,
  litRatio: +(lit / total).toFixed(5),
  meanLuma: +(sum / total).toFixed(2),
}));
