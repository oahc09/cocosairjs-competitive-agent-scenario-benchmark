/** E10 诊断4:近景截图 + 材质替换实验(builtin-standard 纯色) + GL 错误 */
const { chromium } = require('playwright-core');
const EXE = process.env.CHROMIUM_EXE;
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:7106/';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: EXE });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__appReady === true, { timeout: 10000 });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'verify-shots/diag4-fox.png', clip: { x: 80, y: 108, width: 480, height: 576 } });

    const glErr = await page.evaluate(() => {
        const canvas = document.querySelector('#GameCanvas');
        const gl = canvas.getContext('webgl2');
        return gl.getError();
    });
    console.log('gl.getError() =', glErr);

    // 狐狸材质信息(正确属性)
    const info = await page.evaluate(() => {
        const out = [];
        const scene = window.__airApp.getScene();
        const visit = (n) => {
            const smr = n.getComponent && (n.getComponent('cc.SkinnedMeshRenderer') || n.getComponent('cc.MeshRenderer'));
            if (smr && (n.name.startsWith('fox') || n.name === 'Ground' || n.name === 'Backdrop')) {
                const mats = smr.sharedMaterials || [];
                out.push({
                    node: n.name,
                    mats: mats.map((m) => ({
                        name: m && m.name,
                        effect: m && m.effectAsset && m.effectAsset.name,
                        tech: m && m.technique,
                        defines: m && m.passes && m.passes.map((p) => {
                            try { return p.defines; } catch (e) { return '?'; }
                        }),
                    })),
                });
            }
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
        return out;
    });
    console.log(JSON.stringify(info, null, 2).slice(0, 3000));
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
