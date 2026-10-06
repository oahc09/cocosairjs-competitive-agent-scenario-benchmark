// ============================================================================
// E02 — 落日海面与孤舟 (Asset Driven) · three.js r186
// ----------------------------------------------------------------------------
// 页面契约(index.html 内联脚本已置初值):
//   window.__appReady : 资产(boat.glb)加载完成且首帧渲染后置 true
//   window.__bench    : { getState(): object, reset(): void }
//   UI 控件           : data-ui="tone-toggle" / data-ui="reset"
//
// 场景构成:
//   · 海面  — 程序化重力波曲面(顶点着色器逐帧位移,4 组正弦波叠加),
//             顶点数 31,155(≥2000),幂次曲线网格近密远疏;
//             波形参数表 WAVES 为 CPU/GPU 单一事实源,船体起伏采样同一函数 → 严格同相。
//   · 天空  — 渐变天穹(BackSide 大球)+ 太阳/月亮光盘与光晕,颜色随 toneMix 演变。
//   · 孤舟  — GLTFLoader 运行时加载 assets/boat.glb(真实网络请求,不内联),
//             保留资产内嵌 PBR 材质;包围盒中心归一后随波起伏 + 轻微纵摇/横摇。
//   · 光照  — 方向光 + 半球光,方向/色温/强度随 toneMix 演变(暖金落日 → 冷蓝月光)。
//   · 交互  — 水平拖拽环绕(方位角指数平滑,无跳变);Reset 显式 dispose GPU 资源
//             后重建海面与船体(重新发起网络加载),非整页刷新。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- 常量 -------------------------------------------------------------
const ASSET_URL = 'assets/boat.glb';
const INITIAL_AZIMUTH = 35;      // 度,spec 状态契约初始值
const DRAG_DEG_PER_PX = 0.75;    // 与 OrbitControls 默认灵敏度同量级(全屏宽 ≈ 540°)
const AZ_SMOOTH_RATE = 1.5;      // 方位角指数趋近速率(1/s),拖拽平滑无跳变
const TONE_DURATION = 1.5;       // 色调过渡时长(s),spec 上限 2.5s
const CAM_DIST = 7.2, CAM_H = 1.9, LOOK_Y = 0.85, FOV = 55;
const SEA_EXT = 200, SEG_X = 220, SEG_Z = 140; // (220+1)*(140+1)=31,155 顶点
const BOAT_LEN = 2.4;            // 归一化后船体最长边(资产契约 1–4 单位)
const BOAT_YAW = -0.55;          // 船体朝向(初始 35° 方位角呈 3/4 视角)

// 波形参数表:[方向x, 方向z(单位化), 振幅, 波数 k=2π/波长, 角速度, 初相]
// 单一事实源:GLSL 代码由此生成,JS 镜像函数共用同一数据 → 船体与海面同相耦合
const WAVES = [
  { dx: 0.28, dz: 0.96, amp: 0.14, k: 0.8976, w: 0.9, p: 0.0 },
  { dx: 0.94, dz: -0.34, amp: 0.075, k: 2.0265, w: 1.5, p: 1.7 },
  { dx: -0.52, dz: 0.85, amp: 0.045, k: 4.1888, w: 2.1, p: 4.2 },
  { dx: 0.18, dz: 0.98, amp: 0.1, k: 0.3927, w: 0.45, p: 2.6 },
];

function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) + w.w * t + w.p);
  return h;
}

function buildWaveGLSL() {
  const f = (n) => n.toFixed(6); // GLSL 需要字面小数点(int 字面量会类型不匹配)
  let body = '';
  for (const w of WAVES) {
    body +=
      `  ph = ${f(w.k)}*(${f(w.dx)}*p.x + ${f(w.dz)}*p.y) + ${f(w.w)}*t + ${f(w.p)};\n` +
      `  h += ${f(w.amp)}*sin(ph);\n` +
      `  acc += ${f(w.amp * w.k)}*vec2(${f(w.dx)}, ${f(w.dz)})*cos(ph);\n`;
  }
  return `float waveH(vec2 p, float t, out vec2 g){
  float h = 0.0; vec2 acc = vec2(0.0); float ph;
${body}  g = acc;
  return h;
}`;
}

