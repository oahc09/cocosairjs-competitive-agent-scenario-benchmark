// ============================================================================
// E10 — 动画角色展示空间 (Animated Character Showcase) — Three.js r186
// ----------------------------------------------------------------------------
// 页面契约(harness 断言):
//   window.__appReady : GLB 加载 + 双实例建立 + 首帧渲染后置 true(10s 内)
//   window.__bench    : { getState(): object, reset(): void }
//
// getState() 字段(spec.json stateContract):
//   assetLoaded      boolean — GLB 加载完成且双实例就绪
//   instanceCount    integer — 存活实例数(0-2)
//   instances.A/B    { clip:"idle"|"walk", time:number } | null(销毁后)
//   destroyedInstance null | "A"
//   resetCount       integer — reset 执行次数
//   fps              number  — 最近 60 帧平均帧率
//
// 场景:runtime 以相对路径 assets/character.glb 单次网络加载(Khronos Fox,
// 蒙皮 24 关节 + Survey/Walk/Run 三剪辑;idle->Survey, walk->Walk),
// SkeletonUtils.clone 派生双实例,各自独立 AnimationMixer,动画状态完全隔离。
// UI(data-bench / data-ui):anim-a-idle|walk, anim-b-idle|walk, destroy-a, reset。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// --- 画布与渲染器 ------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();

// --- 展示空间:柔和渐变背景 + 地面 + 展台圆盘 ----------------------------------
// 渐变背景:2x512 画布竖向渐变作为 scene.background(全屏拉伸,无网络资源)
function makeGradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, top);
  grad.addColorStop(0.62, bottom);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const BG_TOP = '#cdd6e2';
const BG_BOTTOM = '#5a626c';
scene.background = makeGradientTexture(BG_TOP, BG_BOTTOM);
scene.fog = new THREE.Fog(new THREE.Color(BG_BOTTOM).getHex(), 10, 22);

// 地面:径向明暗渐变(中央地坪光斑),接收接触阴影
function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 40, 256, 256, 256);
  grad.addColorStop(0, '#9aa3ad');
  grad.addColorStop(0.55, '#78808a');
  grad.addColorStop(1, '#4c525b');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.92, metalness: 0.0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 展台圆盘(可选氛围元素)
const pedestalGeo = new THREE.CylinderGeometry(0.95, 1.02, 0.07, 48);
const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x7c8592, roughness: 0.55, metalness: 0.08 });
const PEDESTAL_H = 0.07;
const pedestalA = new THREE.Mesh(pedestalGeo, pedestalMat);
const pedestalB = new THREE.Mesh(pedestalGeo, pedestalMat);
pedestalA.receiveShadow = true;
pedestalB.receiveShadow = true;
scene.add(pedestalA, pedestalB);

// --- 灯光:三点布光(键光+补光+逆光)+ 半球环境光,共 4 盏(<= 6) ------------
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f46, 0.55));

const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.4); // 键光(暖白,投影)
keyLight.position.set(2.6, 3.6, 2.4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -3.5;
keyLight.shadow.camera.right = 3.5;
keyLight.shadow.camera.top = 3.5;
keyLight.shadow.camera.bottom = -3.5;
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 12;
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xbcd0ff, 0.7); // 补光(冷色,弱)
fillLight.position.set(-3.2, 2.0, 2.6);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xe8f0ff, 1.5); // 逆光(轮廓)
rimLight.position.set(-0.4, 2.6, -3.6);
scene.add(rimLight);

// --- 相机:中景平视,轻微俯角,双实例完整入画 -----------------------------------
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 1.35, 4.9);
camera.lookAt(0, 0.5, 0);

// --- 站位 --------------------------------------------------------------------
// 探针视觉区域(归一化):A 区中心 x≈0.25,B 区中心 x≈0.76 -> 世界坐标左右站位
const POS_A = -1.62;
const POS_B = 1.62;
pedestalA.position.set(POS_A, PEDESTAL_H / 2, 0);
pedestalB.position.set(POS_B, PEDESTAL_H / 2, 0);

// --- bench 状态 ----------------------------------------------------------------
const state = {
  assetLoaded: false,
  instanceCount: 0,
  instances: { A: null, B: null },
  destroyedInstance: null,
  resetCount: 0,
};
let frame = 0;
let fps = 0;
const frameTimes = []; // 最近 60 帧间隔(秒)

// --- 角色实例管理 ---------------------------------------------------------------
// 单次网络加载的资产数据缓存在此;双实例与 reset 重建均由缓存派生,绝无二次请求。
let gltfTemplate = null; // { scene, clips: { idle, walk } }
let instances = { A: null, B: null }; // 每项 { root, mixer, actions, current }

function pickClip(clips, canonical) {
  // Fox 命名:Survey(原地观察,映射 idle)/ Walk / Run;做稳健的规范名映射
  const patterns =
    canonical === 'idle'
      ? [/^idle$/i, /survey/i, /idle/i, /breath/i, /stand/i]
      : [/^walk$/i, /walk/i];
  for (const p of patterns) {
    const hit = clips.find((c) => p.test(c.name));
    if (hit) return hit;
  }
  return clips[0] || null;
}

