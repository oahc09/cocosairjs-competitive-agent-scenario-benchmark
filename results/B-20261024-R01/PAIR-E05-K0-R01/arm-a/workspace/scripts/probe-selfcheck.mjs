#!/usr/bin/env node
// ============================================================================
// probe-selfcheck.mjs — 本 Arm 自建诊断脚本(非 harness 组件;只读自己的产物)
// ----------------------------------------------------------------------------
// 目的:一次浏览器会话内在 1280×720 下走完 spec.json 的 P1–P6 动作序列,
//       对每张截图做分区像素统计,给出与 spec 断言同口径的近似判定,
//       并保存各阶段截图供人眼复核。
//
// 预算合规:启动浏览器前先执行 scripts/count.mjs browser(browserAttempt 机器计数)。
//
// 用法:node scripts/probe-selfcheck.mjs [--url http://127.0.0.1:7108/index.html]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argUrlIdx = process.argv.indexOf('--url');
const PAGE_URL = argUrlIdx > 0 ? process.argv[argUrlIdx + 1] : 'http://127.0.0.1:7108/index.html';
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });

// ---- ① browserAttempt 计数(先计后会话)-------------------------------------
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[selfcheck] browser 计数失败,拒绝启动浏览器');
  process.exit(1);
}
process.stdout.write(counted.stdout);

const chromium = createRequire(import.meta.url)('playwright-core').chromium;

function candidates() {
  const out = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) out.push(process.env[k]);
  out.push('E:\\AIProMax\\Y2026M10\\chrome-pin-155.0.8059.40\\chrome.exe');
  out.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  out.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  return out.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// ---- PNG 解码(8bit, 非隔行)-----------------------------------------------
function decodePNG(buf) {
  let p = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bitDepth ' + bitDepth);
  const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    const ft = raw[base];
    const line = raw.subarray(base + 1, base + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { w, h, ch, data: out };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function px(img, x, y) {
  const i = (y * img.w + x) * img.ch;
  const d = img.data;
  return [d[i], d[i + 1], d[i + 2]];
}
function regionNonBlack(img, x0, y0, x1, y1, thr) {
  let n = 0, hit = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      const [r, g, b] = px(img, x, y);
      n++;
      if (Math.max(r, g, b) > thr) hit++;
    }
  }
  return { ratio: n ? hit / n : 0, n };
}
function regionLumNonBlack(img, x0, y0, x1, y1, thr) {
  let n = 0, hit = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      const [r, g, b] = px(img, x, y);
      n++;
      if (lum(r, g, b) > thr) hit++;
    }
  }
  return { ratio: n ? hit / n : 0, n };
}
function diffRatio(a, b, x0, y0, x1, y1, thr) {
  let n = 0, hit = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(a.w, x1); x++) {
      const [r1, g1, b1] = px(a, x, y);
      const [r2, g2, b2] = px(b, x, y);
      n++;
      if (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) > thr) hit++;
    }
  }
  return { ratio: n ? hit / n : 0, n };
}

// ---- P3 口径:方位角扇区(±6% 高度带,内 0.06–0.14 minD / 外 0.18–0.30 minD)
function azimuthBand(img, side, r0, r1) {
  const minD = Math.min(img.w, img.h);
  const cx = img.w / 2, cy = img.h / 2;
  const y0 = Math.round(cy - 0.06 * minD), y1 = Math.round(cy + 0.06 * minD);
  const a0 = Math.round(r0 * minD), a1 = Math.round(r1 * minD);
  let sr = 0, sg = 0, sb = 0, sl = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let d = a0; d <= a1; d++) {
      const x = Math.round(cx + side * d);
      if (x < 0 || x >= img.w || y < 0 || y >= img.h) continue;
      const [r, g, b] = px(img, x, y);
      sr += r; sg += g; sb += b; sl += lum(r, g, b); n++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n, rb: (sr - sb) / n, luma: sl / n, n };
}

// ---- P4 口径:沿水平中线的暗核半径 / 盘外缘半径
function radialProfile(img) {
  const cx = Math.round(img.w / 2), cy = Math.round(img.h / 2);
  const scan = (dir) => {
    const prof = [];
    for (let d = 0; d < Math.min(cx, img.w - cx); d++) {
      const x = cx + dir * d;
      const [r, g, b] = px(img, x, cy);
      prof.push(lum(r, g, b));
    }
    return prof;
  };
  const analyse = (prof) => {
    let core = 0;
    while (core < prof.length && prof[core] < 55) core++;
    let outer = prof.length - 1;
    while (outer > core && prof[outer] < 22) outer--;
    // 暗核内平均亮度(半径 0–0.05 minD)
    const k = Math.round(0.05 * Math.min(img.w, img.h));
    let s = 0;
    for (let i = 0; i < Math.min(k, prof.length); i++) s += prof[i];
    return { coreRadius: core, outerRadius: outer, coreLuma: s / Math.min(k, prof.length) };
  };
  return { right: analyse(scan(1)), left: analyse(scan(-1)) };
}

