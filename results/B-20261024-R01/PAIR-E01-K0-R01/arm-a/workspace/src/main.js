// ============================================================================
// E01 — Deep Space Galaxy Cruise(three.js r186 / 0.186.1)
// ----------------------------------------------------------------------------
// 全程序化旋涡星系:60,000 颗星系星点(1 次 Points 绘制)+ 8,000 颗远景星点
// (1 次 Points 绘制),合计 68,000 颗真实提交渲染的星点。
// 页面契约:
//   window.__appReady — 首帧渲染后置 true
//   window.__bench    — { getState(): object, reset(): void }
// 交互:指针视差 / 滚轮穿行 / HUD 实时数据 / Reset 控件(data-ui="reset")
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------- 冻结规格常量
const INITIAL_DISTANCE = 120;      // 初始 / reset 相机距离
const MIN_DISTANCE = 40;
const MAX_DISTANCE = 400;
const OMEGA = 0.04;                // 星系自转角速度 rad/s(规格 0.02–0.1)
const ZOOM_DURATION = 1.0;         // 滚轮距离过渡时长 s(逐帧插值,不瞬跳)
const RESET_DURATION = 0.55;       // reset 归位时长 s(< 1s 合同)
const PARALLAX_TAU = 0.4;          // 视差平滑时间常数 s(平滑跟随)
const PARALLAX_SHIFT = 0.08;       // 视差横向位移 = 距离 × 该系数(≤ 画面 10%)
const SIZE_K = 0.5;                // 世界尺寸 -> 像素尺寸的全局系数

// 星点规模(状态 starCount 与真实提交渲染的点数严格一致)
const BULGE_COUNT = 6500;
const DISK_COUNT = 53500;
const GALAXY_COUNT = BULGE_COUNT + DISK_COUNT; // 60000
const BG_COUNT = 8000;                          // 远景背景星层
const TOTAL_STARS = GALAXY_COUNT + BG_COUNT;    // 68000

const GALAXY_RADIUS = 64;          // 星系盘半径(世界单位)
const ARM_COUNT = 3;               // 旋臂数(对数螺旋)
const ARM_WIND = 2.4;              // 螺旋缠绕系数 b(theta = b·ln(r/r0))

// ---------------------------------------------------------------- 确定性随机
// 固定种子:每次加载生成同一星系(可复现),无任何外部资产。
function mulberry32(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eed2026);
// Box–Muller:高斯散布用于旋臂宽度与盘厚
function gauss() {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- 渲染器/场景
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x05060b, 1); // 近纯黑深空底色(< RGB 16,16,24)

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.5,
  4000
);

// 观察方向:方位 0.55 rad、仰角 33°(盘面法线与视线夹角 ≈ 57°,落在 30°–60°)
// 注视点略低于盘心,使倾斜后的椭圆构图在画面中居中而不被下边缘裁切。
const ELEV = THREE.MathUtils.degToRad(33);
const AZ = 0.55;
const TARGET_Y = -10;
const viewDir = new THREE.Vector3(
  Math.sin(AZ) * Math.cos(ELEV),
  Math.sin(ELEV),
  Math.cos(AZ) * Math.cos(ELEV)
).normalize();
const forwardVec = viewDir.clone().negate();
const rightVec = new THREE.Vector3().crossVectors(forwardVec, new THREE.Vector3(0, 1, 0)).normalize();
const upVec = new THREE.Vector3().crossVectors(rightVec, forwardVec).normalize();

const galaxyGroup = new THREE.Group(); // 星系整体绕盘面法线(+Y)自转
scene.add(galaxyGroup);

// ---------------------------------------------------------------- 调色板
// Color 构造时由 sRGB 转到线性工作空间;着色器末尾手工编码回 sRGB。
const C_CORE = new THREE.Color(0xffc97a);   // 核球:暖黄
const C_CORE2 = new THREE.Color(0xffe9c6);  // 更亮的暖白核
const C_MID = new THREE.Color(0xb9d4ff);    // 旋臂中段:蓝白
const C_OUT = new THREE.Color(0x4a69ff);    // 外缘:冷蓝
const C_ORANGE = new THREE.Color(0xff5a28); // 少量橙红亮星
const C_BG1 = new THREE.Color(0xffffff);
const C_BG2 = new THREE.Color(0x9db8ff);
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

// ---------------------------------------------------------------- 星点数据生成
function makeStarArrays(count) {
  return {
    pos: new Float32Array(count * 3),
    col: new Float32Array(count * 3),
    size: new Float32Array(count),
    alpha: new Float32Array(count),
  };
}

