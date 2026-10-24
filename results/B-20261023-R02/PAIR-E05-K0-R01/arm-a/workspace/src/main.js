// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— three r186 实现
// ----------------------------------------------------------------------------
// 组成:
//   1) 深空背景:程序化星云 canvas 纹理(scene.background)+ 460 颗自定义着色器
//      星点(大小/亮度/冷暖差异,加色混合);
//   2) 事件视界:半径 1.2 的纯黑球(屏幕上即"暗核",遮挡其后的盘与星流);
//   3) 吸积盘:XZ 平面环形 ShaderMaterial(内缘白/蓝白 → 中带黄橙 → 外缘暗红,
//      螺旋条纹随 uPhase 刚性旋转,多普勒不对称:一侧增亮偏蓝);
//   4) 光子环/透镜观感:XY 平面(面向相机)内亮外暗的蓝白光环,上弧更亮;
//   5) 外围柔光晕圈:更大更淡的暖色环,亮部向环外柔和衰减(辉光观感);
//   6) 星流:240 粒子 × 6 段解析拖尾,螺旋加速汇入,视界处吞噬、外圈重生;
//   7) 后处理:EffectComposer + UnrealBloom(辉光)+ OutputPass(ACES 色调映射)。
// 页面契约:
//   window.__appReady = true(首帧渲染后);window.__bench = { getState, reset }。
// 状态通道(真实数据):diskRotation / accretionPhase / cameraDistance /
//   starStreamCount / backgroundStarCount。
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------- 常量(与 spec.json 对齐)------------------------------------------
const DISK_INNER = 1.8;          // 吸积盘内缘半径(场景单位)
const DISK_outer = 6.5;          // 吸积盘外缘半径
const HORIZON_R = 1.2;           // 事件视界半径
const DISK_OMEGA = 0.4;          // 盘条纹角速度 rad/s(spec: 0.15–0.6)
const DIST0 = 14.0;              // 初始相机距离
const DIST_MIN = 5.0, DIST_MAX = 28.0;
const ELEV = THREE.MathUtils.degToRad(24); // 相机仰角(盘面与视线夹角 24° ∈ 15–75°)
const STAR_STREAM_N = 240;       // 星流粒子数(>=200,恒定)
const BG_STAR_N = 460;           // 背景星点数(>=300,恒定)
const TRAIL_N = 6;               // 每粒子拖尾采样数(含头)
const TWO_PI = Math.PI * 2;

// ---------- 确定性随机(初始状态与 reset 后一致)--------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261023);

// ---------- 渲染器 / 场景 / 相机 ------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 亮部柔和滚降,曝光舒适
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 300
);

// 相机状态:仰角固定、方位固定、距离平滑插值(滚轮改变目标距离)
let camDist = DIST0;          // 当前距离(平滑后,进 getState)
let camDistTarget = DIST0;    // 目标距离(滚轮直接改这个)
const SMOOTH_TAU = 0.12;      // 平滑时间常数(s):1s 内基本到位(残差 <1%)
function placeCamera() {
  camera.position.set(0, Math.sin(ELEV) * camDist, Math.cos(ELEV) * camDist);
  camera.lookAt(0, 0, 0);
}
placeCamera();

