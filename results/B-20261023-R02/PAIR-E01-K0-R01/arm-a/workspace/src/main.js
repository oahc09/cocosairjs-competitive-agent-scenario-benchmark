// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise) — Three.js r186 实现
// ----------------------------------------------------------------------------
// 页面契约(harness 断言,见 RUN-CONTRACT §5 / spec.json stateContract):
//   window.__appReady : 首帧渲染完成后置 true(index.html 内联脚本已置 false)
//   window.__bench    : { getState(), reset() }
//
// 场景构成(全部程序化生成,无外部资产):
//   1) 旋涡星系 55,000 星 = 核球 8,000(暖黄亮星,中央隆起)
//      + 双对数螺旋臂 2×16,000(径向色梯度 + 少量橙红巨星)
//      + 盘面散布 15,000(暗弱盘星,衬托旋臂对比)
//   2) 远景背景星 3,000(球壳分布,极慢旋转,增强纵深/视差参照)
//      —— starCount 状态 = 真实提交渲染总数 58,000(两个 Points 对象)
//   3) 自定义点精灵着色器:逐星尺寸/颜色属性 + 高斯辉光 + 加色混合,
//      单对象单 draw call 批量提交(性能红线:不得逐星绘制)
//   4) 相机:斜俯视 40°(盘面法线与视线夹角 50°),初始距离 120,范围 [40,400];
//      滚轮 exp 响应改变目标距离、帧间指数平滑(禁止瞬跳);
//      指针视差 = 指针偏离画面中心的有符号偏移(±1 归一),指数平滑无过冲
//   5) HUD:星点总数 / 2s 滚动平均帧率 / 相机距离(真实运行数据)+ Reset 按钮
// ============================================================================

import * as THREE from 'three';

// ---------- 冻结常量(与 spec.json 对齐) ------------------------------------
const GALAXY_COUNT = 55000;          // 星系本体星点数
const BG_COUNT = 3000;               // 远景背景星数
const TOTAL_COUNT = GALAXY_COUNT + BG_COUNT; // 58000,真实提交渲染总数
const BULGE_COUNT = 8000;
const ARM_COUNT = 16000;             // 每条臂
const DISK_COUNT = GALAXY_COUNT - BULGE_COUNT - 2 * ARM_COUNT; // 15000

const R_CORE = 6;                    // 旋臂起点半径
const R_OUT = 72;                    // 星系外缘半径(初始视角占宽 ~65%)
const ARM_PITCH = 0.28;              // 对数螺旋 r = R_CORE * e^(pitch*θ)

const OMEGA = 0.06;                  // 盘面角速度 rad/s(spec: 0.02–0.1)
const BG_OMEGA = 0.004;              // 背景层极慢旋转

const FOV_DEG = 55;
const ELEV_DEG = 40;                 // 相机仰角(俯视盘面)→ 法线/视线夹角 50°
const DIST_INIT = 120;               // spec: 初始 120,范围 [40,400]
const DIST_MIN = 40, DIST_MAX = 400;
const WHEEL_K = 0.0012;              // 滚轮 exp 响应系数
const DIST_SMOOTH = 2.5;             // 距离平滑速率 1/s
const PAR_SMOOTH = 2.5;              // 视差平滑速率 1/s(无过冲)
const PAR_AMP_X = 6, PAR_AMP_Y = 4;  // 视差相机平移幅值(世界单位,~5% 画幅 < 10%)

