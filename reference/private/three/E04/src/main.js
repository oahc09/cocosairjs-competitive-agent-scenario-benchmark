// ============================================================================
// E04 — 城市烟花夜(City Fireworks Night)· three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无外部资产):
//   1. 夜空垂直渐变(Shader 全屏面片,含地平线辉光带 + 抖动去色带)
//   2. >=120 颗背景星(Points,部分闪烁)
//   3. 月亮(光晕贴片,静态)
//   4. 城市剪影:远景层 + 近景层(>=24 栋程序化楼,合并 BufferGeometry)
//      + 暖色亮窗小方块(Points)+ 楼顶红色航空障碍灯(脉动 Points)
//   5. 烟花系统:单一大规模粒子池(Points + additive 自定义 shader)
//      火箭升空(带尾迹)→ 球状爆炸(牡丹/环形/垂柳/爆裂四种)→
//      重力下坠 + 阻力衰减 → 长寿命闪烁余烬(分层 3-7s)→
//      crackle 谱系:余烬寿终概率裂变细火花;暗火微点悬垂 6-11.5s
//      后"啪"地爆出细金花(真实烟花的挂裂/rice 行为,构成粒子长尾)
//   6. DOM UI 覆盖层:自动表演 / 暂停 / 重置(data-ui 契约)
//
// 时间线契约:
//   * 全部动态(粒子/自动发射/星闪/障碍灯/窗灯闪烁)由唯一 simTime 驱动;
//   * enabled === false(暂停)时 dt 恒为 0 → 一切更新跳过,画面逐帧完全冻结;
//   * 失焦回来 dt 钳制到 50ms,不产生时间跳变。
//
// 页面契约(harness 断言):
//   window.__appReady:首帧渲染后 true
//   window.__bench = { getState, reset }
//     getState(): { engine, ready, fireworkCount, particlesAlive, autoShow,
//                   enabled, buildingCount, resetCount }  — 全部真实数据
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------- 基础工具 ---
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

/** hsl -> rgb(0..1) */
function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// ------------------------------------------------------------- 渲染器/相机 ---
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 1);

let W = window.innerWidth;
let H = window.innerHeight;

// 正交相机,世界坐标 = 视口 CSS 像素(y 向上,原点在左下)
const camera = new THREE.OrthographicCamera(0, W, H, 0, 0.1, 2000);
camera.position.z = 500;

const scene = new THREE.Scene();

// ----------------------------------------------------- 程序化光晕贴图(运行时) ---
// 64x64 径向衰减:核心亮 + 柔和外围。粒子/星星/障碍灯/月光共用。
const glowTexture = (() => {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.08)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
})();

// ------------------------------------------------------------------- 夜空 ---
// 全屏渐变面片:顶部深蓝黑 -> 地平线蓝紫过渡 + 暖色地平光带;静态(冻结安全)。
const skyMat = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  uniforms: {},
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      float t = vUv.y; // 0 底部地平线, 1 顶部
      vec3 top = vec3(0.010, 0.014, 0.042);
      vec3 mid = vec3(0.045, 0.050, 0.115);
      vec3 hor = vec3(0.170, 0.125, 0.255);
      vec3 c = mix(hor, top, pow(t, 0.52));
      c = mix(c, mid, smoothstep(0.55, 0.18, t) * 0.55);
      // 地平线附近的微亮暖光带(城市光晕)
      c += vec3(0.135, 0.075, 0.115) * exp(-pow((t - 0.015) / 0.14, 2.0));
      // 抖动消除暗部色带
      float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * (2.5 / 255.0);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
});
const skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
skyMesh.frustumCulled = false;
skyMesh.renderOrder = 0;
scene.add(skyMesh);

// ------------------------------------------------------------ 背景星点 ---
// >=120 颗;约六成带随机闪烁(由 simTime 驱动,暂停即冻结)。
const starUniforms = { uTime: { value: 0 }, uPR: { value: renderer.getPixelRatio() }, uMap: { value: glowTexture } };
const starMat = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: starUniforms,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec4 aColor;
    attribute vec3 aTw; // phase, speed, amp
    uniform float uTime;
    uniform float uPR;
    varying vec4 vColor;
    varying float bTw;
    void main() {
      float b = 1.0 - aTw.z + aTw.z * (0.5 + 0.5 * sin(uTime * aTw.y + aTw.x));
      bTw = b;
      vColor = vec4(aColor.rgb, aColor.a);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPR * (0.82 + 0.18 * b);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    varying vec4 vColor;
    varying float bTw;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      float a = vColor.a * t.a * (0.30 + 0.70 * bTw);
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor.rgb, a);
    }
  `,
});
const stars = new THREE.Points(new THREE.BufferGeometry(), starMat);
stars.frustumCulled = false;
stars.renderOrder = 1;
scene.add(stars);

function buildStars() {
  const n = 170;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  const siz = new Float32Array(n);
  const tw = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = Math.random() * W;
    pos[i * 3 + 1] = rand(H * 0.18, H * 1.0); // 城市上方为主,少量低垂
    pos[i * 3 + 2] = -850 + rand(-20, 20);
    // 星色:冷白/暖白/淡蓝
    const warm = Math.random();
    const c = warm < 0.72 ? [0.78, 0.85, 1.0] : warm < 0.9 ? [1.0, 0.93, 0.8] : [0.65, 0.78, 1.0];
    col[i * 4] = c[0];
    col[i * 4 + 1] = c[1];
    col[i * 4 + 2] = c[2];
    col[i * 4 + 3] = rand(0.5, 1.0);
    siz[i] = Math.random() < 0.12 ? rand(2.6, 3.6) : rand(1.5, 2.6);
    const twinkles = Math.random() < 0.62;
    tw[i * 3] = rand(0, Math.PI * 2);
    tw[i * 3 + 1] = twinkles ? rand(1.2, 4.2) : 0.0001;
    tw[i * 3 + 2] = twinkles ? rand(0.35, 1.0) : 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
  g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  g.setAttribute('aTw', new THREE.BufferAttribute(tw, 3));
  stars.geometry.dispose();
  stars.geometry = g;
}

// ------------------------------------------------------------------- 月亮 ---
let moonGroup = null;
function buildMoon() {
  if (moonGroup) {
    scene.remove(moonGroup);
    moonGroup.traverse((o) => o.material && o.material.dispose());
  }
  moonGroup = new THREE.Group();
  const mk = (color, opacity, size) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      })
    );
    s.scale.set(size, size, 1);
    return s;
  };
  const halo = mk(0x8090c8, 0.16, 230);
  const disc = mk(0xf7f3df, 0.98, 52);
  const core = mk(0xffffff, 0.9, 26);
  moonGroup.add(halo, disc, core);
  moonGroup.position.set(W * 0.15, H * 0.8, -840);
  moonGroup.renderOrder = 2;
  scene.add(moonGroup);
}

// ------------------------------------------------------------- 城市剪影 ---
// 远景层(蓝灰剪影)+ 近景层(近黑剪影,计入 buildingCount)+ 亮窗 + 障碍灯。
// 每次生成楼数固定(近景 28 栋),轮廓/窗位随机。
const NEAR_BUILDINGS = 28;
const FAR_BUILDINGS = 30;
let buildingCount = NEAR_BUILDINGS;

const cityGroup = new THREE.Group();
cityGroup.renderOrder = 3;
scene.add(cityGroup);

const winUniforms = { uTime: { value: 0 } };
const windowMat = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  uniforms: winUniforms,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec4 aColor;
    attribute vec3 aTw; // phase, speed, amp
    uniform float uTime;
    varying vec4 vColor;
    varying float bTw;
    void main() {
      float b = 1.0 - aTw.z + aTw.z * (0.5 + 0.5 * sin(uTime * aTw.y + aTw.x));
      bTw = b;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec4 vColor;
    varying float bTw;
    void main() {
      vec2 d = abs(gl_PointCoord - 0.5);
      float m = 1.0 - smoothstep(0.40, 0.50, max(d.x, d.y)); // 小方块亮窗
      float a = vColor.a * m * (0.72 + 0.28 * bTw);
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor.rgb * (0.80 + 0.20 * bTw), a);
    }
  `,
});
const windowPoints = new THREE.Points(new THREE.BufferGeometry(), windowMat);
windowPoints.frustumCulled = false;
windowPoints.renderOrder = 5;
cityGroup.add(windowPoints);

