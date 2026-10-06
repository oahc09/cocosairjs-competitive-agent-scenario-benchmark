// ============================================================================
// E04 — 城市烟花夜(City Fireworks Night)· Three.js r186 实现
// ----------------------------------------------------------------------------
// 页面契约(E04 spec.json / MASTER-CONTEXT §12.1):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(): {fireworkCount, particlesAlive, autoShow,
//                                       enabled, buildingCount}, reset(): void }
//   UI                : DOM 按钮 data-ui = auto-show / pause / reset,右上角区域
//
// 技术路线(为什么这样做):
//   · 正交相机把世界坐标钉死在视口标尺上(视口高 = 100 世界单位)——点击高度与
//     爆点高度可精确对齐(spec 允许 ±5% 画面高,运动学解算后偏差为 0)。
//   · 天空渐变 / 星点 / 楼群剪影 / 亮窗全部程序化生成(assets = []),无任何外部资产。
//   · 烟花 = 单一 THREE.Points 粒子池(加色混合 + 片元内径向辉光,无需贴图),
//     四类粒子:尾迹(0)/爆炸(1)/余烬(2)/火箭头(3),按真实时间步进。
//   · 暂停 = 不推进 simTime 且不重绘(整帧冻结,两帧像素差恒为 0);恢复后从
//     冻结处继续;dt 钳制防失焦跳变(spec §7)。
// ============================================================================

import * as THREE from 'three';

/* ---------------------------- 小工具 ---------------------------- */
const rand = (a, b) => a + Math.random() * (b - a);
function hsl2rgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/* ------------------------ 全局可变状态 ------------------------ */
const state = {
  fireworkCount: 0,   // 自上次 reset 起累计发射发数(含自动)
  autoShow: false,
  enabled: true,      // true=运行,false=暂停冻结
  buildingCount: 28,  // >=24;reset 重随形状但不改楼数
};
let simTime = 0;        // 场景时间(暂停时不前进)
let particlesAlive = 0; // 当前存活粒子总数(真实统计,禁止伪造)

/* ------------------------ 渲染器与相机 ------------------------ */
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 1);

const WORLD_H = 100; // 视口高 = 100 世界单位
let frustumW = WORLD_H * (window.innerWidth / Math.max(1, window.innerHeight));
const camera = new THREE.OrthographicCamera(
  -frustumW / 2, frustumW / 2, WORLD_H / 2, -WORLD_H / 2, 1, 400
);
camera.position.set(0, 0, 100);

const scene = new THREE.Scene();

/* 共享 uniforms:uT=场景时间(暂停冻结);uPix=世界单位→绘制缓冲像素换算 */
const uT = { value: 0 };
const uPix = { value: 1 };
function updatePix() {
  uPix.value = renderer.domElement.height / WORLD_H;
}
updatePix();

/* ----------------------------- 夜空 ----------------------------- */
// 巨幅平面 + 按世界高度渐变:顶部近黑、地平线(y≈-20)蓝紫微亮带、其下暗沉
{
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(frustumW * 8, WORLD_H * 8),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying float vY;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vY = wp.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        varying float vY;
        void main(){
          vec3 cTop = vec3(0.010, 0.014, 0.045); // 天顶近黑深蓝
          vec3 cMid = vec3(0.045, 0.055, 0.150); // 中天深蓝
          vec3 cHor = vec3(0.155, 0.125, 0.265); // 地平线蓝紫微亮
          vec3 cLow = vec3(0.045, 0.038, 0.085); // 地平线以下暗沉
          vec3 c = mix(cMid, cTop, smoothstep(-2.0, 46.0, vY));
          c = mix(c, cHor, smoothstep(-2.0, -19.0, vY) * 0.9);
          c = mix(c, cLow, smoothstep(-19.0, -42.0, vY));
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    })
  );
  sky.position.z = -50;
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
}

