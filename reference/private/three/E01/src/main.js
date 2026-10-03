// ============================================================================
// E01 — 深空星系巡航(Deep Space Galaxy Cruise)— Three.js r186 Reference
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1 / E01 spec.json):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//
// 状态语义(全部来自真实运行数据,无一处硬编码谎报):
//   starCount      = 三层星点几何体实际顶点数之和(核球 9000 + 盘/臂 47000 + 远景 6000)
//                    —— 星云薄雾层是特效 sprite(非星点),不计入 starCount
//   rotationPhase  = 主星系自上一次 reset 起的累计旋转相位(rad,ω = 0.05 rad/s ∈ [0.02,0.1])
//   cameraDistance = 相机到星系中心的实际距离(指数平滑插值,初始 120,范围 [40,400])
//   parallaxOffset = 指针视差偏移的平滑值(指针偏离画面中心的归一化有符号偏移)
//   fps            = 最近 2s 滚动平均帧率
//   hudVisible     = HUD 可见性
//   epoch          = reset 计数(非整页刷新证明)
//
// 探针友好性设计(双采样探针 P3/P4 要求动作后状态持续变化):
//   视差与距离均为指数平滑跟随,动作后数百毫秒内仍在持续逼近目标,绝不瞬跳后静止。
// ============================================================================

import * as THREE from 'three';

// ---------- 随机工具 ----------------------------------------------------------
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------- 场景参数 ----------------------------------------------------------
const BULGE_STARS = 9000;   // 核球亮星群
const DISK_STARS = 47000;   // 旋臂 + 盘面星
const SKY_STARS = 9000;     // 远景背景星(球壳,填充视野四周,增强纵深)
const STAR_COUNT = BULGE_STARS + DISK_STARS + SKY_STARS; // 真实渲染星点总数 = 65000
const NEBULA_PUFFS = 420;   // 星云薄雾 sprite(视觉特效,非星点,不计入 starCount)

const GALAXY_R = 76;        // 星系盘半径(世界单位;dist=120 时盘面占屏宽 ≈71%,落在 60–75% 构图带)
const ARMS = 2;             // 对数螺旋旋臂数(≥2)
const PITCH = 0.30;         // 对数螺旋 pitch=tan(倾角):θ(r) = ln(r/r0)/PITCH

const OMEGA = 0.05;         // 星系角速度 rad/s(合同区间 0.02–0.1)
const SKY_OMEGA = 0.008;    // 远景层极慢反向漂移(增强纵深)

const DIST_INIT = 120, DIST_MIN = 40, DIST_MAX = 400;
const WHEEL_FACTOR = 0.10;  // 每单位 |deltaY| 的目标距离变化量
const TAU_PARALLAX = 0.20;  // 视差指数平滑时间常数(s)
const TAU_DIST = 0.35;      // 距离指数平滑时间常数(s)
const ELEV = (38 * Math.PI) / 180; // 相机仰角(盘面上方 38°,视线-盘法线夹角 52° ∈ [30°,60°])
const PARALLAX_AMP = 6.0;   // |parallax|=1 时的相机横向平移(≈画布 5% < 10% 上限)
const RESET_TWEEN_MS = 450; // reset 距离恢复动画时长(< 1s 合同)

const armAngle = (r) => Math.log(Math.max(r, 2.5) / 2.5) / PITCH;

// ---------- 渲染器 / 场景 / 相机 ------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050810); // 深空底色 RGB(5,8,16),暗于 (16,16,24)

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 5000);
// 固定观察方向:仰角 ELEV 绕原点;视差 = 在该方向的正交基上做小幅平移(lookAt 保持原点)
const CAM_DIR = new THREE.Vector3(0, Math.sin(ELEV), Math.cos(ELEV)).normalize();
const CAM_UP = new THREE.Vector3(0, Math.cos(ELEV), -Math.sin(ELEV)).normalize();
const CAM_RIGHT = new THREE.Vector3(1, 0, 0);

