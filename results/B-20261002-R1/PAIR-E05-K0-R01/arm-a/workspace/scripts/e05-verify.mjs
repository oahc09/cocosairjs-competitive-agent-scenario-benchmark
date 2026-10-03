#!/usr/bin/env node
// ============================================================================
// e05-verify.mjs — E05 场景 Agent 自检(Arm 自有验证脚本,非 harness 代码)
// ----------------------------------------------------------------------------
// 按 spec.json 的 6 个探针自查:state 断言 + 像素/运动独立证据。
// 前置:dist 已构建;serve.mjs 已监听 PORT(默认 7104)。
// 退出码:全部通过 0;否则 1。截图存 .tmp/e05-*.png。
// ============================================================================

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '7104';
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const OUT = path.join(root, '.tmp');
fs.mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findExecutable() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

// --- 零依赖 PNG 解码(同模板 smoke-verify) ------------------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
      out[o + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, pixels: out };
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
};
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const isLit = (c, th = 10) => c[0] > th || c[1] > th || c[2] > th;

// 区域非黑占比
function regionNonBlack(img, x0, y0, x1, y1, th = 10) {
  let total = 0, lit = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { total++; if (isLit(px(img, x, y), th)) lit++; }
  return lit / total;
}

// 环形带统计:平均亮度 / 平均 R-B / 非黑占比
function annulusStats(img, cx, cy, r0, r1) {
  let n = 0, sL = 0, sRB = 0, lit = 0, maxL = 0;
  for (let y = Math.max(0, Math.floor(cy - r1)); y < Math.min(img.height, Math.ceil(cy + r1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r1)); x < Math.min(img.width, Math.ceil(cx + r1)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < r0 || d >= r1) continue;
      const c = px(img, x, y);
      n++; sL += lum(c); sRB += c[0] - c[2]; if (isLit(c)) lit++;
      if (lum(c) > maxL) maxL = lum(c);
    }
  }
  return { n, avgL: sL / n, avgRB: sRB / n, litRatio: lit / n, maxL };
}

// 中心暗核半径:从中心向外扩圆,环上 >=85% 采样点亮度 < th 即视为该半径仍暗
// (容许零星前景星流粒子/噪点,不做单点否决)
function darkCoreRadius(img, cx, cy, th = 40, rMax = 200) {
  let r = 0;
  for (let rr = 2; rr <= rMax; rr += 2) {
    const steps = Math.max(24, Math.floor(rr * 6));
    let dark = 0;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * rr), y = Math.round(cy + Math.sin(a) * rr);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return r;
      if (lum(px(img, x, y)) < th) dark++;
    }
    if (dark / steps < 0.85) return r;
    r = rr;
  }
  return r;
}

// 两帧差分:区域内变化像素数(|ΔL|>12)
function frameDiff(a, b, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ca = px(a, x, y), cb = px(b, x, y);
    if (Math.abs(lum(ca) - lum(cb)) > 12) n++;
  }
  return n;
}

