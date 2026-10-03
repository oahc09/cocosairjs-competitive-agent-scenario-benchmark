// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— three.js 实现
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无任何外部资产):
//   1. 深空背景:天空球 fBm 冷色星云 shader(极暗)+ 460 颗静态星点(Points)
//   2. 黑洞核心:面向相机的纯黑圆盘(事件视界,半径 1.15),先写深度遮挡盘后缘
//   3. 吸积盘:RingGeometry(r 1.8~6.5)自定义 Shader——径向温度梯度(内白蓝
//      →中琥珀→外暗红)+ 刚体旋转螺旋条纹(0.42 rad/s,uRot 时间参数驱动)
//      + 多普勒不对称(一侧增亮增蓝)+ 内缘白热边 + 加色混合柔光
//   4. 引力透镜观感(加分):billboard 光子环 + 上弧增亮光环,呈包绕核心观感
//   5. 星流:224 个沿螺旋轨迹内落的粒子(面向速度方向拉伸的四边形,
//      近视界加速、拖尾拉长,进入视界后在外圈重生,总数恒定)
//   6. 后处理:EffectComposer + UnrealBloomPass(柔光辉光)+ OutputPass(ACES)
//   7. 相机:仰角 40° 环看原点,初始距离 14,滚轮指数缩放 [5,28] 平滑插值
//
// 页面契约:
//   window.__appReady — 首帧渲染完成后置 true
//   window.__bench    — { getState(): object, reset(): void }
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------------------
// 常量(与 spec.json 冻结数值对齐)
// ---------------------------------------------------------------------------
const HORIZON_R = 1.15;          // 事件视界半径(约 1.2)
const DISK_IN = 1.8;             // 吸积盘内缘
const DISK_OUT = 6.5;            // 吸积盘外缘
const CAM_DIST0 = 14.0;          // 初始相机距离
const DIST_MIN = 5.0;
const DIST_MAX = 28.0;
const CAM_ELEV = (55 * Math.PI) / 180; // 盘面与视线倾角 55°(15°–75° 内,偏俯视)
const DISK_OMEGA = 0.42;         // 条纹刚体旋转角速度 rad/s(0.15–0.6 内)
const BG_STAR_COUNT = 460;       // 背景星(>=300)
const STREAM_COUNT = 224;        // 星流粒子(>=200)
const FOV = 60;

// 可复现随机(星流复位重生需要确定性初值)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 渲染器 / 场景 / 相机
// ---------------------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 高光滚降,亮部不死白
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 800);
// 相机始终沿固定方向环看原点(仅距离变化 ⇒ 构图随距离单调缩放)
const CAM_DIR = new THREE.Vector3(0, Math.sin(CAM_ELEV), Math.cos(CAM_ELEV)).normalize();
const BILLBOARD_QUAT = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), CAM_DIR);

let camDist = CAM_DIST0;      // 当前距离(平滑插值后的实际值,即 getState 的 cameraDistance)
let camTarget = CAM_DIST0;    // 目标距离(滚轮修改)

