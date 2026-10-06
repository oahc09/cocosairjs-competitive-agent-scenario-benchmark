// ============================================================================
// E03 — 太阳系仪(Orrery)— three.js r186(Arm B / K0)
// ----------------------------------------------------------------------------
// 页面契约(冻结,harness 断言):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//   UI 控件带 data-ui 属性(探针经 ui#<locator> 定位):speed-0.5x/1x/2x/4x/8x、reset、info-card
//
// 设计要点(为什么这样做):
//   - 一切天体位相由"模拟时钟 simulationTime"纯函数导出(angle = init + ω·simTime),
//     因此 timeScale 只需改变时钟流速即可让全部公转/自转/卫星/小行星带即时平滑变速,
//     reset 只需把时钟归零即可让所有轨道角精确回到 k×45°(连续累计、不取模),
//     且渲染循环从不中断(无整页刷新)。
//   - 公转周期自内向外 240→3900 模拟秒(单调,内 120–240 / 外 1600–4000 区间内),
//     内外角速度比 ≈16x,满足"内侧行星增量 > 4 倍外侧行星"的分层证据。
//   - 小行星带为 900 个独立小天体(THREE.Points 逐粒子轨道参数、逐帧按各自角速度推进,
//     带内速度分层),不是贴图或单一环面网格。
//   - 点击判定用"行星屏幕投影圆域"(每帧用真实投影算 screenX/screenY/screenRadius,
//     半径下限 8.2 CSS 像素保证可点击),点空白处不选中(NC04)。
//   - 信息卡由点击驱动出现/更新,镜像为 __bench.getState().infoCard;reset/点空白关闭。
// ============================================================================

import * as THREE from 'three';

const TAU = Math.PI * 2;

// --- 行星定数(spec §3:半径升序、周期单调、初始角 = k×45°) -------------------
// period = 公转周期(模拟秒);spin = 自转周期(模拟秒,负号反向);moons = 卫星表
const PLANETS = [
  { name: 'mercury', orbitRadius: 24,  period: 240,  radius: 4.2, color: 0x9c8e82, type: '岩质行星',   spin: 58 },
  { name: 'venus',   orbitRadius: 36,  period: 400,  radius: 5.0, color: 0xd9b07c, type: '岩质行星',   spin: -140 },
  { name: 'earth',   orbitRadius: 50,  period: 620,  radius: 5.2, color: 0x3d7dc8, type: '岩质行星',   spin: 24,
    moons: [{ radius: 1.5, dist: 10.5, period: 20, color: 0xcfd2d6 }] },
  { name: 'mars',    orbitRadius: 66,  period: 900,  radius: 4.4, color: 0xb5563c, type: '岩质行星',   spin: 25,
    moons: [{ radius: 1.2, dist: 8.5, period: 12, color: 0xb9a898 }] },
  { name: 'jupiter', orbitRadius: 112, period: 1600, radius: 10,  color: 0xd8b98a, type: '气态巨行星', spin: 10, banded: true,
    moons: [{ radius: 1.6, dist: 15.5, period: 16, color: 0xd8c9a8 }, { radius: 1.3, dist: 20.5, period: 30, color: 0xb8b2a4 }] },
  { name: 'saturn',  orbitRadius: 146, period: 2500, radius: 8.5, color: 0xe0c795, type: '气态巨行星', spin: 11, banded: true,
    ring: { inner: 11.5, outer: 16.8, color: 0xcbb388, opacity: 0.8, tilt: 0.42 } },
  { name: 'uranus',  orbitRadius: 180, period: 3200, radius: 6.2, color: 0x8fd1d8, type: '冰巨行星',   spin: -17,
    ring: { inner: 8.4, outer: 9.8, color: 0xa8c8cc, opacity: 0.35, tilt: 1.15 } },
  { name: 'neptune', orbitRadius: 210, period: 3900, radius: 6.0, color: 0x4f6fd8, type: '冰巨行星',   spin: 16 },
];
PLANETS.forEach((p, k) => { p.initAngle = k * (Math.PI / 4); }); // 第 k 颗初始角 = k×45°

const MOON_COUNT = PLANETS.reduce((n, p) => n + (p.moons ? p.moons.length : 0), 0); // 4
const RINGED_COUNT = PLANETS.filter((p) => p.ring).length;                            // 2

// 小行星带:第 4(mars/66)与第 5(jupiter/112)条轨道之间,900 个独立小天体
const AST_COUNT = 900;
const AST_R_MIN = 80, AST_R_MAX = 97;

// --- 画布与渲染器 --------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02020a); // 深空近黑

