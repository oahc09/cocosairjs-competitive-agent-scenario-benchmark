/**
 * E02 Arm A — 浏览器探针自检脚本(playwright-core + 本机 Chromium)
 * 按 spec.json P1-P7 逐条模拟:状态断言 + 像素/网络/DOM 证据。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require('C:/Users/caosh/AppData/Local/npm-cache/_npx/bd29c0cb7c2b284c/node_modules/playwright-core');
const CHROME = 'C:/Users/caosh/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const URL_ = 'http://127.0.0.1:7102/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function report(id, name, pass, detail) {
    results.push({ id, name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} ${name} | ${detail}`);
}

async function analyze(page, pngB64s, region) {
    // 在空白页解码 PNG 并做区域统计(region: {x0,y0,x1,y1} 比例)
    return await page.evaluate(async ({ pngs, region }) => {
        const load = (data) => new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = () => rej(new Error('img decode fail'));
            img.src = 'data:image/png;base64,' + data;
        });
        const imgs = [];
        for (const p of pngs) imgs.push(await load(p));
        const w = imgs[0].width, h = imgs[0].height;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const datas = imgs.map((im) => {
            ctx.drawImage(im, 0, 0);
            return ctx.getImageData(0, 0, w, h).data;
        });
        const x0 = Math.floor(w * (region.x0 ?? 0)), x1 = Math.floor(w * (region.x1 ?? 1));
        const y0 = Math.floor(h * (region.y0 ?? 0)), y1 = Math.floor(h * (region.y1 ?? 1));
        const avg = datas.map((d) => {
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4;
                r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
            }
            return n ? [r / n, g / n, b / n] : [0, 0, 0];
        });
        const litRatio = (() => {
            const d = datas[0];
            let lit = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4;
                if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 8) lit++;
                n++;
            }
            return n ? lit / n : 0;
        })();
        let motionRatio = 0, diffRatio = 0;
        if (datas.length >= 2) {
            const a = datas[0], b = datas[1];
            let m = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4;
                if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) m++;
                n++;
            }
            motionRatio = n ? m / n : 0;
            let dd = 0, nn = 0;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) dd++;
                nn++;
            }
            diffRatio = nn ? dd / nn : 0;
        }
        return { avg, litRatio, motionRatio, diffRatio, size: [w, h] };
    }, { pngs: pngB64s, region });
}

const b64 = (buf) => buf.toString('base64');

(async () => {
    const browser = await pw.chromium.launch({ headless: true, executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors = [];
    const pageErrors = [];
    const boatResponses = [];
    let navigations = 0;
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => { if (r.url().includes('boat.glb')) boatResponses.push(r.status() + ' ' + r.url()); });
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && f.url() !== URL_) navigations++; });

    const t0 = Date.now();
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });

    // --- P1: 就绪 + 资产 + 网络 + 非空白 ---
    let ready = false;
    while (Date.now() - t0 < 10000) {
        ready = await page.evaluate(() => window.__appReady === true);
        if (ready) break;
        await page.waitForTimeout(200);
    }
    const readyMs = Date.now() - t0;
    await page.waitForTimeout(1500);
    const s1 = await page.evaluate(() => window.__bench.getState());
    const shot1 = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p1-warm.png'), shot1);
    const an = await browser.newPage();
    const p1vis = await analyze(an, [b64(shot1)], { x0: 0, y0: 0, x1: 1, y1: 1 });
    report('P1', 'ready<=10s', ready, `${readyMs}ms`);
    report('P1', 'assetLoaded && assetRequests>=1', s1.assetLoaded === true && s1.assetRequests >= 1, JSON.stringify({ assetLoaded: s1.assetLoaded, assetRequests: s1.assetRequests }));
    report('P1', 'network 200 for boat.glb', boatResponses.some((r) => r.startsWith('200')), boatResponses.join('; '));
    report('P1', 'nonBlank litRatio>=0.05', p1vis.litRatio >= 0.05, `litRatio=${p1vis.litRatio.toFixed(3)} avg=${p1vis.avg[0].map((v) => v.toFixed(0)).join(',')}`);

    // --- P2: 波形相位 + 海面运动(下 60%) ---
    await page.waitForTimeout(500);
    const before2 = await page.evaluate(() => window.__bench.getState());
    const shot2a = await page.screenshot();
    await page.waitForTimeout(1500);
    const after2 = await page.evaluate(() => window.__bench.getState());
    const shot2b = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p2-a.png'), shot2a);
    fs.writeFileSync(path.join(SHOTS, 'p2-b.png'), shot2b);
    const p2vis = await analyze(an, [b64(shot2a), b64(shot2b)], { x0: 0, y0: 0.4, x1: 1, y1: 1 });
    report('P2', 'wavePhase changed', after2.wavePhase !== before2.wavePhase, `${before2.wavePhase.toFixed(3)} -> ${after2.wavePhase.toFixed(3)}`);
    report('P2', 'motion lower60% >= 0.01', p2vis.motionRatio >= 0.01, `motionRatio=${p2vis.motionRatio.toFixed(4)}`);

    // --- P3: 船体竖直坐标变化(900ms 窗 + 4s 序列) ---
    await page.waitForTimeout(300);
    const before3 = await page.evaluate(() => window.__bench.getState().boatPosition.y);
    const shot3a = await page.screenshot();
    await page.waitForTimeout(900);
    const after3 = await page.evaluate(() => window.__bench.getState().boatPosition.y);
    const shot3b = await page.screenshot();
    const p3vis = await analyze(an, [b64(shot3a), b64(shot3b)], { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 });
    const series = await page.evaluate(async () => {
        const ys = [];
        for (let i = 0; i < 9; i++) {
            ys.push(window.__bench.getState().boatPosition.y);
            await new Promise((r) => setTimeout(r, 500));
        }
        return ys;
    });
    const range = Math.max(...series) - Math.min(...series);
    report('P3', 'boatY changed in 900ms', after3 !== before3, `${before3.toFixed(4)} -> ${after3.toFixed(4)}`);
    report('P3', 'motion center40% >= 0.002', p3vis.motionRatio >= 0.002, `motionRatio=${p3vis.motionRatio.toFixed(4)}`);
    report('P3', '4s series range >= 0.02', range >= 0.02, `range=${range.toFixed(4)} samples=${series.map((v) => v.toFixed(2)).join(',')}`);

    // --- P4: 拖拽环绕 ---
    const before4 = await page.evaluate(() => window.__bench.getState());
    const shot4a = await page.screenshot();
    const x1 = 0.50 * 1280, y1 = 0.50 * 800, x2 = 0.78 * 1280;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
        await page.mouse.move(x1 + ((x2 - x1) * i) / 12, y1);
        await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after4 = await page.evaluate(() => window.__bench.getState());
    const shot4b = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p4-before.png'), shot4a);
    fs.writeFileSync(path.join(SHOTS, 'p4-after.png'), shot4b);
    const p4vis = await analyze(an, [b64(shot4a), b64(shot4b)], { x0: 0, y0: 0, x1: 1, y1: 1 });
    const dAz = Math.abs(after4.cameraAzimuth - before4.cameraAzimuth);
    report('P4', 'azimuth delta > 20', dAz > 20, `${before4.cameraAzimuth.toFixed(1)} -> ${after4.cameraAzimuth.toFixed(1)} (d=${dAz.toFixed(1)})`);
    report('P4', 'pixelDelta full >= 0.02', p4vis.diffRatio >= 0.02, `diffRatio=${p4vis.diffRatio.toFixed(4)}`);

    // --- P5: 色调切换 ---
    const before5 = await page.evaluate(() => window.__bench.getState());
    const shot5a = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p5-warm.png'), shot5a);
    await page.click('#tone-toggle');
    await page.waitForTimeout(2500);
    const after5 = await page.evaluate(() => window.__bench.getState());
    const shot5b = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p5-cold.png'), shot5b);
    const p5vis = await analyze(an, [b64(shot5a), b64(shot5b)], { x0: 0, y0: 0, x1: 1, y1: 1 });
    const shift = Math.max(
        Math.abs(p5vis.avg[0][0] - p5vis.avg[1][0]),
        Math.abs(p5vis.avg[0][1] - p5vis.avg[1][1]),
        Math.abs(p5vis.avg[0][2] - p5vis.avg[1][2]),
    );
    const avgWarm = p5vis.avg[0], avgCold = p5vis.avg[1];
    report('P5', 'toneMix > 0.7 after 2.5s', after5.toneMix > 0.7, `toneMix=${after5.toneMix.toFixed(3)}`);
    report('P5', 'avgColorShift >= 8', shift >= 8, `shift=${shift.toFixed(1)} warm=${avgWarm.map((v) => v.toFixed(0)).join(',')} cold=${avgCold.map((v) => v.toFixed(0)).join(',')}`);
    report('P5', 'warm R>B, cold B up & R down', avgWarm[0] > avgWarm[2] && avgCold[2] > avgCold[0], `warmR-warmB=${(avgWarm[0] - avgWarm[2]).toFixed(1)} coldB-coldR=${(avgCold[2] - avgCold[0]).toFixed(1)}`);

    // --- P6: reset #1 ---
    const memBefore = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
    await page.click('#reset');
    await page.waitForTimeout(3000);
    const s6 = await page.evaluate(() => window.__bench.getState());
    const shot6 = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p6-after-reset.png'), shot6);
    const p6vis = await analyze(an, [b64(shot6)], { x0: 0, y0: 0, x1: 1, y1: 1 });
    report('P6', 'epoch>=1 && loaded && warm && az~35', s6.epoch >= 1 && s6.assetLoaded && s6.toneMix < 0.05 && s6.cameraAzimuth >= 32 && s6.cameraAzimuth <= 38,
        JSON.stringify({ epoch: s6.epoch, assetLoaded: s6.assetLoaded, toneMix: +s6.toneMix.toFixed(3), cameraAzimuth: +s6.cameraAzimuth.toFixed(1) }));
    report('P6', 'nonBlank after reset', p6vis.litRatio >= 0.05, `litRatio=${p6vis.litRatio.toFixed(3)}`);
    report('P6', 'no navigation', navigations === 0, `navigations=${navigations}`);

    // --- P7: reset #2 ---
    await page.click('#reset');
    await page.waitForTimeout(3000);
    const s7 = await page.evaluate(() => window.__bench.getState());
    const memAfter = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
    const shot7 = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS, 'p7-after-reset2.png'), shot7);
    const p7vis = await analyze(an, [b64(shot7)], { x0: 0, y0: 0, x1: 1, y1: 1 });
    report('P7', 'epoch>=2 && requests>=2 && warm', s7.epoch >= 2 && s7.assetRequests >= 2 && s7.toneMix < 0.05 && s7.assetLoaded,
        JSON.stringify({ epoch: s7.epoch, assetRequests: s7.assetRequests, toneMix: +s7.toneMix.toFixed(3), assetLoaded: s7.assetLoaded }));
    report('P7', 'nonBlank after reset2', p7vis.litRatio >= 0.05, `litRatio=${p7vis.litRatio.toFixed(3)}`);
    report('P7', 'boat.glb responses count>=3', boatResponses.filter((r) => r.startsWith('200')).length >= 3, `${boatResponses.length} responses: ${boatResponses.join('; ')}`);

    // --- 全局:错误 / fps ---
    report('ALL', 'no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ').slice(0, 200));
    report('ALL', 'no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 200));
    const fps = await page.evaluate(() => window.__bench.getState().fps);
    report('ALL', 'fps >= 30', fps >= 30, `fps=${fps.toFixed(1)}`);
    report('ALL', 'memory sample', true, `usedJSHeap ${(memBefore / 1048576).toFixed(1)}MB -> ${(memAfter / 1048576).toFixed(1)}MB`);

    await an.close();
    await browser.close();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n==== SUMMARY: ${results.length - failed.length}/${results.length} passed ====`);
    fs.writeFileSync(path.join(HERE, 'verify-report.json'), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
})().catch((e) => {
    console.error('SCRIPT ERROR:', e && e.stack ? e.stack : e);
    process.exit(2);
});
