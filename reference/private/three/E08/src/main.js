// ============================================================================
// E08 深海鱼群 (Deep Sea Fish School) — Three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// 场景合同(briefs/E08,冻结 v1.0.0):
//   - >=80 条程序化鱼(纺锤体+尾鳍+背鳍,实例化渲染,每实例独立朝向/摆尾相位)
//   - boids 三规则(聚集/对齐/分离)逐帧实时模拟,O(n^2) 朴素邻域
//   - 指针接近(与鱼世界距离 < 触发半径) => boidMode="scatter",avgCohesisom 下降
//   - 指针离开 => 重聚,boidMode="normal"
//   - 单击画布 => 投喂(3-5 粒发光食物),foodActive/foodPosition,鱼群向食物收敛,
//     食物被啃食消耗或 8s 超时后消失
//   - >=300 悬浮颗粒持续缓漂;深海氛围(渐变+雾+顶部光束)
//   - 页面契约: window.__appReady / window.__bench = { getState, reset }
//
// avgCohesion 冻结公式: 1 - min(1, 个体到鱼群质心平均距离 / 10)  —— 每帧实算。
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ============================== 0. 常量与配置 ================================

const FISH_COUNT = 110;      // >= 80
const PLANKTON_COUNT = 520;  // >= 300

// 鱼群活动水域(硬边界盒,相机取景框内)
const BOUND = { x: 13.5, y: 7.6, z: 6.5 };
const BOUND_MARGIN = 2.6;    // 软边界带:进入后受回推转向力

// 指针"位于水域内"判定(外扩的投影范围,用于惊散 gating)
const WATER_CHK = { x: 17.5, y: 11.0 };

// --- boids 参数(法线模式) ---
const NEIGHBOR_R = 5.5;      // 聚集/对齐邻域半径
const SEP_R_NORMAL = 1.9;    // 分离半径(常态)
const SEP_R_SCATTER = 3.35;  // 分离半径(惊散:互距撑开)
const W_COH = 1.9;           // 聚集权重
const W_ALI = 1.25;          // 对齐权重
const W_SEP = 6.2;           // 分离权重(乘以 1/d 型累加分)
const W_WANDER = 0.55;       // 游走噪声
const W_CENTER = 0.16;       // 全局弱向心力(防止长期分裂成多团)
const K_CONTAIN = 9.0;       // 软边界回推刚度
const SPEED_MIN = 1.4;
const SPEED_MAX_NORMAL = 5.4;

// --- 惊散 ---
const SCARE_TRIGGER_R = 2.8;       // 指针-鱼距离触发惊散(brief 建议值域)
const SCARE_HOLD_S = 2.2;          // 惊散最短持续(鱼群"惊魂未定")
const FLEE_R = 9.5;                // 逃逸力作用半径
const FLEE_W = 34.0;               // 逃逸力权重
const SPEED_MAX_SCATTER = 13.0;
const SPEED_MIN_SCATTER = 4.5;

// --- 重聚(scatter -> normal 切换后的增益窗口) ---
const REGROUP_S = 4.2;       // 增益持续
const REGROUP_COH_MUL = 3.2; // 聚集权重倍率
const SPEED_MAX_REGROUP = 9.5;

// --- 食物 ---
const FOOD_MIN_PELLETS = 3;
const FOOD_MAX_PELLETS = 5;
const FOOD_SPEED = 7.5;      // 趋食期望速度
const FOOD_W = 3.4;          // 趋食转向权重
const FOOD_TIMEOUT_S = 16.0; // 超时消失(brief: >=8s;取宽以覆盖慢采样)
const FOOD_NIBBLE_RATE = 0.07; // 每粒被啃食时的血量衰减(/s) => 持续接触约 14s 吃尽
const FOOD_EAT_R = 0.85;     // 啃食接触半径
const FOOD_SINK_V = 0.35;    // 下沉速度
const FOOD_FLOOR_Y = -6.6;   // 悬停深度

// ============================== 1. 工具 =====================================

