#!/usr/bin/env node
// ============================================================================
// selfcheck-probes.mjs — E04 场景探针自检(Agent 自检口径,非 harness 判定)
// ----------------------------------------------------------------------------
// 按 spec.json 的 P1-P8 时序在真实浏览器会话中逐条自查:
//   每个探针 = 状态断言(getState)+ 独立可观证据(像素差分/亮像素计数/交互)。
// 用法: node scripts/selfcheck-probes.mjs --url <u> [--outdir <dir>]
// 预算: 会话创建前先执行 count.mjs browser(RUN-CONTRACT §2 计数口径)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--url') args.url = process.argv[++i];
  else if (process.argv[i] === '--outdir') args.outdir = process.argv[++i];
}
if (!args.url) {
  console.error('usage: node scripts/selfcheck-probes.mjs --url <u> [--outdir <dir>]');
  process.exit(2);
}
const OUT = path.resolve(args.outdir || path.join(__dirname, '..', '..', 'selfcheck'));
fs.mkdirSync(OUT, { recursive: true });

// --- ① browserAttempt 机器计数(先计后会话) ---
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[selfcheck] browser 计数失败,拒绝创建会话:\n' + (counted.stdout || '') + (counted.stderr || ''));
  process.exit(1);
}
process.stdout.write(counted.stdout);

