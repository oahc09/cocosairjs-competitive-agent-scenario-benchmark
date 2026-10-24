#!/usr/bin/env node
// debug-console.mjs — 自有诊断脚本:先经 count.mjs 计数 browserAttempt,再开带完整
// console/pageerror 捕获的会话(与 verify-browser.mjs 相同的浏览器预算纪律)。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || 'http://127.0.0.1:7213/';

const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) { console.error('count failed'); process.exit(1); }
process.stdout.write(counted.stdout);

const { chromium } = createRequire(import.meta.url)('playwright-core');
import fs from 'node:fs';
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
let browser = null;
const errs = [];
for (const exe of [null, ...browserCandidates()]) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try { browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: { width: 1280, height: 720 } }); break; }
    catch (e) { errs.push(e.message.split('\n')[0]); }
}
if (!browser) { console.error('no browser: ' + errs.join(' | ')); process.exit(1); }
const page = await browser.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack || e.message || e}`));
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 6000));
const st = await page.evaluate(() => ({ ready: window.__appReady === true, fatal: window.__fatal || null, frame: window.__bench.getState().frame }));
console.log('[state]', JSON.stringify(st));
await page.screenshot({ path: '../shots/debug.png' });
await browser.close();
