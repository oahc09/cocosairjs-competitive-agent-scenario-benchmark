// ============================================================================
// E02 — 落日海面与孤舟(Asset Driven)— three.js r186 实现
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1):
//   window.__appReady : 资产(assets/boat.glb)加载完成且首帧渲染后置 true
//   window.__bench    : {
//     getState: () => ({
//       engine, assetLoaded, assetRequests, boatPosition:{x,y,z},
//       wavePhase, toneMix, cameraAzimuth, fps, epoch
//     }),
//     reset: () => void   // 释放并重建场景(非整页刷新),epoch +1
//   }
// 场景构成:程序化重力波海面(顶点位移 ShaderMaterial,近密远疏层次波)+
// 渐变天穹(太阳/月亮盘与光晕,随 toneMix 暖冷演变)+ GLTF 运行时加载的孤舟
// (保留资产内嵌多部件材质,随同一波形函数起伏/纵摇/横摇)+ 色调/Reset UI。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- 全局常量 -----------------------------------------------------------------
const DEG = Math.PI / 180;
const INITIAL_AZIMUTH = 35;     // 状态口径:cameraAzimuth 初始 35(度)
const INITIAL_ELEVATION = 9.5;  // 俯仰角:透视投影下地平线约在画面上 1/3
const ORBIT_RADIUS = 8;
const ORBIT_TARGET = new THREE.Vector3(0, 0.4, 0);
const FOV = 55;
const SUN_AZIMUTH = 238 * DEG;  // 初始视角前方偏侧 ~23°,日盘落在画面内
const SUN_ELEVATION = 11 * DEG; // 低角度落日/月出
const BOAT_YAW = -0.55;
const BOAT_DRAFT = 0.06;        // 吃水深度
const DRAG_SENS = 0.5;          // 水平拖拽灵敏度(度/像素)
const VEL_SENS = 0.12;          // 垂直拖拽灵敏度(度/像素)
const SPRING_W = 3.2;           // 相机方位角临界阻尼弹簧
const ELEV_W = 4.0;
const FLICK_KEEP = 0.35;        // 松手后惯性外推时长(秒)
const FLICK_CLAMP = 300;        // 惯性角速度上限(度/秒)
const TONE_RATE = 1.6;          // 色调过渡速率(1/s),约 1.9s 完成过渡(<2.5s)

// 波形参数:JS(船体采样)与 GLSL(海面顶点位移)共用同一组常量 —— 相位耦合。
// amp 叠加 ~0.33;fade>0 的细节波随距离衰减(近处细节密、远处疏)。
const WAVES = [
  { dx: 0.940, dz: 0.341, amp: 0.150, len: 16.0, spd: 1.05, fade: 0.0 },
  { dx: 0.834, dz: 0.552, amp: 0.095, len: 9.2, spd: 1.55, fade: 0.0 },
  { dx: 0.980, dz: -0.199, amp: 0.055, len: 4.6, spd: 2.50, fade: 0.01 },
  { dx: 0.760, dz: 0.650, amp: 0.030, len: 2.4, spd: 3.40, fade: 0.018 },
].map((w) => ({ ...w, k: (2 * Math.PI) / w.len }));

const SUN_DIR = new THREE.Vector3(
  Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION)
).normalize();

// --- 暖/冷双色板(linear 工作色彩空间;每帧按 toneMix 插值) ---------------------
const PAL = {
  sunLight: [new THREE.Color(1.0, 0.58, 0.28), new THREE.Color(0.55, 0.66, 1.0)],
  sunIntensity: [2.6, 1.7],
  hemiSky: [new THREE.Color(0.60, 0.34, 0.18), new THREE.Color(0.18, 0.24, 0.45)],
  hemiGround: [new THREE.Color(0.10, 0.12, 0.14), new THREE.Color(0.02, 0.04, 0.09)],
  deep: [new THREE.Color(0.016, 0.075, 0.105), new THREE.Color(0.008, 0.030, 0.095)],
  skyRef: [new THREE.Color(0.95, 0.44, 0.16), new THREE.Color(0.22, 0.30, 0.58)],
  sunColor: [new THREE.Color(1.0, 0.58, 0.26), new THREE.Color(0.62, 0.72, 1.0)],
  horizon: [new THREE.Color(1.00, 0.52, 0.20), new THREE.Color(0.22, 0.27, 0.52)],
};

