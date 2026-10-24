// ============================================================================
// E02 — 落日海面与孤舟(Asset Driven)| three.js r186
// ----------------------------------------------------------------------------
// 设计要点(为什么这么做):
//  1) 海面 = 极坐标网格(近密远疏)+ 顶点着色器里的 4 组 Gerstner 波:
//     波形由 GPU 每帧按全局相位 uTime 求值,因此是真实行进的重力波,
//     不是贴图 UV 滚动;顶点数 ~3.4 万(远超 2000 的下限)。
//  2) 船体起伏 = JS 端用**同一组波形参数**(WAVES)采样船位处的水面高度/坡度,
//     高度是相位耦合的(同一 uTime),姿态由水面法线决定(轻微纵摇/横摇)。
//  3) 天空 = 相机跟随的天穹球(BackSide)+ 渐变/日月光晕/圆盘/星点,
//     所有颜色由 toneMix 在暖(落日)↔冷(暮蓝)两套调色板之间逐帧插值,
//     海面、雾/地平线雾、主光、半球光、补光同源演变 —— 不是只换背景色。
//  4) reset = 显式释放(geometry/material/texture/renderLists)后整世界重建,
//     并用代次 token 丢弃“重建过程中才返回”的旧资产回调,避免泄漏与竞态。
//  5) 资产必须走真实网络请求:GLTFLoader 直接请求 'assets/boat.glb',
//     构建期不做任何转译/内联;每次重建都会重新请求并累加 assetRequests。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BOAT_URL = 'assets/boat.glb';
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const AZ_INIT = 35;          // 初始方位角(度,状态报告口径)
const ELEV_INIT = 8.5;       // 初始俯角(度)
const CAM_DIST = 9.2;        // 环绕半径
const TARGET_Y = 1.35;       // 注视点高度(把孤舟放在画面中央偏下)
const TONE_DURATION = 1.3;   // 色调过渡时长(s),合同上限 2.5s

// --- 画布与渲染器 ------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  // 允许自检时用 drawImage 采样像素(证据),对本场景开销可忽略
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  5000
);

// --- 调色板:暖端(落日)↔ 冷端(暮蓝) ----------------------------------------
// 颜色按 sRGB 十六进制书写,THREE.Color 会转到线性工作空间;
// 自定义 ShaderMaterial 内部手动做 ACES + sRGB 编码,与内置材质观感一致。
const PALETTE = {
  warm: {
    zenith: '#241c4a', horizon: '#ff9d52', sun: '#fff3d0', glow: '#ff8f3c',
    sunLight: '#ffb066', hemiSky: '#ffc79a', hemiGround: '#241a14', fill: '#e8c3a6',
    seaDeep: '#0b1a1d', seaScatter: '#1e3638', seaReflect: '#f2a768', seaSpec: '#fff0c8',
  },
  cool: {
    zenith: '#050b1f', horizon: '#27406e', sun: '#e8f0ff', glow: '#6e95da',
    sunLight: '#a9c6ff', hemiSky: '#6f8fca', hemiGround: '#060b14', fill: '#9db2d8',
    seaDeep: '#03101c', seaScatter: '#0a2236', seaReflect: '#7d9fd0', seaSpec: '#cfe2ff',
  },
};

const toColors = (src) => Object.fromEntries(Object.entries(src).map(([k, v]) => [k, new THREE.Color(v)]));
const PAL = { warm: toColors(PALETTE.warm), cool: toColors(PALETTE.cool) };

// 混合结果(每帧原地更新,做法:uniform 直接引用这些 Color 实例)
const MIX = toColors(PALETTE.warm);

function blendPalette(tone, out) {
  for (const key of Object.keys(PAL.warm)) {
    out[key].lerpColors(PAL.warm[key], PAL.cool[key], tone);
  }
}

// --- 状态 ---------------------------------------------------------------------
const S = {
  assetLoaded: false,
  assetRequests: 0,
  wavePhase: 0,        // 全局波形相位(s),单调递增,reset 不清零
  simTime: 0,          // 模拟时间(reset 归零,驱动装饰性摇摆)
  toneMix: 0,
  toneTarget: 0,
  azimuth: AZ_INIT,
  azimuthTarget: AZ_INIT,
  elevation: ELEV_INIT,
  elevationTarget: ELEV_INIT,
  epoch: 0,
  fps: 0,
  resetting: false,
  ready: false,
  boatPos: new THREE.Vector3(0, 0, 0),
};

