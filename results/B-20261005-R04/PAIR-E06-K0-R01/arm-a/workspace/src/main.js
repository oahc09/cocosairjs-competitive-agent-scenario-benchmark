// ============================================================================
// E06 — 荒野篝火营地(Wilderness Campfire)— Three.js r186
// ----------------------------------------------------------------------------
// 场景构成(brief §3):低多边形起伏地形 + 18 棵低多边形树环 + 中央篝火组
//   (石圈/交叉柴堆/自发光炭床)+ 火苗(48 粒子)+ 火星(72 粒子)
//   + 萤火虫(20 粒子)+ 星空(380 点)+ 一盏真实照明地面与树干的动态点光。
// 页面契约(MASTER-CONTEXT §12.1 / brief §7):
//   window.__appReady : 首帧渲染后置 true(10s 内)
//   window.__bench    : { getState(): {timeOfDay, fireLightIntensity, fireflyCount,
//                        cameraOrbitAngle, orbitEnabled, treeCount}, reset(): void }
//   [data-ui]         : day-night / orbit-toggle / reset 三个 DOM 控件(右上角)
// 为什么粒子全部走 WebGL Points + 自定义着色器:brief §10 禁止 DOM/CSS 冒充火焰/火星。
// 为什么火光用真实 PointLight:brief §8 要求火光真实照明地面与树(受光面亮度随闪烁变化)。
// ============================================================================

import * as THREE from 'three';

// ---------- 确定性伪随机(reset 重播种可复现;构图不因每次加载漂移) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xe0606a1);
const TAU = Math.PI * 2;
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
// 与随机序列无关的坐标哈希(地形抖动用,保证 terrainHeight 纯函数)
function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
// sRGB 数值直出色:天空穹顶走自定义着色器(不含色彩空间转换),
// 用 LinearSRGBColorSpace 写入可让 hex 原样显示,与雾色(线性管线)显示结果一致。
function rawColor(hex) {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

// ---------- 地形高度(几何与落树共用同一函数,保证树根贴地) ----------
function terrainHeight(x, z) {
  const d = Math.hypot(x, z);
  const roll =
    0.42 * Math.sin(x * 0.16 + 1.7) +
    0.34 * Math.cos(z * 0.13 + 0.6) +
    0.26 * Math.sin((x + z) * 0.21 + 2.4);
  const facet = (hash2(Math.round(x * 2.2), Math.round(z * 2.2)) - 0.5) * 0.5;
  return (roll + facet) * smoothstep(3.2, 9.5, d); // 营地中心保持平坦(篝火/石圈需要平地)
}

// ---------- 渲染器 / 场景 / 相机 ----------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 压缩火光高光,昼夜动态范围更大
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const FOG_N = new THREE.Color(0x14203f);
const FOG_D = new THREE.Color(0xf0e4cd);
scene.fog = new THREE.Fog(0x14203f, 34, 130); // 远处地形融入天际线(颜色随日夜插值)

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  600
);
const ORBIT_RADIUS = 20;
const ORBIT_HEIGHT = 9; // 俯角 ~21° 环视营地(brief §2 构图)

// ---------- 光照(夜间冷调低亮度 + 暖橙火光;白天充足环境光) ----------
const HEMI_SKY_N = new THREE.Color(0x22304f);
const HEMI_SKY_D = new THREE.Color(0xbfd9ff);
const HEMI_GND_N = new THREE.Color(0x11151d);
const HEMI_GND_D = new THREE.Color(0x8f7f5f);
const hemi = new THREE.HemisphereLight(0x22304f, 0x11151d, 0.24);
scene.add(hemi);

const moon = new THREE.DirectionalLight(0x8fa3d9, 0.7); // 月光:树的冷调明暗面
moon.position.set(-18, 26, -12);
scene.add(moon);

const sun = new THREE.DirectionalLight(0xffedcc, 0); // 太阳:白天主光
sun.position.set(24, 34, 14);
scene.add(sun);

// 火光:decay 取 1.8(略缓于物理 2),树干(9–16m)仍被明显染色;不要求阴影
const fireLight = new THREE.PointLight(0xff7a2a, 20, 48, 1.8);
fireLight.position.set(0, 1.15, 0);
scene.add(fireLight);

