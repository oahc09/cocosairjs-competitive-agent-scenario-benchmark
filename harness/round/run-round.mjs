#!/usr/bin/env node
// round/run-round.mjs — 一轮实验的触发状态机(外部 AI Agent 可直接驱动的唯一入口)
// ---------------------------------------------------------------------------
// 设计:一轮 = 一个批次目录 + 一个 ROUND.json 状态文件。所有阶段幂等,可断点续跑,
//       可被任何 Agent/人用同一条命令反复推进;唯一的外部依赖是"执行 DISPATCH.md 里的
//       Agent Run 任务"(需要真正的 agent runtime,其余全部机械化)。
//
// 用法:
//   node round/run-round.mjs --plan <planFile.json|--matrix "E01,E02|K0,K1|R01,R02"> [--batch auto]
//        stage: create     建 Pair(coordinator)+ 写 ROUND.json + 生成 DISPATCH.md
//   node round/run-round.mjs --batch <id> --stage preflight
//        身份/冻结一致性门禁(FIX-C):各臂 RUN-META.json 存在且身份字段非空、两臂身份与
//        预算一致(仅 engine/knowledge/template 允许不同)、arm spec.json sha==pair.specSha256;
//        不过 → pairs[i].preflight={status:'BLOCKED',reasons[]},该 Pair 不得 validate
//   node round/run-round.mjs --batch <id> --stage collect
//        扫描各臂 RESULT.md 完成标记,汇报 pending
//   node round/run-round.mjs --batch <id> --stage validate [--force]
//        开头自动执行 preflight;对"已完成且未验证"且未被 BLOCKED 的臂串行跑
//        validate.mjs(以 arm 内 spec.json 冻结副本为 --spec,传 --pair-meta pair.json)
//        + leak-scanner + budget-check(机器计数超限 → classification 覆盖 BUDGET_EXHAUSTED;
//        validate 报 INPUT_DRIFT/ENV_DRIFT → 该臂标 INVALID_EVIDENCE)(--force 全部重验)
//   node round/run-round.mjs --batch <id> --stage blind
//        build-blind 生成盲评材料 + JUDGE-INSTRUCTIONS.md;已存在 visual-scores.json 则标记就绪
//   node round/run-round.mjs --batch <id> --stage aggregate
//        aggregate-all 全量聚合(视觉分缺失的臂如实标 visualPending)
//   node round/run-round.mjs --batch <id> --stage status
//        打印本轮仪表盘(各臂状态/各阶段时间线)
//   [--round-out <dir>] 演练专用:ROUND.json 读写重定向到 <dir>(pair/spec/RUN-META 证据
//        仍只读真实批次目录),供 preflight BLOCKED 演练不触碰 results/ 已有内容。
//
// 状态机(ROUND.json):
//   pair.arm.state: created → dispatched(标记) → completed(RESULT.md) → validated
//   pair.preflight: { status: PASS|BLOCKED, reasons[] }(preflight/validate stage 写入)
//   stages: {create, preflight, collect, validate, blind, aggregate} 各记 lastRunAt/summary
// 零依赖(validate/budget-check 等 harness 模块除外)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readBudgetCounts, readLimits, checkBudget } from '../runner/budget-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARN = path.resolve(__dirname, '..');              // bench/harness
const BENCH = path.resolve(HARN, '..');                  // bench
const RESULTS = path.join(BENCH, 'results');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// AIR 引擎指纹:K0 tarball 路径优先取 vendor/engine-versions.json 登记值(换引擎只改注册表),历史文件名兜底
function airTarballFingerprint() {
  let rel = 'vendor/cocosair.js-1.0.0-k0.tgz';
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(BENCH, 'vendor', 'engine-versions.json'), 'utf8'));
    const e = reg.engines && reg.engines.cocosair;
    const v = e && e.versions && e.versions[e.activeVersion];
    if (v && v.k0Tarball) rel = v.k0Tarball;
  } catch { /* 注册表缺失/损坏时沿用历史文件名 */ }
  return { tarball: rel, sha256: sha(path.join(BENCH, ...rel.split('/'))) };
}
const iso = () => new Date().toISOString();
const die = (m) => { console.error('[run-round] ERROR: ' + m); process.exit(1); };
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (k) => process.argv.includes('--' + k);

