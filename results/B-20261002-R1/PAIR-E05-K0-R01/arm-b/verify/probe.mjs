/**
 * E05 arm-b 探针自检驱动(CDP over WebSocket,仅 Node 内建模块)。
 * 用法: node verify/probe.mjs <url> <outDir> [tag]
 * 输出: <outDir>/report-<tag>.json + 各阶段截图,并在 stdout 打印摘要。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const URL_TO_LOAD = process.argv[2] || 'http://127.0.0.1:7105/';
const OUT = process.argv[3] || 'verify/out';
const TAG = process.argv[4] || 'run';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DBG_PORT = 9333 + (process.env.PROBE_INSTANCE ? Number(process.env.PROBE_INSTANCE) : 0);
const PROFILE = `${process.env.TEMP || '/tmp'}\\e05probe-${TAG}`;

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(pathname) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: pathname }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1920,1080', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-timer-throttling',
    'about:blank',
], { stdio: 'ignore' });

const consoleErrors = [];
const report = { tag: TAG, url: URL_TO_LOAD, probes: {}, consoleErrors };

async function main() {
    // 等 devtools 端口就绪
    let targets = null;
    for (let i = 0; i < 60; i++) {
        try {
            targets = await getJSON('/json/list');
            break;
        } catch { await sleep(500); }
    }
    if (!targets) throw new Error('devtools endpoint not reachable');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        } else if (m.method) {
            events.push(m);
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.__cErrors=[];window.addEventListener("error",e=>window.__cErrors.push(String(e.message)));',
    });

    const evalPage = async (fnSrc) => {
        const r = await send('Runtime.evaluate', {
            expression: `(${fnSrc})()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (r.exceptionDetails) {
            throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        }
        return r.result.value;
    };
    const screenshot = async (name) => {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
    };

    // ---------- 页面内像素分析工具 ----------
    const PIXEL_TOOLS = `
    window.__px = (() => {
        const cv = document.querySelector('#GameCanvas');
        const c2 = document.createElement('canvas');
        c2.width = cv.width; c2.height = cv.height;
        const ctx = c2.getContext('2d', { willReadFrequently: true });
        const W = cv.width, H = cv.height;
        function grab() { ctx.drawImage(cv, 0, 0); return ctx.getImageData(0, 0, W, H); }
        function stats(img, x0, y0, x1, y1) {
            x0 = Math.max(0, x0|0); y0 = Math.max(0, y0|0); x1 = Math.min(W, x1|0); y1 = Math.min(H, y1|0);
            const d = img.data; let nb = 0, n = 0, R = 0, G = 0, B = 0, maxL = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * W + x) * 4;
                const r = d[i], g = d[i+1], b = d[i+2];
                const l = 0.299*r + 0.587*g + 0.114*b;
                if (r + g + b > 15) nb++;
                if (l > maxL) maxL = l;
                R += r; G += g; B += b; n++;
            }
            return { nonBlack: +(nb / n).toFixed(4), avg: [+(R/n).toFixed(1), +(G/n).toFixed(1), +(B/n).toFixed(1)], maxL: +maxL.toFixed(1), n };
        }
        function annulus(img, r0, r1) { // 以画面中心为圆心的环带
            const d = img.data; const cx = W/2, cy = H/2;
            let nb = 0, n = 0, R = 0, G = 0, B = 0;
            for (let y = Math.max(0,(cy-r1)|0); y < Math.min(H, cy+r1); y++) {
                for (let x = Math.max(0,(cx-r1)|0); x < Math.min(W, cx+r1); x++) {
                    const dx = x - cx, dy = y - cy; const r = Math.sqrt(dx*dx + dy*dy);
                    if (r < r0 || r >= r1) continue;
                    const i = (y * W + x) * 4;
                    const rr = d[i], g = d[i+1], b = d[i+2];
                    if (rr + g + b > 15) nb++;
                    R += rr; G += g; B += b; n++;
                }
            }
            return { nonBlack: +(nb/n).toFixed(4), R: +(R/n).toFixed(1), G: +(G/n).toFixed(1), B: +(B/n).toFixed(1) };
        }
        function coreRadiusPx(img) { // 从中心沿 +x 找暗核边缘(首个亮像素)
            const d = img.data; const cy = (H/2)|0; const cx = W/2;
            for (let x = cx; x < W; x++) {
                const i = (cy * W + x) * 4;
                const l = d[i] + d[i+1] + d[i+2];
                if (l > 60) return x - cx;
            }
            return -1;
        }
        function diffAnnulus(r0, r1, waitMs) { // 两帧环带差分
            const a = grab();
            return new Promise((resolve) => setTimeout(() => {
                const b = grab();
                const d1 = a.data, d2 = b.data; const cx = W/2, cy = H/2;
                let n = 0, nz = 0, sum = 0;
                for (let y = Math.max(0,(cy-r1)|0); y < Math.min(H, cy+r1); y++) {
                    for (let x = Math.max(0,(cx-r1)|0); x < Math.min(W, cx+r1); x++) {
                        const dx = x - cx, dy = y - cy; const r = Math.sqrt(dx*dx + dy*dy);
                        if (r < r0 || r >= r1) continue;
                        const i = (y * W + x) * 4;
                        const dd = Math.abs(d1[i]-d2[i]) + Math.abs(d1[i+1]-d2[i+1]) + Math.abs(d1[i+2]-d2[i+2]);
                        if (dd > 12) nz++;
                        sum += dd; n++;
                    }
                }
                resolve({ nonzero: +(nz/n).toFixed(4), meanDiff: +(sum/(3*n)).toFixed(2)});
            }, waitMs));
        }
        return { grab, stats, annulus, coreRadiusPx, diffAnnulus, size: [W, H] };
    })();
    `;

    // ---------- 导航 ----------
    const t0 = Date.now();
    await send('Page.navigate', { url: URL_TO_LOAD });
    await sleep(1500);

    // __appReady 10s 契约
    let ready = false;
    for (let i = 0; i < 20; i++) {
        ready = await evalPage('() => window.__appReady === true');
        if (ready) break;
        await sleep(500);
    }
    report.readyInMs = Date.now() - t0;
    report.ready = ready;

    await evalPage(`() => { ${PIXEL_TOOLS}; return true; }`);
    const pxInfo = await evalPage('() => window.__px.size');
    report.canvasSize = pxInfo;

    // ---------- P1:初始画面 ----------
    await sleep(2500);
    await screenshot(`p1-${TAG}`);
    const p1 = await evalPage(`() => {
        const px = window.__px;
        const img = px.grab();
        const [W, H] = px.size;
        const center = px.stats(img, W/3, H/3, 2*W/3, 2*H/3);
        const cs = [];
        cs.push(px.stats(img, 0, 0, W/6, H/6));
        cs.push(px.stats(img, 5*W/6, 0, W, H/6));
        cs.push(px.stats(img, 0, 5*H/6, W/6, H));
        cs.push(px.stats(img, 5*W/6, 5*H/6, W, H));
        const corners = { nonBlack: +(cs.reduce((a,c)=>a+c.nonBlack,0)/4).toFixed(4), minNonBlack: Math.min(...cs.map(c=>c.nonBlack)) };
        const coreBox = px.stats(img, W/2 - 20, H/2 - 20, W/2 + 20, H/2 + 20);
        const st = window.__bench.getState();
        return { st, center, corners, coreBox };
    }`);
    report.probes.P1 = p1;

    // ---------- P2:旋转运动 ----------
    const p2 = await evalPage(`() => {
        const px = window.__px;
        const s1 = window.__bench.getState();
        const u = Math.min(px.size[0], px.size[1]) / (2 * s1.cameraDistance * Math.tan(22.5 * Math.PI / 180)); // px per world unit
        const diff = px.diffAnnulus(1.9 * u * 0.9, 6.4 * u, 800).then((d) => {
            const s2 = window.__bench.getState();
            return { rotDelta: +(s2.diskRotation - s1.diskRotation).toFixed(4), frameDiff: d, pxPerUnit: +u.toFixed(1) };
        });
        return diff;
    }`);
    await screenshot(`p2-${TAG}`);
    report.probes.P2 = p2;

    // ---------- P3:径向颜色梯度(多组候选环带标定) ----------
    const p3 = await evalPage(`() => {
        const px = window.__px;
        const st = window.__bench.getState();
        const u = Math.min(px.size[0], px.size[1]) / (2 * st.cameraDistance * Math.tan(22.5 * Math.PI / 180));
        const img = px.grab();
        function band(r0, r1) {
            const a = px.annulus(img, r0 * u, r1 * u);
            const lum = 0.299*a.R + 0.587*a.G + 0.114*a.B;
            return { lum: +lum.toFixed(1), rb: +(a.R - a.B).toFixed(1), nonBlack: a.nonBlack };
        }
        const pairs = {
            'A:in1.95-2.7/out5.0-6.3': [band(1.95, 2.7), band(5.0, 6.3)],
            'B:in0.10-0.16hh/out0.30-0.40hh': [band(0.10 * 11.6 / 2, 0.16 * 11.6 / 2), band(0.30 * 11.6 / 2, 0.40 * 11.6 / 2)],
            'C:in0.6-1.7/out2.3-2.9': [band(0.6, 1.7), band(2.3, 2.9)],
            'D:in1.5-2.4/out3.5-4.5': [band(1.5, 2.4), band(3.5, 4.5)],
        };
        const out = { phase: st.accretionPhase, pxPerUnit: +u.toFixed(1), pairs: {} };
        for (const k of Object.keys(pairs)) {
            const [inn, oute] = pairs[k];
            out.pairs[k] = {
                innerLum: inn.lum, outerLum: oute.lum,
                lumRatio: +(inn.lum / Math.max(0.5, oute.lum)).toFixed(2),
                rbDiff: +(oute.rb - inn.rb).toFixed(1),
            };
        }
        return out;
    }`);
    report.probes.P3 = p3;

    // ---------- P4:滚轮缩放 ----------
    const p4pre = await evalPage(`() => { const px = window.__px; const img = px.grab(); return { coreR: px.coreRadiusPx(img) }; }`);
    await evalPage(`() => {
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, clientX: innerWidth/2, clientY: innerHeight/2, bubbles: true, cancelable: true }));
        return true;
    }`);
    await sleep(1200);
    await screenshot(`p4-${TAG}`);
    const p4 = await evalPage(`() => {
        const px = window.__px;
        const img = px.grab();
        const st = window.__bench.getState();
        const u = Math.min(px.size[0], px.size[1]) / (2 * st.cameraDistance * Math.tan(22.5 * Math.PI / 180));
        return { st: { cameraDistance: st.cameraDistance, diskRotation: +st.diskRotation.toFixed(3) }, coreR: px.coreRadiusPx(img), diskOuterPx: +(6.5 * u).toFixed(0) };
    }`);
    report.probes.P4 = { pre: p4pre, post: p4, coreRatio: p4pre.coreR > 0 && p4.coreR > 0 ? +(p4.coreR / p4pre.coreR).toFixed(2) : null };

    // ---------- P5:星流运动 ----------
    const p5 = await evalPage(`() => {
        const px = window.__px;
        const st = window.__bench.getState();
        const u = Math.min(px.size[0], px.size[1]) / (2 * st.cameraDistance * Math.tan(22.5 * Math.PI / 180));
        return px.diffAnnulus(2.0 * u, 5.5 * u, 800).then((d) => ({ starStreamCount: st.starStreamCount, frameDiff: d }));
    }`);
    await screenshot(`p5-${TAG}`);
    report.probes.P5 = p5;

    // ---------- P6:reset ----------
    await evalPage(`() => { document.querySelector('[data-ui="reset"]').click(); return true; }`);
    await sleep(400);
    await screenshot(`p6-${TAG}`);
    const p6 = await evalPage(`() => {
        const px = window.__px;
        const img = px.grab();
        const [W, H] = px.size;
        const full = px.stats(img, 0, 0, W, H);
        const st = window.__bench.getState();
        return { st, fullNonBlack: full.nonBlack };
    }`);
    report.probes.P6 = p6;

    // ---------- console 错误汇总 ----------
    const errs = await evalPage(`() => ({ uncaught: window.__cErrors || [] })`);
    report.pageUncaught = errs.uncaught;
    for (const ev of events) {
        if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
            consoleErrors.push(ev.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
        }
        if (ev.method === 'Runtime.exceptionThrown') {
            consoleErrors.push('EXCEPTION: ' + (ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text || '').slice(0, 300));
        }
    }

    ws.close();
    writeFileSync(`${OUT}/report-${TAG}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
    report.fatal = String(e && e.message || e);
    writeFileSync(`${OUT}/report-${TAG}.json`, JSON.stringify(report, null, 2));
    console.error('FATAL:', e && e.message);
}).finally(() => {
    setTimeout(() => { try { proc.kill(); } catch {} }, 300);
});