// --- 主流程 -------------------------------------------------------------------
const exe = findExecutable();
if (!exe) { console.error('E05_FAIL: no chrome executable'); process.exit(1); }

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`  [${id}] ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

const browser = await chromium.launch({ headless: true, executablePath: exe, args: [] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 10000 });

  // 统一契约:__appReady < 10s
  const t0 = Date.now();
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
  record('C', 'appReady<10s', true, `${Date.now() - t0}ms`);

  const W = 1280, H = 720, CX = W / 2, CY = H / 2;

  // ---------------- P1:初始画面非空、盘可见、暗核存在 ----------------
  await page.waitForTimeout(2500);
  {
    const s = await page.evaluate(() => window.__bench.getState());
    const stateOK = s.backgroundStarCount >= 300 && s.starStreamCount >= 200 &&
      s.cameraDistance >= 13 && s.cameraDistance <= 15 && s.diskRotation > 0;
    record('P1', 'state', stateOK, JSON.stringify(s));

    const shot = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, 'e05-p1.png'), shot);
    const img = decodePng(shot);
    const center = regionNonBlack(img, Math.floor(W / 3), Math.floor(H / 3), Math.ceil(W * 2 / 3), Math.ceil(H * 2 / 3));
    let corners = 0, cN = 0;
    for (const [x0, y0] of [[0, 0], [W - 160, 0], [0, H - 100], [W - 160, H - 100]]) {
      corners += regionNonBlack(img, x0, y0, x0 + 160, y0 + 100); cN++;
    }
    corners /= cN;
    const coreR = darkCoreRadius(img, CX, CY);
    const ringAroundCore = annulusStats(img, CX, CY, coreR + 8, coreR + 45);
    record('P1', 'visual', center >= 0.05 && corners >= 0.01 && coreR >= 15 && ringAroundCore.avgL > 25,
      `centerNonBlack=${(center * 100).toFixed(2)}%(>=5) corners=${(corners * 100).toFixed(2)}%(>=1) coreR=${coreR}px ringAvgL=${ringAroundCore.avgL.toFixed(1)}`);
  }

  // ---------------- P2:盘旋转运动证据 ----------------
  {
    const s1 = await page.evaluate(() => window.__bench.getState());
    const shotA = await page.screenshot({ type: 'png' });
    await page.waitForTimeout(800);
    const s2 = await page.evaluate(() => window.__bench.getState());
    const shotB = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, 'e05-p2-a.png'), shotA);
    fs.writeFileSync(path.join(OUT, 'e05-p2-b.png'), shotB);
    const dRot = s2.diskRotation - s1.diskRotation;
    record('P2', 'state', dRot >= 0.1 && s2.diskRotation > 0.05, `ΔdiskRotation=${dRot.toFixed(3)} rad / 0.8s (>=0.1)`);

    const A = decodePng(shotA), B = decodePng(shotB);
    // 盘面环形屏幕区域(椭圆盘覆盖区:取中心大环形区域水平半径 ~500px 内、垂直 ~330px)
    let diff = 0, tot = 0;
    for (let y = 60; y < H - 60; y += 2) for (let x = 140; x < W - 140; x += 2) {
      const dx = (x - CX) / 500, dy = (y - CY) / 330;
      const d = dx * dx + dy * dy;
      if (d < 0.04 || d > 1) continue; // 环形带(避开正中心暗核)
      tot++;
      if (Math.abs(lum(px(A, x, y)) - lum(px(B, x, y))) > 12) diff++;
    }
    record('P2', 'motion', diff >= 500, `disk-zone frameDiff changedPx=${diff}/${tot} (sampled, >=500)`);
  }

  // ---------------- P3:径向颜色梯度(环形采样) ----------------
  {
    const s = await page.evaluate(() => window.__bench.getState());
    record('P3', 'state', s.accretionPhase >= 0 && s.accretionPhase < 1, `accretionPhase=${s.accretionPhase.toFixed(4)}`);

    const shot = await page.screenshot({ type: 'png' });
    const img = decodePng(shot);
    // 内环带(暗核外亮环 ~55-130px)vs 外环带(盘外缘 ~230-320px)
    const inner = annulusStats(img, CX, CY, 55, 130);
    const outer = annulusStats(img, CX, CY, 230, 320);
    // 径向亮度单调性(自内环向外若干环带)
    const prof = [];
    for (let r = 60; r <= 340; r += 40) prof.push(annulusStats(img, CX, CY, r, r + 40).avgL);
    let monotonic = 0;
    for (let i = 1; i < prof.length; i++) if (prof[i] <= prof[i - 1] + 6) monotonic++;
    record('P3', 'visual',
      inner.avgL >= outer.avgL * 1.5 && outer.avgRB >= inner.avgRB + 10 && monotonic >= prof.length - 3,
      `innerL=${inner.avgL.toFixed(1)} outerL=${outer.avgL.toFixed(1)} ratio=${(inner.avgL / Math.max(outer.avgL, 0.1)).toFixed(2)}(>=1.5) innerRB=${inner.avgRB.toFixed(1)} outerRB=${outer.avgRB.toFixed(1)}(Δ>=10) radialDecay=${monotonic}/${prof.length - 1} prof=[${prof.map((v) => v.toFixed(0)).join(',')}]`);
  }

  // ---------------- P4:滚轮缩放 ----------------
  {
    const shotBefore = await page.screenshot({ type: 'png' });
    const before = decodePng(shotBefore);
    const coreBefore = darkCoreRadius(before, CX, CY);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => window.__bench.getState());
    const stateOK = s.cameraDistance < 10 && s.cameraDistance >= 5;
    const shotAfter = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, 'e05-p4-before.png'), shotBefore);
    fs.writeFileSync(path.join(OUT, 'e05-p4-after.png'), shotAfter);
    const after = decodePng(shotAfter);
    const coreAfter = darkCoreRadius(after, CX, CY);
    const ratio = coreAfter / Math.max(coreBefore, 1);
    record('P4', 'state', stateOK, `cameraDistance=${s.cameraDistance.toFixed(3)} (<10,>=5)`);
    record('P4', 'visual', ratio >= 1.25, `darkCoreR ${coreBefore}px -> ${coreAfter}px ratio=${ratio.toFixed(2)}x (>=1.25)`);
  }

  // ---------------- P5:星流螺旋运动 ----------------
  {
    const shotA = await page.screenshot({ type: 'png' });
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__bench.getState());
    const shotB = await page.screenshot({ type: 'png' });
    record('P5', 'state', s.starStreamCount >= 200, `starStreamCount=${s.starStreamCount}`);
    const A = decodePng(shotA), B = decodePng(shotB);
    fs.writeFileSync(path.join(OUT, 'e05-p5-a.png'), shotA);
    fs.writeFileSync(path.join(OUT, 'e05-p5-b.png'), shotB);
    // mid-ring:内缘与外缘之间的盘周区域
    let diff = 0, tot = 0;
    for (let y = 60; y < H - 60; y += 2) for (let x = 140; x < W - 140; x += 2) {
      const dx = (x - CX) / 500, dy = (y - CY) / 330;
      const d = dx * dx + dy * dy;
      if (d < 0.16 || d > 1) continue; // 中环带
      tot++;
      if (Math.abs(lum(px(A, x, y)) - lum(px(B, x, y))) > 12) diff++;
    }
    record('P5', 'motion', diff >= 400, `mid-ring frameDiff changedPx=${diff}/${tot} (sampled, >=400)`);
  }

  // ---------------- P6:reset ----------------
  {
    await page.click('[data-ui="reset"]');
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => window.__bench.getState());
    const stateOK = s.cameraDistance >= 13.5 && s.cameraDistance <= 14.5 &&
      s.diskRotation < 0.3 && s.accretionPhase < 0.1 && s.starStreamCount >= 200;
    record('P6', 'state', stateOK, JSON.stringify(s));
    const shot = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, 'e05-p6.png'), shot);
    const img = decodePng(shot);
    const full = regionNonBlack(img, 0, 0, W, H);
    const coreR = darkCoreRadius(img, CX, CY);
    record('P6', 'visual', full >= 0.02 && coreR >= 15, `fullNonBlack=${(full * 100).toFixed(2)}% coreR=${coreR}px (回到初始量级)`);
  }

  // 统一契约:无未捕获异常 / console error
  record('C', 'noConsoleErrors', consoleErrors.length === 0, consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : '0 errors');

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? '\nE05_ALL_PASS' : `\nE05_FAIL: ${failed.length} item(s)`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
} catch (e) {
  console.error('E05_FAIL:', e && e.message ? e.message : String(e));
  try { await browser.close(); } catch { /* ignore */ }
  process.exit(1);
}
