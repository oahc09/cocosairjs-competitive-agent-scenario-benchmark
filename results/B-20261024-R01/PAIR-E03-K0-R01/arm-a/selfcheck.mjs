// ============================================================================
// selfcheck.mjs — Agent 自检脚本(不属于模板,位于 Arm 根目录,不修改任何冻结文件)
// ----------------------------------------------------------------------------
// 用途:一次浏览器会话内按 spec.json 的 P1–P9 顺序执行真实鼠标点击/等待,
//       采集 __bench.getState() 采样 + 截图,并对截图做像素统计(lit / motion /
//       regionChange)作为视觉证据自查。
// 预算合规:创建会话前先执行 workspace/scripts/count.mjs browser(机器计数),
//           与 verify-browser.mjs 同一计数口径;会话一律 headless Chrome 1280×720。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, 'workspace');
const OUT = path.join(__dirname, 'selfcheck-out');
fs.mkdirSync(OUT, { recursive: true });

const URL_ = process.env.CHECK_URL || 'http://127.0.0.1:7104/';
const VIEWPORT = { width: 1280, height: 720 };

// ---------- ① browser 机器计数(先计后会话) ----------
const counted = spawnSync(process.execPath, [path.join(WS, 'scripts', 'count.mjs'), 'browser'], { encoding: 'utf8' });
if (counted.status !== 0) {
  console.error('browser 计数失败:', counted.stdout, counted.stderr);
  process.exit(1);
}
process.stdout.write(counted.stdout);

// ---------- ② PNG 解码(仅支持 8-bit RGB/RGBA,无 interlace) ----------
function decodePNG(buf) {
  let pos = 8; // signature
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported png: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

const lum = (img, x, y) => {
  const i = (y * img.w + x) * img.channels;
  const d = img.data;
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
};

function litRatio(img, rect, thresh = 26) {
  const { x0, y0, x1, y1 } = rect;
  let lit = 0, total = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      total++;
      if (lum(img, x, y) > thresh) lit++;
    }
  }
  return total ? lit / total : 0;
}

function regionDiffRatio(a, b, rect, thresh = 10) {
  const { x0, y0, x1, y1 } = rect;
  let changed = 0, total = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(a.w, x1); x++) {
      total++;
      const i = (y * a.w + x) * a.channels;
      const dl = Math.abs(lum(a, x, y) - lum(b, x, y));
      const dc = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (dl > thresh || dc > thresh * 2) changed++;
    }
  }
  return total ? changed / total : 0;
}

// ---------- ③ 浏览器会话 ----------
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright-core');

function candidates() {
  const out = [];
  for (const k of ['BENCH_BROWSER', 'CHROME_PATH', 'CHROME_BIN']) if (process.env[k]) out.push(process.env[k]);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  out.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) out.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return out.filter(Boolean);
}

