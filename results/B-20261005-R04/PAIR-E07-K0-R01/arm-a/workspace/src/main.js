// ============================================================================
// E07 霓虹夜城 (Neon Night City) — three.js r186 — Arm A / K0
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(): {buildingCount,carCount,rainParticleCount,
//                                       fogEnabled,fps}, reset(): void }
// 场景构成(全部程序化生成,批量绘制,单帧 draw call ≈ 30):
//   楼群   — 单个 InstancedMesh(≈250 栋,街区网格布局,高度/footprint 变化)
//   窗阵   — 单个 THREE.Points(每栋楼四立面矩阵窗格,暖/冷色随机点亮,总数远超 2000)
//   车流   — 单个 THREE.Points(4 条街道双向车道,头灯暖白/尾灯红,带渐暗短拖尾)
//   雨     — 单个 THREE.LineSegments(2200 条细线循环下落,落地回顶部重生)
//   雾     — THREE.Fog;开关通过 near/far 大幅改写实现(无 shader 重编译,立即生效)
//   霓虹   — 3~4 块文字招牌(CanvasTexture 程序纹理)+ 高塔灯带呼吸 + 航空闪灯,
//            色相:品红/青/橙黄/绿 ≥3 种
// reset:内存内全量重建(种子化 RNG 保证初始布局/计数完全复现),禁止整页刷新。
// fps:最近 60 帧真实帧间隔滚动平均,非常数。
// ============================================================================

import * as THREE from 'three';

// ---------- 确定性随机(reset 后完全复现初始布局) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITY_SEED = 20261007;

// ---------- 渲染器 / 场景 / 相机(低角度仰视构图) ----------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060e); // 近黑夜空

const FOG_NEAR = 45;
const FOG_FAR = 205;
const fog = new THREE.Fog(0x0e1630, FOG_NEAR, FOG_FAR); // 雾色偏亮的蓝灰城光:开雾远处成雾墙,关雾远处楼群立即变暗、窗点变亮,对比肉眼可辨
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 900);
camera.position.set(0, 7, 78);       // 街面低机位
camera.lookAt(0, 18, -10);           // 微仰视:地平线约在画面下 1/3,上方留给楼群与夜空

// ---------- 光照(夜色:冷色半球光 + 微弱月光,楼体呈暗色体块) ----------
scene.add(new THREE.HemisphereLight(0x2a3566, 0x05060a, 1.15));
const moonLight = new THREE.DirectionalLight(0x8fa0d0, 0.6);
moonLight.position.set(-60, 120, 40);
scene.add(moonLight);

// ---------- 共享材质/几何(跨 reset 复用,避免重复编译与泄漏) ----------
const unitBox = new THREE.BoxGeometry(1, 1, 1);
unitBox.userData.shared = true;
const stripGeo = new THREE.BoxGeometry(0.35, 1, 0.35);
stripGeo.userData.shared = true;
const signGeo = new THREE.PlaneGeometry(8.5, 3.2);
signGeo.userData.shared = true;
const beaconGeo = new THREE.SphereGeometry(0.55, 8, 8);
beaconGeo.userData.shared = true;

const buildingMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // 逐实例暗色 variant
const windowMat = new THREE.PointsMaterial({
  size: 1.05, sizeAttenuation: true, vertexColors: true,
  transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
});
const carMat = new THREE.PointsMaterial({
  size: 1.9, sizeAttenuation: true, vertexColors: true,
  transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
});
const lampMat = new THREE.PointsMaterial({
  size: 1.3, sizeAttenuation: true, vertexColors: true,
  transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
});
const rainMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.4,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const groundMat = new THREE.MeshBasicMaterial({ color: 0x07080d });
const roadMatX = new THREE.MeshBasicMaterial({ color: 0x161a26 });
const roadMatZ = new THREE.MeshBasicMaterial({ color: 0x12161f });
const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3050 });
const starMat = new THREE.PointsMaterial({
  size: 1.6, sizeAttenuation: false, color: 0xbfc8e8,
  transparent: true, opacity: 0.9, fog: false, depthWrite: false,
});

