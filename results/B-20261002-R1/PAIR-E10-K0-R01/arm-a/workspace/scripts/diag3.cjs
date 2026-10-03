/** E10 诊断3:正确采样 + 运行时切换阴影/主光方向,定位狐狸发黑原因 */
const { chromium } = require('playwright-core');
const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: EXE });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });
    await page.waitForTimeout(2000);

    // 正确的 bottom-based 采样:hgt ∈ [0,1] 从底部起
    const sample = (h) => page.evaluate((hgt) => {
        const canvas = document.querySelector('#GameCanvas');
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const out = new Uint8Array(4 * 9);
        const y = Math.floor(hgt * H) - 1;
        ctx.readPixels(Math.floor(W / 2) - 1, y, 3, 3, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
        let R = 0, G = 0, B = 0;
        for (let i = 0; i < out.length; i += 4) { R += out[i]; G += out[i + 1]; B += out[i + 2]; }
        return [Math.round(R / 9), Math.round(G / 9), Math.round(B / 9)];
    }, h);

    const foxSample = (nx, hgt) => page.evaluate(({ nx, hgt }) => {
        const canvas = document.querySelector('#GameCanvas');
        const ctx = canvas.getContext('webgl2');
        const W = canvas.width, H = canvas.height;
        const w = 24;
        const out = new Uint8Array(w * w * 4);
        ctx.readPixels(Math.floor(nx * W) - w / 2, Math.floor(hgt * H) - w / 2, w, w, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
        let R = 0, G = 0, B = 0;
        for (let i = 0; i < out.length; i += 4) { R += out[i]; G += out[i + 1]; B += out[i + 2]; }
        return [Math.round(R / (w * w)), Math.round(G / (w * w)), Math.round(B / (w * w))];
    }, { nx, hgt });

    const strip = async () => {
        const rows = [];
        for (let i = 1; i <= 9; i++) rows.push(`h${i}0%:${(await sample(i / 10)).join(',')}`);
        console.log('  center strip:', rows.join(' '));
        console.log(`  foxA(0.25): base=${(await foxSample(0.25, 0.28)).join(',')} mid=${(await foxSample(0.25, 0.45)).join(',')} high=${(await foxSample(0.25, 0.62)).join(',')}`);
        console.log(`  foxB(0.75): base=${(await foxSample(0.75, 0.28)).join(',')} mid=${(await foxSample(0.75, 0.45)).join(',')} high=${(await foxSample(0.75, 0.62)).join(',')}`);
    };

    console.log('--- baseline ---');
    await strip();

    console.log('--- toggle: disable shadows ---');
    await page.evaluate(() => {
        const scene = window.__airApp.getScene();
        scene.globals.shadows.enabled = false;
        const visit = (n) => {
            const dl = n.getComponent && n.getComponent('cc.DirectionalLight');
            if (dl) dl.shadowEnabled = false;
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
    });
    await page.waitForTimeout(300);
    await strip();

    console.log('--- toggle: yaw key light 180deg ---');
    await page.evaluate(() => {
        const scene = window.__airApp.getScene();
        const visit = (n) => {
            const dl = n.getComponent && n.getComponent('cc.DirectionalLight');
            if (dl) {
                const e = n.eulerAngles;
                n.setRotationFromEuler(e.x, e.y + 180, e.z);
            }
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
    });
    await page.waitForTimeout(300);
    await strip();

    console.log('--- toggle: restore yaw, boost ambient ---');
    await page.evaluate(() => {
        const scene = window.__airApp.getScene();
        scene.globals.ambient.skyIllum = 30000;
        const visit = (n) => {
            const dl = n.getComponent && n.getComponent('cc.DirectionalLight');
            if (dl) {
                const e = n.eulerAngles;
                n.setRotationFromEuler(e.x, e.y - 180, e.z);
            }
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
    });
    await page.waitForTimeout(300);
    await strip();
    await page.screenshot({ path: 'verify-shots/diag3.png' });
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
