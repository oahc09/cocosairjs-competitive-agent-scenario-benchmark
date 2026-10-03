#!/usr/bin/env node
// ============================================================================
// soak-verify.mjs — E10 稳定性抽检(brief §6:连续运行无异常、帧率达标、销毁后不降)
// 35s 连续运行采样 fps / console 错误;销毁 A 后再跑 10s 观察 B 与帧率。
// ============================================================================

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const PORT = process.env.PORT || '7107';
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;

const exe = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((c) => fs.existsSync(c));
if (!exe) {
  console.error('SOAK_FAIL: no chrome executable');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, executablePath: exe, args: [] });
const fails = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });

  const samples = [];
  for (let i = 0; i < 7; i++) {
    await page.waitForTimeout(5000);
    samples.push(await page.evaluate(() => {
      const s = window.__bench.getState();
      return { fps: s.fps, n: s.instanceCount, at: s.instances.A?.time, bt: s.instances.B?.time, mem: performance.memory ? performance.memory.usedJSHeapSize : 0 };
    }));
  }
  console.log('[soak] 35s samples:', JSON.stringify(samples.map((s) => ({ fps: s.fps, n: s.n }))));
  const minFps = Math.min(...samples.map((s) => s.fps));
  if (minFps < 30) fails.push(`fps below 30 during run: ${minFps}`);
  if (samples.some((s) => s.n !== 2)) fails.push('instanceCount drifted');

  // 内存趋势(JS heap,Chrome only):末段均值不应显著高于首段(>25% 视为增长)
  if (samples[0].mem > 0 && samples[6].mem > 0) {
    const growth = (samples[6].mem - samples[0].mem) / samples[0].mem;
    console.log(`[soak] JS heap ${samples[0].mem} -> ${samples[6].mem} (${(growth * 100).toFixed(1)}%)`);
    if (growth > 0.25) fails.push(`heap growth ${(growth * 100).toFixed(1)}%`);
  }

  // 销毁 A 后 10s:B 存活、动画推进、fps 不降
  await page.click('[data-bench="destroy-a"]');
  await page.waitForTimeout(5000);
  const afterDestroy = [];
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(5000);
    afterDestroy.push(await page.evaluate(() => {
      const s = window.__bench.getState();
      return { fps: s.fps, n: s.instanceCount, bt: s.instances.B?.time, clip: s.instances.B?.clip };
    }));
  }
  console.log('[soak] post-destroy:', JSON.stringify(afterDestroy));
  if (afterDestroy.some((s) => s.n !== 1)) fails.push('post-destroy instanceCount wrong');
  if (afterDestroy.some((s) => s.clip !== 'idle' || s.bt <= 0)) fails.push('B not animating post-destroy');
  const minFpsAfter = Math.min(...afterDestroy.map((s) => s.fps));
  console.log(`[soak] fps: pre-destroy min=${minFps}, post-destroy min=${minFpsAfter}`);
  if (minFpsAfter < minFps - 5) fails.push(`fps dropped after destroy: ${minFps} -> ${minFpsAfter}`);

  if (errors.length > 0) fails.push(`console errors: ${JSON.stringify(errors)}`);

  if (fails.length > 0) {
    console.error('SOAK_FAIL:', fails.join(' | '));
    process.exitCode = 1;
  } else {
    console.log('SOAK_OK');
  }
} finally {
  await browser.close();
}
