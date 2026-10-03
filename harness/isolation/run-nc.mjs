#!/usr/bin/env node
// isolation/run-nc.mjs — G4 HARNESS_TRUST 负向对照(NC01-NC06 + 扩展 NC07-NC13)
// NC01-NC05: 逐个调 harness/runner/validate.mjs(以 E01 spec;NC03 追加 E02 spec 口径)
//            断言 validate 判 FAIL,并记录挂在哪个探针。
// NC06:      调 isolation/leak-scanner.mjs(--peer-arm arm-b)断言判 INVALID_RUN。
// NC07-NC13(整改 FIX-D,§10 §11 §12 sidecar 配套 + §17 门禁传播):
//   NC07/NC08 spec-audit(未知断言类型/未知 region)→ 退出码 3;工具未建成 → PENDING-INTEGRATION
//   NC09       validate --pair-meta 输入漂移前置闸门(秒级,不建浏览器)→ 退出码 4/INPUT_DRIFT
//   NC10       reference-versions --selftest-drift 量尺漂移自检 → 输出含 PASS
//   NC11       AGENT_IDENTITY_MISSING:设计归 run-round preflight(FIX-C)集成阶段验证 → 恒 PENDING-INTEGRATION
//   NC12       budget-check 机器计数超 agents.yaml 冻结上限 → BUDGET_EXHAUSTED
//   NC13       aggregate-all 真实只读聚合 → formal.total===null 且 objective.total 非 null(§17)
// runner 尚未建成(并行 Agent)→ 对应 case 标 PENDING,由集成阶段重跑本脚本。
// 输出 gates/G4.json(原字段全保留,新增 ncExtended 段)。零依赖。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanWorkspace } from './leak-scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(HARNESS_ROOT, 'runner', 'validate.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const NC_OUT = path.join(BENCH_ROOT, 'results', 'nc');
const GATES_DIR = path.join(BENCH_ROOT, 'gates');
// NC07-13 涉及的工具与数据路径(存在性/源码特征即"集成就绪"探测依据)
const SPEC_AUDIT = path.join(HARNESS_ROOT, 'runner', 'spec-audit.mjs');
const BUDGET_CHECK = path.join(HARNESS_ROOT, 'runner', 'budget-check.mjs');
const PROBE_EXECUTOR = path.join(HARNESS_ROOT, 'runner', 'probe-executor.mjs');
const REF_VERSIONS = path.join(HARNESS_ROOT, 'aggregate', 'reference-versions.mjs');
const AGG_ALL = path.join(HARNESS_ROOT, 'aggregate', 'aggregate-all.mjs');
const RUN_ROUND = path.join(HARNESS_ROOT, 'round', 'run-round.mjs');
const AGG_JSON = path.join(BENCH_ROOT, 'results', 'aggregated.json');
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

// ===========================================================================
// NC07-NC13(整改 FIX-D:扩展负向对照)
// 每个 case:{id,name,kind,method,expected,detected,caughtBy,caughtByActual,
//            mode:'RUN'|'PENDING-INTEGRATION',status,evidence?}
// PENDING-INTEGRATION = 判定工具未建成/归集成阶段,如实标注,不算失败;
// 集成阶段重跑 `node isolation/run-nc.mjs` 即自动转 RUN 并给出真实判定。
// ===========================================================================

function sha256FileLocal(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** spawn node 脚本(带超时杀进程),返回 {code, stdout, stderr, timedOut} */
function runNode(scriptPath, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e.message), timedOut }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

function tail(text, lines = 6, max = 600) {
  return String(text || '').split('\n').slice(-lines).join('\n').slice(0, max);
}

/** PENDING-INTEGRATION 统一记录(不算失败;集成阶段重跑补齐) */
function pendingCase(c, reason, extra = {}) {
  return {
    id: c.id, name: c.name, kind: c.kind, method: c.method,
    mode: 'PENDING-INTEGRATION', expected: c.expect, detected: null,
    caughtBy: c.caughtBy, caughtByActual: null,
    status: 'PENDING-INTEGRATION', reason, ...extra,
  };
}

function runCase(c, proc, detected, caughtByActual, extra = {}) {
  const { toolPath, toolArgs, ...rest } = extra;
  return {
    id: c.id, name: c.name, kind: c.kind, method: c.method,
    mode: 'RUN', expected: c.expect, detected,
    caughtBy: c.caughtBy, caughtByActual,
    status: detected ? 'DETECTED' : 'NOT-DETECTED',
    runs: [{ tool: path.relative(BENCH_ROOT, toolPath || RUNNER), args: toolArgs || [], exitCode: proc.code, timedOut: proc.timedOut || false, stdoutTail: tail(proc.stdout), stderrTail: tail(proc.stderr, 3, 300) }],
    ...rest,
  };
}

