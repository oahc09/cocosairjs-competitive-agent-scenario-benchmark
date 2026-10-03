/** E10 诊断:逐 400ms 采样 A/B time + 区域像素差,定位动画冻结时刻 */
const { chromium } = require('playwright-core');
const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';

const REGIONS = {
    A: { x: 0.08, y: 0.15, w: 0.34, h: 0.8 },
    B: { x: 0.58, y: 0.15, w: 0.34, h: 0.8 },
};

async function grab(page, region) {
    return page.evaluate((r) => {
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
    }, region);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: EXE });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200)); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });

    const t = async (label) => {
        const s = await page.evaluate(() => window.__bench.getState());
        console.log(`${label}  A=${s.instances.A ? s.instances.A.clip + '@' + s.instances.A.time.toFixed(2) : 'null'}  B=${s.instances.B ? s.instances.B.clip + '@' + s.instances.B.time.toFixed(2) : 'null'}  fps=${s.fps}`);
    };

    for (let i = 0; i < 3; i++) { await page.waitForTimeout(400); await t(`t${i}`); }
    const a0 = await grab(page, REGIONS.A), b0 = await grab(page, REGIONS.B);
    await page.waitForTimeout(400);
    const a1 = await grab(page, REGIONS.A), b1 = await grab(page, REGIONS.B);
    console.log(`lum deltas: A=${Math.abs(a1 - a0).toFixed(2)} B=${Math.abs(b1 - b0).toFixed(2)}`);

    console.log('--- click anim-a-walk ---');
    await page.click('[data-bench="anim-a-walk"]');
    for (let i = 0; i < 3; i++) { await page.waitForTimeout(400); await t(`w${i}`); }
    const a2 = await grab(page, REGIONS.A), b2 = await grab(page, REGIONS.B);
    await page.waitForTimeout(400);
    const a3 = await grab(page, REGIONS.A), b3 = await grab(page, REGIONS.B);
    console.log(`lum deltas after walk: A=${Math.abs(a3 - a2).toFixed(2)} B=${Math.abs(b3 - b2).toFixed(2)}`);

    console.log('--- click anim-b-walk ---');
    await page.click('[data-bench="anim-b-walk"]');
    for (let i = 0; i < 2; i++) { await page.waitForTimeout(400); await t(`bw${i}`); }
    const b4 = await grab(page, REGIONS.B);
    await page.waitForTimeout(400);
    const b5 = await grab(page, REGIONS.B);
    console.log(`lum deltas B after b-walk: ${Math.abs(b5 - b4).toFixed(2)}`);

    console.log('--- click destroy-a ---');
    await page.click('[data-bench="destroy-a"]');
    for (let i = 0; i < 3; i++) { await page.waitForTimeout(400); await t(`d${i}`); }

    console.log('--- reset ---');
    await page.click('[data-bench="reset"]');
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(400); await t(`r${i}`); }
    const a6 = await grab(page, REGIONS.A), b6 = await grab(page, REGIONS.B);
    await page.waitForTimeout(400);
    const a7 = await grab(page, REGIONS.A), b7 = await grab(page, REGIONS.B);
    console.log(`lum deltas after reset: A=${Math.abs(a7 - a6).toFixed(2)} B=${Math.abs(b7 - b6).toFixed(2)}`);

    await browser.close();
})().catch((e) => { console.error('diag crashed:', e); process.exit(2); });
