// diag-console.mjs — 诊断用:收集页面 console 全部消息文本(先执行 count.mjs browser 计数)
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ws = path.join(__dirname, 'workspace');

const counted = spawnSync(process.execPath, [path.join(ws, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
process.stdout.write(counted.stdout || '');
if (counted.status !== 0) { console.error(counted.stderr); process.exit(1); }

const require = createRequire(import.meta.url);
const chromium = require(path.join(ws, '..', '..', '..', '..', '..', 'node_modules', 'playwright-core')).chromium;

const url = process.argv[2] || 'http://127.0.0.1:7119/';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000,
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[console:${m.type()}] ${m.text().slice(0, 800)}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e?.message || e).slice(0, 800)}`));
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));
const st = await page.evaluate(() => ({
    ready: window.__appReady,
    state: window.__bench ? window.__bench.getState() : null,
    hudText: document.getElementById('bench-hud') ? document.getElementById('bench-hud').innerText : null,
}));
console.log('[diag] ' + JSON.stringify(st));
await browser.close();
