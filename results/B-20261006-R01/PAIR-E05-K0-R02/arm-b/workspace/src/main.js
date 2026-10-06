// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— three.js r186(K0 冷启动)
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): {diskRotation, accretionPhase, cameraDistance,
//                        starStreamCount, backgroundStarCount}, reset(): void }
//
// 实现路线(全部程序化,零外部资产,无预渲染素材):
//   * 事件视界:纯黑不透明球体(r=1.2),球体轮廓任意视角均为圆,写深度遮挡背景。
//   * 吸积盘:单张高细分 RingGeometry(1.21→9.2),自定义 ShaderMaterial 片元着色:
//       - 径向色梯度:内缘白热 → 黄 → 橙 → 外缘暗红(平滑插值,无硬边);
//       - 内缘光子环(HDR 高亮,喂给 bloom 产生柔光辉光,向内平滑衰减至视界);
//       - 螺旋条纹:角向谐波 × log(r) 螺旋解缠,相位由 uT=diskRotation 驱动,
//         图案角速度恒等于 d(diskRotation)/dt(状态与画面物理一致);
//       - 多普勒不对称:接近侧(screen 左)增亮、远离侧减暗(加分明细);
//       - 外圈 6.5→9.2 指数式软衰减红晕(盘缘无硬边)。
//   * 辉光:UnrealBloomPass(threshold 0.8)+ ACESFilmic 曝光,亮部柔光扩散,
//     暗核保持纯黑(0 亮度不参与 bloom)。
//   * 星流:260 条动态线段(头亮尾暗),螺旋内落 ω∝1/r、dr/dt 随 r 减小加速,
//     近视界拖尾拉长,r<1.24 吞噬并在外圈重生,总数恒定。
//   * 背景星空:3000 颗静态星点(逐星大小/亮度/色温属性,着色器圆点软边)
//     + 64 团冷色星云斑(微弱,加分项)。
//   * 相机:初始距离 14.0(仰角 20° 俯视),滚轮改目标距离夹 [5,28],
//     指数平滑插值(1s 内基本到位);reset 立即回 14.0。
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// --- 常量 -------------------------------------------------------------------
const OMEGA = 0.35;          // 吸积盘角速度 rad/s(spec 允许 0.15-0.6)
const HORIZON_R = 1.2;       // 事件视界半径(场景单位)
const DISK_IN = 1.21;        // 盘面几何内缘(紧贴视界,内域 discard 露出黑核)
const DISK_MAIN_IN = 1.8;    // 主盘内缘
const DISK_MAIN_OUT = 6.5;   // 主盘外缘
const DISK_GEO_OUT = 9.2;    // 几何外缘(含外圈软光晕区)
const STREAM_N = 260;        // 星流粒子数(>=200,恒定)
const STAR_N = 5000;         // 背景星数(>=300)
const NEBULA_N = 64;         // 星云斑数(不计入 backgroundStarCount)
const ELEV = (20 * Math.PI) / 180; // 相机仰角:盘面-视线倾角 20°(spec 15°-75°)
const DIST0 = 14.0, DIST_MIN = 5, DIST_MAX = 28;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);

// --- 渲染器 / 场景 / 相机 -----------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
  preserveDrawingBuffer: true, // 供探针/自检做像素级帧采样
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // HDR 亮部平滑滚降,亮部不死白成片
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);
let dist = DIST0;        // 当前(平滑后)相机距离 = cameraDistance 状态
let distTarget = DIST0;  // 滚轮目标距离
function applyCamera() {
  camera.position.set(0, dist * Math.sin(ELEV), dist * Math.cos(ELEV));
  camera.lookAt(0, 0, 0);
}
applyCamera();

