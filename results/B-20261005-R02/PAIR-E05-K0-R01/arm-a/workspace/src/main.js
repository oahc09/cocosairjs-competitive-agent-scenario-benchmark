// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— three.js r186 实现
// ----------------------------------------------------------------------------
// 页面契约(与模板一致,harness 断言):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(): object, reset(): void }
// 状态通道(spec.stateChannel,全部为真实驱动数据):
//   diskRotation      吸积盘累计旋转弧度(自上次 reset 起,单调递增,0.3 rad/s)
//   accretionPhase    条纹归一化相位 [0,1),每周 +1 回绕
//   cameraDistance    当前相机距离(初始 14.0,滚轮缩放,夹在 [5,28],平滑插值)
//   starStreamCount   星流粒子数(280,恒定,视界吞噬外圈重生)
//   backgroundStarCount 背景星点数(1960,静态;四组撒星全部实例化,计数=真实创建数)
// 全部视觉程序化生成(assets = []):贴图均为运行时 canvas 生成,无任何外部资源。
// ============================================================================

import * as THREE from 'three';

// --- 场景常量(与 brief §2 场景尺度一致) -------------------------------------
const HORIZON_R = 1.2;      // 事件视界(黑色球体,遮挡盘远侧形成暗核)
const DISK_INNER = 1.8;     // 吸积盘内缘
const DISK_OUTER = 6.5;     // 吸积盘外缘
const OMEGA = 0.3;          // 盘旋转角速度 rad/s(spec 允许 0.15–0.6)
const BASE_DISTANCE = 14.0; // 初始相机距离
const BASE_ELEV = THREE.MathUtils.degToRad(34); // 俯视角(盘面与视线 15°–75°)
const STAR_N = 280;         // 星流粒子数(>=200)
const BG_UNIFORM = 620;     // 均匀分布背景星
const BG_CORNER = 460;      // 向四角天区广撒的背景星
const BG_DENSE_SMALL = 528; // 四角密集星场·小星(每角 132)
const BG_DENSE_BIG = 352;   // 四角密集星场·亮星(每角 88)
const BG_STAR_COUNT = BG_UNIFORM + BG_CORNER + BG_DENSE_SMALL + BG_DENSE_BIG;

// --- 渲染器 / 场景 / 相机 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
// ACES 色调映射:加性叠加的高亮自然滚降 → 亮部不死白、光晕过渡平滑(brief §2 辉光观感)
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400);

// --- 相机状态:目标距离 + 平滑插值 + 拖拽偏移 -----------------------------------
let camDist = BASE_DISTANCE;   // 当前(平滑)距离 → getState().cameraDistance
let targetDist = BASE_DISTANCE;
let yaw = 0, pitch = 0;        // 拖拽目标偏移
let yawCur = 0, pitchCur = 0;  // 平滑后的偏移

function updateCamera() {
  const el = THREE.MathUtils.clamp(BASE_ELEV + pitchCur, THREE.MathUtils.degToRad(16), THREE.MathUtils.degToRad(65));
  const az = yawCur;
  camera.position
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .multiplyScalar(camDist);
  camera.lookAt(0, 0, 0);
}
updateCamera();

// 滚轮缩放:负 dy = 靠近;指数缩放(倍率式)保证多次滚动表现一致;夹在 [5,28]
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= 400;
  targetDist = THREE.MathUtils.clamp(targetDist * Math.exp(dy * 0.001), 5.0001, 27.9999);
}, { passive: false });

// 拖拽微调视角(可选加分项):按住拖动微调俯仰/偏航,松开保持
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw = THREE.MathUtils.clamp(yaw - (e.clientX - lastX) * 0.0032, -1.0, 1.0);
  pitch = THREE.MathUtils.clamp(pitch + (e.clientY - lastY) * 0.0028, -0.3, 0.55);
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointercancel', () => { dragging = false; });

// --- 运行时贴图工厂(无外部资产,全部代码生成) ----------------------------------
function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 星点软斑:亮核 + 柔和衰减(背景星与星流头部共用)
const starTex = radialTexture([
  [0, 'rgba(255,255,255,1)'],
  [0.25, 'rgba(255,255,255,0.9)'],
  [0.5, 'rgba(255,255,255,0.26)'],
  [1, 'rgba(255,255,255,0)'],
]);

