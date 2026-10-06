// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)— Three.js r186 实现
// ----------------------------------------------------------------------------
// 设计要点(为什么这么写):
// - 66,000 颗星合并进两个 THREE.Points(星系=核球+旋臂+盘面散星,单 BufferGeometry
//   一次 draw call;远景背景星单独静态层一次 draw call),批量提交;逐星尺寸/颜色走
//   自定义 attribute(aSize/aColor)+ ShaderMaterial 软辉光点精灵,AdditiveBlending
//   叠出核球过曝亮心。绝不逐星 mesh(5 万级 draw call 必卡)。
// - 旋臂为真对数螺旋:r = r0·(R/r0)^t、θ = SWEEP·t(消去 t 得 r = r0·e^(bθ));
//   2 条臂相位差 π,臂宽与盘厚随半径增大;盘面散星按幂律向中心聚拢填补臂间。
//   颜色按半径三段梯度(核暖黄白 → 中段蓝白 → 外缘冷蓝),另撒 ~2% 橙红亮星;
//   亮暗分核球亮星 / 盘面普通星 / 暗弱背景星 ≥3 档。
// - 运动:星系统 Y 轴(盘面法线)刚体旋转 rotationPhase += ω·dt(ω=0.05 rad/s,
//   时钟增量,dt 截断保证单调);相机在 45° 仰角轨道 orbit(盘面法线与视线夹角 45°,
//   落在 30°–60° 锚点);滚轮改目标距离、指数平滑逐帧插值(τ=0.6s,无瞬跳);
//   视差 = 指针偏移映射为小幅 yaw/pitch 偏移(≤6% 画面 < 10% 红线),远景层反向
//   微转形成"星系与远景相对位移";全部指数平滑,天然无过冲振荡。
// - 契约:__appReady 首帧后置 true;__bench = { getState, reset };HUD 为 DOM 覆盖层,
//   数字全部来自运行态(星点数 / 2s 滚动帧率 / 相机距离);reset 原地快平滑恢复
//   (τ=0.12s,<1s),epoch+1,绝不 location.reload。
// ============================================================================

import * as THREE from 'three';

// ---------- 渲染基座 ----------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020207); // 深空近黑(RGB 2,2,7,暗于 16,16,24)

const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.5, 8000
);

// ---------- 场景参数(与 __bench 状态同单位) ----------
const GALAXY_R = 70;        // 盘半径;距离 120 时水平张角 ~61° ≈ 画面宽 66%(锚点 60–75%)
const OMEGA = 0.05;         // 角速度 rad/s(brief 允许 0.02–0.1;reset 后 0.8s 相位 0.04 < 0.1)
const DIST0 = 120, DIST_MIN = 40, DIST_MAX = 400;
const ELEV0 = Math.PI / 4;  // 初始仰角 45°:盘面法线与视线夹角
const PARALLAX_MAX = 0.05;  // 视差状态幅度上限(画面尺寸的 5%,红线 10%)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- 高斯随机(Box-Muller) ----------
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- 星色:按半径三段梯度 + 亮度抖动 ----------
const C_CORE = [1.00, 0.90, 0.65];  // 核心暖黄白
const C_MID = [0.80, 0.88, 1.00];   // 中段蓝白
const C_OUT = [0.52, 0.70, 1.00];   // 外缘冷蓝
const C_GIANT = [1.00, 0.50, 0.28]; // 橙红亮星(少量散布)
function putColor(out, o, rn, mult) {
  let r, g, b;
  if (rn < 0.2) { r = C_CORE[0]; g = C_CORE[1]; b = C_CORE[2]; }
  else if (rn < 0.55) {
    const t = (rn - 0.2) / 0.35;
    r = C_CORE[0] + (C_MID[0] - C_CORE[0]) * t;
    g = C_CORE[1] + (C_MID[1] - C_CORE[1]) * t;
    b = C_CORE[2] + (C_MID[2] - C_CORE[2]) * t;
  } else {
    const t = Math.min(1, (rn - 0.55) / 0.45);
    r = C_MID[0] + (C_OUT[0] - C_MID[0]) * t;
    g = C_MID[1] + (C_OUT[1] - C_MID[1]) * t;
    b = C_MID[2] + (C_OUT[2] - C_MID[2]) * t;
  }
  const j = mult * (0.85 + Math.random() * 0.25);
  out[o] = r * j; out[o + 1] = g * j; out[o + 2] = b * j;
}