async function launch() {
  const errs = [];
  for (const exe of [null, ...candidates()]) {
    if (exe !== null && !fs.existsSync(exe)) continue;
    try {
      return await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, viewport: VIEWPORT, timeout: 30000 });
    } catch (e) {
      errs.push(`${exe || 'default'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('no browser: ' + errs.join(' | '));
}

const result = { probes: {}, consoleErrors: [], pageErrors: [], notes: [], screenshots: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const p = path.join(OUT, name + '.png');
  await page.screenshot({ path: p });
  result.screenshots.push(path.relative(__dirname, p).replaceAll('\\', '/'));
  return decodePNG(fs.readFileSync(p));
}

const browser = await launch();
const page = await browser.newPage();
page.setDefaultTimeout(30000);
page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => result.pageErrors.push(String(e.message || e).slice(0, 300)));

const t0 = Date.now();
await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
result.readyMs = Date.now() - t0;

const getState = () => page.evaluate(() => window.__bench.getState());
const clickState = async (expr) => {
  const pt = await page.evaluate((sel) => {
    const st = window.__bench.getState();
    return sel.split('.').reduce((a, k) => (a == null ? a : a[k]), st);
  }, expr);
  await page.mouse.click(pt.screenX, pt.screenY);
  return pt;
};
const clickUi = async (locator) => {
  const sel = `#speed-panel [data-ui="${locator}"], [data-ui="${locator}"]`;
  const el = page.locator(sel).first();
  await el.click();
};

// 视觉度量:全画幅亮像素比、区域变化比
const litFull = (img) => litRatio(img, { x0: 0, y0: 0, x1: img.w, y1: img.h });
const fullRect = (img) => ({ x0: 0, y0: 0, x1: img.w, y1: img.h });

// ---- P1:初始状态 + 分层公转证据 + 非空画面 ----
{
  const s1 = await getState();
  const shotA = await shot(page, 'P1-before');
  await sleep(2000);
  const s2 = await getState();
  const shotB = await shot(page, 'P1-after');
  const dInner = s2.planets[0].orbitAngle - s1.planets[0].orbitAngle;
  const dOuter = s2.planets[7].orbitAngle - s1.planets[7].orbitAngle;
  const motion = regionDiffRatio(shotA, shotB, fullRect(shotA));
  result.probes.P1 = {
    pass: s1.planetCount === 8 && s1.moonCount >= 2 && s1.asteroidCount >= 500 && s1.ringedPlanetCount >= 1
      && s1.timeScale === 1 && s1.selectedPlanet === null && dInner > 4 * dOuter && litFull(shotA) >= 0.03,
    planetCount: s1.planetCount, moonCount: s1.moonCount, asteroidCount: s1.asteroidCount,
    ringedPlanetCount: s1.ringedPlanetCount, timeScale: s1.timeScale, selectedPlanet: s1.selectedPlanet,
    dInner: +dInner.toFixed(4), dOuter: +dOuter.toFixed(4), lit: +litFull(shotA).toFixed(4),
    motionRatio: +motion.toFixed(4), fps: s1.fps, pickTargets: s1.pickTargets,
    planets: s1.planets.map((p) => ({ n: p.name, a: +p.orbitAngle.toFixed(3) })),
  };
}

// ---- P2:点击 earth 投影 ----
let baseShot = await shot(page, 'P2-before');
{
  const pt = await clickState('pickTargets.2');
  await sleep(600);
  const s = await getState();
  const after = await shot(page, 'P2-after');
  const r = pt.screenRadius;
  const box = { x0: Math.round(pt.screenX - r), y0: Math.round(pt.screenY - r), x1: Math.round(pt.screenX + r), y1: Math.round(pt.screenY + r) };
  result.probes.P2 = {
    pass: s.selectedPlanet === 'earth' && r >= 8 && regionDiffRatio(baseShot, after, box) > 0.01,
    selected: s.selectedPlanet, screenRadius: r, regionChange: +regionDiffRatio(baseShot, after, box).toFixed(4),
    infoCard: s.infoCard,
  };
}

// ---- P3:信息卡 ----
{
  await sleep(800);
  const s = await getState();
  const img = await shot(page, 'P3-card');
  const card = await page.evaluate(() => {
    const el = document.querySelector('[data-ui="info-card"]');
    const r = el.getBoundingClientRect();
    return {
      visible: !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none',
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      ddCount: el.querySelectorAll('dd').length,
    };
  });
  const box = { x0: Math.round(card.rect.x), y0: Math.round(card.rect.y), x1: Math.round(card.rect.x + card.rect.w), y1: Math.round(card.rect.y + card.rect.h) };
  result.probes.P3 = {
    pass: s.infoCard.visible === true && s.infoCard.name === 'earth' && s.infoCard.fieldCount >= 3
      && card.visible && card.text.toLowerCase().includes('earth') && card.ddCount >= 3 && litRatio(img, box, 60) > 0.02,
    infoCard: s.infoCard, domText: card.text, ddCount: card.ddCount, cardLit: +litRatio(img, box, 60).toFixed(4),
  };
}

// ---- P4:8x 档位 ----
{
  await clickUi('speed-8x');
  await sleep(500);
  const s = await getState();
  const img = await shot(page, 'P4-8x');
  const dom = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#speed-panel button'));
    return {
      texts: btns.map((b) => b.textContent.trim()),
      active: btns.filter((b) => b.classList.contains('active')).map((b) => b.textContent.trim()),
      ariaPressed: btns.map((b) => b.getAttribute('aria-pressed')),
    };
  });
  result.probes.P4 = {
    pass: s.timeScale === 8 && dom.texts.length === 5 && dom.active.length === 1 && litFull(img) >= 0.03,
    timeScale: s.timeScale, domText: dom, lit: +litFull(img).toFixed(4),
  };
}