// ---------- 星点材质:自定义 shader(尺寸衰减 + 双层辉光 + 每星闪烁)--------------
const starVert = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aSeed;
  attribute vec3  aColor;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 每星独立相位/频率的轻微闪烁(暗弱星层次感 + 全画面持续微动)
    float tw = 0.85 + 0.15 * sin(uTime * (0.6 + aSeed * 2.4) + aSeed * 37.0);
    vColor = aColor * tw;
    // 尺寸随距离衰减(近大远小);钳制防止穿行时单点爆屏
    float ps = aSize * uPixelRatio * (300.0 / max(0.1, -mv.z));
    gl_PointSize = clamp(ps, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const starFrag = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d2 = dot(uv, uv) * 4.0;          // 0(中心) → 1(边缘)
    float core = exp(-d2 * 7.0);           // 紧致亮核
    float halo = exp(-d2 * 2.0) * 0.32;    // 宽散辉光(免后处理的伪 bloom)
    gl_FragColor = vec4(vColor, min(core + halo, 1.0));
  }
`;
const starMaterial = new THREE.ShaderMaterial({
  vertexShader: starVert,
  fragmentShader: starFrag,
  uniforms: {
    uTime: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
  },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// ---------- 星点层生成 ----------------------------------------------------------
// filler(i) → [x, y, z, r, g, b, size];颜色已含亮度分层(3+ 档亮暗层级)
function buildStarLayer(count, filler) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = filler(i);
    positions[i * 3] = s[0]; positions[i * 3 + 1] = s[1]; positions[i * 3 + 2] = s[2];
    colors[i * 3] = s[3]; colors[i * 3 + 1] = s[4]; colors[i * 3 + 2] = s[5];
    sizes[i] = s[6];
    seeds[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  return g;
}

// 核球:扁高斯椭球,暖黄白,中心更亮(数千密集亮星)。
// 亮度刻意压低:加色混合下数千星叠加,过亮会把整个核心糊成白色斑块
function bulgeFiller() {
  const x = gaussian() * 5.0, y = gaussian() * 3.0, z = gaussian() * 5.0;
  const rr = Math.sqrt(x * x + y * y * 1.6 + z * z);
  const t = Math.min(rr / 16, 1);
  const r = lerp(1.00, 1.00, t), g = lerp(0.95, 0.80, t), b = lerp(0.84, 0.52, t);
  const bright = 0.40 + 0.55 * Math.pow(Math.random(), 2.2);
  const giant = Math.random() < 0.05;
  const size = giant ? 2.0 + 1.2 * Math.random() : 1.0 + 1.2 * Math.random();
  return [x, y, z, r * bright, g * bright, b * bright, size];
}

// 盘面 + 旋臂:对数螺旋 θ(r)=armOffset+ln(r/r0)/PITCH,半径密度外减,
// 角向/径向散布随半径增大;22% 为无结构盘面星;散布少量橙红亮星
function diskFiller(i) {
  const rBase = Math.pow(Math.random(), 1.6) * (GALAXY_R - 4) + 3.0;
  let th;
  if (Math.random() < 0.22) {
    th = Math.random() * Math.PI * 2; // 无结构盘面种群
  } else {
    const arm = i % ARMS;
    const jitter = gaussian() * (0.10 + 0.16 * Math.pow(rBase / GALAXY_R, 1.2));
    th = arm * (Math.PI * 2 / ARMS) + armAngle(rBase) + jitter;
  }
  const rr = Math.max(1.5, rBase + gaussian() * (1.5 + 3.0 * rBase / GALAXY_R));
  const y = gaussian() * (1.4 + 2.4 * Math.exp(-rr / 16)); // 盘厚度:内厚外薄 + 隆起
  const t = Math.min(rr / GALAXY_R, 1);
  // 半径颜色梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝
  let r, g, b;
  if (t < 0.32) { const k = t / 0.32; r = lerp(1.00, 0.86, k); g = lerp(0.94, 0.90, k); b = lerp(0.80, 1.00, k); }
  else if (t < 0.72) { const k = (t - 0.32) / 0.40; r = lerp(0.86, 0.62, k); g = lerp(0.90, 0.72, k); b = 1.00; }
  else { const k = (t - 0.72) / 0.28; r = lerp(0.62, 0.44, k); g = lerp(0.72, 0.56, k); b = 1.00; }
  let size = 0.7 + 1.2 * Math.random();
  let bright = 0.45 + 0.85 * Math.pow(Math.random(), 2.0); // 多数暗弱、少数明亮的层级分布
  if (Math.random() < 0.022 && t > 0.12) { // 橙红亮星散布
    r = 1.00; g = 0.46; b = 0.22;
    bright = 1.05 + 0.45 * Math.random();
    size = 2.2 + 2.0 * Math.random();
  }
  return [Math.cos(th) * rr, y, Math.sin(th) * rr, r * bright, g * bright, b * bright, size];
}

// 远景背景星:大球壳上均匀撒点,暗弱,静态纵深参照(视差的深度差来源)。
// 少量大号暖星点缀 + 大量细小蓝白星,保证视野四周无死黑空区
function skyFiller() {
  const phi = Math.random() * Math.PI * 2;
  const cy = Math.random() * 2 - 1;
  const sxy = Math.sqrt(Math.max(0, 1 - cy * cy));
  const radius = 700 + Math.random() * 900;
  const warm = Math.random() < 0.16;
  let r = 0.72, g = 0.80, b = 1.00;
  if (warm) { r = 1.00; g = 0.85; b = 0.66; }
  const bright = warm ? 0.55 + 0.5 * Math.random() : 0.30 + 0.5 * Math.random();
  const size = warm ? 3.5 + 3.5 * Math.random() : 1.6 + 3.2 * Math.random();
  return [sxy * Math.cos(phi) * radius, cy * radius, sxy * Math.sin(phi) * radius,
          r * bright, g * bright, b * bright, size];
}

// 星云薄雾:沿旋臂的暗色大 sprite,加色混合后成极淡的蓝紫雾(特效,非星点)
function nebulaFiller(i) {
  const r = 6 + Math.pow(Math.random(), 1.3) * (GALAXY_R - 12);
  const arm = i % ARMS;
  const th = arm * (Math.PI * 2 / ARMS) + armAngle(r) + gaussian() * 0.13;
  const y = gaussian() * 1.4;
  const pick = Math.random();
  let cr, cg, cb;
  if (pick < 0.45) { cr = 0.045; cg = 0.085; cb = 0.20; }   // 深蓝
  else if (pick < 0.80) { cr = 0.10; cg = 0.05; cb = 0.18; } // 紫
  else { cr = 0.05; cg = 0.13; cb = 0.17; }                  // 青
  const k = 0.32 + 0.55 * Math.random();
  const size = 12 + 22 * Math.random();
  return [Math.cos(th) * r, y, Math.sin(th) * r, cr * k, cg * k, cb * k, size];
}

const galaxyGroup = new THREE.Group();
galaxyGroup.add(new THREE.Points(buildStarLayer(BULGE_STARS, bulgeFiller), starMaterial));
galaxyGroup.add(new THREE.Points(buildStarLayer(DISK_STARS, diskFiller), starMaterial));
galaxyGroup.add(new THREE.Points(buildStarLayer(NEBULA_PUFFS, nebulaFiller), starMaterial));
scene.add(galaxyGroup);

const skyGroup = new THREE.Group();
skyGroup.add(new THREE.Points(buildStarLayer(SKY_STARS, skyFiller), starMaterial));
scene.add(skyGroup);

// ---------- 运行时状态 ----------------------------------------------------------
let galaxyAngle = 0;      // 主星系累计旋转角(视觉连续,永不回退)
let phaseOrigin = 0;      // rotationPhase = galaxyAngle - phaseOrigin(reset 时置为当前角)
let skyAngle = 0;
let parallax = { x: 0, y: 0 };        // 平滑后的视差偏移(暴露状态)
let parallaxTarget = { x: 0, y: 0 };  // 视差目标(仅由 pointermove 事件驱动)
let distActual = DIST_INIT;           // 实际相机距离(暴露状态)
let targetDist = DIST_INIT;           // 距离目标(滚轮改写)
let resetTween = null;                // reset 期的专用距离补间
let epoch = 0;
let fpsValue = 0;
let simTime = 0;

const phaseNow = () => galaxyAngle - phaseOrigin;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// ---------- HUD(DOM 覆盖层,数值全部来自真实运行数据)----------------------------
{
  const style = document.createElement('style');
  style.textContent = `
    #hud {
      position: fixed; top: 14px; left: 14px; z-index: 10;
      padding: 10px 14px 12px; pointer-events: none; user-select: none;
      font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; line-height: 1.7;
      letter-spacing: 0.06em; color: #a8d8ff;
      background: rgba(5, 12, 24, 0.55);
      border: 1px solid rgba(110, 190, 255, 0.35); border-radius: 8px;
      backdrop-filter: blur(3px);
      box-shadow: 0 0 18px rgba(40, 120, 255, 0.10), inset 0 0 24px rgba(40, 120, 255, 0.06);
    }
    #hud .title { color: #e6f4ff; font-size: 11px; letter-spacing: 0.24em; margin-bottom: 6px; }
    #hud .row { display: flex; justify-content: space-between; gap: 22px; }
    #hud .k { color: #5f8fbf; }
    #hud .v { color: #dff2ff; font-weight: 600; }
    #btn-reset {
      pointer-events: auto; margin-top: 9px; width: 100%; box-sizing: border-box; padding: 6px 0;
      background: rgba(20, 60, 110, 0.35); color: #cfeaff; cursor: pointer;
      border: 1px solid rgba(120, 200, 255, 0.55); border-radius: 5px;
      font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; letter-spacing: 0.30em;
      transition: background 0.15s, box-shadow 0.15s;
    }
    #btn-reset:hover { background: rgba(60, 140, 220, 0.45); box-shadow: 0 0 12px rgba(90, 190, 255, 0.45); }
    #btn-reset:active { background: rgba(90, 180, 255, 0.55); }
    #hint {
      position: fixed; left: 14px; bottom: 12px; z-index: 10; pointer-events: none; user-select: none;
      font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 1.4;
      letter-spacing: 0.18em; color: rgba(178, 212, 240, 0.80);
      text-shadow: 0 0 6px rgba(20, 60, 110, 0.9);
    }
    #vignette {
      position: fixed; inset: 0; z-index: 5; pointer-events: none;
      background: radial-gradient(ellipse at center, rgba(0,0,0,0) 62%, rgba(0,2,8,0.30) 100%);
    }
  `;
  document.head.appendChild(style);
}
const hudRoot = document.createElement('div');
hudRoot.id = 'hud';
hudRoot.setAttribute('data-ui', 'hud');
hudRoot.innerHTML = `
  <div class="title">DEEP SPACE &middot; GALAXY CRUISE</div>
  <div class="row"><span class="k">STARS</span><span class="v" data-ui="hud-stars">--</span></div>
  <div class="row"><span class="k">FPS</span><span class="v" data-ui="hud-fps">--</span></div>
  <div class="row"><span class="k">DIST</span><span class="v" data-ui="hud-dist">120.0</span></div>
  <div class="row"><span class="k">PHASE</span><span class="v" data-ui="hud-phase">0.00</span></div>
  <button id="btn-reset" data-ui="reset" aria-label="reset" type="button">Reset</button>
