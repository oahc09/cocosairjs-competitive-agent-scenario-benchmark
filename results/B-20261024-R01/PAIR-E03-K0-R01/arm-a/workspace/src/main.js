// ============================================================================
// E03 — 太阳系仪(Orrery)
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : 首帧渲染完成后 true
//   window.__bench    : { getState(): object, reset(): void }
// 实现要点(为什么这样做):
//   * 公转用「角速度积分」而非固定角度,orbitAngle 连续累计、不取模,
//     时间倍率因此能真实改变运动速率(不是改显示值)。
//   * 行星-卫星父子层级:orbitPivot(绕 Y 自转)→ holder(平移 r)→ tiltGroup(自转轴倾斜)
//     → 行星网格 / moonPivot → 卫星;卫星天然随行星公转。
//   * 点击判定走「屏幕投影近邻」而不是射线拾取:探针按 pickTargets 的 CSS 像素点击,
//     与命中阈值同一套数据源,保证投影区域内点击可靠命中、空白处必然落空。
//   * 小行星带用 InstancedMesh(独立实例,逐实例位置/自转更新),真实渲染数量 = asteroidCount。
// ============================================================================

import * as THREE from 'three';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03050b);

// --- 相机:俯角约 39.5°,内容占画面约 80% 宽,全部轨道不出画 ----------------------
// 参数经离线投影比选:1280×720 下最内/最外轨道包围盒 x∈[129,1151]、y∈[75,703]。
const CAM_INIT = { pivot: new THREE.Vector3(0, 0, 9), dist: Math.hypot(42, 51), elev: Math.atan2(42, 51), azim: 0 };
const camState = {
  pivot: CAM_INIT.pivot.clone(),
  dist: CAM_INIT.dist,
  elev: CAM_INIT.elev,
  azim: CAM_INIT.azim,
};
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.5, 4000);

function applyCamera() {
  const ce = Math.cos(camState.elev);
  const se = Math.sin(camState.elev);
  camera.position.set(
    camState.pivot.x + camState.dist * ce * Math.sin(camState.azim),
    camState.pivot.y + camState.dist * se,
    camState.pivot.z + camState.dist * ce * Math.cos(camState.azim),
  );
  camera.lookAt(camState.pivot);
  camera.updateMatrixWorld(true);
}

// ============================================================================
// 程序化贴图(无外部贴图资源;全部用 Canvas 现画,确定性种子)
// ============================================================================
function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** 气态巨行星:横向条纹 + 湍流带(米黄/棕,带条纹感)。 */
function bandedTexture(colors, seed, contrast = 0.16) {
  return canvasTexture(512, 256, (ctx, w, h) => {
    const rnd = mulberry32(seed);
    let y = 0;
    while (y < h) {
      const bh = h * (0.025 + rnd() * 0.085);
      ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
      ctx.fillRect(0, y - 1, w, bh + 2);
      y += bh;
    }
    // 湍流:低透明度明暗椭圆拉出条纹边缘的起伏
    for (let i = 0; i < 420; i++) {
      const yy = rnd() * h;
      const ww = w * (0.04 + rnd() * 0.26);
      const hh = 1.5 + rnd() * 7;
      ctx.globalAlpha = 0.04 + rnd() * contrast;
      ctx.fillStyle = rnd() < 0.5 ? '#ffffff' : '#1a1206';
      ctx.beginPath();
      ctx.ellipse(rnd() * w, yy, ww, hh, 0, 0, TAU);
      ctx.fill();
    }
    // 极区压暗
    ctx.globalAlpha = 1;
    const gTop = ctx.createLinearGradient(0, 0, 0, h * 0.22);
    gTop.addColorStop(0, 'rgba(10,8,4,0.55)');
    gTop.addColorStop(1, 'rgba(10,8,4,0)');
    ctx.fillStyle = gTop;
    ctx.fillRect(0, 0, w, h * 0.22);
    const gBot = ctx.createLinearGradient(0, h, 0, h * 0.78);
    gBot.addColorStop(0, 'rgba(10,8,4,0.55)');
    gBot.addColorStop(1, 'rgba(10,8,4,0)');
    ctx.fillStyle = gBot;
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
  });
}

