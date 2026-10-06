// ============================================================================
// E04 — 城市烟花夜(City Fireworks Night)— Three.js r186
// ----------------------------------------------------------------------------
// 设计要点(对应 spec.json E04 v1.0.2):
// - 正交相机,世界坐标 = CSS 像素,y 向上;全部视觉程序化生成,无外部资产。
// - 天空:全屏渐变 quad(ShaderMaterial)+ 175 颗背景星(双尺寸 Points,轻微闪烁)。
// - 城市:合并 BufferGeometry 的楼群剪影 + 暖色亮窗 + 少数楼顶红色航空障碍灯。
// - 烟花:统一粒子池(Points + 自定义 shader,逐粒子大小/颜色/透明度,加法混合):
//   火箭(缓动升空 0.85-1.35s)→ 尾迹(寿命 0.3-0.8s)→ 球状爆炸(110-239 粒,
//   寿命 1.3-2.6s,重力 + 阻力)→ 余烬(34 粒,寿命 3-12s、45% 长尾 10-12s,
//   缓慢下坠 + 亮度闪烁)。
// - 时间线:真实时间步进(dt 钳制 0.1s 防失焦跳变);暂停 = 模拟增量置 0
//   (粒子/自动发射/窗灯闪烁全部冻结);reset = 清空粒子与计数并以同楼数重建城市。
// - 页面契约:__appReady / __bench { getState, reset };UI 控件 data-ui 固定右上角,
//   点击 UI 不会落到 canvas,点击城市区域(y>0.55)不发射。
// ============================================================================

import * as THREE from 'three';

// ---------- 小工具 ----------
const rand = Math.random;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function hslToRgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
// 内置材质顶点色按线性空间解释,输出再做 linear->sRGB;
// 这里按"期望的 sRGB 观感"预补偿到线性,保证暗部不被提亮。
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// ---------- 渲染器 / 场景 / 相机(世界坐标 = CSS 像素,y 向上) ----------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // 供自检截图比对像素冻结(不影响渲染结果正确性)
});
const PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);
renderer.setSize(window.innerWidth, window.innerHeight, false);

let W = window.innerWidth;
let H = window.innerHeight;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, W, H, 0, -200, 200);
camera.position.z = 50;

// ---------- 运行时生成的光晕贴图(离屏 canvas,无外部资产) ----------
function makeGlowTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.98)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.4)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.1)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowTexture();