// ---------- 确定性随机(种子固定 → 构建产物可复现) ---------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261023);
function gauss() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- 径向色梯度:核心暖黄白 → 旋臂中段蓝白 → 外缘冷蓝 ------------------
const _c = [0, 0, 0];
function rampColor(t) {
  if (t < 0.45) {
    const k = t / 0.45;
    _c[0] = 1.00 + (0.78 - 1.00) * k;
    _c[1] = 0.92 + (0.85 - 0.92) * k;
    _c[2] = 0.72 + (1.00 - 0.72) * k;
  } else {
    const k = (t - 0.45) / 0.55;
    _c[0] = 0.78 + (0.50 - 0.78) * k;
    _c[1] = 0.85 + (0.66 - 0.85) * k;
    _c[2] = 1.00;
  }
  return _c;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---------- 星系顶点数据生成 ---------------------------------------------------
const gPos = new Float32Array(GALAXY_COUNT * 3);
const gCol = new Float32Array(GALAXY_COUNT * 3);
const gSiz = new Float32Array(GALAXY_COUNT);
let wi = 0; // 写指针(星点序号)
function putStar(x, y, z, r, g, b, s) {
  const i3 = wi * 3;
  gPos[i3] = x; gPos[i3 + 1] = y; gPos[i3 + 2] = z;
  gCol[i3] = r; gCol[i3 + 1] = g; gCol[i3 + 2] = b;
  gSiz[wi] = s;
  wi += 1;
}

// 1) 核球:中央密集亮星群(高斯椭球,暖黄白,最亮层级)
for (let n = 0; n < BULGE_COUNT; n++) {
  const x = gauss() * 4.2, y = gauss() * 2.6, z = gauss() * 4.2;
  const inten = 0.85 + rnd() * 0.65;
  const warm = rnd();
  putStar(
    x, y, z,
    1.00 * inten,
    (0.90 + warm * 0.07) * inten,
    (0.66 + warm * 0.20) * inten,
    0.65 + rnd() * rnd() * 1.0
  );
}

// 2) 双对数螺旋臂:θ = θ_arm + ln(r/R_CORE)/pitch + 角向高斯散布
for (let arm = 0; arm < 2; arm++) {
  const base = arm * Math.PI;
  for (let n = 0; n < ARM_COUNT; n++) {
    let r = R_CORE + (R_OUT - R_CORE) * Math.pow(rnd(), 0.8); // 内密外疏
    r += gauss() * 1.2;
    if (r < 1.5) r = 1.5;
    const th = base + Math.log(r / R_CORE) / ARM_PITCH
      + gauss() * 0.16 * (0.5 + r / R_OUT); // 臂宽随半径略展宽
    // 盘厚:内厚外薄 + 轻微外扬(非平面纸片)
    const y = gauss() * (1.5 + 2.6 * Math.exp(-r / 16) + 0.012 * r);
    const t = clamp01((r - R_CORE) / (R_OUT - R_CORE));
    rampColor(t);
    let inten, s;
    if (rnd() < 0.025) {
      // 少量橙红亮星(巨星层级)
      inten = 1.25 + rnd() * 0.5;
      _c[0] = 1.0; _c[1] = 0.5 + rnd() * 0.12; _c[2] = 0.25 + rnd() * 0.1;
      s = 1.4 + rnd() * 1.0;
    } else {
      inten = 0.5 + rnd() * 0.55; // 盘面普通星层级
      s = 0.32 + Math.pow(rnd(), 2) * 0.6;
    }
    putStar(r * Math.cos(th), y, r * Math.sin(th),
      _c[0] * inten, _c[1] * inten, _c[2] * inten, s);
  }
}

// 3) 盘面散布星:全周随机、更暗更小(暗弱背景层级,衬托旋臂)
for (let n = 0; n < DISK_COUNT; n++) {
  const r = 2 + Math.pow(rnd(), 0.65) * (R_OUT + 4);
  const th = rnd() * Math.PI * 2;
  const y = gauss() * (1.3 + 2.2 * Math.exp(-r / 16) + 0.02 * r);
  const t = clamp01((r - R_CORE) / (R_OUT - R_CORE));
  rampColor(t);
  const inten = 0.22 + rnd() * 0.4;
  putStar(r * Math.cos(th), y, r * Math.sin(th),
    _c[0] * inten, _c[1] * inten, _c[2] * inten, 0.2 + rnd() * 0.35);
}
if (wi !== GALAXY_COUNT) throw new Error('galaxy count mismatch');

// 4) 远景背景星:球壳分布、静态感极慢旋转,作为视差纵深参照
const bPos = new Float32Array(BG_COUNT * 3);
const bCol = new Float32Array(BG_COUNT * 3);
const bSiz = new Float32Array(BG_COUNT);
for (let n = 0; n < BG_COUNT; n++) {
  const u = rnd() * 2 - 1, phi = rnd() * Math.PI * 2;
  const sq = Math.sqrt(1 - u * u);
  const R = 460 + rnd() * 420;
  bPos[n * 3] = sq * Math.cos(phi) * R;
  bPos[n * 3 + 1] = u * R;
  bPos[n * 3 + 2] = sq * Math.sin(phi) * R;
  const inten = 0.25 + rnd() * 0.35;
  bCol[n * 3] = (0.7 + rnd() * 0.3) * inten;
  bCol[n * 3 + 1] = (0.75 + rnd() * 0.25) * inten;
  bCol[n * 3 + 2] = 1.0 * inten;
  bSiz[n] = 1.0 + rnd() * 1.8;
}

// ---------- 渲染器 / 场景 / 相机 ------------------------------------------------
const canvas = document.getElementById('app-canvas');
// preserveDrawingBuffer: 便于验证侧直接 readPixels 取证(开销可忽略)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04040c); // 深空底色 (4,4,12),暗于 (16,16,24)

const FOV_RAD = THREE.MathUtils.degToRad(FOV_DEG);
const ELEV_RAD = THREE.MathUtils.degToRad(ELEV_DEG);
const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, 0.5, 3000);