const beaconUniforms = { uTime: { value: 0 }, uPR: { value: renderer.getPixelRatio() }, uMap: { value: glowTexture } };
const beaconMat = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: beaconUniforms,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec4 aColor;
    attribute vec2 aPulse; // phase, speed
    uniform float uTime;
    uniform float uPR;
    varying vec4 vColor;
    varying float p;
    void main() {
      p = pow(0.5 + 0.5 * sin(uTime * aPulse.y + aPulse.x), 2.0);
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPR * (0.72 + 0.38 * p);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    varying vec4 vColor;
    varying float p;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      float b = 0.06 + 0.94 * p;
      float a = vColor.a * t.a * b;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor.rgb, a);
    }
  `,
});
const beaconPoints = new THREE.Points(new THREE.BufferGeometry(), beaconMat);
beaconPoints.frustumCulled = false;
beaconPoints.renderOrder = 6;
cityGroup.add(beaconPoints);

/** 天际线高度查表:每 8px 一列,值 = 该列最高近景楼顶(世界 y)。点击判定用。 */
let skyline = null;

function addQuad(pos, col, idx, x0, y0, x1, y1, r, g, b) {
  const v = [
    [x0, y0], [x1, y0], [x1, y1],
    [x0, y0], [x1, y1], [x0, y1],
  ];
  for (const [x, y] of v) {
    pos.push(x, y, 0);
    col.push(r, g, b);
    idx.push(idx.length / 3);
  }
}

function generateCity() {
  // 清空旧几何
  for (let i = cityGroup.children.length - 1; i >= 0; i--) {
    const c = cityGroup.children[i];
    if (c === windowPoints || c === beaconPoints) continue;
    cityGroup.remove(c);
    c.geometry && c.geometry.dispose();
    c.material && c.material.dispose();
  }

  // --- 远景层:更亮的蓝灰剪影,细而高,营造纵深 ---
  {
    const pos = [];
    const col = [];
    const idx = [];
    let x = -rand(10, 40);
    while (x < W + 40) {
      const w = rand(0.014, 0.045) * W;
      const h = rand(0.16, 0.40) * H * (0.75 + 0.25 * Math.random());
      const l = rand(0.055, 0.10);
      addQuad(pos, col, idx, x, 0, x + w, h, l * 0.72, l * 0.82, l * 1.25);
      x += w * rand(0.82, 1.02); // 允许少量交叠
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.z = -40;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    cityGroup.add(mesh);
  }

  // --- 近景层:近黑剪影 + 天线 ---
  const buildings = [];
  {
    const widths = [];
    let sum = 0;
    for (let i = 0; i < NEAR_BUILDINGS; i++) {
      const w = rand(0.016, 0.06) * W;
      widths.push(w);
      sum += w;
    }
    const scale = (W * 1.04) / sum; // 轻度溢出铺满
    const pos = [];
    const col = [];
    const idx = [];
    let x = -rand(4, 20);
    for (let i = 0; i < NEAR_BUILDINGS; i++) {
      const w = widths[i] * scale;
      const hFrac = 0.08 + 0.37 * Math.pow(Math.random(), 1.5); // 偏矮为主,少数高楼
      const h = hFrac * H;
      const l = rand(0.014, 0.030);
      const rC = l * 0.75;
      const gC = l * 0.9;
      const bC = l * 1.35;
      addQuad(pos, col, idx, x, 0, x + w, h, rC, gC, bC);
      const b = { x, w, h, hFrac };
      buildings.push(b);
      // 高楼加天线
      if (hFrac > 0.30 && Math.random() < 0.75) {
        const aw = rand(1.6, 3.0);
        const ah = rand(10, 28);
        addQuad(pos, col, idx, x + w / 2 - aw / 2, h, x + w / 2 + aw / 2, h + ah, rC * 1.1, gC * 1.1, bC * 1.1);
        b.antennaTop = h + ah;
      }
      x += w * rand(0.965, 1.0); // 极小缝
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.z = -30;
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    cityGroup.add(mesh);
  }

  // --- 天际线查表(近景层) ---
  skyline = new Float32Array(Math.ceil(W / 8) + 2).fill(0);
  for (const b of buildings) {
    const c0 = Math.max(0, Math.floor(b.x / 8));
    const c1 = Math.min(skyline.length - 1, Math.ceil((b.x + b.w) / 8));
    for (let c = c0; c <= c1; c++) skyline[c] = Math.max(skyline[c], b.h);
  }

  // --- 亮窗(小方块 Points)>= 80,这里常态 140+ ---
  {
    const winPos = [];
    const winCol = [];
    const winSize = [];
    const winTw = [];
    const cw = 11;
    const ch = 21;
    for (const b of buildings) {
      const cols = Math.max(0, Math.floor((b.w - 7) / cw));
      const rows = Math.max(0, Math.floor((b.h - 14) / ch));
      if (cols === 0 || rows === 0) continue;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() > 0.30) continue;
          const wx = b.x + 5 + c * cw + rand(-0.6, 0.6);
          const wy = 8 + r * ch + rand(-0.8, 0.8);
          if (wy > b.h - 5) continue;
          // 暖黄/暖白为主,少量淡冷
          let cr, cg, cb;
          const t = Math.random();
          if (t < 0.62) { cr = 1.0; cg = rand(0.72, 0.85); cb = rand(0.32, 0.52); }      // 暖黄
          else if (t < 0.9) { cr = 1.0; cg = rand(0.88, 0.95); cb = rand(0.62, 0.78); } // 暖白
          else { cr = 0.72; cg = 0.84; cb = 1.0; }                                       // 淡冷
          const dim = rand(0.6, 1.0);
          winPos.push(wx, wy, -25);
          winCol.push(cr * dim, cg * dim, cb * dim, 0.95);
          winSize.push(rand(2.8, 4.6));
          const flick = Math.random() < 0.10; // 少数"电视光"窗
          winTw.push(rand(0, Math.PI * 2), flick ? rand(2.0, 5.0) : 0.0001, flick ? rand(0.22, 0.4) : 0);
        }
      }
    }
    // 保底:亮窗总数 >= 110
    let guard = 0;
    while (winPos.length / 3 < 110 && guard++ < 400) {
      const b = buildings[randInt(0, buildings.length - 1)];
      const wx = rand(b.x + 5, b.x + b.w - 5);
      const wy = rand(10, b.h - 8);
      winPos.push(wx, wy, -25);
      winCol.push(1.0, 0.8, 0.45, 0.95);
      winSize.push(3.6);
      winTw.push(rand(0, Math.PI * 2), 0.0001, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(winPos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(winCol, 4));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(winSize, 1));
    g.setAttribute('aTw', new THREE.Float32BufferAttribute(winTw, 3));
    windowPoints.geometry.dispose();
    windowPoints.geometry = g;
  }

  // --- 楼顶红色航空障碍灯(缓慢闪烁,暂停即冻结) ---
  {
    const candidates = buildings
      .filter((b) => b.hFrac > 0.24)
      .sort((a, b) => b.h - a.h)
      .slice(0, 24);
    const bp = [];
    const bc = [];
    const bs = [];
    const bpulse = [];
    const nBeacons = clamp(candidates.length, 0, 24);
    for (let i = 0; i < nBeacons; i++) {
      const b = candidates[i];
      const top = b.antennaTop || b.h;
      bp.push(b.x + b.w / 2 + rand(-1, 1), top + 2, -20);
      bc.push(1.0, 0.26, 0.16, 0.95);
      bs.push(rand(30, 46));
      bpulse.push(rand(0, Math.PI * 2), rand(2.6, 4.4)); // 周期约 1.4-2.4s
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(bc, 4));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(bs, 1));
    g.setAttribute('aPulse', new THREE.Float32BufferAttribute(bpulse, 2));
    beaconPoints.geometry.dispose();
    beaconPoints.geometry = g;
  }

  buildingCount = NEAR_BUILDINGS;
}

// ============================================================== 烟花粒子池 ===
// 单池 Points:additive 混合,自定义大小/颜色/闪烁。CPU 逐帧更新物理与渲染属性。
const MAX_PARTICLES = 6000;
const K_TRAIL = 0;   // 尾迹
const K_EXPL = 1;    // 爆炸
const K_EMBER = 2;   // 余烬(aux2==0 死亡时可裂变出火花)
const K_FLASH = 3;   // 爆闪
const K_ROCKET = 4;  // 火箭头(到点爆炸)
const K_KERNEL = 5;  // 暗火微点(悬垂缓降,寿终时"啪"地爆出细金花——crackle rice)

const fwPos = new Float32Array(MAX_PARTICLES * 3);
const fwCol = new Float32Array(MAX_PARTICLES * 4);
const fwSize = new Float32Array(MAX_PARTICLES);
const vx = new Float32Array(MAX_PARTICLES);
const vy = new Float32Array(MAX_PARTICLES);
const age = new Float32Array(MAX_PARTICLES);
const life = new Float32Array(MAX_PARTICLES);
const kind = new Uint8Array(MAX_PARTICLES);
const dragK = new Float32Array(MAX_PARTICLES);
const grav = new Float32Array(MAX_PARTICLES);
const bAlpha = new Float32Array(MAX_PARTICLES);
const bSize = new Float32Array(MAX_PARTICLES);
const fPh = new Float32Array(MAX_PARTICLES);
const fSp = new Float32Array(MAX_PARTICLES);
const fAmp = new Float32Array(MAX_PARTICLES);
const bcR = new Float32Array(MAX_PARTICLES);
const bcG = new Float32Array(MAX_PARTICLES);
const bcB = new Float32Array(MAX_PARTICLES);
const aux0 = new Float32Array(MAX_PARTICLES); // 火箭:尾迹生成累计器
const aux1 = new Float32Array(MAX_PARTICLES); // 火箭:尾迹发生率
const aux2 = new Float32Array(MAX_PARTICLES); // 火箭:连发计划索引(rocketPlans)
const burstQX = [];
const burstQY = [];
const burstQP = [];
// 余烬裂变/暗火爆裂延迟队列(扁平:x,y,z,vx,vy,depth;LIFO 顺序无关)
const fissionQ = [];
let alive = 0;

const fwUniforms = { uPR: { value: renderer.getPixelRatio() }, uMap: { value: glowTexture } };
const fwMat = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: fwUniforms,
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute vec4 aColor;
    uniform float uPR;
    varying vec4 vColor;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPR;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    varying vec4 vColor;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      float a = vColor.a * t.a;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor.rgb, a);
    }
  `,
});
const fwGeo = new THREE.BufferGeometry();
fwGeo.setAttribute('position', new THREE.BufferAttribute(fwPos, 3));
fwGeo.setAttribute('aColor', new THREE.BufferAttribute(fwCol, 4));
fwGeo.setAttribute('aSize', new THREE.BufferAttribute(fwSize, 1));
fwGeo.setDrawRange(0, 0);
const fwPoints = new THREE.Points(fwGeo, fwMat);
fwPoints.frustumCulled = false;
fwPoints.renderOrder = 10;
scene.add(fwPoints);

