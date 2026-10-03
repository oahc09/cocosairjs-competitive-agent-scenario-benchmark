/** E10 诊断8:GPU 纹理读回(v2)+ ImageData 路径重建纹理 */
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
        window.__foxMat = mat;
        const gfxTex = tex.getGFXTexture();
        const glTex = gfxTex && (gfxTex.glTexture || (gfxTex._gpuTexture && gfxTex._gpuTexture.glTexture));
        if (!glTex) return { error: 'still no glTexture', gfxKeys: Object.keys(gfxTex._gpuTexture || {}) };
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        let center = null, corner = null;
        if (status === gl.FRAMEBUFFER_COMPLETE) {
            const read = (x, y) => { const o = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o); return Array.from(o); };
            center = read(512, 512);
            corner = read(8, 8);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        return { fboStatus: status === gl.FRAMEBUFFER_COMPLETE ? 'complete' : String(status), center, corner };
    });
    console.log('GPU readback:', JSON.stringify(gpu));

    // ImageData 路径重建
    const fix = await page.evaluate(async () => {
        const mod = await import('/dist/vendor/cocosair.module.js');
        const { Texture2D, ImageAsset } = mod;
        const tex = window.__foxMat.getProperty('mainTexture');
        let el = null;
        for (const holder of [tex, tex.image, tex.imageAsset, tex._image, tex._imageAsset]) {
            if (!holder) continue;
            for (const k of ['data', '_data', 'src']) {
                const v = holder[k];
                if (v instanceof HTMLImageElement || v instanceof HTMLCanvasElement || v instanceof ImageBitmap) el = el || v;
            }
        }
        if (!el) return { error: 'no source element' };
        const cv = document.createElement('canvas');
        cv.width = el.naturalWidth || el.width; cv.height = el.naturalHeight || el.height;
        const c2 = cv.getContext('2d');
        c2.drawImage(el, 0, 0);
        const imageData = c2.getImageData(0, 0, cv.width, cv.height);
        let s = [0, 0, 0];
        for (let i = 0; i < imageData.data.length; i += 4) { s[0] += imageData.data[i]; s[1] += imageData.data[i + 1]; s[2] += imageData.data[i + 2]; }
        const n = imageData.data.length / 4;
        const ia = new ImageAsset(imageData);
        const nt = new Texture2D();
        nt.image = ia;
        window.__foxMat.setProperty('mainTexture', nt);
        return { srcAvg: s.map((v) => Math.round(v / n)), size: [cv.width, cv.height] };
    });
    console.log('ImageData rebuild:', JSON.stringify(fix));
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
    console.log('fox after ImageData tex:', `A mid=${(await foxSample(0.25, 0.45)).join(',')} high=${(await foxSample(0.25, 0.6)).join(',')}  B mid=${(await foxSample(0.75, 0.45)).join(',')} high=${(await foxSample(0.75, 0.6)).join(',')}`);
    await page.screenshot({ path: 'verify-shots/diag8.png' });
    await browser.close();
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
