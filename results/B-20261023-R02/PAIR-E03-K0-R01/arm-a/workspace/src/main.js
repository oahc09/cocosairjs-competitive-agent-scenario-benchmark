// ============================================================================
// E03 — 太阳系仪(Orrery)— three.js r186 (0.186.1) 实现
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : 首帧渲染完成后置 true(index.html 内联脚本先置 false)
//   window.__bench    : { getState(): object, reset(): void }
// 全部天体程序化生成(参数化球体 / 环面 / 实例化小块 / 顶点级星点),无外部资源。
// 布局要点(经解析计算校准,见 RESULT.md):
//   相机 fov55、俯角约 50°、距离 133、lookAt(0,0,30) 抬升构图 →
//   海王星轨道横跨约 66% 画面宽,上下各留 >25px 边距,8 颗行星全部可投影可点击。
// ============================================================================

import * as THREE from 'three';

const TAU = Math.PI * 2;

// --- 行星配置(轨道半径升序;公转周期单调递增:内 200s、外 3400s,均合规) ---
// bands: 程序化纬向条纹色标(岩质灰褐/锈红、气巨米黄条纹、冰巨蓝青)
const PLANETS = [
  { name: 'mercury', type: 'rocky', size: 1.7, orbitRadius: 14, period: 200,  spin: 0.25,
    bands: ['#b3a48c', '#a89880', '#b3a48c', '#9c8d76', '#b3a48c'] },
  { name: 'venus',   type: 'rocky', size: 2.1, orbitRadius: 20, period: 340,  spin: 0.18,
    bands: ['#e6cd9d', '#d9bd85', '#e6cd9d', '#cfb27a', '#e6cd9d'] },
  { name: 'earth',   type: 'rocky', size: 2.3, orbitRadius: 27, period: 480,  spin: 0.35,
    bands: ['#eaf6ff', '#3f83d9', '#2f6fd0', '#3f83d9', '#eaf6ff'] },
  { name: 'mars',    type: 'rocky', size: 1.9, orbitRadius: 34, period: 640,  spin: 0.32,
    bands: ['#d08a64', '#b5533a', '#c26a4a', '#a5553a', '#c97a56'] },
  { name: 'jupiter', type: 'gas',   size: 5.0, orbitRadius: 47, period: 1200, spin: 0.5,
    bands: ['#e3cfa8', '#b98d62', '#e8d7b2', '#a97b53', '#e3cfa8', '#c49a6d', '#d9c39a', '#b0714b'] },
  { name: 'saturn',  type: 'gas',   size: 4.3, orbitRadius: 58, period: 1800, spin: 0.45, ring: true,
    bands: ['#e8ddbb', '#d5c49a', '#e2d4ac', '#c9b582', '#e0d0a6'] },
  { name: 'uranus',  type: 'ice',   size: 3.0, orbitRadius: 69, period: 2500, spin: 0.3,
    bands: ['#a8e4e6', '#8fd4d9', '#9ddcdf', '#8fd4d9'] },
  { name: 'neptune', type: 'ice',   size: 2.9, orbitRadius: 80, period: 3400, spin: 0.3,
    bands: ['#4a6ede', '#3450c4', '#4266d6', '#2c4bb8'] },
];
const TYPE_LABEL = { rocky: 'Rocky planet', gas: 'Gas giant', ice: 'Ice giant' };

// --- 卫星配置(父=行星组,真实父子层级;周期 8–40 模拟秒) ---
const MOONS = {
  earth:   [{ orbitR: 4.6, period: 20, size: 0.62, color: 0xbfc3cc, angle0: 0.9 }],
  jupiter: [{ orbitR: 7.0, period: 12, size: 0.74, color: 0xcab9a0, angle0: 2.1 },
            { orbitR: 9.2, period: 30, size: 0.66, color: 0xa8b2a0, angle0: 4.4 }],
};
const MOON_TOTAL = Object.values(MOONS).reduce((n, a) => n + a.length, 0);

// --- 小行星带(独立于行星层级;>=500 个独立小天体,带内速度分层) ---
const BELT_COUNT = 900;
const BELT_R0 = 38, BELT_R1 = 44.5; // 位于第 4(mars 34)与第 5(jupiter 47)条轨道之间
const STAR_COUNT = 1100;

