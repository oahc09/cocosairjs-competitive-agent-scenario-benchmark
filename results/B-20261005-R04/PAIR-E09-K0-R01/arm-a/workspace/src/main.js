// ============================================================================
// E09 珠宝展示台 — three.js r186(Arm A / K0 冷启动)
// ----------------------------------------------------------------------------
// 场景:暗色摄影棚中的多切面宝石。核心观感与实现路径:
//   高折射/反射/色散 —— MeshPhysicalMaterial(transmission + ior + dispersion,
//   three r167+ 的真折射管线:透射采样背后场景实时折射;dispersion 在折射路径上
//   按 halfSpread=(ior-1)*0.025*d 拆分 RGB,火彩随视角/转台实时流动,非烘焙贴图);
//   锐利切面高光 —— 程序化 PMREM 摄影棚 HDR 环境(发光柔光箱面板)+ flatShading 凸包切面;
//   三点棚拍 —— key/fill/rim 三盏有向光 + 微弱环境光(作用在展台/地面/金属件上);
//   地面轻反射 —— addons Reflector(暗色压低)+ 径向渐隐罩 + 接触阴影;
//   转台/色板/双击推近/PNG 导出 —— 见各节,状态契约 __bench 严格遵守 spec.json。
// 页面契约(harness 断言):
//   window.__appReady — 首帧渲染完成后置 true
//   window.__bench    — { getState(): {rotationAngle, selectedColor, cameraDistance,
//                        exportCount}, reset(): void }
// UI 控件同时携带 data-ui 与 data-bench 两组属性,兼容探针两种选择器口径。
// ============================================================================

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// --- 常量与状态 -------------------------------------------------------------
const SPEED_DEG_PER_S = 36;      // 转台角速度(spec 下限 25°/s,建议 30,取 36 留裕量)
const DIST_FAR = 10;             // 默认相机距离(spec 初始值)
const DIST_NEAR = 4.6;           // 双击推近目标(需 <= 6)
const DOLLY_MS = 850;            // 推近/拉回缓动时长(spec 要求 >= 600ms)
const GEM_CENTER = new THREE.Vector3(0, 1.88, 0); // 宝石中心(相机距离的参考点)

// 色板(spec 命名与顺序固定;swatch-{i} 自 1 起)
const GEM_COLORS = [
  { name: 'diamond',  swatch: '#E8EEF2', color: 0xe8eef2, attenuation: 0xeaf1f6, attDist: 3.2 },
  { name: 'ruby',     swatch: '#D6323F', color: 0xe05560, attenuation: 0xa81420, attDist: 0.45 },
  { name: 'emerald',  swatch: '#23A96E', color: 0x3fbf87, attenuation: 0x0b6e44, attDist: 0.45 },
  { name: 'sapphire', swatch: '#2E5FD8', color: 0x5477e0, attenuation: 0x17359e, attDist: 0.45 },
  { name: 'amber',    swatch: '#E8A33D', color: 0xeab055, attenuation: 0xb96f0e, attDist: 0.5 },
];

const state = {
  rotationAngle: 0,      // 度,单调增,不折返
  selectedColor: 'diamond',
  cameraDistance: DIST_FAR,
  exportCount: 0,
};

// 导出诊断(非契约字段,供自检读取 PNG 字节数;不影响 __bench 契约)
window.__benchExport = { lastBytes: 0, lastFilename: '' };

// --- 画布与渲染器 -------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // 保证 toBlob 能稳定读取当前画布像素(导出契约)
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;

const scene = new THREE.Scene();

