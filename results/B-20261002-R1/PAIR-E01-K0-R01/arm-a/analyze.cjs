// analyze.cjs — 对 verify-out/P1.png 做结构化像素分析,量化 brief §2 视觉锚点
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePng(buf) {
  let off = 8, w = 0, h = 0, bd = 0, ct = 0, il = 0; const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len); off += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idats.push(data); else if (type === 'IEND') break;
  }
  if (bd !== 8 || il !== 0) throw new Error('unsupported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * ch; const out = Buffer.alloc(h * stride); let pos = 0; const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]; const line = raw.subarray(pos, pos + stride); pos += stride; const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      row[x] = v & 255;
    }
    prev.set(row);
  }
  return { w, h, ch, data: out };
}

const img = decodePng(fs.readFileSync(path.join(__dirname, 'verify-out', 'P1.png')));
const { w, h } = img;
const px = (x, y) => { const i = (y * w + x) * img.ch; return img.ch >= 3 ? [img.data[i], img.data[i + 1], img.data[i + 2]] : [img.data[i], img.data[i], img.data[i]]; };

// 1) 背景暗度:四角 60x60
let bgSum = 0, bgN = 0, bgMax = 0;
for (const [cx, cy] of [[30, 30], [w - 30, 30], [30, h - 30], [w - 30, h - 30]]) {
  for (let dy = -30; dy < 30; dy += 2) for (let dx = -30; dx < 30; dx += 2) {
    const [r, g, b] = px(cx + dx, cy + dy); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    bgSum += l; bgN++; if (l > bgMax) bgMax = l;
  }
}

// 2) 亮度质心
let sx = 0, sy = 0, st = 0;
for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
  const [r, g, b] = px(x, y); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (l > 40) { sx += x * l; sy += y * l; st += l; }
}
const cx = sx / st, cy = sy / st;

// 3) 径向亮度剖面 + 颜色梯度(核球 vs 外缘)
const bands = [0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0];
const prof = bands.map((f) => ({ f, l: 0, n: 0, r: 0, b: 0 }));
const Rref = Math.min(w, h) * 0.44; // 星系大致半径参考
for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
  const dx = x - cx, dy = y - cy; const rr = Math.sqrt(dx * dx + dy * dy) / Rref;
  const [r, g, b] = px(x, y); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (const band of prof) if (rr <= band.f) { band.l += l; band.n++; band.r += r; band.b += b; break; }
}
const profile = prof.map((p) => ({ rFrac: p.f, meanLuma: +(p.l / p.n).toFixed(1), warmthRB: +((p.r - p.b) / p.n).toFixed(1) }));

// 4) 旋臂角向结构:半径带 0.35–0.85,按 36 个角度扇区求亮度
const sectors = new Array(36).fill(0), secN = new Array(36).fill(0);
for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
  const dx = x - cx, dy = y - cy; const rr = Math.sqrt(dx * dx + dy * dy) / Rref;
  if (rr < 0.35 || rr > 0.85) continue;
  const ang = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI); const k = Math.min(35, Math.floor(ang * 36));
  const [r, g, b] = px(x, y); sectors[k] += 0.2126 * r + 0.7152 * g + 0.0722 * b; secN[k]++;
}
const means = sectors.map((s, i) => s / Math.max(1, secN[i]));
const m = means.reduce((a, b) => a + b, 0) / means.length;
const varr = means.reduce((a, b) => a + (b - m) * (b - m), 0) / means.length;
const cv = Math.sqrt(varr) / m; // 变异系数 >0 说明有角向结构(旋臂)
// m=2 傅里叶幅(两臂)
let re2 = 0, im2 = 0;
means.forEach((v, k) => { const th = (k / 36) * 2 * Math.PI; re2 += v * Math.cos(2 * th); im2 += v * Math.sin(2 * th); });
const amp2 = Math.sqrt(re2 * re2 + im2 * im2) / means.length / m;
// 找最亮两个扇区(应相差约 18 扇区 = 180°)
let i1 = 0; means.forEach((v, i) => { if (v > means[i1]) i1 = i; });
let i2 = -1; means.forEach((v, i) => { if (i !== i1 && (i2 < 0 || v > means[i2])) i2 = i; });

// 5) 橙红亮星存在性:盘面内 r 明显大于 b 的亮像素
let redStars = 0;
for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
  const dx = x - cx, dy = y - cy; const rr = Math.sqrt(dx * dx + dy * dy) / Rref;
  if (rr > 0.9) continue;
  const [r, g, b] = px(x, y);
  if (r > 120 && r > b + 40) redStars++;
}

// 6) 亮暗层级:亮像素 luma 十分位分布
const lumas = [];
for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
  const [r, g, b] = px(x, y); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (l > 40) lumas.push(l);
}
lumas.sort((a, b) => a - b);
const q = (f) => +lumas[Math.floor(f * (lumas.length - 1))].toFixed(0);

console.log(JSON.stringify({
  image: { w, h },
  cornerBackground: { meanLuma: +(bgSum / bgN).toFixed(2), maxLuma: +bgMax.toFixed(1), darkEnough: bgSum / bgN < 16 },
  centroid: { x: Math.round(cx), y: Math.round(cy) },
  radialProfile: profile,
  armStructure: { angularCV: +cv.toFixed(3), m2Amplitude: +amp2.toFixed(3), brightestSectors: [i1, i2], sectorSeparation: Math.abs(i1 - i2) },
  redBrightPixels: redStars,
  brightnessTiers: { p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99) },
  litPixelCount: lumas.length * 9,
}, null, 2));
