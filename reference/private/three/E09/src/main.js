// ============================================================================
// E09 珠宝展示台 (Jewelry Display Stand) — Three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// Material Ceiling 场景:暗色摄影棚 + 多切面宝石(transmission 折射 / ior /
// dispersion 色散 / 程序化 PMREM 环境贴图 / 内部金属切面核心)+ 三点棚拍
// 布光 + 转台自转 + 5 色色板 + 双击推近相机过渡 + 真实 PNG 下载导出。
//
// 页面契约(harness 断言,MASTER-CONTEXT §12.1):
//   window.__appReady : 首帧渲染完成后置 true(10s 内)
//   window.__bench    : { getState(), reset() }
//
// getState() 字段(E09 spec.stateContract,字段名冻结):
//   rotationAngle  number  转台累计角度(度),单调增,自转 32°/s(≥25)
//   selectedColor  string  diamond|ruby|emerald|sapphire|amber,初始 diamond
//   cameraDistance number  相机到宝石中心的真实距离,初始 10;双击推近 ≤6,再拉回 ≥9
//   exportCount    integer 真实触发 PNG 浏览器下载的次数
//   resetCount     integer reset() 调用次数
//
// r186 注意:
//   * Clock 自 r183 弃用 -> 本实现用 performance.now() 计时,零弃用告警
//   * PCFSoftShadowMap 自 r186 弃用 -> 用 PCFShadowMap
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- 常量与色板
const ROT_SPEED_DEG = 32;      // 转台角速度(度/s),spec 要求 ≥25
const DIST_FAR = 10;           // 默认/拉回相机距离(spec 初始值)
const DIST_NEAR = 5.2;         // 双击推近后的距离(spec 断言 ≤6)
const ZOOM_MS = 950;           // 双击过渡时长(spec 要求 ≥600ms 缓动)
const GEM_WIDTH = 1.9;         // 归一化后宝石横向尺寸

// 色板(spec §3.5 建议命名与色值;顺序即 swatch-1..5,swatch-2 必须是 ruby)
// hex = 材质着色(透射体取偏亮,保证通光量);chip = UI 色样(spec 建议色值);
// deep = 体吸收色(attenuationColor),取中深色给宝石有色深度而不压黑透射
const PALETTE = [
  { name: 'diamond',  hex: '#F2F7FB', chip: '#E8EEF2', deep: '#b6c8d6', att: 8.0 },
  { name: 'ruby',     hex: '#F0505B', chip: '#D6323F', deep: '#931722', att: 2.8 },
  { name: 'emerald',  hex: '#33C084', chip: '#23A96E', deep: '#0d7a4e', att: 2.8 },
  { name: 'sapphire', hex: '#4A76EC', chip: '#2E5FD8', deep: '#20399c', att: 2.8 },
  { name: 'amber',    hex: '#F2B14D', chip: '#E8A33D', deep: '#a2661a', att: 3.2 },
];
const DEFAULT_COLOR = 'diamond';

// ---------------------------------------------------------------- 渲染器
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 广告级宽容度
renderer.toneMappingExposure = 1.22;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap 已弃用

// ---------------------------------------------------------------- 场景与相机
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  38, window.innerWidth / window.innerHeight, 0.1, 200
);
// 初始取景:方位角 -0.32rad(略偏左前)、仰角 ~9°,距离 10(spec 初始 cameraDistance)
const FOCUS = new THREE.Vector3(0, 1.62, 0); // 宝石中心附近的取景焦点
{
  const az = -0.32, el = 0.16;
  camera.position.set(
    FOCUS.x + DIST_FAR * Math.cos(el) * Math.sin(az),
    FOCUS.y + DIST_FAR * Math.sin(el),
    FOCUS.z + DIST_FAR * Math.cos(el) * Math.cos(az)
  );
  camera.lookAt(FOCUS);
}