// --- 相机机位(取景相机,双击推近 = 真实位置移动) ---------------------------
const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 200);
const camRig = {
  elevation: THREE.MathUtils.degToRad(15), // 俯角,产品棚拍机位(略俯视展台)
  dist: DIST_FAR,
  from: DIST_FAR,
  to: DIST_FAR,
  t0: 0,
  animating: false,
};
function applyCamera() {
  const el = camRig.elevation;
  camera.position.set(
    0,
    GEM_CENTER.y + Math.sin(el) * camRig.dist,
    Math.cos(el) * camRig.dist
  );
  camera.lookAt(GEM_CENTER);
  state.cameraDistance = Number(camera.position.distanceTo(GEM_CENTER).toFixed(3));
}
function dollyTo(target, ms = DOLLY_MS) {
  camRig.from = camRig.dist;
  camRig.to = target;
  camRig.t0 = performance.now();
  camRig.dur = ms;
  camRig.animating = true;
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
applyCamera();

// --- 程序化纹理小工具(canvas 生成,无外部资源,离线安全) --------------------
function makeCanvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function addGrain(ctx, size, amp) {
  // 细颗粒:消除渐变色带,也让 PNG 导出携带足够熵(>10KB 契约)
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (Math.random() - 0.5) * 2 * amp;
    d[i] += g; d[i + 1] += g; d[i + 2] += g;
  }
  ctx.putImageData(img, 0, 0);
}

// --- 背景幕:弧形球幕 + 垂直渐变 + 颗粒(暗色摄影棚) ------------------------
const backdropTex = makeCanvasTexture(512, (ctx, s) => {
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0.0, '#101114');   // 顶部暗
  g.addColorStop(0.30, '#4a505c');  // 上部亮带(主体冠部背后,分离主体)
  g.addColorStop(0.44, '#1a1c21');  // 向地平收暗
  g.addColorStop(0.58, '#08090b');  // 地平线以下近黑(消掉地面弧线)
  g.addColorStop(1.0, '#030304');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // 宝石正后方的"背光柔光箱":球面 u=0.75 对应 -Z(相机 +Z 的正对侧)。
  // 大面积柔光给主体分离;两条锐利光带提供高对比结构 —— 透过宝石观察时光带
  // 弯折/错位/局部倒置,折射观感一目了然(火彩也在光带边缘处绽放)
  const glow = ctx.createRadialGradient(s * 0.75, s * 0.45, 0, s * 0.75, s * 0.45, s * 0.30);
  glow.addColorStop(0, 'rgba(120,132,152,0.30)');
  glow.addColorStop(1, 'rgba(90,100,118,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, s, s);
  const box = ctx.createRadialGradient(s * 0.75, s * 0.46, 0, s * 0.75, s * 0.46, s * 0.11);
  box.addColorStop(0, 'rgba(206,216,230,0.85)');
  box.addColorStop(1, 'rgba(140,152,170,0)');
  ctx.fillStyle = box;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(228,234,244,0.92)';
  ctx.fillRect(s * 0.58, s * 0.435, s * 0.34, s * 0.010); // 光带 1(主)
  ctx.fillStyle = 'rgba(184,198,218,0.75)';
  ctx.fillRect(s * 0.62, s * 0.464, s * 0.26, s * 0.007); // 光带 2(副)
  addGrain(ctx, s, 3);
});
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(60, 32, 24),
  new THREE.MeshBasicMaterial({ map: backdropTex, side: THREE.BackSide, dithering: true })
);
backdrop.position.y = 2;
scene.add(backdrop);

// 主体光晕(柔光板反光观感,亦进入折射画面)
const haloTex = makeCanvasTexture(256, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(150,168,196,0.55)');
  g.addColorStop(0.4, 'rgba(110,126,152,0.22)');
  g.addColorStop(1, 'rgba(90,104,128,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});
const halo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: haloTex, transparent: true, opacity: 0.42, depthWrite: false,
}));
halo.position.set(0, 1.9, -7);
halo.scale.set(13, 9, 1);
halo.material.opacity = 0.38;
scene.add(halo);

