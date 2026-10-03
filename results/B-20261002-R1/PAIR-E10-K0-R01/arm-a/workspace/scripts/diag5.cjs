/** E10 诊断5:现场替换狐狸材质为 builtin-standard 纯色,检验几何/法线/光照 vs gltf 材质路径 */
const { chromium } = require('playwright-core');
const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: EXE });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200)); });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });
    await page.waitForTimeout(1500);

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

    console.log('before:', `A mid=${(await foxSample(0.25, 0.45))} high=${(await foxSample(0.25, 0.62))}  B mid=${(await foxSample(0.75, 0.45))} high=${(await foxSample(0.75, 0.62))}`);

    await page.evaluate(() => {
        const { Material, Color } = window.__benchEngine; // 不存在则失败,改走 import()
    }).catch(() => {});

    // 通过动态 import 引擎模块,构造纯色标准材质并替换
    await page.evaluate(async () => {
        const mod = await import('/dist/vendor/cocosair.module.js');
        const { Material, Color } = mod;
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-standard' });
        mat.setProperty('mainColor', new Color(220, 210, 190, 255));
        const scene = window.__airApp.getScene();
        const visit = (n) => {
            const smr = n.getComponent && n.getComponent('cc.SkinnedMeshRenderer');
            if (smr && n.name.startsWith('fox')) {
                smr.setSharedMaterial(mat, 0);
            }
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
    });
    await page.waitForTimeout(500);
    console.log('after std-material:', `A mid=${(await foxSample(0.25, 0.45))} high=${(await foxSample(0.25, 0.62))}  B mid=${(await foxSample(0.75, 0.45))} high=${(await foxSample(0.75, 0.62))}`);
    await page.screenshot({ path: 'verify-shots/diag5-stdmat.png', clip: { x: 80, y: 108, width: 480, height: 576 } });

    // 再试:关闭灯光阴影相关 + 提高 key 光
    await page.evaluate(async () => {
        const scene = window.__airApp.getScene();
        const visit = (n) => {
            const dl = n.getComponent && n.getComponent('cc.DirectionalLight');
            if (dl) dl.illuminance = 80000;
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
    });
    await page.waitForTimeout(400);
    console.log('after boost key:', `A mid=${(await foxSample(0.25, 0.45))} high=${(await foxSample(0.25, 0.62))}  B mid=${(await foxSample(0.75, 0.45))} high=${(await foxSample(0.75, 0.62))}`);
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