// ---------- 静态环境:地面 / 主干道 / 星空(reset 不重建) ----------
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const mkRoad = (w, l, x, z, mat, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    scene.add(m);
  };
  // 2 条横穿画面的东西向主干道 + 2 条网格化南北向街道(车流)
  mkRoad(360, 9, 0, 22, roadMatX, 0.03);
  mkRoad(360, 9, 0, 40, roadMatX, 0.03);
  mkRoad(9, 330, -41, -100, roadMatZ, 0.05);
  mkRoad(9, 330, 41, -100, roadMatZ, 0.05);

  // 街灯:沿街道的暖色点光(点缀街道层,静态单 Points)
  {
    const lpos = [];
    const lcol = [];
    const lc = new THREE.Color();
    const addLamp = (x, y, z, b) => {
      lpos.push(x, y, z);
      lc.setHSL(0.09, 0.7, 0.5 * b + 0.12);
      lcol.push(lc.r, lc.g, lc.b);
    };
    for (let i = 0; i < 21; i++) {
      const x = -160 + i * 16;
      addLamp(x, 5.6, 22 + (i % 2 ? 5.4 : -5.4), 0.75 + (i % 3) * 0.12);
      addLamp(x + 8, 5.6, 40 + (i % 2 ? -5.4 : 5.4), 0.75 + ((i + 1) % 3) * 0.12);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 15; i++) {
        addLamp(sx * 41 + (i % 2 ? 5.4 : -5.4), 5.6, -215 + i * 18, 0.7 + (i % 3) * 0.12);
      }
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lpos), 3));
    lgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lcol), 3));
    const lamps = new THREE.Points(lgeo, lampMat);
    lamps.frustumCulled = false;
    scene.add(lamps);
  }

  const starN = 380;
  const starPos = new Float32Array(starN * 3);
  const srng = mulberry32(777);
  for (let i = 0; i < starN; i++) {
    const az = srng() * Math.PI * 2;
    const el = Math.asin(srng() * 0.95 + 0.05); // 避免贴地平线
    const r = 640;
    starPos[i * 3] = Math.cos(el) * Math.cos(az) * r;
    starPos[i * 3 + 1] = Math.sin(el) * r * 0.85 + 25;
    starPos[i * 3 + 2] = Math.cos(el) * Math.sin(az) * r;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);
}

// ---------- 可重建世界(楼/窗/霓虹/车/雨) ----------
let worldGroup = null;
let carUpdate = null;
let rainUpdate = null;
let neonAnims = [];   // 呼吸/闪烁动画项
let disposables = []; // 每次重建需释放的 GPU 资源(纹理/材质/几何)
const counts = { buildingCount: 0, carCount: 0, rainParticleCount: 0 };
let time = 0;
let fogEnabled = true;

// --- 招牌纹理:程序生成(Canvas 2D → CanvasTexture,霓虹灯管风格) ---
function makeSignTexture(text, hue) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(5,6,12,0.92)';
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = `hsla(${hue}, 95%, 60%, 0.9)`;
  ctx.lineWidth = 5;
  ctx.strokeRect(7, 7, 242, 82);
  ctx.font = 'bold 46px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
  ctx.shadowBlur = 22;
  ctx.fillStyle = `hsl(${hue}, 100%, 80%)`;
  ctx.fillText(text, 128, 52); // 画两遍增强辉光
  ctx.fillText(text, 128, 52);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --- 楼群 + 窗阵 + 霓虹 ---