// --- 波形参数(渲染与船体采样共用同一份事实源) --------------------------------
// dir 已归一化,避免 GPU/CPU 两端口径漂移
const WAVES = [
  { dir: [0.921, 0.390], amp: 0.170, wl: 32.0, speed: 1.00, steep: 0.32 },
  { dir: [-0.552, 0.834], amp: 0.098, wl: 19.5, speed: 1.06, steep: 0.34 },
  { dir: [0.971, -0.240], amp: 0.055, wl: 11.5, speed: 1.16, steep: 0.30 },
  { dir: [-0.622, -0.783], amp: 0.032, wl: 7.2, speed: 1.32, steep: 0.26 },
].map((w) => {
  const len = Math.hypot(w.dir[0], w.dir[1]);
  return { ...w, dir: [w.dir[0] / len, w.dir[1] / len] };
});

const WAVE_PACK = WAVES.map((w) => new THREE.Vector4(w.dir[0], w.dir[1], w.amp, w.wl));
const WAVE_EXTRA = WAVES.map((w) => new THREE.Vector4(w.speed, w.steep, 0, 0));

const G = 9.81;
const waveK = WAVES.map((w) => (Math.PI * 2) / w.wl);
const waveOmega = WAVES.map((w, i) => w.speed * Math.sqrt(G * waveK[i]));

/** 与顶点着色器同公式的高度场采样(只取竖直分量:船体贴着可见水面)。 */
function sampleWave(x, z, t, out) {
  let h = 0, dhdx = 0, dhdz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const k = waveK[i];
    const phase = k * (w.dir[0] * x + w.dir[1] * z) - waveOmega[i] * t;
    h += w.amp * Math.sin(phase);
    const c = w.amp * k * Math.cos(phase);
    dhdx += c * w.dir[0];
    dhdz += c * w.dir[1];
  }
  out.h = h; out.dhdx = dhdx; out.dhdz = dhdz;
  return out;
}
const WAVE_SAMPLE = { h: 0, dhdx: 0, dhdz: 0 };

// --- 太阳/月亮方向(固定世界方向;冷端显示为月亮) ------------------------------
// 相机在方位角 35° 看向原点,视线朝向 215°;把日/月放在 222°(视线左侧约 7°,
// 仰角 4.2°)——它出现在画面中轴附近偏左、紧贴海平线上方,且在海面拉出高光带。
const SUN_AZ = 228 * DEG;
const SUN_EL = 5.0 * DEG;
const SUN_DIR = new THREE.Vector3(
  Math.sin(SUN_AZ) * Math.cos(SUN_EL),
  Math.sin(SUN_EL),
  Math.cos(SUN_AZ) * Math.cos(SUN_EL)
).normalize();

// ============================================================================
// 天空着色器:渐变天穹 + 光晕 + 日/月盘 + 冷端星点
// ============================================================================
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uGlow;
  uniform vec3 uSunDir;
  uniform float uStars;
  uniform float uSunSize;
  uniform float uTime;
  varying vec3 vDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec3 acesFilm(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = clamp(h, 0.0, 1.0);

    // 天顶 -> 地平线的亮度/色相渐变(地平线附近才暖亮,高空迅速转深)
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.42, pow(up, 0.62)));
    // 高空轻微压暗,增强纵深
    col *= mix(1.0, 0.82, smoothstep(0.18, 0.85, up));

    // 地平线薄雾:贴近海平线的一圈暖/冷辉光
    col += uGlow * 0.26 * exp(-max(h, 0.0) * 13.0);

    // 日/月光晕(宽晕 + 紧晕)
    float cosA = clamp(dot(d, normalize(uSunDir)), -1.0, 1.0);
    float wide = pow(max(cosA, 0.0), 26.0);
    float tight = pow(max(cosA, 0.0), 220.0);
    col += uGlow * (wide * 0.85 + tight * 1.45);

    // 日/月圆盘(角半径由 uSunSize 控制,暖端太阳更大)
    float ang = acos(cosA);
    float disc = 1.0 - smoothstep(uSunSize * 0.78, uSunSize, ang);
    col = mix(col, uSunColor * 1.12, disc);

    // 冷端星点(仅地平线以上,随 toneMix 淡入)
    if (uStars > 0.002 && h > 0.03) {
      vec2 sp = d.xz / (h + 0.30) * 7.0;
      vec2 cell = floor(sp * 7.0);
      float rnd = hash21(cell);
      float twinkle = 0.55 + 0.45 * sin(uTime * 1.7 + rnd * 43.0);
      float star = step(0.9915, rnd) * smoothstep(0.03, 0.26, h);
      col += vec3(0.70, 0.80, 1.0) * star * twinkle * uStars * 1.35;
    }

    col = acesFilm(col * 1.18);
    gl_FragColor = vec4(toSRGB(col), 1.0);
  }
