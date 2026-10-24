#!/usr/bin/env node
// ============================================================================
// selfcheck.mjs — E04 全探针自检(Agent 自用,单浏览器会话跑完 P1-P8 模拟序列)
// ----------------------------------------------------------------------------
// 预算合规:创建浏览器会话前先执行 `node scripts/count.mjs browser`(RUN-CONTRACT §2)。
// 用法: node scripts/selfcheck.mjs [--url http://127.0.0.1:7210/]
// 输出: selfcheck/report.json + selfcheck/P*.png 截图证据(相对本脚本上级目录)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(__dirname, '..');
const OUT = path.join(WS, '..', 'selfcheck');
fs.mkdirSync(OUT, { recursive: true });

const URL = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:7210/';
})();

// ① browserAttempt 机器计数(先计后会话)
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[selfcheck] browser 计数失败,拒绝创建会话');
  process.exit(1);
}
process.stdout.write(counted.stdout);

// ② 解析 playwright-core(共享 node_modules)
const { chromium } = createRequire(import.meta.url)('playwright-core');

function browserCandidates() {
  const cands = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) cands.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  cands.push('E:\\AIProMax\\Y2026M10\\chrome-pin-155.0.8059.40\\chrome.exe');
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
  throw new Error('no browser: ' + errors.join(' | '));
}

// ---------- 页面内像素分析(把截图 base64 喂回页面 2D canvas 计算) ----------
// spec 为纯 JSON 指令(Playwright 参数只能序列化,不能传函数):
//   {op:'warm', region:{x0,y0,x1,y1}}                  → 暖色亮像素计数 + 平均亮度
//   {op:'bright', region:{...}, thr:110}               → 亮像素计数
//   {op:'diff', region:{...}}                          → 两帧差分(需两张图)
//   {op:'multi', items:[{key, op, region, thr}]}       → 单图多项统计
async function analyze(page, spec, ...b64s) {
  return page.evaluate(async ([sp, ...imgs]) => {
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('img load fail'));
      img.src = 'data:image/png;base64,' + b64;
    });
    const cvs = [];
    for (const b64 of imgs) {
      const img = await load(b64);
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      cvs.push(cx);
    }
    const region = (cx, r) => {
      const w = cx.canvas.width, h = cx.canvas.height;
      return { x0: Math.floor(r.x0 * w), y0: Math.floor(r.y0 * h), x1: Math.ceil(r.x1 * w), y1: Math.ceil(r.y1 * h) };
    };
    const getData = (cx, r) => {
      const R = region(cx, r);
      return cx.getImageData(R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0).data;
    };
    const warm = (cx, r) => {
      const d = getData(cx, r);
      let c = 0, lumSum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        lumSum += 0.2126 * R + 0.7152 * G + 0.0722 * B; n++;
        if (R > 70 && R > B * 1.25 && R >= G && G > B * 0.8) c++;
      }
      return { warm: c, avgLum: lumSum / n, n };
    };
    const bright = (cx, r, thr) => {
      const d = getData(cx, r);
      let c = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > thr) c++;
      }
      return { bright: c, total: d.length / 4 };
    };
    const diff = (c1, c2, r) => {
      const da = getData(c1, r), db = getData(c2, r);
      let nz = 0, sumd = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) nz++;
        sumd += d;
      }
      return { nz, total: da.length / 4, ratio: nz / (da.length / 4), avgDiff: sumd / (da.length / 4) };
    };
    const run = (s) => {
      if (s.op === 'warm') return warm(cvs[0], s.region);
      if (s.op === 'bright') return bright(cvs[0], s.region, s.thr ?? 110);
      if (s.op === 'diff') return diff(cvs[0], cvs[1], s.region);
      if (s.op === 'multi') {
        const out = {};
        for (const it of s.items) out[it.key] = run(it);
        return out;
      }
      throw new Error('unknown op ' + s.op);
    };
    return run(sp);
  }, [spec, ...b64s]);
}

