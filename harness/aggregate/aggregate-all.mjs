// M10 全量聚合器(多批次/多 rep/多知识级)
// 输入:results/<batchId>/PAIR-*/{pair.json, arm-*/validation/report.json} + <batchId>/blind/visual-scores.json
// 输出:results/aggregated.json —— 逐 pair 评分、成对指标、(scene×knowledge) 分组统计(N/median/IQR/
//       win-tie-loss/bootstrap CI)、KnowledgeGain(出现 K1/K2 批次时自动计算)、引擎注记。
// 评分公式与 metric-spec 一致:S1 7+5+3 / S2 30×passRate / S3 6+4 / S4 5 / visual=round(Σ18×40/18)。
// 视觉分缺失的 run:visual=null(标记 visualPending),total 以 objectiveOnly 报告,不冒充总分。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS = path.join(BENCH, 'results');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const r2 = (x) => Math.round(x * 100) / 100;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const iqr = (a) => { if (a.length < 2) return null; const s = [...a].sort((x, y) => x - y); const q = (p) => { const h = (s.length - 1) * p; const lo = Math.floor(h), hi = Math.ceil(h); return s[lo] + (s[hi] - s[lo]) * (h - lo); }; return r2(q(0.75) - q(0.25)); };
function bootstrapMedianCiDelta(deltas, draws = 2000, seed = 42) {
  if (deltas.length < 2) return null;
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  const meds = [];
  for (let i = 0; i < draws; i++) {
    const sample = deltas.map(() => deltas[Math.floor(rnd() * deltas.length)]);
    meds.push(median(sample));
  }
  meds.sort((a, b) => a - b);
  return [r2(meds[Math.floor(draws * 0.025)]), r2(meds[Math.floor(draws * 0.975)])];
}

function runScore(report, visual18) {
  const si = report.scoreInputs ?? {};
  const s1 = (report.build?.ok ? 7 : 0)
    + (report.ready?.appReady && report.ready?.benchReady && !(report.console?.uncaughtErrors > 0) ? 5 : 0)
    + ((si.s1?.firstShotNonBlank ?? (report.probePassRate > 0)) ? 3 : 0);
  const s2 = Math.round(30 * (report.probePassRate ?? 0));
  const s3 = ((si.s3?.lifecycleProbePassed ?? false) ? 6 : 0) + ((report.fps ?? 0) >= 30 ? 4 : 0);
  const s4 = 5;
  const visual = visual18 != null ? Math.round(visual18 * 40 / 18) : null;
  return { s1, s2, s3, s4, visual, total: visual != null ? s1 + s2 + s3 + s4 + visual : null, objectiveOnly: s1 + s2 + s3 + s4 };
}

// Reference Ceiling(固定):60 + Judge REF 视觉(在任一批次 blind/judge-pass-1 的 referenceItems 找)
function refCeilingVisual() {
  const map = {};
  for (const b of fs.readdirSync(RESULTS, { withFileTypes: true })) {
    if (!b.isDirectory() || !/^B-\d{8}-R\d+$/.test(b.name)) continue;
    const jp = path.join(RESULTS, b.name, 'blind', 'judge-pass-1.json');
    if (!fs.existsSync(jp)) continue;
    const key = path.join(RESULTS, b.name, 'blind', 'blinding-key.json');
    const items = rj(jp).referenceItems || [];
    const keyItems = fs.existsSync(key) ? rj(key).referenceItems || [] : [];
    for (const it of items) {
      const meta = keyItems.find(k => k.itemId === it.id || k.itemId === it.itemId)
        || /^REF-(E\d\d)-([XY])-/.exec(it.id) && { scene: RegExp.$1, engine: RegExp.$2 === 'X' ? 'three' : 'cocosair' };
      if (meta) map[`${meta.scene}:${meta.engine}`] = Number(it.total ?? 0);
    }
  }
  return map;
}

const batchesIdx = fs.existsSync(path.join(RESULTS, 'batches.json')) ? rj(path.join(RESULTS, 'batches.json')) : { batches: [] };
const refVis = refCeilingVisual();
const ceiling = {};
for (let i = 1; i <= 10; i++) {
  const s = 'E' + String(i).padStart(2, '0');
  for (const e of ['three', 'cocosair']) {
    const v = refVis[`${s}:${e}`];
    ceiling[`${s}:${e}`] = { visual18: v ?? null, total: v != null ? 60 + Math.round(v * 40 / 18) : null };
  }
}