// 可复现随机(brief: reset 恢复初始鱼群分布 => 固定种子)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261008);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 深海背景:竖直渐变(上亮下暗,光线自上而下衰减)
function makeBackgroundTexture() {
  const c = makeCanvas(32, 512);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#175266');
  grad.addColorStop(0.22, '#0d3d52');
  grad.addColorStop(0.50, '#083044');
  grad.addColorStop(0.78, '#04202f');
  grad.addColorStop(1.00, '#02121d');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 柔和圆点(悬浮颗粒)
function makeDotTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// 光晕(食物/指针)
function makeGlowTexture() {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// 顶部光束(体积光观感):横向中间亮两侧衰减 + 纵向上强下弱
function makeShaftTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 256);
  const g2 = g.createLinearGradient(0, 0, 0, 256);
  g2.addColorStop(0.0, 'rgba(0,0,0,0)');
  g2.addColorStop(0.15, 'rgba(0,0,0,0)');
  g2.addColorStop(1.0, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = g2;
  g.fillRect(0, 0, 128, 256);
  return new THREE.CanvasTexture(c);
}

// 水面焦散噪声(缓动的叠加纹理)
function makeCausticTexture() {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 60; i++) {
    g.lineWidth = 1 + rng() * 2.5;
    g.beginPath();
    const x = rng() * 256, y = rng() * 256, r = 12 + rng() * 46;
    g.arc(x, y, r, rng() * Math.PI * 2, rng() * Math.PI * 2 + 1.2 + rng() * 2.4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const dotTex = makeDotTexture();
const glowTex = makeGlowTexture();

// ============================== 2. 渲染器 / 场景 / 相机 ======================

const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
scene.background = makeBackgroundTexture();
scene.fog = new THREE.FogExp2(0x073040, 0.018);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
const CAM_BASE = new THREE.Vector3(0, 1.6, 28);
camera.position.copy(CAM_BASE);
camera.lookAt(0, 0, 0);

// 光照:上冷白、下深青(自上而下衰减)
scene.add(new THREE.HemisphereLight(0xa8dcec, 0x0a2531, 1.0));
const sun = new THREE.DirectionalLight(0xcfeaff, 1.7);
sun.position.set(4, 14, 7);
scene.add(sun);

// ============================== 3. 环境(海床/光束/水面) ====================

// 海床
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 64),
    new THREE.MeshStandardMaterial({ color: 0x06222e, roughness: 1.0, metalness: 0.0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -9.6, -4);
  scene.add(floor);

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x0a2c38, roughness: 0.95 });
  const rockGeo = new THREE.SphereGeometry(1, 10, 7);
  const rockSpots = [
    [-11, -9.1, -6.5, 3.2, 1.2, 2.2],
    [-4.5, -9.3, -7.5, 2.1, 0.8, 1.5],
    [3.5, -9.2, -6.8, 2.6, 1.0, 1.8],
    [10.5, -9.0, -7.0, 3.6, 1.4, 2.6],
    [15.5, -9.2, -5.5, 2.4, 0.9, 1.7],
  ];
  for (const [x, y, z, sx, sy, sz] of rockSpots) {
    const m = new THREE.Mesh(rockGeo, rockMat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.y = rng() * Math.PI;
    scene.add(m);
  }

  // 远处海草剪影(不参与模拟)
  const kelpMat = new THREE.MeshStandardMaterial({ color: 0x0d3a2e, roughness: 0.9 });
  for (let i = 0; i < 8; i++) {
    const h = 5 + rng() * 5;
    const kelp = new THREE.Mesh(new THREE.ConeGeometry(0.16 + rng() * 0.1, h, 5), kelpMat);
    kelp.position.set(-16 + rng() * 32, -9.6 + h / 2 - 0.4, -5 - rng() * 4);
    kelp.rotation.z = (rng() - 0.5) * 0.24;
    scene.add(kelp);
  }
}

// 顶部光束(加色透明面片,缓慢摆动)
const shafts = [];
{
  const shaftTex = makeShaftTexture();
  const defs = [
    { x: -12.0, z: -4.0, w: 3.4, o: 0.14, ph: 0.0 },
    { x: -6.5,  z: -5.5, w: 2.6, o: 0.11, ph: 1.7 },
    { x: -1.5,  z: -6.0, w: 4.2, o: 0.16, ph: 3.1 },
    { x: 5.0,   z: -4.5, w: 3.0, o: 0.12, ph: 4.4 },
    { x: 11.0,  z: -5.0, w: 3.8, o: 0.15, ph: 5.6 },
    { x: 2.0,   z: 2.5,  w: 2.4, o: 0.05, ph: 2.4 },
  ];
  for (const d of defs) {
    const mat = new THREE.MeshBasicMaterial({
      map: shaftTex,
      transparent: true,
      opacity: d.o,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(d.w, 30), mat);
    m.position.set(d.x, 6.5, d.z);
    m.rotation.z = (rng() - 0.5) * 0.1;
    m.frustumCulled = false;
    scene.add(m);
    shafts.push({ mesh: m, base: d.o, ph: d.ph });
  }
}

// 水面焦散(顶部两片缓慢错向滚动)
const caustics = [];
{
  const cTex = makeCausticTexture();
  const defs = [
    { y: 9.4, z: -2.0, o: 0.050, sx: 0.010, sy: 0.004, rs: 0.9 },
    { y: 9.2, z: 3.0, o: 0.038, sx: -0.007, sy: 0.003, rs: -0.7 },
  ];
  for (const d of defs) {
    const mat = new THREE.MeshBasicMaterial({
      map: cTex.clone(),
      transparent: true,
      opacity: d.o,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    mat.map.repeat.set(3, 1.2);
    mat.map.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(64, 9), mat);
    m.position.set(0, d.y, d.z);
    m.rotation.x = -Math.PI / 2 + 0.32;
    m.frustumCulled = false;
    scene.add(m);
    caustics.push({ mesh: m, mat, ...d });
  }
}

// ============================== 4. 程序化鱼 =================================

// 纺锤体(车削)+ 尾鳍 + 背鳍 + 一对胸鳍,全部程序化拼合,头朝 +Z
function buildFishGeometry() {
  const prof = [
    [0.00, 0.020], [0.06, 0.105], [0.16, 0.190], [0.30, 0.232], [0.45, 0.222],
    [0.60, 0.172], [0.75, 0.112], [0.90, 0.052], [1.00, 0.016],
  ];
  const pts = prof.map(([t, r]) => new THREE.Vector2(r, 0.5 - t)); // 鼻尖 y=+0.5
  const body = new THREE.LatheGeometry(pts, 16);
  body.rotateX(Math.PI / 2);            // +Y -> +Z(鼻尖 +z)
  body.scale(0.55, 1.0, 1.5);           // 侧扁 + 拉长:鼻 +0.75 / 尾根 -0.75

  // 尾鳍:压扁圆锥向后展开
  const tail = new THREE.ConeGeometry(0.30, 0.50, 10);
  tail.rotateX(-Math.PI / 2);           // +Y(锥尖) -> -Z
  tail.scale(0.10, 1.0, 1.0);           // 压成薄刃
  tail.translate(0, 0.02, -0.97);       // 基部接尾根,尖至 -1.22

  // 背鳍
  const dorsal = new THREE.ConeGeometry(0.15, 0.30, 6);
  dorsal.scale(0.08, 1.0, 1.7);
  dorsal.translate(0, 0.26, 0.02);

  // 胸鳍 x2
  const finL = new THREE.ConeGeometry(0.075, 0.28, 5);
  finL.scale(1, 0.10, 1);
  finL.rotateZ(1.15);
  finL.rotateY(-0.55);
  finL.translate(0.13, -0.08, 0.15);
  const finR = new THREE.ConeGeometry(0.075, 0.28, 5);
  finR.scale(1, 0.10, 1);
  finR.rotateZ(-1.15);
  finR.rotateY(0.55);
  finR.translate(-0.13, -0.08, 0.15);

  const geo = mergeGeometries([body, tail, dorsal, finL, finR]);
  geo.scale(0.8, 0.8, 0.8);             // 最终体长 ~1.55
  return geo;
}

// 摆尾:沿体长的行波,顶点着色器内按实例相位弯曲(局部空间,实例矩阵之前)
const uWagAmp = { value: 0.16 };
const fishMaterial = new THREE.MeshStandardMaterial({
  color: 0xdfeef2,
  roughness: 0.42,
  metalness: 0.22,
  emissive: 0x0c2a33,
  emissiveIntensity: 0.5,
});
fishMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uWagAmp = uWagAmp;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute float aPhase;
      attribute float aWag;
      uniform float uWagAmp;`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        // 头部 (+z) 几乎不动,尾部 (-z) 摆幅最大;相位沿体长滞后形成行波
        float tAlong = clamp((0.6 - transformed.z) / 1.6, 0.0, 1.0);
        float wave = sin(aPhase - transformed.z * 2.4);
        transformed.x += wave * uWagAmp * (0.12 + tAlong * tAlong * 1.25) * aWag;
      }`
    );
};

const fishGeo = buildFishGeometry();
const aPhaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(FISH_COUNT), 1);
const aWagAttr = new THREE.InstancedBufferAttribute(new Float32Array(FISH_COUNT), 1);
fishGeo.setAttribute('aPhase', aPhaseAttr);
fishGeo.setAttribute('aWag', aWagAttr);

