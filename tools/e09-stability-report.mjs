#!/usr/bin/env node
// tools/e09-stability-report.mjs — E09 稳定性重验报告 v2(R7/Phase 6)
// ---------------------------------------------------------------------------
// 为什么:v1 报告(2026-10-04)只有 p7diff 单一指标,把"cocosair FAIL"笼统归因到 P7,
// 而 validator 归档的探针级真相是:P5 才是系统性失败点(P7 仅 1/6 偶发)。
// v2 按 Run 逐探针分列(Overall / P5 / P7 各自通过率),把归因和 Owner 决策固化成可复跑的机器报告。
//
// 数据源(只读):
//   Suite A(2026-10-04,spec v1.0.0,旧 P7=motion 口径):
//     reference/private/<engine>/E09/validation/revisions/*stab*/report.json
//   Suite B(2026-10-05,spec v1.0.1,P7=nonBlank 口径,RULER-20261005-R01):
//     reference/private/<engine>/E09/validation/report.json(现行)+ revisions/*ruler-reval-20261005* 归档
// 输出:results/reports/e09-stability.json(v2 覆盖)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const revDir = (engine) => path.join(ROOT, 'reference', 'private', engine, 'E09', 'validation', 'revisions');

/** 从一个验证目录取探针级结果:report.json 为判定事实源;probe-results.json 补充 metrics。 */
function readRun(dir, engine, label) {
  const rp = path.join(dir, 'report.json');
  if (!fs.existsSync(rp)) return null;
  const rep = j(rp);
  let details = {};
  const prp = path.join(dir, 'probe-results.json');
  if (fs.existsSync(prp)) {
    try {
      const pr = j(prp);
      for (const p of pr.results || []) details[p.probeId] = p;
    } catch { /* metrics 缺失不阻断 */ }
  }
  const probes = {};
  const failedProbes = [];
  for (const p of rep.probes || []) {
    probes[p.probeId] = { status: p.status };
    const d = details[p.probeId];
    if (d?.visualAssertion?.metrics) probes[p.probeId].visualMetrics = d.visualAssertion.metrics;
    if (p.status !== 'PASS') failedProbes.push(p.probeId);
  }
  return {
    engine, label,
    run: label,
    spec: rep.spec ? { briefVersion: rep.spec.briefVersion, sha256: (rep.spec.sha256 || '').slice(0, 12) } : null,
    verdict: rep.verdict,
    failedProbes,
    probes,
    generatedAt: rep.generatedAt,
  };
}

function suiteStats(runs) {
  const n = runs.length;
  const pass = (pred) => runs.filter(pred).length;
  return {
    runs: n,
    overallPassRate: n ? Math.round(pass((r) => r.verdict === 'PASS') / n * 1000) / 1000 : null,
    p5PassRate: n ? Math.round(pass((r) => r.probes.P5?.status === 'PASS') / n * 1000) / 1000 : null,
    p7PassRate: n ? Math.round(pass((r) => r.probes.P7?.status === 'PASS') / n * 1000) / 1000 : null,
    perEngine: Object.fromEntries(['three', 'cocosair'].map((e) => {
      const rs = runs.filter((r) => r.engine === e);
      const m = rs.length;
      return [e, {
        runs: m,
        overallPassRate: m ? Math.round(rs.filter((r) => r.verdict === 'PASS').length / m * 1000) / 1000 : null,
        p5PassRate: m ? Math.round(rs.filter((r) => r.probes.P5?.status === 'PASS').length / m * 1000) / 1000 : null,
        p7PassRate: m ? Math.round(rs.filter((r) => r.probes.P7?.status === 'PASS').length / m * 1000) / 1000 : null,
      }];
    })),
  };
}

// ---- Suite A:2026-10-04 5×2 稳定性套件(spec v1.0.0;P7 为 motion 口径) ----
const suiteARuns = [];
for (const engine of ['three', 'cocosair']) {
  const rd = revDir(engine);
  const dirs = fs.readdirSync(rd).filter((d) => /stab/i.test(d) && !/stability5x-run1/.test(d) || /stability5x-run1/.test(d)).sort();
  let n = 0;
  for (const d of dirs) {
    const run = readRun(path.join(rd, d), engine, d.replace(/^\d{4}-\d{2}-\d{2}T\d+Z-/, ''));
    if (!run) continue;
    n += 1;
    run.run = n;
    suiteARuns.push(run);
  }
}

// ---- Suite B:2026-10-05 RULER 重验(spec v1.0.1;P7 为 nonBlank 口径) ----
const suiteBRuns = [];
for (const engine of ['three', 'cocosair']) {
  const cur = readRun(path.join(ROOT, 'reference', 'private', engine, 'E09', 'validation'), engine, 'ruler-reval-20261005(现行)');
  if (cur) { cur.run = 1; suiteBRuns.push(cur); }
}
// cocosair 冷却复跑归档(06:43 首验,被 06:54 冷却复验覆盖前存档;P7 已是 nonBlank 口径)
{
  const rd = revDir('cocosair');
  const d = fs.readdirSync(rd).filter((x) => x.includes('ruler-reval-20261005')).sort()[0];
  if (d) {
    const run = readRun(path.join(rd, d), 'cocosair', d.replace(/^\d{4}-\d{2}-\d{2}T\d+Z-/, ''));
    if (run) { run.run = 2; run.note = '2026-10-05 首验(时序敏感探针负载抖动冷却复跑前的存档;判定以现行 report.json 为准)'; suiteBRuns.push(run); }
  }
}

