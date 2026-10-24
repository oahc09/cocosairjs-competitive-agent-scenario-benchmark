// ============================================================================
// E04 — 城市烟花夜(City Fireworks Night)/ three.js 实现
// ----------------------------------------------------------------------------
// 结构:
//   sky.js        夜空渐变 + 背景星 + 月亮
//   city.js       程序化楼群剪影 + 暖色亮窗 + 航空障碍灯
//   particles.js  统一粒子池(尾迹/爆炸/余烬/闪光)
//   fireworks.js  烟花状态机(升空 → 爆炸 → 下坠 → 余烬)
//   main.js       相机/时间线/输入/状态通道/UI(本文件)
//
// 时间线语义:所有动画只由 simTime 驱动;enabled=false 时 dt=0 → simTime 冻结,
// 渲染仍在跑但画面逐帧完全一致(P7 的"两帧像素差≈0")。恢复后从冻结处继续。
// 点击坐标:归一化视口坐标 (nx,ny) → world ((nx-0.5)*aspect, 0.5-ny)。
// ============================================================================

import * as THREE from 'three';

import { makeGlowTexture, makeStarTexture, makeWindowTexture } from './textures.js';
import { createNightSky, createStars } from './sky.js';
import { createCity } from './city.js';
import { ParticleSystem } from './particles.js';
import { Fireworks, pickHue } from './fireworks.js';

// ---------------------------------------------------------------- 渲染器 ----
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 100);
camera.position.set(0, 0, 10);

const drawSize = new THREE.Vector2();
function aspectNow() {
  return window.innerWidth / Math.max(1, window.innerHeight);
}
function pixelScaleNow() {
  renderer.getDrawingBufferSize(drawSize);
  return drawSize.y;
}
function applyCamera(aspect) {
  camera.left = -aspect / 2;
  camera.right = aspect / 2;
  camera.top = 0.5;
  camera.bottom = -0.5;
  camera.updateProjectionMatrix();
}
applyCamera(aspectNow());

// ------------------------------------------------------------ 场景内容 ----
const glowTexture = makeGlowTexture();
const starTexture = makeStarTexture();
const windowTexture = makeWindowTexture();

const sky = createNightSky(scene);
const stars = createStars(scene, starTexture, glowTexture);
const city = createCity(scene, { windowTexture, glowTexture });
const particles = new ParticleSystem(scene, glowTexture);
const fireworks = new Fireworks(particles);

sky.resize(aspectNow());
stars.build(aspectNow());
city.regenerate(aspectNow());
stars.update(0, pixelScaleNow());
city.update(0, pixelScaleNow());
particles.setPixelScale(pixelScaleNow());

// ---------------------------------------------------------------- 状态 ----
let fireworkCount = 0;
let autoShow = false;
let enabled = true;
let autoTimer = 0;
let simTime = 0;

function launchAt(nx, ny) {
  const aspect = aspectNow();
  const worldX = (nx - 0.5) * aspect;
  const worldY = 0.5 - ny;
  fireworks.launch(worldX, worldY, pickHue());
  fireworkCount += 1;
}

function updateAuto(dt) {
  if (!autoShow || !enabled) return;
  autoTimer -= dt;
  if (autoTimer <= 0) {
    autoTimer = 0.5 + Math.random() * 0.6; // 0.5–1.1 s 随机间隔
    launchAt(0.18 + Math.random() * 0.64, 0.16 + Math.random() * 0.34);
  }
}

function doReset() {
  particles.clear();
  fireworks.clear();
  city.regenerate(aspectNow());
  fireworkCount = 0;
  autoShow = false;
  enabled = true;
  autoTimer = 0;
  refreshUi();
}

window.__bench = {
  getState() {
    return {
      engine: 'three',
      fireworkCount,
      particlesAlive: particles.count,
      autoShow,
      enabled,
      buildingCount: city.buildingCount,
    };
  },
  reset: doReset,
};

// ------------------------------------------------------------------ UI ----
const ui = document.createElement('div');
ui.style.cssText = [
  'position:fixed',
  'top:14px',
  'right:14px',
  'z-index:20',
  'display:flex',
  'flex-direction:column',
  'gap:8px',
  'width:152px',
  'pointer-events:none',
  'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
].join(';');

