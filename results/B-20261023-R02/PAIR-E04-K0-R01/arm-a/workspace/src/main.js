// ============================================================================
// E04 — 城市烟花夜(City Fireworks Night)— three.js 0.186.1 (r186) 实现
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,零外部资产,零网络请求):
//   1. 夜空垂直渐变(全屏 quad,着色器三段渐变 + 地平线光污染暖带)
//   2. >=160 颗背景星(Points + 自定义着色器,极轻微正弦闪烁,受 simTime 驱动)
//   3. 程序化城市剪影:26-31 栋楼(合并 BufferGeometry,单 draw call,
//      每栋 8%-45% 画面高、1.5%-6% 画面宽),>=80 个暖色亮窗 quad(顶点色),
//      高楼顶部红色航空障碍灯(慢闪烁,受 simTime 驱动)
//   4. 烟花系统:点击夜空 → 火箭从地面升空(0.68-1.02s,微斜)
//      - 尾迹粒子(暖金,寿命 0.35-0.75s)+ 火箭头亮斑
//      - 爆点 = 点击位置(±5% 画面高):130-219 个爆裂粒子球状扩散,
//        受重力与指数阻力衰减,寿命 1.3-2.6s,尺寸/透明度随寿命衰减
//      - 余烬 22-30 个:40% 长尾(寿命 10.5-12s,慢降)+ 60% 中短(3-8.5s,较快降),
//        暖橙闪烁 + 横向摇摆,保证 P4 采样窗口(点击后 4-12s)center-bottom 有可测运动
//   5. DOM UI(右上角,不进画布):data-ui = auto-show / pause / reset
//   6. 页面契约:window.__appReady / window.__bench = { getState, reset }
//
// 暂停语义:enabled=false 时 dt=0 —— 火箭/粒子/自动发射/星闪/障碍灯全部冻结,
// 仍每帧渲染(输出逐位相同),恢复后从冻结处继续。时间步真实 dt 且 clamp(防失焦跳变)。
// ============================================================================

import * as THREE from 'three';

// ---------- 小工具 -----------------------------------------------------------
const R = Math.random;
const RR = (a, b) => a + (b - a) * Math.random();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
// HSL → rgb 三元组(0-1),避免依赖 THREE.Color 每粒子分配对象
function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  const hp = h * 6;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

// ---------- 渲染基础:像素坐标正交相机(y 向上,原点在左下) -------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
let W = window.innerWidth || 1280;
let H = window.innerHeight || 720;
renderer.setSize(W, H, false);

const camera = new THREE.OrthographicCamera(0, W, H, 0, 0.1, 400);
camera.position.set(0, 0, 200); // 内容统一放在 z=0 平面;深度测试全关,顺序由 renderOrder 决定
const scene = new THREE.Scene();

// ---------- 1. 夜空渐变(全屏 quad) -------------------------------------------
const SKY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */`
  varying vec2 vUv;
  void main() {
    float h = vUv.y; // 0=画面底部, 1=顶部
    vec3 zen = vec3(0.016, 0.019, 0.056);  // 天顶:近黑深蓝黑(非纯黑)
    vec3 mid = vec3(0.048, 0.053, 0.128);  // 中带:深蓝
    vec3 hor = vec3(0.205, 0.135, 0.310);  // 地平线:微亮蓝紫过渡
    vec3 c = mix(mid, zen, smoothstep(0.60, 1.0, h));
    c = mix(hor, c, smoothstep(0.30, 0.58, h));
    // 城市光污染暖带:中心 h≈0.38(天际线上方);向上缓衰、向下陡降(楼体遮挡)
    float band = exp(-max(0.0, 0.38 - h) * 22.0) * exp(-max(0.0, h - 0.38) * 7.0);
    c += vec3(0.135, 0.082, 0.044) * band;
    // 楼群之间/楼后(h 低)强压暗:剪影带均值显著低于地平线亮带
    c *= 1.0 - 0.70 * smoothstep(0.30, 0.04, h);
    gl_FragColor = vec4(c, 1.0);
  }
`;
let skyMesh = null;
function buildSky() {
  if (skyMesh) {
    scene.remove(skyMesh);
    skyMesh.geometry.dispose();
    skyMesh.material.dispose();
  }
  skyMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
    })
  );
  skyMesh.position.set(W / 2, H / 2, 0);
  skyMesh.renderOrder = -100;
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);
}