`;

// ============================================================================
// 海面着色器:4 组 Gerstner 波(顶点位移 + 解析法线)+ 菲涅尔/日光镜面/雾
// ============================================================================
const SEA_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec4 uWaves[4];      // (dirX, dirZ, amplitude, wavelength)
  uniform vec4 uWaveExtra[4];  // (speedFactor, steepness, -, -)
  varying vec3 vWorld;
  varying vec3 vN;

  vec3 waveOffset(vec2 p, float t, float dist) {
    vec3 o = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec4 w = uWaves[i];
      float k = 6.28318530718 / w.w;
      float omega = uWaveExtra[i].x * sqrt(9.81 * k);
      float phase = k * dot(w.xy, p) - omega * t;
      // 距离 LOD:短波在远处先消失,避免大三角形采样造成的锯齿/摩尔纹
      float lod = 1.0 - smoothstep(w.w * 16.0, w.w * 52.0, dist);
      lod *= 1.0 - 0.65 * smoothstep(260.0, 760.0, dist);
      float amp = w.z * lod;
      float qa = (uWaveExtra[i].y / (k * 8.0)) * lod; // 水平位移幅度
      float c = cos(phase);
      o.x += qa * w.x * c;
      o.z += qa * w.y * c;
      o.y += amp * sin(phase);
    }
    return o;
  }

  void main() {
    vec3 base = position;
    float camDist = length(cameraPosition - vec3(base.x, 0.0, base.z));
    vec3 center = base + waveOffset(base.xz, uTime, camDist);
    float eps = 0.45;
    vec3 px = base + waveOffset(base.xz + vec2(eps, 0.0), uTime, camDist);
    vec3 pz = base + waveOffset(base.xz + vec2(0.0, eps), uTime, camDist);
    vec3 n = normalize(cross(pz - center, px - center));
    if (n.y < 0.0) n = -n;

    vec4 wp = modelMatrix * vec4(center, 1.0);
    vWorld = wp.xyz;
    vN = n;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SEA_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uDeep;
  uniform vec3 uScatter;
  uniform vec3 uReflect;
  uniform vec3 uSpecColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunPower;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vN;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 acesFilm(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }

  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    float camDist = length(cameraPosition - vWorld);

    // 多倍频的方向性细波:只扰动法线(逐像素)。斜率幅度大于几何长波,
    // 让掠射反射碎成细密条纹/鳞光,而不是大片“光滑沙丘”。
    float dFade = clamp(1.0 - camDist / 90.0, 0.0, 1.0);
    vec2 rp = vWorld.xz;
    vec2 s2 = vec2(0.0);
    s2 += vec2(0.921, 0.390) * (0.110 * cos(dot(rp, vec2(0.921, 0.390)) * 2.20 + uTime * 2.0));
    s2 += vec2(-0.552, 0.834) * (0.090 * cos(dot(rp, vec2(-0.552, 0.834)) * 3.40 + uTime * 2.7));
    s2 += vec2(0.971, -0.240) * (0.070 * cos(dot(rp, vec2(0.971, -0.240)) * 5.30 + uTime * 3.4));
    s2 += vec2(-0.622, -0.783) * (0.050 * cos(dot(rp, vec2(-0.622, -0.783)) * 8.70 + uTime * 4.3));
    s2 += vec2(0.200, 0.980) * (0.035 * cos(dot(rp, vec2(0.200, 0.980)) * 13.90 + uTime * 5.2));
    N = normalize(N + vec3(s2.x, 0.0, s2.y) * dFade);

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

    // 反射天空:掠射方向反射地平线(暖橙/冷蓝),反射角越大越偏天顶(冷)。
    // 冷暖反差正是细波在掠射角下形成“水纹/鳞光”的来源。
    vec3 R = reflect(-V, N);
    vec3 reflHigh = mix(uZenith * 1.15, uHorizon * 0.30, 0.30);
    vec3 skyRefl = mix(uHorizon * 0.88, reflHigh, smoothstep(0.0, 0.40, clamp(R.y, 0.0, 1.0)));

    // 水体本身:波峰处更亮(散射近似)
    float crest = clamp(vWorld.y * 0.62 + 0.42, 0.0, 1.0);
    vec3 body = mix(uDeep, uScatter, crest);

    // 日光/月光镜面:窄高光 + 宽光泽 + 抖动碎光(形成海面高光带)
    float nh = max(dot(N, H), 0.0);
    float spec = pow(nh, 380.0) * 2.9 + pow(nh, 34.0) * 0.16;
    float sparkle = hash12(floor(vWorld.xz * 3.5) + vec2(floor(uTime * 5.0), 0.0));
    spec += pow(nh, 140.0) * smoothstep(0.55, 1.0, sparkle) * 2.6;

    vec3 col = mix(body, skyRefl * 0.62, clamp(fres * 1.15, 0.0, 0.85));
    // 水体吸收色始终参与一点:即使掠射也不会变成“纯天空镜面”(否则像沙丘)
    col = mix(col, uScatter * 0.62, 0.10);
    // 反射射线对准光源时的亮带(日光在水面的“柱状”通路)
    float path = pow(max(dot(R, L), 0.0), 18.0);
    col = mix(col, uReflect, clamp(path * 0.55, 0.0, 0.42));
    col += uSpecColor * spec * uSunPower * (0.50 + 0.50 * uSunColor);

    // 浪尖极少量白沫
    float foam = smoothstep(0.36, 0.48, vWorld.y) * 0.075;
    col = mix(col, uHorizon * 0.9 + vec3(0.04), foam);

    // 距离雾:远处渐隐到地平线色,保证海天衔接无缝
    float haze = 1.0 - exp(-camDist * 0.0022);
    col = mix(col, uHorizon * 0.94, clamp(haze, 0.0, 0.90));

    col = acesFilm(col * 1.10);
    gl_FragColor = vec4(toSRGB(col), 1.0);
  }
`;