// --- 相机:斜俯视(俯角约 38°),使 8 条轨道占画面约 70% 宽 -----------------------
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 2, 8000);
// 球坐标环绕 + 观察目标:目标沿 +z(近侧)偏移,补偿透视下近侧轨道的下坠溢出,
// 使最外轨道椭圆在竖直方向完整入画(水平占画面约 67% 宽)
const camCtl = { azimuth: 0, elevation: 0.66, dist: 380, target: new THREE.Vector3(0, 0, 41) };
function applyCamera() {
  camera.position.set(
    camCtl.target.x + camCtl.dist * Math.cos(camCtl.elevation) * Math.sin(camCtl.azimuth),
    camCtl.target.y + camCtl.dist * Math.sin(camCtl.elevation),
    camCtl.target.z + camCtl.dist * Math.cos(camCtl.elevation) * Math.cos(camCtl.azimuth)
  );
  camera.lookAt(camCtl.target);
}
applyCamera();

// --- 光照:太阳点光源(无衰减)+ 微环境光,保证背光面可辨 ------------------------
scene.add(new THREE.AmbientLight(0x8899bb, 0.35));
const sunLight = new THREE.PointLight(0xfff1d0, 2.4, 0, 0); // decay 0:场景尺度下均匀照明
scene.add(sunLight);

// --- 程序化纹理(无外部资产,Asset Contract)------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
// 气态行星条纹感:横向渐变条带
function bandTexture(hexBase, hexDark) {
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  const base = new THREE.Color(hexBase), dark = new THREE.Color(hexDark);
  const stops = [0, 0.14, 0.22, 0.35, 0.45, 0.52, 0.62, 0.72, 0.85, 1];
  stops.forEach((s, i) => {
    const col = (i % 2 === 0 ? base : dark).clone();
    col.offsetHSL(0, 0, (i % 4 === 0 ? 0.04 : -0.02));
    grad.addColorStop(s, '#' + col.getHexString());
  });
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// 柔光圆点(太阳光晕 / 小行星 / 背景星共用思路)
function glowTexture(inner, outer) {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const sunGlowTex = glowTexture('rgba(255,236,170,0.95)', 'rgba(255,170,60,0.30)');
const dotTex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.55)');

// --- 恒星:中心发光球体 + 双层光晕(全画面最亮元素)------------------------------
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(9, 48, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe27a })
);
scene.add(sun);
function glowSprite(scale, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity,
  }));
  s.scale.set(scale, scale, 1);
  scene.add(s);
  return s;
}
glowSprite(60, 1.0);
glowSprite(135, 0.55);

// --- 轨道参考线:细淡圆环 --------------------------------------------------------
function orbitLine(radius) {
  const seg = 180;
  const pts = new Float32Array(seg * 3);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    pts[i * 3] = radius * Math.cos(a);
    pts[i * 3 + 2] = -radius * Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
    color: 0x9aa7b8, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  scene.add(line);
}
PLANETS.forEach((p) => orbitLine(p.orbitRadius));

// --- 行星 + 卫星 + 行星环(真实父子层级:orbit → anchor → {mesh, ring, moonPivot})--
for (const p of PLANETS) {
  const orbit = new THREE.Object3D();          // 公转:rotation.y = 轨道角
  const anchor = new THREE.Object3D();         // 行星本体锚点(位置 = 轨道半径处)
  anchor.position.x = p.orbitRadius;
  const matOpts = { roughness: 0.95, metalness: 0.0 };
  if (p.banded) matOpts.map = bandTexture(p.color, new THREE.Color(p.color).offsetHSL(0, 0.02, -0.12).getHex());
  else matOpts.color = p.color;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, 40, 24), new THREE.MeshStandardMaterial(matOpts));
  orbit.add(anchor);
  anchor.add(mesh);
  if (p.ring) {                                // 半透明环面,倾斜使初始视角可辨
    const tiltG = new THREE.Object3D();
    tiltG.rotation.z = p.ring.tilt;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(p.ring.inner, p.ring.outer, 72),
      new THREE.MeshBasicMaterial({
        color: p.ring.color, transparent: true, opacity: p.ring.opacity,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;            // RingGeometry 立于 XY 面,放平到 XZ
    tiltG.add(ring);
    anchor.add(tiltG);
  }
  p.moonPivots = [];
  (p.moons || []).forEach((m) => {
    const pivot = new THREE.Object3D();        // 卫星公转:rotation.y = 卫星轨道角
    const mm = new THREE.Mesh(
      new THREE.SphereGeometry(m.radius, 20, 12),
      new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.98, metalness: 0 })
    );
    mm.position.x = m.dist;
    pivot.add(mm);
    anchor.add(pivot);
    p.moonPivots.push(pivot);
  });
  scene.add(orbit);
  p.orbitObj = orbit;
  p.anchorObj = anchor;
  p.meshObj = mesh;
}

