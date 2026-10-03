// M10 全量聚合器(多批次/多 rep/多知识级)— FIX-B 整改版
// 输入:results/<batchId>/PAIR-*/{pair.json, arm-*/validation/report.json}
//      + <batchId>/blind/visual-scores.json + gates/G7.json + reference/private/REFERENCE-VERSIONS.json(量尺账本)
// 输出:results/aggregated.json —— 逐 pair 评分(formal / objective / provisionalVisual 三口径)、
//      成对指标、(scene×knowledge) 分组统计、KnowledgeGain、量尺状态。
//
// FIX-B 整改要点:
//  1. Reference 分数【只读 RULER 账本】(reference/private/REFERENCE-VERSIONS.json 的冻结指标),
//     不再动态扫描各批次 blind/judge-pass-1 的 referenceItems(refCeilingVisual 已删除);
//  2. G7 传播:gates/G7.json status != PASS 时,每对 formal 全 null
//     {total, attainment, pairedDelta} + visualStatus='INVALID(G7 <status>)';
//     visual 原始折算分保留在 provisionalVisualScore(非正式);objective(S1+S2+S3)照常输出;
//  3. S4 代码健康:读 <workspace>/validation/code-review.json
//     ({structure{score,max,evidence}, antiPatterns{...}, total, reviewer, protocolHash}),
//     缺失 → s4=null + s4Pending:true,不再默认 5 分;
//  4. CEILING_BREACH:objective/formal attainment > 1.03 → 该 arm 标 ceilingBreach:true,
//     汇总进顶部 rulerStatus.needsRecalibration=[scene:engine];如实报告,不 clamp。
//
// 双跑一致性:除 generatedAt 外必须字节一致(bootstrap 固定种子 42;不得引入时间/随机源)。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS = path.join(BENCH, 'results');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const chromeCached = (() => { try { return fs.readFileSync(path.join(BENCH, 'harness', 'chrome-version.cache.txt'), 'utf8').trim(); } catch { return 'unknown'; } })();
// P0(用户裁决待定):maxToolCalls 机器强制模式。hard=冻结合同(缺 toolcall 计数 → PARTIAL 不能进 core);
// diagnostic=宿主运行时确实无法暴露计数时的显式让步,必须先在 config/agents.yaml 增 'toolCallsMode: diagnostic' 并重冻结 G0。
const toolCallsMode = (() => { try { const y = fs.readFileSync(path.join(BENCH, 'config', 'agents.yaml'), 'utf8'); return /toolCallsMode:s*diagnostic/.test(y) ? 'diagnostic' : 'hard'; } catch { return 'hard'; } })();
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

// ---- FIX-B 3:S4 代码健康(评审留档;缺失 → null + pending,不默认 5 分)
function readS4(reviewPath) {
  if (!fs.existsSync(reviewPath)) return { s4: null, s4Pending: true, s4Source: null };
  let cr = null;
  try { cr = rj(reviewPath); } catch (e) { return { s4: null, s4Pending: true, s4Source: reviewPath, s4Error: `unparseable: ${e.message}` }; }
  const s4 = (typeof cr.total === 'number' && cr.total >= 0 && cr.total <= 5)
    ? cr.total
    : ((typeof cr.structure?.score === 'number' && typeof cr.antiPatterns?.score === 'number')
      ? cr.structure.score + cr.antiPatterns.score : null);
  return {
    s4,
    s4Pending: s4 == null,
    s4Source: reviewPath,
    s4Review: {
      structure: cr.structure ?? null,
      antiPatterns: cr.antiPatterns ?? null,
      total: typeof cr.total === 'number' ? cr.total : null,
      reviewer: cr.reviewer ?? null,
      protocolHash: cr.protocolHash ?? null,
    },
  };
}