// --- 波形函数(JS 侧,与 GLSL 逐项一致)----------------------------------------
function waveHeight(x, z, t, camDist) {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const a = w.amp * Math.exp(-camDist * w.fade);
    h += a * Math.sin((x * w.dx + z * w.dz) * w.k + t * w.spd);
  }
  return h;
}

// 由同一组 WAVES 常量生成 GLSL 波形位移代码(单一波形参数源,保证耦合)
function waveGLSL() {
  return WAVES.map((w) => [
    '  {',
    `    vec2 wdir = vec2(${w.dx.toFixed(4)}, ${w.dz.toFixed(4)});`,
    `    float wk = ${w.k.toFixed(6)};`,
    `    float wa = ${w.amp.toFixed(4)} * exp(-dist * ${w.fade.toFixed(4)});`,
    `    float ph = dot(wdir, p) * wk + uTime * ${w.spd.toFixed(4)};`,
    '    h += wa * sin(ph);',
    '    g += wdir * (wa * wk * cos(ph));',
    '  }',
  ].join('\n')).join('\n');
}

// --- 渲染器与场景骨架 -----------------------------------------------------------
const canvas = document.getElementById('app-canvas');
canvas.style.touchAction = 'none';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 600);

// 光照:主光随 toneMix 演变(暖金 -> 冷蓝);半球光提供天空/海面环境反射
const dirLight = new THREE.DirectionalLight(0xffffff, 2.6);
dirLight.position.copy(SUN_DIR).multiplyScalar(80);
scene.add(dirLight);
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x202028, 0.9);
scene.add(hemiLight);

// --- 着色器 ---------------------------------------------------------------------
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform float uTone;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float y = d.y;
    vec3 zen = mix(vec3(0.070, 0.150, 0.360), vec3(0.012, 0.030, 0.100), uTone);
    vec3 mid = mix(vec3(0.760, 0.310, 0.110), vec3(0.070, 0.100, 0.280), uTone);
    vec3 hor = mix(vec3(1.000, 0.520, 0.200), vec3(0.240, 0.280, 0.520), uTone);
    float t1 = smoothstep(0.0, 0.18, y);
    float t2 = smoothstep(0.10, 0.65, y);
    vec3 col = mix(hor, mid, t1);
    col = mix(col, zen, t2);
    if (y < 0.0) col = hor * (1.0 + max(y, -0.12) * 1.2);
    float c = dot(d, uSunDir);
    vec3 sunTint = mix(vec3(1.0, 0.78, 0.50), vec3(0.80, 0.87, 1.0), uTone);
    float glow = pow(max(c, 0.0), 5.0) * 0.30 + pow(max(c, 0.0), 40.0) * 0.55;
    col += sunTint * glow;
    float disc = smoothstep(0.99930, 0.99965, c);
    col += sunTint * disc * mix(2.2, 1.6, uTone);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SEA_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uCamXZ;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vec3 pos = position;
    vec2 p = pos.xz;
    float h = 0.0;
    vec2 g = vec2(0.0);
    float dist = distance(p, uCamXZ);
${waveGLSL()}
    pos.y += h;
    vNormal = normalize(vec3(-g.x, 1.0, -g.y));
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SEA_FRAG = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uSkyRef;
  uniform vec3 uSunColor;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndv = max(dot(N, V), 0.0);
    float fres = pow(1.0 - ndv, 3.0);
    vec3 col = mix(uDeep, uSkyRef, 0.18 + 0.62 * fres);
    vec3 H = normalize(V + uSunDir);
    float ndh = max(dot(N, H), 0.0);
    float spec = pow(ndh, 120.0) * 1.4 + pow(ndh, 16.0) * 0.30;
    col += uSunColor * spec;
    float d = distance(cameraPosition, vWorldPos);
    float fog = smoothstep(40.0, 170.0, d);
    col = mix(col, uHorizon, fog);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// --- 场景构建(可重复调用;reset 时先释放再重建)---------------------------------
