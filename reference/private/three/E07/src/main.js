// ============================================================================
// E07 — 霓虹夜城 (Neon Night City) — Three.js r186 Reference
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无外部资产,无网络请求):
//   1. 楼群:~240 栋 InstancedMesh 暗色体块,网格化街区布局,程序化高度
//   2. 发光窗阵:~5000 个实例化小面片(暖/冷混合、矩阵排布、随机点亮),
//      每栋楼 >= 8 个发光窗,全场景窗点 >= 2000
//   3. 车流:86 辆发光块(白头灯 / 红尾灯 / 少量青色出租车)+ 加法混合
//      拖尾面片,沿 4 条主干道(1 条近景横穿 + 2 条纵深走廊 + 2 条中远景
//      横穿)连续移动
//   4. 雨:2200 个 GPU 循环下落粒子(Points + 自定义 shader,斜向光丝,
//      落地重生于顶部)
//   5. 雾:FogExp2 距离雾(密度动画 0.0102<->0,UI 开关往返)
//   6. 霓虹:~90 个实例化发光元件(招牌 / 楼体描边灯带 / 广告横带 /
//      街灯),品红 / 青 / 橙黄 / 酸绿等高饱和色,呼吸 + 霓虹管断续闪烁
//   7. 湿地面:Reflector 平面反射 + 自定义沥青 shader(水洼掩码、
//      波纹扰动、随距离雾衰减)—— 霓虹在湿街上的倒影
//   8. 夜空:程序化穹顶(垂直渐变 + 城市光害带 + hash 星点 + 薄云),
//      雾开关联动(关雾后星点浮现)
//   9. 后处理:RenderPass → UnrealBloomPass → OutputPass(ACES+sRGB)
//      → FXAAPass
// 页面契约:harness 断言 window.__appReady / window.__bench={getState,reset}
// 状态契约(spec.stateContract):buildingCount / carCount /
//   rainParticleCount / fogEnabled / fps(真实滚动 60 帧平均)+ 附加字段
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// --- 冻结规模(brief.md §6 / spec.json scaleAndPerformance)------------------
const CFG = {
  rainCount: 2200,        // >= 1500(建议 1800-2500)
  carTotal: 86,           // >= 60(建议 64-96),由 avenues 分配求和
  buildingMin: 220,       // >= 200(建议 220-260)
  buildingMax: 260,
  windowMinPerBuilding: 8,   // 每栋楼 >= 8 个发光窗
  windowTotalMin: 2000,      // 全场景窗点 >= 2000
  windowTotalMax: 6000,
  neonMax: 170,
  fogDensity: 0.0115,     // FogExp2 基准密度(开雾态)
  fov: 62,
  seed: 20261002,         // 城市生成种子(reset 用同一种子重建同一座城)
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// --- 确定性 PRNG(mulberry32;reset 后用同种子重建,计数恒定)------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// 渲染器 / 场景 / 相机 / 光照 / 雾
// ============================================================================
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // OutputPass 统一执行
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

const FOG_COLOR = new THREE.Color(0x1c2a4c); // 城市夜霭(蓝,略带光害亮度,与夜空协调)
scene.fog = new THREE.FogExp2(FOG_COLOR, CFG.fogDensity);

// 低角度仰视天际线:相机在街道上,微仰 10.5°;下 1/3 街道层,上 2/3 楼群夜空
const camera = new THREE.PerspectiveCamera(CFG.fov, window.innerWidth / window.innerHeight, 0.5, 1600);
const CAM_BASE = new THREE.Vector3(0, 3.6, 30);
const CAM_TARGET = new THREE.Vector3(0, 24, -80);
camera.position.copy(CAM_BASE);
camera.lookAt(CAM_TARGET);

// 楼体是暗色体块:只给很弱的环境/方向光,让窗阵与霓虹当主角
scene.add(new THREE.AmbientLight(0x36415f, 0.8));
const moon = new THREE.DirectionalLight(0x8fa0d8, 0.4);
moon.position.set(60, 120, 40);
scene.add(moon);
// 走廊氛围灯(只影响楼体表面,微弱染色)
const magentaLamp = new THREE.PointLight(0xff2d95, 190, 90, 2);
magentaLamp.position.set(7, 11, -8);
scene.add(magentaLamp);
const cyanLamp = new THREE.PointLight(0x19e3ff, 150, 80, 2);
cyanLamp.position.set(-10, 9, -34);
scene.add(cyanLamp);

// ============================================================================
// GLSL 公共噪声库(2D value noise + fbm,sky/ground 共用)
// ============================================================================
const GLSL_NOISE2 = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.07 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return v;
}
`;

// ============================================================================
// 8. 夜空穹顶:渐变 + 城市光害 + 星点 + 薄云(uFogAmt 联动雾开关)
// ============================================================================
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    uFogAmt: { value: 1.0 },
    uTime: { value: 0.0 },
    uFogColor: { value: FOG_COLOR.clone() },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uFogAmt;
    uniform float uTime;
    uniform vec3 uFogColor;
    varying vec3 vDir;
    ${GLSL_NOISE2}
    float hash31(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    void main() {
      vec3 dir = normalize(vDir);
      float h = dir.y;
      // 垂直渐变:雾色地平线 -> 近黑天顶
      vec3 top = vec3(0.005, 0.008, 0.020);
      vec3 horizon = uFogColor * 1.15 + vec3(0.008, 0.005, 0.012);
      vec3 col = mix(horizon, top, smoothstep(-0.02, 0.55, h));
      // 城市光害带(地平线上方的暖品红辉光,雾越大越亮)
      col += vec3(0.050, 0.018, 0.042) * exp(-abs(h - 0.04) * 11.0) * (0.30 + 0.70 * uFogAmt);
      // 薄云:随方位角缓慢漂移的微弱水平云带
      float az = atan(dir.x, dir.z);
      float band = exp(-pow((h - 0.20) * 5.5, 2.0));
      col += vec3(0.045, 0.052, 0.085) * band * fbm2(vec2(az * 3.2, h * 9.0) + vec2(uTime * 0.010, 0.0));
      // 星点:方向网格 hash,关雾后清晰浮现
      vec3 sp = dir * 230.0;
      vec3 cell = floor(sp);
      float hs = hash31(cell);
      if (hs > 0.9972 && h > 0.03) {
        vec3 f = fract(sp) - 0.5;
        float d = length(f);
        float star = smoothstep(0.38, 0.02, d) * (0.35 + 0.65 * fract(hs * 97.13));
        col += vec3(0.62, 0.72, 1.0) * star * (1.0 - uFogAmt * 0.88);
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(900, 40, 24), skyMat);
skyDome.frustumCulled = false;
skyDome.renderOrder = -100; // 先画天空,其余物体覆盖
scene.add(skyDome);

// ============================================================================
// 7. 湿地面:Reflector 平面反射 + 沥青 shader(水洼/波纹/雾衰减)
// ============================================================================
const groundShader = {
  name: 'WetAsphaltShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0.0 },
    uCamXZ: { value: new THREE.Vector2(0, 30) },
    uFogColor: { value: FOG_COLOR.clone() },
    uFogDensity: { value: CFG.fogDensity },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUvR;
    varying vec3 vW;
    void main() {
      vUvR = textureMatrix * vec4(position, 1.0);
      vW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 color;
    uniform float uTime;
    uniform vec2 uCamXZ;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec4 vUvR;
    varying vec3 vW;
    ${GLSL_NOISE2}
    void main() {
      vec2 uv = vUvR.xy / vUvR.w;
      // 微波纹扰动采样 -> 湿漉漉的破碎倒影
      float n1 = vnoise(vW.xz * 0.85 + vec2(uTime * 0.30, uTime * 0.11));
      float n2 = vnoise(vW.zx * 0.55 - vec2(uTime * 0.07, uTime * 0.23));
      uv += (vec2(n1, n2) - 0.5) * 0.030;
      vec3 refl = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
      // 水洼掩码:有的地方一汪水(强镜面),有的地方只微湿
      float puddle = smoothstep(0.30, 0.72, fbm2(vW.xz * 0.05));
      // 沥青底色 + 颗粒
      float grain = 0.65 + 0.70 * vnoise(vW.xz * 2.3);
      vec3 asphalt = vec3(0.016, 0.020, 0.034) * grain;
      vec3 col = asphalt + refl * color * mix(0.26, 0.88, puddle);
      // 距离雾衰减(与场景 FogExp2 同式)
      float d = distance(vW.xz, uCamXZ);
      float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
      col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
const ground = new Reflector(new THREE.PlaneGeometry(560, 480), {
  clipBias: 0.003,
  textureWidth: 1024,
  textureHeight: 512,
  multisample: 0,
  color: 0xb4c2e2,
  shader: groundShader,
});
ground.rotation.x = -Math.PI / 2; // 旋转 mesh(Reflector 依 mesh 旋转求镜面法线)
ground.position.set(0, 0, -40);
scene.add(ground);
const groundU = ground.material.uniforms;

// ============================================================================
// 共享几何 / 材质
// ============================================================================
// 楼体:单位盒(底面在 y=0,向上缩放)
const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
buildingGeo.translate(0, 0.5, 0);
const buildingMat = new THREE.MeshStandardMaterial({
  color: 0x101a30,
  roughness: 0.9,
  metalness: 0.15,
});

// 窗阵:实例化小面片(MeshBasicMaterial = 自发光,HDR instanceColor)
const windowGeo = new THREE.PlaneGeometry(1.12, 1.45);
const windowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });

// 车流:发光块
const carGeo = new THREE.BoxGeometry(2.05, 0.62, 0.98);
const carMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });

// 车流拖尾:平躺面片 + 加法混合纵向渐隐
const trailGeo = new THREE.PlaneGeometry(1, 1);
trailGeo.rotateX(-Math.PI / 2);
const trailMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  fog: false,
  uniforms: {
    uFogColor: { value: FOG_COLOR.clone() },
    uFogDensity: { value: CFG.fogDensity },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUvT;
    varying vec3 vTint;
    varying float vFogDepth;
    void main() {
      vUvT = uv;
      vec3 p = position;
      #ifdef USE_INSTANCING
        p = (instanceMatrix * vec4(p, 1.0)).xyz;
      #endif
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vFogDepth = -mv.z;
      #ifdef USE_INSTANCING_COLOR
        vTint = instanceColor;
      #else
        vTint = vec3(1.0);
      #endif
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec2 vUvT;
    varying vec3 vTint;
    varying float vFogDepth;
    void main() {
      float lon = 1.0 - abs(vUvT.x * 2.0 - 1.0);
      float lat = 1.0 - abs(vUvT.y * 2.0 - 1.0);
      float a = pow(lon, 1.7) * smoothstep(0.0, 0.45, lat);
      vec3 col = vTint;
      float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(col * 0.85, a * 0.42);
    }
  `,
});

