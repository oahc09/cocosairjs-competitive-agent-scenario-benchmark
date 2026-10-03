/** E02 Arm A — debug: 亮度网格 + 场景自省 + 全量 console 消息 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('C:/Users/caosh/AppData/Local/npm-cache/_npx/bd29c0cb7c2b284c/node_modules/playwright-core');
const CHROME = 'C:/Users/caosh/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

(async () => {
    const browser = await pw.chromium.launch({ headless: true, executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const msgs = [];
    page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
    page.on('pageerror', (e) => msgs.push('[pageerror] ' + String(e.message).slice(0, 220)));
    await page.goto('http://127.0.0.1:7102/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => {
        const app = window.__airApp;
        const scene = app && app.getScene();
        const names = [];
        scene && scene.children.forEach((c) => names.push(c.name));
        return {
            ready: window.__appReady,
            state: window.__bench.getState(),
            sceneName: scene && scene.name,
            children: names,
        };
    });
    console.log('INFO:', JSON.stringify(info, null, 1));

    const shot = await page.screenshot();
    const an = await browser.newPage();
    const grid = await an.evaluate(async (b64png) => {
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('decode'));
            i.src = 'data:image/png;base64,' + b64png;
        });
        const w = img.width, h = img.height;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, w, h).data;
        const GX = 16, GY = 10;
        const out = [];
        for (let gy = 0; gy < GY; gy++) {
            let row = '';
            for (let gx = 0; gx < GX; gx++) {
                let r = 0, g = 0, b = 0, n = 0;
                for (let y = Math.floor((gy * h) / GY); y < Math.floor(((gy + 1) * h) / GY); y += 4) {
                    for (let x = Math.floor((gx * w) / GX); x < Math.floor(((gx + 1) * w) / GX); x += 4) {
                        const i = (y * w + x) * 4;
                        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
                    }
                }
                const R = r / n, G = g / n, B = b / n;
                const lum = (R + G + B) / 3;
                const ch = lum < 4 ? '.' : lum < 16 ? '-' : lum < 48 ? '+' : lum < 120 ? '*' : '#';
                row += ch;
            }
            out.push(row);
        }
        return out.join('\n') + `\navgFull=(${(d.reduce ? 0 : 0)},see-above)`;
    }, shot.toString('base64'));
    console.log('GRID:\n' + grid);
    console.log('CONSOLE(' + msgs.length + '):\n' + msgs.slice(0, 40).join('\n'));
    await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
