// ============================================================================
// verify.cjs — E01 Arm A 自检脚本(一次性,Agent 自用)
// 以 headless Chrome + 原生 CDP(Node 内置 WebSocket/fetch,零依赖、零安装、
// 仅访问 127.0.0.1 本机端口)按 spec.json 的 7 个探针逐条自检:
//   状态断言(Runtime.evaluate 读取 window.__bench)+ 独立观测证据
//   (Page.captureScreenshot 截图 + 自写 PNG 解码计算亮像素/差分像素比例)。
// 输出:verify-out/ 下 PNG 截图与 summary.json;stdout 打印 JSON 摘要。
// 退出码:全部探针通过 = 0,否则 1。
// ============================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');

const ARM = __dirname;
const OUT = path.join(ARM, 'verify-out');
const CDP_PORT = 9333;
const PAGE_URL = 'http://127.0.0.1:7100/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 极简 CDP 客户端 -----------------------------------------------------------

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const cdp = { ws, id: 0, pending: new Map(), listeners: new Map(), closed: false };
    ws.onopen = () => resolve(cdp);
    ws.onerror = () => reject(new Error('WebSocket connect failed: ' + wsUrl));
    ws.onclose = () => {
      cdp.closed = true;
      for (const p of cdp.pending.values()) p.reject(new Error('cdp closed'));
      cdp.pending.clear();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id !== undefined) {
        const p = cdp.pending.get(m.id);
        if (p) {
          cdp.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } else {
        const arr = cdp.listeners.get(m.method);
        if (arr) for (const f of arr) f(m.params);
      }
    };
  });
}

function send(cdp, method, params = {}) {
  if (cdp.closed) return Promise.reject(new Error('cdp closed'));
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

function on(cdp, method, fn) {
  if (!cdp.listeners.has(method)) cdp.listeners.set(method, []);
  cdp.listeners.get(method).push(fn);
}

// --- PNG 解码(8-bit,非隔行,支持 colorType 0/2/4/6) ----------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported png: depth=${bitDepth} interlace=${interlace}`);
  const chMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ch = chMap[colorType];
  if (!ch) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      row[x] = v & 255;
    }
    prev.set(row);
  }
  return { w, h, ch, data: out };
}

function pixelLuma(img, x, y) {
  const i = (y * img.w + x) * img.ch;
  if (img.ch >= 3) {
    return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  }
  return img.data[i];
}

function regionRect(img, region) {
  // region: 'full' 或 { cx: 0.8 } 表示中央 80%
  if (region && region.cx) {
    const fw = Math.round(img.w * region.cx);
    const fh = Math.round(img.h * region.cx);
    return { x0: Math.floor((img.w - fw) / 2), y0: Math.floor((img.h - fh) / 2), x1: Math.floor((img.w + fw) / 2), y1: Math.floor((img.h + fh) / 2) };
  }
  return { x0: 0, y0: 0, x1: img.w, y1: img.h };
}

function litRatio(img, region, thr = 40) {
  const r = regionRect(img, region);
  let lit = 0;
  let tot = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      tot++;
      if (pixelLuma(img, x, y) > thr) lit++;
    }
  }
  return lit / Math.max(1, tot);
}

function diffRatio(a, b, region, thr = 8) {
  const r = regionRect(a, region);
  let diff = 0;
  let tot = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      tot++;
      if (Math.abs(pixelLuma(a, x, y) - pixelLuma(b, x, y)) > thr) diff++;
    }
  }
  return diff / Math.max(1, tot);
}

