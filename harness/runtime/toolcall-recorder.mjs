#!/usr/bin/env node
// runtime/toolcall-recorder.mjs — Agent Run 工具调用机器计数器(方案 A:maxToolCalls = hard)
// ---------------------------------------------------------------------------
// 为什么存在:agents.yaml(G0 冻结)budget.maxToolCalls=120 是 hard 合同,而 build/browser
// 计数器由工程脚本自记,toolcall 只有宿主运行时知道。本模块是 Runner 侧的唯一合法写入口,
// 把宿主机器口径(逐调用事件或总数)落成 budget-check 可判定的追加日志:
//   workspace/.budget/toolcall.count   每行 = "<ISO 时间戳> tool=<名称>";行数 = 次数
//
// 三种写入模式(按宿主能力从强到弱):
//   call      逐调用追加(流式运行时在每次工具调用后调一次)→ "<ISO> tool=<name>"
//   transcript 从宿主会话转录(JSONL)逐条抽取 tool_use 事件(含真实逐调用时间戳),
//             抽不到时间戳/事件时回退 bulk —— 仍是宿主机器口径,不采信 Agent 自报
//   bulk      宿主只上报总数 N:第 1 行 = session=start,第 N 行 = session=end,
//             中间 N-2 行 = tool=unrecorded 占位(不伪造逐调用时间戳);
//             首尾行参与 budget-check 墙钟跨度判定,行数 = 计数口径
//
// 判定侧在 harness/runner/budget-check.mjs(KIND_LIMIT_KEY.toolcall → maxToolCalls);
// 本模块只负责"如实记录",超限后果(分类 BUDGET_EXHAUSTED)由 validate/run-round 判定。
//
// 用法:
//   node harness/runtime/toolcall-recorder.mjs call --workspace <dir> --tool <name> [--at <ISO>]
//   node harness/runtime/toolcall-recorder.mjs transcript --workspace <dir> --from <transcript.jsonl>
//        [--fallback-count N] [--force]
//   node harness/runtime/toolcall-recorder.mjs bulk --workspace <dir> --count N --start <ISO> --end <ISO>
//        [--source <host-id>] [--force]
//   node harness/runtime/toolcall-recorder.mjs status --workspace <dir>   (只读:计数 + 判定预览)
// 幂等保护:transcript/bulk 默认拒绝覆盖已存在的 toolcall.count(--force 才允许)。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..', '..');
const nowIso = () => new Date().toISOString();
const countPath = (workspace) => path.join(workspace, '.budget', 'toolcall.count');

/** 追加一行(逐调用模式);自动建 .budget 目录。返回写入的行。 */
export function appendCall(workspace, tool, at = nowIso()) {
  const line = `${at} tool=${String(tool || 'unknown').toLowerCase()}`;
  const dir = path.join(workspace, '.budget');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(countPath(workspace), line + '\n');
  return line;
}