// ---------- 通用"发光点"着色器(星点/障碍灯共用,带 uTime 闪烁) ---------------
// aMode: 0=星点(微闪), 1=障碍灯(慢速大幅呼吸闪烁)
const GLOW_VERT = /* glsl */`
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aMode;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uTime;
  void main() {
    vColor = aColor;
    float tw = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
    float k = mix(0.82 + 0.18 * tw, pow(tw, 3.0), aMode); // 星点微闪 / 障碍灯慢闪
    vAlpha = aAlpha * k;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;
const GLOW_FRAG = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float fall = pow(1.0 - r2, 1.8);
    float core = pow(1.0 - r2, 6.0);
    gl_FragColor = vec4(vColor * (fall * 1.2 + core * 2.4), vAlpha * pow(fall, 0.5));
  }
`;
function makeGlowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------- 2. 背景星(>=160,静态位置,微闪烁由 uTime 驱动) -------------------
let starPoints = null;
function buildStars() {
  if (starPoints) {
    scene.remove(starPoints);
    starPoints.geometry.dispose();
    starPoints.material.dispose();
  }
  const N = 170;
  const pos = new Float32Array(N * 3);
  const size = new Float32Array(N);
  const alpha = new Float32Array(N);
  const phase = new Float32Array(N);
  const speed = new Float32Array(N);
  const mode = new Float32Array(N);
  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = RR(0, W);
    pos[i * 3 + 1] = RR(H * 0.17, H - 6); // 低至城市带上缘后方(城市画在星点之前会遮挡)
    pos[i * 3 + 2] = 0;
    const big = Math.random() < 0.08;
    size[i] = big ? RR(2.2, 3.0) : RR(0.9, 1.9);
    alpha[i] = big ? RR(0.7, 1.0) : RR(0.32, 0.85);
    phase[i] = RR(0, TAU);
    speed[i] = RR(0.5, 2.2);
    mode[i] = 0;
    const warm = Math.random() < 0.18;
    const c = warm ? hsl(RR(0.08, 0.13), RR(0.25, 0.5), RR(0.75, 0.92))
                   : hsl(RR(0.53, 0.66), RR(0.15, 0.55), RR(0.72, 0.95));
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aMode', new THREE.BufferAttribute(mode, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  starPoints = new THREE.Points(geo, makeGlowMaterial());
  starPoints.renderOrder = -90;
  starPoints.frustumCulled = false;
  scene.add(starPoints);
}

// ---------- 3. 程序化城市(合并单 mesh:楼体 + 亮窗;另建障碍灯 Points) -------
let cityMesh = null;
let beaconPoints = null;
let pulsePoints = null;      // 呼吸窗灯层
let cityBuildingCount = 0;   // 楼数(reset 后保持不变)
let buildingTops = [];       // {x0,x1,top} 供点击命中判定(城市区域不发射)

