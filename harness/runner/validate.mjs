#!/usr/bin/env node
// validate.mjs — the automated validation pipeline (MASTER-CONTEXT §12.2):
//   workspace snapshot -> npm run build -> static serve -> chromium (headless,
//   1280x720, fresh profile) -> __appReady wait -> console collection ->
//   probes -> key screenshots (>=5) -> optional video -> downloads -> fps ->
//   archive -> report.json (single source of truth for scoring).
//
//   node runner/validate.mjs --workspace <dir> --spec <spec.json> --out <dir>
//                           [--run-id <id>] [--video] [--port <n>]
//                           [--pair <pairId>] [--engine <three|air>]
//
// RED LINES honored here:
//   * never requires/imports code from the workspace under test (only spawns
//     `npm run build` as a subprocess and serves files over HTTP);
//   * every child process / browser is cleaned up in finally blocks;
//   * report.json is the sole judging fact source; JSON is 2-space indented.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  isoNow, sha256, sha256File, writeJson, readJson, walkFiles, getFreePort,
  poll, sleep, parseArgv, round2,
} from './util.mjs';
import { HarnessBrowser } from './browser.mjs';
import { runProbes, dryRunSpec, litRatio, decodePng } from './probe-executor.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_DIR = path.join(HARNESS_DIR, 'runner');
const BUILD_TIMEOUT_MS = 180000;
const READY_TIMEOUT_MS = 10000;

const argv = parseArgv(process.argv.slice(2));
const workspace = path.resolve(argv.workspace);
const specPath = path.resolve(argv.spec);
const outDir = path.resolve(argv.out || './validate-out');
const runId = argv['run-id'] || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const wantVideo = !!argv.video;
const pairId = argv.pair || null;
const engine = argv.engine || null;

if (!argv.workspace || !argv.spec) {
  process.stderr.write('usage: node runner/validate.mjs --workspace <dir> --spec <spec.json> --out <dir> [--run-id id] [--video] [--port n] [--pair id] [--engine three|air]\n');
  process.exit(2);
}

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const tRunStart = Date.now();

// ---------------------------------------------------------------- 0. spec
let spec = null;
let specError = null;
try {
  spec = readJson(specPath);
  const dry = await dryRunSpec(spec);
  if (!dry.allOk) specError = 'spec dry-run failed: ' + JSON.stringify(dry.probes.filter((p) => !p.ok));
} catch (e) {
  specError = e.message;
}
const specSha = sha256File(specPath);
const minFps = Number(spec?.scaleAndPerformance?.minFps ?? 30);

// ---------------------------------------------------------------- out dirs
const shotDir = path.join(outDir, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'downloads'), { recursive: true });

const report = {
  runId,
  generatedAt: isoNow(),
  harnessVersion: '1.0.0',
  workspace,
  spec: spec ? { path: specPath, briefId: spec.briefId ?? null, briefVersion: spec.briefVersion ?? null, sha256: specSha } : { path: specPath, error: specError },
  pairId,
  engine,
  build: { ok: false, exitCode: null, durationMs: null, attempts: 1, logFile: 'build.log' },
  serve: { port: null, root: workspace },
  ready: { appReady: false, benchReady: false, durationMs: null },
  console: { errors: 0, warnings: 0, uncaughtErrors: 0 },
  consoleErrors: 0,
  uncaught: [],
  probes: [],
  probeResults: 'probe-results.json',
  probePassRate: 0,
  fps: null,
  perf: null,
  downloads: [],
  networkEvents: { count: 0, totalBytes: 0 },
  screenshots: [],
  video: null,
  artifacts: [],
  classification: 'INFRA_FAILURE',
  failureCategory: 'INFRA_FAILURE',
  verdict: 'FAIL',
  error: null,
  scoreInputs: {
    s1: { buildPass: false, readyNoError: false, firstShotNonBlank: false, firstShotLitRatio: null },
    s2: { passedWeight: 0, totalWeight: 0, probePassRate: 0, behaviorItemsCount: Array.isArray(spec?.scoring?.behaviorItems) ? spec.scoring.behaviorItems.length : 0 },
    s3: { lifecycleProbePassed: false, lifecycleProbeId: null, fpsMet: false, minFps },
  },
};