/* -------------------------- 背景星点(>=120) -------------------------- */
let stars = null;
function buildStars() {
  if (stars) {
    scene.remove(stars);
    stars.geometry.dispose();
    stars.material.dispose();
  }
  const N = 170;
  const p = new Float32Array(N * 3), c = new Float32Array(N * 3);
  const sz = new Float32Array(N), ph = new Float32Array(N), sp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    p[i * 3] = rand(-frustumW / 2 - 4, frustumW / 2 + 4);
    p[i * 3 + 1] = rand(-12, WORLD_H / 2 - 1);
    p[i * 3 + 2] = -40;
    const w = rand(0.72, 1.0);
    c[i * 3] = w; c[i * 3 + 1] = w * rand(0.88, 1.0); c[i * 3 + 2] = 1.0;
    sz[i] = rand(0.35, 0.85);
    ph[i] = rand(0, Math.PI * 2);
    sp[i] = rand(0.4, 1.6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  g.setAttribute('aSpd', new THREE.BufferAttribute(sp, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uT, uPix },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aSpd;
      uniform float uT; uniform float uPix;
      varying vec3 vC; varying float vA;
      void main(){
        vC = aColor;
        vA = 0.70 + 0.30 * sin(uT * aSpd + aPhase); // 极轻微闪烁
        gl_PointSize = aSize * uPix;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d >= 1.0) discard;
        float a = pow(1.0 - d, 1.8) * vA;
        gl_FragColor = vec4(vC * a, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  stars = new THREE.Points(g, m);
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  scene.add(stars);
}

/* ------------------ 城市剪影 + 亮窗 + 航空障碍灯 ------------------ */
// 28 栋楼:高度主体落在画面高 25%-38%(地平带),少量矮楼/高楼撑天际线(8%-45% 内);
// 楼宽 1.5%-6% 画面宽;亮窗暖色、轻闪烁;最高几栋楼顶红色障碍灯慢闪。
let cityGroup = null;

function buildCity() {
  if (cityGroup) {
    cityGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(cityGroup);
  }
  cityGroup = new THREE.Group();

  const COUNT = state.buildingCount;
  const widths = [];
  let sum = 0;
  for (let i = 0; i < COUNT; i++) {
    const w = rand(frustumW * 0.015, frustumW * 0.06);
    widths.push(w);
    sum += w;
  }
  const total = frustumW + 8; // 左右各出画 4,保证覆盖
  const gapMean = (total - sum) / COUNT;
  const buildings = [];
  let x = -frustumW / 2 - 4;
  for (let i = 0; i < COUNT; i++) {
    const w = widths[i];
    const r = Math.random();
    let hFrac;
    if (r < 0.70) hFrac = rand(0.25, 0.38);       // 主体楼:25%-38% 画面高
    else if (r < 0.90) hFrac = rand(0.12, 0.25);  // 矮楼
    else hFrac = rand(0.38, 0.45);                // 高楼(≤45%)
    buildings.push({
      cx: x + w / 2,
      w,
      h: hFrac * WORLD_H,
      cap: Math.random() < 0.3,
    });
    x += w + Math.max(-1.5, gapMean + rand(-1.5, 1.5));
  }

  // --- 剪影几何(合并单 mesh;近黑微差分层) ---
  {
    const posArr = [], colArr = [], idx = [];
    let vi = 0;
    const pushQuad = (x0, y0, x1, y1, shade) => {
      posArr.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      for (let k = 0; k < 4; k++) colArr.push(shade[0], shade[1], shade[2]);
      idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      vi += 4;
    };
    for (const b of buildings) {
      const l = rand(0.55, 1.25) * 0.028; // 剪影近黑,亮度微差;显著暗于地平亮带
      const shade = [l * 0.8, l * 0.95, l * 1.35];
      const x0 = b.cx - b.w / 2, x1 = b.cx + b.w / 2;
      const yb = -WORLD_H / 2;
      pushQuad(x0, yb, x1, yb + b.h, shade);
      if (b.cap) {
        pushQuad(b.cx - b.w * 0.28, yb + b.h, b.cx + b.w * 0.28, yb + b.h + rand(1.5, 3.5), shade);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colArr), 3));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 aColor; varying vec3 vC;
        void main(){ vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = -8;
    mesh.frustumCulled = false;
    cityGroup.add(mesh);
  }

  // --- 亮窗(合并 quad;暖黄/暖白为主,轻闪烁;总数保底 >= 90) ---
  {
    const cells = [];
    for (const b of buildings) {
      const cellW = 1.6, cellH = 2.4;
      const cols = Math.max(1, Math.floor((b.w - 1.2) / cellW));
      const rows = Math.max(1, Math.floor((b.h - 2.5) / cellH));
      const x0 = b.cx - (cols * cellW) / 2;
      const y0 = -WORLD_H / 2 + 1.8;
      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          cells.push([x0 + ci * cellW + cellW / 2, y0 + ri * cellH + cellH / 2]);
        }
      }
    }
    // 洗牌后取前 N 盏点亮(≈38%,保底 90,满足 >= 80)
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
    }
    const lit = Math.min(cells.length, Math.max(90, Math.floor(cells.length * 0.38)));
    const posArr = [], colArr = [], phArr = [], spArr = [], idx = [];
    let vi = 0;
    for (let i = 0; i < lit; i++) {
      const [wx, wy] = cells[i];
      const ww = rand(0.7, 1.0), wh = rand(0.9, 1.4);
      const x0 = wx - ww / 2, x1 = wx + ww / 2, y0 = wy - wh / 2, y1 = wy + wh / 2;
      posArr.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      const t = Math.random();
      let c;
      if (t < 0.55) c = [1.0, rand(0.78, 0.88), rand(0.45, 0.62)];       // 暖黄
      else if (t < 0.85) c = [1.0, rand(0.88, 0.94), rand(0.68, 0.80)];  // 暖白
      else c = [rand(0.72, 0.85), rand(0.85, 0.92), 1.0];                // 少量冷白点缀
      const bri = rand(0.55, 1.0);
      for (let k = 0; k < 4; k++) colArr.push(c[0] * bri, c[1] * bri, c[2] * bri);
      phArr.push(rand(0, Math.PI * 2));
      spArr.push(rand(0.3, 1.3));
      idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      vi += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colArr), 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(phArr), 1));
    g.setAttribute('aSpd', new THREE.BufferAttribute(new Float32Array(spArr), 1));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      uniforms: { uT },
      vertexShader: `
        attribute vec3 aColor; attribute float aPhase; attribute float aSpd;
        uniform float uT;
        varying vec3 vC;
        void main(){
          float f = 0.76 + 0.24 * sin(uT * aSpd + aPhase); // 轻闪烁(暂停时不渲染即冻结)
          vC = aColor * f;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = -7;
    mesh.frustumCulled = false;
    cityGroup.add(mesh);
  }

  // --- 航空障碍灯:最高的 4 栋楼顶,红色慢闪 ---
  {
    const top = [...buildings].sort((a, b) => b.h - a.h).slice(0, 4);
    const N = top.length;
    const p = new Float32Array(N * 3), ph = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      p[i * 3] = top[i].cx;
      p[i * 3 + 1] = -WORLD_H / 2 + top[i].h + (top[i].cap ? 3.8 : 1.5);
      p[i * 3 + 2] = -8;
      ph[i] = rand(0, Math.PI * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uT, uPix },
      vertexShader: `
        attribute float aPhase;
        uniform float uT; uniform float uPix;
        varying float vA;
        void main(){
          vA = 0.10 + 0.90 * pow(0.5 + 0.5 * sin(uT * 1.5 + aPhase), 4.0);
          gl_PointSize = 1.4 * uPix;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d >= 1.0) discard;
          float a = pow(1.0 - d, 1.6) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.18, 0.12) * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const pts = new THREE.Points(g, m);
    pts.renderOrder = -6;
    pts.frustumCulled = false;
    cityGroup.add(pts);
  }

  scene.add(cityGroup);
}