function buildCityGeometry() {
  const N = cityBuildingCount;
  const posArr = [];
  const colArr = [];
  const idxArr = [];
  let quadBase = 0;
  function quad(x0, y0, x1, y1, c) {
    posArr.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    for (let k = 0; k < 4; k++) colArr.push(c[0], c[1], c[2]);
    idxArr.push(quadBase, quadBase + 1, quadBase + 2, quadBase, quadBase + 2, quadBase + 3);
    quadBase += 4;
  }

  // --- 3.1 楼群布局:N 栋,宽度在 [0.015,0.06]W,间隙 2-12px,铺满画面宽 ---
  const widths = [];
  const gaps = [];
  let wsum = 0, gsum = 0;
  for (let i = 0; i < N; i++) {
    const w = 0.015 + 0.045 * Math.pow(Math.random(), 1.35); // 偏窄,偶有宽楼
    widths.push(w); wsum += w;
    const g = RR(2, 12);
    gaps.push(g); gsum += g;
  }
  const avail = W - 8;
  const raw = widths.map((w) => (w / wsum) * (avail - gsum));
  const minW = 0.015 * W, maxW = 0.06 * W;
  for (let i = 0; i < N; i++) raw[i] = clamp(raw[i], minW, maxW);
  let total = raw.reduce((a, b) => a + b, 0) + gsum;
  if (total > avail) {
    const f = avail / total;
    for (let i = 0; i < N; i++) { raw[i] = Math.max(12, raw[i] * f); gaps[i] = Math.max(1.5, gaps[i] * f); }
  }

  buildingTops = [];
  const beacons = [];
  const litWindowsPositions = []; // 呼吸窗灯候选位置
  let x = 4;
  let litWindows = 0;
  for (let i = 0; i < N; i++) {
    const bw = raw[i];
    let bh = H * (0.08 + 0.37 * Math.pow(Math.random(), 1.7)); // 8%-45%,多数偏矮,少数高楼
    if (Math.random() < 0.16) bh = Math.min(bh * 1.3, 0.45 * H); // 天际线点缀
    const bc = hsl(RR(0.62, 0.75), RR(0.25, 0.4), RR(0.022, 0.042)); // 近黑剪影,与天空可区分
    quad(x, 0, x + bw, bh, bc);
    buildingTops.push({ x0: x, x1: x + bw, top: bh });

    // 障碍灯:高楼上加红色慢闪灯
    if (bh > 0.3 * H) beacons.push([x + bw / 2, bh + 3]);

    // 亮窗:网格单元,概率点亮,暖色为主
    const cellW = 10, cellH = 14;
    const cols = Math.max(1, Math.floor((bw - 4) / cellW));
    const rows = Math.max(1, Math.floor((bh - 8) / cellH));
    const litP = RR(0.11, 0.21);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (Math.random() < litP) {
          const wx0 = x + 3 + c * cellW + RR(0.5, 1.6);
          const wy0 = 7 + r * cellH + RR(0.5, 1.6);
          const wwid = RR(4, 5.6), whei = RR(4.6, 6.4);
          let wc;
          if (Math.random() < 0.15) wc = hsl(RR(0.55, 0.62), RR(0.2, 0.4), RR(0.55, 0.66)); // 少量冷白窗
          else wc = hsl(RR(0.065, 0.125), RR(0.55, 0.92), RR(0.45, 0.6)); // 暖黄/暖橙(克制亮度,压低剪影带均值)
          quad(wx0, wy0, wx0 + wwid, wy0 + whei, wc);
          litWindows++;
          litWindowsPositions.push([wx0 + wwid / 2, wy0 + whei / 2]);
        }
      }
    }
    x += bw + gaps[i];
  }
  // 保底:亮窗 >= 100(规格 >=80,留余量)
  let guard = 0;
  while (litWindows < 100 && guard++ < 400) {
    const b = buildingTops[Math.floor(R() * buildingTops.length)];
    const wx0 = b.x0 + RR(3, Math.max(4, b.x1 - b.x0 - 8));
    const wy0 = RR(8, Math.max(10, top - 12));
    const wc = hsl(RR(0.065, 0.125), RR(0.6, 0.9), RR(0.45, 0.58));
    quad(wx0, wy0, wx0 + RR(4, 5.4), wy0 + RR(4.6, 6.2), wc);
    litWindows++;
  }
  // 障碍灯保底:至少 2 个(取最高两栋)
  if (beacons.length < 2) {
    const sorted = [...buildingTops].sort((a, b) => b.top - a.top);
    for (let i = 0; i < Math.min(2, sorted.length); i++) beacons.push([(sorted[i].x0 + sorted[i].x1) / 2, sorted[i].top + 3]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr), 3));
  geo.setIndex(idxArr);
  return { geo, beacons, litWindowsPositions };
}