/** 批量模式:宿主只上报总数 N(不伪造逐调用时间戳,占位行如实标注)。 */
export function recordBulk(workspace, { count, startAt, endAt, source = null, force = false }) {
  const f = countPath(workspace);
  if (fs.existsSync(f) && !force) throw new Error(`toolcall.count 已存在(如需覆盖加 --force): ${f}`);
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count 必须为正整数,收到: ${count}`);
  const s = startAt || nowIso();
  const e = endAt || nowIso();
  const lines = [`${s} session=start`];
  for (let i = 2; i < n; i++) lines.push(`${s} tool=unrecorded note=per-call-timestamps-not-exposed-by-host`);
  lines.push(`${e} session=end`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return { count: n, mode: 'session-bulk', lines: lines.length, source };
}

/**
 * 从宿主转录(JSONL)抽取逐调用事件。兼容 OpenAI 风格会话转录:
 * 任一行的 JSON 里存在 message.content[] / content[] 中 type==='tool_use' 的块即计一次,
 * 优先取行级 timestamp 作逐调用时间戳(缺省用宿主首尾时间或当前时间)。
 * 返回 {count, mode, events};零事件且给 fallbackCount 时转 bulk(仍是宿主总数口径)。
 */
export async function recordFromTranscript(workspace, transcriptPath, { fallbackCount = null, startAt = null, endAt = null, force = false } = {}) {
  const f = countPath(workspace);
  if (fs.existsSync(f) && !force) throw new Error(`toolcall.count 已存在(如需覆盖加 --force): ${f}`);
  const events = [];
  const rl = readline.createInterface({ input: fs.createReadStream(transcriptPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    let obj = null;
    try { obj = JSON.parse(t); } catch { continue; }
    const blocks = [];
    const msg = obj.message ?? obj;
    if (Array.isArray(msg?.content)) blocks.push(...msg.content);
    else if (Array.isArray(obj?.content)) blocks.push(...obj.content);
    for (const b of blocks) {
      if (b && b.type === 'tool_use') {
        events.push({
          at: obj.timestamp || msg.timestamp || null,
          tool: String(b.name || 'unknown').toLowerCase(),
        });
      }
    }
  }
  if (!events.length) {
    if (fallbackCount == null) throw new Error(`转录中未发现 tool_use 事件且未提供 --fallback-count: ${transcriptPath}`);
    const r = recordBulk(workspace, { count: fallbackCount, startAt, endAt, source: `transcript-fallback:${path.basename(transcriptPath)}`, force: true });
    return { ...r, eventsFound: 0 };
  }
  const lines = events.map((e, i) => `${e.at || startAt || nowIso()} tool=${e.tool}`);
  // 每事件恰好一行(行数=次数,与 bulk 模式同口径);不加 session 标记行 —— 那会让
  // "行数=次数"虚增 2。墙钟跨度由事件时间戳首尾决定(略保守:不含会话前后准备时间)。
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return { count: events.length, mode: 'per-call', eventsFound: events.length, lines: lines.length };
}

/** 只读:当前计数(供 status 子命令与 Runner 自查)。 */
export function readCount(workspace) {
  const f = countPath(workspace);
  if (!fs.existsSync(f)) return { count: 0, exists: false, path: f };
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { count: lines.length, exists: true, path: f, first: lines[0], last: lines[lines.length - 1] };
}

// ---------- CLI ----------
const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes('--' + k);
  const sub = process.argv[2];
  const workspace = arg('workspace');
  const die = (m) => { console.error('[toolcall-recorder] ERROR: ' + m); process.exit(2); };
  try {
    if (sub === 'call') {
      if (!workspace || !arg('tool')) die('usage: call --workspace <dir> --tool <name> [--at <ISO>]');
      const line = appendCall(path.resolve(workspace), arg('tool'), arg('at') || nowIso());
      console.log(`[toolcall-recorder] +1 → ${line} (合计 ${readCount(path.resolve(workspace)).count})`);
    } else if (sub === 'transcript') {
      if (!workspace || !arg('from')) die('usage: transcript --workspace <dir> --from <transcript.jsonl> [--fallback-count N] [--force]');
      const r = await recordFromTranscript(path.resolve(workspace), path.resolve(arg('from')), {
        fallbackCount: arg('fallback-count') != null ? Number(arg('fallback-count')) : null,
        startAt: arg('start'), endAt: arg('end'), force: has('force'),
      });
      console.log(`[toolcall-recorder] ${r.mode}: ${r.count} 次调用 → ${countPath(path.resolve(workspace))}${r.mode === 'per-call' ? '(含逐调用时间戳)' : '(宿主总数回退)'}`);
    } else if (sub === 'bulk') {
      if (!workspace || arg('count') == null) die('usage: bulk --workspace <dir> --count N --start <ISO> --end <ISO> [--source <id>] [--force]');
      const r = recordBulk(path.resolve(workspace), {
        count: Number(arg('count')), startAt: arg('start'), endAt: arg('end'),
        source: arg('source') || 'host-reported', force: has('force'),
      });
      console.log(`[toolcall-recorder] session-bulk: ${r.count} 行 → ${countPath(path.resolve(workspace))}`);
    } else if (sub === 'status') {
      if (!workspace) die('usage: status --workspace <dir>');
      const { budgetCheck } = await import(pathToFileURL(path.join(BENCH, 'harness', 'runner', 'budget-check.mjs')).href);
      const c = readCount(path.resolve(workspace));
      const bc = budgetCheck(path.resolve(workspace));
      console.log(JSON.stringify({ toolcall: c, verdict: bc.verdict, status: bc.status, used: bc.used, exceeded: bc.exceeded }, null, 2));
      process.exit(bc.verdict === 'OK' ? 0 : 3);
    } else {
      die('usage: toolcall-recorder.mjs <call|transcript|bulk|status> …(见文件头注释)');
    }
  } catch (e) {
    die(e.message);
  }
}
