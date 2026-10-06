// ============================================================================
// E08 深海鱼群 — Deep Sea Fish School (three.js r186)
// ----------------------------------------------------------------------------
// 本文件只负责渲染与输入转发;全部模拟动力学在 src/sim.js(纯逻辑,可被 Node
// 确定性回放自检)。场景要点(对齐 brief.md / spec.json):
//   * 96 条程序化鱼(截面放样身体 + 尾鳍/背鳍,顶点级摆尾形变),逐帧 boids;
//   * 指针射线 3D 距离触发惊散 scatter,fear 衰减后重聚;
//   * 画布单击投喂(UI 控件点击不投喂),进食限速,8s 超时;
//   * 460 悬浮颗粒(双层 Points,缓漂),深海渐变穹顶 + 顶部光柱 + 指数雾;
//   * 页面契约:window.__appReady / window.__bench { getState, reset }。
// ============================================================================

import * as THREE from 'three';
import { createSim, FISH_COUNT, PLANKTON_COUNT } from './sim.js';

// --- 模拟核心(含判定相机;渲染与判定同源) ---
const sim = createSim();

// ---------------------------------------------------------------------------
// 渲染器 / 场景 / 相机
// ---------------------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x083042, 0.02); // 深海青雾,提供纵深衰减

const camera = sim.camera; // 渲染与指针判定使用同一相机

// ---------------------------------------------------------------------------
// 光照:顶部主光(水下体积感)+ 半球环境 + 底部补光
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x3fa7c9, 0x03141d, 1.0));
const keyLight = new THREE.DirectionalLight(0xbfe8f5, 2.2);
keyLight.position.set(4, 18, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x2b6f8a, 0.55);
fillLight.position.set(-6, -8, 4);
scene.add(fillLight);

// ---------------------------------------------------------------------------
// 环境:渐变穹顶(上亮下暗)+ 顶部光柱
// ---------------------------------------------------------------------------
{
  const geo = new THREE.SphereGeometry(70, 24, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x0f5468), mid = new THREE.Color(0x063040), bot = new THREE.Color(0x020d14);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(pos.getY(i) / 70, -1, 1);
    if (t >= 0) c.copy(mid).lerp(top, Math.pow(t, 0.7));
    else c.copy(mid).lerp(bot, Math.pow(-t, 0.6));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false,
  }));
  scene.add(dome);
}

const shafts = [];
{
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0x9fe0ef, transparent: true, opacity: 0.06,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const defs = [
    { x: -6, z: -3, r: 3.4, tilt: 0.10, op: 0.07 },
    { x: 1.5, z: 1, r: 2.6, tilt: -0.07, op: 0.055 },
    { x: 8, z: -2, r: 3.0, tilt: 0.13, op: 0.05 },
  ];
  for (const d of defs) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(d.r, 17, 20, 1, true), shaftMat.clone());
    m.material.opacity = d.op;
    m.position.set(d.x, 9.5, d.z);
    m.rotation.z = d.tilt;
    scene.add(m);
    shafts.push(m);
  }
}

// ---------------------------------------------------------------------------
// 悬浮颗粒:双层 Points(sim 计算位置,这里只上传缓冲)
// ---------------------------------------------------------------------------
const planktonPoints = [];
for (const layer of sim.planktonLayers) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(layer.cur, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fd8e8, size: layer.size, sizeAttenuation: true,
    transparent: true, opacity: layer.opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  planktonPoints.push(geo);
}

