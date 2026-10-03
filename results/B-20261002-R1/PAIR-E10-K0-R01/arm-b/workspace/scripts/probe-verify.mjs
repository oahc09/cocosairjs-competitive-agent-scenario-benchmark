#!/usr/bin/env node
// ============================================================================
// probe-verify.mjs — E10 探针自检(P1–P7 逐条模拟 spec.json 的 probes)
// ----------------------------------------------------------------------------
// 前置:dist 已构建;serve.mjs 已监听 PORT。playwright-core 已 vendored。
// 断言内容:
//   - state 断言:与 spec.json 各 probe 的 jq 等价的 JS 断言
//   - visual 断言:nonBlank / motion / regionChange(零依赖 PNG 解码)
//   - network 断言:assets/character.glb 全会话仅一次请求且 200(reset 后不重复)
// 截图存 .tmp/probe-shots/pN.png。退出码 0 = 全部通过。
// ============================================================================

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '7107';
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const SHOT_DIR = path.join(root, '.tmp', 'probe-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const REG_A = { x: 0.08, y: 0.15, w: 0.34, h: 0.8 };
const REG_B = { x: 0.58, y: 0.15, w: 0.34, h: 0.8 };

// --- 零依赖 PNG 解码(同 smoke-verify.mjs) --------------------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
      out[o + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, pixels: out };
}

function toRect(img, r) {
  return {
    x0: Math.floor(img.width * r.x),
    y0: Math.floor(img.height * r.y),
    x1: Math.ceil(img.width * (r.x + r.w)),
    y1: Math.ceil(img.height * (r.y + r.h)),
  };
}

// nonBlank:与区域边条(左 6px 列 + 顶 6px 行)中位色差异 > 28 的像素占比
function nonBlankRatio(img, r) {
  const { x0, y0, x1, y1 } = toRect(img, r);
  const samples = [];
  for (let y = y0; y < y1; y += 3) {
    const i = (y * img.width + Math.min(x0 + 2, img.width - 1)) * 4;
    samples.push([img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]);
  }
  for (let x = x0; x < x1; x += 3) {
    const i = (Math.min(y0 + 2, img.height - 1) * img.width + x) * 4;
    samples.push([img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]);
  }
  const med = [0, 1, 2].map((c) => {
    const arr = samples.map((s) => s[c]).sort((a, b) => a - b);
    return arr[arr.length >> 1];
  });
  let total = 0, lit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      total += 1;
      if (
        Math.abs(img.pixels[i] - med[0]) > 28 ||
        Math.abs(img.pixels[i + 1] - med[1]) > 28 ||
        Math.abs(img.pixels[i + 2] - med[2]) > 28
      ) lit += 1;
    }
  }
  return lit / Math.max(total, 1);
}

// 两帧同区域差异像素占比
function diffRatio(a, b, r) {
  const rect = toRect(a, r);
  let total = 0, diff = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * a.width + x) * 4;
      total += 1;
      if (
        Math.abs(a.pixels[i] - b.pixels[i]) > 12 ||
        Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) > 12 ||
        Math.abs(a.pixels[i + 2] - b.pixels[i + 2]) > 12
      ) diff += 1;
    }
  }
  return diff / Math.max(total, 1);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findExecutable() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

const exe = findExecutable();
if (!exe) {
  console.error('PROBE_FAIL: no chrome executable found');
  process.exit(1);
}

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function shot(page, name) {
  const buf = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), buf);
  return decodePng(buf);
}