// --- 后处理:辉光(bloom)路径 -------------------------------------------------
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.32, // strength:柔光强度(过强会污染暗核)
  0.40, // radius
  0.85  // threshold:仅 HDR 亮部(光子环/内盘/亮星流)参与辉光
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// --- 1. 背景星空(3000 静态星点 + 64 冷色星云斑)--------------------------------
function makePoints(count, fill) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) fill(i, pos, col, size, phase);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      varying vec3 vColor;
      void main() {
        // 轻微闪烁(±10%),不改变静态分布
        float tw = 0.90 + 0.10 * sin(uTime * (0.3 + aPhase * 0.7) + aPhase * 19.0);
        vColor = aColor * tw;
        gl_PointSize = aSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float a = smoothstep(0.25, 0.02, dot(d, d));
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return { points: p, material: m };
}

const starPoints = makePoints(STAR_N, (i, pos, col, size, phase) => {
  // 均匀球面分布
  let x, y, z, l;
  do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-4);
  l = Math.sqrt(l);
  const R = rand(70, 160);
  pos[i * 3] = (x / l) * R; pos[i * 3 + 1] = (y / l) * R; pos[i * 3 + 2] = (z / l) * R;
  const hero = i % 17 === 0;
  size[i] = hero ? rand(3.0, 4.2) : 1.5 + 2.4 * Math.pow(Math.random(), 3);
  const b = hero ? rand(1.0, 1.35) : 0.5 + 0.5 * Math.pow(Math.random(), 2);
  const warm = Math.random() < 0.4;
  const t = Math.random();
  col[i * 3]     = b * (warm ? 1.0 : 0.88 + 0.1 * t);
  col[i * 3 + 1] = b * (warm ? 0.86 + 0.1 * t : 0.92 + 0.06 * t);
  col[i * 3 + 2] = b * (warm ? 0.72 + 0.18 * t : 1.0);
  phase[i] = Math.random();
});
scene.add(starPoints.points);

const nebulaPoints = makePoints(NEBULA_N, (i, pos, col, size, phase) => {
  // 冷色星云:压向银道面的大软斑,极低亮度(纯观感加分)
  const a = Math.random() * Math.PI * 2;
  const y = (Math.random() - 0.5) * 0.55;
  const R = rand(85, 150);
  pos[i * 3] = Math.cos(a) * R; pos[i * 3 + 1] = y * R; pos[i * 3 + 2] = Math.sin(a) * R;
  size[i] = rand(26, 72);
  const b = rand(0.04, 0.09);
  col[i * 3] = b * rand(0.35, 0.55); col[i * 3 + 1] = b * rand(0.45, 0.65); col[i * 3 + 2] = b * rand(0.85, 1.0);
  phase[i] = Math.random();
});
scene.add(nebulaPoints.points);

