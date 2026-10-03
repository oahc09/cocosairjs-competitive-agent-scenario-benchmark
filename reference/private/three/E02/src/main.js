// ============================================================================
// E02 — 落日海面与孤舟(Asset Driven)— Three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// 契约(MASTER-CONTEXT §12.1 + E02 spec.json):
//   window.__appReady : 资产加载完成且首帧渲染后置 true(10s 内)
//   window.__bench    : { getState(), reset() },字段对齐 spec.stateContract:
//     assetLoaded / assetRequests / boatPosition / wavePhase / toneMix /
//     cameraAzimuth / fps / epoch (+ resetCount)
// 关键红线遵守:
//   * assets/boat.glb 由 GLTFLoader 在运行时发起真实网络请求(绝不内联);
//   * 船体保留 GLB 内嵌 6 材质(HullWood/DeckWood/TrimRed/SparDark/SailCloth/JibCloth);
//   * 海面为 GPU 顶点位移的行进重力波(6 波叠加,Gerstner 水平锐化),
//     船体起伏采样同一波形参数(相位耦合);
//   * reset() 显式 dispose 旧船/海/天的 GPU 资源后重建并重新加载 GLB
//     (assetRequests 递增 = spec 认可的释放证据),不整页刷新。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;

// --- 波形参数(CPU 采样与 GPU shader 共用同一份数据 => 相位耦合) -------------
// { dir[2](归一化), wavelength, amp, fadeStart, fadeEnd }:fade 控制短波在远处
// 淡出(层次化波形:近处细节密、远处只剩长涌,同时避免高频闪烁)。
const G = 9.81;
const WAVE_DEFS = [
  { dir: [0.92, 0.39], wavelength: 42.0, amp: 0.240, fadeStart: 1e9, fadeEnd: 1e9 },
  { dir: [0.18, 0.98], wavelength: 18.0, amp: 0.105, fadeStart: 1e9, fadeEnd: 1e9 },
  { dir: [0.65, -0.76], wavelength: 23.0, amp: 0.140, fadeStart: 1e9, fadeEnd: 1e9 },
  { dir: [-0.33, 0.94], wavelength: 11.5, amp: 0.075, fadeStart: 90, fadeEnd: 220 },
  { dir: [0.97, 0.26], wavelength: 6.3, amp: 0.040, fadeStart: 45, fadeEnd: 130 },
  { dir: [-0.71, -0.70], wavelength: 3.4, amp: 0.022, fadeStart: 26, fadeEnd: 80 },
];
const AMP_SUM = WAVE_DEFS.reduce((a, w) => a + w.amp, 0);
// 深水色散关系 ω = sqrt(g·k)
const WAVES = WAVE_DEFS.map((w) => {
  const k = (2 * Math.PI) / w.wavelength;
  return { ...w, k, omega: Math.sqrt(G * k), phase: Math.random() * 0 + w.wavelength * 0.37 };
});

/** 与 vertex shader 完全一致的波形采样(CPU 侧,用于船体浮沉/纵摇/横摇)。 */
function sampleSea(x, z, t) {
  let h = 0;
  let dhx = 0;
  let dhz = 0;
  for (const w of WAVES) {
    const ph = w.k * (w.dir[0] * x + w.dir[1] * z) - w.omega * t + w.phase;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    h += w.amp * s;
    dhx += w.amp * w.k * w.dir[0] * c;
    dhz += w.amp * w.k * w.dir[1] * c;
  }
  return { h, dhx, dhz };
}