// ---------------------------------------------------------------------------
// 1. 深空背景:天空球(极暗 fBm 冷色星云)
// ---------------------------------------------------------------------------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: {},
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vDir;
    float hash3(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise3(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
            mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
        mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
            mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm3(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise3(p);
        p = p * 2.1 + vec3(11.3, 7.7, 5.1);
        a *= 0.5;
      }
      return v;
    }
    void main() {
      vec3 d = normalize(vDir);
      float n1 = fbm3(d * 3.1 + vec3(2.0));
      float n2 = fbm3(d * 6.3 + vec3(9.0));
      // 近黑底色 + 微弱冷色星云(蓝)与少量暖紫斑(保持深空近黑)
      vec3 col = vec3(0.0028, 0.0040, 0.0075);
      col += vec3(0.030, 0.050, 0.100) * pow(max(n1 - 0.32, 0.0) * 1.6, 2.2);
      col += vec3(0.055, 0.028, 0.060) * pow(max(n2 - 0.42, 0.0) * 1.7, 2.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 32), skyMat);
sky.renderOrder = -30;
scene.add(sky);

// ---------------------------------------------------------------------------
// 2. 背景星点(>=300,静态,大小/亮度/色温有差异,加色混合)
// ---------------------------------------------------------------------------
const starGeo = new THREE.BufferGeometry();
{
  const rng = mulberry32(20261005);
  const pos = new Float32Array(BG_STAR_COUNT * 3);
  const col = new Float32Array(BG_STAR_COUNT * 3);
  const size = new Float32Array(BG_STAR_COUNT);
  for (let i = 0; i < BG_STAR_COUNT; i++) {
    // 球面均匀分布(随机向量归一),半径略有差异
    let x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    const r = 300 + rng() * 70;
    pos[i * 3] = (x / len) * r;
    pos[i * 3 + 1] = (y / len) * r;
    pos[i * 3 + 2] = (z / len) * r;
    // 色温:多数白/蓝白,少数暖色
    const k = rng();
    let cr = 1, cg = 1, cb = 1;
    if (k < 0.38) { cr = 0.78; cg = 0.87; cb = 1.0; }       // 蓝白
    else if (k < 0.82) { cr = 1.0; cg = 0.97; cb = 0.92; }  // 纯白
    else { cr = 1.0; cg = 0.80; cb = 0.62; }                // 暖橙
    const b = 0.30 + 0.85 * Math.pow(rng(), 1.6);
    col[i * 3] = cr * b; col[i * 3 + 1] = cg * b; col[i * 3 + 2] = cb * b;
    size[i] = 1.3 + 2.6 * Math.pow(rng(), 2.4);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
}
const starMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uPx: { value: PIXEL_RATIO } },
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec3 color;
    varying vec3 vColor;
    uniform float uPx;
    void main() {
      vColor = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPx; // 像素尺寸,不随距离衰减(静态星点)
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vColor;
    void main() {
      vec2 q = gl_PointCoord * 2.0 - 1.0;
      float d2 = dot(q, q);
      if (d2 > 1.0) discard;
      float f = exp(-d2 * 2.6) * smoothstep(1.0, 0.45, d2);
      gl_FragColor = vec4(vColor * f, 1.0);
    }
  `,
});
const stars = new THREE.Points(starGeo, starMat);
stars.renderOrder = -20;
stars.frustumCulled = false;
scene.add(stars);

// ---------------------------------------------------------------------------
// 3. 宽域柔光辉光(围绕整个系统的暖色低强度晕,先画、中心被暗核覆盖)
// ---------------------------------------------------------------------------
const glowMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    varying vec2 vP;
    void main() {
      vP = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vP;
    void main() {
      // 水平略拉长的椭圆径向衰减(贴合盘的扁长外形),过渡平滑无硬边;
      // 内圈(白蓝热环所在)压制暖色,只在盘体外围铺暖晕
      vec2 e = vec2(vP.x * 0.80, vP.y * 1.15);
      float r = length(e);
      float g = exp(-r * 0.40) * smoothstep(1.4, 2.7, r);
      vec3 col = vec3(1.0, 0.46, 0.19) * g * 0.065;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const glow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), glowMat);
glow.quaternion.copy(BILLBOARD_QUAT);
glow.renderOrder = -15;
scene.add(glow);

// ---------------------------------------------------------------------------
// 4. 黑洞核心:纯黑事件视界圆盘(面向相机,写深度 → 遮挡其后的一切)
// ---------------------------------------------------------------------------
const core = new THREE.Mesh(
  new THREE.CircleGeometry(HORIZON_R, 96),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
core.quaternion.copy(BILLBOARD_QUAT);
core.renderOrder = 0; // 晚于星空/辉光(覆盖它们),早于加色发光层(供深度遮挡)
scene.add(core);

// ---------------------------------------------------------------------------
// 5. 吸积盘:自定义 Shader(RingGeometry 置于 XZ 水平面)
// ---------------------------------------------------------------------------
const diskGeo = new THREE.RingGeometry(DISK_IN, DISK_OUT, 256, 6);
diskGeo.rotateX(-Math.PI / 2); // 局部坐标 → (x, 0, z),shader 内用极坐标
const diskMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uRot: { value: 0 },       // 刚体累计旋转角(rad,即 getState().diskRotation)
    uDiskIn: { value: DISK_IN },
    uDiskOut: { value: DISK_OUT },
  },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uRot;
    uniform float uDiskIn;
    uniform float uDiskOut;
    varying vec3 vPos;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float noise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm2(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise2(p);
        p = p * 2.03 + vec2(19.7, 7.3);
        a *= 0.5;
      }
      return v;
    }

    void main() {
      float r = length(vPos.xz);
      float th = atan(vPos.z, vPos.x);
      float t = clamp((r - uDiskIn) / (uDiskOut - uDiskIn), 0.0, 1.0);

      // 内外缘平滑淡入淡出(无硬边)
      float fin = smoothstep(uDiskIn, uDiskIn + 0.28, r);
      float fout = smoothstep(uDiskOut, uDiskOut - 0.95, r);

      // 径向发光强度:内缘炽热 → 外缘昏暗
      float lum = 0.54 * exp(-2.0 * t) + 0.13;
      // 内缘白热环(全盘最亮、最白的一圈,向外在白蓝区内缓降)
      float rim = 0.50 * exp(-max(r - uDiskIn, 0.0) * 1.9);

      // 刚体旋转的螺旋条纹:sin 在 θ 上天然无缝;随 uRot 时间参数连续旋转
      float ang = 5.0 * (th - uRot) + 2.6 * log(r / uDiskIn);
      float stripes = 1.0 + 0.42 * sin(ang) + 0.18 * sin(2.3 * ang + 1.7);

      // 随图案刚体旋转的湍流颗粒(笛卡尔坐标旋转,无缝)
      float ca = cos(-uRot), sa = sin(-uRot);
      vec2 rp = vec2(ca * vPos.x - sa * vPos.z, sa * vPos.x + ca * vPos.z);
      float grain = 0.80 + 0.55 * fbm2(rp * 1.9);

      // 多普勒集束:approaching 侧(屏幕右侧,θ≈0)增亮,固定于观察方向不随盘转
      float dop = 1.0 + 0.75 * cos(th);

      // 径向温度色带:内白蓝(占盘面内半)→ 中琥珀橙 → 外暗红
      vec3 cIn = vec3(0.85, 0.93, 1.10);
      vec3 cMid = vec3(1.00, 0.62, 0.25);
      vec3 cOut = vec3(0.68, 0.075, 0.018);
      vec3 col = mix(cIn, cMid, smoothstep(0.10, 0.55, t));
      col = mix(col, cOut, smoothstep(0.50, 0.95, t));
      // approaching 侧轻微蓝移
      col = mix(col, col * vec3(0.90, 0.97, 1.16), clamp(dop - 1.0, 0.0, 1.0) * 0.65);

      float I = (lum * stripes * grain + rim * 0.9) * fin * fout * dop;
      vec3 outCol = col * I + vec3(0.90, 0.97, 1.10) * rim * fin * fout * dop * 0.45;
      gl_FragColor = vec4(outCol, 1.0);
    }
  `,
});
const disk = new THREE.Mesh(diskGeo, diskMat);
disk.renderOrder = 1; // 深度测试对暗核生效:盘后缘被视界遮挡、前缘在暗核之前
scene.add(disk);

