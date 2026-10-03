// ============================================================================
// E10 — 动画角色展示空间(Three.js r186 / 0.186.1)
// ----------------------------------------------------------------------------
// 场景要点(brief.md E10 v1.0.1 / spec.json):
//   * runtime 以相对路径加载 assets/character.glb(整会话仅一次网络请求);
//   * 双实例由同一次加载的 gltf.scene 经 SkeletonUtils.clone 派生,动画状态完全
//     独立(每实例独立 AnimationMixer + 独立材质克隆);
//   * GLB 内剪辑映射为规范名:idle -> "Survey"(原地待机),walk -> "Walk";
//   * Idle/Walk 即时切换(fade <= 150ms),实例隔离(切 A 不影响 B,反之亦然);
//   * destroy-a:实例 A 从场景图移除并释放实例资源(mixer/材质),B 不受影响;
//   * reset:应用内重建双实例(缓存数据派生,零新增网络请求,不刷新页面);
//   * 状态契约 window.__bench.getState() / reset(),见 stateContract。
// 页面契约:index.html 内联脚本先置 window.__appReady=false,本文件在双实例就绪
// 且首帧渲染完成后置 true;window.__bench 在启动时即挂载。
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const ASSET_URL = 'assets/character.glb'; // 相对路径,harness 观测该请求(仅一次)

// --- 站位 / 构图常量(按 1280x720 视口与探针归一化区域校准) --------------------
// 探针区域 A:x[0.08,0.42] y[0.15,0.95];区域 B:x[0.58,0.92] y[0.15,0.95]。
const INSTANCE_X = 1.55;    // 实例 A/B 站位偏移(±,世界单位),投影落各自区域中心
const TARGET_HEIGHT = 1.8;  // 角色归一化身高(世界单位)
const PLATFORM_TOP = 0.06;  // 展台圆盘顶面高度(角色脚底)
// 朝向:GLB 原生面向局部 +Z;每实例轻微偏航,面向相机 + 对称 3/4 内侧转身(截图校准)
const FACE_YAW_A = 0.45;
const FACE_YAW_B = -0.45;
const CROSSFADE_S = 0.12;   // 切换淡入淡出时长(<= 300ms 过渡要求)

// --- 渲染器 -------------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// --- 场景:柔和渐变背景(中性展示空间) -----------------------------------------
const scene = new THREE.Scene();
{
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#e9eff7');
  grad.addColorStop(0.55, '#cdd7e3');
  grad.addColorStop(1.0, '#a9b5c3');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const bg = new THREE.CanvasTexture(c);
  bg.colorSpace = THREE.SRGBColorSpace;
  scene.background = bg;
}

// --- 相机:中景平视、轻微俯角,双实例完整入画 -----------------------------------
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 1.5, 4.6);
camera.lookAt(0, 0.95, 0);

// --- 灯光:三点布光(键光 + 补光 + 逆光)+ 半球环境光 ----------------------------
scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x8f8577, 0.55));

const keyLight = new THREE.DirectionalLight(0xfff1dd, 2.4); // 键光(暖,投影)
keyLight.position.set(3.2, 5.2, 2.6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 16;
keyLight.shadow.camera.left = -4;
keyLight.shadow.camera.right = 4;
keyLight.shadow.camera.top = 5;
keyLight.shadow.camera.bottom = -1;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xbcd2f2, 0.85); // 补光(冷,无影)
fillLight.position.set(-4, 2.4, 2.8);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 1.5); // 逆光(轮廓)
rimLight.position.set(-1.2, 3.2, -4.2);
scene.add(rimLight);

// --- 地面与展台圆盘(接触阴影落在地坪上) ----------------------------------------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.96, metalness: 0.0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

function makePlatform(x) {
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.12, PLATFORM_TOP, 48),
    new THREE.MeshStandardMaterial({ color: 0xcfd7df, roughness: 0.9, metalness: 0.0 })
  );
  disc.position.set(x, PLATFORM_TOP / 2, 0);
  disc.receiveShadow = true;
  scene.add(disc);
}
makePlatform(-INSTANCE_X);
makePlatform(INSTANCE_X);