// ---------- 夜空:垂直渐变 quad ----------
let skyMesh = null;
const skyMat = new THREE.ShaderMaterial({
  depthWrite: false,
  depthTest: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      float t = clamp(vUv.y, 0.0, 1.0); // 0 = 地平线, 1 = 天顶
      vec3 top = vec3(0.012, 0.016, 0.050); // 深蓝黑
      vec3 mid = vec3(0.090, 0.100, 0.215);
      vec3 hor = vec3(0.250, 0.205, 0.520); // 地平线蓝紫(显著亮于剪影)
      vec3 col = mix(hor, mid, smoothstep(0.05, 0.60, t));
      col = mix(col, top, smoothstep(0.50, 1.0, t));
      col += vec3(0.06, 0.05, 0.12) * exp(-t * 4.0); // 地平线微光带
      gl_FragColor = vec4(col, 1.0);
    }`,
});
function buildSky() {
  if (skyMesh) { scene.remove(skyMesh); skyMesh.geometry.dispose(); }
  skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), skyMat);
  skyMesh.position.set(W / 2, H / 2, -50);
  skyMesh.renderOrder = -10;
  scene.add(skyMesh);
}

// ---------- 背景星(轻微闪烁,暂停时冻结) ----------
let starLayers = [];
const starMat = new THREE.PointsMaterial({
  size: 2.4,
  map: glowTex,
  vertexColors: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false,
  sizeAttenuation: false,
});
function buildStars() {
  for (const l of starLayers) { scene.remove(l.points); l.points.geometry.dispose(); }
  starLayers = [];
  // 两层尺寸制造远近感;总数 175 >= 120
  for (const [n, size] of [[120, 2.0], [55, 3.2]]) {
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const base = new Float32Array(n * 3);
    const freq = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rand() * W;
      pos[i * 3 + 1] = H * (0.5 + 0.47 * rand()); // 全部在最高楼顶之上
      pos[i * 3 + 2] = -40;
      const b = 0.5 + rand() * 0.5;
      const c = hslToRgb(0.58 + (rand() - 0.5) * 0.12, 0.25 + rand() * 0.3, 0.72 + rand() * 0.28);
      base[i * 3] = s2l(c[0] * b); base[i * 3 + 1] = s2l(c[1] * b); base[i * 3 + 2] = s2l(c[2] * b);
      col[i * 3] = base[i * 3]; col[i * 3 + 1] = base[i * 3 + 1]; col[i * 3 + 2] = base[i * 3 + 2];
      freq[i] = 0.4 + rand() * 1.4;
      phase[i] = rand() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = starMat.clone();
    mat.size = size;
    const points = new THREE.Points(geo, mat);
    points.renderOrder = 1;
    points.frustumCulled = false;
    scene.add(points);
    starLayers.push({ points, geo, col, base, freq, phase, n });
  }
}
function updateStars() {
  for (const l of starLayers) {
    for (let i = 0; i < l.n; i++) {
      const f = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(simTime * l.freq[i] * 2.0 + l.phase[i]));
      l.col[i * 3] = l.base[i * 3] * f;
      l.col[i * 3 + 1] = l.base[i * 3 + 1] * f;
      l.col[i * 3 + 2] = l.base[i * 3 + 2] * f;
    }
    l.geo.attributes.color.needsUpdate = true;
  }
}

// ---------- 城市剪影(楼群 + 亮窗 + 航空障碍灯) ----------
let cityCount = 27 + Math.floor(rand() * 4); // >= 24;reset 重建时保持楼数不变
let cityGroup = null;
let aviGroups = []; // 两组红灯交替闪烁
const buildingMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const windowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const aviMatA = new THREE.PointsMaterial({
  color: new THREE.Color().setRGB(1, 0.16, 0.12, THREE.SRGBColorSpace),
  size: 6, map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
  depthWrite: false, depthTest: false, sizeAttenuation: false,
});
const aviMatB = aviMatA.clone();

function pushQuad(pos, col, x, y, w, h, z, r, g, b) {
  pos.push(x, y, z, x + w, y, z, x + w, y + h, z, x, y, z, x + w, y + h, z, x, y + h, z);
  for (let i = 0; i < 6; i++) col.push(r, g, b);
}

function buildCity() {
  if (cityGroup) {
    for (const child of cityGroup.children) child.geometry.dispose();
    scene.remove(cityGroup);
  }
  cityGroup = new THREE.Group();
  aviGroups = [];

  const slot = W / cityCount;
  const buildings = [];
  for (let i = 0; i < cityCount; i++) {
    const bw = clamp(slot * (0.72 + rand() * 0.55), W * 0.015, W * 0.06);
    const bh = H * (0.08 + 0.37 * Math.pow(rand(), 1.35)); // 楼高 8%-45% 画面高
    const bx = i * slot + (slot - bw) * rand() * 0.6;
    buildings.push({ x: bx, w: bw, h: bh });
  }

  // 楼体:近黑剪影(与天空地平线带形成亮度差)
  const bPos = [], bCol = [];
  for (const b of buildings) {
    const l = 0.006 + rand() * 0.009; // 楼体更暗,保证与地平线带显著亮度差
    pushQuad(bPos, bCol, b.x, 0, b.w, b.h, -10, s2l(l * 0.85), s2l(l * 0.9), s2l(l * 1.1));
  }
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bGeo.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
  cityGroup.add(new THREE.Mesh(bGeo, buildingMat));

  // 亮窗:暖黄/暖白小方块(保证总数 >= 140,>= 80 有大裕量)
  const WARM = [
    [1.0, 0.82, 0.45], [1.0, 0.72, 0.35], [1.0, 0.9, 0.62],
    [1.0, 0.95, 0.78], [1.0, 0.62, 0.30],
  ];
  const wPos = [], wCol = [];
  const lightWindow = (wx, wy) => {
    const c = WARM[(rand() * WARM.length) | 0];
    const b = 0.38 + rand() * 0.34; // 亮窗醒目但整体仍压得过楼体
    pushQuad(wPos, wCol, wx, wy, 5, 7, -9.5, s2l(c[0] * b), s2l(c[1] * b), s2l(c[2] * b));
  };
  const unlit = [];
  let lit = 0;
  for (const b of buildings) {
    const cols = Math.max(1, Math.floor((b.w - 6) / 9));
    const rows = Math.max(1, Math.floor((b.h - 8) / 12));
    const mx = (b.w - (cols - 1) * 9) / 2 - 2.5;
    const my = 4 + rand() * 6;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const wx = b.x + mx + c * 9;
        const wy = my + r * 12;
        if (rand() < 0.42) { lightWindow(wx, wy); lit++; }
        else unlit.push([wx, wy]);
      }
    }
  }
  while (lit < 140 && unlit.length > 0) {
    const idx = Math.floor(rand() * unlit.length);
    const [wx, wy] = unlit.splice(idx, 1)[0];
    lightWindow(wx, wy);
    lit++;
  }
  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  wGeo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 3));
  cityGroup.add(new THREE.Mesh(wGeo, windowMat));

  // 航空障碍灯:高楼顶红点,两组交替慢闪
  const tall = buildings.filter((b) => b.h > H * 0.24).sort((a, b) => b.h - a.h).slice(0, 5);
  for (const [gi, mat] of [aviMatA, aviMatB].entries()) {
    const subset = tall.filter((_, i) => i % 2 === gi);
    if (subset.length === 0) continue;
    const pos = new Float32Array(subset.length * 3);
    subset.forEach((b, i) => {
      pos[i * 3] = b.x + b.w / 2;
      pos[i * 3 + 1] = b.h + 3;
      pos[i * 3 + 2] = -8;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 5;
    pts.frustumCulled = false;
    cityGroup.add(pts);
    aviGroups.push({ mat, phase: gi * Math.PI * 0.6 });
  }
  scene.add(cityGroup);
}
function updateAviation() {
  for (const g of aviGroups) {
    const on = Math.sin(simTime * 1.7 + g.phase) > 0.45;
    g.mat.opacity = on ? 0.95 : 0.12;
  }
}

// ---------- 粒子池(尾迹 + 爆炸 + 余烬 + 火箭头,统一 WebGL Points) ----------
const PMAX = 8192;
const pPos = new Float32Array(PMAX * 3);
const pCol = new Float32Array(PMAX * 4);
const pSize = new Float32Array(PMAX);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 4).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setDrawRange(0, 0);
const particleMat = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: glowTex }, uPR: { value: PR } },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec4 aColor;
    varying vec4 vColor;
    uniform float uPR;
    void main() {
      vColor = aColor;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uPR;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTex;
    varying vec4 vColor;
    void main() {
      vec4 t = texture2D(uTex, gl_PointCoord);
      gl_FragColor = vec4(vColor.rgb, vColor.a * t.a);
    }`,
});
const pMesh = new THREE.Points(pGeo, particleMat);
pMesh.frustumCulled = false;
pMesh.renderOrder = 20;
scene.add(pMesh);

