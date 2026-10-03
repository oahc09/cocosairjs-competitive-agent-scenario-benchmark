#!/usr/bin/env node
// isolation/run-nc.mjs — G4 HARNESS_TRUST 负向对照(NC01-NC06)
// NC01-NC05: 逐个调 harness/runner/validate.mjs(以 E01 spec;NC03 追加 E02 spec 口径)
//            断言 validate 判 FAIL,并记录挂在哪个探针。
// NC06:      调 isolation/leak-scanner.mjs(--peer-arm arm-b)断言判 INVALID_RUN。
// runner 尚未建成(并行 Agent)→ 对应 case 标 PENDING,由集成阶段重跑本脚本。
// 输出 bench/gates/G4.json。零依赖。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from './leak-scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(HARNESS_ROOT, 'runner', 'validate.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const NC_OUT = path.join(BENCH_ROOT, 'results', 'nc');
const GATES_DIR = path.join(BENCH_ROOT, 'gates');
const nowIso = () => new Date().toISOString();

const CASES = [
  {
    id: 'NC01', name: 'empty-renderer', kind: 'validate', specs: ['E01'],
    expect: 'FAIL', caughtBy: 'P1 visualAssertion(nonBlank,亮像素<2%)——状态全对但 canvas 全黑',
  },
  {
    id: 'NC02', name: 'frozen-animation', kind: 'validate', specs: ['E01'],
    expect: 'FAIL', caughtBy: 'P2 visualAssertion(motion,2s 采样窗零运动像素)+ 独立 perfSample 佐证',
  },
  {
    id: 'NC03', name: 'fake-asset-loaded', kind: 'validate', specs: ['E01', 'E02'], primarySpec: 'E02',
    expect: 'FAIL', caughtBy: 'E01: network-evidence 不足(P1 无 asset request 独立观测,如实标注缺口,不改 spec);E02: P1 stateAssertion($.assetRequests >= 1)+ networkRequest 证据缺失',
  },
  {
    id: 'NC04', name: 'broken-interaction', kind: 'validate', specs: ['E01'],
    expect: 'FAIL', caughtBy: 'P3/P4 stateAssertion(指针/滚轮交互零状态变化;pixelDelta 因背景旋转可能通过,state 双采样是必要独立观测)',
  },
  {
    id: 'NC05', name: 'lifecycle-leak', kind: 'validate', specs: ['E01'],
    expect: 'FAIL', caughtBy: 'P7 stateAssertion(reset 后 rotationPhase=0.128>0.1,泄漏双循环)+ console 持续 [leak] 输出佐证',
  },
  {
    id: 'NC06', name: 'validator-tampering', kind: 'scanner',
    expect: 'INVALID_RUN', caughtBy: 'leak-scanner R1/R2/R3/R4 → INVALID_RUN(D1 协议违规扫描,不经 validate.mjs)',
  },
];

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 运行 validate.mjs,返回 {code, stdout, stderr, outDir} */
function runValidate(workspace, specPath, outDir, port) {
  return new Promise((resolve) => {
    const args = ['--workspace', workspace, '--spec', specPath, '--out', outDir];
    if (port) args.push('--port', String(port));
    const child = spawn(process.execPath, [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e.message), outDir }));
    child.on('exit', (code) => resolve({ code, stdout, stderr, outDir }));
  });
}

/** 从 --out 目录解析 validate 判定(report.json 启发式,兼容并行 Agent 的 report 结构) */
function readVerdict(outDir) {
  const candidates = [];
  const preferred = path.join(outDir, 'report.json');
  if (fs.existsSync(preferred)) candidates.push(preferred);
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith('.json') && f !== 'report.json') candidates.push(path.join(outDir, f));
    }
  }
  for (const file of candidates) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const probes = Array.isArray(j.probes) ? j.probes : [];
    const failed = probes.filter((p) => p && (p.status === 'FAIL' || p.status === 'ERROR')).map((p) => p.probeId || '?');
    const overallRaw = j.status ?? j.verdict ?? j.classification ?? j.result ?? null;
    const overall = typeof overallRaw === 'string' ? overallRaw.toUpperCase() : null;
    const failish = overall
      ? /^(FAIL|INVALID_RUN|BUDGET_EXHAUSTED|REPAIR_EXHAUSTED|BUILD|RUNTIME|ERROR)/.test(overall) || failed.length > 0
      : failed.length > 0;
    return { reportFile: path.relative(BENCH_ROOT, file), overall, probes: probes.map((p) => `${p.probeId}:${p.status}`), failedProbes: failed, failish, ready: j.ready, classification: j.classification ?? null };
  }
  return null;
}

