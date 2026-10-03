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
//                           [--pair-meta <pair.json>]   冻结输入守卫(FIX-B)
//                           [--revision <label>]        修订版输出(FIX-B)
//
// FIX-B 冻结输入守卫(--pair-meta,在任何测量之前执行):
//   * 实际 spec 文件 sha256 != pair.specSha256        -> classification=INPUT_DRIFT,exit 4
//   * pair.dependencyHashes 存在且根 node_modules 的
//     three/cocosair/esbuild 合并指纹不等               -> classification=ENV_DRIFT,  exit 5
//   合并指纹 = sha256( sha256(pkg/package.json) + ':' + sha256(pkg 主入口文件) ),
//   键名 {three, cocosair, esbuild}(cocosair 对应 node_modules/cocosair.js)。
//
// FIX-B --revision <label>:输出写 <out>/revisions/<ISO>-<label>/;若 <out>/report.json
//   已存在,先一次性归档到 <out>/revisions/<其生成时间>-original/(幂等,由 marker 保证)。
//
// FIX-B classifyProbeFailures:失败分类依据 harness/runner/probe-meta/<SCENE>.json
//   sidecar(可能不存在),按"失败断言类别(action/state/visual/error)× failureDomains"
//   判定;sidecar 缺失 / 探针未映射 / 多义 一律 UNRESOLVED,不再按 probeId 正则猜测,
//   并删除旧的 STATE_MANAGEMENT 默认兜底。sidecar 契约见下方 classifyProbeFailures 注释。
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