function regenerateCity() {
  if (!cityBuildingCount) cityBuildingCount = 26 + Math.floor(R() * 6); // 26-31,reset 后不变
  const { geo, beacons, litWindowsPositions } = buildCityGeometry();
  if (cityMesh) {
    scene.remove(cityMesh);
    cityMesh.geometry.dispose();
    cityMesh.material.dispose();
  }
  cityMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }));
  cityMesh.renderOrder = -50;
  cityMesh.frustumCulled = false;
  scene.add(cityMesh);

  if (beaconPoints) {
    scene.remove(beaconPoints);
    beaconPoints.geometry.dispose();
    beaconPoints.material.dispose();
  }
  const n = beacons.length;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const alpha = new Float32Array(n);
  const phase = new Float32Array(n);
  const speed = new Float32Array(n);
  const mode = new Float32Array(n);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = beacons[i][0]; pos[i * 3 + 1] = beacons[i][1]; pos[i * 3 + 2] = 0;
    size[i] = RR(3.2, 4.4);
    alpha[i] = RR(0.8, 0.95);
    phase[i] = RR(0, TAU);
    speed[i] = TAU / RR(1.8, 2.8); // 慢闪:周期 1.8-2.8s
    mode[i] = 1;
    const c = hsl(RR(0.985, 1.015), RR(0.85, 1.0), RR(0.5, 0.58));
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  bgeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  bgeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  bgeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  bgeo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  bgeo.setAttribute('aMode', new THREE.BufferAttribute(mode, 1));
  bgeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  beaconPoints = new THREE.Points(bgeo, makeGlowMaterial());
  beaconPoints.renderOrder = -40;
  beaconPoints.frustumCulled = false;
  scene.add(beaconPoints);

  // 呼吸窗灯层:随机挑 16 个已亮窗位置做缓慢明暗呼吸(受 simTime 驱动,暂停即冻结)
  if (pulsePoints) {
    scene.remove(pulsePoints);
    pulsePoints.geometry.dispose();
    pulsePoints.material.dispose();
  }
  const pn = Math.min(22, litWindowsPositions.length);
  const ppos = new Float32Array(pn * 3);
  const psize = new Float32Array(pn);
  const palpha = new Float32Array(pn);
  const pphase = new Float32Array(pn);
  const pspeed = new Float32Array(pn);
  const pmode = new Float32Array(pn);
  const pcol = new Float32Array(pn * 3);
  for (let i = 0; i < pn; i++) {
    const wpos = litWindowsPositions[Math.floor(R() * litWindowsPositions.length)];
    ppos[i * 3] = wpos[0]; ppos[i * 3 + 1] = wpos[1]; ppos[i * 3 + 2] = 0;
    psize[i] = RR(3.4, 4.8);
    palpha[i] = RR(0.45, 0.85);
    pphase[i] = RR(0, TAU);
    pspeed[i] = RR(0.5, 1.6); // 慢呼吸(可感知但不抢戏)
    pmode[i] = 0;
    const c = hsl(RR(0.07, 0.115), RR(0.65, 0.9), RR(0.5, 0.62));
    pcol[i * 3] = c[0]; pcol[i * 3 + 1] = c[1]; pcol[i * 3 + 2] = c[2];
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
  pgeo.setAttribute('aSize', new THREE.BufferAttribute(psize, 1));
  pgeo.setAttribute('aAlpha', new THREE.BufferAttribute(palpha, 1));
  pgeo.setAttribute('aPhase', new THREE.BufferAttribute(pphase, 1));
  pgeo.setAttribute('aSpeed', new THREE.BufferAttribute(pspeed, 1));
  pgeo.setAttribute('aMode', new THREE.BufferAttribute(pmode, 1));
  pgeo.setAttribute('aColor', new THREE.BufferAttribute(pcol, 3));
  pulsePoints = new THREE.Points(pgeo, makeGlowMaterial());
  pulsePoints.renderOrder = -35;
  pulsePoints.frustumCulled = false;
  scene.add(pulsePoints);
}

// ---------- 4. 烟花粒子系统(单 Points + 固定池,属性每帧更新) ---------------
const MAXP = 4096;
const PART_VERT = /* glsl */`
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;
const PART_FRAG = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float fall = pow(1.0 - r2, 1.8);   // 柔和光晕
    float core = pow(1.0 - r2, 6.0);   // 热核
    // alpha 用 fall^0.5 而非 fall:避免双重衰减把光晕边缘压得过暗
    gl_FragColor = vec4(vColor * (fall * 1.5 + core * 3.0), vAlpha * pow(fall, 0.5));
  }
`;