// ---------- 天空穹顶(顶/地平线双色渐变,随 timeOfDay 插值) ----------
const SKY_TOP_N = rawColor(0x070d24);
const SKY_TOP_D = rawColor(0x4a90d9);
const SKY_HOR_N = rawColor(0x14203f);
const SKY_HOR_D = rawColor(0xf0e4cd);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    topColor: { value: SKY_TOP_N.clone() },
    horizonColor: { value: SKY_HOR_N.clone() },
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    varying vec3 vDir;
    void main() {
      float h = clamp(normalize(vDir).y, 0.0, 1.0);
      gl_FragColor = vec4(mix(horizonColor, topColor, pow(h, 0.55)), 1.0);
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(190, 32, 16), skyMat));

// ---------- 粒子系统(共享软圆点纹理 + 每粒子颜色/尺寸) ----------
const softTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c); // 运行时代码生成贴图(brief §5,无外部资产)
})();
const POINT_SCALE = 280 * renderer.getPixelRatio();

function makePointsSystem(count) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
  );
  geo.setAttribute(
    'aColor',
    new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
  );
  geo.setAttribute(
    'aSize',
    new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage)
  );
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: softTex }, uScale: { value: POINT_SCALE } },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (uScale / max(-mv.z, 0.1));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec3 vColor;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(vColor, a); // additive:rgb*a 叠加,变暗即淡出
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // 顶点每帧改写,不维护包围球,避免误剔除
  return points;
}

// ---------- 地形 + 营地泥地 ----------
{
  const geo = new THREE.PlaneGeometry(90, 90, 44, 44);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const gA = new THREE.Color(0x42603a);
  const gB = new THREE.Color(0x5b7a46);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    c.lerpColors(gA, gB, rand());
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  scene.add(
    new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })
    )
  );
  // 营地泥地圆盘:承接火光暖色光斑(P1/P2 视觉焦点)
  const dirt = new THREE.Mesh(
    new THREE.CircleGeometry(2.7, 20),
    new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 })
  );
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.y = 0.04;
  scene.add(dirt);
}

// ---------- 树环:18 棵低多边形树(>=12,建议 14–24) ----------
const TREE_COUNT = 18;
{
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 1.7, 6);
  const tierGeos = [
    new THREE.ConeGeometry(1.55, 2.1, 6),
    new THREE.ConeGeometry(1.15, 1.75, 6),
    new THREE.ConeGeometry(0.75, 1.4, 6),
  ];
  const tierY = [2.15, 3.4, 4.45];
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, flatShading: true, roughness: 0.9 });
  const canopyMats = [0x2e5c33, 0x3a6b3a, 0x345f42].map(
    (h) => new THREE.MeshStandardMaterial({ color: h, flatShading: true, roughness: 0.85 })
  );
  for (let i = 0; i < TREE_COUNT; i++) {
    const ang = (i / TREE_COUNT) * TAU + (rand() - 0.5) * 0.45;
    const rad = 9.5 + rand() * 6.5; // 环形散布,避开场心
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.85;
    tree.add(trunk);
    const mat = canopyMats[i % canopyMats.length];
    for (let tI = 0; tI < 3; tI++) {
      const cone = new THREE.Mesh(tierGeos[tI], mat);
      cone.position.y = tierY[tI];
      tree.add(cone);
    }
    tree.position.set(x, terrainHeight(x, z) - 0.12, z);
    tree.rotation.y = rand() * TAU;
    const s = 0.9 + rand() * 0.9;
    tree.scale.set(s, s * (0.9 + rand() * 0.3), s);
    scene.add(tree);
  }
}

