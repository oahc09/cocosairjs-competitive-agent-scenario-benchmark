// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— Three.js r186 Reference
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无外部资产):
//   1. 深空背景:内翻球面 ShaderMaterial(fbm 星云渐变)+ 1600 颗 Points 星点
//   2. 黑洞核心:纯黑事件视界球(半径 1.2,写深度,遮挡背后一切)
//   3. 光子环:面向相机的公告板环(半径 ~1.46 高斯亮环,辉光核心)
//   4. 吸积盘:RingGeometry(1.8→6.5)+ 自定义 ShaderMaterial
//      - 径向梯度:内缘蓝白 → 中带橙黄 → 外缘暗红
//      - 螺旋条纹:随 uRot(真实时间驱动,0.38 rad/s)连续旋转 + fbm 湍流
//      - 多普勒不对称:一侧增亮/偏蓝,一侧减暗/偏红
//   5. 引力透镜观感:盘后缘上弯的光弧(垂直平面内的半环,随相机方位角朝向)
//   6. 星流:260 粒子沿螺旋轨迹坠入,近视界加速、拉长拖尾,吞噬后外圈重生
//   7. 后处理链(Three 正片优势):RenderPass → UnrealBloomPass → OutputPass
//      (ACES 色调映射 + sRGB)→ 自定义 FinishPass(暗角 + 轻度色差)
// 页面契约:harness 断言 window.__appReady / window.__bench = { getState, reset }
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

// --- 冻结常数(brief.md §2/§3 尺度)--------------------------------------------
const DEG = Math.PI / 180;
const CFG = {
  horizonRadius: 1.2,     // 事件视界半径
  diskInner: 1.8,         // 吸积盘内缘
  diskOuter: 6.5,         // 吸积盘外缘
  photonRadius: 1.46,     // 光子环半径(观感)
  arcInner: 1.55,         // 透镜光弧内缘
  arcOuter: 4.25,         // 透镜光弧外缘
  diskOmega: 0.38,        // 盘旋转角速度 rad/s(spec 允许 0.15–0.6)
  distInit: 14.0,         // 初始相机距离
  distMin: 5.0,
  distMax: 28.0,
  distTau: 0.12,          // 缩放平滑时间常数(s)——1s 内基本到位
  wheelFactor: 0.012,     // deltaY → 距离变化
  fov: 62,
  elevDefault: 24 * DEG,  // 相机仰角(盘面相对视线倾角 ~24°,在 15–75° 内)
  elevMin: 9 * DEG,
  elevMax: 66 * DEG,
  azimMax: 60 * DEG,      // 拖拽方位微调范围(背景星密度按前向壳层设计)
  starStreamCount: 320,   // >= 200
  bgStarCount: 1900,      // >= 300
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ============================================================================
// 渲染器 / 场景 / 相机
// ============================================================================
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // OutputPass 统一执行
renderer.toneMappingExposure = 0.92;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(CFG.fov, window.innerWidth / window.innerHeight, 0.1, 2000);

// --- 相机轨道状态(距离平滑插值;方位/仰角可拖拽微调)--------------------------
const cam = {
  dist: CFG.distInit,
  distTarget: CFG.distInit,
  azimuth: 0,
  elevation: CFG.elevDefault,
};

function applyCamera() {
  const ce = Math.cos(cam.elevation);
  camera.position.set(
    cam.dist * Math.sin(cam.azimuth) * ce,
    cam.dist * Math.sin(cam.elevation),
    cam.dist * Math.cos(cam.azimuth) * ce
  );
  camera.lookAt(0, 0, 0);
}

// ============================================================================
// GLSL 公共噪声库(value noise + fbm,所有 shader 共用)
// ============================================================================
const GLSL_NOISE = /* glsl */ `
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
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}
`;

// ============================================================================
// 1. 深空背景:内翻球 + fbm 星云(保证画面四角有柔和冷色层次)
// ============================================================================
const nebulaMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vDir;
    uniform float uTime;
    ${GLSL_NOISE}
    void main() {
      // 三层星云;阈值按 fbm 实测分布(中位数≈0.49,p90≈0.61)选取,
      // 形成黑底 + 成片冷色云的双峰覆盖(角落亦有柔和层次)
      vec2 uv0 = vDir.xy * 0.9 + vec2(vDir.z * 0.6, 0.0) + 1.7;
      vec2 uv1 = vDir.xy * 3.2 + vec2(0.0, vDir.z * 1.9) + 3.7;
      vec2 uv2 = vDir.xy * 8.0 - vec2(vDir.z * 2.8, 0.0) + 11.3;
      float n0 = fbm(uv0 + uTime * 0.002);
      float n1 = fbm(uv1 + uTime * 0.004);
      float n2 = fbm(uv2 - uTime * 0.006);
      float neb0 = smoothstep(0.52, 0.60, n0);             // 大尺度冷蓝云带(~25-35% 覆盖)
      float neb1 = pow(smoothstep(0.52, 0.62, n1), 1.6);   // 中尺度冷紫斑块(~10%)
      float neb2 = pow(smoothstep(0.60, 0.70, n2), 1.8);   // 细尺度蓝色丝缕(~8%)
      vec3 base = vec3(0.004, 0.005, 0.011);
      vec3 col = base
               + neb0 * vec3(0.017, 0.022, 0.047)
               + neb1 * vec3(0.060, 0.034, 0.110)
               + neb2 * vec3(0.020, 0.040, 0.078);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 48, 32), nebulaMat));