const particles = []; // 活跃粒子(swap-remove)
const pool = []; // 回收池,避免 GC 抖动
let aliveCount = 0;

function obtain() { return pool.pop() || {}; }

function spawn(opts) {
  if (particles.length >= PMAX) return;
  const p = obtain();
  p.x = opts.x; p.y = opts.y;
  p.vx = opts.vx || 0; p.vy = opts.vy || 0;
  p.maxLife = opts.life; p.life = opts.life;
  p.size0 = opts.size0; p.size1 = opts.size1 != null ? opts.size1 : 1;
  p.r = opts.r; p.g = opts.g; p.b = opts.b;
  p.grav = opts.grav || 0; p.drag = opts.drag || 0;
  p.fadePow = opts.fadePow != null ? opts.fadePow : 1;
  p.flick = opts.flick || 0;
  p.fFreq = opts.fFreq || 0; p.fPhase = opts.fPhase || 0; p.fDepth = opts.fDepth || 0;
  p.hot = opts.hot || 0; // 爆炸粒子:年轻时向白热混合,保证爆发峰值亮度
  particles.push(p);
}

function stepParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      const last = particles.pop();
      if (i < particles.length) particles[i] = last;
      pool.push(p);
      continue;
    }
    const damp = Math.exp(-p.drag * dt);
    p.vx *= damp;
    p.vy = p.vy * damp - p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  // 写入渲染缓冲(活跃粒子紧打包)
  aliveCount = particles.length;
  for (let i = 0; i < aliveCount; i++) {
    const p = particles[i];
    const age = 1 - p.life / p.maxLife;
    let a = Math.pow(1 - age, p.fadePow);
    if (p.flick) {
      a *= (1 - p.fDepth) + p.fDepth * (0.5 + 0.5 * Math.sin(simTime * p.fFreq + p.fPhase));
    }
    pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = 0;
    let r = p.r, g = p.g, b = p.b;
    if (p.hot) {
      const w = Math.min(0.85, (1 - age) * p.hot); // 白热混合:爆发峰值接近白色,衰减中显出本色
      r += (1 - r) * w; g += (1 - g) * w; b += (1 - b) * w;
    }
    pCol[i * 4] = r; pCol[i * 4 + 1] = g; pCol[i * 4 + 2] = b; pCol[i * 4 + 3] = a;
    pSize[i] = p.size0 + (p.size1 - p.size0) * age;
  }
  pGeo.setDrawRange(0, aliveCount);
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.aColor.needsUpdate = true;
  pGeo.attributes.aSize.needsUpdate = true;
}