// ---------- 篝火静态组:石圈 + 交叉柴堆 + 自发光炭床 ----------
const emberBedMat = new THREE.MeshStandardMaterial({
  color: 0x2a120a,
  emissive: 0xff5a1a,
  emissiveIntensity: 1.6,
  roughness: 1,
});
{
  const fireGroup = new THREE.Group();
  const rockGeo = new THREE.DodecahedronGeometry(0.3, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b8b86, flatShading: true, roughness: 0.95 });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + (rand() - 0.5) * 0.3;
    const r = 1.05 + (rand() - 0.5) * 0.18;
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(Math.cos(a) * r, 0.1 + rand() * 0.06, Math.sin(a) * r);
    rock.rotation.set(rand() * TAU, rand() * TAU, rand() * TAU);
    const s = 0.75 + rand() * 0.5;
    rock.scale.set(s, s * 0.8, s);
    fireGroup.add(rock);
  }
  const logGeo = new THREE.CylinderGeometry(0.11, 0.13, 1.7, 6);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x5a3d24, flatShading: true, roughness: 0.9 });
  for (let i = 0; i < 5; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 5) * TAU + 0.35;
    const log = new THREE.Mesh(logGeo, logMat);
    log.rotation.z = 1.0; // 距竖直 ~57°:外端搭在石圈上,内端架空于火心
    log.position.set(0.42, 0.35, 0);
    pivot.add(log);
    fireGroup.add(pivot);
  }
  const bed = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), emberBedMat);
  bed.position.y = 0.16;
  bed.scale.y = 0.6;
  fireGroup.add(bed);
  scene.add(fireGroup);
}

// ---------- 火苗:48 粒子(>=30),橙黄→红渐变 + 向上摆动 ----------
const FLAME_COUNT = 48;
const flamePts = makePointsSystem(FLAME_COUNT);
scene.add(flamePts);
const flameP = new Array(FLAME_COUNT);

function spawnFlame(p, scatter) {
  p.life = 0.55 + rand() * 0.4;
  p.age = scatter ? rand() * p.life : 0;
  p.r0 = 0.14 + rand() * 0.3;
  p.a0 = rand() * TAU;
  p.swayF = 1.6 + rand() * 2.4;
  p.seed = rand() * 10.0;
  return p;
}
function seedFlame() {
  for (let i = 0; i < FLAME_COUNT; i++) flameP[i] = spawnFlame({}, true);
}