/** 岩质行星:底色 + 斑块 + 环形山(可选)+ 极冠(可选)。 */
function rockyTexture(base, spots, seed, opts = {}) {
  return canvasTexture(512, 256, (ctx, w, h) => {
    const rnd = mulberry32(seed);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 320; i++) {
      const r = 3 + rnd() * 28;
      ctx.globalAlpha = 0.05 + rnd() * 0.2;
      ctx.fillStyle = spots[Math.floor(rnd() * spots.length)];
      ctx.beginPath();
      ctx.ellipse(rnd() * w, rnd() * h, r, r * (0.5 + rnd() * 0.9), rnd() * Math.PI, 0, TAU);
      ctx.fill();
    }
    if (opts.craters) {
      for (let i = 0; i < 110; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = 1.5 + rnd() * 7;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(38,32,27,0.85)';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = 'rgba(240,232,214,0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.18, Math.PI * 0.75, Math.PI * 1.9);
        ctx.stroke();
      }
    }
    if (opts.poles) {
      const cap = (fromY, toY) => {
        const g = ctx.createLinearGradient(0, fromY, 0, toY);
        g.addColorStop(0, 'rgba(246,250,255,0.9)');
        g.addColorStop(1, 'rgba(246,250,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, Math.min(fromY, toY), w, Math.abs(toY - fromY));
      };
      cap(0, h * 0.13);
      cap(h, h * 0.87);
    }
    if (opts.swirl) {
      for (let i = 0; i < 90; i++) {
        ctx.globalAlpha = 0.04 + rnd() * 0.1;
        ctx.strokeStyle = '#fff3d0';
        ctx.lineWidth = 1 + rnd() * 3;
        ctx.beginPath();
        const y = rnd() * h;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + (rnd() - 0.5) * 30, w * 0.7, y + (rnd() - 0.5) * 30, w, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  });
}

/** 地球:海洋 + 大陆块 + 云带 + 极冠。 */
function earthTexture() {
  return canvasTexture(512, 256, (ctx, w, h) => {
    const rnd = mulberry32(21);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0d2c50');
    g.addColorStop(0.45, '#1b5c94');
    g.addColorStop(1, '#0d2c50');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let c = 0; c < 9; c++) {
      const cx = rnd() * w;
      const cy = h * 0.18 + rnd() * h * 0.64;
      const rr = 22 + rnd() * 62;
      for (let i = 0; i < 70; i++) {
        const a = rnd() * TAU;
        const d = rnd() * rr;
        const x = (cx + Math.cos(a) * d * 1.7 + w) % w;
        const y = cy + Math.sin(a) * d * 0.75;
        ctx.globalAlpha = 0.32 + rnd() * 0.42;
        ctx.fillStyle = rnd() < 0.7 ? '#3f7d49' : '#8d7c4d';
        ctx.beginPath();
        ctx.ellipse(x, y, 5 + rnd() * 16, 3 + rnd() * 10, rnd() * Math.PI, 0, TAU);
        ctx.fill();
      }
    }
    // 云带
    for (let i = 0; i < 120; i++) {
      ctx.globalAlpha = 0.05 + rnd() * 0.12;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(rnd() * w, rnd() * h, 8 + rnd() * 34, 2 + rnd() * 6, 0, 0, TAU);
      ctx.fill();
    }
    // 极冠
    const cap = (fromY, toY) => {
      const gg = ctx.createLinearGradient(0, fromY, 0, toY);
      gg.addColorStop(0, 'rgba(250,253,255,0.95)');
      gg.addColorStop(1, 'rgba(250,253,255,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(0, Math.min(fromY, toY), w, Math.abs(toY - fromY));
    };
    ctx.globalAlpha = 1;
    cap(0, h * 0.1);
    cap(h, h * 0.9);
  });
}

/** 太阳表面:米白颗粒 + 少量暗斑。 */
function sunTexture() {
  return canvasTexture(512, 256, (ctx, w, h) => {
    const rnd = mulberry32(5);
    ctx.fillStyle = '#ffe7a2';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      ctx.globalAlpha = 0.05 + rnd() * 0.22;
      ctx.fillStyle = rnd() < 0.55 ? '#fff6d8' : '#ffc766';
      ctx.beginPath();
      ctx.ellipse(rnd() * w, rnd() * h, 2 + rnd() * 14, 2 + rnd() * 10, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
}

/** 径向光晕(白心 → 暖黄 → 橙 → 透明),用于恒星光晕与选中辉光。 */
function glowTexture(stops) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    for (const [p, c] of stops) g.addColorStop(p, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** 选中环(透明底 + 亮环 + 外发光环)。 */
function selectionRingTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    ctx.strokeStyle = 'rgba(120, 225, 255, 0.30)';
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.36, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150, 238, 255, 0.55)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.41, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(235, 253, 255, 1)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.41, 0, TAU);
    ctx.stroke();
  });
}

/** 土星环:沿半径方向的疏密环带(透明间隙 + 明暗变化),RingGeometry 的 UV 是径向映射。 */
function ringTexture(innerFrac) {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const rnd = mulberry32(33);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const steps = 260;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const r = (w / 2) * (innerFrac + (1 - innerFrac) * t);
      // 多段间隙 + 亮度起伏
      let a = 0.42 + 0.3 * Math.sin(t * 38 + 1.3) * Math.sin(t * 11.7);
      if (t > 0.46 && t < 0.53) a *= 0.12; // 卡西尼缝
      if (t > 0.78 && t < 0.82) a *= 0.35;
      a *= 0.75 + rnd() * 0.35;
      const lum = 0.72 + 0.24 * Math.sin(t * 23);
      ctx.strokeStyle = `rgba(${Math.round(226 * lum)},${Math.round(206 * lum)},${Math.round(172 * lum)},${Math.max(0, Math.min(1, a))})`;
      ctx.lineWidth = (w / 2) * ((1 - innerFrac) / steps) + 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }
  });
}