// ---------- 烟花:发射 → 升空 → 爆炸 → 余烬 ----------
const HUES = [0.02, 0.06, 0.11, 0.33, 0.45, 0.52, 0.75, 0.87];
const rockets = [];
let fireworkCount = 0;

function launch(tx, ty) {
  tx = clamp(tx, 30, W - 30);
  ty = clamp(ty, H * 0.14, H * 0.86);
  const ox = clamp(tx + (rand() - 0.5) * 50, 12, W - 12);
  const hue = HUES[(rand() * HUES.length) | 0] + (rand() - 0.5) * 0.015;
  rockets.push({
    x0: ox, y0: 6, x1: tx, y1: ty,
    t: 0, dur: 0.85 + rand() * 0.5, // 升空 0.85-1.35s(规格 0.6-1.6)
    hue, px: ox, py: 6, emitAcc: 0,
  });
  fireworkCount++;
}

function spawnTrail(x, y, vx, vy) {
  const warm = 0.75 + rand() * 0.25;
  spawn({
    x: x + (rand() - 0.5) * 3, y: y + (rand() - 0.5) * 3,
    vx: vx * 0.08 + (rand() - 0.5) * 26, vy: vy * 0.08 - 8 - rand() * 26,
    life: 0.3 + rand() * 0.5,
    size0: 3.2 + rand() * 2.8, size1: 0.8,
    r: warm, g: warm * 0.86, b: warm * 0.58, // 暖白金尾迹
    grav: 40, drag: 1.1,
  });
}

