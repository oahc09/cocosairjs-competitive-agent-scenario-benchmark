// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk) — three.js r186
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无外部资产):
//   1. 深空背景:BackSide 大球上的极暗星云渐变 + 1500 颗静态星点(软圆点,加色混合)
//   2. 事件视界:纯黑球体(任意角度呈锐利黑盘,写深度,正确遮挡盘远侧)
//   3. 吸积盘:XZ 平面 RingGeometry[1.8, 6.5] + 自定义 ShaderMaterial:
//      径向颜色梯度(内白→黄橙→暗红)、随时间连续旋转的螺旋明暗条纹
//      (uRot = diskRotation,角速度 0.35 rad/s)、多普勒不对称(切向速度朝向相机侧增亮)
//   4. 辉光替代(无后处理):相机朝向 billboard 组 = 光子环(亮白细环)
//      + 紧凑暖光辉 + 宽域柔光辉,全部加色混合、中心留孔保持暗核纯黑
//   5. 引力透镜观感(加分):面向相机的光环面片,上下弧包绕核心
//   6. 星流:260 粒子,开普勒角速度 ω∝r^-1.5 螺旋坠入,接近视界加速、
//      拖尾(速度×固定时间回溯线段)拉长,r<1.24 消失并于外圈重生,总数恒定
//   7. 相机:球坐标绕原点,滚轮指数缩放(平滑插值,clamp [5,28]),拖拽微调
//
// 页面契约:window.__appReady(首帧后置 true)、
//           window.__bench = { getState(): 真实状态, reset(): 复位 }。
// ============================================================================

import * as THREE from 'three';

// --- 常量(spec 冻结尺度) -----------------------------------------------------
const HORIZON_R = 1.2;          // 事件视界半径
const DISK_IN = 1.8;            // 吸积盘内缘
const DISK_OUT = 6.5;           // 吸积盘外缘
const DISK_OMEGA = 0.35;        // 盘旋转角速度 rad/s(0.15–0.6)
const STREAM_N = 260;           // 星流粒子数(>=200,恒定)
const BG_STAR_N = 3000;         // 背景星数(>=300,恒定)
const INIT_DIST = 14.0;         // 初始相机距离
const MIN_DIST = 5, MAX_DIST = 28;
const INIT_ELEV = THREE.MathUtils.degToRad(28);   // 俯视角(15°–75°)
const TRAIL_T = 0.16;           // 星流拖尾回溯时长(s)

const f2 = (x) => x.toFixed(2);

// --- 渲染器 / 场景 / 相机 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const FOV = 45;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 500);

// 点精灵像素换算:gl_PointSize = 世界尺寸 × uPx / 视深
function pxScale() {
  const h = window.innerHeight * renderer.getPixelRatio();
  return (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
}

// ============================================================================
// 1) 深空星云背景(极暗冷色渐变,保证四角外围非纯黑)
// ============================================================================
{
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float band = exp(-pow(dot(d, normalize(vec3(0.2, 1.0, 0.35))), 2.0) * 14.0);
        float n = 0.5 + 0.25 * sin(d.x * 7.0 + 1.3) + 0.25 * sin(d.y * 9.0 - 2.0) + 0.25 * sin(d.z * 6.0 + 4.0);
        n = clamp(n, 0.0, 1.0);
        vec3 col = vec3(0.030, 0.040, 0.082)
                 + band * vec3(0.030, 0.044, 0.090) * (0.4 + 0.6 * n)
                 + n * n * vec3(0.012, 0.009, 0.024);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const nebula = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), mat);
  nebula.renderOrder = -2;
  scene.add(nebula);
}