const fishMesh = new THREE.InstancedMesh(fishGeo, fishMaterial, FISH_COUNT);
fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
fishMesh.frustumCulled = false;
scene.add(fishMesh);

// --- 鱼群模拟状态(SoA 扁平数组,零每帧分配) ---
const px = new Float32Array(FISH_COUNT), py = new Float32Array(FISH_COUNT), pz = new Float32Array(FISH_COUNT);
const vx = new Float32Array(FISH_COUNT), vy = new Float32Array(FISH_COUNT), vz = new Float32Array(FISH_COUNT);
const ax = new Float32Array(FISH_COUNT), ay = new Float32Array(FISH_COUNT), az = new Float32Array(FISH_COUNT);
const cohX = new Float32Array(FISH_COUNT), cohY = new Float32Array(FISH_COUNT), cohZ = new Float32Array(FISH_COUNT);
const aliX = new Float32Array(FISH_COUNT), aliY = new Float32Array(FISH_COUNT), aliZ = new Float32Array(FISH_COUNT);
const sepX = new Float32Array(FISH_COUNT), sepY = new Float32Array(FISH_COUNT), sepZ = new Float32Array(FISH_COUNT);
const cohN = new Int16Array(FISH_COUNT), aliN = new Int16Array(FISH_COUNT);
const cruise = new Float32Array(FISH_COUNT);    // 巡游期望速度(个体差异)
const scaleArr = new Float32Array(FISH_COUNT);  // 个体体型
const wA = new Float32Array(FISH_COUNT), wB = new Float32Array(FISH_COUNT); // 游走相位
const wagPhase = new Float32Array(FISH_COUNT);  // 摆尾累计相位
const prevYaw = new Float32Array(FISH_COUNT);   // 转弯率 -> 侧倾
const rollArr = new Float32Array(FISH_COUNT);

function spawnFish() {
  const r = mulberry32(20261008); // 固定种子:reset 后恢复同一初始分布
  for (let i = 0; i < FISH_COUNT; i++) {
    // 球状初始鱼群(半径 ~4.6 => 平均质心距 ~3.4 => cohesion ~0.66)
    let x, y, z, l2;
    do {
      x = (r() * 2 - 1) * 4.6; y = (r() * 2 - 1) * 4.6; z = (r() * 2 - 1) * 4.6;
      l2 = x * x + y * y + z * z;
    } while (l2 > 4.6 * 4.6);
    px[i] = x; py[i] = y; pz[i] = z;
    // 随机朝向的初始速度
    const th = r() * Math.PI * 2, ph = Math.acos(2 * r() - 1);
    const s = 2.2 + r() * 1.2;
    vx[i] = Math.sin(ph) * Math.cos(th) * s;
    vy[i] = Math.cos(ph) * s * 0.4;
    vz[i] = Math.sin(ph) * Math.sin(th) * s;
    cruise[i] = 3.1 + r() * 1.4;
    scaleArr[i] = 0.82 + r() * 0.26;
    wA[i] = r() * Math.PI * 2;
    wB[i] = r() * Math.PI * 2;
    wagPhase[i] = r() * Math.PI * 2;
    prevYaw[i] = Math.atan2(vx[i], vz[i]);
    rollArr[i] = 0;
    // 个体色:暖银-青灰微差
    fishMesh.setColorAt(i, new THREE.Color().setHSL(0.5 + r() * 0.06, 0.2 + r() * 0.2, 0.6 + r() * 0.2));
  }
  if (fishMesh.instanceColor) fishMesh.instanceColor.needsUpdate = true;
}
spawnFish();

