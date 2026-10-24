#!/usr/bin/env node
// report/generate-report.mjs — 每轮测试结束自动刷新的实验报告(round aggregate 阶段尾部调用)
// ---------------------------------------------------------------------------
// 为什么存在:results/reports/latest/ 下的 M11 报告是手写的,战役推进后不会自己更新;
// 本脚本从聚合数据(aggregated.json)+ 门禁生成一份"说人话"的实验报告,整文件重写:
//   输出: results/reports/latest/EXPERIMENT-REPORT.md
// 口径:先结论后明细;每个符号第一次出现都解释;机器可复算,不引入人工编辑。
// 零依赖(node builtins);路径自定位。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'results');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const agg = rj(path.join(RESULTS, 'aggregated.json'));

// ---- 门禁(缺文件跳过,不猜) ----
const gates = {};
for (const g of ['G0','G1','G2','G3','G4','G5','G6','G7','G8']) {
  const p = path.join(ROOT, 'gates', g + '.json');
  if (fs.existsSync(p)) gates[g] = rj(p);
}

// ---- 场景标题(spec.json title 取括号前中文段) ----
const titles = {};
for (let i = 1; i <= 10; i++) {
  const e = 'E' + String(i).padStart(2, '0');
  try {
    titles[e] = String(rj(path.join(ROOT, 'briefs', e, 'spec.json')).title || '').split('（')[0].split('(')[0].trim().replace(/^E\d+\s*/, '');
  } catch { titles[e] = e; }
}
const sceneName = (e) => titles[e] ? `${e} ${titles[e]}` : e;

// ---- 口径工具 ----
const fmt = (v, dash = '—') => (v === null || v === undefined || Number.isNaN(v) ? dash : String(v));
const deltaWord = (d) => {
  if (d === null || d === undefined || Number.isNaN(d)) return '暂无正式对局';
  if (Math.abs(d) <= 3) return '势均力敌(平局带)';
  if (d > 0) return `cocosair 领先 ${d > 20 ? '显著' : d > 10 ? '明显' : '小幅'}(Δ=${d > 0 ? '+' : ''}${d})`;
  return `three 领先 ${d < -20 ? '显著' : d < -10 ? '明显' : '小幅'}(Δ=${d})`;
};
const qualWord = (s) => {
  if (!s) return '—';
  if (s === 'QUALIFIED') return '合格(全链)';
  if (s === 'QUALIFIED_OBJECTIVE') return '合格(客观口径)';
  if (String(s).startsWith('QUALIFIED_OBJECTIVE_PARTIAL')) return '有条件(证据缺口:' + String(s).replace('QUALIFIED_OBJECTIVE_PARTIAL', '').replace('_TIMING', '+时序超差') + ')';
  if (s === 'LEGACY_PROVISIONAL') return '遗留口径(诊断区)';
  if (s === 'DISQUALIFIED') return '不合格(诊断区)';
  return s;
};

const L = [];
L.push('# 实验报告(CocosAirJS 双引擎对照)');

// ---- 头:口径三行 ----
const ruler = agg.rulerStatus?.rulerId || (typeof agg.rulerStatus === 'string' ? agg.rulerStatus : '') || '—';
L.push('',
  `> 生成:${new Date().toISOString()}(每轮 aggregate 后自动刷新,勿手改;数据源 results/aggregated.json)`,
  `> 量尺:${ruler} | 门禁:G7 视觉 ${gates.G7?.status ?? '—'} / G3 Reference ${gates.G3?.status ?? '—'} | 覆盖批次:${agg.batches.length}`,
  ...(agg.toolchainEra ? ['> 测量仪器(量尺冻结指纹):`' + agg.toolchainEra.frozen + '`;同仪器入组 '
    + agg.toolchainEra.matchedCount + ' 对,换仪器排除 ' + agg.toolchainEra.mismatchedCount
    + ' 对(浏览器/Node/esbuild 换版即仪器换版,被排除的对仍完整保留在 batches 与 toolchainEra 清单中,只是不入正式分组)。'] : []),
  '> 怎么读:Δ = cocosair 得分 − three 得分(**正数 = cocosair 领先**,负数 = three 领先,|Δ|≤3 算平局);',
  '> "客观分"= 构建+行为探针+生命周期(满分 60);"formal 总分"= 客观分 + 代码健康 S4(5)+ 盲评视觉 40,仅双臂数据齐时给出。','');

// ---- 一页速览 ----
L.push('## 一页速览','',
  '| 门禁 | 状态 | 含义 |','|---|---|---|');
