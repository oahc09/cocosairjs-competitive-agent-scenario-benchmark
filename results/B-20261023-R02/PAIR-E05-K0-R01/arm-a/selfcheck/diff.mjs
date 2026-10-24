// 帧差取证:两帧截图的分区差异比例(全图 / 盘环形区 / 中环带)
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
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

const [f1, f2] = [process.argv[2], process.argv[3]];
const A = decodePNG(f1), B = decodePNG(f2);
const cx = (A.w - 1) / 2, cy = (A.h - 1) / 2;
const TH = 10; // 任一通道差 >10 视为变化像素

const regions = {
  full: () => true,
  diskAnnulus: (x, y) => { const d = Math.hypot(x - cx, y - cy); return d > 60 && d < 300; },
  midRing: (x, y) => { const d = Math.hypot(x - cx, y - cy); return d > 130 && d < 260; },
  coreArea: (x, y) => Math.hypot(x - cx, y - cy) < 55,
};
const R = { files: [f1, f2], changedPixelRatio: {} };
for (const [name, pred] of Object.entries(regions)) {
  let n = 0, tot = 0;
  for (let y = 0; y < A.h; y += 2) for (let x = 0; x < A.w; x += 2) {
    if (!pred(x, y)) continue;
    const i = (y * A.w + x) * A.bpp;
    let ch = false;
    for (let k = 0; k < 3; k++) if (Math.abs(A.data[i + k] - B.data[i + k]) > TH) ch = true;
    if (ch) n++;
    tot++;
  }
  R.changedPixelRatio[name] = +(n / tot).toFixed(4);
}
console.log(JSON.stringify(R, null, 2));
