#!/usr/bin/env node
// selftest.mjs — end-to-end self test of the harness. Writes harness/selftest.txt.
//
//   node runner/selftest.mjs
//
// Steps:
//   S0  environment header
//   S1  browser launch config detection (writes launch-config.json)
//   S2  process census before (node/chrome via tasklist)
//   S3  validate.mjs over fixtures/tiny-fake-app with selftest-spec.json (--video)
//   S4  assertions on report.json (P1-P4 PASS, P5 intentional FAIL, P6 SKIPPED, P7 PASS,
//       screenshots >=5, video, network, console, build.log, source-sha, perf, fps)
//   S5  process census after (leak check)
//   S6  dry-run parse of frozen specs E01/E03/E10 (no browser)
//   S7  brief-freeze --check (idempotency probe, informational)
//   S8  score.mjs smoke (runs.json + pair + bootstrap with a synthesized twin)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, isoNow } from './util.mjs';
import { dryRunSpec } from './probe-executor.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(HARNESS_DIR, 'runner');
const BENCH_ROOT = path.resolve(HARNESS_DIR, '..');
const OUT_ROOT = path.join(HARNESS_DIR, 'selftest-out');
const TXT = path.join(HARNESS_DIR, 'selftest.txt');

const lines = [];
const checks = [];
let failed = 0;

function section(name) {
  lines.push('', '='.repeat(72), `== ${name}`, '='.repeat(72));
}
function say(msg) {
  lines.push(String(msg));
  process.stdout.write(String(msg) + '\n');
}
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail: String(detail) });
  if (!ok) failed++;
  say(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 300000, ...opts });
  return { code: r.status, stdout: (r.stdout || '').toString(), stderr: (r.stderr || '').toString() };
}

function processCensus() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV'], { encoding: 'utf8', timeout: 20000 });
    const counts = {};
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line);
      if (!m) continue;
      counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    return { node: counts['node.exe'] || 0, chrome: counts['chrome.exe'] || 0, headless_shell: counts['headless_shell.exe'] || 0 };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------- S0
section('S0 environment');
say(`startedAt: ${isoNow()}`);
say(`node: ${process.version}  platform: ${process.platform} ${process.arch}`);
say(`harness dir: ${HARNESS_DIR}`);

// ---------------------------------------------------------------- S1
section('S1 browser launch config detection');
const det = run('node', [path.join(RUNNER, 'browser.mjs'), '--detect', '--force']);
say(det.stdout.trim());
if (det.code !== 0) say(det.stderr.trim());
check('browser detection exits 0', det.code === 0);
const launchCfg = fs.existsSync(path.join(HARNESS_DIR, 'launch-config.json'))
  ? readJson(path.join(HARNESS_DIR, 'launch-config.json'))
  : null;
check('launch-config.json written', !!launchCfg);
if (launchCfg) {
  say(`executablePath: ${launchCfg.executablePath}`);
  say(`args: ${JSON.stringify(launchCfg.args)}`);
  say(`webgl2: ${JSON.stringify(launchCfg.webgl2)}`);
  check('WebGL2 available', launchCfg.webgl2?.ok === true, `swiftshaderFallback=${launchCfg.swiftshaderFallback}`);
}

// ---------------------------------------------------------------- S2
section('S2 process census BEFORE');
const before = processCensus();
say(JSON.stringify(before));

// ---------------------------------------------------------------- S3
section('S3 validate.mjs over tiny-fake-app (with video recording)');
await fsp.rm(OUT_ROOT, { recursive: true, force: true });
const runOut = path.join(OUT_ROOT, 'run1');
const vres = run('node', [
  path.join(RUNNER, 'validate.mjs'),
  '--workspace', path.join(HARNESS_DIR, 'fixtures', 'tiny-fake-app'),
  '--spec', path.join(HARNESS_DIR, 'fixtures', 'selftest-spec.json'),
  '--out', runOut,
  '--run-id', 'selftest-run1',
  '--pair', 'SELFTEST-PAIR',
  '--engine', 'air',
  '--video',
]);
say(vres.stdout.trim());
if (vres.stderr.trim()) say('[stderr] ' + vres.stderr.trim());

// ---------------------------------------------------------------- S4
section('S4 report assertions');
const reportPath = path.join(runOut, 'report.json');
check('report.json generated', fs.existsSync(reportPath));
const rep = fs.existsSync(reportPath) ? readJson(reportPath) : {};
check('validate exits 0 or 1 (PASS→0 / assertion FAIL→1; infra errors exit>=2)', (vres.code ?? 9) < 2, `exit=${vres.code}`);
check('build.ok', rep.build?.ok === true);
check('appReady within 10s', rep.ready?.appReady === true, `durationMs=${rep.ready?.durationMs}`);
check('bench contract (__bench) present', rep.ready?.benchReady === true);
check('no uncaught errors', (rep.console?.uncaughtErrors ?? 1) === 0);

