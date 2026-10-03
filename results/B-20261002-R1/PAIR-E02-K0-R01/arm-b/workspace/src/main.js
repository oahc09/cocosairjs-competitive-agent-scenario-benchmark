// ============================================================================
// E02 — 落日海面与孤舟(three.js r186 / 0.186.1)
// ----------------------------------------------------------------------------
// 场景:运行时加载 assets/boat.glb(真实网络请求,保留资产材质),置于程序化
// 动态海面中央并随波起伏;鼠标水平拖拽环绕观察;暖(落日)↔ 冷(暮蓝)色调
// 平滑切换;Reset 释放并重建(船 + 海面 GPU 资源显式 dispose)。
//
// 波形:5 个重力行进波的叠加(相位 k*(d·p) - w*t,波峰沿风向推进)。
// 同一组波参数同时驱动:GPU 海面顶点位移(带随距离的高频衰减)与 CPU 船体
// 采样(boat 位于原点,衰减=1,与 GPU 完全一致 → 相位耦合)。
//
// 页面契约:
//   window.__appReady — 资产加载完成且含船体的首帧渲染后置 true
//   window.__bench    — { getState(): object, reset(): void }
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- 常量 ---------------------------------------------------------------------
const D2R = Math.PI / 180;
const ASSET_URL = 'assets/boat.glb';

const INITIAL_AZ = 35; // 度,相机初始方位角
const INITIAL_EL = 10; // 度,相机俯角(仰角)
const CAM_RADIUS = 9;
const CAM_TARGET = new THREE.Vector3(0, 1.4, 0); // 略高于水面,使船体居中偏下
const CAM_SMOOTH = 1.5; // 方位/俯角指数平滑系数(1/s),逐帧插值无跳变
const DRAG_AZ_PER_WIDTH = 800; // 拖拽满视口宽度的方位角变化(度)
const DRAG_EL_PER_HEIGHT = 26; // 拖拽满视口高度的俯角微调(度)
const EL_MIN = 4, EL_MAX = 30;

const BOAT_YAW = 0.65; // 船体系朝向,构图好看即可
const TONE_DURATION_MS = 2000; // 暖冷切换过渡时长(< 2.5s)

// --- 波参数(CPU/GPU 共用同一组数据)------------------------------------------
// dir 未归一化;len 为波长;speed 为相速度(单位/秒);w = k * speed
const WAVE_DEFS = [
  { dx: 1.0, dz: 0.35, amp: 0.21, len: 18.0, speed: 1.05 },
  { dx: 0.82, dz: -0.57, amp: 0.13, len: 11.0, speed: 1.1 },
  { dx: -0.42, dz: 0.91, amp: 0.075, len: 6.4, speed: 1.2 },
  { dx: 0.33, dz: 0.94, amp: 0.045, len: 4.0, speed: 1.35 },
  { dx: -0.88, dz: -0.35, amp: 0.024, len: 2.6, speed: 1.5 },
];
const WAVES = WAVE_DEFS.map((w) => {
  const l = Math.hypot(w.dx, w.dz);
  const k = (2 * Math.PI) / w.len;
  return {
    dx: w.dx / l,
    dz: w.dz / l,
    amp: w.amp,
    k,
    w: k * w.speed,
  };
});
const TOTAL_AMP = WAVES.reduce((s, w) => s + w.amp, 0);

// CPU 波高采样(船体所在,原点附近,无距离衰减 → 与 GPU 在中心处一致)
function waveHeight(x, z, t) {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t);
  }
  return h;
}

// GLSL 波形展开(顶点位移 + 解析法线;高频波随距离衰减,近密远疏)
const glslWaveChunk = WAVES.map((w) => {
  const att = `exp(-d * ${w.k.toFixed(6)} * 0.03) * fade`;
  return [
    `  ph = ${w.k.toFixed(6)} * (${w.dx.toFixed(6)} * px + ${w.dz.toFixed(6)} * pz) - ${w.w.toFixed(6)} * uTime;`,
    `  att = ${att};`,
    `  h += ${w.amp.toFixed(6)} * att * sin(ph);`,
    `  ddx += ${(w.amp * w.k * w.dx).toFixed(6)} * att * cos(ph);`,
    `  ddz += ${(w.amp * w.k * w.dz).toFixed(6)} * att * cos(ph);`,
  ].join('\n');
}).join('\n');

