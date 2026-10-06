// 一次性全量自检(非 harness 文件):先经 count.mjs browser 计数,再创建单一浏览器会话:
// 就绪 → 暖端截图 → 执行 verify/eval-probes.js(P2-P5 镜像,结束时页面已切至冷端)
// → 读终态 → 冷端截图。合规依据:RUN-CONTRACT §2(开会话前先 count.mjs browser)。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ws = path.resolve(__dirname, '..', 'workspace');

const counted = spawnSync(process.execPath, [path.join(ws, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
process.stdout.write(counted.stdout);
if (counted.status !== 0) process.exit(1);

const require = createRequire(import.meta.url);
const chromium = require('playwright-core').chromium;

function browserCandidates() {
  const cands = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) cands.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return cands.filter((p) => fs.existsSync(p));
}

let browser = null;
const errors = [];
for (const exe of [null, ...browserCandidates()]) {
  try {
    browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000 });
    break;
  } catch (e) {
    errors.push(e.message.split('\n')[0]);
  }
}
if (!browser) { console.error('no browser: ' + errors.join(' | ')); process.exit(1); }

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror:' + String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:7131/index.html', { waitUntil: 'load', timeout: 30000 });
const t0 = Date.now();
let ready = false;
while (Date.now() - t0 <= 10000 && !ready) {
  ready = await page.evaluate(() => window.__appReady === true).catch(() => false);
  if (!ready) await new Promise((r) => setTimeout(r, 200));
}
await page.screenshot({ path: path.join(__dirname, 'shot-warm-before-toggle.png') });

const probeExpr = fs.readFileSync(path.join(__dirname, 'eval-probes.js'), 'utf8');
const probes = await page.evaluate(new Function('return (' + probeExpr + ')'));
const endState = await page.evaluate(() => window.__bench.getState());
await page.screenshot({ path: path.join(__dirname, 'shot-cool-dusk.png') });
await browser.close().catch(() => {});
console.log('[full-check] ' + JSON.stringify({ ready, probes, endState, consoleErrors }, null, 1));
