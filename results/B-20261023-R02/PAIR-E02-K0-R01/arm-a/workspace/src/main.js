// ============================================================================
// E02 — 落日海面与孤舟(three.js 0.186.1 / K0)
// ----------------------------------------------------------------------------
// 页面契约:
//   window.__appReady — 资产加载完成且首帧渲染后置 true
//   window.__bench    — { getState(): object, reset(): void }
// getState 字段:assetLoaded / assetRequests / boatPosition / wavePhase /
//               toneMix / cameraAzimuth / fps / epoch(spec.json stateContract)
// 实现要点:
//   - assets/boat.glb 运行时经 GLTFLoader 真实网络请求加载(不内联、不转译)
//   - 海面 = 单一事实源波形参数:CPU(JS)与 GPU(GLSL)共用同一组常数,
//     船体起伏直接采样同一海面函数(相位耦合,brief §8)
//   - 相机环绕 = 恒速 slew 跟随拖拽目标(逐帧平滑、无跳变)
//   - toneMix 驱动天空/海面着色器与方向光/半球光同时演变(暖金 ↔ 暮蓝)
//   - reset = 显式 dispose 船与海的 GPU 资源后重建并重新发起资产请求
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- 冻结初始参数 ----------
const BOAT_URL = 'assets/boat.glb'; // 相对页面根,dev server 根 = workspace
const CAM_AZ0 = 35;                 // 度,spec:cameraAzimuth 初始 35
const CAM_EL0 = 12;                 // 俯角(度):海面占画面 ≥50%、海平线约上 1/3
const CAM_DIST = 9;
const CAM_FOV = 50;
const CAM_TARGET = new THREE.Vector3(0, 0.5, 0);
const AZ_SENS = 0.75;               // 拖拽灵敏度:度/px
const AZ_SLEW = 125;                // 方位角恒速追随上限:度/s(保证拖后仍持续平滑运动)
const EL_SENS = 0.22;               // 俯角微调灵敏度
const TONE_RATE = 2.5;              // toneMix 指数趋近速率(1/s):2.5s 后 ≈0.998

// ---------- 波形参数(单一事实源:JS 数组 → 同时生成 CPU 函数与 GLSL 片段) ----------
const WAVES = [
  { A: 0.150, L: 7.5, dir: 8, off: 0.0 },
  { A: 0.085, L: 3.7, dir: 34, off: 1.7 },
  { A: 0.045, L: 1.95, dir: -22, off: 4.1 },
  { A: 0.022, L: 2.6, dir: 57, off: 2.3 },
];
const GRAVITY = 9.81;
const WC = WAVES.map((w) => {
  const k = (Math.PI * 2) / w.L;          // 波数
  const om = Math.sqrt(GRAVITY * k);      // 深水重力波色散关系 → 行进波
  const r = (w.dir * Math.PI) / 180;      // 传播方向(XZ 平面)
  return { ...w, k, om, dx: Math.cos(r), dz: Math.sin(r) };
});

// CPU 采样:与顶点着色器完全同参的海面高度(船体相位耦合的依据)
function seaHeight(x, z, t) {
  let h = 0;
  for (const c of WC) h += c.A * Math.sin(c.k * (x * c.dx + z * c.dz) - c.om * t + c.off);
  return h;
}

// 由同一 WC 数组生成 GLSL(数值以字面量注入,杜绝两套常数漂移)
const glslSin = (c) => `sin(${c.k.toFixed(6)}*(p.x*${c.dx.toFixed(6)}+p.z*${c.dz.toFixed(6)})-${c.om.toFixed(6)}*uTime+${c.off.toFixed(6)})`;
const GLSL_H = WC.map((c) => `  h += ${c.A.toFixed(6)}*${glslSin(c)};`).join('\n');
const GLSL_DX = WC.map((c) => `  dhx += ${(c.A * c.k * c.dx).toFixed(6)}*cos(${c.k.toFixed(6)}*(p.x*${c.dx.toFixed(6)}+p.z*${c.dz.toFixed(6)})-${c.om.toFixed(6)}*uTime+${c.off.toFixed(6)});`).join('\n');
const GLSL_DZ = WC.map((c) => `  dhz += ${(c.A * c.k * c.dz).toFixed(6)}*cos(${c.k.toFixed(6)}*(p.x*${c.dx.toFixed(6)}+p.z*${c.dz.toFixed(6)})-${c.om.toFixed(6)}*uTime+${c.off.toFixed(6)});`).join('\n');