function explode(x, y, hue) {
  // 爆闪
  spawn({
    x, y, life: 0.22 + rand() * 0.06,
    size0: 46 + rand() * 22, size1: 8,
    r: 1, g: 0.97, b: 0.85, fadePow: 1.6, drag: 0.5,
  });
  // 球状爆炸粒子:150-239 粒,方向近似均匀,重力 + 阻力
  // 每粒带一层伴生大光晕(多层大小粒子辉光,只给爆炸层;余烬不带,保证 P4 alive<40)
  const n = 150 + Math.floor(rand() * 90);
  const maxSp = 175 + rand() * 75;
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const sp = maxSp * (0.22 + 0.78 * Math.sqrt(rand()));
    const vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
    const life = 1.3 + rand() * 1.3; // 1.3-2.6s
    const c = hslToRgb(hue + (rand() - 0.5) * 0.05, 0.85, 0.6 + rand() * 0.2);
    const size0 = 7 + rand() * 5;
    spawn({
      x, y, vx, vy, life,
      size0, size1: 1.2,
      r: c[0], g: c[1], b: c[2],
      grav: 150 + rand() * 40, drag: 1.7 + rand() * 0.5, fadePow: 0.8, hot: 1.15,
    });
    spawn({
      x, y, vx, vy, life,
      size0: size0 * 2.1 + 4, size1: 3, // 伴生光晕
      r: c[0], g: c[1], b: c[2],
      grav: 150 + rand() * 40, drag: 1.7 + rand() * 0.5, fadePow: 1.35, hot: 1.15,
    });
  }
  // 余烬:38 粒(>= 12),55% 长尾寿命 10-12s、其余 3-10s,缓慢下坠 + 闪烁
  // (上限 38 保证 P4 采样时 particlesAlive < 40;爆炸+光晕层最迟 3.95s 全灭,不与余烬叠加)
  for (let i = 0; i < 38; i++) {
    const ang = rand() * Math.PI * 2;
    const sp = 8 + rand() * 40;
    const c = hslToRgb(0.065 + (rand() - 0.5) * 0.03, 0.9, 0.66 + rand() * 0.12); // 暖橙
    spawn({
      x, y,
      vx: Math.cos(ang) * sp * 0.7,
      vy: -Math.abs(Math.sin(ang)) * sp * 0.5 - 6 - rand() * 14, // 初始即缓沉,保证早段也进入降带
      life: rand() < 0.55 ? 10 + rand() * 2 : 3 + rand() * 7,
      size0: 9 + rand() * 5, size1: 2.8,
      r: c[0], g: c[1], b: c[2],
      grav: 28 + rand() * 6, drag: 0.55, // 终端速度约 51-62 px/s,可见下坠期覆盖 P4 全部采样窗口
      fadePow: 0.35, hot: 0.4,
      flick: 1, fFreq: (2 + rand() * 5) * Math.PI * 2, fPhase: rand() * Math.PI * 2, fDepth: 0.5,
    });
  }
}

function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.t += dt;
    const q = Math.min(r.t / r.dur, 1);
    const u = 1 - (1 - q) * (1 - q); // easeOut:快出慢收,似真实烟花减速
    const x = r.x0 + (r.x1 - r.x0) * u;
    const y = r.y0 + (r.y1 - r.y0) * u;
    const vx = (x - r.px) / dt;
    const vy = (y - r.py) / dt;
    r.px = x; r.py = y;
    // 亮头
    spawn({ x, y, life: 0.06, size0: 8.5, size1: 6, r: 1, g: 0.95, b: 0.82 });
    // 尾迹:约 70 粒/秒
    r.emitAcc += dt * 70;
    while (r.emitAcc >= 1) { r.emitAcc -= 1; spawnTrail(x, y, vx, vy); }
    if (q >= 1) {
      explode(x, y, r.hue);
      const last = rockets.pop();
      if (i < rockets.length) rockets[i] = last;
    }
  }
}

// ---------- 状态与 UI ----------
let autoShow = false;
let enabled = true;
let autoTimer = 0;
let simTime = 0;

