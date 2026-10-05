// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)—— three.js r186 实现
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(): object, reset(): void }
// 引擎经 index.html 的 import map 解析("three" -> /dist/vendor/three.module.js),
// 这里只 import 裸名,构建时 esbuild 保持为外部依赖。
//
// 实现要点(对齐 spec.json 探针口径):
//   * 60,000 星点 = 盘面 52,000 + 亮星 5,000 + 远景 3,000,三个 THREE.Points
//     各一次批量 draw call;starCount 状态值与真实提交渲染数严格一致;
//   * 双对数螺旋旋臂 + 中央核球 + 盘面厚度;颜色沿半径 暖黄白→蓝白→冷蓝 梯度,
//     散布橙红亮星;三档亮暗层级(亮星 / 盘面普通星 / 暗弱远景星);
//   * rotationPhase 以 0.05 rad/s(契约区间 [0.02,0.1])随时钟增量单调递增;
//   * 相机距离与视差均为逐帧指数平滑(不瞬跳);reset 采用更快收敛率,
//     保证 800ms 采样点已恢复至 120±5,全程非整页刷新;
//   * HUD 数字全部取自与 getState() 同源的数值,杜绝假数据。
// ============================================================================

import * as THREE from 'three';

// ---- 常量 -------------------------------------------------------------------
const TOTAL_STARS = 60000;        // 状态报告值 = 实际提交渲染的星点总数
const MAIN_COUNT = 52000;         // 盘面:核球 + 旋臂 + 散盘
const BRIGHT_COUNT = 5000;        // 亮星层:核球晕 + 旋臂蓝白巨星 + 橙红巨星
const FAR_COUNT = 3000;           // 远景背景星(静态,增强纵深与视差层次)
const DIST0 = 120;                // 初始相机距离(状态契约)
const DIST_MIN = 40, DIST_MAX = 400;
const WHEEL_GAIN = 0.1;           // deltaY → 目标距离增量(单次 -600 → -60)
const DIST_RATE_WHEEL = 2.5;      // 滚轮距离平滑率(1/s):平滑且在 500→800ms 采样窗内仍有 >5 变化
const DIST_RATE_RESET = 12;       // reset 恢复率:最大误差 360 也在 ~0.55s 内收敛(<1s 合同)
const PAR_RATE = 4.0;             // 视差平滑率(1/s)
const PARALLAX_GAIN = 0.25;       // 视差世界位移 = gain × offset × distance,屏占比 ≤ 6.7% (<10%)
const ROT_SPEED = 0.05;           // 星系角速度(rad/s),契约区间 [0.02, 0.1]
const ELEV = (40 * Math.PI) / 180; // 相机仰角:盘面法线与视线夹角 50° ∈ [30°, 60°]
const AZIM = -0.35;               // 方位角(取斜向构图)
const SEED = 20261004;            // 固定随机种子:同代码产物确定性可复现

// ---- 可复现随机数(mulberry32 + Box-Muller 高斯)-----------------------------
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- 星点精灵:运行时 canvas 径向渐变(程序化生成,非外部图片资产)----------
function makeStarSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---- 星点颜色:沿半径梯度(核 0..4 暖黄白 → 中段蓝白 → 外缘冷蓝)------------
function radiusColor(r, out) {
  const t = clamp((r - 4) / 58, 0, 1); // 盘面有效半径约 5..70
  if (t < 0.45) {
    const k = t / 0.45;
    out[0] = 1.0 - 0.26 * k;   // 暖黄白 → 蓝白
    out[1] = 0.87 - 0.03 * k;
    out[2] = 0.64 + 0.34 * k;
  } else {
    const k = (t - 0.45) / 0.55;
    out[0] = 0.74 - 0.19 * k;  // 蓝白 → 冷蓝
    out[1] = 0.84 - 0.13 * k;
    out[2] = 0.98 + 0.02 * k;
  }
}

// 对数螺旋臂的半径-角度关系:r = R0 * exp(b * theta),theta ∈ [0, 4.4] → r ∈ [5, 70]
const ARM_R0 = 5, ARM_B = 0.6, ARM_THETA_MAX = 4.4, ARM_COUNT = 2, ARM_WIDTH = 4.2;
function armRadius(theta) {
  return ARM_R0 * Math.exp(ARM_B * theta);
}

