// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)— three.js r186
// ----------------------------------------------------------------------------
// 程序化生成旋涡星系:核球 + 2 条对数螺旋主臂 + 弥散盘 + 红巨星 + 远景背景星层。
// 交互:鼠标视差(平滑)、滚轮穿行(相机距离平滑插值)、Reset 恢复初始观察状态。
// 页面契约:
//   window.__appReady — 首帧渲染完成后置 true(index.html 内联脚本初始置 false)
//   window.__bench    — { getState(): object, reset(): void }
//     getState(): starCount / rotationPhase / cameraDistance / parallaxOffset /
//                 fps / hudVisible / epoch
//     reset():    恢复初始相机距离(120)、视差({0,0})、旋转相位(0);epoch +1;
//                 0.6s 缓动完成,非整页刷新。
// ============================================================================

import * as THREE from 'three';

// --- 小工具:确定性随机 / 高斯 / 插值 ------------------------------------------

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
  if (gaussSpare !== null) {
    const v = gaussSpare;
    gaussSpare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = rnd() * 2 - 1;
    v = rnd() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const m = Math.sqrt((-2 * Math.log(s)) / s);
  gaussSpare = v * m;
  return u * m;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// --- 场景常量 ------------------------------------------------------------------

const R_GAL = 78;            // 星系盘半径(世界单位)
const ARM_R0 = 7;            // 对数螺旋参考内径
const ARM_B = 0.231;         // 螺距参数(tan 13°)
const FOV_DEG = 60;
const ELEV = (38 * Math.PI) / 180;   // 相机仰角(盘面法线与视线夹角 ≈ 52°,落在 30°–60°)

const COUNT_BULGE = 9000;    // 核球亮星
const COUNT_ARM_PER = 13500; // 每条主臂星点
const ARM_COUNT = 2;
const COUNT_DISK = 15000;    // 弥散盘面星(含暗弱外缘背景星层级)
const COUNT_GIANTS = 1300;   // 橙红亮星
const COUNT_GLOW = 1;        // 核球中央柔光(单独 1 顶点,计入提交渲染数)
const STAR_COUNT =
  COUNT_BULGE + COUNT_ARM_PER * ARM_COUNT + COUNT_DISK + COUNT_GIANTS +
  COUNT_GLOW;                // = 52301,等于全部 Points 几何的顶点总数
// 说明:brief §3.3 的"远景背景星层"为可选项。试验中发现大半径包围球在
// SwiftShader(软件 WebGL)下于视口顶边产生点精灵光栅化伪影(y=0 亮线),
// 故不使用远景球层;纵深由盘面暗弱星层级与中央柔光体现。

const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const WHEEL_SCALE = 0.12;    // deltaY -> 距离目标增量

const ROT_OMEGA = 0.06;      // rad/s,落在 [0.02, 0.1]
const TAU_DIST = 0.35;       // 距离平滑时间常数(s)
const TAU_PARA = 0.2;        // 视差平滑时间常数(s)
const PARALLAX_AX = 10;      // 视差平移幅度(世界单位,|p|=1 时)
const PARALLAX_AY = 7;

// --- 渲染器 / 场景 / 相机 --------------------------------------------------------

const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x04060a, 1); // 接近纯黑的深空色,暗于 RGB(16,16,24)

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  FOV_DEG,
  window.innerWidth / window.innerHeight,
  0.5,
  4000
);

// --- 星点着色器(逐星颜色 / 尺寸,加色混合,批量提交)-------------------------------

