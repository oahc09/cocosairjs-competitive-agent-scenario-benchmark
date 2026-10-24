#!/usr/bin/env node
// runner/skills-check.mjs — 引擎技能包(knowledge/skills/)生效性核验
// ---------------------------------------------------------------------------
// 为什么存在:RUN-CONTRACT 只声明"开工第一步加载技能",声明本身不是证据(AGENTS.md 硬约束 4:
// Agent 自报口径不算数)。本模块把两件事分开取证,并在 execution.json 里落成机器可查的记录:
//   ① 供给侧(强判,缺即 BLOCKED)—— 臂目录里真有 knowledge/skills/ 且与 pair.json.airSkills 哈希一致;
//   ② 使用侧(弱判,核不到只记 UNVERIFIED)—— 宿主转录里确实发生过对 knowledge/skills/ 的工具调用。
// UNVERIFIED 不否决该 Run(宿主不保证留转录),但必须逐臂披露,跨世代对比时才不会被当成"技能已生效"。
//
// 判据口径(workspace/.budget/toolcall.count 只有 "<ISO> tool=<name>",无路径,证明不了读过什么;
// 路径级取证只能来自宿主会话转录 JSONL 的 tool_use.input —— 与 toolcall-recorder transcript 模式同源)。
//
// 用法:
//   node harness/runner/skills-check.mjs inspect --arm <armDir> [--json]
//   node harness/runner/skills-check.mjs scan --arm <armDir> --from <transcript.jsonl> [--force] [--json]
//   node harness/runner/skills-check.mjs batch --batch-dir <results/B-...> [--json]   (逐臂供给侧盘点)
// 退出码:inspect/scan 正常 0、参数/事实缺失 2;batch 有任一 BLOCKED 臂时 3(供门禁使用,不改历史批次)。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..', '..');

// 转录里 input 中被视为"路径/命令"的字段:命中 skills 目录才算真触达(整体序列化命中只算提及)
const PATH_ARG_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'dir_path', 'dir',
  'dirPath', 'target_file', 'targetFile', 'filename', 'file', 'glob', 'pattern', 'command', 'cmd'];
// 写入类工具名(小写):用于判定"首次触达技能"是否早于"首次改代码"
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'multi_edit', 'str_replace', 'search_replace',
  'create_file', 'write_file', 'edit_file', 'apply_patch', 'notebookedit', 'replace_in_file']);
// 触达判据:路径参数里出现 knowledge/skills(目录根本身也算,如 ls knowledge/skills);
// 用 (?![\w.-]) 收尾避免匹配到 knowledge/skillsXYZ 之类前缀
const SKILLS_RE = /knowledge[\\/]+skills(?![A-Za-z0-9._-])/i;
const SKILL_NAME_RE = /knowledge[\\/]+skills[\\/]+([A-Za-z0-9._-]+)/i;

// ---------------------------------------------------------------------------
// 哈希口径:与 coordinator/create-pair.mjs:38-63 逐行同式(该脚本无导出且 import 即执行 main,
// 无法复用;若任一侧改配方,inspect 会报 HASH_MISMATCH 而非静默通过 —— 失败方向安全)
// ---------------------------------------------------------------------------
function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function sha256File(p) {
  return sha256Buffer(fs.readFileSync(p));
}
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

// ---------------------------------------------------------------------------
// 供给侧
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function armSide(armDir) {
  const base = path.basename(path.resolve(armDir)).toLowerCase();
  return base === 'arm-b' ? 'B' : 'A';
}

function pairOf(armDir) {
  const dir = path.resolve(armDir);
  const pj = readJson(path.join(path.dirname(dir), 'pair.json'));
  return { pairDir: path.dirname(dir), pairJson: pj };
}

/**
 * 供给侧核验(不读转录,只看臂目录里的技能包与 pair.json 登记是否一致)。
 * state:
 *   NOT_APPLICABLE 本臂非 cocosair(无需技能面)
 *   NO_PAIR        臂目录旁没有可解析的 pair.json
 *   PRE_SKILLS_GEN pair.json 无 airSkills 字段(2026-10-17 技能供给世代之前创建的批次)
 *   NOT_SUPPLIED   airSkills 字段为 null(--no-skills 派发,合同里写明本臂无技能包)
 *   MISSING        登记了技能包但臂目录里没有 knowledge/skills/
 *   HASH_MISMATCH  目录存在但树哈希/文件数与登记不符(派发后被改动或拷贝不完整)
 *   OK             目录存在且与登记一致
 */