// ---------- 主流程 ----------
const results = [];
const consoleErrors = [];
const pageErrors = [];
function log(probeId, pass, detail) {
  results.push({ probeId, pass, detail });
  console.log(`[${probeId}] ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (await page.evaluate(() => window.__appReady === true)) break;
    await sleep(150);
  }
  const ready = await page.evaluate(() => window.__appReady === true && !!window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function');
  log('READY', ready, { readyMs: Date.now() - t0 });

  const getState = () => page.evaluate(() => window.__bench.getState());
  const shot = async (name) => {
    const p = path.join(OUT, name);
    await page.screenshot({ path: p });
    return fs.readFileSync(p).toString('base64');
  };
  const click = (x, y) => page.mouse.click(1280 * x, 720 * y);
  const clickUI = async (ui) => {
    const ok = await page.evaluate((u) => {
      const el = document.querySelector('[data-ui="' + u + '"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      window.__lastUiClick = { x: r.left + r.width / 2, y: r.top + r.height / 2, normX: (r.left + r.width / 2) / innerWidth, normY: (r.top + r.height / 2) / innerHeight };
      el.click();
      return true;
    }, ui);
    if (!ok) throw new Error('UI element not found: ' + ui);
    return page.evaluate(() => window.__lastUiClick);
  };

  // ============ P1: 初始夜景 ============
  await sleep(2500);
  let st = await getState();
  const s1 = await shot('P1.png');
  const p1v = await analyze(page, { op: 'multi', items: [
    { key: 'bottomThird', op: 'warm', region: { x0: 0, y0: 2 / 3, x1: 1, y1: 1 } },
    { key: 'skyBand', op: 'warm', region: { x0: 0.3, y0: 0.55, x1: 0.7, y1: 0.66 } },
    { key: 'topSky', op: 'warm', region: { x0: 0.25, y0: 0.02, x1: 0.75, y1: 0.2 } },
  ] }, s1);
  p1v.topSkyAvgLum = p1v.topSky.avgLum;
  log('P1',
    st.buildingCount >= 24 && st.fireworkCount === 0 && st.autoShow === false && st.enabled === true
      && p1v.bottomThird.warm >= 80 && p1v.bottomThird.avgLum < p1v.skyBand.avgLum * 0.85
      && p1v.topSky.avgLum > 2,
    { state: st, pixels: p1v });

  // ============ P2: 点击发射 ============
  const uiPos = await page.evaluate(() => {
    const r = document.querySelector('[data-ui="auto-show"]').getBoundingClientRect();
    return { normX: (r.left + r.width / 2) / innerWidth, normY: (r.top + r.height / 2) / innerHeight };
  });
  log('UIPOS', uiPos.normX > 0.8 && uiPos.normY < 0.25, uiPos);
  await click(0.5, 0.30);
  await sleep(500);
  st = await getState();
  // 运动证据:两帧差分(间隔 300ms),中竖带
  const f1 = await shot('P2_f1.png');
  await sleep(300);
  const f2 = await shot('P2_f2.png');
  const p2v = await analyze(page, { op: 'diff', region: { x0: 0.4, y0: 0.05, x1: 0.6, y1: 0.9 } }, f1, f2);
  log('P2', st.fireworkCount === 1 && st.particlesAlive >= 1 && p2v.nz > 30, { state: st, motion: p2v });

  // ============ P3: 爆炸 ============
  await sleep(1200);
  st = await getState();
  const s3 = await shot('P3.png');
  const p3v = await analyze(page, { op: 'multi', items: [
    { key: 'burstZone', op: 'bright', thr: 90, region: { x0: 0.5 - 0.2 * (720 / 1280), y0: 0.10, x1: 0.5 + 0.2 * (720 / 1280), y1: 0.50 } },
    { key: 'upperHalf', op: 'bright', thr: 110, region: { x0: 0, y0: 0, x1: 1, y1: 0.5 } },
  ] }, s3);
  log('P3', st.particlesAlive >= 40 && p3v.burstZone.bright > 500, { state: st, pixels: p3v });

  // ============ P4: 衰减与余烬(spec 时序 + 长时延模拟双采样) ============
  await sleep(2600);
  st = await getState();
  const peak = st.particlesAlive;
  const e1 = await shot('P4_e1.png');
  await sleep(250);
  const e2 = await shot('P4_e2.png');
  const p4v = await analyze(page, { op: 'multi', items: [
    { key: 'upperHalf', op: 'diff', region: { x0: 0, y0: 0, x1: 1, y1: 0.5 } },
    { key: 'centerBottom', op: 'diff', region: { x0: 0.25, y0: 0.5, x1: 0.75, y1: 1.0 } },
  ] }, e1, e2);
  log('P4', peak >= 1 && peak < 40 && p4v.centerBottom.ratio >= 0.005, { state: st, motion: p4v });

  // P4 长时延变体(模拟 harness 截图时延:点击后再等到 ~7.3s)
  await sleep(2000);
  st = await getState();
  const l1 = await shot('P4L_e1.png');
  await sleep(250);
  const l2 = await shot('P4L_e2.png');
  const p4lv = await analyze(page, { op: 'diff', region: { x0: 0.25, y0: 0.5, x1: 0.75, y1: 1.0 } }, l1, l2);
  log('P4L', st.particlesAlive >= 1 && st.particlesAlive < 40 && p4lv.ratio >= 0.005, { state: st, motion: p4lv });

  // ============ P5: 自动表演 ============
  await clickUI('auto-show');
  await sleep(4000);
  st = await getState();
  const s5 = await shot('P5.png');
  const p5v = await analyze(page, { op: 'bright', thr: 130, region: { x0: 0, y0: 0, x1: 1, y1: 0.5 } }, s5);
  log('P5', st.autoShow === true && st.fireworkCount >= 4, { state: st, upperBright: p5v });

  // ============ P6: 关闭自动 ============
  await clickUI('auto-show');
  const c1 = await getState();
  await sleep(1200);
  const c2 = await getState();
  await sleep(1300);
  st = await getState();
  const s6 = await shot('P6.png');
  log('P6', st.autoShow === false && c2.fireworkCount - c1.fireworkCount === 0 && st.fireworkCount - c2.fireworkCount === 0,
    { s0: c1, s1: c2, s2: st });

  // ============ P7: 暂停冻结 ============
  await clickUI('pause');
  await sleep(300);
  st = await getState();
  const z1 = await shot('P7_z1.png');
  await sleep(1000);
  const z2 = await shot('P7_z2.png');
  const p7v = await analyze(page, { op: 'diff', region: { x0: 0, y0: 0, x1: 1, y1: 1 } }, z1, z2);
  log('P7', st.enabled === false && p7v.ratio <= 0.005, { state: st, freeze: p7v });
  // 恢复检查(不影响后续 P8,先恢复再 reset)
  await clickUI('pause');
  await sleep(200);

  // ============ P8: reset ============
  await clickUI('reset');
  await sleep(600);
  st = await getState();
  const s8 = await shot('P8.png');
  const p8v = await analyze(page, { op: 'multi', items: [
    { key: 'upper', op: 'bright', thr: 110, region: { x0: 0, y0: 0, x1: 1, y1: 0.5 } },
    { key: 'bottomThird', op: 'warm', region: { x0: 0, y0: 2 / 3, x1: 1, y1: 1 } },
  ] }, s8);
  log('P8', st.fireworkCount === 0 && st.particlesAlive === 0 && st.autoShow === false && st.enabled === true && st.buildingCount >= 24 && p8v.bottomThird.warm >= 80,
    { state: st, pixels: p8v });

  // 手动点击在 reset 后仍可用(冒烟)
  await click(0.4, 0.25);
  await sleep(400);
  st = await getState();
  log('POSTRESET_CLICK', st.fireworkCount === 1 && st.particlesAlive >= 1, { state: st });

  log('ERRORS', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });
} catch (e) {
  log('FATAL', false, { error: String(e?.message || e) });
} finally {
  if (browser) await browser.close().catch(() => {});
}

const passCount = results.filter((r) => r.pass).length;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ url: URL, at: new Date().toISOString(), results, passCount, total: results.length }, null, 2));
console.log(`\n[selfcheck] ${passCount}/${results.length} PASS -> ${path.relative(process.cwd(), path.join(OUT, 'report.json'))}`);
process.exit(passCount === results.length ? 0 : 1);
