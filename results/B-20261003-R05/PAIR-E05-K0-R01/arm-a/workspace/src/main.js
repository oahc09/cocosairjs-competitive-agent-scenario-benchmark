// ============================================================================
// E05 — 黑洞吸积盘(Black Hole Accretion Disk)— three.js r186
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
// 全部视觉程序化生成(assets = []);无网络请求;动画按真实时间步进。
// ============================================================================

import * as THREE from 'three';

// ---------- 常量(spec 校准值) ------------------------------------------------
const N_STREAM = 240;          // 星流粒子数 >= 200(恒定,循环重生)
const N_BG_A = 4800;           // 背景星 A 层(小暗星)
const N_BG_B = 1200;           // 背景星 B 层(亮星)
const N_BG = N_BG_A + N_BG_B;  // 背景星点数 >= 300
const OMEGA = 0.42;            // 吸积盘角速度 rad/s(spec: 0.15-0.6)
const DISK_INNER = 1.8;        // 盘内缘半径(场景单位)
const DISK_OUTER = 6.5;        // 盘外缘半径
const HORIZON_R = 1.2;         // 事件视界(暗核)半径
const CAM_MIN = 5, CAM_MAX = 28, CAM_INIT = 14;
const EL0 = (25 * Math.PI) / 180; // 相机俯仰(盘面倾角观感,15°-75° 区间内)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 确定性随机(reset 后星流复位到同一初始布局)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 渲染器 / 场景 / 相机 ----------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);

// 相机状态:距离滚轮平滑缩放;俯仰拖拽微调
let camDist = CAM_INIT, camTarget = CAM_INIT;
let el = EL0, elTarget = EL0;
function applyCamera() {
  camera.position.set(0, Math.sin(el) * camDist, Math.cos(el) * camDist);
  camera.lookAt(0, 0, 0);
}
applyCamera();

// ---------- 程序化纹理工具 ------------------------------------------------------
function radialTexture(size, stops) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 弧形光晕(引力透镜观感:盘后缘向上弯包绕核心的蓝白弧)
function arcTexture(size, radNorm, thickNorm, ang0, ang1, rgb) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const layers = 16;
  for (let k = 0; k < layers; k++) {
    const f = k / (layers - 1);
    g.beginPath();
    g.arc(size / 2, size / 2, (radNorm + (f - 0.5) * thickNorm) * size / 2, ang0, ang1);
    g.strokeStyle = 'rgba(' + rgb + ',' + (0.6 * Math.exp(-Math.pow((f - 0.5) * 3.0, 2))).toFixed(3) + ')';
    g.lineWidth = ((thickNorm * size) / 2 / layers) * 1.9;
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const dotTex = radialTexture(64, [
  [0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)'],
]);
// 星点用更"实心"的核,保证小尺寸下仍清晰可见
const starTex = radialTexture(64, [
  [0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,0.92)'], [1, 'rgba(255,255,255,0)'],
]);

// ---------- 1. 背景星空层(>=300 静态星点,两层密度/亮度) ------------------------
function buildStarLayer(count, size, seed, bMin, bRange) {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rng() * 2 - 1, th = rng() * Math.PI * 2, rr = 46 + rng() * 16;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = s * Math.cos(th) * rr;
    pos[i * 3 + 1] = u * rr;
    pos[i * 3 + 2] = s * Math.sin(th) * rr;
    const b = bMin + Math.pow(rng(), 1.6) * bRange;
    const t = rng();
    let r = b, g = b, bl = b;
    if (t < 0.18) { r = b * 0.74; g = b * 0.86; bl = b; }          // 冷蓝
    else if (t > 0.85) { r = b; g = b * 0.82; bl = b * 0.62; }     // 暖黄
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = bl;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size, sizeAttenuation: false, map: starTex, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
  });
  scene.add(new THREE.Points(geo, mat));
}
buildStarLayer(N_BG_A, 3.9, 20261003, 0.58, 0.5);
buildStarLayer(N_BG_B, 5.6, 4711, 0.80, 0.45);

