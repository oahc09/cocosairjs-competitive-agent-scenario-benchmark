#!/usr/bin/env node
// coordinator/create-pair.mjs — Pair Coordinator(M3;2026-10-02 升级:批次化多轮执行)
// 用法:
//   node coordinator/create-pair.mjs --scene E03 --knowledge K0 --rep R01 [--pilot]
//        [--batch auto|B-YYYYMMDD-Rnn] [--arm-swap] [--vendored-deps]
// 行为:读 briefs/<scene>/ + config/*.yaml(极简子集解析),
//      在 results/<batchId>/PAIR-<scene>-<knowledge>-<rep>/ 下建 pair.json(计划书 §24 结构
//      + benchmark-contract §3 Immutable 字段 + 扩展字段)、arm-a/ 与 arm-b/
//      (workspace 模板拷贝[默认不含 node_modules,共享依赖向上解析] / knowledge / assets /
//       brief / spec / RUN-CONTRACT.md),端口分配扫描全部既有 pair.json 避免冲突(起 7100)。
// 批次:<batchId> = B-<触发日期YYYYMMDD>-R<当日轮次>,auto 时自动递增 —— 支持单日多轮执行,
//      产物按批次唯一化;批次索引写在 results/batches.json。
// 幂等:重复执行同 batchId+pairId 不覆盖已有 workspace,不覆盖 runner 已回填的字段。
// 零依赖(纯 node builtins)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, '..', '..'); // bench/
const RESULTS_DIR = path.join(BENCH_ROOT, 'results');
const PORT_BASE = 7100;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function die(msg, code = 1) {
  console.error(`[create-pair] ERROR: ${msg}`);
  process.exit(code);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256Buffer(fs.readFileSync(p));
}

/** 目录树哈希:按排序后的相对路径 + 文件内容哈希合成(确定性)。 */
function dirTreeHash(root) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) entries.push({ rel: r, hash: sha256File(abs) });
      else entries.push({ rel: r, hash: `special:${ent.name}` });
    }
  };
  walk(root, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const combined = entries.map((e) => `${e.rel}:${e.hash}`).join('\n');
  return { hash: sha256Buffer(Buffer.from(combined, 'utf8')), fileCount: entries.length };
}

function nowIso() {
  return new Date().toISOString();
}

function dirHasEntries(p) {
  return fs.existsSync(p) && fs.readdirSync(p).length > 0;
}

/** 递归拷贝(含空目录),目录不存在时静默跳过由调用方决定。 */
function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, force: true });
}

/** 模板拷贝(可跳过顶层目录,如 node_modules —— 共享依赖布局)。 */
function copyTemplate(src, dest, skipDirs = []) {
  fs.cpSync(src, dest, {
    recursive: true, preserveTimestamps: true, force: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (!rel) return true;
      return !skipDirs.includes(rel.split(path.sep)[0]);
    },
  });
}

// ---------------------------------------------------------------------------
// 依赖哈希(FIX-C 证据链:pair.json dependencyHashes)
// 口径 = validate.mjs dependencyFingerprints() 同式同键(判定侧为唯一事实源,单侧改配方
// 会让所有新 Pair 判 ENV_DRIFT):
//   fingerprint = SHA256( sha256(package.json) ":" sha256(package.json 的 main 入口) )
//   main 入口取 pj.main || pj.module || 'index.js' → 本仓解析结果:
//   three=build/three.cjs(package.json main;module 字段才是 three.module.js,注意!)
//   cocosair(cocosair.js)=build/npm/cocosair.module.js、esbuild=lib/main.js。
// 包目录一律取**根 node_modules**(非模板/工作区各自的副本);任一文件缺失 → null。
// ---------------------------------------------------------------------------