// --- 暖 / 冷 双端调色板(sRGB 十六进制,THREE.Color 自动转线性工作空间) -------
const PAL = {
  warm: {
    skyTop: new THREE.Color(0x2b3d78), skyHorizon: new THREE.Color(0xe08a4e),
    glow: new THREE.Color(0xffc98a), disc: new THREE.Color(0xfff4d6),
    fog: new THREE.Color(0xcf7a49),
    seaDeep: new THREE.Color(0x0b2a3d), seaShallow: new THREE.Color(0x175a66),
    foam: new THREE.Color(0xffe4c4), spec: new THREE.Color(0xffd9a0),
    sunLight: new THREE.Color(0xffc98a), hemiSky: new THREE.Color(0x8090cc),
    hemiGround: new THREE.Color(0x3a2a1e), fill: new THREE.Color(0x35507e),
  },
  cool: {
    skyTop: new THREE.Color(0x060b1e), skyHorizon: new THREE.Color(0x27436f),
    glow: new THREE.Color(0x9db8e6), disc: new THREE.Color(0xe8efff),
    fog: new THREE.Color(0x233a5e),
    seaDeep: new THREE.Color(0x041020), seaShallow: new THREE.Color(0x0a2740),
    foam: new THREE.Color(0xcfe0f0), spec: new THREE.Color(0xc4d6ff),
    sunLight: new THREE.Color(0xa9c0f0), hemiSky: new THREE.Color(0x3c5680),
    hemiGround: new THREE.Color(0x0b1120), fill: new THREE.Color(0x1c2c4a),
  },
};
const SUN_AZ_DEG = 229;        // 太阳/月亮方位(相对 +Z),初始视角下位于中轴偏左
const SUN_EL_WARM = 8.5;       // 暖端:低垂落日
const SUN_EL_COOL = 26.0;      // 冷端:升起的月亮

// --- 渲染器 / 场景 / 相机 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcf7a49, 55, 300); // 颜色每帧按 toneMix 重写

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 2000
);

// --- 环绕相机:临界阻尼弹簧平滑(拖拽 => target,实际方位逐帧追近) -------------
const CAM_AZ0 = 35;
const orbit = {
  az: CAM_AZ0, azT: CAM_AZ0, azV: 0,
  el: 10.5, elT: 10.5, elV: 0,
  r: 7.6, rT: 7.6, rV: 0,
  target: new THREE.Vector3(0, 1.25, 0),
};
const ORBIT_OMEGA = 3.2;        // 弹簧角频率:足够慢以保持平滑,足够快以跟手
const DRAG_AZ_PER_PX = 0.6;     // 拖拽灵敏度(度/像素)
const DRAG_EL_PER_PX = 0.14;

function springStep(cur, vel, target, dt, omega) {
  vel += (omega * omega * (target - cur) - 2 * omega * vel) * dt;
  cur += vel * dt;
  return [cur, vel];
}

function applyCamera() {
  const az = orbit.az * DEG;
  const el = orbit.el * DEG;
  camera.position.set(
    orbit.target.x + Math.sin(az) * Math.cos(el) * orbit.r,
    orbit.target.y + Math.sin(el) * orbit.r,
    orbit.target.z + Math.cos(az) * Math.cos(el) * orbit.r
  );
  camera.lookAt(orbit.target);
}

// --- 光照 ------------------------------------------------------------------------
const dirLight = new THREE.DirectionalLight(0xffc98a, 3.0);
scene.add(dirLight);
scene.add(dirLight.target);
const hemiLight = new THREE.HemisphereLight(0x8090cc, 0x3a2a1e, 0.55);
scene.add(hemiLight);
const fillLight = new THREE.DirectionalLight(0x35507e, 0.6); // 相机侧冷补光,保证背光面可辨
scene.add(fillLight);
scene.add(fillLight.target);

// --- 海面(GPU 顶点位移 + 自定义着色,fog 走 three 内建 uniform) ----------------
const SEA_SIZE = 520;
const SEA_SEG = 224; // 225*225 = 50625 顶点 >= 2000