// 霓虹:实例化发光元件(招牌/横带/描边灯带/街灯),呼吸 + 断续闪烁
const neonGeo = new THREE.BoxGeometry(1, 1, 1);
const neonMat = new THREE.ShaderMaterial({
  fog: false,
  uniforms: {
    uTime: { value: 0.0 },
    uFogColor: { value: FOG_COLOR.clone() },
    uFogDensity: { value: CFG.fogDensity },
  },
  vertexShader: /* glsl */ `
    attribute float aPhase;
    attribute float aSpeed;
    attribute float aMode;
    varying vec3 vTint;
    varying float vPhase;
    varying float vSpeed;
    varying float vMode;
    varying float vFogDepth;
    varying vec2 vUv2;
    void main() {
      vPhase = aPhase;
      vSpeed = aSpeed;
      vMode = aMode;
      vUv2 = uv;
      vec3 p = position;
      #ifdef USE_INSTANCING
        p = (instanceMatrix * vec4(p, 1.0)).xyz;
      #endif
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vFogDepth = -mv.z;
      #ifdef USE_INSTANCING_COLOR
        vTint = instanceColor;
      #else
        vTint = vec3(1.0);
      #endif
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec3 vTint;
    varying float vPhase;
    varying float vSpeed;
    varying float vMode;
    varying float vFogDepth;
    varying vec2 vUv2;
    float hash1(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
      // 呼吸
      float b = 0.80 + 0.20 * sin(uTime * vSpeed + vPhase);
      // 霓虹管断续闪烁(仅招牌类):时间片 hash 掉电
      if (vMode < 0.5) {
        float slice = floor(uTime * (0.6 + hash1(vPhase) * 1.8));
        float outage = step(0.10, hash1(slice * 7.31 + vPhase * 13.7));
        b *= mix(0.07, 1.0, outage);
      }
      vec3 col = vTint * (1.18 * b);
      // 招牌/横带:面板 + 亮边框结构
      if (vMode < 1.5) {
        vec2 g = abs(vUv2 - 0.5) * 2.0;
        float frame = smoothstep(0.70, 0.85, max(g.x, g.y));
        col *= 0.72 + 0.55 * frame;
      }
      float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

// 实例化容器(容量上限,实际 count 由生成结果决定)
const MAX_BUILD = 320;
const MAX_WINDOW = 6400;
const MAX_NEON = 200;
const MAX_CAR = 96;

const buildingsMesh = new THREE.InstancedMesh(buildingGeo, buildingMat, MAX_BUILD);
const windowsMesh = new THREE.InstancedMesh(windowGeo, windowMat, MAX_WINDOW);
const neonMesh = new THREE.InstancedMesh(neonGeo, neonMat, MAX_NEON);
const carsMesh = new THREE.InstancedMesh(carGeo, carMat, MAX_CAR);
const trailsMesh = new THREE.InstancedMesh(trailGeo, trailMat, MAX_CAR);
// 霓虹实例属性:复用同一缓冲(reset 重建只重填,不换 attribute,避免 GPU 缓冲悬挂)
const neonPhaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEON), 1);
const neonSpeedAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEON), 1);
const neonModeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEON), 1);
neonMesh.geometry.setAttribute('aPhase', neonPhaseAttr);
neonMesh.geometry.setAttribute('aSpeed', neonSpeedAttr);
neonMesh.geometry.setAttribute('aMode', neonModeAttr);
for (const m of [buildingsMesh, windowsMesh, neonMesh, carsMesh, trailsMesh]) {
  m.frustumCulled = false; // 实例遍布全城,包围球剔除会整组误剔除
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
}
carsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // 每帧更新
trailsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
windowsMesh.renderOrder = 1;
neonMesh.renderOrder = 2;
trailsMesh.renderOrder = 8;
scene.add(buildingsMesh, windowsMesh, neonMesh, carsMesh, trailsMesh);

// ============================================================================
// 4. 雨:GPU 循环下落粒子(Points + 自定义 shader)
// ============================================================================
const rainGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(CFG.rainCount * 3);
  const seed = new Float32Array(CFG.rainCount);
  const speed = new Float32Array(CFG.rainCount);
  const size = new Float32Array(CFG.rainCount);
  const rng = mulberry32(CFG.seed ^ 0x5a17);
  for (let i = 0; i < CFG.rainCount; i++) {
    pos[i * 3 + 0] = (rng() * 2 - 1) * 48;         // x: [-48, 48]
    pos[i * 3 + 1] = 0;                            // y 由 shader 循环计算
    pos[i * 3 + 2] = 36 - rng() * 176;             // z: [36, -140]
    seed[i] = rng();
    speed[i] = 30 + rng() * 18;                    // 30-48 u/s
    size[i] = 3.0 + rng() * 2.6;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  rainGeo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  rainGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
}
const rainMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  fog: false,
  uniforms: {
    uTime: { value: 0.0 },
    uTop: { value: 58.0 },
    uFallH: { value: 58.0 },
    uWind: { value: 0.55 },
    uColor: { value: new THREE.Color(0.62, 0.72, 0.92) },
    uFogColor: { value: FOG_COLOR.clone() },
    uFogDensity: { value: CFG.fogDensity },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uTop;
    uniform float uFallH;
    uniform float uWind;
    attribute float aSeed;
    attribute float aSpeed;
    attribute float aSize;
    varying float vFade;
    varying float vFogDepth;
    void main() {
      // 循环下落:mod 相位重生于顶部;风致横向漂移
      float fall = mod(aSeed * 719.93 + uTime * aSpeed, uFallH);
      float y = uTop - fall;
      vec3 p = vec3(position.x + uWind * fall * 0.10, y, position.z);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vFogDepth = -mv.z;
      gl_PointSize = aSize * (140.0 / max(4.0, -mv.z));
      // 顶部淡入 / 近地面淡出 / 贴脸淡出,避免生硬边界
      vFade = smoothstep(uTop, uTop - 5.0, y) * smoothstep(0.0, 1.6, y) * smoothstep(2.0, 7.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying float vFade;
    varying float vFogDepth;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      // 斜向光丝:与风向一致的自斜线,宽 ~2-4px
      float x = d.x + d.y * 0.35;
      float w = 1.0 - smoothstep(0.02, 0.10, abs(x));
      if (w <= 0.002) discard;
      float tail = smoothstep(-0.5, 0.35, d.y); // 下端(雨头)更亮
      float a = w * (0.28 + 0.72 * tail) * vFade;
      float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      vec3 col = mix(uColor, uFogColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(col * 1.3, a);
    }
  `,
});
const rain = new THREE.Points(rainGeo, rainMat);
rain.frustumCulled = false;
rain.renderOrder = 10;
scene.add(rain);