// ---------- 调色板(暖端 W / 冷端 C,均按显示色即 sRGB 直出) ----------
const PAL = {
  skyZenW: new THREE.Color(0x2c4a80), skyZenC: new THREE.Color(0x0a1838),
  skyHorW: new THREE.Color(0xff9a52), skyHorC: new THREE.Color(0x3d5e9e),
  discW: new THREE.Color(0xffedb8), discC: new THREE.Color(0xe8f0ff),
  seaDeepW: new THREE.Color(0x0e3350), seaDeepC: new THREE.Color(0x0a2246),
  seaCrestW: new THREE.Color(0x2e7c99), seaCrestC: new THREE.Color(0x3f78b8),
  specW: new THREE.Color(0xffbe6e), specC: new THREE.Color(0xbdd4ff),
  dirW: new THREE.Color(0xffd9a3), dirC: new THREE.Color(0x9fbcff),
  hemiSkyW: new THREE.Color(0x9a86b8), hemiSkyC: new THREE.Color(0x33497a),
  hemiGndW: new THREE.Color(0x40342c), hemiGndC: new THREE.Color(0x12203c),
};

// 太阳/月亮方向:方位固定(初始相机视野中轴附近偏侧),仰角 7°(暖)→20°(冷)
const SUN_HX = -0.7071, SUN_HZ = -0.7071;
function sunDirection(toneMix) {
  const el = ((7 + 13 * toneMix) * Math.PI) / 180;
  return new THREE.Vector3(SUN_HX * Math.cos(el), Math.sin(el), SUN_HZ * Math.cos(el));
}

// ---------- 运行时状态 ----------
let simTime = 0;            // 模拟时间(s):wavePhase 的来源,单调递增
let toneMix = 0, toneTarget = 0;      // 0=暖(落日) 1=冷(暮蓝)
let az = CAM_AZ0, azTarget = CAM_AZ0; // 方位角(度),恒速 slew 跟随
let el = CAM_EL0, elTarget = CAM_EL0;
let epoch = 0;              // 释放重建计数
let assetLoaded = false;    // boat.glb 成功加载并实例化
let assetRequests = 0;      // 成功完成的 boat.glb 加载请求计数
let firstFrame = false;
let resetting = false, pendingReset = false;

const boatPos = { x: 0, y: 0, z: 0 };
let boatRoot = null;        // 船根节点(位置=随波起伏的参考点=包围盒中心)
const BOAT_HEADING = -0.5;  // 船头朝向(弧度),取 3/4 侧视角
const HEADING_FWD = { x: Math.cos(BOAT_HEADING), z: Math.sin(BOAT_HEADING) };
const HEADING_SIDE = { x: -Math.sin(BOAT_HEADING), z: Math.cos(BOAT_HEADING) };
let boatPitch = 0, boatRoll = 0; // 平滑后的纵摇/横摇

// ---------- 渲染器 / 场景 / 相机 ----------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAM_FOV, window.innerWidth / window.innerHeight, 0.1, 1500);

// ---------- 光照(随 toneMix 演变;作用于 GLB 标准材质 → 受光面/背光面对比) ----------
const sunLight = new THREE.DirectionalLight(0xffffff, 1.9);
scene.add(sunLight);
scene.add(sunLight.target);
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x223344, 0.55);
scene.add(hemiLight);

