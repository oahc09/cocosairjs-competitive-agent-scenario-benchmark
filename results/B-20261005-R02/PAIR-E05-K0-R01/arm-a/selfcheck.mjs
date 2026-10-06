#!/usr/bin/env node
// ============================================================================
// selfcheck.mjs — E05 Arm A 一次性探针自检(单浏览器会话,计入 browserAttempt)
// 用法: node selfcheck.mjs [--url http://127.0.0.1:7112/index.html]
// 合规: 创建会话前先执行 workspace/scripts/count.mjs browser(先计后会话,RUN-CONTRACT §2/§4.12)。
// 覆盖: spec.json P1-P6 的状态断言 + 视觉断言像素证据(截图在页内 2D canvas 解码分析)。
// 输出: 每 probe PASS/FAIL 行 + [metrics] JSON;退出码 0=全部通过。
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, 'workspace');
const OUT = path.join(__dirname, 'selfcheck');
fs.mkdirSync(OUT, { recursive: true });

let url = 'http://127.0.0.1:7112/index.html';
const ai = process.argv.indexOf('--url');
if (ai > 0 && process.argv[ai + 1]) url = process.argv[ai + 1];

// ① 预算机器计数(先计后会话,不可绕过)
const c = spawnSync(process.execPath, [path.join(WS, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
process.stdout.write(c.stdout || '');
if (c.status !== 0) {
  console.error((c.stderr || '') + '[selfcheck] browser 计数失败,拒绝创建会话');
  process.exit(1);
}

// ② 启动浏览器(playwright-core,候选回退与 verify-browser.mjs 同口径)
const { chromium } = createRequire(import.meta.url)('playwright-core');
async function launch() {
  const errs = [];
  const cands = [null];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const exe of cands) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try {
      return await chromium.launch({
        ...(exe ? { executablePath: exe } : {}),
        headless: true, viewport: { width: 1280, height: 720 }, timeout: 30000,
      });
    } catch (e) { errs.push((exe || 'playwright-default') + ': ' + e.message.split('\n')[0]); }
  }
  throw new Error('no usable browser (tried: ' + errs.join(' | ') + ')');
}

const checks = [];
const ck = (id, ok, detail) => {
  checks.push({ id, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} :: ${detail}`);
};

const consoleErrors = [];
const pageErrors = [];
let browser = null;
let exitCode = 0;
try {
  browser = await launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 <= 10000) {
    ready = await page.evaluate(() => window.__appReady === true).catch(() => false);
    if (ready) break;
    await page.waitForTimeout(200);
  }
  ck('appReady(<=10s)', ready === true, `${Date.now() - t0}ms`);
  const benchOk = await page.evaluate(() =>
    !!(window.__bench && typeof window.__bench.getState === 'function' && typeof window.__bench.reset === 'function'));
  ck('benchContract', benchOk, '__bench={getState,reset}');

  const st = () => page.evaluate(() => window.__bench.getState());
  const s0 = await st();
  ck('P1.state', s0.backgroundStarCount >= 300 && s0.starStreamCount >= 200 &&
    s0.cameraDistance >= 13 && s0.cameraDistance <= 15 && s0.diskRotation > 0,
    JSON.stringify({ bg: s0.backgroundStarCount, stars: s0.starStreamCount, dist: +s0.cameraDistance.toFixed(2), rot: +s0.diskRotation.toFixed(3) }));

  // P2 状态:两帧 800ms 间隔采样,diskRotation 差 >= 0.1 rad
  await page.waitForTimeout(800);
  const s1 = await st();
  const dRot = s1.diskRotation - s0.diskRotation;
  ck('P2.state(dRot>=0.1)', dRot >= 0.1, `dRot=${dRot.toFixed(3)}rad/0.8s (${(dRot / 0.8).toFixed(2)}rad/s)`);

  const bufInitial = await page.screenshot();
  const bufA = await page.screenshot();
  await page.waitForTimeout(700);
  const bufB = await page.screenshot();

  // P4:滚轮向内缩放(trusted wheel @ 画布中心),平滑插值 1.2s 后断言
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1200);
  const s2 = await st();
  ck('P4.state(dist<10,>=5)', s2.cameraDistance < 10 && s2.cameraDistance >= 5, `dist=${s2.cameraDistance.toFixed(2)}`);
  const bufZoom = await page.screenshot();
  const bufZA = await page.screenshot();
  await page.waitForTimeout(700);
  const bufZB = await page.screenshot();

  // P6:reset 按钮
  await page.click('[data-ui="reset"]');
  await page.waitForTimeout(400);
  const s3 = await st();
  ck('P6.state', s3.cameraDistance >= 13.5 && s3.cameraDistance <= 14.5 && s3.diskRotation < 0.3 &&
    s3.accretionPhase < 0.1 && s3.starStreamCount >= 200,
    `dist=${s3.cameraDistance.toFixed(2)} rot=${s3.diskRotation.toFixed(3)} phase=${s3.accretionPhase.toFixed(3)} stars=${s3.starStreamCount}`);
  const bufReset = await page.screenshot();

  fs.writeFileSync(path.join(OUT, 'p1-initial.png'), bufInitial);
  fs.writeFileSync(path.join(OUT, 'p4-zoom.png'), bufZoom);
  fs.writeFileSync(path.join(OUT, 'p6-reset.png'), bufReset);

  // ③ 像素证据:截图 base64 传入页面,2D canvas 解码后统一分析
  const b64 = (b) => b.toString('base64');
  const M = await page.evaluate(async (S) => {
    const load = async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, cv.width, cv.height);
    };
    const ids = {};
    for (const k of Object.keys(S)) ids[k] = await load(S[k]);
    const W = ids.initial.width, H = ids.initial.height, cx = W / 2, cy = H / 2;
    const minD = Math.min(W, H);
    const lum = (id, x, y) => { const i = (y * id.width + x) * 4; return Math.max(id.data[i], id.data[i + 1], id.data[i + 2]); };
    const nonBlack = (id, x0, y0, x1, y1, thr) => {
      let n = 0, tot = 0;
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++)
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) { tot++; if (lum(id, x, y) > thr) n++; }
      return tot ? n / tot : 0;
    };
    // 暗核半径:自中心沿 ±x 找第一个持续亮像素(亮度>25,连续3px)
    const coreRadius = (id) => {
      let sum = 0, cnt = 0;
      for (const dx of [1, -1]) {
        let run = 0;
        for (let d = 2; d < 300; d++) {
          const x = Math.round(cx + dx * d);
          if (x < 0 || x >= W) break;
          if (lum(id, x, Math.round(cy)) > 25) { run++; if (run >= 3) { sum += d - 2; cnt++; break; } } else run = 0;
        }
      }
      return cnt ? sum / cnt : 0;
    };
    const outerRadius = (id) => {
      let last = 0;
      for (let d = 2; d < 640; d++) {
        const x = Math.round(cx + d);
        if (x >= W) break;
        if (lum(id, x, Math.round(cy)) > 14) last = d;
      }
      return last;
    };
    // P3 扇区采样(口径同 spec amendments:内带 0.06-0.14·minD,外带 0.18-0.30·minD,±6%·minD 高度带)
    const bands = (id) => {
      const band = Math.round(0.06 * minD);
      const rIn1 = 0.14 * minD, rOut0 = 0.18 * minD, rOut1 = 0.30 * minD;
      const acc = { inL: [0, 0, 0, 0], inR: [0, 0, 0, 0], outL: [0, 0, 0, 0], outR: [0, 0, 0, 0] };
      for (let y = Math.round(cy) - band; y <= Math.round(cy) + band; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.round(cx - rOut1); x <= Math.round(cx + rOut1); x++) {
          if (x < 0 || x >= W) continue;
          const dx = x - cx; const r = Math.hypot(dx, y - cy);
          if (r < 0.06 * minD) continue;
          let key = null;
          if (r <= rIn1) key = dx < 0 ? 'inL' : 'inR';
          else if (r >= rOut0 && r <= rOut1) key = dx < 0 ? 'outL' : 'outR';
          if (!key) continue;
          const i = (y * W + x) * 4; const a = acc[key];
          a[0] += id.data[i]; a[1] += id.data[i + 1]; a[2] += id.data[i + 2]; a[3]++;
        }
      }
      const avg = (a) => a[3] ? { R: a[0] / a[3], B: a[2] / a[3], lum: (a[0] + a[1] + a[2]) / (3 * a[3]), n: a[3] } : null;
      return { innerL: avg(acc.inL), innerR: avg(acc.inR), outerL: avg(acc.outL), outerR: avg(acc.outR) };
    };
    const annulusDiff = (idA, idB, r0, r1) => {
      let n = 0, tot = 0;
      for (let y = Math.max(0, Math.round(cy - r1)); y < Math.min(H, Math.round(cy + r1)); y++) {
        for (let x = Math.max(0, Math.round(cx - r1)); x < Math.min(W, Math.round(cx + r1)); x++) {
          const r = Math.hypot(x - cx, y - cy);
          if (r < r0 || r > r1) continue;
          tot++;
          const i = (y * W + x) * 4;
          const d = Math.max(Math.abs(idA.data[i] - idB.data[i]), Math.abs(idA.data[i + 1] - idB.data[i + 1]), Math.abs(idA.data[i + 2] - idB.data[i + 2]));
          if (d > 12) n++;
        }
      }
      return { changed: n, total: tot };
    };
    return {
      W, H, minD,
      centerThird: nonBlack(ids.initial, W / 3, H / 3, (2 * W) / 3, (2 * H) / 3, 16),
      corners: {
        tl: nonBlack(ids.initial, 0, 0, 0.2 * W, 0.2 * H, 12),
        tr: nonBlack(ids.initial, 0.8 * W, 0, W, 0.2 * H, 12),
        bl: nonBlack(ids.initial, 0, 0.8 * H, 0.2 * W, H, 12),
        br: nonBlack(ids.initial, 0.8 * W, 0.8 * H, W, H, 12),
      },
      coreR0: coreRadius(ids.initial),
      outerR0: outerRadius(ids.initial),
      bands0: bands(ids.initial),
      diffDisk: annulusDiff(ids.a, ids.b, 0.13 * minD, 0.42 * minD),
      diffMid: annulusDiff(ids.zoomA, ids.zoomB, 0.15 * minD, 0.45 * minD),
      coreR1: coreRadius(ids.zoom),
      outerR1: outerRadius(ids.zoom),
      resetNonBlack: nonBlack(ids.reset, 0, 0, W, H, 16),
      coreRReset: coreRadius(ids.reset),
    };
  }, {
    initial: b64(bufInitial), a: b64(bufA), b: b64(bufB),
    zoom: b64(bufZoom), zoomA: b64(bufZA), zoomB: b64(bufZB),
    reset: b64(bufReset),
  });
  console.log('[metrics] ' + JSON.stringify(M));

  // --- 逐 probe 判定 ---
  ck('P1.centerThird>=5%', M.centerThird >= 0.05, (M.centerThird * 100).toFixed(2) + '%');
  const minCorner = Math.min(M.corners.tl, M.corners.tr, M.corners.bl, M.corners.br);
  ck('P1.corners>=1%', minCorner >= 0.01, `min=${(minCorner * 100).toFixed(2)}% ${JSON.stringify(M.corners)}`);
  ck('P1.corePresent', M.coreR0 > 25 && M.coreR0 < 85, `coreR=${M.coreR0.toFixed(1)}px (dark core surrounded by bright ring)`);
  ck('P2.motion(disk)', M.diffDisk.changed >= 200, `changed=${M.diffDisk.changed}/${M.diffDisk.total}px`);
  const sides = ['L', 'R'];
  let best = null;
  for (const s of sides) {
    const inn = M.bands0['inner' + s], out = M.bands0['outer' + s];
    if (!inn || !out || !inn.n || !out.n) continue;
    const rb = (out.R - out.B) - (inn.R - inn.B);
    if (!best || rb > best.rb) best = { s, rb, inn, out };
  }
  if (best) {
    ck('P3.rbdiff>=18', best.rb >= 18,
      `side=${best.s} outerRB-innerRB=${best.rb.toFixed(1)} (in R-B=${(best.inn.R - best.inn.B).toFixed(1)}, out R-B=${(best.out.R - best.out.B).toFixed(1)})`);
    ck('P3.innerBright>=1.5x', best.inn.lum >= 1.5 * best.out.lum,
      `in=${best.inn.lum.toFixed(1)} out=${best.out.lum.toFixed(1)} x=${(best.inn.lum / Math.max(1e-6, best.out.lum)).toFixed(2)}`);
  } else {
    ck('P3.sampled', false, 'no band samples');
  }
  const zoomRatio = M.coreR0 > 1 ? M.coreR1 / M.coreR0 : 0;
  const outerRatio = M.outerR0 > 1 ? M.outerR1 / M.outerR0 : 0;
  ck('P4.regionChange', zoomRatio >= 1.25 || outerRatio >= 1.2, `core x${zoomRatio.toFixed(2)} (${M.coreR0.toFixed(0)}->${M.coreR1.toFixed(0)}px) outer x${outerRatio.toFixed(2)}`);
  ck('P5.starCount>=200', s2.starStreamCount >= 200, `stars=${s2.starStreamCount}`);
  ck('P5.motion(mid-ring)', M.diffMid.changed >= 200, `changed=${M.diffMid.changed}/${M.diffMid.total}px`);
  ck('P6.nonBlank>=3%', M.resetNonBlack >= 0.03, (M.resetNonBlack * 100).toFixed(2) + '%');
  ck('P6.compositionBack', M.coreRReset >= 0.85 * M.coreR0 && M.coreRReset <= 1.2 * M.coreR0 + 2, `core ${M.coreR0.toFixed(0)}->${M.coreRReset.toFixed(0)}px`);
  ck('noErrors', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} page=${pageErrors.length}${(consoleErrors.length || pageErrors.length) ? ' :: ' + [...consoleErrors, ...pageErrors].join(' | ') : ''}`);
} catch (e) {
  console.error('[selfcheck] error: ' + (e?.message || e));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
if (checks.some((x) => !x.ok)) exitCode = 1;
console.log('[selfcheck] ' + JSON.stringify({ url, exitCode, passed: checks.filter((x) => x.ok).length, total: checks.length }));
process.exit(exitCode);
