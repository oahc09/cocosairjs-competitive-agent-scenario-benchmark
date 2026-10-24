#!/usr/bin/env node
// ============================================================================
// selfcheck.mjs — Agent 自检脚本(非 harness 探针,仅供本地验证)
// ----------------------------------------------------------------------------
// 依 RUN-CONTRACT §2:创建任何浏览器会话前先执行 `node scripts/count.mjs browser`。
// 本脚本严格先计数再启动 playwright-core 会话,并按 spec.json 的 P1–P8 时序
// 点击/等待/截图,在页面内用 2D canvas 解码截图做像素统计(暖窗数、亮度、
// 帧差比),输出紧凑 JSON 供 WORKLOG/RESULT 引用。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(__dirname, '..');
const outDir = path.join(workspace, 'screenshots', 'selfcheck');
fs.mkdirSync(outDir, { recursive: true });

// ① 机器计数(先计后开会话)
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('browser count failed', counted.stderr);
  process.exit(1);
}
process.stdout.write(counted.stdout);

const { chromium } = createRequire(import.meta.url)('playwright-core');
const url = process.env.BENCH_URL || 'http://127.0.0.1:7106/';
const exe = process.env.BENCH_BROWSER || 'E:/AIProMax/Y2026M10/chrome-pin-155.0.8059.40/chrome.exe';

const browser = await chromium.launch({ executablePath: exe, headless: true, viewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => window.__bench.getState());
const results = {};

let shotSeq = 0;
async function shot(label) {
  shotSeq += 1;
  const file = path.join(outDir, `${String(shotSeq).padStart(2, '0')}-${label}.png`);
  const buf = await page.screenshot({ path: file });
  return buf.toString('base64');
}

const ANALYZE_SRC = async ({ a, b, region }) => {
  const load = (s) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + s;
  });
  const ia = await load(a);
  const ib = b ? await load(b) : null;
  const W = ia.width;
  const H = ia.height;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(ia, 0, 0);
  const da = ctx.getImageData(0, 0, W, H).data;
  let db = null;
  if (ib) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(ib, 0, 0);
    db = ctx.getImageData(0, 0, W, H).data;
  }
  const x0 = Math.floor(region[0] * W);
  const y0 = Math.floor(region[1] * H);
  const x1 = Math.ceil(region[2] * W);
  const y1 = Math.ceil(region[3] * H);
  let n = 0, warm = 0, bright = 0, sum = 0, diff = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const r = da[i], g = da[i + 1], bl = da[i + 2];
      n += 1;
      sum += (r + g + bl) / 3;
      if (r > 120 && r > g * 1.12 && g > bl * 1.08) warm += 1;
      const luma = r * 0.2126 + g * 0.7152 + bl * 0.0722;
      if (luma > 150) bright += 1;
      if (db) {
        const j = i;
        const d = Math.abs(r - db[j]) + Math.abs(g - db[j + 1]) + Math.abs(bl - db[j + 2]);
        if (d > 24) diff += 1;
      }
    }
  }
  return { n, warm, bright, meanLuma: +(sum / n).toFixed(2), diffRatio: db ? +(diff / n).toFixed(5) : null, diffPixels: diff };
};

async function analyze(a, b, region) {
  return page.evaluate(ANALYZE_SRC, { a, b, region });
}

const clickUi = (name) => page.click(`[data-ui="${name}"]`, { timeout: 5000 });

// ---------------------------------------------------------------- P1 ------
await sleep(2500);
results.P1state = await state();
const p1 = await shot('P1-initial');
results.P1bottomThird = await analyze(p1, null, [0, 0.667, 1, 1]);
results.P1upperSky = await analyze(p1, null, [0, 0, 1, 0.5]);
results.P1horizonBand = await analyze(p1, null, [0, 0.55, 1, 0.67]);
results.P1silhouette = await analyze(p1, null, [0, 0.72, 1, 0.92]);

// ---------------------------------------------------------------- P2 ------
const tClick = Date.now();
await page.mouse.click(640, 216); // (0.5, 0.30)
await sleep(500);
results.P2state = await state();
results.P2elapsed = Date.now() - tClick;
const p2a = await shot('P2-t500-a');
await sleep(180);
const p2b = await shot('P2-t680-b');
results.P2motionBand = await analyze(p2a, p2b, [0.4, 0, 0.6, 1]);

// ---------------------------------------------------------------- P3 ------
await sleep(1200);
results.P3state = await state();
results.P3elapsed = Date.now() - tClick;
const p3 = await shot('P3-t1700');
results.P3burst = await analyze(p3, p2a, [0.30, 0.10, 0.70, 0.50]);
results.P3upper = await analyze(p3, null, [0, 0, 1, 0.5]);

// ---------------------------------------------------------------- P4 ------
await sleep(2600);
results.P4state = await state();
results.P4elapsed = Date.now() - tClick;
const p4a = await shot('P4-a');
await sleep(1000);
const p4b = await shot('P4-b');
results.P4elapsed2 = Date.now() - tClick;
results.P4motionCenterBottom = await analyze(p4a, p4b, [0.25, 0.5, 0.75, 0.95]);
results.P4motionUpper = await analyze(p4a, p4b, [0, 0, 1, 0.5]);
results.P4stateLate = await state();

// 追加长尾检查:Burst 后 8s / 12s 左右余烬状态(模拟 harness 探针间截图时延)
await sleep(Math.max(0, 8200 - (Date.now() - tClick)));
results.late8sState = await state();
results.late8sElapsed = Date.now() - tClick;
const late8 = await shot('late-8s');
await sleep(1000);
const late8b = await shot('late-9s');
results.late8smotionCB = await analyze(late8, late8b, [0.25, 0.5, 0.75, 0.98]);
await sleep(Math.max(0, 12200 - (Date.now() - tClick)));
results.late12sState = await state();
results.late12sElapsed = Date.now() - tClick;
const late12 = await shot('late-12s');
results.late12sCB = await analyze(late12, null, [0.25, 0.5, 0.75, 1]);

// ---------------------------------------------------------------- P5 ------
await clickUi('auto-show');
await sleep(4000);
results.P5state = await state();
const p5 = await shot('P5-autoshow');
results.P5upper = await analyze(p5, null, [0, 0, 1, 0.55]);

// ---------------------------------------------------------------- P6 ------
await clickUi('auto-show');
const p6stateA = await state();
await sleep(2500);
const p6stateB = await state();
results.P6state = { a: p6stateA, b: p6stateB, frozen: p6stateA.fireworkCount === p6stateB.fireworkCount };
results.P6elapsed = Date.now() - tClick;

// ---------------------------------------------------------------- P7 ------
// 先让残余粒子/余烬继续存在(有东西可冻结),再暂停
await clickUi('pause');
await sleep(300);
results.P7state = await state();
const p7a = await shot('P7-pause-a');
await sleep(1000);
const p7b = await shot('P7-pause-b');
results.P7fullDiff = await analyze(p7a, p7b, [0, 0, 1, 1]);
results.P7state2 = await state();

// ---------------------------------------------------------------- P8 ------
await clickUi('reset');
await sleep(600);
results.P8state = await state();
const p8 = await shot('P8-reset');
results.P8city = await analyze(p8, null, [0, 0.667, 1, 1]);
results.P8upper = await analyze(p8, null, [0, 0, 1, 0.5]);
results.P8baselineUpper = results.P1upperSky;

results.errors = errors;
await browser.close();
console.log('[selfcheck] ' + JSON.stringify(results, null, 1));
