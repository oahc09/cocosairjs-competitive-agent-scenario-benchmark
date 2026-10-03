// ============================================================================
// E06 — 荒野篝火营地(Wilderness Campfire)— Three.js r186 Reference
// ----------------------------------------------------------------------------
// 场景构成(全部程序化,无外部资产):
//   1. 低多边形起伏地形 + 营地泥地圆盘(terrain.js)
//   2. 18 棵低多边形树环(锥形树冠 + 柱状树干,色相/缩放微随机)(forest.js)
//   3. 篝火:石圈 + 交叉柴堆 + 火苗 shader 面片 + 44 火苗粒子 + 64 火星
//      + 地面暖光斑(campfire.js)
//   4. 动态火光:PointLight,强度/颜色随多频闪烁(0.7/2.3/3.1/5.1 Hz,
//      基准 0.55,波幅 ±0.31),真实照亮地面与树干
//   5. 18 只萤火虫:利萨茹游走 + 深脉冲明灭,白天淡出(fireflies.js)
//   6. 天穹渐变 + 900 星点 + Hemisphere/Directional 光 + 线性雾,
//      全部随 timeOfDay(夜 0 ↔ 日 1,3.2s smootherstep 渐变)联动(sky.js)
//   7. 环绕相机:0.22 rad/s 持续平滑环绕,可暂停/恢复
//   8. 后处理:RenderPass → UnrealBloomPass → OutputPass(ACES)
// 页面契约:window.__appReady / window.__bench = { getState, reset }
// ============================================================================

import * as THREE from 'three';
import { Timer } from 'three'; // r186:Timer 已并入核心(THREE.Clock 弃用)
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createGround } from './terrain.js';
import { createForest, TREE_COUNT } from './forest.js';
import { createCampfire, fireFlicker } from './campfire.js';
import { createFireflies, FIREFLY_COUNT } from './fireflies.js';
import { createSky } from './sky.js';

// --- 冻结常数(brief.md §3/§4/§6 尺度)----------------------------------------
const CFG = {
  fov: 55,
  orbitRadius: 16.5,
  orbitHeight: 7.7,
  orbitTarget: new THREE.Vector3(0, 1.5, 0),
  orbitSpeed: 0.22,          // rad/s(spec 0.05-0.4)
  dayDuration: 3.2,          // s(spec 2.5-4)
  fogNear: 26,
  fogFar: 110,
  bloom: { strength: 0.55, radius: 0.7, threshold: 0.85 },
  exposure: 1.05,
};

// ============================================================================
// 渲染器 / 场景 / 相机 / 后处理
// ============================================================================
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CFG.exposure;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x131e3e, CFG.fogNear, CFG.fogFar);

const camera = new THREE.PerspectiveCamera(
  CFG.fov,
  window.innerWidth / window.innerHeight,
  0.1,
  1400
);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    CFG.bloom.strength,
    CFG.bloom.radius,
    CFG.bloom.threshold
  )
);
composer.addPass(new OutputPass());

// ============================================================================
// 共享帧上下文(各模块每帧读取;状态与画面同源,杜绝伪造)
// ============================================================================
const ctx = {
  simTime: 0,        // 场景时钟(reset 归零;失焦 dt 钳制防跳变)
  dayFactor: 0,      // timeOfDay(0 夜 ↔ 1 日)
  flicker: 0.55,     // 火光强度 [0,1]
};

// ============================================================================
// 场景组装
// ============================================================================
const pointMats = []; // 世界尺寸点精灵材质(uScale 随视口更新)
const sky = createSky(scene);
scene.add(createGround());
scene.add(createForest());
const campfire = createCampfire(scene, pointMats);
const fireflies = createFireflies(scene, pointMats);

// ============================================================================
// 日夜状态机(0 夜 ↔ 1 日,3.2s smootherstep 连续渐变)
// ============================================================================
const day = { value: 0, target: 0, from: 0, progress: 1 };