// ---------- 点精灵着色器(批量提交:一个对象一次 draw call) --------------------
const starUniforms = { uScale: { value: 1 } };
function makePoints(pos, col, siz) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: [
      'attribute float aSize;',
      'attribute vec3 aColor;',
      'uniform float uScale;',
      'varying vec3 vColor;',
      'void main() {',
      '  vColor = aColor;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  float ps = aSize * uScale / max(0.1, -mv.z);', // 距离衰减的真实点尺寸
      '  gl_PointSize = clamp(ps, 1.0, 64.0);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vColor;',
      'void main() {',
      '  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;', // 0 中心 → 1 边缘
      '  if (d > 1.0) discard;',
      '  float g = exp(-d * d * 4.5) * (1.0 - d * d * 0.25);', // 高斯辉光核
      '  gl_FragColor = vec4(vColor * g, g);',
      '}',
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

const galaxy = makePoints(gPos, gCol, gSiz);
const bgStars = makePoints(bPos, bCol, bSiz);
scene.add(galaxy);
scene.add(bgStars);

function updateScale() {
  // 透视点尺寸换算:px = worldSize * (bufferHeight / (2·tan(fov/2))) / dist
  starUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(FOV_RAD / 2));
}
updateScale();

// ---------- 观察状态(全部进 getState / 受 reset 管理) --------------------------
let epoch = 0;
let phase = 0;            // 盘面累计旋转相位 rad(reset 归零,时间步进单调递增)
let bgPhase = 0;
let dist = DIST_INIT;     // 当前相机距离(平滑值)
let targetDist = DIST_INIT;
let parX = 0, parY = 0;   // 当前视差(平滑值)
let parTX = 0, parTY = 0; // 视差目标(指针偏离中心的有符号偏移,±1)

// 相机装配:基座位于仰角 ELEV 的斜上方,再按视差沿视口右/上轴小幅平移;
// 平移(而非旋转)产生近远景相对位移 = 真实视差。
const _base = new THREE.Vector3();
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const UP_WORLD = new THREE.Vector3(0, 1, 0);
function applyCamera() {
  const se = Math.sin(ELEV_RAD), ce = Math.cos(ELEV_RAD);
  _base.set(0, dist * se, dist * ce);
  _look.set(0, -se, -ce).normalize();
  _right.crossVectors(_look, UP_WORLD).normalize();
  _camUp.crossVectors(_right, _look).normalize();
  camera.position.copy(_base)
    .addScaledVector(_right, parX * PAR_AMP_X)
    .addScaledVector(_camUp, -parY * PAR_AMP_Y);
  camera.lookAt(0, 0, 0);
}

// ---------- 输入:指针视差 + 滚轮穿行 -------------------------------------------
function onPointerMove(e) {
  if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
  const px = e.clientX / window.innerWidth;
  const py = e.clientY / window.innerHeight;
  parTX = (px - 0.5) * 2; // 画面中心为原点的有符号偏移,范围 [-1,1]
  parTY = (py - 0.5) * 2;
}
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('mousemove', onPointerMove); // 兜底:仅派发 mousemove 的环境

window.addEventListener('wheel', (e) => {
  e.preventDefault(); // 页面不滚动(画布即全部)
  targetDist = Math.min(DIST_MAX, Math.max(DIST_MIN,
    targetDist * Math.exp(e.deltaY * WHEEL_K))); // deltaY<0(向上)→ 靠近
}, { passive: false });