// 单臂评分:S1 7+5+3 / S2 30×passRate / S3 6+4(公式与冻结 metric-spec 一致);
// S3 生命周期 6 分 = probe-meta sidecar 声明的 lifecycleProbeIds 全部 PASS(整改 §12);
// sidecar 缺失时退回 report.scoreInputs.s3.lifecycleProbePassed 单探针口径并标 lifecycleMode。
// S4 来自 code-review.json;visual(40 制)仅作 provisional(G7 未过时非正式)。
function runScore(report, visual18, sceneId) {
  const si = report.scoreInputs ?? {};
  const s1 = (report.build?.ok ? 7 : 0)
    + (report.ready?.appReady && report.ready?.benchReady && !(report.console?.uncaughtErrors > 0) ? 5 : 0)
    + ((si.s1?.firstShotNonBlank ?? (report.probePassRate > 0)) ? 3 : 0);
  const s2 = Math.round(30 * (report.probePassRate ?? 0));
  let lifecycleOk = si.s3?.lifecycleProbePassed ?? false;
  let lifecycleMode = 'single-probe(report.scoreInputs)';
  let lifecycleIds = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(BENCH, 'harness', 'runner', 'probe-meta', `${sceneId}.json`), 'utf8'));
    if (Array.isArray(meta.lifecycleProbeIds) && meta.lifecycleProbeIds.length) {
      lifecycleIds = meta.lifecycleProbeIds;
      const statuses = Object.fromEntries((report.probes ?? []).map((p) => [p.probeId, p.status]));
      lifecycleOk = meta.lifecycleProbeIds.every((id) => statuses[id] === 'PASS');
      lifecycleMode = 'full-set(probe-meta)';
    }
  } catch { /* sidecar 缺失,保持单探针口径 */ }
  const s3 = (lifecycleOk ? 6 : 0) + ((report.fps ?? 0) >= 30 ? 4 : 0);
  return { s1, s2, s3, lifecycleMode, lifecycleIds };
}

// ---- FIX-B 1:Reference 满分线只读 RULER 账本(冻结时写入的完整指标)
let refEpochs = null, refRulerId = null, refLedgerProtocol = null, legacyLedger = false;
try {
  const ledger = rj(path.join(BENCH, 'reference', 'private', 'REFERENCE-VERSIONS.json'));
  refEpochs = ledger.epochs; refRulerId = ledger.rulerId || null; refLedgerProtocol = ledger.protocol || null;
} catch { /* 账本缺失:Attainment 不可算,如实标 unknown */ }
const ceiling = {};
for (let i = 1; i <= 10; i++) {
  const s = 'E' + String(i).padStart(2, '0');
  for (const e of ['three', 'cocosair']) {
    const ep = refEpochs?.[`${s}:${e}`] ?? null;
    const hasNewMetrics = ep && ep.objectiveScore != null;
    if (!hasNewMetrics && ep?.ceiling != null) legacyLedger = true; // 旧版账本(仅 ceiling 字段)
    ceiling[`${s}:${e}`] = ep ? {
      objective: ep.objectiveScore ?? null,
      objectiveBreakdown: ep.objectiveBreakdown ?? null,
      visual18: ep.visualRaw18 ?? null,
      visual40: ep.visualScore40 ?? null,
      total: ep.totalScore ?? null,
      totalLegacy: ep.totalScore == null && ep.ceiling != null ? ep.ceiling : null, // 旧口径(含默认 S4=5)
      refVersion: ep.refVersion ?? null,
      validationRevision: ep.validationRevision ?? 1,
      frozenUnderRuler: ep.frozenUnderRuler ?? null,
      evidenceHash: ep.evidenceHash ?? null,
    } : { objective: null, total: null, note: 'no-ruler-entry' };
  }
}

// ---- FIX-B 2:G7 盲评有效性门禁(状态传播进每对 formal 口径)
let g7 = null;
try { g7 = rj(path.join(BENCH, 'gates', 'G7.json')); } catch { /* 门禁文件缺失视同未过 */ }
const g7Status = g7?.status ?? 'MISSING';
const g7Pass = g7Status === 'PASS';