const browser = await chromium.launch({ headless: true, executablePath: exe, args: [] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const assetReqs = [];
  page.on('response', (res) => {
    if (res.url().includes('assets/character.glb')) assetReqs.push({ url: res.url(), status: res.status() });
  });

  console.log(`[probe] page: ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 15000 });

  // --- 就绪等待(__appReady,10s 上限)-----------------------------------------
  const t0 = Date.now();
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
  console.log(`[probe] __appReady after ${Date.now() - t0}ms`);
  record('P0', '__bench contract', await page.evaluate(
    () => typeof window.__bench?.getState === 'function' && typeof window.__bench?.reset === 'function'
  ), 'getState/reset callable');

  // --- P1:wait 1500 -------------------------------------------------------------
  await page.waitForTimeout(1500);
  {
    const s = await page.evaluate(() => window.__bench.getState());
    record('P1', 'state: assetLoaded && count=2 && both idle',
      s.assetLoaded === true && s.instanceCount === 2 && s.instances.A?.clip === 'idle' && s.instances.B?.clip === 'idle',
      JSON.stringify(s.instances));
    const img = await shot(page, 'p1.png');
    const cA = nonBlankRatio(img, REG_A), cB = nonBlankRatio(img, REG_B);
    record('P1', 'visual: nonBlank A/B >= 0.1', cA >= 0.1 && cB >= 0.1, `A=${cA.toFixed(3)} B=${cB.toFixed(3)}`);
    record('P1', 'network: character.glb 200 x1', assetReqs.length === 1 && assetReqs[0].status === 200,
      JSON.stringify(assetReqs));
  }

  // --- P2:wait 1000,双实例 time 推进 + 双区域运动 --------------------------------
  await page.waitForTimeout(1000);
  {
    const t1 = await page.evaluate(() => {
      const s = window.__bench.getState();
      return { at: s.instances.A?.time, bt: s.instances.B?.time, n: s.instanceCount };
    });
    await page.waitForTimeout(800);
    const t2 = await page.evaluate(() => {
      const s = window.__bench.getState();
      return { at: s.instances.A?.time, bt: s.instances.B?.time };
    });
    // spec 断言:time > 0 且 count=2;循环剪辑回绕允许(spec §8),
    // 推进证据 = 时间发生变化(含回绕)或运动视觉(下方 motion 断言)
    const moved = (a, b) => Math.abs(b - a) > 0.001;
    record('P2', 'state: A/B time > 0, count=2, time changing',
      t1.at > 0 && t1.bt > 0 && t1.n === 2 && moved(t1.at, t2.at) && moved(t1.bt, t2.bt),
      `A ${t1.at.toFixed(2)}->${t2.at.toFixed(2)} B ${t1.bt.toFixed(2)}->${t2.bt.toFixed(2)}`);
    const imgA = await shot(page, 'p2a.png');
    await page.waitForTimeout(800);
    const imgB = await shot(page, 'p2b.png');
    const mA = diffRatio(imgA, imgB, REG_A), mB = diffRatio(imgA, imgB, REG_B);
    record('P2', 'visual: motion A/B > 0.003', mA > 0.003 && mB > 0.003, `A=${mA.toFixed(4)} B=${mB.toFixed(4)}`);
  }

  // --- P3:click anim-a-walk ------------------------------------------------------
  {
    const s0 = await page.evaluate(() => window.__bench.getState());
    await page.click('[data-bench="anim-a-walk"]');
    const latency = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (window.__bench.getState().instances.A?.clip === 'walk') { clearInterval(iv); res(performance.now() - t0); }
      }, 16);
    }));
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__bench.getState());
    record('P3', 'state: A=walk B=idle', s.instances.A?.clip === 'walk' && s.instances.B?.clip === 'idle',
      `A=${s.instances.A?.clip} B=${s.instances.B?.clip} switchLatency=${latency.toFixed(0)}ms (<=300)`);
    record('P3', 'switch latency <= 300ms', latency <= 300);
    const imgA = await shot(page, 'p3a.png');
    await page.waitForTimeout(500);
    const imgB = await shot(page, 'p3b.png');
    const dA = diffRatio(imgA, imgB, REG_A);
    record('P3', 'visual: regionChange A > 0.003', dA > 0.003, `A=${dA.toFixed(4)}`);
  }

  // --- P3b(补充,scoring:双向隔离):B 切 Walk 不影响 A ---------------------------
  {
    await page.click('[data-bench="anim-b-walk"]');
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => window.__bench.getState());
    record('P3b', 'state: B=walk A unchanged(walk)',
      s.instances.B?.clip === 'walk' && s.instances.A?.clip === 'walk',
      `A=${s.instances.A?.clip} B=${s.instances.B?.clip}`);
    await page.click('[data-bench="anim-b-idle"]');
    await page.waitForTimeout(400);
    const s2 = await page.evaluate(() => window.__bench.getState());
    record('P3b', 'state: B back to idle, A still walk',
      s2.instances.B?.clip === 'idle' && s2.instances.A?.clip === 'walk',
      `A=${s2.instances.A?.clip} B=${s2.instances.B?.clip}`);
  }

  // --- P4:click destroy-a --------------------------------------------------------
  {
    const imgA = await shot(page, 'p4a.png'); // 销毁前帧
    await page.click('[data-bench="destroy-a"]');
    await page.waitForTimeout(800);
    const s = await page.evaluate(() => window.__bench.getState());
    record('P4', 'state: count=1 destroyed=A A=null',
      s.instanceCount === 1 && s.destroyedInstance === 'A' && s.instances.A === null,
      JSON.stringify(s.instances));
    const imgB = await shot(page, 'p4b.png'); // 销毁后帧(frameGap 语义:动作前后对比)
    const dA = diffRatio(imgA, imgB, REG_A);
    record('P4', 'visual: regionChange A > 0.003 (A gone)', dA > 0.003, `A=${dA.toFixed(4)}`);
    const cB = nonBlankRatio(imgB, REG_B);
    record('P4', 'visual: B still visible', cB >= 0.1, `B=${cB.toFixed(3)}`);
  }

  // --- P5:wait 1500,B 仍动画 -----------------------------------------------------
  {
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => {
      const s = window.__bench.getState();
      return { bt: s.instances.B?.time, n: s.instanceCount, clip: s.instances.B?.clip };
    });
    await page.waitForTimeout(800);
    const t2 = await page.evaluate(() => window.__bench.getState());
    // spec 断言:count=1、B=idle、time > 0;循环回绕允许,推进证据 = 时间在变化
    const moved = Math.abs(t2.instances.B.time - t1.bt) > 0.001;
    record('P5', 'state: count=1 B=idle time > 0 and changing',
      t1.n === 1 && t1.clip === 'idle' && t1.bt > 0 && moved,
      `B ${t1.bt.toFixed(2)}->${t2.instances.B.time.toFixed(2)}`);
    const imgA = await shot(page, 'p5a.png');
    await page.waitForTimeout(800);
    const imgB = await shot(page, 'p5b.png');
    const mB = diffRatio(imgA, imgB, REG_B);
    record('P5', 'visual: motion B > 0.003', mB > 0.003, `B=${mB.toFixed(4)}`);
  }

  // --- P6:click reset ------------------------------------------------------------
  {
    const reqsBefore = assetReqs.length;
    await page.click('[data-bench="reset"]');
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => window.__bench.getState());
    record('P6', 'state: resetCount=1 count=2 destroyed=null both idle',
      s.resetCount === 1 && s.instanceCount === 2 && s.destroyedInstance === null &&
      s.instances.A?.clip === 'idle' && s.instances.B?.clip === 'idle',
      JSON.stringify({ resetCount: s.resetCount, n: s.instanceCount, d: s.destroyedInstance, A: s.instances.A?.clip, B: s.instances.B?.clip }));
    record('P6', 'network: no new asset request', assetReqs.length === reqsBefore,
      `total=${assetReqs.length}`);
    const img = await shot(page, 'p6.png');
    const cA = nonBlankRatio(img, REG_A), cB = nonBlankRatio(img, REG_B);
    record('P6', 'visual: nonBlank A/B >= 0.1', cA >= 0.1 && cB >= 0.1, `A=${cA.toFixed(3)} B=${cB.toFixed(3)}`);
  }

  // --- P7:wait 1000,恢复后动画 + fps >= 30 ----------------------------------------
  {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__bench.getState());
    record('P7', 'state: A/B time > 0 && fps >= 30',
      s.instances.A?.time > 0 && s.instances.B?.time > 0 && s.fps >= 30,
      `fps=${s.fps} A.t=${s.instances.A?.time?.toFixed(2)} B.t=${s.instances.B?.time?.toFixed(2)}`);
    const imgA = await shot(page, 'p7a.png');
    await page.waitForTimeout(800);
    const imgB = await shot(page, 'p7b.png');
    const mA = diffRatio(imgA, imgB, REG_A), mB = diffRatio(imgA, imgB, REG_B);
    record('P7', 'visual: motion A/B > 0.003', mA > 0.003 && mB > 0.003, `A=${mA.toFixed(4)} B=${mB.toFixed(4)}`);
  }

  record('ALL', 'no console errors / pageerrors', consoleErrors.length === 0, JSON.stringify(consoleErrors));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('PROBE_FAIL:', failed.map((f) => f.id + ':' + f.name).join(' | '));
    process.exitCode = 1;
  } else {
    console.log('PROBE_OK');
  }
} finally {
  await browser.close();
}