const pPos = new Float32Array(MAXP * 3);
const pCol = new Float32Array(MAXP * 3);
const pSize = new Float32Array(MAXP);
const pAlpha = new Float32Array(MAXP);
const pVX = new Float32Array(MAXP);
const pVY = new Float32Array(MAXP);
const pLife = new Float32Array(MAXP);
const pMaxLife = new Float32Array(MAXP);
const pAge = new Float32Array(MAXP);
const pSize0 = new Float32Array(MAXP);
const pGrav = new Float32Array(MAXP);
const pDrag = new Float32Array(MAXP);
const pFlickAmp = new Float32Array(MAXP);
const pFlickFreq = new Float32Array(MAXP);
const pFlickPhase = new Float32Array(MAXP);
const pSwayAmp = new Float32Array(MAXP);
const pSwayFreq = new Float32Array(MAXP);
const pSwayPhase = new Float32Array(MAXP);
const pEmitT = new Float32Array(MAXP); // 余烬微火花发射计时
const pAlive = new Uint8Array(MAXP);
const pKind = new Uint8Array(MAXP); // 0=尾迹 1=爆裂 2=余烬 3=闪光
let aliveCount = 0;
let freeList = [];
function refillFree() {
  freeList = [];
  for (let i = MAXP - 1; i >= 0; i--) freeList.push(i);
}
refillFree();

const partGeo = new THREE.BufferGeometry();
partGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
partGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
partGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
partGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1));
const partMat = new THREE.ShaderMaterial({
  uniforms: { uPixelRatio: { value: renderer.getPixelRatio() } },
  vertexShader: PART_VERT,
  fragmentShader: PART_FRAG,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
});
const partPoints = new THREE.Points(partGeo, partMat);
partPoints.renderOrder = 10;
partPoints.frustumCulled = false;
scene.add(partPoints);

let colorDirty = false;

function spawn(kind, x, y, vx, vy, life, size, grav, drag, col, flickAmp, flickFreq, swayAmp, swayFreq) {
  if (freeList.length === 0) return; // 池满:丢弃(容量远超需求,不会触发的保险)
  const i = freeList.pop();
  pAlive[i] = 1; aliveCount++;
  pKind[i] = kind;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = 0;
  pVX[i] = vx; pVY[i] = vy;
  pAge[i] = 0; pLife[i] = life; pMaxLife[i] = life;
  pSize0[i] = size; pSize[i] = size; pAlpha[i] = 1;
  pGrav[i] = grav; pDrag[i] = drag;
  pFlickAmp[i] = flickAmp || 0;
  pFlickFreq[i] = flickFreq || 0;
  pFlickPhase[i] = RR(0, TAU);
  pSwayAmp[i] = swayAmp || 0;
  pSwayFreq[i] = swayFreq || 0;
  pSwayPhase[i] = RR(0, TAU);
  pEmitT[i] = RR(0.4, 2.2);
  pCol[i * 3] = col[0]; pCol[i * 3 + 1] = col[1]; pCol[i * 3 + 2] = col[2];
  colorDirty = true;
}

function killParticle(i) {
  pAlive[i] = 0; aliveCount--;
  pPos[i * 3 + 1] = -9999; // 移出画面,保证不栅格化
  pAlpha[i] = 0; pSize[i] = 0;
  freeList.push(i);
}

