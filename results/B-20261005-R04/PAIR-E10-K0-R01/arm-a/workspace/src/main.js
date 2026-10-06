// ============================================================================
// E10 — 动画角色展示空间 (Three.js r186)
// ----------------------------------------------------------------------------
// 场景要点(brief.md v1.0.1 / spec.json):
//   * runtime 以相对路径 "assets/character.glb" 加载(整会话仅一次网络请求);
//   * 双实例由同一次加载的数据 SkeletonUtils.clone 派生,各自独立 AnimationMixer,
//     动画状态完全隔离(A/B 互不影响);
//   * clip 映射:GLB 内 Survey→idle(原地待机)、Walk→walk(规范名暴露);
//   * 生命周期:创建 A/B → 独立动画 → 销毁 A(B 不受影响)→ reset 应用内重建;
//   * 页面契约:__appReady(实例就绪后置 true)/ __bench{getState,reset};
//   * UI 控件同时携带 data-ui 与 data-bench 属性(探针定位兼容两种词表)。
// 骨骼动画由 GLB 动画剪辑驱动蒙皮,无形态键/顶点补间(Forbidden Shortcuts 规避)。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// --- 渲染器 -------------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// --- 场景背景:柔和垂直渐变(CanvasTexture,零网络依赖) ------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x59616e, 7.5, 16);
{
  const bg = document.createElement('canvas');
  bg.width = 16;
  bg.height = 256;
  const g = bg.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#262c38');
  grad.addColorStop(0.55, '#4a5464');
  grad.addColorStop(1.0, '#8d97a6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const bgTex = new THREE.CanvasTexture(bg);
  bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
}

// --- 相机:中景平视,轻微俯视,双实例完整入画 -----------------------------------
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 4.8);
camera.lookAt(0, 0.95, 0);

// --- 灯光:三点布光(键光/补光/逆光)+ 半球环境光,共 4 盏 ≤ 6 -------------------
scene.add(new THREE.HemisphereLight(0xcfd8e8, 0x3a3f46, 0.55));

const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.6); // 键光:暖色,投射接触阴影
keyLight.position.set(2.5, 4.2, 3.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -2.6;
keyLight.shadow.camera.right = 2.6;
keyLight.shadow.camera.top = 3.2;
keyLight.shadow.camera.bottom = -0.6;
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 15;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.radius = 4;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.85); // 补光:冷色,柔化暗部
fillLight.position.set(-3.5, 2.0, 2.5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xdfe8ff, 1.5); // 逆光:勾勒轮廓
rimLight.position.set(0.5, 3.0, -3.5);
scene.add(rimLight);

// --- 展示空间:地面 + 展台圆盘 --------------------------------------------------
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(9, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x707681, roughness: 0.95, metalness: 0.0 })
);
ground.receiveShadow = true;
scene.add(ground);

const discGeom = new THREE.CircleGeometry(0.62, 48).rotateX(-Math.PI / 2);
const discMat = new THREE.MeshStandardMaterial({ color: 0x8a919d, roughness: 0.85, metalness: 0.0 });
for (const sx of [-1, 1]) {
  const disc = new THREE.Mesh(discGeom, discMat);
  disc.position.set(sx * 0.85, 0.004, 0);
  disc.receiveShadow = true;
  scene.add(disc);
}

// --- 角色资产:单次加载,双实例由缓存数据派生 ------------------------------------
const CHAR_HEIGHT = 1.8; // 归一化身高(建议 1.5–1.8)
const A_X = -0.85; // 实例 A 左站位
const B_X = 0.85; // 实例 B 右站位

let source = null; // 归一化母本(不直接入场景,仅作克隆源)
const clips = { idle: null, walk: null };
const instances = { A: null, B: null };
let assetLoaded = false;
let destroyedInstance = null;
let resetCount = 0;

// GLB 剪辑名 → 规范名映射(Survey=原地环顾待机 → idle;Walk → walk)
function mapClips(anims) {
  const byName = (re) => anims.find((c) => re.test(c.name));
  clips.idle = byName(/survey|idle|stand/i) || anims[0] || null;
  clips.walk = byName(/walk/i) || anims[1] || clips.idle;
}

// 创建实例:克隆母本 → 独立 mixer → 默认播放 Idle
function createInstance(x) {
  const root = SkeletonUtils.clone(source);
  root.position.x = x;
  root.rotation.y = 0; // glTF 资产约定 +Z 朝前,面向相机(+Z),截图核对后可调
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // 蒙皮网格包围盒易误剔除,关闭保稳
    }
  });
  const mixer = new THREE.AnimationMixer(root);
  const actions = {
    idle: mixer.clipAction(clips.idle),
    walk: mixer.clipAction(clips.walk),
  };
  actions.idle.play();
  scene.add(root);
  return { root, mixer, actions, current: 'idle', alive: true };
}

// 剪辑切换:同实例内 crossfade,绝不触碰另一实例的 mixer(状态隔离核心)
function setClip(inst, name) {
  if (!inst || !inst.alive || inst.current === name) return;
  const from = inst.actions[inst.current];
  const to = inst.actions[name];
  to.reset();
  to.setEffectiveTimeScale(1);
  to.setEffectiveWeight(1);
  to.play();
  from.fadeOut(0.18);
  to.fadeIn(0.18);
  inst.current = name;
}

// 归位到某剪辑初始状态(reset 用:时间归零、直接切换)
function resetClip(inst, name) {
  if (!inst || !inst.alive) return;
  inst.actions[inst.current].stop();
  inst.actions[name].reset().play();
  inst.current = name;
}