const byProbe = Object.fromEntries((rep.probes ?? []).map((p) => [p.probeId, p.status]));
check('P1 nonBlank PASS', byProbe.P1 === 'PASS', byProbe.P1);
check('P2 motion PASS', byProbe.P2 === 'PASS', byProbe.P2);
check('P3 frame-increment PASS', byProbe.P3 === 'PASS', byProbe.P3);
check('P4 reset PASS', byProbe.P4 === 'PASS', byProbe.P4);
check('P5 intentional FAIL judged FAIL', byProbe.P5 === 'FAIL', byProbe.P5);
check('P6 continues after failed predecessor (rectification §11: no cascade skip)', byProbe.P6 === 'PASS', byProbe.P6);
check('P7 key action PASS', byProbe.P7 === 'PASS', byProbe.P7);
check('probePassRate = 6/7 (P6 继续执行)', Math.abs((rep.probePassRate ?? 0) - 6 / 7) < 0.001, rep.probePassRate);

for (const art of ['source-sha.json', 'build.log', 'console.json', 'probe-results.json', 'network.json', 'perf.json']) {
  check(`artifact ${art}`, fs.existsSync(path.join(runOut, art)));
}
const shotCount = fs.existsSync(path.join(runOut, 'screenshots')) ? fs.readdirSync(path.join(runOut, 'screenshots')).filter((f) => f.endsWith('.png')).length : 0;
check('key screenshots >= 5', shotCount >= 5, `count=${shotCount}`);
check('video.webm recorded', fs.existsSync(path.join(runOut, 'video.webm')));
check('network events recorded', (rep.networkEvents?.count ?? 0) > 0, `count=${rep.networkEvents?.count}`);
check('fps sampled >= 30', (rep.fps ?? 0) >= 30, `fps=${rep.fps}`);
check('classification = failed-probe domain (P5 故意 FAIL;无 sidecar→UNRESOLVED)', rep.classification != null && rep.classification !== 'PASS', rep.classification);
check('scoreInputs.s1 complete', rep.scoreInputs?.s1?.buildPass && rep.scoreInputs?.s1?.readyNoError && rep.scoreInputs?.s1?.firstShotNonBlank);
check('scoreInputs.s3 lifecycle+fps', rep.scoreInputs?.s3?.lifecycleProbePassed === true && rep.scoreInputs?.s3?.fpsMet === true);

// ---------------------------------------------------------------- S5
section('S5 process census AFTER (leak check)');
await new Promise((r) => setTimeout(r, 1500)); // give the OS a moment to reap
const after = processCensus();
say(JSON.stringify(after));
const dNode = after.node - before.node;
const dChrome = after.chrome + after.headless_shell - (before.chrome + before.headless_shell);
say(`delta node=${dNode} chrome(+)headless_shell=${dChrome}`);
check('no node process leak', dNode <= 0, `delta=${dNode} (before=${before.node} after=${after.node})`);
check('no chrome process leak', dChrome <= 0, `delta=${dChrome} (before=${before.chrome + before.headless_shell} after=${after.chrome + after.headless_shell})`);

// ---------------------------------------------------------------- S6
section('S6 spec dry-run parse (E01 / E03 / E10, no browser)');
for (const id of ['E01', 'E03', 'E10']) {
  const specPath = path.join(BENCH_ROOT, 'briefs', id, 'spec.json');
  const spec = readJson(specPath);
  const dry = await dryRunSpec(spec);
  const verbs = [...new Set(dry.probes.flatMap((p) => p.action.verbs ?? []))];
  say(`${id}: ${dry.probeCount} probes, verbs=${JSON.stringify(verbs)}, allOk=${dry.allOk}`);
  for (const p of dry.probes) {
    say(`  ${p.probeId} action=${p.action.ok ? 'ok' : 'ERR:' + p.action.error} jq=${p.stateAssertion ? (p.stateAssertion.ok ? 'ok' : 'ERR:' + p.stateAssertion.error) : '-'} visual=${p.visualAssertion ? (p.visualAssertion.ok ? p.visualAssertion.type + (p.visualAssertion.dynamicRegion ? '(dynamic)' : '') : 'ERR:' + p.visualAssertion.error) : '-'}`);
  }
  check(`${id}: all probes parse`, dry.allOk === true);
}

// ---------------------------------------------------------------- S7
section('S7 brief-freeze --check (informational, writes nothing)');
const bf = run('node', [path.join(RUNNER, 'brief-freeze.mjs'), '--check']);
say(bf.stdout.trim() || bf.stderr.trim());
say(`(exit=${bf.code}; drift before the real freeze run is expected and handled separately)`);