function buildInstance(id) {
  const { scene: template, clips } = gltfTemplate;
  const root = new THREE.Group();
  const model = skeletonClone(template); // 深克隆骨架;几何/材质共享(销毁 A 不伤 B)
  // 归一化:按包围盒把角色高度缩放到 TARGET_HEIGHT,脚底落到组原点
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const TARGET_HEIGHT = 1.22; // 留边:实例完整落在各自探针视觉区域内且不贴边
  const s = size.y > 1e-6 ? TARGET_HEIGHT / size.y : 1;
  model.scale.setScalar(s);
  model.position.y = -box.min.y * s;
  model.position.x = -box.min.x * s - size.x * s * 0.5; // 水平居中到组原点
  model.position.z = -box.min.z * s - size.z * s * 0.5;
  model.rotation.y = id === 'A' ? THREE.MathUtils.degToRad(78) : THREE.MathUtils.degToRad(-78);
  root.add(model);

  root.position.set(id === 'A' ? POS_A : POS_B, PEDESTAL_H, 0);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // 蒙皮网格包围盒随骨骼变化,禁用视锥剔除防闪断
    }
  });
  scene.add(root);

  const mixer = new THREE.AnimationMixer(model); // 每实例独立 mixer -> 动画状态隔离
  const actions = {
    idle: clips.idle ? mixer.clipAction(clips.idle) : null,
    walk: clips.walk ? mixer.clipAction(clips.walk) : null,
  };
  const inst = { root, mixer, actions, current: 'idle' };
  actions.idle && actions.idle.play();
  return inst;
}

function disposeInstance(inst) {
  // 从场景图移除 + 停止动画 + 释放该实例的动画缓存;几何/材质为双实例共享,保留给幸存者
  scene.remove(inst.root);
  inst.mixer.stopAllAction();
  inst.mixer.uncacheRoot(inst.root);
}

function syncStateInstances() {
  for (const id of ['A', 'B']) {
    const inst = instances[id];
    if (!inst) {
      state.instances[id] = null;
      continue;
    }
    const action = inst.actions[inst.current];
    state.instances[id] = {
      clip: inst.current,
      time: action ? action.time : 0, // 当前剪辑播放秒数(循环剪辑回绕)
    };
  }
  state.instanceCount = (instances.A ? 1 : 0) + (instances.B ? 1 : 0);
}

function setClip(id, canonical) {
  const inst = instances[id];
  if (!inst || !(canonical === 'idle' || canonical === 'walk')) return;
  if (inst.current === canonical) return;
  const prev = inst.actions[inst.current];
  const next = inst.actions[canonical];
  if (!next) return;
  prev && prev.fadeOut(0.15); // 即时切换(<300ms),带短淡入淡出
  next.reset().fadeIn(0.15).play();
  inst.current = canonical; // 状态立即更新,与画面一致
  syncStateInstances();
  refreshButtonStates();
}

function destroyA() {
  if (!instances.A) return;
  disposeInstance(instances.A);
  instances.A = null;
  state.destroyedInstance = 'A';
  syncStateInstances();
  refreshButtonStates();
}

function doReset() {
  if (!gltfTemplate) return; // 资产未就绪时 reset 无意义(探针只会在就绪后调用)
  state.resetCount += 1;
  // 全量重建双实例:实例 A 重建,实例 B 回到 Idle 初始状态;
  // 全部由缓存的 gltfTemplate 派生,不发起任何新的资产网络请求,不刷新页面。
  if (instances.A) disposeInstance(instances.A);
  if (instances.B) disposeInstance(instances.B);
  instances.A = buildInstance('A');
  instances.B = buildInstance('B');
  state.destroyedInstance = null;
  syncStateInstances();
  refreshButtonStates();
}

// --- UI 控件组(画布底部边缘;data-bench 与 data-ui 双属性,带 hover/active)----
function makeButton(label, name, on) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.setAttribute('data-bench', name);
  btn.setAttribute('data-ui', name); // 模板探针选择器兼容
  btn.addEventListener('click', on);
  return btn;
}

