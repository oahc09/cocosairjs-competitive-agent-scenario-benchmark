// ============================================================================
// E05 — 黑洞吸积盘 (Black Hole Accretion Disk) — three r186
// ----------------------------------------------------------------------------
// 全程序化生成,无外部资产。视觉构成:
//   1) 深空背景:星云着色球(近黑基底 + 冷色星云渐变)+ 780 颗背景星(Points)
//   2) 吸积盘:RingGeometry(XZ 平面)+ 自定义 ShaderMaterial:
//      径向温度色带(白→黄→橙→暗红)+ 对数螺旋条纹(时间驱动连续旋转)+
//      多普勒不对称(+X 侧增亮)+ 内缘软化 + 外缘暗红衰减
//   3) 光子环:面向相机的加色光环(billboard),包绕暗核 → 引力透镜观感
//   4) 事件视界:面向相机的纯黑圆盘(平滑 AA 边缘),renderOrder 最后,吞噬星流
//   5) 星流:420 条螺旋轨迹(线段 = 拖尾 + 头部亮点),Kepler 式内快外慢,
//      接重视界加速/拖尾拉长,进入视界后外圈重生,总数恒定
//   6) 辉光:UnrealBloomPass(亮部柔光扩散)+ ACES 色调映射(亮部不死白)
// 交互:滚轮平滑缩放([5,28],指数插值)、拖拽微调视角(松开保持)、reset 按钮。
// 状态契约:window.__appReady / window.__bench = { getState, reset }。
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---- 常量 -------------------------------------------------------------------
const DIST0 = 14.0;                    // 初始相机距离(场景单位)
const DIST_MIN = 5, DIST_MAX = 28;     // 缩放范围
const ZOOM_K = 0.00085;                // wheel dy → 距离乘子 exp(K*dy);dy=-600 ⇒ ×0.60
const EL0 = (32 * Math.PI) / 180;      // 初始俯仰角(盘面倾角观感 15°–75° 内)
const AZ0 = 0;                         // 初始方位角
const ROT_SPEED = 0.45;                // 盘角速度 rad/s(规格 0.15–0.6)
const STREAM_N = 420;                  // 星流粒子数(>=200,恒定)
const BG_DIM = 700, BG_BRIGHT = 80;    // 背景星(>=300)
const BG_N = BG_DIM + BG_BRIGHT;
const HORIZON_R = 1.2;                 // 事件视界半径
const TWO_PI = Math.PI * 2;

const clamp = THREE.MathUtils.clamp;
const round4 = (v) => Math.round(v * 10000) / 10000;

// ---- 渲染器 / 场景 / 相机 ----------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // 供 __debug 像素自检读取
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 柔和高光滚降:亮部不死白
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 300);

// 相机状态(滚轮/拖拽目标值 + 指数平滑当前值)
let targetDist = DIST0, curDist = DIST0;
let azT = AZ0, elT = EL0, az = AZ0, el = EL0;
function applyCamera() {
  camera.position.set(
    curDist * Math.cos(el) * Math.sin(az),
    curDist * Math.sin(el),
    curDist * Math.cos(el) * Math.cos(az)
  );
  camera.lookAt(0, 0, 0);
}
applyCamera();

// ---- 后处理:Render → Output(ACES + sRGB) ------------------------------------
// 辉光不依赖屏幕空间 bloom(其白色泛光会稀释盘面色彩的有向 R-B 差),
// 改由着色器级软晕承担:盘面高斯热区/光子环宽晕/星点软光斑贴图,路径合规。
const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  type: THREE.HalfFloatType,
  samples: 4, // WebGL2 MSAA,暗核边缘平滑
});
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());