// ---- 主流程 ----------------------------------------------------------------
const res = { url: PAGE_URL, steps: {} };
let browser = null;
let exitCode = 0;
try {
  let launched = null;
  for (const exe of candidates()) {
    try {
      launched = await chromium.launch({ executablePath: exe, headless: true, viewport: { width: 1280, height: 720 } });
      res.browser = exe;
      break;
    } catch (e) { /* 下一个候选 */ }
  }
  if (!launched) throw new Error('no usable browser');
  browser = launched;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message || e).slice(0, 200)));

  const t0 = Date.now();
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
  res.readyMs = Date.now() - t0;
  res.consoleErrors = errors;

  const shot = async (name) => {
    const buf = await page.screenshot();
    fs.writeFileSync(path.join(OUT, name + '.png'), buf);
    return decodePNG(buf);
  };
  const state = () => page.evaluate(() => window.__bench.getState());

  // P1
  await page.waitForTimeout(2500);
  const s1 = await state();
  const i1 = await shot('p1');
  res.steps.p1 = { state: s1, img: i1 };

  // P2
  await page.waitForTimeout(800);
  const s2 = await state();
  const i2 = await shot('p2');
  res.steps.p2 = { state: s2, img: i2 };

  // P3
  await page.waitForTimeout(1000);
  const s3 = await state();
  const i3 = await shot('p3');
  res.steps.p3 = { state: s3, img: i3 };

  // P4
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1200);
  const s4 = await state();
  const i4 = await shot('p4');
  res.steps.p4 = { state: s4, img: i4 };

  // P5
  await page.waitForTimeout(1000);
  const s5 = await state();
  const i5 = await shot('p5');
  res.steps.p5 = { state: s5, img: i5 };

  // P6(reset 按钮:点元素中心)
  const btn = await page.$('[data-ui="reset"]');
  const box = btn ? await btn.boundingBox() : null;
  if (btn) await btn.click();
  await page.waitForTimeout(400);
  const s6 = await state();
  const i6 = await shot('p6');
  res.steps.p6 = { state: s6, img: i6, resetButtonBox: box };

  // ---- 判定 ----
  const W = i1.w, H = i1.h;
  const p1center = regionNonBlack(i1, Math.round(W / 3), Math.round(H / 3), Math.round(2 * W / 3), Math.round(2 * H / 3), 10);
  const cornerW = Math.round(W * 0.25), cornerH = Math.round(H * 0.25);
  let cornerHits = 0, cornerN = 0, cornerMaxChannel = 0, cornerLumHits = 0;
  for (const [x0, y0] of [[0, 0], [W - cornerW, 0], [0, H - cornerH], [W - cornerW, H - cornerH]]) {
    const a = regionNonBlack(i1, x0, y0, x0 + cornerW, y0 + cornerH, 10);
    cornerHits += a.ratio * a.n; cornerN += a.n;
    const b = regionLumNonBlack(i1, x0, y0, x0 + cornerW, y0 + cornerH, 8);
    cornerLumHits += b.ratio * b.n;
    for (let y = y0; y < y0 + cornerH; y += 7) for (let x = x0; x < x0 + cornerW; x += 7) {
      const [r, g, b2] = px(i1, x, y); cornerMaxChannel = Math.max(cornerMaxChannel, r, g, b2);
    }
  }
  res.p1 = {
    centerThird: p1center.ratio,
    centerThirdLum: regionLumNonBlack(i1, Math.round(W / 3), Math.round(H / 3), Math.round(2 * W / 3), Math.round(2 * H / 3), 8).ratio,
    outerCorners: cornerHits / cornerN,
    outerCornersLum: cornerLumHits / cornerN,
    cornerMaxChannelSample: cornerMaxChannel,
  };

  const diskRect = [Math.round(W * 0.2), Math.round(H * 0.25), Math.round(W * 0.8), Math.round(H * 0.75)];
  res.p2 = {
    dRot: s2.diskRotation - s1.diskRotation,
    dtSec: 0.8,
    diff: diffRatio(i1, i2, ...diskRect, 18).ratio,
  };

  const sideR = { inner: azimuthBand(i3, 1, 0.06, 0.14), outer: azimuthBand(i3, 1, 0.18, 0.30) };
  const sideL = { inner: azimuthBand(i3, -1, 0.06, 0.14), outer: azimuthBand(i3, -1, 0.18, 0.30) };
  const pick = sideR.outer.rb >= sideL.outer.rb ? { side: 'right', ...sideR } : { side: 'left', ...sideL };
  res.p3 = {
    right: sideR, left: sideL, pickedSide: pick.side,
    outerInnerRBDiff: pick.outer.rb - pick.inner.rb,
    innerLuma: pick.inner.luma, outerLuma: pick.outer.luma,
    ratioLuma: pick.inner.luma / Math.max(pick.outer.luma, 1e-6),
  };

  const profBefore = radialProfile(i3);
  const profAfter = radialProfile(i4);
  res.p4 = {
    state: s4.cameraDistance,
    before: profBefore, after: profAfter,
    coreScale: profAfter.right.coreRadius / Math.max(profBefore.right.coreRadius, 1),
    diskScale: profAfter.right.outerRadius / Math.max(profBefore.right.outerRadius, 1),
  };

  res.p5 = { diffMidRing: diffRatio(i3, i5, ...diskRect, 18).ratio, count: s5.starStreamCount };

  res.p6 = {
    state: { d: s6.cameraDistance, rot: s6.diskRotation, phase: s6.accretionPhase, stream: s6.starStreamCount },
    nonBlankFull: regionNonBlack(i6, 0, 0, W, H, 10).ratio,
  };

  // ---- 汇总判定 ----
  const pass = {
    p1: s1.backgroundStarCount >= 300 && s1.starStreamCount >= 200 &&
        s1.cameraDistance >= 13 && s1.cameraDistance <= 15 && s1.diskRotation > 0 &&
        res.p1.centerThird >= 0.05 && res.p1.outerCorners >= 0.01,
    p2: s2.diskRotation > 0.05 && res.p2.dRot >= 0.1 && res.p2.diff > 0.01,
    p3: s3.accretionPhase >= 0 && s3.accretionPhase < 1 && res.p3.outerInnerRBDiff >= 18,
    p4: s4.cameraDistance < 10 && s4.cameraDistance >= 5 &&
        (res.p4.coreScale >= 1.25 || res.p4.diskScale >= 1.2),
    p5: s5.starStreamCount >= 200 && res.p5.diffMidRing > 0.002,
    p6: s6.cameraDistance >= 13.5 && s6.cameraDistance <= 14.5 && s6.diskRotation < 0.3 &&
        s6.accretionPhase < 0.1 && s6.starStreamCount >= 200 && res.p6.nonBlankFull > 0.02,
  };
  res.verdict = pass;
} catch (e) {
  res.error = String(e && e.stack || e).slice(0, 800);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}

