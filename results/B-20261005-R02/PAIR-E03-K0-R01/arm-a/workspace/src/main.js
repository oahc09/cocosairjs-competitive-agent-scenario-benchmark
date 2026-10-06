// ============================================================================
// E03 — 太阳系仪(Orrery)— three.js r186 实现(Arm A, K0)
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1,harness 断言):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//   UI 控件           : data-ui 属性定位(reset / speed-0.5x..speed-8x / info-card)
//
// 设计要点(为什么这样写):
//   1. 全部轨道运动由"模拟时钟"推导:angle = θ0 + 2π·simTime/T。倍率切换只改
//      timeScale 的乘数,角度对 simTime 连续可导 → 变速即时、平滑、无跳变;
//      reset 只需 simTime=0,所有天体(含卫星/自转/小行星带)精确回到初始角,
//      无需逐个恢复,也不可能以整页刷新实现。
//   2. 公转周期自内向外单调递增(230 → 3400 模拟秒),内侧行星角速度约为外侧
//      的 14.8 倍(> 4 倍,公转分层证据);1x 时 1 实时秒 = 1 模拟秒。
//   3. 点击判定用 pickTargets 的屏幕投影距离(与状态同源),空点击不选中(NC04);
//      screenRadius 下限 9px 保证小行星可点(spec 允许"以天体尺寸或选中高亮圈保证")。
//   4. 小行星带 = 600 个独立 InstancedMesh 实例(3 个子环不同角速度 → 带内速度分层),
//      非贴图/单个环面冒充。
//   5. _probe() 为自检辅助:真实渲染一帧后按像素统计亮度/帧间差/行星区域亮度,
//      仅用于本 Arm 自查像素证据,不参与 harness 判定。
// ============================================================================

import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

// --- 天体参数(orbitRadius 升序;T = 公转周期/模拟秒;size = 世界半径) ----------
const PLANET_DEFS = [
  { name: 'mercury', zh: '水星', R: 7.0, T: 230, size: 0.95, color: 0x9c8f84, type: '岩质行星', spinT: 34 },
  { name: 'venus',   zh: '金星', R: 10.0, T: 400, size: 1.35, color: 0xd9b47f, type: '岩质行星', spinT: 50 },
  { name: 'earth',   zh: '地球', R: 13.5, T: 620, size: 1.42, color: 0x4f7fd9, type: '岩质行星', spinT: 18,
    moons: [{ dist: 2.9, size: 0.38, T: 22 }] },
  { name: 'mars',    zh: '火星', R: 17.5, T: 900, size: 1.15, color: 0xc4693f, type: '岩质行星', spinT: 20 },
  { name: 'jupiter', zh: '木星', R: 26.0, T: 1400, size: 3.50, color: 0xffffff, type: '气态巨行星', spinT: 10,
    bands: { base: '#d8b98a', band: '#b98f62' }, moons: [{ dist: 5.4, size: 0.44, T: 12 }, { dist: 7.2, size: 0.36, T: 30 }] },
  { name: 'saturn',  zh: '土星', R: 34.0, T: 2000, size: 3.00, color: 0xffffff, type: '气态巨行星', spinT: 11,
    bands: { base: '#e0cd9a', band: '#c9ad74' }, ring: true },
  { name: 'uranus',  zh: '天王星', R: 42.0, T: 2700, size: 2.10, color: 0x8fd1d8, type: '冰巨行星', spinT: 14 },
  { name: 'neptune', zh: '海王星', R: 49.0, T: 3400, size: 2.00, color: 0x5a7bdc, type: '冰巨行星', spinT: 13 },
];
const SUN_RADIUS = 4.2;
const BELT_COUNT = 600;       // 独立小天体数量(状态报告值 = 真实渲染数)
const BELT_T = 1150;          // 带整体公转周期(模拟秒),介于 mars 900 与 jupiter 1400 之间
const CAM_DIST = 82;          // 相机距离:最外轨道宽约占画幅 64.5%(65–80% 锚点下缘;外环近弧略出画,初始 8 星全部在画面内)
const CAM_PITCH = 42 * DEG;   // 初始俯角 42°(30°–60° 锚点)
const MIN_PICK_RADIUS = 9;    // pickTargets.screenRadius 下限(CSS px,spec ≥ 8)