function dependencyFingerprint(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;
  const pkgJsonSha = sha256File(pkgJsonPath);
  let mainRel = null;
  try {
    const pj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    mainRel = pj.main || pj.module || 'index.js';
  } catch {
    return null;
  }
  const mainSha = sha256File(path.join(pkgDir, mainRel.replace(/^\.\//, '')));
  return pkgJsonSha && mainSha ? sha256Buffer(Buffer.from(`${pkgJsonSha}:${mainSha}`, 'utf8')) : null;
}

// AIR tarball 路径:优先取 vendor/engine-versions.json 登记值(activeVersion 条目),历史文件名兜底
function airTarballPaths() {
  let k0Rel = 'vendor/cocosair.js-1.0.0-k0.tgz', fullRel = 'vendor/cocosair.js-1.0.0.tgz';
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(BENCH_ROOT, 'vendor', 'engine-versions.json'), 'utf8'));
    const e = reg.engines && reg.engines.cocosair;
    const v = e && e.versions && e.versions[e.activeVersion];
    if (v && v.k0Tarball) k0Rel = v.k0Tarball;
    if (v && v.tarball) fullRel = v.tarball;
  } catch { /* 注册表缺失/损坏时沿用历史文件名 */ }
  return { k0: path.join(BENCH_ROOT, ...k0Rel.split('/')), full: path.join(BENCH_ROOT, ...fullRel.split('/')) };
}

function computeDependencyHashes() {
  const nm = path.join(BENCH_ROOT, 'node_modules');
  return {
    three: dependencyFingerprint(path.join(nm, 'three')),
    cocosair: dependencyFingerprint(path.join(nm, 'cocosair.js')),
    esbuild: dependencyFingerprint(path.join(nm, 'esbuild')),
  };
}

// ---------------------------------------------------------------------------
// RUN-META.template.json(FIX-C 身份链:Runner 派发前复制为 RUN-META.json 并逐字段填写;
// preflight stage 校验非空 + 两臂一致,缺失/BLOCKED 的 Pair 不得 validate)
// ---------------------------------------------------------------------------

function runMetaTemplateJson() {
  // R3-4 新 schema:sha 字段由 preflight 真算回填(留 null 即可);id 字段由 Runner 填写
  return {
    agentRuntime: null,      // Agent 运行时标识(如 zcode-cli / claude-code)
    agentBinaryHash: null,   // 云运行时填 'unavailable(...)' 并说明
    modelId: null,
    modelRevision: null,
    systemPromptId: null,    // 如 'DISPATCH-B-20261003-R05'
    systemPromptSha256: null,// preflight 真算 sha256(DISPATCH.md) 回填并核验
    toolPolicyId: null,      // 如 'policy-v2'
    toolPolicySha256: null,  // preflight 真算 sha256(策略输入清单) 回填并核验
    runnerVersion: null,
    notes: '派发前填写为 RUN-META.json;两个 Sha256 可留 null(ROUND dispatch/preflight 自动真算回填)',
  };
}

// ---------------------------------------------------------------------------
// 批次(results/<batchId>/,batchId = B-YYYYMMDD-Rnn,支持单日多轮)
// ---------------------------------------------------------------------------

const BATCH_RE = /^B-(\d{8})-R(\d+)$/;

function listBatchDirs() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BATCH_RE.test(e.name))
    .map((e) => e.name);
}

function resolveBatchId(explicit) {
  if (explicit && explicit !== 'auto') {
    if (!BATCH_RE.test(explicit)) die(`--batch 格式应为 B-YYYYMMDD-Rnn,收到 "${explicit}"`);
    return explicit;
  }
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const nums = listBatchDirs()
    .filter((b) => b.startsWith(`B-${ymd}-R`))
    .map((b) => parseInt(b.split('-R')[1], 10));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `B-${ymd}-R${String(n).padStart(2, '0')}`;
}

/** 批次索引 results/batches.json 的 upsert。 */
function registerBatch(batchId, pairId) {
  const idx = path.join(RESULTS_DIR, 'batches.json');
  let data = { updatedAt: nowIso(), batches: [] };
  if (fs.existsSync(idx)) {
    try { data = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { /* 重建 */ }
  }
  let b = data.batches.find((x) => x.batchId === batchId);
  if (!b) { b = { batchId, createdAt: nowIso(), pairs: [] }; data.batches.push(b); }
  if (!b.pairs.includes(pairId)) b.pairs.push(pairId);
  b.lastPairAt = nowIso();
  b.pairCount = b.pairs.length;
  data.batches.sort((x, y) => (x.batchId < y.batchId ? -1 : 1));
  data.updatedAt = nowIso();
  fs.writeFileSync(idx, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 端口分配:扫描全部既有 pair.json 的端口(注册表式,防并发批次冲突)+ 绑定探测
// ---------------------------------------------------------------------------

function scanUsedPorts() {
  const used = new Set();
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, depth + 1);
      else if (ent.name === 'pair.json') {
        try {
          const p = JSON.parse(fs.readFileSync(abs, 'utf8'));
          for (const k of ['armA', 'armB']) {
            const v = p?.ports?.[k];
            if (Number.isInteger(v)) used.add(v);
          }
        } catch { /* 忽略坏 json */ }
      }
    }
  };
  walk(RESULTS_DIR, 0);
  return used;
}