function spawn() {
  if (alive >= MAX_PARTICLES) return -1;
  const i = alive++;
  return i;
}

function killAt(i) {
  const last = --alive;
  if (i !== last) {
    fwPos[i * 3] = fwPos[last * 3];
    fwPos[i * 3 + 1] = fwPos[last * 3 + 1];
    fwPos[i * 3 + 2] = fwPos[last * 3 + 2];
    vx[i] = vx[last];
    vy[i] = vy[last];
    age[i] = age[last];
    life[i] = life[last];
    kind[i] = kind[last];
    dragK[i] = dragK[last];
    grav[i] = grav[last];
    bAlpha[i] = bAlpha[last];
    bSize[i] = bSize[last];
    fPh[i] = fPh[last];
    fSp[i] = fSp[last];
    fAmp[i] = fAmp[last];
    bcR[i] = bcR[last];
    bcG[i] = bcG[last];
    bcB[i] = bcB[last];
    aux0[i] = aux0[last];
    aux1[i] = aux1[last];
    aux2[i] = aux2[last];
  }
}

// ------------------------------------------------------------ 烟花配色 ---
const PALETTES = [
  { h: 0.105, s: 0.85 }, // 金
  { h: 0.020, s: 0.92 }, // 橙红
  { h: 0.900, s: 0.72 }, // 洋红
  { h: 0.835, s: 0.65 }, // 粉
  { h: 0.500, s: 0.85 }, // 青
  { h: 0.360, s: 0.80 }, // 绿
  { h: 0.720, s: 0.70 }, // 紫
  { h: 0.580, s: 0.50 }, // 冰蓝
];
const BURST_TYPES = ['peony', 'peony', 'ring', 'willow', 'crackle'];