// ---------- 天空(渐变天穹 + 太阳/月亮光盘与光晕,随 toneMix 演变) ----------
const skyUniforms = {
  uToneMix: { value: 0 },
  uSunDir: { value: sunDirection(0) },
  uZenith: { value: PAL.skyZenW.clone() },
  uHorizon: { value: PAL.skyHorW.clone() },
  uDiscCol: { value: PAL.discW.clone() },
};
const skyMesh = new THREE.Mesh(
  new THREE.SphereGeometry(420, 32, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        // 天穹始终以相机为中心,保证任何环绕方位下地平线几何一致
        gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uToneMix;
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uDiscCol;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        // 渐变天穹:地平线色 → 天顶色
        float t = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(t, 0.55));
        // 光盘(暖=太阳较大 / 冷=月亮较小更锐)与色温光晕
        float s = dot(d, uSunDir);
        float discR = mix(0.038, 0.017, uToneMix);
        float disc = 1.0 - smoothstep(0.0, 1.0, clamp((cos(discR) - s) / 0.012, 0.0, 1.0));
        vec3 glowCol = mix(vec3(1.0, 0.62, 0.28), vec3(0.55, 0.65, 0.95), uToneMix);
        float glow = pow(max(s, 0.0), mix(24.0, 80.0, uToneMix));
        col += glowCol * glow * mix(0.55, 0.50, uToneMix);
        col = mix(col, uDiscCol, disc);
        // 地平线以下延续地平线色(被海面遮挡,仅接缝兜底)
        col = mix(uHorizon, col, smoothstep(-0.02, 0.01, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
);
scene.add(skyMesh);

// ---------- 海面(程序化行进重力波;几何顶点 171x171 = 29241 >= 2000) ----------
const seaUniforms = {
  uTime: { value: 0 },
  uToneMix: { value: 0 },
  uSunDir: { value: sunDirection(0) },
  uCamPos: { value: new THREE.Vector3() },
  uDeep: { value: PAL.seaDeepW.clone() },
  uCrest: { value: PAL.seaCrestW.clone() },
  uSpec: { value: PAL.specW.clone() },
  uHorizon: { value: PAL.skyHorW.clone() },
};
const SEA_SIZE = 130, SEA_SEGS = 170;
let seaMesh = null;
function buildSea() {
  const geo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, SEA_SEGS, SEA_SEGS);
  geo.rotateX(-Math.PI / 2); // XZ 平面、Y 向上
  const mat = new THREE.ShaderMaterial({
    uniforms: seaUniforms,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vWPos;
      varying vec3 vNormal;
      varying float vH;
      void main() {
        vec3 p = position;
        // 远处波幅衰减(层次化:近密远疏,同时消远处高频闪烁)
        float fade = 1.0 - smoothstep(24.0, 58.0, length(p.xz));
        float h = 0.0, dhx = 0.0, dhz = 0.0;
${GLSL_H}
${GLSL_DX}
${GLSL_DZ}
        h *= fade; dhx *= fade; dhz *= fade;
        p.y = h;
        vH = h;
        vNormal = normalize(vec3(-dhx, 1.0, -dhz));
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uToneMix;
      uniform vec3 uSunDir;
      uniform vec3 uCamPos;
      uniform vec3 uDeep;
      uniform vec3 uCrest;
      uniform vec3 uSpec;
      uniform vec3 uHorizon;
      varying vec3 vWPos;
      varying vec3 vNormal;
      varying float vH;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 V = normalize(uCamPos - vWPos);
        // 基色:深水体 ↔ 浪峰提亮(浪峰受光更充分)
        float crestMix = smoothstep(-0.12, 0.16, vH);
        vec3 col = mix(uDeep, uCrest, crestMix * 0.65);
        // 主光漫反射(浪面朝向太阳一侧更亮 → 明暗可辨)
        float diff = max(dot(n, uSunDir), 0.0);
        col *= 0.62 + 0.55 * diff;
        // 太阳/月光镜面高光带(经典 glitter path)
        vec3 R = reflect(-uSunDir, n);
        float spec = pow(max(dot(R, V), 0.0), 120.0);
        col += uSpec * spec * mix(1.6, 1.2, uToneMix);
        // 菲涅尔天空反射
        float fres = pow(1.0 - max(dot(V, n), 0.0), 3.0);
        col = mix(col, uHorizon, fres * 0.55);
        // 距离雾 → 与天空地平线色融合
        float d = length(vWPos.xz - uCamPos.xz);
        col = mix(col, uHorizon, smoothstep(20.0, 60.0, d));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  seaMesh = new THREE.Mesh(geo, mat);
  scene.add(seaMesh);
}
function disposeSea() {
  if (!seaMesh) return;
  scene.remove(seaMesh);
  seaMesh.geometry.dispose();      // 显式释放 GPU 侧几何
  seaMesh.material.dispose();      // 显式释放 GPU 侧材质/程序
  seaMesh = null;
}

// ---------- UI(探针约定:可见文本 + aria-label + data-ui) ----------
const uiBox = document.createElement('div');
uiBox.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;display:flex;gap:8px;';
document.body.appendChild(uiBox);

function makeButton(label, aria) {
  const b = document.createElement('button');
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.setAttribute('data-ui', aria);
  b.style.cssText =
    'padding:6px 14px;font:13px sans-serif;background:rgba(20,24,40,0.72);color:#fff;' +
    'border:1px solid rgba(255,255,255,0.35);border-radius:5px;cursor:pointer;';
  return b;
}
const toneBtn = makeButton('Tone: Warm', 'tone-toggle');
const resetBtn = makeButton('Reset', 'reset');
uiBox.appendChild(toneBtn);
uiBox.appendChild(resetBtn);

const loadingDiv = document.createElement('div');
loadingDiv.textContent = 'Loading boat…';
loadingDiv.style.cssText =
  'position:fixed;left:12px;bottom:12px;z-index:9999;padding:4px 10px;font:12px sans-serif;' +
  'color:#fff;background:rgba(0,0,0,0.45);border-radius:4px;';
document.body.appendChild(loadingDiv);

const errorDiv = document.createElement('div');
errorDiv.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10000;display:none;' +
  'padding:10px 18px;font:14px sans-serif;color:#fff;background:rgba(160,30,30,0.9);' +
  'border-radius:6px;';
document.body.appendChild(errorDiv);
function showError(msg) {
  errorDiv.textContent = msg;
  errorDiv.style.display = 'block';
}

// ---------- 资产加载(真实网络请求;失败给可见提示且不抛未捕获异常) ----------
function loadBoat() {
  return new Promise((resolve) => {
    new GLTFLoader().load(
      BOAT_URL,
      (gltf) => {
        try {
          const model = gltf.scene;
          // 归一化:最长边缩放到 1.7 单位,包围盒中心平移到原点(= 船体参考点)
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const s = 1.7 / Math.max(size.x, size.y, size.z);
          model.scale.setScalar(s);
          model.position.set(-center.x * s, -center.y * s, -center.z * s);
          const root = new THREE.Group();
          root.rotation.order = 'YXZ';
          root.rotation.y = BOAT_HEADING;
          root.add(model);
          scene.add(root);
          boatRoot = root;
          assetRequests += 1;
          assetLoaded = true;
        } catch (e) {
          showError('实例化船体资产失败: ' + e.message);
        }
        resolve();
      },
      undefined,
      (err) => {
        showError('加载 boat.glb 失败: ' + (err && err.message ? err.message : err));
        resolve();
      }
    );
  });
}
function disposeBoat() {
  if (!boatRoot) return;
  scene.remove(boatRoot);
  const seenGeo = new Set();
  const seenMat = new Set();
  boatRoot.traverse((o) => {
    if (o.isMesh) {
      if (o.geometry && !seenGeo.has(o.geometry)) { seenGeo.add(o.geometry); o.geometry.dispose(); }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && !seenMat.has(m)) { seenMat.add(m); m.dispose(); }
    }
  });
  boatRoot = null;
  assetLoaded = false;
}

// ---------- reset:释放并重建(不整页刷新;船与海的 GPU 资源显式释放) ----------
function doReset() {
  epoch += 1;
  if (resetting) { pendingReset = true; return; } // 连续点击:排队串行,保证稳定
  resetting = true;
  // 恢复初始参数(色调/方位角/俯角/模拟时间立即归零,不等加载)
  toneTarget = 0; toneMix = 0;
  azTarget = CAM_AZ0; az = CAM_AZ0;
  elTarget = CAM_EL0; el = CAM_EL0;
  simTime = 0;
  boatPitch = 0; boatRoll = 0;
  disposeBoat();
  disposeSea();
  buildSea();
  toneBtn.textContent = 'Tone: Warm';
  loadBoat().then(() => {
    resetting = false;
    if (pendingReset) { pendingReset = false; doReset(); }
  });
}

// ---------- 交互:水平拖拽 → 相机环绕(恒速 slew,平滑无跳变) ----------
let dragging = false, lastX = 0, lastY = 0;
const usePointer = typeof window.PointerEvent !== 'undefined';
const downEvt = usePointer ? 'pointerdown' : 'mousedown';
const moveEvt = usePointer ? 'pointermove' : 'mousemove';
const upEvt = usePointer ? 'pointerup' : 'mouseup';
canvas.addEventListener(downEvt, (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener(moveEvt, (e) => {
  if (!dragging) return;
  azTarget += (e.clientX - lastX) * AZ_SENS;
  elTarget = Math.min(38, Math.max(6, elTarget + (e.clientY - lastY) * EL_SENS));
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener(upEvt, () => { dragging = false; });
canvas.style.touchAction = 'none';

// ---------- UI 事件 ----------
toneBtn.addEventListener('click', () => {
  toneTarget = toneTarget > 0.5 ? 0 : 1;
  toneBtn.textContent = toneTarget > 0.5 ? 'Tone: Cool' : 'Tone: Warm';
});
resetBtn.addEventListener('click', () => doReset());

// ---------- bench 契约 ----------
const frameTimes = []; // 滚动 2s 帧时间戳(fps 口径)
window.__bench = {
  getState: () => ({
    assetLoaded,
    assetRequests,
    boatPosition: { x: +boatPos.x.toFixed(4), y: +boatPos.y.toFixed(4), z: +boatPos.z.toFixed(4) },
    wavePhase: +simTime.toFixed(4),
    toneMix: +toneMix.toFixed(4),
    cameraAzimuth: +az.toFixed(2),
    fps: currentFps(),
    epoch,
  }),
  reset: doReset,
};
function currentFps() {
  if (frameTimes.length < 2) return 0;
  const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
  if (span <= 0) return 0;
  return +Math.min(999, (frameTimes.length - 1) / span).toFixed(1);
}

// ---------- 每帧调色(toneMix 驱动天空/海面/光照同时演变) ----------
function lerpInto(target, a, b) { target.copy(a).lerp(b, toneMix); }
function applyTone() {
  const sunDir = sunDirection(toneMix);
  skyUniforms.uToneMix.value = toneMix;
  skyUniforms.uSunDir.value.copy(sunDir);
  lerpInto(skyUniforms.uZenith.value, PAL.skyZenW, PAL.skyZenC);
  lerpInto(skyUniforms.uHorizon.value, PAL.skyHorW, PAL.skyHorC);
  lerpInto(skyUniforms.uDiscCol.value, PAL.discW, PAL.discC);
  seaUniforms.uToneMix.value = toneMix;
  seaUniforms.uSunDir.value.copy(sunDir);
  lerpInto(seaUniforms.uDeep.value, PAL.seaDeepW, PAL.seaDeepC);
  lerpInto(seaUniforms.uCrest.value, PAL.seaCrestW, PAL.seaCrestC);
  lerpInto(seaUniforms.uSpec.value, PAL.specW, PAL.specC);
  lerpInto(seaUniforms.uHorizon.value, PAL.skyHorW, PAL.skyHorC);
  sunLight.position.copy(sunDir).multiplyScalar(40);
  lerpInto(sunLight.color, PAL.dirW, PAL.dirC);
  sunLight.intensity = 1.9 - 0.4 * toneMix; // 冷端月光保持足够强度,船体明暗可辨
  lerpInto(hemiLight.color, PAL.hemiSkyW, PAL.hemiSkyC);
  lerpInto(hemiLight.groundColor, PAL.hemiGndW, PAL.hemiGndC);
  hemiLight.intensity = 0.6 - 0.05 * toneMix;
}

// ---------- 相机方位(球坐标环绕孤舟) ----------
function updateCamera(dt) {
  // 方位角:恒速 slew 跟随目标(拖拽中与释放后均持续平滑推进)
  const da = azTarget - az;
  const step = AZ_SLEW * dt;
  az += Math.abs(da) <= step ? da : Math.sign(da) * step;
  // 俯角:指数平滑微调
  el += (elTarget - el) * Math.min(1, dt * 8);
  const azR = (az * Math.PI) / 180, elR = (el * Math.PI) / 180;
  camera.position.set(
    CAM_TARGET.x + CAM_DIST * Math.sin(azR) * Math.cos(elR),
    CAM_TARGET.y + CAM_DIST * Math.sin(elR),
    CAM_TARGET.z + CAM_DIST * Math.cos(azR) * Math.cos(elR)
  );
  camera.lookAt(CAM_TARGET);
}

// ---------- 船体随波起伏(采样与海面同一波形函数 → 相位耦合) ----------
function updateBoat(dt) {
  if (!boatRoot) return;
  const y = seaHeight(0, 0, simTime);
  boatRoot.position.set(0, y + 0.06, 0);
  boatPos.x = boatRoot.position.x;
  boatPos.y = boatRoot.position.y;
  boatPos.z = boatRoot.position.z;
  // 由同波形在船首/尾与两舷的采样差得到纵摇/横摇目标,再平滑
  const r = 0.6;
  const hF = seaHeight(HEADING_FWD.x * r, HEADING_FWD.z * r, simTime);
  const hB = seaHeight(-HEADING_FWD.x * r, -HEADING_FWD.z * r, simTime);
  const hS = seaHeight(HEADING_SIDE.x * r, HEADING_SIDE.z * r, simTime);
  const hP = seaHeight(-HEADING_SIDE.x * r, -HEADING_SIDE.z * r, simTime);
  const pitchT = Math.atan2(hF - hB, 2 * r) * 0.9;
  const rollT = Math.atan2(hS - hP, 2 * r) * 0.9;
  const k = Math.min(1, dt * 6);
  boatPitch += (pitchT - boatPitch) * k;
  boatRoll += (rollT - boatRoll) * k;
  boatRoot.rotation.x = boatRoll;
  boatRoot.rotation.z = boatPitch;
}

// ---------- 主循环(时钟增量步进;后台节流由 dt 上限兜底) ----------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  simTime += dt;
  // toneMix 指数趋近(2.5s 内 > 0.998,满足 <=2.5s 过渡)
  toneMix += (toneTarget - toneMix) * (1 - Math.exp(-TONE_RATE * dt));
  seaUniforms.uTime.value = simTime;
  seaUniforms.uCamPos.value.copy(camera.position);
  applyTone();
  updateCamera(dt);
  updateBoat(dt);
  renderer.render(scene, camera);
  // fps 滚动窗
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length > 0 && frameTimes[0] < now - 2000) frameTimes.shift();
  firstFrame = true;
  if (assetLoaded && firstFrame) {
    if (window.__appReady !== true) window.__appReady = true;
    loadingDiv.style.display = 'none';
  }
}

// ---------- 启动 ----------
buildSea();
renderer.setAnimationLoop(tick);
loadBoat();

// ---------- 视口自适应 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