const ui = {};
{
  const style = document.createElement('style');
  style.textContent = `
    .bench-ui {
      position: fixed; left: 50%; bottom: 6px; transform: translateX(-50%);
      display: flex; gap: 6px; align-items: center; z-index: 9999;
      padding: 6px 10px; border-radius: 10px;
      background: rgba(18, 22, 28, 0.72); border: 1px solid rgba(255,255,255,0.14);
      font: 13px/1.2 system-ui, sans-serif; color: #e8edf4;
      user-select: none;
    }
    .bench-ui button {
      padding: 6px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.22);
      background: #2a3340; color: #e8edf4; transition: background .12s, transform .06s;
    }
    .bench-ui button:hover { background: #3a4759; }
    .bench-ui button:active { transform: translateY(1px) scale(0.97); background: #46556b; }
    .bench-ui button.on { background: #4a7fc1; border-color: #6fa3e0; }
    .bench-ui button.disabled, .bench-ui button:disabled {
      background: #20262e; color: #6b7684; border-color: rgba(255,255,255,0.08);
      cursor: not-allowed; transform: none;
    }
    .bench-ui .sep { width: 1px; height: 20px; background: rgba(255,255,255,0.18); margin: 0 3px; }
    .bench-title {
      position: fixed; top: 10px; left: 14px; z-index: 9999;
      font: 14px/1.3 system-ui, sans-serif; color: rgba(232,237,244,0.92);
      text-shadow: 0 1px 2px rgba(0,0,0,0.5); user-select: none;
    }
  `;
  document.head.appendChild(style);

  const title = document.createElement('div');
  title.className = 'bench-title';
  title.textContent = 'E10 — Animated Character Showcase (three.js r186)';
  document.body.appendChild(title);

  const bar = document.createElement('div');
  bar.className = 'bench-ui';
  const mk = (label, name, on) => {
    const b = makeButton(label, name, on);
    ui[name] = b;
    bar.appendChild(b);
    return b;
  };
  mk('A · Idle', 'anim-a-idle', () => setClip('A', 'idle'));
  mk('A · Walk', 'anim-a-walk', () => setClip('A', 'walk'));
  const sep1 = document.createElement('div');
  sep1.className = 'sep';
  bar.appendChild(sep1);
  mk('B · Idle', 'anim-b-idle', () => setClip('B', 'idle'));
  mk('B · Walk', 'anim-b-walk', () => setClip('B', 'walk'));
  const sep2 = document.createElement('div');
  sep2.className = 'sep';
  bar.appendChild(sep2);
  mk('Destroy A', 'destroy-a', () => destroyA());
  mk('Reset', 'reset', () => doReset());
  document.body.appendChild(bar);
}

function refreshButtonStates() {
  const set = (name, on) => ui[name] && ui[name].classList.toggle('on', !!on);
  const aAlive = !!instances.A;
  const bAlive = !!instances.B;
  set('anim-a-idle', aAlive && instances.A.current === 'idle');
  set('anim-a-walk', aAlive && instances.A.current === 'walk');
  set('anim-b-idle', bAlive && instances.B.current === 'idle');
  set('anim-b-walk', bAlive && instances.B.current === 'walk');
  if (ui['destroy-a']) {
    ui['destroy-a'].classList.toggle('disabled', !aAlive);
    if (aAlive) ui['destroy-a'].removeAttribute('disabled');
    else ui['destroy-a'].setAttribute('disabled', 'disabled'); // A 已销毁 -> 置灰无效
  }
}

// --- __bench 契约 ----------------------------------------------------------------
window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: state.assetLoaded,
    frame,
    assetLoaded: state.assetLoaded,
    instanceCount: state.instanceCount,
    instances: {
      A: state.instances.A ? { ...state.instances.A } : null,
      B: state.instances.B ? { ...state.instances.B } : null,
    },
    destroyedInstance: state.destroyedInstance,
    resetCount: state.resetCount,
    fps: Math.round(fps * 10) / 10,
  }),
  reset: doReset,
};

// --- 资产加载(整会话仅此一次对 assets/character.glb 的网络请求)------------------
const ASSET_URL = 'assets/character.glb';
let readyToSignal = false; // 双实例就绪,待首帧渲染后置 __appReady

async function loadAsset() {
  try {
    const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
    const clips = {
      idle: pickClip(gltf.animations, 'idle'),
      walk: pickClip(gltf.animations, 'walk'),
    };
    gltfTemplate = { scene: gltf.scene, clips };
    instances.A = buildInstance('A');
    instances.B = buildInstance('B');
    state.assetLoaded = true;
    syncStateInstances();
    refreshButtonStates();
    readyToSignal = true; // 主循环渲染下一帧后置 __appReady = true
  } catch (err) {
    // 不抛未捕获异常;页面保持运行(背景可见),状态如实反映失败
    console.warn('[E10] asset load failed:', err);
  }
}

// --- 主循环 -------------------------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  frame += 1;

  // 最近 60 帧平均 fps
  frameTimes.push(dt);
  if (frameTimes.length > 60) frameTimes.shift();
  if (frameTimes.length >= 10) {
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    fps = avg > 0 ? 1 / avg : 0;
  }

  if (instances.A) instances.A.mixer.update(dt); // 两 mixer 独立推进
  if (instances.B) instances.B.mixer.update(dt);
  syncStateInstances();

  renderer.render(scene, camera);

  if (readyToSignal && window.__appReady !== true) {
    window.__appReady = true; // 双实例就绪且首帧已渲染
  }
}

tick();
loadAsset();

// --- 视口自适应 -----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