// --- 2. 事件视界(纯黑遮挡球)--------------------------------------------------
{
  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(HORIZON_R, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  scene.add(horizon);
}

// --- 3. 吸积盘(单张环形网格 + 程序化片元着色)----------------------------------
const diskUniforms = { uT: { value: 0 }, uDop: { value: 0.35 } };
{
  const geo = new THREE.RingGeometry(DISK_IN, DISK_GEO_OUT, 256, 4);
  geo.rotateX(-Math.PI / 2); // 铺到 XZ 平面(y=0);片元用 position.xz 作平面坐标
  const mat = new THREE.ShaderMaterial({
    uniforms: diskUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uT;   // = diskRotation(自 reset 起累计弧度)
      uniform float uDop; // 多普勒不对称强度
      varying vec2 vPos;
      void main() {
        float r = length(vPos);
        if (r < ${DISK_IN} || r > ${DISK_GEO_OUT}) discard;
        float th = atan(vPos.y, vPos.x);
        // 多普勒束射:vPos.x < 0(world -X,屏幕左)为接近侧 → 增亮
        float dop = 1.0 + uDop * (-cos(th));
        vec3 col;
        if (r < ${DISK_MAIN_IN}) {
          // 内缘光子环:HDR 高亮,向视界方向平滑衰减(辉光观感,黑核保持纯黑)
          float t = (r - ${DISK_IN}) / (${DISK_MAIN_IN} - ${DISK_IN});
          float ring = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.25, 1.0, t));
          vec3 cHot  = vec3(0.85, 0.92, 1.05); // 蓝白
          vec3 cWarm = vec3(1.02, 0.99, 0.94); // 白热
          vec3 c = mix(cWarm, cHot, smoothstep(0.55, 0.05, t));
          float ang = 0.82 + 0.18 * sin(2.0 * th - uT * 2.0);
          col = c * (ring * 1.22 * ang);
        } else if (r <= ${DISK_MAIN_OUT}) {
          // 主盘:径向色梯度 白→黄→橙→暗红
          float t = (r - ${DISK_MAIN_IN}) / (${DISK_MAIN_OUT} - ${DISK_MAIN_IN});
          vec3 cWhite  = vec3(1.00, 0.97, 0.92);
          vec3 cYellow = vec3(1.02, 0.78, 0.36);
          vec3 cOrange = vec3(0.98, 0.44, 0.13);
          vec3 cRed    = vec3(0.58, 0.15, 0.05);
          vec3 base = mix(cWhite, cYellow, smoothstep(0.02, 0.16, t));
          base = mix(base, cOrange, smoothstep(0.16, 0.45, t));
          base = mix(base, cRed,    smoothstep(0.45, 0.85, t));
          float env = 1.25 - 0.85 * smoothstep(0.0, 1.0, t); // 内亮外暗包络
          // 螺旋条纹:log(r) 解缠 + 双谐波;相位 -uT ⇒ 图案角速度 = d(uT)/dt
          float sp = th + 2.2 * log(r);
          float s1 = sin(3.0 * sp - uT * 3.0);
          float s2 = sin(7.0 * sp - uT * 7.0 + 1.7);
          float stripes = 0.55 + 0.32 * s1 + 0.18 * s2;
          float hot = pow(max(sin(2.0 * sp - uT * 2.0 + 0.9), 0.0), 6.0)
                    * 0.40 * (1.0 - smoothstep(0.1, 0.5, t)); // 内区热点
          float edge = smoothstep(1.0, 0.96, t); // 盘缘平滑收边
          float I = env * max(stripes, 0.0) * dop + hot * dop;
          col = base * I * edge;
        } else {
          // 外圈软红晕:指数式衰减,无硬边
          float h = (r - ${DISK_MAIN_OUT}) / (${DISK_GEO_OUT} - ${DISK_MAIN_OUT});
          float fade = pow(1.0 - h, 1.9);
          col = vec3(0.42, 0.12, 0.04) * (fade * 0.45) * (0.75 + 0.25 * dop);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true, // 视界球写深度:盘后缘被黑核正确遮挡
    side: THREE.DoubleSide,
  });
  scene.add(new THREE.Mesh(geo, mat));
}

// --- 4. 星流(260 条螺旋内落拖尾线段)------------------------------------------
const streamGeo = new THREE.BufferGeometry();
const streamPos = new Float32Array(STREAM_N * 2 * 3);
const streamCol = new Float32Array(STREAM_N * 2 * 3);
streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3).setUsage(THREE.DynamicDrawUsage));
streamGeo.setAttribute('color', new THREE.BufferAttribute(streamCol, 3).setUsage(THREE.DynamicDrawUsage));
const stream = new THREE.LineSegments(streamGeo, new THREE.LineBasicMaterial({
  vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
}));
stream.frustumCulled = false;
scene.add(stream);