function updateFlame(dt, t) {
  const posA = flamePts.geometry.attributes.position;
  const colA = flamePts.geometry.attributes.aColor;
  const sizeA = flamePts.geometry.attributes.aSize;
  const bright = 0.8 + 0.45 * flick; // 火苗亮度与火光同源闪烁
  for (let i = 0; i < FLAME_COUNT; i++) {
    const p = flameP[i];
    p.age += dt;
    if (p.age >= p.life) spawnFlame(p, false);
    const k = p.age / p.life;
    const r = p.r0 * (1 - 0.8 * k); // 上升同时向中轴收拢(火舌形态)
    const sx = Math.sin(t * p.swayF + p.seed) * 0.15 * k;
    const sz = Math.cos(t * p.swayF * 0.83 + p.seed * 1.7) * 0.13 * k;
    posA.setXYZ(i, Math.cos(p.a0) * r + sx, 0.18 + k * 1.95, Math.sin(p.a0) * r + sz);
    const fade = (1 - k) * bright;
    // 颜色:黄白(新生)→ 橙 → 红(将熄),additive 下 (1-k) 即淡出
    colA.setXYZ(i, 1.0 * fade, (0.85 - 0.72 * k) * fade, (0.45 - 0.42 * k) * fade);
    sizeA.setX(i, 0.62 * (1 - 0.55 * k) + 0.08);
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
  sizeA.needsUpdate = true;
}

// ---------- 火星:72 粒子,同屏常驻(峰值>=40),上升 1.2–2.8 单位/s,寿命 0.8–2 s ----------
const EMBER_COUNT = 72;
const emberPts = makePointsSystem(EMBER_COUNT);
scene.add(emberPts);
const emberP = new Array(EMBER_COUNT);
const WIND_X = 0.35;
const WIND_Z = 0.15; // 恒定微风:火星漂移方向一致,运动证据更清晰

function spawnEmber(p, scatter) {
  p.life = 0.8 + rand() * 1.2;
  p.age = scatter ? rand() * p.life : 0;
  p.x0 = (rand() - 0.5) * 0.5;
  p.z0 = (rand() - 0.5) * 0.5;
  p.vy = 1.2 + rand() * 1.6;
  p.vx = (rand() - 0.5) * 0.5;
  p.vz = (rand() - 0.5) * 0.5;
  p.seed = rand() * 10.0;
  p.size = 0.14 + rand() * 0.12;
  return p;
}
function seedEmbers() {
  for (let i = 0; i < EMBER_COUNT; i++) emberP[i] = spawnEmber({}, true);
}

function updateEmbers(dt, t) {
  const posA = emberPts.geometry.attributes.position;
  const colA = emberPts.geometry.attributes.aColor;
  const sizeA = emberPts.geometry.attributes.aSize;
  for (let i = 0; i < EMBER_COUNT; i++) {
    const p = emberP[i];
    p.age += dt;
    if (p.age >= p.life) spawnEmber(p, false);
    const k = p.age / p.life;
    const wx = Math.sin(t * 2.2 + p.seed) * 0.08 * k;
    const wz = Math.cos(t * 1.9 + p.seed * 1.3) * 0.08 * k;
    posA.setXYZ(
      i,
      p.x0 + (p.vx + WIND_X) * p.age + wx,
      0.35 + p.vy * p.age,
      p.z0 + (p.vz + WIND_Z) * p.age + wz
    );
    const fadeIn = Math.min(k / 0.1, 1);
    const fadeOut = k > 0.65 ? (1 - k) / 0.35 : 1; // 上升途中逐渐消散
    const b = fadeIn * fadeOut * (0.65 + 0.5 * flick);
    colA.setXYZ(i, 1.0 * b, 0.55 * b, 0.2 * b);
    sizeA.setX(i, p.size);
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
  sizeA.needsUpdate = true;
}

// ---------- 萤火虫:20 只(>=16),缓慢游走 + 明灭;白天淡出但数量恒定 ----------
const FIREFLY_COUNT = 20;
const fireflyPts = makePointsSystem(FIREFLY_COUNT);
scene.add(fireflyPts);
const fireflyP = new Array(FIREFLY_COUNT);

function spawnFirefly(p) {
  const ang = rand() * TAU;
  const rad = 3 + rand() * 10;
  const x = Math.cos(ang) * rad;
  const z = Math.sin(ang) * rad;
  p.cx = x;
  p.cz = z;
  p.cy = terrainHeight(x, z) + 0.7 + rand() * 2.4;
  p.ax = 0.8 + rand() * 1.4;
  p.ay = 0.3 + rand() * 0.7;
  p.az = 0.8 + rand() * 1.4;
  p.wx = 0.12 + rand() * 0.35;
  p.wy = 0.1 + rand() * 0.3;
  p.wz = 0.12 + rand() * 0.35;
  p.ph = rand() * TAU;
  p.blinkF = 0.5 + rand() * 0.9; // 明灭频率
  p.blinkP = rand() * TAU;
  return p;
}
function seedFireflies() {
  for (let i = 0; i < FIREFLY_COUNT; i++) fireflyP[i] = spawnFirefly({});
}

function updateFireflies(t) {
  const posA = fireflyPts.geometry.attributes.position;
  const colA = fireflyPts.geometry.attributes.aColor;
  const sizeA = fireflyPts.geometry.attributes.aSize;
  const dayFade = 1 - tod * 0.94;
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const p = fireflyP[i];
    posA.setXYZ(
      i,
      p.cx + Math.sin(t * p.wx + p.ph) * p.ax,
      p.cy + Math.sin(t * p.wy + p.ph * 2.0) * p.ay,
      p.cz + Math.cos(t * p.wz + p.ph) * p.az
    );
    const b0 = Math.sin(t * p.blinkF * TAU + p.blinkP);
    const pulse = Math.max(0, b0) ** 1.6; // 亮成短脉冲、灭相明显,但保留微光底避免静帧不可见
    const b = (0.12 + 0.88 * pulse) * dayFade;
    colA.setXYZ(i, 0.65 * b, 1.0 * b, 0.35 * b); // 黄绿色
    sizeA.setX(i, 0.26);
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
  sizeA.needsUpdate = true;
}

// ---------- 星空:380 点,夜间可见(白天淡出) ----------
const STAR_COUNT = 380;
const starPts = makePointsSystem(STAR_COUNT);
scene.add(starPts);
const starBase = new Float32Array(STAR_COUNT * 3);
{
  const posA = starPts.geometry.attributes.position;
  const sizeA = starPts.geometry.attributes.aSize;
  for (let i = 0; i < STAR_COUNT; i++) {
    const y = 0.08 + rand() * 0.92; // 只分布在地平线上方
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const ph = rand() * TAU;
    posA.setXYZ(i, Math.cos(ph) * rr * 190, y * 190, Math.sin(ph) * rr * 190);
    const b = 0.35 + rand() * 0.65;
    starBase[i * 3] = (0.75 + rand() * 0.25) * b;
    starBase[i * 3 + 1] = (0.8 + rand() * 0.2) * b;
    starBase[i * 3 + 2] = b;
    sizeA.setX(i, 1.4 + rand() * 2.0);
  }
  posA.needsUpdate = true;
  sizeA.needsUpdate = true;
}
function updateStars() {
  const n = 1 - tod;
  const colA = starPts.geometry.attributes.aColor;
  for (let i = 0; i < STAR_COUNT; i++) {
    colA.setXYZ(i, starBase[i * 3] * n, starBase[i * 3 + 1] * n, starBase[i * 3 + 2] * n);
  }
  colA.needsUpdate = true;
}

// ---------- 状态通道与 __bench ----------
const ORBIT_SPEED = 0.25; // rad/s,spec 允许 0.05–0.4
const TOD_DURATION = 3.0; // 日夜渐变时长,spec 允许 2.5–4(线性,存在大量可采样中间态)
let tod = 0; // 0=深夜 1=正午
let todFrom = 0;
let todTarget = 0;
let todStart = -1;
let orbitEnabled = true;
let orbitAngle = 0;
let dragYaw = 0;
let dragLift = 0;
let flick = 0.55; // 最近一帧火光强度(getState 报告值)
let elapsed = 0;

function toggleDayNight() {
  todFrom = tod;
  todTarget = todTarget >= 0.5 ? 0 : 1; // 端点间往返;过渡中再点即反向
  todStart = elapsed;
}

function doReset() {
  tod = 0;
  todFrom = 0;
  todTarget = 0;
  todStart = -1;
  orbitEnabled = true;
  orbitAngle = 0;
  dragYaw = 0;
  dragLift = 0;
  seedFlame();
  seedEmbers();
  seedFireflies(); // 火苗/火星/萤火虫重播种 = 恢复初始默认状态
  syncOrbitLabel();
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    timeOfDay: tod,
    fireLightIntensity: flick,
    fireflyCount: FIREFLY_COUNT,
    cameraOrbitAngle: orbitAngle,
    orbitEnabled,
    treeCount: TREE_COUNT,
  }),
  reset: doReset,
};