// ============================================================================
// 2. 背景星空:1600 颗 Points(大小/亮度/色温差异 + 微弱闪烁)
// ============================================================================
const STAR_R = 780;
const starGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(CFG.bgStarCount * 3);
  const size = new Float32Array(CFG.bgStarCount);
  const bright = new Float32Array(CFG.bgStarCount);
  const phase = new Float32Array(CFG.bgStarCount);
  const color = new Float32Array(CFG.bgStarCount * 3);
  for (let i = 0; i < CFG.bgStarCount; i++) {
    // 70% 星点集中于初始视向前向壳层(±75° 方位 / ±55° 仰角,绕 -Z),
    // 保证首屏与四角密度稳定;30% 全球均匀(大角度拖拽时仍有星)。
    let dx;
    let dy;
    let dz;
    if (Math.random() < 0.7) {
      const az = (Math.random() * 2 - 1) * 75 * DEG;
      const el = (Math.random() * 2 - 1) * 55 * DEG;
      dx = Math.sin(az) * Math.cos(el);
      dy = Math.sin(el);
      dz = -Math.cos(az) * Math.cos(el);
    } else {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      dx = s * Math.cos(t);
      dy = u;
      dz = s * Math.sin(t);
    }
    pos[i * 3] = STAR_R * dx;
    pos[i * 3 + 1] = STAR_R * dy;
    pos[i * 3 + 2] = STAR_R * dz;
    const big = Math.random() < 0.14; // 少数亮星(辉光源)
    size[i] = big ? 4.2 + Math.random() * 2.8 : 1.0 + Math.random() * 1.6;
    bright[i] = big ? 1.05 + Math.random() * 0.45 : 0.22 + Math.random() * 0.5;
    phase[i] = Math.random();
    // 色温:多数冷白/蓝白,少数暖色
    const warm = Math.random() < 0.22;
    if (warm) {
      color[i * 3] = 1.0;
      color[i * 3 + 1] = 0.72 + Math.random() * 0.16;
      color[i * 3 + 2] = 0.48 + Math.random() * 0.16;
    } else {
      const b = 0.85 + Math.random() * 0.15;
      color[i * 3] = b * (0.78 + Math.random() * 0.16);
      color[i * 3 + 1] = b * (0.84 + Math.random() * 0.12);
      color[i * 3 + 2] = b;
    }
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
}
const starMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uPR: { value: renderer.getPixelRatio() } },
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    attribute vec3 aColor;
    uniform float uTime;
    uniform float uPR;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float tw = 0.82 + 0.18 * sin(uTime * (0.5 + aPhase * 1.6) + aPhase * 40.0);
      vColor = aColor;
      vAlpha = aBright * tw;
      gl_PointSize = clamp(aSize * uPR * (820.0 / -mv.z), 1.0, 13.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r2 = dot(d, d);
      float a = exp(-r2 * 8.5) * vAlpha;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor * a, 1.0);
    }
  `,
});
const starField = new THREE.Points(starGeo, starMat);
scene.add(starField);

// ============================================================================
// 3. 黑洞核心:纯黑事件视界球(写深度;所有发光体按深度被其遮挡)
// ============================================================================
const horizonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(CFG.horizonRadius, 64, 48),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
scene.add(horizonMesh);

// ============================================================================
// 4. 吸积盘主环:径向色梯度 + 螺旋旋转条纹 + fbm 湍流 + 多普勒不对称
// ============================================================================
const diskMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: {
    uRot: { value: 0 },
    uTime: { value: 0 },
    uInner: { value: CFG.diskInner },
    uOuter: { value: CFG.diskOuter },
  },
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
    uniform float uRot;
    uniform float uTime;
    uniform float uInner;
    uniform float uOuter;
    ${GLSL_NOISE}
    void main() {
      float r = length(vP);
      float theta = atan(vP.y, vP.x);
      float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);

      // 螺旋坐标:图案随 uRot 刚性旋转 + 对数螺旋扭转(尾随条纹)
      float a = theta - uRot + 2.6 * log(r);
      float n1 = fbm(vec2(a * 1.35, r * 1.25 - uTime * 0.05));
      float n2 = fbm(vec2(a * 4.2 + 7.3, r * 4.4 + uTime * 0.025));
      float streaks = 0.5 + 0.5 * sin(a * 8.0 + n1 * 5.5);
      streaks = pow(streaks, 1.7);
      float fil = mix(streaks, n2, 0.32) * 0.95 + 0.14;

      // 径向亮度:内缘炽热边缘 + 向外快速衰减的盘体
      float rim = exp(-pow((r - uInner - 0.14) / 0.40, 2.0));
      float body = pow(1.0 - t, 2.6) * 0.42 + 0.016;
      float bright = (rim * 0.95 + body) * (0.24 + 1.02 * fil);

      // 径向颜色梯度:蓝白 → 橙黄 → 暗红
      vec3 cHot = vec3(1.28, 1.22, 1.10);
      vec3 cMid = vec3(1.35, 0.58, 0.12);
      vec3 cCold = vec3(0.30, 0.055, 0.012);
      vec3 col = (t < 0.38)
        ? mix(cHot, cMid, t / 0.38)
        : mix(cMid, cCold, (t - 0.38) / 0.62);

      // 多普勒不对称:固定世界一侧增亮(轻微蓝移),另一侧减暗(红移)
      float dop = 1.0 + 0.46 * cos(theta);
      col *= dop;
      col = mix(col, col * vec3(1.0, 0.98, 0.93), max(dop - 1.0, 0.0) * 0.45);

      // 内外缘平滑淡出(无硬边)
      float edgeIn = smoothstep(0.0, 0.02, t);
      float edgeOut = 1.0 - smoothstep(0.68, 0.94, t);
      gl_FragColor = vec4(col * bright * edgeIn * edgeOut, 1.0);
    }
  `,
});
const diskMesh = new THREE.Mesh(
  new THREE.RingGeometry(CFG.diskInner, CFG.diskOuter, 288, 56),
  diskMat
);
diskMesh.rotation.x = -Math.PI / 2; // 平铺到世界 XZ 平面
scene.add(diskMesh);

