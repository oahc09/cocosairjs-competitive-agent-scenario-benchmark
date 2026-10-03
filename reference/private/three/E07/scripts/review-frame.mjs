#!/usr/bin/env node
// review-frame.mjs — Reference 实现者的像素级审图工具(写入工作区外临时目录也行,
// 这里放在 E07 工作区 scripts/ 下,属于工作区产物,允许)。
// 用法: node scripts/review-frame.mjs <png> [asciiCols]
// 输出:亮度 ASCII 图(构图)+ 色相字母图(霓虹色分布)+ 分区统计。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// pngjs 来自 harness 的 node_modules(本工作区不装额外依赖)
const here = path.dirname(fileURLToPath(import.meta.url));
const harnessNm = 'E:/AIProMax/Y2026M10/cocosairjs-competitive-agent-scenario-benchmark/bench/harness/node_modules';
const req = createRequire(path.join(harnessNm, 'noop.js'));
const { PNG } = req('pngjs');
void here;

const file = process.argv[2];
const cols = Number(process.argv[3] || 96);
const img = PNG.sync.read(fs.readFileSync(file));
const { width: W, height: H, data } = img;

const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

// --- 亮度 ASCII ---
const rows = Math.round((cols * H) / W / 2);
const chars = ' .:-=+*#%@';
let out = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    const x0 = Math.floor((c * W) / cols);
    const x1 = Math.floor(((c + 1) * W) / cols);
    const y0 = Math.floor((r * H) / rows);
    const y1 = Math.floor(((r + 1) * H) / rows);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += lum((y * W + x) * 4); n++; }
    const v = sum / Math.max(1, n);
    // 对数映射,暗部可辨
    const t = Math.min(1, Math.sqrt(v / 255));
    line += chars[Math.min(chars.length - 1, Math.floor(t * chars.length))];
  }
  out.push(line);
}
console.log('=== LUMINANCE (sqrt gamma) ===');
console.log(out.join('\n'));

// --- 色相字母图(r=红/品红 m=品红 c=青 o=橙 y=黄 w=白/亮 k=暗 .=' .'-) ===
function hueClass(r, g, b, l) {
  if (l < 26) return ' ';
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx - mn;
  if (sat < 28) return l > 200 ? 'W' : l > 120 ? 'w' : '.';
  let h;
  if (mx === r) h = ((g - b) / sat + 6) % 6;
  else if (mx === g) h = (b - r) / sat + 2;
  else h = (r - g) / sat + 4;
  h *= 60;
  if (h < 20 || h >= 340) return 'r';
  if (h < 50) return 'o';
  if (h < 75) return 'y';
  if (h < 160) return 'g';
  if (h < 200) return 'c';
  if (h < 260) return 'C'; // 蓝
  if (h < 310) return 'm'; // 品红
  return 'p'; // 紫
}
out = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    const x0 = Math.floor((c * W) / cols), x1 = Math.floor(((c + 1) * W) / cols);
    const y0 = Math.floor((r * H) / rows), y1 = Math.floor(((r + 1) * H) / rows);
    const cnt = { r: 0, o: 0, y: 0, g: 0, c: 0, C: 0, m: 0, p: 0, W: 0, w: 0, '.': 0, ' ': 0 };
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * 4;
      cnt[hueClass(data[i], data[i + 1], data[i + 2], lum(i))]++;
    }
    let best = ' ', bn = 0;
    for (const k of ['m', 'c', 'o', 'y', 'r', 'W', 'w', '.']) if (cnt[k] > bn) { bn = cnt[k]; best = k; }
    line += best;
  }
  out.push(line);
}
console.log('=== HUE (m=品红 c=青 o=橙 y=黄 r=红 W/w=白 .=中性) ===');
console.log(out.join('\n'));

// --- 分区统计 ---
function regionStats(y0, y1, label) {
  let n = 0, sum = 0, bright = 0, sat = 0, neon = 0, blue = 0;
  let rs = 0, gs = 0, bs = 0;
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++; sum += l; rs += r; gs += g; bs += b;
      if (l > 200) bright++;
      const s = Math.max(r, g, b) - Math.min(r, g, b);
      if (s > 60) { sat++; if (l > 90) neon++; }
      if (b > r + 30 && b > g + 10) blue++;
    }
  }
  console.log(`${label}: avgLum=${(sum / n).toFixed(1)} RGB=(${(rs / n).toFixed(0)},${(gs / n).toFixed(0)},${(bs / n).toFixed(0)}) bright>200=${(100 * bright / n).toFixed(1)}% neonSat=${(100 * neon / n).toFixed(1)}% blueCast=${(100 * blue / n).toFixed(1)}%`);
}
console.log('=== REGIONS ===');
regionStats(0, 0.45, 'upper(sky+towers)');
regionStats(0.45, 0.62, 'mid(skyline)  ');
regionStats(0.62, 1.0, 'lower(street)  ');
regionStats(0, 1, 'full           ');
