// ascii.cjs — 将截图降采样为 ASCII 亮度图,离线目检星系结构
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePng(buf) {
  let off = 8, w = 0, h = 0; const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len); off += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idats.push(data); else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * 4; const out = Buffer.alloc(h * stride); let pos = 0; const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]; const line = raw.subarray(pos, pos + stride); pos += stride; const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0; let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      row[x] = v & 255;
    }
    prev.set(row);
  }
  return { w, h, data: out };
}

const file = process.argv[2] || 'P1.png';
const img = decodePng(fs.readFileSync(path.join(__dirname, 'verify-out', file)));
const COLS = 110, ROWS = 44; // 1280/110≈11.6px, 720/44≈16.4px 每字符块
const CH = ' .:-=+*#%@';
let lines = [];
for (let r = 0; r < ROWS; r++) {
  let line = '';
  for (let c = 0; c < COLS; c++) {
    let sum = 0, n = 0, mx = 0;
    const x0 = Math.floor((c * img.w) / COLS), x1 = Math.floor(((c + 1) * img.w) / COLS);
    const y0 = Math.floor((r * img.h) / ROWS), y1 = Math.floor(((r + 1) * img.h) / ROWS);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * img.w + x) * 4;
      const l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      sum += l; n++; if (l > mx) mx = l;
    }
    const mean = sum / Math.max(1, n);
    const v = Math.max(0, Math.min(1, mean / 30)); // 平均亮度,低天花板突出结构
    line += CH[Math.round(v * (CH.length - 1))];
  }
  lines.push(line);
}
console.log('=== ' + file + ' (mean-luma ASCII, ceiling 30) ===');
console.log(lines.join('\n'));
