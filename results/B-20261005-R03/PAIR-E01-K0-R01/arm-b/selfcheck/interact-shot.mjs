/**
 * selfcheck/interact-shot.mjs — 真实输入(Playwright CDP)交互证据采集
 * 前置:必须先执行 `node workspace/scripts/count.mjs browser`(RUN-CONTRACT §2 计数口径)。
 * 流程:加载 → 静置 → 两帧间隔 2s(运动证据)→ 真实 mouse.move(视差)→ 真实 mouse.wheel(穿行)
 *       每步截图并打印 __bench 状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const URL = 'http://127.0.0.1:7115/';
const OUT = path.resolve(import.meta.dirname, '.');

function browserCandidates() {
    const cands = [];
    for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) {
        if (process.env[k]) cands.push(process.env[k]);
    }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launch();
const page = await browser.newPage();
page.setDefaultTimeout(30000);
const report = { states: {}, shots: [] };
try {
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    const t0 = Date.now();
    while (Date.now() - t0 <= 10000) {
        const st = await page.evaluate(() => window.__appReady === true).catch(() => false);
        if (st) break;
        await sleep(200);
    }
    await sleep(2500); // 静置:让 fps 窗口与初始构图稳定

    // 1) 运动证据:同一相机状态下间隔 2s 两帧(仅星系旋转)
    report.states.motionStart = await page.evaluate(() => window.__bench.getState());
    await page.screenshot({ path: path.join(OUT, 'motion-t0.png') });
    await sleep(2000);
    report.states.motionEnd = await page.evaluate(() => window.__bench.getState());
    await page.screenshot({ path: path.join(OUT, 'motion-t2s.png') });
    report.shots.push('motion-t0.png', 'motion-t2s.png');

    // 2) 真实指针移动(中心 → 0.68,0.50):视差
    await page.mouse.move(640, 360);
    await sleep(200);
    await page.mouse.move(870, 360, { steps: 1 });
    await sleep(700);
    report.states.afterMove = await page.evaluate(() => window.__bench.getState());
    await page.screenshot({ path: path.join(OUT, 'after-pointermove.png') });
    report.shots.push('after-pointermove.png');

    // 3) 真实滚轮(向上 600):穿行靠近
    await page.mouse.move(640, 360); // 指针归位中心再滚轮,与探针口径一致
    await sleep(300);
    await page.mouse.wheel(0, -600);
    await sleep(1200);
    report.states.afterWheel = await page.evaluate(() => window.__bench.getState());
    await page.screenshot({ path: path.join(OUT, 'after-wheel-zoom.png') });
    report.shots.push('after-wheel-zoom.png');
} finally {
    await browser.close().catch(() => {});
}
console.log('[interact-shot] ' + JSON.stringify(report));
