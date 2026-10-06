#!/usr/bin/env node
// ============================================================================
// selfcheck-probes.mjs — E08 探针自检(Arm B 专用,一次性验证脚本)
// 预算合规:创建浏览器会话之前先执行 node scripts/count.mjs browser(RUN-CONTRACT §2),
//           与 verify-browser.mjs 同一计数口径;本脚本不绕过机器计数。
// 流程:按 spec.json 的 P1-P8 逐条:动作 → 等待 → getState 断言;视觉断言以
//       page.screenshot 截图 + Node 侧最小 PNG 解码做像素差近似(nonBlank/motion/regionChange)。
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, 'workspace');
const URL = 'http://127.0.0.1:7123/';
const SHOT_DIR = path.join(__dirname, 'selfcheck');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ① 机器计数(先计后会话,不可绕过)
const counted = spawnSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
    console.error('[probes] browser 计数失败,拒绝创建会话:\n' + (counted.stdout || '') + (counted.stderr || ''));
    process.exit(1);
}
process.stdout.write(counted.stdout);

const require2 = createRequire(import.meta.url);
const chromium = require2('playwright-core').chromium;

function browserCandidates() {
    const cands = [];
    for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) cands.push(process.env[k]);
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return cands.filter(Boolean);
}

async function launch() {
    const errors = [];
    for (const exe of [null, ...browserCandidates()]) {
        if (exe !== null && !fs.existsSync(exe)) continue;
        try {
            return await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000 });
        } catch (e) {
            errors.push(`${exe || 'default'}: ${e.message.split('\n')[0]}`);
        }
    }
    throw new Error('no browser: ' + errors.join(' | '));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
let uncaught = [];

function record(id, desc, pass, detail) {
    results.push({ id, desc, pass, detail });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${desc} :: ${detail}`);
}

async function getState(page) {
    return page.evaluate(() => window.__bench.getState());
}

async function shot(page, name) {
    const p = path.join(SHOT_DIR, name);
    await page.screenshot({ path: p });
    return p;
}

// ---------- 最小 PNG 解码器(Chrome 截图:8-bit RGBA/RGB,非隔行) ----------
function decodePNG(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
    let pos = 8;
    let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0);
            h = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported png depth=${bitDepth} interlace=${interlace}`);
    const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : -1;
    if (ch < 0) throw new Error('unsupported colorType ' + colorType);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const out = Buffer.alloc(w * h * ch);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0;
            const b = prev[x];
            const c = x >= ch ? prev[x - ch] : 0;
            let v = line[x];
            if (f === 1) v = (v + a) & 255;
            else if (f === 2) v = (v + b) & 255;
            else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (f === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            }
            cur[x] = v;
        }
        prev = cur;
    }
    return { w, h, ch, data: out };
}

/** 两张截图在指定归一化区域内的像素差比率 */
function pixelDeltaRatio(fileA, fileB, region) {
    const A = decodePNG(fs.readFileSync(fileA));
    const B = decodePNG(fs.readFileSync(fileB));
    const rx0 = Math.floor((region?.x ?? 0) * A.w);
    const ry0 = Math.floor((region?.y ?? 0) * A.h);
    const rx1 = Math.ceil(((region?.x ?? 0) + (region?.w ?? 1)) * A.w);
    const ry1 = Math.ceil(((region?.y ?? 0) + (region?.h ?? 1)) * A.h);
    let changed = 0, total = 0;
    for (let y = ry0; y < Math.min(ry1, A.h); y++) {
        for (let x = rx0; x < Math.min(rx1, A.w); x++) {
            const i = (y * A.w + x) * A.ch;
            total++;
            if (Math.abs(A.data[i] - B.data[i]) > 12 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 12 || Math.abs(A.data[i + 2] - B.data[i + 2]) > 12) changed++;
        }
    }
    return total > 0 ? changed / total : 0;
}

