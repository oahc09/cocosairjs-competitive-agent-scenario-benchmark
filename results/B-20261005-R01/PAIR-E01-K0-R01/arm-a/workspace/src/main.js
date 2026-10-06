// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)| arm-a / three r186
// ----------------------------------------------------------------------------
// 实现要点(spec.json 对齐):
//   * 60,000 星点全部程序化生成、两次批量 draw call 提交渲染:
//       - 旋转星系 54,000(核球 10,000 + 2 条对数螺旋旋臂 32,000 + 盘面散星 12,000)
//       - 静态远景背景星 6,000(大半径球壳,增强纵深)
//     starCount 状态直接读自两份 BufferGeometry 的真实顶点数,与提交渲染数严格相等。
//   * 颜色沿半径梯度:核心暖黄白 → 旋臂中段蓝白 → 外缘冷蓝,散布少量橙红亮星;
//     亮度分层:核球亮星 / 旋臂普通星 / 盘面暗弱星 + 远景微光星(≥3 档)。
//   * 星系绕盘面法线(+Y)持续慢旋 ω=0.05 rad/s(0.02–0.1 区间中段,保证 reset 后
//     0.8s 采样窗内 rotationPhase < 0.1 的同时 2s 窗增量远大于 0.001)。
//   * 相机 45° 斜俯视(盘面法线与视线夹角 45° ∈ [30°,60°]);滚轮改变目标距离,
//     逐帧指数平滑逼近(无瞬跳、无过冲);指针视差为相机小幅横移+回看原点,
//     近处星系与远处背景星产生真实相对位移(3D 视差,非 DOM 位移)。
//   * HUD 为 DOM 覆盖层,数字全部来自与 __bench 同源的运行时状态(允许四舍五入)。
// 页面契约(harness 断言,MASTER-CONTEXT §12.1):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): {starCount, rotationPhase, cameraDistance,
//                        parallaxOffset:{x,y}, fps, hudVisible, epoch}, reset(): void }
// 引擎经 index.html 的 import map 解析,此处只 import 裸名(构建时保持 external)。
// ============================================================================

import * as THREE from 'three';

// ---------- 结构常量(星系构图) ----------------------------------------------
const ARM_COUNT = 2;          // ≥2 条对数螺旋旋臂
const ARM_STARS_PER_ARM = 16000;
const BULGE_STARS = 10000;    // 核球:中央明亮聚集
const FIELD_STARS = 12000;    // 盘面随机散布星
const BG_STARS = 6000;        // 远景背景星(静态)
const GALAXY_STARS = ARM_COUNT * ARM_STARS_PER_ARM + BULGE_STARS + FIELD_STARS; // 54,000
const TOTAL_STARS = GALAXY_STARS + BG_STARS;                                    // 60,000

const R0 = 6;                                  // 旋臂起始半径
const R_MAX = 82;                              // 盘面外缘半径(diameter 164 → 视宽约 67%,落在 60–75%)
const SPIRAL_B = 0.33;                         // 对数螺旋 r = R0·e^(bθ),b=0.33 → 螺距角约 18°
const THETA_MAX = Math.log(R_MAX / R0) / SPIRAL_B;

// ---------- 运动与交互常量 ----------------------------------------------------
const OMEGA = 0.05;           // rad/s,0.02–0.1 区间中段
const DIST_INIT = 120, DIST_MIN = 40, DIST_MAX = 400;
const WHEEL_K = 0.0008;       // deltaY=-600 → ×e^-0.48≈0.62 → 120→74.3(P4 双时序下均 >5)
const DIST_RATE = 2.5;        // 距离指数平滑速率:0→300ms 降 24,500→800ms 仍降 ~7(两种采样时序均过)
const PARALLAX_RATE = 3.5;    // 视差平滑:无过冲(纯指数),1s 内稳定
const PARALLAX_GAIN = 18;     // 最大视差 0.5×18=9 单位 → 画面位移约 47px(≈3.7% 宽 <10%)
const ELEVATION = Math.PI * 0.25; // 45° 斜俯视

// ---------- 画布与渲染器 -------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // 接近纯黑的深空色(暗于 RGB 16,16,24)

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.5,
  12000 // 远景星壳最远 3000 + 相机 400,留足余量
);

