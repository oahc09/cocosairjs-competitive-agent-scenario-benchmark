// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)— Three.js 实现
// ----------------------------------------------------------------------------
// 页面契约(冻结,见 index.html 与 RUN-CONTRACT §5):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//   Reset 控件        : HUD 内按钮 data-ui="reset" + aria-label="reset"
//
// 实现要点(对应 spec.json 探针):
//   - 60,000 星点批量提交:2 个 THREE.Points draw call(旋臂盘面+核球 56k、
//     远景背景星 4k),全部程序化生成,无外部图片/模型;
//   - 旋臂 = 对数螺旋 θ = 2·ln(r/2),2 条主旋臂 + 盘面散星;核球为中央高斯亮星群;
//   - 颜色沿半径梯度:暖黄白 → 蓝白 → 冷蓝,散布橙红亮星;亮度三档
//     (核球亮星 / 盘面普通星 / 暗弱背景星);
//   - rotationPhase 以 0.05 rad/s(规格区间 0.02–0.1)时钟增量单调递增;
//   - 滚轮改 targetDistance(范围钳制 [40,400]),实际距离逐帧指数插值
//     (τ=0.5s 平滑穿行;reset 后 τ=0.12s 快速但仍平滑地归位,1s 内完成);
//   - 视差 = 指针偏离画面中心的有符号偏移,满幅 ±5% 画布(≤10% 上限),
//     指数平滑、无过冲;
//   - fps 为 2s 滚动窗真实帧率;HUD 数字全部来自运行状态(四舍五入显示);
//   - reset:rotationPhase 立即归零、距离/视差平滑归位、epoch+1,无整页刷新。
// ============================================================================

import * as THREE from 'three';

// --- 常量与状态(与 spec.json stateContract 一一对应) -------------------------
const INIT_DISTANCE = 120;   // 初始相机距离(状态报告单位)
const MIN_DISTANCE = 40;
const MAX_DISTANCE = 400;
const ANGULAR_SPEED = 0.05;  // rad/s,规格区间 [0.02, 0.1]
const PARALLAX_MAX = 0.05;   // 视差满幅(画布尺寸比例,规格上限 0.1)
const DISK_STARS = 48000;    // 旋臂 + 盘面散星
const BULGE_STARS = 8000;    // 核球(计入星点总数)
const BG_STARS = 4000;       // 远景背景星(纵深层)
const GALAXY_R = 70;         // 星系盘半径(世界单位)

let rotationPhase = 0;       // 初始 0,单调递增,reset 归零
let epoch = 0;               // reset 计数,初始 0
let distance = INIT_DISTANCE;
let targetDistance = INIT_DISTANCE;
let parX = 0, parY = 0;      // 视差(平滑后)
let parTX = 0, parTY = 0;    // 视差目标(指针即时值)
let resetting = false;       // reset 后短暂使用更快的归位时间常数
let fps = 0;
let hudVisible = true;
const frameTimes = [];       // 2s 滚动窗帧时间戳(ms)

// --- 画布与渲染器 --------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030a); // 近纯黑深空色,暗于 RGB(16,16,24)

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  2500 // 覆盖最远背景星(~900)
);
const ELEV = (34 * Math.PI) / 180; // 相机仰角 34° → 盘面法线与视线夹角 56° ∈ [30°,60°]

// --- 程序化星点纹理(径向渐变辉光,非外部图片) ---------------------------------
function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const starTex = makeStarTexture();