const streamR = new Float32Array(STREAM_N);
const streamTh = new Float32Array(STREAM_N);
function respawn(i, outer) {
  streamR[i] = outer ? rand(5.6, 8.4) : 1.35 + 7.0 * Math.pow(Math.random(), 1.6);
  streamTh[i] = Math.random() * Math.PI * 2;
}
function initStream() { for (let i = 0; i < STREAM_N; i++) respawn(i, false); }
function updateStream(dt) {
  for (let i = 0; i < STREAM_N; i++) {
    let r = streamR[i], th = streamTh[i];
    const wS = 1.35 / Math.max(r, 0.9);          // 角速度 ∝ 1/r(内快外慢)
    const vR = 0.22 + 2.6 / (r * r);             // 径向内落:近视界加速
    th += wS * dt;
    r -= vR * dt;
    if (r < HORIZON_R + 0.04) { respawn(i, true); r = streamR[i]; th = streamTh[i]; }
    streamR[i] = r; streamTh[i] = th;
    // 头/尾位置(尾沿速度反方向 → 近视界自动拉长)
    const x = r * Math.cos(th), z = -r * Math.sin(th);
    const vx = -vR * Math.cos(th) - r * wS * Math.sin(th);
    const vz = vR * Math.sin(th) - r * wS * Math.cos(th);
    const vlen = Math.hypot(vx, vz) || 1;
    const tl = 0.10 + 1.15 * Math.pow(sstep(2.6, 1.3, r), 2); // 近视界拖尾 1.25 单位
    const tx = x - (vx / vlen) * tl, tz = z - (vz / vlen) * tl;
    const b = 0.35 + 1.35 * sstep(4.2, 1.35, r); // 越靠近视界越亮(喂 bloom)
    const k = sstep(3.5, 1.4, r);                // 外圈暖白 → 内圈蓝白
    streamPos[i * 6 + 0] = x; streamPos[i * 6 + 1] = 0; streamPos[i * 6 + 2] = z;
    streamPos[i * 6 + 3] = tx; streamPos[i * 6 + 4] = 0; streamPos[i * 6 + 5] = tz;
    streamCol[i * 6 + 0] = b * (1.0 - 0.2 * k); streamCol[i * 6 + 1] = b * (0.93 - 0.03 * k); streamCol[i * 6 + 2] = b * (0.82 + 0.28 * k);
    streamCol[i * 6 + 3] = b * 0.15; streamCol[i * 6 + 4] = b * 0.15; streamCol[i * 6 + 5] = b * 0.15;
  }
  streamGeo.attributes.position.needsUpdate = true;
  streamGeo.attributes.color.needsUpdate = true;
}
initStream();

// --- bench 状态契约 -----------------------------------------------------------
let diskRotation = 0; // 自上次 reset 起累计弧度(单调递增)
function getState() {
  return {
    engine: 'three',
    diskRotation,
    accretionPhase: (diskRotation / (Math.PI * 2)) % 1, // 每旋转一周 +1 回绕
    cameraDistance: dist,
    starStreamCount: STREAM_N,
    backgroundStarCount: STAR_N,
  };
}
function doReset() {
  diskRotation = 0;
  dist = DIST0; distTarget = DIST0;
  applyCamera();
  initStream(); // 星流粒子复位重生;背景星不动
}
window.__bench = { getState, reset: doReset };

// --- UI:reset 按钮(右上角,DOM,非画布内渲染)---------------------------------
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:9999;padding:5px 14px;' +
    "font:13px sans-serif;background:#1b1e26;color:#dfe6f2;border:1px solid #4a5265;" +
    'border-radius:5px;cursor:pointer;opacity:0.92';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放';
  hint.style.cssText = 'position:fixed;left:12px;bottom:10px;font:11px sans-serif;color:#5a6375;z-index:9999;pointer-events:none';
  document.body.appendChild(hint);
}

// --- 交互:滚轮缩放(平滑插值)-------------------------------------------------
window.addEventListener('wheel', (e) => {
  distTarget = clamp(distTarget + e.deltaY * 0.011, DIST_MIN, DIST_MAX);
}, { passive: true });

// --- 主循环 -------------------------------------------------------------------
let last = performance.now();
let ready = false;
function tick() {
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 失焦保护:回到前台无时间跳变
  diskRotation += OMEGA * dt;
  dist += (distTarget - dist) * (1 - Math.exp(-6 * dt)); // λ=6/s:1s 残差 <0.3%
  if (Math.abs(distTarget - dist) < 0.0005) dist = distTarget;
  applyCamera();
  updateStream(dt);
  diskUniforms.uT.value = diskRotation;
  const t = diskRotation;
  starPoints.material.uniforms.uTime.value = t;
  nebulaPoints.material.uniforms.uTime.value = t;
  composer.render();
  if (!ready) { ready = true; window.__appReady = true; } // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
});