async function allocFreePorts(count, used, base = PORT_BASE) {
  const ports = [];
  let p = base;
  while (ports.length < count && p < base + 500) {
    if (!used.has(p) && (await checkPortFree(p))) { ports.push(p); used.add(p); }
    p += 1;
  }
  if (ports.length < count) die(`无法在 ${base}-${base + 500} 范围内找到 ${count} 个未被占用的端口(已扫描既有 pair 全部端口)`);
  return ports;
}

// ---------------------------------------------------------------------------
// 极简 YAML 子集解析(只需 agents.yaml 的 budget 与 benchmark.yaml 的个别标量)
// ---------------------------------------------------------------------------

/** 按行取 `key: value` 的标量(允许行内注释);找不到返回 undefined。 */
function yamlScalar(text, key) {
  const re = new RegExp(`^\\s*-?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'm');
  const m = text.match(re);
  if (!m) return undefined;
  let v = m[1].trim();
  const hashIdx = v.indexOf(' #');
  if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
  v = v.replace(/^["']|["']$/g, '');
  return v;
}

function readBudget(agentsYamlText) {
  const pick = (key, fallback) => {
    const v = yamlScalar(agentsYamlText, key);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    maxToolCalls: pick('maxToolCalls', 120),
    maxWallTimeMinutes: pick('maxWallTimeMinutes', 90),
    maxBuildAttempts: pick('maxBuildAttempts', 8),
    maxBrowserAttempts: pick('maxBrowserAttempts', 6),
    identicalAcrossEngines: true,
    source: 'config/agents.yaml (agentRun.budget, FROZEN G0)',
  };
}

// ---------------------------------------------------------------------------
// 端口分配
// ---------------------------------------------------------------------------

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// (端口分配见下方 allocFreePorts —— 扫描式注册表版本)

// ---------------------------------------------------------------------------
// Arm 引擎分配:rep 数字 mod 2(R01 奇 → A=three/B=cocosair;R02 偶 → 反转)
// ---------------------------------------------------------------------------

function armEngines(rep, armSwap) {
  const num = parseInt(String(rep).replace(/\D/g, ''), 10);
  if (!Number.isFinite(num)) die(`无法从 rep "${rep}" 解析序号`);
  const aIsThree = num % 2 === 1; // R01/R03 → A=three
  let engines = aIsThree ? { A: 'three', B: 'cocosair' } : { A: 'cocosair', B: 'three' };
  if (armSwap) engines = { A: engines.B, B: engines.A };
  return engines;
}

// ---------------------------------------------------------------------------
// RUN-CONTRACT 渲染
// ---------------------------------------------------------------------------

function renderRunContract(tpl, v) {
  return tpl
    .replaceAll('{{PAIR_ID}}', v.pairId)
    .replaceAll('{{ARM}}', v.arm)
    .replaceAll('{{ARM_LOW}}', v.arm.toLowerCase())
    .replaceAll('{{SCENE}}', v.scene)
    .replaceAll('{{ENGINE}}', v.engine)
    .replaceAll('{{KNOWLEDGE_LEVEL}}', v.knowledge)
    .replaceAll('{{PORT}}', String(v.port))
    .replaceAll('{{BUDGET_TOOLCALLS}}', String(v.budget.maxToolCalls))
    .replaceAll('{{BUDGET_WALLTIME_MINUTES}}', String(v.budget.maxWallTimeMinutes))
    .replaceAll('{{BUDGET_BUILD_ATTEMPTS}}', String(v.budget.maxBuildAttempts))
    .replaceAll('{{BUDGET_BROWSER_ATTEMPTS}}', String(v.budget.maxBrowserAttempts));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], batch: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scene') out.scene = argv[++i];
    else if (a === '--knowledge') out.knowledge = argv[++i];
    else if (a === '--rep') out.rep = argv[++i];
    else if (a === '--pilot') out.pilot = true;
    else if (a === '--track') out.track = argv[++i];
    else if (a === '--arm-swap') out.armSwap = true;
    else if (a === '--batch') out.batch = argv[++i] || 'auto';
    else if (a === '--vendored-deps') out.vendoredDeps = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const HELP = `用法: node coordinator/create-pair.mjs --scene E03 --knowledge K0 --rep R01 [选项]
  --scene      场景 ID(briefs/<scene>/ 必须含 brief.md + spec.json)
  --knowledge  知识等级 K0|K1|K2
  --rep        重复序号 R01/R02/...(Arm 引擎按 rep 数字 mod 2 平衡;R01 A=three/B=cocosair)
  --batch      批次 auto(默认,当日自动递增 B-YYYYMMDD-Rnn,支持单日多轮)|显式批次 ID
  --pilot      标记为 Pilot pair(M6 前置验证,不计入 Track B 统计)
  --arm-swap   交换 A/B 引擎分配(用于抵消 slot bias 的补充随机化,记录进 pair.json)
  --vendored-deps 把模板 node_modules 拷进 workspace(默认不拷:共享依赖向上解析,exFAT 去重布局)
幂等:重复执行同 batch+pairId 不覆盖已有 workspace;runner 已回填字段(startTimestamp*/status)保留。
端口:扫描 results/ 下全部 pair.json 已用端口 + 绑定探测,从 7100 起分配,批次间不冲突。`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scene || !args.knowledge || !args.rep) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const { scene, knowledge, rep, pilot = false, armSwap = false, batch: batchArg = 'auto', vendoredDeps = false } = args;
  // P0-1:track 必须显式提供(--track);--pilot 隐含 pilot。禁止默认猜测。
  const TRACKS = ['pilot', 'targeted-pilot', 'core', 'k2-ablation'];
  const trackArg = args.track;
  if (trackArg && !TRACKS.includes(trackArg)) die(`--track 取值须为: ${TRACKS.join('|')}(收到 "${trackArg}")`);
  const track = trackArg ?? (pilot ? 'pilot' : null);
  if (!track) die('--track 必须显式提供(pilot|targeted-pilot|core|k2-ablation);正式矩阵须 --track core');

  // ---- 1. 读输入 ---------------------------------------------------------
  const briefDir = path.join(BENCH_ROOT, 'briefs', scene);
  const briefMd = path.join(briefDir, 'brief.md');
  const specJson = path.join(briefDir, 'spec.json');
  if (!fs.existsSync(briefMd) || !fs.existsSync(specJson)) {
    die(`briefs/${scene}/ 下缺少 brief.md 或 spec.json`);
  }
  const spec = JSON.parse(fs.readFileSync(specJson, 'utf8'));
  if (spec.briefId !== scene) die(`spec.json briefId(${spec.briefId})与 --scene(${scene})不一致`);

  const agentsYamlPath = path.join(BENCH_ROOT, 'config', 'agents.yaml');
  const benchmarkYamlPath = path.join(BENCH_ROOT, 'config', 'benchmark.yaml');
  if (!fs.existsSync(agentsYamlPath)) die('config/agents.yaml 不存在');
  const agentsYaml = fs.readFileSync(agentsYamlPath, 'utf8');
  const benchmarkYaml = fs.existsSync(benchmarkYamlPath) ? fs.readFileSync(benchmarkYamlPath, 'utf8') : '';
  const budget = readBudget(agentsYaml);
  const startDeltaRaw = yamlScalar(benchmarkYaml, 'startDeltaMaxSeconds');
  const startTimeDeltaBudgetSec = Number(startDeltaRaw) || 30;

  const briefSha256 = sha256File(briefMd);
  const specSha256 = sha256File(specJson);
  const manifestPath = path.join(BENCH_ROOT, 'assets', 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) die('assets/MANIFEST.json 不存在');
  const assetSetSha256 = sha256File(manifestPath);
  const budgetConfigHash = sha256File(agentsYamlPath);

  // ---- 2. 批次、目录与引擎分配 ---------------------------------------------
  const batchId = resolveBatchId(batchArg);
  const pairId = `PAIR-${scene}-${knowledge}-${rep}`;
  const batchDir = path.join(RESULTS_DIR, batchId);
  const pairDir = path.join(batchDir, pairId);
  fs.mkdirSync(pairDir, { recursive: true });

  const engines = armEngines(rep, armSwap);

  // ---- 3. 端口(幂等:已有 pair.json 则复用其端口;否则扫描注册表分配) ------
  const pairJsonPath = path.join(pairDir, 'pair.json');
  const existing = fs.existsSync(pairJsonPath)
    ? JSON.parse(fs.readFileSync(pairJsonPath, 'utf8'))
    : null;
  let portA, portB;
  if (existing?.ports && Number.isInteger(existing.ports.armA) && Number.isInteger(existing.ports.armB)) {
    portA = existing.ports.armA;
    portB = existing.ports.armB;
  } else {
    [portA, portB] = await allocFreePorts(2, scanUsedPorts());
  }

  // ---- 4. 每 Arm 建目录 ---------------------------------------------------
  const tplPath = path.join(__dirname, 'run-contract-template.md');
  const tplText = fs.readFileSync(tplPath, 'utf8');
  const createdAt = existing?.createdAt || nowIso();

  const armReport = {};
  for (const arm of ['A', 'B']) {
    const engine = engines[arm];
    const armDirName = `arm-${arm.toLowerCase()}`;
    const armDir = path.join(pairDir, armDirName);

    const knowledgeSrc = path.join(BENCH_ROOT, 'knowledge', knowledge, engine);
    if (!fs.existsSync(knowledgeSrc)) die(`knowledge/${knowledge}/${engine} 不存在`);
    const templateSrc = path.join(BENCH_ROOT, 'templates', engine);
    const templateReady = dirHasEntries(templateSrc);

    // workspace/:模板拷贝(幂等:已存在且非空则跳过;默认跳过 node_modules —— 共享依赖向上解析)
    const workspaceDir = path.join(armDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    let workspaceAction;
    if (dirHasEntries(workspaceDir)) {
      workspaceAction = 'kept-existing(幂等跳过)';
    } else if (templateReady) {
      if (vendoredDeps) {
        copyTree(templateSrc, workspaceDir);
        workspaceAction = `copied-from templates/${engine} (含 vendored node_modules)`;
      } else {
        copyTemplate(templateSrc, workspaceDir, ['node_modules', '.budget']);
        workspaceAction = `copied-from templates/${engine} (无 node_modules,共享依赖向上解析)`;
      }
    } else {
      workspaceAction = 'template-missing(留空目录,重跑本脚本可补拷)';
    }

    // knowledge/、assets/、brief、spec
    copyTree(knowledgeSrc, path.join(armDir, 'knowledge'));
    copyTree(path.join(BENCH_ROOT, 'assets'), path.join(armDir, 'assets'));
    fs.copyFileSync(briefMd, path.join(armDir, 'brief.md'));
    fs.copyFileSync(specJson, path.join(armDir, 'spec.json'));

    // RUN-CONTRACT.md(coordinator 拥有,每次渲染覆盖)
    const contract = renderRunContract(tplText, {
      pairId, arm, scene, engine, knowledge, port: arm === 'A' ? portA : portB, budget,
    });
    fs.writeFileSync(path.join(armDir, 'RUN-CONTRACT.md'), contract, 'utf8');

    // execution.json(P1-4):时间戳由 Runner/编排方在派发与收集时盖章,Agent 不经手
    const execPath = path.join(armDir, 'execution.json');
    if (!fs.existsSync(execPath)) {
      fs.writeFileSync(execPath, JSON.stringify({
        dispatchAt: null, agentStartedAt: null, agentFinishedAt: null,
        workerId: 'local-worker-1',
        hostFingerprint: 'E:/AIProMax 单机(RTX4060/Chrome154/Node24)',
        source: 'Runner 派发时盖章(round dispatch stage);Agent 不经手,不依赖 WORKLOG',
      }, null, 2));
    }
        // RUN-META.template.json(coordinator 拥有,每次覆盖;Runner 派发前复制填写为 RUN-META.json,
    // 已填写的 RUN-META.json 永不触碰 —— 身份证据属于 Runner/Agent 侧)
    const runMetaTemplatePath = path.join(armDir, 'RUN-META.template.json');
    fs.writeFileSync(runMetaTemplatePath, JSON.stringify(runMetaTemplateJson(), null, 2) + '\n', 'utf8');

    // 模板哈希(模板就绪时取 template-manifest.json 或目录树哈希)
    let templateHash = null;
    if (templateReady) {
      const manifest = path.join(templateSrc, 'template-manifest.json');
      templateHash = fs.existsSync(manifest) ? sha256File(manifest) : dirTreeHash(templateSrc).hash;
    }
    const knowledgeHash = dirTreeHash(knowledgeSrc).hash;

    armReport[arm] = {
      engine,
      armDir: `${pairId}/${armDirName}`,
      templatePath: `templates/${engine}`,
      templateHash,
      templateMissing: !templateReady,
      templateManifestMissing: templateReady && !fs.existsSync(path.join(templateSrc, 'template-manifest.json')),
      workspaceAction,
      knowledgePath: `knowledge/${knowledge}/${engine}`,
      knowledgeHash,
      port: arm === 'A' ? portA : portB,
      runContract: `${pairId}/${armDirName}/RUN-CONTRACT.md`,
      runMetaTemplate: `${pairId}/${armDirName}/RUN-META.template.json`,
    };
    console.log(`[create-pair] arm-${arm.toLowerCase()}: engine=${engine} port=${arm === 'A' ? portA : portB} workspace=${workspaceAction} runMeta=RUN-META.template.json(待 Runner 填写)`);
  }

  // ---- 5. 引擎包哈希 + 共享依赖哈希(FIX-C dependencyHashes) ---------------
  const dependencyHashes = computeDependencyHashes();
  const airPaths = airTarballPaths();
  const airTarball = knowledge === 'K0' && fs.existsSync(airPaths.k0) ? airPaths.k0 : airPaths.full;
  const airPackageHash = fs.existsSync(airTarball) ? sha256File(airTarball) : null;
  let threePackageHash = null;
  const threePkgJson = path.join(BENCH_ROOT, 'templates', 'three', 'node_modules', 'three', 'package.json');
  if (fs.existsSync(threePkgJson)) threePackageHash = sha256File(threePkgJson);

  // ---- 6. 环境字段 ---------------------------------------------------------
  let packageManagerVersion = null;
  try {
    packageManagerVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch { /* 保持 null,由 runner 回填 */ }

  // ---- 7. pair.json(§24 结构 + §3 Immutable 字段 + 扩展字段;保留 runner 回填) --
  const armStatus = (arm) =>
    existing?.arms?.[arm]?.status && existing.arms[arm].status !== 'created'
      ? existing.arms[arm].status
      : 'created';

  const pairJson = {
    // §24 结构
    pairId,
    batchId,
    sceneId: scene,
    knowledge,
    knowledgeProfile: knowledge,
    repetition: rep,
    agentRevision: existing?.agentRevision ?? null,
    modelRevision: existing?.modelRevision ?? null,
    briefHash: briefSha256,
    arms: {
      A: { engine: engines.A, status: armStatus('A'), rawScore: null, attainment: null },
      B: { engine: engines.B, status: armStatus('B'), rawScore: null, attainment: null },
    },
    paired: null,

    // 扩展字段(任务规格)
    pilot,
    track,
    armSwapApplied: armSwap,
    status: existing?.status && existing.status !== 'created' ? existing.status : 'created',
    createdAt,
    updatedAt: nowIso(),
    startTimeDeltaBudgetSec,
    budget,
    briefSha256,
    specSha256,
    assetSetSha256,
    templatePathA: armReport.A.templatePath,
    templatePathB: armReport.B.templatePath,
    knowledgePathA: armReport.A.knowledgePath,
    knowledgePathB: armReport.B.knowledgePath,

    // benchmark-contract §3 Immutable Pair Configuration(两引擎组可不同,其余 runner 回填)
    agentBinaryHash: existing?.agentBinaryHash ?? null,
    modelId: existing?.modelId ?? null,
    modelRevisionId: existing?.modelRevisionId ?? null,
    systemPromptHash: existing?.systemPromptHash ?? null,
    toolPolicyHash: existing?.toolPolicyHash ?? null,
    budgetConfigHash,
    // FIX-C:共享依赖哈希(根 node_modules;配方见 computeDependencyHashes 注释,
    // 与 validate 侧同键名同口径 —— 引擎/构建器任一漂移在此可检出)
    dependencyHashes,
    threePackageHash,
    airPackageHash,
    airTarballUsed: airTarball ? `vendor/${path.basename(airTarball)}` : null,
    threeKnowledgeHash: engines.A === 'three' ? armReport.A.knowledgeHash : armReport.B.knowledgeHash,
    airKnowledgeHash: engines.A === 'cocosair' ? armReport.A.knowledgeHash : armReport.B.knowledgeHash,
    threeTemplateHash: engines.A === 'three' ? armReport.A.templateHash : armReport.B.templateHash,
    airTemplateHash: engines.A === 'cocosair' ? armReport.A.templateHash : armReport.B.templateHash,

    environment: {
      nodeVersion: process.version,
      packageManagerVersion,
      os: `${os.platform()} ${os.release()}`,
      gpu: null,             // runner/validate 回填
      graphicsBackend: null, // runner/validate 回填
      browserVersion: null,  // runner/validate 回填
    },

    execution: {
      startTimestampA: existing?.execution?.startTimestampA ?? null, // runner 回填
      startTimestampB: existing?.execution?.startTimestampB ?? null, // runner 回填
      startTimeDeltaActualSec: existing?.execution?.startTimeDeltaActualSec ?? null,
      workerA: existing?.execution?.workerA ?? null,
      workerB: existing?.execution?.workerB ?? null,
    },

    ports: { armA: portA, armB: portB },

    enginesDetail: armReport,

    pendingFields: [
      'agentBinaryHash', 'modelId', 'modelRevision', 'modelRevisionId', 'systemPromptHash',
      'toolPolicyHash', 'environment.gpu', 'environment.graphicsBackend',
      'environment.browserVersion', 'execution.startTimestampA', 'execution.startTimestampB',
      'execution.workerA', 'execution.workerB',
    ],
    notes: [
      'Arm 引擎分配规则:rep 序号 mod 2(R01/R03… A=three/B=cocosair;R02… 反转);--arm-swap 时反转并记录。',
      'workspace 为空且 templateMissing:true 表示模板尚未建成(并行 Wave2),重跑本脚本可补拷,不影响 pairId/端口/时间戳。',
      'RUN-META.template.json:Runner 派发前复制为各 Arm 的 RUN-META.json 并填写全部身份字段;run-round preflight stage 校验非空+两臂一致,缺失/BLOCKED 的 Pair 不得 validate。',
      'dependencyHashes 配方(与 validate.mjs dependencyFingerprints 同式同键):SHA256( sha256(package.json) ":" sha256(package.json main 入口) ),包目录=根 node_modules;键 {three,cocosair,esbuild}(cocosair→node_modules/cocosair.js);main 入口解析 three=build/three.cjs、cocosair.js=build/npm/cocosair.module.js、esbuild=lib/main.js。',
      ...(pilot ? ['pilot:true — M6 前置验证 pair,不计入 Track B 统计。'] : []),
      `track=${track} — 聚合分层:pilot/targeted-pilot 仅入 diagnostic 区,core 才进正式统计(需 qualification+量尺匹配)。`,
    ],
  };
  fs.writeFileSync(pairJsonPath, JSON.stringify(pairJson, null, 2) + '\n', 'utf8');
  registerBatch(batchId, pairId);

  // ---- 8. 摘要输出 ---------------------------------------------------------
  const summary = {
    pairId,
    batchId,
    pairDir: path.relative(BENCH_ROOT, pairDir),
    pilot,
    armA: { engine: engines.A, port: portA, workspace: armReport.A.workspaceAction },
    armB: { engine: engines.B, port: portB, workspace: armReport.B.workspaceAction },
    briefSha256,
    assetSetSha256,
    budgetConfigHash,
    pairJson: path.relative(BENCH_ROOT, pairJsonPath),
  };
  console.log('[create-pair] DONE ' + JSON.stringify(summary, null, 2));
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