// 太阳/月亮方向(方位角/仰角,度)
function sphDir(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

// 暖(落日)/冷(暮蓝)两套调色板;运行时按 toneMix 逐项 lerp
// 太阳方位:相机初始方位角 35° 时视线朝方位 215°,太阳置于 197°(中轴附近偏侧 18°)
const SUN_AZ = 197;
const PAL = {
  warm: {
    zenith: new THREE.Color(0x3a4a80),
    horizon: new THREE.Color(0xff8a2e),
    glow: new THREE.Color(0xffb347),
    disk: new THREE.Color(0xfff3c8),
    seaDeep: new THREE.Color(0x16323f),
    seaShallow: new THREE.Color(0x3f7a80),
    spec: new THREE.Color(0xffc06a),
    tint: new THREE.Color(0xffd9b0),
    sunDir: sphDir(SUN_AZ, 9),
    diskCos: 0.99978, diskEdge: 0.99926, // 太阳光盘 ≈1.2°
    glowPow: 5.0, glowStr: 0.9,
    lightColor: new THREE.Color(0xffd2a0), lightInt: 2.0,
    hemiSky: new THREE.Color(0xcc9a70), hemiGround: new THREE.Color(0x1e3440), hemiInt: 0.65,
  },
  cool: {
    zenith: new THREE.Color(0x070d24),
    horizon: new THREE.Color(0x2c3f86),
    glow: new THREE.Color(0x9db8ee),
    disk: new THREE.Color(0xe8f0ff),
    seaDeep: new THREE.Color(0x081527),
    seaShallow: new THREE.Color(0x1d3a5e),
    spec: new THREE.Color(0xbfd4ff),
    tint: new THREE.Color(0xa8c0e8),
    sunDir: sphDir(SUN_AZ, 14), // 月亮略高
    diskCos: 0.99988, diskEdge: 0.9997, // 月亮光盘 ≈0.9°
    glowPow: 55.0, glowStr: 0.5,
    lightColor: new THREE.Color(0xaec6f2), lightInt: 1.5,
    hemiSky: new THREE.Color(0x51689c), hemiGround: new THREE.Color(0x0a1220), hemiInt: 0.55,
  },
};

const lerp = (a, b, t) => a + (b - a) * t;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// ---------- 渲染器 / 场景 / 相机 ---------------------------------------------
const canvas = document.getElementById('app-canvas');
canvas.style.touchAction = 'none';
canvas.style.cursor = 'grab';
// preserveDrawingBuffer:支持页面侧对画布做像素级自检(readPixels);帧率影响可忽略
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 1200);

// ---------- 光照 -------------------------------------------------------------
const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.target.position.set(0, 0, 0);
scene.add(dirLight, dirLight.target);
const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.6);
scene.add(hemi);

// ---------- 天空穹 -------------------------------------------------------------
const skyUniforms = {
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uGlow: { value: new THREE.Color() },
  uDisk: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uGlowPow: { value: 5 },
  uGlowStr: { value: 0.9 },
  uDiskCos: { value: 0.99978 },
  uDiskEdge: { value: 0.99926 },
};
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    void main() {
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uZenith, uHorizon, uGlow, uDisk, uSunDir;
    uniform float uGlowPow, uGlowStr, uDiskCos, uDiskEdge;
    varying vec3 vWorldPos;
    void main() {
      vec3 d = normalize(vWorldPos - cameraPosition);
      float y = d.y;
      vec3 col = mix(uHorizon, uZenith, smoothstep(0.02, 0.5, y));
      col = mix(col, uHorizon * 0.5, smoothstep(0.02, -0.25, y)); // 海平线以下压暗
      float s = max(dot(d, normalize(uSunDir)), 0.0);
      col += uGlow * pow(s, uGlowPow) * uGlowStr;                  // 光源光晕
      col += uGlow * pow(s, uGlowPow * 0.30) * uGlowStr * 0.30;    // 宽域泛光
      col = mix(col, uDisk, smoothstep(uDiskEdge, uDiskCos, s));   // 光盘
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), skyMat);
skyMesh.renderOrder = -1;
skyMesh.frustumCulled = false;
scene.add(skyMesh);