// ============================================================================
// 城市生成(确定性:同一种子 -> 同一座城;reset 复用)
// ============================================================================
const counts = { buildings: 0, windows: 0, neon: 0, cars: CFG.carTotal, rain: CFG.rainCount };

const NEON_PALETTE = [
  [1.0, 0.16, 0.55],  // 品红
  [0.10, 0.90, 1.0],  // 青
  [1.0, 0.60, 0.12],  // 橙黄
  [0.22, 1.0, 0.50],  // 酸绿
  [1.0, 0.80, 0.22],  // 金
  [0.55, 0.34, 1.0],  // 紫
];

// 街道网:纵深走廊沿 Z(x = 0 宽 12 主走廊 + ±30/±62/±94/±126 宽 8),
// 横穿街道沿 X(z = 18 / -14 / -46 / -78 / -110 / -142 宽 8)
const CORRIDORS_X = [0, 30, -30, 62, -62, 94, -94, 126, -126];
const CORRIDOR_HALF = (x) => (x === 0 ? 6.0 : 4.0);
const STREETS_Z = [18, -14, -46, -78, -110, -142];

function blockRanges() {
  // 返回 [x0,x1,z0,z1] 街区块列表(x/z 均为近->远有序)
  const xs = [];
  const sortedX = [...CORRIDORS_X].sort((a, b) => a - b);
  for (let i = 0; i < sortedX.length - 1; i++) {
    const a = sortedX[i] + CORRIDOR_HALF(sortedX[i]);
    const b = sortedX[i + 1] - CORRIDOR_HALF(sortedX[i + 1]);
    if (b - a > 8) xs.push([a, b]);
  }
  // 两侧延伸块
  xs.unshift([-142, sortedX[0] - CORRIDOR_HALF(sortedX[0])]);
  xs.push([sortedX[sortedX.length - 1] + CORRIDOR_HALF(sortedX[sortedX.length - 1]), 142]);
  const zs = [];
  for (let i = 0; i < STREETS_Z.length - 1; i++) {
    // [近边(数值大), 远边(数值小)]:街道从近 18 到远 -142,z 单调递减
    zs.push([STREETS_Z[i] - 4, STREETS_Z[i + 1] + 4]);
  }
  return { xs, zs };
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _col = new THREE.Color();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function buildCity() {
  const rng = mulberry32(CFG.seed);
  const { xs, zs } = blockRanges();

  // ---- 楼群 + 窗阵候选 + 霓虹候选 -------------------------------------------
  const buildings = [];
  const windowRecs = []; // {x,y,z,rotY,color:[r,g,b],forced}
  const neonRecs = [];   // {x,y,z,sx,sy,sz,color,phase,speed,mode}

  const rowHMax = [26, 42, 62, 76, 88]; // 每排(近->远)最大高度
  const corridors = CORRIDORS_X.slice().sort((a, b) => Math.abs(a) - Math.abs(b));

  for (let ri = 0; ri < zs.length; ri++) {
    const [zNear, zFar] = zs[ri]; // zNear(大) -> zFar(小)
    for (const [x0, x1] of xs) {
      const areaW = x1 - x0;
      const areaD = zNear - zFar;
      if (areaW < 8 || areaD < 10) continue;
      const n = clamp(Math.floor(areaW / 8) + Math.floor(rng() * 3), 2, 6);
      for (let k = 0; k < n; k++) {
        const w = clamp(5 + rng() * 5, 5, Math.min(10, areaW * 0.55));
        const d = clamp(5 + rng() * 4, 5, Math.min(9, areaD * 0.5));
        const bx = x0 + w / 2 + 1.0 + rng() * Math.max(0.5, areaW - w - 2.0);
        const bz = zFar + d / 2 + 1.0 + rng() * Math.max(0.5, areaD - d - 2.0);
        // 高度:近排矮(不挡天际线),中远排高,6% 概率地标塔
        let hMax = rowHMax[ri] ?? 70;
        let h = 10 + rng() * (hMax - 10);
        if (ri >= 1 && rng() < 0.06) h = Math.min(118, hMax + 26 + rng() * 26);
        buildings.push({ bx, bz, w, d, h, ri });
      }
    }
  }
  // 保底/封顶楼数
  while (buildings.length > 0 && buildings.length < CFG.buildingMin) {
    const proto = buildings[Math.floor(rng() * buildings.length)];
    buildings.push({
      bx: proto.bx + (rng() * 2 - 1) * 3,
      bz: proto.bz - rng() * 2,
      w: 5 + rng() * 4, d: 5 + rng() * 3, h: 12 + rng() * 40, ri: proto.ri,
    });
  }
  if (buildings.length > CFG.buildingMax) buildings.length = CFG.buildingMax;
  counts.buildings = buildings.length;

  // ---- 窗阵生成 ---------------------------------------------------------------
  const genFaceWindows = (list, cx, cy0, cz, span, h, rotY, forcedStart) => {
    const cols = clamp(Math.floor((span - 0.8) / 2.5), 1, 8);
    const rows = clamp(Math.floor((h - 2.0) / 3.2), 2, 26);
    const pitchC = (span - 0.8) / cols;
    const pitchR = (h - 2.6) / rows;
    // 窗格尺寸随局部间距缩放:填充率封顶 ~52%,保证窗格矩阵可辨识
    const winW = Math.min(1.12, pitchC * 0.52);
    const winH = Math.min(1.45, pitchR * 0.48);
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      const y = 2.4 + r * pitchR;
      for (let c = 0; c < cols; c++) {
        const off = -(span - 0.8) / 2 + 0.4 + (c + 0.5) * pitchC;
        let x, z;
        if (rotY === 0) { x = cx + off; z = cz; }
        else { x = cx; z = cz + off; }
        const warm = rng() < 0.58;
        const bright = 0.28 + rng() * 0.44; // 暗夜窗光(线性):过亮会糊成光墙
        const color = warm
          ? [bright * 1.00, bright * 0.62, bright * 0.30]
          : [bright * 0.52, bright * 0.74, bright * 1.00];
        list.push({
          x, y, z, rotY, color, winW, winH,
          forced: idx < 8, // 每面保底前 8 个(在强制窗内)
          lit: rng() < 0.55,
        });
        idx++;
      }
    }
  };

  for (const b of buildings) {
    const recs = [];
    // 正面(+Z,朝向相机)
    genFaceWindows(recs, b.bx, 0, b.bz + b.d / 2 + 0.08, b.w, b.h, 0, 0);
    // 朝主走廊的侧面(左右楼群各露一面向中心)
    const nearestCorr = corridors.reduce((a, c) => (Math.abs(b.bx - c) < Math.abs(b.bx - a) ? c : a), corridors[0]);
    if (Math.abs(b.bx - nearestCorr) < 20 && b.ri <= 3) {
      const rotY = b.bx < nearestCorr ? Math.PI / 2 : -Math.PI / 2; // +X 面或 -X 面
      const faceX = b.bx + (rotY > 0 ? b.w / 2 + 0.08 : -(b.w / 2 + 0.08));
      genFaceWindows(recs, faceX, 0, b.bz, b.d, b.h, rotY, 8);
    }
    // 每栋楼 >= 8 个发光窗:不足则强制点亮
    let litCount = recs.filter((r) => r.lit).length;
    if (litCount < CFG.windowMinPerBuilding) {
      for (const r of recs) {
        if (litCount >= CFG.windowMinPerBuilding) break;
        if (!r.lit) { r.lit = true; litCount++; }
      }
    }
    for (const r of recs) if (r.lit) windowRecs.push(r);
    b._winFaceCount = recs.length;
  }
  // 总量封顶(优先保留 forced)
  if (windowRecs.length > CFG.windowTotalMax) {
    windowRecs.sort((a, b) => (a.forced === b.forced ? 0 : a.forced ? -1 : 1));
    windowRecs.length = CFG.windowTotalMax;
  }
  counts.windows = windowRecs.length;

  // ---- 霓虹生成 -----------------------------------------------------------------
  for (const b of buildings) {
    if (b.bz < -96) continue; // 远景楼不挂霓虹(雾里看不清)
    const fz = b.bz + b.d / 2 + 0.22;
    const roll = rng();
    if (roll < 0.34) {
      // 竖招牌:挂在前立面一角
      const pal = NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)];
      const sw = 0.5 + rng() * 0.4;
      const sh = 2.6 + rng() * 2.2;
      neonRecs.push({
        x: b.bx + (rng() < 0.5 ? -1 : 1) * (b.w / 2 - 0.4),
        y: 4.2 + rng() * 9.0,
        z: fz, sx: sw, sy: sh, sz: 0.28,
        color: pal, phase: rng() * 20, speed: 1.6 + rng() * 2.4, mode: 0,
      });
    } else if (roll < 0.58) {
      // 广告横带:前立面中部
      const pal = NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)];
      neonRecs.push({
        x: b.bx,
        y: clamp(7 + rng() * (b.h * 0.55), 6, b.h - 2),
        z: fz, sx: b.w * (0.55 + rng() * 0.3), sy: 0.5 + rng() * 0.35, sz: 0.24,
        color: pal, phase: rng() * 20, speed: 0.8 + rng() * 1.4, mode: 1,
      });
    }
    // 高楼描边灯带:2-4 根竖亮线
    if (b.h > 52) {
      const nStrips = 2 + Math.floor(rng() * 3);
      const pal = NEON_PALETTE[Math.floor(rng() * 3)]; // 主色相(品红/青/橙)
      for (let s = 0; s < nStrips; s++) {
        const corner = Math.floor(rng() * 2) === 0 ? -1 : 1;
        neonRecs.push({
          x: b.bx + corner * (b.w / 2 - 0.10),
          y: b.h * 0.46,
          z: b.bz + (Math.floor(rng() * 2) === 0 ? 1 : -1) * (b.d / 2 - 0.10) + 0.12,
          sx: 0.16, sy: b.h * 0.9, sz: 0.16,
          color: pal, phase: rng() * 20, speed: 0.5 + rng() * 0.9, mode: 2,
        });
      }
    }
  }
  // 主走廊入口两块大广告牌(构图锚点)
  {
    const palA = NEON_PALETTE[0];
    const palB = NEON_PALETTE[1];
    neonRecs.push({ x: -8.6, y: 12.5, z: -22.5, sx: 5.6, sy: 2.9, sz: 0.30, color: palA, phase: 2.2, speed: 1.9, mode: 0 });
    neonRecs.push({ x: 8.6, y: 15.5, z: -26.5, sx: 4.8, sy: 2.4, sz: 0.30, color: palB, phase: 11.7, speed: 2.6, mode: 0 });
    // 沿主走廊两排街灯(纵深线索 + 湿地倒影)
    for (let i = 0; i < 9; i++) {
      const z = -6 - i * 13;
      neonRecs.push({ x: -5.4, y: 4.3, z, sx: 0.20, sy: 0.85, sz: 0.20, color: [0.55, 0.85, 1.0], phase: rng() * 20, speed: 0.5, mode: 2 });
      neonRecs.push({ x: 5.4, y: 4.3, z: z - 6, sx: 0.20, sy: 0.85, sz: 0.20, color: [1.0, 0.72, 0.45], phase: rng() * 20, speed: 0.5, mode: 2 });
    }
  }
  if (neonRecs.length > CFG.neonMax) neonRecs.length = CFG.neonMax;
  counts.neon = neonRecs.length;

  // ---- 写入实例 -----------------------------------------------------------------
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    _v3.set(b.bx, 0, b.bz);
    _q.identity();
    _s3.set(b.w, b.h, b.d);
    _m4.compose(_v3, _q, _s3);
    buildingsMesh.setMatrixAt(i, _m4);
    const v = 0.72 + mulberry32(CFG.seed + i * 977)() * 0.5; // 稳定的楼体明度差
    _col.setRGB(v * 0.92, v * 0.98, v * 1.12);
    buildingsMesh.setColorAt(i, _col);
  }
  buildingsMesh.count = buildings.length;
  buildingsMesh.instanceMatrix.needsUpdate = true;
  if (buildingsMesh.instanceColor) buildingsMesh.instanceColor.needsUpdate = true;

  for (let i = 0; i < windowRecs.length; i++) {
    const r = windowRecs[i];
    _v3.set(r.x, r.y, r.z);
    _q.setFromAxisAngle(Y_AXIS, r.rotY);
    _s3.set(r.winW / 1.12, r.winH / 1.45, 1); // 基础几何 1.12×1.45
    _m4.compose(_v3, _q, _s3);
    windowsMesh.setMatrixAt(i, _m4);
    _col.setRGB(r.color[0], r.color[1], r.color[2]);
    windowsMesh.setColorAt(i, _col);
  }
  windowsMesh.count = windowRecs.length;
  windowsMesh.instanceMatrix.needsUpdate = true;
  if (windowsMesh.instanceColor) windowsMesh.instanceColor.needsUpdate = true;

  // 霓虹实例属性(复用预建缓冲,重填后标记更新)
  for (let i = 0; i < neonRecs.length; i++) {
    const r = neonRecs[i];
    _v3.set(r.x, r.y, r.z);
    _q.identity();
    _s3.set(r.sx, r.sy, r.sz);
    _m4.compose(_v3, _q, _s3);
    neonMesh.setMatrixAt(i, _m4);
    _col.setRGB(r.color[0], r.color[1], r.color[2]);
    neonMesh.setColorAt(i, _col);
    neonPhaseAttr.array[i] = r.phase;
    neonSpeedAttr.array[i] = r.speed;
    neonModeAttr.array[i] = r.mode;
  }
  neonPhaseAttr.needsUpdate = true;
  neonSpeedAttr.needsUpdate = true;
  neonModeAttr.needsUpdate = true;
  neonMesh.count = neonRecs.length;
  neonMesh.instanceMatrix.needsUpdate = true;
  if (neonMesh.instanceColor) neonMesh.instanceColor.needsUpdate = true;
}