const outBatches = [];
const groupMap = new Map();
const batchQual = {}; // batchId → QUALIFICATION.json 内容(track/qualification 门禁数据源)
const needsRecalibration = [];
// coordinator 自测批次(batches.json selftestNote:未运行任何 Agent Run)不进入聚合;
// 该目录会被 run-round 自测临时重建,聚合若纳入会污染正式看板。
const SELFTEST_BATCHES = new Set(['B-00010101-R99']);
const excludedBatches = [];
for (const b of [...(fs.existsSync(path.join(RESULTS, 'batches.json')) ? rj(path.join(RESULTS, 'batches.json')) : { batches: [] }).batches].sort((x, y) => (x.batchId < y.batchId ? -1 : 1))) {
  if (SELFTEST_BATCHES.has(b.batchId)) { excludedBatches.push({ batchId: b.batchId, reason: 'coordinator selftest 批次(batches.json selftestNote),未运行任何 Agent Run' }); continue; }
  const bDir = path.join(RESULTS, b.batchId);
  if (!fs.existsSync(bDir)) continue;
  try { batchQual[b.batchId] = rj(path.join(bDir, 'QUALIFICATION.json')); } catch { /* 无鉴定文件 */ }
  let vis = {};
  try { vis = rj(path.join(bDir, 'blind', 'visual-scores.json')).pairs || {}; } catch { /* 无视觉分 */ }
  const pairs = [];
  for (const pd of fs.readdirSync(bDir, { withFileTypes: true })) {
    if (!pd.isDirectory() || !pd.name.startsWith('PAIR-')) continue;
    const pj = rj(path.join(bDir, pd.name, 'pair.json'));
    const arms = {};
    for (const armKey of ['A', 'B']) {
      const armLetter = armKey.toLowerCase();
      const engine = pj.arms[armKey].engine;
      const armDir = path.join(bDir, pd.name, 'arm-' + armLetter);
      const repPath = path.join(armDir, 'validation', 'report.json');
      const v18 = vis[pd.name]?.[engine] ?? null;
      if (!fs.existsSync(repPath)) { arms[engine] = { status: pj.arms[armKey].status, reportMissing: true }; continue; }
      const rep = rj(repPath);
      const { s1, s2, s3, lifecycleMode, lifecycleIds } = runScore(rep, v18, pj.sceneId);
      const s4info = readS4(path.join(armDir, 'validation', 'code-review.json'));
      const objectiveTotal = s1 + s2 + s3;
      const provisionalVisual = v18 != null ? Math.round(v18 * 40 / 18) : null;
      // formal 总分:S4 已评审 + G7 PASS(视觉可用)才有定义
      const formalTotal = (g7Pass && s4info.s4 != null && provisionalVisual != null)
        ? objectiveTotal + s4info.s4 + provisionalVisual : null;
      const ruler = ceiling[`${pj.sceneId}:${engine}`];
      // RULER 协议兼容门禁(整改 P0-2):objective 相关四输入 + validator 协议必须与量尺冻结时一致,
      // 否则 objectiveAttainment=null + rulerStatus=RULER_PROTOCOL_MISMATCH(fail closed,不靠人工 ceiling-check)
      const epochEntry = refEpochs ? refEpochs[`${pj.sceneId}:${engine}`] : null;
      const compat = {};
      // P0-2 引擎指纹:air=tarball sha(pair 冻结);three=版本串(与 RULER 账本同口径)
      const actualEngine = engine === 'cocosair' ? (pj.airPackageHash ?? null) : ('three@' + JSON.parse(fs.readFileSync(path.join(BENCH, 'node_modules', 'three', 'package.json'))).version);
      for (const [k, actual] of Object.entries({
        engine: actualEngine,
        brief: pj.briefSha256 ?? null,
        spec: rep.specSha256 ?? null,
        validator: rep.validatorProtocolHash ?? null,
      })) {
        const frozen = epochEntry ? epochEntry.inputs?.[{ engine: 'engine', brief: 'briefSha', spec: 'specSha', validator: 'validatorProtocolHash', toolchain: 'toolchain' }[k]] : undefined;
        compat[k + 'Match'] = frozen == null || actual == null ? 'unknown' : (String(frozen) === String(actual) ? 'matched' : 'MISMATCH');
      }
      // P1-5:比报告冻结指纹,不比 aggregate 宿主当前环境
      compat.toolchainMatch = compat.toolchainMatch ?? 'unknown';
      const objectiveRelevantMismatch = ['engineMatch', 'briefMatch', 'specMatch', 'validatorMatch', 'toolchainMatch'].some(k => compat[k] === 'MISMATCH');
      const objectiveAttainment = (ruler?.objective != null && ruler.objective > 0 && !objectiveRelevantMismatch) ? r2(objectiveTotal / ruler.objective) : null;
      const formalAttainment = (formalTotal != null && ruler?.total != null && ruler.total > 0) ? r2(formalTotal / ruler.total) : null;
      // FIX-B 4:CEILING_BREACH(>1.03 如实标记上报,不 clamp)
      const breach = (x) => x != null && x > 1.03;
      if (breach(objectiveAttainment) || breach(formalAttainment)) {
        needsRecalibration.push(`${pj.sceneId}:${engine}`);
      }
      arms[engine] = {
        s1, s2, s3, lifecycleMode, lifecycleIds,
        s4: s4info.s4, s4Pending: s4info.s4Pending, ...(s4info.s4Source ? { s4Source: path.relative(BENCH, s4info.s4Source).replaceAll('\\', '/') } : {}), ...(s4info.s4Error ? { s4Error: s4info.s4Error } : {}),
        objectiveTotal,
        verdict: rep.verdict, classification: rep.classification,
        ...(rep.classificationEvidence ? { classificationEvidence: rep.classificationEvidence } : {}),
        ...(rep.inputGuard ? { inputGuard: rep.inputGuard } : {}),
        ...(rep.specSha256 ? { specSha256: rep.specSha256 } : {}), ...(rep.validatorProtocolHash ? { validatorProtocolHash: rep.validatorProtocolHash } : {}),
        passRate: rep.probePassRate, fps: rep.fps,
        visual18: v18,
        provisionalVisualScore: provisionalVisual, // FIX-B:视觉折算分仅作参考(非正式)
        visualPending: v18 == null,
        formal: { total: formalTotal, attainment: formalAttainment },
        objective: { total: objectiveTotal, attainment: objectiveAttainment },
        rulerStatus: objectiveRelevantMismatch ? 'RULER_PROTOCOL_MISMATCH(' + ['engineMatch','briefMatch','specMatch','validatorMatch','toolchainMatch'].filter(k=>compat[k]==='MISMATCH').join('+') + ')' : 'RULER_COMPAT(' + Object.entries(compat).map(([k,v])=>k+'='+v).join(',') + ')',
        ...(breach(objectiveAttainment) || breach(formalAttainment) ? { ceilingBreach: true } : {}),
        report: `${b.batchId}/${pd.name}/arm-${armLetter}/validation/report.json`,
      };
    }
    const objBoth = arms.three?.objective?.total != null && arms.cocosair?.objective?.total != null;
    const objDelta = objBoth ? arms.cocosair.objective.total - arms.three.objective.total : null;
    const formalBoth = arms.three?.formal?.total != null && arms.cocosair?.formal?.total != null;
    const formalDelta = formalBoth ? arms.cocosair.formal.total - arms.three.formal.total : null;
    // 纪元匹配:该批次跑的 AIR 引擎是否与量尺冻结时同版(不匹配则 Attainment 跨版本,单列)
    const epoch = refEpochs ? refEpochs[`${pj.sceneId}:cocosair`] : null;
    const airEpochMatch = !epoch ? 'unknown(账本未冻结)' : (pj.airPackageHash === epoch.inputs.engine ? 'matched' : 'engine-differs');
    pairs.push({
      pairId: pd.name, batchId: b.batchId, scene: pj.sceneId, knowledge: pj.knowledge, rep: pj.repetition, pilot: pj.pilot ?? false, track: pj.track || (pj.pilot ? 'pilot' : 'core'),
      qualificationStatus: (batchQual[b.batchId]?.pairs || []).find(q => q.pairId === pd.name)?.status ?? null,
      arms,
      // FIX-B 2:formal 口径 —— G7 未过时全 null + visualStatus 标注,不得以任何替代值填充
      formal: g7Pass ? {
        total: { three: arms.three?.formal?.total ?? null, cocosair: arms.cocosair?.formal?.total ?? null },
        attainment: { three: arms.three?.formal?.attainment ?? null, cocosair: arms.cocosair?.formal?.attainment ?? null },
        pairedDelta: formalDelta,
        visualStatus: 'VALID',
      } : {
        total: null,
        attainment: null,
        pairedDelta: null,
        visualStatus: `INVALID(G7 ${g7Status})`,
        reason: `gates/G7.json status=${g7Status};盲评视觉分不得进入正式总分,visual 参考值见 provisionalVisualScore`,
      },
      // FIX-B 2:objective 口径(S1+S2+S3;S4 待评审分列,不受 G7 影响)
      objective: {
        total: { three: arms.three?.objective?.total ?? null, cocosair: arms.cocosair?.objective?.total ?? null },
        attainment: { three: arms.three?.objective?.attainment ?? null, cocosair: arms.cocosair?.objective?.attainment ?? null },
        pairedDelta: objDelta,
        basis: 'S1+S2+S3(S4 待 code-review,视觉不参于 objective)',
      },
      provisionalVisualScore: {
        three: arms.three?.provisionalVisualScore ?? null,
        cocosair: arms.cocosair?.provisionalVisualScore ?? null,
        note: '原 visual 18→40 折算分,仅参考,非正式口径',
      },
      ceilingRuler: { air: airEpochMatch, refVersion: epoch ? epoch.refVersion : null, validationRevision: epoch ? epoch.validationRevision ?? 1 : null, rulerId: refRulerId, refFrozenUnderRuler: epoch ? (epoch.frozenUnderRuler || epoch.frozenInEpoch) : null, batchEngineSha: (pj.airPackageHash || '').slice(0, 8), ceilingEngineSha: epoch ? String(epoch.inputs.engine).slice(0, 8) : null },
    });
    const gk = `${pj.sceneId}|${pj.knowledge}`;
    // P0-1 分层:core 统计只收 track==='core' 且 pair 级 qualification 通过且量尺兼容;
    // pilot / targeted-pilot / 不合格对 → 只进 diagnosticGroups(观察口径,不进 median/CI)
    const track = pj.track || (pj.pilot ? 'pilot' : 'core');
    const qualEntry = (batchQual[b.batchId]?.pairs || []).find(q => q.pairId === pd.name);
    const qualStatus = qualEntry ? qualEntry.status : (b.batchId === 'B-20261002-R1' ? 'LEGACY_PROVISIONAL' : null);
    const coreEligible = track === 'core'
      && (qualStatus === 'QUALIFIED' || qualStatus === 'QUALIFIED' + '_OBJECTIVE')
      && compat.engineMatch === 'matched' && compat.specMatch === 'matched'
      && compat.validatorMatch === 'matched' && !objectiveRelevantMismatch;
    if (!groupMap.has(gk)) groupMap.set(gk, { scene: pj.sceneId, knowledge: pj.knowledge, deltas: [], outcomes: [], attThree: [], attAir: [] });
    const g = groupMap.get(gk);
    // 分组统计:formal 可用时用 formal delta;G7 未过时退居 objective delta 并标注 basis
    const groupDelta = formalDelta != null ? formalDelta : objDelta;
    if (groupDelta != null) {
      if (coreEligible) { g.deltas.push(groupDelta); g.outcomes.push(Math.abs(groupDelta) <= 3 ? 'TIE' : (groupDelta > 0 ? 'AIR_WIN' : 'THREE_WIN')); }
      // 诊断区:非 core 或不合格对的 delta 记入 pair 自身(diagnosticDeltas),不进 g.* 正式统计
      (g.diagnosticDeltas = g.diagnosticDeltas || []).push({ pairId: pd.name, track, qualStatus, delta: groupDelta });
    }
    const attT = arms.three?.objective?.attainment ?? null, attA = arms.cocosair?.objective?.attainment ?? null;
    if (coreEligible) { if (attT != null) g.attThree.push(attT); if (attA != null) g.attAir.push(attA); }
  }
  outBatches.push({ batchId: b.batchId, createdAt: b.createdAt, note: b.note, pairs });
}

