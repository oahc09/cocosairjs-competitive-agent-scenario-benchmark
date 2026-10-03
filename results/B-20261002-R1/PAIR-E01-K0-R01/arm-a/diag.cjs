// diag.cjs — 一次性诊断:逐个隐藏对象,定位 y=0 黄线来源
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');

const ARM = __dirname;
const OUT = path.join(ARM, 'verify-out');
const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const cdp = { ws, id: 0, pending: new Map(), listeners: new Map(), closed: false };
    ws.onopen = () => resolve(cdp);
    ws.onerror = () => reject(new Error('ws connect failed'));
    ws.onclose = () => { cdp.closed = true; for (const p of cdp.pending.values()) p.reject(new Error('cdp closed')); cdp.pending.clear(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id !== undefined) { const p = cdp.pending.get(m.id); if (p) { cdp.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
    };
  });
}
function send(cdp, method, params = {}) {
  const id = ++cdp.id;
  return new Promise((resolve, reject) => { cdp.pending.set(id, { resolve, reject }); cdp.ws.send(JSON.stringify({ id, method, params })); });
}
function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePng(buf) {
  let off = 8, w = 0, h = 0; const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len); off += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idats.push(data); else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats)); const s = w * 4; const out = Buffer.alloc(h * s); let pos = 0; const prev = Buffer.alloc(s);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]; const line = raw.subarray(pos, pos + s); pos += s; const row = out.subarray(y * s, (y + 1) * s);
    for (let x = 0; x < s; x++) { const a = x >= 4 ? row[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0; let v = line[x]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c); row[x] = v & 255; }
    prev.set(row);
  }
  return { w, h, d: out };
}

async function main() {
  const chromePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
  const profileDir = path.join(ARM, '.chrome-tmp2');
  fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true });
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=1280,720', '--no-first-run', '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  const results = {};
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch { await sleep(250); } }
    for (const variant of ['plain', 'noglow', 'nobg', 'nogalaxy']) {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
      const target = await res.json();
      const cdp = await wsConnect(target.webSocketDebuggerUrl);
      await send(cdp, 'Page.enable');
      await send(cdp, 'Runtime.enable');
      await send(cdp, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await send(cdp, 'Page.navigate', { url: 'http://127.0.0.1:7100/' + (variant === 'plain' ? '' : '?debug=' + variant) });
      await sleep(3500);
      const r = await send(cdp, 'Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(OUT, 'diag-' + variant + '.png'), buf);
      const img = decodePng(buf);
      // y=0 行亮段
      const runs = []; let inrun = false, st = 0;
      for (let x = 0; x < img.w; x++) { const i = x * 4; const l = 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2]; const b = l > 40; if (b && !inrun) { inrun = true; st = x; } if (!b && inrun) { inrun = false; runs.push([st, x - 1]); } }
      if (inrun) runs.push([st, img.w - 1]);
      const merged = []; for (const rr of runs) { if (merged.length && rr[0] - merged[merged.length - 1][1] <= 4) merged[merged.length - 1][1] = rr[1]; else merged.push(rr); }
      // 全图亮像素比例 + y=0 处 RGB
      let lit = 0; for (let y = 0; y < img.h; y += 2) for (let x = 0; x < img.w; x += 2) { const i = (y * img.w + x) * 4; if (0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2] > 40) lit++; }
      const i600 = 600 * 4;
      results[variant] = { y0runs: merged, litPct: +((lit * 4) / (img.w * img.h) * 100).toFixed(2), rgbAt600y0: [img.d[i600], img.d[i600 + 1], img.d[i600 + 2]].join(',') };
      try { await send(cdp, 'Page.close'); } catch { /* ignore */ }
      await sleep(300);
    }
  } finally {
    try { chrome.kill(); } catch {}
    await sleep(600);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error('DIAG FAILED:', e.message); process.exit(1); });
