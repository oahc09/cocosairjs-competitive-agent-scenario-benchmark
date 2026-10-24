// 离线"目视":把截图降采样为 ASCII 亮度图 + 中心剖面(自检用,零网络)
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, ct = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (interlace !== 0) throw new Error('interlaced');
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = raw[p + x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    p += stride;
  }
  return { w, h, bpp, data: out };
}

const img = decodePNG(process.argv[2]);
const { w, h, bpp, data } = img;
const px = (x, y) => { const i = (y * w + x) * bpp; return [data[i], data[i + 1], data[i + 2]]; };

// ASCII 亮度图(80×24 覆盖全图;字符按亮度升序)
const CH = ' .:-=+*#%@';
const cols = 80, rows = 24;
let mapStr = '';
for (let ry = 0; ry < rows; ry++) {
  for (let rx = 0; rx < cols; rx++) {
    let sum = 0, n = 0;
    const x0 = Math.floor((rx * w) / cols), x1 = Math.floor(((rx + 1) * w) / cols);
    const y0 = Math.floor((ry * h) / rows), y1 = Math.floor(((ry + 1) * h) / rows);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const [r, g, b] = px(x, y); sum += (r + g + b) / 3; n++;
    }
    const lum = sum / n;
    mapStr += CH[Math.min(9, Math.floor(lum / 25.6))];
  }
  mapStr += '\n';
}
console.log(mapStr);

// 中心水平剖面(每隔 20px):亮度 + R-B
const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
let prof = 'H-profile(y=360): ';
for (let x = cx - 300; x <= cx + 300; x += 30) {
  const [r, g, b] = px(x, cy);
  prof += `${x - cx}:(L${Math.round((r + g + b) / 3)},RB${Math.round(r - b)}) `;
}
console.log(prof);
let vprof = 'V-profile(x=640): ';
for (let y = cy - 180; y <= cy + 180; y += 20) {
  const [r, g, b] = px(cx, y);
  vprof += `${y - cy}:(L${Math.round((r + g + b) / 3)},RB${Math.round(r - b)}) `;
}
console.log(vprof);