// ---------- 2. 黑洞核心(纯黑事件视界,锐利边界) ---------------------------------
const core = new THREE.Mesh(
  new THREE.SphereGeometry(HORIZON_R, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
scene.add(core);

// ---------- 3. 吸积盘(Shader:径向梯度 + 旋转螺旋条纹 + 多普勒增亮) ---------------
const diskUniforms = { uRotation: { value: 0 } };
const diskMat = new THREE.ShaderMaterial({
  uniforms: diskUniforms,
  vertexShader: [
    'varying vec2 vP;',
    'void main() {',
    '  vP = position.xy;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}',
  ].join('\n'),
  fragmentShader: [
    'precision highp float;',
    'varying vec2 vP;',
    'uniform float uRotation;',
    'const float IN_R = 1.8;',
    'const float OUT_R = 6.5;',
    // 径向颜色梯度:内缘白/蓝白 -> 中带亮黄橙 -> 外缘暗红
    'vec3 ramp(float x) {',
    '  vec3 c = mix(vec3(1.70, 1.82, 2.10), vec3(1.85, 1.83, 1.86), clamp(x / 0.213, 0.0, 1.0));',
    '  c = mix(c, vec3(1.24, 0.86, 0.34), clamp((x - 0.213) / 0.127, 0.0, 1.0));',
    '  c = mix(c, vec3(0.90, 0.42, 0.15), clamp((x - 0.340) / 0.319, 0.0, 1.0));',
    '  c = mix(c, vec3(0.38, 0.10, 0.04), clamp((x - 0.659) / 0.341, 0.0, 1.0));',
    '  return c;',
    '}',
    'void main() {',
    '  float r = length(vP);',
    '  if (r < IN_R - 0.05 || r > OUT_R + 0.05) discard;',
    '  float t = clamp((r - IN_R) / (OUT_R - IN_R), 0.0, 1.0);',
    '  float theta = atan(vP.y, vP.x);',
    // 螺旋条纹:时间参数驱动的连续旋转(uRotation 为累计弧度)
    '  float a = theta - uRotation + 2.4 * log(r);',
    '  float stripes = 0.50 + 0.26 * sin(a * 6.0) + 0.10 * sin(a * 13.0 + 1.7);',
    // 多普勒束射:近核(轨道更快)增亮更强,亮侧固定(白/橙偏移克制以保色彩梯度)
    '  float dop = 1.0 + (0.10 + 0.40 * (1.0 - smoothstep(1.8, 4.5, r))) * cos(theta);',
    '  float fadeIn = smoothstep(IN_R, IN_R + 0.30, r);',
    '  float fadeOut = 1.0 - smoothstep(OUT_R - 1.6, OUT_R, r);',
    // 内缘炽热白蓝 rim(向内增亮,向外指数衰减 -> 柔和辉光过渡)
    '  float rim = 1.30 * exp(-max(r - IN_R, 0.0) * 1.75);',
    '  vec3 col = ramp(t) * stripes * dop + vec3(0.85, 0.92, 1.10) * rim;',
    '  gl_FragColor = vec4(col, fadeIn * fadeOut * 0.95);',
    '}',
  ].join('\n'),
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
});
const disk = new THREE.Mesh(new THREE.RingGeometry(DISK_INNER - 0.05, DISK_OUTER + 0.05, 256, 1), diskMat);
disk.rotation.x = Math.PI / 2; // 铺到 XZ 平面;条纹角向与星流公转方向一致
scene.add(disk);

// ---------- 4. 辉光替代层(多层叠加光晕片,路径不限,柔光无硬边) -------------------
// 光子环(贴视界蓝白细环,兼作引力透镜观感基底)
const photon = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture(256, [
    [0.0, 'rgba(0,0,0,0)'], [0.50, 'rgba(0,0,0,0)'], [0.58, 'rgba(190,212,255,0.20)'],
    [0.66, 'rgba(226,236,255,0.85)'], [0.72, 'rgba(200,220,255,0.42)'], [1.0, 'rgba(160,190,255,0)'],
  ]),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
photon.scale.set(4.0, 4.0, 1);
scene.add(photon);

// 内区炽热辉光(白蓝,贴合内缘向外柔和扩散)
const glowIn = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture(256, [
    [0.0, 'rgba(0,0,0,0)'], [0.14, 'rgba(0,0,0,0)'], [0.26, 'rgba(235,238,255,0.48)'],
    [0.36, 'rgba(242,244,255,0.62)'], [0.55, 'rgba(255,228,195,0.12)'], [1.0, 'rgba(255,205,155,0)'],
  ]),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
glowIn.scale.set(7.0, 7.0, 1);
scene.add(glowIn);

// 外围大范围暖色微光(整体氛围,极淡)
const glowOut = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture(256, [
    [0.0, 'rgba(0,0,0,0)'], [0.25, 'rgba(255,160,95,0.05)'], [0.32, 'rgba(255,150,90,0.075)'],
    [0.55, 'rgba(190,85,50,0.02)'], [1.0, 'rgba(120,50,30,0)'],
  ]),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
glowOut.scale.set(18.0, 18.0, 1);
scene.add(glowOut);

// 引力透镜弧(上半环,贴视界上方包绕)
const lensArc = new THREE.Sprite(new THREE.SpriteMaterial({
  map: arcTexture(256, 0.62, 0.10, Math.PI * 0.96, Math.PI * 2.04, '190,215,255'),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8,
}));
lensArc.scale.set(4.4, 4.4, 1);
scene.add(lensArc);

// ---------- 5. 星流(>=200 粒子,螺旋汇入,视界吞噬重生,近界拉长) ----------------
const linePos = new Float32Array(N_STREAM * 6);
const lineCol = new Float32Array(N_STREAM * 6);
const headPos = new Float32Array(N_STREAM * 3);
const headCol = new Float32Array(N_STREAM * 3);

const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
})));

