// ============================================================================
// E10 动画角色展示空间 — Three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// 契约(MASTER-CONTEXT §12.1 + briefs/E10):
//   window.__appReady : 资产加载 + 双实例创建 + 首帧渲染完成后置 true
//   window.__bench    : { getState(): object, reset(): void }
//
// 核心生命周期(全部满足 spec frozen 断言):
//   单次网络加载 assets/character.glb(整会话仅 1 次请求)
//     → 归一化为原型(SkeletonUtils 可克隆的骨架层级)
//     → clone 出实例 A / B(各自独立 AnimationMixer,动画状态完全隔离)
//     → UI 切换 A/B 的 idle|walk(0.25s 交叉淡入淡出,互不影响)
//     → 销毁 A(场景图移除 + mixer 停止/反缓存 + 每实例骨骼纹理释放,A=null;B 不受影响)
//     → reset(从缓存原型 clone 重建双实例,零新网络请求)
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const ENGINE_VERSION = '0.186.1';
const ASSET_URL = 'assets/character.glb'; // 相对路径:整会话只允许请求这一次
const TARGET_HEIGHT = 1.5;                // 归一化后角色身高(世界单位)
const SLOT_X = { A: -1.35, B: 1.35 };     // 实例站位(世界 X;A 屏左 / B 屏右)
const FADE_SEC = 0.25;                    // 动画切换交叉淡化时长

// ============================================================================
// 1. 渲染器 / 场景 / 相机
// ============================================================================
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1); // harness 视口固定 1280x720,无需 DPR 缩放
renderer.setSize(window.innerWidth || 1280, window.innerHeight || 720, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186 已移除 PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x2b3244, 10, 24); // 远处地坪融入背景

// 展示空间背景:柔和渐变穹顶(不受雾影响,保证背景层次)
function makeGradientTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, '#1c2333');
  grad.addColorStop(0.45, '#2a3247');
  grad.addColorStop(0.72, '#3a4258'); // 地平线附近微亮
  grad.addColorStop(1.0, '#171b26');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
{
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(26, 32, 20),
    new THREE.MeshBasicMaterial({ map: makeGradientTexture(), side: THREE.BackSide, fog: false })
  );
  scene.add(dome);
}

// 相机:中景平视(轻微俯角),绕场景中心的平滑环绕摆动 + 用户拖拽/滚轮
const camera = new THREE.PerspectiveCamera(40, (window.innerWidth || 1280) / (window.innerHeight || 720), 0.1, 60);
const camTarget = new THREE.Vector3(0, 0.95, 0);
const CAM_BASE = { az: 0.0, polar: 1.32, radius: 4.9 }; // polar≈75.6°(自上而下约 14° 俯角)
const SWAY = { amp: 0.3, period: 26 };                  // ±0.3rad / 26s:构图稳定,持续轻微视差
const camUser = { az: 0, polar: 0, zoom: 1 };           // 用户输入偏移
const camCur = { az: CAM_BASE.az, polar: CAM_BASE.polar, radius: CAM_BASE.radius };

// ============================================================================
// 2. 灯光:环境半球光 + 三点布光(键/补/逆)共 4 盏(<= 6)
// ============================================================================
scene.add(new THREE.HemisphereLight(0xbfd0ea, 0x2a2620, 0.5));

const keyLight = new THREE.DirectionalLight(0xfff0dd, 2.6); // 键光:暖白,唯一投影光源
keyLight.position.set(3.6, 5.6, 4.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -3.4;
keyLight.shadow.camera.right = 3.4;
keyLight.shadow.camera.top = 3.4;
keyLight.shadow.camera.bottom = -3.4;
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 16;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x9db4ff, 0.9); // 补光:冷色,冲淡暗部
fillLight.position.set(-5, 3, 2.5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xdfe9ff, 1.7); // 逆光:勾轮廓
rimLight.position.set(-1.2, 4.6, -5.2);
scene.add(rimLight);