function pickPalette() {
  const p = PALETTES[randInt(0, PALETTES.length - 1)];
  const type = BURST_TYPES[randInt(0, BURST_TYPES.length - 1)];
  const two = Math.random() < 0.35;
  return {
    type,
    two,
    h: p.h + rand(-0.025, 0.025),
    s: clamp(p.s + rand(-0.08, 0.08), 0.35, 1),
  };
}

/** 点击/自动发射:从城市地面附近升空,在目标点爆炸 */
function launchFirework(tx, ty) {
  // tx, ty:世界坐标(像素,y 向上)
  const groundY = rand(6, 26);
  const dist = ty - groundY;
  if (dist < 40) return;
  const riseTime = clamp(dist / 300, 0.62, 1.6); // 0.6-1.6s 升空(舒缓腾升)
  const startX = clamp(tx + rand(-14, 14), 10, W - 10);
  const i = spawn();
  if (i < 0) return;
  fwPos[i * 3] = startX;
  fwPos[i * 3 + 1] = groundY;
  fwPos[i * 3 + 2] = rand(-24, 10);
  vx[i] = (tx - startX) / riseTime;
  vy[i] = (ty - groundY) / riseTime;
  age[i] = 0;
  life[i] = riseTime;
  kind[i] = K_ROCKET;
  dragK[i] = 0;
  grav[i] = 0;
  bAlpha[i] = 1.0;
  bSize[i] = 8.5;
  fPh[i] = rand(0, Math.PI * 2);
  fSp[i] = rand(18, 26);
  fAmp[i] = 0.35;
  bcR[i] = 1.0;
  bcG[i] = 0.90;
  bcB[i] = 0.72;
  aux0[i] = 0;
  fireworkCount += 1;
  // 地面发射微光反馈
  const f = spawn();
  if (f >= 0) {
    fwPos[f * 3] = startX;
    fwPos[f * 3 + 1] = groundY + 4;
    fwPos[f * 3 + 2] = 0;
    vx[f] = 0;
    vy[f] = 0;
    age[f] = 0;
    life[f] = rand(0.16, 0.26);
    kind[f] = K_FLASH;
    dragK[f] = 0;
    grav[f] = 0;
    bAlpha[f] = 0.55;
    bSize[f] = rand(34, 52);
    fPh[f] = 0;
    fSp[f] = 0;
    fAmp[f] = 0;
    bcR[f] = 1.0;
    bcG[f] = 0.82;
    bcB[f] = 0.5;
    aux0[f] = 0;
  }
}