const headGeo = new THREE.BufferGeometry();
headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
headGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage));
scene.add(new THREE.Points(headGeo, new THREE.PointsMaterial({
  size: 2.6, sizeAttenuation: false, map: dotTex, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
})));

const stream = { parts: [], seed: 987654321 };
function seedStream() {
  const rng = mulberry32(stream.seed);
  stream.parts.length = 0;
  for (let i = 0; i < N_STREAM; i++) {
    stream.parts.push({
      r: 2.0 + Math.pow(rng(), 0.9) * 6.3,
      phi: rng() * Math.PI * 2,
      yA: 0.10 + rng() * 0.55,
      yPh: rng() * Math.PI * 2,
      b: 0.45 + rng() * 0.55,
    });
  }
}
seedStream();

function updateStream(dt) {
  for (let i = 0; i < N_STREAM; i++) {
    const p = stream.parts[i];
    const w = 1.35 / Math.pow(p.r, 1.5);                              // 开普勒式:内快外慢
    const dr = -(0.30 + 1.05 * Math.pow(1.9 / p.r, 2.2));             // 越近视界坠落越快
    const damp = clamp((p.r - HORIZON_R) / 2.2, 0, 1);
    const y = p.yA * Math.sin(p.phi + p.yPh) * damp;
    const x = Math.cos(p.phi) * p.r, z = Math.sin(p.phi) * p.r;
    // 拖尾:沿轨迹向后回推;越接近视界尾迹越长(被拉长)
    const tdt = 0.05 + 0.24 * Math.pow(1.55 / p.r, 2.0);
    const rp = Math.min(8.6, p.r - dr * tdt);
    const phip = p.phi - w * tdt;
    const yp = p.yA * Math.sin(phip + p.yPh) * clamp((rp - HORIZON_R) / 2.2, 0, 1);
    const xp = Math.cos(phip) * rp, zp = Math.sin(phip) * rp;
    const i6 = i * 6, i3 = i * 3;
    linePos[i6] = xp; linePos[i6 + 1] = yp; linePos[i6 + 2] = zp;
    linePos[i6 + 3] = x; linePos[i6 + 4] = y; linePos[i6 + 5] = z;
    lineCol[i6] = 0.40 * p.b; lineCol[i6 + 1] = 0.25 * p.b; lineCol[i6 + 2] = 0.13 * p.b;
    lineCol[i6 + 3] = 1.0 * p.b; lineCol[i6 + 4] = 0.95 * p.b; lineCol[i6 + 5] = 0.85 * p.b;
    headPos[i3] = x; headPos[i3 + 1] = y; headPos[i3 + 2] = z;
    headCol[i3] = p.b; headCol[i3 + 1] = p.b * 0.95; headCol[i3 + 2] = p.b * 0.85;
    p.phi += w * dt;
    p.r += dr * dt;
    if (p.r <= HORIZON_R + 0.04) {
      // 吞噬:总数恒定,外圈重生
      p.r = 5.8 + Math.random() * 2.6;
      p.phi = Math.random() * Math.PI * 2;
      p.yA = 0.10 + Math.random() * 0.55;
      p.yPh = Math.random() * Math.PI * 2;
    }
  }
  lineGeo.attributes.position.needsUpdate = true;
  lineGeo.attributes.color.needsUpdate = true;
  headGeo.attributes.position.needsUpdate = true;
  headGeo.attributes.color.needsUpdate = true;
}