// ---------- plan 解析 ----------
function parsePlan() {
  const planFile = arg('plan');
  if (planFile && fs.existsSync(planFile)) return JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const matrix = arg('matrix');
  if (!matrix) return null;
  // --matrix "E01,E02|K0,K1|R01" 简式
  const m = matrix.split('|').map(s => s.split(',').map(x => x.trim()).filter(Boolean));
  const [scenes, knows, reps] = m;
  if (!scenes || !knows || !reps) die('--matrix 格式: "E01,E02|K0,K1|R01,R02"');
  const pairs = [];
  for (const k of knows) for (const r of reps) for (const s of scenes) pairs.push({ scene: s, knowledge: k, rep: r });
  return { pairs };
}

// ---------- ROUND.json 读写 ----------
// --round-out <dir>:演练专用重定向(见文件头用法);生产路径不变。
const ROUND_OUT_DIR = arg('round-out');
const roundPath = (batch) => (ROUND_OUT_DIR ? path.join(ROUND_OUT_DIR, 'ROUND.json') : path.join(RESULTS, batch, 'ROUND.json'));
const loadRound = (batch) => JSON.parse(fs.readFileSync(roundPath(batch), 'utf8'));
const saveRound = (r) => { r.updatedAt = iso(); const f = roundPath(r.batchId); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(r, null, 2) + '\n'); };

function armStateFile(batch, pairId, armDir) { return path.join(RESULTS, batch, pairId, armDir); }

// ---------- stage: create ----------
function stageCreate() {
  const roundTrack = arg('track') || null;
  const plan = parsePlan();
  if (!plan) die('create 需要 --plan <file|--matrix>');
  let batchArg = arg('batch') || 'auto';
  for (const p of plan.pairs) {
    const args = ['--scene', p.scene, '--knowledge', p.knowledge, '--rep', p.rep, '--batch', batchArg];
    if (p.track || roundTrack) args.push('--track', p.track || roundTrack); // P0-1:track 链透传(显式必须,core 才进正式统计)
    if (p.pilot) args.push('--pilot');
    if (p.armSwap) args.push('--arm-swap');
    const res = spawnSync('node', [path.join(HARN, 'coordinator', 'create-pair.mjs'), ...args], { encoding: 'utf8' });
    if (res.status !== 0) die('coordinator 失败:\n' + res.stdout + res.stderr);
    const m = /"pairId":\s*"([^"]+)"[\s\S]*?"batchId":\s*"([^"]+)"/.exec(res.stdout) || [];
    const pairId = m[1], batchId = m[2];
    if (batchArg === 'auto') batchArg = batchId; // auto:首个 pair 定批次,后续同批
    if (!global.__batch) global.__batch = batchId;
    else if (global.__batch !== batchId) die('多批次混入(不应发生)');
    global.__pairs = (global.__pairs || []).concat([{ ...p, track: p.track || roundTrack, pairId, batchId }]);
  }
  const batch = global.__batch;
  const round = {
    batchId: batch, createdAt: iso(), updatedAt: iso(),
    plan: { source: arg("plan") || ("--matrix " + arg("matrix")), pairs: global.__pairs },
    engine: {
      three: { version: JSON.parse(fs.readFileSync(path.join(BENCH, 'node_modules/three/package.json'))).version },
      cocosair: airTarballFingerprint(),
    },
    pairs: global.__pairs.map(p => ({
      pairId: p.pairId,
      arms: { 'arm-a': { state: 'created' }, 'arm-b': { state: 'created' } },
    })),
    stages: {},
    notes: ['Agent Run 执行说明见同目录 DISPATCH.md;执行完毕后依次 --stage collect/validate/blind/aggregate'],
  };
  fs.mkdirSync(path.join(RESULTS, batch), { recursive: true });
  saveRound(round);
  writeDispatch(round);
  console.log(`[create] batch=${batch} pairs=${round.plan.pairs.length} → results/${batch}/{ROUND.json,DISPATCH.md}`);
}