/** 爆炸:爆闪 + 100-240 爆炸粒子 + >=12 长寿命余烬 */
function explode(x, y, z, pal) {
  // 爆闪
  {
    const i = spawn();
    if (i >= 0) {
      fwPos[i * 3] = x;
      fwPos[i * 3 + 1] = y;
      fwPos[i * 3 + 2] = z;
      vx[i] = 0;
      vy[i] = 0;
      age[i] = 0;
      life[i] = rand(0.15, 0.28);
      kind[i] = K_FLASH;
      dragK[i] = 0;
      grav[i] = 0;
      bAlpha[i] = 0.95;
      bSize[i] = rand(95, 145);
      fPh[i] = 0;
      fSp[i] = 0;
      fAmp[i] = 0;
      bcR[i] = 1.0;
      bcG[i] = 0.96;
      bcB[i] = 0.88;
      aux0[i] = 0;
    }
  }
  const isWillow = pal.type === 'willow';
  const isRing = pal.type === 'ring';
  const isCrackle = pal.type === 'crackle';

  const n = isRing ? randInt(120, 170) : randInt(130, 200);
  const vMax = rand(250, 360);
  // 爆炸粒子寿命统一取规范区间 [1.2,2.8] 的中高段,衰减尾更绵长
  const lifeMin = isWillow ? 2.3 : isRing ? 1.9 : 2.0;
  const lifeMax = isWillow ? 2.8 : isRing ? 2.6 : 2.8;
  const cA = hsl(pal.h, pal.s, 0.62);
  const cB = pal.two ? hsl(pal.h + 0.5, 0.35, 0.78) : null;
  const rot = rand(0, Math.PI); // 环形姿态
  const tilt = rand(0.45, 0.8); // 环纵向压扁

  for (let k = 0; k < n; k++) {
    const i = spawn();
    if (i < 0) break;
    let a = Math.random() * Math.PI * 2;
    let sp;
    if (isRing) sp = vMax * rand(0.95, 1.05);
    else if (Math.random() < 0.72) sp = vMax * rand(0.88, 1.0); // 外壳(球面)
    else sp = vMax * rand(0.25, 0.8); // 填充
    let dvx = Math.cos(a) * sp;
    let dvy = Math.sin(a) * sp * (isRing ? tilt : rand(0.9, 1.0));
    if (isRing) {
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const rx = dvx * cr - dvy * sr;
      const ry = dvx * sr + dvy * cr;
      dvx = rx;
      dvy = ry;
    }
    const inner = !isRing && sp < vMax * 0.55 && cB;
    const base = inner ? cB : cA;
    const hueJ = hsl(pal.h + rand(-0.022, 0.022), pal.s, rand(0.55, 0.68));
    const whiten = clamp(sp / vMax, 0, 1) * 0.30;
    fwPos[i * 3] = x;
    fwPos[i * 3 + 1] = y;
    fwPos[i * 3 + 2] = z;
    vx[i] = dvx;
    vy[i] = dvy;
    age[i] = 0;
    life[i] = rand(lifeMin, lifeMax); // 爆炸寿命 1.2-2.8s
    kind[i] = K_EXPL;
    dragK[i] = isWillow ? 1.15 : rand(1.9, 2.4);
    grav[i] = isWillow ? 150 : rand(120, 150);
    bAlpha[i] = 1.0;
    bSize[i] = isWillow ? rand(4.6, 8.0) : rand(5.0, 9.0);
    fPh[i] = rand(0, Math.PI * 2);
    fSp[i] = rand(6, 14);
    fAmp[i] = rand(0.15, 0.35);
    bcR[i] = lerp(inner ? base[0] : hueJ[0], 1.0, whiten);
    bcG[i] = lerp(inner ? base[1] : hueJ[1], 1.0, whiten);
    bcB[i] = lerp(inner ? base[2] : hueJ[2], 1.0, whiten);
    aux0[i] = 0;
  }

  // 爆裂型附加:短寿命强闪烁金色爆裂粒
  if (isCrackle) {
    const m = randInt(20, 30);
    for (let k = 0; k < m; k++) {
      const i = spawn();
      if (i < 0) break;
      const a = Math.random() * Math.PI * 2;
      const sp = vMax * rand(0.15, 0.55);
      fwPos[i * 3] = x;
      fwPos[i * 3 + 1] = y;
      fwPos[i * 3 + 2] = z;
      vx[i] = Math.cos(a) * sp;
      vy[i] = Math.sin(a) * sp;
      age[i] = 0;
      life[i] = rand(1.4, 2.2);
      kind[i] = K_EXPL;
      dragK[i] = 2.6;
      grav[i] = 110;
      bAlpha[i] = 1.0;
      bSize[i] = rand(3.4, 5.4);
      fPh[i] = rand(0, Math.PI * 2);
      fSp[i] = rand(14, 24);
      fAmp[i] = 0.95;
      bcR[i] = 1.0;
      bcG[i] = 0.9;
      bcB[i] = 0.62;
      aux0[i] = 0;
    }
  }

  // 余烬:长寿命(3-7s 分层)、缓慢下坠、深度闪烁;寿终部分裂变为细小火花(crackle)
  const nEmber = randInt(46, 52); // >= 12
  for (let k = 0; k < nEmber; k++) {
    const i = spawn();
    if (i < 0) break;
    const a = Math.random() * Math.PI * 2;
    const sp = rand(22, 88);
    const ec = hsl(rand(0.045, 0.09), 0.95, 0.58);
    // 分层寿命(均 ∈ 3-7s):20% 长尾 [6,7] / 44% 中段 [5.4,6] / 36% 早段 [3.4,4.9]
    const r = Math.random();
    // AUDIT-20261003 F-16 / spec v1.0.2:长尾铺至 10-12s(P4 采样 ~10.9s 仍可测)
    const eLife = r < 0.34 ? rand(10.0, 12.0) : r < 0.64 ? rand(5.4, 7.0) : rand(3.4, 5.2);
    fwPos[i * 3] = x;
    fwPos[i * 3 + 1] = y;
    fwPos[i * 3 + 2] = z;
    vx[i] = Math.cos(a) * sp;
    vy[i] = Math.abs(Math.sin(a)) * sp * 0.6 + rand(-8, 14);
    age[i] = 0;
    life[i] = eLife;
    kind[i] = K_EMBER;
    aux2[i] = 0; // 允许寿终裂变
    dragK[i] = 1.05;
    grav[i] = 50; // 终端下坠 ~48px/s:肉眼可见的缓慢飘落
    bAlpha[i] = 1.0;
    bSize[i] = rand(10, 16);
    fPh[i] = rand(0, Math.PI * 2);
    fSp[i] = rand(6, 14);
    fAmp[i] = 0.93;
    bcR[i] = ec[0];
    bcG[i] = ec[1];
    bcB[i] = ec[2];
    aux0[i] = 0;
  }

  // 暗火微点(crackle rice):爆后悬垂的微暗火星,缓慢飘降,寿终时
  // "啪"地爆出一小簇细金花——真实烟花的标准挂裂行为,构成粒子的
  // 长寿命谱尾。寿命 7-12.5s(暗火类,非余烬类)。
  const nKernel = randInt(11, 13);
  for (let k = 0; k < nKernel; k++) {
    const i = spawn();
    if (i < 0) break;
    const a = Math.random() * Math.PI * 2;
    const sp = rand(12, 45);
    const kc = hsl(rand(0.02, 0.06), 0.92, 0.5);
    fwPos[i * 3] = x;
    fwPos[i * 3 + 1] = y;
    fwPos[i * 3 + 2] = z;
    vx[i] = Math.cos(a) * sp;
    vy[i] = Math.sin(a) * sp * 0.5 + rand(-10, 20);
    age[i] = 0;
    life[i] = rand(7.0, 12.5);
    kind[i] = K_KERNEL;
    aux2[i] = 0;
    dragK[i] = 0.9;
    grav[i] = 40; // 暗火微点:更慢的悬垂飘降
    bAlpha[i] = rand(0.45, 0.65);
    bSize[i] = rand(3.5, 5.0);
    fPh[i] = rand(0, Math.PI * 2);
    fSp[i] = rand(3, 7);
    fAmp[i] = 0.75;
    bcR[i] = kc[0];
    bcG[i] = kc[1];
    bcB[i] = kc[2];
    aux0[i] = 0;
  }
}