const groups = [...groupMap.values()].map((g) => ({
  scene: g.scene, knowledge: g.knowledge,
  n: g.deltas.length,
  scope: 'core-only(track=core 且 qualification 合格且量尺兼容);pilot/targeted-pilot/不合格对见 groupsDiagnostic',
  rawDelta: { median: r2(median(g.deltas)), iqr: iqr(g.deltas), bootstrapCi95: bootstrapMedianCiDelta(g.deltas) },
  winTieLoss: { air: g.outcomes.filter(o => o === 'AIR_WIN').length, tie: g.outcomes.filter(o => o === 'TIE').length, three: g.outcomes.filter(o => o === 'THREE_WIN').length },
  attainmentMedian: { three: r2(median(g.attThree)), air: r2(median(g.attAir)), basis: 'objective 对 RULER objectiveScore(量尺兼容对)' },
  diagnosticDeltas: g.diagnosticDeltas || [],
}));

// KnowledgeGain:同 scene 出现多知识级时,按 K 级中位 objective 分差(AIR 与 Three 分别计)
const kgByScene = new Map();
// P0-1 修正:KnowledgeGain 弃 if(pilot) 过滤,改三重门禁:
//   量尺兼容(RULER_COMPAT)+ qualification ∈ {QUALIFIED, QUALIFIED_OBJECTIVE} +
//   track:K0/K1 → core;K2 → k2-ablation。其余(pilot/targeted-pilot/不合格)一律不进。
const kgTrackAllow = (p) => {
  if (p.rulerStatus && !String(p.rulerStatus).startsWith('RULER_COMPAT')) return false;
  const qual = p.qualificationStatus ?? null;
  if (qual != null && !['QUALIFIED', 'QUALIFIED_OBJECTIVE'].includes(qual)) return false;
  if (p.knowledge === 'K2') return p.track === 'k2-ablation';
  return p.track === 'core';
};
for (const b of outBatches) for (const p of b.pairs) {
  if (!kgTrackAllow(p)) continue;
  for (const e of ['three', 'cocosair']) {
    const t = p.arms[e]?.objective?.total ?? null;
    if (t == null) continue;
    if (!kgByScene.has(p.scene)) kgByScene.set(p.scene, {});
    kgByScene.get(p.scene)[p.knowledge] = kgByScene.get(p.scene)[p.knowledge] || { three: [], cocosair: [] };
    kgByScene.get(p.scene)[p.knowledge][e].push(t);
  }
}
const knowledgeGain = [];
for (const [scene, ks] of kgByScene) {
  const levels = Object.keys(ks).filter(k => k.startsWith('K'));
  for (const e of ['three', 'cocosair']) {
    const gain = {};
    for (const k of levels.sort()) gain[k] = r2(median(ks[k][e] ?? []));
    const base = gain.K0;
    knowledgeGain.push({ scene, engine: e, basis: 'objective(S1+S2+S3)', medianRawByK: gain, knowledgeGainVsK0: base != null ? Object.fromEntries(levels.filter(x => x !== 'K0').map(x => [x, r2(gain[x] - base)])) : null });
  }
}