function buildCity(rng, group) {
  // 楼群数据:网格街区,2x2 地块/街区,留 10% 空地,少量双塔
  const buildings = [];
  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -6; gz <= 2; gz++) {
      const bx = gx * 30, bz = gz * 28 - 62;
      for (let lx = 0; lx < 2; lx++) {
        for (let lz = 0; lz < 2; lz++) {
          if (rng() < 0.1) continue; // 街区内空地
          const x = bx + (lx - 0.5) * 14 + (rng() - 0.5) * 4;
          const z = bz + (lz - 0.5) * 13 + (rng() - 0.5) * 4;
          let h;
          if (rng() < 0.06) h = 44 + rng() * 38;            // 少量高塔
          else h = 9 + Math.pow(rng(), 1.5) * 30;            // 一般楼(偏矮)
          const w = 6.5 + rng() * 5;
          const d = 6.5 + rng() * 5;
          buildings.push({ x, z, w, h, d });
          if (rng() < 0.06) {
            buildings.push({ x: x + 4, z: z + 3, w: w * 0.55, h: 18 + rng() * 30, d: d * 0.55 });
          }
        }
      }
    }
  }
  while (buildings.length < 212) { // 保底补足,确保 ≥200
    const x = (rng() - 0.5) * 190;
    if (Math.abs(x - 41) < 7 || Math.abs(x + 41) < 7) continue; // 避让南北街道
    buildings.push({ x, z: -25 - rng() * 190, w: 6 + rng() * 5, h: 10 + rng() * 32, d: 6 + rng() * 5 });
  }
  counts.buildingCount = buildings.length;

  // 楼体:单个 InstancedMesh,一次绘制
  const im = new THREE.InstancedMesh(unitBox, buildingMat, buildings.length);
  im.frustumCulled = false;
  const mat4 = new THREE.Matrix4();
  const col = new THREE.Color();
  buildings.forEach((b, i) => {
    mat4.makeScale(b.w, b.h, b.d);
    mat4.setPosition(b.x, b.h / 2, b.z);
    im.setMatrixAt(i, mat4);
    col.setHSL(0.56 + rng() * 0.08, 0.2 + rng() * 0.18, 0.045 + rng() * 0.055);
    im.setColorAt(i, col);
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  group.add(im);

  // 发光窗阵:全部楼所有立面矩阵排布,单 Points 提交
  const wpos = [];
  const wcol = [];
  const wc = new THREE.Color();
  const pushWindow = (x, y, z) => {
    wpos.push(x, y, z);
    const warm = rng() < 0.68;
    if (warm) wc.setHSL(0.085 + rng() * 0.03, 0.72, 0.5 + rng() * 0.25);
    else wc.setHSL(0.56 + rng() * 0.04, 0.5, 0.5 + rng() * 0.25);
    wcol.push(wc.r, wc.g, wc.b);
  };
  for (const b of buildings) {
    const litRatio = 0.35 + rng() * 0.4; // 每栋楼点亮率有随机性
    const floors = Math.max(2, Math.floor((b.h - 3) / 2.3));
    const yStep = (b.h - 3.6) / floors;
    const colsX = Math.max(2, Math.floor((b.w - 1.4) / 1.8));
    const colsZ = Math.max(2, Math.floor((b.d - 1.4) / 1.8));
    for (let f = 0; f < floors; f++) {
      const y = 2.2 + (f + 0.5) * yStep;
      for (let c = 0; c < colsX; c++) {
        const x = b.x - b.w / 2 + (c + 0.5) * (b.w / colsX);
        if (rng() < litRatio) pushWindow(x, y, b.z + b.d / 2 + 0.12);
        if (rng() < litRatio) pushWindow(x, y, b.z - b.d / 2 - 0.12);
      }
      for (let c = 0; c < colsZ; c++) {
        const z = b.z - b.d / 2 + (c + 0.5) * (b.d / colsZ);
        if (rng() < litRatio) pushWindow(b.x + b.w / 2 + 0.12, y, z);
        if (rng() < litRatio) pushWindow(b.x - b.w / 2 - 0.12, y, z);
      }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wpos), 3));
  wgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(wcol), 3));
  const windows = new THREE.Points(wgeo, windowMat);
  windows.frustumCulled = false;
  group.add(windows);
  disposables.push(wgeo);

  // 霓虹招牌:选靠近相机的楼,面朝 +Z 挂文字招牌(品红/青/橙黄/绿 ≥3 色相)
  const NEON = [
    { text: 'NEON', hue: 315 },
    { text: '24H', hue: 190 },
    { text: 'OPEN', hue: 38 },
    { text: 'HOTEL', hue: 135 },
  ];
  let pool = buildings.filter((b) => b.z > -58 && b.z < 6 && Math.abs(b.x) > 9 && Math.abs(b.x) < 40 && b.h >= 15 && b.w >= 7);
  if (pool.length < NEON.length) pool = buildings.filter((b) => b.z > -70 && b.h >= 12);
  pool.sort((a, b) => b.z - a.z);
  for (let si = 0; si < NEON.length && si < pool.length; si++) {
    const b = pool[si];
    const def = NEON[si];
    const tex = makeSignTexture(def.text, def.hue);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const mesh = new THREE.Mesh(signGeo, mat);
    mesh.position.set(b.x, Math.min(b.h - 3.5, 8 + (si % 3) * 4.5), b.z + b.d / 2 + 0.4);
    group.add(mesh);
    disposables.push(tex, mat);
    neonAnims.push({ type: 'sign', mat, phase: si * 1.7, speed: 1.3 + si * 0.5, flicker: si === 1 });
  }

  // 高塔灯带(四角垂直灯条,呼吸)+ 楼顶航空闪灯
  const towers = buildings.slice().sort((a, b) => b.h - a.h).slice(0, 3);
  const stripHues = [318, 187, 30];
  towers.forEach((b, ti) => {
    const base = new THREE.Color().setHSL(stripHues[ti % 3] / 360, 1, 0.6);
    const mat = new THREE.MeshBasicMaterial({ color: base.clone() });
    disposables.push(mat);
    const hw = b.w / 2 + 0.18, hd = b.d / 2 + 0.18;
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        const s = new THREE.Mesh(stripGeo, mat);
        s.scale.y = b.h * 0.92;
        s.position.set(b.x + sx * hw, b.h * 0.46, b.z + sz * hd);
        group.add(s);
      }
    }
    neonAnims.push({ type: 'breathe', mat, base, phase: ti * 2.1, speed: 0.9 + ti * 0.35 });
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(b.x, b.h + 0.9, b.z);
    group.add(beacon);
    neonAnims.push({ type: 'blink', mesh: beacon, phase: ti * 0.9, speed: 2.4 });
  });
}