// ============================================================================
// 世界对象与生命周期
// ============================================================================
let skyMesh = null;
let seaMesh = null;
let skyMat = null;
let seaMat = null;
let sunLight = null;
let hemiLight = null;
let fillLight = null;
let boatPivot = null;   // 承载 GLB 的枢轴(位置/姿态由波浪驱动)
let boatRoot = null;    // 当前 GLB 实例
let loadToken = 0;      // 世界代次:丢弃过期回调

const gltfLoader = new GLTFLoader();
const SEA_VERT_COUNT = (() => { const R = 150, S = 224; return (R + 1) * S; })();

function makeSeaGeometry() {
  const RINGS = 150;
  const SEG = 224;
  const R_MIN = 0.4;
  const R_MAX = 900;
  const count = (RINGS + 1) * SEG;
  const pos = new Float32Array(count * 3);
  let p = 0;
  for (let i = 0; i <= RINGS; i++) {
    // 半径按几何级数增长:近处环密(波形细节),远处环疏(层次化 LOD)
    const r = R_MIN * Math.pow(R_MAX / R_MIN, i / RINGS);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }
  const idx = new Uint32Array(RINGS * SEG * 6);
  let q = 0;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const j2 = (j + 1) % SEG;
      const a = i * SEG + j;
      const b = i * SEG + j2;
      const c = (i + 1) * SEG + j;
      const d = (i + 1) * SEG + j2;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_MAX);
  return geo;
}