const starUniforms = {
  uScale: { value: 1 }, // 1 世界单位在深度 1 处的像素数 = H / (2·tan(fov/2))
};
const starMaterial = new THREE.ShaderMaterial({
  uniforms: starUniforms,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec3 aColor;
    varying vec3 vColor;
    uniform float uScale;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vec4 clip = projectionMatrix * mv;
      // 显式执行 GL 点裁剪规则:中心在裁剪体外(|ndc|>1 或 w<=0)的点必须整点丢弃。
      // 部分软件光栅器(SwiftShader)对体外中心仍做错误光栅化(y=0 伪亮线),故在此手动剔除。
      if (clip.w <= 0.0 || abs(clip.x) > clip.w || abs(clip.y) > clip.w || abs(clip.z) > clip.w) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 1.0;
        return;
      }
      gl_PointSize = clamp(aSize * uScale / (-mv.z), 1.0, 120.0);
      gl_Position = clip;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      float e = max(0.0, 1.0 - r2);           // 柔和圆形衰减(多项式,软光栅器友好)
      gl_FragColor = vec4(vColor, e * e);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

function pxScale() {
  return renderer.domElement.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
}
starUniforms.uScale.value = pxScale();

// --- 星系生成 --------------------------------------------------------------------

// 盘面厚度:内厚外薄,叠中央隆起
function diskHeight(r) {
  return 1.4 + 2.6 * Math.exp(-r / 16);
}

// 沿半径的颜色梯度:核心暖黄白 -> 中段蓝白 -> 外缘冷蓝
const C_CORE = [1.0, 0.9, 0.72];
const C_MIDIN = [0.96, 0.94, 0.9];
const C_ARM = [0.78, 0.84, 1.0];
const C_EDGE = [0.55, 0.66, 1.0];
function radialColor(t, out) {
  let c0;
  let c1;
  let k;
  if (t < 0.3) {
    c0 = C_CORE;
    c1 = C_MIDIN;
    k = t / 0.3;
  } else if (t < 0.65) {
    c0 = C_MIDIN;
    c1 = C_ARM;
    k = (t - 0.3) / 0.35;
  } else {
    c0 = C_ARM;
    c1 = C_EDGE;
    k = (t - 0.65) / 0.35;
  }
  for (let i = 0; i < 3; i++) {
    out[i] = clamp(lerp(c0[i], c1[i], k) * (0.92 + 0.16 * rnd()), 0, 1);
  }
  return out;
}

// 亮暗分层:12% 亮星 / 70% 普通星 / 18% 暗弱星
function tierSize() {
  const u = rnd();
  if (u < 0.12) return 0.5 + 0.25 * rnd(); // 亮
  if (u < 0.82) return 0.36 + 0.18 * rnd(); // 普通
  return 0.24 + 0.12 * rnd();              // 暗弱
}

const galaxyCount = COUNT_BULGE + COUNT_ARM_PER * ARM_COUNT + COUNT_DISK + COUNT_GIANTS;
const gPos = new Float32Array(galaxyCount * 3);
const gCol = new Float32Array(galaxyCount * 3);
const gSize = new Float32Array(galaxyCount);
const tmpC = [0, 0, 0];
let gi = 0;

function put(x, y, z, c, intensity, size) {
  const i3 = gi * 3;
  gPos[i3] = x;
  gPos[i3 + 1] = y;
  gPos[i3 + 2] = z;
  gCol[i3] = c[0] * intensity;
  gCol[i3 + 1] = c[1] * intensity;
  gCol[i3 + 2] = c[2] * intensity;
  gSize[gi] = size;
  gi += 1;
}

// 1) 核球:中央密集暖色亮星群,带厚度隆起
for (let n = 0; n < COUNT_BULGE; n++) {
  const rr = Math.abs(gauss()) * 5.5 + Math.abs(gauss()) * 2.0;
  const r = Math.min(rr, 17);
  const th = rnd() * Math.PI * 2;
  const h = (4.2 * Math.exp(-(r * r) / 120) + 1.1) * gauss();
  const x = r * Math.cos(th);
  const z = r * Math.sin(th);
  const intensity = 0.85 + 0.15 * rnd();
  const c = radialColor(clamp(r / R_GAL, 0, 0.3) * 0.9, tmpC);
  const size = rnd() < 0.1 ? 1.0 + 0.3 * rnd() : 0.55 + 0.5 * rnd();
  put(x, h, z, c, intensity, size);
}

// 2) 旋臂:2 条对数螺旋主臂 θ = ln(r/r0)/b + 相位,垂直散布随半径加宽
for (let arm = 0; arm < ARM_COUNT; arm++) {
  const phase = (arm * Math.PI * 2) / ARM_COUNT; // 两条臂相差 π
  for (let n = 0; n < COUNT_ARM_PER; n++) {
    const u = Math.pow(rnd(), 1.15);
    const r = ARM_R0 + (R_GAL - ARM_R0) * u;
    const t = r / R_GAL;
    const sigma = 2.0 + 0.05 * r;
    const th = Math.log(r / ARM_R0) / ARM_B + phase + (gauss() * sigma) / r;
    const h = gauss() * diskHeight(r);
    radialColor(t, tmpC);
    const intensity = lerp(0.95, 0.55, t) * (0.8 + 0.4 * rnd());
    put(r * Math.cos(th), h, r * Math.sin(th), tmpC, intensity, tierSize());
  }
}

// 3) 弥散盘面星:全角度随机散布,稍暗
for (let n = 0; n < COUNT_DISK; n++) {
  const u = Math.pow(rnd(), 1.3);
  const r = ARM_R0 + (R_GAL - ARM_R0) * u;
  const t = r / R_GAL;
  const th = rnd() * Math.PI * 2;
  const h = gauss() * diskHeight(r) * 1.15;
  radialColor(t, tmpC);
  const intensity = lerp(0.85, 0.45, t) * (0.75 + 0.35 * rnd());
  const sz = tierSize();
  put(r * Math.cos(th), h, r * Math.sin(th), tmpC, intensity, sz * 0.95);
}

// 4) 橙红亮星:散布全盘,最亮一档
for (let n = 0; n < COUNT_GIANTS; n++) {
  const r = 8 + 62 * Math.pow(rnd(), 0.9);
  const th = rnd() * Math.PI * 2;
  const h = gauss() * diskHeight(r);
  const c = [1.0, 0.45 + 0.1 * rnd(), 0.25];
  put(r * Math.cos(th), h, r * Math.sin(th), c, 1.0, 0.75 + 0.45 * rnd());
}

const galaxyGeo = new THREE.BufferGeometry();
galaxyGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
galaxyGeo.setAttribute('aColor', new THREE.BufferAttribute(gCol, 3));
galaxyGeo.setAttribute('aSize', new THREE.BufferAttribute(gSize, 1));
const galaxy = new THREE.Points(galaxyGeo, starMaterial);
scene.add(galaxy);

// 5) 核球中央柔光(1 个大点,加色叠加出明亮核球)
const glowPos = new Float32Array([0, 0, 0]);
const glowCol = new Float32Array([0.5, 0.42, 0.29]);
const glowSize = new Float32Array([14]);
const glowGeo = new THREE.BufferGeometry();
glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
glowGeo.setAttribute('aColor', new THREE.BufferAttribute(glowCol, 3));
glowGeo.setAttribute('aSize', new THREE.BufferAttribute(glowSize, 1));
const glow = new THREE.Points(glowGeo, starMaterial);
scene.add(glow);

// --- 诊断开关(中性,不影响默认行为)----------------------------------------------
{
  const dbg = new URLSearchParams(location.search).get('debug') || '';
  if (dbg.includes('nogalaxy')) galaxy.visible = false;
  if (dbg.includes('noglow')) glow.visible = false;
}

// --- bench 状态 -------------------------------------------------------------------

const state = {
  starCount: STAR_COUNT,
  rotationPhase: 0,
  cameraDistance: DIST_INIT,
  parallaxOffset: { x: 0, y: 0 },
  fps: 0,
  hudVisible: true,
  epoch: 0,
};
let targetDistance = DIST_INIT;
const pointerTarget = { x: 0, y: 0 };
let resetAnim = null; // { t, dur, d0, px0, py0, ph0 }

// --- HUD(2D 覆盖层,含 Reset 控件)------------------------------------------------

const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.style.cssText =
  'position:fixed;top:12px;left:12px;z-index:100;padding:8px 12px;' +
  'background:rgba(6,10,18,0.62);border:1px solid rgba(120,170,255,0.35);' +
  'border-radius:6px;color:#bfe0ff;font:12px/1.7 "Consolas","Courier New",monospace;' +
  'pointer-events:none;user-select:none;white-space:nowrap;letter-spacing:0.4px;';
const hudStars = document.createElement('div');
const hudFps = document.createElement('div');
const hudDist = document.createElement('div');
hudStars.textContent = 'Stars: ' + STAR_COUNT;
hudFps.textContent = 'FPS: --';
hudDist.textContent = 'Dist: ' + DIST_INIT.toFixed(1);
hud.appendChild(hudStars);
hud.appendChild(hudFps);
hud.appendChild(hudDist);

const resetBtn = document.createElement('button');
resetBtn.type = 'button';
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText =
  'pointer-events:auto;margin-top:6px;padding:3px 14px;cursor:pointer;' +
  'background:#16233c;color:#d7e8ff;border:1px solid #3c5d9e;border-radius:4px;' +
  'font:12px "Consolas","Courier New",monospace;';
resetBtn.addEventListener('click', () => doReset());
hud.appendChild(resetBtn);
document.body.appendChild(hud);

// --- 输入:指针视差 / 滚轮穿行 ------------------------------------------------------

function onPointer(cx, cy) {
  pointerTarget.x = clamp((cx / window.innerWidth) * 2 - 1, -1, 1);
  pointerTarget.y = clamp((cy / window.innerHeight) * 2 - 1, -1, 1);
}
window.addEventListener('pointermove', (e) => onPointer(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => onPointer(e.clientX, e.clientY));

window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    targetDistance = clamp(targetDistance + e.deltaY * WHEEL_SCALE, DIST_MIN, DIST_MAX);
  },
  { passive: false }
);