// --- ② playwright-core 会话(浏览器可执行文件候选与 verify-browser 同构) ---
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright-core');
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
    } catch (e) {
      errors.push(`${exe || 'playwright-default'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('no usable browser (tried: ' + errors.join(' | ') + ')');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
let browser = null;
let passCount = 0;

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  if (pass) passCount++;
  console.log(`[selfcheck] ${id}: ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(detail)}`);
}

try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(30000);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e?.message || e).slice(0, 300)));

  await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
  const t0 = Date.now();
  while (Date.now() - t0 <= 10000) {
    if (await page.evaluate(() => window.__appReady === true)) break;
    await sleep(200);
  }
  const ready = await page.evaluate(() => window.__appReady === true &&
    !!(window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function'));
  if (!ready) throw new Error('__appReady/__bench 未就绪');

  // 页内像素证据工具:WebGL canvas → 2D 快照(A/B 两缓冲差分 + 区域统计)
  await page.evaluate(() => {
    const W = 1280, H = 720;
    const cvs = document.getElementById('app-canvas');
    let A = null, B = null;
    function grab() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(cvs, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    }
    window.__px = {
      a() { A = grab(); return 1; },
      b() { B = grab(); return 1; },
      diff(x0, y0, x1, y1, thr = 14) {
        if (!A || !B) return null;
        const X0 = Math.round(x0 * W), X1 = Math.round(x1 * W), Y0 = Math.round(y0 * H), Y1 = Math.round(y1 * H);
        let ch = 0;
        const tot = Math.max(1, (X1 - X0) * (Y1 - Y0));
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
          const i = (y * W + x) * 4;
          if (Math.abs(A[i] - B[i]) > thr || Math.abs(A[i + 1] - B[i + 1]) > thr || Math.abs(A[i + 2] - B[i + 2]) > thr) ch++;
        }
        return { changed: ch, total: tot, ratio: +(ch / tot).toFixed(5) };
      },
      warmBottom() { // bottom-third 暖色像素计数(P1 阈值 >= 80)
        if (!A) return null;
        let n = 0;
        const Y0 = Math.round(H * 2 / 3);
        for (let y = Y0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4, r = A[i], g = A[i + 1], b = A[i + 2];
          if (r > 90 && r > b + 30 && g > 50 && g < r + 50) n++;
        }
        return n;
      },
      bright(x0, y0, x1, y1, lum = 360) { // 区域亮像素计数
        if (!A) return null;
        let n = 0;
        const X0 = Math.round(x0 * W), X1 = Math.round(x1 * W), Y0 = Math.round(y0 * H), Y1 = Math.round(y1 * H);
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
          const i = (y * W + x) * 4;
          if (A[i] + A[i + 1] + A[i + 2] > lum) n++;
        }
        return n;
      },
      skyNonBlack() { // 上部夜空非纯黑像素(渐变+星点)
        if (!A) return null;
        let n = 0;
        for (let y = 0; y < Math.round(H * 0.35); y += 2) for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          if (A[i] + A[i + 1] + A[i + 2] > 30) n++;
        }
        return n;
      },
    };
  });

  const S = () => page.evaluate(() => window.__bench.getState());
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  /* ---------- P1 初始夜景 ---------- */
  await sleep(2500);
  const s1 = await S();
  await page.evaluate(() => window.__px.a());
  const p1warm = await page.evaluate(() => window.__px.warmBottom());
  const p1sky = await page.evaluate(() => window.__px.skyNonBlack());
  await shot('p1-initial.png');
  record('P1', s1.buildingCount >= 24 && s1.fireworkCount === 0 && s1.autoShow === false && s1.enabled === true &&
    p1warm >= 80 && p1sky > 500,
    { state: s1, warmBottomPixels: p1warm, skyNonBlack: p1sky });

  /* ---------- P2 点击发射(尾迹运动) ---------- */
  await page.mouse.click(640, 216); // 归一化 {x:0.5, y:0.30}
  await sleep(250);
  await page.evaluate(() => window.__px.a());
  await sleep(200);
  await page.evaluate(() => window.__px.b());
  const p2diff = await page.evaluate(() => window.__px.diff(0.4, 0.15, 0.6, 0.85));
  const p2base = await page.evaluate(() => window.__px.bright(0.4, 0.1, 0.6, 0.5));
  const s2 = await S();
  await shot('p2-launch.png');
  record('P2', s2.fireworkCount === 1 && s2.particlesAlive >= 1 && p2diff.changed > 50,
    { state: s2, bandDiff: p2diff, burstRegionBrightAtP2: p2base });

  /* ---------- P3 爆炸(球状亮团) ---------- */
  await sleep(1200);
  const s3 = await S();
  await page.evaluate(() => window.__px.a());
  const p3bright = await page.evaluate(() => window.__px.bright(0.4, 0.1, 0.6, 0.5));
  await shot('p3-burst.png');
  const ratio3 = p2base > 0 ? +(p3bright / p2base).toFixed(2) : null;
  record('P3', s3.particlesAlive >= 40 && p3bright >= p2base * 3,
    { state: s3, burstRegionBright: p3bright, baseline: p2base, ratio: ratio3 });

  /* ---------- P4 衰减与余烬(早/晚两个采样点均验证降带运动) ---------- */
  await sleep(2600);
  const s4a = await S();
  await page.evaluate(() => window.__px.a());
  await sleep(350);
  await page.evaluate(() => window.__px.b());
  const p4diff = await page.evaluate(() => window.__px.diff(0.2, 0.5, 0.8, 1.0));
  await sleep(2000); // 模拟 harness 截图时延后的晚期采样(参照 amendment ~7.3s 口径)
  await page.evaluate(() => window.__px.a());
  await sleep(350);
  await page.evaluate(() => window.__px.b());
  const p4diffLate = await page.evaluate(() => window.__px.diff(0.2, 0.5, 0.8, 1.0));
  const s4 = await S();
  await shot('p4-embers.png');
  record('P4', s4.particlesAlive >= 1 && s4.particlesAlive < 40 && s4.particlesAlive < s3.particlesAlive &&
    (p4diff.ratio >= 0.005 || p4diffLate.ratio >= 0.005),
    { state: s4, stateAtEntry: s4a, centerBottomDiff: p4diff, centerBottomDiffLate: p4diffLate, aliveAtP3: s3.particlesAlive });

  /* ---------- P5 自动表演 ---------- */
  await page.click('button[data-ui="auto-show"]');
  const pulses = [];
  for (let i = 0; i < 7; i++) {
    await sleep(600);
    await page.evaluate(() => window.__px.a());
    pulses.push(await page.evaluate(() => window.__px.bright(0.1, 0.05, 0.9, 0.6)));
  }
  const s5 = await S();
  await shot('p5-autoshow.png');
  let pulseCount = 0;
  for (let i = 1; i < pulses.length; i++) if (pulses[i] > pulses[i - 1] * 1.10) pulseCount++;
  record('P5', s5.autoShow === true && s5.fireworkCount >= 4 && pulseCount >= 3,
    { state: s5, brightSamples: pulses, pulseCount });

  /* ---------- P6 关闭自动表演 ---------- */
  await page.click('button[data-ui="auto-show"]');
  await sleep(300);
  const s6a = await S();
  await sleep(2000);
  const s6 = await S();
  await shot('p6-autooff.png');
  record('P6', s6.autoShow === false && s6.fireworkCount === s6a.fireworkCount,
    { state: s6, countAtEntry: s6a.fireworkCount, countAfter2s: s6.fireworkCount });

  /* ---------- P7 暂停冻结 ---------- */
  await page.click('button[data-ui="pause"]');
  await sleep(300);
  const s7 = await S();
  await page.evaluate(() => window.__px.a());
  await sleep(1000);
  await page.evaluate(() => window.__px.b());
  const p7diff = await page.evaluate(() => window.__px.diff(0, 0, 1, 1));
  await shot('p7-paused.png');
  record('P7', s7.enabled === false && p7diff.ratio < 0.005,
    { state: s7, fullFrameDiff: p7diff });

  /* ---------- P8 reset ---------- */
  await page.click('button[data-ui="reset"]');
  await sleep(600);
  const s8 = await S();
  await page.evaluate(() => window.__px.a());
  const p8warm = await page.evaluate(() => window.__px.warmBottom());
  const p8brightUp = await page.evaluate(() => window.__px.bright(0.1, 0.05, 0.9, 0.6, 500));
  await shot('p8-reset.png');
  record('P8', s8.fireworkCount === 0 && s8.particlesAlive === 0 && s8.autoShow === false &&
    s8.enabled === true && s8.buildingCount >= 24 && p8warm >= 80,
    { state: s8, warmBottomPixels: p8warm, upperBright: p8brightUp });

  /* ---------- 附加:P8 reset 已把 enabled 置 true,验证手动发射仍可用 ---------- */
  await page.mouse.click(400, 300);
  await sleep(400);
  const s9 = await S();
  record('P9-resume-launch', s9.enabled === true && s9.fireworkCount === 1 && s9.particlesAlive >= 1,
    { state: s9 });
} catch (e) {
  record('FATAL', false, { error: String(e?.message || e) });
} finally {
  if (browser) await browser.close().catch(() => {});
}

const summary = { url: args.url, pass: passCount, total: results.length, consoleErrors: consoleErrors.length, consoleErrorSamples: consoleErrors.slice(0, 5), results };
fs.writeFileSync(path.join(OUT, 'selfcheck.json'), JSON.stringify(summary, null, 2));
console.log('[selfcheck] ' + JSON.stringify({ pass: passCount, total: results.length, consoleErrors: consoleErrors.length }));
process.exit(passCount === results.length && consoleErrors.length === 0 ? 0 : 1);