// ============================================================================
// 3. 地坪 + 展台(A/B 各一,带脉冲光圈与顶面标识)
// ============================================================================
function makeFloorTexture() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#20242f';
  g.fillRect(0, 0, S, S);
  // 中心柔和光池
  const pool = g.createRadialGradient(S / 2, S / 2, 40, S / 2, S / 2, S * 0.5);
  pool.addColorStop(0, 'rgba(96,116,150,0.34)');
  pool.addColorStop(0.5, 'rgba(60,72,98,0.16)');
  pool.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = pool;
  g.fillRect(0, 0, S, S);
  // 同心圆环(精致刻度感,亦为相机摆动提供视差纹理)
  g.strokeStyle = 'rgba(150,170,200,0.10)';
  g.lineWidth = 2;
  for (let r = 70; r < S / 2; r += 58) {
    g.beginPath();
    g.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    g.stroke();
  }
  // 细噪点,避免大平面色带
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(180,190,210,${0.02 + Math.random() * 0.03})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(11, 72),
  new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.92, metalness: 0.05 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const PED_HEIGHT = 0.14;
function makeDecalTexture(letter) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(120,215,232,0.35)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.36, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(120,215,232,0.22)';
  g.font = `600 ${Math.round(S * 0.34)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, S / 2, S / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const pedestalRings = {}; // id -> Mesh(脉冲光圈,销毁后仍留空展台)
for (const id of ['A', 'B']) {
  const group = new THREE.Group();
  group.position.set(SLOT_X[id], 0, 0);

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 1.05, PED_HEIGHT, 48),
    new THREE.MeshStandardMaterial({ color: 0x2d3342, roughness: 0.55, metalness: 0.2 })
  );
  body.position.y = PED_HEIGHT / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.985, 0.014, 10, 72),
    new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: 0x35c4d8, emissiveIntensity: 1.0, roughness: 0.4 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = PED_HEIGHT + 0.004;
  group.add(ring);
  pedestalRings[id] = ring;

  const decal = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 48),
    new THREE.MeshBasicMaterial({ map: makeDecalTexture(id), transparent: true, depthWrite: false })
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.y = PED_HEIGHT + 0.006;
  group.add(decal);

  scene.add(group);
}

// ============================================================================
// 4. 应用状态( getState 契约字段 )
// ============================================================================
const state = {
  assetLoaded: false,
  assetRequests: 0,          // 对 character.glb 发起的 load 次数(永远为 1)
  destroyedInstance: null,   // null | "A"
  resetCount: 0,
};
const instances = { A: null, B: null }; // 销毁后置 null

// 资产缓存:整会话持有(供 reset 重建克隆),几何/材质/贴图与全部实例共享
let asset = null; // { proto, clips: {idle, walk}, sourceName: {idle, walk} }

// ============================================================================
// 5. 资产加载(单次网络请求)+ 原型归一化 + 就地(In-Place)动画处理
// ============================================================================
function freezeDriftingPositionTracks(clip) {
  // Khronos Fox 的 Survey/Walk 剪辑带根位移(髋骨平移,Walk 漂移约 2.2 单位)。
  // 冻结位移幅度超过阈值的位置轨道为其首帧值 => 原地播放,旋转轨道(迈步/摆臂/摇头)全保留。
  // 这仍是 GLB 剪辑驱动的骨骼蒙皮动画,只是去掉世界空间根位移。
  const EPS = 0.02;
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const v = track.values;
    let drift = 0;
    for (let i = 3; i < v.length; i += 3) {
      drift = Math.max(drift, Math.abs(v[i] - v[0]), Math.abs(v[i + 1] - v[1]), Math.abs(v[i + 2] - v[2]));
    }
    if (drift <= EPS) continue;
    for (let i = 3; i < v.length; i += 3) {
      v[i] = v[0]; v[i + 1] = v[1]; v[i + 2] = v[2];
    }
  }
}

function pickClips(animations) {
  // 映射为规范名:idle(优先 idle/survey 类)、walk(优先 walk 类)
  const lower = animations.map((c) => c.name.toLowerCase());
  const idxOf = (re) => lower.findIndex((n) => re.test(n));
  let idle = idxOf(/idle|survey/);
  if (idle < 0) idle = 0;
  let walk = idxOf(/walk/);
  if (walk < 0 || walk === idle) walk = animations.length > 1 ? (idle === 0 ? 1 : 0) : idle;
  return {
    idle: animations[idle],
    walk: animations[walk],
    sourceName: { idle: animations[idle].name, walk: animations[walk].name },
  };
}

function buildPrototype(gltfScene) {
  const inner = gltfScene;                 // 归一化变换烘焙进原始层级,克隆体自然继承
  inner.rotation.y = 0;                    // 先量取原始姿态
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  // 鼻尾轴(最长水平轴)转到面向镜头的朝向,再给一点上相的斜角
  inner.rotation.y = (size.x >= size.z ? Math.PI / 2 : 0) + 0.0;
  inner.updateMatrixWorld(true);

  const wrapper = new THREE.Group();
  wrapper.add(inner);

  const box1 = new THREE.Box3().setFromObject(wrapper);
  const s1 = box1.getSize(new THREE.Vector3());
  const scale = TARGET_HEIGHT / Math.max(s1.y, 1e-6);
  wrapper.scale.setScalar(scale);
  wrapper.updateMatrixWorld(true);

  // 站上展台:底部贴 0,水平居中
  const box2 = new THREE.Box3().setFromObject(wrapper);
  const c = box2.getCenter(new THREE.Vector3());
  wrapper.position.set(-c.x, -box2.min.y, -c.z);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

function loadAsset() {
  state.assetRequests += 1; // 唯一一次;reset/重建一律走缓存克隆
  new GLTFLoader().load(
    ASSET_URL,
    (gltf) => {
      try {
        const clips = pickClips(gltf.animations || []);
        for (const clip of [clips.idle, clips.walk]) freezeDriftingPositionTracks(clip);
        const proto = buildPrototype(gltf.scene);
        proto.updateMatrixWorld(true);
        asset = { proto, clips, sourceName: clips.sourceName };
        spawnInstance('A');
        spawnInstance('B');
        state.assetLoaded = true; // GLB 解析完成且双实例就绪
        syncUI();
        console.info(`[E10] asset ready: clips idle=${clips.sourceName.idle}, walk=${clips.sourceName.walk}`);
      } catch (e) {
        console.error('[E10] asset processing failed:', e);
        setLoadingError(e);
      }
    },
    undefined,
    (err) => {
      console.error('[E10] asset load failed:', err);
      setLoadingError(err);
    }
  );
}

// ============================================================================
// 6. 实例生命周期:创建 / 动画切换 / 销毁(真实释放)
// ============================================================================
const INSTANCE_YAW = { A: 0.42, B: -0.42 }; // 双实例相向微侧,站位有构图感

function spawnInstance(id) {
  if (!asset || instances[id]) return;
  const anchor = new THREE.Group();
  anchor.position.set(SLOT_X[id], PED_HEIGHT, 0);
  anchor.rotation.y = INSTANCE_YAW[id];

  const root = cloneSkinned(asset.proto); // SkeletonUtils.clone:蒙皮网格 + 新骨架(骨骼纹理独立)
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  anchor.add(root);
  scene.add(anchor);

  const mixer = new THREE.AnimationMixer(anchor); // 每实例独立 mixer => 动画状态完全隔离
  const actions = {};
  for (const name of ['idle', 'walk']) {
    const a = mixer.clipAction(asset.clips[name]);
    a.loop = THREE.LoopRepeat;
    actions[name] = a;
  }
  actions.idle.play();

  instances[id] = { id, anchor, root, mixer, actions, current: 'idle' };
  if (id === 'A') state.destroyedInstance = null; // (重新)创建 A 时清除销毁标记
}

function setInstanceClip(id, name) {
  const inst = instances[id];
  if (!inst || inst.current === name) return;
  const from = inst.actions[inst.current];
  const to = inst.actions[name];
  to.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(FADE_SEC).play();
  from.fadeOut(FADE_SEC);
  inst.current = name; // 状态即时更新(画面 0.25s 内完成过渡)
  syncUI();
}

function destroyInstance(id) {
  const inst = instances[id];
  if (!inst) return;
  scene.remove(inst.anchor);                    // 1) 从场景图移除(非隐藏)
  inst.mixer.stopAllAction();                   // 2) 停止全部动画
  inst.mixer.uncacheRoot(inst.anchor);          // 3) 释放 mixer 的绑定/插值缓存
  inst.root.traverse((o) => {                   // 4) 释放每实例 GPU 资源(骨骼纹理)
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
  });
  instances[id] = null;                         // 5) 引用置空 => 实例对象图可被 GC
  if (id === 'A') state.destroyedInstance = 'A';
  syncUI();
}

function doReset() {
  if (!asset) return;                 // 资产未就绪时 reset 无意义(不计次)
  destroyInstance('A');               // 内部销毁会置 destroyedInstance='A',重建后清除
  destroyInstance('B');
  spawnInstance('A');                 // 从缓存原型克隆重建,零新网络请求
  spawnInstance('B');
  state.destroyedInstance = null;
  state.resetCount += 1;
  syncUI();
}

// ============================================================================
// 7. window.__bench 契约
// ============================================================================
let frameCount = 0;
const dtWindow = []; // 最近 60 帧间隔(ms) => 滚动平均 fps
let fpsRolling = 0;

function instanceState(id) {
  const inst = instances[id];
  if (!inst) return null;
  const action = inst.actions[inst.current];
  return {
    clip: inst.current,
    time: Math.round(action.time * 1000) / 1000,
    playing: action.isRunning(),
  };
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    engineVersion: ENGINE_VERSION,
    brief: 'E10',
    ready: window.__appReady === true,
    assetLoaded: state.assetLoaded,
    assetUrl: ASSET_URL,
    assetRequests: state.assetRequests,
    instanceCount: (instances.A ? 1 : 0) + (instances.B ? 1 : 0),
    instances: { A: instanceState('A'), B: instanceState('B') },
    clipSources: asset ? asset.sourceName : null,
    destroyedInstance: state.destroyedInstance,
    resetCount: state.resetCount,
    fps: Math.round(fpsRolling * 10) / 10,
    frame: frameCount,
  }),
  reset: doReset,
};

// ============================================================================
// 8. UI:加载遮罩 / 标题 / 顶栏控件(data-ui + data-bench)/ 状态 HUD
// ============================================================================
const UI_DEFS = [
  { group: 'A', label: '实例 A', buttons: [
    { ui: 'anim-a-idle', text: 'Idle' },
    { ui: 'anim-a-walk', text: 'Walk' },
  ] },
  { group: 'B', label: '实例 B', buttons: [
    { ui: 'anim-b-idle', text: 'Idle' },
    { ui: 'anim-b-walk', text: 'Walk' },
  ] },
  { group: 'ops', label: '生命周期', buttons: [
    { ui: 'destroy-a', text: '销毁 A', cls: 'danger' },
    { ui: 'reset', text: '重置', cls: 'primary' },
  ] },
];

const uiButtons = {}; // ui名 -> {el, group, kind}
const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'loading-overlay';
loadingOverlay.innerHTML =
  '<div class="spinner"></div><div class="loading-text">正在加载 assets/character.glb …</div>';
document.body.appendChild(loadingOverlay);

function setLoadingError(err) {
  loadingOverlay.innerHTML = `<div class="loading-text" style="color:#ff8a8a">资产加载失败:${err && err.message ? err.message : err}</div>`;
}

{
  const style = document.createElement('style');
  style.textContent = `
    .hud-title{position:fixed;top:10px;left:14px;z-index:60;color:rgba(230,238,248,.8);
      font:600 13px/1.5 system-ui,sans-serif;letter-spacing:.4px;pointer-events:none;
      text-shadow:0 1px 3px rgba(0,0,0,.5)}
    .hud-title small{display:block;font-weight:400;font-size:10.5px;color:rgba(190,205,222,.55)}
    #bench-toolbar{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:70;
      display:flex;gap:14px;align-items:flex-end;padding:7px 12px 8px;border-radius:12px;
      background:rgba(15,19,29,.74);border:1px solid rgba(255,255,255,.09);
      box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(6px)}
    .tb-group{display:flex;flex-direction:column;gap:4px;align-items:center}
    .tb-label{font:600 9.5px/1 system-ui,sans-serif;letter-spacing:1.2px;color:#8fa0b3;
      text-transform:uppercase}
    .tb-row{display:flex;gap:5px}
    .tb-btn{padding:5px 11px;border-radius:7px;border:1px solid rgba(255,255,255,.13);
      background:rgba(48,56,74,.85);color:#cfd8e3;font:500 12px/1 system-ui,sans-serif;
      cursor:pointer;transition:background .15s,color .15s,border-color .15s,transform .06s,opacity .2s}
    .tb-btn:hover{background:rgba(66,78,102,.95);color:#fff}
    .tb-btn:active{transform:translateY(1px)}
    .tb-btn.active{background:rgba(53,196,216,.16);border-color:rgba(84,220,236,.65);color:#7fe3f0}
    .tb-btn.danger{border-color:rgba(227,102,110,.5);color:#f0a3a8}
    .tb-btn.danger:hover{background:rgba(160,50,58,.55);color:#ffd9db}
    .tb-btn.danger.off{opacity:.32;cursor:default;background:rgba(48,56,74,.5)}
    .tb-btn.primary{border-color:rgba(126,217,143,.55);color:#a9e8b4}
    .tb-btn.primary:hover{background:rgba(46,110,58,.55);color:#d6f5db}
    #bench-hud{position:fixed;left:14px;bottom:12px;z-index:60;color:rgba(210,222,238,.72);
      font:11px/1.7 ui-monospace,Consolas,monospace;text-shadow:0 1px 3px rgba(0,0,0,.55);
      pointer-events:none;white-space:pre}
    #loading-overlay{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;gap:18px;
      align-items:center;justify-content:center;background:rgba(10,13,20,.86);color:#dfe7f2;
      font:14px/1 system-ui,sans-serif;transition:opacity .35s}
    #loading-overlay.hidden{opacity:0;pointer-events:none}
    .spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.15);
      border-top-color:#54dcec;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(style);

  const title = document.createElement('div');
  title.className = 'hud-title';
  title.innerHTML = `E10 · 动画角色展示空间<small>three.js r${ENGINE_VERSION} · Khronos Fox · SkeletonUtils.clone ×2</small>`;
  document.body.appendChild(title);

  const bar = document.createElement('div');
  bar.id = 'bench-toolbar';
  for (const grp of UI_DEFS) {
    const box = document.createElement('div');
    box.className = 'tb-group';
    const lab = document.createElement('div');
    lab.className = 'tb-label';
    lab.textContent = grp.label;
    box.appendChild(lab);
    const row = document.createElement('div');
    row.className = 'tb-row';
    for (const def of grp.buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-btn' + (def.cls ? ' ' + def.cls : '');
      btn.textContent = def.text;
      btn.setAttribute('data-ui', def.ui);
      btn.setAttribute('data-bench', def.ui);
      btn.setAttribute('aria-label', def.ui);
      btn.addEventListener('click', () => onUIButton(def.ui));
      row.appendChild(btn);
      uiButtons[def.ui] = { el: btn, group: grp.group, kind: def.ui.replace(/^(anim-|-a-|-b-)/, '') };
    }
    box.appendChild(row);
    bar.appendChild(box);
  }
  document.body.appendChild(bar);

  const hud = document.createElement('div');
  hud.id = 'bench-hud';
  document.body.appendChild(hud);
  window.__hudEl = hud;
}

function onUIButton(ui) {
  switch (ui) {
    case 'anim-a-idle': setInstanceClip('A', 'idle'); break;
    case 'anim-a-walk': setInstanceClip('A', 'walk'); break;
    case 'anim-b-idle': setInstanceClip('B', 'idle'); break;
    case 'anim-b-walk': setInstanceClip('B', 'walk'); break;
    case 'destroy-a':
      if (instances.A) destroyInstance('A'); // 已销毁时为受控 no-op(按钮置灰)
      break;
    case 'reset': doReset(); break;
  }
}

function syncUI() {
  for (const id of ['A', 'B']) {
    for (const clip of ['idle', 'walk']) {
      const b = uiButtons[`anim-${id.toLowerCase()}-${clip}`];
      if (b) b.el.classList.toggle('active', !!instances[id] && instances[id].current === clip);
    }
  }
  const dBtn = uiButtons['destroy-a'];
  if (dBtn) {
    const off = !instances.A;
    dBtn.el.classList.toggle('off', off);
    dBtn.el.setAttribute('aria-disabled', off ? 'true' : 'false');
  }
}

// ============================================================================
// 9. 相机控制(拖拽环绕 / 滚轮缩放;探针不涉及画布指针,但保留交互性)
// ============================================================================
let dragging = false;
let lastPx = 0;
let lastPy = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPx = e.clientX;
  lastPy = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camUser.az -= (e.clientX - lastPx) * 0.005;
  camUser.polar -= (e.clientY - lastPy) * 0.004;
  camUser.az = THREE.MathUtils.clamp(camUser.az, -1.1, 1.1);
  camUser.polar = THREE.MathUtils.clamp(camUser.polar, -0.32, 0.22);
  lastPx = e.clientX;
  lastPy = e.clientY;
});
const endDrag = () => { dragging = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camUser.zoom = THREE.MathUtils.clamp(camUser.zoom * (1 + e.deltaY * 0.0011), 0.62, 1.7);
}, { passive: false });

