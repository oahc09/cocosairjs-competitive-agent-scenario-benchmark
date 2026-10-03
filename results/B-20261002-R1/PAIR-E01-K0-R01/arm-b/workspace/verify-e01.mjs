/**
 * E01 Arm-B 自检脚本(playwright-core + 本地 Chrome)
 * 按 spec.json probes P1–P7 逐条自查:状态断言 + 视觉断言(像素级)。
 */
import { chromium } from 'playwright-core';
import zlib from 'node:zlib';

const URL = process.env.URL || 'http://127.0.0.1:7101/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const W = 1280;
const H = 720;

// ---------- minimal PNG decoder (RGBA8) ----------
function decodePng(buf) {
    let pos = 8;
    const idat = [];
    let w = 0, h = 0, bd = 8, ct = 6;
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        if (type === 'IHDR') {
            w = buf.readUInt32BE(pos + 8);
            h = buf.readUInt32BE(pos + 12);
            bd = buf[pos + 16];
            ct = buf[pos + 17];
        } else if (type === 'IDAT') {
            idat.push(buf.subarray(pos + 8, pos + 8 + len));
        } else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported png bd=${bd} ct=${ct}`);
    const ch = ct === 6 ? 4 : 3;
    const bpp = ch;
    const stride = w * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const filter = raw[p++];
        const cur = Buffer.from(raw.subarray(p, p + stride));
        p += stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v = cur[x];
            if (filter === 1) v = (v + a) & 255;
            else if (filter === 2) v = (v + b) & 255;
            else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (filter === 4) {
                const pp = a + b - c;
                const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            }
            cur[x] = v;
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            const q = x * bpp;
            out[o] = cur[q]; out[o + 1] = cur[q + 1]; out[o + 2] = cur[q + 2];
            out[o + 3] = ch === 4 ? cur[q + 3] : 255;
        }
        prev = cur;
    }
    return { w, h, data: out };
}

function luma(img, i) {
    return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}
function litRatio(img) {
    let lit = 0;
    const n = img.w * img.h;
    for (let i = 0; i < n; i++) if (luma(img, i * 4) > 40) lit++;
    return lit / n;
}
function regionIter(img, region, cb) {
    let x0 = 0, y0 = 0, x1 = img.w, y1 = img.h;
    if (region === 'center80') { x0 = img.w * 0.1; y0 = img.h * 0.1; x1 = img.w * 0.9; y1 = img.h * 0.9; }
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) cb((y * img.w + x) * 4);
}
function diffRatio(a, b, region = 'full', tol = 10) {
    if (a.w !== b.w || a.h !== b.h) throw new Error('size mismatch');
    let diff = 0, n = 0;
    regionIter(a, region, (i) => {
        n++;
        const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > tol) diff++;
    });
    return diff / n;
}

// ---------- probe helpers ----------
const results = [];
function report(id, ok, detail) {
    results.push({ id, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, clip) {
    return decodePng(await page.screenshot(clip ? { clip } : {}));
}

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME, headless: false });
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const consoleErrors = [];
    const pageErrors = [];
    let navigated = false;
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && f.url() !== URL && !f.url().startsWith('about')) navigated = true; });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // ready contract
    try {
        await page.waitForFunction('window.__appReady === true', null, { timeout: 10000 });
        report('READY', true, '__appReady true within 10s');
    } catch {
        report('READY', false, '__appReady not set within 10s');
    }
    const benchOK = await page.evaluate(() => typeof window.__bench?.getState === 'function' && typeof window.__bench?.reset === 'function');
    report('BENCH-CONTRACT', benchOK, `__bench = { getState, reset } present: ${benchOK}`);

    const getState = () => page.evaluate('window.__bench.getState()');

    // ---- P1 ----
    await sleep(2500);
    const s1 = await getState();
    const img1 = await shot(page);
    const lit1 = litRatio(img1);
    report('P1', s1.starCount >= 50000 && lit1 >= 0.02, `starCount=${s1.starCount} litRatio=${(lit1 * 100).toFixed(2)}% (>=2%)`);

    // ---- P2 ----
    await sleep(500);
    const b2 = await getState();
    const m1 = await shot(page);
    await sleep(2000);
    const a2 = await getState();
    const m2 = await shot(page);
    const dPhase = a2.rotationPhase - b2.rotationPhase;
    const motion = diffRatio(m1, m2, 'center80', 10);
    report('P2', dPhase > 0.001 && motion >= 0.005, `dPhase=${dPhase.toFixed(4)}rad motionRatio(center80)=${(motion * 100).toFixed(2)}% (>=0.5%)`);

    // ---- P3 ----
    await page.mouse.move(W * 0.5, H * 0.5);
    await sleep(300);
    const b3 = await getState();
    const p1 = await shot(page);
    await page.mouse.move(W * 0.68, H * 0.5, { steps: 4 });
    await sleep(400);
    const b3b = await getState(); // "动作后 before 采样"
    await sleep(600);
    const a3 = await getState();
    const p2 = await shot(page);
    const pxD3 = diffRatio(p1, p2, 'full', 10);
    const parChanged = a3.parallaxOffset.x !== b3b.parallaxOffset.x || a3.parallaxOffset.y !== b3b.parallaxOffset.y;
    report('P3', parChanged && pxD3 >= 0.003, `parallax(${b3b.parallaxOffset.x.toFixed(3)},${b3b.parallaxOffset.y.toFixed(3)})->(${a3.parallaxOffset.x.toFixed(3)},${a3.parallaxOffset.y.toFixed(3)}) diffRatio=${(pxD3 * 100).toFixed(2)}% (>=0.3%)`);

    // ---- P4 ----
    const b4 = await getState(); // wheel 前
    await page.mouse.wheel(0, -600);
    await sleep(500);
    const b4b = await getState(); // before 采样
    const z1 = await shot(page);
    await sleep(300);
    const a4 = await getState();
    const z2 = await shot(page);
    const pxD4 = diffRatio(z1, z2, 'full', 10);
    report('P4', a4.cameraDistance < b4b.cameraDistance - 5 && pxD4 >= 0.01, `dist ${b4b.cameraDistance.toFixed(1)}(pre-action ${b4.cameraDistance.toFixed(1)})->${a4.cameraDistance.toFixed(1)} diffRatio=${(pxD4 * 100).toFixed(2)}% (>=1%)`);

    // ---- P5 ----
    await sleep(1000);
    const s5 = await getState();
    const hudText = await page.evaluate("document.getElementById('hud')?.textContent || ''");
    const fpsShown = String(Math.max(0, Math.round(s5.fps)));
    const starsShown = String(s5.starCount);
    const hudOK = s5.hudVisible === true && s5.fps > 0 && hudText.includes(starsShown) && hudText.includes(fpsShown);
    const hudBox = await page.evaluate(() => { const el = document.getElementById('hud'); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const hudShot = await shot(page, { x: hudBox.x, y: hudBox.y, width: hudBox.w, height: hudBox.h });
    const hudLit = litRatio(hudShot);
    report('P5', hudOK && hudLit > 0.001, `hudVisible=${s5.hudVisible} fps=${s5.fps.toFixed(1)} hudText="${hudText.replace(/\n/g, ' | ')}" hudRegionNonBlank=${(hudLit * 100).toFixed(2)}%`);

    // ---- P6 ----
    // 独立帧率采样 3s(与状态 fps 交叉验证)
    const rafFps = await page.evaluate(() => new Promise((resolve) => {
        const times = [];
        function cb(t) { times.push(t); if (t - times[0] < 3000) requestAnimationFrame(cb); else resolve((times.length - 1) / ((times[times.length - 1] - times[0]) / 1000)); }
        requestAnimationFrame(cb);
    }));
    await sleep(200);
    const s6 = await getState();
    report('P6', s6.fps >= 30 && rafFps >= 30, `stateFps=${s6.fps.toFixed(1)} indepRafFps=${rafFps.toFixed(1)} (both >=30)`);

    // ---- P7 ----
    await page.mouse.move(W * 0.5, H * 0.5);
    await sleep(300);
    await page.click('#resetBtn');
    await sleep(800);
    const s7 = await getState();
    const img7 = await shot(page);
    const lit7 = litRatio(img7);
    const epoch0 = s7.epoch;
    const p7ok =
        s7.epoch >= 1 && s7.cameraDistance >= 115 && s7.cameraDistance <= 125 &&
        Math.abs(s7.parallaxOffset.x) < 0.01 && Math.abs(s7.parallaxOffset.y) < 0.01 &&
        s7.rotationPhase < 0.1 && lit7 >= 0.02 && !navigated;
    report('P7', p7ok, `epoch=${s7.epoch} dist=${s7.cameraDistance.toFixed(1)} par=(${s7.parallaxOffset.x.toFixed(4)},${s7.parallaxOffset.y.toFixed(4)}) phase=${s7.rotationPhase.toFixed(4)} lit=${(lit7 * 100).toFixed(2)}% nav=${navigated}`);

    // reset 连续一致性
    await page.click('#resetBtn');
    await sleep(900);
    const s7b = await getState();
    report('P7-repeat', s7b.epoch === epoch0 + 1 && Math.abs(s7b.cameraDistance - 120) < 5 && !navigated, `second reset epoch=${s7b.epoch} dist=${s7b.cameraDistance.toFixed(1)}`);

    // ---- console / page errors ----
    report('NO-UNCAUGHT', pageErrors.length === 0, `pageErrors=${JSON.stringify(pageErrors.slice(0, 5))}`);
    report('NO-CONSOLE-ERROR', consoleErrors.length === 0, `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 5))}`);

    await page.screenshot({ path: 'verify-final.png' });
    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('VERIFY-SCRIPT-FATAL', e); process.exit(2); });