// ---------- HUD(真实运行数据,数值与 __bench 一致) -----------------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.style.cssText = [
  'position:fixed;top:12px;left:12px;z-index:10;',
  'padding:10px 14px;border-radius:6px;',
  'background:rgba(6,8,16,0.78);border:1px solid rgba(90,120,200,0.45);',
  "color:#d7e4ff;font:12px/1.7 Consolas,monospace;white-space:nowrap;",
  'pointer-events:none;user-select:none;',
].join('');
hud.innerHTML = [
  '<div style="color:#8fa8d8;">E01 · 深空星系巡航</div>',
  '<div>星点 <span id="hud-stars">–</span></div>',
  '<div>帧率 <span id="hud-fps">–</span> fps</div>',
  '<div>距离 <span id="hud-dist">–</span></div>',
].join('');
const resetBtn = document.createElement('button');
resetBtn.type = 'button';
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText = [
  'pointer-events:auto;margin-top:6px;padding:3px 14px;',
  'font:12px Consolas,monospace;color:#e8f0ff;background:#1a2440;',
  'border:1px solid #4a5f9a;border-radius:4px;cursor:pointer;',
].join('');
resetBtn.addEventListener('click', doReset);
hud.appendChild(resetBtn);
document.body.appendChild(hud);
const elStars = hud.querySelector('#hud-stars');
const elFps = hud.querySelector('#hud-fps');
const elDist = hud.querySelector('#hud-dist');

function hudVisible() {
  if (!hud.isConnected) return false;
  const r = hud.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// ---------- fps:2s 滚动平均(spec 口径) ----------------------------------------
let fps = 0;
const frameTs = [];
function noteFrame(ts) {
  frameTs.push(ts);
  const cut = ts - 2000;
  while (frameTs.length > 0 && frameTs[0] < cut) frameTs.shift();
  if (frameTs.length >= 2) {
    const span = (frameTs[frameTs.length - 1] - frameTs[0]) / 1000;
    if (span > 0) fps = (frameTs.length - 1) / span;
  }
}

// ---------- __bench 契约 --------------------------------------------------------
function getState() {
  return {
    starCount: TOTAL_COUNT,
    rotationPhase: phase,
    cameraDistance: dist,
    parallaxOffset: { x: parX, y: parY },
    fps: fps,
    hudVisible: hudVisible(),
    epoch: epoch,
  };
}
function doReset() {
  epoch += 1;
  phase = 0; galaxy.rotation.y = 0;      // 旋转相位归零(角速度上限内可过 P7)
  bgPhase = 0; bgStars.rotation.y = 0;
  targetDist = DIST_INIT; dist = DIST_INIT; // 相机距离恢复 120(1s 内,瞬时)
  parTX = 0; parTY = 0; parX = 0; parY = 0; // 视差归零;后续指针再移动才会更新
}
window.__bench = { getState, reset: doReset };

// HUD 数字刷新(200ms 节流;帧率取整显示,状态保留原值,允许四舍五入)
function refreshHud() {
  elStars.textContent = String(TOTAL_COUNT);
  elFps.textContent = String(Math.round(fps));
  elDist.textContent = dist.toFixed(1);
}
refreshHud(); // 立即填充一次,避免早期截图出现占位符
setInterval(refreshHud, 200);

// ---------- 主循环:时钟增量步进(后台节流恢复后不跳变) -------------------------
let lastT = performance.now();
function tick(now) {
  const dt = Math.min(Math.max((now - lastT) / 1000, 0), 0.05);
  lastT = now;

  phase += OMEGA * dt;                   // 单调递增(仅 reset 归零)
  galaxy.rotation.y = phase;            // 绕盘面法线(+Y)整体慢旋
  bgPhase += BG_OMEGA * dt;
  bgStars.rotation.y = bgPhase;

  const kd = 1 - Math.exp(-DIST_SMOOTH * dt); // 距离帧间指数平滑(不瞬跳)
  dist += (targetDist - dist) * kd;
  const kp = 1 - Math.exp(-PAR_SMOOTH * dt);  // 视差平滑(一阶滞后,无过冲)
  parX += (parTX - parX) * kp;
  parY += (parTY - parY) * kp;

  applyCamera();
  noteFrame(now);
  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
applyCamera();
requestAnimationFrame(tick);

// ---------- 视口自适应 ------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  updateScale();
});
