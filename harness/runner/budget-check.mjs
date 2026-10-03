#!/usr/bin/env node
// budget-check.mjs — Agent Run 预算机器计数判定(模块 + CLI;FIX-C §13/§15)
// ---------------------------------------------------------------------------
// 口径(RUN-CONTRACT §2 冻结定义 / config/agents.yaml agentRun.budget,FROZEN G0):
//   buildAttempt  = 每次 `npm run build`              → workspace/.budget/build.count   行数
//   browserAttempt= 每次创建浏览器会话                → workspace/.budget/browser.count 行数
//   toolCall      = 运行时原始调用(Runner 侧记录)    → workspace/.budget/toolcall.count 行数(如写入)
//   wallTime      = 计数文件 ISO 时间戳首尾跨度(分钟) → 上限 maxWallTimeMinutes(存在任一计数时判定)
// 触达上限由系统计数判定,自报仅诊断 —— 本模块就是"系统计数"的判定侧。
//
// 模块接口(run-round validate stage 每臂验证后调用;注意:validate.mjs 自身会执行一次
// `npm run build` 产生 +1 build 计数,故 run-round 在 spawn validate 之前先快照计数,
// 判定窗口 = Agent Run 期间,不含 harness 验证阶段):
//   readBudgetCounts(workspace)          → { dir, kinds: { <kind>: { count, lines } }, unknownFiles }
//   readLimits(agentsYamlPath)           → { maxToolCalls, maxWallTimeMinutes, maxBuildAttempts, maxBrowserAttempts, source }
//   checkBudget(counts, limits)          → { verdict: 'OK'|'BUDGET_EXHAUSTED', exceeded: [{kind,used,max}], checked: [...] }
//
// CLI:
//   node runner/budget-check.mjs --workspace <dir> [--agents-yaml <path>] [--json]
//   退出码:0=OK,3=BUDGET_EXHAUSTED,2=用法/环境错误。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS_YAML = path.resolve(__dirname, '..', '..', 'config', 'agents.yaml');

/** 计数 kind → agents.yaml 上限键(toolcalls 是 toolcall 的兼容别名,仅归并读取)。 */
const KIND_LIMIT_KEY = {
  build: 'maxBuildAttempts',
  browser: 'maxBrowserAttempts',
  toolcall: 'maxToolCalls',
};
const KIND_ALIAS = { toolcall: 'toolcalls' };

/** 按行取 `key: value` 标量(容忍行内注释)—— 与 coordinator/create-pair.mjs 同款子集解析。 */
function yamlScalar(text, key) {
  const re = new RegExp(`^\\s*-?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'm');
  const m = text.match(re);
  if (!m) return undefined;
  let v = m[1].trim();
  const hashIdx = v.indexOf(' #');
  if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
  return v.replace(/^["']|["']$/g, '');
}

/** 读 agents.yaml 的预算上限(冻结值;任何改动=配置漂移,见 agents.yaml driftPolicy)。 */
export function readLimits(agentsYamlPath = DEFAULT_AGENTS_YAML) {
  const text = fs.readFileSync(agentsYamlPath, 'utf8');
  const pick = (key) => {
    const v = yamlScalar(text, key);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    maxToolCalls: pick('maxToolCalls'),
    maxWallTimeMinutes: pick('maxWallTimeMinutes'),
    maxBuildAttempts: pick('maxBuildAttempts'),
    maxBrowserAttempts: pick('maxBrowserAttempts'),
    source: path.basename(agentsYamlPath) + ' (agentRun.budget, FROZEN G0)',
  };
}

/** 读 workspace/.budget/*.count 机器计数(不存在 .budget 目录 = 0 次计数,合法)。 */
export function readBudgetCounts(workspace) {
  const dir = path.join(workspace, '.budget');
  const kinds = {};
  const unknownFiles = [];
  if (!fs.existsSync(dir)) return { dir, kinds, unknownFiles };
  for (const f of fs.readdirSync(dir)) {
    const m = /^([a-z0-9-]+)\.count$/i.exec(f);
    if (!m) { unknownFiles.push(f); continue; }
    const lines = fs.readFileSync(path.join(dir, f), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    kinds[m[1].toLowerCase()] = { count: lines.length, lines };
  }
  return { dir, kinds, unknownFiles };
}

/**
 * 判定:counts = readBudgetCounts() 的返回值,limits = readLimits() 的返回值。
 * 超限项进 exceeded;wallTime 用全部计数文件的 ISO 时间戳首尾跨度(向上取整分钟)。
 */
export function checkBudget(counts, limits, { now = new Date().toISOString() } = {}) {
  const checked = [];
  const exceeded = [];
  const used = {};
  for (const [kind, key] of Object.entries(KIND_LIMIT_KEY)) {
    const max = limits[key];
    const n = counts.kinds[kind]?.count ?? counts.kinds[KIND_ALIAS[kind]]?.count ?? 0;
    used[kind] = n;
    if (max === undefined) continue; // 配置缺失:不猜上限,交由 preflight/漂移检测报告
    checked.push({ kind, used: n, max });
    if (n > max) exceeded.push({ kind, used: n, max });
  }
  // wallTime:取所有 ISO 行的最小/最大时间戳跨度(harness 无独立计时文件时的保守口径)
  const stamps = Object.values(counts.kinds)
    .flatMap((k) => k.lines)
    .map((l) => Date.parse(l))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (stamps.length >= 1 && limits.maxWallTimeMinutes !== undefined) {
    const minutes = Math.max(1, Math.ceil((stamps[stamps.length - 1] - stamps[0]) / 60000));
    used.walltime = minutes;
    checked.push({ kind: 'walltime', used: minutes, max: limits.maxWallTimeMinutes });
    if (minutes > limits.maxWallTimeMinutes) exceeded.push({ kind: 'walltime', used: minutes, max: limits.maxWallTimeMinutes });
  }
  return {
    verdict: exceeded.length ? 'BUDGET_EXHAUSTED' : 'OK',
    exceeded,
    checked,
    used,
    limits,
    unknownFiles: counts.unknownFiles,
    checkedAt: now,
  };
}

/** 一步到位:workspace + agents.yaml → 判定结果。 */
export function budgetCheck(workspace, agentsYamlPath = DEFAULT_AGENTS_YAML) {
  return checkBudget(readBudgetCounts(workspace), readLimits(agentsYamlPath));
}

// ---------- CLI(仅直接执行时) ----------
const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const workspace = arg('workspace');
  const asJson = process.argv.includes('--json');
  if (!workspace) {
    console.error('usage: node runner/budget-check.mjs --workspace <dir> [--agents-yaml <path>] [--json]');
    process.exit(2);
  }
  let result;
  try {
    result = budgetCheck(path.resolve(workspace), arg('agents-yaml') ? path.resolve(arg('agents-yaml')) : undefined);
  } catch (e) {
    console.error('[budget-check] ERROR: ' + e.message);
    process.exit(2);
  }
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checked) console.log(`[budget-check] ${c.kind.padEnd(8)} ${c.used}/${c.max}`);
    console.log(`[budget-check] verdict: ${result.verdict}` + (result.unknownFiles.length ? `(忽略非计数文件: ${result.unknownFiles.join(', ')})` : ''));
  }
  process.exit(result.verdict === 'OK' ? 0 : 3);
}
