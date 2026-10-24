// 自检截图采集:按 RUN-CONTRACT §2,先机器计数 browser,再以 playwright-core
// (系统 Chrome headless 1280×720)执行 P2 帧差双帧、P4 缩放后、P6 reset 后的取证截图。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARM = path.resolve(__dirname, '..');
const OUT = path.join(ARM, 'shots');

// ① 先计数(与 verify-browser.mjs 同口径:先计后会话)
const counted = spawnSync(process.execPath, [path.join(ARM, 'workspace', 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) { console.error('count failed'); process.exit(1); }
process.stdout.write(counted.stdout);

// ② 解析 playwright-core(共享 node_modules,沿目录向上)
const { chromium } = createRequire(import.meta.url)('playwright-core');
function browserCandidates() {
  const c = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) c.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  c.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  c.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) c.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return c.filter(Boolean);
}

const consoleErrors = [];
const browser = await (async () => {
  const errs = [];
  for (const exe of [null, ...browserCandidates()]) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try { return await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000 }); }
    catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  throw new Error(errs.join(' | '));
})();

const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e.message).slice(0, 200)));
await page.goto('http://127.0.0.1:7212/', { waitUntil: 'load', timeout: 30000 });

// 等待 __appReady
const t0 = Date.now();
while (Date.now() - t0 <= 10000) {
  if (await page.evaluate(() => window.__appReady === true)) break;
  await new Promise((r) => setTimeout(r, 150));
}

const R = { consoleErrors: 0, states: {}, shots: {} };
const wait = (ms) => page.evaluate((m) => new Promise((r) => setTimeout(r, m)), ms);

// --- P1 稳态:等 2.5s,取双帧(间隔 800ms)供帧差 ---
await wait(2500);
R.states.s1 = await page.evaluate(() => window.__bench.getState());
await page.screenshot({ path: path.join(OUT, 'p2-frameA.png') });
await wait(800);
R.states.s2 = await page.evaluate(() => window.__bench.getState());
await page.screenshot({ path: path.join(OUT, 'p2-frameB.png') });
R.shots.frameA = 'p2-frameA.png'; R.shots.frameB = 'p2-frameB.png';
R.states.rotDiff800 = R.states.s2.diskRotation - R.states.s1.diskRotation;

// --- P4:真实滚轮(CDP 输入)向内 ---
await page.mouse.move(640, 360);
await page.mouse.wheel(0, -600);
await wait(1300);
R.states.afterWheel = await page.evaluate(() => window.__bench.getState());
await page.screenshot({ path: path.join(OUT, 'p4-zoomed.png') });
R.shots.zoomed = 'p4-zoomed.png';

// --- P5:缩放态星流仍在跑 ---
await wait(1000);
R.states.p5 = await page.evaluate(() => window.__bench.getState());

// --- P6:点击 reset 按钮(真实点击) ---
await page.click('[data-ui="reset"]');
await wait(400);
R.states.afterReset = await page.evaluate(() => window.__bench.getState());
await page.screenshot({ path: path.join(OUT, 'p6-reset.png') });
R.shots.reset = 'p6-reset.png';

R.consoleErrors = consoleErrors.length;
R.errorDetail = consoleErrors.slice(0, 5);
await browser.close();
console.log('[capture] ' + JSON.stringify(R));
