#!/usr/bin/env node
/**
 * E04 自检脚本(不是 harness 探针,只用于交付前自查)。
 *
 * 预算契约要求:任何非 verify-browser.mjs 的浏览器会话都必须先执行
 * `node scripts/count.mjs browser`;本脚本第一步就做这件事,再启动 playwright-core。
 *
 * 行为:按 spec.json 的 P1..P8 顺序用真实鼠标事件跑完整条时间线,
 *      在页面内用 2D canvas 解码截图并做像素统计,最后输出 JSON 报告。
 *
 * 用法:node scripts/selfcheck.mjs --url http://127.0.0.1:7107/ [--out .selfcheck]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(__dirname);

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === '--url') args.url = process.argv[++i];
    else if (a === '--out') args.out = process.argv[++i];
}
if (!args.url) {
    console.error('usage: node scripts/selfcheck.mjs --url <url> [--out dir]');
    process.exit(2);
}
const outDir = path.resolve(root, args.out || '.selfcheck');
fs.mkdirSync(outDir, { recursive: true });

// ① 先计 browserAttempt(契约 §2),再开会话。
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
process.stdout.write(counted.stdout || '');
if (counted.status !== 0) {
    console.error('[selfcheck] browser 计数失败,拒绝开会话');
    process.exit(1);
}

const { chromium } = createRequire(import.meta.url)('playwright-core');

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
            return await chromium.launch({
                ...(exe ? { executablePath: exe } : {}),
                headless: true,
                viewport: { width: 1280, height: 720 },
                timeout: 30000,
            });
        } catch (e) {
            errors.push(`${exe || 'playwright-default'}: ${e.message.split('\n')[0]}`);
        }
    }
    throw new Error('no usable browser: ' + errors.join(' | '));
}

const W = 1280;
const H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
    url: args.url,
    appReady: false,
    readyMs: null,
    consoleErrors: [],
    uncaught: [],
    states: {},
    pixel: {},
    checks: {},
    shots: {},
};

const browser = await launch();
const page = await browser.newPage();
page.setDefaultTimeout(30000);
page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => report.uncaught.push(String(e && e.message ? e.message : e).slice(0, 400)));

async function shot(name) {
    const file = path.join(outDir, `${name}.png`);
    const buf = await page.screenshot({ path: file });
    report.shots[name] = path.relative(root, file).replaceAll('\\', '/');
    return buf.toString('base64');
}

async function state() {
    return page.evaluate(() => window.__bench.getState());
}

async function clickNorm(nx, ny) {
    await page.mouse.click(Math.round(nx * W), Math.round(ny * H));
}

async function clickUi(name) {
    const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
    }, `[data-ui="${name}"]`);
    if (!box) throw new Error(`UI not found: ${name}`);
    await page.mouse.click(Math.round(box.x), Math.round(box.y));
    return box;
}

/** 页面内解码 PNG + 统计。 */
async function analyze(payload) {
    return page.evaluate(async (p) => {
        async function decode(b64) {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height);
        }
        const imgs = {};
        const keys = Object.keys(p.images);
        for (const key of keys) imgs[key] = await decode(p.images[key]);
        const first = imgs[keys[0]];
        const w = first.width;
        const h = first.height;
        const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

        function stats(img, region, test) {
            const { data } = img;
            const x0 = Math.floor(region.x0 * w);
            const x1 = Math.floor(region.x1 * w);
            const y0 = Math.floor(region.y0 * h);
            const y1 = Math.floor(region.y1 * h);
            let count = 0;
            let sum = 0;
            let total = 0;
            for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) {
                    const i = (y * w + x) * 4;
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    total += 1;
                    sum += lum(r, g, b);
                    if (test(r, g, b)) count += 1;
                }
            }
            return { count, mean: total ? sum / total : 0, total };
        }

        function diff(a, b, region, threshold) {
            const da = a.data;
            const db = b.data;
            const x0 = Math.floor(region.x0 * w);
            const x1 = Math.floor(region.x1 * w);
            const y0 = Math.floor(region.y0 * h);
            const y1 = Math.floor(region.y1 * h);
            let changed = 0;
            let total = 0;
            for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) {
                    const i = (y * w + x) * 4;
                    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
                    total += 1;
                    if (d > threshold) changed += 1;
                }
            }
            return { ratio: total ? changed / total : 0, changed, total };
        }

        const out = {};
        const bottom = { x0: 0, x1: 1, y0: 0.67, y1: 1 };
        const full = { x0: 0, x1: 1, y0: 0, y1: 1 };
        const upper = { x0: 0, x1: 1, y0: 0, y1: 0.5 };
        const horizon = { x0: 0, x1: 1, y0: 0.55, y1: 0.64 };
        const warm = (r, g, b) => r > 150 && g > 80 && g < 240 && b < 190 && r > b + 45;
        const bright = (r, g, b) => lum(r, g, b) > 150;

        if (imgs.p1) {
            const s = stats(imgs.p1, bottom, warm);
            const hz = stats(imgs.p1, horizon, () => true);
            out.p1Warm = s.count;
            out.p1BottomMean = s.mean;
            out.p1HorizonMean = hz.mean;
            out.p1SkyMean = stats(imgs.p1, upper, () => true).mean;
            out.p1FullMean = stats(imgs.p1, full, () => true).mean;
            out.p1SkyBright = stats(imgs.p1, upper, bright).count;
        }
        if (imgs.p2 && imgs.p2b) {
            const band = { x0: 0.4, x1: 0.6, y0: 0, y1: 1 };
            out.p2Motion = diff(imgs.p2, imgs.p2b, band, 20);
            out.p2TrailBright = stats(imgs.p2, band, bright).count;
        }
        if (imgs.p3 && imgs.p2) {
            const cx = 0.5;
            const cy = 0.3;
            const r = 0.2;
            const neighborhood = { x0: cx - r, x1: cx + r, y0: cy - r * (w / h), y1: cy + r * (w / h) };
            out.p3BurstBright = stats(imgs.p3, neighborhood, bright).count;
            out.p2BurstBright = stats(imgs.p2, neighborhood, bright).count;
            out.p3UpperBright = stats(imgs.p3, upper, bright).count;
        }
        if (imgs.p4a && imgs.p4b) {
            out.p4Motion = diff(imgs.p4a, imgs.p4b, { x0: 0, x1: 1, y0: 0.5, y1: 1 }, 16);
            out.p4UpperBright = stats(imgs.p4a, upper, bright).count;
        }
        if (imgs.p6) {
            out.p6UpperBright = stats(imgs.p6, upper, bright).count;
        }
        if (imgs.p7a && imgs.p7b) {
            out.p7Diff = diff(imgs.p7a, imgs.p7b, full, 16);
            out.p7DiffStrict = diff(imgs.p7a, imgs.p7b, full, 8);
        }
        if (imgs.p8 && imgs.p1) {
            out.p8UpperBright = stats(imgs.p8, upper, bright).count;
            out.p8Warm = stats(imgs.p8, bottom, warm).count;
            out.p8BottomMean = stats(imgs.p8, bottom, () => true).mean;
        }
        if (imgs.cityOnly) {
            out.cityWarm = stats(imgs.cityOnly, bottom, warm).count;
            out.cityBottomMean = stats(imgs.cityOnly, bottom, () => true).mean;
            out.cityHorizonMean = stats(imgs.cityOnly, horizon, () => true).mean;
            out.cityUpperBright = stats(imgs.cityOnly, upper, bright).count;
        }
        if (imgs.fxOnly) {
            out.fxBottomMean = stats(imgs.fxOnly, bottom, () => true).mean;
        }
        return out;
    }, payload);
}