function makeButton(name, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-ui', name);
  btn.style.cssText = [
    'pointer-events:auto',
    'display:block',
    'width:100%',
    'padding:8px 10px',
    'font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif',
    'letter-spacing:0.4px',
    'text-align:left',
    'color:#dfe6ff',
    'background:rgba(12,16,30,0.72)',
    'border:1px solid rgba(140,165,235,0.45)',
    'border-radius:6px',
    'cursor:pointer',
    'outline:none',
    'transition:none',
    'box-shadow:0 0 0 rgba(0,0,0,0)',
  ].join(';');
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  // 键盘激活(Enter/Space)同样走 click;这里不额外做画面动画
  ui.appendChild(btn);
  return btn;
}

const autoBtn = makeButton('auto-show', () => {
  autoShow = !autoShow;
  autoTimer = autoShow ? 0.03 : 0; // 开启后下一帧即发射,保证 4s 窗口内足够多发
  refreshUi();
});
const pauseBtn = makeButton('pause', () => {
  enabled = !enabled;
  refreshUi();
});
const resetBtn = makeButton('reset', () => {
  doReset();
});

document.body.appendChild(ui);

function refreshUi() {
  autoBtn.textContent = autoShow ? '自动表演:开' : '自动表演:关';
  autoBtn.style.borderColor = autoShow ? 'rgba(255,196,110,0.9)' : 'rgba(140,165,235,0.45)';
  autoBtn.style.color = autoShow ? '#ffd9a0' : '#dfe6ff';
  pauseBtn.textContent = enabled ? '时间线:运行' : '时间线:已暂停';
  pauseBtn.style.borderColor = enabled ? 'rgba(140,165,235,0.45)' : 'rgba(255,120,110,0.9)';
  pauseBtn.style.color = enabled ? '#dfe6ff' : '#ffb3ad';
  resetBtn.textContent = '重置';
}
refreshUi();

// 标题 / 操作提示(纯展示,pointer-events:none,不参与交互)
{
  const title = document.createElement('div');
  title.textContent = 'CITY FIREWORKS NIGHT';
  title.style.cssText =
    'position:fixed;top:16px;left:18px;z-index:10;pointer-events:none;' +
    'font:11px/1 system-ui,sans-serif;letter-spacing:3px;color:rgba(200,214,255,0.42);';
  document.body.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = '点击夜空发射烟花';
  hint.style.cssText =
    'position:fixed;left:18px;bottom:14px;z-index:10;pointer-events:none;' +
    'font:12px/1 system-ui,sans-serif;letter-spacing:1px;color:rgba(200,214,255,0.30);';
  document.body.appendChild(hint);
}

// ---------------------------------------------------------------- 输入 ----
canvas.addEventListener('click', (ev) => {
  const nx = ev.clientX / Math.max(1, window.innerWidth);
  const ny = ev.clientY / Math.max(1, window.innerHeight);
  if (nx > 0.8 && ny < 0.25) return; // 控件区域(正常情况下点击被按钮截获)
  if (city.isInCity(nx, ny, aspectNow())) return; // 城市剪影区域不发射
  launchAt(nx, ny);
});

// ------------------------------------------------------------ 主循环 ----
let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const raw = (now - last) / 1000;
  last = now;
  const dt = enabled ? Math.min(Math.max(raw, 0), 0.05) : 0; // clamped 时间步

  if (dt > 0) {
    simTime += dt;
    updateAuto(dt);
    fireworks.update(dt, simTime);
    particles.update(dt, simTime);
    const px = pixelScaleNow();
    stars.update(simTime, px);
    city.update(simTime, px);
    particles.setPixelScale(px);
  }

  renderer.render(scene, camera);
  if (window.__appReady !== true) window.__appReady = true;
}
requestAnimationFrame(tick);

// ------------------------------------------------------------ 视口自适应 ----
window.addEventListener('resize', () => {
  const aspect = aspectNow();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  applyCamera(aspect);
  sky.resize(aspect);
  stars.build(aspect);
  city.regenerate(aspect);
  const px = pixelScaleNow();
  stars.update(simTime, px);
  city.update(simTime, px);
  particles.setPixelScale(px);
  renderer.render(scene, camera);
});
