// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)| engine: three (import map 裸名)
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1,harness 断言):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(): object, reset(): void }
//     getState() -> { starCount, rotationPhase, cameraDistance, parallaxOffset,
//                     fps, hudVisible, epoch }
// 场景要点(对应 spec.json 探针):
//   - 单一 THREE.Points 批量提交星系星点(旋臂+盘面+核球+亮巨星),另有一个
//     远景背景星层;两者合计 = starCount,状态值与真实提交渲染数严格相等。
//   - 星系绕盘面法线(+Y)持续慢旋(0.06 rad/s,落在 0.02–0.1 区间中段,
//     既保证 P2 两秒相位增量充足,又保证 P7 reset 后 0.8s 相位 < 0.1)。
//   - 相机距离用指数平滑逐帧插值(时间常数 0.4s,无瞬跳、无过冲);视差同理
//     (0.45s)。滚轮目标距离 = target*exp(deltaY*0.001),钳制在 [40,400]。
//   - reset 用 0.45s smoothstep 补间一次性恢复 距离/视差/旋转相位(<1s 完成,
//     非整页刷新),phase 先对 2π 取模保证视觉连续(刚体旋转的周期性)。
//   - HUD 为 DOM 覆盖层(3D 场景本身全部由 WebGL canvas 渲染),左上角,
//     不遮挡星系主体;数值全部来自运行时真实状态。
// ============================================================================

import * as THREE from 'three';

// --- 常量与工具 ---------------------------------------------------------------
const GALAXY_RADIUS = 72;        // 星系盘半径(世界单位)
const ANGULAR_SPEED = 0.06;      // 旋转角速度 rad/s(spec 允许 0.02–0.1)
const HOME_DISTANCE = 120;       // 初始相机距离
const MIN_DISTANCE = 40, MAX_DISTANCE = 400;
const HOME_ELEV = (40 * Math.PI) / 180;  // 相机仰角 40° → 盘面法线与视线夹角约 50°,落在 30–60°
const HOME_AZIMUTH = -0.35;      // 方位角稍偏,旋臂构图更自然

// 可复现的 seeded RNG(同一次构建的星空形态确定,便于自检与复跑对比)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261005);
function gauss() { // Box-Muller 标准正态
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const lerp = (a, b, t) => a + (b - a) * t;

// --- 渲染器 / 场景 / 相机 -------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // 深空接近纯黑(RGB 0,0,0 < 16,16,24)

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.5, 6000
);

// --- 星点着色器(批量一次 draw call,逐星颜色/尺寸 attribute)--------------------
// 尺寸按透视衰减:140/-mv.z 使"近距穿行时星点明显放大";软圆点 + 加色混合
// 形成辉光叠加,亮像素占比自然超过 2% 断言下限。
const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 1.0);
    gl_PointSize = clamp(aSize * (140.0 / dist), 0.5, 40.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    float fall = exp(-r * r * 3.5) * (1.0 - r * r); // 软衰减,避免硬边圆点
    gl_FragColor = vec4(vColor, fall);
  }