// ============================================================================
// 场景内容
// ============================================================================

// 光照:远处恒星点光(decay=1 让内外行星亮度差可控)+ 冷色环境补光
const sunLight = new THREE.PointLight(0xfff1d2, 11, 0, 1);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x3a4d75, 0.95));
const fill = new THREE.DirectionalLight(0xa8c0e2, 0.6);
fill.position.set(26, 60, 74);
scene.add(fill);

// --- 背景星 ----------------------------------------------------------------
{
  const count = 3200;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const rnd = mulberry32(101);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // 球壳均匀分布
    const u = rnd() * 2 - 1;
    const phi = rnd() * TAU;
    const r = 420 + rnd() * 220;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(phi);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(phi);
    const warm = rnd() < 0.22;
    const b = 0.35 + rnd() * 0.65;
    c.setRGB(warm ? b : b * 0.82, warm ? b * 0.9 : b * 0.9, warm ? b * 0.72 : b);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 1.9, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  stars.frustumCulled = false;
  scene.add(stars);

  // 少量亮星(更大光点,增强层次)
  const brightCount = 90;
  const bp = new Float32Array(brightCount * 3);
  for (let i = 0; i < brightCount; i++) {
    const u = rnd() * 2 - 1;
    const phi = rnd() * TAU;
    const r = 420 + rnd() * 200;
    const s = Math.sqrt(1 - u * u);
    bp[i * 3] = r * s * Math.cos(phi);
    bp[i * 3 + 1] = r * u;
    bp[i * 3 + 2] = r * s * Math.sin(phi);
  }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  const brightStars = new THREE.Points(
    bgeo,
    new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, color: 0xdfeaff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  brightStars.frustumCulled = false;
  scene.add(brightStars);
}

// --- 恒星(太阳) ------------------------------------------------------------
const haloOuter = (() => {
  const sunCore = new THREE.Mesh(
    new THREE.SphereGeometry(2.25, 48, 32),
    new THREE.MeshBasicMaterial({ map: sunTexture(), color: 0xffedb4 }),
  );
  scene.add(sunCore);

  // 内层紧贴表面的暖光壳(加色混合,造「高亮核心」)
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(2.55, 40, 26),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  scene.add(shell);

  const glowWarm = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture([[0, 'rgba(255,255,255,1)'], [0.14, 'rgba(255,238,186,0.8)'], [0.34, 'rgba(255,190,110,0.26)'], [0.66, 'rgba(255,150,70,0.05)'], [1, 'rgba(255,140,60,0)']]),
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    }),
  );
  glowWarm.scale.set(17, 17, 1);
  scene.add(glowWarm);

  const glowHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture([[0, 'rgba(255,232,184,0.42)'], [0.2, 'rgba(255,198,128,0.14)'], [0.5, 'rgba(255,152,72,0.035)'], [1, 'rgba(255,120,40,0)']]),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.85,
    }),
  );
  glowHalo.scale.set(30, 30, 1);
  scene.add(glowHalo);
  return glowHalo;
})();

