// Local pixel analysis of probe screenshots (no network, zero deps beyond node).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'shots');

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const s = x * ch;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
    }
    prev = cur;
  }
  return { width, height, pixels: out };
}

function analyze(name) {
  const img = decodePng(fs.readFileSync(path.join(SHOTS, name + '.png')));
  const { width: W, height: H, pixels: P } = img;
  console.log(`\n=== ${name} (${W}x${H}) ===`);

  // 1) Horizon: largest mean-luminance discontinuity between adjacent row means (top 60%)
  const rowMean = [];
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x += 4) {
      const i = (y * W + x) * 3;
      s += 0.3 * P[i] + 0.5 * P[i + 1] + 0.2 * P[i + 2];
    }
    rowMean.push(s / (W / 4));
  }
  let bestY = 0, bestD = 0;
  for (let y = 1; y < H * 0.6; y++) {
    const d = Math.abs(rowMean[y] - rowMean[y - 1]);
    if (d > bestD) { bestD = d; bestY = y; }
  }
  console.log(`horizon: strongest row-luma discontinuity at y=${bestY} (${(bestY / H).toFixed(3)} of height), delta=${bestD.toFixed(1)}`);

  // 2) Sun disc: brightest 0.05% pixel centroid in top half
  let sunX = 0, sunY = 0, sunN = 0, sunMax = 0;
  for (let y = 0; y < H;  y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 3;
    const l = P[i] + P[i + 1] + P[i + 2];
    if (l > sunMax) sunMax = l;
  }
  const thr = sunMax * 0.93;
  for (let y = 0; y < H * 0.55; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 3;
    if (P[i] + P[i + 1] + P[i + 2] > thr) { sunX += x; sunY += y; sunN += 1; }
  }
  if (sunN > 0) console.log(`bright disc centroid: (${(sunX / sunN / W).toFixed(3)}, ${(sunY / sunN / H).toFixed(3)}) n=${sunN}`);

  // 3) Boat: in center box [0.34..0.66]x[0.36..0.64], cluster hues of pixels far from local sea/sky base
  const bx0 = Math.floor(W * 0.34), bx1 = Math.ceil(W * 0.66);
  const by0 = Math.floor(H * 0.36), by1 = Math.ceil(H * 0.64);
  // base = median-ish color of region border ring (sea around boat)
  const samples = [];
  for (let y = by0; y < by1; y += 3) for (let x = bx0; x < bx1; x += 3) {
    const edge = y < by0 + 12 || y > by1 - 12 || x < bx0 + 12 || x > bx1 - 12;
    if (edge) samples.push([P[(y * W + x) * 3], P[(y * W + x) * 3 + 1], P[(y * W + x) * 3 + 2]]);
  }
  const med = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
  const mR = med(samples.map((s) => s[0])), mG = med(samples.map((s) => s[1])), mB = med(samples.map((s) => s[2]));
  const clusters = new Map();
  let boatPixels = 0, totalPixels = 0;
  for (let y = by0 + 12; y < by1 - 12; y += 2) for (let x = bx0 + 12; x < bx1 - 12; x += 2) {
    const i = (y * W + x) * 3;
    totalPixels += 1;
    const dist = Math.abs(P[i] - mR) + Math.abs(P[i + 1] - mG) + Math.abs(P[i + 2] - mB);
    if (dist > 60) {
      boatPixels += 1;
      const key = `${Math.round(P[i] / 48)}_${Math.round(P[i + 1] / 48)}_${Math.round(P[i + 2] / 48)}`;
      clusters.set(key, (clusters.get(key) || 0) + 1);
    }
  }
  const top = [...clusters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => `${k.replace(/_/g, ',')}~${n}`);
  console.log(`boat box: deviant-pixel ratio=${((boatPixels / totalPixels) * 100).toFixed(1)}%, distinct clusters=${clusters.size}`);
  console.log(`  top clusters (r,g,b bucket~count): ${top.join(' | ')}`);
}

analyze('p1');
analyze('p5a_warm');
analyze('p5b_cool');
analyze('p6');