/** 区域内非空白占比:与整帧中位色差异 > 阈值 的像素比率 */
function nonBlankRatio(file, region) {
    const A = decodePNG(fs.readFileSync(file));
    const rx0 = Math.floor((region?.x ?? 0) * A.w);
    const ry0 = Math.floor((region?.y ?? 0) * A.h);
    const rx1 = Math.ceil(((region?.x ?? 0) + (region?.w ?? 1)) * A.w);
    const ry1 = Math.ceil(((region?.y ?? 0) + (region?.h ?? 1)) * A.h);
    // 采样统计中位色
    const samples = [];
    for (let y = ry0; y < ry1; y += 8) for (let x = rx0; x < rx1; x += 8) {
        const i = (y * A.w + x) * A.ch;
        samples.push([A.data[i], A.data[i + 1], A.data[i + 2]]);
    }
    const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[samples.length >> 1];
    const m = [med(0), med(1), med(2)];
    let non = 0, total = 0;
    for (let y = ry0; y < ry1; y++) {
        for (let x = rx0; x < rx1; x++) {
            const i = (y * A.w + x) * A.ch;
            total++;
            if (Math.abs(A.data[i] - m[0]) + Math.abs(A.data[i + 1] - m[1]) + Math.abs(A.data[i + 2] - m[2]) > 40) non++;
        }
    }
    return total > 0 ? non / total : 0;
}