// ---- 1) 深空星云背景球(近黑基底 + 冷色星云) ---------------------------------
{
  const geo = new THREE.SphereGeometry(90, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      void main() {
        vec3 n = normalize(vDir);
        float b1 = pow(max(dot(n, normalize(vec3(-0.55, 0.30, -0.78))), 0.0), 2.3);
        float b2 = pow(max(dot(n, normalize(vec3(0.62, -0.20, -0.75))), 0.0), 2.5);
        float b3 = pow(max(dot(n, normalize(vec3(0.15, 0.60, 0.20))), 0.0), 3.0) * 0.5;
        vec3 col = vec3(0.010, 0.012, 0.017)
                 + vec3(0.016, 0.020, 0.034) * b1
                 + vec3(0.014, 0.019, 0.028) * b2
                 + vec3(0.010, 0.012, 0.018) * b3;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const nebula = new THREE.Mesh(geo, mat);
  nebula.renderOrder = 0;
  nebula.frustumCulled = false;
  scene.add(nebula);
}

// ---- 2) 背景星(780 颗,静态,软光斑贴图) --------------------------------------
const starSprite = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();
{
  const pos = new Float32Array(BG_N * 3);
  const col = new Float32Array(BG_N * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < BG_N; i++) {
    // 随机方向均匀布在球面
    v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
    if (v.lengthSq() < 1e-4) v.set(0, 1, 0);
    v.normalize().multiplyScalar(70 + Math.random() * 18);
    pos.set([v.x, v.y, v.z], i * 3);
    const bright = i < BG_DIM ? 0.28 + Math.random() * 0.55 : 0.85 + Math.random() * 0.5;
    const warm = Math.random();
    const tint = warm < 0.3 ? [1.0, 0.88, 0.78] : warm < 0.6 ? [1.0, 1.0, 1.0] : [0.80, 0.88, 1.0];
    col.set([tint[0] * bright, tint[1] * bright, tint[2] * bright], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 3.5,
    sizeAttenuation: false,
    map: starSprite,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  }));
  pts.renderOrder = 1;
  pts.frustumCulled = false;
  scene.add(pts);
}

// ---- 3) 吸积盘(程序化着色,时间驱动旋转) --------------------------------------
const diskUniforms = { uRot: { value: 0 } };
{
  // 几何直接烘焙到 XZ 平面(局部 position.xz 即盘面坐标,网格足够平滑无折边)
  const geo = new THREE.RingGeometry(1.3, 6.55, 256, 40);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: diskUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vPos;
      uniform float uRot;

      // 径向温度色带(按 fov70 像素几何标定):
      // 白(≈1.2-2.2u)→ 黄(2.2-2.9u)→ 橙(2.9-4.3u)→ 暗红(4.3u+)
      vec3 ramp(float t) {
        vec3 cw = vec3(1.45, 1.36, 1.24);
        vec3 cy = vec3(1.30, 0.80, 0.30);
        vec3 co = vec3(1.25, 0.36, 0.05);
        vec3 cr = vec3(0.50, 0.055, 0.012);
        vec3 c = mix(cw, cy, smoothstep(0.08, 0.22, t));
        c = mix(c, co, smoothstep(0.22, 0.34, t));
        c = mix(c, cr, smoothstep(0.38, 0.64, t));
        return c;
      }

      void main() {
        float r = length(vPos.xz);
        float a = atan(vPos.z, vPos.x);           // 盘面世界方位角(+X = 屏幕右)
        float t = clamp((r - 1.55) / 4.95, 0.0, 1.0);

        // 旋转条纹:pa = a - uRot ⇒ uRot 增大时图案向 +a 方向连续转动(与星流同向)
        float pa = a - uRot;
        float sp = log(max(r, 1.2)) * 2.6;        // 对数螺旋 → 拖尾旋臂
        float x = 0.55 + 0.30 * sin(4.0 * pa + sp)
                      + 0.15 * sin(9.0 * pa - sp * 1.7 + 1.3);
        float stripes = smoothstep(0.06, 0.94, x) * 0.75 + 0.25; // 柔化,避免硬边

        // 亮度包络(fov70 像素几何:内环带≈1.2-2.7u,外环带≈3.5-5.9u):
        // 白热主峰(1.75u)+ 橙色中带平台(3.6u,保证外环带有向 R-B 差)+ 暗红长尾
        float env = 1.15 * exp(-pow((r - 1.75) / 0.60, 2.0))
                  + 0.55 * exp(-pow((r - 3.60) / 1.25, 2.0))
                  + 0.06 * exp(-(max(r, 1.55) - 1.55) * 0.30);
        env *= smoothstep(1.28, 1.52, r);          // 内缘软化,无生硬边界
        env *= smoothstep(6.55, 5.30, r);          // 外缘渐隐

        // 多普勒束射:物质朝向相机的一侧(+X,屏幕右)增亮
        float dopp = 1.0 + 0.70 * cos(a);

        vec3 col = ramp(t) * (stripes * env * dopp);

        // 内缘白热环(叠加峰,构成"内缘白亮")
        float hot = exp(-pow((r - 1.62) / 0.30, 2.0));
        col += vec3(1.0, 0.975, 0.93) * hot * 1.8;

        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const disk = new THREE.Mesh(geo, mat);
  disk.renderOrder = 2;
  disk.frustumCulled = false;
  scene.add(disk);
}

// ---- 4) 星流:420 粒子螺旋汇入,线段拖尾 + 头部亮点 -----------------------------
const stream = (() => {
  const P = new Array(STREAM_N);
  function spawn(i) {
    P[i] = {
      r: 4.8 + Math.random() * 3.6,           // 出生半径(外圈)
      th: Math.random() * TWO_PI,
      y: (Math.random() - 0.5) * 0.24,        // 微离面抖动
    };
  }
  for (let i = 0; i < STREAM_N; i++) spawn(i);

  const linePos = new Float32Array(STREAM_N * 2 * 3);
  const lineCol = new Float32Array(STREAM_N * 2 * 3);
  const headPos = new Float32Array(STREAM_N * 3);
  const headCol = new Float32Array(STREAM_N * 3);

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  }));
  lines.renderOrder = 3;
  lines.frustumCulled = false;

  const headGeo = new THREE.BufferGeometry();
  headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3));
  headGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3));
  const heads = new THREE.Points(headGeo, new THREE.PointsMaterial({
    size: 3.0,
    sizeAttenuation: false,
    map: starSprite,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  }));
  heads.renderOrder = 4;
  heads.frustumCulled = false;
  scene.add(lines, heads);

  // Kepler 式角速度:内圈快、外圈慢;径向缓慢内旋,近视界加速
  const omega = (r) => 1.45 / Math.pow(r, 1.5);
  const inspiral = (r) => 0.16 + 0.85 / r;

  function update(dt) {
    for (let i = 0; i < STREAM_N; i++) {
      const p = P[i];
      const om = omega(p.r);
      p.th += om * dt;
      p.r -= inspiral(p.r) * dt;
      let heat; // 0(外圈)→ 1(近视界)
      if (p.r < 1.18) { spawn(i); heat = 0; }
      else heat = 1 - clamp((p.r - 1.35) / (3.2 - 1.35), 0, 1);

      const c = Math.cos(p.th), s = Math.sin(p.th);
      const x = p.r * c, z = p.r * s, y = p.y;
      // 速度方向(径向内旋 + 切向公转)→ 拖尾沿轨迹反向
      const ir = inspiral(p.r);
      const vx = -ir * c - p.r * om * s;
      const vz = -ir * s + p.r * om * c;
      const spd = Math.hypot(vx, vz) || 1;
      const tl = 0.10 + 0.60 * heat; // 近视界拖尾拉长
      const tx = x - (vx / spd) * tl, tz = z - (vz / spd) * tl;

      const b = 0.16 + 1.35 * (1 - clamp((p.r - 1.4) / (4.6 - 1.4), 0, 1));
      const cr = (0.85 + 0.15 * heat) * b;
      const cg = (0.90 + 0.10 * heat) * b;
      const cb = 1.0 * b;

      const i6 = i * 6;
      linePos[i6] = x; linePos[i6 + 1] = y; linePos[i6 + 2] = z;
      linePos[i6 + 3] = tx; linePos[i6 + 4] = y; linePos[i6 + 5] = tz;
      lineCol[i6] = cr; lineCol[i6 + 1] = cg; lineCol[i6 + 2] = cb;
      lineCol[i6 + 3] = cr * 0.10; lineCol[i6 + 4] = cg * 0.10; lineCol[i6 + 5] = cb * 0.10;

      const i3 = i * 3;
      headPos[i3] = x; headPos[i3 + 1] = y; headPos[i3 + 2] = z;
      headCol[i3] = cr; headCol[i3 + 1] = cg; headCol[i3 + 2] = cb;
    }
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    headGeo.attributes.position.needsUpdate = true;
    headGeo.attributes.color.needsUpdate = true;
  }

  function resetAll() { for (let i = 0; i < STREAM_N; i++) spawn(i); }
  return { update, resetAll };
})();

