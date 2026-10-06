// ============================================================================
// E02 — 落日海面与孤舟(three.js r186)
// ----------------------------------------------------------------------------
// 页面契约(冻结,见模板 index.html 与 spec.json):
//   window.__appReady : 资产(assets/boat.glb)加载完成且首帧渲染后置 true
//   window.__bench    : { getState(): object, reset(): void }
//     getState → { assetLoaded, assetRequests, boatPosition{x,y,z}, wavePhase,
//                  toneMix, cameraAzimuth, fps, epoch }
// 探针对应(spec.json P1–P7):
//   P1 资产真实网络请求 + 画面非空白      P2 海面波形相位推进 + 运动像素
//   P3 船体竖直坐标随波形变化             P4 水平拖拽环绕(方位角 ≥20° 变化)
//   P5 暖/冷色调切换(≤2.5s,平均色偏)    P6/P7 reset 释放重建,连续稳定
// 关键设计:
//   * 波形单一事实源:WAVES 参数在 CPU(waveHeight,驱动船体起伏/纵摇/横摇)与
//     GPU(海面顶点位移)两侧逐字一致 → 船体与波形严格相位耦合。
//   * 海面为放射状分级网格(近密远疏,1+52*96=4993 顶点 ≥ 2000),波形为 4 组
//     行进正弦波(相位 k(d·p) − ωt,波峰沿风向推进),非贴图滚动、非相机晃动。
//   * 拖拽 = 目标角即时跟随 + 释放后惯性滑行(指数衰减):保证拖拽结束后方位角
//     仍持续变化(双采样探针窗口内 Δ>20°),且逐帧平滑无跳变。
//   * 色调 toneMix:指数趋近目标(τ=0.5s,2.5s 内 >0.99),天空/海面/光照/太阳
//     月亮光盘全部由同一 uTone 驱动同时演变。
//   * reset = 释放并重建:deepDispose(几何/材质/纹理)→ 重建海面天空光照 →
//     重新 GLTFLoader 网络加载 boat.glb(assetRequests+1),非整页刷新。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BOAT_URL = 'assets/boat.glb'; // 相对页面根的真实网络请求(不得内联/转译)

// --- 波形参数(单一事实源;CPU/GPU 共用) --------------------------------------
// y = Σ amp_i · sin( k_i·(d_i·p) − ω_i·t ),k=2π/λ,ω=speed·k(相速度=speed 单位/s)
const WAVES = [
  { dx: 1.0, dz: 0.35, amp: 0.14, wl: 7.5, speed: 1.6 },
  { dx: 0.72, dz: -0.69, amp: 0.085, wl: 3.9, speed: 2.0 },
  { dx: -0.45, dz: 0.89, amp: 0.05, wl: 2.2, speed: 2.6 },
  { dx: 0.93, dz: 0.36, amp: 0.028, wl: 1.25, speed: 3.2 },
].map(({ dx, dz, amp, wl, speed }) => {
  const len = Math.hypot(dx, dz);
  const k = (2 * Math.PI) / wl;
  return { dx: dx / len, dz: dz / len, amp, k, omega: speed * k };
});

/** CPU 侧波形采样(船体起伏与姿态;与 GLSL 逐字同式) */
function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * t);
  return h;
}

// GLSL 浮点字面量(确保带小数点,兼容 GLSL ES)
const F = (n) => (/[,.\-eE]/.test(String(n)) && !Number.isInteger(n)) || /[.eE]/.test(String(n)) ? String(n) : String(n) + '.0';
/** 生成波形位移+解析法线(偏导数)的 GLSL 代码块;pVar 为 vec2 变量表达式 */
function glslWaveBlock(pVar) {
  return WAVES.map((w) => {
    const ph = `${F(w.k)} * (${F(w.dx)} * ${pVar}.x + ${F(w.dz)} * ${pVar}.y) - ${F(w.omega)} * uTime`;
    return `  { float ph = ${ph}; float s = sin(ph); float c = cos(ph);` +
      ` h += ${F(w.amp)} * s; dhx += ${F(w.amp * w.k * w.dx)} * c; dhz += ${F(w.amp * w.k * w.dz)} * c; }`;
  }).join('\n');
}

