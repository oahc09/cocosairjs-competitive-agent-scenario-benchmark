// ============================================================================
// E03 — 太阳系仪(Orrery)· Three.js r186 Reference 实现
// ----------------------------------------------------------------------------
// 页面契约(MASTER-CONTEXT §12.1 / E03 spec):
//   window.__appReady :首帧渲染完成后置 true
//   window.__bench    :{ getState(): object, reset(): void }
//
// getState 字段:E03 stateContract(planetCount/moonCount/asteroidCount/
// ringedPlanetCount/timeScale/simulationTime/selectedPlanet/planets/
// pickTargets/infoCard/fps/epoch)。
//
// 实现要点:
//   * 轨道角 = k·45° + 2π·simTime/周期(由模拟时钟确定性驱动,timeScale 真实
//     作用于公转/自转/卫星/小行星带;角度连续累计不取模)。
//   * 时间步进基于时钟增量,单帧积分上限 50ms(抗卡顿/后台节流跳变;稳态
//     60fps 下 1 实时秒 = 1 模拟秒 @1x)。
//   * 点击拾取:对 pickTargets 屏幕投影做距离判定(与暴露给探针的半径一致),
//     点空白不产生选中。
//   * reset:epoch+1、倍率回 1、取消选中;轨道相位经 0.85s"回卷"过渡平滑恢复到
//     k×45°(恢复期内模拟时钟停在 0,渲染与运动不中断,符合"恢复在 1s 内完成"
//     合同),过渡结束后时钟从 0 继续推进。无页面刷新。
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Orrery, PLANETS, MOON_COUNT, ASTEROID_COUNT, RINGED_PLANET_COUNT, orbitAngleOf,
} from './orrery.js';
import { createUI } from './ui.js';

// --- 画布 / 渲染器 ------------------------------------------------------------
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

// --- 场景 / 相机(初始斜俯视 ≈ 34°,同心轨道分层展开) ------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060d);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.5,
  4000
);
camera.position.set(0, 58, 88); // 俯角 atan(58/88) ≈ 33.4°
camera.lookAt(0, 0, 0);

// --- 相机交互(可选增强:环绕 + 缩放,阻尼平滑) -------------------------------
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 28;
controls.maxDistance = 420;
controls.maxPolarAngle = Math.PI * 0.52;

// --- 天体系统 ------------------------------------------------------------------
const orrery = new Orrery(scene);

// --- bench 状态 -----------------------------------------------------------------
let simTime = 0;          // 模拟秒(@1x 与实时 1:1;reset 期间时钟停在 0)
let effTime = 0;          // 当前帧实际用于渲染/状态的角度驱动时间(恢复期内为回卷值)
let timeScale = 1;        // ∈ {0.5,1,2,4,8}
let selected = null;      // 选中行星名(小写英文)| null
let epoch = 0;            // reset 计数
let pickData = [];        // 每帧更新的屏幕投影(点击判定与探针共用同一份数据)
const fpsSamples = [];    // 最近 2s 的帧时间戳

// --- reset 恢复期(spec 允许"恢复在 1s 内完成") ----------------------------------
// reset 不是瞬跳,而是 0.85s 的"回卷"过渡:模拟时钟归零并暂停,全部天体沿轨道
// 平滑倒退回初始相位(k×45°),期间渲染与运动不中断;过渡结束后时钟从 0 恢复推进。
// getState().simulationTime 在恢复期内如实报告 0(时钟已复位),planets[].orbitAngle
// 报告当前实际渲染的(回卷中的)角度。
const RESTORE_DUR = 0.85; // 秒(< 1s 合同上限)
let restore = null;       // { start: 毫秒时间戳, from: 回卷起始的 effTime }

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function currentFps() {
  if (fpsSamples.length < 2) return 0;
  const span = (fpsSamples[fpsSamples.length - 1] - fpsSamples[0]) / 1000;
  return span > 0 ? (fpsSamples.length - 1) / span : 0;
}