// --- 小行星带:900 个独立小天体,各自轨道半径/相位/角速度(带内速度分层)-----------
const astRad = new Float32Array(AST_COUNT);
const astY = new Float32Array(AST_COUNT);
const astPhase = new Float32Array(AST_COUNT);
const astPeriod = new Float32Array(AST_COUNT);
const astColor = new Float32Array(AST_COUNT * 3);
const astPos = new Float32Array(AST_COUNT * 3);
{
  const c = new THREE.Color();
  for (let i = 0; i < AST_COUNT; i++) {
    // 半径在带内聚中分布(高斯近似),略有厚度;周期介于 mars(900)与 jupiter(1600)之间且外慢内快
    astRad[i] = AST_R_MIN + (AST_R_MAX - AST_R_MIN) * (0.5 + 0.5 * (Math.random() + Math.random() - 1));
    astY[i] = (Math.random() - 0.5) * 3.4;
    astPhase[i] = Math.random() * TAU;
    const t = (astRad[i] - AST_R_MIN) / (AST_R_MAX - AST_R_MIN); // 0 内 → 1 外
    astPeriod[i] = 1080 + t * 340;
    c.setHSL(0.07 + Math.random() * 0.03, 0.22 + Math.random() * 0.14, 0.58 + Math.random() * 0.26);
    astColor[i * 3] = c.r; astColor[i * 3 + 1] = c.g; astColor[i * 3 + 2] = c.b;
  }
}
const beltGeo = new THREE.BufferGeometry();
beltGeo.setAttribute('position', new THREE.BufferAttribute(astPos, 3));
beltGeo.setAttribute('color', new THREE.BufferAttribute(astColor, 3));
const belt = new THREE.Points(beltGeo, new THREE.PointsMaterial({
  size: 2.6, map: dotTex, vertexColors: true, transparent: true, alphaTest: 0.25,
  depthWrite: false, sizeAttenuation: true,
}));
scene.add(belt);

// --- 背景星(可选装饰,静态)------------------------------------------------------
{
  const N = 650;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const r = 1900 + Math.random() * 900;
    const th = Math.random() * TAU;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    c.setHSL(0.55 + Math.random() * 0.1, 0.3, 0.5 + Math.random() * 0.4);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    size: 1.7, map: dotTex, vertexColors: true, transparent: true, alphaTest: 0.2,
    depthWrite: false, sizeAttenuation: false, opacity: 0.8,
  })));
}

// --- 模拟时钟与状态(spec §7 stateContract)---------------------------------------
let simTime = 0;          // 模拟秒(1x:1 实时秒 = 1 模拟秒)
let timeScale = 1;        // ∈ {0.5, 1, 2, 4, 8}
let selectedPlanet = null; // 小写行星名 | null
let epoch = 0;            // reset 计数
const pickTargets = PLANETS.map((p) => ({ name: p.name, x: 0, y: 0, r: 8.2 }));
const frameTimes = [];     // fps 2s 滚动窗口
let fps = 0;

// --- UI:时间倍率五档 / Reset / 信息卡 / 选中高亮圈 -------------------------------
const CSS = document.createElement('style');
CSS.textContent = `
  .hud { position: fixed; z-index: 9999; font: 12px/1.4 system-ui, sans-serif; color: #cfd8e3; user-select: none; }
  #time-controls { top: 8px; left: 8px; display: flex; gap: 4px; align-items: center;
    background: rgba(10,14,22,0.72); border: 1px solid #2a3648; border-radius: 6px; padding: 4px 6px; }
  #time-controls .lbl { margin-right: 4px; color: #8fa0b5; }
  .ts-btn { padding: 3px 9px; font: 12px system-ui, sans-serif; background: #1a2433; color: #cfd8e3;
    border: 1px solid #3a4a5c; border-radius: 4px; cursor: pointer; }
  .ts-btn:hover { background: #24344a; }
  .ts-btn.active { background: #ffd75e; color: #14202e; border-color: #ffd75e; font-weight: 700; }
  #reset { top: 8px; right: 8px; padding: 4px 14px; font: 12px system-ui, sans-serif; background: #1a2433;
    color: #ffd75e; border: 1px solid #4a5c66; border-radius: 4px; cursor: pointer; }
  #reset:hover { background: #24344a; }
  #info-card { top: 64px; right: 12px; width: 216px; background: rgba(10,14,22,0.85);
    border: 1px solid #384a5c; border-radius: 8px; padding: 10px 12px; }
  #info-card h3 { margin: 0 0 6px; font-size: 15px; color: #ffd75e; letter-spacing: 1px; }
  #info-card .row { display: flex; justify-content: space-between; padding: 2px 0; }
  #info-card .row span { color: #8fa0b5; }
  #info-card .row b { color: #e8eef5; font-weight: 600; }
  #hint { bottom: 8px; left: 12px; color: #6d7f94; pointer-events: none; }
  #sel-ring { position: fixed; z-index: 9998; border: 2px solid #7fd8ff; border-radius: 50%;
    box-shadow: 0 0 12px rgba(127,216,255,0.55), inset 0 0 8px rgba(127,216,255,0.25);
    pointer-events: none; display: none; }
`;
document.head.appendChild(CSS);