function smootherstep(x) {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function toggleDayNight() {
  day.from = day.value;
  day.target = day.target > 0.5 ? 0 : 1;
  day.progress = 0;
}

function updateDay(dt) {
  if (day.progress < 1) {
    day.progress = Math.min(1, day.progress + dt / CFG.dayDuration);
    day.value = THREE.MathUtils.lerp(day.from, day.target, smootherstep(day.progress));
  }
  ctx.dayFactor = day.value;
}

// ============================================================================
// 环绕相机
// ============================================================================
const orbit = { angle: 0, enabled: true };

function updateCamera(dt) {
  if (orbit.enabled) orbit.angle += CFG.orbitSpeed * dt;
  const a = orbit.angle;
  camera.position.set(
    Math.sin(a) * CFG.orbitRadius,
    CFG.orbitHeight,
    Math.cos(a) * CFG.orbitRadius
  );
  camera.lookAt(CFG.orbitTarget);
}

// ============================================================================
// UI 覆盖层(DOM,data-ui 契约,右上角 x>0.8 / y<0.25)
// ============================================================================
const uiRefs = {};
{
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;top:14px;right:16px;z-index:1000;display:flex;' +
    'flex-direction:column;gap:8px;align-items:stretch;';

  function makeButton(dataUi, labelOf) {
    const btn = document.createElement('button');
    btn.setAttribute('data-ui', dataUi);
    btn.textContent = labelOf();
    btn.style.cssText =
      'padding:7px 16px;min-width:118px;text-align:left;cursor:pointer;' +
      "font:13px/1.4 system-ui,sans-serif;color:#f2ecd8;letter-spacing:0.5px;" +
      'background:rgba(10,14,24,0.74);border:1px solid rgba(255,255,255,0.24);' +
      'border-radius:8px;backdrop-filter:blur(2px);transition:background 0.15s;';
    btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(46,58,84,0.85)'));
    btn.addEventListener('mouseleave', () => (btn.style.background = 'rgba(10,14,24,0.74)'));
    btn.addEventListener('click', () => {
      if (dataUi === 'day-night') toggleDayNight();
      else if (dataUi === 'orbit-toggle') orbit.enabled = !orbit.enabled;
      else if (dataUi === 'reset') doReset();
      refreshLabels();
    });
    box.appendChild(btn);
    uiRefs[dataUi] = { btn, labelOf };
  }

  makeButton('day-night', () => `昼夜:${day.target > 0.5 ? '昼' : '夜'}`);
  makeButton('orbit-toggle', () => `环绕:${orbit.enabled ? '开' : '关'}`);
  makeButton('reset', () => '重置');

  function refreshLabels() {
    for (const { btn, labelOf } of Object.values(uiRefs)) btn.textContent = labelOf();
  }
  document.body.appendChild(box);
}

// ============================================================================
// bench 状态通道(全部真实数据)
// ============================================================================
let frame = 0;
let resetCount = 0;

function doReset() {
  // 语义(brief §4):timeOfDay 立即(<=300ms)回夜、环绕恢复且角度归零、
  // 火光/火苗/火星/萤火虫回初始(同种子重放);__appReady 保持 true。
  day.value = 0;
  day.from = 0;
  day.target = 0;
  day.progress = 1;
  orbit.angle = 0;
  orbit.enabled = true;
  ctx.simTime = 0;
  campfire.reset();
  resetCount += 1;
}

window.__bench = {
  getState: () => ({
    engine: 'three',
    ready: true,
    frame,
    resetCount,
    timeOfDay: Math.round(day.value * 10000) / 10000,
    fireLightIntensity: Math.round(ctx.flicker * 10000) / 10000,
    fireflyCount: FIREFLY_COUNT,
    cameraOrbitAngle: Math.round(orbit.angle * 10000) / 10000,
    orbitEnabled: orbit.enabled,
    treeCount: TREE_COUNT,
  }),
  reset: doReset,
};

// ============================================================================
// 主循环(Timer 取真实时间步;失焦回来 dt 钳制,无时间跳变瞬变)
// ============================================================================
const timer = new Timer();
timer.connect(document); // Page Visibility API:避免大 delta

function updatePointScale() {
  // 世界尺寸点精灵:uScale = 绘制缓冲高 / (2·tan(fov/2))
  const h = renderer.domElement.height; // buffer px(已含 pixelRatio)
  const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(CFG.fov) / 2));
  for (const m of pointMats) m.uniforms.uScale.value = s;
  sky.setPixelRatio(renderer.getPixelRatio());
}
updatePointScale();

function animate(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1); // 钳制:失焦/卡顿不产生跳变

  ctx.simTime += dt;
  updateDay(dt);
  ctx.flicker = fireFlicker(ctx.simTime); // 状态与画面同一闪烁来源

  sky.applyDay(ctx.dayFactor, ctx.simTime);
  campfire.update(dt, ctx);
  fireflies.update(dt, ctx);
  updateCamera(dt);

  composer.render();
  frame += 1;
  if (window.__appReady !== true) window.__appReady = true; // 首帧渲染完成
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ============================================================================
// 视口自适应
// ============================================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  updatePointScale();
});