// ---------------------------------------------------------------- 后处理:微 Bloom
// 阈值取 1.0(线性 HDR 域):只有超过白点的超亮源(切面针尖闪点、金边镜面)
// 溢光,普通画面不糊。OutputPass 统一完成色调映射 + sRGB 输出。
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.35,  // strength:克制的广告级光晕
  0.4,   // radius
  1.0    // threshold(HDR > 1 才溢光)
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- 程序化环境
// 自制环境贴图(Brief §5 允许):equirect CanvasTexture 画出"三点柔光箱摄影棚",
// 经 PMREMGenerator 生成环境光照;另画一张更暗的版本作为 scene.background,
// 使透过宝石能看到背景亮斑的折射变形(晶体感),火彩来自 dispersion。
function paintStudio(w, h, intensity) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  // 基础竖直渐变:深灰顶 -> 近黑地
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#23262d');
  grad.addColorStop(0.52, '#0c0d11');
  grad.addColorStop(1.0, '#040405');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  const blob = (x, y, rx, ry, color, alpha) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    rg.addColorStop(0, color.replace('ALPHA', String(alpha * intensity)));
    rg.addColorStop(0.55, color.replace('ALPHA', String(alpha * 0.45 * intensity)));
    rg.addColorStop(1, color.replace('ALPHA', '0'));
    g.save();
    g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y);
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, rx, 0, Math.PI * 2); g.fill();
    g.restore();
  };

  // 柔光箱 = 硬边亮矩形 + 少量溢光。硬边是关键:低粗糙度切面要么完整反射
  // 亮箱、要么反射暗房,形成锐利的黑白切面对比(珠宝闪感的来源)。
  const softbox = (x, y, bw, bh, color, alpha, glow) => {
    g.save();
    g.globalAlpha = Math.min(1, alpha * intensity);
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = glow;
    g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
    g.shadowBlur = glow * 0.5;
    g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
    g.restore();
  };

  // 主光(键光)柔光箱:左上暖白大箱
  softbox(w * 0.20, h * 0.24, w * 0.085, w * 0.13, '#fff2dc', 1.0, 34);
  // 辅光(填充)柔光箱:右侧冷色弱箱
  softbox(w * 0.78, h * 0.42, w * 0.065, w * 0.10, '#bcd2ff', 0.55, 26);
  // 轮廓光(逆光)横条:正后上方
  softbox(w * 0.50, h * 0.13, w * 0.34, w * 0.016, '#f8fbff', 1.0, 22);
  // 轮廓光(逆光)竖条:右后侧
  softbox(w * 0.62, h * 0.30, w * 0.012, w * 0.20, '#eef4ff', 0.9, 16);
  // 顶部天光条缝
  softbox(w * 0.35, h * 0.045, w * 0.26, w * 0.012, '#e8eef6', 0.85, 14);
  // 点状硬光灯(小亮点 → 切面镜面闪点 / 色散棱边的高对比源)
  softbox(w * 0.10, h * 0.36, w * 0.010, w * 0.010, '#ffffff', 1.0, 6);
  softbox(w * 0.32, h * 0.18, w * 0.008, w * 0.008, '#fffaf0', 1.0, 6);
  softbox(w * 0.68, h * 0.22, w * 0.010, w * 0.010, '#f8faff', 1.0, 6);
  softbox(w * 0.88, h * 0.28, w * 0.008, w * 0.008, '#fff4e0', 0.95, 6);
  softbox(w * 0.42, h * 0.40, w * 0.007, w * 0.007, '#ffffff', 0.9, 6);
  softbox(w * 0.16, h * 0.12, w * 0.008, w * 0.008, '#ffffff', 0.95, 6);
  softbox(w * 0.72, h * 0.10, w * 0.008, w * 0.008, '#fdf6e8', 0.9, 6);
  softbox(w * 0.93, h * 0.48, w * 0.008, w * 0.008, '#ffffff', 0.9, 6);
  softbox(w * 0.05, h * 0.52, w * 0.008, w * 0.008, '#eef4ff', 0.85, 6);
  // 地面反弹:底部暗暖反光(柔)
  blob(w * 0.5, h * 0.94, w * 0.5, w * 0.10, 'rgba(72,58,42,ALPHA)', 0.4);

  return c;
}