// --- bench 状态(stateContract)-------------------------------------------------
let assetLoaded = false;        // GLB 解析完成且双实例就绪
let destroyedInstance = null;   // null | 'A'
let resetCount = 0;             // reset 执行次数
let instA = null;
let instB = null;
let fpsAvg = 0;                 // 最近 60 帧平均帧率

// --- GLB 资产(单次加载,实例全部由缓存数据派生) --------------------------------
let source = null;              // gltf.scene(模板,不再直接入场景)
let clips = null;               // { idle, walk } 规范名 -> THREE.AnimationClip
let normScale = 1;              // 归一化缩放
let srcFeetY = 0;               // 源空间脚底高度(bind pose bbox min.y)

function prepareSource(gltfScene, animations) {
  const box = new THREE.Box3().setFromObject(gltfScene);
  const height = Math.max(box.max.y - box.min.y, 1e-6);
  normScale = TARGET_HEIGHT / height;
  srcFeetY = box.min.y;
  const byName = (re) => animations.find((a) => re.test(a.name));
  clips = {
    idle: byName(/^survey$/i) || animations[0], // 原地待机(look-around)
    walk: byName(/^walk$/i) || animations[1],   // 行走
  };
}

// --- 实例构建 / 切换 / 销毁 ------------------------------------------------------
function buildInstance(id, xOffset, yaw) {
  // SkeletonUtils.clone:克隆骨架与蒙皮,几何体/贴图与源共享(单次加载派生)
  const model = skeletonClone(source);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // 蒙皮网格包围盒不可靠,禁视锥剔除
      o.material = o.material.clone(); // 材质实例隔离(销毁时只释放本实例克隆)
    }
  });
  model.scale.setScalar(normScale);
  model.position.y = -srcFeetY * normScale; // 脚底贴展台面

  const holder = new THREE.Group();
  holder.add(model);
  holder.position.set(xOffset, PLATFORM_TOP, 0);
  holder.rotation.y = yaw;
  scene.add(holder);

  // 每实例独立 mixer => 动画状态(剪辑/播放时间)完全独立
  const mixer = new THREE.AnimationMixer(model);
  const actions = {
    idle: mixer.clipAction(clips.idle),
    walk: mixer.clipAction(clips.walk),
  };
  actions.idle.play(); // 初始一律 Idle

  return { id, holder, model, mixer, actions, clip: 'idle', alive: true };
}

function setClip(inst, name) {
  if (!inst || !inst.alive || !actionsOk(inst) || inst.clip === name) return;
  inst.actions[name].reset().fadeIn(CROSSFADE_S).play();
  inst.actions[inst.clip].fadeOut(CROSSFADE_S);
  inst.clip = name;
}

function actionsOk(inst) {
  return inst.actions && inst.actions.idle && inst.actions.walk;
}

// 销毁:从场景图移除 + 释放实例资源(mixer、本实例材质克隆)。几何体/贴图与
// 另一实例共享,不释放;仅设为不可见不算销毁。
function destroyInstance(inst) {
  if (!inst || !inst.alive) return;
  scene.remove(inst.holder);
  inst.mixer.stopAllAction();
  inst.mixer.uncacheRoot(inst.model);
  inst.model.traverse((o) => {
    if (o.isMesh && o.material) o.material.dispose();
  });
  inst.alive = false;
}

function buildPair() {
  instA = buildInstance('A', -INSTANCE_X, FACE_YAW_A);
  instB = buildInstance('B', +INSTANCE_X, FACE_YAW_B);
}

function resetAll() {
  if (!source) return; // 资产未就绪时不生效(探针时序不会发生)
  destroyInstance(instA);
  destroyInstance(instB);
  buildPair(); // 应用内重建,零新增网络请求,不刷新页面
  destroyedInstance = null;
  resetCount += 1;
  syncUI();
}

// --- 状态契约 -------------------------------------------------------------------
window.__bench = {
  getState() {
    const alive = (i) => (i && i.alive && actionsOk(i) ? 1 : 0);
    const entry = (i) =>
      i && i.alive && actionsOk(i)
        ? { clip: i.clip, time: i.actions[i.clip].time }
        : null;
    return {
      engine: 'three',
      assetLoaded,
      instanceCount: alive(instA) + alive(instB),
      instances: { A: entry(instA), B: entry(instB) },
      destroyedInstance,
      resetCount,
      fps: fpsAvg,
    };
  },
  reset: resetAll,
};