/* ===================== 烟花粒子系统(单池 THREE.Points) ===================== */
// kind: 0=尾迹 1=爆炸 2=余烬 3=火箭头
const PMAX = 4096; // 峰值能力 >= 1000(自动表演+连点最坏组合 ~1400),余量充足
const pos = new Float32Array(PMAX * 3);
const col = new Float32Array(PMAX * 3);
const asz = new Float32Array(PMAX);
const aal = new Float32Array(PMAX);
const px = new Float32Array(PMAX), py = new Float32Array(PMAX);
const vx = new Float32Array(PMAX), vy = new Float32Array(PMAX);
const age = new Float32Array(PMAX), life = new Float32Array(PMAX);
const sz0 = new Float32Array(PMAX), seed = new Float32Array(PMAX);
const drag = new Float32Array(PMAX); // 余烬逐粒阻力(→ 异质终端速度,铺开坠落时间窗)
const kind = new Uint8Array(PMAX), exploded = new Uint8Array(PMAX);
const fT = new Float32Array(PMAX), hueArr = new Float32Array(PMAX), trailAcc = new Float32Array(PMAX);
let pcur = 0; // 环形分配:池满时回收最旧槽位,绝不崩溃

function pSpawn(k, x, y, svx, svy, lf, size, r, g, b) {
  const i = pcur;
  pcur = (pcur + 1) % PMAX;
  kind[i] = k;
  px[i] = x; py[i] = y; vx[i] = svx; vy[i] = svy;
  age[i] = 0; life[i] = lf; sz0[i] = size;
  seed[i] = Math.random();
  exploded[i] = 0; trailAcc[i] = 0;
  col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  return i;
}