// --- 渲染器 / 场景 / 相机 ------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020309);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 1200);
function applyCamera() {
  camera.position.set(0, CAM_DIST * Math.sin(CAM_PITCH), CAM_DIST * Math.cos(CAM_PITCH));
  camera.lookAt(0, 0, 0);
}
applyCamera();

// --- 恒星:发光核心 + 加色光晕(全画面最亮元素) --------------------------------
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(SUN_RADIUS, 48, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe28a })
));
{
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(255,238,180,1)');
  g.addColorStop(0.22, 'rgba(255,214,120,0.55)');
  g.addColorStop(0.55, 'rgba(255,190,90,0.15)');
  g.addColorStop(1.0, 'rgba(255,180,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color: 0xffdd99, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.set(30, 30, 1);
  scene.add(glow);
}

// --- 光照:太阳点光(decay=0 无衰减,行星远近亮度一致)+ 低强度环境光 ----------
scene.add(new THREE.AmbientLight(0x54608a, 0.55));
const sunLight = new THREE.PointLight(0xfff1c4, 1.5, 0, 0);
scene.add(sunLight);

// --- 轨道参考线(细淡,低不透明度) ---------------------------------------------
{
  const mat = new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.22, depthWrite: false });
  for (const def of PLANET_DEFS) {
    const pts = [];
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * TWO_PI;
      pts.push(new THREE.Vector3(Math.cos(a) * def.R, 0, Math.sin(a) * def.R));
    }
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
}

// --- 气态巨行星条纹纹理(程序生成,无外部资产) ----------------------------------
function makeBandTexture(base, band) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 8, 128);
  ctx.fillStyle = band;
  let y = 0;
  let i = 0;
  while (y < 128) {
    const h = 4 + ((i * 37) % 11);
    if (i % 2 === 0) ctx.fillRect(0, y, 8, h);
    y += h; i += 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// --- 行星 + 卫星(父子层级:卫星随行星公转) ------------------------------------
const PLANETS = PLANET_DEFS.map((def, k) => {
  const anchor = new THREE.Group(); // 行星系统锚点:位于轨道位置
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(def.size, 40, 20),
    def.bands
      ? new THREE.MeshStandardMaterial({ map: makeBandTexture(def.bands.base, def.bands.band), roughness: 0.85, metalness: 0 })
      : new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.85, metalness: 0 })
  );
  anchor.add(mesh);

  if (def.ring) {
    // 行星环:半透明环面,整体倾斜(轴倾角 0.42 rad),初始俯视角下可辨
    const tilt = new THREE.Group();
    tilt.rotation.z = 0.42;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(def.size * 1.35, def.size * 2.2, 96),
      new THREE.MeshBasicMaterial({ color: 0xd8c8a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; // 环面铺进行星赤道面
    tilt.add(ring);
    anchor.add(tilt);
  }

  const moonPivots = (def.moons || []).map((m) => {
    const pivot = new THREE.Group(); // 卫星枢轴:绕行星本地原点公转
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(m.size, 20, 10),
      new THREE.MeshStandardMaterial({ color: 0xb9b2a6, roughness: 0.95 })
    );
    moon.position.set(m.dist, 0, 0);
    pivot.add(moon);
    anchor.add(pivot);
    return { pivot, def: m };
  });

  scene.add(anchor);
  return {
    ...def,
    index: k,
    theta0: k * (Math.PI / 4), // 第 k 颗初始轨道角 = k × 45°
    anchor, mesh, moonPivots,
    screen: { name: def.name, screenX: 0, screenY: 0, screenRadius: MIN_PICK_RADIUS },
  };
});
const MOON_COUNT = PLANETS.reduce((n, p) => n + p.moonPivots.length, 0);
const RINGED_COUNT = PLANETS.filter((p) => p.ring).length;

