// reset-loop.mjs — NC05 alignment: repeated reset stability (memory / errors / recovery)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const exe = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((c) => fs.existsSync(c));
if (!exe) { console.error('no chrome'); process.exit(1); }

const browser = await chromium.launch({ headless: true, executablePath: exe, args: [] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${process.env.PORT || '7103'}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
console.log('[loop] ready');

const mem = () => page.evaluate(() => ({
  js: performance.memory ? performance.memory.usedJSHeapSize : 0,
  textures: window.__threeInfo ? null : null,
}));
const N = Number(process.env.RESET_N || '5');
for (let i = 1; i <= N; i++) {
  await page.click('button[data-ui="reset"]');
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => window.__bench.getState());
  const m = await mem();
  console.log(`[loop] reset#${i}: epoch=${s.epoch} assetLoaded=${s.assetLoaded} assetRequests=${s.assetRequests} toneMix=${s.toneMix} az=${s.cameraAzimuth.toFixed(1)} fps=${s.fps} jsHeap=${(m.js / 1048576).toFixed(1)}MB`);
  if (!(s.epoch === i && s.assetLoaded && s.toneMix < 0.05)) { console.log('LOOP_FAIL'); process.exit(1); }
}
await page.waitForTimeout(1500);
const s = await page.evaluate(() => window.__bench.getState());
const m = await mem();
console.log(`[loop] final: fps=${s.fps} jsHeap=${(m.js / 1048576).toFixed(1)}MB errors=${errors.length}`);
await browser.close();
if (errors.length > 0) { console.log('LOOP_FAIL errors=' + JSON.stringify(errors)); process.exit(1); }
console.log('LOOP_OK');
process.exit(0);