// ============================================================================
// 2) 背景星空:1500 颗静态星点(大小/亮度/色温有差异)
// ============================================================================
{
  const pos = new Float32Array(BG_STAR_N * 3);
  const col = new Float32Array(BG_STAR_N * 3);
  const size = new Float32Array(BG_STAR_N);
  for (let i = 0; i < BG_STAR_N; i++) {
    const u = Math.random() * 2 - 1;
    const ph = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const R = 120 + Math.random() * 50;
    pos[i * 3] = R * s * Math.cos(ph);
    pos[i * 3 + 1] = R * u;
    pos[i * 3 + 2] = R * s * Math.sin(ph);
    const k = Math.random();
    const c = k < 0.6 ? [1, 1, 1] : k < 0.8 ? [0.75, 0.85, 1.0] : [1.0, 0.85, 0.7];
    const b = 0.6 + Math.random() * 0.4;
    col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
    size[i] = Math.random() < 0.15 ? 3.2 + Math.random() * 1.8 : 1.5 + Math.random() * 1.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uDpr: { value: DPR } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize;
      varying vec3 vC; uniform float uDpr;
      void main() {
        vC = aColor;
        gl_PointSize = aSize * uDpr;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.15, d);
        a *= a;
        gl_FragColor = vec4(vC * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(g, m);
  stars.renderOrder = -1;
  scene.add(stars);
}

// ============================================================================
// 3) 事件视界:纯黑球(写深度 → 正确遮挡盘远侧/星流远侧)
// ============================================================================
{
  const hole = new THREE.Mesh(
    new THREE.SphereGeometry(HORIZON_R, 64, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  scene.add(hole);
}

// ============================================================================
// 4) 吸积盘(自定义着色:径向梯度 + 旋转条纹 + 多普勒不对称)
// ============================================================================
const diskUniforms = { uRot: { value: 0 } };
{
  const geo = new THREE.RingGeometry(DISK_IN, DISK_OUT, 220, 1);
  geo.rotateX(-Math.PI / 2); // XY → XZ 平面
  const mat = new THREE.ShaderMaterial({
    uniforms: diskUniforms,
    vertexShader: `
      varying vec3 vWorld; varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vWorld; varying vec3 vLocal;
      uniform float uRot;
      void main() {
        float r = length(vLocal.xz);
        float t = clamp((r - ${f2(DISK_IN)}) / ${f2(DISK_OUT - DISK_IN)}, 0.0, 1.0);
        float theta = atan(vLocal.z, vLocal.x);
        // 径向颜色梯度:内缘白 → 暖白黄 → 橙 → 橙红 → 暗红
        vec3 c0 = vec3(1.00, 0.99, 0.94);
        vec3 c1 = vec3(1.00, 0.88, 0.58);
        vec3 c2 = vec3(1.00, 0.60, 0.18);
        vec3 c3 = vec3(0.95, 0.36, 0.07);
        vec3 c4 = vec3(0.55, 0.12, 0.02);
        vec3 c5 = vec3(0.20, 0.025, 0.008);
        vec3 col = mix(c0, c1, smoothstep(0.0, 0.10, t));
        col = mix(col, c2, smoothstep(0.08, 0.24, t));
        col = mix(col, c3, smoothstep(0.22, 0.42, t));
        col = mix(col, c4, smoothstep(0.40, 0.70, t));
        col = mix(col, c5, smoothstep(0.68, 1.0, t));
        // 亮度包络:内缘炽热,向外单调衰减(无硬边)
        float env = 1.22 * pow(1.9 / max(r, 0.6), 2.95);
        env *= smoothstep(${f2(DISK_IN - 0.03)}, ${f2(DISK_IN + 0.07)}, r);
        env *= 1.0 - smoothstep(${f2(DISK_OUT - 0.9)}, ${f2(DISK_OUT)}, r);
        // 旋转条纹:双频螺旋(高对比明暗相间),整体随 uRot 连续转动
        float sp = sin((theta - uRot) * 5.0 + r * 1.9);
        float sp2 = sin((theta - uRot) * 7.0 - r * 2.3 + 1.7);
        float stripe = clamp(0.50 + 0.34 * sp + 0.24 * sp2, 0.04, 1.15);
        // 多普勒不对称:切向速度朝向相机的一侧增亮
        vec3 tangent = normalize(vec3(-vLocal.z, 0.0, vLocal.x));
        vec3 toCam = normalize(cameraPosition - vWorld);
        float dop = clamp(1.0 + 0.62 * dot(tangent, toCam), 0.22, 1.85);
        gl_FragColor = vec4(col * env * stripe * dop, 1.0);
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const disk = new THREE.Mesh(geo, mat);
  disk.renderOrder = 2;
  scene.add(disk);
}

// ============================================================================
// 5) 相机朝向 billboard 组:光子环 + 双层辉光 + 引力透镜弧(辉光替代后处理)
// ============================================================================
const facing = new THREE.Group();
scene.add(facing);

// 径向渐变贴图(运行时 canvas 生成,非外部资产)
function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, cs] of stops) grad.addColorStop(o, cs);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function glowPlane(halfSize, stops) {
  const tex = radialTexture(stops);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(halfSize * 2, halfSize * 2),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  );
  return m;
}
// 宽域柔光(中心留孔 → 暗核保持纯黑;峰在视界外缘,向外平滑衰减)
{
  const g = glowPlane(4.6, [
    [0.00, 'rgba(0,0,0,0)'],
    [0.27, 'rgba(0,0,0,0)'],
    [0.31, 'rgba(255,190,120,0.30)'],
    [0.44, 'rgba(255,140,60,0.11)'],
    [0.68, 'rgba(255,90,40,0.032)'],
    [1.00, 'rgba(0,0,0,0)'],
  ]);
  g.renderOrder = 8;
  facing.add(g);
}
// 紧凑亮辉(贴着视界的白热光晕)
{
  const g = glowPlane(2.2, [
    [0.00, 'rgba(0,0,0,0)'],
    [0.55, 'rgba(0,0,0,0)'],
    [0.60, 'rgba(255,225,185,0.55)'],
    [0.74, 'rgba(255,175,95,0.18)'],
    [1.00, 'rgba(0,0,0,0)'],
  ]);
  g.renderOrder = 7;
  facing.add(g);
}
// 光子环:贴视界的锐利亮环(白蓝热)+ 轻微多普勒增亮
{
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float core = exp(-pow((r - 1.32) / 0.13, 2.0));
        float halo = 0.45 * exp(-pow((r - 1.32) / 0.28, 2.0));
        float dop = 1.0 + 0.35 * (vP.x / max(r, 0.001));
        vec3 col = mix(vec3(1.0, 0.93, 0.80), vec3(0.75, 0.85, 1.0), 0.35);
        float I = (core + halo) * 1.75 * dop;
        gl_FragColor = vec4(col * I, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.21, 1.75, 128, 1), mat);
  ring.renderOrder = 6;
  facing.add(ring);
}
// 引力透镜观感(加分):上下弧包绕核心的透镜光环
{
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float a = atan(vP.y, vP.x);
        float vert = abs(sin(a));
        float mask = smoothstep(0.25, 0.55, vert);           // 避开盘面所在的水平侧
        float side = a > 0.0 ? 1.0 : 0.45;                    // 上弧强、下弧弱
        float t = clamp((r - 1.35) / 1.65, 0.0, 1.0);
        vec3 col = mix(vec3(1.0, 0.90, 0.72), vec3(1.0, 0.52, 0.14), smoothstep(0.0, 0.45, t));
        col = mix(col, vec3(0.42, 0.09, 0.02), smoothstep(0.45, 1.0, t));
        float env = 1.2 * pow(1.45 / max(r, 0.6), 2.2);
        env *= smoothstep(1.30, 1.38, r) * (1.0 - smoothstep(2.6, 3.0, r));
        float dop = 1.0 + 0.5 * (vP.x / max(r, 0.001));
        float I = env * mask * side * dop * 0.40;
        gl_FragColor = vec4(col * I, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const arc = new THREE.Mesh(new THREE.RingGeometry(1.30, 3.0, 96, 1), mat);
  arc.renderOrder = 9;
  facing.add(arc);
}

// ============================================================================
// 6) 星流:螺旋坠入 + 视界吞噬 + 外圈重生(总数恒定)
// ============================================================================
const pR = new Float32Array(STREAM_N);
const pTh = new Float32Array(STREAM_N);
const pSf = new Float32Array(STREAM_N);

function respawn(i, initial) {
  if (initial) {
    // 面积近似均匀的初始半径分布
    const u = Math.random();
    pR[i] = Math.sqrt(1.32 * 1.32 + u * (7.0 * 7.0 - 1.32 * 1.32));
  } else {
    pR[i] = 5.6 + Math.random() * 1.4; // 外圈重生
  }
  pTh[i] = Math.random() * Math.PI * 2;
  pSf[i] = 0.55 + Math.random() * 0.9;
}
for (let i = 0; i < STREAM_N; i++) respawn(i, true);

// 星流头部(Points)
const headPos = new Float32Array(STREAM_N * 3);
const headCol = new Float32Array(STREAM_N * 3);
const headSize = new Float32Array(STREAM_N);
for (let i = 0; i < STREAM_N; i++) headSize[i] = 0.07 + Math.random() * 0.04;
const headGeom = new THREE.BufferGeometry();
headGeom.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
headGeom.setAttribute('aColor', new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage));
headGeom.setAttribute('aSize', new THREE.BufferAttribute(headSize, 1));
const headMat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: pxScale() } },
  vertexShader: `
    attribute vec3 aColor; attribute float aSize;
    varying vec3 vC; uniform float uPx;
    void main() {
      vC = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(aSize * uPx / max(-mv.z, 0.1), 1.5, 18.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vC;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float a = smoothstep(1.0, 0.1, d);
      gl_FragColor = vec4(vC * a, 1.0);
    }`,
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
});
const heads = new THREE.Points(headGeom, headMat);
heads.renderOrder = 4;
heads.frustumCulled = false;
scene.add(heads);

// 星流拖尾(LineSegments:头亮尾暗,速度越快拖尾越长)
const trailPos = new Float32Array(STREAM_N * 2 * 3);
const trailCol = new Float32Array(STREAM_N * 2 * 3);
const trailGeom = new THREE.BufferGeometry();
trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
trailGeom.setAttribute('color', new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage));
const trailMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const trails = new THREE.LineSegments(trailGeom, trailMat);
trails.renderOrder = 3;
trails.frustumCulled = false;
scene.add(trails);

function updateStream(dt) {
  for (let i = 0; i < STREAM_N; i++) {
    let r = pR[i];
    const om = 6.2 * Math.pow(r, -1.5) * pSf[i];                       // 开普勒式角速度
    const infall = (0.10 + 0.9 * Math.pow(2.2 / Math.max(r, 1.25), 2.2)) * pSf[i];
    pTh[i] += om * dt;
    r -= infall * dt;
    if (r < 1.24) { respawn(i, false); r = pR[i]; }
    else pR[i] = r;
    const th = pTh[i];
    const c = Math.cos(th), s = Math.sin(th);
    const x = r * c, z = r * s;
    // 速度 = 切向 + 径向;拖尾 = 位置 − 速度×TRAIL_T(近视界自动拉长)
    const vt = om * r, vr = -infall;
    let tx = x - (vr * c - vt * s) * TRAIL_T;
    let tz = z - (vr * s + vt * c) * TRAIL_T;
    const tl = Math.hypot(x - tx, z - tz);
    if (tl > 1.3) { const k = 1.3 / tl; tx = x + (tx - x) * k; tz = z + (tz - z) * k; }
    // 颜色:外橙内白热(整体克制,避免星流喧宾夺主)
    const heat = THREE.MathUtils.clamp((5.0 - r) / 3.6, 0, 1);
    const cr = 1.0, cg = 0.66 + 0.31 * heat, cb = 0.35 + 0.58 * heat;
    const bri = 0.28 + 0.55 * heat;
    const i3 = i * 3, i6 = i * 6;
    headPos[i3] = x; headPos[i3 + 1] = 0; headPos[i3 + 2] = z;
    headCol[i3] = cr * bri; headCol[i3 + 1] = cg * bri; headCol[i3 + 2] = cb * bri;
    trailPos[i6] = x; trailPos[i6 + 1] = 0; trailPos[i6 + 2] = z;
    trailPos[i6 + 3] = tx; trailPos[i6 + 4] = 0; trailPos[i6 + 5] = tz;
    trailCol[i6] = cr * bri * 0.60; trailCol[i6 + 1] = cg * bri * 0.60; trailCol[i6 + 2] = cb * bri * 0.60;
    trailCol[i6 + 3] = cr * bri * 0.04; trailCol[i6 + 4] = cg * bri * 0.04; trailCol[i6 + 5] = cb * bri * 0.04;
  }
  headGeom.attributes.position.needsUpdate = true;
  headGeom.attributes.aColor.needsUpdate = true;
  trailGeom.attributes.position.needsUpdate = true;
  trailGeom.attributes.color.needsUpdate = true;
}

// ============================================================================
// 7) 状态通道 / reset / UI
// ============================================================================
let diskRotation = 0;
let cameraDist = INIT_DIST;
let targetDist = INIT_DIST;
let azimuth = 0;
let elevation = INIT_ELEV;
let frame = 0;

function doReset() {
  diskRotation = 0;
  cameraDist = INIT_DIST;   // reset 直接回到 14.0(±0.5 契约)
  targetDist = INIT_DIST;
  azimuth = 0;
  elevation = INIT_ELEV;
  for (let i = 0; i < STREAM_N; i++) respawn(i, true); // 星流复位重生,背景星不变
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    frame,
    ready: true,
    diskRotation,
    accretionPhase: (diskRotation / (Math.PI * 2)) % 1,
    cameraDistance: cameraDist,
    starStreamCount: STREAM_N,
    backgroundStarCount: BG_STAR_N,
  }),
  reset: doReset,
};

// UI:右上角 reset 按钮(DOM 控件,data-ui="reset")
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:10px;right:12px;z-index:9999;padding:5px 14px;' +
    "font:13px sans-serif;background:rgba(30,30,34,0.85);color:#eee;" +
    'border:1px solid #666;border-radius:4px;cursor:pointer;';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);
}

// ============================================================================
// 8) 交互:滚轮平滑缩放 + 拖拽微调视角
// ============================================================================
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = THREE.MathUtils.clamp(e.deltaY, -2000, 2000);
  targetDist = THREE.MathUtils.clamp(targetDist * Math.exp(dy * 0.00115), MIN_DIST, MAX_DIST);
}, { passive: false });

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  azimuth -= (e.clientX - lastX) * 0.004;
  elevation = THREE.MathUtils.clamp(elevation + (e.clientY - lastY) * 0.003, 0.26, 1.31);
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  headMat.uniforms.uPx.value = pxScale();
});

// ============================================================================
// 9) 主循环(真实时间步进;失焦再聚焦 dt 钳制,无时间跳变)
// ============================================================================
let lastT = performance.now();
function tick() {
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.1) dt = 0.1;

  diskRotation += DISK_OMEGA * dt;
  diskUniforms.uRot.value = diskRotation;

  // 相机平滑插值(1s 内基本到位)
  cameraDist += (targetDist - cameraDist) * (1 - Math.exp(-5.5 * dt));
  if (Math.abs(targetDist - cameraDist) < 0.002) cameraDist = targetDist;

  const ce = Math.cos(elevation), se = Math.sin(elevation);
  camera.position.set(
    cameraDist * ce * Math.sin(azimuth),
    cameraDist * se,
    cameraDist * ce * Math.cos(azimuth)
  );
  camera.lookAt(0, 0, 0);
  facing.quaternion.copy(camera.quaternion);

  updateStream(dt);
  renderer.render(scene, camera);
  frame += 1;
  window.__appReady = true;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
