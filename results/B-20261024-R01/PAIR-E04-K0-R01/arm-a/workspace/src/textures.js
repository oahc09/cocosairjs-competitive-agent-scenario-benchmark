// ============================================================================
// textures.js — 运行时程序化贴图(无任何外部图片资产,见 brief §5)
// ----------------------------------------------------------------------------
// 所有贴图均用离屏 canvas 画出,只提供 alpha 形状(着色由粒子/星星的顶点色决定):
//   glow   — 柔和径向光晕(烟花、余烬、亮窗的环境辉光)
//   star   — 更锐利的小星点
//   window — 带轻微散射的方形暖窗贴片
// 为什么要程序化:资产契约为空,且 K0 不允许读取任何外部图片/字体文件。
// ============================================================================

import * as THREE from 'three';

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finish(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 径向柔光:中心实心、二次衰减,叠加混合时形成 bloom 观感。 */
export function makeGlowTexture() {
  const S = 128;
  const canvas = makeCanvas(S);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.20, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.09)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.02)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(canvas);
}

/** 星点:小核心 + 极短光尾,避免出现方块感。 */
export function makeStarTexture() {
  const S = 64;
  const canvas = makeCanvas(S);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.16, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.34, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(canvas);
}

/** 亮窗:圆角方形 + 轻微外发光,叠加混合后像玻璃后透出的灯光。 */
export function makeWindowTexture() {
  const S = 64;
  const canvas = makeCanvas(S);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.shadowColor = 'rgba(255,255,255,0.75)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffffff';
  const pad = 19;
  const w = S - pad * 2;
  const r = 5;
  ctx.beginPath();
  ctx.moveTo(pad + r, pad);
  ctx.arcTo(pad + w, pad, pad + w, pad + w, r);
  ctx.arcTo(pad + w, pad + w, pad, pad + w, r);
  ctx.arcTo(pad, pad + w, pad, pad, r);
  ctx.arcTo(pad, pad, pad + w, pad, r);
  ctx.closePath();
  ctx.fill();
  // 再叠一次小核心,让像素中心更亮(视觉上像窗内灯)
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(pad + 6, pad + 6, w - 12, w - 12);
  return finish(canvas);
}