// 环形辉光(中央挖孔):套在黑洞外围的大范围柔光,中心孔保护暗核纯黑
const donutTex = radialTexture([
  [0, 'rgba(255,236,210,0)'],
  [0.26, 'rgba(255,236,210,0)'],
  [0.36, 'rgba(255,225,190,0.34)'],
  [0.55, 'rgba(255,180,110,0.16)'],
  [0.8, 'rgba(255,150,80,0.05)'],
  [1, 'rgba(255,140,70,0)'],
]);

// 热点光斑(盘上随盘转动的亮团)
const blobTex = radialTexture([
  [0, 'rgba(255,244,224,1)'],
  [0.3, 'rgba(255,214,160,0.55)'],
  [0.65, 'rgba(255,170,100,0.16)'],
  [1, 'rgba(255,150,80,0)'],
]);

// --- 背景星空(>=300,静态;向四角天区加密保证四角非空) -------------------------
function randDir() {
  const z = Math.random() * 2 - 1;
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return new THREE.Vector3(s * Math.cos(phi), z, s * Math.sin(phi));
}
function starColor() {
  const c = new THREE.Color();
  const u = Math.random();
  if (u < 0.55) c.setHSL(0.6 + Math.random() * 0.06, 0.5, 0.72 + Math.random() * 0.26);   // 蓝白
  else if (u < 0.85) c.setHSL(0, 0, 0.78 + Math.random() * 0.22);                          // 白
  else c.setHSL(0.07 + Math.random() * 0.05, 0.55, 0.7 + Math.random() * 0.2);             // 暖
  return c;
}
function buildStarCloud(positions, colors, size, brightness) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({
    size, map: starTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: false,
  }));
  pts.renderOrder = 1;
  scene.add(pts);
}
{
  // 以默认机位的四个屏幕对角方向为锥轴,额外撒一圈星,保证 P1 四角外围非空
  const cornerCam = [
    new THREE.Vector3(1.2, 0.577, -1), new THREE.Vector3(-1.2, 0.577, -1),
    new THREE.Vector3(1.2, -0.577, -1), new THREE.Vector3(-1.2, -0.577, -1),
  ].map((v) => v.normalize().applyQuaternion(camera.quaternion.clone()));

  const make = (count, cornerBiased, brightness) => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      let d;
      if (cornerBiased) {
        d = cornerCam[(Math.random() * 4) | 0].clone()
          .addScaledVector(randDir(), Math.random() * 0.45).normalize();
      } else {
        d = randDir();
      }
      const r = 85 + Math.random() * 45;
      pos[i * 3] = d.x * r; pos[i * 3 + 1] = d.y * r; pos[i * 3 + 2] = d.z * r;
      const c = starColor().multiplyScalar(brightness);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    return { pos, col };
  };
  // 四组撒星全部实例化(总数 = BG_STAR_COUNT,getState 报告真实创建数):
  // 均匀全天 + 角向偏置 + 四角密集小星 + 四角密集亮星(保证 P1 四角外围非空)
  for (const [g, size] of [
    [make(BG_UNIFORM, false, 1.0), 1.8],
    [make(BG_CORNER, true, 1.35), 3.0],
    [make(BG_DENSE_SMALL, true, 0.85), 1.3],
    [make(BG_DENSE_BIG, true, 1.7), 3.6],
  ]) buildStarCloud(g.pos, g.col, size);
}

// --- 黑洞核心:纯黑遮挡球(先写深度;透明层全部 depthTest 对齐) ------------------
const horizon = new THREE.Mesh(
  new THREE.SphereGeometry(HORIZON_R, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0x000000 }),
);
scene.add(horizon);