// --- 摄影棚 HDR 环境(PMREM:黑房间 + 发光柔光箱) ---------------------------
// 环境贴图驱动宝石切面的锐利镜面高光;随转台转动,面片法线扫过不同柔光箱 → 高光流动。
function buildStudioEnvironment() {
  const env = new THREE.Scene();
  // 渐变穹顶(摄影棚环绕灰调):让多数切面反射出"亮晶体"底色,面板再给锐利爆点
  const domeTex = makeCanvasTexture(256, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s); // canvas 顶 = 穹顶顶
    g.addColorStop(0.0, '#5f646d');
    g.addColorStop(0.30, '#cdd4de');  // 上部亮环带(天光/柔光箱阵列)
    g.addColorStop(0.50, '#7d838d');  // 地平环绕亮灰
    g.addColorStop(0.62, '#232529');
    g.addColorStop(1.0, '#0b0c0e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  env.add(new THREE.Mesh(
    new THREE.SphereGeometry(24, 32, 24),
    new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide })
  ));
  const panel = (w, h, intensity, pos) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(intensity), side: THREE.DoubleSide })
    );
    m.position.copy(pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(10, 7, 26, new THREE.Vector3(-7, 8, 6));   // 主柔光箱(左上前,大面积)
  panel(12, 8, 7, new THREE.Vector3(9, 4, 7));     // 辅光(右,中等)
  panel(12, 2, 45, new THREE.Vector3(0, 8, -9));   // 轮廓光条(后上,勾边亮线)
  panel(10, 10, 6, new THREE.Vector3(0, 12, 0));   // 顶部补光
  panel(8, 4, 8, new THREE.Vector3(0, 2, 11));     // 前低位补光板:透过台面点亮冠部
  const floorBounce = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(0.8), side: THREE.DoubleSide })
  );
  floorBounce.rotation.x = -Math.PI / 2;
  floorBounce.position.y = -3;
  env.add(floorBounce);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02, 0.1, 60);
  pmrem.dispose();
  return rt.texture;
}
scene.environment = buildStudioEnvironment();

// --- 三点棚拍布光(作用于展台/地面/金属件;宝石高光主要由环境驱动) ---------
scene.add(new THREE.AmbientLight(0x3a4048, 0.55));
const keyLight = new THREE.DirectionalLight(0xfff2e2, 3.2);   // 主光:暖白,塑造主体
keyLight.position.set(4.5, 7, 4.5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.75); // 辅光:冷调低强度,降死黑
fillLight.position.set(-6, 2.5, 5);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 4.2);   // 轮廓光:后方高角度勾边
rimLight.position.set(-1.5, 5.5, -7);
scene.add(rimLight);

// --- 地面:镜面反射(压暗=轻反射)+ 径向渐隐罩 + 接触阴影 -------------------
const floorReflector = new Reflector(new THREE.CircleGeometry(16, 48), {
  clipBias: 0.003,
  textureWidth: 1024,
  textureHeight: 1024,
  color: 0x232529, // 暗色乘法 → "轻微"反射
});
floorReflector.rotation.x = -Math.PI / 2;
scene.add(floorReflector);

const floorFadeTex = makeCanvasTexture(512, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(8,8,10,0.35)');
  g.addColorStop(0.25, 'rgba(8,8,10,0.62)');
  g.addColorStop(0.55, 'rgba(8,8,10,0.92)');
  g.addColorStop(1.0, 'rgba(6,6,8,1.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});
const floorFade = new THREE.Mesh(
  new THREE.CircleGeometry(16.05, 48),
  new THREE.MeshBasicMaterial({ map: floorFadeTex, transparent: true, depthWrite: false })
);
floorFade.rotation.x = -Math.PI / 2;
floorFade.position.y = 0.02;
floorFade.renderOrder = 1;
scene.add(floorFade);

const contactShadowTex = makeCanvasTexture(256, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.38)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});
const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(5.2, 5.2),
  new THREE.MeshBasicMaterial({ map: contactShadowTex, transparent: true, depthWrite: false, opacity: 0.72 })
);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.position.y = 0.035;
contactShadow.renderOrder = 2;
scene.add(contactShadow);