// ---------- 状态通道与 reset ------------------------------------------------------
let diskRotation = 0; // 自上次 reset 起累计弧度(单调递增)
let frame = 0;

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    frame,
    diskRotation,
    accretionPhase: (diskRotation / (Math.PI * 2)) % 1,
    cameraDistance: camDist,
    starStreamCount: N_STREAM,
    backgroundStarCount: N_BG,
  }),
  reset: doReset,
};

function doReset() {
  diskRotation = 0;
  camDist = CAM_INIT;
  camTarget = CAM_INIT;
  diskUniforms.uRotation.value = 0;
  seedStream(); // 星流复位重生(确定性初始布局);背景星不变
}

// ---------- 交互:滚轮缩放(平滑插值)+ 拖拽微调俯仰 ------------------------------
window.addEventListener('wheel', (e) => {
  if (e.cancelable) e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
  camTarget = clamp(camTarget * Math.exp(dy * 0.0011), CAM_MIN, CAM_MAX);
}, { passive: false });

let dragging = false, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  elTarget = clamp(elTarget + (e.clientY - lastY) * 0.0012, 0.30, 0.62);
  lastY = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointercancel', () => { dragging = false; });

// ---------- UI 覆盖层(DOM,非画布内) --------------------------------------------
{
  const btn = document.createElement('button');
  btn.textContent = '重置';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:9999;padding:5px 14px;font:13px sans-serif;' +
    'background:rgba(20,20,26,0.85);color:#dde3ff;border:1px solid #4a5178;border-radius:6px;cursor:pointer';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);

  const hint = document.createElement('div');
  hint.textContent = '滚轮缩放 · 拖拽微调视角';
  hint.style.cssText = 'position:fixed;bottom:10px;left:12px;z-index:9999;font:11px sans-serif;color:rgba(180,190,220,0.55)';
  document.body.appendChild(hint);
}

// ---------- 主循环(真实时间步进;失焦不跳变) -------------------------------------
let last = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0.0001;
  dt = Math.min(dt, 0.05); // 失焦再聚焦不产生时间跳变

  diskRotation += OMEGA * dt;
  diskUniforms.uRotation.value = diskRotation;

  camDist += (camTarget - camDist) * (1 - Math.exp(-6 * dt)); // 1s 内残差 <0.3%
  el += (elTarget - el) * (1 - Math.exp(-8 * dt));
  applyCamera();

  updateStream(dt);
  renderer.render(scene, camera);
  frame += 1;
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
}
requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });

// ---------- 视口自适应 ------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
