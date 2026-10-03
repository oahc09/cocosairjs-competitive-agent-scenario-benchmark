// project.cjs — 离线复算:重放 main.js 的确定性生成序列,重建相机投影,
// 找出远景背景星在屏幕顶部边缘的投影,判明 y=0 亮线来源。
// 相机:P1 时刻(cameraDistance=120, 无视差),fov60, aspect 1280/720。

// ---- 以下生成代码逐字拷贝自 src/main.js(保证 rnd() 调用序列一致)----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x0e01a75a);
let gaussSpare = null;
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const m = Math.sqrt((-2 * Math.log(s)) / s);
  gaussSpare = v * m;
  return u * m;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const R_GAL = 78, ARM_R0 = 7, ARM_B = 0.231;
const COUNT_BULGE = 9000, COUNT_ARM_PER = 13500, ARM_COUNT = 2, COUNT_DISK = 15000, COUNT_GIANTS = 1300, COUNT_BG = 7800;
function diskHeight(r) { return 1.4 + 2.6 * Math.exp(-r / 16); }
const C_CORE = [1.0, 0.9, 0.72], C_MIDIN = [0.96, 0.94, 0.9], C_ARM = [0.78, 0.84, 1.0], C_EDGE = [0.55, 0.66, 1.0];
function radialColor(t, out) {
  let c0, c1, k;
  if (t < 0.3) { c0 = C_CORE; c1 = C_MIDIN; k = t / 0.3; }
  else if (t < 0.65) { c0 = C_MIDIN; c1 = C_ARM; k = (t - 0.3) / 0.35; }
  else { c0 = C_ARM; c1 = C_EDGE; k = (t - 0.65) / 0.35; }
  for (let i = 0; i < 3; i++) out[i] = clamp(lerp(c0[i], c1[i], k) * (0.92 + 0.16 * rnd()), 0, 1);
  return out;
}
function tierSize() {
  const u = rnd();
  if (u < 0.12) return 0.5 + 0.25 * rnd();
  if (u < 0.82) return 0.36 + 0.18 * rnd();
  return 0.24 + 0.12 * rnd();
}
const tmpC = [0, 0, 0];
// bulge
for (let n = 0; n < COUNT_BULGE; n++) {
  const rr = Math.abs(gauss()) * 5.5 + Math.abs(gauss()) * 2.0;
  const r = Math.min(rr, 17);
  const th = rnd() * Math.PI * 2;
  const h = (4.2 * Math.exp(-(r * r) / 120) + 1.1) * gauss();
  const intensity = 0.85 + 0.15 * rnd();
  const c = radialColor(clamp(r / R_GAL, 0, 0.3) * 0.9, tmpC);
  const size = rnd() < 0.1 ? 1.0 + 0.3 * rnd() : 0.55 + 0.5 * rnd();
}
// arms
for (let arm = 0; arm < ARM_COUNT; arm++) {
  const phase = (arm * Math.PI * 2) / ARM_COUNT;
  for (let n = 0; n < COUNT_ARM_PER; n++) {
    const u = Math.pow(rnd(), 1.15);
    const r = ARM_R0 + (R_GAL - ARM_R0) * u;
    const t = r / R_GAL;
    const sigma = 2.0 + 0.05 * r;
    const th = Math.log(r / ARM_R0) / ARM_B + phase + (gauss() * sigma) / r;
    const h = gauss() * diskHeight(r);
    radialColor(t, tmpC);
    const intensity = lerp(0.95, 0.55, t) * (0.8 + 0.4 * rnd());
    tierSize();
  }
}
// disk
for (let n = 0; n < COUNT_DISK; n++) {
  const u = Math.pow(rnd(), 1.3);
  const r = ARM_R0 + (R_GAL - ARM_R0) * u;
  const t = r / R_GAL;
  const th = rnd() * Math.PI * 2;
  const h = gauss() * diskHeight(r) * 1.15;
  radialColor(t, tmpC);
  const intensity = lerp(0.85, 0.45, t) * (0.75 + 0.35 * rnd());
  tierSize();
}
// giants
for (let n = 0; n < COUNT_GIANTS; n++) {
  const r = 8 + 62 * Math.pow(rnd(), 0.9);
  const th = rnd() * Math.PI * 2;
  gauss();
  0.45 + 0.1 * rnd();
}
// ---- 背景星(需要真实位置/尺寸/颜色)----
const bg = [];
for (let n = 0; n < COUNT_BG; n++) {
  const cz = rnd() * 2 - 1;
  const phi = rnd() * Math.PI * 2;
  const sxy = Math.sqrt(Math.max(0, 1 - cz * cz));
  const radius = 500 + 400 * rnd();
  const x = sxy * Math.cos(phi) * radius, y = cz * radius, z = sxy * Math.sin(phi) * radius;
  const u = rnd();
  let c;
  if (u < 0.7) c = [0.75, 0.82, 1.0];
  else if (u < 0.9) c = [1.0, 0.95, 0.85];
  else c = [1.0, 0.7, 0.5];
  const intensity = 0.25 + 0.45 * rnd();
  const size = 0.9 + 0.9 * rnd();
  bg.push({ x, y, z, c: c.map((v) => v * intensity), size });
}

// ---- 相机与投影(three.js lookAt 语义手动复算)----
const ELEV = (38 * Math.PI) / 180, D = 120;
const E = [0, Math.sin(ELEV) * D, Math.cos(ELEV) * D];
const zAxis = E.map((v) => v / D); // normalize(E - 0)
const xAxis = [1, 0, 0]; // cross(worldUp, z) 归一化
const yAxis = [0, zAxis[2], -zAxis[1]]; // cross(z, x)
const TAN = Math.tan((60 * Math.PI) / 360), ASPECT = 1280 / 720, USCALE = 720 / (2 * TAN);
function project(p) {
  const dx = p[0] - E[0], dy = p[1] - E[1], dz = p[2] - E[2];
  const vx = xAxis[0] * dx + xAxis[1] * dy + xAxis[2] * dz;
  const vy = yAxis[0] * dx + yAxis[1] * dy + yAxis[2] * dz;
  const vz = zAxis[0] * dx + zAxis[1] * dy + zAxis[2] * dz; // 相机空间 z(朝前为负)
  const depth = -vz;
  const ndcY = vy / (TAN * depth);
  const ndcX = vx / (TAN * ASPECT * depth);
  return { depth, ndcX, ndcY, screenX: (ndcX + 1) / 2 * 1280, screenY: (1 - ndcY) / 2 * 720 };
}

const stats = { total: bg.length, behind: 0, topZone: 0, inside: 0, samples: [] };
for (const s of bg) {
  const pr = project([s.x, s.y, s.z]);
  if (pr.depth <= 0) stats.behind++;
  const r = (s.size * USCALE / Math.max(pr.depth, 0.1)) / 2; // 精灵半径 px
  if (pr.ndcY > 0.9 && pr.ndcY < 2.0 && Math.abs(pr.ndcX) < 1.1) {
    stats.topZone++;
    if (stats.samples.length < 14) {
      stats.samples.push({
        screenX: Math.round(pr.screenX), screenY: Math.round(pr.screenY), ndcY: +pr.ndcY.toFixed(3),
        depth: Math.round(pr.depth), radiusPx: +r.toFixed(1), color: s.c.map((v) => +v.toFixed(2)),
      });
    }
  }
  if (Math.abs(pr.ndcX) < 1 && Math.abs(pr.ndcY) < 1 && pr.depth > 0) stats.inside++;
}
console.log(JSON.stringify(stats, null, 1));
