// ============================================================================
// E01 — Deep Space Galaxy Cruise(深空星系巡航)— three.js r186
// ----------------------------------------------------------------------------
// 页面契约(冻结,见 ../spec.json;与 ../brief.md 冲突时以 spec.json 为准):
//   window.__appReady : 初始 false(index.html 内联),首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//     getState() → { starCount, rotationPhase, cameraDistance,
//                    parallaxOffset:{x,y}, fps, hudVisible, epoch }
//
// 实现要点:
//   - 三个 THREE.Points 批量层:旋臂盘面 41000 / 核球 9000 / 远景背景 10000,
//     共 60000 = getState().starCount(真实提交渲染的星点数,单几何一次性提交);
//   - 自定义 ShaderMaterial:逐星点位置/颜色/尺寸属性,加色混合 + 软辉光圆点;
//   - 双条对数螺旋旋臂(r = r0·e^(bθ),b=tan15°)+ 高斯散布盘面星;
//   - 颜色沿半径梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝,另散布 ~2.5% 橙红亮星;
//     三档亮暗层级(亮巨星 / 普通盘星 / 暗弱星);
//   - 星系绕盘面法线(+Y)持续慢旋 0.04 rad/s(合同区间 0.02–0.1);
//   - 相机:固定仰角 45° 斜俯视(法线与视线夹角 45° ∈ [30°,60°]);
//     滚轮改变目标距离(指数平滑,[40,400],初始 120);
//     指针视差经平滑后作为相机横/纵平移 —— 近层位移大、远景位移小,真实视差;
//   - HUD 为 DOM 覆盖层,数值全部来自运行状态(星点数 / 2s 滚动平均帧率 / 距离等);
//   - Reset:epoch+1,旋转相位与视差归零,相机距离 0.45s easeOutCubic 平滑回 120
//     (<1s 完成),不使用任何形式的页面刷新。
// 全部星点与结构程序化生成(确定性种子 RNG),不依赖任何外部图片/模型/预烘焙资源。
// ============================================================================

import * as THREE from 'three';

// ---------- 确定性随机(可复现的程序化生成) ---------------------------------
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
const rand = mulberry32(0xe01c0de);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------- 冻结参数 ---------------------------------------------------------
const DISK_STARS = 41000;   // 旋臂 + 盘面散布星
const BULGE_STARS = 9000;   // 核球(数千星点,计入总数)
const BG_STARS = 10000;     // 远景背景星(静态,增强纵深)
const STAR_COUNT = DISK_STARS + BULGE_STARS + BG_STARS; // 60000

const DISK_RADIUS = 80;          // 星系盘半径(世界单位)
const SPIN_SPEED = 0.04;         // rad/s,合同区间 [0.02, 0.1]
const DIST_INIT = 120;           // 初始相机距离
const DIST_MIN = 40, DIST_MAX = 400;
const WHEEL_UNIT = 0.1;          // 距离单位 / deltaY
const CAM_TAU = 0.35;            // 滚轮距离平滑时间常数(s)
const RESET_DUR = 0.45;          // reset 相机恢复时长(s,< 1s)
const PAR_TAU = 0.6;             // 视差平滑时间常数(s),无过冲
const PAR_AMP = 0.12;            // parallaxOffset = 指针偏移系数 × 0.12(峰值 ±0.06 ≤ 10% 画布)
const PAR_WORLD = 250;           // 视差状态 → 相机平移世界单位换算
const ELEV = Math.PI / 4;        // 相机仰角 45° ⇒ 盘面法线与视线夹角 45°
const AZIM = 0.65;               // 方位角(固定)
const FOV = 60;

// ---------- 画布与渲染器 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // 接近纯黑深空(暗于 RGB 16,16,24)

const camera = new THREE.PerspectiveCamera(
  FOV,
  window.innerWidth / window.innerHeight,
  0.5,
  2600
);

