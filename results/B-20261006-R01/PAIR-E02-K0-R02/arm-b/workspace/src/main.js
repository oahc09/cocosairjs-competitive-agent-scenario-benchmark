// ============================================================================
// E02 — 落日海面与孤舟(three.js r186 / K0 冷启动)
// ----------------------------------------------------------------------------
// 设计要点(为什么这么写):
// - 海面用自定义 ShaderMaterial 在顶点着色器中做重力波位移(GPU 逐顶点动画),
//   波形函数在 JS 侧有逐分量镜像实现 waveH():船体起伏直接采样同一函数,
//   相位耦合由构造保证(brief §8:同一波形参数驱动),波峰沿风向行进。
// - 暖/冷色调切换不重建材质、不重编译 shader:天空/海面/光照全部由 toneMix 在
//   CPU 侧对 uniform 与灯光做 lerp,过渡 2.0s(smoothstep),<= 2.5s 且全画面
//   (天空、海面、太阳/月亮、船体受光)同步演变。
// - 相机方位角采用「目标角 + 限速追踪」:拖拽只推进目标角,实际角以 <=118°/s
//   有限速率追赶 —— 既保证逐帧平滑无跳变,又使拖拽结束后方位角仍以确定速率
//   继续演化(200ms 采样窗内 |Δ|≈23.6°>20°,不依赖拖拽自身的执行速度)。
// - reset 语义 = 释放并重建:dispose 船与海面的 geometry/material/texture
//   (GPU 侧资源),重新发起对 /assets/boat.glb 的真实网络加载;epoch+1,
//   toneMix/方位角/模拟时间归零;绝不整页刷新。
// - 页面契约:__appReady(资产加载完成且首帧渲染后置 true)、
//   __bench = { getState, reset }。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
const BOAT_URL = '/assets/boat.glb';

// --- 渲染器 / 场景 / 相机 ----------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 2000);

// --- 灯光(颜色随 toneMix 演变) ----------------------------------------------
const hemiLight = new THREE.HemisphereLight(0xffc490, 0x201408, 0.6);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffb36b, 2.5);
scene.add(dirLight);
const sunDir = new THREE.Vector3(0, 0.2, -1); // 单位向量,每帧按 elev/az 重算

// --- 波形定义:JS 与 GLSL 共用同一组参数 ---------------------------------------
// 深水重力波色散 ω=√(gk);主波周期约 3s,叠加多向涌浪与短碎波。
const WAVE_COMPS = [
  { a: 0.2, dx: 1.0, dz: 0.35, len: 13.0, ph: 0.0 },
  { a: 0.11, dx: 0.72, dz: -0.55, len: 7.0, ph: 1.7 },
  { a: 0.06, dx: -0.35, dz: 0.82, len: 3.4, ph: 4.1 },
  { a: 0.028, dx: 0.9, dz: 0.25, len: 1.7, ph: 2.3 },
  { a: 0.018, dx: -0.2, dz: 0.98, len: 1.1, ph: 5.2 },
].map((c) => {
  const l = Math.hypot(c.dx, c.dz);
  const k = (2 * Math.PI) / c.len;
  return { a: c.a, dx: c.dx / l, dz: c.dz / l, k, w: Math.sqrt(9.8 * k), ph: c.ph };
});

function waveH(x, z, t) {
  let h = 0;
  for (const c of WAVE_COMPS) h += c.a * Math.sin(c.k * (c.dx * x + c.dz * z) - c.w * t + c.ph);
  return h;
}

const f6 = (n) => n.toFixed(6);
const waveGLSL =
  'vec3 waveHG(vec2 p, float t){\n  float h=0.0; float gx=0.0; float gz=0.0;\n' +
  WAVE_COMPS.map(
    (c) =>
      `  { float th = ${f6(c.k)}*(${f6(c.dx)}*p.x + ${f6(c.dz)}*p.y) - ${f6(c.w)}*t + ${f6(c.ph)};` +
      ` h += ${f6(c.a)}*sin(th); float cq = ${f6(c.a * c.k)}*cos(th); gx += cq*${f6(c.dx)}; gz += cq*${f6(c.dz)}; }`
  ).join('\n') +
  '\n  return vec3(h, gx, gz);\n}';