// --- 确定性随机(同一构建产物行为一致) ------------------------------------------
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261006);
function gauss() {
  // Box-Muller:标准正态
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// --- 颜色梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝 ---------------------------------
const WARM = [1.0, 0.93, 0.78];
const MID = [0.88, 0.93, 1.0];
const COOL = [0.55, 0.72, 1.0];
function radiusColor(t, out, o) {
  let r, g, b;
  if (t < 0.3) {
    const k = t / 0.3;
    r = WARM[0] + (MID[0] - WARM[0]) * k;
    g = WARM[1] + (MID[1] - WARM[1]) * k;
    b = WARM[2] + (MID[2] - WARM[2]) * k;
  } else {
    const k = (t - 0.3) / 0.7;
    r = MID[0] + (COOL[0] - MID[0]) * k;
    g = MID[1] + (COOL[1] - MID[1]) * k;
    b = MID[2] + (COOL[2] - MID[2]) * k;
  }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

// --- 星系生成:旋臂盘面 + 核球(56k,一个 Points 批量提交) ----------------------
const GALAXY_STARS = DISK_STARS + BULGE_STARS;
const gPos = new Float32Array(GALAXY_STARS * 3);
const gCol = new Float32Array(GALAXY_STARS * 3);

for (let i = 0; i < DISK_STARS; i++) {
  const o = i * 3;
  let r, theta;
  if (rng() < 0.72) {
    // 主旋臂星:对数螺旋 θ = 2·ln(r/2),两条(相位差 π),法向高斯散布成臂宽
    const arm = i % 2;
    r = 6 + (GALAXY_R - 6) * Math.pow(rng(), 0.75);
    theta = arm * Math.PI + 2.0 * Math.log(r / 2) + gauss() * (0.20 + 0.10 * (r / GALAXY_R));
    r += gauss() * 1.8;
  } else {
    // 盘面散星:填补旋臂之间,半径分布偏内密外疏
    r = GALAXY_R * Math.pow(rng(), 0.55);
    theta = rng() * Math.PI * 2;
  }
  r = clamp(r, 0.5, GALAXY_R * 1.05);
  // 盘厚:中心隆起、外缘薄(非纸片)
  const y = gauss() * (1.1 + 6.0 * Math.exp(-r / 12));
  gPos[o] = Math.cos(theta) * r;
  gPos[o + 1] = y;
  gPos[o + 2] = Math.sin(theta) * r;

  // 颜色沿半径梯度 + 少量橙红亮星
  const t = clamp(r / GALAXY_R, 0, 1);
  let br;
  const tier = rng();
  if (tier < 0.14) br = 0.16 + 0.14 * rng();        // 暗弱背景盘星(层级 3)
  else if (tier < 0.945) br = 0.45 + 0.35 * rng();  // 盘面普通星(层级 2)
  else br = 0.85 + 0.40 * rng();                    // 亮巨星(层级 1)
  if (rng() < 0.035) {
    gCol[o] = 1.0 * br; gCol[o + 1] = 0.50 * br; gCol[o + 2] = 0.28 * br; // 橙红亮星
  } else {
    radiusColor(t, gCol, o);
    gCol[o] *= br; gCol[o + 1] *= br; gCol[o + 2] *= br;
  }
}

for (let i = 0; i < BULGE_STARS; i++) {
  const o = (DISK_STARS + i) * 3;
  // 核球:中央三维高斯亮星群(y 向略扁)
  gPos[o] = gauss() * 6.0;
  gPos[o + 1] = gauss() * 4.0;
  gPos[o + 2] = gauss() * 6.0;
  const br = 0.75 + 0.5 * rng();
  gCol[o] = (1.0 + (rng() - 0.5) * 0.08) * br;
  gCol[o + 1] = (0.90 + (rng() - 0.5) * 0.06) * br;
  gCol[o + 2] = (0.72 + (rng() - 0.5) * 0.08) * br;
}

const galaxyGeo = new THREE.BufferGeometry();
galaxyGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
galaxyGeo.setAttribute('color', new THREE.BufferAttribute(gCol, 3));
const galaxyMat = new THREE.PointsMaterial({
  size: 0.55,            // 世界单位;sizeAttenuation 下 120 距离处约 3px
  sizeAttenuation: true,
  map: starTex,
  vertexColors: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
});
const galaxy = new THREE.Points(galaxyGeo, galaxyMat);
const galaxyGroup = new THREE.Group(); // 旋转载体:仅盘面+核球参与慢旋
galaxyGroup.add(galaxy);
scene.add(galaxyGroup);

// --- 远景背景星(4k,静态深纵层,独立批量提交) ----------------------------------
const bgPos = new Float32Array(BG_STARS * 3);
const bgCol = new Float32Array(BG_STARS * 3);
for (let i = 0; i < BG_STARS; i++) {
  const o = i * 3;
  // 均匀球面方向(高斯三元组归一化)+ 550~900 半径
  let x = gauss(), y = gauss(), z = gauss();
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  const rad = 550 + 350 * rng();
  bgPos[o] = (x / len) * rad;
  bgPos[o + 1] = (y / len) * rad;
  bgPos[o + 2] = (z / len) * rad;
  const br = 0.28 + 0.38 * rng();
  bgCol[o] = 0.74 * br; bgCol[o + 1] = 0.82 * br; bgCol[o + 2] = 1.0 * br;
}
const bgGeo = new THREE.BufferGeometry();
bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
bgGeo.setAttribute('color', new THREE.BufferAttribute(bgCol, 3));
const bgMat = new THREE.PointsMaterial({
  size: 2.0,             // 远景星距远,放大尺寸保证亚像素可见
  sizeAttenuation: true,
  map: starTex,
  vertexColors: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
});
scene.add(new THREE.Points(bgGeo, bgMat));

// --- 相机更新(距离 + 视差合成;视差为小幅横向平移 → 近景位移大、远景几乎不动) --
function updateCamera() {
  camera.position.set(
    parX * 110,
    Math.sin(ELEV) * distance + parY * 70,
    Math.cos(ELEV) * distance
  );
  camera.lookAt(0, 0, 0);
}
updateCamera();

// --- HUD(2D 覆盖层;数字全部来自真实运行状态,四舍五入显示) --------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:9999;padding:8px 12px;' +
  'font:13px/1.7 Consolas,monospace;color:#d6e4ff;background:rgba(4,8,18,0.72);' +
  'border:1px solid rgba(120,150,220,0.35);border-radius:6px;user-select:none;';
const starLine = document.createElement('div');
const fpsLine = document.createElement('div');
const distLine = document.createElement('div');
hud.appendChild(starLine);
hud.appendChild(fpsLine);
hud.appendChild(distLine);

const resetBtn = document.createElement('button');
resetBtn.type = 'button';
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText =
  'margin-top:6px;padding:3px 14px;font:12px sans-serif;background:#1b2740;' +
  'color:#fff;border:1px solid #5a76b8;border-radius:4px;cursor:pointer;';
hud.appendChild(resetBtn);
document.body.appendChild(hud);

function updateHud() {
  starLine.textContent = `Stars: ${GALAXY_STARS + BG_STARS}`;
  fpsLine.textContent = `FPS: ${Math.round(fps)}`;
  distLine.textContent = `Dist: ${Math.round(distance)}`;
}
updateHud();

// --- reset(禁止整页刷新;1s 内完成;可重复且行为一致) ---------------------------
function doReset() {
  epoch += 1;
  rotationPhase = 0;
  galaxyGroup.rotation.y = 0;
  targetDistance = INIT_DISTANCE;
  parTX = 0;
  parTY = 0;
  resetting = true;
}
resetBtn.addEventListener('click', doReset);

// --- window.__bench 状态契约 ------------------------------------------------------
window.__bench = {
  getState: () => ({
    engine: 'three',
    starCount: GALAXY_STARS + BG_STARS, // 与真实提交渲染的星点数一致
    rotationPhase,
    cameraDistance: distance,
    parallaxOffset: { x: parX, y: parY },
    fps,
    hudVisible,
    epoch,
  }),
  reset: doReset,
};

// --- 输入:指针视差 + 滚轮穿行 ------------------------------------------------------
function onPointerMove(e) {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const nx = clamp((e.clientX / w - 0.5) * 2, -1, 1);
  const ny = clamp((e.clientY / h - 0.5) * 2, -1, 1);
  parTX = nx * PARALLAX_MAX;
  parTY = ny * PARALLAX_MAX;
}
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('mousemove', onPointerMove); // 兜底:无 pointer 事件环境

window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    resetting = false; // 新的滚轮输入恢复常规平滑
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // 行模式换算为像素
    targetDistance = clamp(targetDistance + dy * 0.12, MIN_DISTANCE, MAX_DISTANCE);
  },
  { passive: false }
);