// --- 渲染器 / 场景 / 相机 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
canvas.style.touchAction = 'none';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 仅作用于内置材质(船体)
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  4000
);

// --- 光照(暖 ↔ 冷两端插值;作用于 GLTF 船体)--------------------------------
const sunLight = new THREE.DirectionalLight(0xffffff, 3.6);
scene.add(sunLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
scene.add(fillLight);
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, 0.85);
scene.add(hemiLight);

const TONE_LIGHTS = {
  warm: {
    sun: new THREE.Color(0xffb469), fill: new THREE.Color(0x6a5a8a),
    hemiSky: new THREE.Color(0x8a6f9a), hemiGnd: new THREE.Color(0x5a3d2e),
    sunI: 3.6, fillI: 0.55, hemiI: 0.85,
  },
  cool: {
    sun: new THREE.Color(0xa9c2ff), fill: new THREE.Color(0x1c2a44),
    hemiSky: new THREE.Color(0x2c3a5e), hemiGnd: new THREE.Color(0x0e1622),
    sunI: 2.6, fillI: 0.4, hemiI: 0.7,
  },
};

// 太阳/月亮方向(世界系;与相机初始方位 35° 相对构图:光盘位于中轴附近偏侧)
function dirFromAzEl(azDeg, elDeg) {
  const a = azDeg * D2R, e = elDeg * D2R;
  return new THREE.Vector3(
    Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)
  );
}
const SUN_DIR_WARM = dirFromAzEl(204, 9); // 落日:低角度
const SUN_DIR_COOL = dirFromAzEl(210, 15); // 月亮:略高
const sunDirCur = SUN_DIR_WARM.clone();
const _tmpColor = new THREE.Color();

// --- 天空:渐变天穹 + 光盘与光晕(uTone 在 shader 内混色)----------------------
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FRAG = /* glsl */`
precision highp float;
uniform float uTone;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 zen = mix(vec3(0.365, 0.271, 0.478), vec3(0.027, 0.051, 0.125), uTone);
  vec3 mid = mix(vec3(0.831, 0.463, 0.231), vec3(0.153, 0.251, 0.431), uTone);
  vec3 hor = mix(vec3(1.000, 0.757, 0.471), vec3(0.365, 0.482, 0.651), uTone);
  vec3 sunC = mix(vec3(1.000, 0.945, 0.769), vec3(0.902, 0.941, 1.000), uTone);
  vec3 col;
  float y = dir.y;
  if (y >= 0.0) {
    col = mix(hor, mid, smoothstep(0.0, 0.16, y));
    col = mix(col, zen, smoothstep(0.12, 0.55, y));
  } else {
    col = mix(hor, hor * 0.62, smoothstep(0.0, 0.2, -y));
  }
  float cd = dot(dir, normalize(uSunDir));
  float mcd = max(cd, 0.0);
  float glow = pow(mcd, 8.0) * 0.16 + pow(mcd, 48.0) * 0.30 + pow(mcd, 300.0) * 0.5;
  float disc = smoothstep(0.99930, 0.99960, cd);
  col += sunC * glow;
  col += sunC * disc * 1.4;
  gl_FragColor = vec4(col, 1.0);
}`;

const skyMat = new THREE.ShaderMaterial({
  vertexShader: SKY_VERT,
  fragmentShader: SKY_FRAG,
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTone: { value: 0 },
    uSunDir: { value: sunDirCur },
  },
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1600, 48, 24), skyMat);
scene.add(skyMesh);

// --- 海面:程序化波浪网格(中心密、远处疏;顶点数 >= 2000)--------------------
const SEA_VERT = /* glsl */`
precision highp float;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vDistFog;
varying float vRelH;
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  float px = p.x;
  float pz = p.z;
  float d = length(vec2(px, pz));
  float fade = 1.0 - smoothstep(180.0, 320.0, d);
  float ph;
  float att;
  float h = 0.0;
  float ddx = 0.0;
  float ddz = 0.0;
${glslWaveChunk}
  p.y = h;
  vRelH = h / ${TOTAL_AMP.toFixed(6)};
  vNrm = normalize(vec3(-ddx, 1.0, -ddz));
  vWorld = p;
  vDistFog = d;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SEA_FRAG = /* glsl */`
