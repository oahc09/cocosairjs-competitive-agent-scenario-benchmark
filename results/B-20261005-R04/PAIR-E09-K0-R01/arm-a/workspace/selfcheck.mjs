// ============================================================================
// selfcheck.mjs — Agent 自检探针(在页面上下文动态 import 执行)
// 用法:verify-browser.mjs --eval "(async()=>{const m=await import('/selfcheck.mjs?v='+Date.now());return m.runProbes();})()"
// 语义对齐 spec.json probes:P1-P8 状态断言 + nonBlank 覆盖率 + regionChange 帧间差。
// 仅用于 Agent 自检;正式判定以 harness 探针为准。
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => window.__bench.getState();

function sampleCanvas(x, y, w, h, cols = 128) {
  const canvas = document.getElementById('app-canvas');
  const rows = Math.max(1, Math.round((cols * canvas.height) / canvas.width));
  const off = document.createElement('canvas');
  off.width = cols; off.height = rows;
  const ctx = off.getContext('2d');
  ctx.drawImage(canvas, 0, 0, cols, rows);
  const d = ctx.getImageData(
    Math.round(x * cols), Math.round(y * rows),
    Math.max(1, Math.round(w * cols)), Math.max(1, Math.round(h * rows))
  ).data;
  return { d, px: d.length / 4 };
}

// nonBlank:区域内亮度>40 的像素占比
function coverage(x, y, w, h) {
  const { d, px } = sampleCanvas(x, y, w, h);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 40) n++;
  }
  return n / px;
}

// regionChange:间隔 gapMs 两帧降采样平均绝对差
async function motionDiff(x, y, w, h, gapMs) {
  const a = sampleCanvas(x, y, w, h);
  await sleep(gapMs);
  const b = sampleCanvas(x, y, w, h);
  let sum = 0;
  for (let i = 0; i < a.d.length; i += 4) {
    sum += Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
  }
  return sum / (a.px * 3);
}

function dblclickAt(x, y) {
  document.getElementById('app-canvas').dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })
  );
}

export async function runProbes() {
  const R = {};
  const GEM = { x: 0.36, y: 0.26, w: 0.28, h: 0.42 };
  const WIDE = { x: 0.25, y: 0.15, w: 0.5, h: 0.7 };

  // P1:就绪初始状态
  await sleep(1500);
  R.p1 = { ...st() };
  R.p1Coverage = coverage(GEM.x, GEM.y, GEM.w, GEM.h);

  // P2:自转 ≥25°/s + 画面流动
  const a0 = st().rotationAngle;
  await sleep(1000);
  const a1 = st().rotationAngle;
  R.p2 = { ...st() };
  R.p2degPerSec = a1 - a0;
  R.p2Motion = await motionDiff(GEM.x, GEM.y, GEM.w, GEM.h, 500);

  // P3:色板 swatch-2 → ruby
  document.querySelector('[data-ui="swatch-2"]').click();
  await sleep(400);
  R.p3 = { ...st() };
  R.p3Motion = await motionDiff(GEM.x, GEM.y, GEM.w, GEM.h, 400);

  // P4:双击推近
  dblclickAt(640, 360);
  await sleep(1100);
  R.p4 = { ...st() };
  R.p4Motion = await motionDiff(WIDE.x, WIDE.y, WIDE.w, WIDE.h, 600);

  // P5:再次双击拉回
  dblclickAt(640, 360);
  await sleep(1100);
  R.p5 = { ...st() };

  // P6/P7:连续导出
  document.querySelector('[data-ui="export-png"]').click();
  await sleep(1200);
  R.p6 = { ...st() };
  R.p6Export = { ...window.__benchExport };
  document.querySelector('[data-ui="export-png"]').click();
  await sleep(1200);
  R.p7 = { ...st() };
  R.p7Export = { ...window.__benchExport };
  R.p7Coverage = coverage(GEM.x, GEM.y, GEM.w, GEM.h);

  // P8:reset
  document.querySelector('[data-ui="reset"]').click();
  await sleep(900);
  R.p8 = { ...st() };
  R.p8Motion = await motionDiff(GEM.x, GEM.y, GEM.w, GEM.h, 500);

  // rotationAngle 单调性快速采样
  let mono = true;
  let prev = -1;
  for (let i = 0; i < 5; i++) {
    const a = st().rotationAngle;
    if (a < prev) mono = false;
    prev = a;
    await sleep(100);
  }
  R.rotationMonotonic = mono;

  // 汇总布尔判定
  R.pass = {
    p1: R.p1.selectedColor === 'diamond' && R.p1.cameraDistance >= 9 && R.p1.exportCount === 0 && R.p1.rotationAngle >= 0 && R.p1Coverage >= 0.08,
    p2: R.p2.rotationAngle >= 50 && R.p2degPerSec >= 25 && R.p2Motion > 1.5,
    p3: R.p3.selectedColor === 'ruby' && R.p3Motion > 0.3,
    p4: R.p4.cameraDistance <= 6,
    p5: R.p5.cameraDistance >= 9,
    p6: R.p6.exportCount === 1 && R.p6Export.lastBytes > 10240,
    p7: R.p7.exportCount === 2 && R.p7Export.lastBytes > 10240 && R.p7Coverage >= 0.08,
    p8: R.p8.selectedColor === 'diamond' && R.p8.cameraDistance >= 9 && R.p8.exportCount === 0 && R.p8Motion > 0.5,
    mono: R.rotationMonotonic,
  };
  R.allPass = Object.values(R.pass).every(Boolean);
  return R;
}