function updateParticles(dt) {
  if (dt <= 0) return; // 暂停:状态完全不变(渲染输出逐位相同)
  for (let i = 0; i < MAXP; i++) {
    if (!pAlive[i]) continue;
    pAge[i] += dt;
    pLife[i] -= dt;
    const x = pPos[i * 3], y = pPos[i * 3 + 1];
    if (pLife[i] <= 0 || y < -40 || y > H + 120 || x < -100 || x > W + 100) {
      killParticle(i);
      continue;
    }
    const dragF = Math.exp(-pDrag[i] * dt);
    let vx = pVX[i] * dragF;
    let vy = pVY[i] * dragF - pGrav[i] * dt;
    if (pSwayAmp[i] > 0) {
      vx += Math.cos(pAge[i] * pSwayFreq[i] + pSwayPhase[i]) * pSwayAmp[i] * dt;
    }
    pVX[i] = vx; pVY[i] = vy;
    pPos[i * 3] = x + vx * dt;
    pPos[i * 3 + 1] = y + vy * dt;

    const t = pAge[i] / pMaxLife[i]; // 0→1
    let a, s;
    const flick = pFlickAmp[i] > 0
      ? 1 - pFlickAmp[i] * 0.5 * (1 - Math.sin(pAge[i] * pFlickFreq[i] + pFlickPhase[i]))
      : 1;
    if (pKind[i] === 0) { // 尾迹
      a = Math.pow(1 - t, 1.2);
      s = pSize0[i] * (0.45 + 0.55 * (1 - t));
    } else if (pKind[i] === 1) { // 爆裂
      const fade = Math.pow(1 - t, 0.85);
      a = Math.min(1, 1.15 * fade * flick);
      s = pSize0[i] * (0.5 + 0.5 * (1 - t));
    } else if (pKind[i] === 2) { // 余烬
      a = Math.min(1, (1.0 - 0.5 * t) * flick);
      s = pSize0[i] * (0.85 + 0.15 * (1 - t));
      // 余烬着陆:接近画面底部即驻留闪烁(保证长尾寿命内可见、有可测运动)
      if (pPos[i * 3 + 1] < 30) {
        pPos[i * 3 + 1] = 30;
        pVY[i] = 0;
        pVX[i] = vx * 0.4;
      }
      // 余烬偶发微火花(着陆后发得更勤,增加长尾期可测运动)
      pEmitT[i] -= dt;
      if (pEmitT[i] <= 0) {
        const landed = pPos[i * 3 + 1] <= 30.5;
        pEmitT[i] = landed ? RR(0.6, 1.4) : RR(1.2, 2.4);
        const sc = hsl(RR(0.06, 0.1), 0.85, RR(0.55, 0.66));
        spawn(0, pPos[i * 3], pPos[i * 3 + 1], vx * 0.4 + RR(-9, 9), vy * 0.3 - RR(2, 14),
          RR(0.4, 0.8), RR(2.6, 3.6), 30, 2.0, sc, 0, 0, 0, 0);
      }
    } else { // 闪光
      a = Math.pow(1 - t, 2.0);
      s = pSize0[i] * (1 + 2.2 * t);
    }
    pAlpha[i] = a;
    pSize[i] = s;
  }
}

// ---------- 5. 火箭(发射 → 升空尾迹 → 爆炸) --------------------------------
const rockets = []; // {x,y,vx,vy,ty,T,t,acc,hue}
let fireworkCount = 0;

const HUE_PALETTE = [
  [0.075, 0.115], // 金
  [0.86, 0.94],   // 洋红
  [0.485, 0.545], // 青
  [0.30, 0.37],   // 绿
  [0.71, 0.78],   // 紫
  [0.015, 0.05],  // 橙红
  [0.555, 0.60],  // 湛蓝
];
function pickHue() {
  const r = HUE_PALETTE[Math.floor(R() * HUE_PALETTE.length)];
  return RR(r[0], r[1]);
}

function launchFirework(tx, ty) {
  const sx = clamp(tx + RR(-16, 16), 10, W - 10);
  const sy = RR(10, 46); // 城市地面附近
  const T = RR(0.68, 1.02); // 升空 0.6-1.6s 区间取短段,保证探针时序(爆于点击后 <=1.1s)
  rockets.push({
    x: sx, y: sy,
    vx: (tx - sx) / T, vy: (ty - sy) / T,
    ty, T, t: 0, acc: 0, hue: pickHue(),
  });
  fireworkCount++;
  // 地面发射微光反馈
  spawn(3, sx, sy + 4, RR(-4, 4), RR(8, 18), 0.22, RR(9, 13), 20, 2.0, [1.0, 0.82, 0.5], 0, 0, 0, 0);
}