// ---------------------------------------------------------------- S8
section('S8 score.mjs smoke (runs.json + pair metrics + bootstrap)');
const scoreDir = path.join(OUT_ROOT, 'score-fixture');
fs.mkdirSync(scoreDir, { recursive: true });
// twin A = the real selftest report (air arm)
const runA = JSON.parse(JSON.stringify(rep));
runA.runId = 'selftest-run1';
runA.pairId = 'SELFTEST-PAIR';
runA.engine = 'air';
writeJson(path.join(scoreDir, 'report-air.json'), runA);
// twin B = counterfactual three arm: P5 also passes -> higher S2
const runB = JSON.parse(JSON.stringify(rep));
runB.runId = 'selftest-run2';
runB.pairId = 'SELFTEST-PAIR';
runB.engine = 'three';
runB.probes = runB.probes.map((p) => (p.probeId === 'P5' ? { ...p, status: 'PASS' } : p));
runB.probePassRate = 6 / 7;
runB.scoreInputs.s2.passedWeight = 6;
runB.scoreInputs.s2.totalWeight = 7;
writeJson(path.join(scoreDir, 'report-three.json'), runB);
// run C = unpaired, visual dims missing -> visual null
const runC = JSON.parse(JSON.stringify(rep));
runC.runId = 'selftest-run3';
runC.pairId = null;
writeJson(path.join(scoreDir, 'report-unpaired.json'), runC);

// NOTE: inline JSON args lose their quotes through cmd.exe, so the selftest
// passes --visual/--ceiling as files (both input forms are supported by score.mjs).
const visualFile = path.join(scoreDir, 'visual-scores.json');
writeJson(visualFile, {
  'selftest-run1': { 构图: 3, 材质光影: 2, 动效流畅: 3, 特效质感: 2, 交互反馈: 2, 整体完成度: 3 },
  'selftest-run2': { 构图: 2, 材质光影: 2, 动效流畅: 2, 特效质感: 2, 交互反馈: 2, 整体完成度: 2 },
});
const ceilingFile = path.join(scoreDir, 'ceiling.json');
writeJson(ceilingFile, { 'SELFTEST-PAIR': { air: 90, three: 95 } });
const scoreOut = path.join(OUT_ROOT, 'score-out');
const sc = run('node', [
  path.join(RUNNER, 'score.mjs'),
  '--reports', path.join(scoreDir, 'report-*.json'),
  '--visual', visualFile,
  '--ceiling', ceilingFile,
  '--out', scoreOut,
]);
say(sc.stdout.trim());
if (sc.stderr.trim()) say('[stderr] ' + sc.stderr.trim());
check('score.mjs exits 0', sc.code === 0, `exit=${sc.code}`);
const runsJson = fs.existsSync(path.join(scoreOut, 'runs.json')) ? readJson(path.join(scoreOut, 'runs.json')) : null;
const pairsJson = fs.existsSync(path.join(scoreOut, 'pairs.json')) ? readJson(path.join(scoreOut, 'pairs.json')) : null;
check('runs.json written', !!runsJson, `${runsJson?.runCount ?? 0} runs`);
if (runsJson) {
  const r1 = runsJson.runs.find((r) => r.runId === 'selftest-run1');
  const r2 = runsJson.runs.find((r) => r.runId === 'selftest-run2');
  const r3 = runsJson.runs.find((r) => r.runId === 'selftest-run3');
  check('run1 S1=15 (7+5+3)', r1?.s1?.score === 15, r1?.s1?.score);
  check('run1 S2=round(30*6/7)=26 (P6 继续执行)', r2 && r1?.s2?.score === 26, r1?.s2?.score);
  check('run1 S3=10 (lifecycle 6 + fps 4)', r1?.s3?.score === 10, r1?.s3?.score);
  check('run1 S4=5 (default placeholder)', r1?.s4?.score === 5, r1?.s4?.score);
  check('run1 visual=round(15*40/18)=33', r1?.visual?.score === 33, r1?.visual?.score);
  check('run1 total=89 (84+5: P6 计入)', r1?.total === 89, r1?.total);
  check('run2 S2=round(30*6/7)=26', r2?.s2?.score === 26, r2?.s2?.score);
  check('run2 visual=round(12*40/18)=27', r2?.visual?.score === 27, r2?.visual?.score);
  check('run3 visual=null (dims missing)', r3?.visual?.score === null && r3?.total === null, JSON.stringify(r3?.visual?.score));
}
check('pairs.json written', !!pairsJson);
if (pairsJson) {
  const pair = pairsJson.pairs?.[0];
  say(`pair: ${JSON.stringify(pair)}`);
  check('pair rawDelta = 89-83 = 6', pair?.rawDelta === 6, pair?.rawDelta);
  check('pair outcome AIR_win (|6| > 3)', pair?.outcome === 'AIR_WIN' || pair?.outcome === 'AIR_win', pair?.outcome);
  check('pair attainmentDelta computed', typeof pair?.attainmentDelta === 'number', pair?.attainmentDelta);
  const boot = pairsJson.summary?.bootstrap;
  check('bootstrap CI present (2000 resamples)', boot?.resamples === 2000 && Array.isArray(boot?.ci95), JSON.stringify(boot?.ci95));
}

// ---------------------------------------------------------------- summary
section('SUMMARY');
say(`checks: ${checks.length - failed}/${checks.length} passed`);
say(`result: ${failed === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL'}`);
lines.push('', `generatedAt: ${isoNow()}`);
fs.writeFileSync(TXT, lines.join('\n') + '\n', 'utf8');
say(`written: ${TXT}`);
process.exit(failed === 0 ? 0 : 1);