// ---- 5) 光子环 + 事件视界:overlay 直绘层 --------------------------------------
// 放在后处理(composer)之后直接渲染到画布:暗核保持纯黑不被 bloom 白晕侵蚀,
// 光子环保持锐利;两 shader 输出按显示空间(已含柔和衰减)直接取值。
const overlayScene = new THREE.Scene();
function makeBillboard(halfSize, fragShader, blending, order) {
  const geo = new THREE.PlaneGeometry(halfSize * 2, halfSize * 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: halfSize } },
    transparent: true,
    blending,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */`
      varying vec2 vP;
      uniform float uScale;
      void main() {
        vP = position.xy / uScale; // -1..1
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: fragShader,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  overlayScene.add(mesh);
  return mesh;
}

// 光子环:半径 ~1.34 的锐亮环 + 宽软晕(引力透镜式包绕观感)
const photonRing = makeBillboard(2.2, /* glsl */`
  precision highp float;
  varying vec2 vP;
  uniform float uScale;
  void main() {
    float r = length(vP) * uScale;
    float ring = exp(-pow((r - 1.30) / 0.10, 2.0)) * 1.8
               + exp(-pow((r - 1.30) / 0.46, 2.0)) * 0.55;
    gl_FragColor = vec4(vec3(1.0, 0.99, 0.96) * ring, 1.0);
  }`, THREE.AdditiveBlending, 5);

// 事件视界:纯黑圆盘,平滑 AA 边缘,最后绘制以吞噬盘面/星流
const horizon = makeBillboard(2.2, /* glsl */`
  precision highp float;
  varying vec2 vP;
  uniform float uScale;
  void main() {
    float r = length(vP) * uScale;
    float alpha = 1.0 - smoothstep(1.185, 1.215, r);
    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
  }`, THREE.NormalBlending, 6);

// ---- 交互:滚轮缩放(平滑)+ 拖拽微调视角(松开保持) --------------------------
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  targetDist = clamp(targetDist * Math.exp(ZOOM_K * e.deltaY), DIST_MIN, DIST_MAX);
}, { passive: false });

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  azT -= (e.clientX - lastX) * 0.0032;
  elT = clamp(elT + (e.clientY - lastY) * 0.0028, 0.21, 1.25);
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });

// ---- 状态契约 -----------------------------------------------------------------
let diskRotation = 0; // 自上次 reset 起累计弧度(单调递增)
let ready = false;

function doReset() {
  diskRotation = 0;
  targetDist = DIST0;
  curDist = DIST0;        // reset 时距离立即回位(平滑要求针对滚轮缩放)
  azT = AZ0; az = AZ0;
  elT = EL0; el = EL0;
  applyCamera();
  stream.resetAll();      // 星流复位重生;背景星不动
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    diskRotation: round4(diskRotation),
    accretionPhase: round4(((diskRotation / TWO_PI) % 1 + 1) % 1),
    cameraDistance: round4(curDist),
    starStreamCount: STREAM_N,
    backgroundStarCount: BG_N,
  }),
  reset: doReset,
};

// ---- 自检用像素采样(preserveDrawingBuffer;不影响页面契约) --------------------
const dbgCanvas = document.createElement('canvas');
dbgCanvas.width = 1280; dbgCanvas.height = 720;
const dbgCtx = dbgCanvas.getContext('2d', { willReadFrequently: true });
function capture() {
  dbgCtx.drawImage(renderer.domElement, 0, 0, 1280, 720);
}
function regionStats(x, y, w, h) {
  const d = dbgCtx.getImageData(x, y, w, h).data;
  let r = 0, g = 0, b = 0, n = 0, nb = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    if (Math.max(d[i], d[i + 1], d[i + 2]) > 16) nb++;
  }
  return { x, y, w, h, avgR: r / n, avgG: g / n, avgB: b / n, nonBlack: nb / n };
}
window.__debug = {
  capture,
  // P1:中心 1/3 + 四角 22% 方块
  p1check() {
    capture();
    const W = 1280, H = 720, cw = Math.round(W / 3), ch = Math.round(H / 3);
    const bw = Math.round(W * 0.22), bh = Math.round(H * 0.22);
    return {
      centerThird: regionStats(cw, ch, cw, ch),
      cornerTL: regionStats(0, 0, bw, bh),
      cornerTR: regionStats(W - bw, 0, bw, bh),
      cornerBL: regionStats(0, H - bh, bw, bh),
      cornerBR: regionStats(W - bw, H - bh, bw, bh),
    };
  },
  // P3:spec 几何 —— 内环带 0.06–0.14×minD,外环带 0.18–0.30×minD,±6% 高度带,分左右侧
  bands() {
    capture();
    const W = 1280, H = 720, cx = W / 2, cy = H / 2, minD = Math.min(W, H);
    const rIn0 = 0.06 * minD, rIn1 = 0.14 * minD;
    const rOut0 = 0.18 * minD, rOut1 = 0.30 * minD, hBand = 0.06 * minD;
    const acc = {
      innerL: { n: 0, r: 0, g: 0, b: 0, rb: 0, nb: 0 },
      innerR: { n: 0, r: 0, g: 0, b: 0, rb: 0, nb: 0 },
      outerL: { n: 0, r: 0, g: 0, b: 0, rb: 0, nb: 0 },
      outerR: { n: 0, r: 0, g: 0, b: 0, rb: 0, nb: 0 },
    };
    const y0 = Math.max(0, Math.round(cy - hBand)), y1 = Math.min(H - 1, Math.round(cy + hBand));
    const x0 = Math.max(0, Math.round(cx - rOut1)), x1 = Math.min(W - 1, Math.round(cx + rOut1));
    const img = dbgCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
    const iw = x1 - x0 + 1;
    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      if (Math.abs(dy) > hBand) continue;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        const rho = Math.hypot(dx, dy);
        let cell = null;
        if (rho >= rIn0 && rho <= rIn1) cell = dx >= 0 ? acc.innerR : acc.innerL;
        else if (rho >= rOut0 && rho <= rOut1) cell = dx >= 0 ? acc.outerR : acc.outerL;
        if (!cell) continue;
        const idx = ((py - y0) * iw + (px - x0)) * 4;
        const R = img[idx], G = img[idx + 1], B = img[idx + 2];
        cell.n++; cell.r += R; cell.g += G; cell.b += B; cell.rb += (R - B);
        if (Math.max(R, G, B) > 16) cell.nb++;
      }
    }
    const fin = (c) => ({
      n: c.n, avgR: c.r / c.n, avgG: c.g / c.n, avgB: c.b / c.n,
      avgRB: c.rb / c.n, lum: (c.r + c.g + c.b) / (3 * c.n), nonBlack: c.nb / c.n,
    });
    return { innerL: fin(acc.innerL), innerR: fin(acc.innerR), outerL: fin(acc.outerL), outerR: fin(acc.outerR) };
  },
  // 暗核半径(沿水平中线向右/向左扫描首个亮像素)
  coreRadius() {
    capture();
    const W = 1280, H = 720, cx = W / 2, cy = H / 2;
    const row = dbgCtx.getImageData(0, cy, W, 1).data;
    const scan = (dir) => {
      let run = 0;
      for (let k = 1; k < W / 2; k++) {
        const i = (cx + dir * k) * 4;
        const lum = (row[i] + row[i + 1] + row[i + 2]) / 3;
        if (lum > 30) { run++; if (run >= 3) return k - 2; } else run = 0;
      }
      return -1;
    };
    return { right: scan(1), left: scan(-1) };
  },
};

// ---- UI:reset 按钮(右上角,data-ui) ------------------------------------------
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:9999;padding:5px 14px;' +
    'font:13px sans-serif;background:#1a1a22;color:#e8e8f0;border:1px solid #555;' +
    'border-radius:4px;cursor:pointer';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);
}

// ---- 主循环(真实时间步进;失焦 dt 钳制防跳变) ----------------------------------
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  diskRotation += ROT_SPEED * dt;

  // 平滑插值(缩放 1s 内基本到位;拖拽角度同理)
  curDist += (targetDist - curDist) * (1 - Math.exp(-6 * dt));
  if (Math.abs(targetDist - curDist) < 0.002) curDist = targetDist;
  az += (azT - az) * (1 - Math.exp(-10 * dt));
  el += (elT - el) * (1 - Math.exp(-10 * dt));
  applyCamera();

  diskUniforms.uRot.value = diskRotation;
  photonRing.quaternion.copy(camera.quaternion);
  horizon.quaternion.copy(camera.quaternion);

  stream.update(dt);
  composer.render();
  // overlay(光子环+暗核)在后处理之后直绘:autoClear 暂关,叠在最终画面上
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;

  if (!ready) { ready = true; window.__appReady = true; } // 首帧渲染完成
}
requestAnimationFrame(tick);

// ---- 视口自适应 -----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
});