const hudTime = document.createElement('div');
hudTime.className = 'hud';
hudTime.id = 'time-controls';
hudTime.setAttribute('data-ui', 'time-controls');
hudTime.innerHTML = '<span class="lbl">时间倍率</span>';
const SPEEDS = [0.5, 1, 2, 4, 8];
const speedBtns = {};
for (const s of SPEEDS) {
  const b = document.createElement('button');
  b.className = 'ts-btn';
  b.textContent = s + 'x';
  b.setAttribute('data-ui', 'speed-' + s + 'x');
  b.setAttribute('aria-label', 'speed-' + s + 'x');
  b.addEventListener('click', () => setTimeScale(s));
  hudTime.appendChild(b);
  speedBtns[s] = b;
}
document.body.appendChild(hudTime);

const btnReset = document.createElement('button');
btnReset.id = 'reset';
btnReset.className = 'hud';
btnReset.textContent = 'Reset';
btnReset.setAttribute('data-ui', 'reset');
btnReset.setAttribute('aria-label', 'reset');
btnReset.addEventListener('click', () => doReset());
document.body.appendChild(btnReset);

const card = document.createElement('div');
card.id = 'info-card';
card.className = 'hud';
card.setAttribute('data-ui', 'info-card');
card.setAttribute('role', 'status');
card.setAttribute('aria-label', 'info-card');
card.style.display = 'none';
document.body.appendChild(card);

const hint = document.createElement('div');
hint.id = 'hint';
hint.className = 'hud';
hint.textContent = '拖拽旋转 · 滚轮缩放 · 点击行星查看信息 · 点击空白取消';
document.body.appendChild(hint);

const selRing = document.createElement('div');
selRing.id = 'sel-ring';
document.body.appendChild(selRing);

function renderCard(p) {
  // 数据与状态一致:轨道半径/周期直接取自 PLANETS 定数(即 getState().planets 的来源)
  card.innerHTML =
    '<h3>' + p.name + '</h3>' +
    '<div class="row"><span>类型</span><b>' + p.type + '</b></div>' +
    '<div class="row"><span>公转周期</span><b>' + p.period + ' 模拟秒</b></div>' +
    '<div class="row"><span>轨道半径</span><b>' + p.orbitRadius + '</b></div>' +
    '<div class="row"><span>卫星数</span><b>' + (p.moons ? p.moons.length : 0) + ' 颗</b></div>';
}

function setTimeScale(s) {
  timeScale = s; // 只改时钟流速:全部天体运动即时平滑变速,无跳变
  for (const k of SPEEDS) speedBtns[k].classList.toggle('active', k === s);
}
setTimeScale(1);

function selectPlanet(name) {
  selectedPlanet = name;
  if (name) {
    renderCard(PLANETS.find((p) => p.name === name));
    card.style.display = 'block';
  } else {
    card.style.display = 'none';
  }
}

function doReset() {
  // 恢复初始:轨道角由 simTime 导出,归零即精确回到 k×45°;渲染循环不中断
  simTime = 0;
  timeScale = 1;
  selectedPlanet = null;
  card.style.display = 'none';
  selRing.style.display = 'none';
  for (const k of SPEEDS) speedBtns[k].classList.toggle('active', k === 1);
  epoch += 1;
}

// --- 点击拾取:针对行星的可视投影区域;点空白不选中(NC04)-------------------------
let downX = 0, downY = 0;
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // 拖拽不是点击
  let best = null, bestD = Infinity;
  for (const t of pickTargets) {
    const d = Math.hypot(t.x - e.clientX, t.y - e.clientY);
    const hit = Math.max(t.r * 1.3, 10); // 投影圆域(含最小可点击下限)
    if (d <= hit && d < bestD) { best = t; bestD = d; }
  }
  selectPlanet(best ? best.name : null);
});