function buildWorld() {
  // --- 天空(始终跟随相机,视觉上位于无限远)
  skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: MIX.zenith },
      uHorizon: { value: MIX.horizon },
      uSunColor: { value: MIX.sun },
      uGlow: { value: MIX.glow },
      uSunDir: { value: SUN_DIR },
      uStars: { value: 0 },
      uSunSize: { value: 0.020 },
      uTime: { value: 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1600, 48, 32), skyMat);
  skyMesh.renderOrder = -10;
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  // --- 海面(极坐标网格)
  seaMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaves: { value: WAVE_PACK },
      uWaveExtra: { value: WAVE_EXTRA },
      uHorizon: { value: MIX.horizon },
      uZenith: { value: MIX.zenith },
      uDeep: { value: MIX.seaDeep },
      uScatter: { value: MIX.seaScatter },
      uReflect: { value: MIX.seaReflect },
      uSpecColor: { value: MIX.seaSpec },
      uSunColor: { value: MIX.sun },
      uSunDir: { value: SUN_DIR },
      uSunPower: { value: 1.0 },
    },
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    side: THREE.DoubleSide,
    fog: false,
  });
  seaMesh = new THREE.Mesh(makeSeaGeometry(), seaMat);
  seaMesh.frustumCulled = false;
  scene.add(seaMesh);

  // --- 光照:主光(暖金/冷蓝)+ 半球环境 + 反侧补光
  sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
  sunLight.position.copy(SUN_DIR).multiplyScalar(60);
  scene.add(sunLight);

  hemiLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9);
  scene.add(hemiLight);

  fillLight = new THREE.DirectionalLight(0xffffff, 1.1);
  // 补光来自相机这一侧的高处(逆光落日下让船体正面仍然可读)
  fillLight.position.set(Math.sin(40 * DEG) * 30, 34, Math.cos(40 * DEG) * 30);
  scene.add(fillLight);

  // --- 船体枢轴(asset 加载完成后挂入)
  boatPivot = new THREE.Group();
  boatPivot.name = 'BoatPivot';
  scene.add(boatPivot);
  boatRoot = null;

  applyPaletteToScene();
}

function applyPaletteToScene() {
  if (!sunLight) return;
  sunLight.color.copy(MIX.sunLight);
  hemiLight.color.copy(MIX.hemiSky);
  hemiLight.groundColor.copy(MIX.hemiGround);
  fillLight.color.copy(MIX.fill);
  // 冷端月光更弱、更均匀
  sunLight.intensity = 2.9 - 1.1 * S.toneMix;
  hemiLight.intensity = 0.85 - 0.15 * S.toneMix;
  fillLight.intensity = 1.15 - 0.25 * S.toneMix; // 逆光场景的正面补光,保证船体材质可辨
  if (skyMat) {
    skyMat.uniforms.uStars.value = S.toneMix;
    skyMat.uniforms.uSunSize.value = 0.0205 - 0.006 * S.toneMix; // 太阳略大于月亮
  }
  if (seaMat) {
    seaMat.uniforms.uSunPower.value = 1.0 - 0.45 * S.toneMix;
  }
}

function disposeTree(obj, disposed) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry && !disposed.has(o.geometry)) {
      disposed.add(o.geometry);
      o.geometry.dispose();
    }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (disposed.has(m)) continue;
      disposed.add(m);
      // 材质上所有贴图都要显式释放(本资产的 PBR 材质无贴图,仍按通用路径处理)
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture && !disposed.has(v)) {
          disposed.add(v);
          v.dispose();
        }
      }
      m.dispose();
    }
  });
  if (obj.parent) obj.parent.remove(obj);
}

function disposeWorld() {
  const disposed = new Set();
  disposeTree(skyMesh, disposed);
  disposeTree(seaMesh, disposed);
  disposeTree(boatPivot, disposed);
  if (sunLight) { scene.remove(sunLight); sunLight.dispose?.(); }
  if (hemiLight) { scene.remove(hemiLight); hemiLight.dispose?.(); }
  if (fillLight) { scene.remove(fillLight); fillLight.dispose?.(); }
  skyMesh = null; seaMesh = null; skyMat = null; seaMat = null;
  sunLight = null; hemiLight = null; fillLight = null;
  boatPivot = null; boatRoot = null;
  renderer.renderLists.dispose(); // 释放上一代渲染列表缓存
}

// --- 资产加载 ----------------------------------------------------------------
function loadBoat() {
  const token = ++loadToken;
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      BOAT_URL,
      (gltf) => {
        if (token !== loadToken || !boatPivot) {
          // 世界已换代:丢弃这次结果并释放,避免悬挂引用/泄漏
          disposeTree(gltf.scene, new Set());
          resolve(null);
          return;
        }
        const root = gltf.scene;
        root.traverse((o) => {
          if (o.isMesh) {
            o.frustumCulled = false; // 船始终在视野内,省去逐帧包围球更新
            if (o.material) o.material.envMapIntensity = 0.7;
          }
        });
        boatRoot = root;
        boatPivot.add(root);
        S.assetLoaded = true;
        S.assetRequests += 1;
        hideError();
        updateBoat(1, true); // 立即落到当前波面,避免首帧穿帮
        resolve(root);
      },
      undefined,
      (err) => {
        if (token === loadToken) {
          S.assetLoaded = false;
          showError('资产加载失败:assets/boat.glb' + (err && err.message ? ' — ' + err.message : ''));
        }
        reject(err instanceof Error ? err : new Error('boat.glb load failed'));
      }
    );
  });
}