function explode(x, y, hue) {
  // 中心闪光(峰值光团)
  spawn(3, x, y, 0, 0, 0.25, RR(40, 56), 0, 0, [1.0, 0.97, 0.9], 0, 0, 0, 0);
  // 球状爆裂粒子:160-229 个(规格 100-240)
  const n = 160 + Math.floor(R() * 70);
  const v0 = RR(115, 172);
  for (let i = 0; i < n; i++) {
    const th = RR(0, TAU);
    const shell = Math.random() < 0.88;
    const sp = shell ? v0 * (0.82 + 0.18 * R()) : v0 * R() * 0.75;
    const vx = Math.cos(th) * sp;
    const vy = Math.sin(th) * sp;
    const life = RR(1.3, 2.6); // 规格 1.2-2.8
    const size = RR(5.0, 8.0);
    let col;
    if (Math.random() < 0.15) col = hsl(hue, 0.22, 0.9); // 白热芯
    else col = hsl(hue + RR(-0.035, 0.035), RR(0.9, 1.0), RR(0.62, 0.72)); // 同色系微抖
    spawn(1, x + vx * 0.012, y + vy * 0.012, vx, vy, life, size,
      RR(58, 78), RR(1.35, 1.65), col, RR(0, 0.18), RR(3, 7), 0, 0);
  }
  // 余烬:24-27 个(规格 >=12);35% 长尾 10.5-12s 慢降,其余 3-8.5s 分层较快降
  const m = 24 + Math.floor(R() * 4);
  for (let i = 0; i < m; i++) {
    const roll = Math.random();
    let life, grav, drag;
    if (roll < 0.35) { life = RR(10.5, 12); grav = RR(70, 88); drag = RR(1.3, 1.42); } // 长尾慢降(终端 ~52-66)
    else if (roll < 0.75) { life = RR(5.5, 8.5); grav = RR(95, 120); drag = RR(1.35, 1.5); } // 中层
    else { life = RR(3, 5.5); grav = RR(95, 120); drag = RR(1.35, 1.5); } // 短命
    const th = RR(0, TAU);
    const sp = RR(6, 26);
    const col = hsl(RR(0.045, 0.09), 0.95, RR(0.62, 0.72)); // 暖橙
    spawn(2, x, y, Math.cos(th) * sp, Math.sin(th) * sp + RR(0, 10), life,
      RR(7.6, 10.2), grav, drag, col, RR(0.75, 0.88), RR(5, 10), RR(16, 30), RR(0.8, 2.2));
  }
}

function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.t += dt;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    // 尾迹粒子:约 140/s,暖金,寿命 0.4-0.78s(规格 0.3-0.8)
    r.acc += dt;
    const step = 1 / 140;
    while (r.acc >= step) {
      r.acc -= step;
      const gold = Math.random() < 0.75;
      const col = gold ? hsl(RR(0.09, 0.13), RR(0.7, 0.95), RR(0.72, 0.88))
                       : [1.0, 0.96, 0.88];
      spawn(0, r.x + RR(-1.6, 1.6), r.y + RR(-1.6, 1.6),
        r.vx * 0.06 + RR(-14, 14), r.vy * 0.05 + RR(-14, 10),
        RR(0.4, 0.78), RR(2.8, 4.0), 30, 2.2, col, 0, 0, 0, 0);
    }
    // 火箭头亮斑(强运动证据)
    spawn(3, r.x, r.y, 0, 0, 0.07, RR(8, 12), 0, 0, [1.0, 0.95, 0.8], 0, 0, 0, 0);
    if (r.y >= r.ty || r.t >= r.T + 0.05) {
      explode(r.x, Math.min(r.y, r.ty + 8), r.hue);
      rockets.splice(i, 1);
    }
  }
}

// ---------- 6. 状态 / UI / __bench 契约 ---------------------------------------
let autoShow = false;
let enabled = true;
let simTime = 0;
let autoTimer = 0;

function updateBtnLabels() {
  if (btnAuto) btnAuto.textContent = '自动表演:' + (autoShow ? '开' : '关');
  if (btnPause) btnPause.textContent = enabled ? '暂停' : '恢复(已暂停)';
}

let btnAuto = null, btnPause = null, btnResetBtn = null;
function buildUI() {
  const mk = (dataUi, top) => {
    const b = document.createElement('button');
    b.setAttribute('data-ui', dataUi);
    b.style.cssText =
      'position:fixed;display:block;right:14px;top:' + top + 'px;z-index:9999;' +
      'min-width:118px;padding:7px 14px;text-align:center;cursor:pointer;' +
      "font:13px/1.2 system-ui,'Segoe UI',sans-serif;color:#ffe9c8;" +
      'background:rgba(10,12,24,0.74);border:1px solid rgba(255,225,180,0.35);' +
      'border-radius:6px;user-select:none;-webkit-user-select:none;';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dataUi === 'auto-show') setAuto(!autoShow);
      else if (dataUi === 'pause') { enabled = !enabled; updateBtnLabels(); }
      else if (dataUi === 'reset') doReset();
    });
    document.body.appendChild(b);
    return b;
  };
  btnAuto = mk('auto-show', 12);
  btnPause = mk('pause', 56);
  btnResetBtn = mk('reset', 100);
  updateBtnLabels();
}