// ============================== 5. 悬浮颗粒 =================================

const planktonGeo = new THREE.BufferGeometry();
const planktonPos = new Float32Array(PLANKTON_COUNT * 3);
const planktonInit = new Float32Array(PLANKTON_COUNT * 3);
const planktonVel = new Float32Array(PLANKTON_COUNT * 3);
const planktonSeed = new Float32Array(PLANKTON_COUNT);
const PB = { x: 16.5, y: 9.6, z: 8.6 }; // 颗粒包裹盒(略大于鱼群盒)

function spawnPlankton() {
  const r = mulberry32(880208);
  for (let i = 0; i < PLANKTON_COUNT; i++) {
    const i3 = i * 3;
    planktonInit[i3] = (r() * 2 - 1) * PB.x;
    planktonInit[i3 + 1] = (r() * 2 - 1) * PB.y;
    planktonInit[i3 + 2] = (r() * 2 - 1) * PB.z;
    planktonVel[i3] = (r() - 0.5) * 0.3;
    planktonVel[i3 + 1] = (r() - 0.5) * 0.12 + 0.03; // 极缓上浮
    planktonVel[i3 + 2] = (r() - 0.5) * 0.3;
    planktonSeed[i] = r() * Math.PI * 2;
  }
  planktonPos.set(planktonInit);
  planktonGeo.getAttribute('position').needsUpdate = true;
}
planktonGeo.setAttribute('position', new THREE.BufferAttribute(planktonPos, 3));
const planktonMat = new THREE.PointsMaterial({
  size: 0.15,
  map: dotTex,
  color: 0xbfe3ea,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
  fog: false,
});
const plankton = new THREE.Points(planktonGeo, planktonMat);
plankton.frustumCulled = false;
scene.add(plankton);
spawnPlankton();

// ============================== 6. 食物系统 =================================

const pelletGeo = new THREE.SphereGeometry(0.1, 10, 8);
const pelletMat = new THREE.MeshStandardMaterial({
  color: 0xffe6b0,
  emissive: 0xffb45e,
  emissiveIntensity: 2.4,
  roughness: 0.4,
});
const glowSpriteMat = new THREE.SpriteMaterial({
  map: glowTex,
  color: 0xffb45e,
  transparent: true,
  opacity: 0.42,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});

const foodLight = new THREE.PointLight(0xffbe7a, 42, 15, 1.8);
foodLight.visible = false;
scene.add(foodLight);

/** 活跃食物(每次投喂一组 3-5 粒) */
const food = {
  active: false,
  spawnTime: 0,        // tSim
  center: new THREE.Vector3(),
  pellets: [],         // { mesh, sprite, health, alive, seed }
};

function despawnFood() {
  for (const p of food.pellets) {
    scene.remove(p.mesh);
    scene.remove(p.sprite); // 几何/材质共享,仅移除出场景
  }
  food.pellets.length = 0;
  food.active = false;
  foodLight.visible = false;
}

function spawnFoodAt(worldPos, tSim) {
  despawnFood();
  food.active = true;
  food.spawnTime = tSim;
  food.center.copy(worldPos);
  food.center.x = THREE.MathUtils.clamp(food.center.x, -11, 11);
  food.center.y = THREE.MathUtils.clamp(food.center.y, -5.2, 5.2);
  food.center.z = THREE.MathUtils.clamp(food.center.z, -5.5, 5.5);
  const n = FOOD_MIN_PELLETS + Math.floor(rng() * (FOOD_MAX_PELLETS - FOOD_MIN_PELLETS + 1));
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(pelletGeo, pelletMat);
    const sprite = new THREE.Sprite(glowSpriteMat);
    sprite.scale.setScalar(1.15);
    const off = new THREE.Vector3((rng() - 0.5) * 1.2, rng() * 1.0, (rng() - 0.5) * 1.2);
    mesh.position.copy(food.center).add(off);
    sprite.position.copy(mesh.position);
    scene.add(mesh);
    scene.add(sprite);
    food.pellets.push({ mesh, sprite, health: 1, alive: true, seed: rng() * Math.PI * 2 });
  }
  foodLight.position.copy(food.center);
  foodLight.visible = true;
}

// ============================== 7. 指针 / 惊散 / 投喂 ========================

const raycaster = new THREE.Raycaster();
const planeZ0 = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // 鱼群中心深度平面
const pointerNDC = new THREE.Vector2();
const pointerWorld = new THREE.Vector3();
const _pw = new THREE.Vector3();

const pointer = {
  active: false,   // 指针位于画布上
  inWater: false,  // 投影落点位于水域内(外扩判定)
  hasWorld: false,
};

function updatePointerWorld() {
  if (!pointer.active) { pointer.inWater = false; pointer.hasWorld = false; return; }
  raycaster.setFromCamera(pointerNDC, camera);
  if (raycaster.ray.intersectPlane(planeZ0, _pw)) {
    pointerWorld.copy(_pw);
    pointer.hasWorld = true;
    pointer.inWater = Math.abs(_pw.x) <= WATER_CHK.x && Math.abs(_pw.y) <= WATER_CHK.y;
  } else {
    pointer.hasWorld = false;
    pointer.inWater = false;
  }
}