let sea = null;
let sky = null;
let boatGroup = null;
const boatCenterLocal = new THREE.Vector3();

function buildSea() {
  const geo = new THREE.PlaneGeometry(400, 400, 256, 256); // 257*257 = 66049 顶点 (>= 2000)
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCamXZ: { value: new THREE.Vector2() },
      uDeep: { value: new THREE.Color() },
      uSkyRef: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
  });
  return new THREE.Mesh(geo, mat);
}

function buildSky() {
  const geo = new THREE.SphereGeometry(300, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTone: { value: 0 },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}

// --- 状态 ------------------------------------------------------------------------
let simTime = 0;            // 模拟时间(reset 归零),wavePhase 即 simTime
let toneMix = 0;            // 0=暖(落日) 1=冷(暮蓝)
let toneTarget = 0;
let azCurrent = INITIAL_AZIMUTH;   // 实际方位角(度)
let azTarget = INITIAL_AZIMUTH;
let azVel = 0;                     // 弹簧角速度
let elCurrent = INITIAL_ELEVATION;
let elTarget = INITIAL_ELEVATION;
let elVel = 0;
let ptrAzVel = 0;                  // 拖拽角速度(惯性外推用)
let assetLoaded = false;
let assetRequests = 0;
let epoch = 0;
let appReadySignaled = false;
let fpsValue = 0;
const frameTimes = [];

// --- UI 覆盖层 -------------------------------------------------------------------
function makeButton(text, aria, dataUi, top) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.setAttribute('aria-label', aria);
  btn.setAttribute('data-ui', dataUi);
  btn.style.cssText =
    'position:fixed;z-index:9999;padding:6px 14px;font:13px sans-serif;' +
    'background:rgba(18,22,30,0.72);color:#fff;border:1px solid rgba(255,255,255,0.4);' +
    'border-radius:6px;cursor:pointer';
  btn.style.top = top + 'px';
  btn.style.right = '10px';
  document.body.appendChild(btn);
  return btn;
}

const toneBtn = makeButton('Tone: 落日/暮蓝', 'tone-toggle', 'tone-toggle', 10);
const resetBtn = makeButton('Reset', 'reset', 'reset', 48);

const loadingEl = document.createElement('div');
loadingEl.textContent = 'Loading assets/boat.glb ...';
loadingEl.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:9999;padding:6px 10px;' +
  'font:12px sans-serif;background:rgba(0,0,0,0.55);color:#fff;border-radius:4px';
document.body.appendChild(loadingEl);

const errEl = document.createElement('div');
errEl.setAttribute('role', 'alert');
errEl.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10000;' +
  'padding:14px 20px;font:14px sans-serif;background:#b00020;color:#fff;' +
  'border-radius:6px;display:none;max-width:70%';
document.body.appendChild(errEl);

function showError(msg) {
  try {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  } catch (e) { /* 忽略:不产生未捕获异常 */ }
}
function hideError() {
  try { errEl.style.display = 'none'; } catch (e) { /* 忽略 */ }
}

toneBtn.addEventListener('click', () => {
  toneTarget = toneTarget > 0.5 ? 0 : 1;
  toneBtn.textContent = toneTarget > 0.5 ? 'Tone: 暮蓝(冷)' : 'Tone: 落日(暖)';
});

// --- 资产加载(真实网络请求)------------------------------------------------------
const ASSET_URL = window.location.pathname.includes('/dist/')
  ? '../assets/boat.glb'
  : 'assets/boat.glb';
const gltfLoader = new GLTFLoader();

function loadBoat() {
  const myEpoch = epoch;
  loadingEl.style.display = 'block';
  gltfLoader.loadAsync(ASSET_URL).then((gltf) => {
    if (myEpoch !== epoch) {
      // 过期加载(reset 已再次重建):直接释放,不入场
      if (gltf.scene) disposeObject(gltf.scene);
      return;
    }
    const model = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    boatGroup.add(model);
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(boatCenterLocal);
    assetLoaded = true;
    assetRequests += 1;
    loadingEl.style.display = 'none';
  }).catch((err) => {
    if (myEpoch !== epoch) return;
    loadingEl.style.display = 'none';
    showError('资产加载失败: assets/boat.glb — ' + (err && err.message ? err.message : String(err)));
  });
}