// --- 行星定义 ---------------------------------------------------------------
// 周期:最内侧 230 模拟秒 → 最外侧 3400 模拟秒,自内向外单调递增。
// 半径:参考真实太阳系数量级压缩(对数感),并保证初始视角下投影可辨。
const PLANET_DEFS = [
  { name: 'mercury', radius: 0.66, orbitRadius: 5.2, period: 230, type: 'Rocky planet', diameterKm: 4879, color: 0x9d8d7d, tilt: 0.01 },
  { name: 'venus', radius: 0.9, orbitRadius: 7.4, period: 300, type: 'Rocky planet', diameterKm: 12104, color: 0xd9a45e, tilt: 0.05 },
  { name: 'earth', radius: 0.95, orbitRadius: 9.8, period: 400, type: 'Rocky planet', diameterKm: 12742, color: 0x3f7fd0, tilt: 0.41 },
  { name: 'mars', radius: 0.75, orbitRadius: 12.4, period: 560, type: 'Rocky planet', diameterKm: 6779, color: 0xb4552e, tilt: 0.44 },
  { name: 'jupiter', radius: 2.2, orbitRadius: 18.6, period: 1000, type: 'Gas giant', diameterKm: 139820, color: 0xd9c08a, tilt: 0.05 },
  { name: 'saturn', radius: 1.9, orbitRadius: 23.6, period: 1400, type: 'Gas giant', diameterKm: 116460, color: 0xe2cd96, tilt: 0.42, ring: true },
  { name: 'uranus', radius: 1.2, orbitRadius: 28.6, period: 2200, type: 'Ice giant', diameterKm: 50724, color: 0x74cddb, tilt: 1.71 },
  { name: 'neptune', radius: 1.15, orbitRadius: 33.4, period: 3400, type: 'Ice giant', diameterKm: 49244, color: 0x3f63c9, tilt: 0.49 },
];

// 卫星(公转周期 8–40 模拟秒;父子层级挂在所属行星下)
const MOON_DEFS = {
  earth: [{ radius: 0.24, dist: 1.75, period: 10, color: 0xbfc4c9 }],
  jupiter: [
    { radius: 0.26, dist: 3.3, period: 14, color: 0xd8ccb4 },
    { radius: 0.2, dist: 4.4, period: 24, color: 0xa9a08f },
  ],
  saturn: [{ radius: 0.24, dist: 5.1, period: 34, color: 0xc9d2d8 }],
};

const moonCount = Object.values(MOON_DEFS).reduce((n, arr) => n + arr.length, 0);

