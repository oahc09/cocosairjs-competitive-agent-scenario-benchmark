#!/usr/bin/env node
// ============================================================================
// probe-check.mjs — E10 探针自检(Agent 自己的验证脚本,非 harness 组件)
// ----------------------------------------------------------------------------
// ① 先执行 count.mjs browser(browserAttempt 机器计数,先计后会话,不绕过预算);
// ② 用 playwright-core 启动 headless Chrome(1280x720,同 verify-browser 口径),
//    依 spec.json probes P1..P7 顺序执行动作、采样状态与像素证据:
//      - state:window.__bench.getState() 逐条对照 stateAssertion 的 jq 语义;
//      - 视觉:截图数据 URL 在页面内解码,按归一化区域计算 nonBlank / 帧间 changed;
//      - 网络:记录对 assets/character.glb 的响应(应恰好 1 次 200);
//      - 页面刷新检测:reset 前后 window 标记不丢失。
// 结果逐 probe 打印 PASS/FAIL;任一失败退出码 1。截图存 workspace/.selfcheck/。
// ============================================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ① browserAttempt 机器计数(先计后会话)
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[probe-check] browser 计数失败,拒绝创建浏览器会话:\n' + (counted.stdout || '') + (counted.stderr || ''));
  process.exit(1);
}
process.stdout.write(counted.stdout);

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const URL_ = process.argv[2] || 'http://127.0.0.1:7124/';
const outDir = path.resolve(__dirname, '..', '.selfcheck');
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORT = { width: 1280, height: 720 };

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
      return await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: VIEWPORT, timeout: 30000 });
    } catch (e) {
      errors.push(`${exe || 'playwright-default'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('no usable browser (tried: ' + errors.join(' | ') + ')');
}

// 探针归一化区域 -> 像素矩形(spec.json §8:instanceA / instanceB)
const RECTS = {
  A: { x0: Math.round(0.08 * 1280), y0: Math.round(0.15 * 720), x1: Math.round(0.42 * 1280), y1: Math.round(0.95 * 720) },
  B: { x0: Math.round(0.58 * 1280), y0: Math.round(0.15 * 720), x1: Math.round(0.92 * 1280), y1: Math.round(0.95 * 720) },
};

// 在页面内解码截图并计算各区域 nonBlank(与区域主导色差 > 24 的像素占比)
async function regionStats(page, dataUrl) {
  return page.evaluate(async (dataUrl) => {
    const rects = {
      A: { x0: 102, y0: 108, x1: 538, y1: 684 },
      B: { x0: 742, y0: 108, x1: 1178, y1: 684 },
    };
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const out = {};
    for (const [k, r] of Object.entries(rects)) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      const d = ctx.getImageData(r.x0, r.y0, w, h).data;
      const hist = new Map();
      for (let i = 0; i < d.length; i += 16) {
        const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        hist.set(key, (hist.get(key) || 0) + 1);
      }
      let dom = 0, domN = -1;
      for (const [key, n] of hist) if (n > domN) { domN = n; dom = key; }
      const dr = ((dom >> 10) & 31) * 8, dg = ((dom >> 5) & 31) * 8, db = (dom & 31) * 8;
      let non = 0, tot = 0;
      for (let i = 0; i < d.length; i += 4) {
        tot++;
        if (Math.abs(d[i] - dr) > 24 || Math.abs(d[i + 1] - dg) > 24 || Math.abs(d[i + 2] - db) > 24) non++;
      }
      out[k] = { nonBlank: non / tot };
    }
    return out;
  }, dataUrl);
}

// 两张截图各区域像素差(任一通道差 > 20 的像素占比)
async function regionDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const rects = {
      A: { x0: 102, y0: 108, x1: 538, y1: 684 },
      B: { x0: 742, y0: 108, x1: 1178, y1: 684 },
    };
    async function load(url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx;
    }
    const ca = await load(a);
    const cb = await load(b);
    const out = {};
    for (const [k, r] of Object.entries(rects)) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      const da = ca.getImageData(r.x0, r.y0, w, h).data;
      const db = cb.getImageData(r.x0, r.y0, w, h).data;
      let ch = 0, tot = 0;
      for (let i = 0; i < da.length; i += 4) {
        tot++;
        if (Math.abs(da[i] - db[i]) > 20 || Math.abs(da[i + 1] - db[i + 1]) > 20 || Math.abs(da[i + 2] - db[i + 2]) > 20) ch++;
      }
      out[k] = ch / tot;
    }
    return out;
  }, { a, b });
}

const browser = await launchBrowser();
const page = await browser.newPage();
page.setDefaultTimeout(30000);

const consoleErrors = [];
const pageErrors = [];
const glbResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 300)));
page.on('response', (r) => { if (r.url().includes('character.glb')) glbResponses.push({ url: r.url(), status: r.status() }); });

async function shot(name) {
  const buf = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(outDir, name + '.png'), buf);
  return 'data:image/png;base64,' + buf.toString('base64');
}
const getState = () => page.evaluate(() => window.__bench.getState());

const results = [];
function record(probeId, checks, extra) {
  const ok = checks.every((c) => c.pass);
  results.push({ probeId, ok, checks, extra });
  console.log(`[${probeId}] ${ok ? 'PASS' : 'FAIL'} | ` + checks.map((c) => `${c.pass ? 'ok' : 'XX'} ${c.name}`).join(' | ') + (extra ? ' | ' + JSON.stringify(extra) : ''));
}

try {
  await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
  const benchOk = await page.evaluate(() => !!(window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function'));

  // ---- P1: wait 1500 — 双实例 Idle 就位,区域非空 ------------------------------
  await page.waitForTimeout(1500);
  let st = await getState();
  const p1shot = await shot('p1');
  const p1stats = await regionStats(page, p1shot);
  record('P1', [
    { name: 'benchContract', pass: benchOk },
    { name: 'assetLoaded', pass: st.assetLoaded === true },
    { name: 'instanceCount==2', pass: st.instanceCount === 2 },
    { name: 'A.clip==idle', pass: st.instances.A && st.instances.A.clip === 'idle' },
    { name: 'B.clip==idle', pass: st.instances.B && st.instances.B.clip === 'idle' },
    { name: 'regionA nonBlank>=0.1', pass: p1stats.A.nonBlank >= 0.1 },
    { name: 'regionB nonBlank>=0.1', pass: p1stats.B.nonBlank >= 0.1 },
  ], { state: st, stats: p1stats, glb: glbResponses });

  // ---- P2: wait 1000 — time 推进 + 双区域运动 ----------------------------------
  await page.waitForTimeout(1000);
  const st2 = await getState();
  const p2a = await shot('p2a');
  await page.waitForTimeout(800);
  const p2b = await shot('p2b');
  const p2diff = await regionDiff(page, p2a, p2b);
  record('P2', [
    { name: 'instanceCount==2', pass: st2.instanceCount === 2 },
    { name: 'A.time>0', pass: st2.instances.A && st2.instances.A.time > 0 },
    { name: 'B.time>0', pass: st2.instances.B && st2.instances.B.time > 0 },
    { name: 'regionA motion>0.005', pass: p2diff.A >= 0.005 },
    { name: 'regionB motion>0.005', pass: p2diff.B >= 0.005 },
  ], { state: st2, diff: p2diff });

  // ---- P3: click anim-a-walk — 仅 A 切 Walk,B 保持 Idle ------------------------
  await page.click('[data-bench="anim-a-walk"]');
  await page.waitForTimeout(1000);
  const st3 = await getState();
  const p3a = await shot('p3a');
  await page.waitForTimeout(500);
  const p3b = await shot('p3b');
  const p3diff = await regionDiff(page, p3a, p3b);
  const p3stats = await regionStats(page, p3b);
  record('P3', [
    { name: 'A.clip==walk', pass: st3.instances.A && st3.instances.A.clip === 'walk' },
    { name: 'B.clip==idle', pass: st3.instances.B && st3.instances.B.clip === 'idle' },
    { name: 'regionA change(500ms)>0.005', pass: p3diff.A >= 0.005 },
    { name: 'regionB still visible', pass: p3stats.B.nonBlank >= 0.1 },
  ], { state: st3, diff: p3diff, statsB: p3stats.B });

  // ---- P4: click destroy-a — A 从场景图移除(动作前 vs 动作后 pixelDelta) -------
  const p4pre = await shot('p4pre');
  await page.click('[data-bench="destroy-a"]');
  await page.waitForTimeout(800);
  const st4 = await getState();
  const p4post = await shot('p4post');
  const p4diff = await regionDiff(page, p4pre, p4post);
  const p4stats = await regionStats(page, p4post);
  record('P4', [
    { name: 'instanceCount==1', pass: st4.instanceCount === 1 },
    { name: 'destroyedInstance=="A"', pass: st4.destroyedInstance === 'A' },
    { name: 'instances.A==null', pass: st4.instances.A === null },
    { name: 'pixelDelta A>=0.02', pass: p4diff.A >= 0.02 },
    { name: 'regionB still nonBlank>=0.1', pass: p4stats.B.nonBlank >= 0.1 },
  ], { state: st4, diff: p4diff, stats: p4stats });

  // ---- P5: wait 1500 — B 独立存活且动画继续 ------------------------------------
  await page.waitForTimeout(1500);
  const st5 = await getState();
  const p5a = await shot('p5a');
  await page.waitForTimeout(800);
  const p5b = await shot('p5b');
  const p5diff = await regionDiff(page, p5a, p5b);
  record('P5', [
    { name: 'instanceCount==1', pass: st5.instanceCount === 1 },
    { name: 'B.clip==idle', pass: st5.instances.B && st5.instances.B.clip === 'idle' },
    { name: 'B.time>0', pass: st5.instances.B && st5.instances.B.time > 0 },
    { name: 'regionB motion>0.005', pass: p5diff.B >= 0.005 },
  ], { state: st5, diff: p5diff });

  // ---- P6: click reset — 双实例恢复 Idle,无新资产请求,无页面刷新 ---------------
  await page.evaluate(() => { window.__probeMarker = 42; });
  await page.click('[data-bench="reset"]');
  await page.waitForTimeout(1500);
  const st6 = await getState();
  const markerKept = await page.evaluate(() => window.__probeMarker === 42);
  const p6shot = await shot('p6');
  const p6stats = await regionStats(page, p6shot);
  record('P6', [
    { name: 'resetCount==1', pass: st6.resetCount === 1 },
    { name: 'instanceCount==2', pass: st6.instanceCount === 2 },
    { name: 'destroyedInstance==null', pass: st6.destroyedInstance === null },
    { name: 'A.clip==idle', pass: st6.instances.A && st6.instances.A.clip === 'idle' },
    { name: 'B.clip==idle', pass: st6.instances.B && st6.instances.B.clip === 'idle' },
    { name: 'regionA nonBlank>=0.1', pass: p6stats.A.nonBlank >= 0.1 },
    { name: 'regionB nonBlank>=0.1', pass: p6stats.B.nonBlank >= 0.1 },
    { name: 'no page reload', pass: markerKept },
    { name: 'glb requests==1', pass: glbResponses.length === 1 && glbResponses[0].status === 200 },
  ], { state: st6, stats: p6stats, glb: glbResponses });

  // ---- P7: wait 1000 — 双实例动画推进 + fps>=30 --------------------------------
  await page.waitForTimeout(1000);
  const st7 = await getState();
  const p7a = await shot('p7a');
  await page.waitForTimeout(800);
  const p7b = await shot('p7b');
  const p7diff = await regionDiff(page, p7a, p7b);
  record('P7', [
    { name: 'A.time>0', pass: st7.instances.A && st7.instances.A.time > 0 },
    { name: 'B.time>0', pass: st7.instances.B && st7.instances.B.time > 0 },
    { name: 'fps>=30', pass: typeof st7.fps === 'number' && st7.fps >= 30 },
    { name: 'regionA motion>0.005', pass: p7diff.A >= 0.005 },
    { name: 'regionB motion>0.005', pass: p7diff.B >= 0.005 },
  ], { state: st7, diff: p7diff });

  record('ENV', [
    { name: 'no console errors', pass: consoleErrors.length === 0 },
    { name: 'no pageerrors', pass: pageErrors.length === 0 },
  ], { consoleErrors, pageErrors });
} catch (e) {
  results.push({ probeId: 'FATAL', ok: false, error: String(e?.message || e) });
  console.error('[probe-check] FATAL:', e);
} finally {
  await browser.close().catch(() => {});
}

const allOk = results.length > 0 && results.every((r) => r.ok) && pageErrors.length === 0;
console.log('[probe-check] SUMMARY ' + JSON.stringify({ allOk, glbResponses, consoleErrors, pageErrors }));
process.exit(allOk ? 0 : 1);
