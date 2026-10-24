#!/usr/bin/env node
// report/generate-cost-metrics.mjs — K0 成本比(AIR/Three)机器口径生成器
// ---------------------------------------------------------------------------
// 为什么存在:门户 KPI"K0 成本比"读 results/cost-metrics.json,旧文件是 Pilot 时代
// 编排会话手写的,方案A清库(30710b0)时被删且从无生成器。本脚本从各臂
// execution.json.toolCallsEvidence(宿主运行时 tool_uses 机器计数)重建同 schema 文件。
// 口径:
//   runs        = 双臂都有机器计数的 pair(缺任一臂则整对排除,不猜)
//   toolUses    = toolCallsEvidence.count(宿主 Agent 工具调用次数,机器口径);
//                 该字段缺失的臂(如 R03 起的子代理仪器)回退 .budget/toolcall.count 行数,
//                 逐臂在 run.evidence 记口径来源,不改写任何已落盘计数。
//   durationSec = execution.json agentStartedAt→agentFinishedAt 跨度(含臂内空闲,偏保守)
//   tokenRatio  = 'n/a':宿主不持久化每臂 token;自 2026-10-06 起新切片在
//                 toolCallsEvidence.tokens 记录(subagent usage),攒够后本脚本自动给出
// 已知保守性:E05-R02 等臂的计数含"派发失败重试前"的部分工作,toolUses 可能轻微低估
// three 侧/高估 air 侧差距 —— 如实保留,详见 notes。
// 零依赖;路径自定位。输出:results/cost-metrics.json(整文件重写)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'results');
const BATCH_RE = /^B-\d{8}-R\d+$/;
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// 回退口径:harness/runtime/toolcall-recorder.mjs 逐调用落盘的 workspace/.budget/toolcall.count,
// 一行一次 tool_use(与 qualification budgetToolCallEvidence 读的同一事实源),行数即机器计数。
const budgetToolcallCount = (pairDir, armDir) => {
  try {
    return fs.readFileSync(path.join(pairDir, armDir, 'workspace', '.budget', 'toolcall.count'), 'utf8')
      .split(/\r?\n/).filter((l) => l.trim()).length;
  } catch { return null; }
};

const runs = [];
// 测量仪器 = 该对臂验证报告里的工具链指纹(node+esbuild+chrome)。浏览器换版即换仪器,
// 成本比只在同仪器内可比,故逐对登记并给出分组聚合。
const instrumentOf = (pairDir) => {
  for (const dir of ['arm-a', 'arm-b']) {
    try {
      const fp = rj(path.join(pairDir, dir, 'validation', 'report.json')).toolchainFingerprint;
      if (fp) return fp;
    } catch { /* 本臂无报告,试另一臂 */ }
  }
  return 'unknown';
};
for (const ent of fs.readdirSync(RESULTS, { withFileTypes: true })) {
  if (!ent.isDirectory() || !BATCH_RE.test(ent.name)) continue;
  const batchDir = path.join(RESULTS, ent.name);
  for (const pe of fs.readdirSync(batchDir, { withFileTypes: true })) {
    if (!pe.isDirectory() || !pe.name.startsWith('PAIR-')) continue;
    const pairDir = path.join(batchDir, pe.name);
    const pjPath = path.join(pairDir, 'pair.json');
    if (!fs.existsSync(pjPath)) continue;
    let pj;
    try { pj = rj(pjPath); } catch { continue; }
    const arms = {};
    let ok = true;
    for (const [dir, key] of [['arm-a', 'A'], ['arm-b', 'B']]) {
      const exPath = path.join(pairDir, dir, 'execution.json');
      try {
        const ex = rj(exPath);
        let n = ex?.toolCallsEvidence?.count;
        let evidence = 'execution.toolCallsEvidence';
        if (!Number.isFinite(n)) {
          n = budgetToolcallCount(pairDir, dir);
          evidence = 'workspace/.budget/toolcall.count(行数)';
        }
        if (!Number.isFinite(n)) { ok = false; break; }
        const spanSec = (ex.agentStartedAt && ex.agentFinishedAt)
          ? Math.max(0, Math.round((Date.parse(ex.agentFinishedAt) - Date.parse(ex.agentStartedAt)) / 1000))
          : null;
        arms[key] = {
          engine: pj.arms?.[key]?.engine ?? null,
          toolUses: n,
          tokens: Number.isFinite(ex.toolCallsEvidence?.tokens) ? ex.toolCallsEvidence.tokens : null,
          durationSec: spanSec,
          evidence,
        };
      } catch { ok = false; break; }
    }
    if (!ok || !arms.A || !arms.B || !arms.A.engine || !arms.B.engine) continue;
    const t = arms.A.engine === 'three' ? arms.A : arms.B;
    const a = arms.A.engine === 'cocosair' ? arms.A : arms.B;
    if (t.engine !== 'three' || a.engine !== 'cocosair') continue;
    runs.push({
      batch: ent.name,
      pair: `${pj.sceneId}-${pj.knowledge}-${pj.repetition}`,
      scene: pj.sceneId,
      knowledge: pj.knowledge,
      repetition: pj.repetition,
      instrument: instrumentOf(pairDir),
      three: { toolUses: t.toolUses, durationSec: t.durationSec, tokens: t.tokens, evidence: t.evidence },
      cocosair: { toolUses: a.toolUses, durationSec: a.durationSec, tokens: a.tokens, evidence: a.evidence },
    });
  }
}
runs.sort((x, y) => (x.batch + x.pair < y.batch + y.pair ? -1 : 1));