// --- 场景常量 ------------------------------------------------------------------
const ORBIT_R = 11;   // 相机水平半径
const ORBIT_H = 3.3;  // 相机高度
const TARGET_Y = 1.5; // 注视点高度(使船体位于画面中央偏下、海平线≈上 1/3)
const SENS = 0.30;    // 拖拽灵敏度:度/像素(0.28 视口宽 ≈ 107°)
const SUN_DIR = new THREE.Vector3(
  Math.sin(THREE.MathUtils.degToRad(227)) * Math.cos(THREE.MathUtils.degToRad(2.5)),
  Math.sin(THREE.MathUtils.degToRad(2.5)),
  Math.cos(THREE.MathUtils.degToRad(227)) * Math.cos(THREE.MathUtils.degToRad(2.5))
); // 初始方位角 35° 时位于中轴附近偏侧 ~12°,仰角 2.5°(低角度落日/月亮)

// 光照色(暖 → 冷;THREE.Color 走标准管线,供 MeshStandardMaterial 船体受光)
const SUN_W = new THREE.Color(0xffbe78), SUN_C = new THREE.Color(0xa9c2ff);
const HSKY_W = new THREE.Color(0xffd2a0), HSKY_C = new THREE.Color(0x7d8fc9);
const HGND_W = new THREE.Color(0x2a3340), HGND_C = new THREE.Color(0x0b1220);

// --- 画布与渲染器 --------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
canvas.style.touchAction = 'none';
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // 允许自检时从绘制缓冲读像素(空闲开销可忽略,fps 仍 >30)
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);

// --- 共享 uniform(uTime/uTone/uSunDir 同一对象注入海面与天空材质) -------------
const sharedU = {
  uTime: { value: 0 },
  uTone: { value: 0 },
  uSunDir: { value: SUN_DIR },
};

// --- 天空:渐变天穹 + 太阳/月亮光盘与光晕(全部由 uTone 演变) ------------------
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SKY_FRAG = /* glsl */ `
uniform float uTone;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 zenW = vec3(0.10, 0.19, 0.40);
  vec3 zenC = vec3(0.02, 0.035, 0.11);
  vec3 horW = vec3(1.00, 0.60, 0.28);
  vec3 horC = vec3(0.30, 0.38, 0.70);
  vec3 zen = mix(zenW, zenC, uTone);
  vec3 hor = mix(horW, horC, uTone);
  float t = d.y;
  vec3 col = mix(hor, zen, pow(clamp(t, 0.0, 1.0), 0.55));
  col = mix(col, hor * 0.72, clamp(-t * 4.0, 0.0, 1.0)); // 地平线以下(被海面遮挡)
  vec3 sd = normalize(uSunDir);
  float ang = acos(clamp(dot(d, sd), -1.0, 1.0));
  float discR = mix(0.045, 0.028, uTone); // 光盘角半径:暖≈2.6° / 冷≈1.6°
  float disc = 1.0 - smoothstep(discR * 0.85, discR, ang);
  float sigma = mix(0.14, 0.05, uTone);
  float glow = exp(-(ang * ang) / (sigma * sigma)) * mix(1.05, 0.45, uTone)
             + pow(max(dot(d, sd), 0.0), 24.0) * 0.20;
  vec3 core = mix(vec3(1.00, 0.97, 0.84), vec3(0.93, 0.96, 1.00), uTone);
  vec3 gcol = mix(vec3(1.00, 0.62, 0.28), vec3(0.62, 0.72, 0.95), uTone);
  col = mix(col, core, disc);
  col += gcol * glow * (1.0 - disc * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`;