// --- 调色板:暖(落日)/ 冷(暮蓝)端点,渲染期按 toneMix lerp -------------------
// 注意:ShaderMaterial 输出不经过 three 的输出编码,这里直接按显示(sRGB)值调色。
const v3 = (r, g, b) => new THREE.Vector3(r, g, b);
const PALETTE = {
  warm: {
    zenith: v3(0.26, 0.21, 0.36), horizon: v3(1.0, 0.52, 0.18),
    sun: v3(1.0, 0.86, 0.58), halo: v3(1.0, 0.46, 0.13), haze: v3(0.88, 0.46, 0.21),
    seaDeep: v3(0.075, 0.075, 0.095), seaCrest: v3(0.36, 0.22, 0.11),
    skyRef: v3(0.95, 0.55, 0.26), streak: v3(1.0, 0.72, 0.3),
    sunLight: new THREE.Color(1.0, 0.62, 0.32), hemiSky: new THREE.Color(1.0, 0.74, 0.48),
    hemiGround: new THREE.Color(0.16, 0.11, 0.07), lightIntensity: 2.5, hemiIntensity: 0.8,
    sunElev: 9,
  },
  cool: {
    zenith: v3(0.02, 0.035, 0.11), horizon: v3(0.33, 0.4, 0.7),
    sun: v3(0.93, 0.96, 1.0), halo: v3(0.42, 0.56, 0.95), haze: v3(0.2, 0.26, 0.5),
    seaDeep: v3(0.012, 0.028, 0.07), seaCrest: v3(0.07, 0.13, 0.28),
    skyRef: v3(0.3, 0.38, 0.68), streak: v3(0.62, 0.76, 1.0),
    sunLight: new THREE.Color(0.62, 0.72, 1.0), hemiSky: new THREE.Color(0.42, 0.52, 0.85),
    hemiGround: new THREE.Color(0.02, 0.03, 0.07), lightIntensity: 1.6, hemiIntensity: 0.55,
    sunElev: 13, // 冷端月亮低悬于海平线上,保持天体与高光带同框
  },
};
const SUN_AZ = 230; // 太阳/月亮方位角(度),初始相机 35° 视轴 215° → 太阳居中偏侧

// --- 天空:渐变天穹 + 日/月光盘与光晕(BackSide 大球,单 pass) ------------------
const skyUniforms = {
  uSunDir: { value: sunDir },
  uZenith: { value: new THREE.Vector3() },
  uHorizon: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Vector3() },
  uHalo: { value: new THREE.Vector3() },
  uHaze: { value: new THREE.Vector3() },
};
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uSunDir, uZenith, uHorizon, uSunColor, uHalo, uHaze;
    varying vec3 vWorldPos;
    void main() {
      vec3 dir = normalize(vWorldPos - cameraPosition);
      float h = clamp(dir.y, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(h, 0.5));
      float s = max(dot(dir, uSunDir), 0.0);
      col += uHalo * (pow(s, 20.0) * 0.55 + pow(s, 5.0) * 0.20);
      col += uSunColor * smoothstep(0.99930, 0.99965, s);
      col = mix(col, uHaze, 1.0 - smoothstep(-0.06, 0.02, dir.y));
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(700, 48, 24), skyMat);
scene.add(skyMesh);

