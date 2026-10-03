/** E10 诊断7:FBO 读回狐狸 albedo GPU 纹理 + 重建 raw RGBA 纹理替换试验 + 背景板竖立 */
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

    // 1) 读回狐狸 GPU 纹理中心 8x8
    const gpu = await page.evaluate(() => {
        const canvas = document.querySelector('#GameCanvas');
        const gl = canvas.getContext('webgl2');
        const scene = window.__airApp.getScene();
        let mat = null;
        const visit = (n) => {
            const smr = n.getComponent && n.getComponent('cc.SkinnedMeshRenderer');
            if (smr && n.name.startsWith('fox') && !mat) mat = smr.sharedMaterials[0];
            for (const c of n.children || []) visit(c);
        };
        visit(scene);
        const tex = mat.getProperty('mainTexture');
        window.__foxTex = tex;
        const gfxTex = tex.getGFXTexture();
        const glTex = gfxTex && gfxTex.glTexture;
        if (!glTex) return { error: 'no glTexture', keys: Object.keys(gfxTex || {}) };
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        const out = new Uint8Array(8 * 8 * 4);
        if (status === gl.FRAMEBUFFER_COMPLETE) {
            gl.readPixels(508, 508, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, out);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        return {
            fboStatus: status === gl.FRAMEBUFFER_COMPLETE ? 'complete' : status,
            center: Array.from(out.slice(0, 16)),
        };
    });
    console.log('GPU texture readback:', JSON.stringify(gpu));

    // 2) 用 2D canvas 解码源图 → raw RGBA ImageAsset → 替换 mainTexture
    const fix = await page.evaluate(async () => {
        const mod = await import('/dist/vendor/cocosair.module.js');
        const { Texture2D, ImageAsset } = mod;
        const tex = window.__foxTex;
        // 源 HTMLImageElement 藏在 ImageAsset 里;尝试通过 texture.image / _image 拿
        let el = tex.image && (tex.image.data || tex.image._data) || tex._image && (tex._image.data || tex._image._data);
        if (!el) {
            // 遍历 gltf 资产不可达,退而求其次:从 GPU 读回全图?太大。尝试 texture.imageAsset
            el = tex.imageAsset && (tex.imageAsset.data || tex.imageAsset._data);
        }
        if (!el || !(el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof ImageBitmap)) {
            return { error: 'source element not found', imageKeys: Object.keys(tex.image || tex.imageAsset || {}) };
        }
        const cv = document.createElement('canvas');
        cv.width = el.width || el.naturalWidth; cv.height = el.height || el.naturalHeight;
        const c2 = cv.getContext('2d');
        c2.drawImage(el, 0, 0);
        const data = c2.getImageData(0, 0, cv.width, cv.height);
        const srcAvg = [0, 0, 0];
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) { srcAvg[0] += d[i]; srcAvg[1] += d[i + 1]; srcAvg[2] += d[i + 2]; }
        const n = d.length / 4;
        const ia = new ImageAsset({
            _data: d.buffer,
            width: cv.width,
            height: cv.height,
            format: 2, // RGBATexture
        });
        const nt = new Texture2D();
        nt.image = ia;
        nt.uploadData && nt.uploadData(d.data);
        // 替换材质纹理(两实例共享同一材质)
        const scene = window.__airApp.getScene();
        const visit = (nd) => {
            const smr = nd.getComponent && nd.getComponent('cc.SkinnedMeshRenderer');
            if (smr && nd.name.startsWith('fox')) {
                smr.sharedMaterials[0].setProperty('mainTexture', nt);
            }
            for (const c of nd.children || []) visit(c);
        };
        visit(scene);
        return { srcAvg: srcAvg.map((v) => Math.round(v / n)), w: cv.width, h: cv.height };
    });
    console.log('raw texture rebuild:', JSON.stringify(fix));
    await page.waitForTimeout(600);

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
    console.log('fox after raw tex:', `A mid=${(await foxSample(0.25, 0.45)).join(',')} high=${(await foxSample(0.25, 0.6)).join(',')}  B mid=${(await foxSample(0.75, 0.45)).join(',')} high=${(await foxSample(0.75, 0.6)).join(',')}`);
    await page.screenshot({ path: 'verify-shots/diag7.png' });
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
