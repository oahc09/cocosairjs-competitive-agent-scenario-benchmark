#!/usr/bin/env node
// ============================================================================
// probe-verify.mjs — E02 场景探针自检(Arm 自用,非 harness)
// ----------------------------------------------------------------------------
// 按 spec.json 的 P1..P7 逐条自查:状态断言 + 像素/网络/DOM 观测证据。
// 前置:dist 已构建;serve.mjs 已监听 PORT(本 Arm 合同指定 7103)。
// 退出码:全部通过 0;否则 1。截图存 .tmp/shots/。
// ============================================================================

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '7103';
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const SHOTS = path.join(root, '.tmp', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// --- 零依赖 PNG 解码(同 smoke-verify)-----------------------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
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

// --- 区域与指标 ----------------------------------------------------------------
function regionRect(img, region) {
  if (region === 'full') return { x0: 0, y0: 0, x1: img.width, y1: img.height };
  if (region === 'lower:60%') return { x0: 0, y0: Math.floor(img.height * 0.4), x1: img.width, y1: img.height };
  if (region === 'center:40%')
    return {
      x0: Math.floor(img.width * 0.3), y0: Math.floor(img.height * 0.3),
      x1: Math.ceil(img.width * 0.7), y1: Math.ceil(img.height * 0.7),
    };
  throw new Error(`unknown region ${region}`);
}
function nonBlankRatio(img, region) {
  const r = regionRect(img, region);
  let total = 0, lit = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * img.width + x) * 4;
      total += 1;
      if (img.pixels[i] > 10 || img.pixels[i + 1] > 10 || img.pixels[i + 2] > 10) lit += 1;
    }
  return lit / total;
}
function diffRatio(imgA, imgB, region, thr) {
  const r = regionRect(imgA, region);
  let total = 0, diff = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * imgA.width + x) * 4;
      total += 1;
      const d =
        Math.abs(imgA.pixels[i] - imgB.pixels[i]) +
        Math.abs(imgA.pixels[i + 1] - imgB.pixels[i + 1]) +
        Math.abs(imgA.pixels[i + 2] - imgB.pixels[i + 2]);
      if (d > thr) diff += 1;
    }
  return diff / total;
}
function avgColorShift(imgA, imgB) {
  let sumR = 0, sumG = 0, sumB = 0;
  const n = imgA.width * imgA.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sumR += Math.abs(imgA.pixels[o] - imgB.pixels[o]);
    sumG += Math.abs(imgA.pixels[o + 1] - imgB.pixels[o + 1]);
    sumB += Math.abs(imgA.pixels[o + 2] - imgB.pixels[o + 2]);
  }
  return (sumR / n + sumG / n + sumB / n) / 3;
}
function avgColor(img) {
  let r = 0, g = 0, b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r += img.pixels[o]; g += img.pixels[o + 1]; b += img.pixels[o + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

// --- 运行 ----------------------------------------------------------------------
function findExecutable() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
const exe = findExecutable();
if (!exe) { console.error('PROBE_FAIL: no chrome executable'); process.exit(1); }
console.log(`[probe] executable: ${exe}`);
console.log(`[probe] page: ${PAGE_URL}`);

const COMBOS = [
  { label: 'no-extra-args', args: [] },
  { label: 'enable-unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  { label: 'use-angle-swiftshader', args: ['--use-angle=swiftshader'] },
];

let lastErr = null;
outer:
for (const combo of COMBOS) {
  console.log(`\n[probe] === launch: ${combo.label} ===`);
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, executablePath: exe, args: combo.args });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const consoleErrors = [];
    let navCount = 0;
    const boatResponses = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navCount += 1; });
    page.on('response', (r) => {
      if (r.url().includes('boat.glb')) boatResponses.push({ url: r.url(), status: r.status() });
    });

    const results = [];
    const check = (id, name, ok, detail) => {
      results.push({ id, name, ok });
      console.log(`  ${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? ' — ' + detail : ''}`);
    };
    const getState = () => page.evaluate(() => window.__bench.getState());
    const shot = async (name) => {
      const b = await page.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), b);
      return decodePng(b);
    };

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 10000 });

    // ---- P1: 就绪 + 资产 + 网络请求 + 非空白 ----
    const t0 = Date.now();
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
    const readyMs = Date.now() - t0;
    await page.waitForTimeout(1500);
    const s1 = await getState();
    const p1img = await shot('p1');
    check('P1', 'appReady within 10s', readyMs < 10000, `${readyMs}ms`);
    check('P1', 'assetLoaded && assetRequests>=1', s1.assetLoaded === true && s1.assetRequests >= 1, JSON.stringify({ assetLoaded: s1.assetLoaded, assetRequests: s1.assetRequests }));
    check('P1', 'network boat.glb 200', boatResponses.filter((r) => r.status === 200).length >= 1, JSON.stringify(boatResponses));
    check('P1', 'nonBlank full >= 5%', nonBlankRatio(p1img, 'full') >= 0.05, `lit=${(nonBlankRatio(p1img, 'full') * 100).toFixed(2)}%`);
    const avg1 = avgColor(p1img);
    console.log(`  [P1] avgColor R=${avg1.r.toFixed(1)} G=${avg1.g.toFixed(1)} B=${avg1.b.toFixed(1)} (warm: expect R>B)`);

    // ---- P2: 海面持续运动 + wavePhase 推进 ----
    await page.waitForTimeout(500);
    const s2a = await getState();
    const p2a = await shot('p2a');
    await page.waitForTimeout(1500);
    const s2b = await getState();
    const p2b = await shot('p2b');
    check('P2', 'wavePhase changes', s2b.wavePhase !== s2a.wavePhase, `${s2a.wavePhase.toFixed(3)} -> ${s2b.wavePhase.toFixed(3)}`);
    const m2 = diffRatio(p2a, p2b, 'lower:60%', 8);
    check('P2', 'motion lower:60% >= 1%', m2 >= 0.01, `motion=${(m2 * 100).toFixed(2)}%`);

    // ---- P3: 船体竖直坐标变化 + 中央运动 + 4s 极差 ----
    await page.waitForTimeout(300);
    const s3a = await getState();
    const p3a = await shot('p3a');
    await page.waitForTimeout(900);
    const s3b = await getState();
    const p3b = await shot('p3b');
    check('P3', 'boatPosition.y changes', s3b.boatPosition.y !== s3a.boatPosition.y, `${s3a.boatPosition.y.toFixed(4)} -> ${s3b.boatPosition.y.toFixed(4)}`);
    const m3 = diffRatio(p3a, p3b, 'center:40%', 8);
    check('P3', 'motion center:40% >= 0.2%', m3 >= 0.002, `motion=${(m3 * 100).toFixed(3)}%`);
    const series = [];
    const tSer = Date.now();
    while (Date.now() - tSer < 4000) {
      const s = await getState();
      series.push(s.boatPosition.y);
      await page.waitForTimeout(200);
    }
    const range = Math.max(...series) - Math.min(...series);
    check('P3', 'boatY range(4s) >= 0.02', range >= 0.02, `range=${range.toFixed(4)}`);

    // ---- P4: 拖拽环绕 ----
    const s4pre = await getState();
    const p4pre = await shot('p4pre');
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(998, 360, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const s4a = await getState();
    const p4a = await shot('p4a');
    await page.waitForTimeout(200);
    const s4b = await getState();
    const p4b = await shot('p4b');
    const dWindow = Math.abs(s4b.cameraAzimuth - s4a.cameraAzimuth);
    const dAction = Math.abs(s4b.cameraAzimuth - s4pre.cameraAzimuth);
    check('P4', 'azimuth delta > 20deg', dWindow > 20 || dAction > 20, `window=${dWindow.toFixed(2)} actionTotal=${dAction.toFixed(2)}`);
    const dPixWindow = diffRatio(p4a, p4b, 'full', 8);
    const dPixAction = diffRatio(p4pre, p4b, 'full', 8);
    check('P4', 'pixelDelta full >= 2%', dPixWindow >= 0.02 || dPixAction >= 0.02, `window=${(dPixWindow * 100).toFixed(2)}% action=${(dPixAction * 100).toFixed(2)}%`);

    // ---- P5: 色调切换 ----
    const p5a = await shot('p5a_warm');
    await page.click('button[data-ui="tone-toggle"]');
    await page.waitForTimeout(2500);
    const s5 = await getState();
    const p5b = await shot('p5b_cool');
    check('P5', 'toneMix > 0.7 after 2.5s', s5.toneMix > 0.7, `toneMix=${s5.toneMix}`);
    const shift = avgColorShift(p5a, p5b);
    check('P5', 'avgColorShift >= 8', shift >= 8, `shift=${shift.toFixed(2)}`);
    const avg5w = avgColor(p5a), avg5c = avgColor(p5b);
    console.log(`  [P5] warm avg R=${avg5w.r.toFixed(1)} B=${avg5w.b.toFixed(1)} | cool avg R=${avg5c.r.toFixed(1)} B=${avg5c.b.toFixed(1)}`);
    check('P5', 'warm R>B and cool B>warm B', avg5w.r > avg5w.b && avg5c.b > avg5w.b, `warmR-warmB=${(avg5w.r - avg5w.b).toFixed(1)} coolB-warmB=${(avg5c.b - avg5w.b).toFixed(1)}`);

    // ---- P6: Reset #1 ----
    const memBefore = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
    await page.click('button[data-ui="reset"]');
    await page.waitForTimeout(3000);
    const s6 = await getState();
    const p6img = await shot('p6');
    check('P6', 'epoch>=1 && assetLoaded && tone<0.05 && az in [32,38]',
      s6.epoch >= 1 && s6.assetLoaded === true && s6.toneMix < 0.05 && s6.cameraAzimuth >= 32 && s6.cameraAzimuth <= 38,
      JSON.stringify({ epoch: s6.epoch, assetLoaded: s6.assetLoaded, toneMix: s6.toneMix, cameraAzimuth: s6.cameraAzimuth }));
    check('P6', 'nonBlank full >= 5%', nonBlankRatio(p6img, 'full') >= 0.05, `lit=${(nonBlankRatio(p6img, 'full') * 100).toFixed(2)}%`);
    check('P6', 'boat.glb reloaded', boatResponses.filter((r) => r.status === 200).length >= 2, JSON.stringify(boatResponses));
    check('P6', 'no navigation', navCount === 1, `navCount=${navCount}`);

    // ---- P7: Reset #2 ----
    await page.click('button[data-ui="reset"]');
    await page.waitForTimeout(3000);
    const s7 = await getState();
    const p7img = await shot('p7');
    const memAfter = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
    check('P7', 'epoch>=2 && assetLoaded && assetRequests>=2 && tone<0.05',
      s7.epoch >= 2 && s7.assetLoaded === true && s7.assetRequests >= 2 && s7.toneMix < 0.05,
      JSON.stringify({ epoch: s7.epoch, assetLoaded: s7.assetLoaded, assetRequests: s7.assetRequests, toneMix: s7.toneMix }));
    check('P7', 'nonBlank full >= 5%', nonBlankRatio(p7img, 'full') >= 0.05, `lit=${(nonBlankRatio(p7img, 'full') * 100).toFixed(2)}%`);
    console.log(`  [P7] memory usedJSHeapSize: ${(memBefore / 1048576).toFixed(1)}MB -> ${(memAfter / 1048576).toFixed(1)}MB`);

    // ---- 全程无未捕获异常 / fps ----
    const fps = (await getState()).fps;
    check('Z', 'no console errors / pageerrors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));
    check('Z', 'fps >= 30 (2s rolling avg)', fps >= 30, `fps=${fps}`);

    await browser.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n[probe] ${combo.label}: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length === 0) {
      console.log('PROBE_OK');
      process.exit(0);
    }
    console.log('PROBE_FAIL ' + JSON.stringify(failed.map((f) => f.id + ':' + f.name)));
    process.exit(1);
  } catch (e) {
    lastErr = e;
    console.log(`  ERROR ${e && e.message ? e.message : String(e)}`);
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}
console.error(`\nPROBE_FAIL: all launch combos failed; last: ${lastErr && lastErr.message}`);
process.exit(1);