// --- 船体随波起伏(y 与波形相位同源,姿态取水面法线) --------------------------
const _qTilt = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _box = new THREE.Box3();
const _center = new THREE.Vector3();

function updateBoat(dt, snap) {
  if (!boatPivot || !boatRoot) return;
  sampleWave(0, 0, S.wavePhase, WAVE_SAMPLE);
  const waterY = WAVE_SAMPLE.h + 0.10; // 吃水:船体略沉入水面

  const k = snap ? 1 : Math.min(1, dt * 8);
  boatPivot.position.y += (waterY - boatPivot.position.y) * k;

  // 水面法线 -> 纵摇/横摇(轻微,按 0.75 衰减,避免像暴风)
  _n.set(-WAVE_SAMPLE.dhdx * 0.75, 1, -WAVE_SAMPLE.dhdz * 0.75).normalize();
  _qTilt.setFromUnitVectors(UP, _n);
  _qYaw.setFromAxisAngle(UP, Math.sin(S.simTime * 0.42) * 0.05);
  _qTarget.copy(_qTilt).multiply(_qYaw);
  if (snap) boatPivot.quaternion.copy(_qTarget);
  else boatPivot.quaternion.slerp(_qTarget, Math.min(1, dt * 5));

  boatPivot.updateMatrixWorld(true);
  _box.setFromObject(boatRoot);
  _box.getCenter(_center);
  S.boatPos.copy(_center);
}

// --- 相机 ---------------------------------------------------------------------
function updateCamera(dt, snap) {
  const k = snap ? 1 : 1 - Math.exp(-dt * 11);
  S.azimuth += (S.azimuthTarget - S.azimuth) * k;
  S.elevation += (S.elevationTarget - S.elevation) * k;

  const az = S.azimuth * DEG;
  const el = S.elevation * DEG;
  const horiz = Math.cos(el) * CAM_DIST;
  camera.position.set(
    Math.sin(az) * horiz,
    TARGET_Y + Math.sin(el) * CAM_DIST,
    Math.cos(az) * horiz
  );
  camera.lookAt(0, TARGET_Y, 0);
}

function normalizeAzimuth(a) {
  const v = ((a % 360) + 360) % 360;
  return Math.round(v * 1e6) / 1e6;
}

// --- UI ----------------------------------------------------------------------
const toneBtn = document.getElementById('tone-toggle');
const resetBtn = document.getElementById('reset');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');

function updateToneButton() {
  if (!toneBtn) return;
  toneBtn.textContent = S.toneTarget > 0.5 ? '色调:暮蓝' : '色调:落日';
  toneBtn.classList.toggle('is-cool', S.toneTarget > 0.5);
}

function showError(msg) {
  if (!errorEl) return;
  errorEl.textContent = String(msg);
  errorEl.hidden = false;
}
function hideError() {
  if (errorEl) errorEl.hidden = true;
}
function hideLoading() {
  if (loadingEl) loadingEl.classList.add('hidden');
}

function toggleTone() {
  S.toneTarget = S.toneTarget > 0.5 ? 0 : 1;
  updateToneButton();
}

// --- 指针拖拽(水平环绕 + 垂直微调俯角) ---------------------------------------
let dragging = false;
let lastX = 0;
let lastY = 0;
let lastPointerDownAt = -1e9;

function beginDrag(x, y) {
  dragging = true;
  lastX = x;
  lastY = y;
}
function moveDrag(x, y) {
  if (!dragging) return;
  const dx = x - lastX;
  const dy = y - lastY;
  lastX = x;
  lastY = y;
  // 0.20°/px:横拖 0.28 视口宽(≈358px)≈ 72°,满足探针 >= 20° 的要求
  S.azimuthTarget -= dx * 0.20;
  S.elevationTarget = Math.min(22, Math.max(2, S.elevationTarget + dy * 0.06));
}
function endDrag() { dragging = false; }