// ---------- 星点集合构建(数量硬计数,starCount 与真实提交严格一致) ----------
const NUCLEUS_N = 2500;   // 核心亮星
const BULGE_N = 5500;     // 核球
const ARM_N = 44000;      // 2 条对数旋臂(臂占比高,保证旋臂可辨)
const SCATTER_N = 10000;  // 盘面散星(调暗作背景衬底,不抢旋臂)
const BG_N = 4000;        // 远景背景星
const GALAXY_TOTAL = NUCLEUS_N + BULGE_N + ARM_N + SCATTER_N; // 62000
const BG_TOTAL = BG_N;
const STAR_TOTAL = GALAXY_TOTAL + BG_TOTAL; // 66000

function buildBuffers(n) {
  return {
    pos: new Float32Array(n * 3),
    col: new Float32Array(n * 3),
    siz: new Float32Array(n),
    i: 0,
  };
}
function pushStar(buf, x, y, z, rn, size, mult, forceGiant) {
  const i = buf.i, o = i * 3;
  buf.pos[o] = x; buf.pos[o + 1] = y; buf.pos[o + 2] = z;
  if (forceGiant) {
    const j = 0.9 + Math.random() * 0.2;
    buf.col[o] = C_GIANT[0] * j; buf.col[o + 1] = C_GIANT[1] * j; buf.col[o + 2] = C_GIANT[2] * j;
  } else {
    putColor(buf.col, o, rn, mult);
  }
  buf.siz[i] = size;
  buf.i = i + 1;
}

// --- 星系盘(核球 + 旋臂 + 散星) ---
const gb = buildBuffers(GALAXY_TOTAL);
// 核心亮星:小 σ 高斯,最亮一档
for (let i = 0; i < NUCLEUS_N; i++) {
  const x = gauss() * 0.035 * GALAXY_R;
  const z = gauss() * 0.035 * GALAXY_R;
  const y = gauss() * 0.02 * GALAXY_R;
  const rn = Math.hypot(x, z) / GALAXY_R;
  pushStar(gb, x, y, z, rn, 1.4 + Math.random() * 1.4, 1.15, false);
}
// 核球:扁高斯,暖色第二亮档
for (let i = 0; i < BULGE_N; i++) {
  const x = gauss() * 0.11 * GALAXY_R;
  const z = gauss() * 0.11 * GALAXY_R;
  const y = gauss() * 0.055 * GALAXY_R;
  const rn = Math.hypot(x, z) / GALAXY_R;
  pushStar(gb, x, y, z, rn * 0.6, 0.7 + Math.random() * 0.9, 1.0, false);
}
// 旋臂:对数螺旋,臂宽随半径展宽,盘厚外缘微翘;2% 橙红亮星
const ARMS = 2, ARM_SWEEP = Math.PI * 2.35, ARM_R0 = 0.14 * GALAXY_R;
for (let arm = 0; arm < ARMS; arm++) {
  const phase = arm * (Math.PI * 2 / ARMS);
  for (let i = 0; i < ARM_N / ARMS; i++) {
    const t = Math.pow(Math.random(), 0.9);
    const rBase = ARM_R0 * Math.pow(GALAXY_R / ARM_R0, t);
    const theta = t * ARM_SWEEP + phase + gauss() * (0.06 + 0.11 * t);
    const r = Math.max(1, rBase * (1 + gauss() * 0.04));
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = gauss() * 0.016 * GALAXY_R * (1 + 1.6 * t);
    const giant = Math.random() < 0.02;
    const size = giant ? 1.8 + Math.random() * 1.2 : 0.5 + Math.random() * 0.6;
    pushStar(gb, x, y, z, r / GALAXY_R, size, 1.0, giant);
  }
}
// 盘面散星:幂律向中心聚拢,填补旋臂之间
for (let i = 0; i < SCATTER_N; i++) {
  const r = 0.5 + GALAXY_R * Math.pow(Math.random(), 0.62);
  const ang = Math.random() * Math.PI * 2;
  const x = Math.cos(ang) * r;
  const z = Math.sin(ang) * r;
  const y = gauss() * 0.02 * GALAXY_R * (1 + r / GALAXY_R);
  const giant = Math.random() < 0.015;
  const size = giant ? 1.8 + Math.random() * 1.2 : 0.4 + Math.random() * 0.5;
  pushStar(gb, x, y, z, r / GALAXY_R, size, 0.62, giant);
}