// --- 展台 + 转台(低反射深色,衬托宝石主体) ---------------------------------
const pedestalMat = new THREE.MeshStandardMaterial({
  color: 0x17181c, roughness: 0.34, metalness: 0.6, envMapIntensity: 0.9,
});
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.80, 1.15, 0.80, 64), pedestalMat);
pedestal.position.y = 0.4;
scene.add(pedestal);

const rimMetalMat = new THREE.MeshStandardMaterial({
  color: 0xd9dde6, roughness: 0.14, metalness: 1.0, envMapIntensity: 1.2,
});
const pedestalRim = new THREE.Mesh(new THREE.TorusGeometry(0.80, 0.013, 12, 96), rimMetalMat);
pedestalRim.rotation.x = Math.PI / 2;
pedestalRim.position.y = 0.80;
scene.add(pedestalRim);

// 转台组:抛光转盘 + 金属定位珠(随宝石同步自转,相位可视化)+ 宝石
const turntable = new THREE.Group();
scene.add(turntable);

const turntableDisc = new THREE.Mesh(
  new THREE.CylinderGeometry(1.0, 1.0, 0.05, 64),
  new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.22, metalness: 0.75, envMapIntensity: 1.0 })
);
turntableDisc.position.y = 0.825;
turntable.add(turntableDisc);

const studGeo = new THREE.SphereGeometry(0.03, 12, 8);
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const stud = new THREE.Mesh(studGeo, rimMetalMat);
  stud.position.set(Math.cos(a) * 0.92, 0.865, Math.sin(a) * 0.92);
  turntable.add(stud);
}

// --- 宝石:程序化多切面(凸包 brilliant cut,94 个三角面 ≈ 60+ 视觉切面) ----
// 点集:台面8 + 冠部8 + 腰棱16 + 亭部16 + 底尖1 → 凸包 F = 2V-4 = 94 三角面
function buildGemGeometry() {
  const pts = [];
  const TAU = Math.PI * 2;
  for (let i = 0; i < 8; i++) {  // 台面环
    const a = (i / 8) * TAU + Math.PI / 8;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.42, 0.60, Math.sin(a) * 0.42));
  }
  for (let i = 0; i < 8; i++) {  // 冠部环(错半步 → 冠部 kite/bezel 切面)
    const a = (i / 8) * TAU;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.80, 0.34, Math.sin(a) * 0.80));
  }
  for (let i = 0; i < 16; i++) { // 腰棱环
    const a = (i / 16) * TAU + Math.PI / 16;
    pts.push(new THREE.Vector3(Math.cos(a) * 1.0, 0.0, Math.sin(a) * 1.0));
  }
  for (let i = 0; i < 16; i++) { // 亭部上环(错半步)
    const a = (i / 16) * TAU;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.70, -0.38, Math.sin(a) * 0.70));
  }
  pts.push(new THREE.Vector3(0, -0.92, 0)); // 底尖(culet)
  const geo = new ConvexGeometry(pts);
  geo.computeVertexNormals(); // 凸包为非共享顶点 → 法线逐面平坦,切面锐利
  return geo;
}
const gemGeometry = buildGemGeometry();

const gemMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xe8eef2,
  metalness: 0.0,
  roughness: 0.02,           // 镜面级 → 切面锐利高光
  transmission: 1.0,         // 真折射:实时采样背后场景
  thickness: 1.3,
  ior: 1.70,                 // 表观折射率 >= 1.5(晶体感)
  dispersion: 2.4,           // 火彩:折射路径 RGB 拆分,随视角/转台流动(非烘焙)
  attenuationColor: 0xeaf1f6,
  attenuationDistance: 3.2,
  clearcoat: 0.5,
  clearcoatRoughness: 0.03,
  envMapIntensity: 2.1,
  specularIntensity: 1.0,
  flatShading: true,
  dithering: true,
});
const gem = new THREE.Mesh(gemGeometry, gemMaterial);
const GEM_SCALE = 1.05;
gem.scale.setScalar(GEM_SCALE);
gem.position.y = 1.88; // 底尖坐于转盘中心垫上
turntable.add(gem);