// ============================================================================
// 3. 车流:86 辆沿主干道连续移动(发光块 + 拖尾)
// ============================================================================
const AVENUES = [
  { axis: 'x', z: 16.3, dir: 1, n: 12, spd: [10, 14], range: [-150, 150], kind: 'head' },
  { axis: 'x', z: 19.7, dir: -1, n: 12, spd: [10, 14], range: [-150, 150], kind: 'tail' },
  { axis: 'x', z: -44.2, dir: -1, n: 9, spd: [12, 16], range: [-150, 150], kind: 'tail' },
  { axis: 'x', z: -47.4, dir: 1, n: 9, spd: [12, 16], range: [-150, 150], kind: 'head' },
  { axis: 'x', z: -107.8, dir: 1, n: 7, spd: [14, 18], range: [-150, 150], kind: 'head' },
  { axis: 'x', z: -110.6, dir: -1, n: 7, spd: [14, 18], range: [-150, 150], kind: 'tail' },
  { axis: 'z', x: 1.7, dir: 1, n: 10, spd: [10, 14], range: [-165, 24], kind: 'head' },
  { axis: 'z', x: -1.7, dir: -1, n: 10, spd: [10, 14], range: [-165, 24], kind: 'tail' },
  { axis: 'z', x: 28.5, dir: -1, n: 5, spd: [9, 13], range: [-150, 20], kind: 'tail' },
  { axis: 'z', x: -28.5, dir: 1, n: 5, spd: [9, 13], range: [-150, 20], kind: 'head' },
];
const cars = [];