// probe-meta sidecar(整改 §10/§11/§12):lifecycle/fullPassDeps/failureDomains,
// 由 fixture 维护侧提供;缺失时执行器按保守语义运行(失败分类=UNRESOLVED)
function loadProbeMeta(sceneId) {
  if (!sceneId) return null;
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-meta', `${sceneId}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_DIR = path.join(HARNESS_DIR, 'runner');
const BUILD_TIMEOUT_MS = 180000;
const READY_TIMEOUT_MS = 10000;

const argv = parseArgv(process.argv.slice(2));
const workspace = path.resolve(argv.workspace);
const specPath = path.resolve(argv.spec);
const outDirBase = path.resolve(argv.out || './validate-out');
const runId = argv['run-id'] || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const wantVideo = !!argv.video;
const pairId = argv.pair || null;
const engine = argv.engine || null;
// FIX-B: --pair-meta(冻结输入守卫)与 --revision(修订版输出)
const pairMetaPath = typeof argv['pair-meta'] === 'string' && argv['pair-meta'] ? path.resolve(argv['pair-meta']) : null;
const revisionLabel = typeof argv.revision === 'string' && argv.revision.trim()
  ? argv.revision.trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  : null;

if (!argv.workspace || !argv.spec) {
  process.stderr.write('usage: node runner/validate.mjs --workspace <dir> --spec <spec.json> --out <dir> [--run-id id] [--video] [--port n] [--pair id] [--engine three|air] [--pair-meta pair.json] [--revision label]\n');
  process.exit(2);
}

// --revision:先把 <out>/report.json 一次性归档到 revisions/<其时间>-original/,
// 再把本次全部输出重定向到 <out>/revisions/<ISO>-<label>/。
// 幂等保证:归档只在 marker 文件(revisions/.original-archived)不存在时执行一次。
const compactIso = (iso) => String(iso).replace(/[:.]/g, '').replace(/[^0-9TZ-]/g, '');
function resolveOutDir(base) {
  if (!revisionLabel) return base;
  const revRoot = path.join(base, 'revisions');
  const existing = path.join(base, 'report.json');
  const marker = path.join(revRoot, '.original-archived');
  if (fs.existsSync(existing) && !fs.existsSync(marker)) {
    let bornAt = new Date().toISOString();
    try { bornAt = JSON.parse(fs.readFileSync(existing, 'utf8')).generatedAt || bornAt; } catch { /* 保留现时刻 */ }
    const archiveDir = path.join(revRoot, `${compactIso(bornAt)}-original`);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(existing, path.join(archiveDir, 'report.json'));
    fs.rmSync(existing);
    fs.mkdirSync(revRoot, { recursive: true });
    fs.writeFileSync(marker, `${bornAt}\n`, 'utf8');
    // (log 尚未定义,这里直接写 stdout)
    process.stdout.write(`[revision] 已归档原有 report.json -> ${path.relative(base, path.join(archiveDir, 'report.json'))}\n`);
  }
  const dir = path.join(revRoot, `${compactIso(isoNow())}-${revisionLabel}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const outDir = resolveOutDir(outDirBase);

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

// FIX-B: 验证协议指纹(probe-executor.mjs + validate.mjs 内容合并 sha,启动时计算;
// reference-versions.mjs 冻结账本使用同一公式,保证两边可比对)。
const validatorProtocolHash = (() => {
  const a = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-executor.mjs'));
  const b = fs.readFileSync(fileURLToPath(import.meta.url));
  return { hash: sha256(Buffer.concat([a, b])), probeExecutorSha256: sha256(a), validateSha256: sha256(b) };
})();

// FIX-B: pair 元数据(冻结输入守卫);sidecar 场景号优先取 spec.briefId。
let pairMeta = null;
let pairMetaError = null;
if (pairMetaPath) {
  try { pairMeta = readJson(pairMetaPath); } catch (e) { pairMetaError = e.message; }
}
const sceneId = spec?.briefId || pairMeta?.sceneId || null;

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
  // FIX-B: 冻结输入与协议指纹(聚合/账本/qualify 据此判漂移)
  specSha256: specSha,
  validatorProtocolHash: validatorProtocolHash.hash,
  validatorProtocolComponents: { probeExecutorSha256: validatorProtocolHash.probeExecutorSha256, validateSha256: validatorProtocolHash.validateSha256 },
  pairMeta: pairMetaPath ? {
    path: pairMetaPath,
    pairId: pairMeta?.pairId ?? pairMeta?.sceneId ?? null,
    batchId: pairMeta?.batchId ?? null,
    sceneId: pairMeta?.sceneId ?? null,
    knowledge: pairMeta?.knowledge ?? null,
    loadError: pairMetaError,
  } : null,
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

// ------------------------------------------- FIX-B: 冻结输入守卫(测量前执行)
// 依赖合并指纹:sha256( sha256(pkg/package.json) + ':' + sha256(主入口文件) );
// 键名 {three, cocosair, esbuild}(cocosair -> node_modules/cocosair.js)。
function dependencyFingerprints() {
  const root = path.join(HARNESS_DIR, '..', 'node_modules');
  const dirs = { three: 'three', cocosair: 'cocosair.js', esbuild: 'esbuild' };
  const out = {};
  for (const [key, dir] of Object.entries(dirs)) {
    const pkgDir = path.join(root, dir);
    const pkgJsonSha = sha256File(path.join(pkgDir, 'package.json'));
    let mainRel = null;
    try { const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); mainRel = pj.main || pj.module || 'index.js'; } catch { /* 缺包在下面对 null 判漂移 */ }
    const mainSha = mainRel ? sha256File(path.join(pkgDir, mainRel)) : null;
    out[key] = (pkgJsonSha && mainSha) ? sha256(`${pkgJsonSha}:${mainSha}`) : null;
  }
  return out;
}

function exitGuarded(code, classification, guardInfo) {
  report.classification = classification;
  report.failureCategory = classification;
  report.verdict = 'FAIL';
  report.inputGuard = guardInfo;
  report.error = guardInfo.reason;
  report.durationMs = Date.now() - tRunStart;
  report.finishedAt = isoNow();
  fs.mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, 'report.json'), report);
  process.stdout.write(`guarded: ${classification} -> ${path.join(outDir, 'report.json')}\n`);
  process.exit(code);
}

if (pairMetaPath) {
  // (a) INPUT_DRIFT:实际 spec 与 pair 冻结指纹不一致(含 pair 元数据不可读/缺 specSha256 —— 无法核验即拒跑)
  if (pairMetaError || !pairMeta) {
    exitGuarded(4, 'INPUT_DRIFT', { kind: 'INPUT_DRIFT', checked: 'pair-meta', reason: `pair.json 不可读: ${pairMetaError}`, pairMetaPath });
  }
  if (typeof pairMeta.specSha256 !== 'string' || !pairMeta.specSha256) {
    exitGuarded(4, 'INPUT_DRIFT', { kind: 'INPUT_DRIFT', checked: 'specSha256', reason: 'pair.specSha256 缺失,冻结输入不可核验', pairMetaPath, specPath, actualSpecSha256: specSha });
  }
  if (specSha !== pairMeta.specSha256) {
    exitGuarded(4, 'INPUT_DRIFT', {
      kind: 'INPUT_DRIFT', checked: 'specSha256',
      reason: `实际 spec sha256(${specSha}) != pair.specSha256(${pairMeta.specSha256})`,
      pairMetaPath, specPath, actualSpecSha256: specSha, frozenSpecSha256: pairMeta.specSha256,
    });
  }
  // (b) ENV_DRIFT:根 node_modules 依赖合并指纹与 pair.dependencyHashes 不一致(字段缺失则跳过 —— 历史批次未冻结)
  const want = pairMeta.dependencyHashes;
  if (want && typeof want === 'object') {
    const got = dependencyFingerprints();
    const diffs = [];
    for (const key of ['three', 'cocosair', 'esbuild']) {
      if (want[key] === undefined) continue; // 只比对 pair 冻结过的键
      if (got[key] !== want[key]) diffs.push({ key, frozen: want[key], actual: got[key] });
    }
    if (diffs.length) {
      exitGuarded(5, 'ENV_DRIFT', {
        kind: 'ENV_DRIFT', checked: 'dependencyHashes',
        reason: `依赖指纹不一致: ${diffs.map((d) => d.key).join(', ')}`,
        diffs, computed: got,
      });
    }
    report.inputGuard = { kind: 'PASS', checked: ['specSha256', 'dependencyHashes'], at: isoNow() };
  } else {
    report.inputGuard = { kind: 'PASS', checked: ['specSha256'], note: 'pair.dependencyHashes 缺失(历史批次未冻结依赖指纹,跳过 ENV 校验)', at: isoNow() };
  }
}

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

// FIX-B 重写:失败分类不再按 probeId 正则猜测,并删除旧的 STATE_MANAGEMENT 默认兜底。
// 判定依据 = harness/runner/probe-meta/<SCENE>.json sidecar(sidecar 可能不存在):
//   {
//     "scene": "E01",
//     "version": 1,
//     "probes": {
//       "P4": {
//         "failureDomains": {
//           "action": ["INTERACTION"],
//           "state":  ["STATE_MANAGEMENT"],
//           "visual": ["RUNTIME"],
//           "error":  ["RUNTIME"]
//         }
//       }
//     }
//   }
// 规则:每个失败探针取其"失败断言类别"(action/state/visual/error,来自探针证据),
// 查 sidecar 各类别的 failureDomains 并集:唯一域 -> 判该域;多义 -> UNRESOLVED。
// sidecar 缺失 / 探针未映射 / 类别未映射 / 失败无类别证据 -> UNRESOLVED。
// 跨探针:全部可判且同域 -> 该域;否则 UNRESOLVED。逐探针依据写入
// report.classificationEvidence 供聚合/人工复核。
function classifyProbeFailures(failed) {
  const sidecarPath = sceneId ? path.join(RUNNER_DIR, 'probe-meta', `${sceneId}.json`) : null;
  let sidecar = null;
  if (sidecarPath && fs.existsSync(sidecarPath)) {
    try { sidecar = readJson(sidecarPath); } catch { sidecar = null; }
  }
  const perProbe = failed.map((f) => {
    const cats = Array.isArray(f.failedAssertions) && f.failedAssertions.length
      ? f.failedAssertions
      : (f.status === 'ERROR' ? ['error'] : []);
    let domain = null;
    let unresolvedReason = null;
    if (!sidecar) unresolvedReason = 'no-sidecar';
    else if (!sidecar.probes || !sidecar.probes[f.probeId]) unresolvedReason = 'probe-not-in-sidecar';
    else if (!cats.length) unresolvedReason = 'uncategorized-failure';
    else {
      const domains = new Set();
      let mappedAny = false;
      for (const c of cats) {
        const list = sidecar.probes[f.probeId].failureDomains?.[c];
        if (Array.isArray(list) && list.length) { mappedAny = true; for (const d of list) domains.add(d); }
      }
      if (!mappedAny) unresolvedReason = 'assertion-category-unmapped';
      else if (domains.size === 1) domain = [...domains][0];
      else unresolvedReason = 'ambiguous:' + [...domains].sort().join('+');
    }
    return { probeId: f.probeId, status: f.status, failedAssertions: cats, domain, unresolvedReason };
  });
  report.classificationEvidence = {
    rule: 'probe-meta sidecar: 失败断言类别 x failureDomains;sidecar 缺失/多义 -> UNRESOLVED(无默认兜底)',
    sidecar: sidecar ? sidecarPath : null,
    failedProbes: perProbe,
  };
  const resolved = perProbe.filter((p) => p.domain).map((p) => p.domain);
  const unique = [...new Set(resolved)];
  if (perProbe.length && resolved.length === perProbe.length && unique.length === 1) return unique[0];
  return 'UNRESOLVED';
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
      // 独立观测通道接线(整改 §8):download/console 断言接真实采集器,缺数据时
      // executor 返回 UNSUPPORTED_BY_ENV,绝不静默 PASS
      downloads: collector.downloads,
      consoleSince: (tsIso) => collector.entries.filter((e) => (e.ts ?? '') >= tsIso),
      consoleEntries: collector.entries,
      probeMeta: loadProbeMeta(spec?.briefId),
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
  report.probes = probeRun.results.map((r) => {
    // FIX-B: 记录该探针"失败的断言类别"(证据来自探针执行明细,供失败分类 sidecar 使用)
    const cats = [];
    if (r.action?.error) cats.push('action');
    if (r.stateAssertion && (r.stateAssertion.ok === false || r.stateAssertion.error)) cats.push('state');
    if (r.visualAssertion && r.visualAssertion.ok === false) cats.push('visual');
    if (r.status === 'ERROR' && !cats.length) cats.push('error');
    return {
      probeId: r.probeId,
      status: r.status,
      weight: r.weight,
      visualType: r.visualAssertion?.type || null,
      failedAssertions: cats,
    };
  });
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
