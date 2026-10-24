#!/usr/bin/env node
// ============================================================================
// verify-browser.mjs — Agent Run 浏览器验证统一入口(预算计数 + playwright-core 会话)
// ----------------------------------------------------------------------------
// 用法: node scripts/verify-browser.mjs --url <u> [--shot <png>] [--eval <js>]
//   --url   目标页面(必须;通常是本 Arm dev server 地址,端口见 RUN-CONTRACT §0)
//   --shot  页面截图保存路径(相对当前工作目录或绝对路径,1280×720 视口)
//   --eval  在页面上下文求值的 JS 表达式(如 "window.__bench.getState()"),结果以 JSON 打印
//
// 行为:
//   ① 先执行 `node scripts/count.mjs browser` —— browserAttempt 机器计数,先计后会话;
//      计数失败则拒绝启动浏览器会话(预算完整性优先于本次验证)。
//   ② 以 playwright-core 启动 headless Chrome/Chromium(1280×720,全新临时 profile),
//      依赖沿目录向上解析到共享 node_modules(exFAT 去重布局,见 RUN-CONTRACT §1)。
//   ③ 导航 → 等待 window.__appReady(≤10s)→ 收集 console error 与未捕获异常;
//      按 --shot 截图、按 --eval 求值;结果汇总为单行 JSON 打印到 stdout。
//
// 退出码: 0=会话完成且无未捕获异常;1=导航失败/存在未捕获异常/计数或启动失败;2=用法错误。
// 说明: 本脚本属于冻结模板(harness 预置),不得修改;浏览器会话一律经本脚本,
//       保证 workspace/.budget/browser.count 机器计数完整(RUN-CONTRACT §2/§4)。
// ============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1280, height: 720 };
const READY_TIMEOUT_MS = 10000; // 与 RUN-CONTRACT §5.2 同口径

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--shot') out.shot = argv[++i];
    else if (a === '--eval') out.eval = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  console.error('usage: node scripts/verify-browser.mjs --url <u> [--shot <png>] [--eval <js>]');
  process.exit(args.help ? 0 : 2);
}

// ---------- ① browserAttempt 机器计数(先计后会话,不可绕过) ----------
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[verify-browser] browser 计数失败,拒绝创建浏览器会话:\n' + (counted.stdout || '') + (counted.stderr || ''));
  process.exit(1);
}
process.stdout.write(counted.stdout);

// ---------- ② 解析 playwright-core(共享 node_modules,沿目录向上) ----------
let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright-core').chromium;
} catch (e) {
  console.error(`[verify-browser] 无法解析 playwright-core(共享 node_modules 缺失?禁 npm install,见 RUN-CONTRACT §4): ${e.message}`);
  process.exit(1);
}

/** 浏览器可执行文件候选(环境变量覆盖优先,然后标准 Chrome 安装位置)。 */
function browserCandidates() {
  const cands = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) {
    if (process.env[k]) cands.push(process.env[k]);
  }
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
  // 先交给 playwright-core 默认解析(其自带 chromium 或 channel),再退回候选路径
  for (const exe of [null, ...browserCandidates()]) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try {
      return await chromium.launch({
        ...(exe ? { executablePath: exe } : {}),
        headless: true,
        viewport: VIEWPORT,
        timeout: 30000,
      });
    } catch (e) {
      errors.push(`${exe || 'playwright-default'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('no usable browser (tried: ' + errors.join(' | ') + ')');
}

// ---------- ③ 会话 ----------
const summary = { url: args.url, appReady: false, benchReady: null, consoleErrors: 0, uncaught: [], shot: null, evalResult: null };
const consoleErrors = [];
let browser = null;
let exitCode = 0;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', (err) => summary.uncaught.push(String(err?.message || err).slice(0, 300)));

  await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });

  // 等待 __appReady(≤10s;轮询而非一次性,便于诊断慢启动)
  const t0 = Date.now();
  while (Date.now() - t0 <= READY_TIMEOUT_MS) {
    try {
      const st = await page.evaluate(() => ({
        ready: window.__appReady === true,
        bench: !!(window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function'),
      }));
      summary.benchReady = st.bench;
      if (st.ready) { summary.appReady = true; break; }
    } catch { /* 页面尚不可求值 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (args.shot) {
    const shotPath = path.resolve(process.cwd(), args.shot);
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath });
    summary.shot = path.relative(process.cwd(), shotPath).replaceAll('\\', '/');
  }
  if (args.eval) {
    summary.evalResult = await page.evaluate(new Function(`return (${args.eval})`)); // eslint-disable-line no-new-func
  }
  summary.consoleErrors = consoleErrors.length;
} catch (e) {
  summary.error = String(e.message || e).split('\n')[0];
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
if (summary.uncaught.length > 0) exitCode = 1;

console.log('[verify-browser] ' + JSON.stringify(summary));
process.exit(exitCode);