// ---- 盘面星点生成(核球 + 旋臂 + 散盘,单一 BufferGeometry)------------------
function buildMainGeometry() {
  const pos = new Float32Array(MAIN_COUNT * 3);
  const col = new Float32Array(MAIN_COUNT * 3);
  const c = [0, 0, 0];
  const bulgeCount = Math.floor(MAIN_COUNT * 0.17); // 核球约 8,800 颗(数千颗,计入总数)
  const armEveryOther = MAIN_COUNT - bulgeCount;

  for (let i = 0; i < MAIN_COUNT; i++) {
    let x, y, z, r;
    if (i < bulgeCount) {
      // 核球:中央三维高斯聚集,盘向压扁,形成中央隆起与亮核
      x = gauss() * 5.5;
      y = gauss() * 3.1;
      z = gauss() * 5.5;
      r = Math.sqrt(x * x + z * z);
    } else if (i - bulgeCount < armEveryOther * 0.62) {
      // 旋臂星:两条对数螺旋(相位差 π),恒定世界宽度的横向高斯弥散
      const arm = i % ARM_COUNT;
      const t = Math.pow(rand(), 0.9);
      const theta = t * ARM_THETA_MAX;
      r = armRadius(theta) * (1 + gauss() * 0.035);
      const phi = theta + arm * Math.PI + (gauss() * ARM_WIDTH) / Math.max(r, 8);
      x = r * Math.cos(phi);
      z = r * Math.sin(phi);
      y = gauss() * (1.1 + 2.4 * Math.exp(-r / 22));
    } else {
      // 散盘星:全域随机分布,略厚,避免旋臂外空白
      r = 5 + 63 * Math.pow(rand(), 0.8);
      const phi = rand() * Math.PI * 2;
      x = r * Math.cos(phi);
      z = r * Math.sin(phi);
      y = gauss() * (1.1 + 2.4 * Math.exp(-r / 22)) * 1.4;
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;

    // 颜色:半径梯度 × 亮度分层(散盘整体偏暗,形成暗弱背景层)
    radiusColor(r, c);
    const onArm = i >= bulgeCount && i - bulgeCount < armEveryOther * 0.62;
    let lum = (onArm ? 0.55 : 0.4) + 0.5 * Math.pow(rand(), 1.6);
    if (i < bulgeCount) lum = 0.65 + 0.35 * rand(); // 核球偏亮
    if (rand() < 0.012) {
      // 少量橙红亮星散布(视觉锚点)
      c[0] = 1.0; c[1] = 0.42 + 0.08 * rand(); c[2] = 0.2 + 0.08 * rand();
      lum = 0.85 + 0.15 * rand();
    }
    col[i * 3] = c[0] * lum;
    col[i * 3 + 1] = c[1] * lum;
    col[i * 3 + 2] = c[2] * lum;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---- 亮星层(更大点尺寸:核球晕 / 旋臂蓝白巨星 / 橙红巨星)-------------------
function buildBrightGeometry() {
  const pos = new Float32Array(BRIGHT_COUNT * 3);
  const col = new Float32Array(BRIGHT_COUNT * 3);
  const coreCount = 2500, giantCount = 1700; // 其余 800 为橙红巨星
  for (let i = 0; i < BRIGHT_COUNT; i++) {
    let x, y, z, r;
    if (i < coreCount) {
      x = gauss() * 4.5; y = gauss() * 2.6; z = gauss() * 4.5;
      r = Math.sqrt(x * x + z * z);
      col[i * 3] = 1.0; col[i * 3 + 1] = 0.88 + 0.06 * gauss(); col[i * 3 + 2] = 0.66 + 0.08 * gauss();
    } else if (i < coreCount + giantCount) {
      // 蓝白巨星落在旋臂上,强化旋臂可辨识度
      const arm = i % ARM_COUNT;
      const t = Math.pow(rand(), 0.85);
      const theta = t * ARM_THETA_MAX;
      r = armRadius(theta) * (1 + gauss() * 0.02);
      const phi = theta + arm * Math.PI + (gauss() * 2.5) / Math.max(r, 8);
      x = r * Math.cos(phi); z = r * Math.sin(phi);
      y = gauss() * 0.8;
      col[i * 3] = 0.78; col[i * 3 + 1] = 0.86; col[i * 3 + 2] = 1.0;
    } else {
      r = 6 + 60 * rand();
      const phi = rand() * Math.PI * 2;
      x = r * Math.cos(phi); z = r * Math.sin(phi);
      y = gauss() * 1.6;
      col[i * 3] = 1.0; col[i * 3 + 1] = 0.44 + 0.06 * rand(); col[i * 3 + 2] = 0.22 + 0.06 * rand();
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    if (i < coreCount) {
      const lum = 0.85 + 0.15 * rand();
      col[i * 3] *= lum; col[i * 3 + 1] *= lum; col[i * 3 + 2] *= lum;
    } else {
      const lum = 0.8 + 0.2 * rand();
      col[i * 3] *= lum; col[i * 3 + 1] *= lum; col[i * 3 + 2] *= lum;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---- 远景背景星(静态球壳,不随星系旋转;与星系形成纵深视差)-----------------
function buildFarGeometry() {
  const pos = new Float32Array(FAR_COUNT * 3);
  const col = new Float32Array(FAR_COUNT * 3);
  for (let i = 0; i < FAR_COUNT; i++) {
    let dx = gauss(), dy = gauss(), dz = gauss();
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const rad = 480 + rand() * 370;
    pos[i * 3] = (dx / len) * rad;
    pos[i * 3 + 1] = (dy / len) * rad;
    pos[i * 3 + 2] = (dz / len) * rad;
    const lum = 0.3 + 0.35 * rand(); // 暗弱背景档
    const blue = rand() < 0.6;
    col[i * 3] = (blue ? 0.75 : 0.95) * lum;
    col[i * 3 + 1] = 0.82 * lum;
    col[i * 3 + 2] = 1.0 * lum;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---- 渲染器 / 场景 / 相机 -----------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050509); // 深空近黑(RGB 5,5,9,暗于 16,16,24)

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.5, 3000
);

// ---- 星系对象:旋转组(盘面 + 亮星)+ 静态远景壳 ------------------------------
const sprite = makeStarSprite();
function pointsMaterial(size) {
  return new THREE.PointsMaterial({
    size,
    map: sprite,
    vertexColors: true,
    transparent: true,
    depthWrite: false,          // 加色混合:写入深度会造成星点互相裁剪
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
}

const galaxy = new THREE.Group();
const mainPoints = new THREE.Points(buildMainGeometry(), pointsMaterial(0.55));
const brightPoints = new THREE.Points(buildBrightGeometry(), pointsMaterial(1.15));
galaxy.add(mainPoints, brightPoints);
scene.add(galaxy);

const farPoints = new THREE.Points(buildFarGeometry(), pointsMaterial(2.6));
scene.add(farPoints);

// ---- 运行时状态(getState 单一来源)-------------------------------------------
let rotationPhase = 0;                    // 初始 0,随时间单调递增,reset 归零
let dist = DIST0;                        // 平滑后的相机距离
let distTarget = DIST0;
let distRate = DIST_RATE_WHEEL;
const parTgt = { x: 0, y: 0 };           // 指针归一化偏移目标(相对画面中心,有符号)
const parCur = { x: 0, y: 0 };           // 平滑后的当前视差
let epoch = 0;
let fpsAvg = 0;
const frameTimes = [];                    // 2s 滚动窗口的帧时间戳
const round4 = (v) => Math.round(v * 10000) / 10000;

function getState() {
  return {
    engine: 'three',
    starCount: TOTAL_STARS,
    rotationPhase,
    cameraDistance: Math.round(dist * 100) / 100,
    parallaxOffset: { x: round4(parCur.x), y: round4(parCur.y) },
    fps: Math.round(fpsAvg * 10) / 10,
    hudVisible: true,
    epoch,
  };
}

// reset:恢复初始观察状态(距离/视差/旋转相位),epoch+1,非整页刷新
function doReset() {
  epoch += 1;
  rotationPhase = 0;
  galaxy.rotation.y = 0;
  distTarget = DIST0;
  distRate = DIST_RATE_RESET; // 快速收敛:最大 360 误差也在 ~0.55s 内恢复(<1s 合同)
  parTgt.x = 0; parTgt.y = 0;
  parCur.x = 0; parCur.y = 0;
}
window.__bench = { getState, reset: doReset };

// ---- HUD(2D 覆盖层)+ Reset 控件 ---------------------------------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.style.cssText =
  'position:fixed;left:12px;top:12px;z-index:9998;pointer-events:none;' +
  'font:13px/1.7 ui-monospace,Consolas,monospace;color:#e6eeff;text-align:left;' +
  'background:rgba(3,5,14,0.5);border:1px solid rgba(130,160,255,0.28);' +
  'border-radius:6px;padding:8px 14px;white-space:pre;';
const hudTitle = document.createElement('div');
hudTitle.textContent = 'E01 Deep Space Galaxy Cruise';
const hudStars = document.createElement('div');
const hudFps = document.createElement('div');
const hudDist = document.createElement('div');
const hudPhase = document.createElement('div');
hud.append(hudTitle, hudStars, hudFps, hudDist, hudPhase);
document.body.appendChild(hud);

const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText =
  'position:fixed;right:12px;top:12px;z-index:9999;padding:6px 18px;' +
  'font:13px sans-serif;background:#1a2238;color:#eaf0ff;' +
  'border:1px solid #6f86c8;border-radius:6px;cursor:pointer;';
resetBtn.addEventListener('click', () => doReset());
document.body.appendChild(resetBtn);

let hudTimer = 0;
function updateHud() {
  const st = getState(); // HUD 与 __bench 同源,数字永远一致(允许四舍五入显示)
  hudStars.textContent = `stars  ${st.starCount}`;
  hudFps.textContent = `fps    ${st.fps}`;
  hudDist.textContent = `dist   ${Math.round(st.cameraDistance)}`;
  hudPhase.textContent = `phase  ${st.rotationPhase.toFixed(3)}`;
}
updateHud();

// ---- 输入:指针视差 + 滚轮穿行 --------------------------------------------------
// harness 以真实指针/滚轮事件驱动;监听 window 以保证事件总能到达。
function onPointerMove(e) {
  parTgt.x = e.clientX / window.innerWidth - 0.5;   // 有符号,范围约 [-0.5, 0.5]
  parTgt.y = e.clientY / window.innerHeight - 0.5;
}
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('mousemove', onPointerMove); // 兜底:仅合成 mousemove 的驱动方
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault(); // 页面本身不滚动,阻止默认行为保持视口稳定
    distTarget = clamp(distTarget + e.deltaY * WHEEL_GAIN, DIST_MIN, DIST_MAX);
    distRate = DIST_RATE_WHEEL;
  },
  { passive: false }
);

// ---- 相机摆位:斜俯视 + 视差侧移(平移产生真实纵深视差)------------------------
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
function placeCamera() {
  camera.position.set(
    dist * Math.cos(ELEV) * Math.sin(AZIM),
    dist * Math.sin(ELEV),
    dist * Math.cos(ELEV) * Math.cos(AZIM)
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  // 视差:保持朝向,仅沿相机右/上方向平移;远景壳因更远屏移更小 → 相对位移
  const off = PARALLAX_GAIN * dist;
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(_right, parCur.x * off);
  camera.position.addScaledVector(_up, -parCur.y * off);
}

// ---- 主循环 ---------------------------------------------------------------------
let lastT = performance.now();
function tick() {
  const now = performance.now();
  const dt = clamp((now - lastT) / 1000, 0, 0.1); // 后台节流恢复后不产生巨步
  lastT = now;

  // 旋转相位:单调递增(reset 归零)
  rotationPhase += ROT_SPEED * dt;
  galaxy.rotation.y = rotationPhase;

  // 相机距离:逐帧指数插值(不瞬跳)
  dist += (distTarget - dist) * (1 - Math.exp(-distRate * dt));
  if (distRate > DIST_RATE_WHEEL && Math.abs(distTarget - dist) < 0.05) {
    distRate = DIST_RATE_WHEEL; // reset 快速恢复完成后回到常规平滑率
  }

  // 视差:朝指针目标指数平滑
  const kp = 1 - Math.exp(-PAR_RATE * dt);
  parCur.x += (parTgt.x - parCur.x) * kp;
  parCur.y += (parTgt.y - parCur.y) * kp;

  placeCamera();
  renderer.render(scene, camera);

  // fps:2s 滚动平均(状态契约口径)
  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
  const span = now - frameTimes[0];
  fpsAvg = frameTimes.length > 1 && span > 0 ? ((frameTimes.length - 1) * 1000) / span : 0;

  hudTimer += dt;
  if (hudTimer >= 0.2) { hudTimer = 0; updateHud(); } // 实时刷新(5Hz,数字可读)

  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