wj(path.join(RESULTS, 'aggregated.json'), {
  generatedAt: new Date().toISOString(),
  formula: 'metric-spec:S1(7+5+3)+S2(30×passRate)+S3(6+4)+S4(code-review.json,缺失则 pending 不默认 5)+visual(round(Σ18×40/18));G7 未过时 formal 全 null,objective=S1+S2+S3 照常,visual 仅 provisional',
  rulerStatus: {
    rulerId: refRulerId,
    source: 'reference/private/REFERENCE-VERSIONS.json(只读冻结账本;不动态扫描批次 judge 数据)',
    ...(refLedgerProtocol ? { protocol: refLedgerProtocol } : {}),
    ...(legacyLedger ? { legacyLedgerWarning: '账本含旧版条目(仅 ceiling 字段,无 objectiveScore/totalScore);请重跑 reference-versions.mjs 冻结完整指标' } : {}),
    g7: { gate: 'G7 BLIND_JUDGE_VALIDITY', status: g7Status, source: 'gates/G7.json', formalImpact: g7Pass ? 'VALID' : 'INVALID — formal total/attainment/pairedDelta 全 null,视觉分仅 provisional' },
    needsRecalibration, // CEILING_BREACH:>1.03 的 scene:engine 清单(如实上报,不 clamp)
  },
  batches: outBatches,
  ...(excludedBatches.length ? { excludedBatches } : {}),
  groups,
  knowledgeGain,
  referenceCeiling: Object.fromEntries(Object.entries(ceiling).map(([k, v]) => [k.replace(':', '/'), v])),
  notes: [
    '批次布局 results/<B-YYYYMMDD-Rnn>/;coordinator auto-batch 支持单日多轮。',
    'FIX-B:Reference 满分线只读 RULER 账本冻结值(objectiveScore/totalScore/evidenceHash),来源见各 entry。账本漂移检测:node run.mjs ceiling-check。',
    'FIX-B:gates/G7.json 非 PASS 时,每对 formal={total:null,attainment:null,pairedDelta:null,visualStatus:"INVALID(G7 <status>)"};objective(S1+S2+S3)与 provisionalVisualScore 照常输出。',
    'FIX-B:S4 读 arm-*/validation/code-review.json(structure/antiPatterns/total/reviewer/protocolHash);缺失 → s4=null+s4Pending:true,不以 5 分填充。',
    'FIX-B:attainment>1.03 → arm.ceilingBreach:true + rulerStatus.needsRecalibration(量尺可能被低估,需重校准;不截断)。',
    '新批次无盲评时 provisionalVisualScore=null(visualPending),补跑 build-blind + judge 后重跑本脚本回填。',
    'KnowledgeGain 仅统计非 pilot pair;K1/K2 批次出现后自动生效;G7 未过期间以 objective 口径计算。',
  ],
});
const n = outBatches.reduce((s, b) => s + b.pairs.length, 0);
console.log(`aggregated.json: ${outBatches.length} batches / ${n} pairs / ${groups.length} groups / kgEntries=${knowledgeGain.length}`);
console.log(`  ruler=${refRulerId} g7=${g7Status} formal=${g7Pass ? 'enabled' : 'ALL-NULL(objective 口径照常)'} needsRecalibration=${JSON.stringify(needsRecalibration)}`);
for (const g of groups) console.log(`  ${g.scene} ${g.knowledge}: n=${g.n} [${g.scope}] medianΔ=${g.rawDelta.median} CI=${JSON.stringify(g.rawDelta.bootstrapCi95)} W/T/L=${g.winTieLoss.air}/${g.winTieLoss.tie}/${g.winTieLoss.three}`);
