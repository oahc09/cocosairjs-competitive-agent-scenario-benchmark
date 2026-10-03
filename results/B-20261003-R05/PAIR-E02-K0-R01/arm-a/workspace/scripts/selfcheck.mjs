#!/usr/bin/env node
// ============================================================================
// selfcheck.mjs — E02 探针自检(单浏览器会话内跑完 spec.json P1–P7)
// ----------------------------------------------------------------------------
// 合同口径:创建浏览器会话前先执行 `node scripts/count.mjs browser`(§2 计数)。
// 用法: node scripts/selfcheck.mjs --url http://127.0.0.1:7120/ --out selfcheck
// 输出: 每个探针一行 PASS/FAIL + 汇总 JSON;退出码 0=全部通过。
// 像素断言: 内置 PNG 解码(Chrome 截图为 8bit RGBA/RGB)计算
//   litRatio(非空白)、motionRatio(运动像素)、diffRatio(像素差)、avgShift(平均色偏)。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--url') args.url = process.argv[++i];
  else if (process.argv[i] === '--out') args.out = process.argv[++i];
}
if (!args.url) { console.error('usage: selfcheck.mjs --url <u> [--out dir]'); process.exit(2); }
const OUT = path.resolve(__dirname, '..', args.out || 'selfcheck');
fs.mkdirSync(OUT, { recursive: true });

// ---------- ① browserAttempt 机器计数(先计后会话) ----------
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) { console.error('[selfcheck] browser 计数失败,拒绝开会话'); process.exit(1); }
process.stdout.write(counted.stdout);