const planetMat = {
  mercury: new THREE.MeshStandardMaterial({
    map: rockyTexture('#8d8377', ['#6f665c', '#a79c8c', '#554d45'], 11, { craters: true }),
    roughness: 0.95,
    metalness: 0.02,
    emissive: 0x3a3428,
    emissiveIntensity: 1,
  }),
  venus: new THREE.MeshStandardMaterial({
    map: rockyTexture('#d9a45e', ['#c08d4a', '#efc884', '#a9743a'], 12, { swirl: true }),
    roughness: 0.9,
    metalness: 0,
    emissive: 0x53401c,
    emissiveIntensity: 1,
  }),
  earth: new THREE.MeshStandardMaterial({
    map: earthTexture(),
    roughness: 0.78,
    metalness: 0.05,
    emissive: 0x0b2138,
    emissiveIntensity: 1,
  }),
  mars: new THREE.MeshStandardMaterial({
    map: rockyTexture('#b4552e', ['#8f3f22', '#d08a5a', '#7a3419'], 13, { poles: true, craters: true }),
    roughness: 0.95,
    metalness: 0.02,
    emissive: 0x4a2415,
    emissiveIntensity: 1,
  }),
  jupiter: new THREE.MeshStandardMaterial({
    map: bandedTexture(['#c9ab7c', '#dcc596', '#b08b5f', '#e6d3ac', '#a9764f'], 14, 0.18),
    roughness: 0.95,
    metalness: 0,
    emissive: 0x483a24,
    emissiveIntensity: 1,
  }),
  saturn: new THREE.MeshStandardMaterial({
    map: bandedTexture(['#d9c292', '#e6d6ad', '#c7ab77', '#efe0b8'], 15, 0.12),
    roughness: 0.95,
    metalness: 0,
    emissive: 0x463a22,
    emissiveIntensity: 1,
  }),
  uranus: new THREE.MeshStandardMaterial({
    map: bandedTexture(['#8fd6e0', '#79c4d4', '#a3e0e8', '#6fbccb'], 16, 0.07),
    roughness: 0.85,
    metalness: 0.02,
    emissive: 0x17454f,
    emissiveIntensity: 1,
  }),
  neptune: new THREE.MeshStandardMaterial({
    map: bandedTexture(['#3f63c9', '#4a72d8', '#35529f', '#5b82e0'], 17, 0.09),
    roughness: 0.85,
    metalness: 0.02,
    emissive: 0x16295f,
    emissiveIntensity: 1,
  }),
};

const orbitLineMaterials = [];

const planets = PLANET_DEFS.map((def, k) => {
  const orbitPivot = new THREE.Group();
  orbitPivot.name = `orbit-${def.name}`;
  scene.add(orbitPivot);

  const holder = new THREE.Group();
  holder.position.set(def.orbitRadius, 0, 0);
  orbitPivot.add(holder);

  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.z = def.tilt;
  holder.add(tiltGroup);

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(def.radius, 48, 32), planetMat[def.name]);
  mesh.name = def.name;
  tiltGroup.add(mesh);

  // 大气薄辉光(给岩质行星一点边缘层次)
  if (def.name === 'earth' || def.name === 'venus' || def.name === 'neptune' || def.name === 'uranus') {
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(def.radius * 1.055, 40, 26),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    tiltGroup.add(atmo);
  }

  // 行星环(至少 1 颗:saturn)
  if (def.ring) {
    const inner = def.radius * 1.32;
    const outer = def.radius * 2.42;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 160, 1),
      new THREE.MeshBasicMaterial({
        map: ringTexture(inner / outer),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        opacity: 0.95,
      }),
    );
    ring.rotation.x = -Math.PI / 2; // RingGeometry 在 XY 平面 → 摆到行星赤道面
    tiltGroup.add(ring);
  }

  // 卫星(父子层级:随行星公转)
  const moons = (MOON_DEFS[def.name] || []).map((md, i) => {
    const moonPivot = new THREE.Group();
    holder.add(moonPivot);
    const moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(md.radius, 20, 14),
      new THREE.MeshStandardMaterial({ color: md.color, roughness: 1, metalness: 0, emissive: 0x0c0e12, emissiveIntensity: 1 }),
    );
    moonMesh.position.set(md.dist, 0, 0);
    moonPivot.add(moonMesh);
    return { pivot: moonPivot, mesh: moonMesh, def: md, angle: i * 1.7, initAngle: i * 1.7 };
  });

  // 选中反馈:始终面向相机的环(Sprite),按行星半径缩放
  const ringSize = Math.max(3.0, def.radius * 5.4);
  const highlight = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: selectionRingTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  highlight.scale.set(ringSize, ringSize, 1);
  highlight.visible = false;
  highlight.renderOrder = 10;
  holder.add(highlight);

  // 轨道参考线(细淡,不喧宾夺主)
  const pts = [];
  const SEG = 180;
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * TAU;
    pts.push(new THREE.Vector3(def.orbitRadius * Math.cos(a), 0, def.orbitRadius * Math.sin(a)));
  }
  const lineMat = new THREE.LineBasicMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.16 });
  orbitLineMaterials.push(lineMat);
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
  scene.add(line);

  const initAngle = k * 45 * DEG;
  orbitPivot.rotation.y = -initAngle;

  return {
    def,
    orbitPivot,
    holder,
    tiltGroup,
    mesh,
    moons,
    highlight,
    lineMat,
    angle: initAngle,
    initAngle,
    spin: 0,
    screenX: 0,
    screenY: 0,
    screenRadius: 12,
    ringSize,
  };
});