// --- 车流:4 条街道双向车道,单 Points(每车 3 点:车头+渐暗拖尾) ---
function buildCars(rng, group) {
  const roadsDef = [
    { axis: 'x', at: 22, lo: -170, hi: 170, per: 26, baseSpeed: 15 },
    { axis: 'x', at: 40, lo: -170, hi: 170, per: 26, baseSpeed: 15 },
    { axis: 'z', at: -41, lo: -236, hi: 46, per: 16, baseSpeed: 11 },
    { axis: 'z', at: 41, lo: -236, hi: 46, per: 16, baseSpeed: 11 },
  ];
  const cars = [];
  for (const rd of roadsDef) {
    for (let i = 0; i < rd.per; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const along = rd.lo + rng() * (rd.hi - rd.lo);
      const p = rd.axis === 'x'
        ? { x: along, y: 0.8, z: rd.at + dir * 2.1 }
        : { x: rd.at + dir * 2.1, y: 0.8, z: along };
      cars.push({ axis: rd.axis, dir, speed: rd.baseSpeed + rng() * 9, p, lo: rd.lo, hi: rd.hi });
    }
  }
  counts.carCount = cars.length;

  const n = cars.length * 4;
  const pos = new Float32Array(n * 3);
  const colr = new Float32Array(n * 3);
  const head = new THREE.Color();
  const bright = [1, 0.5, 0.28, 0.14];
  cars.forEach((car, i) => {
    // 同向车道同色:朝向镜头/正向 = 暖白头灯,反向 = 红色尾灯
    if (car.dir > 0) head.setHSL(0.13, 0.55, 0.72);
    else head.setHSL(0.015, 0.95, 0.55);
    for (let k = 0; k < 4; k++) {
      const j = (i * 4 + k) * 3;
      colr[j] = head.r * bright[k];
      colr[j + 1] = head.g * bright[k];
      colr[j + 2] = head.b * bright[k];
    }
  });
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  const points = new THREE.Points(geo, carMat);
  points.frustumCulled = false;
  group.add(points);
  disposables.push(geo);

  carUpdate = (dt) => {
    const a = posAttr.array;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.axis === 'x') {
        car.p.x += car.dir * car.speed * dt;
        if (car.p.x > car.hi) car.p.x = car.lo + (car.p.x - car.hi);
        else if (car.p.x < car.lo) car.p.x = car.hi - (car.lo - car.p.x);
      } else {
        car.p.z += car.dir * car.speed * dt;
        if (car.p.z > car.hi) car.p.z = car.lo + (car.p.z - car.hi);
        else if (car.p.z < car.lo) car.p.z = car.hi - (car.lo - car.p.z);
      }
      const dx = car.axis === 'x' ? car.dir : 0;
      const dz = car.axis === 'z' ? car.dir : 0;
      for (let k = 0; k < 4; k++) {
        const j = (i * 4 + k) * 3;
        a[j] = car.p.x - dx * k * 2.5;
        a[j + 1] = car.p.y;
        a[j + 2] = car.p.z - dz * k * 2.5;
      }
    }
    posAttr.needsUpdate = true;
  };
}