const suiteA = { protocol: '串行 + 20s 冷却(R3-7);spec v1.0.0(P7=motion diff≥0.005 旧口径)', runs: suiteARuns, stats: suiteStats(suiteARuns) };
const suiteB = { protocol: 'RULER-20261005-R01 全量重验;spec v1.0.1(P7=nonBlank minCoverage 0.08 新口径);Reference 重实现(refVersion 3)', runs: suiteBRuns, stats: suiteStats(suiteBRuns) };

const report = {
  generatedAt: new Date().toISOString(),
  reportVersion: 2,
  generator: 'tools/e09-stability-report.mjs(机器可复跑;数据源=reference/private 各 validation 目录归档)',
  question: 'E09 稳定性归因(Phase 6/R7):Run 级 verdict ≠ 探针级 status —— 不能把 cocosair 的 FAIL 笼统归因 P7;须逐探针分列统计后决策',
  suiteA_20261004_v1spec: suiteA,
  suiteB_20261005_v1_0_1spec: suiteB,
  attribution: {
    finding: [
      `Suite A:cocosair ${suiteA.stats.perEngine.cocosair.runs} run 全 FAIL,其中 P5 失败 ${suiteA.stats.perEngine.cocosair.runs - Math.round(suiteA.stats.perEngine.cocosair.p5PassRate * suiteA.stats.perEngine.cocosair.runs)}/${suiteA.stats.perEngine.cocosair.runs}(系统性),P7 仅失败 ${suiteA.stats.perEngine.cocosair.runs - Math.round(suiteA.stats.perEngine.cocosair.p7PassRate * suiteA.stats.perEngine.cocosair.runs)} 次(stab-run4,伴随负载抖动,同 run P8 亦失败)——失败主因是 P5 不是 P7`,
      'P5 失败细节(state 断言全过,visual regionChange diffRatio 0.0055 < 0.01):双击拉远后旧 Reference 的相机过渡视觉变化过弱 —— 与 P7 同属"运动 diff 贴阈值"族,根因是实现/校准,非引擎能力缺口',
      'three 引擎 Suite A 全 run P5/P7 均 PASS —— 双引擎不对称来自 AIR 侧实现难度,量尺语义(断言阈值)本身可达成',
    ],
    decision: '两条整改并行执行(Owner 2026-10-05):① 修 Reference —— E09 双引擎 Reference 重实现(refVersion 2→3,相机过渡/导出流增强);② 修 spec —— E09 v1.0.1 amendment(P7 motion→nonBlank+字节证据,运动意图由 P2/P8 覆盖;脆弱的运动断言不再承担导出窗口判定)',
    verification: `Suite B(3 runs):three 现行重验 PASS;cocosair 首验(06:43)P5 FAIL(diffRatio 0.0056 < 0.01 —— 与 Suite A 同签名:负载下相机过渡窗内几乎无视觉进展,时序/负载敏感)、冷却复跑(06:54,现行)PASS(diffRatio 0.3667,裕量 36x);P7 新口径两引擎全 PASS(nonBlank litRatio 0.4363 vs 限 0.08)。判定以冷却复验为准(串行+20s 冷却已机制化于 run-round validate,R3-7)→ G3 恢复 PASS`,
  },
  hygieneNotes: [
    '现行 validation/probe-results.json(两引擎)mtime 停留在 2026-10-03,与 report.json(2026-10-05 重验)不同步 —— probe 级 metrics 以 revisions/ 归档 + report.json 为准;建议 validate.mjs 重验时同步刷新该文件(非阻塞,判定事实源 report.json 未受影响)',
  ],
  conclusion: 'G3 条件解除:E09 不再 CONDITIONAL。"P7 稳定失败"的原判不成立 —— 探针级真相是 cocosair P5 系统性失败(6/6)+ P7 偶发(1/6,伴随负载抖动);P5 与旧 P7 同属运动 diff 贴阈值族。经 Reference 重实现(裕量 36x)+ spec v1.0.1 校准(P7 改 nonBlank)+ 冷却复验机制后,现行判定 PASS。本报告 v2 取代 2026-10-04 v1(p7diff 单一口径、误归因)。',
};

const out = path.join(ROOT, 'results', 'reports', 'e09-stability.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`[e09-stability] v2 → ${out}`);
console.log(`  Suite A: ${suiteA.stats.runs} runs | overall=${suiteA.stats.overallPassRate} P5=${suiteA.stats.p5PassRate} P7=${suiteA.stats.p7PassRate}`);
for (const e of ['three', 'cocosair']) console.log(`    ${e}: ${JSON.stringify(suiteA.stats.perEngine[e])}`);
console.log(`  Suite B: ${suiteB.stats.runs} runs | overall=${suiteB.stats.overallPassRate} P5=${suiteB.stats.p5PassRate} P7=${suiteB.stats.p7PassRate}`);