// ============================================================================
// 渲染器 / 场景 / 相机
// ============================================================================
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03050a); // 深空近黑

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.5,
  4000
);
camera.position.set(0, 85.6, 101.9); // 距原点 133,仰角 ≈40°(视线俯角 ≈50°,在 30–60° 区间)
camera.lookAt(0, 0, 30);             // 目标点前移 → 系统整体上抬,近侧轨道不裁出画面

/** 垂直焦距(像素),用于 pickTargets 的 screenRadius 投影。 */
function focalPx() {
  return (window.innerHeight / 2) / Math.tan(((camera.fov * Math.PI) / 180) / 2);
}

// ============================================================================
// 光照:中心点光(恒星)+ 微弱环境光(暗面可辨)
// ============================================================================
scene.add(new THREE.AmbientLight(0x8899bb, 0.32));
scene.add(new THREE.PointLight(0xfff0c8, 2.6, 0, 0)); // decay=0:全程均匀照亮

// ============================================================================
// 程序化纹理工具(无外部资源)
// ============================================================================
function bandTexture(stops) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  stops.forEach((col, i) => grad.addColorStop(i / (stops.length - 1), col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,244,214,1)');
  grad.addColorStop(0.18, 'rgba(255,224,150,0.85)');
  grad.addColorStop(0.45, 'rgba(255,190,90,0.28)');
  grad.addColorStop(1.0, 'rgba(255,170,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================================
// 恒星:发光核心 + 双层加性光晕(全画面最亮元素)
// ============================================================================
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(6.5, 48, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
));
{
  const glowTex = glowTexture();
  const mkGlow = (scale, opacity) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, blending: THREE.AdditiveBlending, transparent: true,
      opacity, depthWrite: false,
    }));
    s.scale.setScalar(scale);
    scene.add(s);
  };
  mkGlow(30, 0.95);
  mkGlow(62, 0.5);
}

// ============================================================================
// 行星(组 = 位置节点;mesh = 自转;卫星 = 组的子节点 → 随行星公转)
// ============================================================================
const planetMeshes = []; // 仅行星球体可被拾取
const planetNodes = PLANETS.map((cfg, k) => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.size, 36, 20),
    new THREE.MeshStandardMaterial({ map: bandTexture(cfg.bands), roughness: 0.9, metalness: 0.04 })
  );
  mesh.userData.name = cfg.name;
  group.add(mesh);

  if (cfg.ring) {
    const mkRing = (r0, r1, op) => {
      const rm = new THREE.Mesh(
        new THREE.RingGeometry(r0, r1, 72, 1),
        new THREE.MeshBasicMaterial({
          color: 0xd8c9a3, transparent: true, opacity: op,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      rm.rotation.x = -Math.PI / 2; // 环面置于行星本地水平面
      rm.renderOrder = 1;
      return rm;
    };
    group.add(mkRing(5.6, 7.1, 0.5));
    group.add(mkRing(7.2, 8.7, 0.3));
    group.rotation.set(0.18, 0, 0.44); // 轴倾角:初始俯视角下环面可辨
  }

  const moons = (MOONS[cfg.name] || []).map((m) => {
    const mm = new THREE.Mesh(
      new THREE.SphereGeometry(m.size, 18, 10),
      new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.95 })
    );
    group.add(mm); // 父子层级:卫星节点挂在行星组下
    return { ...m, mesh: mm, angle: m.angle0 };
  });

  scene.add(group);
  planetMeshes.push(mesh);
  return {
    cfg, k, group, mesh, moons,
    angle0: (k * Math.PI) / 4, // 第 k 颗初始轨道角 = k × 45°
    angle: (k * Math.PI) / 4,
    pickRadius: cfg.ring ? 8.7 : cfg.size,
  };
});

// ============================================================================
// 轨道参考线(细淡)
// ============================================================================
{
  const mat = new THREE.LineBasicMaterial({ color: 0x8a93a3, transparent: true, opacity: 0.22 });
  for (const p of PLANETS) {
    const N = 180;
    const pts = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      pts[i * 3] = Math.cos(a) * p.orbitRadius;
      pts[i * 3 + 2] = Math.sin(a) * p.orbitRadius;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    scene.add(new THREE.LineLoop(geo, mat));
  }
}

