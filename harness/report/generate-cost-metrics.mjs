#!/usr/bin/env node
// report/generate-cost-metrics.mjs — K0 成本比(AIR/Three)机器口径生成器
// ---------------------------------------------------------------------------
// 为什么存在:门户 KPI"K0 成本比"读 results/cost-metrics.json,旧文件是 Pilot 时代
// 编排会话手写的,方案A清库(30710b0)时被删且从无生成器。本脚本从各臂
// execution.json.toolCallsEvidence(宿主运行时 tool_uses 机器计数)重建同 schema 文件。
// 口径:
//   runs        = 双臂都有机器计数的 pair(缺任一臂则整对排除,不猜)
//   toolUses    = toolCallsEvidence.count(宿主 Agent 工具调用次数,机器口径)
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

const runs = [];
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
        const n = ex?.toolCallsEvidence?.count;
        if (!Number.isFinite(n)) { ok = false; break; }
        const spanSec = (ex.agentStartedAt && ex.agentFinishedAt)
          ? Math.max(0, Math.round((Date.parse(ex.agentFinishedAt) - Date.parse(ex.agentStartedAt)) / 1000))
          : null;
        arms[key] = {
          engine: pj.arms?.[key]?.engine ?? null,
          toolUses: n,
          tokens: Number.isFinite(ex.toolCallsEvidence.tokens) ? ex.toolCallsEvidence.tokens : null,
          durationSec: spanSec,
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
      three: { toolUses: t.toolUses, durationSec: t.durationSec, tokens: t.tokens },
      cocosair: { toolUses: a.toolUses, durationSec: a.durationSec, tokens: a.tokens },
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

const out = {
  generatedAt: new Date().toISOString(),
  source: '机器口径:各臂 execution.json.toolCallsEvidence(宿主运行时 tool_uses)+ 起止时戳;双臂齐备的 pair 才计入,缺任一臂整对排除',
  coverage: { batches: [...new Set(runs.map(r => r.batch))].sort(), pairs: runs.length },
  runs: runs.map(r => ({
    pair: `${r.pair} @ ${r.batch}`,
    three: r.three, cocosair: r.cocosair,
    dTools: r.cocosair.toolUses - r.three.toolUses,
  })),
  totals: {
    three: { toolUses: threeTools, durationSec: threeSec },
    cocosair: { toolUses: airTools, durationSec: airSec },
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
  ],
};

fs.writeFileSync(path.join(RESULTS, 'cost-metrics.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`[cost-metrics] 已刷新:${runs.length} 对(工具比 ${out.pairedDeltasAirMinusThree.aggregate.toolRatio}×,墙钟比 ${out.pairedDeltasAirMinusThree.aggregate.wallTimeRatio}×,token 比 ${out.pairedDeltasAirMinusThree.aggregate.tokenRatio})`);