// --- 小行星带(独立于行星层级;InstancedMesh 逐实例运动) -----------------------
const ASTEROID_COUNT = 1500;
const belt = new THREE.Group();
belt.name = 'asteroid-belt';
scene.add(belt);

const asteroids = [];
let beltMesh = null;
{
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0.05, flatShading: true, emissive: 0x2a2318, emissiveIntensity: 1 });
  const inst = new THREE.InstancedMesh(geo, mat, ASTEROID_COUNT);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.frustumCulled = false;
  inst.name = 'asteroid-instances';
  belt.add(inst);
  beltMesh = inst;

  const rnd = mulberry32(2027);
  const color = new THREE.Color();
  const inner = 13.6;
  const outer = 17.6;
  for (let i = 0; i < ASTEROID_COUNT; i++) {
    // 径向双峰分布,让带体中间更密(连续环带而非零星点)
    let t = rnd();
    t = 0.5 + 0.5 * Math.tanh((t - 0.5) * 3.2);
    const r = inner + (outer - inner) * t;
    const angle = rnd() * TAU;
    const y = (rnd() - 0.5) * 0.9 * (rnd() < 0.5 ? 1 : 0.55);
    const size = 0.062 + Math.pow(rnd(), 2.1) * 0.17;
    const spinAxis = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const spinRate = (rnd() - 0.5) * 1.2;
    // 带内速度分层:内圈略快
    const omega = 0.0062 * Math.pow(15.6 / r, 1.35);
    asteroids.push({ r, angle, y, size, spinAxis, spinRate, omega, initAngle: angle });
    color.setHSL(0.062 + rnd() * 0.05, 0.2 + rnd() * 0.22, 0.15 + rnd() * 0.18);
    inst.setColorAt(i, color);
  }
  inst.instanceColor.needsUpdate = true;
}

const beltDummy = new THREE.Object3D();

// --- 选中状态 / 模拟时钟 ------------------------------------------------------
const state = {
  timeScale: 1,
  simTime: 0,
  selected: null,
  epoch: 0,
  fps: 60,
};

const ui = {
  card: document.getElementById('info-card'),
  name: document.getElementById('ic-name'),
  type: document.getElementById('ic-type'),
  orbit: document.getElementById('ic-orbit'),
  period: document.getElementById('ic-period'),
  diameter: document.getElementById('ic-diameter'),
  moons: document.getElementById('ic-moons'),
  angle: document.getElementById('ic-angle'),
  speedButtons: Array.from(document.querySelectorAll('.speed')),
  resetBtn: document.getElementById('reset-btn'),
};

const planetBy = new Map(planets.map((p) => [p.def.name, p]));