// ============================================================================
// 小行星带:InstancedMesh × 900(每个小天体独立位置/转速/翻滚)
// ============================================================================
const belt = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(1, 0),
  new THREE.MeshStandardMaterial({ color: 0x9a8a74, roughness: 1, metalness: 0 }),
  BELT_COUNT
);
belt.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(belt);

// 确定性伪随机:reset 后初始分布可精确复现
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261023);
const beltData = Array.from({ length: BELT_COUNT }, () => {
  const r = BELT_R0 + (BELT_R1 - BELT_R0) * rand();
  const period = 700 + (r - BELT_R0) * 70 + rand() * 90; // 内快外慢,带内速度分层
  return {
    r, y: (rand() - 0.5) * 1.9,
    a0: rand() * TAU, a: 0,
    w: TAU / period,
    s: 0.22 + rand() * 0.3,
    t1: rand() * TAU, t2: rand() * TAU,
    w1: (rand() - 0.5) * 1.2, w2: (rand() - 0.5) * 1.2, // 翻滚
  };
});

// ============================================================================
// 背景星(球壳均匀分布)
// ============================================================================
{
  const pos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const u = rand() * 2 - 1;
    const ph = rand() * TAU;
    const rr = 900 + rand() * 600;
    const q = Math.sqrt(1 - u * u);
    pos[i * 3] = q * Math.cos(ph) * rr;
    pos[i * 3 + 1] = u * rr;
    pos[i * 3 + 2] = q * Math.sin(ph) * rr;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xcfd8ea, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85,
  })));
}

// ============================================================================
// 选中高亮圈(始终朝向相机的亮黄描边环)
// ============================================================================
const highlight = new THREE.Mesh(
  new THREE.RingGeometry(0.8, 0.97, 48),
  new THREE.MeshBasicMaterial({
    color: 0xffd75e, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  })
);
highlight.renderOrder = 10;
highlight.visible = false;
scene.add(highlight);

// ============================================================================
// UI 覆盖层(信息卡 / 时间倍率五档 / Reset)—— data-ui 供探针定位
// ============================================================================
const BTN_CSS =
  'padding:5px 12px;font:600 13px sans-serif;cursor:pointer;border-radius:6px;' +
  'background:#1b2333;color:#cfd8ea;border:1px solid #44506b;';
const BTN_ACTIVE_CSS =
  'padding:5px 12px;font:600 13px sans-serif;cursor:pointer;border-radius:6px;' +
  'background:#ffd75e;color:#221a06;border:1px solid #ffe9a0;';

const uiRoot = document.createElement('div');
document.body.appendChild(uiRoot);

const speedBtns = {};
{
  const bar = document.createElement('div');
  bar.setAttribute('data-ui', 'time-controls');
  bar.setAttribute('aria-label', 'time controls');
  bar.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:6px;' +
    'align-items:center;z-index:1000;';
  const label = document.createElement('span');
  label.textContent = 'Time';
  label.style.cssText = 'color:#9fb0cc;font:12px sans-serif;margin-right:6px;';
  bar.appendChild(label);
  for (const s of [0.5, 1, 2, 4, 8]) {
    const b = document.createElement('button');
    b.textContent = s + 'x';
    b.setAttribute('data-ui', 'speed-' + s + 'x');
    b.setAttribute('aria-label', 'time scale ' + s + 'x');
    b.style.cssText = BTN_CSS;
    b.addEventListener('click', () => setTimeScale(s));
    bar.appendChild(b);
    speedBtns[s] = b;
  }
  uiRoot.appendChild(bar);
}
{
  const b = document.createElement('button');
  b.textContent = 'Reset';
  b.setAttribute('data-ui', 'reset');
  b.setAttribute('aria-label', 'reset');
  b.style.cssText = BTN_CSS + 'position:fixed;top:12px;right:12px;z-index:1000;';
  b.addEventListener('click', () => doReset());
  uiRoot.appendChild(b);
}