// ---------- 海面 -------------------------------------------------------------
const seaUniforms = {
  uTime: { value: 0 },
  uDeep: { value: new THREE.Color() },
  uShallow: { value: new THREE.Color() },
  uSky: { value: new THREE.Color() },
  uSpec: { value: new THREE.Color() },
  uTint: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSpecPow: { value: 180 },
  uGlint: { value: 0.9 },
};
const seaVert = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;
  ${buildWaveGLSL()}
  void main() {
    vec3 pos = position;
    vec2 g;
    float h = waveH(pos.xz, uTime, g);
    pos.y += h;
    vNormal = normalize(vec3(-g.x, 1.0, -g.y)); // 解析法线(波形可导)
    vHeight = h;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const seaFrag = /* glsl */ `
  uniform vec3 uDeep, uShallow, uSky, uSpec, uTint, uSunDir;
  uniform float uSpecPow, uGlint;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDir);
    float diff = max(dot(N, L), 0.0);
    float hN = clamp(vHeight * 1.4 + 0.5, 0.0, 1.0);
    vec3 col = mix(uDeep, uShallow, hN) * (0.45 + 0.65 * diff);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col = mix(col, uSky, fres * 0.6); // 天空反射(菲涅尔)
    vec3 R = reflect(-L, N);
    float rv = max(dot(R, V), 0.0);
    col += uSpec * (pow(rv, uSpecPow) * uGlint + pow(rv, 8.0) * 0.10); // 太阳/月亮高光带
    col *= uTint;
    float dist = length(vWorldPos.xz - cameraPosition.xz);
    col = mix(col, uSky, smoothstep(60.0, 190.0, dist) * 0.85); // 远景融入海平线
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

// 幂次曲线网格:|u|^2 拉伸 → 中心(近景/船体)波形密,边缘(远景)疏
function makeSeaGeometry() {
  const nx = SEG_X + 1, nz = SEG_Z + 1;
  const positions = new Float32Array(nx * nz * 3);
  const index = new Uint32Array(SEG_X * SEG_Z * 6);
  const curve = (u) => Math.sign(u) * u * u;
  let pi = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = curve((iz / SEG_Z) * 2 - 1) * SEA_EXT;
    for (let ix = 0; ix < nx; ix++) {
      const x = curve((ix / SEG_X) * 2 - 1) * SEA_EXT;
      positions[pi++] = x; positions[pi++] = 0; positions[pi++] = z;
    }
  }
  let ii = 0;
  for (let iz = 0; iz < SEG_Z; iz++) {
    for (let ix = 0; ix < SEG_X; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      index[ii++] = a; index[ii++] = c; index[ii++] = b;
      index[ii++] = b; index[ii++] = c; index[ii++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}

let sea = null; // { mesh, geo, mat }
function buildSea() {
  const geo = makeSeaGeometry();
  const mat = new THREE.ShaderMaterial({ uniforms: seaUniforms, vertexShader: seaVert, fragmentShader: seaFrag });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // 波形在顶点着色器中位移,包围盒不可信
  scene.add(mesh);
  sea = { mesh, geo, mat };
}

// ---------- 船体(GLTF 运行时加载) -------------------------------------------
const loader = new GLTFLoader();
let boatRoot = null; // 包围盒中心即 group 原点

function disposeObjectDeep(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}

function mountBoat(gltf) {
  const model = gltf.scene;
  // 包围盒中心归一到 group 原点,最长边归一到 2.4(资产契约 1–4 单位内)
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = BOAT_LEN / maxDim;
  model.scale.setScalar(s);
  model.position.set(-center.x * s, -center.y * s, -center.z * s);
  boatRoot = new THREE.Group();
  boatRoot.rotation.order = 'YXZ'; // 先 yaw 后 pitch/roll
  boatRoot.rotation.y = BOAT_YAW;
  boatRoot.add(model);
  // 水线校准:包围盒含桅杆/帆,船体只占下部 —— 抬升使船体约 1/3 吃水、可辨船形
  boatRoot.userData.baseY = size.y * s * 0.28;
  scene.add(boatRoot);
}

function setStatus(text, isError) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
  el.style.color = isError ? '#ff7a7a' : '#e8e8e8';
}

// ---------- 状态与生命周期 -----------------------------------------------------
let simTime = 0;          // 波形全局相位(秒,单调递增;reset 归零)
let epoch = 0;            // 场景重建计数
let assetRequests = 0;    // boat.glb 完成加载计数
let assetLoaded = false;
let appReadySent = false;
let rebuilding = false;   // reset 重建进行中(防重入)
let toneCur = 0, toneFrom = 0, toneTarget = 0, toneT = 1;
let azCur = INITIAL_AZIMUTH, azTarget = INITIAL_AZIMUTH;
let lastFps = 0;
const frameTimes = [];

function loadBoat() {
  rebuilding = true;
  assetLoaded = false;
  loader.load(
    ASSET_URL,
    (gltf) => {
      mountBoat(gltf);
      assetRequests += 1;
      assetLoaded = true;
      rebuilding = false;
      setStatus('', false);
    },
    undefined,
    (err) => {
      // 加载失败:可见错误提示,不抛未捕获异常
      rebuilding = false;
      setStatus('Failed to load assets/boat.glb — ' + (err && err.message ? err.message : 'unknown error'), true);
    }
  );
}

function doReset() {
  if (rebuilding) return;
  epoch += 1;
  // 释放 GPU 侧资源(几何体/材质/纹理),移出场景
  if (boatRoot) { scene.remove(boatRoot); disposeObjectDeep(boatRoot); boatRoot = null; }
  if (sea) { scene.remove(sea.mesh); sea.geo.dispose(); sea.mat.dispose(); sea = null; }
  // 恢复初始状态:色调、方位角、模拟时间
  toneCur = 0; toneFrom = 0; toneTarget = 0; toneT = 1;
  azCur = INITIAL_AZIMUTH; azTarget = INITIAL_AZIMUTH;
  simTime = 0;
  buildSea();
  loadBoat(); // 重新发起真实网络加载 → assetRequests +1
}

// 色调控件:暖 ↔ 冷(过渡 TONE_DURATION 秒)
function toggleTone() {
  toneFrom = toneCur;
  toneTarget = toneTarget > 0.5 ? 0 : 1;
  toneT = 0;
  updateToneLabel();
}

function updateToneLabel() {
  const btn = document.getElementById('tone-btn');
  if (btn) btn.textContent = toneTarget > 0.5 ? 'Tone: Moonlight' : 'Tone: Sunset';
}

// 逐帧把两套调色板按 toneCur 混入 uniforms 与灯光
function applyToneMix(k) {
  const A = PAL.warm, B = PAL.cool;
  skyUniforms.uZenith.value.copy(A.zenith).lerp(B.zenith, k);
  skyUniforms.uHorizon.value.copy(A.horizon).lerp(B.horizon, k);
  skyUniforms.uGlow.value.copy(A.glow).lerp(B.glow, k);
  skyUniforms.uDisk.value.copy(A.disk).lerp(B.disk, k);
  skyUniforms.uSunDir.value.copy(A.sunDir).lerp(B.sunDir, k).normalize();
  skyUniforms.uGlowPow.value = lerp(A.glowPow, B.glowPow, k);
  skyUniforms.uGlowStr.value = lerp(A.glowStr, B.glowStr, k);
  skyUniforms.uDiskCos.value = lerp(A.diskCos, B.diskCos, k);
  skyUniforms.uDiskEdge.value = lerp(A.diskEdge, B.diskEdge, k);
  seaUniforms.uDeep.value.copy(A.seaDeep).lerp(B.seaDeep, k);
  seaUniforms.uShallow.value.copy(A.seaShallow).lerp(B.seaShallow, k);
  seaUniforms.uSky.value.copy(A.horizon).lerp(B.horizon, k);
  seaUniforms.uSpec.value.copy(A.spec).lerp(B.spec, k);
  seaUniforms.uTint.value.copy(A.tint).lerp(B.tint, k);
  seaUniforms.uSunDir.value.copy(skyUniforms.uSunDir.value);
  seaUniforms.uSpecPow.value = lerp(180, 260, k);
  seaUniforms.uGlint.value = lerp(0.9, 0.55, k);
  dirLight.color.copy(A.lightColor).lerp(B.lightColor, k);
  dirLight.intensity = lerp(A.lightInt, B.lightInt, k);
  dirLight.position.copy(skyUniforms.uSunDir.value).multiplyScalar(60);
  hemi.color.copy(A.hemiSky).lerp(B.hemiSky, k);
  hemi.groundColor.copy(A.hemiGround).lerp(B.hemiGround, k);
  hemi.intensity = lerp(A.hemiInt, B.hemiInt, k);
}

// ---------- UI 覆盖层 ----------------------------------------------------------
{
  const css =
    'position:fixed;z-index:9999;padding:5px 14px;font:13px sans-serif;color:#fff;' +
    'background:rgba(20,26,38,0.72);border:1px solid #66707f;border-radius:5px;cursor:pointer;';
  const toneBtn = document.createElement('button');
  toneBtn.id = 'tone-btn';
  toneBtn.textContent = 'Tone: Sunset';
  toneBtn.setAttribute('data-ui', 'tone-toggle');
  toneBtn.setAttribute('aria-label', 'tone-toggle');
  toneBtn.style.cssText = css + 'top:10px;left:10px;';
  toneBtn.addEventListener('click', toggleTone);
  document.body.appendChild(toneBtn);

  const resetBtn = document.createElement('button');
  resetBtn.id = 'reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.setAttribute('data-ui', 'reset');
  resetBtn.setAttribute('aria-label', 'reset');
  resetBtn.style.cssText = css + 'top:10px;left:130px;';
  resetBtn.addEventListener('click', doReset);
  document.body.appendChild(resetBtn);

  const status = document.createElement('div');
  status.id = 'status';
  status.textContent = 'Loading boat…';
  status.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:block;' +
    'font:13px sans-serif;color:#e8e8e8;background:rgba(20,26,38,0.72);padding:4px 12px;border-radius:5px;';
  document.body.appendChild(status);
}

// ---------- 拖拽环绕(pointer 事件,水平位移 → 方位角) -------------------------
let drag = null; // { id, lastX }
canvas.addEventListener('pointerdown', (e) => {
  drag = { id: e.pointerId, lastX: e.clientX };
  canvas.style.cursor = 'grabbing';
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针,忽略 */ }
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  azTarget += (e.clientX - drag.lastX) * DRAG_DEG_PER_PX;
  drag.lastX = e.clientX;
});
const endDrag = (e) => {
  if (drag && e.pointerId === drag.id) { drag = null; canvas.style.cursor = 'grab'; }
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// ---------- bench 契约 ----------------------------------------------------------
window.__bench = {
  getState: () => {
    const p = boatRoot ? boatRoot.position : { x: 0, y: 0, z: 0 };
    const az = ((azCur % 360) + 360) % 360;
    return {
      engine: 'three',
      assetLoaded,
      assetRequests,
      boatPosition: { x: r4(p.x), y: r4(p.y), z: r4(p.z) },
      wavePhase: r4(simTime),
      toneMix: r4(toneCur),
      cameraAzimuth: r4(az),
      fps: lastFps,
      epoch,
    };
  },
  reset: doReset,
};

// ---------- 主循环 ---------------------------------------------------------------
let lastT = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (!(dt > 0)) dt = 0.0001;
  if (dt > 0.25) dt = 0.25; // 后台标签节流恢复后限步推进,避免相位跳变

  simTime += dt;
  frameTimes.push(now);
  while (frameTimes.length > 2 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 2) {
    const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
    if (span > 0) lastFps = Math.round((frameTimes.length - 1) / span);
  }

  // 色调过渡(smoothstep 缓动,≤2.5s)
  if (toneT < 1) {
    toneT = Math.min(1, toneT + dt / TONE_DURATION);
    const e = toneT * toneT * (3 - 2 * toneT);
    toneCur = toneFrom + (toneTarget - toneFrom) * e;
  }

  // 方位角指数趋近:逐帧平滑、无跳变
  azCur += (azTarget - azCur) * (1 - Math.exp(-AZ_SMOOTH_RATE * dt));
  const az = (azCur * Math.PI) / 180;
  camera.position.set(Math.sin(az) * CAM_DIST, CAM_H, Math.cos(az) * CAM_DIST);
  camera.lookAt(0, LOOK_Y, 0);

  // 船体随波起伏:采样与海面相同的波形函数(同相耦合)+ 轻微纵摇/横摇
  if (boatRoot) {
    boatRoot.position.y = boatRoot.userData.baseY + 0.85 * waveHeight(0, 0, simTime);
    const fx = Math.sin(BOAT_YAW), fz = Math.cos(BOAT_YAW);
    const hBow = waveHeight(fx * 1.1, fz * 1.1, simTime);
    const hStern = waveHeight(-fx * 1.1, -fz * 1.1, simTime);
    const hR = waveHeight(fz * 0.7, -fx * 0.7, simTime);
    const hL = waveHeight(-fz * 0.7, fx * 0.7, simTime);
    const pitch = Math.atan2(hStern - hBow, 2.2) * 0.7;
    const roll = Math.atan2(hR - hL, 1.4) * 0.5;
    const sm = Math.min(1, dt * 5);
    boatRoot.rotation.x += (pitch - boatRoot.rotation.x) * sm;
    boatRoot.rotation.z += (roll - boatRoot.rotation.z) * sm;
  }

  seaUniforms.uTime.value = simTime;
  applyToneMix(toneCur);

  renderer.render(scene, camera);

  // 资产加载完成且首帧渲染后置 ready(P1 前置:assetLoaded 先于 __appReady)
  if (assetLoaded && !appReadySent) {
    appReadySent = true;
    window.__appReady = true;
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// ---------- 启动 -----------------------------------------------------------------
buildSea();
loadBoat();
updateToneLabel();
requestAnimationFrame(tick);
