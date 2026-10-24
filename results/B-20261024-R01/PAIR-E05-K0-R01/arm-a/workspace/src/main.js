// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)
// ----------------------------------------------------------------------------
// 页面契约:window.__appReady / window.__bench = { getState, reset } / data-ui="reset"
//
// 场景结构(全部程序化生成,零外部资产):
//   1) 深空天穹  — BackSide 球体,GLSL fbm 星云(冷蓝/微紫)
//   2) 背景星    — 1500 颗 Points,逐点尺寸/亮度/色温
//   3) 事件视界  — 纯黑球体(遮挡背后星点与星流)
//   4) 吸积盘    — 自定义环形网格 + ShaderMaterial:径向温度梯度 + 差速旋转条纹
//                  + 多普勒不对称(近侧增亮)+ 湍流细节;加法混合(自发光气体)
//   5) 引力透镜晕 — 面向相机的环面:光子环 + 被弯折到上下方的盘后缘弧
//   6) 星流      — 260 条线段拖尾 + 头部亮点,螺旋内落、视界处重生
//   7) 后期      — EffectComposer + UnrealBloomPass(辉光观感,路径不限)
//
// 时间基准:全部由真实时间步进(dt 上限 0.1s,失焦回来不会突跳)。
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------------------
// 常量(场景尺度与 Brief 一致:视界 ~1.15、盘 1.75..6.7、初始相机 14)
// ---------------------------------------------------------------------------
const CFG = {
  camDist0: 14.0,
  camMin: 5.0,
  camMax: 28.0,
  fov: 60,
  elevationDeg: 27,       // 相机在盘面上方的仰角 → 盘面倾角 27°(15°–75° 内)
  horizonR: 1.15,
  diskInner: 1.75,
  diskOuter: 6.70,
  omega: 0.32,            // 盘面图案角速度 rad/s(合同 0.15–0.6)
  streamCount: 260,       // >= 200,恒定
  bgStars: 1500,          // >= 300,恒定
  zoomExpK: 0.0009,       // wheel dy → 距离指数缩放系数
  zoomTau: 0.16,          // 缩放平滑时间常数(1s 内到位)
  resetDist: 14.0,
};