/** Extra facts gathered along the way, merged into the report at the end. */
const extra = { consoleCollector: null, keyShots: [] };

// ---------------------------------------------------------------- helpers
function shotPath(name) { return path.join(shotDir, name); }

async function takeShot(page, name) {
  const buf = await page.screenshot({ type: 'png' });
  fs.writeFileSync(shotPath(name), buf);
  report.screenshots.push(name);
  return buf;
}

async function snapshotWorkspace() {
  const files = await walkFiles(workspace, { skipDirs: ['node_modules', '.git', 'dist', '.cache'] });
  const list = [];
  let totalBytes = 0;
  for (const f of files.slice(0, 5000)) {
    const st = fs.statSync(f);
    totalBytes += st.size;
    list.push({ path: path.relative(workspace, f).replaceAll('\\', '/'), bytes: st.size, sha256: sha256File(f) });
  }
  const distDir = path.join(workspace, 'dist');
  const distFiles = fs.existsSync(distDir) ? (await walkFiles(distDir)).slice(0, 300) : [];
  writeJson(path.join(outDir, 'source-sha.json'), {
    workspace,
    generatedAt: isoNow(),
    fileCount: list.length,
    totalBytes,
    skippedDirs: ['node_modules', '.git', 'dist', '.cache'],
    files: list,
    dist: distFiles.map((f) => ({ path: path.relative(workspace, f).replaceAll('\\', '/'), bytes: fs.statSync(f).size })),
  });
  report.artifacts.push('source-sha.json');
}

/** ② run `npm run build` in the workspace as a subprocess (never in-process). */
function runBuild() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cmd = process.platform === 'win32' ? 'npm run build' : 'npm';
    const args = process.platform === 'win32' ? [] : ['run', 'build'];
    const child = spawn(cmd, args, {
      cwd: workspace,
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_progress: 'false', npm_config_color: 'false' },
      windowsHide: true,
    });
    let out = [];
    const cap = (b) => { out.push(b.toString()); if (out.join('').length > 4_000_000) out = [out.join('').slice(-2_000_000)]; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, BUILD_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, durationMs: Date.now() - t0, log: `spawn error: ${e.message}\n` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const logText = `$ npm run build\n${out.join('')}\n[exit code ${timedOut ? 'timeout-killed' : code}] duration ${Date.now() - t0}ms\n`;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'build.log'), logText, 'utf8');
      report.artifacts.push('build.log');
      resolve({ ok: code === 0 && !timedOut, exitCode: code, durationMs: Date.now() - t0, timedOut, log: logText });
    });
  });
}

/** ③ spawn serve.mjs and wait until it answers. */
async function startServe(port) {
  const logFile = path.join(outDir, 'serve-log.json');
  const child = spawn(process.execPath, [path.join(RUNNER_DIR, 'serve.mjs'), '--root', workspace, '--port', String(port), '--log', logFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { process.stderr.write('[serve] ' + d.toString()); });
  let info = null;
  await poll(
    async () => {
      try { info = JSON.parse(stdout.trim().split('\n').pop()); return info; } catch { return null; }
    },
    { intervalMs: 100, timeoutMs: 8000, label: 'serve startup line' }
  );
  const actualPort = info?.port ?? port;
  await poll(
    () => new Promise((res) => {
      const req = http.get(`http://127.0.0.1:${actualPort}/`, (r) => { r.resume(); res(r.statusCode ? true : false); });
      req.on('error', () => res(false));
      req.setTimeout(1500, () => { req.destroy(); res(false); });
    }),
    { intervalMs: 150, timeoutMs: 10000, label: 'serve http ready' }
  );
  return { child, port: actualPort, logFile };
}

async function fetchServeLog(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/__log`, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ requests: [] }); }
      });
    });
    req.on('error', () => resolve({ requests: [] }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ requests: [] }); });
  });
}

function stopServe(serve) {
  if (!serve?.child || serve.child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${serve.port}/__shutdown`, { method: 'POST' }, (r) => { r.resume(); });
    req.on('error', () => { /* server may already be gone */ });
    req.end();
    const done = () => resolve();
    serve.child.once('exit', done);
    setTimeout(() => {
      try { serve.child.kill(); } catch { /* ignore */ }
      setTimeout(done, 300);
    }, 1500).unref();
  });
}