// 指针微光(可选反馈:水域内的柔光)
const pointerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, color: 0x7fd8e8, transparent: true, opacity: 0.0,
  blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
}));
pointerGlow.scale.setScalar(1.8);
scene.add(pointerGlow);

let scareUntil = -1;       // 惊散保持到此时刻(tSim)
let mode = 'normal';       // "normal" | "scatter"
let regroupUntil = -1;     // scatter->normal 后的重聚增益窗口

// 区分"单击投喂"与"拖拽"(拖拽位移大,不投喂)
let downX = 0, downY = 0, downT = 0;

canvas.addEventListener('pointermove', (e) => {
  pointer.active = true;
  pointerNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
});
canvas.addEventListener('pointerdown', (e) => {
  pointer.active = true;
  pointerNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  downX = e.clientX; downY = e.clientY; downT = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  const dx = e.clientX - downX, dy = e.clientY - downY;
  const moved = Math.sqrt(dx * dx + dy * dy);
  if (moved < 10 && performance.now() - downT < 900) {
    // 单击 => 投喂(投影到水域平面,且落点在水域内)
    pointerNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    updatePointerWorld();
    if (pointer.hasWorld && pointer.inWater) spawnFoodAt(pointerWorld, tSim);
  }
});
canvas.addEventListener('pointerleave', () => { pointer.active = false; });

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') doReset();
});

// ============================== 8. 模拟核心 =================================

let tSim = 0;
let avgCohesionLive = 0;      // 冻结公式实算
let avgDistFoodLive = null;   // 有食物时实算,否则 null
let resetCount = 0;

const dummy = new THREE.Object3D();
const _look = new THREE.Vector3();

