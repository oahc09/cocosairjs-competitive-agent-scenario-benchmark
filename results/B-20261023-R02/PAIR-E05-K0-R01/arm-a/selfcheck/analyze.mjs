// 自检用离线像素分析:极简 PNG 解码(zlib)+ E05 探针区域统计
// 用法: node analyze.mjs <png> [对比png]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, ct = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      ct = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (interlace !== 0) throw new Error('interlaced png unsupported');
  if (ct !== 6 && ct !== 2) throw new Error('colortype ' + ct + ' unsupported');
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

function px(img, x, y) {
  const i = (y * img.w + x) * img.bpp;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

const file = process.argv[2];
const img = decodePNG(file);
const { w, h } = img;
const cx = (w - 1) / 2, cy = (h - 1) / 2;
const minD = Math.min(w, h);
const R = { file, w, h };

// ---- P1 nonBlank: center-third 与 outer-corners(多阈值口径) ----
function nonBlackRatio(x0, y0, x1, y1, thr) {
  let n = 0, tot = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const [r, g, b] = px(img, x, y);
    if (r > thr || g > thr || b > thr) n++;
    tot++;
  }
  return n / tot;
}
const c3 = { x0: Math.floor(w / 3), x1: Math.ceil((2 * w) / 3), y0: 0, y1: h };
R.centerThird = { thr1: nonBlackRatio(c3.x0, c3.y0, c3.x1, c3.y1, 1), thr8: nonBlackRatio(c3.x0, c3.y0, c3.x1, c3.y1, 8), thr16: nonBlackRatio(c3.x0, c3.y0, c3.x1, c3.y1, 16) };
const box = 0.2;
R.corners = {};
for (const thr of [1, 8, 16]) {
  const vals = [];
  vals.push(nonBlackRatio(0, 0, Math.floor(w * box), Math.floor(h * box), thr));
  vals.push(nonBlackRatio(Math.ceil(w * (1 - box)), 0, w, Math.floor(h * box), thr));
  vals.push(nonBlackRatio(0, Math.ceil(h * (1 - box)), Math.floor(w * box), h, thr));
  vals.push(nonBlackRatio(Math.ceil(w * (1 - box)), Math.ceil(h * (1 - box)), w, h, thr));
  R.corners['thr' + thr] = { min: Math.min(...vals), vals: vals.map((v) => +v.toFixed(4)) };
}

// ---- 暗核:中心 20px 半径平均亮度 vs 周围亮环 ----
{
  let sum = 0, n = 0;
  for (let y = Math.floor(cy - 18); y <= cy + 18; y++) for (let x = Math.floor(cx - 18); x <= cx + 18; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= 18 * 18) { const [r, g, b] = px(img, x, y); sum += (r + g + b) / 3; n++; }
  }
  let ring = 0, rn = 0;
  for (let y = Math.floor(cy - 100); y <= cy + 100; y++) for (let x = Math.floor(cx - 110); x <= cx + 110; x++) {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (d2 >= 55 * 55 && d2 <= 95 * 95) { const [r, g, b] = px(img, x, y); ring += (r + g + b) / 3; rn++; }
  }
  R.core = { centerLum: +(sum / n).toFixed(1), ringLum: +(ring / rn).toFixed(1) };
}

// ---- P3:方位扇区有向 R-B 差(±X 水平带,|dy|<=6%h) ----
{
  const band = Math.floor(0.06 * h);
  const bands = {
    inner: [0.06 * minD, 0.14 * minD],
    outer: [0.18 * minD, 0.30 * minD],
  };
  function sample(rr, side) {
    let rb = 0, lum = 0, n = 0;
    for (let y = Math.floor(cy - band); y <= Math.ceil(cy + band); y++) {
      if (y < 0 || y >= h) continue;
      for (let k = Math.ceil(rr[0]); k <= Math.floor(rr[1]); k++) {
        const x = side > 0 ? Math.round(cx + k) : Math.round(cx - k);
        if (x < 0 || x >= w) continue;
        const [r, g, b] = px(img, x, y);
        rb += r - b; lum += (r + g + b) / 3; n++;
      }
    }
    return { rb: rb / n, lum: lum / n, n };
  }
  const right = { inner: sample(bands.inner, +1), outer: sample(bands.outer, +1) };
  const left = { inner: sample(bands.inner, -1), outer: sample(bands.outer, -1) };
  function sideSummary(s) {
    return {
      innerRB: +s.inner.rb.toFixed(1), innerLum: +s.inner.lum.toFixed(1),
      outerRB: +s.outer.rb.toFixed(1), outerLum: +s.outer.lum.toFixed(1),
      directedDiff: +(s.outer.rb - s.inner.rb).toFixed(1),
      lumRatio: +(s.inner.lum / s.outer.lum).toFixed(2),
    };
  }
  R.p3 = { right: sideSummary(right), left: sideSummary(left) };
}

// ---- 曝光:接近纯白像素占比(死白检查) ----
{
  let white = 0, tot = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const [r, g, b] = px(img, x, y);
    if (r > 250 && g > 250 && b > 250) white++;
    tot++;
  }
  R.overexposed = +(white / tot).toFixed(4);
}

// ---- 可选:对比图(缩放构图变化:暗核/盘外缘像素半径) ----
if (process.argv[3]) {
  const img2 = decodePNG(process.argv[3]);
  function coreRadius(im) { // 从中心向外找暗核→亮环跃迁半径
    let rr = 0;
    for (let k = 6; k < 300; k++) {
      let lum = 0, n = 0;
      for (let a = 0; a < 32; a++) {
        const t = (a / 32) * 2 * Math.PI;
        const x = Math.round((im.w - 1) / 2 + Math.cos(t) * k), y = Math.round((im.h - 1) / 2 + Math.sin(t) * k);
        if (x < 0 || y < 0 || x >= im.w || y >= im.h) continue;
        const i = (y * im.w + x) * im.bpp;
        lum += (im.data[i] + im.data[i + 1] + im.data[i + 2]) / 3; n++;
      }
      lum /= n;
      if (lum > 120) { rr = k; break; }
    }
    return rr;
  }
  R.coreRadius = { initial: coreRadius(img), zoomed: coreRadius(img2) };
  R.coreRadius.ratio = +(R.coreRadius.zoomed / R.coreRadius.initial).toFixed(2);
}

console.log(JSON.stringify(R, null, 2));