// ---------------------------------------------------------------- 程序化环境(HDR)
// 自制环境贴图(Brief §5 允许),两条链:
//   A) scene.environment —— 用「真实小场景」+ PMREMGenerator.fromScene 生成
//      HDR 环境:暗房内若干发光柔光箱平面,颜色分量 >1(可达 25)。HDR 是
//      珠宝闪感的关键:低粗糙度切面要么反射超亮小灯(ACES 滚降成白针尖),
//      要么反射暗房 → 黑白切面对比 + 色散棱边。
//   B) scene.background —— 暗化 LDR equirect 画布,保持摄影棚氛围不抢主体。
function buildStudioEnvScene() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(
    new THREE.SphereGeometry(24, 32, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.055, 0.06, 0.07), side: THREE.BackSide })
  ));
  const box = (bw, bh, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  // 主光(键光)柔光箱:左前上,暖白
  box(5, 7, new THREE.Color(5.2, 4.5, 3.5), -9, 7, 8);
  // 辅光(填充)柔光箱:右前,冷
  box(4, 5, new THREE.Color(1.0, 1.35, 2.0), 10, 4, 6);
  // 轮廓光长横条:正后上方(勾边主源)
  box(14, 1.1, new THREE.Color(9, 9.5, 10.2), 0, 9, -12);
  // 轮廓光竖条:右后
  box(0.9, 8, new THREE.Color(5, 5.5, 6.4), 7, 5, -9);
  // 顶部天光条缝
  box(10, 1.0, new THREE.Color(4, 4.2, 4.6), -3, 11, 2);
  // 点状硬光灯若干(HDR 25 → 切面针尖闪点 / 火彩的高对比源)
  const glints = [
    [-8, 3, 3], [6, 8, 4], [-4, 9, -5], [9, 2, -3],
    [-2, 5, 9], [3, 10, 4], [-10, 6, -2], [8, 7, 6],
  ];
  for (const [x, y, z] of glints) box(0.32, 0.32, new THREE.Color(25, 25, 25), x, y, z);
  // 地面反弹:底部暗暖
  box(16, 16, new THREE.Color(0.34, 0.26, 0.16), 0, -9, 0);
  return env;
}

function canvasToEquirect(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const bgTex = canvasToEquirect(paintStudio(1024, 512, 0.16));    // 背景(暗,不抢主体)
scene.background = bgTex;
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(buildStudioEnvScene(), 0.05).texture;
  pmrem.dispose();
}

// 实体背景光墙:宝石正后方一块大的柔和发光幕(摄影棚背景幕的中央亮区)。
// 这是透射宝石真正「看」到的东西 —— 折射变形/倒置感的可见内容物,
// 也是切面棱线色散(火彩)所需的高对比光源。
{
  const bc = document.createElement('canvas');
  bc.width = 512; bc.height = 256;
  const bg2 = bc.getContext('2d');
  bg2.fillStyle = '#050608';
  bg2.fillRect(0, 0, 512, 256);
  const rg = bg2.createRadialGradient(256, 104, 6, 256, 104, 200);
  rg.addColorStop(0.0, 'rgba(188,194,208,0.95)');
  rg.addColorStop(0.3, 'rgba(96,102,116,0.5)');
  rg.addColorStop(0.65, 'rgba(30,33,40,0.16)');
  rg.addColorStop(1.0, 'rgba(5,6,8,0)');
  bg2.fillStyle = rg;
  bg2.fillRect(0, 0, 512, 256);
  const btex = new THREE.CanvasTexture(bc);
  btex.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 23),
    new THREE.MeshBasicMaterial({ map: btex, depthWrite: false })
  );
  backdrop.position.set(0, 8.5, -15);
  scene.add(backdrop);
}

// ---------------------------------------------------------------- 三点棚拍布光
// 主光(键光):暖白聚光,左前上,投影
const keyLight = new THREE.SpotLight(0xfff0dc, 520, 0, 0.52, 0.6, 2);
keyLight.position.set(-5.5, 8.5, 6.0);
keyLight.target.position.copy(FOCUS);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 2;
keyLight.shadow.camera.far = 30;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.radius = 5;
scene.add(keyLight, keyLight.target);

// 辅光(填充):冷色弱平行光,右前,降低死黑
const fillLight = new THREE.DirectionalLight(0xbcd2ff, 0.7);
fillLight.position.set(6.5, 3.2, 4.5);
scene.add(fillLight);

// 轮廓光(逆光)双灯:后上方窄角冷白,勾出宝石两侧边缘亮线
const rimLight = new THREE.SpotLight(0xeef4ff, 1500, 0, 0.36, 0.45, 2);
rimLight.position.set(2.6, 6.4, -7.5);
rimLight.target.position.copy(FOCUS);
scene.add(rimLight, rimLight.target);

const rimLight2 = new THREE.SpotLight(0xdde8ff, 1000, 0, 0.4, 0.5, 2);
rimLight2.position.set(-6.5, 5.2, -6.0);
rimLight2.target.position.copy(FOCUS);
scene.add(rimLight2, rimLight2.target);