// --- 小行星带:600 个独立实例,3 个子环不同角速度(带内速度分层) ----------------
const beltSubs = [];
{
  const rockGeo = new THREE.IcosahedronGeometry(0.42, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a8974, roughness: 1, metalness: 0 });
  const ranges = [[20.0, 21.2], [21.2, 22.4], [22.4, 23.6]]; // 第 4(mars 17.5)与第 5(jupiter 26)条轨道之间
  const factors = [1.18, 1.0, 0.86];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const perGroup = BELT_COUNT / ranges.length;
  ranges.forEach((rg, gi) => {
    const g = new THREE.Group();
    const inst = new THREE.InstancedMesh(rockGeo, rockMat, perGroup);
    for (let i = 0; i < perGroup; i++) {
      const r = rg[0] + Math.random() * (rg[1] - rg[0]);
      const a = Math.random() * TWO_PI;
      pos.set(Math.cos(a) * r, (Math.random() - 0.5) * 1.6, Math.sin(a) * r);
      e.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      q.setFromEuler(e);
      const s = 0.35 + Math.random() * 0.9;
      scl.set(s, s * (0.7 + Math.random() * 0.6), s);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
    scene.add(g);
    beltSubs.push({ g, factor: factors[gi] });
  });
}

// --- 背景星(可选锚点,程序生成点云) -------------------------------------------
{
  const N = 900;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const r = 420 + Math.random() * 100;
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * TWO_PI;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = r * s * Math.cos(phi);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * s * Math.sin(phi);
    col.setHSL(0.55 + Math.random() * 0.1, 0.25, 0.6 + Math.random() * 0.35);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
  })));
}