// 底尖托垫(小暗垫,视觉承托)+ 焦散光斑(光穿过宝石投在转盘上的亮斑)
const cushion = new THREE.Mesh(
  new THREE.CylinderGeometry(0.15, 0.19, 0.06, 24),
  new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.4, metalness: 0.5 })
);
cushion.position.y = 0.88;
turntable.add(cushion);

const causticTex = makeCanvasTexture(128, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,250,238,0.9)');
  g.addColorStop(0.35, 'rgba(230,238,252,0.35)');
  g.addColorStop(0.7, 'rgba(210,225,250,0.10)');
  g.addColorStop(1, 'rgba(200,220,250,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});
const caustic = new THREE.Mesh(
  new THREE.PlaneGeometry(1.15, 1.15),
  new THREE.MeshBasicMaterial({
    map: causticTex, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
caustic.rotation.x = -Math.PI / 2;
caustic.position.y = 0.905;
turntable.add(caustic);

console.log(`[e09] gem facets(triangles)= ${gemGeometry.attributes.position.count / 3}`);

// --- 色板切换 ------------------------------------------------------------------
function applyGemColor(name) {
  const cfg = GEM_COLORS.find((c) => c.name === name) || GEM_COLORS[0];
  gemMaterial.color.setHex(cfg.color);
  gemMaterial.attenuationColor.setHex(cfg.attenuation);
  gemMaterial.attenuationDistance = cfg.attDist;
  state.selectedColor = cfg.name;
  updateSwatchUI();
}

// --- UI(同时带 data-ui 与 data-bench;精致克制,不抢主体) -------------------
const style = document.createElement('style');
style.textContent = `
  * { user-select: none; -webkit-user-select: none; }
  #bench-hud { position: fixed; inset: 0; z-index: 10; pointer-events: none;
    font-family: 'Segoe UI', system-ui, sans-serif; color: rgba(255,255,255,.82); }
  #bench-title { position: absolute; top: 14px; left: 18px; font-size: 12px;
    letter-spacing: .35em; color: rgba(255,255,255,.5); text-transform: uppercase; }
  #bench-actions { position: absolute; top: 12px; right: 14px; display: flex; gap: 8px; pointer-events: auto; }
  .bench-btn { padding: 7px 14px; font-size: 12px; letter-spacing: .08em; color: rgba(255,255,255,.88);
    background: rgba(16,17,20,.62); border: 1px solid rgba(255,255,255,.26); border-radius: 999px;
    cursor: pointer; backdrop-filter: blur(6px); transition: border-color .15s, background .15s; }
  .bench-btn:hover { border-color: rgba(255,255,255,.6); background: rgba(30,32,38,.72); }
  #bench-swatches { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 14px; padding: 10px 18px; pointer-events: auto;
    background: rgba(12,13,16,.55); border: 1px solid rgba(255,255,255,.16);
    border-radius: 999px; backdrop-filter: blur(8px); }
  .bench-swatch { width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
    border: 1px solid rgba(255,255,255,.35); outline: 2px solid transparent; outline-offset: 3px;
    transition: transform .15s, outline-color .15s; padding: 0; }
  .bench-swatch:hover { transform: scale(1.12); }
  .bench-swatch.active { outline-color: rgba(255,255,255,.9); transform: scale(1.22); }
  #bench-colorname { font-size: 11px; letter-spacing: .3em; text-transform: uppercase;
    color: rgba(255,255,255,.55); margin-left: 4px; min-width: 72px; }
`;
document.head.appendChild(style);

const hud = document.createElement('div');
hud.id = 'bench-hud';
hud.innerHTML = `
  <div id="bench-title">Lumiere — Atelier</div>
  <div id="bench-actions">
    <button class="bench-btn" data-ui="export-png" data-bench="export-png">导出 PNG</button>
    <button class="bench-btn" data-ui="reset" data-bench="reset">重置</button>
  </div>
  <div id="bench-swatches"></div>
`;
document.body.appendChild(hud);

const swatchBar = hud.querySelector('#bench-swatches');
const swatchButtons = GEM_COLORS.map((cfg, i) => {
  const b = document.createElement('button');
  b.className = 'bench-swatch';
  b.style.background = cfg.swatch;
  b.title = cfg.name;
  b.setAttribute('data-ui', `swatch-${i + 1}`);
  b.setAttribute('data-bench', `swatch-${i + 1}`);
  b.setAttribute('aria-label', `色板 ${i + 1}: ${cfg.name}`);
  b.addEventListener('click', () => applyGemColor(cfg.name));
  swatchBar.appendChild(b);
  return b;
});
const colorName = document.createElement('span');
colorName.id = 'bench-colorname';
swatchBar.appendChild(colorName);

function updateSwatchUI() {
  const idx = GEM_COLORS.findIndex((c) => c.name === state.selectedColor);
  swatchButtons.forEach((b, i) => b.classList.toggle('active', i === idx));
  colorName.textContent = GEM_COLORS[idx >= 0 ? idx : 0].name;
}
updateSwatchUI();

// --- 交互:双击推近/拉回(真实相机移动,禁视口缩放) --------------------------
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  // 目标翻转:当前(或目标)在远位 → 推近;否则拉回
  const reference = camRig.animating ? camRig.to : camRig.dist;
  dollyTo(reference > 7.5 ? DIST_NEAR : DIST_FAR);
});

// --- 交互:PNG 导出(真实浏览器下载,画布像素) --------------------------------
let exportSeq = 0;
function exportPNG() {
  renderer.render(scene, camera); // 确保读取的是当前帧像素(同步重绘,<200ms)
  canvas.toBlob((blob) => {
    if (!blob) return;
    exportSeq += 1;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gem-${state.selectedColor}-${Date.now()}-${exportSeq}.png`; // 带时间戳/序号,避免同名冲突
    document.body.appendChild(a);
    a.click(); // 触发真实浏览器 download 事件
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    state.exportCount += 1; // 仅在真实触发下载后递增
    window.__benchExport.lastBytes = blob.size;
    window.__benchExport.lastFilename = a.download;
  }, 'image/png');
}
hud.querySelector('[data-ui="export-png"]').addEventListener('click', exportPNG);

// --- reset(禁止整页刷新;转台相位保持连续单调) ------------------------------
function resetBench() {
  applyGemColor('diamond');
  state.exportCount = 0;
  exportSeq = 0;
  dollyTo(DIST_FAR, 700);
}
hud.querySelector('[data-ui="reset"]').addEventListener('click', resetBench);

// --- __bench 契约 ---------------------------------------------------------------
window.__bench = {
  getState: () => ({
    rotationAngle: Number(state.rotationAngle.toFixed(3)),
    selectedColor: state.selectedColor,
    cameraDistance: state.cameraDistance,
    exportCount: state.exportCount,
  }),
  reset: resetBench,
};

// --- 主循环 ---------------------------------------------------------------------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1); // 钳制切页大步长,保持单调累计
  state.rotationAngle += SPEED_DEG_PER_S * dt;
  turntable.rotation.y = THREE.MathUtils.degToRad(state.rotationAngle);

  if (camRig.animating) {
    const t = Math.min((performance.now() - camRig.t0) / camRig.dur, 1);
    camRig.dist = THREE.MathUtils.lerp(camRig.from, camRig.to, easeInOutCubic(t));
    if (t >= 1) camRig.animating = false;
    applyCamera();
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