// --- reset:0.6s 缓动恢复初始观察状态(非整页刷新)-----------------------------------

function easeInOutCubic(u) {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function doReset() {
  state.epoch += 1;
  state.rotationPhase = state.rotationPhase % (Math.PI * 2); // 取模保持视觉连续
  resetAnim = {
    t: 0,
    dur: 0.6,
    d0: state.cameraDistance,
    px0: state.parallaxOffset.x,
    py0: state.parallaxOffset.y,
    ph0: state.rotationPhase,
  };
  targetDistance = DIST_INIT;
  pointerTarget.x = 0;
  pointerTarget.y = 0;
}

window.__bench = {
  getState: () => ({
    starCount: state.starCount,
    rotationPhase: state.rotationPhase,
    cameraDistance: state.cameraDistance,
    parallaxOffset: { x: state.parallaxOffset.x, y: state.parallaxOffset.y },
    fps: state.fps,
    hudVisible: state.hudVisible,
    epoch: state.epoch,
  }),
  reset: doReset,
};

// --- 相机姿态 ---------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const basePos = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const shift = new THREE.Vector3();

function updateCamera() {
  const d = state.cameraDistance;
  basePos.set(0, Math.sin(ELEV) * d, Math.cos(ELEV) * d);
  forward.copy(basePos).multiplyScalar(-1).normalize(); // 指向星系中心
  right.crossVectors(forward, UP).normalize();
  up.crossVectors(right, forward);
  // 视差 = 相机与观察目标的整体平移(近处星系位移大、远景小 → 相对视差)
  shift.set(0, 0, 0)
    .addScaledVector(right, state.parallaxOffset.x * PARALLAX_AX)
    .addScaledVector(up, -state.parallaxOffset.y * PARALLAX_AY);
  camera.position.copy(basePos).add(shift);
  camera.lookAt(shift.x, shift.y, shift.z);
}
updateCamera();

// --- 主循环 -----------------------------------------------------------------------

const fpsTimes = [];
let last = performance.now();
let ready = false;

function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.1) dt = 0.1; // 后台节流恢复后避免大跳

  // fps:2s 滚动平均
  fpsTimes.push(now);
  while (fpsTimes.length > 0 && now - fpsTimes[0] > 2000) fpsTimes.shift();
  const span = fpsTimes.length > 1 ? (fpsTimes[fpsTimes.length - 1] - fpsTimes[0]) / 1000 : 0;
  state.fps = span > 0.25 ? (fpsTimes.length - 1) / span : 0;

  if (resetAnim) {
    // reset 缓动:距离/视差/相位同步回到初始值,0.6s 内精确完成
    resetAnim.t += dt;
    const u = clamp(resetAnim.t / resetAnim.dur, 0, 1);
    const k = easeInOutCubic(u);
    state.cameraDistance = lerp(resetAnim.d0, DIST_INIT, k);
    state.parallaxOffset.x = lerp(resetAnim.px0, 0, k);
    state.parallaxOffset.y = lerp(resetAnim.py0, 0, k);
    state.rotationPhase = lerp(resetAnim.ph0, 0, k);
    if (u >= 1) {
      state.cameraDistance = DIST_INIT;
      state.parallaxOffset.x = 0;
      state.parallaxOffset.y = 0;
      state.rotationPhase = 0;
      resetAnim = null;
    }
  } else {
    // 常规平滑:距离与视差逐帧指数逼近(无过冲)
    state.cameraDistance += (targetDistance - state.cameraDistance) * (1 - Math.exp(-dt / TAU_DIST));
    state.parallaxOffset.x += (pointerTarget.x - state.parallaxOffset.x) * (1 - Math.exp(-dt / TAU_PARA));
    state.parallaxOffset.y += (pointerTarget.y - state.parallaxOffset.y) * (1 - Math.exp(-dt / TAU_PARA));
    state.rotationPhase += ROT_OMEGA * dt;
  }

  galaxy.rotation.y = state.rotationPhase; // 绕盘面法线(+Y)整体慢旋
  updateCamera();
  renderer.render(scene, camera);

  if (!ready) {
    ready = true;
    window.__appReady = true; // 首帧渲染完成
  }

  // HUD 每帧刷新(真实运行数据,数值与 __bench 状态同帧一致)
  hudFps.textContent = 'FPS: ' + Math.round(state.fps);
  hudDist.textContent = 'Dist: ' + state.cameraDistance.toFixed(1);
  hudStars.textContent = 'Stars: ' + state.starCount;
  state.hudVisible = hud.style.display !== 'none' && document.body.contains(hud);
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  starUniforms.uScale.value = pxScale();
});