// ---------- 程序化生成辅助 -----------------------------------------------------
// Box-Muller 高斯分布(生成器无状态,调用开销可忽略)
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// 半径 → 颜色梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝
const C_CORE = [1.0, 0.93, 0.78];
const C_MID = [0.86, 0.91, 1.0];
const C_OUT = [0.6, 0.74, 1.0];
function radiusColor(t) {
  let a, b, k;
  if (t < 0.35) { a = C_CORE; b = C_MID; k = t / 0.35; }
  else { a = C_MID; b = C_OUT; k = Math.min(1, (t - 0.35) / 0.5); }
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// ---------- 星系几何(旋转组) ---------------------------------------------------
{
  var galaxyGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(GALAXY_STARS * 3);
  const col = new Float32Array(GALAXY_STARS * 3);
  const siz = new Float32Array(GALAXY_STARS);
  let i = 0;
  const put = (x, y, z, r, g, b, s) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
    siz[i] = s; i += 1;
  };

  // 核球:3D 高斯,中央隆起(厚度明显大于盘面),暖黄白亮星
  for (let k = 0; k < BULGE_STARS; k += 1) {
    const x = gauss() * 7.5, y = gauss() * 5.0, z = gauss() * 7.5;
    const inten = 0.85 + Math.random() * 0.5;
    put(x, y, z,
      1.0 * inten, (0.9 + Math.random() * 0.06) * inten, (0.68 + Math.random() * 0.14) * inten,
      0.3 + Math.random() * 0.38);
  }

  // 旋臂:对数螺旋 + 高斯弥散,盘面薄(y 厚度随半径缓慢增大)
  const armTotal = ARM_COUNT * ARM_STARS_PER_ARM;
  for (let k = 0; k < armTotal; k += 1) {
    const armIdx = k % ARM_COUNT;
    const u = Math.pow(Math.random(), 0.72); // 内密外疏
    const theta0 = u * THETA_MAX;
    let r = R0 * Math.exp(SPIRAL_B * theta0);
    r *= 1 + gauss() * 0.075;                      // 径向弥散
    const theta = theta0 + gauss() * 0.14;         // 角向弥散(臂宽随半径自然展开)
    const phase = armIdx * ((Math.PI * 2) / ARM_COUNT);
    const x = r * Math.cos(theta + phase);
    const z = r * Math.sin(theta + phase);
    const y = gauss() * (1.6 + 1.6 * u);
    const t = Math.min(1, r / R_MAX);
    let c = radiusColor(t);
    let size = 0.2 + Math.random() * 0.22;
    let inten = 0.55 + Math.random() * 0.4;
    if (Math.random() < 0.025) { // 少量橙红亮星(尺寸/亮度双提升)
      c = [1.0, 0.52 + Math.random() * 0.1, 0.3];
      size *= 1.9; inten = 1.1 + Math.random() * 0.4;
    }
    put(x, y, z, c[0] * inten, c[1] * inten, c[2] * inten, size);
  }

  // 盘面散星:填充旋臂之间,更暗更小(构成暗弱背景层级)
  for (let k = 0; k < FIELD_STARS; k += 1) {
    const u = Math.pow(Math.random(), 0.6);
    const r = 5 + u * (R_MAX - 6);
    const th = Math.random() * Math.PI * 2;
    const y = gauss() * (1.4 + 2.2 * u);
    const t = Math.min(1, r / R_MAX);
    let c = radiusColor(t);
    let size = 0.14 + Math.random() * 0.18;
    let inten = 0.34 + Math.random() * 0.26;
    if (Math.random() < 0.02) {
      c = [1.0, 0.55, 0.32]; size *= 1.8; inten = 1.0;
    }
    put(r * Math.cos(th), y, r * Math.sin(th), c[0] * inten, c[1] * inten, c[2] * inten, size);
  }

  galaxyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  galaxyGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  galaxyGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
}