const brief = {
  readyMs: res.readyMs,
  consoleErrors: res.consoleErrors,
  verdict: res.verdict,
  p1: res.p1,
  p2: res.p2,
  p3: res.p3 && {
    picked: res.p3.pickedSide, diff: +res.p3.outerInnerRBDiff.toFixed(1),
    inner: { rb: +res.p3.right.inner.rb.toFixed(1), luma: +res.p3.right.inner.luma.toFixed(1) },
    outer: { rb: +res.p3.right.outer.rb.toFixed(1), luma: +res.p3.right.outer.luma.toFixed(1) },
    leftInnerRb: +res.p3.left.inner.rb.toFixed(1), leftOuterRb: +res.p3.left.outer.rb.toFixed(1),
    lumaRatio: +res.p3.ratioLuma.toFixed(2),
  },
  p4: res.p4 && {
    dist: +res.p4.state.toFixed(2),
    coreBefore: res.p4.before.right.coreRadius, coreAfter: res.p4.after.right.coreRadius,
    diskBefore: res.p4.before.right.outerRadius, diskAfter: res.p4.after.right.outerRadius,
    coreLumaBefore: +res.p4.before.right.coreLuma.toFixed(1),
  },
  p5: res.p5,
  p6: res.p6,
  error: res.error,
};
console.log('[selfcheck] ' + JSON.stringify(brief));
fs.writeFileSync(path.join(ROOT, 'shots', 'selfcheck.json'), JSON.stringify(res, (k, v) => (k === 'img' ? undefined : v), 2));
process.exit(exitCode);