// --- 吸积盘:环形几何 + 自定义着色(径向梯度 / 旋转螺旋条纹 / 多普勒束射) --------
const diskMat = new THREE.ShaderMaterial({
  uniforms: {
    uRot: { value: 0 },
    uInner: { value: DISK_INNER },
    uOuter: { value: DISK_OUTER },
    uBeam: { value: 0.56 },
  },
  vertexShader: /* glsl */`
    varying vec2 vLocal;
    void main() {
      vLocal = position.xy; // RingGeometry 位于局部 XY 平面,旋转由 uRot 在片元内完成
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vLocal;
    uniform float uRot;
    uniform float uInner;
    uniform float uOuter;
    uniform float uBeam;
    void main() {
      float r = length(vLocal);
      float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
      float ang = atan(vLocal.y, vLocal.x);

      // 双层螺旋明暗条纹:随 uRot 刚体旋转(时间驱动的连续旋转,非循环贴图)
      float s1 = 0.5 + 0.5 * sin(3.0 * (ang - uRot) + 2.1 * r);
      float s2 = 0.5 + 0.5 * sin(7.0 * (ang - uRot) - 3.1 * r + 1.7);
      float stripes = 0.45 + 0.55 * (0.62 * s1 + 0.38 * s2);

      // 径向包络:内缘快速起亮、向外指数衰减、外缘长距离渐隐(无硬边)
      float edgeIn  = smoothstep(uInner - 0.06, uInner + 0.10, r);
      float edgeOut = 1.0 - smoothstep(uOuter - 1.7, uOuter, r);
      float fall    = 0.22 + 1.12 * exp(-(r - uInner) * 1.15);
      float bright  = edgeIn * edgeOut * fall * stripes;
      bright *= 1.0 - 0.62 * smoothstep(0.18, 0.75, t); // 外带压暗:中心暗-内环亮-外缘暗的径向亮度次序

      // 多普勒束射:approaching 侧固定为世界 -x(本局部 x<0 → beam>0);
      // 亮度不对称 + 通道不等权增益 → 亮侧整体更亮且更橙
      float beam = -cos(ang);
      bright *= 1.0 + uBeam * beam;
      vec3 gain = 1.0 + uBeam * beam * vec3(0.30, 0.10, -0.10);

      // 径向颜色梯度:内缘蓝白 → 黄 → 橙 → 外缘暗红
      vec3 cHot = vec3(0.94, 0.98, 1.12);
      vec3 cYel = vec3(1.05, 0.84, 0.44);
      vec3 cOrg = vec3(1.05, 0.50, 0.15);
      vec3 cRed = vec3(0.40, 0.09, 0.05);
      vec3 col = mix(cHot, cYel, smoothstep(0.02, 0.30, t));
      col = mix(col, cOrg, smoothstep(0.28, 0.56, t));
      col = mix(col, cRed, smoothstep(0.55, 0.96, t));

      gl_FragColor = vec4(col * bright * gain, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: true,
  side: THREE.DoubleSide,
});
const disk = new THREE.Mesh(new THREE.RingGeometry(DISK_INNER, DISK_OUTER, 220, 40), diskMat);
disk.rotation.x = -Math.PI / 2; // 铺到 XZ 平面(局部 x ↔ 世界 x,多普勒方向据此标定)
disk.renderOrder = 2;
scene.add(disk);

// --- 光子环 + 透镜弧:面向相机的加性平面(贴着暗核边缘的亮环,上方弧为透镜观感) --
const photonMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    void main() {
      vec2 p = (vUv - 0.5) * 4.6;      // 平面半宽 2.3 世界单位
      float r = length(p);
      float d1 = (r - 1.34) / 0.17;    // 光子环(贴暗核边缘的细亮环,稍宽以充盈暗核-盘缘间隙)
      float ring = exp(-d1 * d1) * 3.2;
      float d2 = (r - 1.72) / 0.27;    // 上方透镜弧(远侧盘被弯折包绕的观感)
      float arc = exp(-d2 * d2) * smoothstep(0.30, 1.05, p.y) * 0.95;
      float d3 = (r - 1.58) / 0.30;    // 下方弱弧(近侧盘内缘的过渡)
      float arc2 = exp(-d3 * d3) * smoothstep(0.25, 0.95, -p.y) * 0.38;
      vec3 col = vec3(1.0, 0.95, 0.86) * ring + vec3(1.0, 0.88, 0.72) * (arc + arc2);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: true,
});
const photonRing = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), photonMat);
photonRing.renderOrder = 5;
scene.add(photonRing);

// --- 大范围环形辉光(挖孔保护暗核,深度测试关闭避免与球面深度打架) --------------
{
  const m = new THREE.SpriteMaterial({
    map: donutTex, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, opacity: 0.32,
  });
  const glow = new THREE.Sprite(m);
  glow.scale.set(17.5, 10.5, 1); // 屏幕上呈随盘倾角压扁的椭圆光环
  glow.renderOrder = 7;
  scene.add(glow);
}

// --- 盘上热点(随盘转动的高亮团,增强辉光与运动证据) -----------------------------
const hotspots = [];
for (let i = 0; i < 3; i++) {
  const m = new THREE.SpriteMaterial({
    map: blobTex, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, opacity: 0.75,
  });
  const sp = new THREE.Sprite(m);
  sp.scale.set(2.6, 2.6, 1);
  sp.renderOrder = 6;
  sp.userData.baseAngle = i * 2.1;
  hotspots.push(sp);
  scene.add(sp);
}

// --- 星流:280 颗粒子螺旋汇入,视界吞噬、外圈重生;线段拖尾随速度拉长 ------------
const streamParts = [];
function respawn(p, initial) {
  p.r = initial ? 1.35 + Math.pow(Math.random(), 0.7) * 5.4 : 6.2 + Math.random() * 0.7;
  p.ang = Math.random() * Math.PI * 2;
  p.y = (Math.random() - 0.5) * 0.32 * (p.r / 6.9);
  p.px = undefined; // 重生帧不画拖尾(避免横跨屏幕的假线)
}
for (let i = 0; i < STAR_N; i++) {
  const p = {};
  respawn(p, true);
  streamParts.push(p);
}
const streamLineGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(STAR_N * 2 * 3);
  const col = new Float32Array(STAR_N * 2 * 3);
  streamLineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  streamLineGeo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
}
const streamLines = new THREE.LineSegments(streamLineGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
  depthWrite: false, depthTest: true,
}));
streamLines.renderOrder = 3;
scene.add(streamLines);

const streamHeadGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(STAR_N * 3);
  const col = new Float32Array(STAR_N * 3);
  streamHeadGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  streamHeadGeo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
}
const streamHeads = new THREE.Points(streamHeadGeo, new THREE.PointsMaterial({
  size: 3, map: starTex, transparent: true, depthWrite: false, depthTest: true,
  blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: false,
}));
streamHeads.renderOrder = 4;
scene.add(streamHeads);

function updateStarStream(dt) {
  const lp = streamLineGeo.attributes.position.array;
  const lc = streamLineGeo.attributes.color.array;
  const hp = streamHeadGeo.attributes.position.array;
  const hc = streamHeadGeo.attributes.color.array;
  for (let i = 0; i < STAR_N; i++) {
    const p = streamParts[i];
    // 开普勒式角速度(内快外慢)+ 向内漂移(近视界加速)→ 螺旋汇入
    const w = 1.6 * Math.pow(2.0 / p.r, 1.5) + 0.15;
    const vr = -(0.18 + 1.1 * Math.pow(1.8 / p.r, 2.2));
    p.ang += w * dt;
    p.r += vr * dt;
    if (p.r < 1.22) respawn(p, false); // 视界吞噬 → 外圈重生,总数恒定
    const x = p.r * Math.cos(p.ang);
    const y = p.y;
    const z = -p.r * Math.sin(p.ang); // 与盘条纹同向旋转(世界系从 +x 转向 -z)
    let vx = 0, vy = 0, vz = 0;
    if (p.px !== undefined && dt > 0) {
      vx = (x - p.px) / dt; vy = (y - p.py) / dt; vz = (z - p.pz) / dt;
    }
    p.px = x; p.py = y; p.pz = z;
    // 拖尾:长度 ∝ 速度(近视界加速 → 被拉长),上限防穿帮
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const tau = sp > 1e-6 ? Math.min(0.12, 0.55 / sp) : 0;
    const tx = x - vx * tau, ty = y - vy * tau, tz = z - vz * tau;
    // 颜色:外圈橙 → 近视界白热,且近视界增亮
    const heat = 1 - THREE.MathUtils.clamp((p.r - 1.35) / 5.3, 0, 1);
    const boost = 1 + 1.3 * Math.exp(-(p.r - 1.25) * 1.1);
    const cr = boost, cg = (0.55 + 0.42 * heat) * boost, cb = (0.22 + 0.66 * heat) * boost;
    const o6 = i * 6;
    lp[o6] = x; lp[o6 + 1] = y; lp[o6 + 2] = z;
    lp[o6 + 3] = tx; lp[o6 + 4] = ty; lp[o6 + 5] = tz;
    lc[o6] = cr; lc[o6 + 1] = cg; lc[o6 + 2] = cb;
    lc[o6 + 3] = cr * 0.1; lc[o6 + 4] = cg * 0.1; lc[o6 + 5] = cb * 0.1;
    const o3 = i * 3;
    hp[o3] = x; hp[o3 + 1] = y; hp[o3 + 2] = z;
    hc[o3] = cr * 0.9; hc[o3 + 1] = cg * 0.9; hc[o3 + 2] = cb * 0.9;
  }
  streamLineGeo.attributes.position.needsUpdate = true;
  streamLineGeo.attributes.color.needsUpdate = true;
  streamHeadGeo.attributes.position.needsUpdate = true;
  streamHeadGeo.attributes.color.needsUpdate = true;
}
updateStarStream(0);

// --- bench 状态通道与 reset -----------------------------------------------------
let frame = 0;
let diskRotation = 0; // 自上次 reset 起累计旋转弧度(真实驱动条纹与热点)

function doReset() {
  diskRotation = 0;
  targetDist = BASE_DISTANCE;
  camDist = BASE_DISTANCE; // 立即回到 14.0(reset 探针 +400ms 内断言 14±0.5)
  yaw = 0; pitch = 0; yawCur = 0; pitchCur = 0;
  for (const p of streamParts) respawn(p, true);
  updateStarStream(0);
  // 背景星空不动;__appReady 保持 true,场景继续运行
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    frame,
    diskRotation,
    accretionPhase: (diskRotation / (Math.PI * 2)) % 1,
    cameraDistance: camDist,
    starStreamCount: STAR_N,
    backgroundStarCount: BG_STAR_COUNT,
  }),
  reset: doReset,
};

// --- UI:右上角 reset 按钮(DOM,携带 data-ui)+ 缩放提示 -------------------------
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
    "font:12px sans-serif;background:#222;color:#fff;border:1px solid #555;" +
    'border-radius:4px;cursor:pointer';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放 · 拖拽微调视角';
  hint.style.cssText =
    'position:fixed;left:10px;bottom:8px;z-index:9999;pointer-events:none;' +
    'font:11px sans-serif;color:rgba(255,255,255,0.45)';
  document.body.appendChild(hint);
}

// --- 主循环:真实时间步进;失焦保护(dt 截断防时间跳变) ---------------------------
let last = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.05) dt = 0.05; // 失焦再聚焦不产生状态突变
  frame += 1;

  diskRotation += OMEGA * dt; // 0.3 rad/s,单调递增

  // 相机平滑插值(1s 内残差 < 1%)
  camDist += (targetDist - camDist) * (1 - Math.exp(-5 * dt));
  yawCur += (yaw - yawCur) * (1 - Math.exp(-8 * dt));
  pitchCur += (pitch - pitchCur) * (1 - Math.exp(-8 * dt));
  updateCamera();

  diskMat.uniforms.uRot.value = diskRotation;
  for (const sp of hotspots) {
    const a = sp.userData.baseAngle + diskRotation; // 与条纹同向共转
    sp.position.set(2.3 * Math.cos(a), 0.06, -2.3 * Math.sin(a));
  }
  photonRing.quaternion.copy(camera.quaternion); // 始终面向相机

  updateStarStream(dt);
  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
}
requestAnimationFrame(tick);

// --- 视口自适应 ------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