// ---------- 远景背景星(静态球壳) ----------------------------------------------
{
  var bgGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(BG_STARS * 3);
  const col = new Float32Array(BG_STARS * 3);
  const siz = new Float32Array(BG_STARS);
  for (let k = 0; k < BG_STARS; k += 1) {
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const R = 1400 + Math.random() * 1600;
    pos[k * 3] = s * Math.cos(phi) * R;
    pos[k * 3 + 1] = u * R;
    pos[k * 3 + 2] = s * Math.sin(phi) * R;
    let c = (Math.random() < 0.75)
      ? [0.72 + Math.random() * 0.2, 0.78 + Math.random() * 0.15, 1.0]
      : [1.0, 0.8 + Math.random() * 0.12, 0.62];
    const inten = 0.3 + Math.random() * 0.3;
    col[k * 3] = c[0] * inten; col[k * 3 + 1] = c[1] * inten; col[k * 3 + 2] = c[2] * inten;
    siz[k] = 3.2 + Math.random() * 3.0; // 远处经尺寸衰减后仍约 1px 可辨
  }
  bgGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  bgGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  bgGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
}

// ---------- 点材质(逐星尺寸 + 软辉光,加色混合) --------------------------------
// uScale = 绘制缓冲高 / (2·tan(fov/2)),把世界尺寸换算为屏幕像素(透视衰减)。
const pointsMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 1 } },
  vertexShader: `
    uniform float uScale;
    attribute vec3 aColor;
    attribute float aSize;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float px = aSize * uScale / max(0.001, -mv.z);
      gl_PointSize = clamp(px, 1.0, 64.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float d2 = dot(p, p);
      if (d2 > 1.0) discard;
      float a = (1.0 - d2) * (1.0 - d2); // 二次衰减:中心亮、边缘柔和(辉光近似)
      gl_FragColor = vec4(vColor, a);
    }
  `,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
});

const galaxyGroup = new THREE.Group();
const galaxyPoints = new THREE.Points(galaxyGeo, pointsMat);
galaxyPoints.frustumCulled = false; // 点云跨越很大空间,关闭视锥剔除防误裁
galaxyGroup.add(galaxyPoints);
scene.add(galaxyGroup);

const bgPoints = new THREE.Points(bgGeo, pointsMat);
bgPoints.frustumCulled = false;
scene.add(bgPoints);

// starCount = 真实提交渲染的顶点数(两份几何体之和),不使用任何独立常数
const STAR_COUNT = galaxyGeo.getAttribute('position').count + bgGeo.getAttribute('position').count;

function updatePointScale() {
  const h = renderer.domElement.height; // 绘制缓冲高(物理像素)
  pointsMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
}
updatePointScale();

// ---------- 运行时状态 ----------------------------------------------------------
let rotationPhase = 0;          // 弧度,初始 0,单调递增(reset 归零)
let dist = DIST_INIT;           // 当前相机距离(逐帧平滑值,即状态报告值)
let targetDist = DIST_INIT;     // 滚轮目标距离
let par = { x: 0, y: 0 };       // 平滑后的视差偏移(状态报告值)
let parTarget = { x: 0, y: 0 }; // 指针目标视差
let parallaxArmed = false;      // reset 后忽略旧指针位置,直到下一次 pointermove
let epoch = 0;
let lastFps = 0;
const frameStamps = [];         // 最近 2s 的帧时间戳(滚动平均)

function doReset() {
  epoch += 1;
  rotationPhase = 0;
  dist = DIST_INIT;
  targetDist = DIST_INIT;
  par.x = 0; par.y = 0;
  parTarget.x = 0; parTarget.y = 0;
  parallaxArmed = false; // 恢复过程瞬时完成(<1s),且不受 reset 前指针残留位置影响
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    starCount: STAR_COUNT,
    rotationPhase,
    cameraDistance: dist,
    parallaxOffset: { x: par.x, y: par.y },
    fps: lastFps,
    hudVisible: true,
    epoch,
  }),
  reset: doReset,
};

// ---------- HUD(DOM 覆盖层,数字与 __bench 同源) -------------------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.style.cssText =
  'position:fixed;left:12px;top:12px;z-index:9999;min-width:150px;padding:8px 12px 10px;' +
  'font:12px/1.7 Consolas,monospace;color:#dfe8ff;background:rgba(8,10,18,0.72);' +
  'border:1px solid rgba(120,150,220,0.35);border-radius:6px;pointer-events:none;user-select:none;';