function initCars() {
  const rng = mulberry32(CFG.seed ^ 0xca2f);
  cars.length = 0;
  for (const av of AVENUES) {
    for (let i = 0; i < av.n; i++) {
      let color;
      if (rng() < 0.15) color = [0.32, 0.85, 0.85];        // 青色出租车
      else if (av.kind === 'head') color = [1.55, 1.42, 1.12]; // 头灯暖白(HDR)
      else color = [1.30, 0.20, 0.11];                     // 尾灯红(HDR)
      cars.push({
        axis: av.axis,
        fixed: av.axis === 'x' ? av.z : av.x,
        dir: av.dir,
        p: av.range[0] + rng() * (av.range[1] - av.range[0]),
        speed: av.spd[0] + rng() * (av.spd[1] - av.spd[0]),
        range: av.range,
        trailLen: 3.2 + rng() * 2.4,
        color,
      });
    }
  }
  counts.cars = cars.length;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    _col.setRGB(c.color[0], c.color[1], c.color[2]);
    carsMesh.setColorAt(i, _col);
    _col.setRGB(c.color[0] * 0.5, c.color[1] * 0.5, c.color[2] * 0.5);
    trailsMesh.setColorAt(i, _col);
  }
  carsMesh.count = cars.length;
  trailsMesh.count = cars.length;
  if (carsMesh.instanceColor) carsMesh.instanceColor.needsUpdate = true;
  if (trailsMesh.instanceColor) trailsMesh.instanceColor.needsUpdate = true;
}