// ---------------------------------------------------------------- 地面与展台
// 暗色微反射地面(环境贴图反射 + 接收阴影)
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(40, 72),
  new THREE.MeshStandardMaterial({
    color: 0x111318, roughness: 0.34, metalness: 0.5, envMapIntensity: 0.5,
  })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// 接触阴影贴片(径向渐变,柔和接地)
{
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const rg = sg.createRadialGradient(128, 128, 8, 128, 128, 124);
  rg.addColorStop(0, 'rgba(0,0,0,0.62)');
  rg.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = rg;
  sg.fillRect(0, 0, 256, 256);
  const st = new THREE.CanvasTexture(sc);
  st.colorSpace = THREE.SRGBColorSpace;
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 4.6),
    new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  scene.add(blob);
}

// 展台底座:低反射深色圆台 + 香槟金细亮边
const pedestal = new THREE.Group();
{
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.42, 1.72, 0.52, 72),
    new THREE.MeshStandardMaterial({
      color: 0x15171c, roughness: 0.38, metalness: 0.65, envMapIntensity: 0.55,
    })
  );
  base.position.y = 0.26;
  base.receiveShadow = true;
  base.castShadow = true;
  pedestal.add(base);

  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(1.43, 0.028, 20, 96),
    new THREE.MeshStandardMaterial({
      color: 0xc9a86a, roughness: 0.24, metalness: 1.0, envMapIntensity: 1.1,
    })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.52;
  pedestal.add(trim);
}
scene.add(pedestal);

// 转台:随宝石一起旋转的深色圆盘 + 金点刻度(让"转台在转"肉眼可辨)
const turntable = new THREE.Group();
turntable.position.y = 0.52;
{
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.12, 1.18, 0.13, 72),
    new THREE.MeshStandardMaterial({
      color: 0x1a1d23, roughness: 0.3, metalness: 0.7, envMapIntensity: 0.6,
    })
  );
  disc.position.y = 0.065;
  disc.receiveShadow = true;
  turntable.add(disc);

  const dotGeo = new THREE.SphereGeometry(0.026, 12, 8);
  const dotMat = new THREE.MeshStandardMaterial({
    color: 0xd8b878, roughness: 0.3, metalness: 1.0, envMapIntensity: 1.2,
  });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.set(Math.cos(a) * 1.0, 0.135, Math.sin(a) * 0.86);
    turntable.add(dot);
  }
}
scene.add(turntable);

// 色彩溢光(假焦散):宝石正下方随主色变化的柔和光池,广告感 + 色板反馈
const causticMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTE[0].hex),
  transparent: true,
  opacity: 0.4,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
{
  const cc = document.createElement('canvas');
  cc.width = cc.height = 256;
  const cg = cc.getContext('2d');
  const rg = cg.createRadialGradient(128, 128, 4, 128, 128, 126);
  rg.addColorStop(0.0, 'rgba(255,255,255,0.9)');
  rg.addColorStop(0.35, 'rgba(255,255,255,0.38)');
  rg.addColorStop(1.0, 'rgba(255,255,255,0)');
  cg.fillStyle = rg;
  cg.fillRect(0, 0, 256, 256);
  const ct = new THREE.CanvasTexture(cc);
  ct.colorSpace = THREE.SRGBColorSpace;
  causticMat.map = ct;
  const caustic = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.7), causticMat);
  caustic.rotation.x = -Math.PI / 2;
  caustic.position.y = 0.685;
  scene.add(caustic);
}

// ---------------------------------------------------------------- 宝石
// 材质上限链:MeshPhysicalMaterial transmission(实时折射画布回采)
// + ior 2.2(表观折射率 ≥1.5)+ dispersion(切面棱线色散火彩)
// + PMREM envMap(柔光箱反射)+ flatShading(锐利切面法线)
// + 内部同形金属核心(透过折射外壳可见的内部切面光影)。
const gemGroup = new THREE.Group();      // 归一化后的宝石(底部落在 y=0)
gemGroup.position.y = 0.145;             // 落在转台盘面之上(0.52+0.13+微浮空)
turntable.add(gemGroup);

const gemMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(PALETTE[0].hex),
  metalness: 0,
  roughness: 0.02,
  transmission: 1.0,          // 全透射,实时折射
  thickness: 1.15,            // 折射厚度(世界单位)
  ior: 2.2,                   // 类钻石折射率
  dispersion: 0.62,           // 色散火彩(依赖 transmission;在折射亮边处出彩虹条纹)
  attenuationColor: new THREE.Color(PALETTE[0].deep),
  attenuationDistance: PALETTE[0].att, // 体吸收:有色深度但保持通量可见
  specularIntensity: 1.0,
  envMapIntensity: 1.15,      // HDR 环境已含超亮源,勿再放大
  clearcoat: 0.5,             // 表皮额外锐利高光
  clearcoatRoughness: 0.05,
  flatShading: true,          // 切面感:每面一个法线
  side: THREE.FrontSide,
});

const coreMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(PALETTE[0].hex),
  metalness: 1.0,
  roughness: 0.05,
  envMapIntensity: 1.5,       // 内核:透过折射壳看见的内部切面闪光
  flatShading: true,
});

function buildGem(geometry) {
  // 归一化:横向尺寸缩放到 GEM_WIDTH,水平居中,底面落在 y=0
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const sizeX = bb.max.x - bb.min.x;
  const sizeZ = bb.max.z - bb.min.z;
  const s = GEM_WIDTH / Math.max(sizeX, sizeZ);
  geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geometry.scale(s, s, s);

  const outer = new THREE.Mesh(geometry, gemMat);
  outer.castShadow = true;
  gemGroup.add(outer);

  // 内部金属切面核心(缩至 42%,沉到宝石中部):折射外壳内可见的内部棱面反光
  const core = new THREE.Mesh(geometry.clone().scale(0.42, 0.42, 0.42), coreMat);
  geometry.computeBoundingBox();
  const cy = (geometry.boundingBox.max.y + geometry.boundingBox.min.y) / 2;
  core.position.y = cy * 0.9;
  gemGroup.add(core);
}

// 加载共享资产 assets/gem.glb(78 三角切面);失败则回退程序化 80 切面几何
let gemReady = false;
function loadGem() {
  const fallback = () => buildGem(new THREE.IcosahedronGeometry(1, 1)); // 80 面
  new GLTFLoader().load(
    'assets/gem.glb',
    (gltf) => {
      let mesh = null;
      gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (mesh) buildGem(mesh.geometry.clone());
      else fallback();
      gemReady = true;
    },
    undefined,
    () => { fallback(); gemReady = true; }
  );
}
loadGem();

// ---------------------------------------------------------------- 尘埃微光
// 摄影棚空气浮尘(加点广告级空气感,极低成本)
const dustGroup = new THREE.Group();
{
  const N = 52;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.4 + Math.random() * 2.6;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.6 + Math.random() * 3.4;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xd9caa6, size: 0.035, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  dustGroup.add(new THREE.Points(geo, mat));
  scene.add(dustGroup);
}

// ---------------------------------------------------------------- 相机控制
// 拖拽环绕(观感加分项;探针不使用)。双击推近期间暂停 controls,避免打架。
const controls = new OrbitControls(camera, canvas);
controls.target.copy(FOCUS);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 3.2;
controls.maxDistance = 16;
controls.rotateSpeed = 0.55;
controls.update();

// 双击推近:取景相机沿当前视线方向的真实 dolly(位置移动,非视口缩放)
let zoomAnim = null; // { fromR, toR, dir, t0 }
canvas.addEventListener('dblclick', () => {
  if (zoomAnim) return; // 过渡中忽略,保证缓动完整
  const cur = camera.position.distanceTo(FOCUS);
  const targetR = cur > 8 ? DIST_NEAR : DIST_FAR; // 远→近 / 近→远
  const dir = camera.position.clone().sub(FOCUS).normalize();
  zoomAnim = { fromR: cur, toR: targetR, dir, t0: performance.now() };
  controls.enabled = false;
});