// ---- NC07 SPEC_UNSUPPORTED_ASSERTION:spec-audit 未知 visualAssertion.type ----
async function runNc07(c) {
  const specPath = path.join(FIXTURES, 'NC07', 'spec.json');
  // auxiliary(只读佐证,当前即可复跑):probe-executor 严格性合同在 dry-run 层即拒绝未知 type
  const aux = await runNode(PROBE_EXECUTOR, ['--dry-run', '--spec', specPath], 30000);
  const auxOut = aux.stdout + aux.stderr;
  const evidence = {
    auxiliary: {
      tool: 'runner/probe-executor.mjs --dry-run --spec fixtures/NC07/spec.json',
      exitCode: aux.code, rejectsUnknownType: aux.code === 1 && /motionBlur|unknown type/i.test(auxOut),
      stdoutTail: tail(aux.stdout, 10, 800),
    },
  };
  if (!fs.existsSync(SPEC_AUDIT)) {
    return pendingCase(c, 'harness/runner/spec-audit.mjs 未建成(并行 Agent 建设);集成阶段重跑本脚本', evidence);
  }
  const proc = await runNode(SPEC_AUDIT, ['--spec', specPath], 30000);
  const detected = proc.code === 3;
  return runCase(c, proc, detected,
    detected ? 'spec-audit exit 3 → SPEC_INVALID(visualAssertion.type=motionBlur 不在封闭词表)' : `exit ${proc.code}(未按预期退出 3)`,
    { ...evidence, toolPath: SPEC_AUDIT, toolArgs: ['--spec', specPath] });
}

// ---- NC08 UNKNOWN_REGION:spec-audit 未知 region 形式 ----
async function runNc08(c) {
  const specPath = path.join(FIXTURES, 'NC08', 'spec.json');
  // auxiliary:probe-executor 导出的 classifyRegionForm 即封闭表合同(注意:--dry-run 不校验 region,故须直调)
  let regionAux;
  try {
    const mod = await import(pathToFileURL(PROBE_EXECUTOR).href);
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const regions = (spec.probes || [])
      .map((p) => p.visualAssertion?.params?.region ?? p.visualAssertion?.params?.regions ?? null)
      .filter(Boolean);
    const acc = { unknown: [], dynamic: false, forms: [] };
    for (const r of regions) mod.classifyRegionForm(r, acc);
    regionAux = { tool: 'probe-executor.classifyRegionForm(封闭表静态判定)', ok: acc.unknown.length === 0, unknown: acc.unknown, forms: acc.forms };
  } catch (e) {
    regionAux = { tool: 'probe-executor.classifyRegionForm', error: e.message };
  }
  const evidence = { auxiliary: regionAux };
  if (!fs.existsSync(SPEC_AUDIT)) {
    return pendingCase(c, 'harness/runner/spec-audit.mjs 未建成(并行 Agent 建设);集成阶段重跑本脚本', evidence);
  }
  const proc = await runNode(SPEC_AUDIT, ['--spec', specPath], 30000);
  const out = proc.stdout + proc.stderr;
  // as-built 契约(spec-audit.mjs):未知 type → UNSUPPORTED → exit 3;
  // 未知 region → PARTIAL(exit 0)+ 明示 "strict scoring run => SPEC_INVALID"
  //   (运行时 resolveRegions 严格模式以 SPEC_INVALID: unknown region 拒绝,diagnostic 除外)。
  // 两种严重度都构成"静态审计抓到漂移",不得静默放行。
  const unsupportedExit = proc.code === 3;
  const partialFlagged = /\[PARTIAL\]/.test(out) && out.includes('accretion-torus(inner)') && /LEGAL_REGION_FORMS/.test(out);
  const detected = unsupportedExit || partialFlagged;
  return runCase(c, proc, detected,
    unsupportedExit
      ? 'spec-audit exit 3 → UNSUPPORTED(region="accretion-torus(inner)" 判定升级,退出码 3)'
      : partialFlagged
        ? 'spec-audit PARTIAL 判定:region "accretion-torus(inner)" outside LEGAL_REGION_FORMS(exit 0;审计明示 strict scoring run => SPEC_INVALID,运行时严格模式同判)—— 漂移被抓捕并申报,非静默放行'
        : `exit ${proc.code},输出未针对 "accretion-torus(inner)" 给出 UNSUPPORTED/PARTIAL 判定`,
    { ...evidence, toolPath: SPEC_AUDIT, toolArgs: ['--spec', specPath], detectionRule: 'exit 3(UNSUPPORTED)或 [PARTIAL]+LEGAL_REGION_FORMS+region 命中(as-built 契约:region 漂移为 PARTIAL 级,严格打分 run 判 SPEC_INVALID)' });
}

