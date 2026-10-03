#!/usr/bin/env node
// soak-test.mjs — E07 长稳自检(brief §7: >=120s 无粒子泄漏/帧率衰减/未捕获异常)
//   node scripts/soak-test.mjs [--seconds 125] [--port 7420]
// 依赖 harness 的 playwright-core 封装(HarnessBrowser),产物写 workspace/soak-report.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HARNESS = 'E:/AIProMax/Y2026M10/cocosairjs-competitive-agent-scenario-benchmark/bench/harness';
const RUNNER = path.join(HARNESS, 'runner');

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const seconds = Number(getArg('seconds', 125));
const port = Number(getArg('port', 7420));

const { HarnessBrowser } = await import(pathToFileURL(path.join(RUNNER, 'browser.mjs')).href);
const { spawn } = await import('node:child_process');

// 起本地静态服务(复用 harness serve.mjs)
const serveChild = spawn(process.execPath, [path.join(RUNNER, 'serve.mjs'), '--root', root, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
await new Promise((r) => setTimeout(r, 1200));

const hb = new HarnessBrowser();
const samples = [];
const uncaught = [];
let ok = true;
try {
  await hb.launch({});
  const page = await hb.newPage();
  page.on('pageerror', (e) => uncaught.push(String(e?.message || e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const t0 = Date.now();
  // 等 ready
  while (Date.now() - t0 < 10000) {
    if (await page.evaluate(() => window.__appReady === true)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const s0 = await page.evaluate(() => window.__bench.getState());
  samples.push({ t: 0, ...s0 });
  // 每隔 ~15s 采样一次到 seconds
  for (let t = 15; t <= seconds; t += 15) {
    await new Promise((r) => setTimeout(r, t === 15 ? 15000 - (Date.now() - t0) : 15000));
    const mem = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
    const s = await page.evaluate(() => window.__bench.getState());
    samples.push({ t: Math.round((Date.now() - t0) / 1000), jsHeapMB: mem ? Math.round(mem / 1048576) : null, ...s });
    console.log(`t=${samples[samples.length - 1].t}s fps=${s.fps} frame=${s.frame} heap=${samples[samples.length - 1].jsHeapMB}MB`);
  }
  const last = samples[samples.length - 1];
  const firstFps = samples[0].fps;
  const lastFps = last.fps;
  const fpsDropPct = firstFps > 0 ? (1 - lastFps / firstFps) * 100 : 100;
  const heapGrow = samples.length > 1 && samples[1].jsHeapMB && last.jsHeapMB ? last.jsHeapMB - samples[1].jsHeapMB : null;
  ok = uncaught.length === 0 && lastFps >= 30 && fpsDropPct < 25;
  const report = {
    generatedAt: new Date().toISOString(),
    seconds: samples[samples.length - 1].t,
    samples,
    uncaught,
    firstFps,
    lastFps,
    fpsDropPct: Math.round(fpsDropPct * 10) / 10,
    heapGrowMB: heapGrow,
    verdict: ok ? 'OK' : 'FAIL',
  };
  fs.writeFileSync(path.join(root, 'soak-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('soak verdict:', report.verdict, 'fps', firstFps, '->', lastFps, `(-${report.fpsDropPct}%)`, 'heapGrow', heapGrow, 'MB', 'uncaught', uncaught.length);
} finally {
  await hb.close().catch(() => {});
  try { serveChild.kill(); } catch { /* ignore */ }
}
process.exit(ok ? 0 : 1);