// ---------- UI 控件(DOM,右上角,固定 data-ui 属性) ----------
const uiPanel = document.createElement('div');
uiPanel.style.cssText =
  'position:fixed;top:12px;right:12px;z-index:9999;display:flex;flex-direction:column;' +
  'gap:6px;align-items:flex-end;font:13px/1.4 sans-serif;';
const statusEl = document.createElement('div');
statusEl.style.cssText =
  'padding:3px 10px;background:rgba(8,12,22,0.72);color:#dfe6f0;' +
  'border:1px solid #3a4a6a;border-radius:4px;';
statusEl.textContent = '夜 · 环绕:开';
const bDay = document.createElement('button');
bDay.textContent = '切换昼/夜';
bDay.setAttribute('data-ui', 'day-night');
const bOrbit = document.createElement('button');
bOrbit.textContent = '环绕 暂停';
bOrbit.setAttribute('data-ui', 'orbit-toggle');
const bReset = document.createElement('button');
bReset.textContent = '重置';
bReset.setAttribute('data-ui', 'reset');
for (const b of [bDay, bOrbit, bReset]) {
  b.style.cssText =
    'padding:5px 14px;background:#1c2436;color:#e8eef8;border:1px solid #5a6a8a;' +
    'border-radius:4px;cursor:pointer;font-size:13px;';
  uiPanel.appendChild(b);
}
uiPanel.insertBefore(statusEl, bDay);
document.body.appendChild(uiPanel);