// ---------------------------------------------------------------------------
// 6. 引力透镜观感(加分):billboard 光子环 + 上弧增亮光环(包绕核心)
// ---------------------------------------------------------------------------
const haloMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uHorizon: { value: HORIZON_R } },
  vertexShader: /* glsl */ `
    varying vec2 vP;
    void main() {
      vP = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uHorizon;
    varying vec2 vP;
    void main() {
      float r = length(vP);
      float a = atan(vP.y, vP.x);
      // 光子环:紧贴视界的窄热环(盘后缘光线弯折包绕核心的观感),偏白蓝
      float ring = exp(-pow((r - 1.48) / 0.15, 2.0)) * 1.05;
      // 宽域透镜晕:仅在外围铺开(暖),不侵入内环白蓝热区
      float wide = exp(-max(r - 1.25, 0.0) * 1.05) * 0.07 * smoothstep(2.0, 3.0, r);
      // 上弧增亮(盘远端向上弯折的像)
      float arc = 1.0 + 0.45 * smoothstep(-0.4, 1.2, sin(a));
      // 不涂染暗核内部
      float mask = smoothstep(uHorizon + 0.01, uHorizon + 0.17, r);
      vec3 cRing = vec3(0.92, 0.96, 1.05);
      vec3 cWide = vec3(1.0, 0.55, 0.26);
      vec3 col = (cRing * ring * arc + cWide * wide * (0.7 + 0.5 * arc)) * mask;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const halo = new THREE.Mesh(new THREE.PlaneGeometry(8.5, 8.5), haloMat);
halo.quaternion.copy(BILLBOARD_QUAT);
halo.renderOrder = 3;
scene.add(halo);

// ---------------------------------------------------------------------------
// 7. 星流:螺旋内落粒子(面向相机、沿速度方向拉伸的软边四边形)
// ---------------------------------------------------------------------------
// 粒子状态:极坐标 (r, th) 在盘平面(XZ)内演化;近视界角速度与内落速度增大;
// r < 视界 → 视为被吞噬,在外圈(盘外缘之外)随机重生,总数恒定。
const streamRng = mulberry32(77031);
const stream = [];
function spawnParticle(p, initial) {
  p.r = 6.8 + streamRng() * 2.4;                       // 外圈重生
  p.th = streamRng() * Math.PI * 2;
  p.speedMul = 0.75 + streamRng() * 0.6;
  p.sizeJit = 0.7 + streamRng() * 0.7;
  if (initial) Object.assign(p, { r0: p.r, th0: p.th, speedMul0: p.speedMul, sizeJit0: p.sizeJit });
}
for (let i = 0; i < STREAM_COUNT; i++) {
  const p = {};
  spawnParticle(p, true);
  stream.push(p);
}
// 初值快照(reset 复位用,确定性恢复)
const streamInit = stream.map((p) => ({ r: p.r0, th: p.th0, speedMul: p.speedMul0, sizeJit: p.sizeJit0 }));

const streamGeo = new THREE.BufferGeometry();
const STREAM_VERTS = STREAM_COUNT * 4;
const streamPos = new Float32Array(STREAM_VERTS * 3);
const streamCol = new Float32Array(STREAM_VERTS * 3);
const streamUV = new Float32Array(STREAM_VERTS * 2);
const streamIdx = new Uint16Array(STREAM_COUNT * 6);
for (let i = 0; i < STREAM_COUNT; i++) {
  const v = i * 4, o = i * 6;
  streamUV[v * 2] = -1; streamUV[v * 2 + 1] = -1;
  streamUV[(v + 1) * 2] = 1; streamUV[(v + 1) * 2 + 1] = -1;
  streamUV[(v + 2) * 2] = 1; streamUV[(v + 2) * 2 + 1] = 1;
  streamUV[(v + 3) * 2] = -1; streamUV[(v + 3) * 2 + 1] = 1;
  streamIdx[o] = v; streamIdx[o + 1] = v + 1; streamIdx[o + 2] = v + 2;
  streamIdx[o + 3] = v; streamIdx[o + 4] = v + 2; streamIdx[o + 5] = v + 3;
}
streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
streamGeo.setAttribute('color', new THREE.BufferAttribute(streamCol, 3));
streamGeo.setAttribute('uv', new THREE.BufferAttribute(streamUV, 2));
streamGeo.setIndex(new THREE.BufferAttribute(streamIdx, 1));

const streamMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    attribute vec3 color;
    varying vec3 vColor;
    varying vec2 vUv;
    void main() {
      vColor = color;
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vColor;
    varying vec2 vUv;
    void main() {
      // uv.x ∈ [-1,1] 沿速度方向(长度),uv.y ∈ [-1,1] 横向(宽度)
      float fU = max(0.0, 1.0 - vUv.x * vUv.x);
      float fV = max(0.0, 1.0 - vUv.y * vUv.y);
      float f = fU * fV * fV; // 软边拖尾
      gl_FragColor = vec4(vColor * f, 1.0);
    }
  `,
});
const streamMesh = new THREE.Mesh(streamGeo, streamMat);
streamMesh.renderOrder = 2; // 深度测试:越过暗核背后的粒子被视界遮挡(被吞噬)
streamMesh.frustumCulled = false;
scene.add(streamMesh);