// ---------------------------------------------------------------------------
// 共享 GLSL 片段
// ---------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++){
    s += a * vnoise(p);
    p = p * 2.02 + vec2(13.7, 7.1);
    a *= 0.5;
  }
  return s;
}
`;

// 径向温度色带:t=0 内缘(白/蓝白)→ 黄 → 橙 → 暗红(t=1)
const GLSL_RAMP = /* glsl */ `
vec3 tempRamp(float t){
  vec3 c = mix(vec3(0.72, 0.86, 1.00), vec3(1.00, 0.97, 0.92), smoothstep(0.00, 0.09, t));
  c = mix(c, vec3(1.00, 0.86, 0.52), smoothstep(0.09, 0.24, t));
  c = mix(c, vec3(1.00, 0.55, 0.16), smoothstep(0.24, 0.46, t));
  c = mix(c, vec3(0.66, 0.17, 0.045), smoothstep(0.46, 0.72, t));
  c = mix(c, vec3(0.26, 0.045, 0.018), smoothstep(0.72, 1.00, t));
  return c;
}
`;

// ---------------------------------------------------------------------------
// 渲染器 / 场景 / 相机
// ---------------------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 1);
// 色调映射交给 OutputPass(后期链);渲染到 HDR target 时 three 不会在材质里做
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  CFG.fov,
  window.innerWidth / window.innerHeight,
  0.1,
  1200
);

// 相机方向固定(仰角 27°),距离由滚轮在 [5,28] 内平滑插值
const elevRad = THREE.MathUtils.degToRad(CFG.elevationDeg);
const camDir = new THREE.Vector3(0, Math.sin(elevRad), Math.cos(elevRad)).normalize();
let camDistance = CFG.camDist0;
let camTarget = CFG.camDist0;
camera.position.copy(camDir).multiplyScalar(camDistance);
camera.lookAt(0, 0, 0);

// ---------------------------------------------------------------------------
// 1) 深空天穹(星云):BackSide 大球 + fbm 冷色云
// ---------------------------------------------------------------------------
{
  const skyGeo = new THREE.SphereGeometry(420, 48, 32);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      ${GLSL_NOISE}
      void main(){
        vec3 d = normalize(vDir);
        float n1 = fbm(d.xy * 2.30 + vec2(3.1, 1.7));
        float n2 = fbm(d.zy * 4.10 - vec2(1.3, 2.9));
        float n3 = fbm(d.xz * 6.40 + vec2(8.2, 4.4));
        float cloud = smoothstep(0.30, 0.92, n1 * 0.62 + n2 * 0.46);
        // 银河带:一条大圆弧上的稀疏亮雾,给深空一点结构
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.82, -0.45))) / 0.26, 2.0));
        float dust = smoothstep(0.25, 0.85, n3);

        vec3 base  = vec3(0.0062, 0.0080, 0.0165);
        vec3 cool  = vec3(0.0165, 0.0230, 0.0540);
        vec3 violet= vec3(0.0290, 0.0165, 0.0420);
        vec3 col = base;
        col += cool * cloud * 0.85;
        col += violet * pow(cloud, 2.0) * 0.55;
        col += vec3(0.011, 0.015, 0.030) * band * (0.35 + 0.65 * dust);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -30;
  sky.frustumCulled = false;
  scene.add(sky);
  scene.userData.skyMat = skyMat;
}

// ---------------------------------------------------------------------------
// 2) 背景星(>=300,恒定;逐点尺寸/亮度/色温)
// ---------------------------------------------------------------------------
const BG_STAR_COUNT = CFG.bgStars;
{
  const pos = new Float32Array(BG_STAR_COUNT * 3);
  const size = new Float32Array(BG_STAR_COUNT);
  const bright = new Float32Array(BG_STAR_COUNT);
  const tint = new Float32Array(BG_STAR_COUNT * 3);

  const tintA = new THREE.Color(0.80, 0.88, 1.00); // 冷白
  const tintB = new THREE.Color(1.00, 0.96, 0.88); // 暖白
  const tintC = new THREE.Color(1.00, 0.82, 0.66); // 橙矮星

  let s = 20261024;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  for (let i = 0; i < BG_STAR_COUNT; i++) {
    // 球面均匀采样,半径 260–380(远于盘与星流,近于天穹)
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = 260 + rnd() * 120;
    const sq = Math.sqrt(Math.max(0, 1 - u * u));
    pos[i * 3 + 0] = Math.cos(phi) * sq * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = Math.sin(phi) * sq * r;

    const m = Math.pow(rnd(), 2.6); // 少数亮星,多数暗星
    size[i] = 1.0 + 2.8 * m + rnd() * 0.5;
    bright[i] = 0.16 + 1.55 * m;

    const k = rnd();
    const c = k < 0.55 ? tintA : (k < 0.88 ? tintB : tintC);
    tint[i * 3 + 0] = c.r;
    tint[i * 3 + 1] = c.g;
    tint[i * 3 + 2] = c.b;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));

  const m = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aBright;
      attribute vec3 aTint;
      uniform float uPixelRatio;
      varying vec3 vTint;
      varying float vB;
      void main(){
        vTint = aTint;
        vB = aBright;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vTint;
      varying float vB;
      void main(){
        float d = length(gl_PointCoord - vec2(0.5));
        float core = smoothstep(0.50, 0.06, d);
        float halo = exp(-d * d * 12.0) * 0.55;
        vec3 c = vTint * vB * (core + halo);
        if (c.r + c.g + c.b < 0.0005) discard;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(g, m);
  pts.renderOrder = -20;
  pts.frustumCulled = false;
  scene.add(pts);
}

// ---------------------------------------------------------------------------
// 3) 事件视界:纯黑球(写入深度 → 正确遮挡背后的星点与星流)
// ---------------------------------------------------------------------------
{
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(CFG.horizonR, 64, 48),
    new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false })
  );
  core.renderOrder = 0;
  scene.add(core);
}

// ---------------------------------------------------------------------------
// 4) 吸积盘:自定义环网格(aRadius / aTheta)+ 程序化着色
// ---------------------------------------------------------------------------
function makeDiskGeometry(inner, outer, radialSegs, angularSegs) {
  const count = (radialSegs + 1) * (angularSegs + 1);
  const pos = new Float32Array(count * 3);
  const aR = new Float32Array(count);
  const aTheta = new Float32Array(count);
  const idx = new Uint32Array(radialSegs * angularSegs * 6);

  let p = 0;
  for (let j = 0; j <= radialSegs; j++) {
    // 内圈更密:内缘梯度变化最快,细分换平滑
    const tr = Math.pow(j / radialSegs, 0.82);
    const r = inner + (outer - inner) * tr;
    for (let i = 0; i <= angularSegs; i++) {
      const th = (i / angularSegs) * Math.PI * 2;
      pos[p * 3 + 0] = Math.cos(th) * r;
      pos[p * 3 + 1] = 0;
      pos[p * 3 + 2] = Math.sin(th) * r;
      aR[p] = r;
      aTheta[p] = th;
      p++;
    }
  }
  let k = 0;
  for (let j = 0; j < radialSegs; j++) {
    for (let i = 0; i < angularSegs; i++) {
      const a = j * (angularSegs + 1) + i;
      const b = a + 1;
      const c = a + (angularSegs + 1);
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aR', new THREE.BufferAttribute(aR, 1));
  g.setAttribute('aTheta', new THREE.BufferAttribute(aTheta, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

const diskUniforms = {
  uTime: { value: 0 },
  uRotation: { value: 0 },
  uInner: { value: CFG.diskInner },
  uOuter: { value: CFG.diskOuter },
  uDopPhase: { value: 0.0 }, // 多普勒亮侧方位角(+X 侧为 approaching)
};

{
  const geo = makeDiskGeometry(CFG.diskInner, CFG.diskOuter, 120, 384);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: diskUniforms,
    vertexShader: /* glsl */ `
      attribute float aR;
      attribute float aTheta;
      varying float vR;
      varying float vTheta;
      void main(){
        vR = aR;
        vTheta = aTheta;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRotation;
      uniform float uInner;
      uniform float uOuter;
      uniform float uDopPhase;
      varying float vR;
      varying float vTheta;

      ${GLSL_NOISE}
      ${GLSL_RAMP}

      void main(){
        float t = clamp((vR - uInner) / (uOuter - uInner), 0.0, 1.0);

        // 差速旋转:内圈更快(开普勒式剪切)→ 条纹随时间自然缠绕
        float ang = vTheta - uRotation * (1.0 + 0.30 / max(vR, 1.0));

        // 主螺旋臂 + 细纹 + 湍流(世界空间采样,无接缝)
        float s1 = 0.5 + 0.5 * sin(9.0 * ang + 5.0 * log(vR / uInner));
        float s2 = 0.5 + 0.5 * sin(23.0 * ang - 2.2 * log(vR / uInner) + 1.7);
        float s3 = 0.5 + 0.5 * sin(47.0 * ang + 3.0 * log(vR / uInner) + 0.7);
        vec2 q = vec2(cos(ang), sin(ang)) * vR;
        float n1 = fbm(q * 1.55 + vec2(uTime * 0.030, -uTime * 0.020));
        float n2 = fbm(q * 3.70 + vec2(-uTime * 0.050, uTime * 0.040));

        float tex = 0.34 * s1 + 0.26 * s2 + 0.16 * s3 + 0.30 * n1 + 0.24 * n2;
        // 内缘(t 很小)近乎均匀白热,条纹对比度随半径增大 → 避免内圈变成"太阳芒"
        float amp = smoothstep(0.02, 0.24, t);
        float bright = mix(1.05, mix(0.50, 1.70, smoothstep(0.18, 0.82, tex)), amp);

        // 径向亮度:内缘白热峰 + 快速衰减(ACES 下 >1.2 即近白,
        // 峰值刻意压在 ~1.8 → 亮但不制造大面积曝光溢出)
        float radial = 0.060 + 0.85 * exp(-t / 0.040)
                     + 0.40 * exp(-t / 0.20)
                     + 0.16 * pow(1.0 - t, 2.0);
        // 内缘极窄白边(盘与光子环交界)
        radial += 0.35 * exp(-pow((t - 0.001) / 0.012, 2.0));

        // 多普勒:靠近侧增亮、远离侧压暗(只改亮度不改色相,
        // 保证径向色温梯度在两侧一致)
        float dop = 0.42 + 1.12 * pow(0.5 + 0.5 * cos(vTheta - uDopPhase), 1.5);

        // 内外边缘软收边,避免几何硬边
        float edge = smoothstep(0.0, 0.012, t) * (1.0 - smoothstep(0.86, 1.0, t));

        vec3 col = tempRamp(t) * (radial * bright * dop * edge);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const disk = new THREE.Mesh(geo, mat);
  disk.renderOrder = 2;
  scene.add(disk);
}

// ---------------------------------------------------------------------------
// 5) 引力透镜晕:面向相机的环面 —— 光子环 + 盘后缘弯折弧
// ---------------------------------------------------------------------------
const haloUniforms = {
  uTime: { value: 0 },
  uRotation: { value: 0 },
};
let haloMesh = null;
{
  const geo = new THREE.RingGeometry(1.02, 4.70, 256, 48);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // 光晕永远叠在画面最上层(透镜像在盘前也在盘后)
    side: THREE.DoubleSide,
    uniforms: haloUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main(){
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRotation;
      varying vec2 vP;

      ${GLSL_NOISE}
      ${GLSL_RAMP}

      void main(){
        float rr = length(vP);
        float phi = atan(vP.y, vP.x);

        // 光子环:贴着视界边缘的极窄亮环
        float ring = exp(-pow((rr - 1.28) / 0.062, 2.0));
        float ringWide = exp(-pow((rr - 1.46) / 0.42, 2.0)) * 0.12;

        // 盘后缘被引力弯折到阴影上方/下方形成的弧(取竖直方向加权,
        // 半径范围收窄,避免变成满天辐条)
        float vert = abs(sin(phi));
        float arcMask = smoothstep(0.55, 0.98, vert);
        float arcBand = smoothstep(1.10, 1.26, rr) * (1.0 - smoothstep(2.05, 2.95, rr));
        float t = clamp((rr - 1.25) / 4.60, 0.0, 1.0);

        float stripes = 0.86 + 0.14 * sin(phi * 15.0 + uRotation * 2.2 + rr * 5.0);
        float streaks = 0.68 + 0.32 * fbm(vec2(cos(phi), sin(phi)) * (2.2 + rr * 0.55)
                                      + vec2(uTime * 0.02, rr * 0.4));
        float arc = arcMask * arcBand * stripes * streaks;

        vec3 ringCol = vec3(0.82, 0.92, 1.00);
        vec3 arcCol = tempRamp(0.18 + t * 0.62);

        vec3 col = ringCol * (ring * 0.55 + ringWide)
                 + arcCol * arc * 0.22;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  haloMesh = new THREE.Mesh(geo, mat);
  haloMesh.renderOrder = 5;
  haloMesh.frustumCulled = false;
  scene.add(haloMesh);
}

// ---------------------------------------------------------------------------
// 6) 星流:260 条拖尾线段 + 头部亮点
// ---------------------------------------------------------------------------
const STREAM_N = CFG.streamCount;
const streamR = new Float32Array(STREAM_N);
const streamTh = new Float32Array(STREAM_N);
const streamY = new Float32Array(STREAM_N);
const streamV = new Float32Array(STREAM_N);
const streamW = new Float32Array(STREAM_N);

const trailPos = new Float32Array(STREAM_N * 2 * 3); // [head, tail] × N
const trailB = new Float32Array(STREAM_N * 2);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute('aBright', new THREE.BufferAttribute(trailB, 1));

const trailMat = new THREE.ShaderMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: true,
  uniforms: {
    uHead: { value: new THREE.Color(1.00, 0.95, 0.90) },
    uTail: { value: new THREE.Color(1.00, 0.55, 0.22) },
  },
  vertexShader: /* glsl */ `
    attribute float aBright;
    varying float vB;
    void main(){
      vB = aBright;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uHead;
    uniform vec3 uTail;
    varying float vB;
    void main(){
      vec3 c = mix(uTail, uHead, clamp(vB, 0.0, 1.0)) * (0.03 + 0.55 * vB);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
});
const trailLines = new THREE.LineSegments(trailGeo, trailMat);
trailLines.renderOrder = 3;
trailLines.frustumCulled = false;
scene.add(trailLines);

const headPos = new Float32Array(STREAM_N * 3);
const headSize = new Float32Array(STREAM_N);
const headB = new Float32Array(STREAM_N);
const headGeo = new THREE.BufferGeometry();
headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3));
headGeo.setAttribute('aSize', new THREE.BufferAttribute(headSize, 1));
headGeo.setAttribute('aBright', new THREE.BufferAttribute(headB, 1));

const headMat = new THREE.ShaderMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: true,
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uColor: { value: new THREE.Color(1.0, 0.97, 0.94) },
  },
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute float aBright;
    uniform float uPixelRatio;
    varying float vB;
    void main(){
      vB = aBright;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uPixelRatio;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    varying float vB;
    void main(){
      float d = length(gl_PointCoord - vec2(0.5));
      float a = smoothstep(0.5, 0.08, d);
      vec3 c = uColor * vB * a;
      if (c.r + c.g + c.b < 0.0005) discard;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
});
const headPoints = new THREE.Points(headGeo, headMat);
headPoints.renderOrder = 4;
headPoints.frustumCulled = false;
scene.add(headPoints);

// 确定性伪随机(仅用于外观分布,不影响时间演化)
let rndState = 987654321;
function rnd01() {
  rndState = (rndState * 1664525 + 1013904223) >>> 0;
  return rndState / 4294967296;
}

function respawnParticle(i, initial) {
  // 初始铺满整条螺旋;重生从外圈开始
  const r = initial ? 1.35 + rnd01() * 6.9 : 6.6 + rnd01() * 2.3;
  streamR[i] = r;
  streamTh[i] = rnd01() * Math.PI * 2;
  streamY[i] = (rnd01() - 0.5) * 0.30;
  streamV[i] = 0.85 + rnd01() * 0.6;   // 个体速度系数
  streamW[i] = 0.8 + rnd01() * 0.5;    // 个体角速度系数
  headSize[i] = 1.6 + rnd01() * 2.2;
}

function initStream(initial) {
  for (let i = 0; i < STREAM_N; i++) respawnParticle(i, initial);
}

initStream(true);

// 星流演化:螺旋内落 → 视界(1.34)处吞噬 → 外圈重生(总数恒定)
function updateStream(dt) {
  for (let i = 0; i < STREAM_N; i++) {
    let r = streamR[i];
    let th = streamTh[i];

    const v = (0.30 + 1.95 * Math.exp(-(r - 1.30) / 1.10)) * streamV[i];
    const w = 0.55 * Math.pow(6.0 / Math.max(r, 1.0), 1.15) * streamW[i];

    r -= v * dt;
    th += w * dt;
    if (r < 1.46) {
      respawnParticle(i, false);
      r = streamR[i];
      th = streamTh[i];
    }
    streamR[i] = r;
    streamTh[i] = th;

    const y = streamY[i];
    const hx = Math.cos(th) * r;
    const hz = Math.sin(th) * r;
    const hi = i * 6;
    trailPos[hi + 0] = hx;
    trailPos[hi + 1] = y;
    trailPos[hi + 2] = hz;

    // 拖尾:长度随内落速度增加(越接近视界越被拉长)
    const tl = (0.10 + 0.16 * Math.exp(-(r - 1.30) / 1.05)) * streamV[i];
    const rp = r + v * tl;
    const tp = th - w * tl;
    trailPos[hi + 3] = Math.cos(tp) * rp;
    trailPos[hi + 4] = y;
    trailPos[hi + 5] = Math.sin(tp) * rp;

    // 近核淡出:星流被吸积盘内缘淹没,避免在视界周围堆成白色芒刺
    const fade = THREE.MathUtils.smoothstep(r, 1.50, 2.60);
    const heat = THREE.MathUtils.clamp(1.0 - (r - 1.34) / 6.4, 0.18, 1.0);
    trailB[i * 2 + 0] = heat * fade;          // head
    trailB[i * 2 + 1] = heat * fade * 0.10;   // tail

    headPos[i * 3 + 0] = hx;
    headPos[i * 3 + 1] = y;
    headPos[i * 3 + 2] = hz;
    headB[i] = (0.12 + 0.30 * heat) * fade;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.aBright.needsUpdate = true;
  headGeo.attributes.position.needsUpdate = true;
  headGeo.attributes.aBright.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// 7) 后期:ACES + UnrealBloom + OutputPass
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.40,   // strength
  0.22,   // radius(收紧:只做柔和溢出,不淹没黑洞暗核)
  0.95    // threshold(HDR 线性域:只让内缘/亮星溢出)
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// 事件视界"恢复纯黑"通道
// 为什么需要:UnrealBloom 的最宽 mip 会把内缘白热的辉光卷积到暗核上,
// 把纯黑的事件视界糊成灰球。这一通道只在「屏幕投影的视界圆盘 ∩ 暗像素」
// 内做有向压暗:从前方掠过的盘内缘与星流是亮像素,原样保留;本就该黑的
// 部分被压回黑。边缘 4px 软过渡,保持锐利但不锯齿。
const shadowPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uRadius: { value: 0.071 },   // 视界圆盘屏幕半径(占视口高度比例)
    uAspect: { value: window.innerWidth / window.innerHeight },
    uFloor: { value: 0.02 },     // 压暗后的残余系数(2% → 观感纯黑)
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uRadius;
    uniform float uAspect;
    uniform float uFloor;
    varying vec2 vUv;
    void main(){
      vec4 tex = texture2D(tDiffuse, vUv);
      vec2 d = (vUv - vec2(0.5)) * vec2(uAspect, 1.0);
      float r = length(d) / max(uRadius, 1e-4);
      float inside = 1.0 - smoothstep(0.94, 1.02, r);
      float l = dot(tex.rgb, vec3(0.2126, 0.7152, 0.0722));
      float darkish = 1.0 - smoothstep(0.42, 0.72, l);
      tex.rgb *= mix(1.0, uFloor, inside * darkish);
      gl_FragColor = tex;
    }
  `,
});
composer.addPass(shadowPass);

// ---------------------------------------------------------------------------
// 状态通道 + reset
// ---------------------------------------------------------------------------
let diskRotation = 0;   // 累计旋转弧度
let elapsed = 0;        // 场景累计时间(s)
let frames = 0;
let fps = 60;

function accretionPhase() {
  const p = (diskRotation / (Math.PI * 2)) % 1;
  return p < 0 ? p + 1 : p;
}

function doReset() {
  diskRotation = 0;
  camTarget = CFG.resetDist;
  camDistance = CFG.resetDist; // 立即回到初始构图(读数为 14.0,不等插值)
  camera.position.copy(camDir).multiplyScalar(camDistance);
  camera.lookAt(0, 0, 0);
  initStream(true);
  updateStream(0);
}

window.__bench = {
  getState: () => ({
    diskRotation,
    accretionPhase: accretionPhase(),
    cameraDistance: camDistance,
    starStreamCount: STREAM_N,
    backgroundStarCount: BG_STAR_COUNT,
    // 诊断附加字段(不属于合同口径)
    elapsed,
    fps,
    frame: frames,
    engine: 'three',
  }),
  reset: doReset,
};

// 右上角 reset 按钮(data-ui 契约;归一化坐标 x>0.8, y<0.25)
{
  const btn = document.createElement('button');
  btn.setAttribute('data-ui', 'reset');
  btn.textContent = '重置';
  btn.style.cssText =
    'position:fixed;top:14px;right:16px;z-index:10;padding:6px 14px;' +
    'font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.08em;' +
    'color:#cfe3ff;background:rgba(12,18,34,.72);border:1px solid rgba(120,170,255,.45);' +
    'border-radius:6px;cursor:pointer;backdrop-filter:blur(4px);' +
    'box-shadow:0 0 12px rgba(70,130,255,.18)';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.id = 'hint';
  hint.textContent = '滚轮缩放';
  hint.style.cssText =
    'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;' +
    'font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.22em;' +
    'color:rgba(160,190,235,.45);pointer-events:none;user-select:none';
  document.body.appendChild(hint);
}

// ---------------------------------------------------------------------------
// 交互:滚轮缩放(距离指数映射 + 指数平滑),窗口失焦不跳变
// ---------------------------------------------------------------------------
function onWheel(e) {
  e.preventDefault();
  const dy = e.deltaY;
  camTarget = THREE.MathUtils.clamp(
    camTarget * Math.exp(dy * CFG.zoomExpK),
    CFG.camMin,
    CFG.camMax
  );
}
window.addEventListener('wheel', onWheel, { passive: false });

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 失焦回来不产生时间跳变
  elapsed += dt;
  frames += 1;
  fps = fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;

  diskRotation += CFG.omega * dt;

  // 相机平滑靠近/远离
  const k = 1 - Math.exp(-dt / CFG.zoomTau);
  camDistance += (camTarget - camDistance) * k;
  if (Math.abs(camTarget - camDistance) < 0.0005) camDistance = camTarget;
  camera.position.copy(camDir).multiplyScalar(camDistance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // 透镜晕始终正对相机
  haloMesh.quaternion.copy(camera.quaternion);

  diskUniforms.uRotation.value = diskRotation;
  diskUniforms.uTime.value = elapsed;
  haloUniforms.uRotation.value = diskRotation;
  haloUniforms.uTime.value = elapsed;

  // 视界圆盘屏幕半径随相机距离变化(占视口高度比例)
  shadowPass.uniforms.uRadius.value =
    (CFG.horizonR * 0.99 / camDistance) /
    (2.0 * Math.tan(THREE.MathUtils.degToRad(CFG.fov) * 0.5));

  updateStream(dt);

  composer.render();

  if (window.__appReady !== true) window.__appReady = true;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// 视口自适应
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  shadowPass.uniforms.uAspect.value = w / h;
  const pr = renderer.getPixelRatio();
  // 点尺寸随像素比更新(仅本场景自建的两处点材质)
  scene.children.forEach((o) => {
    if (o.isPoints && o.material.uniforms && o.material.uniforms.uPixelRatio) {
      o.material.uniforms.uPixelRatio.value = pr;
    }
  });
});