const _dirV = new THREE.Vector3();
function updateCars(dt) {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    c.p += c.dir * c.speed * dt;
    const span = c.range[1] - c.range[0];
    if (c.p > c.range[1]) c.p -= span;
    if (c.p < c.range[0]) c.p += span;

    let px, pz, yaw;
    if (c.axis === 'x') { px = c.p; pz = c.fixed; yaw = c.dir > 0 ? 0 : Math.PI; _dirV.set(c.dir, 0, 0); }
    else { px = c.fixed; pz = c.p; yaw = c.dir > 0 ? -Math.PI / 2 : Math.PI / 2; _dirV.set(0, 0, c.dir); }

    _v3.set(px, 0.34, pz);
    _q.setFromAxisAngle(Y_AXIS, yaw);
    _s3.set(1, 1, 1);
    _m4.compose(_v3, _q, _s3);
    carsMesh.setMatrixAt(i, _m4);

    // 拖尾:车后方拉长的发光面片(平躺,轻度加法混合)
    _v3.set(px - _dirV.x * (1.0 + c.trailLen / 2), 0.07, pz - _dirV.z * (1.0 + c.trailLen / 2));
    _s3.set(c.trailLen, 1, 0.74);
    _m4.compose(_v3, _q, _s3);
    trailsMesh.setMatrixAt(i, _m4);
  }
  carsMesh.instanceMatrix.needsUpdate = true;
  trailsMesh.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// 9. 后处理:RenderPass → UnrealBloom → OutputPass(ACES+sRGB)→ FXAA