const card = document.createElement('div');
card.setAttribute('data-ui', 'info-card');
card.setAttribute('aria-label', 'info-card');
card.style.cssText =
  'position:fixed;right:18px;top:50%;transform:translateY(-50%);width:250px;' +
  'background:rgba(8,13,22,0.92);border:1px solid #3d5078;border-radius:10px;padding:12px 16px;' +
  'color:#dfe7f4;font:13px/1.55 sans-serif;z-index:1000;pointer-events:none;display:none;';
card.innerHTML =
  '<div style="font:600 16px sans-serif;color:#ffd98a;margin-bottom:8px;"></div><div></div>';
uiRoot.appendChild(card);
const cardTitle = card.firstChild;
const cardBody = card.lastChild;

function showCard(name) {
  const cfg = PLANETS.find((p) => p.name === name);
  cardTitle.textContent = name;
  cardBody.innerHTML = '';
  const rows = [
    ['Type', TYPE_LABEL[cfg.type]],
    ['Orbital period', cfg.period + ' s'],
    ['Orbit radius', cfg.orbitRadius + ' units'],
    ['Planet size', cfg.size + ' units'],
  ];
  for (const [k2, v] of rows) {
    const d = document.createElement('div');
    const key = document.createElement('span');
    key.style.color = '#8fa2c4';
    key.textContent = k2 + ': ';
    d.appendChild(key);
    d.appendChild(document.createTextNode(String(v)));
    cardBody.appendChild(d);
  }
  card.style.display = 'block';
}
function hideCard() {
  card.style.display = 'none';
}

// ============================================================================
// 运行状态
// ============================================================================
let timeScale = 1;
let simulationTime = 0;
let epoch = 0;
let selected = null;
let selectedIdx = -1;
let fps = 0;
const frameTimes = [];
let lastNow = performance.now();

function updateSpeedUI() {
  for (const s of [0.5, 1, 2, 4, 8]) {
    speedBtns[s].style.cssText = s === timeScale ? BTN_ACTIVE_CSS : BTN_CSS;
    speedBtns[s].setAttribute('aria-pressed', s === timeScale ? 'true' : 'false');
  }
}
function setTimeScale(s) {
  timeScale = s; // 只改速率,角度连续积分 → 无跳变
  updateSpeedUI();
}

function select(idx) {
  selectedIdx = idx;
  selected = idx >= 0 ? PLANETS[idx].name : null;
  if (idx >= 0) {
    highlight.visible = true;
    showCard(selected);
  } else {
    highlight.visible = false;
    hideCard();
  }
}

function doReset() {
  simulationTime = 0;
  timeScale = 1;
  updateSpeedUI();
  epoch += 1;
  select(-1);
  for (const p of planetNodes) {
    p.angle = p.angle0;
    p.mesh.rotation.y = 0;
    p.group.position.set(
      Math.cos(p.angle0) * p.cfg.orbitRadius, 0, Math.sin(p.angle0) * p.cfg.orbitRadius
    );
    for (const m of p.moons) {
      m.angle = m.angle0;
      m.mesh.position.set(Math.cos(m.angle0) * m.orbitR, 0, Math.sin(m.angle0) * m.orbitR);
    }
  }
  for (const a of beltData) a.a = a.a0;
  applyBelt(); // 立即重摆小行星带姿态,不依赖下一帧
}

// ============================================================================
// 拾取:屏幕点击 → 射线求交行星球体;未命中 = 取消选中
// ============================================================================
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0, downT = 0;

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX; downY = e.clientY; downT = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (performance.now() - downT > 600) return;         // 长按忽略
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // 拖拽忽略
  handleClick(e.clientX, e.clientY);
});
function handleClick(cx, cy) {
  ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(planetMeshes, false);
  if (hits.length > 0) {
    select(planetNodes.findIndex((p) => p.cfg.name === hits[0].object.userData.name));
  } else {
    select(-1); // 点击空白:不产生选中
  }
}