// ---------------------------------------------------------------------------
// 程序化鱼体:截面放样身体(侧扁)+ 鼻尖 + 尾鳍扇 + 背鳍,索引几何
// 轴向:鱼头朝 +Z(配合 Object3D.lookAt),横向摆尾沿局部 X
// ---------------------------------------------------------------------------
function buildFishGeometry() {
  const positions = [];
  const colors = [];
  const swayW = []; // 每顶点摆尾权重:0 鼻尖 → 1 尾鳍梢
  const idx = [];

  const cBack = [0.20, 0.34, 0.42];   // 背部暗青
  const cBelly = [0.80, 0.86, 0.92];  // 腹部银白
  const cFin = [0.52, 0.62, 0.68];    // 鳍

  const L = 1.17, zNose = 0.55;
  const prof = [ // [u 沿体轴 0..1, 截面半径]
    [0.00, 0.022], [0.10, 0.078], [0.28, 0.132], [0.50, 0.150],
    [0.72, 0.112], [0.90, 0.052], [1.00, 0.028],
  ];
  const RAD = 8;
  const rings = [];
  for (const [u, r] of prof) {
    const z = zNose - L * u;
    const ring = [];
    const w = 0.06 + 0.9 * Math.pow(u, 1.5);
    for (let i = 0; i <= RAD; i++) {
      const a = (i / RAD) * Math.PI * 2;
      const x = Math.cos(a) * r * 0.62;
      const y = Math.sin(a) * r * 1.30;
      ring.push(positions.length / 3);
      positions.push(x, y, z);
      const t = THREE.MathUtils.clamp(y / (r * 1.30) * 0.5 + 0.5, 0, 1);
      colors.push(
        cBelly[0] + (cBack[0] - cBelly[0]) * t,
        cBelly[1] + (cBack[1] - cBelly[1]) * t,
        cBelly[2] + (cBack[2] - cBelly[2]) * t,
      );
      swayW.push(w);
    }
    rings.push(ring);
  }
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < RAD; i++) {
      const a = rings[s][i], b = rings[s][i + 1], c = rings[s + 1][i], d = rings[s + 1][i + 1];
      idx.push(a, c, b, b, c, d);
    }
  }
  // 鼻尖封口
  const tipIdx = positions.length / 3;
  positions.push(0, 0.004, zNose + 0.07);
  colors.push(cBelly[0] * 0.9, cBelly[1] * 0.9, cBelly[2] * 0.95);
  swayW.push(0.02);
  for (let i = 0; i < RAD; i++) idx.push(rings[0][i], tipIdx, rings[0][i + 1]);

  // 尾鳍:竖直新月形扇面(z-y 平面,x=0)
  {
    const cz = -0.56, cy = 0.0;
    const rim = [[-0.97, 0.36], [-0.74, 0.15], [-0.71, 0.0], [-0.74, -0.15], [-0.97, -0.36]];
    const cIdx = positions.length / 3;
    positions.push(0, cy, cz);
    colors.push(...cFin);
    swayW.push(1.0);
    const rimIdx = [];
    for (const [z, y] of rim) {
      rimIdx.push(positions.length / 3);
      positions.push(0, y, z);
      colors.push(...cFin);
      swayW.push(1.0);
    }
    for (let i = 0; i < rimIdx.length - 1; i++) idx.push(cIdx, rimIdx[i], rimIdx[i + 1]);
  }
  // 背鳍:小三角帆
  {
    const quad = [[0.17, 0.06], [0.35, -0.13], [0.15, -0.30], [0.105, -0.40]]; // [y, z]
    const qi = quad.map(([y, z]) => {
      const i = positions.length / 3;
      positions.push(0, y, z);
      colors.push(...cFin);
      swayW.push(0.7);
      return i;
    });
    idx.push(qi[0], qi[1], qi[2], qi[0], qi[2], qi[3]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, swayW: new Float32Array(swayW) };
}

const fishMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.45, metalness: 0.25, side: THREE.DoubleSide,
});

const { geo: fishGeoProto, swayW } = buildFishGeometry();
const vertCount = fishGeoProto.attributes.position.count;
const basePos = fishGeoProto.attributes.position.array; // 基准位置(局部)

const fishGroup = new THREE.Group();
scene.add(fishGroup);
const wagPhases = new Float32Array(FISH_COUNT);
for (let i = 0; i < FISH_COUNT; i++) wagPhases[i] = Math.random() * Math.PI * 2;
for (let i = 0; i < FISH_COUNT; i++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(basePos.slice(), 3));
  g.setAttribute('color', fishGeoProto.attributes.color);
  g.setIndex(fishGeoProto.index);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, fishMat);
  mesh.scale.setScalar(1.0 + (Math.random() - 0.5) * 0.5);
  fishGroup.add(mesh);
  sim.fishes[i].mesh = mesh; // 渲染句柄挂回 sim 鱼(sim 不读它)
}

// ---------------------------------------------------------------------------
// 食物视觉(粒子球 + 点光源;生命周期完全由 sim.food 驱动)
// ---------------------------------------------------------------------------
const foodGeo = new THREE.SphereGeometry(0.16, 10, 8);
const foodMat = new THREE.MeshBasicMaterial({ color: 0xffd98a, fog: false });
let foodGroup = null;
let foodLight = null;

function syncFoodVisual() {
  if (sim.food.active && !foodGroup) {
    foodGroup = new THREE.Group();
    for (let i = 0; i < sim.food.pieces.length; i++) {
      foodGroup.add(new THREE.Mesh(foodGeo, foodMat));
    }
    foodLight = new THREE.PointLight(0xffc36b, 90, 22, 2);
    scene.add(foodGroup, foodLight);
  } else if (!sim.food.active && foodGroup) {
    scene.remove(foodGroup, foodLight);
    foodGroup = null;
    foodLight = null;
  }
  if (foodGroup) {
    for (let i = 0; i < sim.food.pieces.length; i++) {
      const p = sim.food.pieces[i];
      foodGroup.children[i].position.copy(p.pos);
      foodGroup.children[i].visible = !p.eaten;
    }
    foodLight.position.copy(sim.food.centroid);
  }
}