// 销毁实例 A:从场景图移除 + 释放 mixer 绑定(仅设不可见不算销毁)
function destroyA() {
  const inst = instances.A;
  if (!inst || !inst.alive) return;
  inst.mixer.stopAllAction();
  inst.mixer.uncacheRoot(inst.root);
  scene.remove(inst.root);
  inst.alive = false;
  instances.A = null;
  destroyedInstance = 'A';
  updateButtons();
}

// reset:应用内重建(资产数据已在内存,零网络请求、零页面刷新)
function doReset() {
  if (instances.A) {
    const inst = instances.A;
    inst.mixer.stopAllAction();
    inst.mixer.uncacheRoot(inst.root);
    scene.remove(inst.root);
  }
  if (!instances.B) {
    instances.B = createInstance(B_X); // 防御:B 理论上恒存活
  } else {
    resetClip(instances.B, 'idle'); // B 回到 Idle 初始状态
  }
  instances.A = createInstance(A_X); // 重建 A(克隆缓存母本)
  destroyedInstance = null;
  resetCount += 1;
  updateButtons();
}

// --- bench 状态契约 -------------------------------------------------------------
let frame = 0;
let fpsNow = 0;
const frameTimes = [];

window.__bench = {
  getState: () => {
    const st = (inst) => {
      if (!inst || !inst.alive) return null;
      const a = inst.actions[inst.current];
      return { clip: inst.current, time: Math.round(a.time * 1000) / 1000 };
    };
    return {
      engine: 'three',
      assetLoaded,
      instanceCount: (instances.A && instances.A.alive ? 1 : 0) + (instances.B && instances.B.alive ? 1 : 0),
      instances: { A: st(instances.A), B: st(instances.B) },
      destroyedInstance,
      resetCount,
      fps: fpsNow,
      frame,
    };
  },
  reset: doReset,
};

// --- UI 控件(画布底缘,同时带 data-ui 与 data-bench)---------------------------
const uiBar = document.createElement('div');
uiBar.id = 'bench-ui';
document.body.appendChild(uiBar);

{
  const style = document.createElement('style');
  style.textContent = [
    '#bench-ui{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;',
    '  padding:6px 10px;justify-content:center;z-index:9999;pointer-events:none;}',
    '#bench-ui button{pointer-events:auto;padding:3px 12px;font:12px/1.4 sans-serif;',
    '  background:#1f2630;color:#e8edf4;border:1px solid #59616e;border-radius:4px;',
    '  cursor:pointer;transition:background .12s,border-color .12s;}',
    '#bench-ui button:hover:not(:disabled){background:#31435c;border-color:#7f8ea3;}',
    '#bench-ui button:active:not(:disabled){background:#45608a;transform:translateY(1px);}',
    '#bench-ui button:disabled{opacity:.35;cursor:not-allowed;}',
  ].join('');
  document.head.appendChild(style);
}

function makeButton(label, ui, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.setAttribute('data-ui', ui);
  b.setAttribute('data-bench', ui);
  b.disabled = true; // 资产就绪前统一禁用
  b.addEventListener('click', onClick);
  uiBar.appendChild(b);
  return b;
}

const btnAIdle = makeButton('A · Idle', 'anim-a-idle', () => setClip(instances.A, 'idle'));
const btnAWalk = makeButton('A · Walk', 'anim-a-walk', () => setClip(instances.A, 'walk'));
const btnBIdle = makeButton('B · Idle', 'anim-b-idle', () => setClip(instances.B, 'idle'));
const btnBWalk = makeButton('B · Walk', 'anim-b-walk', () => setClip(instances.B, 'walk'));
const btnDestroyA = makeButton('Destroy A', 'destroy-a', destroyA);
const btnReset = makeButton('Reset', 'reset', doReset);

function updateButtons() {
  const ready = assetLoaded;
  const aAlive = !!(instances.A && instances.A.alive);
  for (const b of [btnAIdle, btnAWalk, btnDestroyA, btnReset]) b.disabled = !ready;
  btnBIdle.disabled = !ready;
  btnBWalk.disabled = !ready;
  btnDestroyA.disabled = !ready || !aAlive; // A 已销毁时置灰
}

// --- 资产加载(相对路径,整会话仅一次)------------------------------------------
new GLTFLoader().load(
  'assets/character.glb',
  (gltf) => {
    source = gltf.scene;

    // 归一化:身高 → CHAR_HEIGHT,脚底贴地 y=0,水平居中于自身原点
    let box = new THREE.Box3().setFromObject(source);
    const size = box.getSize(new THREE.Vector3());
    const scale = CHAR_HEIGHT / (size.y || 1);
    source.scale.setScalar(scale);
    box = new THREE.Box3().setFromObject(source);
    const center = box.getCenter(new THREE.Vector3());
    source.position.x = -center.x;
    source.position.z = -center.z;
    source.position.y = -box.min.y;
    source.updateMatrixWorld(true);

    mapClips(gltf.animations || []);
    if (!clips.idle || !clips.walk) {
      console.error('[E10] GLB 缺少可用动画剪辑');
      return;
    }

    instances.A = createInstance(A_X);
    instances.B = createInstance(B_X);
    assetLoaded = true;
    updateButtons();
    window.__appReady = true; // 实例就绪并开始播放 Idle,页面契约达成
  },
  undefined,
  (err) => {
    console.error('[E10] character.glb 加载失败:', err);
  }
);

// --- 主循环 ---------------------------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  frameTimes.push(dt);
  if (frameTimes.length > 60) frameTimes.shift();
  const sum = frameTimes.reduce((a, b) => a + b, 0);
  fpsNow = sum > 0 ? Math.round((frameTimes.length / sum) * 10) / 10 : 0;

  if (instances.A) instances.A.mixer.update(dt);
  if (instances.B) instances.B.mixer.update(dt);

  renderer.render(scene, camera);
  frame += 1;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