// ============================================================================
// 每帧更新的屏幕投影(供探针真实点击)
// ============================================================================
const pickTargets = PLANETS.map((p) => ({ name: p.name, screenX: 0, screenY: 0, screenRadius: 0 }));
const wp = new THREE.Vector3();
function updatePickTargets() {
  const f = focalPx();
  for (let i = 0; i < planetNodes.length; i++) {
    const p = planetNodes[i];
    wp.copy(p.group.position);
    const dist = camera.position.distanceTo(wp);
    wp.project(camera);
    const t = pickTargets[i];
    t.name = p.cfg.name;
    t.screenX = +(((wp.x + 1) / 2) * window.innerWidth).toFixed(1);
    t.screenY = +(((1 - wp.y) / 2) * window.innerHeight).toFixed(1);
    t.screenRadius = +Math.max((p.pickRadius * f) / dist, 8.5).toFixed(1);
  }
}

// ============================================================================
// 小行星带姿态
// ============================================================================
const dummy = new THREE.Object3D();
function applyBelt() {
  for (let i = 0; i < BELT_COUNT; i++) {
    const a = beltData[i];
    dummy.position.set(Math.cos(a.a) * a.r, a.y, Math.sin(a.a) * a.r);
    dummy.rotation.set(a.t1 + simulationTime * a.w1, a.t2 + simulationTime * a.w2, 0);
    dummy.scale.setScalar(a.s);
    dummy.updateMatrix();
    belt.setMatrixAt(i, dummy.matrix);
  }
  belt.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// __bench 契约
// ============================================================================
window.__bench = {
  getState: () => ({
    engine: 'three',
    planetCount: PLANETS.length,
    moonCount: MOON_TOTAL,
    asteroidCount: BELT_COUNT,
    ringedPlanetCount: PLANETS.filter((p) => p.ring).length,
    timeScale,
    simulationTime,
    selectedPlanet: selected,
    planets: planetNodes.map((p) => ({
      name: p.cfg.name, orbitRadius: p.cfg.orbitRadius, orbitAngle: p.angle,
    })),
    pickTargets: pickTargets.map((t) => ({ ...t })),
    infoCard: selected
      ? { visible: true, name: selected, fieldCount: 4 }
      : { visible: false, name: '', fieldCount: 0 },
    fps,
    epoch,
  }),
  reset: doReset,
};

// ============================================================================
// 初始姿态(首次渲染前摆好,pickTargets 立即可用)
// ============================================================================
for (const p of planetNodes) {
  p.group.position.set(
    Math.cos(p.angle0) * p.cfg.orbitRadius, 0, Math.sin(p.angle0) * p.cfg.orbitRadius
  );
  for (const m of p.moons) {
    m.mesh.position.set(Math.cos(m.angle0) * m.orbitR, 0, Math.sin(m.angle0) * m.orbitR);
  }
}
for (const a of beltData) a.a = a.a0;
applyBelt();
updatePickTargets();
updateSpeedUI();

// ============================================================================
// 主循环:时钟增量驱动模拟;timeScale 即时作用于全部天体
// ============================================================================
function tick() {
  const now = performance.now();
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  if (dt > 0.25) dt = 0.25; // 后台标签页节流恢复时不产生大跳变
  const simDt = dt * timeScale;
  simulationTime += simDt;

  for (const p of planetNodes) {
    p.angle += (TAU / p.cfg.period) * simDt;
    p.group.position.set(
      Math.cos(p.angle) * p.cfg.orbitRadius, 0, Math.sin(p.angle) * p.cfg.orbitRadius
    );
    p.mesh.rotation.y += p.cfg.spin * simDt;
    for (const m of p.moons) {
      m.angle += (TAU / m.period) * simDt;
      m.mesh.position.set(Math.cos(m.angle) * m.orbitR, 0, Math.sin(m.angle) * m.orbitR);
    }
  }

  for (const a of beltData) a.a += a.w * simDt;
  applyBelt();

  if (selectedIdx >= 0) {
    const p = planetNodes[selectedIdx];
    highlight.position.copy(p.group.position);
    highlight.scale.setScalar(p.cfg.size * 2.3);
    highlight.quaternion.copy(camera.quaternion); // 始终正对相机
  }

  updatePickTargets();

  // fps:2s 滚动平均
  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 2) {
    fps = (frameTimes.length - 1) / ((frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000);
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
}
renderer.setAnimationLoop(tick);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