hud.innerHTML =
  '<div id="hud-stars">星点 0</div>' +
  '<div id="hud-fps">FPS 0</div>' +
  '<div id="hud-dist">距离 0.0</div>' +
  '<div id="hud-epoch">轮次 0</div>';
const btn = document.createElement('button');
btn.type = 'button';
btn.textContent = 'Reset';
btn.setAttribute('aria-label', 'reset');
btn.setAttribute('data-ui', 'reset');
btn.style.cssText =
  'pointer-events:auto;margin-top:6px;width:100%;padding:4px 0;' +
  'font:12px sans-serif;color:#e8eeff;background:#1c2333;' +
  'border:1px solid #5a76b8;border-radius:4px;cursor:pointer;';
btn.addEventListener('click', () => doReset());
hud.appendChild(btn);
document.body.appendChild(hud);

const elStars = document.getElementById('hud-stars');
const elFps = document.getElementById('hud-fps');
const elDist = document.getElementById('hud-dist');
const elEpoch = document.getElementById('hud-epoch');
let hudStarsCache = -1, hudFpsCache = -1, hudDistCache = -1, hudEpochCache = -1;
function updateHud() {
  if (STAR_COUNT !== hudStarsCache) { hudStarsCache = STAR_COUNT; elStars.textContent = `星点 ${STAR_COUNT}`; }
  const f = Math.round(lastFps);
  if (f !== hudFpsCache) { hudFpsCache = f; elFps.textContent = `FPS ${f}`; }
  const d = Math.round(dist * 10) / 10;
  if (d !== hudDistCache) { hudDistCache = d; elDist.textContent = `距离 ${d.toFixed(1)}`; }
  if (epoch !== hudEpochCache) { hudEpochCache = epoch; elEpoch.textContent = `轮次 ${epoch}`; }
}

// ---------- 输入 ----------------------------------------------------------------
// 指针视差:基于指针偏离画面中心的有符号归一化偏移
window.addEventListener('pointermove', (e) => {
  const nx = e.clientX / window.innerWidth - 0.5;
  const ny = e.clientY / window.innerHeight - 0.5;
  parallaxArmed = true;
  parTarget.x = THREE.MathUtils.clamp(nx, -0.5, 0.5);
  parTarget.y = THREE.MathUtils.clamp(ny, -0.5, 0.5);
});

// 滚轮穿行:deltaY<0 靠近(距离减小),deltaY>0 远离;目标距离限制在 [40,400]
window.addEventListener('wheel', (e) => {
  targetDist = THREE.MathUtils.clamp(targetDist * Math.exp(e.deltaY * WHEEL_K), DIST_MIN, DIST_MAX);
}, { passive: true });

// ---------- 主循环 ---------------------------------------------------------------
// 距离/视差逐帧指数平滑(无瞬跳、无过冲);旋转基于时钟增量,后台节流恢复后继续推进。
let lastT = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  rotationPhase += OMEGA * dt;
  galaxyGroup.rotation.y = -rotationPhase; // 星系绕盘面法线(+Y)慢旋

  dist += (targetDist - dist) * (1 - Math.exp(-dt * DIST_RATE));
  if (parallaxArmed) {
    const k = 1 - Math.exp(-dt * PARALLAX_RATE);
    par.x += (parTarget.x - par.x) * k;
    par.y += (parTarget.y - par.y) * k;
  }

  // 相机:45° 仰角球面定位 + 小幅指针视差横移,再看向星系中心
  const cy = Math.sin(ELEVATION) * dist;
  const cz = Math.cos(ELEVATION) * dist;
  camera.position.set(par.x * PARALLAX_GAIN, cy + par.y * PARALLAX_GAIN * 0.9, cz);
  camera.lookAt(0, 0, 0);

  // fps:最近 2s 滚动平均
  frameStamps.push(now);
  while (frameStamps.length > 0 && frameStamps[0] < now - 2000) frameStamps.shift();
  lastFps = frameStamps.length >= 2
    ? ((frameStamps.length - 1) * 1000) / Math.max(1, now - frameStamps[0])
    : 0;

  renderer.render(scene, camera);
  updateHud();
  window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 视口自适应 -----------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  updatePointScale();
});