function stepSimulation(dt) {
  const now = tSim;

  // --- 8.1 惊散触发:指针与鱼的真实距离判定(逐帧,非定时器) ---
  // 投喂期间"进食压过恐惧":鱼群聚焦食物,不再触发惊散(觅食群不畏手)。
  updatePointerWorld();
  if (!food.active && pointer.active && pointer.inWater && pointer.hasWorld) {
    const r2 = SCARE_TRIGGER_R * SCARE_TRIGGER_R;
    for (let i = 0; i < FISH_COUNT; i++) {
      const dx = px[i] - pointerWorld.x, dy = py[i] - pointerWorld.y, dz = pz[i] - pointerWorld.z;
      if (dx * dx + dy * dy + dz * dz < r2) { scareUntil = now + SCARE_HOLD_S; break; }
    }
  }
  const newMode = now < scareUntil ? 'scatter' : 'normal';
  if (newMode !== mode) {
    if (newMode === 'normal') regroupUntil = now + REGROUP_S; // 惊散结束 => 重聚增益
    mode = newMode;
  }
  const scatter = mode === 'scatter';
  const regrouping = mode === 'normal' && now < regroupUntil;

  // --- 8.2 模式相关参数 ---
  // 惊散恐慌参数组(集群解体+大范围逃逸):scatter 且无食物时生效;
  // 投喂期间鱼群保持集群形态专注进食,恐慌组不生效。
  const panic = scatter && !food.active;
  const wCoh = panic ? W_COH * 0.03 : (regrouping ? W_COH * REGROUP_COH_MUL : W_COH);
  const wAli = panic ? W_ALI * 0.4 : W_ALI;
  const sepR = panic ? SEP_R_SCATTER : SEP_R_NORMAL;
  const wSep = panic ? W_SEP * 1.8 : W_SEP;
  const wWander = panic ? W_WANDER * 2.2 : W_WANDER;
  const speedMax = panic ? SPEED_MAX_SCATTER : (regrouping ? SPEED_MAX_REGROUP : SPEED_MAX_NORMAL);
  const speedMin = panic ? SPEED_MIN_SCATTER : SPEED_MIN;
  const fleeR2 = FLEE_R * FLEE_R;

  // --- 8.3 邻域累积(O(n^2) 对称遍历) ---
  cohN.fill(0); aliN.fill(0);
  cohX.fill(0); cohY.fill(0); cohZ.fill(0);
  aliX.fill(0); aliY.fill(0); aliZ.fill(0);
  sepX.fill(0); sepY.fill(0); sepZ.fill(0);
  const nr2 = NEIGHBOR_R * NEIGHBOR_R;
  const sr2 = sepR * sepR;
  for (let i = 0; i < FISH_COUNT; i++) {
    const xi = px[i], yi = py[i], zi = pz[i];
    for (let j = i + 1; j < FISH_COUNT; j++) {
      const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > nr2 || d2 < 1e-8) continue;
      cohX[i] += px[j]; cohY[i] += py[j]; cohZ[i] += pz[j]; cohN[i]++;
      cohX[j] += xi; cohY[j] += yi; cohZ[j] += zi; cohN[j]++;
      aliX[i] += vx[j]; aliY[i] += vy[j]; aliZ[i] += vz[j]; aliN[i]++;
      aliX[j] += vx[i]; aliY[j] += vy[i]; aliZ[j] += vz[i]; aliN[j]++;
      if (d2 < sr2) {
        const d = Math.sqrt(d2);
        const w = (sepR - d) / (sepR * d); // 近者强、按 1/d 累积
        const fx = dx * w, fy = dy * w, fz = dz * w;
        sepX[i] -= fx; sepY[i] -= fy; sepZ[i] -= fz;
        sepX[j] += fx; sepY[j] += fy; sepZ[j] += fz;
      }
    }
  }

  // --- 8.4 转向力合成 -> 速度 -> 位置 ---
  for (let i = 0; i < FISH_COUNT; i++) {
    let fx = 0, fy = 0, fz = 0;
    const vlen = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) || 1e-5;

    // 聚集:驶向邻域质心
    if (cohN[i] > 0) {
      let tx = cohX[i] / cohN[i] - px[i], ty = cohY[i] / cohN[i] - py[i], tz = cohZ[i] / cohN[i] - pz[i];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-4) {
        const sp = cruise[i];
        tx = tx / tl * sp - vx[i]; ty = ty / tl * sp - vy[i]; tz = tz / tl * sp - vz[i];
        fx += tx * wCoh; fy += ty * wCoh; fz += tz * wCoh;
      }
    }
    // 对齐:与邻域平均朝向一致
    if (aliN[i] > 0) {
      let tx = aliX[i] / aliN[i], ty = aliY[i] / aliN[i], tz = aliZ[i] / aliN[i];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-4) {
        const sp = cruise[i];
        tx = tx / tl * sp - vx[i]; ty = ty / tl * sp - vy[i]; tz = tz / tl * sp - vz[i];
        fx += tx * wAli; fy += ty * wAli; fz += tz * wAli;
      }
    }
    // 分离:邻距过近时互推
    {
      const sl = Math.sqrt(sepX[i] * sepX[i] + sepY[i] * sepY[i] + sepZ[i] * sepZ[i]);
      if (sl > 1e-5) {
        const sp = cruise[i] * 1.35;
        fx += (sepX[i] / sl * sp - vx[i]) * wSep;
        fy += (sepY[i] / sl * sp - vy[i]) * wSep;
        fz += (sepZ[i] / sl * sp - vz[i]) * wSep;
      }
    }
    // 游走:缓慢变向的个体噪声
    {
      wA[i] += dt * (0.35 + cruise[i] * 0.05);
      wB[i] += dt * 0.27;
      const nx = Math.sin(wA[i]) + Math.sin(wB[i] * 0.63) * 0.5;
      const ny = Math.sin(wB[i]) * 0.4 + Math.cos(wA[i] * 0.77) * 0.3;
      const nz = Math.cos(wA[i] * 1.21) + Math.cos(wB[i] * 0.9) * 0.5;
      fx += nx * wWander; fy += ny * wWander * 0.6; fz += nz * wWander;
    }
    // 全局弱向心(防长期分裂)
    fx += -px[i] * W_CENTER; fy += -py[i] * W_CENTER; fz += -pz[i] * W_CENTER;

    // 软边界回推(取景框内约束)
    {
      const m = BOUND_MARGIN;
      if (px[i] < -BOUND.x + m) fx += (-BOUND.x + m - px[i]) * K_CONTAIN;
      else if (px[i] > BOUND.x - m) fx -= (px[i] - (BOUND.x - m)) * K_CONTAIN;
      if (py[i] < -BOUND.y + m) fy += (-BOUND.y + m - py[i]) * K_CONTAIN;
      else if (py[i] > BOUND.y - m) fy -= (py[i] - (BOUND.y - m)) * K_CONTAIN;
      if (pz[i] < -BOUND.z + m) fz += (-BOUND.z + m - pz[i]) * K_CONTAIN;
      else if (pz[i] > BOUND.z - m) fz -= (pz[i] - (BOUND.z - m)) * K_CONTAIN;
    }

    // 惊散:沿远离指针方向强推(恐慌状态,半径内随距离衰减)
    if (panic && pointer.hasWorld) {
      const dx = px[i] - pointerWorld.x, dy = py[i] - pointerWorld.y, dz = pz[i] - pointerWorld.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < fleeR2 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const w = FLEE_W * (1 - d / FLEE_R) / d;
        fx += dx * w; fy += dy * w; fz += dz * w;
      }
    }

    // 趋食:驶向食物点(强吸引)
    if (food.active) {
      const dx = food.center.x - px[i], dy = food.center.y - py[i], dz = food.center.z - pz[i];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > 1e-4) {
        fx += (dx / d * FOOD_SPEED - vx[i]) * FOOD_W;
        fy += (dy / d * FOOD_SPEED - vy[i]) * FOOD_W;
        fz += (dz / d * FOOD_SPEED - vz[i]) * FOOD_W;
      }
    }

    // 积分(加速度上限保护)
    vx[i] += fx * dt; vy[i] += fy * dt; vz[i] += fz * dt;
    const sp2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
    const sp = Math.sqrt(sp2);
    const cap = Math.max(speedMax, cruise[i] * 1.15);
    if (sp > cap) { const k = cap / sp; vx[i] *= k; vy[i] *= k; vz[i] *= k; }
    else if (sp < speedMin && sp > 1e-5) { const k = speedMin / sp; vx[i] *= k; vy[i] *= k; vz[i] *= k; }

    px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
    // 硬边界钳制(不得游出画面)
    px[i] = THREE.MathUtils.clamp(px[i], -BOUND.x, BOUND.x);
    py[i] = THREE.MathUtils.clamp(py[i], -BOUND.y, BOUND.y);
    pz[i] = THREE.MathUtils.clamp(pz[i], -BOUND.z, BOUND.z);

    // 摆尾相位(速度越快摆越快)与侧倾(转弯压弯)
    wagPhase[i] += dt * (3.2 + sp * 1.9);
    aWagAttr.array[i] = THREE.MathUtils.clamp(0.45 + sp / 4.0, 0.45, 1.7);
    const yaw = Math.atan2(vx[i], vz[i]);
    let dyaw = yaw - prevYaw[i];
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const targetRoll = THREE.MathUtils.clamp(dyaw / Math.max(dt, 1e-3) * -0.55, -0.55, 0.55);
    rollArr[i] += (targetRoll - rollArr[i]) * Math.min(1, dt * 6);
    prevYaw[i] = yaw;
  }

  // --- 8.5 状态统计:质心 / avgCohesion(冻结公式) / 到食物平均距离 ---
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < FISH_COUNT; i++) { cx += px[i]; cy += py[i]; cz += pz[i]; }
  cx /= FISH_COUNT; cy /= FISH_COUNT; cz /= FISH_COUNT;
  let sumD = 0;
  for (let i = 0; i < FISH_COUNT; i++) {
    const dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz;
    sumD += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  avgCohesionLive = 1 - Math.min(1, (sumD / FISH_COUNT) / 10);

  if (food.active) {
    let sumF = 0;
    for (let i = 0; i < FISH_COUNT; i++) {
      const dx = px[i] - food.center.x, dy = py[i] - food.center.y, dz = pz[i] - food.center.z;
      sumF += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    avgDistFoodLive = sumF / FISH_COUNT;
  } else {
    avgDistFoodLive = null;
  }

  // --- 8.6 实例矩阵(位置 + 朝向 + 压弯侧倾)与摆尾属性 ---
  for (let i = 0; i < FISH_COUNT; i++) {
    dummy.position.set(px[i], py[i], pz[i]);
    // 朝向速度方向(限制俯仰,避免垂直竖立)
    const hl = Math.sqrt(vx[i] * vx[i] + vz[i] * vz[i]) + 1e-5;
    const vyOrient = THREE.MathUtils.clamp(vy[i], -hl * 0.6, hl * 0.6);
    _look.set(px[i] + vx[i], py[i] + vyOrient, pz[i] + vz[i]);
    dummy.lookAt(_look);
    dummy.rotateZ(rollArr[i]);
    dummy.scale.setScalar(scaleArr[i]);
    dummy.updateMatrix();
    fishMesh.setMatrixAt(i, dummy.matrix);
    aPhaseAttr.array[i] = wagPhase[i];
  }
  fishMesh.instanceMatrix.needsUpdate = true;
  aPhaseAttr.needsUpdate = true;
  aWagAttr.needsUpdate = true;

  // --- 8.7 食物更新:下沉/悬停、被啃食消耗、超时 ---
  if (food.active) {
    let aliveCount = 0;
    for (const p of food.pellets) {
      if (!p.alive) continue;
      // 缓沉 + 摆动,到悬停深度后浮动
      const mp = p.mesh.position;
      if (mp.y > FOOD_FLOOR_Y) mp.y = Math.max(FOOD_FLOOR_Y, mp.y - FOOD_SINK_V * dt);
      mp.x += Math.sin(tSim * 1.3 + p.seed) * 0.12 * dt;
      mp.z += Math.cos(tSim * 1.1 + p.seed) * 0.12 * dt;
      // 啃食:任一鱼进入接触半径即持续消耗(进食速率受限,保证可观察过程)
      let contact = false;
      const er2 = FOOD_EAT_R * FOOD_EAT_R;
      for (let i = 0; i < FISH_COUNT; i++) {
        const dx = px[i] - mp.x, dy = py[i] - mp.y, dz = pz[i] - mp.z;
        if (dx * dx + dy * dy + dz * dz < er2) { contact = true; break; }
      }
      if (contact) p.health -= FOOD_NIBBLE_RATE * dt;
      const vis = Math.max(0.05, p.health);
      p.mesh.scale.setScalar(0.4 + 0.6 * vis);
      p.sprite.scale.setScalar(0.5 + 0.7 * vis + Math.sin(tSim * 6 + p.seed) * 0.06);
      p.sprite.position.copy(mp);
      if (p.health <= 0) {
        p.alive = false;
        scene.remove(p.mesh);
        scene.remove(p.sprite);
      } else {
        aliveCount++;
      }
    }
    foodLight.intensity = 34 + Math.sin(tSim * 9) * 9 + aliveCount * 2;
    if (aliveCount === 0 || tSim - food.spawnTime >= FOOD_TIMEOUT_S) {
      despawnFood();
      avgDistFoodLive = null;
    }
  }
}

// ============================== 9. 氛围动画 =================================

function stepAtmosphere(dt) {
  // 光束摆动 + 呼吸
  for (const s of shafts) {
    s.mesh.rotation.z = Math.sin(tSim * 0.21 + s.ph) * 0.075;
    s.mesh.material.opacity = s.base * (0.75 + 0.25 * Math.sin(tSim * 0.4 + s.ph * 1.7));
  }
  // 焦散滚动
  for (const c of caustics) {
    c.mat.map.offset.x += c.sx * dt;
    c.mat.map.offset.y += c.sy * dt;
    c.mesh.rotation.z += c.rs * dt * 0.02;
  }
  // 悬浮颗粒缓漂 + 包裹盒环绕
  const pos = planktonGeo.getAttribute('position');
  for (let i = 0; i < PLANKTON_COUNT; i++) {
    const i3 = i * 3;
    const sway = Math.sin(tSim * 0.4 + planktonSeed[i]) * 0.06;
    pos.array[i3] += (planktonVel[i3] + sway) * dt;
    pos.array[i3 + 1] += (planktonVel[i3 + 1] + Math.cos(tSim * 0.3 + planktonSeed[i]) * 0.05) * dt;
    pos.array[i3 + 2] += (planktonVel[i3 + 2] + sway * 0.7) * dt;
    if (pos.array[i3] > PB.x) pos.array[i3] = -PB.x; else if (pos.array[i3] < -PB.x) pos.array[i3] = PB.x;
    if (pos.array[i3 + 1] > PB.y) pos.array[i3 + 1] = -PB.y; else if (pos.array[i3 + 1] < -PB.y) pos.array[i3 + 1] = PB.y;
    if (pos.array[i3 + 2] > PB.z) pos.array[i3 + 2] = -PB.z; else if (pos.array[i3 + 2] < -PB.z) pos.array[i3 + 2] = PB.z;
  }
  pos.needsUpdate = true;
  // 指针微光(水域内可见的柔光反馈)
  if (pointer.active && pointer.inWater && pointer.hasWorld) {
    pointerGlow.position.copy(pointerWorld);
    pointerGlow.material.opacity = 0.16 + 0.08 * Math.sin(tSim * 5);
  } else {
    pointerGlow.material.opacity = 0;
  }
  // 相机极缓漂移(呼吸感,不影响取景)
  camera.position.x = CAM_BASE.x + Math.sin(tSim * 0.11) * 0.35;
  camera.position.y = CAM_BASE.y + Math.sin(tSim * 0.07 + 1.2) * 0.22;
  camera.lookAt(0, 0, 0);
}

// ============================== 10. HUD / 页面契约 ==========================

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:12px;left:12px;z-index:10;padding:10px 14px;' +
  'font:12px/1.65 ui-monospace,Consolas,monospace;color:#b9dbe6;' +
  'background:rgba(4,20,28,0.5);border:1px solid rgba(110,200,220,0.28);' +
  'border-radius:10px;pointer-events:none;white-space:pre;';
document.body.appendChild(hud);

const hint = document.createElement('div');
hint.textContent = '移动指针惊散鱼群 · 单击投喂 · R 重置';
hint.style.cssText =
  'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:10;' +
  'font:12px ui-monospace,Consolas,monospace;color:rgba(170,215,228,0.55);' +
  'pointer-events:none;letter-spacing:0.08em;';
document.body.appendChild(hint);

// 暗角(纯 CSS,零渲染成本)
const vignette = document.createElement('div');
vignette.style.cssText =
  'position:fixed;inset:0;z-index:5;pointer-events:none;' +
  'background:radial-gradient(ellipse at 50% 42%, rgba(0,0,0,0) 52%, rgba(1,8,13,0.55) 100%);';
document.body.appendChild(vignette);

const resetBtn = document.createElement('button');
resetBtn.textContent = '重置 Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.style.cssText =
  'position:fixed;top:12px;right:12px;z-index:10;padding:7px 18px;' +
  'font:13px ui-monospace,Consolas,monospace;color:#cfeef7;cursor:pointer;' +
  'background:rgba(6,30,42,0.72);border:1px solid rgba(110,200,220,0.45);' +
  'border-radius:8px;transition:background 0.15s;';
resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background = 'rgba(14,64,86,0.85)'; });
resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background = 'rgba(6,30,42,0.72)'; });
resetBtn.addEventListener('click', () => doReset());
document.body.appendChild(resetBtn);