// ============================================================================
// 5. 引力透镜光弧:垂直平面内的上半环(盘后缘上弯包绕核心的观感)
//    随相机方位角朝向(平面包含世界 Y 轴与相机水平方向)
// ============================================================================
const arcMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: {
    uRot: { value: 0 },
    uTime: { value: 0 },
    uInner: { value: CFG.arcInner },
    uOuter: { value: CFG.arcOuter },
    uTheta0: { value: 24 * DEG },
    uTheta1: { value: 156 * DEG },
  },
  vertexShader: diskMat.vertexShader,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vP;
    uniform float uRot;
    uniform float uTime;
    uniform float uInner;
    uniform float uOuter;
    uniform float uTheta0;
    uniform float uTheta1;
    ${GLSL_NOISE}
    void main() {
      float r = length(vP);
      float theta = atan(vP.y, vP.x);
      float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);

      // 条纹与主盘同源旋转(透镜像 = 后缘盘的弯折像)
      float a = theta - uRot * 0.5 + 2.0 * log(r);
      float n1 = fbm(vec2(a * 1.9, r * 1.6 - uTime * 0.04));
      float streaks = 0.5 + 0.5 * sin(a * 7.0 + n1 * 5.0);
      float fil = mix(pow(streaks, 1.5), n1, 0.3) * 0.9 + 0.25;

      float rim = exp(-pow((r - uInner - 0.10) / 0.36, 2.0));
      float body = pow(1.0 - t, 3.4) * 0.38;
      float bright = (rim * 1.05 + body) * (0.35 + 0.85 * fil);

      vec3 cHot = vec3(1.28, 1.20, 1.05);
      vec3 cMid = vec3(1.25, 0.58, 0.14);
      vec3 cCold = vec3(0.40, 0.08, 0.02);
      vec3 col = (t < 0.38)
        ? mix(cHot, cMid, t / 0.38)
        : mix(cMid, cCold, (t - 0.38) / 0.62);

      // 两端平滑淡出(与盘远侧自然衔接)
      float ends = smoothstep(uTheta0, uTheta0 + 0.30, theta)
                 * (1.0 - smoothstep(uTheta1 - 0.30, uTheta1, theta));
      float edgeOut = 1.0 - smoothstep(0.80, 1.0, t);
      gl_FragColor = vec4(col * bright * ends * edgeOut * 0.72, 1.0);
    }
  `,
});
const arcMesh = new THREE.Mesh(
  new THREE.RingGeometry(CFG.arcInner, CFG.arcOuter, 192, 32, 24 * DEG, 132 * DEG),
  arcMat
);
// 光弧面向相机(屏幕空间内呈包绕核心的上弯弓形);每帧与相机姿态对齐
scene.add(arcMesh);

// ============================================================================
// 6. 光子环:面向相机的公告板薄亮环(事件视界边缘的锐利光环 + 辉光核心)
// ============================================================================
const photonMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uR: { value: CFG.photonRadius } },
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
    uniform float uR;
    void main() {
      float r = length(vP);
      float ring = exp(-pow((r - uR) / 0.062, 2.0));
      float halo = exp(-pow((r - uR - 0.05) / 0.46, 2.0)) * 0.035;
      vec3 col = vec3(1.36, 1.08, 0.74) * (ring * 1.5 + halo);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const photonMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), photonMat);
scene.add(photonMesh);

// ============================================================================
// 7. 星流:260 粒子螺旋坠入(CPU 更新 LineSegments 拖尾;近视界加速/拉长/增亮)
// ============================================================================
const STREAM_N = CFG.starStreamCount;
const streamGeo = new THREE.BufferGeometry();
const streamPos = new Float32Array(STREAM_N * 2 * 3);
const streamFade = new Float32Array(STREAM_N * 2);
const streamHeat = new Float32Array(STREAM_N * 2);
streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
streamGeo.setAttribute('aFade', new THREE.BufferAttribute(streamFade, 1));
streamGeo.setAttribute('aHeat', new THREE.BufferAttribute(streamHeat, 1));
const streamMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    attribute float aFade;
    attribute float aHeat;
    varying float vFade;
    varying float vHeat;
    void main() {
      vFade = aFade;
      vHeat = aHeat;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying float vFade;
    varying float vHeat;
    void main() {
      vec3 cold = vec3(1.00, 0.52, 0.16);
      vec3 hot = vec3(1.32, 1.14, 0.92);
      vec3 col = mix(cold, hot, vHeat);
      float a = vFade * (0.55 + 1.25 * vHeat);
      gl_FragColor = vec4(col * a, 1.0);
    }
  `,
});
const streamLines = new THREE.LineSegments(streamGeo, streamMat);
streamLines.frustumCulled = false;
scene.add(streamLines);