try {
    const t0 = Date.now();
    await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
    while (Date.now() - t0 < 10000) {
        const ready = await page.evaluate(() => window.__appReady === true);
        if (ready) { report.appReady = true; break; }
        await sleep(150);
    }
    report.readyMs = Date.now() - t0;
    if (!report.appReady) throw new Error('__appReady not true within 10s');

    const ui = await page.evaluate(() => ({
        auto: !!document.querySelector('[data-ui="auto-show"]'),
        pause: !!document.querySelector('[data-ui="pause"]'),
        reset: !!document.querySelector('[data-ui="reset"]'),
        rects: [...document.querySelectorAll('[data-ui]')].map((el) => {
            const r = el.getBoundingClientRect();
            return { ui: el.getAttribute('data-ui'), x: r.left / innerWidth, y: r.top / innerHeight, x2: r.right / innerWidth, y2: r.bottom / innerHeight };
        }),
    }));
    report.ui = ui;

    // ---- P1 -------------------------------------------------------------
    await sleep(2500);
    report.states.p1 = await state();
    const p1 = await shot('p1-initial');

    // ---- P2 -------------------------------------------------------------
    await clickNorm(0.5, 0.3);
    await sleep(500);
    report.states.p2 = await state();
    const p2 = await shot('p2-launch');
    await sleep(130);
    const p2b = await shot('p2b-launch-motion');

    // ---- P3 -------------------------------------------------------------
    await sleep(1200);
    report.states.p3 = await state();
    const p3 = await shot('p3-burst');

    // ---- P4 -------------------------------------------------------------
    await sleep(2600);
    report.states.p4 = await state();
    const p4a = await shot('p4-ember-a');
    await sleep(160);
    const p4b = await shot('p4-ember-b');

    // ---- P5 -------------------------------------------------------------
    const autoBox = await clickUi('auto-show');
    report.states.p5afterClick = await state();
    await sleep(4000);
    report.states.p5 = await state();
    const p5 = await shot('p5-auto');

    // ---- P6 -------------------------------------------------------------
    await clickUi('auto-show');
    const p6start = await state();
    await sleep(400);
    const p6a = await state();
    await sleep(2000);
    const p6b = await state();
    report.states.p6 = { start: p6start, a: p6a, b: p6b };
    const p6 = await shot('p6-auto-off');

    // ---- P7 -------------------------------------------------------------
    await clickUi('pause');
    await sleep(300);
    report.states.p7 = await state();
    const p7a = await shot('p7-paused-a');
    await sleep(1000);
    const p7b = await shot('p7-paused-b');

    // ---- P8 -------------------------------------------------------------
    await clickUi('reset');
    await sleep(600);
    report.states.p8 = await state();
    const p8 = await shot('p8-reset');

    // 自检:reset 后手动点击仍然有效(不写入报告状态,只确认交互活着)
    await clickNorm(0.4, 0.28);
    await sleep(120);
    report.states.afterResetClick = await state();

    // 分层诊断截图:只留城市 / 只留 FX,用于判定是渲染还是遮挡问题。
    await page.evaluate(() => window.__bench.reset());
    await sleep(150);
    report.debug = await page.evaluate(() => window.__bench.debug.info());
    await page.evaluate(() => window.__bench.debug.setFxVisible(false));
    await sleep(120);
    const cityOnly = await shot('diag-city-only');
    await page.evaluate(() => {
        window.__bench.debug.setFxVisible(true);
        window.__bench.debug.setCityVisible(false);
    });
    await sleep(120);
    const fxOnly = await shot('diag-fx-only');
    await page.evaluate(() => window.__bench.debug.setCityVisible(true));

    report.pixel = await analyze({
        images: { p1, p2, p2b, p3, p4a, p4b, p5, p6, p7a, p7b, p8, cityOnly, fxOnly },
        data: { p1, p2, p2b, p3, p4a, p4b, p5, p6, p7a, p7b, p8, cityOnly, fxOnly },
    });

    const st = report.states;
    report.checks = {
        p1_state: st.p1.buildingCount >= 24 && st.p1.fireworkCount === 0 && st.p1.autoShow === false && st.p1.enabled === true,
        p1_city: report.pixel.p1Warm >= 80 && report.pixel.p1BottomMean < report.pixel.p1HorizonMean,
        p1_sky: report.pixel.p1SkyMean > 1 && report.pixel.p1SkyBright >= 120,
        p2_state: st.p2.fireworkCount === 1 && st.p2.particlesAlive >= 1,
        p2_motion: report.pixel.p2Motion.ratio > 0.002,
        p3_state: st.p3.particlesAlive >= 40,
        p3_pixels: report.pixel.p3BurstBright >= Math.max(60, report.pixel.p2BurstBright * 3),
        p4_state: st.p4.particlesAlive >= 1 && st.p4.particlesAlive < 40 && st.p4.particlesAlive < st.p3.particlesAlive,
        p4_motion: report.pixel.p4Motion.ratio >= 0.005,
        p5_state: st.p5.autoShow === true && st.p5.fireworkCount >= 4,
        p5_delta: st.p5.fireworkCount - st.p5afterClick.fireworkCount,
        p6_state: st.p6.b.autoShow === false && st.p6.b.fireworkCount === st.p6.a.fireworkCount,
        p7_state: st.p7.enabled === false,
        p7_frozen: report.pixel.p7Diff.ratio < 0.005,
        p8_state: st.p8.fireworkCount === 0 && st.p8.particlesAlive === 0 && st.p8.autoShow === false
            && st.p8.enabled === true && st.p8.buildingCount >= 24,
        p8_pixels: report.pixel.p8UpperBright <= Math.max(40, report.pixel.p1SkyBright * 1.15),
        no_console_errors: report.consoleErrors.length === 0,
        no_uncaught: report.uncaught.length === 0,
        reset_reinteractive: st.afterResetClick.fireworkCount === 1,
    };
    report.autoButtonRect = autoBox;
} catch (err) {
    report.error = String(err && err.message ? err.message : err);
} finally {
    await browser.close().catch(() => {});
}

console.log(JSON.stringify(report, null, 2));
const failed = Object.entries(report.checks).filter(([k, v]) => typeof v === 'boolean' && !v).map(([k]) => k);
if (report.error || failed.length > 0) {
    console.error('[selfcheck] FAILED:', report.error || failed.join(', '));
    process.exit(1);
}
console.log('[selfcheck] all checks passed');