const seaVert = /* glsl */ `
  #define NW ${WAVES.length}
  uniform float uTime;
  uniform vec4 uWaves[NW];   // dirX, dirZ, k, amp
  uniform vec4 uWavesB[NW];  // omega, phase, fadeStart, fadeEnd
  uniform float uAmpSum;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vCrest;
  #include <fog_pars_vertex>

  void main() {
    vec3 p = position;
    float h = 0.0;
    float dhx = 0.0;
    float dhz = 0.0;
    vec2 hdisp = vec2(0.0);
    float dist = length(p.xz);
    for (int i = 0; i < NW; i++) {
      vec4 w = uWaves[i];
      vec4 b = uWavesB[i];
      float fade = 1.0 - smoothstep(b.z, b.w, dist);
      float amp = w.w * fade;
      float ph = w.z * dot(w.xy, p.xz) - b.x * uTime + b.y;
      float s = sin(ph);
      float c = cos(ph);
      h += amp * s;
      dhx += amp * w.z * w.x * c;
      dhz += amp * w.z * w.y * c;
      hdisp += 0.55 * amp * w.xy * c;  // Gerstner 式水平位移 => 波峰锐化
    }
    p.x += hdisp.x;
    p.z += hdisp.y;
    p.y += h;
    vNormal = normalize(vec3(-dhx, 1.0, -dhz));
    vCrest = h / uAmpSum;
    vWorldPos = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const seaFrag = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSkyTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFoamColor;
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vCrest;
  #include <fog_pars_fragment>

  void main() {
    vec3 n = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    // 逐像素细波法线扰动:近景高频光泽细节(顶点网格分辨率之下的涟漪)
    {
      vec2 q = vWorldPos.xz;
      float d1 = sin(dot(vec2(0.94, 0.34), q) * 6.1 + uTime * 5.2);
      float d2 = sin(dot(vec2(-0.28, 0.96), q) * 4.3 - uTime * 4.1);
      float d3 = sin(dot(vec2(0.62, -0.78), q) * 9.7 + uTime * 6.7);
      float d4 = sin(dot(vec2(0.83, 0.55), q) * 15.3 - uTime * 8.3);
      n = normalize(n + vec3(d1, 0.0, d2) * 0.055 + vec3(d3, 0.0, d4) * 0.035);
    }
    float ndv = max(dot(n, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    float depthMix = clamp(vCrest * 0.5 + 0.5, 0.0, 1.0);
    vec3 base = mix(uDeep, uShallow, depthMix * 0.6);
    vec3 R = reflect(-V, n);
    vec3 skyRef = mix(uHorizon, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.45));
    vec3 col = mix(base, skyRef, clamp(fres * 1.2, 0.0, 1.0));
    // 太阳/月亮镜面高光带(高指数 Blinn-Phong => 波峰上的 glitter)
    vec3 H = normalize(uSunDir + V);
    float ndh = max(dot(n, H), 0.0);
    col += uSunColor * (pow(ndh, 260.0) * 1.5 + pow(ndh, 48.0) * 0.22);
    // 波峰白沫(轻微、随相位闪烁)
    float foam = smoothstep(0.62, 0.98, vCrest)
               * (0.5 + 0.5 * sin(vWorldPos.x * 3.1 + vWorldPos.z * 2.7 + uTime * 2.2));
    col = mix(col, uFoamColor, clamp(foam, 0.0, 1.0) * 0.16);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// --- 天空穹顶(渐变 + 日/月光盘 + 光晕;冷端浮现星点) ---------------------------
const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFrag = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uDisc;
  uniform vec3 uSunDir;
  uniform float uCosInner;
  uniform float uCosOuter;
  uniform float uToneMix;
  uniform float uTime;
  varying vec3 vDir;

  float hash13(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  void main() {
    vec3 d = normalize(vDir);
    float hgt = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(hgt, 0.55));
    float sd = clamp(dot(d, uSunDir), 0.0, 1.0);
    col += uGlow * (pow(sd, 5.0) * 0.42 + pow(sd, 60.0) * 0.5) * (1.0 - hgt * 0.55);
    // 冷端(暮蓝)高空星点,随 toneMix 淡入
    if (uToneMix > 0.02 && d.y > 0.08) {
      float s = hash13(floor(d * 220.0));
      float star = smoothstep(0.9975, 1.0, s) * uToneMix * smoothstep(0.05, 0.45, d.y);
      col += vec3(0.85, 0.9, 1.0) * star * (0.55 + 0.45 * sin(uTime * 3.0 + s * 40.0));
    }
    float disc = smoothstep(uCosOuter, uCosInner, sd);
    col = mix(col, uDisc, disc);
    // 海平线以下压到雾色,与海面雾化无缝衔接
    col = mix(uHorizon * 0.92, col, smoothstep(-0.06, 0.015, d.y));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// --- 世界构建 / 释放 -------------------------------------------------------------
let seaMesh = null;
let seaMat = null;
let skyMesh = null;
let skyMat = null;
const sunDirV = new THREE.Vector3();
const work = {
  // 每帧复用的线性空间工作颜色(避免 GC)
  skyTop: new THREE.Color(), skyHorizon: new THREE.Color(), glow: new THREE.Color(),
  disc: new THREE.Color(), fog: new THREE.Color(), seaDeep: new THREE.Color(),
  seaShallow: new THREE.Color(), foam: new THREE.Color(), spec: new THREE.Color(),
  sunLight: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
  fill: new THREE.Color(),
};
function mixColor(out, a, b, t) { out.copy(a).lerp(b, t); }

function buildSea() {
  const geo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, SEA_SEG, SEA_SEG);
  geo.rotateX(-Math.PI / 2); // 烘焙到 XZ 平面,shader 内 position.y 即世界高度
  seaMat = new THREE.ShaderMaterial({
    vertexShader: seaVert,
    fragmentShader: seaFrag,
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uWaves: { value: WAVES.map((w) => new THREE.Vector4(w.dir[0], w.dir[1], w.k, w.amp)) },
      uWavesB: { value: WAVES.map((w) => new THREE.Vector4(w.omega, w.phase, w.fadeStart, w.fadeEnd)) },
      uAmpSum: { value: AMP_SUM },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uSkyTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uFoamColor: { value: new THREE.Color() },
    },
  });
  seaMesh = new THREE.Mesh(geo, seaMat);
  seaMesh.frustumCulled = false;
  scene.add(seaMesh);
}

function buildSky() {
  const geo = new THREE.SphereGeometry(700, 48, 28);
  skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uDisc: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCosInner: { value: 0.999 },
      uCosOuter: { value: 0.998 },
      uToneMix: { value: 0 },
      uTime: { value: 0 },
    },
  });
  skyMesh = new THREE.Mesh(geo, skyMat);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isLine || o.isPoints) {
      o.geometry?.dispose();
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
}

// --- 孤舟(GLB 运行时加载;anchor 常驻,内部 model 可重建) ----------------------
const boatAnchor = new THREE.Group();
boatAnchor.rotation.order = 'YXZ';
scene.add(boatAnchor);
let boatModel = null;
let assetLoaded = false;
let assetRequests = 0;

const BOAT_TARGET_LENGTH = 2.6;
const BOAT_BASE_YAW = 2.15;

function loadBoat() {
  assetLoaded = false;
  // 相对路径 => http://host/assets/boat.glb(serve 根 = 工作区根):真实网络请求
  new GLTFLoader().load(
    'assets/boat.glb',
    (gltf) => {
      const model = gltf.scene;
      // 归一:最长边缩放到目标长度,居中于原点,水线置于包围盒高度 25% 处
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const s = BOAT_TARGET_LENGTH / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(s);
      const box2 = new THREE.Box3().setFromObject(model);
      const c = box2.getCenter(new THREE.Vector3());
      model.position.x -= c.x;
      model.position.z -= c.z;
      model.position.y -= box2.min.y + 0.25 * (box2.max.y - box2.min.y);
      const inner = new THREE.Group();
      inner.rotation.y = BOAT_BASE_YAW;
      inner.add(model);
      boatAnchor.add(inner);
      boatModel = inner;
      assetLoaded = true;
      assetRequests += 1;
      hideLoading();
    },
    (ev) => { /* 进度:本地资产瞬时完成,无需 UI */ },
    (err) => {
      showFatalError(`assets/boat.glb 加载失败:${err?.message || err}`);
    }
  );
}

// --- 船体随波起伏(采样 CPU 波形 => 与海面相位耦合) ----------------------------
let boatY = 0;
let boatPitch = 0;
let boatRoll = 0;

function updateBoat(dt, simT) {
  const s = sampleSea(0, 0, simT);
  const targetY = s.h * 0.9;
  const kY = 1 - Math.exp(-dt / 0.18);
  boatY += (targetY - boatY) * kY;
  const kA = 1 - Math.exp(-dt / 0.35);
  boatPitch += (Math.atan(s.dhz) * 0.55 - boatPitch) * kA;
  boatRoll += (Math.atan(s.dhx) * 0.7 - boatRoll) * kA;
  const sway = 0.05 * Math.sin(simT * 0.33) + 0.02 * Math.sin(simT * 0.9 + 1.7);
  boatAnchor.position.set(0, boatY, 0);
  boatAnchor.rotation.set(boatPitch, sway, boatRoll);
}

// --- 环境演变(toneMix 驱动天空/雾/光照/海面颜色) ------------------------------
function updateEnvironment(t, simT) {
  mixColor(work.skyTop, PAL.warm.skyTop, PAL.cool.skyTop, t);
  mixColor(work.skyHorizon, PAL.warm.skyHorizon, PAL.cool.skyHorizon, t);
  mixColor(work.glow, PAL.warm.glow, PAL.cool.glow, t);
  mixColor(work.disc, PAL.warm.disc, PAL.cool.disc, t);
  mixColor(work.fog, PAL.warm.fog, PAL.cool.fog, t);
  mixColor(work.seaDeep, PAL.warm.seaDeep, PAL.cool.seaDeep, t);
  mixColor(work.seaShallow, PAL.warm.seaShallow, PAL.cool.seaShallow, t);
  mixColor(work.foam, PAL.warm.foam, PAL.cool.foam, t);
  mixColor(work.spec, PAL.warm.spec, PAL.cool.spec, t);
  mixColor(work.sunLight, PAL.warm.sunLight, PAL.cool.sunLight, t);
  mixColor(work.hemiSky, PAL.warm.hemiSky, PAL.cool.hemiSky, t);
  mixColor(work.hemiGround, PAL.warm.hemiGround, PAL.cool.hemiGround, t);
  mixColor(work.fill, PAL.warm.fill, PAL.cool.fill, t);

  // 日/月方向:固定方位,暖->冷时仰角抬升(落日沉下,月亮升起)
  const el = THREE.MathUtils.lerp(SUN_EL_WARM, SUN_EL_COOL, t) * DEG;
  const az = SUN_AZ_DEG * DEG;
  sunDirV.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

  dirLight.position.copy(sunDirV).multiplyScalar(60);
  dirLight.color.copy(work.sunLight);
  dirLight.intensity = THREE.MathUtils.lerp(3.0, 1.55, t);
  hemiLight.color.copy(work.hemiSky);
  hemiLight.groundColor.copy(work.hemiGround);
  hemiLight.intensity = THREE.MathUtils.lerp(0.62, 0.55, t);
  fillLight.position.set(-sunDirV.x * 40, 18, -sunDirV.z * 40);
  fillLight.color.copy(work.fill);
  fillLight.intensity = THREE.MathUtils.lerp(0.6, 0.45, t);

  scene.fog.color.copy(work.fog);
  scene.fog.near = THREE.MathUtils.lerp(55, 42, t);
  scene.fog.far = THREE.MathUtils.lerp(300, 250, t);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(1.08, 0.98, t);

  if (seaMat) {
    const u = seaMat.uniforms;
    u.uTime.value = simT;
    u.uDeep.value.copy(work.seaDeep);
    u.uShallow.value.copy(work.seaShallow);
    u.uSkyTop.value.copy(work.skyTop);
    u.uHorizon.value.copy(work.skyHorizon);
    u.uSunDir.value.copy(sunDirV);
    u.uSunColor.value.copy(work.spec);
    u.uFoamColor.value.copy(work.foam);
  }
  if (skyMat) {
    const u = skyMat.uniforms;
    u.uTop.value.copy(work.skyTop);
    u.uHorizon.value.copy(work.skyHorizon);
    u.uGlow.value.copy(work.glow);
    u.uDisc.value.copy(work.disc);
    u.uSunDir.value.copy(sunDirV);
    // 暖端日面 2.6°,冷端月面 1.15°(软边外扩一倍)
    u.uCosInner.value = THREE.MathUtils.lerp(Math.cos(2.6 * DEG), Math.cos(1.15 * DEG), t);
    u.uCosOuter.value = THREE.MathUtils.lerp(Math.cos(5.2 * DEG), Math.cos(3.2 * DEG), t);
    u.uToneMix.value = t;
    u.uTime.value = simT;
  }
}

// --- 交互:拖拽环绕 / 滚轮缩放 -----------------------------------------------------
let dragging = false;
let lastPX = 0;
let lastPY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPX = e.clientX;
  lastPY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPX;
  const dy = e.clientY - lastPY;
  lastPX = e.clientX;
  lastPY = e.clientY;
  orbit.azT += dx * DRAG_AZ_PER_PX;
  orbit.elT = THREE.MathUtils.clamp(orbit.elT + dy * DRAG_EL_PER_PX, 3.5, 40);
});
function endDrag() { dragging = false; }
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    orbit.rT = THREE.MathUtils.clamp(orbit.rT * (1 + e.deltaY * 0.001), 5, 15);
  },
  { passive: false }
);

// --- UI 覆盖层 ---------------------------------------------------------------------
const uiRoot = document.createElement('div');
uiRoot.style.cssText =
  'position:fixed;inset:0;pointer-events:none;z-index:9999;' +
  "font:13px/1.5 'Segoe UI',system-ui,sans-serif;color:#f5efe6";
document.body.appendChild(uiRoot);

function makePanel(css) {
  const p = document.createElement('div');
  p.style.cssText =
    'position:absolute;pointer-events:auto;backdrop-filter:blur(6px);' +
    'background:rgba(12,16,28,0.42);border:1px solid rgba(255,255,255,0.16);' +
    'border-radius:10px;padding:10px 14px;' + css;
  return p;
}

// 左上:标题 + 状态
const infoPanel = makePanel('top:14px;left:14px;min-width:190px;');
infoPanel.innerHTML =
  '<div style="font-size:14px;font-weight:600;letter-spacing:.5px">E02 · 落日海面与孤舟</div>' +
  '<div id="bench-tone-label" style="margin-top:2px;opacity:.92">色调:暖(落日)</div>' +
  '<div style="margin-top:2px;opacity:.65;font-size:11px">拖拽环绕 · 滚轮缩放</div>';
uiRoot.appendChild(infoPanel);

// 右上:色调切换 + Reset(必需控件,data-ui 供 harness 定位)
const ctrlPanel = makePanel('top:14px;right:14px;display:flex;gap:8px;');
const toneBtn = document.createElement('button');
toneBtn.id = 'tone-toggle';
toneBtn.setAttribute('data-ui', 'tone-toggle');
toneBtn.setAttribute('aria-label', '切换色调 tone: warm sunset / cool twilight');
toneBtn.textContent = '色调:暖 → 冷';
toneBtn.style.cssText = btnCss();
const resetBtn = document.createElement('button');
resetBtn.id = 'reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.textContent = 'Reset';
resetBtn.style.cssText = btnCss();
ctrlPanel.appendChild(toneBtn);
ctrlPanel.appendChild(resetBtn);
uiRoot.appendChild(ctrlPanel);

function btnCss() {
  return (
    'pointer-events:auto;cursor:pointer;padding:7px 14px;border-radius:8px;' +
    'border:1px solid rgba(255,255,255,0.28);color:#f5efe6;' +
    'background:rgba(60,70,100,0.55);font:600 13px system-ui,sans-serif;' +
    'transition:background .15s'
  );
}

// 加载中提示(资产就绪后隐藏;出错时转为错误提示)
const loading = document.createElement('div');
loading.style.cssText =
  'position:absolute;left:50%;bottom:12%;transform:translateX(-50%);' +
  'background:rgba(12,16,28,0.55);border:1px solid rgba(255,255,255,0.18);' +
  'border-radius:8px;padding:8px 16px;letter-spacing:.5px;';
loading.textContent = '正在加载 assets/boat.glb …';
uiRoot.appendChild(loading);
function hideLoading() { loading.style.display = 'none'; }
function showFatalError(msg) {
  loading.style.display = 'block';
  loading.style.borderColor = 'rgba(255,120,120,0.7)';
  loading.textContent = '错误:' + msg;
}

// --- bench 状态与生命周期 -----------------------------------------------------------
let epoch = 0;
let resetCount = 0;
let toneMix = 0;          // 0=暖,1=冷
let toneTarget = 0;
let simT = 0;             // 模拟时间(reset 归零)——wavePhase 即 simT
let wavePhase = 0;
let rebuilding = false;
let fps = 0;
const frameTimes = [];

function getState() {
  return {
    engine: 'three',
    ready: assetLoaded,
    assetLoaded,
    assetRequests,
    boatPosition: {
      x: boatAnchor.position.x,
      y: boatAnchor.position.y,
      z: boatAnchor.position.z,
    },
    wavePhase,
    toneMix,
    cameraAzimuth: orbit.az,
    cameraElevation: orbit.el,
    fps,
    epoch,
    resetCount,
  };
}

function reset() {
  if (rebuilding) return; // 重建期间防重入(重建在数十毫秒内完成)
  rebuilding = true;
  try {
    epoch += 1;
    resetCount += 1;
    // -- 释放:显式 dispose 船/海/天的 GPU 侧资源并移出场景
    if (boatModel) {
      boatAnchor.remove(boatModel);
      disposeObject(boatModel);
      boatModel = null;
    }
    if (seaMesh) { scene.remove(seaMesh); disposeObject(seaMesh); seaMesh = seaMat = null; }
    if (skyMesh) { scene.remove(skyMesh); disposeObject(skyMesh); skyMesh = skyMat = null; }
    // -- 恢复初始状态:色调 / 方位角 / 俯角 / 距离 / 模拟时间
    toneMix = 0;
    toneTarget = 0;
    simT = 0;
    wavePhase = 0;
    boatY = 0;
    boatPitch = 0;
    boatRoll = 0;
    orbit.az = orbit.azT = CAM_AZ0; orbit.azV = 0;
    orbit.el = orbit.elT = 10.5; orbit.elV = 0;
    orbit.r = orbit.rT = 7.6; orbit.rV = 0;
    updateToneUi();
    // -- 重建世界与资产(重新发起对 assets/boat.glb 的网络请求)
    buildSea();
    buildSky();
    updateEnvironment(0, 0);
    loadBoat();
  } finally {
    rebuilding = false;
  }
}

window.__bench = { getState, reset };

function updateToneUi() {
  const warm = toneTarget < 0.5;
  toneBtn.textContent = warm ? '色调:暖 → 冷' : '色调:冷 → 暖';
  document.getElementById('bench-tone-label').textContent = warm
    ? '色调:暖(落日)'
    : '色调:冷(暮蓝)';
}

toneBtn.addEventListener('click', () => {
  toneTarget = toneTarget < 0.5 ? 1 : 0; // 任意时刻可反向切换
  updateToneUi();
});
resetBtn.addEventListener('click', () => reset());

// --- 主循环 -------------------------------------------------------------------------
const timer = new THREE.Timer();
timer.connect(document); // Page Visibility API:后台节流恢复后避免大步长
let appReadySet = false;

function tick() {
  requestAnimationFrame(tick);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  simT += dt;
  wavePhase = simT;

  // 色调平滑过渡(τ=0.55s,全程 << 2.5s)
  toneMix += (toneTarget - toneMix) * (1 - Math.exp(-dt / 0.55));
  if (toneTarget === 0 && toneMix < 1e-4) toneMix = 0;
  if (toneTarget === 1 && toneMix > 0.9999) toneMix = 1;

  // 环绕弹簧平滑
  [orbit.az, orbit.azV] = springStep(orbit.az, orbit.azV, orbit.azT, dt, ORBIT_OMEGA);
  [orbit.el, orbit.elV] = springStep(orbit.el, orbit.elV, orbit.elT, dt, ORBIT_OMEGA);
  [orbit.r, orbit.rV] = springStep(orbit.r, orbit.rV, orbit.rT, dt, ORBIT_OMEGA);
  applyCamera();

  updateEnvironment(toneMix, simT);
  updateBoat(dt, simT);

  renderer.render(scene, camera);

  // fps:2s 滚动平均
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length > 0 && frameTimes[0] < now - 2000) frameTimes.shift();
  fps = Math.round((frameTimes.length / 2) * 10) / 10;

  if (assetLoaded && !appReadySet) {
    appReadySet = true;
    window.__appReady = true; // 资产加载完成 + 首帧已渲染
  }
}

// --- 启动 ----------------------------------------------------------------------------
buildSea();
buildSky();
updateEnvironment(0, 0);
applyCamera();
loadBoat();
tick();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