// --- 视口自适应 ----------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// --- 主循环:时钟增量步进;距离/视差逐帧指数插值(帧率无关、无过冲) ------------------
let last = performance.now();
let lastHud = 0;

function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > 0.5) dt = 0.5; // 后台节流恢复后不产生巨步

  // 星系慢旋(单调递增)
  rotationPhase += dt * ANGULAR_SPEED;
  galaxyGroup.rotation.y = rotationPhase;

  // 相机距离平滑(reset 期用更小时间常数:1s 内归位且仍逐帧插值)
  const tauD = resetting ? 0.12 : 0.5;
  distance += (targetDistance - distance) * (1 - Math.exp(-dt / tauD));
  if (resetting && Math.abs(targetDistance - distance) < 0.02) distance = targetDistance;

  // 视差平滑
  const tauP = resetting ? 0.1 : 0.3;
  parX += (parTX - parX) * (1 - Math.exp(-dt / tauP));
  parY += (parTY - parY) * (1 - Math.exp(-dt / tauP));
  if (resetting && Math.abs(parTX - parX) < 1e-5) parX = parTX;
  if (resetting && Math.abs(parTY - parY) < 1e-5) parY = parTY;
  if (resetting && distance === targetDistance && parX === parTX && parY === parTY) {
    resetting = false;
  }

  updateCamera();
  renderer.render(scene, camera);

  // fps:2s 滚动窗平均(真实帧时间)
  frameTimes.push(now);
  while (frameTimes.length > 0 && frameTimes[0] < now - 2000) frameTimes.shift();
  if (frameTimes.length > 1) {
    const span = now - frameTimes[0];
    fps = ((frameTimes.length - 1) * 1000) / span;
  }

  // HUD 节流刷新(每 200ms,数字随真实状态变化)
  if (now - lastHud > 200) {
    updateHud();
    lastHud = now;
  }

  if (window.__appReady !== true) {
    window.__appReady = true; // 首帧渲染完成
  }
}
requestAnimationFrame(tick);