// 星系(核球 + 旋臂/盘面散星)
function buildGalaxyData() {
  const { pos, col, size, alpha } = makeStarArrays(GALAXY_COUNT);
  let i = 0;

  // ---- 核球:中心密集球状聚集(计入总数),扁率 0.60 ----
  for (let k = 0; k < BULGE_COUNT; k++, i++) {
    const r = 13 * Math.pow(rand(), 1.35);         // 强中心聚集
    const cosT = rand() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rand() * Math.PI * 2;
    const x = r * sinT * Math.cos(phi);
    const z = r * sinT * Math.sin(phi);
    const y = r * cosT * 0.6;

    const mix = rand() * 0.7;                      // 暖黄 -> 暖白
    tmpA.copy(C_CORE).lerp(C_CORE2, mix);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    col[i * 3] = tmpA.r;
    col[i * 3 + 1] = tmpA.g;
    col[i * 3 + 2] = tmpA.b;
    size[i] = 0.6 + 0.75 * rand();                 // 亮星层级 3:核球亮星
    alpha[i] = 0.42 + 0.34 * rand();
  }

  // ---- 盘面:72% 旋臂星 + 28% 随机散星,颜色随半径梯度 ----
  const rMin = 5;
  for (let k = 0; k < DISK_COUNT; k++, i++) {
    const onArm = rand() < 0.72;
    let rr = Math.pow(rand(), 0.8);                // 0..1,盘面径向分布
    let r = rMin + rr * (GALAXY_RADIUS - rMin);
    let theta;
    if (onArm) {
      const arm = Math.floor(rand() * ARM_COUNT);
      theta = (arm / ARM_COUNT) * Math.PI * 2 + ARM_WIND * Math.log(Math.max(r, 4) / 8) + gauss() * 0.15;
      r += gauss() * 1.3;
    } else {
      theta = rand() * Math.PI * 2;
      r += gauss() * 2.4;
    }
    r = clamp(r, 2, GALAXY_RADIUS * 1.02);

    // 盘厚:中心隆起、外缘变薄 —— 使盘具有可感知的厚度而非纸片
    const thick = 0.9 + 3.0 * Math.exp(-r / 16);
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = gauss() * thick * 0.55;

    // 颜色梯度:核心暖白 -> 中段蓝白 -> 外缘冷蓝
    const t = r / GALAXY_RADIUS;
    if (t < 0.32) {
      tmpA.copy(C_CORE).lerp(C_MID, t / 0.32);
    } else {
      tmpA.copy(C_MID).lerp(C_OUT, clamp((t - 0.32) / 0.62, 0, 1));
    }
    // 每颗星的亮度微扰,避免颜色完全均匀
    const vary = 0.85 + 0.3 * rand();
    tmpA.multiplyScalar(vary);

    const isOrange = rand() < 0.01;                // 少量橙红亮星
    if (isOrange) {
      tmpB.copy(C_ORANGE).lerp(C_CORE2, rand() * 0.35);
      tmpA.copy(tmpB);
    }

    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    col[i * 3] = tmpA.r;
    col[i * 3 + 1] = tmpA.g;
    col[i * 3 + 2] = tmpA.b;

    if (isOrange) {
      size[i] = 1.2 + 1.2 * rand();
      alpha[i] = 0.8 + 0.2 * rand();
    } else if (onArm || rand() < 0.5) {
      // 亮暗层级 2:旋臂 / 盘面普通星
      size[i] = 0.38 + 0.62 * rand();
      alpha[i] = 0.42 + 0.30 * rand();
    } else {
      // 亮暗层级 1:暗弱背景星
      size[i] = 0.22 + 0.26 * rand();
      alpha[i] = 0.14 + 0.12 * rand();
    }
  }
  return { pos, col, size, alpha };
}

// 远景背景星层(独立对象、不随星系旋转,提供纵深与视差参照)
function buildBackgroundData() {
  const { pos, col, size, alpha } = makeStarArrays(BG_COUNT);
  for (let i = 0; i < BG_COUNT; i++) {
    const cosT = rand() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rand() * Math.PI * 2;
    const r = 520 + 880 * rand();
    pos[i * 3] = r * sinT * Math.cos(phi);
    pos[i * 3 + 1] = r * cosT;
    pos[i * 3 + 2] = r * sinT * Math.sin(phi);

    tmpA.copy(C_BG1).lerp(C_BG2, rand());
    col[i * 3] = tmpA.r;
    col[i * 3 + 1] = tmpA.g;
    col[i * 3 + 2] = tmpA.b;
    size[i] = 1.0 + 3.2 * rand();
    alpha[i] = 0.18 + 0.42 * rand();
  }
  return { pos, col, size, alpha };
}