// ---------- DISPATCH.md(外部 Agent Runner 的执行载荷) ----------
function writeDispatch(round) {
  const lines = [`# DISPATCH — 批次 ${round.batchId} 的 Agent Run 任务清单`, '',
    '> 执行者:任意 AI Agent 运行时(或人)。规则:同一 Pair 的两臂**同批启动**(时差 ≤30s,记录实际时间);',
    '> 每个 Arm 用**全新会话**执行下列提示词(仅工作目录不同);执行期间禁止读取 bench/ 其余目录;',
    '> 派发前:Runner 把各 Arm 目录的 RUN-META.template.json 复制为 RUN-META.json 并填写全部身份字段',
    '> (两臂同值,engine/knowledge 除外)—— run-round 的 preflight stage 会校验,缺失/BLOCKED 的 Pair 不得 validate;',
    '> 全部臂完成后运行 `node harness/round/run-round.mjs --batch ${round.batchId} --stage collect`。', ''];
  for (const p of round.plan.pairs) {
    lines.push(`## ${p.pairId}`);
    for (const arm of ['a', 'b']) {
      const dir = path.join(RESULTS, round.batchId, p.pairId, 'arm-' + arm);
      lines.push(`### arm-${arm}(\`${path.relative(BENCH, dir)}\`)`,
        '```', `你是双引擎对照实验中的一个 Agent Run。你的唯一任务指令:严格执行工作目录中的 RUN-CONTRACT.md。`,
        '', `工作目录:${dir}`, '',
        `流程:先读 RUN-CONTRACT.md 全文(身份/预算/白名单/红线/完成合同/日志/交付),再读同目录 brief.md 与 spec.json,`,
        `然后在 workspace/ 内实现场景、自检、写 WORKLOG.md 与 RESULT.md。预算与红线以合同为准。`,
        `这是一次性 R0 自主模式:尽力交付满足完成合同的完整实现。`, '```', '');
    }
  }
  fs.writeFileSync(path.join(RESULTS, round.batchId, 'DISPATCH.md'), lines.join('\n'));
}

// ---------- stage: collect ----------
function stageCollect(round) {
  let done = 0, pending = [];
  for (const p of round.pairs) {
    for (const arm of ['arm-a', 'arm-b']) {
      const d = armStateFile(round.batchId, p.pairId, arm);
      const completed = fs.existsSync(path.join(d, 'RESULT.md'));
      if (completed) {
        if (p.arms[arm].state === 'created') p.arms[arm].state = 'completed';
        done++;
      } else pending.push(`${p.pairId}/${arm}`);
    }
  }
  round.stages.collect = { lastRunAt: iso(), completed: `${done}/${round.pairs.length * 2}`, pending };
  saveRound(round);
  console.log(`[collect] 完成 ${done}/${round.pairs.length * 2}` + (pending.length ? `;未完成: ${pending.join(', ')}` : ' — 全部就绪,可进入 validate'));
}

// ---------- stage: preflight(FIX-C 身份/冻结一致性门禁) ----------
// RUN-META 身份字段全集(与 coordinator 写出的 RUN-META.template.json 一一对应)
const RUN_META_FIELDS = ['agentRuntime', 'agentBinaryHash', 'modelId', 'modelRevision', 'systemPromptHash', 'toolPolicyHash', 'runnerVersion'];
// 两臂必须一致的字段(engine/knowledge/template 天然允许不同,不在 RUN-META 内)
const RUN_META_CONSISTENCY_FIELDS = ['agentRuntime', 'modelId', 'modelRevision', 'systemPromptHash', 'toolPolicyHash'];