window.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas) return;
  lastPointerDownAt = performance.now();
  beginDrag(e.clientX, e.clientY);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 非关键 */ }
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// 兼容“脚本合成 MouseEvent”(没有 pointer 事件)的测试驱动
window.addEventListener('mousedown', (e) => {
  if (e.target !== canvas) return;
  if (performance.now() - lastPointerDownAt < 250) return; // 真实鼠标已由 pointerdown 处理
  beginDrag(e.clientX, e.clientY);
});
window.addEventListener('mousemove', (e) => {
  // 真实鼠标的 pointermove 已更新 lastX,这里 dx 为 0,不会重复累计
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dragstart', (e) => e.preventDefault());

toneBtn.addEventListener('click', toggleTone);
resetBtn.addEventListener('click', () => { void doReset(); });

// --- reset:释放并整世界重建(不是刷新页面) -----------------------------------
async function doReset() {
  if (S.resetting) return;
  S.resetting = true;
  S.epoch += 1;
  S.assetLoaded = false;
  // assetRequests 只增不减:每次重建的真实加载成功后再 +1
  S.toneMix = 0;
  S.toneTarget = 0;
  S.azimuth = AZ_INIT;
  S.azimuthTarget = AZ_INIT;
  S.elevation = ELEV_INIT;
  S.elevationTarget = ELEV_INIT;
  S.simTime = 0;
  S.boatPos.set(0, 0, 0);
  updateToneButton();

  disposeWorld();
  buildWorld();
  blendPalette(0, MIX);
  updateCamera(0, true);

  try {
    await loadBoat();
  } catch (err) {
    showError(err && err.message ? err.message : '资产加载失败');
  } finally {
    S.resetting = false;
    updateToneButton();
  }
}

// --- 主循环 -------------------------------------------------------------------
const frameStamps = [];
let lastNow = performance.now();
const _paletteTone = { v: 0 };

function tick(now) {
  const dt = Math.min(0.06, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  S.wavePhase += dt;   // 单调递增:海面相位永不回退(reset 也不回退)
  S.simTime += dt;

  // 色调过渡(线性推近,1.3s 到位,<= 2.5s 合同上限)
  if (S.toneMix < S.toneTarget) S.toneMix = Math.min(S.toneTarget, S.toneMix + dt / TONE_DURATION);
  else if (S.toneMix > S.toneTarget) S.toneMix = Math.max(S.toneTarget, S.toneMix - dt / TONE_DURATION);

  // 用 smoothstep 做视觉上的缓入缓出(toneMix 状态值本身保持线性可断言)
  const e = S.toneMix * S.toneMix * (3 - 2 * S.toneMix);
  if (Math.abs(e - _paletteTone.v) > 1e-5) {
    _paletteTone.v = e;
    blendPalette(e, MIX);
    applyPaletteToScene();
  }

  updateCamera(dt, false);
  updateBoat(dt, false);

  if (skyMat) skyMat.uniforms.uTime.value = S.simTime;
  if (seaMat) seaMat.uniforms.uTime.value = S.wavePhase;
  if (skyMesh) skyMesh.position.copy(camera.position); // 天穹跟随相机

  renderer.render(scene, camera);

  // fps:最近 2s 滚动平均
  frameStamps.push(now);
  while (frameStamps.length > 1 && frameStamps[0] < now - 2000) frameStamps.shift();
  const span = Math.min(2, (now - frameStamps[0]) / 1000);
  S.fps = span > 0.25 ? frameStamps.length / span : S.fps;

  if (!S.ready && S.assetLoaded) {
    S.ready = true;
    window.__appReady = true;
    hideLoading();
  }

  requestAnimationFrame(tick);
}

// --- 页面契约 -----------------------------------------------------------------
window.__bench = {
  getState() {
    return {
      engine: 'three',
      assetLoaded: S.assetLoaded,
      assetRequests: S.assetRequests,
      boatPosition: { x: S.boatPos.x, y: S.boatPos.y, z: S.boatPos.z },
      wavePhase: S.wavePhase,
      toneMix: S.toneMix,
      cameraAzimuth: normalizeAzimuth(S.azimuth),
      fps: Math.round(S.fps * 10) / 10,
      epoch: S.epoch,
      // 诊断字段(不属于合同必需项)
      ready: window.__appReady === true,
      seaVertices: SEA_VERT_COUNT,
      toneTarget: S.toneTarget,
      resetting: S.resetting,
    };
  },
  reset() { void doReset(); },
};

// --- 启动 ---------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

buildWorld();
updateCamera(0, true);
blendPalette(0, MIX);
applyPaletteToScene();
loadBoat().catch(() => { /* 错误已由 showError 呈现,保持无未捕获异常 */ });
requestAnimationFrame(tick);