// --- 雨:2200 条细线粒子,循环下落,落地回顶部;单 LineSegments ---
function buildRain(rng, group) {
  const n = 2200;
  counts.rainParticleCount = n;
  const pos = new Float32Array(n * 2 * 3);
  const colr = new Float32Array(n * 2 * 3);
  const drops = [];
  for (let i = 0; i < n; i++) {
    const d = {
      x: -135 + rng() * 270,
      y: rng() * 90,
      z: -175 + rng() * 223, // z ∈ [-175, 48]
      v: 36 + rng() * 26,
      len: 1.5 + rng() * 0.9,
      b: 0.25 + rng() * 0.4,
    };
    drops.push(d);
    const j = i * 6;
    colr[j] = 0.62 * d.b; colr[j + 1] = 0.72 * d.b; colr[j + 2] = 0.95 * d.b; // 下端亮
    colr[j + 3] = 0.62 * d.b * 0.25; colr[j + 4] = 0.72 * d.b * 0.25; colr[j + 5] = 0.95 * d.b * 0.25; // 上端暗
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  const lines = new THREE.LineSegments(geo, rainMat);
  lines.frustumCulled = false;
  group.add(lines);
  disposables.push(geo);

  rainUpdate = (dt) => {
    const a = posAttr.array;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.y -= d.v * dt;
      d.x -= 2.2 * dt; // 微风斜落
      if (d.y < 0.4) d.y += 90; // 落地 → 顶部重生
      if (d.x < -140) d.x += 270;
      const j = i * 6;
      a[j] = d.x; a[j + 1] = d.y; a[j + 2] = d.z;
      a[j + 3] = d.x + 0.18; a[j + 4] = d.y + d.len; a[j + 5] = d.z;
    }
    posAttr.needsUpdate = true;
  };
}

// --- 霓虹动画(呼吸/闪灯/招牌明暗) ---
function updateNeon(t) {
  for (const a of neonAnims) {
    if (a.type === 'breathe') {
      const f = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * a.speed + a.phase));
      a.mat.color.copy(a.base).multiplyScalar(f);
    } else if (a.type === 'blink') {
      a.mesh.visible = Math.sin(t * a.speed + a.phase) > 0.15;
    } else if (a.type === 'sign') {
      if (a.flicker) {
        const g = Math.sin(t * 11.3 + a.phase) + Math.sin(t * 17.7 + a.phase * 2);
        a.mat.opacity = g > 0.4 ? 1 : 0.35;
      } else {
        a.mat.opacity = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * a.speed + a.phase));
      }
    }
  }
}

// --- 雾开关:改写 near/far(无重编译,画面立即同步) ---
function applyFog() {
  fog.near = fogEnabled ? FOG_NEAR : 1e7;
  fog.far = fogEnabled ? FOG_FAR : 2e7;
}