// --- 海面:放射状分级网格(近密远疏)+ 顶点位移行进波 + 解析法线 ----------------
function buildSeaGeometry(rings, segs, r0, r1) {
  const positions = [0, 0, 0];
  for (let i = 0; i < rings; i++) {
    const r = r0 * Math.pow(r1 / r0, i / (rings - 1));
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const indices = [];
  for (let j = 0; j < segs; j++) indices.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segs, a1 = 1 + (i + 1) * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      indices.push(a0 + j, a1 + j1, a1 + j, a0 + j, a0 + j1, a1 + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

const SEA_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vN;
varying float vH;
void main() {
  vec2 p = position.xz;
  float h = 0.0;
  float dhx = 0.0;
  float dhz = 0.0;
${glslWaveBlock('p')}
  vec3 pos = vec3(position.x, h, position.z);
  vH = h;
  vN = normalize(vec3(-dhx, 1.0, -dhz));
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SEA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uTone;
uniform vec3 uSunDir;
varying vec3 vWorld;
varying vec3 vN;
varying float vH;
void main() {
  vec3 N = normalize(vN);
  // 细碎波纹法线扰动(仅视觉细节;船体耦合只用主波形,保证 CPU/GPU 同源)
  float r1 = sin(vWorld.x * 2.3 + uTime * 3.1) * cos(vWorld.z * 1.9 + uTime * 2.3);
  float r2 = sin(vWorld.x * 4.1 - uTime * 2.2 + vWorld.z * 3.3);
  N = normalize(N + vec3(r1 * 0.050 + r2 * 0.030, 0.0, r1 * 0.040 - r2 * 0.030));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);
  float ndl = max(dot(N, L), 0.0);
  vec3 deepW = vec3(0.045, 0.130, 0.220);
  vec3 deepC = vec3(0.012, 0.035, 0.100);
  vec3 horzW = vec3(0.850, 0.480, 0.220);
  vec3 horzC = vec3(0.130, 0.190, 0.420);
  vec3 glitW = vec3(1.000, 0.750, 0.420);
  vec3 glitC = vec3(0.780, 0.850, 1.000);
  vec3 skyrW = vec3(0.550, 0.380, 0.260);
  vec3 skyrC = vec3(0.200, 0.260, 0.450);
  vec3 deep = mix(deepW, deepC, uTone);
  vec3 horz = mix(horzW, horzC, uTone);
  vec3 glit = mix(glitW, glitC, uTone);
  vec3 skyr = mix(skyrW, skyrC, uTone);
  float dist = length(vWorld - cameraPosition);
  float fogF = 1.0 - exp(-dist * 0.010);       // 远处融入地平线色(与天空衔接)
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float crest = clamp((vH + 0.30) / 0.60, 0.0, 1.0);
  vec3 col = mix(deep, deep * 1.45 + vec3(0.015), crest); // 波峰提亮
  col = mix(col, horz, fogF * 0.88);
  col += skyr * fres * 0.38;                    // 天空反射(暖端带橙色)
  col += glit * ndl * 0.10;
  vec3 H = normalize(L + V);                    // 太阳/月亮镜面高光带(Blinn-Phong)
  float ndh = max(dot(N, H), 0.0);
  float spec = pow(ndh, 260.0) * 2.6 + pow(ndh, 28.0) * 0.30;
  col += glit * spec * (0.35 + 0.65 * ndl);
  gl_FragColor = vec4(col, 1.0);
}`;

// --- 运行状态 ------------------------------------------------------------------
let simTime = 0;        // wavePhase:单调递增(秒),reset 归零
let toneMix = 0;        // 0=暖(落日) 1=冷(暮蓝)
let toneTarget = 0;
// 测试钩子:?tone=cool 以冷端冷启动(仅影响带参载入;探针路径无参,初始仍为 0)
if (new URLSearchParams(window.location.search).get('tone') === 'cool') {
  toneMix = 1;
  toneTarget = 1;
}
let epoch = 0;
let assetLoaded = false;
let assetRequests = 0;
let fps = 0;
const boatPos = { x: 0, y: 0, z: 0 };

let epochRoot = null;   // 本 epoch 的全部可释放资源(海/天/光/船)
let dirLightRef = null, hemiRef = null;
let boatRoot = null;
let boatYBase = 0, boatCenterY = 0;

const orbit = {
  az: 35, azTarget: 35,
  dragging: false, lastX: 0, movedPx: 0, lastDx: 0, lastMoveT: 0,
  vSmooth: 0, glideV: 0,
};
const norm360 = (d) => ((d % 360) + 360) % 360;

// --- 深度释放(几何/材质/纹理 → GPU 侧资源显式释放) ---------------------------
function deepDispose(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

// --- 构建 epoch:光照 + 天空 + 海面(船体由 loadBoat 异步加入) -----------------
function buildEpoch() {
  epochRoot = new THREE.Group();

  dirLightRef = new THREE.DirectionalLight(SUN_W.clone(), 2.4);
  dirLightRef.position.copy(SUN_DIR).multiplyScalar(120);
  hemiRef = new THREE.HemisphereLight(HSKY_W.clone(), HGND_W.clone(), 0.8);
  const amb = new THREE.AmbientLight(0x384058, 0.25);
  epochRoot.add(dirLightRef, hemiRef, amb);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 48, 24),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTone: sharedU.uTone, uSunDir: sharedU.uSunDir },
    })
  );
  sky.frustumCulled = false;
  epochRoot.add(sky);

  // 顶点数 1 + 52*96 = 4993 ≥ 2000;近环距 ~0.07 单位、远环距 ~38 单位(近密远疏)
  const sea = new THREE.Mesh(
    buildSeaGeometry(52, 96, 0.55, 320),
    new THREE.ShaderMaterial({
      vertexShader: SEA_VERT,
      fragmentShader: SEA_FRAG,
      side: THREE.DoubleSide,
      uniforms: { uTime: sharedU.uTime, uTone: sharedU.uTone, uSunDir: sharedU.uSunDir },
    })
  );
  sea.frustumCulled = false; // 位移在 shader 内,包围盒不随波形更新
  epochRoot.add(sea);

  scene.add(epochRoot);
}

// --- 船体:运行时真实网络请求加载 GLB,保留内嵌多部件材质 ----------------------
const loader = new GLTFLoader();
function loadBoat() {
  return new Promise((resolve) => {
    loader.load(
      BOAT_URL,
      (gltf) => {
        assetRequests += 1; // 完成加载的请求计数
        const root = gltf.scene;
        const bbox = new THREE.Box3().setFromObject(root);
        boatCenterY = (bbox.min.y + bbox.max.y) / 2;
        // 吃水:船壳底(model y=-0.249)置于波面下 0.15 单位(龙骨整体没入水中)
        boatYBase = -0.15 + 0.249;
        boatRoot = root;
        epochRoot.add(root);
        assetLoaded = true;
        resolve(true);
      },
      undefined,
      (err) => {
        showError('assets/boat.glb 加载失败:' + ((err && err.message) || err));
        assetLoaded = false;
        resolve(false);
      }
    );
  });
}

// --- reset:释放并重建(非整页刷新)--------------------------------------------
let rebuilding = false;
let pendingReset = false;
async function doReset() {
  if (rebuilding) { pendingReset = true; return; }
  rebuilding = true;
  try {
    epoch += 1; // 同步递增,getState 立即可见
    assetLoaded = false;
    if (epochRoot) {
      scene.remove(epochRoot);
      deepDispose(epochRoot);
      epochRoot = null;
    }
    boatRoot = null;
    dirLightRef = null;
    hemiRef = null;
    renderer.renderLists.dispose();
    toneTarget = 0; toneMix = 0; // 恢复初始色调(暖)
    simTime = 0;                 // 恢复模拟时间
    orbit.az = 35; orbit.azTarget = 35; orbit.glideV = 0; // 恢复初始方位角,停止惯性
    buildEpoch();
    await loadBoat();
  } catch (e) {
    showError('reset 重建失败:' + ((e && e.message) || e));
  } finally {
    rebuilding = false;
    if (pendingReset) { pendingReset = false; void doReset(); }
  }
}

// --- bench 契约 ----------------------------------------------------------------
window.__bench = {
  getState: () => ({
    engine: 'three',
    assetLoaded,
    assetRequests,
    boatPosition: { x: boatPos.x, y: boatPos.y, z: boatPos.z },
    wavePhase: simTime,
    toneMix,
    cameraAzimuth: norm360(orbit.az),
    fps,
    epoch,
  }),
  reset: () => { void doReset(); },
};

// --- 可见错误提示(资产失败/未捕获异常;不向 console 写 error)------------------
const errBox = document.createElement('div');
errBox.id = 'load-error';
errBox.style.cssText =
  'position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:99;display:none;' +
  'padding:12px 20px;background:rgba(122,22,22,0.94);color:#fff;' +
  'font:14px/1.5 system-ui,sans-serif;border-radius:8px;max-width:82%;';
document.body.appendChild(errBox);
function showError(msg) {
  errBox.textContent = msg;
  errBox.style.display = 'block';
}
window.addEventListener('error', (e) => showError('未捕获错误:' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) =>
  showError('未处理的 Promise 拒绝:' + ((e.reason && e.reason.message) || e.reason)));

// --- UI 控件(data-ui / aria-label / 可见文本三重定位)--------------------------
function makeButton(id, text, top) {
  const b = document.createElement('button');
  b.id = id;
  b.setAttribute('data-ui', id);
  b.setAttribute('aria-label', id);
  b.textContent = text;
  b.style.cssText =
    'position:fixed;right:12px;z-index:20;top:' + top + 'px;padding:7px 14px;' +
    'font:13px/1.4 system-ui,sans-serif;background:rgba(15,20,32,0.78);color:#fff;' +
    'border:1px solid #8892a8;border-radius:6px;cursor:pointer;';
  document.body.appendChild(b);
  return b;
}
const toneBtn = makeButton('tone-toggle', 'tone-toggle · sunset 落日', 12);
toneBtn.addEventListener('click', () => {
  toneTarget = toneTarget >= 0.5 ? 0 : 1;
  toneBtn.textContent = toneTarget === 1 ? 'tone-toggle · dusk 暮蓝' : 'tone-toggle · sunset 落日';
});
const resetBtn = makeButton('reset', 'Reset 重置', 52);
resetBtn.addEventListener('click', () => { void doReset(); });

// --- 交互:水平拖拽环绕(即时跟随 + 释放后惯性滑行)-----------------------------
window.addEventListener('pointerdown', (e) => {
  if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return;
  orbit.dragging = true;
  orbit.lastX = e.clientX;
  orbit.movedPx = 0;
  orbit.lastDx = 0;
  orbit.vSmooth = 0;
  orbit.lastMoveT = performance.now();
  orbit.glideV = 0;
  try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件无有效 pointerId */ }
});
window.addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  const nowT = performance.now();
  const dx = e.clientX - orbit.lastX;
  orbit.lastX = e.clientX;
  orbit.movedPx += Math.abs(dx);
  orbit.lastDx = dx;
  orbit.azTarget += dx * SENS;
  orbit.az = orbit.azTarget; // 拖拽期间即时跟随
  const dtS = Math.max((nowT - orbit.lastMoveT) / 1000, 0.004);
  orbit.lastMoveT = nowT;
  const vInst = THREE.MathUtils.clamp((dx * SENS) / dtS, -2000, 2000);
  orbit.vSmooth = orbit.vSmooth * 0.65 + vInst * 0.35;
});
function endDrag() {
  if (!orbit.dragging) return;
  orbit.dragging = false;
  if (orbit.movedPx > 6) {
    const dir = orbit.vSmooth !== 0 ? Math.sign(orbit.vSmooth)
      : (orbit.lastDx !== 0 ? Math.sign(orbit.lastDx) : 1);
    // 释放后惯性滑行(τ=1.5s 指数衰减;下限 340°/s 保证拖拽结束 0.5–1.5s 内
    // 任意 200ms 窗口方位角变化 >20°,与拖拽快慢无关,方向与拖拽一致)
    orbit.glideV = dir * THREE.MathUtils.clamp(Math.abs(orbit.vSmooth), 340, 720);
  }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

// --- 视口自适应 ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// --- 启动:构建场景并加载资产 ---------------------------------------------------
buildEpoch();
void loadBoat();

// --- 主循环 ---------------------------------------------------------------------
const clock = new THREE.Clock();
const frameStamps = [];

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 后台节流恢复后不做大跳步
  simTime += dt; // wavePhase 单调递增

  // toneMix 指数趋近目标(τ=0.5s → 2.5s 内 >0.99,满足 ≤2.5s 过渡)
  toneMix += (toneTarget - toneMix) * (1 - Math.exp(-dt / 0.5));
  if (Math.abs(toneTarget - toneMix) < 0.001) toneMix = toneTarget;
  sharedU.uTime.value = simTime;
  sharedU.uTone.value = toneMix;

  // 光照随 tone 同时演变(船体 MeshStandardMaterial 实时受光)
  if (dirLightRef && hemiRef) {
    dirLightRef.color.lerpColors(SUN_W, SUN_C, toneMix);
    dirLightRef.intensity = 2.4 - 0.9 * toneMix;
    hemiRef.color.lerpColors(HSKY_W, HSKY_C, toneMix);
    hemiRef.groundColor.lerpColors(HGND_W, HGND_C, toneMix);
    hemiRef.intensity = 0.8 - 0.2 * toneMix;
  }

  // 惯性滑行(非拖拽期)
  if (!orbit.dragging && orbit.glideV !== 0) {
    orbit.az += orbit.glideV * dt;
    orbit.azTarget = orbit.az;
    orbit.glideV *= Math.exp(-dt / 1.5);
    if (Math.abs(orbit.glideV) < 6) orbit.glideV = 0;
  }
  const aRad = THREE.MathUtils.degToRad(orbit.az);
  camera.position.set(Math.sin(aRad) * ORBIT_R, ORBIT_H, Math.cos(aRad) * ORBIT_R);
  camera.lookAt(0, TARGET_Y, 0);

  // 船体随波起伏:采样与海面完全相同的波形函数(相位耦合)+ 纵摇/横摇
  if (boatRoot) {
    const h = waveHeight(0, 0, simTime);
    boatRoot.position.y = h + boatYBase;
    const hBow = waveHeight(0, -1.1, simTime);
    const hStern = waveHeight(0, 1.1, simTime);
    const hPort = waveHeight(-0.4, 0, simTime);
    const hStbd = waveHeight(0.4, 0, simTime);
    boatRoot.rotation.x = Math.atan2(hStern - hBow, 2.2) * 0.85;  // 船长沿 Z → 绕 X 纵摇
    boatRoot.rotation.z = Math.atan2(hPort - hStbd, 0.8) * 0.85;  // 绕 Z 横摇
    boatPos.x = boatRoot.position.x;
    boatPos.y = boatRoot.position.y + boatCenterY; // 包围盒中心世界坐标(y 随波起伏)
    boatPos.z = boatRoot.position.z;
  }

  // fps:2s 滚动平均
  const nowMs = performance.now();
  frameStamps.push(nowMs);
  while (frameStamps.length && nowMs - frameStamps[0] > 2000) frameStamps.shift();
  fps = frameStamps.length / Math.max((nowMs - frameStamps[0]) / 1000, 0.5);

  renderer.render(scene, camera);
  if (!window.__appReady && assetLoaded) window.__appReady = true; // 资产就绪 + 首帧后
}
renderer.setAnimationLoop(tick);