// ---------- 1) 深空背景:程序化星云纹理 ----------------------------------------
// 极暗基底 + 几团冷色星云渐变(角落保留 ~(8,11,22) 的非纯黑冷色,避免四角死黑)
function makeNebulaTexture() {
  const w = 512, h = 288;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0a0e20';
  ctx.fillRect(0, 0, w, h);
  const blobs = [
    { x: 0.16, y: 0.32, r: 0.62, c: '30,52,104', a: 0.20 },
    { x: 0.84, y: 0.66, r: 0.55, c: '44,30,84', a: 0.16 },
    { x: 0.55, y: 0.12, r: 0.38, c: '22,58,88', a: 0.13 },
    { x: 0.32, y: 0.88, r: 0.46, c: '18,40,76', a: 0.13 },
    { x: 0.93, y: 0.14, r: 0.34, c: '32,54,96', a: 0.11 },
    { x: 0.05, y: 0.95, r: 0.34, c: '26,44,86', a: 0.12 },
  ];
  for (const b of blobs) {
    const cx = b.x * w, cy = b.y * h, rr = b.r * Math.min(w, h);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
    g.addColorStop(0, `rgba(${b.c},${b.a})`);
    g.addColorStop(1, `rgba(${b.c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeNebulaTexture();

// ---------- 2) 背景星点(自定义 Points 着色器:像素级大小 + 柔和圆点)-----------
const starGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(BG_STAR_N * 3);
  const col = new Float32Array(BG_STAR_N * 3);
  const alp = new Float32Array(BG_STAR_N);
  const siz = new Float32Array(BG_STAR_N);
  const r0 = mulberry32(777);
  for (let i = 0; i < BG_STAR_N; i++) {
    // 球壳均匀分布(半径 95–140,远景)
    const z = r0() * 2 - 1, phi = r0() * TWO_PI;
    const rad = 95 + r0() * 45;
    const xy = Math.sqrt(Math.max(0, 1 - z * z)) * rad;
    pos[i * 3] = Math.cos(phi) * xy;
    pos[i * 3 + 1] = Math.sin(phi) * xy;
    pos[i * 3 + 2] = z * rad;
    // 颜色:多数白,少数冷蓝/暖黄;亮度差异大
    const kind = r0();
    let c;
    if (kind < 0.14) c = [0.72, 0.84, 1.25];       // 冷蓝亮星
    else if (kind < 0.26) c = [1.25, 0.98, 0.72];  // 暖星
    else c = [1, 1, 1];
    const b = 0.35 + Math.pow(r0(), 1.8) * 1.15;
    col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
    alp[i] = 0.45 + r0() * 0.55;
    // 大小三档:大量小星、少量亮星
    const s = r0();
    siz[i] = s < 0.72 ? 1.6 + r0() * 0.7 : (s < 0.95 ? 2.4 + r0() * 0.9 : 3.4 + r0() * 1.4);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  starGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
}
const starMat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: renderer.getPixelRatio() } },
  vertexShader: /* glsl */`
    attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
    uniform float uPx;
    varying vec3 vC; varying float vA;
    void main() {
      vC = aColor; vA = aAlpha;
      gl_PointSize = aSize * uPx;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vC; varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float m = smoothstep(0.5, 0.1, d);
      gl_FragColor = vec4(vC * (vA * m), 1.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const bgStars = new THREE.Points(starGeo, starMat);
bgStars.frustumCulled = false;
scene.add(bgStars);

// ---------- 3) 事件视界(纯黑球 = 观感暗核,遮挡后方物体)------------------------
const horizon = new THREE.Mesh(
  new THREE.SphereGeometry(HORIZON_R, 64, 48),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
scene.add(horizon);

// ---------- 4) 吸积盘主环(XZ 平面,加色混合的自定义着色器)---------------------
// 条纹图案 f(theta - uPhase) 随 uPhase 刚性旋转 → 视觉角速度 === diskRotation 增速
const diskMat = new THREE.ShaderMaterial({
  uniforms: {
    uPhase: { value: 0 },
    uInner: { value: DISK_INNER },
    uOuter: { value: DISK_outer },
  },
  vertexShader: /* glsl */`
    varying vec2 vP;
    void main() {
      vP = position.xy; // RingGeometry 局部坐标(网格再整体旋到 XZ 平面)
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uPhase; uniform float uInner; uniform float uOuter;
    varying vec2 vP;
    void main() {
      float r = length(vP);
      float theta = atan(vP.y, vP.x);
      float u = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);

      // 径向基线:内缘窄条白亮(指数衰减,热点集中)→ 外缘暗红;内外缘平滑无硬边
      float w = smoothstep(0.0, 0.06, u) * (1.1 * exp(-3.2 * u));
      w = max(w, 0.10 * pow(1.0 - u, 2.0)); // 外围薄层柔化外边界

      // 旋转螺旋条纹:11 臂 + r 向螺旋偏移;图案随 uPhase 刚性旋转
      float stripes = 0.72 + 0.28 * sin((theta - uPhase) * 11.0 + r * 1.9);
      stripes *= 0.86 + 0.14 * sin((theta - uPhase) * 3.0 - r * 0.55);

      // 多普勒不对称:theta≈0(朝向观察者)一侧增亮、微蓝移;对侧减暗、微红移
      float dop = cos(theta);
      float bright = 1.0 + 0.9 * dop;

      // 径向色带:白/蓝白 → 黄橙 → 暗红
      vec3 col = mix(vec3(0.92, 0.96, 1.06), vec3(1.0, 0.62, 0.18), smoothstep(0.0, 0.42, u));
      col = mix(col, vec3(0.55, 0.12, 0.035), smoothstep(0.38, 1.0, u));
      col += vec3(-0.06, 0.0, 0.12) * max(dop, 0.0) * (1.0 - u);
      col += vec3(0.10, 0.02, -0.05) * max(-dop, 0.0) * 0.5;

      float I = w * stripes * bright * 1.1;
      gl_FragColor = vec4(col * I, 1.0);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
const disk = new THREE.Mesh(new THREE.RingGeometry(DISK_INNER, DISK_outer, 256, 8), diskMat);
disk.rotation.x = -Math.PI / 2; // XY → XZ 水平盘
scene.add(disk);

// ---------- 5) 外围柔光晕圈(更大更淡,亮部向环外柔和衰减)----------------------
const haloMat = new THREE.ShaderMaterial({
  uniforms: { uPhase: { value: 0 } },
  vertexShader: diskMat.vertexShader,
  fragmentShader: /* glsl */`
    uniform float uPhase;
    varying vec2 vP;
    void main() {
      float r = length(vP);
      float theta = atan(vP.y, vP.x);
      float u = clamp((r - 1.55) / (9.2 - 1.55), 0.0, 1.0);
      float w = smoothstep(0.0, 0.10, u) * pow(1.0 - u, 2.0);
      float dop = 1.0 + 0.35 * cos(theta); // 与主盘同侧微增强
      vec3 col = mix(vec3(1.0, 0.55, 0.20), vec3(0.45, 0.10, 0.05), smoothstep(0.1, 0.9, u));
      gl_FragColor = vec4(col * (0.09 * w * dop), 1.0);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
const halo = new THREE.Mesh(new THREE.RingGeometry(1.55, 9.2, 128, 4), haloMat);
halo.rotation.x = -Math.PI / 2;
scene.add(halo);

// ---------- 6) 光子环(XY 立面,蓝白内亮外暗,上弧更亮 = 透镜观感)----------------
const photonMat = new THREE.ShaderMaterial({
  uniforms: { uPhase: { value: 0 } },
  vertexShader: diskMat.vertexShader,
  fragmentShader: /* glsl */`
    varying vec2 vP;
    void main() {
      float r = length(vP);
      float u = clamp((r - 1.3) / (2.1 - 1.3), 0.0, 1.0);
      float w = pow(1.0 - u, 3.0) * smoothstep(0.0, 0.06, u);
      float up = 1.0 + 0.35 * smoothstep(-0.2, 1.0, vP.y / max(r, 1e-4)); // 上弧更亮
      vec3 col = mix(vec3(0.78, 0.88, 1.05), vec3(1.0, 0.72, 0.45), smoothstep(0.1, 1.0, u));
      gl_FragColor = vec4(col * (w * up * 1.25), 1.0);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
const photonRing = new THREE.Mesh(new THREE.RingGeometry(1.3, 2.1, 256, 4), photonMat);
scene.add(photonRing); // 位于 XY 平面(z≈0),面向相机 → 围绕暗核的近圆光环

// ---------- 6b) 核心辉光(面向相机的径向渐变板;中心被黑球深度遮挡 → 环状柔光)----
// 用途:即便 bloom 克制,也保证"亮部向四周柔光扩散"的观感;深度测试使暗核中心保持纯黑
const glowMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      float d = length(vUv * 2.0 - 1.0);          // 0=中心,1=板边缘
      float i = 0.40 * exp(-3.6 * d);             // 指数柔光衰减(无硬边)
      vec3 col = mix(vec3(0.80, 0.88, 1.05), vec3(1.0, 0.72, 0.42), smoothstep(0.1, 0.8, d));
      gl_FragColor = vec4(col * i, 1.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const coreGlow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 7.5), glowMat);
scene.add(coreGlow); // 每帧 billboard 对齐相机(见主循环)

// ---------- 7) 星流:240 粒子螺旋汇入 + 解析拖尾(近核加速拉长)------------------
// 每粒子 6 个点(头 + 5 拖尾采样):拖尾位置由当前运动状态回推(解析),无需历史缓存
const streamGeo = new THREE.BufferGeometry();
const streamPos = new Float32Array(STAR_STREAM_N * TRAIL_N * 3);
const streamCol = new Float32Array(STAR_STREAM_N * TRAIL_N * 3);
const streamAlp = new Float32Array(STAR_STREAM_N * TRAIL_N);
const streamSiz = new Float32Array(STAR_STREAM_N * TRAIL_N);
streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
streamGeo.setAttribute('aColor', new THREE.BufferAttribute(streamCol, 3));
streamGeo.setAttribute('aAlpha', new THREE.BufferAttribute(streamAlp, 1));
streamGeo.setAttribute('aSize', new THREE.BufferAttribute(streamSiz, 1));
const streamMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 1 } },
  vertexShader: /* glsl */`
    attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
    uniform float uScale;
    varying vec3 vC; varying float vA;
    void main() {
      vC = aColor; vA = aAlpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 64.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vC; varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float m = smoothstep(0.5, 0.06, d);
      gl_FragColor = vec4(vC * (vA * m), 1.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const stream = new THREE.Points(streamGeo, streamMat);
stream.frustumCulled = false;
scene.add(stream);

const particles = new Array(STAR_STREAM_N);
function seedParticles(rand) {
  for (let i = 0; i < STAR_STREAM_N; i++) {
    particles[i] = {
      r: 1.35 + rand() * 8.05,          // 初始铺满全轨道 → t=0 即稳态
      theta: rand() * TWO_PI,
      spd: 0.75 + rand() * 0.6,         // 个体速度系数
      yJit: (rand() - 0.5) * 0.16,      // 盘面附近的薄层抖动
      warm: rand(),                     // 色相微差
    };
  }
}
function respawn(p, rand) {
  p.r = 6.8 + rand() * 2.6;             // 外圈重生
  p.theta = rand() * TWO_PI;
  p.spd = 0.75 + rand() * 0.6;
  p.yJit = (rand() - 0.5) * 0.16;
  p.warm = rand();
}
seedParticles(rng);

function omegaAt(r, spd) { return (2.4 / Math.pow(Math.max(r, 0.4), 1.5)) * spd; }
function vrAt(r, spd) { return -(0.22 + 1.35 * Math.pow(HORIZON_R / Math.max(r, 0.4), 3)) * spd; }

function updateStream(dt) {
  const rand = rng;
  for (let i = 0; i < STAR_STREAM_N; i++) {
    const p = particles[i];
    const om = omegaAt(p.r, p.spd);
    p.theta += om * dt;
    p.r += vrAt(p.r, p.spd) * dt;
    if (p.r <= 1.16) respawn(p, rand);  // 越过视界 → 吞噬,外圈重生(总数恒定)

    // 拖尾:由当前 (r, theta, om, vr) 回推过去 T 秒的解析位置;越近核速度越快 → 拖尾越长
    const heat = THREE.MathUtils.clamp((5.2 - p.r) / 3.6, 0, 1);
    const T = 0.16 + 0.6 * heat;
    const vr = vrAt(p.r, p.spd);
    const hotR = Math.min(1, 0.25 + heat);
    const headCol = [
      0.85 + 0.35 * hotR * (0.4 + p.warm * 0.6), // R
      0.78 + 0.18 * hotR,                        // G
      0.6 + 0.6 * hotR,                          // B(近核偏蓝白)
    ];
    const headSize = 0.085 + 0.05 * heat;
    for (let k = 0; k < TRAIL_N; k++) {
      const tk = (T * k) / (TRAIL_N - 1);
      const rk = Math.min(p.r - vr * tk, 9.6);   // vr<0 → 过去更靠外
      const thk = p.theta - om * tk;
      const j = (i * TRAIL_N + k) * 3;
      streamPos[j] = Math.cos(thk) * rk;
      streamPos[j + 1] = p.yJit * (1 - 0.5 * (rk / 9.6)); // 靠外略薄
      streamPos[j + 2] = Math.sin(thk) * rk;
      const fade = Math.pow(1 - k / (TRAIL_N - 1), 1.7);
      const b = 0.32 + 0.68 * heat;              // 头部亮度随接近核心提升
      streamCol[j] = headCol[0] * b;
      streamCol[j + 1] = headCol[1] * b;
      streamCol[j + 2] = headCol[2] * b;
      streamAlp[i * TRAIL_N + k] = 0.95 * fade;
      streamSiz[i * TRAIL_N + k] = headSize * (1 - 0.1 * k);
    }
  }
  streamGeo.attributes.position.needsUpdate = true;
  streamGeo.attributes.aColor.needsUpdate = true;
  streamGeo.attributes.aAlpha.needsUpdate = true;
  streamGeo.attributes.aSize.needsUpdate = true;
}

// ---------- 8) 后处理:UnrealBloom 辉光 + ACES 输出 ----------------------------
const rt = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, // HDR 通道,亮部 >1 的信息保留给 bloom
  samples: 4,                // MSAA:暗核边缘干净锐利
});
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.36, // strength:只给最热部分(内缘/光子环/亮星)柔和扩散,避免冲刷暗核
  0.4,  // radius
  1.4   // threshold:仅 HDR >1.4 的亮部进入辉光
);
composer.addPass(bloom);
composer.addPass(new OutputPass()); // 色调映射 + sRGB 输出

// ---------- 9) 基准状态 ---------------------------------------------------------
let diskRotation = 0;        // 自上次 reset 起累计旋转弧度(单调递增)
let frame = 0;
let resetCount = 0;

function getState() {
  return {
    engine: 'three',
    ready: true,
    frame,
    diskRotation,                                     // 单调递增
    accretionPhase: (diskRotation % TWO_PI) / TWO_PI, // [0,1)
    cameraDistance: camDist,
    starStreamCount: STAR_STREAM_N,
    backgroundStarCount: BG_STAR_N,
  };
}

function doReset() {
  diskRotation = 0;
  camDist = DIST0;
  camDistTarget = DIST0;
  placeCamera();
  diskMat.uniforms.uPhase.value = 0;
  seedParticles(mulberry32(20261023 + resetCount * 17 + 1)); // 复位重生(总数恒定)
  resetCount += 1;
}

window.__bench = { getState, reset: doReset };

// ---------- 10) UI:右上角 reset 按钮 + 左下角提示 --------------------------------
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 14px;' +
    "font:12px sans-serif;background:#1a1f2b;color:#dfe6f2;border:1px solid #46506a;" +
    'border-radius:4px;cursor:pointer';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放 · 右上角重置';
  hint.style.cssText =
    'position:fixed;left:10px;bottom:8px;z-index:9999;font:12px sans-serif;' +
    'color:#48546e;pointer-events:none';
  document.body.appendChild(hint);
}

// ---------- 11) 滚轮缩放(平滑插值,负 dy = 靠近)--------------------------------
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const d = camDistTarget * Math.exp(e.deltaY * 0.0012);
    camDistTarget = THREE.MathUtils.clamp(d, DIST_MIN, DIST_MAX);
  },
  { passive: false }
);

// ---------- 12) 主循环 -----------------------------------------------------------
let last = performance.now();
function tick(now) {
  const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05); // 失焦恢复不跳变
  last = now;
  frame += 1;

  // 盘旋转(条纹图案与状态同源驱动)
  diskRotation += DISK_OMEGA * dt;
  diskMat.uniforms.uPhase.value = diskRotation;

  // 相机距离平滑插值
  camDist += (camDistTarget - camDist) * (1 - Math.exp(-dt / SMOOTH_TAU));
  placeCamera();
  coreGlow.quaternion.copy(camera.quaternion); // 核心辉光始终面向相机

  // 星流推进 + 属性上传
  updateStream(dt);

  composer.render();

  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 13) 视口自适应 --------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  bloom.setSize(w, h);
  starMat.uniforms.uPx.value = renderer.getPixelRatio();
});

// uScale:世界单位 → 像素的换算(透视点大小衰减)
function updateStreamScale() {
  const h = renderer.domElement.height; // 绘制缓冲像素高
  streamMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
updateStreamScale();
new ResizeObserver(updateStreamScale).observe(canvas);
