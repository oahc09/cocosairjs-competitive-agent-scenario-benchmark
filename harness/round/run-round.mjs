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
//   node round/run-round.mjs --batch <id> --stage collect
//        扫描各臂 RESULT.md 完成标记,汇报 pending
//   node round/run-round.mjs --batch <id> --stage validate [--force]
//        对"已完成且未验证"的臂串行跑 validate.mjs + leak-scanner(--force 全部重验)
//   node round/run-round.mjs --batch <id> --stage blind
//        build-blind 生成盲评材料 + JUDGE-INSTRUCTIONS.md;已存在 visual-scores.json 则标记就绪
//   node round/run-round.mjs --batch <id> --stage aggregate
//        aggregate-all 全量聚合(视觉分缺失的臂如实标 visualPending)
//   node round/run-round.mjs --batch <id> --stage status
//        打印本轮仪表盘(各臂状态/各阶段时间线)
//
// 状态机(ROUND.json):
//   pair.arm.state: created → dispatched(标记) → completed(RESULT.md) → validated
//   stages: {create, collect, validate, blind, aggregate} 各记 lastRunAt/summary
// 零依赖。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARN = path.resolve(__dirname, '..');              // bench/harness
const BENCH = path.resolve(HARN, '..');                  // bench
const RESULTS = path.join(BENCH, 'results');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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
const roundPath = (batch) => path.join(RESULTS, batch, 'ROUND.json');
const loadRound = (batch) => JSON.parse(fs.readFileSync(roundPath(batch), 'utf8'));
const saveRound = (r) => { r.updatedAt = iso(); fs.writeFileSync(roundPath(r.batchId), JSON.stringify(r, null, 2) + '\n'); };

function armStateFile(batch, pairId, armDir) { return path.join(RESULTS, batch, pairId, armDir); }

// ---------- stage: create ----------
function stageCreate() {
  const plan = parsePlan();
  if (!plan) die('create 需要 --plan <file|--matrix>');
  const batchArg = arg('batch') || 'auto';
  for (const p of plan.pairs) {
    const args = ['--scene', p.scene, '--knowledge', p.knowledge, '--rep', p.rep, '--batch', batchArg];
    if (p.pilot) args.push('--pilot');
    if (p.armSwap) args.push('--arm-swap');
    const res = spawnSync('node', [path.join(HARN, 'coordinator', 'create-pair.mjs'), ...args], { encoding: 'utf8' });
    if (res.status !== 0) die('coordinator 失败:\n' + res.stdout + res.stderr);
    const m = /"pairId":\s*"([^"]+)"[\s\S]*?"batchId":\s*"([^"]+)"/.exec(res.stdout) || [];
    const pairId = m[1], batchId = m[2];
    if (batchArg === 'auto') batchArg = batchId; // auto:首个 pair 定批次,后续同批
    if (!global.__batch) global.__batch = batchId;
    else if (global.__batch !== batchId) die('多批次混入(不应发生)');
    global.__pairs = (global.__pairs || []).concat([{ ...p, pairId, batchId }]);
  }
  const batch = global.__batch;
  const round = {
    batchId: batch, createdAt: iso(), updatedAt: iso(),
    plan: { source: arg("plan") || ("--matrix " + arg("matrix")), pairs: global.__pairs },
    engine: {
      three: { version: JSON.parse(fs.readFileSync(path.join(BENCH, 'node_modules/three/package.json'))).version },
      cocosair: { tarball: 'vendor/cocosair.js-1.0.0-k0.tgz', sha256: sha(path.join(BENCH, 'vendor', 'cocosair.js-1.0.0-k0.tgz')) },
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

// ---------- stage: validate ----------
function stageValidate(round, force) {
  const jobs = [];
  for (const p of round.pairs) {
    const pj = JSON.parse(fs.readFileSync(path.join(RESULTS, round.batchId, p.pairId, 'pair.json'), 'utf8'));
    for (const arm of ['arm-a', 'arm-b']) {
      const st = p.arms[arm];
      if (st.state !== 'completed' && st.state !== 'validated') continue;
      const already = fs.existsSync(path.join(RESULTS, round.batchId, p.pairId, arm, 'validation', 'report.json'));
      if (already && !force) { st.state = 'validated'; continue; }
      if (st.state !== 'completed') continue; // force 时仅重验已完成臂
      const engine = pj.arms[arm === 'arm-a' ? 'A' : 'B'].engine;
      const scene = pj.sceneId;
      jobs.push({ p, arm, engine, scene, pairId: p.pairId });
    }
  }
  let ok = 0, fail = 0;
  for (const j of jobs) {
    const base = path.join(RESULTS, round.batchId, j.pairId, j.arm);
    console.log(`[validate] ${j.pairId}/${j.arm} (${j.engine}) ...`);
    const v = spawnSync('node', [path.join(HARN, 'runner', 'validate.mjs'),
      '--workspace', path.join(base, 'workspace'),
      '--spec', path.join(BENCH, 'briefs', j.scene, 'spec.json'),
      '--out', path.join(base, 'validation'),
      '--run-id', `RUN-${j.pairId}-${j.arm.slice(4)}`, '--video'], { encoding: 'utf8' });
    const verdict = /done: (\w+)/.exec(v.stdout)?.[1] || 'ERROR';
    const ls = spawnSync('node', [path.join(HARN, 'isolation', 'leak-scanner.mjs'),
      '--workspace', base, '--peer-arm', j.arm === 'arm-a' ? 'arm-b' : 'arm-a', '--json'], { encoding: 'utf8' });
    const leak = /"status":\s*"(\w+)"/.exec(ls.stdout)?.[1] || 'ERROR';
    j.p.arms[j.arm].state = 'validated';
    j.p.arms[j.arm].validation = { verdict, leakScan: leak, at: iso() };
    if (verdict === 'PASS' && leak === 'CLEAN') ok++; else fail++;
    console.log(`           verdict=${verdict} leak=${leak}`);
  }
  round.stages.validate = { lastRunAt: iso(), jobs: jobs.length, ok, fail, forced: !!force };
  saveRound(round);
  console.log(`[validate] ${jobs.length} 个臂验证:ok=${ok} fail=${fail}` + (jobs.length ? ' → 可进入 blind/aggregate' : '(无待验臂)'));
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
    const cells = ['arm-a', 'arm-b'].map(a => `${a}:${p.arms[a].state}${p.arms[a].validation ? `(${p.arms[a].validation.verdict}/${p.arms[a].validation.leakScan})` : ''}`);
    console.log(`  ${p.pairId}  ${cells.join('  ')}`);
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
      cocosair: { tarball: 'vendor/cocosair.js-1.0.0-k0.tgz', sha256: sha(path.join(BENCH, 'vendor', 'cocosair.js-1.0.0-k0.tgz')) },
    },
    pairs, stages: {}, notes: ['adopted:ROUND.json 由既有批次合成(迁移批次或手工 create-pair 产物)'],
  };
  saveRound(round);
  console.log(`[adopt] 已为既有批次 ${batch} 合成 ROUND.json(${pairs.length} pairs)`);
}
const round = loadRound(batch);
switch (stage) {
  case 'collect': stageCollect(round); break;
  case 'validate': stageValidate(round, has('force')); break;
  case 'blind': stageBlind(round); break;
  case 'aggregate': stageAggregate(round); break;
  case 'status': stageStatus(round); break;
  default: die('未知 --stage;可用:create/collect/validate/blind/aggregate/status');
}