// 星流头部亮点(与拖尾共享热度;近视界增大增亮,视觉上"坠落加速")
const headGeo = new THREE.BufferGeometry();
const headPos = new Float32Array(STREAM_N * 3);
const headHeat = new Float32Array(STREAM_N);
headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3));
headGeo.setAttribute('aHeat', new THREE.BufferAttribute(headHeat, 1));
const headMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uPR: { value: renderer.getPixelRatio() } },
  vertexShader: /* glsl */ `
    attribute float aHeat;
    uniform float uPR;
    varying float vHeat;
    void main() {
      vHeat = aHeat;
      gl_PointSize = clamp((2.0 + aHeat * 2.8) * uPR, 2.0, 5.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying float vHeat;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r2 = dot(d, d);
      float a = exp(-r2 * 10.0) * (0.55 + 0.95 * vHeat);
      if (a < 0.01) discard;
      vec3 col = mix(vec3(1.0, 0.55, 0.18), vec3(1.35, 1.18, 0.95), vHeat);
      gl_FragColor = vec4(col * a, 1.0);
    }
  `,
});
const streamHeads = new THREE.Points(headGeo, headMat);
streamHeads.frustumCulled = false;
scene.add(streamHeads);

// 粒子状态:life∈[0,1) 单调推进;速度随 ease² 加速;life>=1 时外圈重生
const streamP = [];
function spawnParticle(p, randomLife) {
  p.r0 = 6.3 + Math.random() * 2.3;              // 重生外圈半径
  p.phi0 = Math.random() * Math.PI * 2;
  p.sweep = (2.0 + Math.random() * 1.1) * Math.PI; // 总角行程(螺旋圈数)
  p.yAmp = 0.06 + Math.random() * 0.30;
  p.yFreq = 0.8 + Math.random() * 1.6;
  p.phiY = Math.random() * Math.PI * 2;
  p.life = randomLife ? Math.random() : 0;
  p.prev = null;
}
function initStream() {
  streamP.length = 0;
  for (let i = 0; i < STREAM_N; i++) {
    const p = {};
    spawnParticle(p, true);
    streamP.push(p);
  }
}
const _head = new THREE.Vector3();
function streamPoint(p, life, rot, out) {
  const ease = clamp(life, 0, 1);
  const r = p.r0 + (CFG.horizonRadius * 0.92 - p.r0) * Math.pow(ease, 0.78);
  const ang = p.phi0 + rot * 0.5 + p.sweep * ease; // 与盘图案同向的螺旋
  const y = p.yAmp * Math.sin(ang * p.yFreq + p.phiY) * Math.pow(1 - ease, 1.4);
  out.set(Math.cos(ang) * r, y, -Math.sin(ang) * r);
}