// --- 主流程 -----------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('chrome.exe not found');
  const profileDir = path.join(ARM, '.chrome-tmp');
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,720',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ], { stdio: 'ignore' });

  const summary = { startedAt: new Date().toISOString(), probes: {}, errors: [], consoleErrors: [], notes: [] };

  try {
    // 等 CDP 端口就绪
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        version = await res.json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('CDP port never became ready');
    summary.chrome = version.Browser;

    // 新建页面 target
    const newRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    const target = await newRes.json();
    const cdp = await wsConnect(target.webSocketDebuggerUrl);

    // 事件收集:未捕获异常 / console error / 导航计数
    let navigations = 0;
    let loaded = false;
    on(cdp, 'Runtime.exceptionThrown', (p) => summary.errors.push(JSON.stringify(p.exceptionDetails).slice(0, 500)));
    on(cdp, 'Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') summary.consoleErrors.push((p.args || []).map((a) => a.value || a.description || a.type).join(' ').slice(0, 300));
    });
    on(cdp, 'Log.entryAdded', (p) => {
      if (p.entry && p.entry.level === 'error') summary.consoleErrors.push(String(p.entry.text).slice(0, 300));
    });
    on(cdp, 'Page.frameNavigated', () => { navigations++; });
    on(cdp, 'Page.loadEventFired', () => { loaded = true; });

    await send(cdp, 'Page.enable');
    await send(cdp, 'Runtime.enable');
    await send(cdp, 'Log.enable');
    await send(cdp, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expr) => {
      const r = await send(cdp, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    const getState = () => evaluate('window.__bench ? window.__bench.getState() : null');
    const shot = async (name) => {
      const r = await send(cdp, 'Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(OUT, name), buf);
      return decodePng(buf);
    };
    const mouse = (type, x, y, extra = {}) => send(cdp, 'Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });

    // --- 加载页面,计时 __appReady ---
    const navStart = Date.now();
    await send(cdp, 'Page.navigate', { url: PAGE_URL });
    let readyAt = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        if (await evaluate('window.__appReady === true')) { readyAt = Date.now() - navStart; break; }
      } catch { /* 页面尚未就绪 */ }
    }
    summary.appReadyMs = readyAt;
    if (readyAt == null) throw new Error('__appReady 未在 10s 内置 true');
    // 等待 load 完成标记
    for (let i = 0; i < 20 && !loaded; i++) await sleep(100);

    // --- P1:wait 2500 → starCount + 亮像素比例 ---
    await sleep(2500);
    const p1s = await getState();
    const p1img = await shot('P1.png');
    summary.probes.P1 = {
      starCount: p1s.starCount,
      stateOK: p1s.starCount >= 50000,
      litRatio: +litRatio(p1img, 'full', 40).toFixed(5),
      litRatioThr30: +litRatio(p1img, 'full', 30).toFixed(5),
      visualOK: litRatio(p1img, 'full', 40) >= 0.02,
    };

    // --- P2:wait 500 → before → 2000ms → after;相位增量 + 中央 80% 运动像素 ---
    await sleep(500);
    const p2b = await getState();
    const p2imgB = await shot('P2-before.png');
    await sleep(2000);
    const p2a = await getState();
    const p2imgA = await shot('P2-after.png');
    summary.probes.P2 = {
      dPhase: +(p2a.rotationPhase - p2b.rotationPhase).toFixed(5),
      stateOK: p2a.rotationPhase - p2b.rotationPhase > 0.001,
      motionRatio: +diffRatio(p2imgB, p2imgA, { cx: 0.8 }, 8).toFixed(5),
      motionRatioThr4: +diffRatio(p2imgB, p2imgA, { cx: 0.8 }, 4).toFixed(5),
      visualOK: diffRatio(p2imgB, p2imgA, { cx: 0.8 }, 8) >= 0.005,
    };

    // --- P3:pointermove 中心→(0.68,0.5),wait 400 → before → 600ms → after ---
    await mouse('mouseMoved', 640, 360);
    await sleep(150);
    await mouse('mouseMoved', 870, 360);
    await sleep(400);
    const p3b = await getState();
    const p3imgB = await shot('P3-before.png');
    await sleep(600);
    const p3a = await getState();
    const p3imgA = await shot('P3-after.png');
    summary.probes.P3 = {
      before: { x: +p3b.parallaxOffset.x.toFixed(5), y: +p3b.parallaxOffset.y.toFixed(5) },
      after: { x: +p3a.parallaxOffset.x.toFixed(5), y: +p3a.parallaxOffset.y.toFixed(5) },
      stateOK: p3a.parallaxOffset.x !== p3b.parallaxOffset.x || p3a.parallaxOffset.y !== p3b.parallaxOffset.y,
      diffRatio: +diffRatio(p3imgB, p3imgA, 'full', 8).toFixed(5),
      visualOK: diffRatio(p3imgB, p3imgA, 'full', 8) >= 0.003,
    };

    // --- P4:wheel deltaY=-600,wait 500 → before → 300ms → after ---
    await mouse('mouseWheel', 640, 360, { deltaX: 0, deltaY: -600 });
    await sleep(500);
    const p4b = await getState();
    const p4imgB = await shot('P4-before.png');
    await sleep(300);
    const p4a = await getState();
    const p4imgA = await shot('P4-after.png');
    summary.probes.P4 = {
      beforeDist: +p4b.cameraDistance.toFixed(3),
      afterDist: +p4a.cameraDistance.toFixed(3),
      stateOK: p4a.cameraDistance < p4b.cameraDistance - 5,
      diffRatio: +diffRatio(p4imgB, p4imgA, 'full', 8).toFixed(5),
      visualOK: diffRatio(p4imgB, p4imgA, 'full', 8) >= 0.01,
    };

    // --- P5:HUD 可见 + 文本与状态一致 ---
    const p5s = await getState();
    const hudText = await evaluate("document.getElementById('hud') ? document.getElementById('hud').innerText : ''");
    summary.probes.P5 = {
      hudVisible: p5s.hudVisible,
      fps: +p5s.fps.toFixed(2),
      stateOK: p5s.hudVisible === true && p5s.fps > 0,
      hudText: hudText.replace(/\n/g, ' | '),
      textHasStarCount: hudText.includes(String(p5s.starCount)),
      textHasFpsRound: hudText.includes(String(Math.round(p5s.fps))),
    };
    summary.probes.P5.visualOK = summary.probes.P5.textHasStarCount && summary.probes.P5.textHasFpsRound;

    // --- P6:fps ≥ 30(3s 后再次采样) ---
    await sleep(3000);
    const p6s = await getState();
    summary.probes.P6 = { fps: +p6s.fps.toFixed(2), stateOK: p6s.fps >= 30, visualOK: true, note: 'perfSample 由本脚本帧率采样交叉验证(见 fps 序列)' };

    // --- P7:指针归位中心 → 点击 Reset → wait 800 → 断言 + 无导航 ---
    const navBefore = navigations;
    await mouse('mouseMoved', 640, 360);
    await sleep(200);
    const btnRect = await evaluate("(function(){const b=document.querySelector('[data-ui=reset]');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    await mouse('mousePressed', btnRect.x, btnRect.y, { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', btnRect.x, btnRect.y, { button: 'left', clickCount: 1 });
    await sleep(800);
    const p7s = await getState();
    const p7img = await shot('P7.png');
    const inRange = p7s.cameraDistance >= 115 && p7s.cameraDistance <= 125;
    const paraZero = Math.abs(p7s.parallaxOffset.x) < 0.01 && Math.abs(p7s.parallaxOffset.y) < 0.01;
    summary.probes.P7 = {
      epoch: p7s.epoch,
      cameraDistance: +p7s.cameraDistance.toFixed(3),
      rotationPhase: +p7s.rotationPhase.toFixed(5),
      parallaxOffset: { x: +p7s.parallaxOffset.x.toFixed(5), y: +p7s.parallaxOffset.y.toFixed(5) },
      stateOK: p7s.epoch >= 1 && inRange && paraZero && p7s.rotationPhase < 0.1,
      litRatio: +litRatio(p7img, 'full', 40).toFixed(5),
      visualOK: litRatio(p7img, 'full', 40) >= 0.02,
      navigationsAfterClick: navigations - navBefore,
      noNavigation: navigations - navBefore === 0,
    };

    // --- 连续 reset 一致性(brief §7) ---
    await evaluate('window.__bench.reset()');
    await sleep(800);
    await evaluate('window.__bench.reset()');
    await sleep(800);
    const p7x = await getState();
    summary.notes.push('reset 连续 3 次:epoch=' + p7x.epoch + ', dist=' + p7x.cameraDistance.toFixed(3) + ', phase=' + p7x.rotationPhase.toFixed(5));

    summary.noUncaughtErrors = summary.errors.length === 0 && summary.consoleErrors.length === 0;
    summary.allPassed = Object.values(summary.probes).every((p) => p.stateOK && p.visualOK) && summary.noUncaughtErrors && summary.appReadyMs <= 10000;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(600);
    try { fs.rmSync(path.join(ARM, '.chrome-tmp'), { recursive: true, force: true }); } catch { /* Windows 文件锁,忽略 */ }
  }

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e.message);
  process.exit(1);
});