const gateMeaning = {
  G0: '合同冻结完好', G1: '双模板等价', G2: '隔离无泄漏', G3: '20 个 Reference 可行',
  G4: '验证器可信(负向对照全检出)', G5: '试点有效性', G6: 'core 矩阵完整性(战役进度)',
  G7: '盲评有效', G8: '证据链完整',
};
for (const [g, info] of Object.entries(gates)) {
  L.push(`| ${g} | **${info.status}** | ${gateMeaning[g] ?? ''} |`);
}
L.push('');
// 战役进度:按批次统计 core 对与合格对
const batchLines = [];
for (const b of agg.batches) {
  const total = b.pairs.length;
  const qualified = b.pairs.filter(p => p.qualificationStatus === 'QUALIFIED' || p.qualificationStatus === 'QUALIFIED_OBJECTIVE').length;
  const scenes = [...new Set(b.pairs.map(p => p.scene))].sort().join('/');
  const k = [...new Set(b.pairs.map(p => p.knowledge))].join('/');
  const rep = [...new Set(b.pairs.map(p => p.rep))].join('/');
  batchLines.push(`| ${b.batchId} | ${scenes} | K=${k} | ${rep} | ${total} | ${qualified} |`);
}
L.push('**战役进度**(每"批次"= 5 对双引擎 = 10 个 Agent Run;全部合格才计入正式统计):','',
  '| 批次 | 场景 | 知识级 | 重复轮 | 对数 | 合格对 |','|---|---|---|---|---|---|',
  ...batchLines, '');

// ---- 场景对比 ----
L.push('## 场景对比(谁领先)','',
  '> 只统计 track=core 且资格合格的对;诊断区(资格有缺口)的对不计入,数据在批次明细里可见。','',
  '| 场景 | 对局数 | Δ 中位 | 95% 区间 | 结论 |','|---|---|---|---|---|');
for (const g of agg.groups) {
  const d = g.rawDelta?.median ?? null;
  const ci = g.rawDelta?.bootstrapCi95;
  const ciTxt = Array.isArray(ci) && ci.length === 2 && ci.every(v => v !== null) ? `[${ci[0]}, ${ci[1]}]` : '—';
  L.push(`| ${sceneName(g.scene)} | ${g.n} | ${fmt(d)} | ${ciTxt} | ${deltaWord(d)} |`);
}
L.push('');

// ---- 批次明细 ----
L.push('## 批次明细','', '> 判定列:PASS=探针全过;FAIL 分类见括号(INTERACTION=交互类探针未过、PERFORMANCE=性能/视觉类等);',
  '> BUDGET_EXHAUSTED=触发冻结预算上限(hard,如实计罚);资格列解释见文末"数据保留说明"。','');
for (const b of agg.batches) {
  L.push(`### ${b.batchId}`,'',
    '| 场景 | cocosair 客观/视觉/正式 | three 客观/视觉/正式 | 判定(A=cocosair / T=three) | 资格 |','|---|---|---|---|---|');
  for (const p of b.pairs) {
    const cell = (a) => `${fmt(a.objective?.total)}/${fmt(a.visual18)}/${fmt(a.formal?.total)}`;
    const verdict = (a) => {
      if (!a.verdict) return '—';
      let s = a.verdict === 'PASS' ? 'PASS' : `FAIL(${a.classification ?? '?'})`;
      if (a.budgetExceeded || String(a.classification) === 'BUDGET_EXHAUSTED') s += '⚠预算';
      return s;
    };
    L.push(`| ${sceneName(p.scene)} | ${cell(p.arms.cocosair)} | ${cell(p.arms.three)} | A:${verdict(p.arms.cocosair)} / T:${verdict(p.arms.three)} | ${qualWord(p.qualificationStatus)} |`);
  }
  L.push('');
}

// ---- 数据保留说明 ----
L.push('## 数据保留说明','',
  '- **formal 总分为 "—"**:该臂缺代码健康(S4)或视觉分,或 G7 门禁未过——缺什么不补什么,不用估计值填充。',
  '- **诊断区对**(资格列非"合格"):时序超差、预算超限、spec 被新版本取代或证据链缺口;它们的分数**只进诊断不进场景对比**。',
  '- **视觉 40 分来自双盲评 Judge**(主题锚定一致性验证,0 unreliable 为通过线);E10 类材料若 HUD 印有引擎名,属匿名化瑕疵,已另行留档。',
  '- needsRecalibration(某臂超越 Reference 天花板 3%+):' + ((agg.rulerStatus?.needsRecalibration?.length) ? agg.rulerStatus.needsRecalibration.join('、') + ' —— 量尺复测候选,战役完成后统一处理。' : '无。'),
  '- 引擎差距归因(为什么领先/落后)见同目录 cocosair-gap-map.md(R2 增补 2026-10-06)。','');

fs.writeFileSync(path.join(RESULTS, 'reports', 'latest', 'EXPERIMENT-REPORT.md'), L.join('\n') + '\n');
console.log('[report] EXPERIMENT-REPORT.md 已刷新(' + agg.batches.length + ' 批次 / ' + agg.batches.reduce((t, b) => t + b.pairs.length, 0) + ' 对)');