// ============================================================================
// 8. 后处理链:Render → UnrealBloom → Output(ACES+sRGB)→ Finish(暗角/色差)
// ============================================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.65,  // strength
  0.38,  // radius
  0.72   // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
composer.addPass(new FXAAPass()); // sRGB 域抗锯齿(光子环/细丝边缘)

// 终末 pass:sRGB 域轻量暗角 + 径向色差(胶片感收边)
// + 事件视界暗核遮罩:辉光是屏幕空间叠加,会淹没 104px 的暗核;
//   在合成阶段按投影轮廓把核心压回近黑(边缘干净锐利),环外辉光不受影响。
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCA: { value: 0.0016 },
    uVig: { value: 0.20 },
    uCore: { value: new THREE.Vector3(0.5, 0.5, 0.075) }, // xy=中心 uv,z=半径(uv,高归一)
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uCA;
    uniform float uVig;
    uniform vec3 uCore;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * uCA * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // 事件视界暗核(投影圆内压暗至 ~12%,0.82-1.02 倍半径间平滑过渡)
      vec2 pc = (vUv - uCore.xy) * vec2(uAspect, 1.0);
      float dCore = length(pc);
      col *= mix(0.12, 1.0, smoothstep(uCore.z * 0.82, uCore.z * 1.02, dCore));
      float vig = 1.0 - uVig * smoothstep(0.18, 0.62, r2);
      gl_FragColor = vec4(col * vig, 1.0);
    }
  `,
};
const finishPass = new ShaderPass(FinishShader);
composer.addPass(finishPass);

// ============================================================================
// bench 状态通道(真实数据,无伪造)+ reset
// ============================================================================
let frame = 0;
let resetCount = 0;
let simTime = 0;    // 累计模拟时间(reset 归零;dt 钳制防失焦跳变)
let diskRot = 0;    // 吸积盘累计旋转弧度 = diskOmega * simTime(单调递增)

function doReset() {
  resetCount += 1;
  simTime = 0;
  diskRot = 0;
  cam.dist = CFG.distInit;
  cam.distTarget = CFG.distInit;
  cam.azimuth = 0;
  cam.elevation = CFG.elevDefault;
  initStream(); // 星流粒子复位重生(背景星不变)
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    frame,
    ready: true,
    resetCount,
    diskRotation: diskRot,
    accretionPhase: (diskRot / (Math.PI * 2)) % 1,
    cameraDistance: cam.dist,
    starStreamCount: STREAM_N,
    backgroundStarCount: CFG.bgStarCount,
  }),
  reset: doReset,
};

// ============================================================================
// UI:右上角 reset 按钮(data-ui 契约)+ 左下角操作提示
// ============================================================================
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:14px;right:16px;z-index:10;padding:6px 18px;' +
    "font:13px/1.4 'Segoe UI',sans-serif;background:rgba(20,24,38,0.72);" +
    'color:#dfe6f5;border:1px solid rgba(140,160,210,0.45);border-radius:6px;' +
    'cursor:pointer;backdrop-filter:blur(4px);transition:border-color .15s,background .15s;';
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'rgba(255,200,120,0.8)'; });
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'rgba(140,160,210,0.45)'; });
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放 · 拖拽调整视角';
  hint.style.cssText =
    'position:fixed;left:14px;bottom:12px;z-index:10;padding:3px 10px;' +
    "font:11px/1.5 'Segoe UI',sans-serif;color:rgba(170,185,215,0.55);" +
    'background:rgba(8,10,18,0.4);border-radius:4px;pointer-events:none;';
  document.body.appendChild(hint);
}

// ============================================================================
// 交互:滚轮平滑缩放(负 dy = 靠近)+ 拖拽微调视角(可选加分项)
// ============================================================================
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cam.distTarget = clamp(cam.distTarget + e.deltaY * CFG.wheelFactor, CFG.distMin, CFG.distMax);
  },
  { passive: false }
);

let dragging = false;
let lastPX = 0;
let lastPY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPX = e.clientX;
  lastPY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPX;
  const dy = e.clientY - lastPY;
  lastPX = e.clientX;
  lastPY = e.clientY;
  cam.azimuth = clamp(cam.azimuth - dx * 0.0042, -CFG.azimMax, CFG.azimMax);
  cam.elevation = clamp(cam.elevation + dy * 0.0032, CFG.elevMin, CFG.elevMax);
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointercancel', () => { dragging = false; });

// ============================================================================
// 主循环:真实时间步进(dt 钳制 [0, 0.1]s,防失焦跳变),渲染后置 ready
// ============================================================================
initStream();
applyCamera();

let lastNow = performance.now();
const _origin = new THREE.Vector3();
function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  dt = clamp(dt, 0, 0.1);

  simTime += dt;
  diskRot = CFG.diskOmega * simTime;

  // 相机距离平滑插值(指数趋近,τ=0.12s)
  cam.dist += (cam.distTarget - cam.dist) * (1 - Math.exp(-dt / CFG.distTau));
  applyCamera();

  // 透镜弧与光子环面向相机(屏幕空间弓形/圆环)
  arcMesh.quaternion.copy(camera.quaternion);
  photonMesh.quaternion.copy(camera.quaternion);

  // 暗核遮罩参数:视界球投影中心与视轮廓半径(透视放大)
  {
    const ndc = _origin.set(0, 0, 0).project(camera);
    const d = camera.position.length();
    const silR = CFG.horizonRadius * d / Math.sqrt(d * d - CFG.horizonRadius * CFG.horizonRadius);
    const radiusUv = (silR / (d * Math.tan(CFG.fov * DEG * 0.5))) * 0.5;
    finishPass.uniforms.uCore.value.set((ndc.x + 1) / 2, (ndc.y + 1) / 2, radiusUv);
    finishPass.uniforms.uAspect.value = window.innerWidth / Math.max(window.innerHeight, 1);
  }

  // 盘/弧/星 shader uniforms
  diskMat.uniforms.uRot.value = diskRot;
  diskMat.uniforms.uTime.value = simTime;
  arcMat.uniforms.uRot.value = diskRot;
  arcMat.uniforms.uTime.value = simTime;
  starMat.uniforms.uTime.value = simTime;
  nebulaMat.uniforms.uTime.value = simTime;

  // 星流推进:ease² 加速;life>=1 吞噬重生
  for (let i = 0; i < STREAM_N; i++) {
    const p = streamP[i];
    const ease = clamp(p.life, 0, 1);
    p.life += dt * (0.05 + 0.52 * Math.pow(ease, 2.2));
    if (p.life >= 1) {
      spawnParticle(p, false);
      continue;
    }
    streamPoint(p, p.life, diskRot, _head);
    const ease2 = clamp(p.life, 0, 1);
    const trailLen = 0.08 + 0.62 * ease2 * ease2;
    const i6 = i * 6;
    if (p.prev) {
      const dx = _head.x - p.prev.x;
      const dy = _head.y - p.prev.y;
      const dz = _head.z - p.prev.z;
      const len = Math.hypot(dx, dy, dz) || 1e-6;
      const k = trailLen / len;
      // 头部 + 沿速度反方向的尾部
      streamPos[i6] = _head.x;
      streamPos[i6 + 1] = _head.y;
      streamPos[i6 + 2] = _head.z;
      streamPos[i6 + 3] = _head.x - dx * k;
      streamPos[i6 + 4] = _head.y - dy * k;
      streamPos[i6 + 5] = _head.z - dz * k;
    } else {
      streamPos[i6] = streamPos[i6 + 3] = _head.x;
      streamPos[i6 + 1] = streamPos[i6 + 4] = _head.y;
      streamPos[i6 + 2] = streamPos[i6 + 5] = _head.z;
    }
    p.prev = p.prev ?? new THREE.Vector3();
    p.prev.copy(_head);
    headPos[i * 3] = _head.x;
    headPos[i * 3 + 1] = _head.y;
    headPos[i * 3 + 2] = _head.z;
    headHeat[i] = ease2;
    streamFade[i * 2] = 1.0;
    streamFade[i * 2 + 1] = 0.12;
    streamHeat[i * 2] = ease2;
    streamHeat[i * 2 + 1] = ease2;
  }
  streamGeo.attributes.position.needsUpdate = true;
  streamGeo.attributes.aFade.needsUpdate = true;
  streamGeo.attributes.aHeat.needsUpdate = true;
  headGeo.attributes.position.needsUpdate = true;
  headGeo.attributes.aHeat.needsUpdate = true;

  frame += 1;
  composer.render();
  if (window.__appReady !== true) {
    window.__appReady = true; // 首帧渲染完成
  }
}
requestAnimationFrame(tick);

// ============================================================================
// 视口自适应
// ============================================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  starMat.uniforms.uPR.value = renderer.getPixelRatio();
  headMat.uniforms.uPR.value = renderer.getPixelRatio();
});