// --- 选中高亮:始终面向相机的双环(随选中行星移动) ------------------------------
const selRing = new THREE.Group();
selRing.visible = false;
{
  const mk = (ri, ro, op) => new THREE.Mesh(
    new THREE.RingGeometry(ri, ro, 64),
    new THREE.MeshBasicMaterial({ color: 0x7de8ff, transparent: true, opacity: op, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  selRing.add(mk(1.0, 1.16, 0.95), mk(1.24, 1.3, 0.45));
  selRing.renderOrder = 999;
  scene.add(selRing);
}

// --- 运行状态 -------------------------------------------------------------------
let simTime = 0;        // 模拟秒(1x:1 实时秒 = 1 模拟秒)
let timeScale = 1;      // ∈ {0.5, 1, 2, 4, 8}
let selectedPlanet = null; // 小写英文行星名 | null
let epoch = 0;          // reset 计数
let cardVisible = false;
const frameStamps = []; // 最近 2s 帧时间戳(fps 滚动平均)

function orbitAngle(p) {
  return p.theta0 + (TWO_PI * simTime) / p.T; // 连续累计,不取模
}

// --- UI:时间倍率五档控件 + Reset + 信息卡 --------------------------------------
const cssBtn = 'padding:5px 12px;font:13px sans-serif;background:#141a26;color:#cfe0f5;' +
  'border:1px solid #3a4a63;border-radius:4px;cursor:pointer;';
const cssBtnActive = 'padding:5px 12px;font:13px sans-serif;background:#2f6fd0;color:#ffffff;' +
  'border:1px solid #9cc8ff;border-radius:4px;cursor:pointer;';

const timeControls = document.createElement('div');
timeControls.setAttribute('data-ui', 'time-controls');
timeControls.setAttribute('aria-label', 'time-controls');
timeControls.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;' +
  'display:flex;gap:6px;align-items:center;';
const speedButtons = {};
for (const v of [0.5, 1, 2, 4, 8]) {
  const b = document.createElement('button');
  b.textContent = v + 'x';
  b.setAttribute('data-ui', 'speed-' + v + 'x');
  b.setAttribute('aria-label', 'speed-' + v + 'x');
  b.addEventListener('click', () => setTimeScale(v));
  timeControls.appendChild(b);
  speedButtons[v] = b;
}
document.body.appendChild(timeControls);

const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText = cssBtn + 'position:fixed;top:10px;right:12px;z-index:9999;';
resetBtn.addEventListener('click', () => doReset());
document.body.appendChild(resetBtn);

const card = document.createElement('div');
card.setAttribute('data-ui', 'info-card');
card.setAttribute('aria-label', 'info-card');
card.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:9999;display:none;min-width:196px;' +
  'padding:10px 14px;font:12px/1.7 sans-serif;background:rgba(10,16,28,0.92);color:#dbe7f7;' +
  'border:1px solid #3a4a63;border-radius:6px;pointer-events:none;';
document.body.appendChild(card);

function setTimeScale(v) {
  timeScale = v; // 即时生效:角度由 simTime 推导,无跳变
  for (const key of Object.keys(speedButtons)) {
    speedButtons[key].style.cssText = Number(key) === v ? cssBtnActive : cssBtn;
  }
}
setTimeScale(1);

function hideCard() {
  cardVisible = false;
  card.style.display = 'none';
}
function showCard(p) {
  const rows = [
    ['类型', p.type],
    ['公转周期', Math.round(p.T) + ' 模拟秒'],
    ['轨道半径', p.R + ' 单位'],
    ['卫星数', String(p.moonPivots.length)],
  ];
  card.innerHTML = '<div style="font-weight:bold;font-size:13px;margin-bottom:4px;">' + p.name + ' · ' + p.zh + '</div>' +
    rows.map((r) => '<div><span style="color:#8fa5c5;">' + r[0] + '</span>:' + r[1] + '</div>').join('');
  card.style.display = 'block';
  cardVisible = true;
}

function select(name) {
  if (name === null) {
    selectedPlanet = null;
    hideCard();
    selRing.visible = false;
    return;
  }
  const p = PLANETS.find((x) => x.name === name);
  if (!p) return;
  selectedPlanet = p.name;
  showCard(p);
  selRing.visible = true;
}

// --- 点击判定:pickTargets 屏幕投影距离(点空白不选中,NC04) --------------------
canvas.addEventListener('click', (ev) => {
  const x = ev.clientX;
  const y = ev.clientY;
  let best = null;
  let bestD = Infinity;
  for (const p of PLANETS) {
    const d = Math.hypot(p.screen.screenX - x, p.screen.screenY - y);
    const grab = Math.max(p.screen.screenRadius, 12);
    if (d <= grab && d < bestD) { best = p; bestD = d; }
  }
  select(best ? best.name : null);
});

// --- __bench 契约 ---------------------------------------------------------------
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 320; probeCanvas.height = 180;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
let probePrev = null;

function getFps() {
  const n = frameStamps.length;
  if (n < 2) return 0;
  const span = (frameStamps[n - 1] - frameStamps[0]) / 1000;
  return span > 0 ? (n - 1) / span : 0;
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    planetCount: PLANETS.length,
    moonCount: MOON_COUNT,
    asteroidCount: BELT_COUNT,
    ringedPlanetCount: RINGED_COUNT,
    timeScale,
    simulationTime: +simTime.toFixed(4),
    selectedPlanet,
    planets: PLANETS.map((p) => ({
      name: p.name,
      orbitRadius: p.R,
      orbitAngle: +orbitAngle(p).toFixed(6),
    })),
    pickTargets: PLANETS.map((p) => ({
      name: p.screen.name,
      screenX: +p.screen.screenX.toFixed(2),
      screenY: +p.screen.screenY.toFixed(2),
      screenRadius: +p.screen.screenRadius.toFixed(2),
    })),
    infoCard: {
      visible: cardVisible,
      name: cardVisible ? (selectedPlanet || '') : '',
      fieldCount: cardVisible ? 4 : 0,
    },
    fps: +getFps().toFixed(1),
    epoch,
  }),
  reset: () => doReset(),
  // _probe:自检辅助。真实渲染一帧 → 降采样像素统计:全屏亮像素比、与上次调用的
  // 平均亮度差(运动证据)、各行星屏幕区域(±2.5×screenRadius)亮像素比。
  _probe: () => {
    renderer.render(scene, camera);
    probeCtx.drawImage(canvas, 0, 0, 320, 180);
    const img = probeCtx.getImageData(0, 0, 320, 180).data;
    const n = 320 * 180;
    const lum = new Uint8Array(n);
    let lit = 0;
    for (let i = 0; i < n; i++) {
      const l = (img[i * 4] * 0.299 + img[i * 4 + 1] * 0.587 + img[i * 4 + 2] * 0.114) | 0;
      lum[i] = l;
      if (l > 18) lit += 1;
    }
    let diff = 0;
    if (probePrev) {
      for (let i = 0; i < n; i++) diff += Math.abs(lum[i] - probePrev[i]);
      diff = diff / (n * 255);
    }
    probePrev = lum;
    const sx = 320 / window.innerWidth;
    const sy = 180 / window.innerHeight;
    const regions = PLANETS.map((p) => {
      const cx = p.screen.screenX * sx;
      const cy = p.screen.screenY * sy;
      const half = Math.max(6, p.screen.screenRadius * 2.5 * sx);
      const x0 = Math.max(0, Math.round(cx - half));
      const x1 = Math.min(319, Math.round(cx + half));
      const y0 = Math.max(0, Math.round(cy - half));
      const y1 = Math.min(179, Math.round(cy + half));
      let area = 0;
      let litR = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          area += 1;
          if (lum[yy * 320 + xx] > 18) litR += 1;
        }
      }
      return area > 0 ? +(litR / area).toFixed(4) : 0;
    });
    return { lit: +(lit / n).toFixed(4), diff: +diff.toFixed(5), regions };
  },
};