// --- 全量重建(reset 语义:种子化,布局/计数/相位完全复现) ---
function resetWorld() {
  if (worldGroup) {
    worldGroup.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    });
    scene.remove(worldGroup);
  }
  for (const d of disposables) {
    try { d.dispose(); } catch { /* 忽略单资源释放失败 */ }
  }
  disposables.length = 0;
  neonAnims.length = 0;
  carUpdate = null;
  rainUpdate = null;
  time = 0;
  fogEnabled = true;
  applyFog();
  const rng = mulberry32(CITY_SEED);
  worldGroup = new THREE.Group();
  buildCity(rng, worldGroup);
  buildCars(rng, worldGroup);
  buildRain(rng, worldGroup);
  scene.add(worldGroup);
  if (typeof fogBtn !== 'undefined' && fogBtn) fogBtn.textContent = fogEnabled ? '雾: 开' : '雾: 关';
}

// ---------- UI 控件(data-ui 与 data-bench 双属性,画布右下角固定,hover/active 反馈) ----------
const uiStyle = document.createElement('style');
uiStyle.textContent = [
  'button[data-ui] { position:fixed; right:12px; z-index:9999; padding:6px 14px;',
  '  font:13px/1.4 system-ui, sans-serif; color:#dfe8ff; background:rgba(16,19,31,0.8);',
  '  border:1px solid #3a4468; border-radius:6px; cursor:pointer; }',
  'button[data-ui]:hover { filter:brightness(1.45); border-color:#7fd0ff; }',
  'button[data-ui]:active { transform:translateY(1px); filter:brightness(0.85); }',
].join('\n');
document.head.appendChild(uiStyle);

const fogBtn = document.createElement('button');
fogBtn.textContent = '雾: 开';
fogBtn.setAttribute('data-ui', 'toggle-fog');
fogBtn.setAttribute('data-bench', 'toggle-fog');
fogBtn.style.bottom = '46px';
fogBtn.addEventListener('click', () => {
  fogEnabled = !fogEnabled;
  applyFog();
  fogBtn.textContent = fogEnabled ? '雾: 开' : '雾: 关';
});
document.body.appendChild(fogBtn);

const resetBtn = document.createElement('button');
resetBtn.textContent = '重置';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('data-bench', 'reset');
resetBtn.style.bottom = '12px';
resetBtn.addEventListener('click', () => resetWorld());
document.body.appendChild(resetBtn);

// ---------- bench 契约 ----------
let fpsAvg = 0;
window.__bench = {
  getState: () => ({
    buildingCount: counts.buildingCount,
    carCount: counts.carCount,
    rainParticleCount: counts.rainParticleCount,
    fogEnabled,
    fps: fpsAvg,
  }),
  reset: () => resetWorld(),
};

// ---------- 主循环:fps 取最近 60 帧真实帧间隔滚动平均 ----------
const frameDeltas = new Float64Array(60);
let fdIndex = 0;
let fdCount = 0;
let prevMs = 0;
let ready = false;

function tick(now) {
  requestAnimationFrame(tick);
  const dMs = prevMs > 0 ? Math.min(now - prevMs, 250) : 16.7;
  prevMs = now;
  frameDeltas[fdIndex] = dMs;
  fdIndex = (fdIndex + 1) % 60;
  if (fdCount < 60) fdCount += 1;
  let sum = 0;
  for (let i = 0; i < fdCount; i++) sum += frameDeltas[i];
  fpsAvg = fdCount >= 30 ? Math.round(((fdCount * 1000) / sum) * 10) / 10 : 0;

  const dt = dMs / 1000;
  time += dt;
  if (carUpdate) carUpdate(dt);
  if (rainUpdate) rainUpdate(dt);
  updateNeon(time);
  renderer.render(scene, camera);
  if (!ready) {
    ready = true;
    window.__appReady = true; // 首帧渲染完成
  }
}

// ---------- 启动:构建城市并进入完整运行状态(无需用户操作) ----------
resetWorld();
requestAnimationFrame(tick);

// ---------- 视口自适应 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