// --- 相机交互(可选增强):左键拖拽环绕,滚轮缩放 ----------------------------------
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camCtl.azimuth -= (e.clientX - lastX) * 0.005;
  camCtl.elevation = THREE.MathUtils.clamp(camCtl.elevation + (e.clientY - lastY) * 0.004, 0.12, 1.45);
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
window.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camCtl.dist = THREE.MathUtils.clamp(camCtl.dist * (e.deltaY > 0 ? 1.1 : 0.9), 150, 1200);
  applyCamera();
}, { passive: false });

// --- 状态导出(每帧刷新的 pickTargets / 镜像 DOM 的 infoCard)---------------------
function getState() {
  return {
    engine: 'three',
    ready: true,
    planetCount: PLANETS.length,
    moonCount: MOON_COUNT,
    asteroidCount: AST_COUNT,
    ringedPlanetCount: RINGED_COUNT,
    timeScale,
    simulationTime: simTime,
    selectedPlanet,
    epoch,
    fps,
    planets: PLANETS.map((p) => ({
      name: p.name,
      orbitRadius: p.orbitRadius,
      orbitAngle: p.initAngle + (TAU * simTime) / p.period, // 连续累计,不取模
    })),
    pickTargets: pickTargets.map((t) => ({ name: t.name, screenX: t.x, screenY: t.y, screenRadius: t.r })),
    infoCard: {
      visible: card.style.display !== 'none',
      name: card.style.display !== 'none' ? selectedPlanet : '',
      fieldCount: card.style.display !== 'none' ? 4 : 0, // 类型/公转周期/轨道半径/卫星数
    },
  };
}

window.__bench = { getState, reset: doReset };

// --- 主循环 ------------------------------------------------------------------------
const wp = new THREE.Vector3();
let lastT = performance.now();

function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.5); // 钳制后台标签页回来时的巨大增量
  lastT = now;
  simTime += dt * timeScale;                       // 唯一的时间源:模拟时钟

  // fps:2s 滚动平均
  frameTimes.push(now);
  while (frameTimes.length > 0 && frameTimes[0] < now - 2000) frameTimes.shift();
  if (frameTimes.length > 1) fps = ((frameTimes.length - 1) * 1000) / (now - frameTimes[0]);

  // 行星公转 + 自转 + 卫星(全部由 simTime 导出)
  for (const p of PLANETS) {
    p.orbitObj.rotation.y = p.initAngle + (TAU * simTime) / p.period;
    p.meshObj.rotation.y = (TAU * simTime) / p.spin;
    p.moonPivots.forEach((pv, i) => {
      pv.rotation.y = i * 1.9 + (TAU * simTime) / p.moons[i].period;
    });
  }
  // 小行星带:逐天体按各自角速度推进(整体缓慢流动,带内分层)
  for (let i = 0; i < AST_COUNT; i++) {
    const a = astPhase[i] + (TAU * simTime) / astPeriod[i];
    astPos[i * 3] = astRad[i] * Math.cos(a);
    astPos[i * 3 + 1] = astY[i];
    astPos[i * 3 + 2] = -astRad[i] * Math.sin(a);
  }
  beltGeo.attributes.position.needsUpdate = true;

  renderer.render(scene, camera);

  // pickTargets:渲染后用真实投影计算(渲染已更新世界矩阵),CSS 像素,原点左上
  const H = window.innerHeight;
  const f = H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  PLANETS.forEach((p, i) => {
    p.anchorObj.getWorldPosition(wp);
    const dist = camera.position.distanceTo(wp);
    wp.project(camera);
    pickTargets[i].x = (wp.x * 0.5 + 0.5) * window.innerWidth;
    pickTargets[i].y = (-wp.y * 0.5 + 0.5) * window.innerHeight;
    pickTargets[i].r = Math.max((p.radius * f) / Math.max(dist, 1), 8.2); // ≥8px 保证可点击
  });

  // 选中高亮圈跟随选中行星
  if (selectedPlanet) {
    const t = pickTargets.find((q) => q.name === selectedPlanet);
    if (t) {
      const d = Math.max(t.r * 2 + 12, 20);
      selRing.style.display = 'block';
      selRing.style.width = d + 'px';
      selRing.style.height = d + 'px';
      selRing.style.left = t.x - d / 2 + 'px';
      selRing.style.top = t.y - d / 2 + 'px';
    }
  }

  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- 视口自适应 ----------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
