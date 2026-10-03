/** E10 诊断6:检查狐狸 albedo 纹理绑定;切换 mipFilter 检验 incomplete-mipmap 黑纹理假说 */
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

    // 找到狐狸材质与纹理绑定
    const bindInfo = await page.evaluate(() => {
        const scene = window.__airApp.getScene();
        let mat = null, node = null;
        const visit = (n) => {
            const smr = n.getComponent && n.getComponent('cc.SkinnedMeshRenderer');
            if (smr && n.name.startsWith('fox') && !mat) { mat = smr.sharedMaterials && smr.sharedMaterials[0]; node = n; }
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
        if (!mat) return { error: 'no fox material' };
        const pass = mat.passes[0];
        const binds = [];
        try {
            for (const b of pass.shader.bindingMappings || []) binds.push(b);
        } catch (e) { }
        const textures = {};
        for (const name of ['albedoMap', 'mainTexture', 'albedoTexture', 'diffuseMap']) {
            try {
                const t = mat.getUniform ? null : null;
            } catch (e) { }
        }
        // 直接遍历 pass 上的 texture 属性
        let texInfo = [];
        try {
            const texs = mat.passes.map((p) => {
                const out = {};
                for (const k of ['albedoMap', 'mainTexture', 'emissiveMap', 'metallicRoughnessMap']) {
                    try {
                        const v = p.getBinding ? null : undefined;
                    } catch (e) { }
                }
                return Object.keys(p);
            });
            texInfo = texs;
        } catch (e) { }
        window.__foxMat = mat;
        return { node: node.name, matName: mat.name, passKeys: Object.keys(pass).slice(0, 60) };
    });
    console.log('bindInfo:', JSON.stringify(bindInfo, null, 2).slice(0, 2000));

    // 通过引擎 API 拿纹理(材质属性名尝试多个)
    const texProbe = await page.evaluate(() => {
        const mod = window.__foxMat;
        if (!mod) return 'no mat';
        const names = [];
        for (const k in mod) { if (typeof mod[k] !== 'function') names.push(k); }
        // 常见 gltf 材质属性
        const out = {};
        for (const prop of ['albedoMap', 'mainTexture', 'albedoTexture', 'baseColorMap', 'map']) {
            try {
                const t = mod.getProperty(prop);
                if (t) {
                    out[prop] = {
                        w: t.width, h: t.height,
                        mipmapCount: t.mipmapCount,
                        minFilter: t.minFilter, magFilter: t.magFilter, mipFilter: t.mipFilter,
                        isDefault: t.isDefault,
                    };
                    window.__foxTex = t;
                }
            } catch (e) { }
        }
        return { props: out, keys: names.filter((n) => !n.startsWith('_')).slice(0, 40) };
    });
    console.log('texProbe:', JSON.stringify(texProbe, null, 2));

    const before = await foxSample(0.25, 0.5);
    console.log('before:', before.join(','));

    // 假说检验:关掉 mipmap 过滤
    const toggled = await page.evaluate(() => {
        const mod = window.__foxTex;
        if (!mod) return 'no tex';
        try {
            mod.setMipFilter(0); // Filter.NONE
            return 'mipFilter->NONE ok';
        } catch (e) {
            return 'err ' + e.message;
        }
    });
    console.log('toggle:', toggled);
    await page.waitForTimeout(500);
    console.log('after:', (await foxSample(0.25, 0.5)).join(','));

    await page.screenshot({ path: 'verify-shots/diag6.png', clip: { x: 80, y: 108, width: 480, height: 576 } });
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
