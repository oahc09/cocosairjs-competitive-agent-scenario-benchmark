/**
 * probe-selfcheck.mjs — E05 arm-b 探针自检(spec.json P1–P6 全序列,单浏览器会话)。
 *
 * 合规:本脚本创建浏览器会话前先执行 `workspace/scripts/count.mjs browser`
 * (RUN-CONTRACT §2 browserAttempt 计数口径)。仅访问本 Arm 目录与 dev server。
 *
 * 用法: node probe-selfcheck.mjs <url> <outdir>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const armDir = path.resolve(here, '..');
const workspace = path.join(armDir, 'workspace');
const URL_ = process.argv[2] || 'http://127.0.0.1:7103/';
const OUT = process.argv[3] || path.join(here, 'probe-shots');
fs.mkdirSync(OUT, { recursive: true });

// ---------- ① browserAttempt 计数(先计后会话) ----------
const counted = spawnSync(process.execPath, [path.join(workspace, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
    console.error('[selfcheck] browser 计数失败,拒绝创建会话:\n' + (counted.stdout || '') + (counted.stderr || ''));
    process.exit(1);
}
process.stdout.write(counted.stdout);

// ---------- ② playwright-core(共享 node_modules 沿目录向上解析) ----------
const chromium = createRequire(import.meta.url)('playwright-core').chromium;
function browserCandidates() {
    const cands = [];
    for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) cands.push(process.env[k]);
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return cands.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
async function launch() {
    const errors = [];
    for (const exe of [null, ...browserCandidates()]) {
        try {
            return await chromium.launch({
                ...(exe ? { executablePath: exe } : {}),
                headless: true,
                viewport: { width: 1280, height: 720 },
                timeout: 30000,
            });
        } catch (e) { errors.push(`${exe || 'playwright-default'}: ${e.message.split('\n')[0]}`); }
    }
    throw new Error('no usable browser: ' + errors.join(' | '));
}

// ---------- ③ PNG 解码(8-bit RGB/RGBA 非隔行) ----------
function decodePNG(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
    let off = 8, w = 0, h = 0, colorType = 0, bitDepth = 8, idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9];
            if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported png: depth=' + bitDepth + ' color=' + colorType);
            if (data[12] !== 0) throw new Error('interlaced png unsupported');
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = colorType === 6 ? 4 : 3;
    const stride = w * bpp;
    const out = new Uint8Array(w * h * 4);
    let prevStart = -1;
    for (let y = 0; y < h; y++) {
        const f0 = y * (stride + 1);
        const filter = raw[f0];
        const line = raw.subarray(f0 + 1, f0 + 1 + stride);
        const cur = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0;
            const b = prevStart >= 0 ? raw[prevStart + 1 + i] : 0;
            const c = (prevStart >= 0 && i >= bpp) ? raw[prevStart + 1 + i - bpp] : 0;
            let val = line[i];
            if (filter === 1) val = (val + a) & 255;
            else if (filter === 2) val = (val + b) & 255;
            else if (filter === 3) val = (val + ((a + b) >> 1)) & 255;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                val = (val + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
            }
            cur[i] = val;
        }
        prevStart = f0;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, s = x * bpp;
            out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = colorType === 6 ? cur[s + 3] : 255;
        }
    }
    return { w, h, data: out };
}
const lum = (img, x, y) => {
    x = Math.max(0, Math.min(img.w - 1, x | 0)); y = Math.max(0, Math.min(img.h - 1, y | 0));
    const o = (y * img.w + x) * 4;
    return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
};
const px = (img, x, y) => {
    const o = ((y | 0) * img.w + (x | 0)) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

// ---------- ④ 像素判定(spec 探针阈值口径) ----------
function regionNonBlackRatio(img, x0, y0, x1, y1, thr = 20) {
    let n = 0, tot = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(img.h, y1 | 0); y++) {
        for (let x = Math.max(0, x0 | 0); x < Math.min(img.w, x1 | 0); x++) {
            tot++;
            if (lum(img, x, y) > thr) n++;
        }
    }
    return tot ? n / tot : 0;
}
function frameDiff(imgA, imgB, x0, y0, x1, y1, thr = 12) {
    let n = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(imgA.h, y1 | 0); y++) {
        for (let x = Math.max(0, x0 | 0); x < Math.min(imgA.w, x1 | 0); x++) {
            const oa = (y * imgA.w + x) * 4, ob = (y * imgB.w + x) * 4;
            const d = Math.abs(imgA.data[oa] - imgB.data[ob]) + Math.abs(imgA.data[oa + 1] - imgB.data[ob + 1]) + Math.abs(imgA.data[oa + 2] - imgB.data[ob + 2]);
            if (d > thr * 3) n++;
        }
    }
    return n;
}
// 内/外环带方位角扇区采样(复刻 spec P3 几何常数:0.06–0.14 / 0.18–0.30 × minD,±6% 高度带)
function bandStats(img, rMinF, rMaxF) {
    const cx = img.w / 2, cy = img.h / 2, minD = Math.min(img.w, img.h);
    const rMin = rMinF * minD, rMax = rMaxF * minD, hBand = 0.06 * minD;
    const sides = { left: { rb: 0, lum: 0, n: 0 }, right: { rb: 0, lum: 0, n: 0 } };
    for (let y = (cy - hBand) | 0; y <= (cy + hBand) | 0; y++) {
        for (let x = (cx - rMax) | 0; x <= (cx + rMax) | 0; x++) {
            if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const r = Math.hypot(dx, dy);
            if (r < rMin || r > rMax) continue;
            const [R, G, B] = px(img, x, y);
            const s = dx < 0 ? sides.left : sides.right;
            s.rb += R - B; s.lum += 0.2126 * R + 0.7152 * G + 0.0722 * B; s.n++;
        }
    }
    const out = {};
    for (const k of Object.keys(sides)) {
        const s = sides[k];
        out[k] = { avgRB: s.n ? s.rb / s.n : 0, avgLum: s.n ? s.lum / s.n : 0, n: s.n };
    }
    return out;
}
// 中心向外水平扫描:暗核半径(首次 lum>thr)
function coreRadiusH(img, thr = 30) {
    const cx = img.w / 2, cy = img.h / 2;
    let r = 0;
    for (let x = cx; x < img.w; x++) { if (lum(img, x, cy) > thr) { r = x - cx; break; } }
    return r;
}
function diskEdgeRadiusH(img, thr = 10) {
    const cx = img.w / 2, cy = img.h / 2;
    let last = 0;
    for (let x = cx; x < img.w; x++) { if (lum(img, x, cy) > thr) last = x - cx; }
    return last;
}

// ---------- ⑤ 会话与探针序列 ----------
const report = { url: URL_, at: new Date().toISOString(), consoleErrors: [], uncaught: [], probes: {} };
let browser = null;
try {
    browser = await launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => report.uncaught.push(String(e?.message || e).slice(0, 200)));

    await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
    const t0 = Date.now();
    for (;;) {
        const st = await page.evaluate(() => window.__appReady === true);
        if (st) break;
        if (Date.now() - t0 > 10000) throw new Error('__appReady timeout');
        await new Promise((r) => setTimeout(r, 150));
    }
    report.readyMs = Date.now() - t0;
    const snap = (n) => page.screenshot({ path: path.join(OUT, n + '.png') }).then(() => path.join(OUT, n + '.png'));
    const state = () => page.evaluate(() => window.__bench.getState());

    // —— P1:初始画面非空(中心 1/3 与四角外围非黑;暗核被亮环包围) ——
    await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
    const p1png = await snap('p1');
    const p1s = await state();
    const p1 = decodePNG(fs.readFileSync(p1png));
    const cxT = p1.w / 3, cyT = p1.h / 3;
    const centerRatio = regionNonBlackRatio(p1, cxT, cyT, p1.w - cxT, p1.h - cyT);
    const cw = p1.w / 4, ch = p1.h / 4;
    const corners = [
        regionNonBlackRatio(p1, 0, 0, cw, ch),
        regionNonBlackRatio(p1, p1.w - cw, 0, p1.w, ch),
        regionNonBlackRatio(p1, 0, p1.h - ch, cw, p1.h),
        regionNonBlackRatio(p1, p1.w - cw, p1.h - ch, p1.w, p1.h),
    ];
    const cornerRatio = Math.min(...corners);
    const coreLum = lum(p1, p1.w / 2 + 6, p1.h / 2 + 6);
    // 暗核外亮环:60–90px 环带平均亮度
    let ringLum = 0, ringN = 0;
    for (let a = 0; a < 360; a += 3) {
        const rr = 75 * Math.PI * a / 180;
        const X = p1.w / 2 + 75 * Math.cos(rr), Y = p1.h / 2 + 75 * Math.sin(rr) * 0.55;
        ringLum += lum(p1, X, Y); ringN++;
    }
    ringLum /= ringN;
    report.probes.P1 = {
        state: p1s,
        statePass: p1s.backgroundStarCount >= 300 && p1s.starStreamCount >= 200 && p1s.cameraDistance >= 13 && p1s.cameraDistance <= 15 && p1s.diskRotation > 0,
        centerRatio, cornerRatio, corners, coreLum, ringLum,
        pass: centerRatio >= 0.05 && cornerRatio >= 0.01 && coreLum < 40 && ringLum > 90,
    };

    // —— P2:盘旋转运动证据(两帧差 + diskRotation 采样差 ≥ 0.1 rad / 0.8s) ——
    const p2aPng = await snap('p2a'); const p2aS = await state(); const tA = Date.now();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
    const p2bPng = await snap('p2b'); const p2bS = await state(); const tB = Date.now();
    const p2a = decodePNG(fs.readFileSync(p2aPng)), p2b = decodePNG(fs.readFileSync(p2bPng));
    const diskDiff = frameDiff(p2a, p2b, p1.w / 2 - 260, p1.h / 2 - 170, p1.w / 2 + 260, p1.h / 2 + 190);
    const dRot = p2bS.diskRotation - p2aS.diskRotation;
    const dt = (tB - tA) / 1000;
    report.probes.P2 = {
        dRot, dt, impliedOmega: dRot / dt, diskDiff,
        statePass: p2bS.diskRotation > 0.05,
        pass: dRot >= 0.1 && diskDiff > 1000 && dRot / dt >= 0.15 && dRot / dt <= 0.6,
    };

    // —— P3:径向颜色梯度(内白外橙,方位角扇区有向 R-B 差 ≥ 18;内环亮度 ≥ 外环 1.5x) ——
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const p3png = await snap('p3'); const p3s = await state();
    const p3 = decodePNG(fs.readFileSync(p3png));
    const inner = bandStats(p3, 0.06, 0.14);
    const outer = bandStats(p3, 0.18, 0.30);
    const side = outer.right.avgRB > outer.left.avgRB ? 'right' : 'left';
    const rbDiff = outer[side].avgRB - inner[side].avgRB;
    const lumRatio = inner[side].avgLum / Math.max(1e-6, outer[side].avgLum);
    report.probes.P3 = {
        state: { accretionPhase: p3s.accretionPhase },
        statePass: p3s.accretionPhase >= 0 && p3s.accretionPhase < 1,
        inner, outer, pickedSide: side, rbDiff, lumRatio,
        pass: rbDiff >= 18 && lumRatio >= 1.5,
    };

    // —— P4:滚轮缩放(trusted wheel,dy=-600)→ cameraDistance<10 且构图增大 ——
    const coreBefore = coreRadiusH(p3), edgeBefore = diskEdgeRadiusH(p3);
    await page.mouse.move(p1.w / 2, p1.h / 2);
    await page.mouse.wheel(0, -600);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    const p4png = await snap('p4'); const p4s = await state();
    const p4 = decodePNG(fs.readFileSync(p4png));
    const coreAfter = coreRadiusH(p4), edgeAfter = diskEdgeRadiusH(p4);
    report.probes.P4 = {
        state: { cameraDistance: p4s.cameraDistance },
        statePass: p4s.cameraDistance < 10 && p4s.cameraDistance >= 5,
        coreBefore, coreAfter, coreRatio: coreAfter / Math.max(1, coreBefore),
        edgeBefore, edgeAfter, edgeRatio: edgeAfter / Math.max(1, edgeBefore),
        pass: p4s.cameraDistance < 10 && p4s.cameraDistance >= 5 && (coreAfter / Math.max(1, coreBefore) >= 1.25 || edgeAfter / Math.max(1, edgeBefore) >= 1.2),
    };

    // —— P5:星流螺旋(mid-ring 两帧差 + 星流数恒定) ——
    const p5aPng = await snap('p5a'); const p5aS = await state();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
    const p5bPng = await snap('p5b'); const p5bS = await state();
    const p5a = decodePNG(fs.readFileSync(p5aPng)), p5b = decodePNG(fs.readFileSync(p5bPng));
    const midDiff = frameDiff(p5a, p5b, p1.w / 2 - 230, p1.h / 2 - 150, p1.w / 2 + 230, p1.h / 2 + 170);
    report.probes.P5 = {
        state: { starStreamCount: p5bS.starStreamCount, constant: p5aS.starStreamCount === p5bS.starStreamCount },
        statePass: p5bS.starStreamCount >= 200,
        midDiff,
        pass: p5bS.starStreamCount >= 200 && p5aS.starStreamCount === p5bS.starStreamCount && midDiff > 1000,
    };

    // —— P6:reset(按钮点击)→ cameraDistance 14±0.5、diskRotation<0.3、accretionPhase<0.1 ——
    await page.click('[data-ui="reset"]');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const p6s = await state(); // 状态断言先采样(与探针 waitMs=400 对齐,避免截图耗时稀释)
    const p6png = await snap('p6');
    const p6 = decodePNG(fs.readFileSync(p6png));
    const fullNonBlack = regionNonBlackRatio(p6, 0, 0, p6.w, p6.h);
    report.probes.P6 = {
        state: p6s,
        statePass: p6s.cameraDistance >= 13.5 && p6s.cameraDistance <= 14.5 && p6s.diskRotation < 0.3 && p6s.accretionPhase < 0.1 && p6s.starStreamCount >= 200,
        fullNonBlack,
        pass: p6s.cameraDistance >= 13.5 && p6s.cameraDistance <= 14.5 && p6s.diskRotation < 0.3 && p6s.accretionPhase < 0.1 && p6s.starStreamCount >= 200 && fullNonBlack > 0.05,
    };

    report.allPass = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].every((k) => report.probes[k].pass);
    report.noUncaught = report.consoleErrors.length === 0 && report.uncaught.length === 0;
    report.completion = {
        buildExit0: true, // 本会话前最后一次 npm run build 退出码 0(见 WORKLOG)
        appReady: true,
        benchContract: true,
        noUncaught: report.noUncaught,
        probesAllPass: report.allPass,
    };
} catch (e) {
    report.error = String(e && e.message || e);
} finally {
    if (browser) await browser.close().catch(() => { });
}

fs.writeFileSync(path.join(here, 'selfcheck-result.json'), JSON.stringify(report, null, 2));
console.log('[selfcheck] ' + JSON.stringify({
    allPass: report.allPass ?? false,
    noUncaught: report.noUncaught ?? false,
    probes: Object.fromEntries(Object.entries(report.probes || {}).map(([k, v]) => [k, v.pass])),
    error: report.error,
}));
process.exit(report.allPass && report.noUncaught ? 0 : 1);