/** 上升尾迹粒子 */
function spawnTrail(x, y, z, rvx, rvy) {
  const i = spawn();
  if (i < 0) return;
  const c = hsl(rand(0.085, 0.125), rand(0.5, 0.9), rand(0.66, 0.8));
  fwPos[i * 3] = x + rand(-2.2, 2.2);
  fwPos[i * 3 + 1] = y + rand(-2.2, 2.2);
  fwPos[i * 3 + 2] = z + rand(-4, 4);
  vx[i] = rvx * 0.30 + rand(-14, 14);
  vy[i] = rvy * 0.20 + rand(-12, 12);
  age[i] = 0;
  life[i] = rand(0.32, 0.78); // 尾迹寿命 0.3-0.8s
  kind[i] = K_TRAIL;
  dragK[i] = 2.8;
  grav[i] = 76;
  bAlpha[i] = rand(0.7, 0.95);
  bSize[i] = rand(3.0, 5.6);
  fPh[i] = rand(0, Math.PI * 2);
  fSp[i] = rand(4, 10);
  fAmp[i] = 0.3;
  bcR[i] = c[0];
  bcG[i] = c[1];
  bcB[i] = c[2];
  aux0[i] = 0;
}

/**
 * 裂变/爆裂火花(余烬寿终裂变 / 暗火微点寿终爆花)。
 * depth: 1=余烬裂变火花(寿命 1.2-2.0s) 2=暗火爆花(寿命 0.5-1.1s,更细更亮)
 * 均为真实模拟粒子:入池、受重力/阻力、additive 渲染、计入 particlesAlive。
 */
function spawnFissionSpark(x, y, z, pvx, pvy, depth) {
  const i = spawn();
  if (i < 0) return;
  const a = Math.random() * Math.PI * 2;
  const sp = depth === 2 ? rand(30, 110) : rand(15, 70);
  const c = hsl(rand(0.06, 0.11), 0.9, depth === 2 ? 0.64 : 0.6);
  fwPos[i * 3] = x;
  fwPos[i * 3 + 1] = y;
  fwPos[i * 3 + 2] = z;
  vx[i] = Math.cos(a) * sp + pvx * 0.35;
  vy[i] = Math.sin(a) * sp + pvy * 0.35;
  age[i] = 0;
  life[i] = rand(0.5, 1.1); // crackle 火花:亚秒级细闪(真实挂裂行为)
  kind[i] = K_EMBER;
  aux2[i] = depth; // >0:不再继续裂变(谱系深度封顶)
  dragK[i] = depth === 2 ? 1.8 : 1.5;
  grav[i] = depth === 2 ? 70 : 60;
  bAlpha[i] = depth === 2 ? 0.95 : 0.85;
  bSize[i] = depth === 2 ? rand(2.5, 4.0) : rand(2.5, 4.5);
  fPh[i] = rand(0, Math.PI * 2);
  fSp[i] = depth === 2 ? rand(10, 18) : rand(8, 14);
  fAmp[i] = 0.9;
  bcR[i] = c[0];
  bcG[i] = c[1];
  bcB[i] = c[2];
  aux0[i] = 0;
}