function classify() {
  if (specError) return 'SPEC_INVALID';
  if (!report.build.ok) return 'BUILD';
  if (!report.ready.appReady || !report.ready.benchReady) return 'RUNTIME';
  if (report.console.uncaughtErrors > 0) return 'RUNTIME';
  if (browserLaunchFailed) return 'INFRA_FAILURE';
  // 探针是判定事实源:任何 FAIL/ERROR 都不得判 PASS(反作弊核心路径,NC01-05 依赖)
  const probes = report.probes || [];
  const failed = probes.filter(p => p.status === 'FAIL' || p.status === 'ERROR');
  if (failed.length > 0) return classifyProbeFailures(failed, probes);
  const minFps = Number(spec?.scaleAndPerformance?.minFps) || 0;
  if (minFps > 0 && typeof report.fps === 'number' && report.fps < minFps) return 'PERFORMANCE';
  return 'PASS';
}

function classifyProbeFailures(failed) {
  // 按探针证据映射失败分类枚举(自动初判,聚合阶段可由人工/审查细化)
  const has = (pred) => failed.some(pred);
  const pid = (x) => String(x.probeId || '');
  if (has(x => /reset|lifecycle|destroy|instance/i.test(pid(x)))) return 'LIFECYCLE_MISUSE';
  if (has(x => /asset|load|glb/i.test(pid(x)))) return 'ASSET_PIPELINE';
  if (has(x => x.status === 'ERROR')) return 'RUNTIME';
  if (has(x => /nonBlank/i.test(String(x.visualType || '')))) return 'RUNTIME';
  if (has(x => /click|drag|wheel|key|pick|interact|export|feed|scatter/i.test(pid(x)))) return 'INTERACTION';
  if (has(x => /fps|performance/i.test(pid(x)))) return 'PERFORMANCE';
  return 'STATE_MANAGEMENT';
}

let browserLaunchFailed = false;

// ---------------------------------------------------------------- pipeline
const serve = { child: null, port: null, logFile: null };
const hb = new HarnessBrowser();
let page = null;