const browser = await launch();
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => uncaught.push(String(e?.message || e).slice(0, 240)));

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    const t0 = Date.now();
    while (Date.now() - t0 <= 10000) {
        const r = await page.evaluate(() => window.__appReady === true).catch(() => false);
        if (r) break;
        await sleep(200);
    }

    // ---------- P1: 启动 2.5s 后:规模/模式/非空 ----------
    await sleep(2500);
    let s = await getState(page);
    await shot(page, 'p1.png');
    record('P1', 'state: fish>=80 && plankton>=300 && normal && !food',
        s.fishCount >= 80 && s.planktonCount >= 300 && s.boidMode === 'normal' && s.foodActive === false,
        `fish=${s.fishCount} plk=${s.planktonCount} mode=${s.boidMode} cohesion=${s.avgCohesion.toFixed(3)}`);
    const nb1 = nonBlankRatio(path.join(SHOT_DIR, 'p1.png'), { x: 0, y: 0, w: 1, h: 1 });
    record('P1b', '全屏非空(minCoverage>=0.25)', nb1 >= 0.25, `nonBlank=${(nb1 * 100).toFixed(1)}%`);

    // ---------- P2: 再 2s:常态聚群 + 中央水域运动 ----------
    await sleep(2000);
    s = await getState(page);
    await shot(page, 'p2a.png');
    await sleep(1000);
    await shot(page, 'p2b.png');
    const motion = pixelDeltaRatio(path.join(SHOT_DIR, 'p2a.png'), path.join(SHOT_DIR, 'p2b.png'), { x: 0.3, y: 0.25, w: 0.4, h: 0.5 });
    record('P2', 'normal && avgCohesion>=0.45', s.boidMode === 'normal' && s.avgCohesion >= 0.45,
        `mode=${s.boidMode} cohesion=${s.avgCohesion.toFixed(3)}`);
    record('P2b', '中央水域持续运动(1s 像素差)', motion >= 0.05, `delta=${(motion * 100).toFixed(1)}%`);

    // ---------- P3: drag 扫过中央 → scatter && cohesion<0.35 ----------
    await page.mouse.move(320, 360);
    await page.mouse.down();
    await page.mouse.move(960, 360, { steps: 25 });
    await page.mouse.up();
    await sleep(1200);
    s = await getState(page);
    await shot(page, 'p3.png');
    record('P3', 'scatter && avgCohesion<0.35', s.boidMode === 'scatter' && s.avgCohesion < 0.35,
        `mode=${s.boidMode} cohesion=${s.avgCohesion.toFixed(3)} panic=${s.panicking}`);
    record('P3b', 'drag 不误触投喂', s.foodActive === false, `foodActive=${s.foodActive}`);

    // ---------- P4: 指针移出 → 6s 内重聚 ----------
    await page.mouse.move(20, 20);
    await sleep(6000);
    s = await getState(page);
    await shot(page, 'p4.png');
    record('P4', 'normal && avgCohesion>=0.45', s.boidMode === 'normal' && s.avgCohesion >= 0.45,
        `mode=${s.boidMode} cohesion=${s.avgCohesion.toFixed(3)}`);

    // ---------- P5: 点击投喂 ----------
    await page.mouse.click(640, 360);
    await sleep(800);
    s = await getState(page);
    await shot(page, 'p5.png');
    record('P5', 'foodActive && foodPosition!=null', s.foodActive === true && s.foodPosition != null,
        `food=${JSON.stringify(s.foodPosition)}`);

    // ---------- P6: 4s 内鱼群聚到食物 ----------
    await sleep(4000);
    s = await getState(page);
    await shot(page, 'p6.png');
    record('P6', 'avgDistanceToFood<6 且食物仍在', s.avgDistanceToFood != null && s.avgDistanceToFood < 6 && s.foodActive,
        `dist=${s.avgDistanceToFood == null ? 'null' : s.avgDistanceToFood.toFixed(2)} foodActive=${s.foodActive}`);

    // ---------- P7: reset ----------
    await page.click('button[data-ui="reset"]');
    await sleep(2000);
    s = await getState(page);
    await shot(page, 'p7.png');
    record('P7', 'reset: fish>=80 && normal && !food && dist==null',
        s.fishCount >= 80 && s.boidMode === 'normal' && s.foodActive === false && s.avgDistanceToFood === null,
        `mode=${s.boidMode} food=${s.foodActive} dist=${s.avgDistanceToFood} fish=${s.fishCount}`);

    // ---------- P8: reset 后模拟继续(像素变化 ≥2%) ----------
    await sleep(500);
    await shot(page, 'p8a.png');
    await sleep(300);
    await shot(page, 'p8b.png');
    await sleep(700);
    s = await getState(page);
    const delta8 = pixelDeltaRatio(path.join(SHOT_DIR, 'p8a.png'), path.join(SHOT_DIR, 'p8b.png'), { x: 0, y: 0, w: 1, h: 1 });
    record('P8', 'fish>=80 && plankton>=300 && 像素变化>=2%',
        s.fishCount >= 80 && s.planktonCount >= 300 && delta8 >= 0.02,
        `fish=${s.fishCount} plk=${s.planktonCount} delta=${(delta8 * 100).toFixed(1)}%`);

    // ---------- 长跑稳定性(≈120s 无泄漏/无异常) ----------
    const sAtP8 = s;
    await sleep(60000);
    const m1 = await getState(page);
    await sleep(60000);
    const m2 = await getState(page);
    record('L1', '120s 长跑:计数不增长、fps>=30、frame 前进、无异常模式',
        m2.fishCount === m1.fishCount && m1.fishCount === sAtP8.fishCount &&
        m2.planktonCount === m1.planktonCount && m2.fps >= 30 &&
        m2.boidMode === 'normal' && m2.frame > m1.frame,
        `fps1=${m1.fps.toFixed(0)} fps2=${m2.fps.toFixed(0)} frame=${m1.frame}→${m2.frame} mode=${m2.boidMode}`);

    const errs = consoleErrors.length + uncaught.length;
    record('E1', 'console 无 error / 无未捕获异常', errs === 0,
        consoleErrors.concat(uncaught).slice(0, 5).join(' | ') || 'clean');

    const passN = results.filter((r) => r.pass).length;
    console.log(`\n[probes] SUMMARY ${passN}/${results.length} PASS; consoleErrors=${consoleErrors.length} uncaught=${uncaught.length}`);
    process.exit(passN === results.length ? 0 : 2);
} finally {
    await browser.close().catch(() => {});
}