const outBatches = [];
const groupMap = new Map();
for (const b of [...batchesIdx.batches].sort((x, y) => (x.batchId < y.batchId ? -1 : 1))) {
  const bDir = path.join(RESULTS, b.batchId);
  if (!fs.existsSync(bDir)) continue;
  let vis = {};
  try { vis = rj(path.join(bDir, 'blind', 'visual-scores.json')).pairs || {}; } catch { /* 无视觉分 */ }
  const pairs = [];
  for (const pd of fs.readdirSync(bDir, { withFileTypes: true })) {
    if (!pd.isDirectory() || !pd.name.startsWith('PAIR-')) continue;
    const pj = rj(path.join(bDir, pd.name, 'pair.json'));
    const arms = {};
    for (const armKey of ['A', 'B']) {
      const engine = pj.arms[armKey].engine;
      const repPath = path.join(bDir, pd.name, 'arm-' + armKey.toLowerCase(), 'validation', 'report.json');
      const v18 = vis[pd.name]?.[engine] ?? null;
      if (!fs.existsSync(repPath)) { arms[engine] = { status: pj.arms[armKey].status, reportMissing: true }; continue; }
      const rep = rj(repPath);
      const sc = runScore(rep, v18);
      arms[engine] = { ...sc, verdict: rep.verdict, classification: rep.classification, passRate: rep.probePassRate, fps: rep.fps, visual18: v18, visualPending: v18 == null, report: `${b.batchId}/${pd.name}/arm-${armKey.toLowerCase()}/validation/report.json` };
    }
    const both = arms.three && arms.cocosair && arms.three.total != null && arms.cocosair.total != null;
    const rawDelta = both ? arms.cocosair.total - arms.three.total : null;
    const att = {};
    for (const e of ['three', 'cocosair']) att[e] = (arms[e]?.total != null && ceiling[`${pj.sceneId}:${e}`]?.total) ? r2(arms[e].total / ceiling[`${pj.sceneId}:${e}`].total) : null;
    pairs.push({
      pairId: pd.name, batchId: b.batchId, scene: pj.sceneId, knowledge: pj.knowledge, rep: pj.repetition, pilot: pj.pilot ?? false,
      arms,
      attainment: att,
      paired: both ? {
        rawDeltaAirMinusThree: rawDelta,
        attainmentDeltaAirMinusThree: (att.cocosair != null && att.three != null) ? r2(att.cocosair - att.three) : null,
        outcome: Math.abs(rawDelta) <= 3 ? 'TIE' : (rawDelta > 0 ? 'AIR_WIN' : 'THREE_WIN'),
      } : { incomplete: true },
    });
    const gk = `${pj.sceneId}|${pj.knowledge}`;
    if (!groupMap.has(gk)) groupMap.set(gk, { scene: pj.sceneId, knowledge: pj.knowledge, deltas: [], outcomes: [], attThree: [], attAir: [] });
    const g = groupMap.get(gk);
    if (rawDelta != null) { g.deltas.push(rawDelta); g.outcomes.push(Math.abs(rawDelta) <= 3 ? 'TIE' : (rawDelta > 0 ? 'AIR_WIN' : 'THREE_WIN')); }
    if (att.three != null) g.attThree.push(att.three);
    if (att.cocosair != null) g.attAir.push(att.cocosair);
  }
  outBatches.push({ batchId: b.batchId, createdAt: b.createdAt, note: b.note, pairs });
}

const groups = [...groupMap.values()].map((g) => ({
  scene: g.scene, knowledge: g.knowledge, n: g.deltas.length,
  rawDelta: { median: r2(median(g.deltas)), iqr: iqr(g.deltas), bootstrapCi95: bootstrapMedianCiDelta(g.deltas) },
  winTieLoss: { air: g.outcomes.filter(o => o === 'AIR_WIN').length, tie: g.outcomes.filter(o => o === 'TIE').length, three: g.outcomes.filter(o => o === 'THREE_WIN').length },
  attainmentMedian: { three: r2(median(g.attThree)), air: r2(median(g.attAir)) },
}));

// KnowledgeGain:同 scene 出现多知识级时,按 K 级中位 raw 分差(AIR 与 Three 分别计)
const kgByScene = new Map();
for (const b of outBatches) for (const p of b.pairs) {
  if (p.pilot) continue;
  for (const e of ['three', 'cocosair']) {
    const t = p.arms[e]?.total ?? p.arms[e]?.objectiveOnly ?? null;
    if (t == null) continue;
    if (!kgByScene.has(p.scene)) kgByScene.set(p.scene, {});
    kgByScene.get(p.scene)[p.knowledge] = kgByScene.get(p.scene)[p.knowledge] || { three: [], cocosair: [] };
    kgByScene.get(p.scene)[p.knowledge][e].push(t);
  }
}
const knowledgeGain = [];
for (const [scene, ks] of kgByScene) {
  for (const [k, arr] of Object.entries(ks)) {
    const m = (e) => median(arr[e] ?? []);
    if (m('three') != null) ks['__m' + k] = ks['__m' + k] || {};
  }
  const levels = Object.keys(ks).filter(k => k.startsWith('K'));
  for (const e of ['three', 'cocosair']) {
    const gain = {};
    for (const k of levels.sort()) gain[k] = r2(median(ks[k][e] ?? []));
    const base = gain.K0;
    knowledgeGain.push({ scene, engine: e, medianRawByK: gain, knowledgeGainVsK0: base != null ? Object.fromEntries(levels.filter(x => x !== 'K0').map(x => [x, r2(gain[x] - base)])) : null });
  }
}

wj(path.join(RESULTS, 'aggregated.json'), {
  generatedAt: new Date().toISOString(),
  formula: 'metric-spec:S1(7+5+3)+S2(30×passRate)+S3(6+4)+S4(5)+visual(round(Σ18×40/18));visual 缺失时 total=null(objectiveOnly 报告)',
  batches: outBatches,
  groups,
  knowledgeGain,
  referenceCeiling: Object.fromEntries(Object.entries(ceiling).map(([k, v]) => [k.replace(':', '/'), v])),
  notes: [
    '批次布局 results/<B-YYYYMMDD-Rnn>/;coordinator auto-batch 支持单日多轮。',
    '新批次无盲评时 visual=null(visualPending),补跑 build-blind + judge 后重跑本脚本回填。',
    'KnowledgeGain 仅统计非 pilot pair;K1/K2 批次出现后自动生效。',
  ],
});
const n = outBatches.reduce((s, b) => s + b.pairs.length, 0);
console.log(`aggregated.json: ${outBatches.length} batches / ${n} pairs / ${groups.length} groups / kgEntries=${knowledgeGain.length}`);
for (const g of groups) console.log(`  ${g.scene} ${g.knowledge}: n=${g.n} medianΔ=${g.rawDelta.median} CI=${JSON.stringify(g.rawDelta.bootstrapCi95)} W/T/L=${g.winTieLoss.air}/${g.winTieLoss.tie}/${g.winTieLoss.three}`);