function toGeometry(data) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(data.col, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(data.size, 1));
  geom.setAttribute('aAlpha', new THREE.BufferAttribute(data.alpha, 1));
  geom.computeBoundingSphere();
  return geom;
}

// ---------------------------------------------------------------- 星点着色器
// 圆点 + 中心辉光衰减(additive),点径按距离衰减 -> 近距星点明显放大变疏。
const starMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelScale: { value: 700 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aAlpha;
    uniform float uPixelScale;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float depth = max(-mv.z, 0.001);
      gl_PointSize = clamp(aSize * uPixelScale / depth, 1.0, 42.0);
      vColor = aColor;
      vAlpha = aAlpha;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r2 = dot(d, d);
      if (r2 > 0.25) discard;                       // 圆点边界
      float falloff = 1.0 - smoothstep(0.0, 0.25, r2);
      float core = pow(falloff, 2.5);
      vec3 c = vColor * (0.20 + 1.45 * core) * vAlpha;
      // Reinhard 压缩:密集叠加的核球不直接裁剪成纯白,保留暖色与蓝白色相
      vec3 mapped = c / (1.0 + 1.0 * c);
      vec3 srgb = pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)); // 线性 -> sRGB 编码
      gl_FragColor = vec4(srgb, 1.0);
    }
  `,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
  transparent: true,
});

const galaxyData = buildGalaxyData();
const backgroundData = buildBackgroundData();
const galaxyPoints = new THREE.Points(toGeometry(galaxyData), starMaterial);
const backgroundPoints = new THREE.Points(toGeometry(backgroundData), starMaterial);
galaxyPoints.frustumCulled = false;
backgroundPoints.frustumCulled = false;
galaxyGroup.add(galaxyPoints);
scene.add(backgroundPoints);

// 点径像素换算:drawingBufferHeight / (2·tan(fov/2)) × 全局系数
function updatePixelScale() {
  const sizeV = renderer.getDrawingBufferSize(new THREE.Vector2());
  const h = sizeV.y || window.innerHeight;
  starMaterial.uniforms.uPixelScale.value =
    (h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))) * SIZE_K;
}
updatePixelScale();

// ---------------------------------------------------------------- 运行状态
let phase = 0;          // 旋转相位(弧度),单调递增,reset 归零
let epoch = 0;          // reset 计数
let distance = INITIAL_DISTANCE;
let zoomFrom = INITIAL_DISTANCE;
let zoomTo = INITIAL_DISTANCE;
let zoomT = 1;          // 0..1 过渡进度
let zoomDuration = ZOOM_DURATION;
let parX = 0;           // 平滑后的视差偏移(-1..1)
let parY = 0;
let parTargetX = 0;
let parTargetY = 0;
let fpsAvg = 0;

const frameTimes = [];  // 最近 2s 的帧时间戳(滚动平均帧率)

// ---------------------------------------------------------------- 相机
function applyCamera() {
  const amount = distance * PARALLAX_SHIFT; // 视差位移随观察距离缩放(屏幕占比恒定)
  camera.position
    .copy(viewDir)
    .multiplyScalar(distance)
    .addScaledVector(rightVec, parX * amount)
    .addScaledVector(upVec, -parY * amount);
  camera.lookAt(0, TARGET_Y, 0);
}
applyCamera();

// ---------------------------------------------------------------- 距离过渡
// 逐帧插值(smoothstep),滚轮与 reset 都走同一条平滑路径,绝不瞬跳。
function startZoom(target, duration) {
  zoomFrom = distance;
  zoomTo = clamp(target, MIN_DISTANCE, MAX_DISTANCE);
  zoomT = 0;
  zoomDuration = duration;
}
function updateZoom(dt) {
  if (zoomT >= 1) return;
  zoomT = Math.min(1, zoomT + dt / zoomDuration);
  distance = zoomFrom + (zoomTo - zoomFrom) * smoothstep(zoomT);
}

// ---------------------------------------------------------------- 输入
function handlePointer(e) {
  const nx = (e.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
  const ny = (e.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2;
  parTargetX = clamp(nx, -1, 1);
  parTargetY = clamp(ny, -1, 1);
}
window.addEventListener('pointermove', handlePointer, { passive: true });
window.addEventListener('mousemove', handlePointer, { passive: true });

window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    // 向上(deltaY<0)靠近、向下远离;指数缩放保证近远两端手感一致
    const factor = Math.exp(e.deltaY * 0.0009);
    startZoom(zoomTo * factor, ZOOM_DURATION);
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  updatePixelScale();
});

// ---------------------------------------------------------------- HUD
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.setAttribute('aria-label', 'hud');
hud.style.cssText = [
  'position:fixed',
  'left:16px',
  'top:16px',
  'z-index:10',
  'padding:10px 14px 12px',
  'min-width:168px',
  'background:rgba(6,10,20,0.68)',
  'border:1px solid rgba(120,170,255,0.32)',
  'border-radius:8px',
  'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace',
  'color:#9dc0ff',
  'letter-spacing:0.08em',
  'user-select:none',
].join(';');

const title = document.createElement('div');
title.textContent = 'DEEP SPACE CRUISE';
title.style.cssText = 'font-size:10px;color:#7fa6e8;letter-spacing:0.2em;margin-bottom:7px;';
hud.appendChild(title);

function makeRow(label) {
  // 单行内联文本("LABEL value"),便于 HUD 文本读取与数字解析
  const line = document.createElement('div');
  line.style.cssText = 'white-space:nowrap;';
  line.appendChild(document.createTextNode(label + ' '));
  const val = document.createElement('span');
  val.style.cssText = 'color:#eaf3ff;font-weight:700;letter-spacing:0.04em;';
  val.textContent = '0';
  line.appendChild(val);
  hud.appendChild(line);
  return val;
}
const hudStars = makeRow('STARS');
const hudFps = makeRow('FPS');
const hudDist = makeRow('DIST');

const resetBtn = document.createElement('button');
resetBtn.type = 'button';
resetBtn.id = 'reset-btn';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.textContent = 'Reset';
resetBtn.style.cssText = [
  'margin-top:10px',
  'width:100%',
  'padding:5px 10px',
  'font:inherit',
  'letter-spacing:0.14em',
  'color:#eaf3ff',
  'background:rgba(58,105,196,0.30)',
  'border:1px solid rgba(130,180,255,0.55)',
  'border-radius:5px',
  'cursor:pointer',
].join(';');
hud.appendChild(resetBtn);
document.body.appendChild(hud);

let hudStarsText = '';
let hudFpsText = '';
let hudDistText = '';
function updateHud() {
  const s = String(TOTAL_STARS);
  if (s !== hudStarsText) {
    hudStarsText = s;
    hudStars.textContent = s;
  }
  const f = String(Math.round(fpsAvg));
  if (f !== hudFpsText) {
    hudFpsText = f;
    hudFps.textContent = f;
  }
  const d = String(Math.round(distance));
  if (d !== hudDistText) {
    hudDistText = d;
    hudDist.textContent = d;
  }
}
updateHud();

// ---------------------------------------------------------------- reset / 状态
function doReset() {
  epoch += 1;
  phase = 0;
  galaxyGroup.rotation.y = 0;
  parX = 0;
  parY = 0;
  parTargetX = 0;
  parTargetY = 0;
  startZoom(INITIAL_DISTANCE, RESET_DURATION); // 平滑归位(≤1s 内完成)
}
resetBtn.addEventListener('click', doReset);

window.__bench = {
  getState() {
    // fixed 定位元素的 offsetParent 恒为 null,故用包围盒 + 计算样式判定可见性
    const box = hud.getBoundingClientRect();
    const style = window.getComputedStyle(hud);
    return {
      starCount: TOTAL_STARS,
      rotationPhase: phase,
      cameraDistance: distance,
      parallaxOffset: { x: parX, y: parY },
      fps: fpsAvg,
      hudVisible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      epoch,
    };
  },
  reset: doReset,
};

// ---------------------------------------------------------------- 主循环
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 后台节流后不产生巨大步进
  const now = performance.now();

  phase += OMEGA * dt;                        // 单调递增的旋转相位
  galaxyGroup.rotation.y = phase;

  updateZoom(dt);

  // 指针视差:指数平滑跟随(帧率无关)
  const k = 1 - Math.exp(-dt / PARALLAX_TAU);
  parX += (parTargetX - parX) * k;
  parY += (parTargetY - parY) * k;

  applyCamera();
  renderer.render(scene, camera);

  // 2s 滚动平均帧率
  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 2) {
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    fpsAvg = span > 0 ? ((frameTimes.length - 1) * 1000) / span : 0;
  }

  updateHud();

  if (window.__appReady !== true) {
    window.__appReady = true; // 首帧渲染完成,页面就绪
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