function setAuto(on) {
  autoShow = on;
  autoTimer = on ? RR(0.2, 0.4) : 0; // 开启后首发很快(0.2-0.4s),后续 0.55-1.15s 随机(在 0.5-1.5 区间内)
  updateBtnLabels();
}

function updateAuto(dt) {
  if (!autoShow) return;
  autoTimer -= dt;
  if (autoTimer <= 0) {
    const tx = RR(0.08, 0.92) * W;
    const ty = (1 - RR(0.2, 0.55)) * H; // 爆点集中上半屏(高度 20%-55%)
    launchFirework(tx, ty);
    autoTimer = RR(0.55, 1.15);
  }
}

function doReset() {
  for (let i = 0; i < MAXP; i++) if (pAlive[i]) killParticle(i);
  aliveCount = 0;
  refillFree();
  colorDirty = true;
  rockets.length = 0;
  fireworkCount = 0;
  autoShow = false;
  enabled = true;
  autoTimer = 0;
  regenerateCity(); // 城市重新随机生成,楼数不变
  updateBtnLabels();
}

window.__bench = {
  getState: () => ({
    fireworkCount,
    particlesAlive: aliveCount,
    autoShow,
    enabled,
    buildingCount: cityBuildingCount,
    engine: 'three',
    ready: true,
  }),
  reset: doReset,
};

// ---------- 7. 点击发射(仅画布;城市区域与 UI 不触发) -----------------------
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width;
  const ny = (e.clientY - rect.top) / rect.height; // 归一化,左上原点
  const wx = nx * W;
  const wy = (1 - ny) * H;
  // 城市区域不发射:命中任一楼体(点击低于该楼顶)即忽略
  for (let i = 0; i < buildingTops.length; i++) {
    const b = buildingTops[i];
    if (wx >= b.x0 && wx <= b.x1 && wy <= b.top + 6) return;
  }
  launchFirework(clamp(wx, 12, W - 12), clamp(wy, H * 0.12, H - 24));
});

// ---------- 8. 初始化静态场景 -------------------------------------------------
buildSky();
buildStars();
regenerateCity();
buildUI();

// ---------- 9. 主循环(真实时间步 + clamp;暂停 dt=0 全冻结) ------------------
let lastT = performance.now();
let readySet = false;
function frame(now) {
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.05) dt = 0.05; // 失焦回归/卡顿:限幅防粒子瞬移
  if (dt < 0) dt = 0;
  if (!enabled) dt = 0; // 全局暂停:时间线冻结(渲染继续,输出逐帧相同)
  simTime += dt;
  if (dt > 0) {
    updateAuto(dt);
    updateRockets(dt);
    updateParticles(dt);
  }
  if (starPoints) starPoints.material.uniforms.uTime.value = simTime;
  if (beaconPoints) beaconPoints.material.uniforms.uTime.value = simTime;
  if (pulsePoints) pulsePoints.material.uniforms.uTime.value = simTime;

  partGeo.attributes.position.needsUpdate = true;
  partGeo.attributes.aSize.needsUpdate = true;
  partGeo.attributes.aAlpha.needsUpdate = true;
  if (colorDirty) {
    partGeo.attributes.aColor.needsUpdate = true;
    colorDirty = false;
  }
  renderer.render(scene, camera);
  if (!readySet) {
    readySet = true;
    window.__appReady = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- 10. 视口自适应 -----------------------------------------------------
window.addEventListener('resize', () => {
  W = window.innerWidth || W;
  H = window.innerHeight || H;
  renderer.setSize(W, H, false);
  camera.right = W;
  camera.top = H;
  camera.updateProjectionMatrix();
  buildSky();
  buildStars();
  regenerateCity(); // 楼数不变,按新尺寸重新随机
});