function setSpeed(v) {
  state.timeScale = v;
  for (const b of ui.speedButtons) {
    const on = Number(b.dataset.speed) === v;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function updateCard() {
  const p = state.selected ? planetBy.get(state.selected) : null;
  if (!p) {
    ui.card.classList.add('hidden');
    return;
  }
  const d = p.def;
  ui.name.textContent = d.name;
  ui.type.textContent = d.type;
  ui.orbit.textContent = d.orbitRadius.toFixed(1) + ' u';
  ui.period.textContent = d.period + ' s';
  ui.diameter.textContent = d.diameterKm.toLocaleString('en-US') + ' km';
  const moons = p.moons.length;
  ui.moons.textContent = moons === 0 ? 'none' : String(moons);
  ui.angle.textContent = state.selected ? (p.angle % TAU).toFixed(2) + ' rad' : '—';
  ui.card.classList.remove('hidden');
}

function setSelected(name) {
  const next = name && planetBy.has(name) ? name : null;
  if (state.selected === next) {
    if (next) updateCard();
    return;
  }
  state.selected = next;
  for (const p of planets) {
    const on = p.def.name === next;
    p.highlight.visible = on;
    p.mesh.scale.setScalar(on ? 1.06 : 1);
    p.lineMat.opacity = on ? 0.5 : 0.16;
    p.lineMat.color.setHex(on ? 0x67d8ff : 0x9fb4d8);
  }
  updateCard();
}

// --- 屏幕投影(每帧更新,供探针与点击共用同一事实源) ---------------------------
const projVec = new THREE.Vector3();
let pickTargets = [];

function updatePickTargets() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const halfTan = Math.tan((camera.fov * DEG) / 2);
  const next = [];
  for (const p of planets) {
    p.holder.getWorldPosition(projVec);
    const dist = camera.position.distanceTo(projVec);
    const ndc = projVec.clone().project(camera);
    const sx = (ndc.x * 0.5 + 0.5) * w;
    const sy = (-ndc.y * 0.5 + 0.5) * h;
    const pxPerWorld = h / 2 / (halfTan * Math.max(dist, 0.001));
    const radiusPx = p.def.radius * pxPerWorld;
    // 选中环半径 ≈ 0.41 * ringSize,拾取/区域断言都覆盖到高亮圈
    const ringPx = 0.41 * p.ringSize * pxPerWorld;
    p.screenX = sx;
    p.screenY = sy;
    p.screenRadius = Math.max(12, Math.max(radiusPx * 1.2, ringPx + 3));
    next.push({ name: p.def.name, screenX: sx, screenY: sy, screenRadius: p.screenRadius });
  }
  pickTargets = next;
}

// --- 相机交互(拖拽环绕 / 滚轮缩放) -------------------------------------------
const pointer = { down: false, moved: false, x: 0, y: 0, id: -1 };

canvas.addEventListener('pointerdown', (e) => {
  pointer.down = true;
  pointer.moved = false;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.id = e.pointerId;
  canvas.setPointerCapture?.(e.pointerId);
});

window.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  const dx = e.clientX - pointer.x;
  const dy = e.clientY - pointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = pointer.moved || Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 4;
  if (pointer.moved) {
    camState.azim -= dx * 0.005;
    camState.elev = Math.min(1.35, Math.max(0.18, camState.elev + dy * 0.0035));
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    applyCamera();
  }
});

window.addEventListener('pointerup', (e) => {
  if (!pointer.down) return;
  pointer.down = false;
  canvas.releasePointerCapture?.(e.pointerId);
  if (pointer.moved) return;
  // 空白处点击 = 取消选中(负向对照:不得无条件选中)
  let best = null;
  let bestD = Infinity;
  for (const t of pickTargets) {
    const d = Math.hypot(e.clientX - t.screenX, e.clientY - t.screenY);
    if (d <= t.screenRadius && d < bestD) {
      bestD = d;
      best = t.name;
    }
  }
  setSelected(best);
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camState.dist = Math.min(160, Math.max(26, camState.dist * (1 + Math.sign(e.deltaY) * 0.09)));
    applyCamera();
  },
  { passive: false },
);

for (const b of ui.speedButtons) {
  b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
}
ui.resetBtn.addEventListener('click', () => doReset());

