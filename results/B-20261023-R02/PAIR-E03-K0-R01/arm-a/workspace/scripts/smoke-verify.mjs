#!/usr/bin/env node
// ============================================================================
// smoke-verify.mjs — M2 模板浏览器冒烟验证(交付物 7c,非 benchmark 场景)
// ----------------------------------------------------------------------------
// 前置:1) dist 已构建;2) scripts/serve.mjs 已监听 PORT(默认 5173);
//       3) playwright-core 已安装(临时 devDependency 或 npm i --no-save)。
// 断言(1280x720 headless):
//   A. 3s 内 window.__appReady === true
//   B. window.__bench.getState().frame 递增
//   C. 截图中心区域(中央 50%x50%)非纯黑像素占比 > 5%(零依赖 PNG 解码)
//   D. window.__bench.reset() 后 frame 立即归零、随后继续递增
// WebGL 不可用时按组合重试启动参数(no-args -> --enable-unsafe-swiftshader
//   -> --use-angle=swiftshader -> 两者叠加),成功组合打印并写入 .tmp/launch-args.json
//   供 template-manifest.json / harness 复用。截图存 template-smoke.png。
// 退出码:全部通过 0;否则 1。
// ============================================================================

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '5173';
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;

// 浏览器可执行文件:优先 CHROME_PATH,其次 Chrome 安装路径,最后 playwright 缓存 chromium
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA
    ? [path.join(process.env.LOCALAPPDATA, 'ms-playwright')]
    : []),
].filter(Boolean);

function findExecutable() {
  for (const c of CHROME_CANDIDATES) {
    if (c.endsWith('chrome.exe') || c.endsWith('chrome')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // playwright 缓存目录:取最新的 chromium-*/chrome-win*/chrome.exe
    if (fs.existsSync(c)) {
      const dirs = fs
        .readdirSync(c)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort();
      for (const d of dirs.reverse()) {
        for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
          const p = path.join(c, d, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}

// --- 零依赖 PNG 解码(playwright 截图为 8-bit 非隔行 truecolor) ------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
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
      const a = i >= ch ? cur[i - ch] : 0; // 左
      const b = prev[i]; // 上
      const c = i >= ch ? prev[i - ch] : 0; // 左上
      let v = line[i];
      if (filter === 1) v = (v + a) & 255; // Sub
      else if (filter === 2) v = (v + b) & 255; // Up
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255; // Average
      else if (filter === 4) {
        // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      out[o] = cur[s];
      out[o + 1] = cur[s + 1];
      out[o + 2] = cur[s + 2];
      out[o + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, pixels: out };
}

// 中心 50%x50% 区域内非纯黑(max(r,g,b) > 10)像素占比
function centerNonBlackRatio(img) {
  const x0 = Math.floor(img.width * 0.25);
  const x1 = Math.ceil(img.width * 0.75);
  const y0 = Math.floor(img.height * 0.25);
  const y1 = Math.ceil(img.height * 0.75);
  let total = 0;
  let lit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      total += 1;
      if (img.pixels[i] > 10 || img.pixels[i + 1] > 10 || img.pixels[i + 2] > 10) lit += 1;
    }
  }
  return lit / total;
}

const LAUNCH_COMBOS = [
  { label: 'no-extra-args', args: [] },
  { label: 'enable-unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  { label: 'use-angle-swiftshader', args: ['--use-angle=swiftshader'] },
  { label: 'use-angle-swiftshader+enable-unsafe-swiftshader', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
];

const exe = findExecutable();
if (!exe) {
  console.error('SMOKE_FAIL: no chromium/chrome executable found');
  process.exit(1);
}
console.log(`[smoke] executable: ${exe}`);
console.log(`[smoke] page: ${PAGE_URL}`);

let lastErr = null;
for (const combo of LAUNCH_COMBOS) {
  console.log(`\n[smoke] === try launch args: ${JSON.stringify(combo.args)} (${combo.label}) ===`);
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, executablePath: exe, args: combo.args });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 10000 });

    // A. __appReady 在 3s 内为 true
    const t0 = Date.now();
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 3000 });
    const readyMs = Date.now() - t0;
    console.log(`  [A] PASS __appReady === true (${readyMs}ms, limit 3000ms)`);

    // B. frame 递增
    const f1 = await page.evaluate(() => window.__bench.getState().frame);
    await page.waitForTimeout(400);
    const f2 = await page.evaluate(() => window.__bench.getState().frame);
    if (!(f1 >= 1 && f2 > f1)) throw new Error(`frame not increasing: f1=${f1} f2=${f2}`);
    console.log(`  [B] PASS frame increasing: ${f1} -> ${f2}`);

    // D. reset() 后 frame 归零、再递增
    //    reset 与读取放在同一次 evaluate 里(原子),避免两次 CDP 往返之间 rAF 又渲染 1 帧
    const f3 = await page.evaluate(() => {
      window.__bench.reset();
      return window.__bench.getState().frame;
    });
    await page.waitForTimeout(300);
    const f4 = await page.evaluate(() => window.__bench.getState().frame);
    if (f3 !== 0 || f4 <= 0) throw new Error(`reset broken: rightAfter=${f3} then=${f4}`);
    console.log(`  [D] PASS reset(): frame -> ${f3} (atomic), then -> ${f4}`);

    // C. 截图中心区域非纯黑(>5%),存 template-smoke.png
    const shot = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(root, 'template-smoke.png'), shot);
    const img = decodePng(shot);
    const ratio = centerNonBlackRatio(img);
    if (ratio <= 0.05) throw new Error(`center region blank: nonBlack=${(ratio * 100).toFixed(2)}% (need >5%)`);
    console.log(`  [C] PASS screenshot ${img.width}x${img.height}, center non-black ${(ratio * 100).toFixed(2)}% (>5%)`);

    console.log(`  [+] ${consoleErrors.length === 0 ? 'PASS no console errors / pageerrors' : `WARN console errors: ${JSON.stringify(consoleErrors)}`}`);
    await browser.close();

    // 成功:记录启动参数(manifest / harness 复用),汇总一行
    const launch = { executablePath: exe, headless: true, args: combo.args, viewport: { width: 1280, height: 720 } };
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tmp', 'launch-args.json'), JSON.stringify(launch, null, 2));
    console.log('\nSMOKE_OK ' + JSON.stringify({
      launch,
      readyMs,
      frameSample: [f1, f2],
      frameAfterReset: [f3, f4],
      centerNonBlackRatio: Number(ratio.toFixed(4)),
      consoleErrors,
    }));
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.log(`  FAIL ${e && e.message ? e.message : String(e)}`);
    try {
      if (browser) await browser.close();
    } catch { /* ignore */ }
  }
}

console.error(`\nSMOKE_FAIL: all launch combos failed; last error: ${lastErr && lastErr.message ? lastErr.message : String(lastErr)}`);
process.exit(1);