precision highp float;
uniform float uTone;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vDistFog;
varying float vRelH;
void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 L = normalize(uSunDir);
  vec3 deep = mix(vec3(0.180, 0.300, 0.320), vec3(0.040, 0.100, 0.180), uTone);
  vec3 refl = mix(vec3(0.878, 0.541, 0.322), vec3(0.208, 0.341, 0.498), uTone);
  vec3 spec = mix(vec3(1.000, 0.851, 0.627), vec3(0.741, 0.839, 1.000), uTone);
  vec3 hor  = mix(vec3(0.949, 0.643, 0.373), vec3(0.290, 0.384, 0.533), uTone);
  float ndl = max(dot(N, L), 0.0);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 2.5);
  vec3 col = deep * (0.50 + 0.50 * ndl);
  col = mix(col, refl * (0.72 + 0.28 * ndl), clamp(0.22 + 0.78 * fres, 0.0, 1.0));
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  col += spec * pow(ndh, 200.0) * 2.6;  // 太阳/月亮镜面高光带
  col += spec * pow(ndh, 28.0) * 0.14;  // 宽光晕
  float foam = smoothstep(0.52, 0.90, vRelH) * (1.0 - smoothstep(0.35, 0.75, uTone));
  col = mix(col, vec3(0.980, 0.930, 0.860), foam * 0.22);
  col = mix(col, hor, smoothstep(90.0, 380.0, vDistFog)); // 远处融入海平线
  gl_FragColor = vec4(col, 1.0);
}`;

function buildSeaGeometry(seg, half, exp) {
  // 均匀网格 + 幂映射:近处网格密(细节波),远处疏(只剩长波)
  const verts = (seg + 1) * (seg + 1);
  const pos = new Float32Array(verts * 3);
  const idx = new Uint32Array(seg * seg * 6);
  const curve = (u) => Math.sign(u) * Math.pow(Math.abs(u), exp) * half;
  let p = 0;
  for (let j = 0; j <= seg; j++) {
    const z = curve((j / seg) * 2 - 1);
    for (let i = 0; i <= seg; i++) {
      pos[p++] = curve((i / seg) * 2 - 1);
      pos[p++] = 0;
      pos[p++] = z;
    }
  }
  let q = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

let seaMesh = null;
function buildSea() {
  const geo = buildSeaGeometry(176, 600, 2.4); // 177*177 = 31329 顶点 >= 2000
  const mat = new THREE.ShaderMaterial({
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uTone: { value: toneMix },
      uSunDir: { value: sunDirCur },
      uCamPos: { value: new THREE.Vector3() },
    },
  });
  seaMesh = new THREE.Mesh(geo, mat);
  seaMesh.frustumCulled = false; // 顶点在 GPU 位移,包围盒不适用
  scene.add(seaMesh);
}
function disposeSea() {
  if (!seaMesh) return;
  scene.remove(seaMesh);
  seaMesh.geometry.dispose();
  seaMesh.material.dispose(); // 显式释放 GPU 侧资源
  seaMesh = null;
}

// --- 孤舟:运行时 GLB 加载(真实网络请求,材质保留)---------------------------
const gltfLoader = new GLTFLoader();
let boatGroup = null; // 装载 GLB 场景的组
let boatCenterOffY = 0; // 包围盒中心相对组原点的 y 偏移
let assetLoaded = false;
let assetRequests = 0;
let loadToken = 0;

function loadBoat(token) {
  gltfLoader.load(
    ASSET_URL,
    (gltf) => {
      if (token !== loadToken) return; // 过期加载(reset 期间)丢弃
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.y = -box.min.y + 0.16; // 吃水:船底略没入水面
      boatCenterOffY = center.y + model.position.y;
      const group = new THREE.Group();
      group.rotation.order = 'YXZ';
      group.rotation.y = BOAT_YAW;
      group.add(model);
      scene.add(group);
      boatGroup = group;
      assetLoaded = true;
      assetRequests += 1;
      hideLoading();
    },
    undefined,
    (err) => {
      if (token !== loadToken) return;
      showLoadError(err);
    }
  );
}
function disposeBoat() {
  if (!boatGroup) return;
  scene.remove(boatGroup);
  boatGroup.traverse((o) => {
    if (o.isMesh) {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
  boatGroup = null;
  assetLoaded = false;
}

// --- UI 覆盖层 ----------------------------------------------------------------
function makeButton(label, uiId, corner) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.setAttribute('data-ui', uiId);
  btn.setAttribute('aria-label', uiId);
  btn.style.cssText =
    `position:fixed;top:10px;${corner}:10px;z-index:9999;padding:6px 16px;` +
    "font:13px/1.4 sans-serif;background:rgba(20,22,30,0.72);color:#fff;" +
    'border:1px solid rgba(255,255,255,0.45);border-radius:6px;cursor:pointer;';
  document.body.appendChild(btn);
  return btn;
}
const toneBtn = makeButton('Tone 色调', 'tone-toggle', 'left');
const resetBtn = makeButton('Reset', 'reset', 'right');

const loadingDiv = document.createElement('div');
loadingDiv.textContent = 'Loading assets/boat.glb ...';
loadingDiv.setAttribute('data-ui', 'loading');
loadingDiv.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9998;' +
  "font:13px sans-serif;color:#fff;background:rgba(0,0,0,0.55);padding:8px 16px;" +
  'border-radius:6px;pointer-events:none;';
document.body.appendChild(loadingDiv);
function hideLoading() { loadingDiv.style.display = 'none'; }
function showLoadError(err) {
  loadingDiv.style.display = 'block';
  loadingDiv.textContent = 'Error: failed to load assets/boat.glb (' + String(err && err.message ? err.message : err) + ')';
  loadingDiv.style.color = '#ff9a9a';
}

// --- 状态(探针读取)----------------------------------------------------------
let simTime = 0; // 波形模拟时间(wavePhase 口径,单调递增;reset 归零)
let epoch = 0;
let toneMix = 0; // 0=暖,1=冷
let toneTarget = 0;
let toneTweenFrom = 0;
let toneTweenStart = 0;
let toneTweening = false;
let az = INITIAL_AZ, azTarget = INITIAL_AZ; // 方位角(度)
let el = INITIAL_EL, elTarget = INITIAL_EL;
let smPitch = 0, smRoll = 0;
const frameTimes = [];
let readyDone = false;

toneBtn.addEventListener('click', () => {
  toneTarget = toneTarget > 0.5 ? 0 : 1;
  toneTweenFrom = toneMix;
  toneTweenStart = performance.now();
  toneTweening = true;
});

resetBtn.addEventListener('click', () => doReset());

function doReset() {
  epoch += 1;
  loadToken += 1; // 使在途加载过期
  // 恢复初始状态(色调/方位角/俯角/模拟时间)
  toneMix = 0; toneTarget = 0; toneTweening = false;
  az = INITIAL_AZ; azTarget = INITIAL_AZ;
  el = INITIAL_EL; elTarget = INITIAL_EL;
  smPitch = 0; smRoll = 0;
  simTime = 0;
  // 释放并重建:船与海面的渲染资源显式 dispose 后重建
  disposeBoat();
  disposeSea();
  buildSea();
  loadBoat(loadToken);
}

// --- 指针拖拽:水平 → 方位角,垂直 → 俯角微调 --------------------------------
let dragging = false, dragId = null, lastPX = 0, lastPY = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (dragId !== null) return;
  dragId = e.pointerId;
  dragging = true;
  lastPX = e.clientX;
  lastPY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragId) return;
  const dx = e.clientX - lastPX;
  const dy = e.clientY - lastPY;
  lastPX = e.clientX;
  lastPY = e.clientY;
  azTarget += (dx / window.innerWidth) * DRAG_AZ_PER_WIDTH;
  elTarget = Math.min(EL_MAX, Math.max(EL_MIN, elTarget + (dy / window.innerHeight) * DRAG_EL_PER_HEIGHT));
});
function endDrag(e) {
  if (e.pointerId !== dragId) return;
  dragging = false;
  dragId = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// --- __bench 契约 ---------------------------------------------------------------
window.__bench = {
  getState: () => ({
    engine: 'three',
    assetLoaded,
    assetRequests,
    boatPosition: {
      x: 0,
      y: boatGroup ? boatGroup.position.y + boatCenterOffY : 0,
      z: 0,
    },
    wavePhase: simTime,
    toneMix,
    cameraAzimuth: az,
    fps: frameTimes.length >= 2 ? frameTimes.length / 2 : 0,
    epoch,
  }),
  reset: doReset,
};

// --- 相机与每帧更新 ------------------------------------------------------------
function updateCamera(dt) {
  const t = 1 - Math.exp(-CAM_SMOOTH * dt);
  az += (azTarget - az) * t;
  el += (elTarget - el) * t;
  const a = az * D2R, e = el * D2R;
  camera.position.set(
    CAM_TARGET.x + Math.sin(a) * Math.cos(e) * CAM_RADIUS,
    CAM_TARGET.y + Math.sin(e) * CAM_RADIUS,
    CAM_TARGET.z + Math.cos(a) * Math.cos(e) * CAM_RADIUS
  );
  camera.lookAt(CAM_TARGET);
}

function updateTone(nowMs, dt) {
  if (toneTweening) {
    const p = Math.min(1, (nowMs - toneTweenStart) / TONE_DURATION_MS);
    const s = p * p * (3 - 2 * p);
    toneMix = toneTweenFrom + (toneTarget - toneTweenFrom) * s;
    if (p >= 1) toneTweening = false;
  } else {
    toneMix = toneTarget;
  }
  // 光盘方向与光照插值(天空/海面/船体同时演变)
  sunDirCur.copy(SUN_DIR_WARM).lerp(SUN_DIR_COOL, toneMix).normalize();
  skyMat.uniforms.uTone.value = toneMix;
  if (seaMesh) {
    seaMesh.material.uniforms.uTone.value = toneMix;
    seaMesh.material.uniforms.uTime.value = simTime;
    seaMesh.material.uniforms.uCamPos.value.copy(camera.position);
  }
  const { warm, cool } = TONE_LIGHTS;
  sunLight.color.copy(_tmpColor.copy(warm.sun).lerp(cool.sun, toneMix));
  sunLight.intensity = warm.sunI + (cool.sunI - warm.sunI) * toneMix;
  sunLight.position.copy(sunDirCur).multiplyScalar(50);
  fillLight.color.copy(_tmpColor.copy(warm.fill).lerp(cool.fill, toneMix));
  fillLight.intensity = warm.fillI + (cool.fillI - warm.fillI) * toneMix;
  fillLight.position.copy(sunDirCur).multiplyScalar(-30).setY(24);
  hemiLight.color.copy(_tmpColor.copy(warm.hemiSky).lerp(cool.hemiSky, toneMix));
  hemiLight.groundColor.copy(_tmpColor.copy(warm.hemiGnd).lerp(cool.hemiGnd, toneMix));
  hemiLight.intensity = warm.hemiI + (cool.hemiI - warm.hemiI) * toneMix;
}

function updateBoat(dt) {
  if (!boatGroup) return;
  // 与海面同一波形函数采样(相位耦合);纵摇/横摇来自波面坡度
  const h = waveHeight(0, 0, simTime);
  boatGroup.position.y = h;
  const d = 0.9;
  const hx1 = waveHeight(d, 0, simTime), hx0 = waveHeight(-d, 0, simTime);
  const hz1 = waveHeight(0, d, simTime), hz0 = waveHeight(0, -d, simTime);
  const pitch = Math.atan2(hz1 - hz0, 2 * d) * 0.55;
  const roll = Math.atan2(hx1 - hx0, 2 * d) * 0.5;
  const s = Math.min(1, dt * 6);
  smPitch += (pitch - smPitch) * s;
  smRoll += (roll - smRoll) * s;
  boatGroup.rotation.x = smPitch;
  boatGroup.rotation.z = smRoll;
}

// --- 主循环 ---------------------------------------------------------------------
let lastNow = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  if (dt > 0.1) dt = 0.1; // 后台节流/恢复:时钟增量步进并钳制
  simTime += dt;

  updateCamera(dt);
  updateTone(now, dt);
  updateBoat(dt);

  renderer.render(scene, camera);

  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();

  if (!readyDone && assetLoaded) {
    window.__appReady = true; // 含船体的首帧已渲染
    readyDone = true;
  }
}

// --- 启动 -------------------------------------------------------------------------
buildSea();
loadBoat(loadToken);
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