// ---------- 星点着色器(批量渲染,逐星点尺寸 + 软辉光) ------------------------
const starMaterial = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 1 } },
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec3 aColor;
    varying vec3 vColor;
    uniform float uScale;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float ps = aSize * uScale / max(1.0, -mv.z); // 透视尺寸衰减
      gl_PointSize = clamp(ps, 1.0, 48.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    void main() {
      vec2 q = gl_PointCoord - vec2(0.5);
      float d2 = dot(q, q) * 4.0;           // d2 ∈ [0,1],d = 归一化半径
      if (d2 > 1.0) discard;
      float d = sqrt(d2);
      float glow = 1.0 - d; glow = glow * glow; // 柔和晕圈
      float core = exp(-d2 * 5.0);              // 亮核
      float intensity = glow * 0.55 + core;
      gl_FragColor = vec4(vColor * intensity, 1.0);
    }
  `,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: false,
});

function updatePointScale() {
  // uScale = 焦距(设备像素) = 绘制缓冲高 / (2·tan(fov/2))
  const h = renderer.domElement.height;
  starMaterial.uniforms.uScale.value = h / (2 * Math.tan(((FOV * Math.PI) / 180) / 2));
}

function makePoints(pos, col, siz) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  const p = new THREE.Points(g, starMaterial);
  p.frustumCulled = false; // 60k 星点每帧全量提交,starCount 与真实提交数一致
  return p;
}

// ---------- 程序化生成:旋臂盘面(双对数螺旋) --------------------------------
function buildDisk() {
  const n = DISK_STARS;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const siz = new Float32Array(n);
  const ARMS = 2;
  const ARM_SEP = (Math.PI * 2) / ARMS;
  const SWEEP = 8.6;          // 臂总展角(rad)≈1.37 圈
  const PITCH = 0.268;        // ≈ tan(15°) 螺距
  const R0 = 8;               // 内起点半径(R0·e^(PITCH·SWEEP) ≈ 80 = DISK_RADIUS)
  for (let i = 0; i < n; i++) {
    const t = rand(); // 沿臂参数
    const arm = Math.floor(rand() * ARMS);
    let th = t * SWEEP + arm * ARM_SEP;
    let r = R0 * Math.exp(PITCH * t * SWEEP);
    if (rand() < 0.6) {
      th += gauss() * 0.13;       // 紧致臂成员
      r *= 1 + gauss() * 0.05;
    } else {
      th += gauss() * 0.55;       // 松散盘面星(仍整体沿用旋向)
      r *= 1 + gauss() * 0.17;
    }
    r = clamp(r, 1, DISK_RADIUS);
    const y = gauss() * (2.0 * Math.exp(-r / 55) + 0.7); // 盘面厚度(中心更厚)
    pos[i * 3] = Math.cos(th) * r;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(th) * r;

    // 颜色沿半径梯度
    const rf = r / DISK_RADIUS;
    let cr, cg, cb;
    if (rf < 0.16) {
      cr = 1.0; cg = 0.86 + rand() * 0.1; cb = 0.6 + rand() * 0.2; // 核区暖黄白
    } else {
      const k = clamp((rf - 0.16) / 0.84, 0, 1);
      cr = 0.92 - 0.3 * k;  // 中段蓝白 → 外缘冷蓝
      cg = 0.94 - 0.22 * k;
      cb = 1.0;
    }
    if (rand() < 0.025) { cr = 1.0; cg = 0.4 + rand() * 0.18; cb = 0.2 + rand() * 0.14; } // 橙红亮星

    // 三档亮暗层级
    const cls = rand();
    let size, boost;
    if (cls < 0.07) { size = 0.85 + rand() * 0.55; boost = 1.3; }        // 亮巨星
    else if (cls < 0.68) { size = 0.34 + rand() * 0.3; boost = 1.0; }    // 普通盘星
    else { size = 0.2 + rand() * 0.15; boost = 0.4; }                    // 暗弱星
    col[i * 3] = cr * boost;
    col[i * 3 + 1] = cg * boost;
    col[i * 3 + 2] = cb * boost;
    siz[i] = size;
  }
  return makePoints(pos, col, siz);
}

// ---------- 程序化生成:核球(中央明亮聚集 + 厚度隆起) ----------------------
function buildBulge() {
  const n = BULGE_STARS;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const siz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = gauss() * 6.5;
    const z = gauss() * 6.5;
    const y = gauss() * 4.2; // 垂向更扁但仍厚 → 中央隆起
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    const rr = Math.hypot(x, z);
    const cr = 1.0, cg = 0.84 + rand() * 0.12, cb = 0.52 + rand() * 0.28; // 暖黄白
    const cls = rand();
    let size, boost;
    if (cls < 0.1) { size = 0.9 + rand() * 0.6; boost = 1.35; }
    else if (cls < 0.75) { size = 0.34 + rand() * 0.3; boost = 1.0; }
    else { size = 0.2 + rand() * 0.14; boost = 0.5; }
    if (rr < 3.5) boost *= 1.35; // 最核心更亮
    col[i * 3] = cr * boost;
    col[i * 3 + 1] = cg * boost;
    col[i * 3 + 2] = cb * boost;
    siz[i] = size;
  }
  return makePoints(pos, col, siz);
}

// ---------- 程序化生成:远景背景星(静态球壳,增强纵深与视差) ---------------
function buildBackground() {
  const n = BG_STARS;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const siz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const R = 380 + rand() * 370;
    pos[i * 3] = s * Math.cos(phi) * R;
    pos[i * 3 + 1] = u * R;
    pos[i * 3 + 2] = s * Math.sin(phi) * R;
    const cls = rand();
    let boost;
    if (cls < 0.04) { siz[i] = 0.4 + rand() * 0.3; boost = 0.85; }       // 少量稍亮
    else { siz[i] = 0.22 + rand() * 0.18; boost = 0.3 + rand() * 0.2; }  // 暗弱远景
    col[i * 3] = (0.75 + rand() * 0.25) * boost;
    col[i * 3 + 1] = (0.8 + rand() * 0.2) * boost;
    col[i * 3 + 2] = 1.0 * boost;
  }
  return makePoints(pos, col, siz);
}

const galaxyGroup = new THREE.Group(); // 盘面 + 核球一起绕 +Y 慢旋
galaxyGroup.add(buildDisk());
galaxyGroup.add(buildBulge());
scene.add(galaxyGroup);
scene.add(buildBackground()); // 背景层静态(相对星系产生视差纵深)

// ---------- bench 状态(冻结契约) --------------------------------------------
const state = {
  starCount: STAR_COUNT,
  rotationPhase: 0,
  cameraDistance: DIST_INIT,
  parallaxOffset: { x: 0, y: 0 },
  fps: 0,
  hudVisible: true,
  epoch: 0,
};

let camDist = DIST_INIT;
let targetDist = DIST_INIT;
let parX = 0, parY = 0;       // 当前视差(平滑后,即状态与相机实际取值)
let tParX = 0, tParY = 0;     // 视差目标(由指针位置决定)
let resetAnim = null;         // { from, start }

function doReset() {
  state.epoch += 1;
  state.rotationPhase = 0;
  galaxyGroup.rotation.y = 0;
  parX = 0; parY = 0;
  state.parallaxOffset.x = 0;
  state.parallaxOffset.y = 0;
  targetDist = DIST_INIT;
  resetAnim = { from: camDist, start: performance.now() };
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

// 自检辅助:同步补渲染一帧(供 canvas.toDataURL 采帧,不影响正常循环)
window.__renderOnce = () => renderer.render(scene, camera);

// ---------- 输入:指针视差 + 滚轮穿行 -----------------------------------------
window.addEventListener('pointermove', (e) => {
  const fx = clamp(e.clientX / Math.max(1, window.innerWidth) - 0.5, -0.5, 0.5);
  const fy = clamp(e.clientY / Math.max(1, window.innerHeight) - 0.5, -0.5, 0.5);
  tParX = fx * PAR_AMP;
  tParY = fy * PAR_AMP;
});
window.addEventListener(
  'wheel',
  (e) => {
    targetDist = clamp(targetDist + e.deltaY * WHEEL_UNIT, DIST_MIN, DIST_MAX);
  },
  { passive: true }
);

// ---------- HUD(2D 覆盖层,数值全部来自真实运行状态) ------------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:9999;' +
  'background:rgba(3,6,14,0.55);border:1px solid rgba(110,150,255,0.30);border-radius:6px;' +
  'padding:8px 12px 10px;font:12px/1.7 Consolas,ui-monospace,Menlo,monospace;color:#cfe0ff;' +
  'user-select:none;pointer-events:auto;';
hud.innerHTML =
  '<div style="font-weight:700;color:#ffffff;letter-spacing:0.5px;">E01 · Deep Space Galaxy Cruise</div>' +
  '<div>Stars 星点: <span id="hud-stars">—</span></div>' +
  '<div>FPS 帧率: <span id="hud-fps">—</span></div>' +
  '<div>Distance 距离: <span id="hud-dist">—</span></div>' +
  '<div>Phase 相位: <span id="hud-phase">—</span></div>' +
  '<button id="hud-reset" type="button" data-ui="reset" aria-label="reset" ' +
  'style="margin-top:6px;padding:3px 14px;font:12px Consolas,monospace;background:#1b2a4a;' +
  'color:#eaf1ff;border:1px solid #4a6cff;border-radius:4px;cursor:pointer;">Reset</button>';
document.body.appendChild(hud);

const elStars = document.getElementById('hud-stars');
const elFps = document.getElementById('hud-fps');
const elDist = document.getElementById('hud-dist');
const elPhase = document.getElementById('hud-phase');
document.getElementById('hud-reset').addEventListener('click', () => doReset());

let hudLast = -1e9;
function updateHud(now) {
  if (now - hudLast < 50) return; // ≤50ms 刷新,HUD 数字与 __bench 状态偏差可忽略
  hudLast = now;
  elStars.textContent = String(state.starCount);
  elFps.textContent = String(Math.round(state.fps));
  elDist.textContent = state.cameraDistance.toFixed(1);
  elPhase.textContent = state.rotationPhase.toFixed(3);
}

// ---------- 视口自适应 --------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  updatePointScale();
});

// ---------- 主循环 -------------------------------------------------------------
const _base = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const frameStamps = [];
let last = performance.now();

function tick() {
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 后台标签页节流恢复保护(基于时钟增量)
  if (dt < 0) dt = 0;

  // 星系绕盘面法线(+Y)持续慢旋;rotationPhase 单调递增
  state.rotationPhase += SPIN_SPEED * dt;
  galaxyGroup.rotation.y = state.rotationPhase;

  // 相机距离:reset 用 0.45s easeOutCubic 恢复;滚轮用指数平滑(逐帧插值,不瞬跳)
  if (resetAnim) {
    const k = clamp((now - resetAnim.start) / (RESET_DUR * 1000), 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    camDist = resetAnim.from + (DIST_INIT - resetAnim.from) * e;
    if (k >= 1) resetAnim = null;
  } else {
    camDist += (targetDist - camDist) * (1 - Math.exp(-dt / CAM_TAU));
  }
  state.cameraDistance = camDist;

  // 视差平滑(指数,无过冲振荡)
  const kp = 1 - Math.exp(-dt / PAR_TAU);
  parX += (tParX - parX) * kp;
  parY += (tParY - parY) * kp;
  state.parallaxOffset.x = parX;
  state.parallaxOffset.y = parY;

  // 相机位姿:仰角 45° 斜俯视;先按基准位姿定向,再施加视差平移
  // (保持朝向不变的整体平移 → 近处星系位移大、远景背景位移小,真实视差)
  const ch = Math.cos(ELEV) * camDist;
  const cyv = Math.sin(ELEV) * camDist;
  _base.set(Math.sin(AZIM) * ch, cyv, Math.cos(AZIM) * ch);
  camera.position.copy(_base);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  _r.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(_r, parX * PAR_WORLD);
  camera.position.addScaledVector(_u, -parY * PAR_WORLD * 0.55);

  renderer.render(scene, camera);

  // fps:2s 滚动平均
  frameStamps.push(now);
  const cutoff = now - 2000;
  while (frameStamps.length > 2 && frameStamps[0] < cutoff) frameStamps.shift();
  if (frameStamps.length >= 2) {
    state.fps = ((frameStamps.length - 1) * 1000) / (frameStamps[frameStamps.length - 1] - frameStamps[0]);
  }

  updateHud(now);

  if (window.__appReady !== true) {
    window.__appReady = true; // 首帧渲染完成,页面就绪
  }
  requestAnimationFrame(tick);
}

updatePointScale();
requestAnimationFrame(tick);