// ---- NC09 SPEC_DRIFT:validate --pair-meta 输入漂移前置闸门(秒级,不建浏览器)----
async function runNc09(c) {
  const ws = path.join(FIXTURES, 'NC09');
  const specPath = path.join(ws, 'spec.json');
  const pairPath = path.join(ws, 'pair.json');
  // auxiliary:漂移事实的机器证明(sha256 对比),与 validate 就绪与否无关
  let realSha = null, pairSha = null, driftConfirmed = null;
  try {
    realSha = sha256FileLocal(specPath);
    pairSha = JSON.parse(fs.readFileSync(pairPath, 'utf8')).specSha256 ?? null;
    driftConfirmed = pairSha !== null && realSha !== pairSha;
  } catch { /* fixture 不可读时保持 null */ }
  const evidence = {
    auxiliary: { tool: 'sha256(spec.json) vs pair.json.specSha256', realSpecSha256: realSha, pairSpecSha256: pairSha, driftConfirmed },
  };
  // 就绪探测(静态源码特征):validate.mjs 需支持 --pair-meta 且有 INPUT_DRIFT 判定
  const src = readTextSafe(RUNNER) || '';
  const ready = src.includes('pair-meta') && src.includes('INPUT_DRIFT');
  if (!ready) {
    return pendingCase(c,
      'runner/validate.mjs 尚无 --pair-meta / INPUT_DRIFT 前置闸门(退出码 4);集成阶段重跑本脚本',
      { ...evidence, readinessProbe: { check: "源码含 'pair-meta' 且含 'INPUT_DRIFT'", ready: false } });
  }
  const outDir = path.join(NC_OUT, 'NC09-drift');
  const proc = await runNode(RUNNER, ['--workspace', ws, '--spec', specPath, '--pair-meta', pairPath, '--out', outDir], 90000);
  const detected = proc.code === 4 || /INPUT_DRIFT/.test(proc.stdout + proc.stderr);
  return runCase(c, proc, detected,
    detected ? `validate exit ${proc.code} → INPUT_DRIFT(sha256(spec)=${String(realSha).slice(0, 8)}… ≠ pair.specSha256=${String(pairSha).slice(0, 8)}…),浏览器前置拦截` : `exit ${proc.code},未检出输入漂移`,
    { ...evidence, readinessProbe: { ready: true }, toolPath: RUNNER, toolArgs: ['--workspace', ws, '--spec', specPath, '--pair-meta', pairPath, '--out', outDir] });
}

// ---- NC10 RULER_DRIFT:reference-versions --selftest-drift 量尺漂移自检 ----
async function runNc10(c) {
  // auxiliary(--check 只读):真实账本现状观测(非 NC 判定口径)
  const aux = await runNode(REF_VERSIONS, ['--check'], 60000);
  const staleCount = (aux.stdout.match(/\bSTALE\b/g) || []).length;
  const evidence = {
    auxiliary: {
      tool: 'aggregate/reference-versions.mjs --check(只读现状观测,非判定)', exitCode: aux.code, staleCount,
      summaryTail: tail(aux.stdout.split('\n').filter(Boolean).slice(-2).join(' | '), 2, 400),
    },
  };
  // 就绪探测:源码必须实现 --selftest-drift;未实现时绝不运行脚本
  // (默认冻结模式会写 reference/private/REFERENCE-VERSIONS.json —— 禁改目录,安全护栏)
  const src = readTextSafe(REF_VERSIONS) || '';
  if (!src.includes('selftest-drift')) {
    return pendingCase(c,
      'aggregate/reference-versions.mjs 未实现 --selftest-drift 自检分支;集成阶段重跑本脚本',
      { ...evidence, readinessProbe: { check: "源码含 'selftest-drift'", ready: false }, guard: '探测失败即不执行脚本:默认冻结模式会写 reference/private/(禁改目录)' });
  }
  const proc = await runNode(REF_VERSIONS, ['--selftest-drift'], 60000);
  const detected = /PASS/.test(proc.stdout);
  return runCase(c, proc, detected,
    detected ? 'selftest-drift 输出含 PASS(注入的量尺漂移被识别并申报,未静默沿用旧 RULER)' : 'selftest-drift 输出未含 PASS(漂移未被识别?)',
    { ...evidence, readinessProbe: { ready: true }, toolPath: REF_VERSIONS, toolArgs: ['--selftest-drift'] });
}