function round(v, n) {
  const m = Math.pow(10, n);
  return Math.round(v * m) / m;
}

function getState() {
  return {
    fishCount: FISH_COUNT,
    planktonCount: PLANKTON_COUNT,
    boidMode: mode,
    foodActive: food.active,
    foodPosition: food.active
      ? { x: round(food.center.x, 3), y: round(food.center.y, 3), z: round(food.center.z, 3) }
      : null,
    avgCohesion: round(avgCohesionLive, 4),
    avgDistanceToFood: food.active && avgDistFoodLive != null ? round(avgDistFoodLive, 3) : null,
    resetCount,
  };
}

function doReset() {
  despawnFood();
  scareUntil = -1;
  regroupUntil = -1;
  mode = 'normal';
  avgDistFoodLive = null;
  spawnFish();          // 同种子 => 恢复初始分布
  spawnPlankton();
  resetCount += 1;
}

window.__bench = { getState, reset: doReset };

let hudTimer = 0;
function updateHUD(dt) {
  hudTimer += dt;
  if (hudTimer < 0.15) return;
  hudTimer = 0;
  const s = getState();
  const modeText = s.boidMode === 'scatter' ? '惊散 SCATTER' : '常态 NORMAL';
  const coh = Math.round(s.avgCohesion * 100);
  const filled = Math.round(s.avgCohesion * 10);
  const bar = '■'.repeat(filled) + '·'.repeat(10 - filled);
  const foodText = s.foodActive
    ? `food (${s.foodPosition.x.toFixed(1)}, ${s.foodPosition.y.toFixed(1)}, ${s.foodPosition.z.toFixed(1)}) d=${s.avgDistanceToFood.toFixed(1)}`
    : 'food —';
  hud.textContent =
    `深海鱼群 E08  fish ${s.fishCount}  plankton ${s.planktonCount}\n` +
    `mode  ${modeText}\n` +
    `cohesion ${bar} ${coh}%\n` +
    `${foodText}`;
}

// ============================== 11. 主循环 ==================================

let lastT = performance.now();
let ready = false;

function tick(now) {
  const dt = Math.min(Math.max((now - lastT) / 1000, 0), 0.05);
  lastT = now;
  tSim += dt;

  stepSimulation(dt);
  stepAtmosphere(dt);
  updateHUD(dt);

  renderer.render(scene, camera);
  if (!ready) {
    ready = true;
    window.__appReady = true; // 首帧渲染完成
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ============================== 12. 视口自适应 ==============================

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