// ---------- ② playwright-core ----------
const chromium = createRequire(import.meta.url)('playwright-core').chromium;
function browserCandidates() {
  const cands = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) cands.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return cands.filter(Boolean);
}
async function launchBrowser() {
  const errors = [];
  for (const exe of [null, ...browserCandidates()]) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try {
      return await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000 });
    } catch (e) { errors.push(`${exe || 'default'}: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('no usable browser: ' + errors.join(' | '));
}

// ---------- ③ PNG 解码(8bit RGB/RGBA) ----------
function decodePNG(buf) {
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported png depth=${bitDepth} color=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

// 区域:[x0,y0,x1,y1] 比例;full / lower:60% / center:40%
function regionRect(img, region) {
  const map = {
    full: [0, 0, 1, 1],
    lower60: [0, 0.4, 1, 1],
    center40: [0.3, 0.3, 0.7, 0.7],
  };
  const r = map[region] || map.full;
  return [Math.floor(r[0] * img.width), Math.floor(r[1] * img.height), Math.ceil(r[2] * img.width), Math.ceil(r[3] * img.height)];
}
function litRatio(img, region) {
  const [x0, y0, x1, y1] = regionRect(img, region);
  let lit = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * 4;
    total++;
    if (Math.max(img.data[o], img.data[o + 1], img.data[o + 2]) > 24) lit++;
  }
  return lit / total;
}
function diffRatio(a, b, region, thr = 16) {
  const [x0, y0, x1, y1] = regionRect(a, region);
  let diff = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * a.width + x) * 4;
    total++;
    if (Math.abs(a.data[o] - b.data[o]) > thr || Math.abs(a.data[o + 1] - b.data[o + 1]) > thr || Math.abs(a.data[o + 2] - b.data[o + 2]) > thr) diff++;
  }
  return diff / total;
}
function avgShift(a, b) {
  const [x0, y0, x1, y1] = regionRect(a, 'full');
  let sum = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * a.width + x) * 4;
    sum += (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])) / 3;
    total++;
  }
  return sum / total;
}
async function shot(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  return decodePNG(fs.readFileSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ④ 会话与探针 ----------
const results = [];
const consoleErrors = [];
const uncaught = [];
const netLog = [];
let browser = null;
let exitCode = 0;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => uncaught.push(String(e?.message || e).slice(0, 200)));
  page.on('response', (r) => { if (r.url().includes('boat.glb')) netLog.push({ status: r.status(), url: r.url().split('/').slice(-2).join('/') }); });

  await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
  const t0 = Date.now();
  while (Date.now() - t0 <= 10000) {
    const s = await page.evaluate(() => window.__appReady === true).catch(() => false);
    if (s) break;
    await sleep(200);
  }
  const ready = await page.evaluate(() => window.__appReady === true && !!(window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function'));
  const getState = () => page.evaluate(() => window.__bench.getState());
  const mem = () => page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1));
  function record(id, pass, detail) {
    results.push({ id, pass, detail });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
  }
  if (!ready) {
    record('READY', false, `__appReady/__bench 未就绪 (${Date.now() - t0}ms)`);
    throw new Error('page not ready');
  }
  record('READY', true, `__appReady=true 且 __bench 契约成立(${Date.now() - t0}ms)`);

  // P1 — 资产加载 + 非空白
  await sleep(1500);
  const s1 = await getState();
  const img1 = await shot(page, 'p1.png');
  const lit1 = litRatio(img1, 'full');
  record('P1', s1.assetLoaded === true && s1.assetRequests >= 1 && lit1 >= 0.05 && netLog.some((n) => n.status === 200),
    `assetLoaded=${s1.assetLoaded} assetRequests=${s1.assetRequests} litRatio=${lit1.toFixed(3)} net=${JSON.stringify(netLog)}`);

  // P2 — 海面持续波动(相位推进 + 下 60% 运动像素)
  const seaA = await shot(page, 'p2a.png');
  const s2b = await getState();
  await sleep(1500);
  const seaB = await shot(page, 'p2b.png');
  const s2a = await getState();
  const motion2 = diffRatio(seaA, seaB, 'lower60');
  record('P2', s2a.wavePhase !== s2b.wavePhase && motion2 >= 0.01,
    `wavePhase ${s2b.wavePhase} -> ${s2a.wavePhase} motion(lower60)=${motion2.toFixed(4)}`);

  // P3 — 船体随波起伏(y 变化 + 中心 40% 运动)
  const bA = await shot(page, 'p3a.png');
  const s3b = await getState();
  await sleep(900);
  const bB = await shot(page, 'p3b.png');
  const s3a = await getState();
  const motion3 = diffRatio(bA, bB, 'center40', 10);
  const dy = Math.abs(s3a.boatPosition.y - s3b.boatPosition.y);
  record('P3', dy > 0 && motion3 >= 0.002,
    `boatY ${s3b.boatPosition.y} -> ${s3a.boatPosition.y} (|dy|=${dy.toFixed(4)}) motion(center40)=${motion3.toFixed(4)}`);

  // P4 — 水平拖拽环绕(方位角 >= 20° + 构图改变)
  const s4b = await getState();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(998.4, 360, { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  const s4m = await getState(); // 严格口径:before(动作后 500ms)
  await sleep(200);
  const s4a = await getState(); // 严格口径:after(+200ms 窗)
  const totalAz = Math.abs(s4a.cameraAzimuth - s4b.cameraAzimuth);
  const winAz = Math.abs(s4a.cameraAzimuth - s4m.cameraAzimuth);
  const img4 = await shot(page, 'p4.png');
  const diff4 = diffRatio(img1, img4, 'full');
  record('P4', totalAz > 20 && diff4 >= 0.02,
    `az ${s4b.cameraAzimuth} -> ${s4m.cameraAzimuth} -> ${s4a.cameraAzimuth} (windowΔ=${winAz.toFixed(1)}, totalΔ=${totalAz.toFixed(1)}) diff(full)=${diff4.toFixed(3)}`);

  // P5 — 色调切换(暖->冷,2.5s 内 toneMix>0.7 + 平均色偏 >= 8)
  const img5a = await shot(page, 'p5a.png');
  await page.click('button[data-ui="tone-toggle"]');
  await sleep(2500);
  const s5 = await getState();
  const img5b = await shot(page, 'p5b.png');
  const shift5 = avgShift(img5a, img5b);
  record('P5', s5.toneMix > 0.7 && shift5 >= 8,
    `toneMix=${s5.toneMix} avgColorShift=${shift5.toFixed(1)}/255`);

  // P6 — Reset 释放并重建
  const urlBefore = page.url();
  const memBefore = await mem();
  await page.click('button[data-ui="reset"]');
  await sleep(3000);
  const s6 = await getState();
  const img6 = await shot(page, 'p6.png');
  const lit6 = litRatio(img6, 'full');
  const navOk = page.url() === urlBefore;
  record('P6', s6.epoch >= 1 && s6.assetLoaded === true && s6.toneMix < 0.05 && s6.cameraAzimuth >= 32 && s6.cameraAzimuth <= 38 && lit6 >= 0.05 && navOk && uncaught.length === 0,
    `epoch=${s6.epoch} assetLoaded=${s6.assetLoaded} toneMix=${s6.toneMix} az=${s6.cameraAzimuth} lit=${lit6.toFixed(3)} navSame=${navOk} uncaught=${uncaught.length}`);

  // P7 — 连续第二次 reset 稳定
  await page.click('button[data-ui="reset"]');
  await sleep(3000);
  const s7 = await getState();
  const img7 = await shot(page, 'p7.png');
  const lit7 = litRatio(img7, 'full');
  const memAfter = await mem();
  record('P7', s7.epoch >= 2 && s7.assetLoaded === true && s7.assetRequests >= 2 && s7.toneMix < 0.05 && lit7 >= 0.05 && uncaught.length === 0,
    `epoch=${s7.epoch} assetRequests=${s7.assetRequests} toneMix=${s7.toneMix} lit=${lit7.toFixed(3)} heap ${Math.round(memBefore / 1e6)}MB -> ${Math.round(memAfter / 1e6)}MB`);

  // 附加 — 色调可反向切换(reset 后 toneTarget=0,连点两次 0->1->0)/ fps / UI 定位 / console 清洁
  await page.click('button[data-ui="tone-toggle"]');
  await sleep(2500);
  const s8a = await getState();
  await page.click('button[data-ui="tone-toggle"]');
  await sleep(2500);
  const s8 = await getState();
  record('P8-tone-back', s8a.toneMix > 0.7 && s8.toneMix < 0.3, `往返切换 toneMix ${s8a.toneMix} -> ${s8.toneMix}`);
  const ui = await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const t = document.querySelector('[data-ui="tone-toggle"]');
    const r = document.querySelector('[data-ui="reset"]');
    return { tone: t ? { aria: t.getAttribute('aria-label'), text: t.textContent, visible: rect(t) } : null, reset: r ? { aria: r.getAttribute('aria-label'), text: r.textContent, visible: rect(r) } : null };
  });
  record('UI', !!(ui.tone && ui.reset && ui.tone.visible && ui.reset.visible && /tone/i.test(ui.tone.text) && /reset/i.test(ui.reset.text)),
    `tone=${JSON.stringify(ui.tone)} reset=${JSON.stringify(ui.reset)}`);
  const sFps = await getState();
  record('FPS', sFps.fps >= 30, `fps(2s 滚动平均)=${sFps.fps}`);
  record('CONSOLE', consoleErrors.length === 0 && uncaught.length === 0,
    `consoleErrors=${consoleErrors.length} uncaught=${uncaught.length} ${consoleErrors.concat(uncaught).join(' | ')}`);
  record('NETWORK', netLog.filter((n) => n.status === 200).length >= 1, `boat.glb 请求记录=${JSON.stringify(netLog)}`);
} catch (e) {
  console.error('[selfcheck] 异常终止: ' + (e?.message || e));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
const allPass = results.length > 0 && results.every((r) => r.pass);
console.log('[selfcheck-summary] ' + JSON.stringify({ allPass, pass: results.filter((r) => r.pass).length, total: results.length, consoleErrors, uncaught, netLog }, null, 0));
if (!allPass || uncaught.length > 0) exitCode = 1;
process.exit(exitCode);
