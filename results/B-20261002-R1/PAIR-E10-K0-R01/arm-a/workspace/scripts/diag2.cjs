/** E10 诊断2:狐狸/地面/背景像素取样 + 全量 console 输出 */
const { chromium } = require('playwright-core');
const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: EXE });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });
    await page.waitForTimeout(2500);

    const samples = await page.evaluate(() => {
        const canvas = document.querySelector('#GameCanvas');
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const px = (nx, ny) => {
            const out = new Uint8Array(4);
            ctx.readPixels(Math.floor(nx * W), Math.floor((1 - ny) * H), 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
            return [out[0], out[1], out[2]];
        };
        const avg = (nx, ny, r) => {
            const w = 24;
            const out = new Uint8Array(w * w * 4);
            ctx.readPixels(Math.floor(nx * W) - w / 2, Math.floor((1 - ny) * H) - w / 2, w, w, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
            let R = 0, G = 0, B = 0;
            for (let i = 0; i < out.length; i += 4) { R += out[i]; G += out[i + 1]; B += out[i + 2]; }
            const n = out.length / 4;
            return [Math.round(R / n), Math.round(G / n), Math.round(B / n)];
        };
        return {
            foxA_body: avg(0.25, 0.45, 0), foxA_head: avg(0.25, 0.62, 0),
            foxB_body: avg(0.75, 0.45, 0), foxB_head: avg(0.75, 0.62, 0),
            ground_left: avg(0.25, 0.12, 0), ground_right: avg(0.75, 0.12, 0),
            platform_A: avg(0.25, 0.22, 0),
            backdrop_top: avg(0.5, 0.92, 0), backdrop_mid: avg(0.5, 0.75, 0), backdrop_low: avg(0.5, 0.3, 0),
            canvasSize: [W, H],
        };
    });
    console.log(JSON.stringify(samples, null, 2));

    // 引擎侧材质信息
    const matInfo = await page.evaluate(() => {
        const app = window.__airApp;
        const scene = app && app.getScene();
        const out = [];
        const visit = (n) => {
            const smr = n.getComponent && (n.getComponent('cc.SkinnedMeshRenderer') || n.getComponent('cc.MeshRenderer'));
            if (smr) {
                const mats = smr.getSharedMaterials ? smr.getSharedMaterials() : [];
                out.push({
                    node: n.name,
                    type: smr.constructor.name,
                    mats: mats.map((m) => m && ({ name: m.name, effect: m.effectName || (m.effectAsset && m.effectAsset.name) })),
                });
            }
            for (const c of n.children || []) visit(c);
        };
        if (scene) visit(scene);
        return out.slice(0, 12);
    });
    console.log('materials:', JSON.stringify(matInfo, null, 2));
    console.log('---- console logs ----');
    for (const l of logs) console.log(l);
    await page.screenshot({ path: 'verify-shots/diag2.png' });
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