// --- 重建(初始构建与 reset 共用)--------------------------------------------------
function buildScene() {
  boatGroup = new THREE.Group();
  boatGroup.rotation.order = 'YXZ';
  boatGroup.rotation.y = BOAT_YAW;
  scene.add(boatGroup);

  sea = buildSea();
  scene.add(sea);

  sky = buildSky();
  scene.add(sky);

  boatCenterLocal.set(0, 0, 0);
  loadBoat();
}

function doReset() {
  epoch += 1;
  simTime = 0;
  toneMix = 0;
  toneTarget = 0;
  toneBtn.textContent = 'Tone: 落日(暖)';
  azCurrent = INITIAL_AZIMUTH; azTarget = INITIAL_AZIMUTH; azVel = 0; ptrAzVel = 0;
  elCurrent = INITIAL_ELEVATION; elTarget = INITIAL_ELEVATION; elVel = 0;

  if (boatGroup) { scene.remove(boatGroup); disposeObject(boatGroup); boatGroup = null; }
  if (sea) { scene.remove(sea); sea.geometry.dispose(); sea.material.dispose(); sea = null; }
  if (sky) { scene.remove(sky); sky.geometry.dispose(); sky.material.dispose(); sky = null; }
  assetLoaded = false;
  hideError();
  buildScene();
}

resetBtn.addEventListener('click', () => doReset());
window.__bench = { getState: getState, reset: doReset };

// --- bench 状态契约 ----------------------------------------------------------------
const _tmpV = new THREE.Vector3();
const _eulerTmp = new THREE.Euler(0, 0, 0, 'YXZ');
function round3(v) { return Math.round(v * 1000) / 1000; }

function getState() {
  if (boatGroup) {
    _tmpV.copy(boatCenterLocal).applyEuler(boatGroup.rotation).add(boatGroup.position);
  } else {
    _tmpV.set(0, 0, 0);
  }
  let az = azCurrent % 360;
  if (az < 0) az += 360;
  return {
    engine: 'three',
    assetLoaded: assetLoaded,
    assetRequests: assetRequests,
    boatPosition: { x: round3(_tmpV.x), y: round3(_tmpV.y), z: round3(_tmpV.z) },
    wavePhase: round3(simTime),
    toneMix: Math.round(toneMix * 10000) / 10000,
    cameraAzimuth: round3(az),
    fps: Math.round(fpsValue * 100) / 100,
    epoch: epoch,
  };
}

// --- 输入:水平拖拽环绕(逐帧弹簧插值,松手带惯性外推,方向一致)--------------------
let dragging = false;
let lastX = 0;
let lastY = 0;
let lastMoveT = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveT = e.timeStamp;
  ptrAzVel = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  const dtm = Math.max((e.timeStamp - lastMoveT) / 1000, 0.004);
  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveT = e.timeStamp;
  const dAz = dx * DRAG_SENS;
  azTarget += dAz;
  ptrAzVel = ptrAzVel * 0.7 + (dAz / dtm) * 0.3;
  elTarget = Math.min(35, Math.max(8, elTarget + dy * VEL_SENS));
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  const coast = Math.max(-FLICK_CLAMP, Math.min(FLICK_CLAMP, ptrAzVel)) * FLICK_KEEP;
  azTarget += coast;
  ptrAzVel = 0;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// 临界阻尼弹簧步进(zeta=1:平滑无跳变、无过冲)
function spring(cur, tgt, vel, dt, w) {
  const acc = w * w * (tgt - cur) - 2 * w * vel;
  vel += acc * dt;
  cur += vel * dt;
  return [cur, vel];
}

