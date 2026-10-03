/** 色彩诊断:外环带为何偏蓝 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const URL_TO_LOAD = process.argv[2] || 'http://127.0.0.1:7105/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DBG_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: p }, (r) => {
            let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
    });
}
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG_PORT}`, `--user-data-dir=${process.env.TEMP}\\e05diag`, '--no-first-run', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });

async function main() {
    let targets = null;
    for (let i = 0; i < 60; i++) { try { targets = await getJSON('/json/list'); break; } catch { await sleep(500); } }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve } = pend.get(m.id); pend.delete(m.id); resolve(m.result); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, { resolve: r }); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

    await send('Page.enable');
    await send('Page.navigate', { url: URL_TO_LOAD });
    for (let i = 0; i < 20; i++) { if (await evl('window.__appReady===true')) break; await sleep(500); }
    await sleep(2500);
    const out = await evl(`(() => {
        const cv = document.querySelector('#GameCanvas');
        const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
        const ctx = c2.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(cv, 0, 0);
        const W = cv.width, H = cv.height, d = ctx.getImageData(0, 0, W, H).data;
        const cx = W/2, cy = H/2;
        function boxAvg(x0,y0,x1,y1){ let R=0,G=0,B=0,n=0;
            for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*W+x)*4;R+=d[i];G+=d[i+1];B+=d[i+2];n++;}
            return [+(R/n).toFixed(1),+(G/n).toFixed(1),+(B/n).toFixed(1)];
        }
        // 水平右向剖面:每 20px 一格的平均色
        const hprof = [];
        for (let x = cx; x < W; x += 20) hprof.push(boxAvg(x, cy-6, x+20, cy+6));
        // 环带统计(5.0-6.3u) + 亮像素列表
        const u = Math.min(W,H) / (2 * window.__bench.getState().cameraDistance * Math.tan(22.5*Math.PI/180));
        const r0 = 5*u, r1 = 6.3*u;
        let R=0,G=0,B=0,n=0; const bright=[];
        for (let y=0;y<H;y+=2) for (let x=0;x<W;x+=2) {
            const dx=x-cx, dy=y-cy, r=Math.sqrt(dx*dx+dy*dy);
            if (r<r0||r>=r1) continue;
            const i=(y*W+x)*4; R+=d[i];G+=d[i+1];B+=d[i+2];n++;
            if (d[i]+d[i+1]+d[i+2] > 100) bright.push([x,y,d[i],d[i+1],d[i+2]]);
        }
        // 最蓝的像素(找出蓝色来源)
        let minRB = 1e9, minPix = null;
        for (let y=0;y<H;y+=3) for (let x=0;x<W;x+=3) {
            const dx=x-cx, dy=y-cy, r=Math.sqrt(dx*dx+dy*dy);
            if (r<r0||r>=r1) continue;
            const i=(y*W+x)*4;
            if (d[i]+d[i+1]+d[i+2] > 30) { const rb = d[i]-d[i+2]; if (rb < minRB) { minRB = rb; minPix = [x,y,d[i],d[i+1],d[i+2]]; } }
        }
        return { u: +u.toFixed(1), bandAvg: [+(R/n).toFixed(1),+(G/n).toFixed(1),+(B/n).toFixed(1)], n,
                 brightSample: bright.slice(0, 12), bluestPixel: minPix,
                 hprof: hprof.map(c=>c.join(',')) };
    })()`);
    console.log(JSON.stringify(out, null, 1));
    ws.close();
}
main().catch((e) => console.error('FATAL', e)).finally(() => setTimeout(() => { try { proc.kill(); } catch {} }, 300));