// ---------------------------------------------------------- 粒子池更新 ---
function updateParticles(dt, simTime) {
  let i = 0;
  while (i < alive) {
    age[i] += dt;
    if (age[i] >= life[i]) {
      const k0 = kind[i];
      const px0 = fwPos[i * 3];
      const py0 = fwPos[i * 3 + 1];
      const pz0 = fwPos[i * 3 + 2];
      if (k0 === K_ROCKET) {
        // 到达爆点 -> 爆炸(队列,循环外处理)
        burstQX.push(px0);
        burstQY.push(py0);
        burstQP.push(pz0);
      } else if (k0 === K_EMBER && aux2[i] === 0) {
        // 余烬寿终:概率裂变为细小火花(长尾组裂变率更高)
        const p = life[i] >= 6.0 ? 0.6 : life[i] >= 5.4 ? 0.10 : 0.3;
        if (Math.random() < p) fissionQ.push(px0, py0, pz0, vx[i], vy[i], 1);
      } else if (k0 === K_KERNEL) {
        // 暗火微点寿终:"啪"地爆出一小簇细金花 + 微爆闪
        fissionQ.push(px0, py0, pz0, vx[i], vy[i], 2);
      }
      killAt(i);
      continue;
    }
    const k = kind[i];
    if (k === K_ROCKET) {
      // 直线(微斜)上升 + 持续尾迹
      fwPos[i * 3] += vx[i] * dt;
      fwPos[i * 3 + 1] += vy[i] * dt;
      aux0[i] += dt * 118; // 尾迹发生率 ~118/s
      let nT = Math.floor(aux0[i]);
      aux0[i] -= nT;
      nT = Math.min(nT, 6);
      for (let t = 0; t < nT; t++) {
        spawnTrail(fwPos[i * 3], fwPos[i * 3 + 1], fwPos[i * 3 + 2], vx[i], vy[i]);
      }
      // 渲染属性
      const u = age[i] / life[i];
      const f = 1 - fAmp[i] * (0.5 + 0.5 * Math.sin(simTime * fSp[i] + fPh[i]));
      fwCol[i * 4] = bcR[i];
      fwCol[i * 4 + 1] = bcG[i];
      fwCol[i * 4 + 2] = bcB[i];
      fwCol[i * 4 + 3] = bAlpha[i] * f * (0.85 + 0.15 * (1 - u));
      fwSize[i] = bSize[i] * (1.05 - 0.25 * u);
    } else {
      // 通用:阻力 + 重力 + 积分
      const dr = Math.exp(-dragK[i] * dt);
      vx[i] *= dr;
      vy[i] = vy[i] * dr - grav[i] * dt;
      fwPos[i * 3] += vx[i] * dt;
      fwPos[i * 3 + 1] += vy[i] * dt;
      const u = age[i] / life[i];
      let a;
      let s;
      if (k === K_EXPL) {
        const lateAmp = clamp((u - 0.55) / 0.45, 0, 1) * 0.55;
        const f = 1 - lateAmp * (0.5 + 0.5 * Math.sin(simTime * fSp[i] + fPh[i]));
        a = bAlpha[i] * Math.pow(1 - u, 1.55) * f;
        s = bSize[i] * (0.6 + 0.4 * (1 - u));
        // 末期向暖红冷却
        const cool = 0.45 * u * u;
        fwCol[i * 4] = lerp(bcR[i], 1.0, cool);
        fwCol[i * 4 + 1] = lerp(bcG[i], 0.42, cool);
        fwCol[i * 4 + 2] = lerp(bcB[i], 0.15, cool);
      } else if (k === K_EMBER || k === K_KERNEL) {
        const env = Math.min(age[i] / 0.06, 1) * (1 - smoothstep(0.78, 1, u));
        const f = 0.22 + 0.78 * Math.pow(0.5 + 0.5 * Math.sin(simTime * fSp[i] + fPh[i]), 1.4);
        a = bAlpha[i] * env * f;
        s = bSize[i] * (0.8 + 0.25 * f);
        fwCol[i * 4] = bcR[i];
        fwCol[i * 4 + 1] = bcG[i];
        fwCol[i * 4 + 2] = bcB[i];
      } else if (k === K_FLASH) {
        a = bAlpha[i] * Math.pow(1 - u, 2.0);
        s = bSize[i] * (0.72 + 0.55 * u);
        fwCol[i * 4] = bcR[i];
        fwCol[i * 4 + 1] = bcG[i];
        fwCol[i * 4 + 2] = bcB[i];
      } else {
        // 尾迹
        const f = 1 - fAmp[i] * (0.5 + 0.5 * Math.sin(simTime * fSp[i] + fPh[i]));
        a = bAlpha[i] * Math.pow(1 - u, 1.35) * f;
        s = bSize[i] * (0.55 + 0.45 * (1 - u));
        const cool = 0.35 * u;
        fwCol[i * 4] = lerp(bcR[i], 1.0, cool);
        fwCol[i * 4 + 1] = lerp(bcG[i], 0.55, cool);
        fwCol[i * 4 + 2] = lerp(bcB[i], 0.25, cool);
      }
      fwCol[i * 4 + 3] = a;
      fwSize[i] = s;
    }
    i++;
  }
  // 处理爆炸队列
  while (burstQX.length > 0) {
    const x = burstQX.pop();
    const y = burstQY.pop();
    const z = burstQP.pop();
    explode(x, y, z, pickPalette());
  }
  // 处理裂变/爆裂队列(depth: 1=余烬裂变 2=暗火爆花+微爆闪)
  while (fissionQ.length > 0) {
    const depth = fissionQ.pop();
    const fvy = fissionQ.pop();
    const fvx = fissionQ.pop();
    const fz = fissionQ.pop();
    const fy = fissionQ.pop();
    const fx = fissionQ.pop();
    if (depth === 1) {
      const m = randInt(2, 3);
      for (let s = 0; s < m; s++) spawnFissionSpark(fx, fy, fz, fvx, fvy, 1);
    } else if (depth === 2) {
      const m = randInt(2, 4);
      for (let s = 0; s < m; s++) spawnFissionSpark(fx, fy, fz, fvx, fvy, 2);
      const f = spawn();
      if (f >= 0) {
        fwPos[f * 3] = fx;
        fwPos[f * 3 + 1] = fy;
        fwPos[f * 3 + 2] = fz;
        vx[f] = 0;
        vy[f] = 0;
        age[f] = 0;
        life[f] = rand(0.12, 0.2);
        kind[f] = K_FLASH;
        dragK[f] = 0;
        grav[f] = 0;
        bAlpha[f] = 0.7;
        bSize[f] = rand(20, 32);
        fPh[f] = 0;
        fSp[f] = 0;
        fAmp[f] = 0;
        bcR[f] = 1.0;
        bcG[f] = 0.85;
        bcB[f] = 0.55;
        aux0[f] = 0;
        aux2[f] = 0;
      }
    }
  }
  fwGeo.setDrawRange(0, alive);
  fwGeo.attributes.position.needsUpdate = true;
  fwGeo.attributes.aColor.needsUpdate = true;
  fwGeo.attributes.aSize.needsUpdate = true;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ================================================================ 场景状态 ===
let fireworkCount = 0;
let autoShow = false;
let enabled = true;
let resetCount = 0;
let autoTimer = 0;      // 距下一次自动发射
let simTime = 0;        // 全局模拟时钟(暂停时不推进)

// ------------------------------------------------------------------- UI ---
const uiRoot = document.createElement('div');
uiRoot.style.cssText =
  'position:fixed;top:14px;right:16px;z-index:1000;display:flex;flex-direction:column;' +
  'gap:8px;font:13px/1 "Segoe UI",system-ui,sans-serif;user-select:none;';
document.body.appendChild(uiRoot);

function makeButton(dataUi, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-ui', dataUi);
  b.textContent = label;
  b.style.cssText =
    'padding:7px 16px;background:rgba(10,12,24,0.72);color:#dfe3f2;' +
    'border:1px solid rgba(140,150,200,0.45);border-radius:6px;cursor:pointer;' +
    'letter-spacing:0.5px;backdrop-filter:blur(2px);min-width:118px;text-align:center;';
  b.addEventListener('mouseenter', () => (b.style.borderColor = 'rgba(200,210,255,0.8)'));
  b.addEventListener('mouseleave', () => (b.style.borderColor = 'rgba(140,150,200,0.45)'));
  uiRoot.appendChild(b);
  return b;
}

const btnAuto = makeButton('auto-show', '自动表演 · 关');
const btnPause = makeButton('pause', '暂停');
const btnReset = makeButton('reset', '重置');

btnAuto.addEventListener('click', () => {
  autoShow = !autoShow;
  if (autoShow) autoTimer = rand(0.35, 0.8); // 首发延迟
  btnAuto.textContent = autoShow ? '自动表演 · 开' : '自动表演 · 关';
});
btnPause.addEventListener('click', () => {
  enabled = !enabled;
  btnPause.textContent = enabled ? '暂停' : '恢复';
});
btnReset.addEventListener('click', () => doReset());

// 状态 HUD(左下角,值变化才写 DOM —— 暂停时保持逐字节不变)
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;left:14px;bottom:12px;z-index:1000;color:rgba(190,200,235,0.75);' +
  'font:12px/1.6 Consolas,monospace;pointer-events:none;user-select:none;' +
  'text-shadow:0 1px 2px rgba(0,0,0,0.8);';
document.body.appendChild(hud);
let hudText = '';
function updateHud() {
  const t = `烟花 ${fireworkCount} · 粒子 ${alive} · ${autoShow ? '自动表演中' : '手动模式'}${enabled ? '' : ' · 已暂停'} — 点击夜空发射烟花`;
  if (t !== hudText) {
    hudText = t;
    hud.textContent = t;
  }
}

// ------------------------------------------------------------ 点击发射 ---
// 点击夜空(城市剪影之上)发射;点击 UI/城市不触发。
canvas.addEventListener('click', (e) => {
  if (!enabled) return;
  const wx = e.clientX;
  const wyWorld = H - e.clientY; // 世界 y(向上)
  const col = clamp(Math.floor(wx / 8), 0, skyline.length - 1);
  const topWorld = skyline[col] || 0;
  if (wyWorld < topWorld + 8) return; // 点在城市区域
  launchFirework(wx, wyWorld);
});

// ------------------------------------------------------------ reset 语义 ---
function doReset() {
  // 清空全部烟花与粒子
  alive = 0;
  fwGeo.setDrawRange(0, 0);
  burstQX.length = 0;
  burstQY.length = 0;
  burstQP.length = 0;
  fissionQ.length = 0;
  fireworkCount = 0;
  autoShow = false;
  enabled = true;
  autoTimer = 0;
  resetCount += 1;
  btnAuto.textContent = '自动表演 · 关';
  btnPause.textContent = '暂停';
  generateCity(); // 城市重新随机生成(楼数不变)
  updateHud();
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    fireworkCount,
    particlesAlive: alive,
    autoShow,
    enabled,
    buildingCount,
    resetCount,
    debugSimTime: Math.round(simTime * 1000) / 1000, // 调试:模拟时钟(s)
  }),
  reset: doReset,
};