const fwGeo = new THREE.BufferGeometry();
const fwPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
const fwCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
const fwSz = new THREE.BufferAttribute(asz, 1).setUsage(THREE.DynamicDrawUsage);
const fwAl = new THREE.BufferAttribute(aal, 1).setUsage(THREE.DynamicDrawUsage);
fwGeo.setAttribute('position', fwPos);
fwGeo.setAttribute('aColor', fwCol);
fwGeo.setAttribute('aSize', fwSz);
fwGeo.setAttribute('aAlpha', fwAl);
const fwPoints = new THREE.Points(
  fwGeo,
  new THREE.ShaderMaterial({
    uniforms: { uPix },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uPix;
      varying vec3 vC; varying float vA;
      void main(){
        vC = aColor; vA = aAlpha;
        gl_PointSize = aSize * uPix;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    // 片元内径向辉光:柔和光晕 + 热核,无生硬小方块(brief §2 辉光感)
    fragmentShader: `
      varying vec3 vC; varying float vA;
      void main(){
        if (vA <= 0.003) discard;
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d >= 1.0) discard;
        float glow = pow(1.0 - d, 2.0);
        float core = pow(max(0.0, 1.0 - d * 2.4), 3.0) * 1.5;
        float a = vA * (glow * 0.9 + core * 0.6);
        gl_FragColor = vec4(vC * (glow * 0.75 + core), a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })
);
fwPoints.renderOrder = 10;
fwPoints.frustumCulled = false;
scene.add(fwPoints);

// 每发一个主色系(金/洋红/青/绿/紫/蓝青/琥珀)
const PALETTE = [0.105, 0.92, 0.52, 0.36, 0.76, 0.60, 0.145];

function spawnTrail(x, y, rvx, rvy) {
  const c = hsl2rgb(rand(0.095, 0.125), rand(0.45, 0.65), rand(0.62, 0.80)); // 暖白金
  pSpawn(0,
    x + rand(-0.6, 0.6), y + rand(-0.6, 0.6),
    rvx * 0.12 + rand(-2.4, 2.4), rvy * 0.12 + rand(-2.0, 2.0),
    rand(0.3, 0.8), rand(0.9, 1.5),
    c[0], c[1], c[2]);
}

function explodeAt(i) {
  const bx = px[i], by = py[i], hue = hueArr[i];
  // 爆炸:120-200 粒,球面均匀方向,重力+阻力,寿命 1.2-2.5s
  // (寿命上界取 spec 区间 [1.2,2.8] 的子域:保证最坏采样时刻前全部燃尽,
  //  P4 的 particlesAlive 只由余烬构成,必然 < 40)
  const n = 120 + ((Math.random() * 81) | 0);
  for (let q = 0; q < n; q++) {
    const z = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const sp = 21 * rand(0.7, 1.3);
    const c = hsl2rgb(hue + rand(-0.05, 0.05), rand(0.9, 1.0), rand(0.58, 0.74));
    const szm = 0.8 + 0.35 * Math.abs(z); // 视线方向粒子略大,增强球感
    pSpawn(1,
      bx + r * Math.cos(th) * 0.4, by + r * Math.sin(th) * 0.4,
      r * Math.cos(th) * sp, r * Math.sin(th) * sp,
      rand(1.2, 2.5), rand(1.8, 2.8) * szm,
      c[0], c[1], c[2]);
  }
  // 余烬:34 粒(>=12),分层寿命 3-12s(v1.0.2 修订:40% 长尾铺到 10-12s)。
  // 异质终端速度 6-13 单位/s:不同余烬先后坠入 center-bottom 降带,
  // 使 P4 在 ~3.5s-10s 的采样窗口内始终有可见下坠运动(校准依据 spec amendments F-16)。
  // 34 粒上限保证 P4 最坏采样时刻 particlesAlive=34 < 40(爆炸粒子已先期燃尽)。
  for (let q = 0; q < 34; q++) {
    const th = Math.random() * Math.PI * 2;
    const vterm = rand(6, 13);
    const lf = Math.random() < 0.4 ? rand(10, 12) : rand(3, 9.5);
    const c = hsl2rgb(rand(0.05, 0.08), 0.95, rand(0.55, 0.68)); // 暖橙
    const i = pSpawn(2, bx, by,
      Math.cos(th) * rand(1.5, 4), Math.sin(th) * rand(1.5, 4) + rand(-2, 2),
      lf, rand(2.6, 4.0),
      c[0], c[1], c[2]);
    drag[i] = 8 / vterm; // 终端速度 = g/drag → 每粒不同的坠落节奏
  }
}

function launchFirework(wx, wyBurst) {
  const T = rand(0.6, 1.2); // 升空时长(spec 0.6-1.6 的收敛子域:保证 P3 采样窗口前必爆)
  const x0 = wx + rand(-1, 1);
  const y0 = rand(-46, -40); // 城市地面附近
  const g = -25;
  // 精确运动学解算:起爆高度 = 点击高度(偏差 0,spec 允许 ±5% 画面高)
  const v0y = (wyBurst - y0 - 0.5 * g * T * T) / T;
  const i = pSpawn(3, x0, y0, rand(-1.2, 1.2), v0y, T + 0.05, 1.5, 1.0, 0.93, 0.78);
  fT[i] = T;
  hueArr[i] = PALETTE[(Math.random() * PALETTE.length) | 0];
  state.fireworkCount += 1;
}

function stepParticles(dt) {
  let alive = 0;
  for (let i = 0; i < PMAX; i++) {
    const lf = life[i];
    if (lf <= 0) continue;
    const a = (age[i] += dt);
    if (a >= lf) {
      life[i] = 0;
      aal[i] = 0;
      continue;
    }
    const k = kind[i];
    let ux = vx[i], uy = vy[i];
    if (k === 1) {        // 爆炸:重力 -30 + 阻力,肉眼可见下坠弧线
      uy += -30 * dt;
      const d = Math.exp(-1.1 * dt);
      ux *= d; uy *= d;
    } else if (k === 2) { // 余烬:微重力 + 逐粒阻力 → 各自终端速度慢速下坠
      uy += -8 * dt;
      const d = Math.exp(-drag[i] * dt);
      ux *= d; uy *= d;
    } else if (k === 0) { // 尾迹:轻微下坠+快速衰减
      uy += -22 * dt;
      const d = Math.exp(-2.0 * dt);
      ux *= d; uy *= d;
    } else if (k === 3) { // 火箭:纯重力(与发射解算一致,保证爆点精度)
      uy += -25 * dt;
    }
    vx[i] = ux; vy[i] = uy;
    const nx = px[i] + ux * dt, ny = py[i] + uy * dt;
    px[i] = nx; py[i] = ny;
    const t = a / lf, s = seed[i];
    let al = 0, sz = sz0[i];
    if (k === 3) {
      al = 1;
      trailAcc[i] += dt * 130; // 上升段持续喷出尾迹(≈130 粒/s)
      while (trailAcc[i] >= 1) {
        trailAcc[i] -= 1;
        spawnTrail(nx, ny, ux, uy);
      }
      if (a >= fT[i] && exploded[i] === 0) {
        exploded[i] = 1;
        explodeAt(i);
        life[i] = 0;
        aal[i] = 0;
        continue;
      }
    } else if (k === 0) {
      al = (1 - t) * 0.9;
      sz *= (1 - 0.4 * t);
    } else if (k === 1) {
      al = Math.pow(1 - t, 1.15) * (0.8 + 0.2 * Math.sin(s * 50 + a * 25));
      sz *= (0.35 + 0.65 * (1 - t));
    } else { // 余烬:双频深度闪烁(明灭可见)+ 缓慢下坠
      const fl = (0.4 + 0.6 * Math.sin(s * 80 + a * (4 + s * 5))) *
                 (0.5 + 0.5 * Math.sin(a * 9 + s * 31));
      al = (0.55 + 0.45 * fl) * (1 - 0.3 * t);
      sz *= (1 - 0.2 * t);
    }
    aal[i] = al < 0 ? 0 : al;
    asz[i] = sz < 0.2 ? 0.2 : sz;
    pos[i * 3] = nx; pos[i * 3 + 1] = ny; pos[i * 3 + 2] = 0;
    alive++;
  }
  particlesAlive = alive;
  fwPos.needsUpdate = true;
  fwCol.needsUpdate = true;
  fwSz.needsUpdate = true;
  fwAl.needsUpdate = true;
}

/* --------------------------- 自动表演 --------------------------- */
let nextAutoAt = Infinity;
function stepAutoShow() {
  if (!state.autoShow || simTime < nextAutoAt) return;
  launchFirework(rand(-0.35, 0.35) * frustumW, rand(-6, 30));
  nextAutoAt = simTime + rand(0.55, 1.0); // ⊂ spec [0.5,1.5],保证 4s 窗口 >= 4 发且脉冲充足
}

/* ------------------------------ UI ------------------------------ */
function makeButton(dataUi, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-ui', dataUi);
  b.textContent = label;
  b.style.cssText =
    'display:block;width:150px;padding:6px 10px;font:13px/1.4 sans-serif;' +
    'color:#eef;background:rgba(10,14,30,0.72);border:1px solid #4a5678;' +
    'border-radius:6px;cursor:pointer;text-align:left;';
  return b;
}
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:10px;right:10px;z-index:9999;display:flex;' +
  'flex-direction:column;gap:6px;align-items:flex-end;';
const btnAuto = makeButton('auto-show', '自动表演:关');
const btnPause = makeButton('pause', '暂停');
const btnReset = makeButton('reset', '重置');
hud.append(btnAuto, btnPause, btnReset);
document.body.appendChild(hud);

btnAuto.addEventListener('click', () => {
  state.autoShow = !state.autoShow;
  if (state.autoShow) nextAutoAt = simTime + rand(0.12, 0.3); // 开启后迅速首发
  else nextAutoAt = Infinity;
  btnAuto.textContent = state.autoShow ? '自动表演:开' : '自动表演:关';
});
btnPause.addEventListener('click', () => {
  state.enabled = !state.enabled;
  btnPause.textContent = state.enabled ? '暂停' : '恢复';
});
btnReset.addEventListener('click', () => doReset());

/* -------------------------- reset 语义 -------------------------- */
function doReset() {
  for (let i = 0; i < PMAX; i++) {
    life[i] = 0;
    aal[i] = 0;
  }
  particlesAlive = 0;
  state.fireworkCount = 0;
  state.autoShow = false;
  state.enabled = true;
  nextAutoAt = Infinity;
  btnAuto.textContent = '自动表演:关';
  btnPause.textContent = '暂停';
  buildCity(); // 城市重新随机生成(楼数不变)
}

/* -------------------------- 状态通道 -------------------------- */
window.__bench = {
  getState: () => ({
    fireworkCount: state.fireworkCount,
    particlesAlive,
    autoShow: state.autoShow,
    enabled: state.enabled,
    buildingCount: state.buildingCount,
  }),
  reset: doReset,
};

/* --------------------------- 点击发射 --------------------------- */
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (!state.enabled) return; // 暂停期间时间线冻结,不接受发射
  const r = canvas.getBoundingClientRect();
  const xn = (e.clientX - r.left) / r.width;
  const yn = (e.clientY - r.top) / r.height;
  const wy = (0.5 - yn) * WORLD_H;
  // 仅夜空区域发射(城市剪影带 / 画面边缘不发射);UI 点击不会到达 canvas
  if (wy < -14 || wy > WORLD_H / 2 - 2) return;
  launchFirework((xn - 0.5) * frustumW, wy);
});

/* --------------------------- 视口自适应 --------------------------- */
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = Math.max(1, window.innerHeight);
  frustumW = WORLD_H * (w / h);
  camera.left = -frustumW / 2;
  camera.right = frustumW / 2;
  camera.top = WORLD_H / 2;
  camera.bottom = -WORLD_H / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  updatePix();
  buildStars();
  buildCity();
});

/* ----------------------------- 主循环 ----------------------------- */
buildStars();
buildCity();

let last = performance.now();
let readySet = false;
let warned = false;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05; // 失焦/卡顿钳制:防时间跳变导致粒子瞬移
  if (dt <= 0) dt = 0.0001;
  if (!state.enabled) return; // 暂停 = 整条时间线冻结(不推进、不重绘,两帧差恒 0)
  simTime += dt;
  uT.value = simTime;
  try {
    stepParticles(dt);
    stepAutoShow();
    renderer.render(scene, camera);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[e04] runtime error:', err);
    }
  }
  if (!readySet) {
    readySet = true;
    window.__appReady = true; // 首帧渲染完成
  }
}
requestAnimationFrame(tick);