function readRunMeta(armDir) {
  const p = path.join(armDir, 'RUN-META.json');
  if (!fs.existsSync(p)) return { missing: true };
  try {
    return { meta: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { error: e.message };
  }
}

/** 解析 RUN-CONTRACT §2 预算表(表行格式为模板冻结契约;解析不出 → null)。 */
function parseContractBudget(contractText) {
  const row = (label) => {
    const m = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)`).exec(contractText);
    return m ? Number(m[1]) : null;
  };
  const b = {
    maxToolCalls: row('工具调用次数'),
    maxWallTimeMinutes: row('墙钟时间'),
    maxBuildAttempts: row('build 尝试次数'),
    maxBrowserAttempts: row('浏览器验证尝试次数'),
  };
  return Object.values(b).every((v) => Number.isFinite(v)) ? b : null;
}

function runPreflight(round) {
  for (const p of round.pairs) {
    const pairDir = path.join(RESULTS, round.batchId, p.pairId);
    const reasons = [];
    let pj = null;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(pairDir, 'pair.json'), 'utf8'));
    } catch (e) {
      reasons.push(`pair.json 不可读: ${e.message}`);
    }
    // ① 各臂 RUN-META.json 存在且身份字段非空
    const metas = {};
    for (const arm of ['arm-a', 'arm-b']) {
      const armDir = path.join(pairDir, arm);
      const r = readRunMeta(armDir);
      if (r.missing) reasons.push(`${arm}: RUN-META.json 缺失(派发前须由 Runner 复制 RUN-META.template.json 填写)`);
      else if (r.error) reasons.push(`${arm}: RUN-META.json 解析失败: ${r.error}`);
      else {
        metas[arm] = r.meta;
        for (const f of RUN_META_FIELDS) {
          const v = r.meta[f];
          if (v === null || v === undefined || String(v).trim() === '') reasons.push(`${arm}: RUN-META.${f} 为空`);
        }
      }
      // ② arm 内 spec.json 冻结副本哈希 == pair.specSha256(活 briefs 漂移在此检出)
      const specCopy = path.join(armDir, 'spec.json');
      if (!fs.existsSync(specCopy)) reasons.push(`${arm}: spec.json 冻结副本缺失`);
      else if (pj?.specSha256 && sha(specCopy) !== pj.specSha256) reasons.push(`${arm}: spec.json 冻结副本 sha256 ≠ pair.specSha256(规格被改动?)`);
    }
    // ③ 两臂身份一致(测量仪器恒定:仅 engine/knowledge/template 允许不同)
    if (metas['arm-a'] && metas['arm-b']) {
      for (const f of RUN_META_CONSISTENCY_FIELDS) {
        if (metas['arm-a'][f] !== metas['arm-b'][f]) {
          reasons.push(`两臂 RUN-META.${f} 不一致(arm-a=${JSON.stringify(metas['arm-a'][f]) ?? 'null'}, arm-b=${JSON.stringify(metas['arm-b'][f]) ?? 'null'})`);
        }
      }
    }
    // ④ 两臂预算一致,且与 pair.json 冻结预算一致(预算漂移 = Pair 失效,agents.yaml driftPolicy)
    const contractBudgets = {};
    for (const arm of ['arm-a', 'arm-b']) {
      const c = path.join(pairDir, arm, 'RUN-CONTRACT.md');
      contractBudgets[arm] = fs.existsSync(c) ? parseContractBudget(fs.readFileSync(c, 'utf8')) : null;
    }
    if (!contractBudgets['arm-a'] || !contractBudgets['arm-b']) {
      reasons.push('RUN-CONTRACT §2 预算段缺失或不可解析');
    } else if (JSON.stringify(contractBudgets['arm-a']) !== JSON.stringify(contractBudgets['arm-b'])) {
      reasons.push(`两臂 RUN-CONTRACT 预算不一致(a=${JSON.stringify(contractBudgets['arm-a'])}, b=${JSON.stringify(contractBudgets['arm-b'])})`);
    } else if (pj?.budget) {
      const want = {
        maxToolCalls: pj.budget.maxToolCalls, maxWallTimeMinutes: pj.budget.maxWallTimeMinutes,
        maxBuildAttempts: pj.budget.maxBuildAttempts, maxBrowserAttempts: pj.budget.maxBrowserAttempts,
      };
      if (JSON.stringify(contractBudgets['arm-a']) !== JSON.stringify(want)) {
        reasons.push(`RUN-CONTRACT 预算与 pair.json 冻结预算不一致(contract=${JSON.stringify(contractBudgets['arm-a'])}, pair=${JSON.stringify(want)})`);
      }
    }
    const status = reasons.length ? 'BLOCKED' : 'PASS';
    p.preflight = { status, reasons, checkedAt: iso() };
    console.log(`[preflight] ${p.pairId}: ${status}` + (reasons.length ? `\n           - ${reasons.join('\n           - ')}` : ''));
  }
  const blocked = round.pairs.filter((p) => p.preflight?.status === 'BLOCKED').map((p) => p.pairId);
  round.stages.preflight = { lastRunAt: iso(), summary: blocked.length ? 'BLOCKED' : 'PASS', blocked, pairs: round.pairs.length };
  return round.stages.preflight;
}

function stagePreflight(round) {
  runPreflight(round);
  saveRound(round);
  const b = round.stages.preflight;
  console.log(`[preflight] ${b.pairs} 个 pair:${b.summary}` + (b.blocked.length ? `;BLOCKED(不得 validate): ${b.blocked.join(', ')}` : ''));
}

// ---------- stage: validate ----------
function stageValidate(round, force) {
  // FIX-C:validate 开头自动执行 preflight —— BLOCKED 的 Pair 证据链身份/冻结校验未过,不得 validate
  const pre = runPreflight(round);
  const blockedPairs = pre.blocked.slice();
  if (blockedPairs.length) console.log(`[validate] preflight BLOCKED,跳过 ${blockedPairs.length} 个 pair: ${blockedPairs.join(', ')}`);
  const limits = readLimits(path.join(BENCH, 'config', 'agents.yaml'));
  const jobs = [];
  for (const p of round.pairs) {
    if (p.preflight?.status === 'BLOCKED') continue;
    const pairDir = path.join(RESULTS, round.batchId, p.pairId);
    const pairJsonPath = path.join(pairDir, 'pair.json');
    const pj = JSON.parse(fs.readFileSync(pairJsonPath, 'utf8'));
    for (const arm of ['arm-a', 'arm-b']) {
      const st = p.arms[arm];
      if (st.state !== 'completed' && st.state !== 'validated') continue;
      const already = fs.existsSync(path.join(pairDir, arm, 'validation', 'report.json'));
      if (already && !force) { st.state = 'validated'; continue; }
      if (st.state !== 'completed') continue; // force 时仅重验已完成臂
      const engine = pj.arms[arm === 'arm-a' ? 'A' : 'B'].engine;
      jobs.push({ p, arm, engine, scene: pj.sceneId, pairId: p.pairId, pairDir, pairJsonPath });
    }
  }
  let ok = 0, fail = 0, budgetExhausted = 0, invalidEvidence = 0;
  for (const j of jobs) {
    const base = path.join(j.pairDir, j.arm);
    const ws = path.join(base, 'workspace');
    console.log(`[validate] ${j.pairId}/${j.arm} (${j.engine}) ...`);
    // spec 一律用 arm 目录内冻结副本(briefs/ 活文件升版/漂移不影响既往 Pair 的判定);
    // 副本缺失 = 冻结证据链断裂,本臂直接判错,不回退活文件。
    const specCopy = path.join(base, 'spec.json');
    if (!fs.existsSync(specCopy)) {
      j.p.arms[j.arm].state = 'validated';
      j.p.arms[j.arm].validation = { verdict: 'ERROR', classification: 'INVALID_EVIDENCE', classificationSource: 'run-round(spec 冻结副本缺失)', leakScan: 'SKIPPED', at: iso() };
      fail++; invalidEvidence++;
      console.log('           verdict=ERROR — spec.json 冻结副本缺失');
      continue;
    }
    // 预算机器计数快照(spawn validate 之前):validate.mjs 自身会执行一次 npm run build
    // 产生 +1 build 计数;判定窗口 = Agent Run 期间,故以验证前快照为准。
    const countsBefore = readBudgetCounts(ws);
    const v = spawnSync('node', [path.join(HARN, 'runner', 'validate.mjs'),
      '--workspace', ws,
      '--spec', specCopy,
      '--pair-meta', j.pairJsonPath, // FIX-B validate 侧消费:pair 元数据交叉核对(现版本安全忽略)
      '--out', path.join(base, 'validation'),
      '--run-id', `RUN-${j.pairId}-${j.arm.slice(4)}`, '--video'], { encoding: 'utf8' });
    let verdict = /done: (\w+)/.exec(v.stdout)?.[1] || 'ERROR';
    // report.json = 判定唯一事实源(AGENTS.md 硬约束 4);stdout 正则仅兜底
    const reportPath = path.join(base, 'validation', 'report.json');
    let classification = null;
    if (fs.existsSync(reportPath)) {
      try {
        const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        classification = rep.classification ?? null;
        if (rep.verdict) verdict = rep.verdict;
      } catch { /* report 损坏:保留 stdout 兜底 */ }
    }
    const ls = spawnSync('node', [path.join(HARN, 'isolation', 'leak-scanner.mjs'),
      '--workspace', base, '--peer-arm', j.arm === 'arm-a' ? 'arm-b' : 'arm-a', '--json'], { encoding: 'utf8' });
    const leak = /"status":\s*"(\w+)"/.exec(ls.stdout)?.[1] || 'ERROR';
    // 每臂验证后调 budget-check(机器计数判定;RUN-CONTRACT §2 触达上限由系统计数判定)
    const bc = checkBudget(countsBefore, limits);
    const entry = { verdict, classification: classification ?? (verdict === 'PASS' ? 'PASS' : 'FAIL'), leakScan: leak, at: iso() };
    if (classification) entry.classificationSource = 'validate.mjs';
    entry.budgetVerdict = bc.verdict;
    entry.budgetUsed = bc.used;
    if (bc.verdict !== 'OK') {
      entry.classification = 'BUDGET_EXHAUSTED';
      entry.classificationSource = 'budget-check@run-round(机器计数,验证后判定;计数窗口=Agent Run 期间)';
      entry.budgetExceeded = bc.exceeded;
      budgetExhausted++;
    }
    if (classification === 'INPUT_DRIFT' || classification === 'ENV_DRIFT') {
      entry.evidenceFlag = 'INVALID_EVIDENCE'; // 输入/环境漂移:该臂证据不可用,ROUND 层标注
      invalidEvidence++;
    }
    j.p.arms[j.arm].state = 'validated';
    j.p.arms[j.arm].validation = entry;
    if (verdict === 'PASS' && leak === 'CLEAN' && entry.classification === 'PASS' && !entry.evidenceFlag) ok++; else fail++;
    console.log(`           verdict=${verdict} classification=${entry.classification} leak=${leak} budget=${bc.verdict}${entry.evidenceFlag ? ` evidence=${entry.evidenceFlag}` : ''}`);
  }
  round.stages.validate = { lastRunAt: iso(), jobs: jobs.length, ok, fail, forced: !!force, blockedPairs, budgetExhausted, invalidEvidence };
  saveRound(round);
  console.log(`[validate] ${jobs.length} 个臂验证:ok=${ok} fail=${fail}` +
    (blockedPairs.length ? `;跳过 BLOCKED pair ${blockedPairs.length} 个` : '') +
    (budgetExhausted ? `;BUDGET_EXHAUSTED ${budgetExhausted}` : '') +
    (invalidEvidence ? `;INVALID_EVIDENCE ${invalidEvidence}` : '') +
    (jobs.length ? ' → 可进入 blind/aggregate' : '(无待验臂)'));
}

// ---------- stage: blind ----------
function stageBlind(round) {
  const b = spawnSync('node', [path.join(HARN, 'judge', 'build-blind.mjs'), '--batch', round.batchId, '--refs'], { encoding: 'utf8' });
  console.log(b.stdout.trim());
  const hasVis = fs.existsSync(path.join(RESULTS, round.batchId, 'blind', 'visual-scores.json'));
  const instr = `# JUDGE-INSTRUCTIONS — 批次 ${round.batchId}\n\n材料:results/${round.batchId}/blind/CMP-*/{side1,side2}/shot-*.png\n主题锚定+一致性验证协议、六维 0-3 评分与 preference 判定,按 docs/metric-spec.md §18;\n两个独立 Judge 会话执行后把结果按 <batch>/blind/visual-scores.json 契约回填(pairs[pairId][engine]=Σ18),\n然后重跑 --stage aggregate。\n`;
  fs.writeFileSync(path.join(RESULTS, round.batchId, 'blind', 'JUDGE-INSTRUCTIONS.md'), instr);
  round.stages.blind = { lastRunAt: iso(), material: 'built', visualScores: hasVis ? 'present' : 'pending-judge' };
  saveRound(round);
  console.log(`[blind] 材料就绪;视觉分 ${hasVis ? '已存在' : '待 Judge(见 blind/JUDGE-INSTRUCTIONS.md)'}`);
}

// ---------- stage: aggregate ----------
function stageAggregate(round) {
  const a = spawnSync('node', [path.join(HARN, 'aggregate', 'aggregate-all.mjs')], { encoding: 'utf8', cwd: HARN });
  console.log(a.stdout.trim()); if (a.status !== 0) console.error(a.stderr);
  round.stages.aggregate = { lastRunAt: iso(), output: 'results/aggregated.json' };
  saveRound(round);
}

// ---------- stage: status ----------
function stageStatus(round) {
  console.log(`批次 ${round.batchId}(创建于 ${round.createdAt})`);
  console.log(`引擎: three@${round.engine.three.version} | cocosair ${round.engine.cocosair.tarball} (${round.engine.cocosair.sha256.slice(0, 8)}…)`);
  for (const p of round.pairs) {
    const cells = ['arm-a', 'arm-b'].map(a => {
      const v = p.arms[a].validation;
      const extra = v ? `(${v.verdict}/${v.leakScan}${v.budgetVerdict && v.budgetVerdict !== 'OK' ? `/budget:${v.budgetVerdict}` : ''}${v.evidenceFlag ? `/${v.evidenceFlag}` : ''})` : '';
      return `${a}:${p.arms[a].state}${extra}`;
    });
    const pf = p.preflight ? ` preflight:${p.preflight.status}` : ' preflight:未检';
    console.log(`  ${p.pairId}  ${cells.join('  ')}${pf}`);
  }
  for (const [k, v] of Object.entries(round.stages)) console.log(`  [${k}] ${JSON.stringify(v).slice(0, 120)}`);
}

// ---------- main ----------
const batch = arg('batch');
const stage = arg('stage');
if (stage === 'create' || (!stage && arg('plan'))) { stageCreate(); process.exit(0); }
if (!batch || !fs.existsSync(path.join(RESULTS, batch))) die('需要 --batch <B-YYYYMMDD-Rnn>(或先用 --stage create --plan …)');
if (!fs.existsSync(roundPath(batch))) {
  // 收编既有批次(迁移/手工创建):从 pair.json 与完成标记合成 ROUND.json
  const pairs = fs.readdirSync(path.join(RESULTS, batch), { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('PAIR-')).map(e => e.name).sort()
    .map(pairId => ({
      pairId,
      arms: Object.fromEntries(['arm-a', 'arm-b'].map(arm => {
        const d = path.join(RESULTS, batch, pairId, arm);
        const state = fs.existsSync(path.join(d, 'validation', 'report.json')) ? 'validated'
          : fs.existsSync(path.join(d, 'RESULT.md')) ? 'completed' : 'created';
        return [arm, { state }];
      })),
    }));
  if (!pairs.length) die(`批次 ${batch} 下无 PAIR-* 目录`);
  const round = {
    batchId: batch, createdAt: iso(), updatedAt: iso(), adopted: true,
    plan: { pairs: pairs.map(p => { const pj = JSON.parse(fs.readFileSync(path.join(RESULTS, batch, p.pairId, 'pair.json'), 'utf8')); return { pairId: p.pairId, scene: pj.sceneId, knowledge: pj.knowledge, rep: pj.repetition, pilot: pj.pilot ?? false }; }) },
    engine: {
      three: { version: JSON.parse(fs.readFileSync(path.join(BENCH, 'node_modules/three/package.json'))).version },
      cocosair: airTarballFingerprint(),
    },
    pairs, stages: {}, notes: ['adopted:ROUND.json 由既有批次合成(迁移批次或手工 create-pair 产物)'],
  };
  saveRound(round);
  console.log(`[adopt] 已为既有批次 ${batch} 合成 ROUND.json(${pairs.length} pairs)`);
}
const round = loadRound(batch);
switch (stage) {
  case 'preflight': stagePreflight(round); break;
  case 'collect': stageCollect(round); break;
  case 'validate': stageValidate(round, has('force')); break;
  case 'blind': stageBlind(round); break;
  case 'aggregate': stageAggregate(round); break;
  case 'status': stageStatus(round); break;
  default: die('未知 --stage;可用:create/preflight/collect/validate/blind/aggregate/status');
}