// ---------------------------------------------------------------------------
// 指针事件 → sim(浏览器事件转发;UI 控件上的指针不投喂)
// ---------------------------------------------------------------------------
function canvasRect() {
  return canvas.getBoundingClientRect();
}

window.addEventListener('pointermove', (e) => {
  sim.pointerMove(e.clientX, e.clientY, canvasRect());
});
window.addEventListener('pointerdown', (e) => {
  sim.pointerDown(e.clientX, e.clientY, performance.now(), canvasRect());
});
window.addEventListener('pointerup', (e) => {
  const onUi = !!(e.target && e.target.closest && e.target.closest('[data-ui],[data-bench]'));
  sim.pointerUp(e.clientX, e.clientY, performance.now(), {
    onUi,
    isCanvas: !!(e.target && e.target.tagName === 'CANVAS'),
    button: e.button,
    rect: canvasRect(),
  });
});

// ---------------------------------------------------------------------------
// 页面契约:__bench + UI 控件(data-ui 与 data-bench 双属性,兼容两种探针选择器)
// ---------------------------------------------------------------------------
let frame = 0;
let fps = 60;

window.__bench = {
  getState: () => {
    const s = sim.state;
    return {
      engine: 'three',
      frame,
      ready: true,
      fishCount: s.fishCount,
      planktonCount: s.planktonCount,
      boidMode: s.boidMode,
      foodActive: s.foodActive,
      foodPosition: s.foodPosition,
      avgCohesion: s.avgCohesion,
      avgDistanceToFood: s.avgDistanceToFood,
      fps: Math.round(fps),
      centroid: s.centroid,
      scared: s.scared,
    };
  },
  reset: () => sim.reset(),
};

{
  const btn = document.createElement('button');
  btn.textContent = 'Reset';
  btn.setAttribute('data-ui', 'reset');
  btn.setAttribute('data-bench', 'reset');
  btn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
    "font:12px sans-serif;background:#12303e;color:#cfeef7;border:1px solid #3f6b7d;" +
    'border-radius:4px;cursor:pointer';
  btn.addEventListener('click', () => sim.reset());
  document.body.appendChild(btn);
}

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:9998;padding:4px 8px;' +
  'font:11px monospace;color:#9fd8e8;background:rgba(4,24,36,.55);' +
  'border-radius:4px;pointer-events:none;white-space:pre';
document.body.appendChild(hud);
let hudTimer = 0;

// ---------------------------------------------------------------------------
// 逐帧摆尾形变:pos.x = base.x + w * amp * sin(相位 - 体轴滞后)
// ---------------------------------------------------------------------------
const lookTmp = new THREE.Vector3();
function updateFishMeshes(dt) {
  for (let i = 0; i < FISH_COUNT; i++) {
    const f = sim.fishes[i];
    const speed = f.vel.length();
    const speedNorm = Math.min(1.4, speed / 4.6);
    wagPhases[i] += dt * (5.0 + speed * 2.2);
    const amp = 0.10 + 0.13 * speedNorm;
    const attr = f.mesh.geometry.attributes.position;
    const arr = attr.array;
    const ph = wagPhases[i];
    for (let v = 0; v < vertCount; v++) {
      const b = v * 3;
      arr[b] = basePos[b] + swayW[v] * Math.sin(ph - (basePos[b + 2] + 0.62) * 4.2) * amp;
    }
    attr.needsUpdate = true;
    f.mesh.position.copy(f.pos);
    lookTmp.copy(f.pos).add(f.vel);
    f.mesh.lookAt(lookTmp);
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let lastT = performance.now();

function tick() {
  const t = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (t - lastT) / 1000));
  lastT = t;
  frame += 1;
  fps = fps * 0.95 + (1 / dt) * 0.05;

  sim.update(dt);
  updateFishMeshes(dt);
  syncFoodVisual();

  // 悬浮颗粒缓冲上传(sim 已写入 layer.cur)
  for (const geo of planktonPoints) geo.attributes.position.needsUpdate = true;

  // 光柱缓摆
  for (let i = 0; i < shafts.length; i++) {
    shafts[i].rotation.x = Math.sin(sim.state.now * 0.11 + i * 1.7) * 0.05;
  }

  hudTimer += dt;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    const s = sim.state;
    hud.textContent =
      `fish ${s.fishCount}  plankton ${s.planktonCount}  mode ${s.boidMode}\n` +
      `cohesion ${s.avgCohesion.toFixed(2)}  food ${s.foodActive ? 'Y' : 'N'}  fps ${Math.round(fps)}`;
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