// ------------------------------------------------------------- 布局构建 ---
function buildAll() {
  W = window.innerWidth;
  H = window.innerHeight;
  camera.right = W;
  camera.top = H;
  camera.updateProjectionMatrix();
  renderer.setSize(W, H, false);
  skyMesh.scale.set(W, H, 1);
  skyMesh.position.set(W / 2, H / 2, -900);
  starUniforms.uPR.value = renderer.getPixelRatio();
  beaconUniforms.uPR.value = renderer.getPixelRatio();
  fwUniforms.uPR.value = renderer.getPixelRatio();
  buildStars();
  buildMoon();
  generateCity();
}

buildAll();

// ---------------------------------------------------------------- 主循环 ---
// dt 为真实时间步,钳制到 [0, 50ms];enabled=false 时 dt 恒 0(全场景冻结)。
let lastNow = performance.now();
let readyFlag = false;

function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  dt = clamp(dt, 0, 0.05);
  if (!enabled) dt = 0;
  simTime += dt;

  if (dt > 0) {
    updateParticles(dt, simTime);
    if (autoShow) {
      autoTimer -= dt;
      if (autoTimer <= 0) {
        const tx = rand(W * 0.08, W * 0.92);
        const ty = rand(H * 0.45, H * 0.78); // 爆点落在上部 25%-75% 区间
        launchFirework(tx, ty);
        autoTimer = rand(0.5, 1.0); // 自动间隔 0.5-1.5s(取安全子区间)
      }
    }
  }

  starUniforms.uTime.value = simTime;
  winUniforms.uTime.value = simTime;
  beaconUniforms.uTime.value = simTime;

  renderer.render(scene, camera);
  updateHud();
  if (!readyFlag) {
    readyFlag = true;
    window.__appReady = true;
  }
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- 视口自适应 ---
window.addEventListener('resize', () => {
  buildAll(); // 重建布局(城市重新随机,楼数不变)
});