// ============================================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45,  // strength:霓虹辉光(收紧,避免把窗阵糊成光墙)
  0.40,  // radius
  0.85   // threshold(HDR 域,只有霓虹/车灯越阈,窗点保持锐利)
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
composer.addPass(new FXAAPass());

// ============================================================================
// 状态 / 生命周期(stateContract + 真实 fps 测量)
// ============================================================================
let fogEnabled = true;      // 初始 true(spec)
let fogAmt = 1.0;           // 视觉雾量(向 fogEnabled 平滑)
let resetCount = 0;
let simTime = 0;            // 动画相位时钟(reset 归零)
let frameCount = 0;
let appReady = false;

// fps:最近 60 帧真实帧间隔滚动平均(rAF 时间戳,非常数)
const FPS_WINDOW = 60;
const fpsSamples = new Float64Array(FPS_WINDOW);
let fpsIdx = 0;
let fpsFilled = 0;
let currentFps = 0;

function pushFpsSample(dt) {
  fpsSamples[fpsIdx] = dt;
  fpsIdx = (fpsIdx + 1) % FPS_WINDOW;
  if (fpsFilled < FPS_WINDOW) fpsFilled++;
  let sum = 0;
  for (let i = 0; i < fpsFilled; i++) sum += fpsSamples[i];
  const mean = sum / fpsFilled;
  currentFps = mean > 0 ? Math.round((1 / mean) * 10) / 10 : 0;
}

function getState() {
  return {
    engine: 'three',
    ready: true,
    frame: frameCount,
    buildingCount: counts.buildings,
    carCount: counts.cars,
    rainParticleCount: counts.rain,
    windowCount: counts.windows,
    neonCount: counts.neon,
    fogEnabled: fogEnabled,
    fps: currentFps,
    resetCount: resetCount,
  };
}

function doReset() {
  resetCount += 1;
  simTime = 0;                     // 动画相位归零(车流位置重排、雨相位归零)
  fogEnabled = true;               // 雾开关恢复初始
  fogAmt = 1.0;
  syncFogUI();
  buildCity();                     // 同一种子重建同一座城(计数恢复初始)
  initCars();
}