export function inspectSupply(armDir) {
  const dir = path.resolve(armDir);
  const side = armSide(dir);
  const { pairJson } = pairOf(dir);
  const engine = pairJson?.arms?.[side]?.engine ?? null;
  const skillsDir = path.join(dir, 'knowledge', 'skills');
  const out = {
    side,
    engine,
    state: 'NO_PAIR',
    reason: null,
    declared: null,
    dirExists: fs.existsSync(skillsDir),
    actualHash: null,
    fileCount: null,
    readmePresent: false,
    sourceHash: null,
    sourceMatches: null,
    skillsDir: path.relative(BENCH, skillsDir).replace(/\\/g, '/'),
  };
  if (!pairJson) { out.reason = 'pair.json 缺失或不可解析'; return out; }
  if (engine !== 'cocosair') { out.state = 'NOT_APPLICABLE'; out.reason = '本臂引擎非 cocosair,无技能面'; return out; }
  if (!Object.hasOwn(pairJson, 'airSkills')) {
    out.state = 'PRE_SKILLS_GEN';
    out.reason = 'pair.json 无 airSkills 字段(早于技能供给世代 2026-10-17);该批次不可与技能世代横向比较';
    return out;
  }
  const declared = pairJson.airSkills;
  out.declared = declared;
  if (!declared) {
    out.state = 'NOT_SUPPLIED';
    out.reason = 'airSkills=null(--no-skills 派发:本臂无技能包,RUN-CONTRACT §0 应已写明)';
    return out;
  }
  if (!out.dirExists) {
    out.state = 'MISSING';
    out.reason = `pair.json 登记了技能包(${declared.fileCount} 文件)但臂目录缺少 ${out.skillsDir}`;
    return out;
  }
  const h = dirTreeHash(skillsDir);
  out.actualHash = h.hash;
  out.fileCount = h.fileCount;
  out.readmePresent = fs.existsSync(path.join(skillsDir, 'README.md'));
  if (declared.source) {
    const src = path.join(BENCH, ...String(declared.source).split('/'));
    if (fs.existsSync(src)) {
      const sh = dirTreeHash(src);
      out.sourceHash = sh.hash;
      out.sourceMatches = sh.hash === declared.hash;
    }
  }
  if (h.hash !== declared.hash || h.fileCount !== declared.fileCount) {
    out.state = 'HASH_MISMATCH';
    out.reason = `臂内技能包树哈希 ≠ pair.json 登记(${String(h.hash).slice(0, 12)}…/${h.fileCount} vs ${String(declared.hash).slice(0, 12)}…/${declared.fileCount})`;
    return out;
  }
  if (!out.readmePresent) {
    out.state = 'HASH_MISMATCH';
    out.reason = '技能包与登记一致但缺少 README.md(合同要求的第一入口不在位)';
    return out;
  }
  out.state = 'OK';
  out.reason = `技能包在位且与登记一致(${h.fileCount} 文件,树哈希 ${String(h.hash).slice(0, 12)}…)`;
  return out;
}

/** 供给侧是否阻断(与 run-round preflight 同口径,供其它脚本复用)。 */
export function supplyBlockedStates() {
  return ['MISSING', 'HASH_MISMATCH'];
}

// ---------------------------------------------------------------------------
// 使用侧(宿主转录 JSONL → 路径级取证)
// ---------------------------------------------------------------------------
/** 转录单行的 tool_use 块 → tool_use 事件(与 toolcall-recorder.recordFromTranscript 同解析口径,多带 input)。 */
async function* parseTranscript(transcriptPath) {
  const rl = readline.createInterface({ input: fs.createReadStream(transcriptPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    let obj = null;
    try { obj = JSON.parse(t); } catch { continue; }
    const msg = obj.message ?? obj;
    const blocks = Array.isArray(msg?.content) ? msg.content : (Array.isArray(obj?.content) ? obj.content : []);
    for (const b of blocks) {
      if (b && b.type === 'tool_use') {
        yield {
          at: obj.timestamp || msg.timestamp || null,
          tool: String(b.name || 'unknown').toLowerCase(),
          input: b.input ?? null,
        };
      }
    }
  }
}

/** 从 tool_use.input 里取"路径/命令"类字符串参数(含嵌套一层的 args 数组)。 */
function pathArgsOf(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v) out.push(v); };
  for (const [k, v] of Object.entries(input)) {
    if (PATH_ARG_KEYS.includes(k)) push(v);
    else if (Array.isArray(v)) for (const item of v) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') for (const kk of PATH_ARG_KEYS) push(item[kk]);
    } else if (v && typeof v === 'object') {
      for (const kk of PATH_ARG_KEYS) push(v[kk]);
    }
  }
  return out;
}