// --- 每帧调色 ----------------------------------------------------------------------
function applyTone(t) {
  sea.material.uniforms.uDeep.value.copy(PAL.deep[0]).lerp(PAL.deep[1], t);
  sea.material.uniforms.uSkyRef.value.copy(PAL.skyRef[0]).lerp(PAL.skyRef[1], t);
  sea.material.uniforms.uSunColor.value.copy(PAL.sunColor[0]).lerp(PAL.sunColor[1], t);
  sea.material.uniforms.uHorizon.value.copy(PAL.horizon[0]).lerp(PAL.horizon[1], t);
  sky.material.uniforms.uTone.value = t;
  dirLight.color.copy(PAL.sunLight[0]).lerp(PAL.sunLight[1], t);
  dirLight.intensity = PAL.sunIntensity[0] + (PAL.sunIntensity[1] - PAL.sunIntensity[0]) * t;
  hemiLight.color.copy(PAL.hemiSky[0]).lerp(PAL.hemiSky[1], t);
  hemiLight.groundColor.copy(PAL.hemiGround[0]).lerp(PAL.hemiGround[1], t);
}

// --- 主循环 ------------------------------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 后台节流恢复后不跳变
  simTime += dt;

  // 色调过渡(<= 2.5s)
  toneMix += (toneTarget - toneMix) * (1 - Math.exp(-TONE_RATE * dt));
  if (Math.abs(toneTarget - toneMix) < 0.0005) toneMix = toneTarget;

  // 相机弹簧插值(方位角逐帧平滑、无跳变)
  [azCurrent, azVel] = spring(azCurrent, azTarget, azVel, dt, SPRING_W);
  [elCurrent, elVel] = spring(elCurrent, elTarget, elVel, dt, ELEV_W);
  const azRad = azCurrent * DEG;
  const elRad = elCurrent * DEG;
  camera.position.set(
    ORBIT_TARGET.x + ORBIT_RADIUS * Math.cos(elRad) * Math.sin(azRad),
    ORBIT_TARGET.y + ORBIT_RADIUS * Math.sin(elRad),
    ORBIT_TARGET.z + ORBIT_RADIUS * Math.cos(elRad) * Math.cos(azRad)
  );
  camera.lookAt(ORBIT_TARGET);

  // 船体随波起伏:与海面采样同一波形函数(相位耦合),伴纵摇/横摇
  if (boatGroup) {
    const camDist = Math.hypot(camera.position.x, camera.position.z);
    const h0 = waveHeight(0, 0, simTime, camDist);
    boatGroup.position.y = h0 - BOAT_DRAFT;
    const fx = Math.sin(BOAT_YAW);
    const fz = Math.cos(BOAT_YAW);
    const hBow = waveHeight(fx * 1.1, fz * 1.1, simTime, camDist);
    const hStern = waveHeight(-fx * 1.1, -fz * 1.1, simTime, camDist);
    const hStar = waveHeight(-fz * 0.45, fx * 0.45, simTime, camDist);
    const hPort = waveHeight(fz * 0.45, -fx * 0.45, simTime, camDist);
    const pitch = Math.max(-0.22, Math.min(0.22, Math.atan2(hStern - hBow, 2.2)));
    const roll = Math.max(-0.25, Math.min(0.25, Math.atan2(hStar - hPort, 0.9)));
    boatGroup.rotation.set(pitch, BOAT_YAW, roll);
  }

  // 海面/天空 uniforms
  sea.material.uniforms.uTime.value = simTime;
  sea.material.uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
  sky.position.copy(camera.position);
  applyTone(toneMix);

  renderer.render(scene, camera);

  // 首帧(含资产)渲染完成后置就绪
  if (!appReadySignaled && assetLoaded) {
    appReadySignaled = true;
    window.__appReady = true;
  }

  // fps:2s 滚动平均
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 2) {
    fpsValue = (frameTimes.length - 1) / ((now - frameTimes[0]) / 1000);
  }
}

// --- 视口自适应 --------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// --- 启动(任何初始化失败都以可见错误提示呈现,不产生未捕获异常)--------------------
try {
  buildScene();
  renderer.setAnimationLoop(tick);
} catch (e) {
  showError('场景初始化失败: ' + (e && e.message ? e.message : String(e)));
}