// --- 远景背景星:大球壳静态层,暗弱一档,增强纵深 ---
const bb = buildBuffers(BG_TOTAL);
for (let i = 0; i < BG_N; i++) {
  const u = Math.random() * 2 - 1;
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const r = 1500 + Math.random() * 1100;
  const x = Math.cos(phi) * s * r;
  const y = u * r;
  const z = Math.sin(phi) * s * r;
  const mult = 0.25 + Math.random() * 0.35;
  const o = i * 3;
  bb.pos[o] = x; bb.pos[o + 1] = y; bb.pos[o + 2] = z;
  const tint = Math.random() < 0.15 ? [1.0, 0.85, 0.7] : [0.8, 0.88, 1.0];
  bb.col[o] = tint[0] * mult; bb.col[o + 1] = tint[1] * mult; bb.col[o + 2] = tint[2] * mult;
  bb.siz[i] = 0.6 + Math.random() * 0.7;
}
bb.i = BG_N;

// ---------- 软辉光点精灵材质(逐点尺寸/颜色,加色叠亮) ----------
const starMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false, // 纯粒子场景,关深度免排序问题;加色混合与顺序无关
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute float aSize;
    attribute vec3 aColor;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float ps = aSize * (200.0 / max(1.0, -mv.z));
      gl_PointSize = clamp(ps, 1.0, 64.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 p = gl_PointCoord - vec2(0.5);
      float d = length(p) * 2.0;
      float a = smoothstep(1.0, 0.0, d);
      a *= a;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor * a, a);
    }
  `,
});

function makePoints(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buf.pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(buf.col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(buf.siz, 1));
  const pts = new THREE.Points(g, starMat);
  pts.frustumCulled = false; // 星系大于视锥体时避免整体被剔除
  return pts;
}

const galaxyGroup = new THREE.Group(); // 随 rotationPhase 刚体旋转
galaxyGroup.add(makePoints(gb));
const bgGroup = new THREE.Group();     // 远景层:仅视差微动
bgGroup.add(makePoints(bb));
scene.add(galaxyGroup, bgGroup);

// 运行期真实计数(= 提交渲染的星点数,双份各检一次,防静默截断)
const starCount =
  galaxyGroup.children[0].geometry.attributes.position.count +
  bgGroup.children[0].geometry.attributes.position.count;
if (starCount !== STAR_TOTAL) throw new Error(`star buffer mismatch: ${starCount} != ${STAR_TOTAL}`);

// ---------- 运行态 ----------
const st = {
  rotationPhase: 0,   // 星系旋转相位(rad),单调递增,reset 归零
  epoch: 0,           // reset 计数
  camDist: DIST0,     // 相机距离(平滑值)
  camTarget: DIST0,   // 相机距离目标
  camTau: 0.6,        // 距离平滑时间常数(滚轮慢 / reset 快)
  parX: 0, parY: 0,   // 视差平滑值(状态口径,画面尺寸比例)
  parTX: 0, parTY: 0, // 视差目标
  fps: 0,
};
let hudVisible = true;

// ---------- HUD(2D 覆盖层,数字全部来自运行态) ----------
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:10;pointer-events:none;' +
  'font:12px/1.7 Consolas,Menlo,monospace;color:#cfd8ff;' +
  'background:rgba(2,4,12,0.55);border:1px solid rgba(120,140,220,0.35);' +
  'border-radius:6px;padding:8px 12px;user-select:none;white-space:pre;';
const hudInfo = document.createElement('div');
hudInfo.textContent = 'STARS - | FPS - | DIST - | EPOCH -';
hud.appendChild(hudInfo);
const resetBtn = document.createElement('button');
resetBtn.type = 'button';
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText =
  'pointer-events:auto;margin-top:6px;padding:3px 14px;font:12px sans-serif;' +
  'background:#1b2340;color:#e6ecff;border:1px solid #5a6ec2;border-radius:4px;cursor:pointer;';
resetBtn.addEventListener('click', () => doReset());
hud.appendChild(resetBtn);
document.body.appendChild(hud);

// ---------- 页面契约 ----------
window.__appReady = false;
window.__bench = {
  getState: () => ({
    engine: 'three',
    starCount,
    rotationPhase: st.rotationPhase,
    cameraDistance: st.camDist,
    parallaxOffset: { x: st.parX, y: st.parY },
    fps: st.fps,
    hudVisible,
    epoch: st.epoch,
  }),
  reset: doReset,
};

function doReset() {
  st.epoch += 1;
  st.rotationPhase = 0;
  galaxyGroup.rotation.y = 0;
  st.parTX = 0; st.parTY = 0;
  st.parX = 0; st.parY = 0;      // 视差立即归零(恢复 <1s)
  st.camTarget = DIST0;
  st.camTau = 0.12;              // 距离快平滑恢复(<1s 内收敛到 120±0.1)
}

// ---------- 输入 ----------
window.addEventListener('pointermove', (e) => {
  const nx = clamp((e.clientX / window.innerWidth - 0.5) * 2, -1, 1);
  const ny = clamp((e.clientY / window.innerHeight - 0.5) * 2, -1, 1);
  st.parTX = nx * PARALLAX_MAX;
  st.parTY = ny * PARALLAX_MAX;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  st.camTarget = clamp(st.camTarget + e.deltaY * 0.08, DIST_MIN, DIST_MAX); // -600 → -48
  st.camTau = 0.6; // 滚轮驱动的距离变化走慢平滑:逐帧插值、不瞬跳
}, { passive: false });

// ---------- 帧率:最近 2s 滚动平均 ----------
const frameTimes = [];
function updateFps(now) {
  frameTimes.push(now);
  while (frameTimes.length > 2 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 2) {
    const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
    if (span > 0.12) st.fps = (frameTimes.length - 1) / span;
  }
}

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let hudAcc = 1; // 首帧即刷新 HUD
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 后台节流恢复后防相位跳变(仍单调)
  const now = performance.now();

  // 状态推进:旋转相位单调递增
  st.rotationPhase += OMEGA * dt;

  // 平滑:距离与视差均为指数插值(无过冲)
  st.camDist += (st.camTarget - st.camDist) * (1 - Math.exp(-dt / st.camTau));
  if (Math.abs(st.camTarget - st.camDist) < 0.02) { st.camDist = st.camTarget; st.camTau = 0.6; }
  const kPar = 1 - Math.exp(-dt / 0.25);
  st.parX += (st.parTX - st.parX) * kPar;
  st.parY += (st.parTY - st.parY) * kPar;

  // 相机:45° 仰角轨道 + 视差小幅 yaw/pitch 偏移
  const yaw = st.parX * 2.0;                 // 最大 0.1 rad ≈ 画面 6%
  const elev = clamp(ELEV0 - st.parY * 1.2, 0.3, 1.35);
  const ce = Math.cos(elev), se = Math.sin(elev);
  camera.position.set(st.camDist * ce * Math.sin(yaw), st.camDist * se, st.camDist * ce * Math.cos(yaw));
  camera.lookAt(0, 0, 0);

  // 星系刚体旋转;远景反向微转 → 星系与远景相对位移
  galaxyGroup.rotation.y = st.rotationPhase;
  bgGroup.rotation.y = st.parX * 0.4;

  updateFps(now);

  // HUD 4Hz 刷新(数字与 getState 同源,允许四舍五入)
  hudAcc += dt;
  if (hudAcc >= 0.25) {
    hudAcc = 0;
    hudInfo.textContent =
      `STARS ${starCount} | FPS ${st.fps.toFixed(1)} | DIST ${st.camDist.toFixed(1)} | EPOCH ${st.epoch}`;
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 视口自适应 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