/**
 * 使用侧取证:扫转录,统计对 knowledge/skills/ 的路径级触达。
 * state:
 *   UNVERIFIED  无转录 / 转录里抽不到 tool_use 事件(宿主未留机器口径,不能据此断言"没读")
 *   NOT_LOADED  有 tool_use 事件、但零次触达技能包(声明未兑现)
 *   LOADED      至少一次触达技能包
 */
export async function scanUsage(armDir, transcriptPath) {
  const dir = path.resolve(armDir);
  const skillsDir = path.join(dir, 'knowledge', 'skills');
  const knownSkills = new Set(
    fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [],
  );
  const res = {
    state: 'UNVERIFIED',
    reason: null,
    transcript: transcriptPath ? path.basename(transcriptPath) : null,
    toolUseEvents: 0,
    callsTouchingSkills: 0,
    mentionsOnly: 0,
    distinctSkills: [],
    firstTouchAt: null,
    firstEditAt: null,
    skillBeforeFirstEdit: null,
    toolsTouching: {},
  };
  if (!transcriptPath) { res.reason = '未提供宿主转录'; return res; }
  if (!fs.existsSync(transcriptPath)) { res.reason = `转录文件不存在: ${transcriptPath}`; return res; }
  let firstTouchIdx = -1, firstEditIdx = -1, idx = -1;
  for await (const ev of parseTranscript(transcriptPath)) {
    idx += 1;
    res.toolUseEvents += 1;
    const args = pathArgsOf(ev.input);
    const pathHit = args.some((s) => SKILLS_RE.test(s));
    if (!pathHit) {
      // 整体序列化命中(如写入合同文本时提到该路径)只算"提及",不作生效证据
      try { if (SKILLS_RE.test(JSON.stringify(ev.input ?? ''))) res.mentionsOnly += 1; } catch { /* 巨型 input 忽略 */ }
    } else {
      res.callsTouchingSkills += 1;
      res.toolsTouching[ev.tool] = (res.toolsTouching[ev.tool] || 0) + 1;
      if (firstTouchIdx < 0) { firstTouchIdx = idx; res.firstTouchAt = ev.at; }
      for (const s of args) {
        const m = SKILL_NAME_RE.exec(s);
        if (m && knownSkills.has(m[1])) res.distinctSkills.push(m[1]);
        else if (m && !knownSkills.size) res.distinctSkills.push(m[1]);
      }
    }
    if (firstEditIdx < 0 && EDIT_TOOLS.has(ev.tool)) { firstEditIdx = idx; res.firstEditAt = ev.at; }
  }
  res.distinctSkills = [...new Set(res.distinctSkills)].sort();
  if (res.toolUseEvents === 0) { res.reason = '转录中未发现 tool_use 事件(宿主口径不可用)'; return res; }
  if (res.callsTouchingSkills === 0) {
    res.state = 'NOT_LOADED';
    res.reason = `转录含 ${res.toolUseEvents} 次工具调用、其中 ${res.mentionsOnly} 次仅提及路径,零次真触达 knowledge/skills/`;
    return res;
  }
  res.state = 'LOADED';
  res.reason = `${res.callsTouchingSkills} 次工具调用触达技能包(涉及 ${res.distinctSkills.length} 个技能)`;
  if (firstEditIdx >= 0) res.skillBeforeFirstEdit = firstTouchIdx < firstEditIdx;
  else res.skillBeforeFirstEdit = null;
  return res;
}

/** 读取臂内已有证据(只读,供 preflight/报告复用)。 */
export function readEvidence(armDir) {
  const ex = readJson(path.join(path.resolve(armDir), 'execution.json'));
  return ex?.skillsEvidence ?? null;
}