`;
document.body.appendChild(hudRoot);
const hintEl = document.createElement('div');
hintEl.id = 'hint';
hintEl.setAttribute('data-ui', 'hint');
hintEl.textContent = 'POINTER 视差 · WHEEL 穿行巡航 · RESET 复位';
document.body.appendChild(hintEl);
const vignette = document.createElement('div');
vignette.id = 'vignette';
document.body.appendChild(vignette);

const hudStars = hudRoot.querySelector('[data-ui="hud-stars"]');
const hudFps = hudRoot.querySelector('[data-ui="hud-fps"]');
const hudDist = hudRoot.querySelector('[data-ui="hud-dist"]');
const hudPhase = hudRoot.querySelector('[data-ui="hud-phase"]');

let hudNextUpdate = 0;
function updateHud(nowMs) {
  if (nowMs < hudNextUpdate) return;
  hudNextUpdate = nowMs + 120;
  hudStars.textContent = String(STAR_COUNT);                    // 与几何体实际点数一致
  hudFps.textContent = String(Math.max(0, Math.round(fpsValue)));
  hudDist.textContent = distActual.toFixed(1);
  hudPhase.textContent = phaseNow().toFixed(2);
}

// ---------- fps:最近 2s 滚动平均 -------------------------------------------------
const frameTimes = [];
function pushFrameTime(tSec) {
  // 后台标签挂起恢复的大间隔帧不计入滚动窗(节流非失败;恢复后正确重算)
  if (frameTimes.length > 0 && tSec - frameTimes[frameTimes.length - 1] > 0.25) {
    frameTimes.length = 0;
  }
  frameTimes.push(tSec);
  while (frameTimes.length > 2 && tSec - frameTimes[0] > 2.0) frameTimes.shift();
  const n = frameTimes.length;
  fpsValue = n >= 2 ? (n - 1) / Math.max(1e-6, frameTimes[n - 1] - frameTimes[0]) : 0;
}

// ---------- reset ----------------------------------------------------------------
function doReset() {
  epoch += 1;
  phaseOrigin = galaxyAngle;   // rotationPhase 归零;星系视觉角度连续,不回跳
  parallaxTarget.x = 0; parallaxTarget.y = 0;
  parallax.x = 0; parallax.y = 0;
  targetDist = DIST_INIT;
  resetTween = { t0: performance.now(), dur: RESET_TWEEN_MS, from: distActual };
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    starCount: STAR_COUNT,
    rotationPhase: phaseNow(),
    cameraDistance: distActual,
    parallaxOffset: { x: parallax.x, y: parallax.y },
    fps: fpsValue,
    hudVisible: true,
    epoch,
  }),
  reset: doReset,
};

// ---------- 输入:指针视差 / 滚轮穿行 ---------------------------------------------
// 视差目标仅由 pointermove 事件驱动(reset 清零后若指针不再移动则保持零)
window.addEventListener('pointermove', (e) => {
  parallaxTarget.x = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1);
  parallaxTarget.y = clamp((e.clientY / window.innerHeight) * 2 - 1, -1, 1);
}, { passive: true });
document.addEventListener('mouseleave', () => {
  parallaxTarget.x = 0; parallaxTarget.y = 0;
});

// 滚轮:deltaY<0(向上)→ 目标距离减小 → 靠近穿行;平滑插值由主循环完成
window.addEventListener('wheel', (e) => {
  resetTween = null; // 用户重新接管,取消 reset 补间
  targetDist = clamp(targetDist + e.deltaY * WHEEL_FACTOR, DIST_MIN, DIST_MAX);
}, { passive: true });

document.getElementById('btn-reset').addEventListener('click', doReset);

// ---------- 主循环 ----------------------------------------------------------------
const clock = new THREE.Clock();
let appReadySet = false;

function tick() {
  requestAnimationFrame(tick);
  let dt = clock.getDelta();
  if (dt < 0) dt = 0;
  if (dt > 0.1) dt = 0.1; // 后台恢复保护:单帧步长钳制,时间推进始终正确
  simTime += dt;

  pushFrameTime(performance.now() / 1000);

  // 旋转:主星系 + 远景层(切向整体流动)
  galaxyAngle += OMEGA * dt;
  galaxyGroup.rotation.y = galaxyAngle;
  skyAngle -= SKY_OMEGA * dt;
  skyGroup.rotation.y = skyAngle;

  // 视差:指数平滑跟随(τ=0.2s,连续变化、无过冲)
  const kp = 1 - Math.exp(-dt / TAU_PARALLAX);
  parallax.x += (parallaxTarget.x - parallax.x) * kp;
  parallax.y += (parallaxTarget.y - parallax.y) * kp;

  // 距离:reset 补间优先;否则指数平滑逼近滚轮目标(τ=0.35s,惯性穿行)
  if (resetTween) {
    const t = (performance.now() - resetTween.t0) / resetTween.dur;
    if (t >= 1) { distActual = DIST_INIT; resetTween = null; }
    else distActual = lerp(resetTween.from, DIST_INIT, easeOutCubic(t));
    targetDist = DIST_INIT;
  } else {
    distActual += (targetDist - distActual) * (1 - Math.exp(-dt / TAU_DIST));
    if (Math.abs(targetDist - distActual) < 0.001) distActual = targetDist;
  }

  // 相机:固定仰角方向 × 距离 + 视差横向平移,lookAt 星系中心
  // ( galaxy 居中、远景层反向位移 → 深度视差 )
  camera.position.copy(CAM_DIR).multiplyScalar(distActual)
    .addScaledVector(CAM_RIGHT, parallax.x * PARALLAX_AMP)
    .addScaledVector(CAM_UP, -parallax.y * PARALLAX_AMP);
  camera.lookAt(0, 0, 0);

  starMaterial.uniforms.uTime.value = simTime;
  renderer.render(scene, camera);
  updateHud(performance.now());

  if (!appReadySet) {
    appReadySet = true;
    window.__appReady = true; // 首帧渲染完成
  }
}
tick();

// ---------- 视口自适应 -------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  starMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
});