function animateCameraTo(radius) {
  const cur = camera.position.distanceTo(FOCUS);
  const dir = camera.position.clone().sub(FOCUS).normalize();
  zoomAnim = { fromR: cur, toR: radius, dir, t0: performance.now() };
  controls.enabled = false;
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------- bench 状态
let rotationAngle = 0;   // 转台累计角度(度,单调增;reset 可归零后继续)
let selectedColor = DEFAULT_COLOR;
let exportCount = 0;
let resetCount = 0;
let frame = 0;
let fpsAvg = 0;
const frameTimes = [];

function setSelected(name) {
  const entry = PALETTE.find((p) => p.name === name);
  if (!entry) return;
  selectedColor = entry.name;
  gemMat.color.set(entry.hex);            // 宝石色调立即变化
  gemMat.attenuationColor.set(entry.deep);
  gemMat.attenuationDistance = entry.att;
  coreMat.color.set(entry.hex);
  causticMat.color.set(entry.hex);        // 光池颜色同步
  document.querySelectorAll('#swatches .swatch').forEach((el) => {
    const active = el.dataset.name === entry.name;
    el.classList.toggle('active', active);
    el.setAttribute('aria-pressed', String(active));
  });
  const label = document.getElementById('swatch-name');
  if (label) label.textContent = entry.name;
}

function doReset() {
  resetCount += 1;
  setSelected(DEFAULT_COLOR);
  animateCameraTo(DIST_FAR);
  exportCount = 0;
  rotationAngle = 0;             // 转台相位归零后继续运转(spec §7 允许)
  turntable.rotation.y = 0;
  showToast('已重置 — diamond · 相机拉回 · 导出计数清零');
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    frame,
    fps: Math.round(fpsAvg * 10) / 10,
    rotationAngle: Math.round(rotationAngle * 100) / 100,
    selectedColor,
    cameraDistance: Math.round(camera.position.distanceTo(FOCUS) * 1000) / 1000,
    exportCount,
    resetCount,
  }),
  reset: doReset,
};

// ---------------------------------------------------------------- PNG 导出
// 真实读取当前画布像素:同帧重渲染后 canvas.toBlob -> <a download> 点击
// 触发浏览器真实下载事件(harness 以 download 事件 + 文件大小独立观测)。
// toBlob 异步回调,不冻结主循环。
function exportPng() {
  composer.render();                       // 保证导出的就是当前画面(同任务内缓冲有效)
  canvas.toBlob((blob) => {
    if (!blob) { showToast('导出失败:画布编码为空'); return; }
    exportCount += 1;                      // 仅在真实 blob 生成后计数
    const name = `gem-stage-${Date.now()}-${exportCount}.png`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`已导出 ${name}(${(blob.size / 1024).toFixed(0)} KB)`);
  }, 'image/png');
}

// ---------------------------------------------------------------- UI(HUD)
function showToast(text) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function buildUI() {
  // 色板:swatch-1..5(同时挂 data-bench 与 data-ui,供探针 click:ui= 定位)
  const row = document.getElementById('swatch-row');
  PALETTE.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', p.chip);
    b.dataset.name = p.name;
    b.title = p.name;
    b.setAttribute('data-bench', `swatch-${i + 1}`);
    b.setAttribute('data-ui', `swatch-${i + 1}`);
    b.setAttribute('aria-pressed', String(p.name === DEFAULT_COLOR));
    b.addEventListener('click', () => { setSelected(p.name); });
    row.appendChild(b);
  });

  document.getElementById('btn-export').addEventListener('click', exportPng);
  document.getElementById('btn-reset').addEventListener('click', doReset);
}
buildUI();
setSelected(DEFAULT_COLOR);

// ---------------------------------------------------------------- 主循环
// 用 performance.now 计时(r183 起 Clock 弃用);dt 钳制防后台切回跳变。
let lastT = performance.now();
let ready = false;

function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  frame += 1;

  // 转台自转:rotationAngle 单调累计(度),画面与状态同源
  rotationAngle += ROT_SPEED_DEG * dt;
  turntable.rotation.y = THREE.MathUtils.degToRad(rotationAngle);

  // 双击推近/拉回缓动:沿视线方向的真实相机位移
  if (zoomAnim) {
    const t = Math.min((now - zoomAnim.t0) / ZOOM_MS, 1);
    const r = zoomAnim.fromR + (zoomAnim.toR - zoomAnim.fromR) * easeInOutCubic(t);
    camera.position.copy(FOCUS).addScaledVector(zoomAnim.dir, r);
    camera.lookAt(FOCUS);
    if (t >= 1) {
      zoomAnim = null;
      controls.enabled = true;
      controls.update();
    }
  } else if (controls.enabled) {
    controls.update();
  }

  // 浮尘缓移 + 闪烁
  dustGroup.rotation.y += dt * 0.05;
  dustGroup.children[0].material.opacity = 0.3 + 0.16 * Math.sin(now * 0.0011);

  renderer.render(scene, camera);
  composer.render();

  // fps(最近 60 帧平均)
  frameTimes.push(dt);
  if (frameTimes.length > 60) frameTimes.shift();
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  fpsAvg = avg > 0 ? 1 / avg : 0;

  if (!ready && gemReady) {
    ready = true;
    window.__appReady = true; // 首帧完整渲染完成(宝石已就位)
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- 视口自适应
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
});