window.__bench = { getState, reset: doReset };

// ============================================================================
// UI:雾开关 / 重置(data-ui + data-bench 双属性)+ 轻量 HUD
// ============================================================================
const style = document.createElement('style');
style.textContent = `
  .e07-panel {
    position: fixed; right: 14px; bottom: 12px; z-index: 9999;
    display: flex; gap: 8px; font: 12px/1 "Segoe UI", system-ui, sans-serif;
  }
  .e07-btn {
    padding: 7px 14px; border-radius: 6px; cursor: pointer;
    background: rgba(8, 12, 24, 0.74); color: #bfe3ff;
    border: 1px solid rgba(25, 227, 255, 0.35);
    letter-spacing: 0.08em; transition: all .15s ease;
    user-select: none;
  }
  .e07-btn:hover { color: #fff; border-color: #19e3ff; box-shadow: 0 0 14px rgba(25,227,255,.45); }
  .e07-btn:active { transform: translateY(1px); background: rgba(18, 34, 56, .9); }
  .e07-btn.off { color: #7d8aa5; border-color: rgba(120,140,170,.3); }
  .e07-hud {
    position: fixed; left: 12px; bottom: 12px; z-index: 9999;
    font: 11px/1.6 ui-monospace, Consolas, monospace; color: #9fd8ff;
    background: rgba(6, 10, 20, 0.55); padding: 6px 10px; border-radius: 6px;
    border: 1px solid rgba(25, 227, 255, 0.18); pointer-events: none;
    white-space: pre;
  }
`;
document.head.appendChild(style);

const panel = document.createElement('div');
panel.className = 'e07-panel';

const fogBtn = document.createElement('button');
fogBtn.className = 'e07-btn';
fogBtn.textContent = 'FOG: ON';
fogBtn.setAttribute('data-ui', 'toggle-fog');
fogBtn.setAttribute('data-bench', 'toggle-fog');
fogBtn.addEventListener('click', () => {
  fogEnabled = !fogEnabled;
  syncFogUI();
});

const resetBtn = document.createElement('button');
resetBtn.className = 'e07-btn';
resetBtn.textContent = 'RESET';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('data-bench', 'reset');
resetBtn.addEventListener('click', () => doReset());

panel.appendChild(fogBtn);
panel.appendChild(resetBtn);
document.body.appendChild(panel);

function syncFogUI() {
  fogBtn.textContent = fogEnabled ? 'FOG: ON' : 'FOG: OFF';
  fogBtn.classList.toggle('off', !fogEnabled);
}

const hud = document.createElement('div');
hud.className = 'e07-hud';
document.body.appendChild(hud);
let hudTimer = 0;
function updateHUD() {
  const s = getState();
  hud.textContent =
    `NEON CITY  E07\n` +
    `FPS ${s.fps.toFixed(0).padStart(3)}   FOG ${s.fogEnabled ? 'ON ' : 'OFF'}\n` +
    `BLD ${s.buildingCount}  WIN ${s.windowCount}\n` +
    `CAR ${s.carCount}  RAIN ${s.rainParticleCount}`;
}

// ============================================================================
// 初始化 + 主循环
// ============================================================================
buildCity();
initCars();
syncFogUI();
updateHUD();

function updateFog(dt) {
  const target = fogEnabled ? 1.0 : 0.0;
  fogAmt += (target - fogAmt) * Math.min(1, dt * 7.0);
  if (Math.abs(target - fogAmt) < 0.002) fogAmt = target;
  const density = CFG.fogDensity * fogAmt;
  scene.fog.density = density; // 密度 0 == 关雾(无 shader 重编译)
  skyMat.uniforms.uFogAmt.value = fogAmt;
  neonMat.uniforms.uFogDensity.value = density;
  trailMat.uniforms.uFogDensity.value = density;
  rainMat.uniforms.uFogDensity.value = density;
  groundU.uFogDensity.value = density;
}

function updateCamera() {
  // 极缓慢的漂浮取景(呼吸感视差,不干扰构图)
  const sway = Math.sin(simTime * 0.12) * 0.9;
  camera.position.set(sway, CAM_BASE.y + Math.sin(simTime * 0.073) * 0.22, CAM_BASE.z);
  camera.lookAt(sway * 0.3, CAM_TARGET.y, CAM_TARGET.z);
}

function updateUniforms() {
  neonMat.uniforms.uTime.value = simTime;
  rainMat.uniforms.uTime.value = simTime;
  skyMat.uniforms.uTime.value = simTime;
  groundU.uTime.value = simTime;
  groundU.uCamXZ.value.set(camera.position.x, camera.position.z);
}

let lastT = null;
function tick(now) {
  requestAnimationFrame(tick);
  let dt = lastT === null ? 1 / 60 : (now - lastT) / 1000;
  lastT = now;
  if (!(dt > 0)) dt = 1 / 60;
  pushFpsSample(Math.min(dt, 0.25)); // 真实帧间隔(钳制离谱离群)

  simTime += dt;
  updateFog(dt);
  updateCars(dt);
  updateCamera();
  updateUniforms();

  composer.render();
  frameCount++;

  if (!appReady) {
    appReady = true;
    window.__appReady = true; // 首帧渲染完成
  }

  hudTimer += dt;
  if (hudTimer > 0.25) { hudTimer = 0; updateHUD(); }
}
requestAnimationFrame(tick);

// --- 视口自适应 ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
});