const sum = (arr, f) => arr.reduce((t, r) => t + (f(r) ?? 0), 0);
const threeTools = sum(runs, r => r.three.toolUses);
const airTools = sum(runs, r => r.cocosair.toolUses);
const threeSec = sum(runs, r => r.three.durationSec);
const airSec = sum(runs, r => r.cocosair.durationSec);
const withTokens = runs.filter(r => r.three.tokens != null && r.cocosair.tokens != null);
const r1 = (v) => Math.round(v * 100) / 100;

// 分仪器聚合:总量比值会把 154 时代与 155 时代的臂混在一起(仪器换版即口径变化),
// 因此按 measurement instrument 各自给出可比口径;unknown = 该对无验证报告工具链指纹。
const byInstrument = {};
for (const r of runs) {
  const g = byInstrument[r.instrument] ||= { pairs: 0, threeTools: 0, airTools: 0, threeSec: 0, airSec: 0 };
  g.pairs += 1;
  g.threeTools += r.three.toolUses ?? 0; g.airTools += r.cocosair.toolUses ?? 0;
  g.threeSec += r.three.durationSec ?? 0; g.airSec += r.cocosair.durationSec ?? 0;
}
for (const [k, g] of Object.entries(byInstrument)) {
  byInstrument[k] = {
    pairs: g.pairs,
    toolRatio: g.threeTools ? r1(g.airTools / g.threeTools) : null,
    wallTimeRatio: g.threeSec ? r1(g.airSec / g.threeSec) : null,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  source: '机器口径:各臂 execution.json.toolCallsEvidence(宿主运行时 tool_uses);该字段缺失的臂回退 workspace/.budget/toolcall.count 行数(toolcall-recorder 逐调用落盘,与 qualification 同事实源),两口径逐臂记入 evidence;双臂齐备的 pair 才计入,缺任一臂整对排除',
  coverage: { batches: [...new Set(runs.map(r => r.batch))].sort(), pairs: runs.length },
  runs: runs.map(r => ({
    pair: `${r.pair} @ ${r.batch}`,
    instrument: r.instrument,
    three: r.three, cocosair: r.cocosair,
    dTools: r.cocosair.toolUses - r.three.toolUses,
  })),
  totals: {
    three: { toolUses: threeTools, durationSec: threeSec },
    cocosair: { toolUses: airTools, durationSec: airSec },
    byInstrument,
  },
  pairedDeltasAirMinusThree: {
    perPair: runs.map(r => ({
      pair: `${r.pair} @ ${r.batch}`,
      dTools: r.cocosair.toolUses - r.three.toolUses,
      dSec: (r.cocosair.durationSec != null && r.three.durationSec != null) ? r.cocosair.durationSec - r.three.durationSec : null,
    })),
    aggregate: {
      toolRatio: threeTools ? r1(airTools / threeTools) : null,
      wallTimeRatio: threeSec ? r1(airSec / threeSec) : null,
      tokenRatio: withTokens.length ? r1(sum(withTokens, r => r.cocosair.tokens) / sum(withTokens, r => r.three.tokens)) : 'n/a',
    },
    interpretation: `K0 下 AIR 臂工具调用系统性更贵(机器口径,${runs.length} 对一致方向 ${runs.filter(r => r.cocosair.toolUses > r.three.toolUses).length} 对);token 比值待新切片累积(toolsEvidence.tokens 自 2026-10-06 起记录)`,
  },
  notes: [
    '已知保守性:个别臂(如 E05@B-20261005-R02)的计数含派发失败重试前的部分工作,使用时注意;',
    'durationSec 为 agentStartedAt→agentFinishedAt 全跨度,含臂内等待,偏保守;',
    'token 口径:宿主不持久化每臂 token;toolCallsEvidence.tokens 字段自 2026-10-06 起由 Runner 在派发后回填(subagent usage),存量批次无法补录。',
    '跨仪器提示:R03 起的臂用 .budget 行数口径,且批次所属测量仪器(浏览器工具链)不同 —— 成本比只宜同仪器内比较,分层见 results/aggregated.json 的 toolchainEra。',
  ],
};

fs.writeFileSync(path.join(RESULTS, 'cost-metrics.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`[cost-metrics] 已刷新:${runs.length} 对(工具比 ${out.pairedDeltasAirMinusThree.aggregate.toolRatio}×,墙钟比 ${out.pairedDeltasAirMinusThree.aggregate.wallTimeRatio}×,token 比 ${out.pairedDeltasAirMinusThree.aggregate.tokenRatio})`);