// --- 模拟推进 ---------------------------------------------------------------
function stepSimulation(simDt) {
  // 公转:角速度 = 2π / 周期;内侧显著快于外侧(开普勒式分层)
  for (const p of planets) {
    p.angle += (TAU / p.def.period) * simDt;
    p.orbitPivot.rotation.y = -p.angle;
    p.spin += simDt * (0.18 + p.def.orbitRadius * 0.006);
    p.mesh.rotation.y = p.spin;
    for (const m of p.moons) {
      m.angle += (TAU / m.def.period) * simDt;
      m.pivot.rotation.y = -m.angle;
      m.mesh.rotation.y = m.angle * 2.4;
    }
  }
  // 小行星带:逐实例推进角位(带内速度分层)
  const inst = beltMesh;
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    a.angle += a.omega * simDt;
    beltDummy.position.set(a.r * Math.cos(a.angle), a.y, a.r * Math.sin(a.angle));
    beltDummy.rotation.set(0, a.angle + a.spinRate * state.simTime, 0);
    beltDummy.scale.setScalar(a.size);
    beltDummy.updateMatrix();
    inst.setMatrixAt(i, beltDummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
}

function doReset() {
  state.simTime = 0;
  setSpeed(1);
  for (const p of planets) {
    p.angle = p.initAngle; // 第 k 颗回到 k × 45°
    p.orbitPivot.rotation.y = -p.angle;
    p.spin = 0;
    p.mesh.rotation.y = 0;
    for (const m of p.moons) {
      m.angle = m.initAngle;
      m.pivot.rotation.y = -m.angle;
    }
  }
  const inst = beltMesh;
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    a.angle = a.initAngle;
    beltDummy.position.set(a.r * Math.cos(a.angle), a.y, a.r * Math.sin(a.angle));
    beltDummy.rotation.set(0, a.angle, 0);
    beltDummy.scale.setScalar(a.size);
    beltDummy.updateMatrix();
    inst.setMatrixAt(i, beltDummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  // 视角也回到初始构图
  camState.azim = CAM_INIT.azim;
  camState.elev = CAM_INIT.elev;
  camState.dist = CAM_INIT.dist;
  applyCamera();
  setSelected(null);
  state.epoch += 1;
}

// --- getState ---------------------------------------------------------------
function getState() {
  const cardVisible = !ui.card.classList.contains('hidden');
  return {
    engine: 'three',
    planetCount: planets.length,
    moonCount,
    asteroidCount: ASTEROID_COUNT,
    ringedPlanetCount: planets.filter((p) => p.def.ring).length,
    timeScale: state.timeScale,
    simulationTime: state.simTime,
    selectedPlanet: state.selected,
    planets: planets.map((p) => ({ name: p.def.name, orbitRadius: p.def.orbitRadius, orbitAngle: p.angle })),
    pickTargets: pickTargets.map((t) => ({ name: t.name, screenX: t.screenX, screenY: t.screenY, screenRadius: t.screenRadius })),
    infoCard: { visible: cardVisible, name: cardVisible ? state.selected : '', fieldCount: cardVisible ? 5 : 0 },
    fps: Math.round(state.fps * 10) / 10,
    epoch: state.epoch,
  };
}

window.__bench = { getState, reset: doReset };

// --- 主循环 ------------------------------------------------------------------
applyCamera();
updatePickTargets();
renderer.compile(scene, camera); // 预热着色器编译

let lastT = performance.now();
const frameStamps = [];
let cardTick = 0;

function tick(now) {
  const raw = (now - lastT) / 1000;
  lastT = now;
  const dt = Math.min(Math.max(raw, 0), 0.1); // 后台节流回来后不跳帧
  const simDt = dt * state.timeScale;
  state.simTime += simDt;

  stepSimulation(simDt);

  // 恒星外晕轻微呼吸(真实时间驱动,与倍率无关):让画面始终有生命感
  const t = now / 1000;
  haloOuter.scale.setScalar(30 * (1 + 0.02 * Math.sin(t * 1.6)));
  haloOuter.material.opacity = 0.8 + 0.08 * Math.sin(t * 1.6 + 0.7);

  // 选中环脉动
  if (state.selected) {
    const p = planetBy.get(state.selected);
    const s = p.ringSize * (1 + 0.035 * Math.sin(t * 5.2));
    p.highlight.scale.set(s, s, 1);
    p.highlight.material.opacity = 0.75 + 0.25 * Math.sin(t * 5.2);
  }

  updatePickTargets();
  renderer.render(scene, camera);

  // fps:最近 2s 滚动平均
  frameStamps.push(now);
  while (frameStamps.length > 0 && now - frameStamps[0] > 2000) frameStamps.shift();
  if (frameStamps.length > 2) {
    const span = (frameStamps[frameStamps.length - 1] - frameStamps[0]) / 1000;
    if (span >= 1.0) state.fps = (frameStamps.length - 1) / span;
  }

  // 信息卡里的实时轨道角(5Hz 刷新,避免每帧读写 DOM)
  cardTick += 1;
  if (state.selected && cardTick % 12 === 0) updateCard();

  if (window.__appReady !== true) window.__appReady = true;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 --------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