function doReset() {
  simTime = 0;
  timeScale = 1;
  selectedPlanet = null;
  hideCard();
  selRing.visible = false;
  epoch += 1;
  setTimeScale(1); // 档位高亮回 1x
}

// --- 主循环:一切运动由 simTime 推导(变速即时平滑,reset 精确归位) --------------
const projV = new THREE.Vector3();
let last = performance.now();
let readySet = false;

function tick(now) {
  const dtReal = Math.min(Math.max((now - last) / 1000, 0), 0.25); // 后台节流保护
  last = now;
  simTime += dtReal * timeScale;

  // 行星位置 / 自转 / 卫星
  for (const p of PLANETS) {
    const th = orbitAngle(p);
    p.anchor.position.set(Math.cos(th) * p.R, 0, Math.sin(th) * p.R);
    p.mesh.rotation.y = (TWO_PI * simTime) / p.spinT;
    for (const mp of p.moonPivots) mp.pivot.rotation.y = (TWO_PI * simTime) / mp.def.T;
  }
  // 小行星带(子环分层角速度)
  for (const sb of beltSubs) sb.g.rotation.y = (TWO_PI * simTime * sb.factor) / BELT_T;

  // pickTargets:屏幕投影(每帧更新)
  const focal = (window.innerHeight / 2) / Math.tan(camera.fov * DEG / 2);
  for (const p of PLANETS) {
    projV.copy(p.anchor.position).project(camera);
    p.screen.screenX = (projV.x + 1) / 2 * window.innerWidth;
    p.screen.screenY = (1 - projV.y) / 2 * window.innerHeight;
    const dist = camera.position.distanceTo(p.anchor.position);
    p.screen.screenRadius = Math.max((p.size / dist) * focal, MIN_PICK_RADIUS);
  }

  // 选中高亮:跟随行星、面向相机、轻微脉动
  if (selectedPlanet) {
    const p = PLANETS.find((x) => x.name === selectedPlanet);
    if (p) {
      selRing.position.copy(p.anchor.position);
      selRing.quaternion.copy(camera.quaternion);
      // 1.6×:主环 1.6–1.86×r、外环 1.98–2.08×r,保证紧裁剪区域(±2×screenRadius)内仍可见
      const s = p.size * 1.6 * (1 + 0.05 * Math.sin(now * 0.004));
      selRing.scale.set(s, s, s);
    }
  }

  renderer.render(scene, camera);

  frameStamps.push(now);
  const cutoff = now - 2000;
  while (frameStamps.length > 0 && frameStamps[0] < cutoff) frameStamps.shift();

  if (!readySet) {
    readySet = true;
    window.__appReady = true; // 首帧渲染完成
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
