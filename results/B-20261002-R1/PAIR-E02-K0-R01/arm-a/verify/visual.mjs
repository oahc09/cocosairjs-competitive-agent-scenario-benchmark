/** E02 Arm A — 最终视觉确认:地平线位置 / 太阳光盘 / 船体部件色彩多样性 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pw = require('C:/Users/caosh/AppData/Local/npm-cache/_npx/bd29c0cb7c2b284c/node_modules/playwright-core');
const CHROME = 'C:/Users/caosh/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');

(async () => {
    const browser = await pw.chromium.launch({ headless: true, executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('http://127.0.0.1:7102/', { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && !(await page.evaluate(() => window.__appReady))) await page.waitForTimeout(200);
    await page.waitForTimeout(1200);
    const warm = await page.screenshot();
    await page.click('#tone-toggle');
    await page.waitForTimeout(2600);
    const cold = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'final-warm.png'), warm);
    fs.writeFileSync(path.join(SHOTS, 'final-cold.png'), cold);

    const an = await browser.newPage();
    const out = await an.evaluate(async ({ warmB64, coldB64 }) => {
        const load = (d) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('dec')); i.src = 'data:image/png;base64,' + d; });
        const imgs = [await load(warmB64), await load(coldB64)];
        const w = imgs[0].width, h = imgs[0].height;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const res = [];
        for (const im of imgs) {
            ctx.drawImage(im, 0, 0);
            const d = ctx.getImageData(0, 0, w, h).data;
            const px = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
            // 地平线:逐行平均亮度/色相最大突变
            const rowAvg = [];
            for (let y = 0; y < h; y += 4) {
                let r = 0, g = 0, b = 0, n = 0;
                for (let x = 0; x < w; x += 8) { const p = px(x, y); r += p[0]; g += p[1]; b += p[2]; n++; }
                rowAvg.push({ y, r: r / n, g: g / n, b: b / n });
            }
            let maxGrad = 0, horizonY = -1;
            for (let i = 1; i < rowAvg.length; i++) {
                const a = rowAvg[i - 1], b2 = rowAvg[i];
                const grad = Math.abs(a.r - b2.r) + Math.abs(a.g - b2.g) + Math.abs(a.b - b2.b);
                if (grad > maxGrad) { maxGrad = grad; horizonY = b2.y; }
            }
            // 最亮紧凑光盘:找 max 亮度像素块中心(在上半屏)
            let best = [0, 0, 0];
            for (let y = 0; y < h * 0.55; y += 2) for (let x = 0; x < w; x += 2) {
                const p = px(x, y); const lum = p[0] + p[1] + p[2];
                if (lum > best[0]) best = [lum, x / w, y / h];
            }
            // 船体裁剪:中心 ±0.12,统计亮像素 hue 桶
            const cx0 = Math.floor(w * 0.38), cx1 = Math.floor(w * 0.62), cy0 = Math.floor(h * 0.38), cy1 = Math.floor(h * 0.75);
            const hueBuckets = new Set(); let litN = 0, totN = 0; let distinct = 0;
            const lumRows = [];
            for (let y = cy0; y < cy1; y += 2) {
                let rowLit = 0;
                for (let x = cx0; x < cx1; x += 2) {
                    const [r, g, b2] = px(x, y); totN++;
                    const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2);
                    if ((r + g + b2) / 3 > 25) {
                        litN++; rowLit++;
                        let hue = 0;
                        if (mx !== mn) {
                            if (mx === r) hue = ((g - b2) / (mx - mn)) % 6;
                            else if (mx === g) hue = (b2 - r) / (mx - mn) + 2;
                            else hue = (r - g) / (mx - mn) + 4;
                            hue = Math.round(hue * 6) % 36; // 36 桶
                        } else hue = -1;
                        hueBuckets.add(hue);
                    }
                }
                lumRows.push(rowLit);
            }
            res.push({
                horizonFrac: +(horizonY / h).toFixed(3),
                horizonGrad: Math.round(maxGrad),
                sunAt: [best[1] && +best[1].toFixed(3), +best[2].toFixed(3)],
                boatCropLitRatio: +(litN / totN).toFixed(3),
                boatHueBuckets: hueBuckets.size,
                pageErrors: 0,
            });
        }
        return res;
    }, { warmB64: warm.toString('base64'), coldB64: cold.toString('base64') });
    console.log('WARM:', JSON.stringify(out[0]));
    console.log('COLD:', JSON.stringify(out[1]));
    console.log('pageErrors:', errors.length);
    await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
