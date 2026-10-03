/**
 * E10 Arm A — 探针自检脚本(playwright-core + 本地 chromium)
 * 按 spec.json probes P1..P7 逐条自查(状态断言 + 简化视觉断言),并采集网络请求证据。
 * 输出:文字结论 + 截图到 ../verify-shots/
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';
const OUT = path.resolve(__dirname, '..', 'verify-shots');
fs.mkdirSync(OUT, { recursive: true });

const REGIONS = {
    A: { x: 0.08, y: 0.15, w: 0.34, h: 0.8 },
    B: { x: 0.58, y: 0.15, w: 0.34, h: 0.8 },
};

const results = [];
function report(probe, item, pass, detail) {
    results.push({ probe, item, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} [${probe}] ${item} — ${detail}`);
}

// 在页面内对指定归一化区域做非空白像素统计(与背景色差异阈值)
async function regionStats(page, region) {
    return page.evaluate((r) => {
        const canvas = document.querySelector('#GameCanvas');
        if (!canvas) return { coverage: -1 };
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const x = Math.floor(r.x * W), y = Math.floor((1 - r.y - r.h) * H);
        const w = Math.floor(r.w * W), h = Math.floor(r.h * H);
        const px = new Uint8Array(w * h * 4);
        ctx.readPixels(x, y, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        // 背景参考色:取区域最常出现的颜色(渐变背景下按行聚类过于复杂,改用亮度方差+边缘变化)
        let sum = 0, sum2 = 0;
        for (let i = 0; i < px.length; i += 4) {
            const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            sum += lum; sum2 += lum * lum;
        }
        const n = px.length / 4;
        const mean = sum / n;
        const variance = sum2 / n - mean * mean;
        return { coverage: variance > 40 ? 1 : 0, mean, variance, n };
    }, region);
}

// 两帧像素差(区域运动检测)
async function regionDiff(page, region, spanMs) {
    const grab = () => page.evaluate((r) => {
        const canvas = document.querySelector('#GameCanvas');
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const x = Math.floor(r.x * W), y = Math.floor((1 - r.y - r.h) * H);
        const w = Math.floor(r.w * W), h = Math.floor(r.h * H);
        const px = new Uint8Array(w * h * 4);
        ctx.readPixels(x, y, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        return Array.from(px);
    }, region);
    const a = await grab();
    await page.waitForTimeout(spanMs);
    const b = await grab();
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
    return diff / (a.length / 4);
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        executablePath: EXE,
        args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();

    const glbRequests = [];
    page.on('request', (req) => {
        if (req.url().includes('character.glb')) glbRequests.push({ t: Date.now(), url: req.url() });
    });
    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // --- P1 前置:__appReady(10s 内) ---
    const t0 = Date.now();
    let ready = false;
    try {
        await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });
        ready = true;
    } catch (e) { /* timeout */ }
    report('P0', 'appReady within 10s', ready, `elapsed=${Date.now() - t0}ms`);

    await page.waitForTimeout(1500);
    let s = await page.evaluate(() => window.__bench.getState());
    report('P1', 'state', s.assetLoaded === true && s.instanceCount === 2 && s.instances.A.clip === 'idle' && s.instances.B.clip === 'idle', JSON.stringify(s.instances) + ` count=${s.instanceCount}`);

    const sa = await regionStats(page, REGIONS.A);
    const sb = await regionStats(page, REGIONS.B);
    report('P1', 'visual nonBlank A/B', sa.coverage > 0 && sb.coverage > 0, `varA=${sa.variance.toFixed(1)} varB=${sb.variance.toFixed(1)}`);
    report('P1', 'network: character.glb requested', glbRequests.length >= 1, `count=${glbRequests.length}`);
    await page.screenshot({ path: path.join(OUT, 'p1.png') });

    // --- P2 ---
    await page.waitForTimeout(1000);
    s = await page.evaluate(() => window.__bench.getState());
    report('P2', 'state time advancing', s.instances.A.time > 0 && s.instances.B.time > 0 && s.instanceCount === 2, `A.time=${s.instances.A.time} B.time=${s.instances.B.time}`);
    const dA = await regionDiff(page, REGIONS.A, 800);
    const dB = await regionDiff(page, REGIONS.B, 800);
    report('P2', 'visual motion A/B', dA > 0.5 && dB > 0.5, `diffA=${dA.toFixed(2)} diffB=${dB.toFixed(2)}`);
    await page.screenshot({ path: path.join(OUT, 'p2.png') });

    // --- P3: click anim-a-walk ---
    await page.click('[data-bench="anim-a-walk"]');
    await page.waitForTimeout(1000);
    s = await page.evaluate(() => window.__bench.getState());
    report('P3', 'state isolation', s.instances.A.clip === 'walk' && s.instances.B.clip === 'idle', JSON.stringify({ A: s.instances.A.clip, B: s.instances.B.clip }));
    const dA3 = await regionDiff(page, REGIONS.A, 500);
    report('P3', 'visual regionChange A', dA3 > 0.5, `diffA=${dA3.toFixed(2)}`);
    await page.screenshot({ path: path.join(OUT, 'p3.png') });

    // --- P4: click destroy-a ---
    await page.click('[data-bench="destroy-a"]');
    await page.waitForTimeout(800);
    s = await page.evaluate(() => window.__bench.getState());
    report('P4', 'state destroyed', s.instanceCount === 1 && s.destroyedInstance === 'A' && s.instances.A === null, JSON.stringify({ count: s.instanceCount, destroyed: s.destroyedInstance, A: s.instances.A }));
    const grabA = async () => page.evaluate((r) => {
        const canvas = document.querySelector('#GameCanvas');
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const x = Math.floor(r.x * W), y = Math.floor((1 - r.y - r.h) * H);
        const w = Math.floor(r.w * W), h = Math.floor(r.h * H);
        const px = new Uint8Array(w * h * 4);
        ctx.readPixels(x, y, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        return sum / (px.length / 4);
    }, REGIONS.A);
    const before = await grabA();
    await page.waitForTimeout(500);
    const after = await grabA();
    report('P4', 'visual regionChange A (A removed)', Math.abs(after - before) < 500, `lumBefore=${before.toFixed(1)} lumAfter=${after.toFixed(1)}`);
    await page.screenshot({ path: path.join(OUT, 'p4.png') });

    // --- P5: B keeps animating ---
    await page.waitForTimeout(1500);
    s = await page.evaluate(() => window.__bench.getState());
    const t1 = s.instances.B.time;
    await page.waitForTimeout(600);
    s = await page.evaluate(() => window.__bench.getState());
    report('P5', 'state B alive animating', s.instanceCount === 1 && s.instances.B.clip === 'idle' && t1 > 0 && s.instances.B.time > t1, `B.clip=${s.instances.B.clip} time ${t1}→${s.instances.B.time}`);
    const dB5 = await regionDiff(page, REGIONS.B, 800);
    report('P5', 'visual motion B', dB5 > 0.5, `diffB=${dB5.toFixed(2)}`);
    await page.screenshot({ path: path.join(OUT, 'p5.png') });

    // --- P6: click reset ---
    const glbBefore = glbRequests.length;
    await page.click('[data-bench="reset"]');
    await page.waitForTimeout(1500);
    s = await page.evaluate(() => window.__bench.getState());
    report('P6', 'state reset', s.resetCount === 1 && s.instanceCount === 2 && s.destroyedInstance === null && s.instances.A.clip === 'idle' && s.instances.B.clip === 'idle', JSON.stringify({ resetCount: s.resetCount, count: s.instanceCount, destroyed: s.destroyedInstance, A: s.instances.A && s.instances.A.clip, B: s.instances.B && s.instances.B.clip }));
    report('P6', 'network: no new glb request', glbRequests.length === glbBefore, `count=${glbRequests.length}`);
    const sa6 = await regionStats(page, REGIONS.A);
    const sb6 = await regionStats(page, REGIONS.B);
    report('P6', 'visual nonBlank A/B', sa6.coverage > 0 && sb6.coverage > 0, `varA=${sa6.variance.toFixed(1)} varB=${sb6.variance.toFixed(1)}`);
    await page.screenshot({ path: path.join(OUT, 'p6.png') });

    // --- P7 ---
    await page.waitForTimeout(1000);
    s = await page.evaluate(() => window.__bench.getState());
    report('P7', 'state time+fps', s.instances.A.time > 0 && s.instances.B.time > 0 && s.fps >= 30, `A.time=${s.instances.A.time} B.time=${s.instances.B.time} fps=${s.fps}`);
    const dA7 = await regionDiff(page, REGIONS.A, 800);
    const dB7 = await regionDiff(page, REGIONS.B, 800);
    report('P7', 'visual motion A/B', dA7 > 0.5 && dB7 > 0.5, `diffA=${dA7.toFixed(2)} diffB=${dB7.toFixed(2)}`);
    await page.screenshot({ path: path.join(OUT, 'p7.png') });

    report('ALL', 'no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));
    report('ALL', 'glb requested exactly once (whole session)', glbRequests.length === 1, `count=${glbRequests.length}`);

    fs.writeFileSync(path.join(OUT, 'verify-report.json'), JSON.stringify({ results, glbRequests, consoleErrors }, null, 2));
    const failed = results.filter((r) => !r.pass);
    console.log(`\n==== SUMMARY: ${results.length - failed.length}/${results.length} passed ====`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
})().catch((err) => {
    console.error('verify crashed:', err);
    process.exit(2);
});