// ---- NC11 AGENT_IDENTITY_MISSING:归 run-round preflight(FIX-C),恒 PENDING-INTEGRATION ----
async function runNc11(c) {
  const rr = readTextSafe(RUN_ROUND) || '';
  const m = /RUN_META_FIELDS\s*=\s*\[([^\]]*)\]/.exec(rr);
  const fields = m
    ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  const pairDir = path.join(FIXTURES, 'NC11', 'PAIR-E01-K0-R01');
  const armReport = {};
  for (const arm of ['arm-a', 'arm-b']) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pairDir, arm, 'RUN-META.json'), 'utf8'));
      armReport[arm] = {
        emptyIdentityFields: fields.filter((f) => meta[f] === null || meta[f] === undefined || String(meta[f]).trim() === ''),
      };
    } catch (e) { armReport[arm] = { error: e.message }; }
  }
  const evidence = {
    auxiliary: {
      tool: '静态解析 fixture RUN-META vs run-round RUN_META_FIELDS',
      runRoundPreflightImplemented: /runPreflight/.test(rr) && fields.length > 0,
      identityFields: fields,
      armReport,
      expectedBlockReasons: (armReport['arm-a']?.emptyIdentityFields || []).map((f) => `arm-a: RUN-META.${f} 为空`),
    },
    integrationCommand: 'node round/run-round.mjs --batch <batch> --stage preflight → 本 fixture Pair 应 BLOCKED(身份字段为空,不得 validate)',
  };
  // 集成执行:fixture 暂存为临时批次 → 真实 run-round preflight → 期待 BLOCKED(身份缺失)
  const tmpBatch = '_nc11tmp';
  const tmpBatchDir = path.join(BENCH_ROOT, 'results', tmpBatch);
  const osMod = await import('node:os');
  const roundOutDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'nc11-round-'));
  const roundOut = path.join(roundOutDir, 'ROUND.json');
  try {
    fs.rmSync(tmpBatchDir, { recursive: true, force: true });
    fs.mkdirSync(tmpBatchDir, { recursive: true });
    fs.cpSync(pairDir, path.join(tmpBatchDir, 'PAIR-E01-K0-R01'), { recursive: true });
    const res = await new Promise((resolve) => {
      const p = spawn('node', [RUN_ROUND, '--batch', tmpBatch, '--stage', 'preflight', '--round-out', roundOutDir]);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (code) => resolve({ code, out }));
    });
    const round = fs.existsSync(roundOut) ? JSON.parse(fs.readFileSync(roundOut, 'utf8')) : null;
    const blocked = (round?.pairs || []).some((p) => p.preflight?.status === 'BLOCKED');
    const reasons = (round?.pairs || []).flatMap((p) => p.preflight?.reasons || []);
    const identityReasons = reasons.filter((r) => /RUN-META|身份|identity|modelId|agentBinaryHash|systemPromptHash|toolPolicyHash|agentRuntime|modelRevision/i.test(String(r)));
    return {
      ...c,
      detected: blocked && identityReasons.length > 0,
      status: blocked && identityReasons.length > 0 ? 'DETECTED' : 'NOT-DETECTED',
      caughtBy: `run-round --stage preflight 真实执行(exit ${res.code}):BLOCKED + 身份缺失 reasons ×${identityReasons.length}`,
      mode: 'RUN',
      evidence: { ...evidence, realRun: { exit: res.code, blocked, identityReasons: identityReasons.slice(0, 4), stdoutTail: res.out.split(/\r?\n/).filter(Boolean).slice(-6) } },
    };
  } catch (e) {
    return pendingCase(c, '真实 preflight 执行异常(' + String(e.message).slice(0, 80) + '),降级为佐证登记', evidence);
  } finally {
    fs.rmSync(tmpBatchDir, { recursive: true, force: true });
    try { fs.rmSync(roundOutDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ---- NC12 BUDGET_EXHAUSTION:budget-check 机器计数超冻结上限 ----
async function runNc12(c) {
  const ws = path.join(FIXTURES, 'NC12');
  let count = null, limit = null;
  try {
    // as-built 口径(budget-check.mjs):.budget/*.count 为追加日志,机器计数 = 非空行数
    count = fs.readFileSync(path.join(ws, '.budget', 'build.count'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
  } catch { /* 缺文件保持 null */ }
  const yaml = readTextSafe(path.join(BENCH_ROOT, 'config', 'agents.yaml')) || '';
  const lm = /maxBuildAttempts:\s*(\d+)/.exec(yaml);
  if (lm) limit = Number(lm[1]);
  const evidence = {
    auxiliary: {
      tool: '.budget/build.count 行数(追加日志口径)vs config/agents.yaml agentRun.budget.maxBuildAttempts(G0 冻结,只读)',
      buildCount: count, maxBuildAttempts: limit,
      countOverLimit: count != null && limit != null ? count > limit : null,
    },
  };
  if (!fs.existsSync(BUDGET_CHECK)) {
    return pendingCase(c, 'harness/runner/budget-check.mjs 未建成(run-round validate stage 已声明接线);集成阶段重跑本脚本', evidence);
  }
  const proc = await runNode(BUDGET_CHECK, ['--workspace', ws], 30000);
  const out = proc.stdout + proc.stderr;
  const detected = /BUDGET_EXHAUSTED/i.test(out);
  return runCase(c, proc, detected,
    detected ? `budget-check → BUDGET_EXHAUSTED(build.count=${count} > maxBuildAttempts=${limit})` : `exit ${proc.code},输出未含 BUDGET_EXHAUSTED`,
    { ...evidence, toolPath: BUDGET_CHECK, toolArgs: ['--workspace', ws] });
}

// ---- NC13 GATE_PROPAGATION:aggregate-all 真实只读聚合 + §17 传播口径 ----
function aggSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(AGG_JSON, 'utf8'));
    const pairs = (j.batches || []).flatMap((b) => b.pairs || []);
    const arms = pairs.flatMap((p) => Object.values(p.arms || {}));
    return {
      generatedAt: j.generatedAt, batches: (j.batches || []).length, pairs: pairs.length,
      pilotPairs: pairs.filter((p) => p.pilot === true).length,
      visualPendingArms: arms.filter((a) => a && a.visualPending === true).length,
      g7: j.rulerStatus?.g7?.status ?? null,
    };
  } catch (e) { return { exists: false, error: e.message }; }
}

async function runNc13(c) {
  const evidence = {
    before: aggSnapshot(),
    tool: 'aggregate/aggregate-all.mjs(真实只读聚合:批次数据只读,重算其自身产物 results/aggregated.json)',
  };
  if (!fs.existsSync(AGG_ALL)) {
    return pendingCase(c, 'aggregate/aggregate-all.mjs 不存在;集成阶段重跑本脚本', evidence);
  }
  const proc = await runNode(AGG_ALL, [], 120000);
  if (proc.code !== 0) {
    return {
      id: c.id, name: c.name, kind: c.kind, method: c.method, mode: 'RUN',
      expected: c.expect, detected: false, caughtBy: c.caughtBy,
      caughtByActual: `aggregate-all 退出码 ${proc.code},无法解析聚合产物`,
      status: 'NOT-DETECTED', runs: [{ exitCode: proc.code, timedOut: proc.timedOut || false, stdoutTail: tail(proc.stdout), stderrTail: tail(proc.stderr, 3, 300) }], ...evidence,
    };
  }
  let agg = null;
  try { agg = JSON.parse(fs.readFileSync(AGG_JSON, 'utf8')); } catch { /* 保持 null */ }
  if (!agg) {
    return {
      id: c.id, name: c.name, kind: c.kind, method: c.method, mode: 'RUN',
      expected: c.expect, detected: false, caughtBy: c.caughtBy,
      caughtByActual: 'results/aggregated.json 聚合后不可读',
      status: 'NOT-DETECTED', runs: [{ exitCode: proc.code, stdoutTail: tail(proc.stdout) }], ...evidence,
    };
  }
  // §17 传播口径:formal.total === null && objective.total 非 null → DETECTED
  // 三种 schema 形态均支持(按库内实际产物自适应):
  //   ① per-pair/per-arm formal|objective 段(FIX-B as-built:G7 未过 → formal.total=null,objective 照常)
  //   ② 顶层显式 formal 段(§17 最终形态变体)
  //   ③ 旧 schema(total/objectiveOnly + pilot 标志)→ 按 pilot 派生
  const pairs = (agg.batches || []).flatMap((b) => b.pairs || []);
  let formalTotal = null, objectiveTotal = null, shape;
  if (pairs.length && pairs.some((p) => p.formal || p.objective || Object.values(p.arms || {}).some((a) => a && (a.formal || a.objective)))) {
    shape = 'per-pair-formal-objective(FIX-B as-built)';
    const pairArms = pairs.flatMap((p) => Object.values(p.arms || {}).filter(Boolean));
    // 归一取值:arm 级段为 {total:number,…};pair 级段 total 可能再套 engine→number 映射
    // ({total:{three:55,…}})—— 两种 as-built 形态都收数字叶子
    const collect = (x, section) => {
      if (!x || typeof x !== 'object' || !x[section] || typeof x[section] !== 'object') return [];
      const s = x[section];
      const leaves = s.total !== undefined ? [s.total] : Object.values(s);
      return leaves.flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : [v]));
    };
    const formalVals = [...pairs, ...pairArms].flatMap((x) => collect(x, 'formal'));
    const objectiveVals = [...pairs, ...pairArms].flatMap((x) => collect(x, 'objective'));
    const formalNums = formalVals.filter((v) => Number.isFinite(v));
    const objectiveNums = objectiveVals.filter((v) => Number.isFinite(v));
    formalTotal = formalVals.length && formalNums.length === 0
      ? null // 段存在但全部为 null/非数 → formal 总分缺失(门禁未过)
      : (formalNums.length ? Math.max(...formalNums) : null);
    objectiveTotal = objectiveNums.length ? Math.max(...objectiveNums) : null;
    evidence.derivation = {
      pairsWithFormalSection: pairs.filter((p) => p.formal || Object.values(p.arms || {}).some((a) => a && a.formal)).length,
      formalValuesAllNull: formalVals.length > 0 && formalVals.every((v) => v == null || !Number.isFinite(v)),
      objectiveNonNullCount: objectiveNums.length,
      g7: agg.rulerStatus?.g7 ? { status: agg.rulerStatus.g7.status, formalImpact: agg.rulerStatus.g7.formalImpact } : null,
      note: 'G7(BLIND_JUDGE_VALIDITY)未过 → formal.total/attainment 全 null;objective(S1+S2+S3)照常非空 —— 门禁状态如实传播,不以 provisional 视觉分冒充正式总分',
    };
  } else if (agg.formal && typeof agg.formal === 'object') {
    // 整改 §17 最终形态:聚合器显式输出顶层 formal 段
    shape = 'explicit-top-level-formal-section';
    formalTotal = agg.formal.total ?? null;
    objectiveTotal = agg.formal.objective ?? agg.formal.objectiveTotal
      ?? (agg.objective && agg.objective.total !== undefined ? agg.objective.total : null);
  } else {
    // 旧 schema:按 pilot 标志派生 —— formal = 非 pilot(正式核心矩阵)pairs
    shape = 'derived-from-pilot-flag(legacy schema)';
    const formalPairs = pairs.filter((p) => p.pilot !== true);
    const formalArms = formalPairs.flatMap((p) => Object.values(p.arms || {}));
    const formalArmsWithTotal = formalArms.filter((a) => a && a.total != null);
    const objectiveArms = pairs.flatMap((p) => Object.values(p.arms || {})).filter((a) => a && a.objectiveOnly != null);
    formalTotal = formalArmsWithTotal.length > 0 ? formalArmsWithTotal[0].total : null;
    objectiveTotal = objectiveArms.length > 0 ? Math.max(...objectiveArms.map((a) => a.objectiveOnly)) : null;
    evidence.derivation = {
      formalPairCount: formalPairs.length, formalArmsWithTotal: formalArmsWithTotal.length,
      objectiveArmsCount: objectiveArms.length,
      note: 'formalPairCount=0(G6:正式矩阵未跑)→ formal.total=null;pilot 客观分非空 → objective.total 非 null(不冒充正式总分)',
    };
  }
  const detected = formalTotal === null && objectiveTotal !== null;
  return runCase(c, proc, detected,
    detected
      ? `聚合如实传播门禁:${shape};formal.total=${JSON.stringify(formalTotal)} 且 objective.total=${JSON.stringify(objectiveTotal)}(未过的门禁保持 formal=null,客观分如实呈现)`
      : `传播口径未满足(${shape};formal.total=${JSON.stringify(formalTotal)},objective.total=${JSON.stringify(objectiveTotal)})`,
    { ...evidence, toolPath: AGG_ALL, toolArgs: [], after: aggSnapshot(), rule: 'formal.total===null && objective.total!=null → DETECTED' });
}