// --- 海面:程序化动态波浪曲面(中心密、远处疏的弯折网格) ------------------------
const SEA_N = 144;   // (145)^2 = 21025 顶点 >= 2000
const SEA_EXT = 240; // 半径(世界单位)
const seaUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: sunDir },
  uSeaDeep: { value: new THREE.Vector3() },
  uSeaCrest: { value: new THREE.Vector3() },
  uSkyRef: { value: new THREE.Vector3() },
  uStreak: { value: new THREE.Vector3() },
  uHaze: { value: new THREE.Vector3() },
};
const seaVert = `
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vNormal;
${waveGLSL}
void main() {
  vec3 pos = position;
  vec3 hg = waveHG(pos.xz, uTime);
  pos.y = hg.x;
  vNormal = normalize(vec3(-hg.y, 1.0, -hg.z));
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;
const seaFrag = `
uniform vec3 uSeaDeep, uSeaCrest, uSkyRef, uStreak, uHaze, uSunDir;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vNormal);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  float crest = clamp(vWorldPos.y * 0.55 + 0.30, 0.0, 1.0);
  vec3 col = mix(uSeaDeep, uSeaCrest, crest);
  col = mix(col, uSkyRef, fres * 0.62);
  vec3 R = reflect(-V, N);
  float s = max(dot(R, uSunDir), 0.0);
  col += uStreak * (pow(s, 110.0) * 1.15 + pow(s, 12.0) * 0.28);
  float d = length(vWorldPos.xz - cameraPosition.xz);
  col = mix(col, uHaze, smoothstep(70.0, 236.0, d));
  gl_FragColor = vec4(col, 1.0);
}`;
const seaMat = new THREE.ShaderMaterial({ uniforms: seaUniforms, vertexShader: seaVert, fragmentShader: seaFrag, side: THREE.DoubleSide });

function buildSeaGeometry(n, ext) {
  // u ∈ [-1,1] 经 |u|^1.6 弯折:船附近顶点密度高,远处渐疏(近景波形平滑)
  const warp = (u) => Math.sign(u) * Math.pow(Math.abs(u), 1.6) * ext;
  const verts = new Float32Array((n + 1) * (n + 1) * 3);
  let p = 0;
  for (let iz = 0; iz <= n; iz++) {
    const z = warp((iz / n) * 2 - 1);
    for (let ix = 0; ix <= n; ix++) {
      verts[p++] = warp((ix / n) * 2 - 1);
      verts[p++] = 0;
      verts[p++] = z;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let q = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iz * (n + 1) + ix;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

let seaMesh = null;
function buildSea() {
  seaMesh = new THREE.Mesh(buildSeaGeometry(SEA_N, SEA_EXT), seaMat);
  seaMesh.frustumCulled = false; // 顶点在 GPU 侧位移,避免包围盒误剔除
  scene.add(seaMesh);
}

// --- 递归释放一个子树的所有 GPU 侧资源(reset 释放语义) -------------------------
function disposeTree(root) {
  root.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine) {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}

// --- 船体:运行时真实网络加载 assets/boat.glb,保留内嵌 PBR 材质 -----------------
const loader = new GLTFLoader();
let boatGroup = null;      // wrap:随波刚体(位置/姿态由波形驱动)
let boatCenterLocal = null; // 包围盒中心(wrap 本地系)
let assetLoaded = false;
let assetRequests = 0;
let loadToken = 0;
const BOAT_HEADING = 0.55;
const BOAT_DRAFT = -0.02;  // 静水时船底近贴水面,保证波谷中船体仍完整可辨

const statusEl = document.createElement('div');
statusEl.id = 'status';
statusEl.style.cssText =
  'position:fixed;left:10px;bottom:8px;z-index:9999;font:12px/1.4 sans-serif;' +
  'color:#ddd;background:rgba(0,0,0,.45);padding:3px 8px;border-radius:4px;max-width:60vw';
statusEl.textContent = 'Loading assets/boat.glb ...';
document.body.appendChild(statusEl);
function showStatus(msg, isError) {
  statusEl.style.display = 'block';
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff9a8a' : '#ddd';
}
function hideStatus() { statusEl.style.display = 'none'; }

function attachBoat(gltf) {
  const inner = gltf.scene;
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = 3.0 / maxDim; // 归一到 ~3.0 单位(契约 1–4),兼顾画面中船体可辨
  inner.scale.setScalar(s);
  inner.position.y -= box.min.y * s; // 船底落到 wrap 原点
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.rotation.y = BOAT_HEADING;
  wrap.position.y = BOAT_DRAFT;
  scene.add(wrap);
  const wbox = new THREE.Box3().setFromObject(wrap);
  boatCenterLocal = wrap.worldToLocal(wbox.getCenter(new THREE.Vector3()));
  boatGroup = wrap;
  assetLoaded = true;
  assetRequests += 1;
}

function loadBoat() {
  const token = loadToken;
  loader.load(
    BOAT_URL,
    (gltf) => {
      if (token !== loadToken) { disposeTree(gltf.scene); return; } // 过期响应:直接丢弃
      try { attachBoat(gltf); } catch (e) { showStatus('boat attach failed: ' + (e && e.message), true); }
    },
    undefined,
    (err) => {
      if (token !== loadToken) return;
      // 可见错误提示,不抛未捕获异常(资产加载失败契约)
      showStatus('Failed to load assets/boat.glb: ' + (err && err.message ? err.message : err), true);
    }
  );
}

// --- 色调切换:2.0s smoothstep 过渡(<= 2.5s) ---------------------------------
const TONE_DUR = 2.0;
let toneMix = 0, toneFrom = 0, toneTo = 0, toneT = TONE_DUR;
const smooth01 = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
function setToneTarget(v) { toneFrom = toneMix; toneTo = v; toneT = 0; }
function updateTone(dt) {
  if (toneT < TONE_DUR) {
    toneT = Math.min(TONE_DUR, toneT + dt);
    toneMix = toneFrom + (toneTo - toneFrom) * smooth01(toneT / TONE_DUR);
  }
}

// --- 环境随 toneMix 演变(天空/海面 uniform + 灯光 + 日月方向) -------------------
function updateEnv() {
  const t = toneMix;
  const W = PALETTE.warm, C = PALETTE.cool;
  skyUniforms.uZenith.value.lerpVectors(W.zenith, C.zenith, t);
  skyUniforms.uHorizon.value.lerpVectors(W.horizon, C.horizon, t);
  skyUniforms.uSunColor.value.lerpVectors(W.sun, C.sun, t);
  skyUniforms.uHalo.value.lerpVectors(W.halo, C.halo, t);
  skyUniforms.uHaze.value.lerpVectors(W.haze, C.haze, t);
  seaUniforms.uSeaDeep.value.lerpVectors(W.seaDeep, C.seaDeep, t);
  seaUniforms.uSeaCrest.value.lerpVectors(W.seaCrest, C.seaCrest, t);
  seaUniforms.uSkyRef.value.lerpVectors(W.skyRef, C.skyRef, t);
  seaUniforms.uStreak.value.lerpVectors(W.streak, C.streak, t);
  seaUniforms.uHaze.value.lerpVectors(W.haze, C.haze, t);
  const elev = (W.sunElev + (C.sunElev - W.sunElev) * t) * DEG;
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, SUN_AZ * DEG);
  dirLight.color.lerpColors(W.sunLight, C.sunLight, t);
  dirLight.intensity = W.lightIntensity + (C.lightIntensity - W.lightIntensity) * t;
  dirLight.position.copy(sunDir).multiplyScalar(80);
  hemiLight.color.lerpColors(W.hemiSky, C.hemiSky, t);
  hemiLight.groundColor.lerpColors(W.hemiGround, C.hemiGround, t);
  hemiLight.intensity = W.hemiIntensity + (C.hemiIntensity - W.hemiIntensity) * t;
}

// --- 相机:方位角限速追踪(拖拽只改目标角) --------------------------------------
const CAM = { target: new THREE.Vector3(0, 1.3, 0), dist: 9.6, elev: 12, azCurrent: 35, azTarget: 35, azRate: 118 };
const normAz = () => ((CAM.azCurrent % 360) + 360) % 360;
function updateCamera(dt) {
  const gap = CAM.azTarget - CAM.azCurrent;
  if (Math.abs(gap) > 1e-6) {
    const rate = Math.min(Math.abs(gap) * 6, CAM.azRate); // 近目标比例减速,远端限速
    CAM.azCurrent += Math.sign(gap) * rate * dt;
    if ((gap > 0 && CAM.azCurrent > CAM.azTarget) || (gap < 0 && CAM.azCurrent < CAM.azTarget)) {
      CAM.azCurrent = CAM.azTarget;
    }
  }
  const az = CAM.azCurrent * DEG;
  const el = CAM.elev * DEG;
  camera.position.set(
    CAM.target.x + CAM.dist * Math.cos(el) * Math.sin(az),
    CAM.target.y + CAM.dist * Math.sin(el),
    CAM.target.z + CAM.dist * Math.cos(el) * Math.cos(az)
  );
  camera.lookAt(CAM.target);
}

// 拖拽环绕:水平位移 → 目标方位角(方向一致:右拖方位角增加)
let drag = null;
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => { drag = { id: e.pointerId, x: e.clientX }; });
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  CAM.azTarget += (e.clientX - drag.x) * 0.5; // 0.5°/px
  drag.x = e.clientX;
});
const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// --- 船体随波起伏:采样与海面同一 waveH(相位耦合),伴纵摇/横滚 -------------------
let pitchS = 0, rollS = 0;
const _tmpV = new THREE.Vector3();
function updateBoat(dt) {
  if (!boatGroup) return;
  const t = simTime;
  const h = waveH(0, 0, t);
  const L = 0.8;
  const pitchT = Math.atan((waveH(L, 0, t) - waveH(-L, 0, t)) / (2 * L)) * 0.85;
  const rollT = Math.atan((waveH(0, L, t) - waveH(0, -L, t)) / (2 * L)) * 0.85;
  const k = Math.min(1, dt * 6);
  pitchS += (pitchT - pitchS) * k;
  rollS += (rollT - rollS) * k;
  boatGroup.position.y = BOAT_DRAFT + h * 0.75;
  boatGroup.rotation.x = pitchS;
  boatGroup.rotation.z = rollS;
}
function boatPositionSample() {
  if (!boatGroup || !boatCenterLocal) return { x: 0, y: 0, z: 0 };
  _tmpV.copy(boatCenterLocal);
  boatGroup.localToWorld(_tmpV);
  return { x: r4(_tmpV.x), y: r4(_tmpV.y), z: r4(_tmpV.z) };
}

// --- bench 状态契约 -------------------------------------------------------------
const r4 = (v) => Math.round(v * 10000) / 10000;
let simTime = 0;
let epoch = 0;
let appReadyFlag = false;
const frameTimes = [];
function currentFps() {
  const n = frameTimes.length;
  if (n < 2) return 0;
  const span = (frameTimes[n - 1] - frameTimes[0]) / 1000;
  return span > 0 ? (n - 1) / span : 0;
}

function doReset() {
  epoch += 1;
  loadToken = epoch; // 作废在途加载
  if (boatGroup) { scene.remove(boatGroup); disposeTree(boatGroup); boatGroup = null; boatCenterLocal = null; }
  assetLoaded = false;
  if (seaMesh) {
    scene.remove(seaMesh);
    seaMesh.geometry.dispose(); // 几何(GPU 侧)显式释放
    seaMesh.material.dispose();
    seaMesh = null;
  }
  renderer.renderLists.dispose();
  simTime = 0; pitchS = 0; rollS = 0;
  toneMix = 0; toneFrom = 0; toneTo = 0; toneT = TONE_DUR;
  CAM.azCurrent = 35; CAM.azTarget = 35;
  buildSea();
  loadBoat();
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    assetLoaded,
    assetRequests,
    boatPosition: boatPositionSample(),
    wavePhase: r4(simTime),
    toneMix: r4(toneMix),
    cameraAzimuth: r4(normAz()),
    fps: r4(currentFps()),
    epoch,
  }),
  reset: doReset,
};

// 自检辅助:同步重渲染一帧后导出画布像素(供浏览器验证脚本做像素级断言)
window.__capture = () => {
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
};

// --- UI 控件(data-ui 定位约定) -------------------------------------------------
function makeButton(text, dataUi, aria, cssText) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.setAttribute('data-ui', dataUi);
  btn.setAttribute('aria-label', aria);
  btn.style.cssText = cssText;
  document.body.appendChild(btn);
  return btn;
}
const baseBtn =
  'position:fixed;top:8px;z-index:9999;padding:4px 12px;font:12px sans-serif;' +
  'background:rgba(20,20,26,.8);color:#fff;border:1px solid #666;border-radius:4px;cursor:pointer';
const toneBtn = makeButton('Tone: Sunset 落日', 'tone-toggle', 'tone-toggle warm sunset',
  baseBtn + ';left:8px');
const resetBtn = makeButton('Reset', 'reset', 'reset', baseBtn + ';right:8px');
toneBtn.addEventListener('click', () => {
  const next = toneTo < 0.5 ? 1 : 0;
  setToneTarget(next);
  toneBtn.textContent = next === 1 ? 'Tone: Dusk 暮蓝' : 'Tone: Sunset 落日';
});
resetBtn.addEventListener('click', () => doReset());

// --- 初始构建与主循环 -------------------------------------------------------------
buildSea();
loadBoat();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05); // 后台节流恢复后不产生时间跳变
  simTime += dt;
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length > 2 && now - frameTimes[0] > 2000) frameTimes.shift();

  updateTone(dt);
  updateCamera(dt);
  updateEnv();
  updateBoat(dt);
  seaUniforms.uTime.value = simTime;

  renderer.render(scene, camera);
  if (!appReadyFlag && assetLoaded) {
    appReadyFlag = true;
    window.__appReady = true; // 资产加载完成且首帧渲染完成
    hideStatus();
  }
}
const clock = new THREE.Clock();
requestAnimationFrame(tick);