// --- UI 控件组(画布顶部条,均带 data-bench 与 data-ui 属性) ----------------------
const bar = document.createElement('div');
bar.style.cssText =
  'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
  'display:flex;align-items:center;gap:8px;padding:8px 12px;z-index:10;' +
  'background:rgba(24,30,38,0.62);border-radius:10px;white-space:nowrap;';
document.body.appendChild(bar);

function makeBtn(label, benchName, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.setAttribute('data-bench', benchName);
  b.setAttribute('data-ui', benchName);
  b.className = 'bench-btn';
  b.style.cssText =
    "font:13px/1 system-ui,sans-serif;padding:7px 12px;color:#e8edf3;" +
    'background:#2c3644;border:1px solid #46586c;border-radius:6px;cursor:pointer;';
  b.addEventListener('click', onClick);
  bar.appendChild(b);
  return b;
}
function makeSep() {
  const s = document.createElement('div');
  s.style.cssText = 'width:1px;align-self:stretch;background:#46586c;';
  bar.appendChild(s);
}
const btnAIdle = makeBtn('A·待机', 'anim-a-idle', () => setClip(instA, 'idle'));
const btnAWalk = makeBtn('A·行走', 'anim-a-walk', () => setClip(instA, 'walk'));
makeSep();
const btnBIdle = makeBtn('B·待机', 'anim-b-idle', () => setClip(instB, 'idle'));
const btnBWalk = makeBtn('B·行走', 'anim-b-walk', () => setClip(instB, 'walk'));
makeSep();
const btnDestroyA = makeBtn('销毁A', 'destroy-a', () => {
  if (instA && instA.alive) {
    destroyInstance(instA);
    destroyedInstance = 'A';
    syncUI();
  }
});
makeSep();
const btnReset = makeBtn('重置', 'reset', () => resetAll());
// hover / active 反馈
const style = document.createElement('style');
style.textContent =
  '.bench-btn:hover{background:#3b4a5c !important;border-color:#7d95ad !important;}' +
  '.bench-btn:active{background:#22303f !important;transform:translateY(1px);}' +
  '.bench-btn:disabled{opacity:0.35;cursor:not-allowed;}';
document.head.appendChild(style);

const status = document.createElement('span');
status.style.cssText =
  'color:#aebbc9;font:12px/1 system-ui,sans-serif;margin-left:4px;min-width:150px;';
bar.appendChild(status);

function syncUI() {
  const aAlive = !!(instA && instA.alive);
  btnDestroyA.disabled = !aAlive; // 实例 A 已销毁 => 置灰无效
  const st = window.__bench.getState();
  status.textContent =
    `实例 ${st.instanceCount}/2 · 重置 ${st.resetCount} · ` +
    `A:${st.instances.A ? st.instances.A.clip : '—'} ` +
    `B:${st.instances.B ? st.instances.B.clip : '—'}`;
}
syncUI();

// --- 运行时加载 GLB(相对路径;整会话仅此一次网络请求) ---------------------------
new GLTFLoader().load(
  ASSET_URL,
  (gltf) => {
    source = gltf.scene;
    prepareSource(source, gltf.animations || []);
    buildPair();        // 双实例由同一次加载的数据派生
    assetLoaded = true; // GLB 解析完成且实例就绪
    syncUI();
  },
  undefined,
  (err) => {
    console.error('[E10] GLB 加载失败:', err);
  }
);

// --- 主循环 ---------------------------------------------------------------------
const clock = new THREE.Clock();
const frameTimes = [];
let readySet = false;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (instA && instA.alive) instA.mixer.update(dt);
  if (instB && instB.alive) instB.mixer.update(dt);
  renderer.render(scene, camera);

  // fps:最近 60 帧平均(仅统计就绪后的帧,排除首帧着色器编译等启动抖动)
  if (readySet) {
    const now = performance.now();
    frameTimes.push(now);
    if (frameTimes.length > 61) frameTimes.shift();
    if (frameTimes.length > 6) {
      const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
      const n = frameTimes.length - 1;
      if (span > 0) fpsAvg = Math.round((n * 1000) / span);
    }
  }

  // 首帧(双实例已在场)渲染完成 => 页面就绪
  if (assetLoaded && !readySet) {
    readySet = true;
    window.__appReady = true;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