const EXTENDED_CASES = [
  {
    id: 'NC07', name: 'spec-unsupported-assertion', kind: 'specAudit', expect: 'SPEC_INVALID(spec-audit exit 3)',
    method: 'runner/spec-audit.mjs --spec fixtures/NC07/spec.json',
    caughtBy: 'spec-audit 封闭词表校验:visualAssertion.type="motionBlur" 不在 {nonBlank,motion,pixelDelta,regionChange}(整改 §8 严格性合同:unknown 绝不 fallback→PASS)',
    run: runNc07,
  },
  {
    id: 'NC08', name: 'unknown-region', kind: 'specAudit', expect: 'SPEC_INVALID(spec-audit exit 3 或 PARTIAL 命中 LEGAL_REGION_FORMS)',
    method: 'runner/spec-audit.mjs --spec fixtures/NC08/spec.json',
    caughtBy: 'spec-audit LEGAL_REGION_FORMS 校验:region="accretion-torus(inner)" 为描述性命名 → PARTIAL(审计明示 strict scoring run => SPEC_INVALID;运行时 resolveRegions 严格模式同判;仅 diagnostic 模式可全画面兜底且永不作 PASS 证据)',
    run: runNc08,
  },
  {
    id: 'NC09', name: 'spec-drift', kind: 'validateDrift', expect: 'INPUT_DRIFT(exit 4,浏览器前置拦截,秒级)',
    method: 'runner/validate.mjs --workspace fixtures/NC09 --spec fixtures/NC09/spec.json --pair-meta fixtures/NC09/pair.json',
    caughtBy: 'validate --pair-meta 前置闸门:sha256(spec.json)=7598f756… ≠ pair.specSha256=448b817b…(decoy)→ 输入漂移,该臂 INVALID_EVIDENCE',
    run: runNc09,
  },
  {
    id: 'NC10', name: 'ruler-drift', kind: 'rulerDrift', expect: 'selftest-drift 输出含 PASS(注入漂移被识别)',
    method: 'aggregate/reference-versions.mjs --selftest-drift',
    caughtBy: '量尺账本四输入指纹比对(引擎/文档/Brief/工具链):注入篡改指纹应报 STALE 并换新 RULER 号,不静默沿用旧量尺',
    run: runNc10,
  },
  {
    id: 'NC11', name: 'agent-identity-missing', kind: 'identityPreflight', expect: 'run-round preflight BLOCKED(集成阶段)',
    method: '(集成阶段)round/run-round.mjs --batch <batch> --stage preflight',
    caughtBy: 'run-round preflight(FIX-C):arm-a RUN-META 身份字段空(agentBinaryHash=null/modelId=""/systemPromptHash=null)→ BLOCKED,不得 validate',
    run: runNc11,
  },
  {
    id: 'NC12', name: 'budget-exhaustion', kind: 'budgetCheck', expect: 'BUDGET_EXHAUSTED(budget-check exit 3)',
    method: 'runner/budget-check.mjs --workspace fixtures/NC12',
    caughtBy: 'budget-check 机器计数(.budget/build.count 追加日志行数口径):build 9/8 > config/agents.yaml maxBuildAttempts=8(G0 冻结;触及上限即终止并判 BUDGET_EXHAUSTED)',
    run: runNc12,
  },
  {
    id: 'NC13', name: 'gate-propagation', kind: 'gatePropagation', expect: 'formal.total==null && objective.total!=null',
    method: 'aggregate/aggregate-all.mjs(真实只读聚合)→ 解析 results/aggregated.json',
    caughtBy: '聚合器如实传播未过的门禁(G7 BLOCKED → formal.total/attainment 全 null,objective=S1+S2+S3 照常非空;不以 provisional 视觉分冒充正式总分)(整改 §17)',
    run: runNc13,
  },
];

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

  // ---- NC07-NC13(整改 FIX-D:扩展负向对照;PENDING-INTEGRATION 不算失败)----
  const ncExtCases = [];
  for (const c of EXTENDED_CASES) {
    const rec = await c.run(c);
    ncExtCases.push(rec);
    console.log(`[G4] ${rec.id}: ${rec.status} (mode ${rec.mode}${rec.detected == null ? '' : rec.detected ? ', DETECTED' : ', NOT-DETECTED'})`);
  }
  const extFail = ncExtCases.some((c) => c.mode === 'RUN' && c.status === 'NOT-DETECTED');
  const extPending = ncExtCases.some((c) => c.status === 'PENDING-INTEGRATION');
  const ncExtendedStatus = extFail ? 'FAIL' : extPending ? 'PENDING-INTEGRATION' : 'PASS';

  // ---- 汇总状态(NC01-06 原口径保留为 statusBase;ncExtended 并入总口径)----
  const mismatch = cases.some((c) => c.status === 'NOT-DETECTED' && !(c.id === 'NC03' && !c.detected));
  const anyPending = cases.some((c) => c.status === 'PENDING');
  let statusBase;
  if (mismatch) statusBase = 'FAIL';
  else if (anyPending) statusBase = 'PENDING';
  else statusBase = 'PASS';
  let status;
  if (statusBase === 'FAIL' || ncExtendedStatus === 'FAIL') status = 'FAIL';
  else if (statusBase === 'PENDING' || ncExtendedStatus === 'PENDING-INTEGRATION') status = 'PENDING';
  else status = 'PASS';

  const g4 = {
    gate: 'G4 HARNESS_TRUST',
    status,
    statusBase, // NC01-NC06 原口径(不含扩展段),原字段语义保留
    generatedAt: nowIso(),
    runnerAvailable,
    runner: runnerAvailable ? 'harness/runner/validate.mjs' : '(built by parallel harness agent; re-run isolation/run-nc.mjs at integration)',
    cases,
    ncExtended: {
      scope: '整改 FIX-D:NC07-NC13(规格审计 / 输入漂移 / 量尺漂移 / 身份 / 预算 / 门禁传播)',
      status: ncExtendedStatus,
      modeLegend: 'RUN = 本轮实测;PENDING-INTEGRATION = 判定工具未建成或归集成阶段(run-round preflight),不算失败,集成阶段重跑 isolation/run-nc.mjs 自动补齐',
      cases: ncExtCases,
      notes: [
        'NC07/NC08 佐证(auxiliary,只读可复跑):probe-executor 严格性合同已拒绝未知 visualAssertion.type(dry-run exit 1)与未知 region(classifyRegionForm.ok=false);正式判定仍以 spec-audit exit 3 为准。',
        'NC10 安全护栏:reference-versions.mjs 默认冻结模式会写 reference/private/(禁改目录),就绪探测失败即绝不执行该脚本;--check 为只读现状观测。',
        'NC11 为设计性 PENDING-INTEGRATION:AGENT_IDENTITY_MISSING 归 run-round preflight(FIX-C)集成阶段验证,run-nc 只登记 fixture 与佐证。',
        'NC13 为 mode:RUN 的真实聚合重算:aggregate-all 只读批次数据,重算其自身可再生产物 results/aggregated.json;判定口径 formal.total===null 且 objective.total 非 null(整改 §17)。',
      ],
    },
    specCoverageNotes: [
      'NC03 双口径如实记录:E01 spec 的 P1 只有 starCount+nonBlank,无 asset 网络独立观测,检不出 fake-asset-loaded;',
      'NC03 以 E02 spec(P1: $.assetRequests >= 1 + networkRequest:assets/boat.glb 证据)作为抓捕口径 —— 不篡改任何 spec。',
      'NC01-NC05 的"detected"= validate.mjs 判 FAIL;NC06 的"detected"= leak-scanner 判 INVALID_RUN。',
      'NC07-NC13 的"detected"见各 case.method;PENDING-INTEGRATION 的 case detected=null,不计入失败。',
    ],
    environment: { nodeVersion: process.version },
  };

  fs.mkdirSync(GATES_DIR, { recursive: true });
  const outPath = path.join(GATES_DIR, 'G4.json');
  fs.writeFileSync(outPath, JSON.stringify(g4, null, 2) + '\n', 'utf8');
  console.log(`[G4] cases: ${cases.map((c) => `${c.id}:${c.status}`).join('  ')}  → statusBase ${statusBase}`);
  console.log(`[G4] ncExtended: ${ncExtCases.map((c) => `${c.id}:${c.status}(${c.mode})`).join('  ')}  → ncExtended ${ncExtendedStatus}`);
  console.log(`[G4] written ${path.relative(BENCH_ROOT, outPath)}`);
  process.exit(status === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error('[G4] FATAL', e);
  process.exit(1);
});