const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _A = new THREE.Vector3();
const _B = new THREE.Vector3();

function omegaAt(r) { return 2.6 / Math.pow(Math.max(r, 1.25), 1.5); } // 角速度(Kepler 式)
function vradAt(r) { return 0.28 + 2.3 / (r * r); }                     // 内落速度

function updateStream(dt) {
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const posAttr = streamGeo.attributes.position;
  const colAttr = streamGeo.attributes.color;

  for (let i = 0; i < STREAM_COUNT; i++) {
    const p = stream[i];
    const w = omegaAt(p.r) * p.speedMul;
    const vr = vradAt(p.r) * p.speedMul;
    p.th += w * dt;
    p.r -= vr * dt;
    if (p.r < HORIZON_R) { spawnParticle(p, false); continue; } // 吞噬 → 外圈重生

    // 世界位置与速度(盘平面 XZ)
    const cx = Math.cos(p.th), sx = Math.sin(p.th);
    _pos.set(p.r * cx, 0, p.r * sx);
    _vel.set(-p.r * sx * w - cx * vr, 0, p.r * cx * w - sx * vr);
    if (_vel.lengthSq() < 1e-8) _vel.set(1, 0, 0);
    _vel.normalize();

    // 屏幕面内对齐:把速度方向投影到 (camRight, camUp) 平面
    let dx = _vel.dot(_camRight), dy = _vel.dot(_camUp);
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    _A.copy(_camRight).multiplyScalar(dx).addScaledVector(_camUp, dy); // 速度屏幕方向(世界系)
    _B.copy(_camUp).multiplyScalar(dx).addScaledVector(_camRight, -dy); // 其面内垂向

    // 近视界:更快 → 拖尾更长更亮更白热
    const heat = Math.min(Math.max((6.8 - p.r) / (6.8 - HORIZON_R), 0), 1);
    const speed = Math.hypot(p.r * w, vr);
    const halfLen = Math.min(0.09 + speed * 0.20, 0.85) * p.sizeJit;
    const halfWid = 0.030 + 0.045 * heat * p.sizeJit;
    const bright = (0.26 + 1.30 * Math.pow(heat, 1.6)) * p.sizeJit;
    // 颜色:外缘暖橙 → 内缘白蓝
    const cr = 1.00 - 0.14 * heat, cg = 0.62 + 0.32 * heat, cb = 0.34 + 0.68 * heat;
    const R = cr * bright, G = cg * bright, B = cb * bright;

    const v = i * 4;
    const axL = _A.x * halfLen, ayL = _A.y * halfLen, azL = _A.z * halfLen;
    const bxW = _B.x * halfWid, byW = _B.y * halfWid, bzW = _B.z * halfWid;
    streamPos[v * 3] = _pos.x - axL - bxW; streamPos[v * 3 + 1] = _pos.y - ayL - byW; streamPos[v * 3 + 2] = _pos.z - azL - bzW;
    streamPos[(v + 1) * 3] = _pos.x + axL - bxW; streamPos[(v + 1) * 3 + 1] = _pos.y + ayL - byW; streamPos[(v + 1) * 3 + 2] = _pos.z + azL - bzW;
    streamPos[(v + 2) * 3] = _pos.x + axL + bxW; streamPos[(v + 2) * 3 + 1] = _pos.y + ayL + byW; streamPos[(v + 2) * 3 + 2] = _pos.z + azL + bzW;
    streamPos[(v + 3) * 3] = _pos.x - axL + bxW; streamPos[(v + 3) * 3 + 1] = _pos.y - ayL + byW; streamPos[(v + 3) * 3 + 2] = _pos.z - azL + bzW;
    for (let k = 0; k < 4; k++) {
      streamCol[(v + k) * 3] = R; streamCol[(v + k) * 3 + 1] = G; streamCol[(v + k) * 3 + 2] = B;
    }
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// 8. 后处理:UnrealBloom(柔光辉光)+ OutputPass(ACES + sRGB)
// ---------------------------------------------------------------------------
// HDR 半浮点渲染目标 + 4x MSAA(平滑边缘),bloom 在线性 HDR 上进行
const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, { type: THREE.HalfFloatType, samples: 4 })
);
composer.setPixelRatio(PIXEL_RATIO);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
// 阈值取高:只让真正的白热部(内缘/光子环/亮星)起辉
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.38, 0.4, 0.9);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// 8b. 事件视界保黑通道:composer 之后向屏幕盖章纯黑圆盘(暗核最后的防线)。
//     bloom 会把环绕亮环的光晕弥散进核心区域,本通道按解析投影半径把暗核
//     重新压回纯黑,保证任何后处理强度下"中心连续暗核 + 锐利边缘"恒成立。
//     半径 = HORIZON_R / (camDist * tan(fov/2))(相机始终正对原点 ⇒ 恒在屏心)。
// ---------------------------------------------------------------------------
const stampScene = new THREE.Scene();
const stampCam = new THREE.Camera(); // 单位正交(全屏面片直接输出 NDC)
const stampMat = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  uniforms: {
    uAspect: { value: window.innerWidth / window.innerHeight },
    uR: { value: HORIZON_R / (CAM_DIST0 * Math.tan((FOV * Math.PI / 180) / 2)) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uAspect;
    uniform float uR;
    varying vec2 vUv;
    void main() {
      // 换算到以屏心为原点、按纵横比修正的圆度量空间
      vec2 p = vec2((vUv.x * 2.0 - 1.0) * uAspect, vUv.y * 2.0 - 1.0);
      float d = length(p);
      float feather = max(fwidth(d), 0.0015);
      float a = 1.0 - smoothstep(uR - feather, uR, d);
      gl_FragColor = vec4(vec3(0.0), a);
    }
  `,
});
stampScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stampMat));

// ---------------------------------------------------------------------------
// 9. 状态通道 / reset / UI
// ---------------------------------------------------------------------------
let diskRotation = 0; // 自上次 reset 起的累计旋转弧度(单调递增)

function getState() {
  return {
    diskRotation,
    accretionPhase: (diskRotation / (Math.PI * 2)) % 1,
    cameraDistance: camDist,
    starStreamCount: STREAM_COUNT,
    backgroundStarCount: BG_STAR_COUNT,
  };
}

function reset() {
  diskRotation = 0;
  camDist = CAM_DIST0;
  camTarget = CAM_DIST0;
  for (let i = 0; i < STREAM_COUNT; i++) {
    const p = stream[i], s = streamInit[i];
    p.r = s.r; p.th = s.th; p.speedMul = s.speedMul; p.sizeJit = s.sizeJit;
  }
  diskMat.uniforms.uRot.value = 0;
}

window.__bench = { getState, reset };

// DOM 覆盖层:右上角 reset 按钮(自动化的 UI 契约)+ 可选缩放提示
{
  const btn = document.createElement('button');
  btn.setAttribute('data-ui', 'reset');
  btn.textContent = '重置';
  Object.assign(btn.style, {
    position: 'fixed', top: '14px', right: '16px', zIndex: '10',
    padding: '8px 18px', fontSize: '13px', color: '#e8ecf2',
    background: 'rgba(18, 22, 30, 0.55)', border: '1px solid rgba(160,180,210,0.45)',
    borderRadius: '6px', cursor: 'pointer', letterSpacing: '1px',
  });
  btn.addEventListener('click', () => reset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放';
  Object.assign(hint.style, {
    position: 'fixed', left: '14px', bottom: '12px', zIndex: '10',
    fontSize: '12px', color: 'rgba(190,200,215,0.45)', pointerEvents: 'none',
  });
  document.body.appendChild(hint);
}

// 滚轮缩放:负 dy(向上滚)= 靠近放大;指数映射 + [5,28] 夹紧;平滑插值见主循环
window.addEventListener(
  'wheel',
  (e) => {
    const d = camTarget * Math.exp(e.deltaY * 0.0012);
    camTarget = Math.min(DIST_MAX, Math.max(DIST_MIN, d));
  },
  { passive: true }
);

// resize
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  stampMat.uniforms.uAspect.value = w / h;
});

// ---------------------------------------------------------------------------
// 10. 主循环(真实时间步进,dt 夹紧防失焦跳变)
// ---------------------------------------------------------------------------
let lastT = performance.now();
let ready = false;

function frame(now) {
  const dt = Math.min(Math.max((now - lastT) / 1000, 0), 0.05);
  lastT = now;

  // 盘旋转(时间参数驱动,连续动态)
  diskRotation += DISK_OMEGA * dt;
  diskMat.uniforms.uRot.value = diskRotation;

  // 相机距离平滑插值(约 0.2s 走 63%,1s 内基本到位,残差 <1%)
  camDist += (camTarget - camDist) * (1 - Math.exp(-5.0 * dt));

  camera.position.copy(CAM_DIR).multiplyScalar(camDist);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  updateStream(dt);
  composer.render();

  // 事件视界保黑:后处理完成后向屏幕盖章暗核(纯黑、解析半径、随缩放平滑变化)
  stampMat.uniforms.uR.value = HORIZON_R / (camDist * Math.tan((FOV * Math.PI / 180) / 2));
  renderer.autoClear = false;
  renderer.render(stampScene, stampCam);
  renderer.autoClear = true;

  if (!ready) {
    ready = true;
    window.__appReady = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