`;
function makeStarMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // 纯加色星点,彼此无遮挡关系,关深度测试省一序问题
    transparent: true,
  });
}

// --- 星系生成(全部程序化,无任何外部资产)--------------------------------------
// 颜色沿半径三段渐变:核心暖黄白 → 中段蓝白 → 外缘冷蓝;
// 三个亮暗层级:核球亮星(1.0)/旋臂普通星(0.7)/盘面暗星与背景星(0.4)。
function diskColor(t) { // t: 半径归一化 [0,1]
  if (t < 0.25) {
    const u = t / 0.25;
    return [lerp(1.0, 0.90, u), lerp(0.86, 0.90, u), lerp(0.62, 1.0, u)];
  }
  const u = Math.min((t - 0.25) / 0.75, 1);
  return [lerp(0.90, 0.60, u), lerp(0.90, 0.76, u), 1.0];
}

const N_ARMS = 24000, N_FIELD = 18000, N_BULGE = 6500, N_GIANT = 900;
const N_GALAXY = N_ARMS + N_FIELD + N_BULGE + N_GIANT; // 49400
const N_BG = 7500;
const TOTAL_STARS = N_GALAXY + N_BG;                    // 56900 = starCount 真值

function buildGalaxy() {
  const pos = new Float32Array(N_GALAXY * 3);
  const col = new Float32Array(N_GALAXY * 3);
  const siz = new Float32Array(N_GALAXY);
  let i = 0;
  const put = (x, y, z, r, g, b, s) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
    siz[i] = s; i += 1;
  };
  const SPIRAL_B = 0.55;              // 对数螺旋紧度 r = r0 * e^(b*θ)
  const R0 = 5, ARMS = 2;

  // 1) 旋臂星(对数螺旋 + 随半径增长的横向散布,明暗混合制造层次)
  for (let k = 0; k < N_ARMS; k += 1) {
    const arm = k % ARMS;
    let r = R0 + (GALAXY_RADIUS - R0) * Math.pow(rand(), 0.8);
    r += gauss() * 1.2;
    const theta = Math.log(Math.max(r, R0) / R0) / SPIRAL_B
      + (arm * Math.PI) + gauss() * 0.16;
    const spread = 1.5 + r * 0.05;
    const x = Math.cos(theta) * r + gauss() * spread;
    const z = Math.sin(theta) * r + gauss() * spread;
    const y = gauss() * (0.8 + 2.4 * Math.exp(-r / 16));
    const t = Math.min(Math.abs(r) / GALAXY_RADIUS, 1);
    const c = diskColor(t);
    const tier = rand() < 0.18 ? 0.95 : 0.7; // 少量臂内亮星 + 普通星
    const s = 0.9 + rand() * 1.4;
    put(x, y, z, c[0] * tier, c[1] * tier, c[2] * tier, s);
  }
  // 2) 盘面散布星(均匀盘面 + 中央增厚,暗层)
  for (let k = 0; k < N_FIELD; k += 1) {
    const r = GALAXY_RADIUS * (0.12 + 0.88 * Math.sqrt(rand()));
    const theta = rand() * Math.PI * 2;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = gauss() * (0.9 + 2.0 * Math.exp(-r / 14));
    const t = r / GALAXY_RADIUS;
    const c = diskColor(t);
    const b = 0.32 + rand() * 0.2;
    put(x, y, z, c[0] * b, c[1] * b, c[2] * b, 0.7 + rand() * 1.1);
  }
  // 3) 核球(中央高斯椭球,前 900 颗更紧更亮 → 核心明亮聚集)
  for (let k = 0; k < N_BULGE; k += 1) {
    const tight = k < 900 ? 0.35 : 1.0;
    const rr = Math.abs(gauss()) * 3.4 * tight + 0.15;
    const u = rand() * 2 - 1, phi = rand() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    const x = sq * Math.cos(phi) * rr;
    const z = sq * Math.sin(phi) * rr;
    const y = u * rr * 0.62; // 扁椭球 → 中央隆起
    const warm = 0.95 + rand() * 0.05;
    const b = k < 900 ? 1.0 : 0.75 + rand() * 0.3;
    put(x, y, z, warm * b, 0.86 * b, 0.66 * b, 1.3 + rand() * 1.7);
  }
  // 4) 橙红亮巨星(少量散布,大尺寸高亮 → 第四类视觉锚点)
  for (let k = 0; k < N_GIANT; k += 1) {
    const r = 6 + (GALAXY_RADIUS - 6) * Math.pow(rand(), 0.7);
    const theta = rand() * Math.PI * 2;
    const x = Math.cos(theta) * r + gauss() * 1.5;
    const z = Math.sin(theta) * r + gauss() * 1.5;
    const y = gauss() * 1.3;
    put(x, y, z, 1.0, 0.42 + rand() * 0.2, 0.22 + rand() * 0.15, 3.2 + rand() * 1.6);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  return g;
}

function buildBackground() {
  // 远景背景星:大半径球壳内随机方向,极暗小点,增强纵深(静态层)
  const pos = new Float32Array(N_BG * 3);
  const col = new Float32Array(N_BG * 3);
  const siz = new Float32Array(N_BG);
  for (let k = 0; k < N_BG; k += 1) {
    const u = rand() * 2 - 1, phi = rand() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    const r = 900 + 800 * rand();
    pos[k * 3] = sq * Math.cos(phi) * r;
    pos[k * 3 + 1] = u * r;
    pos[k * 3 + 2] = sq * Math.sin(phi) * r;
    const b = 0.18 + rand() * 0.22;
    col[k * 3] = 0.85 * b; col[k * 3 + 1] = 0.9 * b; col[k * 3 + 2] = 1.0 * b;
    siz[k] = 7 + rand() * 6; // 远处衰减后约 1px 的暗点
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  return g;
}

const galaxyGroup = new THREE.Group(); // 只承载星系本体旋转(背景层不动 → 视差时产生相对位移)
galaxyGroup.add(new THREE.Points(buildGalaxy(), makeStarMaterial()));
scene.add(galaxyGroup);
scene.add(new THREE.Points(buildBackground(), makeStarMaterial()));

// --- 运行状态(bench 状态契约的唯一事实源)--------------------------------------
let rotationPhase = 0;                       // 星系旋转相位(rad),初始 0
let distTarget = HOME_DISTANCE;              // 滚轮控制的目标距离
let distCurrent = HOME_DISTANCE;             // 逐帧插值后的当前距离(getState 报告值)
let parallax = { x: 0, y: 0 };               // 平滑后的视差偏移(报告值,[-0.5,0.5] 归一化)
let parallaxTarget = { x: 0, y: 0 };         // 指针即时目标
let fps = 0;                                 // 2s 滚动平均帧率
let epoch = 0;                               // reset 计数
let resetAnim = null;                        // reset 补间状态
let hudVisible = true;

// --- 输入 ---------------------------------------------------------------------
window.addEventListener('pointermove', (e) => {
  // 有符号归一化偏移(相对画面中心),幅度 [-0.5,0.5];视差视觉幅度按此比例,
  // 相机横移 = offset*dist*0.12 → 最大约 6% 画布,低于 10% 上限
  parallaxTarget.x = e.clientX / window.innerWidth - 0.5;
  parallaxTarget.y = e.clientY / window.innerHeight - 0.5;
});
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = THREE.MathUtils.clamp(e.deltaY || 0, -2000, 2000);
  distTarget = THREE.MathUtils.clamp(distTarget * Math.exp(dy * 0.001), MIN_DISTANCE, MAX_DISTANCE);
}, { passive: false });

// --- HUD(2D DOM 覆盖层;3D 场景仍全部由 WebGL canvas 渲染)---------------------
const hud = document.createElement('div');
hud.id = 'hud';
hud.setAttribute('data-ui', 'hud');
hud.setAttribute('aria-label', 'hud');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:9999;pointer-events:none;' +
  'font:12px/1.6 Consolas,monospace;color:#d8e4ff;' +
  'background:rgba(3,6,14,0.55);border:1px solid rgba(120,150,220,0.35);' +
  'border-radius:6px;padding:8px 12px;min-width:170px;';
hud.innerHTML =
  '<div style="opacity:.75">E01 Deep Space Galaxy Cruise</div>' +
  '<div>STARS <span id="hud-stars">0</span></div>' +
  '<div>FPS <span id="hud-fps">0</span></div>' +
  '<div>DIST <span id="hud-dist">0</span></div>' +
  '<button type="button" data-ui="reset" aria-label="reset" ' +
  'style="pointer-events:auto;margin-top:6px;padding:3px 12px;font:12px sans-serif;' +
  'background:#1c2740;color:#fff;border:1px solid #55688f;border-radius:4px;cursor:pointer;">' +
  'Reset</button>';
document.body.appendChild(hud);
const hudStars = document.getElementById('hud-stars');
const hudFps = document.getElementById('hud-fps');
const hudDist = document.getElementById('hud-dist');
// Reset 控件绑定(探针经可见文本/aria-label/data-ui 定位后点击)
const resetBtn = document.querySelector('[data-ui="reset"]');
resetBtn.addEventListener('click', () => doReset());

// --- reset(0.45s smoothstep 补间,非整页刷新;phase 先 mod 2π 保视觉连续)------
function doReset() {
  epoch += 1;
  resetAnim = {
    t: 0,
    dur: 0.45,
    fromDist: distCurrent,
    fromPhase: ((rotationPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    fromX: parallax.x, fromY: parallax.y,
    fromTX: parallaxTarget.x, fromTY: parallaxTarget.y,
  };
  distTarget = HOME_DISTANCE;
  parallaxTarget.x = 0; parallaxTarget.y = 0;
}
window.__bench = {
  getState: () => ({
    starCount: TOTAL_STARS,
    rotationPhase,
    cameraDistance: distCurrent,
    parallaxOffset: { x: parallax.x, y: parallax.y },
    fps,
    hudVisible,
    epoch,
  }),
  reset: doReset,
};

// --- Agent 自检用探针模拟(不影响正式契约;由 verify-browser --eval 调用)--------
// 在页面内完成 P1–P7 的状态采样与画布像素度量(依赖 preserveDrawingBuffer)。
function grabFrame() {
  const w = canvas.width, h = canvas.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}
function litRatio(img, region) { // region: 'full' | 'center80';亮度阈值 > 40/255
  const x0 = region === 'center80' ? Math.floor(img.width * 0.1) : 0;
  const x1 = region === 'center80' ? Math.ceil(img.width * 0.9) : img.width;
  const y0 = region === 'center80' ? Math.floor(img.height * 0.1) : 0;
  const y1 = region === 'center80' ? Math.ceil(img.height * 0.9) : img.height;
  let total = 0, lit = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * img.width + x) * 4;
      total += 1;
      if (img.data[o] > 40 || img.data[o + 1] > 40 || img.data[o + 2] > 40) lit += 1;
    }
  }
  return lit / total;
}
function diffRatio(a, b, region) { // 任一通道 |Δ|>10 视为变化像素
  const x0 = region === 'center80' ? Math.floor(a.width * 0.1) : 0;
  const x1 = region === 'center80' ? Math.ceil(a.width * 0.9) : a.width;
  const y0 = region === 'center80' ? Math.floor(a.height * 0.1) : 0;
  const y1 = region === 'center80' ? Math.ceil(a.height * 0.9) : a.height;
  let total = 0, diff = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * a.width + x) * 4;
      total += 1;
      if (Math.abs(a.data[o] - b.data[o]) > 10 ||
          Math.abs(a.data[o + 1] - b.data[o + 1]) > 10 ||
          Math.abs(a.data[o + 2] - b.data[o + 2]) > 10) diff += 1;
    }
  }
  return diff / total;
}
window.__selfcheck = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__bench.getState();
  const out = {};
  out.initial = S();
  // P1
  await sleep(2500);
  out.p1 = { state: S(), litFull: litRatio(grabFrame(), 'full') };
  // P2(2s 采样窗:旋转相位增量 + 中央 80% 运动像素)
  const f2a = grabFrame(); const s2b = S();
  await sleep(2000);
  const f2b = grabFrame(); const s2a = S();
  out.p2 = { phaseDelta: s2a.rotationPhase - s2b.rotationPhase, motion: diffRatio(f2a, f2b, 'center80') };
  // P3(指针中心 → 右侧 0.68)
  window.dispatchEvent(new PointerEvent('pointermove', {
    clientX: Math.round(window.innerWidth * 0.68),
    clientY: Math.round(window.innerHeight * 0.5), bubbles: true,
  }));
  await sleep(400);
  const f3a = grabFrame(); const s3b = S();
  await sleep(600);
  const f3b = grabFrame(); const s3a = S();
  out.p3 = { before: s3b.parallaxOffset, after: s3a.parallaxOffset, pixelDelta: diffRatio(f3a, f3b, 'full') };
  // P4(滚轮 -600 → 穿行靠近)
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, cancelable: true, bubbles: true }));
  await sleep(500);
  const f4a = grabFrame(); const s4b = S();
  await sleep(300);
  const f4b = grabFrame(); const s4a = S();
  out.p4 = { before: s4b.cameraDistance, after: s4a.cameraDistance, pixelDelta: diffRatio(f4a, f4b, 'full') };
  // P5 + P6(等待 3s 后读 fps;HUD 可见性 + 文本)
  await sleep(3000);
  const s56 = S();
  const hudRect = hud.getBoundingClientRect();
  out.p56 = {
    state: s56,
    hud: {
      visible: hudRect.width > 0 && hudRect.height > 0,
      rect: { x: hudRect.x, y: hudRect.y, w: hudRect.width, h: hudRect.height },
      text: hud.innerText,
    },
  };
  // P7(点击 Reset → 0.8s 后断言恢复)
  document.querySelector('[data-ui="reset"]').click();
  await sleep(800);
  out.p7 = { state: S() };
  return out;
};

// --- 主循环 ---------------------------------------------------------------------
const frameTimes = []; // 2s 滚动窗口内的帧时间戳
let lastT = 0;
let hudAccum = 0;

function tick(now) {
  requestAnimationFrame(tick);
  if (lastT === 0) lastT = now;
  const dt = Math.min((now - lastT) / 1000, 0.5); // 钳制后台节流恢复后的单帧增量
  lastT = now;

  if (resetAnim) {
    // reset 补间:距离/视差/相位一起在 0.45s 内平滑恢复(smoothstep 无过冲)
    resetAnim.t += dt;
    const u = Math.min(resetAnim.t / resetAnim.dur, 1);
    const e = u * u * (3 - 2 * u);
    rotationPhase = resetAnim.fromPhase * (1 - e);
    distCurrent = resetAnim.fromDist + (HOME_DISTANCE - resetAnim.fromDist) * e;
    parallax.x = resetAnim.fromX * (1 - e);
    parallax.y = resetAnim.fromY * (1 - e);
    if (u >= 1) {
      rotationPhase = 0;
      distCurrent = HOME_DISTANCE;
      parallax.x = 0; parallax.y = 0;
      resetAnim = null;
    }
  } else {
    rotationPhase += ANGULAR_SPEED * dt; // 单调递增(仅 reset 补间期除外)
    // 指数平滑 = 帧率无关的逐帧插值(时间常数:距离 0.4s / 视差 0.45s)
    distCurrent += (distTarget - distCurrent) * (1 - Math.exp(-dt / 0.4));
    parallax.x += (parallaxTarget.x - parallax.x) * (1 - Math.exp(-dt / 0.45));
    parallax.y += (parallaxTarget.y - parallax.y) * (1 - Math.exp(-dt / 0.45));
  }

  // 相机:球坐标定基准位姿 + 视差横移;lookAt 目标同向小幅偏移,
  // 使星系与远景背景产生轻微相对位移(深度视差)
  const ce = Math.cos(HOME_ELEV), se = Math.sin(HOME_ELEV);
  const ca = Math.cos(HOME_AZIMUTH), sa = Math.sin(HOME_AZIMUTH);
  const px = parallax.x * distCurrent, py = parallax.y * distCurrent;
  camera.position.set(
    ca * ce * distCurrent + px * 0.12,
    se * distCurrent - py * 0.07,
    sa * ce * distCurrent
  );
  camera.lookAt(px * 0.05, -py * 0.03, 0);

  galaxyGroup.rotation.y = rotationPhase; // 绕盘面法线(+Y)整体慢旋

  // fps:2s 滚动平均
  frameTimes.push(now);
  while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
  if (frameTimes.length >= 3) {
    const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
    if (span > 0.2) fps = (frameTimes.length - 1) / span;
  }

  // HUD 每 0.2s 刷新一次真实运行数据(允许四舍五入显示)
  hudAccum += dt;
  if (hudAccum >= 0.2) {
    hudAccum = 0;
    hudStars.textContent = String(TOTAL_STARS);
    hudFps.textContent = String(Math.round(fps));
    hudDist.textContent = distCurrent.toFixed(1);
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
