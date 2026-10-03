// scripts/shot.mjs — 本地快速取景调试(非交付物):serve dist → 截图 → ASCII 预览
// usage: node scripts/shot.mjs [out.png]
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'file:///E:/AIProMax/Y2026M10/cocosairjs-competitive-agent-scenario-benchmark/bench/harness/node_modules/pngjs/lib/png.js';
import { chromium } from 'file:///E:/AIProMax/Y2026M10/cocosairjs-competitive-agent-scenario-benchmark/bench/harness/node_modules/playwright-core/index.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = 7421;
const OUT = process.argv[2] || join(ROOT, 'validation', 'debug-shot.png');

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        let p = decodeURIComponent(url.pathname);
        if (p === '/') p = '/index.html';
        const file = normalize(join(ROOT, p));
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        const data = await readFile(file);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
        res.end(data);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); else if (m.text().includes('e09')) console.log('LOG:', m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?v=${process.env.SHOT_V || "full"}${process.env.SHOT_EXTRA || ""}`);
await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
const state = await page.evaluate(() => window.__bench ? window.__bench.getState() : null);
await page.screenshot({ path: OUT });
await browser.close();
server.close();

const png = PNG.sync.read(await readFile(OUT));
const { width, height, data } = png;
for (let gy = 0; gy < 18; gy++) {
    let row = '';
    for (let gx = 0; gx < 36; gx++) {
        const x = Math.floor((gx + 0.5) * width / 36), y = Math.floor((gy + 0.5) * height / 18);
        const i = (y * width + x) * 4;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        row += ' .:-=+*#%@'[Math.min(9, Math.floor(lum / 25.6))];
    }
    console.log(row);
}
const avg = (x0, y0, x1, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * width + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
};
console.log('sky avg   ', avg(600, 40, 680, 90));
console.log('gem avg   ', avg(520, 260, 760, 460));
console.log('floor avg ', avg(300, 600, 500, 700));
console.log('state     ', JSON.stringify(state));
console.log('errors    ', errors.length ? errors : '(none)');
