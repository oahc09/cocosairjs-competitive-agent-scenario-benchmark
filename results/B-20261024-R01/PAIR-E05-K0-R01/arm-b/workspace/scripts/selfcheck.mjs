#!/usr/bin/env node
/**
 * selfcheck.mjs — 本 Arm 自检工具(非冻结模板;不属于 harness/validator)
 *
 * 用途:用一次浏览器会话重放 spec.json 的 6 个探针动作,抓多帧截图 + 状态采样,
 * 并在 Node 侧解码 PNG 计算像素证据(非黑比例、环带 R-B、径向剖面、帧差)。
 * 浏览器会话创建前先调用 scripts/count.mjs browser,遵守 RUN-CONTRACT §2 计数口径。
 *
 * 用法: node scripts/selfcheck.mjs --url http://127.0.0.1:7109/
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const url = arg('url', 'http://127.0.0.1:7109/');
const outDir = path.resolve(root, arg('out', '.selfcheck'));
fs.mkdirSync(outDir, { recursive: true });

// --- ① browser 计数(先计后会话) ------------------------------------------
const counted = spawnSync(process.execPath, [path.join(__dirname, 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('[selfcheck] count failed', counted.stdout, counted.stderr);
  process.exit(1);
}
process.stdout.write(counted.stdout);

const requireCjs = createRequire(import.meta.url);
const { chromium } = requireCjs('playwright-core');

function candidates() {
  const out = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) out.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  out.push(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return out.filter((p) => p && fs.existsSync(p));
}

async function launch() {
  const errs = [];
  for (const exe of [null, ...candidates()]) {
    try {
      return await chromium.launch({
        ...(exe ? { executablePath: exe } : {}),
        headless: true,
        viewport: { width: 1280, height: 720 },
      });
    } catch (e) {
      errs.push(`${exe || 'default'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('no browser: ' + errs.join(' | '));
}

// --- PNG 解码(8-bit,filter 0-4) ------------------------------------------
function decodePNG(buf) {
  let pos = 8;
  let w = 0; let h = 0; let colorType = 6; let bitDepth = 8;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const data = Buffer.alloc(w * h * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[lineStart + x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      cur[x] = v;
    }
    cur.copy(data, y * stride);
    prev = cur;
  }
  return { w, h, channels, data };
}

function px(img, x, y) {
  const i = (y * img.w + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function nonBlackRatio(img, x0, y0, x1, y1, thr) {
  let hit = 0;
  let total = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x += 1) {
      const [r, g, b] = px(img, x, y);
      if (Math.max(r, g, b) > thr) hit++;
      total++;
    }
  }
  return total ? hit / total : 0;
}

function annulusSample(img, band) {
  const cx = img.w / 2;
  const cy = img.h / 2;
  const minD = Math.min(img.w, img.h);
  const r0 = band[0] * minD;
  const r1 = band[1] * minD;
  const acc = {
    full: { n: 0, r: 0, g: 0, b: 0 },
    right: { n: 0, r: 0, g: 0, b: 0 },
    left: { n: 0, r: 0, g: 0, b: 0 },
  };
  const step = 2;
  for (let y = Math.floor(cy - r1); y <= cy + r1; y += step) {
    for (let x = Math.floor(cx - r1); x <= cx + r1; x += step) {
      const dx = x - cx;
      const dy = y - cy;
      const rr = Math.sqrt(dx * dx + dy * dy);
      if (rr < r0 || rr > r1) continue;
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const [r, g, b] = px(img, x, y);
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      for (const key of ['full', 'right', 'left']) {
        if (key === 'right' && Math.abs(ang) > 25) continue;
        if (key === 'left' && Math.abs(Math.abs(ang) - 180) > 25) continue;
        const a = acc[key];
        a.n++; a.r += r; a.g += g; a.b += b;
      }
    }
  }
  const out = {};
  for (const key of ['full', 'right', 'left']) {
    const a = acc[key];
    if (!a.n) { out[key] = null; continue; }
    const r = a.r / a.n; const g = a.g / a.n; const b = a.b / a.n;
    out[key] = { r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1), lum: +lum(r, g, b).toFixed(1), rb: +(r - b).toFixed(1) };
  }
  return out;
}

function radialProfile(img, angleDeg, maxPx) {
  const cx = img.w / 2;
  const cy = img.h / 2;
  const a = angleDeg * Math.PI / 180;
  const out = [];
  for (let rr = 0; rr <= maxPx; rr += 6) {
    const x = Math.round(cx + Math.cos(a) * rr);
    const y = Math.round(cy + Math.sin(a) * rr);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) break;
    const [r, g, b] = px(img, x, y);
    out.push({ rr, lum: Math.round(lum(r, g, b)), rb: r - b });
  }
  return out;
}

function firstAbove(profile, thr, fromR = 0) {
  for (const p of profile) if (p.rr >= fromR && p.lum >= thr) return p.rr;
  return -1;
}
function lastAbove(profile, thr) {
  let last = -1;
  for (const p of profile) if (p.lum >= thr) last = p.rr;
  return last;
}

function frameDiff(a, b, region) {
  const x0 = region ? Math.max(0, Math.floor(region[0])) : 0;
  const y0 = region ? Math.max(0, Math.floor(region[1])) : 0;
  const x1 = region ? Math.min(a.w, Math.ceil(region[2])) : a.w;
  const y1 = region ? Math.min(a.h, Math.ceil(region[3])) : a.h;
  let n = 0; let total = 0; let strong = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const [r1, g1, b1] = px(a, x, y);
      const [r2, g2, b2] = px(b, x, y);
      const d = Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
      if (d > 8) n++;
      if (d > 24) strong++;
      total++;
    }
  }
  return { moved: +(n / total).toFixed(4), strong: +(strong / total).toFixed(4) };
}

function shotStats(img) {
  const w = img.w; const h = img.h;
  const minD = Math.min(w, h);
  const cw = w * 0.125; const ch = h * 0.125;
  const regions = {
    centerThird: [
      nonBlackRatio(img, w / 3, h / 3, (2 * w) / 3, (2 * h) / 3, 8),
      nonBlackRatio(img, w / 3, h / 3, (2 * w) / 3, (2 * h) / 3, 16),
    ],
    corners: [
      nonBlackRatio(img, 0, 0, cw, ch, 8) + nonBlackRatio(img, w - cw, 0, w, ch, 8)
        + nonBlackRatio(img, 0, h - ch, cw, h, 8) + nonBlackRatio(img, w - cw, h - ch, w, h, 8),
      nonBlackRatio(img, 0, 0, cw, ch, 16) + nonBlackRatio(img, w - cw, 0, w, ch, 16)
        + nonBlackRatio(img, 0, h - ch, cw, h, 16) + nonBlackRatio(img, w - cw, h - ch, w, h, 16),
    ],
    inner: annulusSample(img, [0.06, 0.14]),
    outer: annulusSample(img, [0.18, 0.30]),
    profileX: radialProfile(img, 0, Math.round(minD * 0.36)),
    profileNX: radialProfile(img, 180, Math.round(minD * 0.36)),
    profileUp: radialProfile(img, -90, Math.round(minD * 0.30)),
  };
  const ringR = firstAbove(regions.profileX, 60);
  const diskLast = lastAbove(regions.profileX, 18);
  return {
    size: `${w}x${h}`,
    centerThird: { gt8: +regions.centerThird[0].toFixed(3), gt16: +regions.centerThird[1].toFixed(3) },
    cornersSum: { gt8: +regions.corners[0].toFixed(3), gt16: +regions.corners[1].toFixed(3) },
    inner: regions.inner,
    outer: regions.outer,
    ringRadiusPx: ringR,
    diskOuterRadiusPx: diskLast,
    profiles: {
      x: regions.profileX.filter((_, i) => i % 2 === 0),
      up: regions.profileUp.filter((_, i) => i % 2 === 0),
    },
  };
}

// --- ③ 会话 ---------------------------------------------------------------
const summary = { url, appReady: false, readyMs: null, bench: null, consoleErrors: [], uncaught: [], steps: [] };
let browser;
let exitCode = 0;
try {
  browser = await launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (m) => { if (m.type() === 'error') summary.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => summary.uncaught.push(String(e && e.message ? e.message : e).slice(0, 300)));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  while (Date.now() - t0 < 10000) {
    const ok = await page.evaluate(() => window.__appReady === true).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  summary.readyMs = Date.now() - t0;
  summary.appReady = await page.evaluate(() => window.__appReady === true);
  summary.bench = await page.evaluate(() => !!(window.__bench && window.__bench.getState && window.__bench.reset));
  summary.diag = await page.evaluate(() => (window.__diag ? window.__diag.materials() : null)).catch(() => null);

  const shot = async (name) => {
    const p = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: p });
    return p;
  };
  const snap = async (label) => {
    const st = await page.evaluate(() => window.__bench.getState());
    summary.steps.push({ label, state: st });
    return st;
  };

  // P1
  await page.waitForTimeout(2500);
  await snap('P1');
  const s1 = await shot('s1');
  // P2
  await page.waitForTimeout(800);
  await snap('P2');
  const s2 = await shot('s2');
  // P3
  await page.waitForTimeout(1000);
  await snap('P3');
  const s3 = await shot('s3');
  // P4:wheel dy=-600(向上滚=靠近)
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1200);
  await snap('P4');
  const s4 = await shot('s4');
  // P5
  await page.waitForTimeout(1000);
  await snap('P5');
  const s5 = await shot('s5');
  // P6:click data-ui=reset
  await page.click('[data-ui="reset"]');
  await page.waitForTimeout(400);
  await snap('P6');
  const s6 = await shot('s6');

  const img1 = decodePNG(fs.readFileSync(s1));
  const img2 = decodePNG(fs.readFileSync(s2));
  const img3 = decodePNG(fs.readFileSync(s3));
  const img4 = decodePNG(fs.readFileSync(s4));
  const img5 = decodePNG(fs.readFileSync(s5));
  const img6 = decodePNG(fs.readFileSync(s6));

  const minD = Math.min(img1.w, img1.h);
  summary.pixels = {
    s1_P1: shotStats(img1),
    s3_P3: shotStats(img3),
    s6_P6: shotStats(img6),
    p4Zoom: {
      from: shotStats(img3).diskOuterRadiusPx,
      to: shotStats(img4).diskOuterRadiusPx,
      core: { from: shotStats(img3).ringRadiusPx, to: shotStats(img4).ringRadiusPx },
    },
    diffP2: frameDiff(img1, img2, [img1.w / 2 - minD * 0.4, img1.h / 2 - minD * 0.4, img1.w / 2 + minD * 0.4, img1.h / 2 + minD * 0.4]),
    diffP5: frameDiff(img4, img5, [img4.w / 2 - minD * 0.35, img4.h / 2 - minD * 0.35, img4.w / 2 + minD * 0.35, img4.h / 2 + minD * 0.35]),
    diffFull: frameDiff(img1, img2),
  };
  summary.shots = [s1, s2, s3, s4, s5, s6].map((p) => path.relative(root, p).replaceAll('\\', '/'));
} catch (e) {
  summary.fatal = String(e && e.message ? e.message : e).split('\n')[0];
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
if (summary.uncaught.length || summary.consoleErrors.length) exitCode = 1;
console.log('[selfcheck] ' + JSON.stringify(summary, null, 2));
process.exit(exitCode);