/** 合成"供给 + 使用"总判定:供 execution.json.skillsEvidence 与 preflight 共用。 */
export async function auditArm(armDir, transcriptPath, { force = false, write = false } = {}) {
  const dir = path.resolve(armDir);
  const supply = inspectSupply(dir);
  const usage = await scanUsage(dir, transcriptPath);
  const blocked = supplyBlockedStates().includes(supply.state);
  const state = blocked ? 'BLOCKED'
    : supply.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE'
    : usage.state;
  const evidence = {
    schema: 'skills-evidence-v1',
    verifiedAt: new Date().toISOString(),
    engine: supply.engine,
    state,
    supply,
    usage,
  };
  if (write) {
    if (supply.state === 'NOT_APPLICABLE') throw new Error(`本臂非 cocosair,无技能证据可写: ${dir}`);
    const execPath = path.join(dir, 'execution.json');
    if (!fs.existsSync(execPath)) throw new Error(`execution.json 缺失(应由 create-pair 生成,拒绝代建): ${execPath}`);
    const ex = readJson(execPath);
    if (ex.skillsEvidence && !force) throw new Error(`execution.json.skillsEvidence 已存在(state=${ex.skillsEvidence.state},如需覆盖加 --force)`);
    ex.skillsEvidence = evidence;
    fs.writeFileSync(execPath, JSON.stringify(ex, null, 2) + '\n', 'utf8');
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main().catch((e) => { console.error(`[skills-check] ERROR: ${e && e.stack ? e.stack : e}`); process.exit(2); });

async function main() {
  const argv = process.argv;
  const arg = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (k) => argv.includes('--' + k);
  const sub = argv[2];
  const asJson = has('json');

  if (sub === 'inspect') {
    const arm = arg('arm');
    if (!arm) throw new Error('用法: inspect --arm <armDir> [--json]');
    const r = inspectSupply(arm);
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else console.log(`[skills-check] ${r.skillsDir}\n  state=${r.state} engine=${r.engine ?? 'null'}\n  ${r.reason}`);
    process.exit(supplyBlockedStates().includes(r.state) ? 3 : 0);
  }

  if (sub === 'scan') {
    const arm = arg('arm');
    const from = arg('from');
    if (!arm) throw new Error('用法: scan --arm <armDir> --from <transcript.jsonl> [--force] [--json]');
    const ev = await auditArm(arm, from, { force: has('force'), write: true });
    if (asJson) console.log(JSON.stringify(ev, null, 2));
    else {
      console.log(`[skills-check] ${path.relative(BENCH, path.resolve(arm)).replace(/\\/g, '/')}`);
      console.log(`  supply=${ev.supply.state}: ${ev.supply.reason}`);
      console.log(`  usage =${ev.usage.state}: ${ev.usage.reason}`);
      console.log(`  state =${ev.state} → execution.json.skillsEvidence 已写入`);
    }
    process.exit(ev.state === 'BLOCKED' ? 3 : 0);
  }

  if (sub === 'batch') {
    const batchDir = arg('batch-dir');
    if (!batchDir) throw new Error('用法: batch --batch-dir <results/B-...> [--json]');
    const root = path.isAbsolute(batchDir) ? batchDir : path.resolve(BENCH, batchDir);
    const rows = [];
    for (const pairId of fs.readdirSync(root).filter((x) => x.startsWith('PAIR-')).sort()) {
      for (const arm of ['arm-a', 'arm-b']) {
        const armDir = path.join(root, pairId, arm);
        if (!fs.existsSync(armDir)) continue;
        const sup = inspectSupply(armDir);
        if (sup.state === 'NOT_APPLICABLE') continue;   // three 臂不入技能盘点
        const ev = readEvidence(armDir);
        rows.push({
          pairId, arm,
          supply: sup.state,
          usage: ev?.usage?.state ?? (ev ? null : 'NO_EVIDENCE'),
          overall: ev?.state ?? sup.state,
          files: sup.fileCount ?? sup.declared?.fileCount ?? null,
          reason: ev ? ev.supply.reason : sup.reason,
        });
      }
    }
    if (asJson) console.log(JSON.stringify({ batch: path.basename(root), rows }, null, 2));
    else {
      console.log(`[skills-check] batch=${path.basename(root)} AIR 臂 ${rows.length} 个`);
      for (const r of rows) {
        console.log(`  ${r.pairId}/${r.arm}: supply=${r.supply} usage=${r.usage} overall=${r.overall}${r.files ? ` files=${r.files}` : ''}`);
      }
      const blocked = rows.filter((r) => supplyBlockedStates().includes(r.supply));
      console.log(`  BLOCKED=${blocked.length}${blocked.length ? ' → ' + blocked.map((r) => `${r.pairId}/${r.arm}`).join(', ') : ''}`);
    }
    process.exit(rows.some((r) => supplyBlockedStates().includes(r.supply)) ? 3 : 0);
  }

  console.log(`用法:
  node harness/runner/skills-check.mjs inspect --arm <armDir> [--json]
  node harness/runner/skills-check.mjs scan --arm <armDir> --from <transcript.jsonl> [--force] [--json]
  node harness/runner/skills-check.mjs batch --batch-dir <results/B-...> [--json]

state 口径:供给侧 OK / MISSING / HASH_MISMATCH / NOT_SUPPLIED / PRE_SKILLS_GEN / NOT_APPLICABLE
           使用侧 LOADED / NOT_LOADED / UNVERIFIED
BLOCKED(= 供给 MISSING 或 HASH_MISMATCH)时退出码 3。`);
}