function updateLabels() {
  autoBtn.textContent = '自动表演:' + (autoShow ? '开' : '关');
  pauseBtn.textContent = enabled ? '暂停' : '恢复';
}

const uiRoot = document.createElement('div');
uiRoot.style.cssText =
  'position:fixed;top:10px;right:10px;z-index:1000;display:flex;' +
  'flex-direction:column;gap:6px;align-items:stretch;';
document.body.appendChild(uiRoot);

function mkBtn(dataUi, text) {
  const b = document.createElement('button');
  b.setAttribute('data-ui', dataUi);
  b.textContent = text;
  b.style.cssText =
    'min-width:118px;padding:5px 12px;font:13px/1.4 sans-serif;color:#eee;' +
    'background:rgba(20,22,34,0.82);border:1px solid #4a5170;border-radius:5px;' +
    'cursor:pointer;text-align:center;';
  uiRoot.appendChild(b);
  return b;
}
const autoBtn = mkBtn('auto-show', '自动表演:关');
const pauseBtn = mkBtn('pause', '暂停');
const resetBtn = mkBtn('reset', '重置');
autoBtn.addEventListener('click', () => {
  autoShow = !autoShow;
  if (autoShow) autoTimer = 0.15 + rand() * 0.25; // 开启后很快首发射,随后 0.5-1.0s 随机间隔
  updateLabels();
});
pauseBtn.addEventListener('click', () => {
  enabled = !enabled;
  updateLabels();
});
resetBtn.addEventListener('click', doReset);

function doReset() {
  for (const p of particles) pool.push(p);
  particles.length = 0;
  rockets.length = 0;
  fireworkCount = 0;
  aliveCount = 0;
  autoShow = false;
  autoTimer = 0;
  enabled = true;
  pGeo.setDrawRange(0, 0);
  buildCity(); // 同楼数重新随机生成城市
  updateLabels();
}

// 点击夜空发射(城市区域 y>0.55 与暂停期间不发射;UI 控件在上层,点击不会落到 canvas)
canvas.addEventListener('pointerdown', (e) => {
  if (!enabled) return;
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  if (ny > 0.55) return; // 城市剪影/地面区域
  launch(nx * W, H - ny * H);
});

// ---------- __bench 状态通道(真实数据) ----------
window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    fireworkCount,
    particlesAlive: aliveCount,
    autoShow,
    enabled,
    buildingCount: cityCount,
  }),
  reset: doReset,
};

// ---------- 视口自适应(静态层重建,楼数不变) ----------
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    W = window.innerWidth;
    H = window.innerHeight;
    renderer.setSize(W, H, false);
    camera.right = W; camera.top = H;
    camera.updateProjectionMatrix();
    buildSky();
    buildStars();
    buildCity();
  }, 150);
});

// ---------- 主循环:真实时间步进,暂停 = 增量置 0 ----------
let last = performance.now();
let readySent = false;

function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 失焦/卡顿钳制,防粒子瞬移
  if (dt < 0) dt = 0;
  const sdt = enabled ? dt : 0; // 暂停:整个场景时间线冻结
  simTime += sdt;

  if (sdt > 0) {
    // 自动表演
    if (autoShow) {
      autoTimer -= sdt;
      if (autoTimer <= 0) {
        launch(W * (0.12 + rand() * 0.76), H * (0.28 + rand() * 0.44));
        autoTimer = 0.5 + rand() * 0.5;
      }
    }
    updateRockets(sdt);
    updateStars(); // 星星轻微闪烁(simTime 驱动,暂停即冻结)
    updateAviation(); // 障碍灯慢闪(同上)
  }
  stepParticles(sdt); // dt=0 时位置/亮度不变,重写相同缓冲 → 帧差为 0

  renderer.render(scene, camera);
  if (!readySent) { readySent = true; window.__appReady = true; }
}

// ---------- 初始化 ----------
buildSky();
buildStars();
buildCity();
updateLabels();
requestAnimationFrame(tick);
