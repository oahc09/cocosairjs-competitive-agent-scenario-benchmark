#!/usr/bin/env node
// runtime/agent-launcher.mjs — Agent Launcher Adapter(时序闭环;RUN-CONTRACT §execution.json)
// ---------------------------------------------------------------------------
// 为什么存在:track=core 要求同 Pair 双臂 agentStartedAt 时差 ≤30s,而该事实此前靠
// Runner 手工回填(可事后编造、可遗漏)。本适配器把"启动/结束"两个时刻的盖章动作
// 机制化:编排会话在真正派发每个 Arm 会话的前一刻调 start、会话返回后立刻调 finish,
// execution.json 从此是时序唯一事实源(不从 WORKLOG 推断、不从 dispatchAt 推断、不人工填写)。
//
// execution.json 结构(create-pair 生成,本模块只动三个时间字段):
//   { dispatchAt, agentStartedAt, agentFinishedAt, workerId, hostFingerprint, source }
//
// 幂等/防伪规则:
//   start  首写生效 —— agentStartedAt 已存在时拒绝(--force 才允许覆盖);不允许早于 dispatchAt
//   finish 要求先有 agentStartedAt;已存在时拒绝(--force 才允许覆盖);不允许早于 agentStartedAt
// 用法:
//   node harness/runtime/agent-launcher.mjs start  --arm-dir <dir> [--worker-id <id>] [--host <fp>] [--force]
//   node harness/runtime/agent-launcher.mjs finish --arm-dir <dir> [--at <ISO>] [--force]
//   node harness/runtime/agent-launcher.mjs status --arm-dir <dir>
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nowIso = () => new Date().toISOString();
const execPath = (armDir) => path.join(armDir, 'execution.json');

function loadExec(armDir) {
  const f = execPath(armDir);
  if (!fs.existsSync(f)) throw new Error(`execution.json 缺失(应由 create-pair 生成,拒绝代建): ${f}`);
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e._path = f;
  return e;
}
function saveExec(e) {
  const { _path, ...rest } = e;
  fs.writeFileSync(_path, JSON.stringify(rest, null, 2) + '\n');
}

/** 启动盖章:派发 Agent 会话前一刻调用。首写生效;返回生效时间戳。 */
export function stampStart(armDir, { workerId = null, host = null, force = false, at = nowIso() } = {}) {
  const e = loadExec(armDir);
  if (e.agentStartedAt && !force) throw new Error(`agentStartedAt 已存在(${e.agentStartedAt})——首写即事实源,拒绝覆盖(--force 才允许)`);
  if (e.dispatchAt && new Date(at) < new Date(e.dispatchAt)) throw new Error(`agentStartedAt(${at})早于 dispatchAt(${e.dispatchAt})——非法时序`);
  if (e.agentFinishedAt && !force) throw new Error(`agentFinishedAt 已存在却要写 start —— 时序倒置,拒绝`);
  e.agentStartedAt = at;
  if (workerId) e.workerId = workerId;
  if (host) e.hostFingerprint = host;
  e.source = 'agent-launcher start(Runner 在派发会话前一刻盖章;非 dispatchAt 推断)';
  saveExec(e);
  return at;
}

/** 结束盖章:Agent 会话返回后立刻调用。要求先 start;返回生效时间戳。 */
export function stampFinish(armDir, { force = false, at = nowIso() } = {}) {
  const e = loadExec(armDir);
  if (!e.agentStartedAt) throw new Error('agentStartedAt 缺失 —— 未 start 先 finish,拒绝(时序只认真实启动时刻)');
  if (e.agentFinishedAt && !force) throw new Error(`agentFinishedAt 已存在(${e.agentFinishedAt})——首写即事实源,拒绝覆盖(--force 才允许)`);
  if (new Date(at) < new Date(e.agentStartedAt)) throw new Error(`agentFinishedAt(${at})早于 agentStartedAt(${e.agentStartedAt})——非法时序`);
  e.agentFinishedAt = at;
  saveExec(e);
  return at;
}

// ---------- CLI ----------
const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes('--' + k);
  const sub = process.argv[2];
  const armDir = arg('arm-dir');
  const die = (m) => { console.error('[agent-launcher] ERROR: ' + m); process.exit(2); };
  try {
    if (sub === 'start') {
      if (!armDir) die('usage: start --arm-dir <dir> [--worker-id <id>] [--host <fp>] [--force]');
      const at = stampStart(path.resolve(armDir), { workerId: arg('worker-id'), host: arg('host'), force: has('force') });
      console.log(`[agent-launcher] agentStartedAt = ${at} → ${path.basename(path.resolve(armDir))}/execution.json(立即派发会话)`);
    } else if (sub === 'finish') {
      if (!armDir) die('usage: finish --arm-dir <dir> [--at <ISO>] [--force]');
      const at = stampFinish(path.resolve(armDir), { force: has('force'), at: arg('at') || nowIso() });
      console.log(`[agent-launcher] agentFinishedAt = ${at} → ${path.basename(path.resolve(armDir))}/execution.json`);
    } else if (sub === 'status') {
      if (!armDir) die('usage: status --arm-dir <dir>');
      const e = loadExec(path.resolve(armDir));
      const { _path, ...rest } = e;
      console.log(JSON.stringify(rest, null, 2));
    } else {
      die('usage: agent-launcher.mjs <start|finish|status> --arm-dir <dir>(见文件头注释)');
    }
  } catch (err) {
    die(err.message);
  }
}