function syncOrbitLabel() {
  bOrbit.textContent = orbitEnabled ? '环绕 暂停' : '环绕 恢复';
}
bDay.addEventListener('click', () => toggleDayNight());
bOrbit.addEventListener('click', () => {
  orbitEnabled = !orbitEnabled;
  syncOrbitLabel();
});
bReset.addEventListener('click', () => doReset());

// 拖拽微调视角(可选加分项;不影响自动化探针)
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* 捕获失败不影响拖拽逻辑 */
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  dragYaw += (e.clientX - lastX) * 0.005;
  dragLift = Math.min(Math.max(dragLift - (e.clientY - lastY) * 0.03, -3), 8);
  lastX = e.clientX;
  lastY = e.clientY;
});
const endDrag = () => {
  dragging = false;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- 环境随 timeOfDay 插值 ----------
function applyEnvironment() {
  hemi.intensity = 0.24 + 1.05 * tod;
  hemi.color.lerpColors(HEMI_SKY_N, HEMI_SKY_D, tod);
  hemi.groundColor.lerpColors(HEMI_GND_N, HEMI_GND_D, tod);
  moon.intensity = 0.7 * (1 - tod);
  sun.intensity = 2.6 * tod;
  // 白天火光相对减弱(ambient 变亮 + 直接衰减 40%),夜间全额照明
  fireLight.intensity = 34 * flick * (1 - 0.4 * tod);
  emberBedMat.emissiveIntensity = 0.9 + 1.5 * flick;
  skyMat.uniforms.topColor.value.lerpColors(SKY_TOP_N, SKY_TOP_D, tod);
  skyMat.uniforms.horizonColor.value.lerpColors(SKY_HOR_N, SKY_HOR_D, tod);
  scene.fog.color.lerpColors(FOG_N, FOG_D, tod);
}

// ---------- 主循环 ----------
// 时间统一用累计的 clamp 后 dt:失焦再聚焦不产生时间跳变瞬变(brief §6)
const clock = new THREE.Clock();
let readyFired = false;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  // 多频火光闪烁:0.6/1.1/2.9/5.3 Hz 叠加,基准 0.55,幅度 ±0.27(spec: >=0.08, 0.5–6Hz)
  flick =
    0.55 +
    0.11 * Math.sin(TAU * 1.1 * elapsed) +
    0.07 * Math.sin(TAU * 2.9 * elapsed + 1.3) +
    0.05 * Math.sin(TAU * 5.3 * elapsed + 4.1) +
    0.04 * Math.sin(TAU * 0.6 * elapsed + 2.0);
  flick = clamp01(flick);

  // 日夜渐变(线性 3s:0.5s 步进采样必捕获 0.17/0.33/0.5/0.67/0.83 等中间态)
  if (todStart >= 0) {
    const k = Math.min((elapsed - todStart) / TOD_DURATION, 1);
    tod = todFrom + (todTarget - todFrom) * k;
    if (k >= 1) {
      tod = todTarget;
      todStart = -1;
    }
  }

  if (orbitEnabled) orbitAngle += ORBIT_SPEED * dt;

  applyEnvironment();
  updateFlame(dt, elapsed);
  updateEmbers(dt, elapsed);
  updateFireflies(elapsed);
  updateStars();

  const a = orbitAngle + dragYaw;
  camera.position.set(Math.cos(a) * ORBIT_RADIUS, ORBIT_HEIGHT + dragLift, Math.sin(a) * ORBIT_RADIUS);
  camera.lookAt(0, 1.3, 0);

  renderer.render(scene, camera);

  const st = (tod > 0.5 ? '昼' : '夜') + ' · 环绕:' + (orbitEnabled ? '开' : '关');
  if (statusEl.textContent !== st) statusEl.textContent = st;

  if (!readyFired) {
    window.__appReady = true; // 首帧渲染完成,页面就绪
    readyFired = true;
  }
}

// 初始播种 + 启动
seedFlame();
seedEmbers();
seedFireflies();
renderer.setAnimationLoop(tick);

// 自检辅助(Agent 自查像素证据用,非 harness 契约):同步渲染一帧并导出 PNG。
// 为什么同任务 render+toDataURL:WebGL 默认缓冲在合成后清空,同任务内读取才有内容。
window.__snap = () => {
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