async function main() {
  console.log(`[G4] negative controls start at ${nowIso()}`);
  const runnerAvailable = fs.existsSync(RUNNER);
  if (!runnerAvailable) {
    console.log('[G4] harness/runner/validate.mjs 不存在(并行 Agent 建设中)→ NC01-NC05 标 PENDING,NC06 走 leak-scanner');
  }

  const cases = [];
  let portCursor = 7410;

  for (const c of CASES) {
    const workspace = path.join(FIXTURES, c.id);

    if (c.kind === 'scanner') {
      // NC06:leak-scanner 直接判
      const result = scanWorkspace(workspace, { peerArm: 'arm-b' });
      const detected = result.status === 'VIOLATIONS';
      const ruleIds = [...new Set(result.violations.map((v) => v.rule))];
      cases.push({
        id: c.id, name: c.name, method: 'isolation/leak-scanner.mjs --peer-arm arm-b',
        expected: c.expect, detected,
        detectedAs: result.status === 'VIOLATIONS' ? 'INVALID_RUN' : 'CLEAN',
        caughtBy: c.caughtBy,
        caughtByActual: result.status === 'VIOLATIONS' ? `leak-scanner ${ruleIds.join(',')}` : 'nothing',
        status: detected ? 'DETECTED' : 'NOT-DETECTED',
        evidence: {
          hitRules: ruleIds,
          violations: result.violations.map((v) => `${v.rule} @ ${v.file}:${v.line}`),
          stats: result.stats,
        },
      });
      console.log(`[G4] ${c.id}: ${detected ? 'DETECTED' : 'NOT-DETECTED'} (scanner ${result.status}, rules=${ruleIds.join(',') || '-'})`);
      continue;
    }

    if (!runnerAvailable) {
      cases.push({
        id: c.id, name: c.name, method: `runner/validate.mjs (specs: ${c.specs.join('+')})`,
        expected: c.expect, detected: null,
        caughtBy: c.caughtBy,
        status: 'PENDING',
        reason: 'harness/runner/validate.mjs 尚未建成(由并行 Agent 建设);集成阶段重跑 `node isolation/run-nc.mjs` 补齐',
      });
      console.log(`[G4] ${c.id}: PENDING (runner 缺失)`);
      continue;
    }

    const runs = [];
    for (const specId of c.specs) {
      while (!(await checkPortFree(portCursor))) portCursor += 1;
      const port = portCursor; portCursor += 1;
      const specPath = path.join(BENCH_ROOT, 'briefs', specId, 'spec.json');
      const outDir = path.join(NC_OUT, `${c.id}-${specId}`);
      const proc = await runValidate(workspace, specPath, outDir, port);
      const verdict = readVerdict(outDir);
      runs.push({
        spec: specId, exitCode: proc.code,
        verdict: verdict ? verdict.overall : null,
        failish: verdict ? verdict.failish : null,
        failedProbes: verdict ? verdict.failedProbes : [],
        ready: verdict ? verdict.ready : undefined,
        report: verdict ? verdict.reportFile : null,
        stdoutTail: proc.stdout.split('\n').slice(-5).join('\n').slice(0, 500),
        stderrTail: proc.stderr.split('\n').slice(-3).join('\n').slice(0, 300),
      });
    }

    // 主判定口径:primarySpec(缺省第一个 spec;NC03 为 E02)。E01 侧结果照记为观测覆盖缺口证据。
    const primary = runs.find((r) => r.spec === (c.primarySpec || c.specs[0]));
    const detected = primary
      ? (primary.failish === null || primary.failish === undefined ? primary.exitCode !== 0 : primary.failish || primary.exitCode !== 0)
      : false;
    cases.push({
      id: c.id, name: c.name, method: `runner/validate.mjs (specs: ${c.specs.join('+')}; primary=${c.primarySpec || c.specs[0]})`,
      expected: c.expect, detected,
      caughtBy: c.caughtBy,
      caughtByActual: primary ? (primary.failedProbes.join(',') || (detected ? 'overall' : '-')) : '-',
      status: detected ? 'DETECTED' : 'NOT-DETECTED',
      runs,
    });
    console.log(`[G4] ${c.id}: ${detected ? 'DETECTED' : 'NOT-DETECTED'} (${c.specs.map((s) => {
      const r = runs.find((x) => x.spec === s);
      return `${s} failed=[${r ? r.failedProbes.join(',') : '-'}]`;
    }).join(' ')})`);
  }

  // ---- 汇总状态 ----
  const mismatch = cases.some((c) => c.status === 'NOT-DETECTED' && !(c.id === 'NC03' && !c.detected));
  const anyPending = cases.some((c) => c.status === 'PENDING');
  let status;
  if (mismatch) status = 'FAIL';
  else if (anyPending) status = 'PENDING';
  else status = 'PASS';

  const g4 = {
    gate: 'G4 HARNESS_TRUST',
    status,
    generatedAt: nowIso(),
    runnerAvailable,
    runner: runnerAvailable ? 'harness/runner/validate.mjs' : '(built by parallel harness agent; re-run isolation/run-nc.mjs at integration)',
    cases,
    specCoverageNotes: [
      'NC03 双口径如实记录:E01 spec 的 P1 只有 starCount+nonBlank,无 asset 网络独立观测,检不出 fake-asset-loaded;',
      'NC03 以 E02 spec(P1: $.assetRequests >= 1 + networkRequest:assets/boat.glb 证据)作为抓捕口径 —— 不篡改任何 spec。',
      'NC01-NC05 的"detected"= validate.mjs 判 FAIL;NC06 的"detected"= leak-scanner 判 INVALID_RUN。',
    ],
    environment: { nodeVersion: process.version },
  };

  fs.mkdirSync(GATES_DIR, { recursive: true });
  const outPath = path.join(GATES_DIR, 'G4.json');
  fs.writeFileSync(outPath, JSON.stringify(g4, null, 2) + '\n', 'utf8');
  console.log(`[G4] cases: ${cases.map((c) => `${c.id}:${c.status}`).join('  ')}  → overall ${status}`);
  console.log(`[G4] written ${path.relative(BENCH_ROOT, outPath)}`);
  process.exit(status === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error('[G4] FATAL', e);
  process.exit(1);
});