try {
  // ① source snapshot
  log(`[1/14] snapshot workspace: ${workspace}`);
  await snapshotWorkspace();

  // ② build
  log('[2/14] npm run build ...');
  const build = await runBuild();
  report.build = { ...report.build, ...build, logFile: 'build.log' };
  log(`       build ok=${build.ok} exit=${build.exitCode} ${build.durationMs}ms`);
  if (!build.ok) throw Object.assign(new Error('build failed'), { soft: true });

  // ③ serve
  const port = Number(argv.port) || (await getFreePort());
  log(`[3/14] serve on 127.0.0.1:${port}`);
  const s = await startServe(port);
  serve.child = s.child;
  serve.port = s.port;
  serve.logFile = s.logFile;
  report.serve.port = s.port;

  // ④ browser
  log('[4/14] launch browser (headless, 1280x720, fresh profile)');
  try {
    await hb.launch(wantVideo ? { videoDir: path.join(outDir, '.video-tmp') } : {});
  } catch (e) {
    browserLaunchFailed = true;
    throw e;
  }
  page = await hb.newPage();

  // ⑥ console collection (attached before navigation)
  const collector = hb.collectConsole(page);
  extra.consoleCollector = collector;

  // ⑤ navigate + wait for readiness
  log('[5/14] navigate + wait __appReady (10s)');
  const navOk = await page
    .goto(`http://127.0.0.1:${serve.port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .then(() => true)
    .catch((e) => { report.error = `navigation failed: ${e.message}`; return false; });
  if (navOk) {
    const ready = await hb.waitForAppReady(page, READY_TIMEOUT_MS);
    report.ready = ready;
  }
  log(`       appReady=${report.ready.appReady} benchReady=${report.ready.benchReady}`);

  // ⑧ key screenshots — initial
  if (navOk) {
    await takeShot(page, 'initial.png').catch(() => {});
    // S1 sub-item: first-shot non-blank render
    const p = shotPath('initial.png');
    if (fs.existsSync(p)) {
      try {
        const img = decodePng(fs.readFileSync(p));
        const m = litRatio(img, { x: 0, y: 0, w: img.width, h: img.height }, 30);
        report.scoreInputs.s1.firstShotLitRatio = round2(m.ratio, 4);
        report.scoreInputs.s1.firstShotNonBlank = m.ratio >= 0.02;
      } catch { /* analysis failure leaves firstShotNonBlank false */ }
    }
  }

  // ⑦ probes
  log('[7/14] execute probes');
  let probeRun = { results: [], passed: 0, passedWeight: 0, totalWeight: 0 };
  if (report.ready.appReady && report.ready.benchReady) {
    let networkLogCache = await fetchServeLog(serve.port);
    const since = (tsIso) => (networkLogCache?.requests ?? []).filter((r) => r.ts >= tsIso);
    probeRun = await runProbes(spec, {
      page,
      viewport: { width: 1280, height: 720 },
      appReady: report.ready.appReady,
      shotDir,
      networkSince: since,
    });
    // refresh the network cache right after probes (serve log grows)
    networkLogCache = await fetchServeLog(serve.port);
    // mid-session key shot
    await takeShot(page, 'mid.png').catch(() => {});
  } else {
    log('       probes skipped: app not ready');
  }
  writeJson(path.join(outDir, 'probe-results.json'), {
    runId,
    generatedAt: isoNow(),
    results: probeRun.results,
  });
  report.artifacts.push('probe-results.json');
  report.probes = probeRun.results.map((r) => ({
    probeId: r.probeId,
    status: r.status,
    weight: r.weight,
    visualType: r.assertion?.visualType || r.visualType || null,
  }));
  report.probePassRate = probeRun.totalWeight > 0 ? round2(probeRun.passedWeight / probeRun.totalWeight, 4) : 0;
  report.scoreInputs.s2.passedWeight = probeRun.passedWeight;
  report.scoreInputs.s2.totalWeight = probeRun.totalWeight;
  report.scoreInputs.s2.probePassRate = report.probePassRate;

  // S3: lifecycle = a reset probe that passed
  const resetProbe = probeRun.results.find((r) => /reset/i.test(r.action?.raw || ''));
  if (resetProbe) {
    report.scoreInputs.s3.lifecycleProbeId = resetProbe.probeId;
    report.scoreInputs.s3.lifecycleProbePassed = resetProbe.status === 'PASS';
  }

  // ⑧ final key shot + guarantee >= 5 screenshots
  if (navOk) await takeShot(page, 'final.png').catch(() => {});
  let extraIdx = 0;
  while (report.screenshots.length < 5 && navOk && extraIdx < 6) {
    extraIdx++;
    await sleep(250);
    await takeShot(page, `extra-${extraIdx}.png`).catch(() => {});
  }

  // ⑪ fps sampling (rAF count over 3s)
  if (navOk && report.ready.appReady) {
    log('[11/14] fps sampling (3s rAF)');
    const fps = await hb.sampleFps(page, 3000).catch((e) => ({ fps: null, error: e.message }));
    report.fps = fps.fps;
    report.perf = { ...fps, minFpsSpec: minFps, fpsMet: fps.fps != null ? fps.fps >= minFps : false };
    report.scoreInputs.s3.fpsMet = report.perf.fpsMet;
  }

  // ⑩ downloads
  if (collector.downloadWaiters.length) await Promise.allSettled(collector.downloadWaiters);
  report.downloads = collector.downloads.map((d) => ({ filename: d.filename, bytes: d.bytes, error: d.error || null }));
  if (report.downloads.length) {
    for (const d of collector.downloads) {
      if (d.savedTo) {
        const dest = path.join(outDir, 'downloads', d.filename);
        try { fs.copyFileSync(d.savedTo, dest); } catch { /* keep tmp copy only */ }
      }
    }
  }

  // ⑥ console report
  const errs = collector.entries.filter((e) => e.type === 'error');
  const warns = collector.entries.filter((e) => e.type === 'warning');
  report.console = {
    errors: errs.length,
    warnings: warns.length,
    uncaughtErrors: collector.uncaught.length,
  };
  report.consoleErrors = errs.length + collector.uncaught.length;
  report.uncaught = collector.uncaught;
  writeJson(path.join(outDir, 'console.json'), { entries: collector.entries, uncaught: collector.uncaught });
  report.artifacts.push('console.json');
  report.scoreInputs.s1.readyNoError = report.ready.appReady && collector.uncaught.length === 0;
  report.scoreInputs.s1.buildPass = report.build.ok;
} catch (e) {
  report.error = report.error || e.message;
  if (!e.soft) process.stderr.write(`[validate] pipeline error: ${e.stack || e.message}\n`);
} finally {
  // ---- cleanup (always) ----
  // ⑨ video finalization must happen before the context closes
  if (wantVideo && page) {
    try {
      const vid = page.video();
      if (vid) {
        await page.close().catch(() => {});
        const src = await vid.path();
        if (src && fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(outDir, 'video.webm'));
          report.video = 'video.webm';
          report.artifacts.push('video.webm');
        }
      }
    } catch (e) {
      process.stderr.write(`[validate] video finalize: ${e.message}\n`);
    }
  }
  await hb.close().catch(() => {});
  await stopServe(serve).catch(() => {});
  // remove harness-internal temp dirs (evidence has already been copied out)
  for (const tmp of [path.join(outDir, '.video-tmp'), path.join(HARNESS_DIR, '.downloads-tmp')]) {
    try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // network log (post-shutdown the serve-log.json is final; fall back to it)
  let netLog = null;
  if (serve.port) netLog = await fetchServeLog(serve.port).catch(() => null);
  if (!netLog?.requests?.length && serve.logFile && fs.existsSync(serve.logFile)) {
    try { netLog = readJson(serve.logFile); } catch { netLog = null; }
  }
  const reqs = netLog?.requests ?? [];
  writeJson(path.join(outDir, 'network.json'), { requests: reqs, count: reqs.length, totalBytes: reqs.reduce((a, r) => a + (r.bytes || 0), 0) });
  report.networkEvents = { count: reqs.length, totalBytes: reqs.reduce((a, r) => a + (r.bytes || 0), 0) };
  report.artifacts.push('network.json');
  if (serve.logFile && fs.existsSync(serve.logFile)) report.artifacts.push('serve-log.json');

  // perf.json (S3 evidence)
  writeJson(path.join(outDir, 'perf.json'), report.perf ?? { error: 'not sampled' });
  report.artifacts.push('perf.json');

  // ⑬⑭ classification + verdict + final report
  report.classification = classify();
  report.verdict = report.classification === 'PASS' ? 'PASS' : 'FAIL';
  report.failureCategory = report.classification === 'PASS' ? null : report.classification;
  report.durationMs = Date.now() - tRunStart;
  report.finishedAt = isoNow();
  for (const f of fs.readdirSync(shotDir)) {
    if (!report.screenshots.includes(f)) report.screenshots.push(f);
  }
  writeJson(path.join(outDir, 'report.json'), report);
  log(`done: ${report.verdict} classification=${report.classification} probes=${report.probes.length} passRate=${report.probePassRate} fps=${report.fps}`);
  log(`report: ${path.join(outDir, 'report.json')}`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}