// ============================================================================
// 10. 主循环
// ============================================================================
let lastNow = performance.now(); // r186:THREE.Clock 已弃用,自计时更干净
let elapsed = 0;
let readyReported = false;
let hudClock = 0;

function updateCamera(t, dt) {
  const swayAz = SWAY.amp * Math.sin((t * Math.PI * 2) / SWAY.period);
  const want = {
    az: CAM_BASE.az + swayAz + camUser.az,
    polar: THREE.MathUtils.clamp(CAM_BASE.polar + camUser.polar, 0.95, 1.5),
    radius: THREE.MathUtils.clamp(CAM_BASE.radius * camUser.zoom, 3.4, 8.2),
  };
  const k = 1 - Math.exp(-dt * 3.2); // 平滑趋近(阻尼感)
  camCur.az += (want.az - camCur.az) * k;
  camCur.polar += (want.polar - camCur.polar) * k;
  camCur.radius += (want.radius - camCur.radius) * k;
  camera.position.setFromSphericalCoords(camCur.radius, camCur.polar, camCur.az).add(camTarget);
  camera.lookAt(camTarget);
}

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  elapsed += dt;
  const t = elapsed;
  frameCount += 1;

  // 滚动 fps(最近 60 帧)
  dtWindow.push(dt * 1000);
  if (dtWindow.length > 60) dtWindow.shift();
  if (dtWindow.length >= 8) {
    const avg = dtWindow.reduce((a, b) => a + b, 0) / dtWindow.length;
    fpsRolling = avg > 0 ? 1000 / avg : 0;
  }

  // 双实例各自独立推进(销毁实例的 mixer 引用已释放,不存在于表内)
  if (instances.A) instances.A.mixer.update(dt);
  if (instances.B) instances.B.mixer.update(dt);

  // 展台光圈缓慢呼吸(销毁 A 后其空展台仍有生命感,构图不塌)
  pedestalRings.A.material.emissiveIntensity = 0.85 + 0.45 * Math.sin(t * 1.25);
  pedestalRings.B.material.emissiveIntensity = 0.85 + 0.45 * Math.sin(t * 1.25 + Math.PI * 0.66);

  updateCamera(t, dt);
  renderer.render(scene, camera);

  // HUD 低频刷新
  hudClock += dt;
  if (hudClock > 0.2 && window.__hudEl) {
    hudClock = 0;
    const s = window.__bench.getState();
    const fmt = (x) => (x ? `${x.clip} ${x.time.toFixed(2)}s` : 'destroyed');
    window.__hudEl.textContent =
      `fps ${s.fps.toFixed(0).padStart(3)}  frames ${String(s.frame).padStart(5)}  instances ${s.instanceCount}\n` +
      `A: ${fmt(s.instances.A)}   B: ${fmt(s.instances.B)}\n` +
      `assetRequests ${s.assetRequests}  resetCount ${s.resetCount}`;
  }

  // 资产就绪且完成首帧渲染 => 页面 ready
  if (!readyReported && state.assetLoaded && instances.A && instances.B) {
    readyReported = true;
    loadingOverlay.classList.add('hidden');
    window.__appReady = true;
  }
}

window.addEventListener('resize', () => {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
});

// --- 启动:先起渲染循环(空场景/加载遮罩下亦有帧节奏),再发起唯一一次资产请求
tick();
loadAsset();