// ---- P5:8x 运动量 ----
{
  await sleep(300);
  const s1 = await getState();
  const a = await shot(page, 'P5-a');
  await sleep(1500);
  const s2 = await getState();
  const b = await shot(page, 'P5-b');
  const dSim = s2.simulationTime - s1.simulationTime;
  const dAng = s2.planets[0].orbitAngle - s1.planets[0].orbitAngle;
  const motion = regionDiffRatio(a, b, fullRect(a));
  result.probes.P5 = {
    pass: dSim >= 6 && dAng >= 0.05 && motion >= 0.005,
    dSim: +dSim.toFixed(3), dAng: +dAng.toFixed(4), motionRatio: +motion.toFixed(4),
  };
}

// ---- P6:reset ----
let afterResetShot = null;
{
  const before = await getState();
  await clickUi('reset');
  await sleep(600);
  const s = await getState();
  afterResetShot = await shot(page, 'P6-reset');
  const nav = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  result.probes.P6 = {
    pass: s.epoch >= 1 && s.timeScale === 1 && s.epoch === before.epoch + 1 && litFull(afterResetShot) >= 0.03,
    epoch: s.epoch, timeScale: s.timeScale, navEntries: nav, lit: +litFull(afterResetShot).toFixed(4),
  };
}

// ---- P7:reset 后归位 + 仍在运动 ----
{
  await sleep(300);
  const s = await getState();
  await sleep(900);
  const s2 = await getState();
  const motion = regionDiffRatio(afterResetShot, await shot(page, 'P7-motion'), fullRect(afterResetShot));
  result.probes.P7 = {
    pass: s2.simulationTime < 2.5 && s2.selectedPlanet === null && s2.infoCard.visible === false
      && s2.planets[0].orbitAngle >= -0.08 && s2.planets[0].orbitAngle <= 0.08
      && s2.planets[7].orbitAngle >= 5.43 && s2.planets[7].orbitAngle <= 5.56 && motion >= 0.002,
    simulationTime: +s2.simulationTime.toFixed(3), selected: s2.selectedPlanet, infoVisible: s2.infoCard.visible,
    a0: +s2.planets[0].orbitAngle.toFixed(4), a7: +s2.planets[7].orbitAngle.toFixed(4),
    motionRatio: +motion.toFixed(4), simTimeAt300: +s.simulationTime.toFixed(2),
  };
}

// ---- P8:0.5x ----
{
  await clickUi('speed-0.5x');
  await sleep(400);
  const s = await getState();
  const img = await shot(page, 'P8-half');
  const dom = await page.evaluate(() => Array.from(document.querySelectorAll('#speed-panel button')).map((b) => `${b.textContent.trim()}${b.classList.contains('active') ? '*' : ''}`));
  result.probes.P8 = { pass: s.timeScale === 0.5 && litFull(img) >= 0.03, timeScale: s.timeScale, domText: dom, lit: +litFull(img).toFixed(4) };
}

// ---- P9:空白点击 ----
{
  const st = await getState();
  const minDist = Math.min(...st.pickTargets.map((t) => Math.hypot(t.screenX - 0.08 * VIEWPORT.width, t.screenY - 0.08 * VIEWPORT.height)));
  const before = await shot(page, 'P9-before');
  await page.mouse.click(0.08 * VIEWPORT.width, 0.08 * VIEWPORT.height);
  await sleep(500);
  const s = await getState();
  const after = await shot(page, 'P9-after');
  const cardRect = await page.evaluate(() => {
    const el = document.querySelector('[data-ui="info-card"]');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: el.classList.contains('hidden') };
  });
  result.probes.P9 = {
    pass: s.selectedPlanet === null && s.infoCard.visible === false && cardRect.hidden && minDist >= 80,
    selected: s.selectedPlanet, infoCard: s.infoCard, cornerMinDist: +minDist.toFixed(1), cardRect,
    cornerRegionChange: +regionDiffRatio(before, after, { x0: 60, y0: 20, x1: 150, y1: 100 }).toFixed(4),
  };
}

const final = await getState();
result.finalFps = final.fps;
result.finalState = { ...final, pickTargets: final.pickTargets, planets: final.planets };
result.consoleErrors = result.consoleErrors;
result.pass = Object.values(result.probes).every((p) => p.pass);
console.log(JSON.stringify(result, null, 2));
await browser.close();