const ui = createUI({
  onSpeed(scale) {
    timeScale = scale; // 即时变速:角度由 simTime 驱动,无跳变
    ui.setSpeedActive(scale);
  },
  onReset: doReset,
});
ui.setSpeedActive(1);

function selectPlanet(name) {
  selected = name;
  orrery.setSelected(name);
  const cfg = name ? PLANETS.find((p) => p.name === name) : null;
  if (cfg) ui.showInfo(cfg);
  else ui.hideInfo();
}

function doReset() {
  // 回卷起点 = 当前实际显示的时间(若正处于上一次恢复期内,从当前回卷位置续接)
  restore = { start: performance.now(), from: effTime };
  simTime = 0;            // 时钟复位,恢复期内保持 0(暂停推进)
  timeScale = 1;
  ui.setSpeedActive(1);
  selectPlanet(null); // 信息卡关闭、高亮圈移除
  epoch += 1;
}

window.__bench = {
  getState() {
    return {
      planetCount: PLANETS.length,
      moonCount: MOON_COUNT,
      asteroidCount: ASTEROID_COUNT,
      ringedPlanetCount: RINGED_PLANET_COUNT,
      timeScale,
      simulationTime: simTime,
      selectedPlanet: selected,
      planets: PLANETS.map((p, i) => ({
        name: p.name,
        orbitRadius: p.orbitRadius,
        orbitAngle: orbitAngleOf(p, i, effTime),
      })),
      pickTargets: pickData.map((d) => ({
        name: d.name,
        screenX: Math.round(d.x * 10) / 10,
        screenY: Math.round(d.y * 10) / 10,
        screenRadius: Math.round(d.screenRadius * 10) / 10,
      })),
      infoCard: selected
        ? { visible: true, name: selected, fieldCount: 5 }
        : { visible: false, name: '', fieldCount: 0 },
      fps: Math.round(currentFps() * 10) / 10,
      epoch,
    };
  },
  reset: doReset,
};

// --- 点击拾取(屏幕投影距离判定;拖拽视角不算点击) ------------------------------
let downPos = null;
canvas.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const dx = e.clientX - downPos.x;
  const dy = e.clientY - downPos.y;
  downPos = null;
  if (dx * dx + dy * dy > 36) return; // 位移 > 6px 视为拖拽相机
  pickAt(e.clientX, e.clientY);
});

function pickAt(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const d of pickData) {
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist <= d.screenRadius && dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  selectPlanet(best ? best.name : null); // 点空白 → 取消选中,不产生新选中
}

// --- 主循环 ---------------------------------------------------------------------
const MAX_DT = 0.05; // 单帧积分上限:抗截图/卡顿/后台节流造成的时间跳变
let last = performance.now();
let ready = false;

function tick(now) {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;

  // 恢复期(回卷过渡):时钟暂停在 0,effTime 从 from 平滑倒退到 0;
  // 过渡结束(按墙钟判定,后台节流回来后立即收敛)后恢复实时推进。
  if (restore) {
    const p = (now - restore.start) / 1000 / RESTORE_DUR;
    if (p >= 1) {
      restore = null;
      effTime = simTime;
    } else {
      effTime = restore.from * (1 - easeInOutCubic(p));
    }
  } else {
    simTime += dt * timeScale;
    effTime = simTime;
  }

  controls.update();
  orrery.update(effTime, now / 1000, camera);
  renderer.render(scene, camera);
  pickData = orrery.screenData(camera, window.innerWidth, window.innerHeight);

  fpsSamples.push(now);
  while (fpsSamples.length > 1 && now - fpsSamples[0] > 2000) fpsSamples.shift();
  ui.tick(simTime, timeScale, currentFps());

  if (!ready) {
    ready = true;
    window.__appReady = true; // 首帧渲染完成
  }
  requestAnimationFrame(tick);
}

// 初始一帧数据(getState 在首帧前被调用也返回有效投影)
orrery.update(0, 0, camera);
pickData = orrery.screenData(camera, window.innerWidth, window.innerHeight);
requestAnimationFrame(tick);
// --- 视口自适应 -------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
