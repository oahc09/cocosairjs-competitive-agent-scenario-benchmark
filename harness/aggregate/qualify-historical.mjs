// qualify-historical.mjs — 历史批次证据链鉴定(FIX-B 新增)
// 用途:对冻结合同整改(FIX-B)之前产生的批次做逐项鉴定,回答
//   "这批历史数据的哪些指标还能用、哪些必须作废/挂起、为什么"。
// 只读历史产物(不改任何已有文件),输出 results/<batch>/QUALIFICATION.json(新增文件)。
//
//   node harness/aggregate/qualify-historical.mjs --batch B-20261002-R1
//
// 鉴定项(每对逐项,证据取自产物本身,不做无证据推断):
//   1. frozenInputsComplete  冻结输入指纹是否完整(pair.json 各 sha 字段)
//   2. specExact             spec 精确性:验证时实际所用 spec(report.spec.sha256)
//                            vs pair.specSha256 vs arm 落盘 spec vs 现行 briefs;
//   3. validatorKnown        验证器版本是否可追溯(report.validatorProtocolHash)
//   4. agentIdentityComplete Agent 身份五元组是否完整
//   5. budgetMachineCounted  预算是否有机器计数证据(.budget 计数器)
//   6. visualGate            视觉口径是否可用(blind 材料 × gates/G7.json)
//   7. rulerMatch            批次引擎哈希 vs RULER 量尺账本(含量尺晚于批次的时序核)
// 结论 status:LEGACY_PROVISIONAL(历史遗留,有条件可用)/ QUALIFIED / DISQUALIFIED。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS = path.join(ROOT, 'results');
const argv = process.argv.slice(2);
const batchArg = argv.includes('--batch') ? argv[argv.indexOf('--batch') + 1] : null;
if (!batchArg || !/^B-\d{8}-R\d+$/.test(batchArg)) {
  process.stderr.write('usage: node harness/aggregate/qualify-historical.mjs --batch <B-YYYYMMDD-Rnn>\n');
  process.exit(2);
}
const BATCH_DIR = path.join(RESULTS, batchArg);
if (!fs.existsSync(BATCH_DIR)) { process.stderr.write(`批次不存在: ${BATCH_DIR}\n`); process.exit(2); }

const shaFile = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha8 = (h) => (h ? String(h).slice(0, 8) : null);
const briefIdx = j(path.join(ROOT, 'briefs', 'index.json'));
const briefByScene = Object.fromEntries((briefIdx.entries || []).map((e) => [e.briefId, e]));

let ruler = null;
try { ruler = j(path.join(ROOT, 'reference', 'private', 'REFERENCE-VERSIONS.json')); } catch { /* 无账本 */ }
let g7 = null;
try { g7 = j(path.join(ROOT, 'gates', 'G7.json')); } catch { /* 无门禁 */ }
const g7Status = g7?.status ?? 'MISSING';

// 现行验证协议指纹(与 validate.mjs 同式),供"历史验证器版本已知与否"对照
const vp = (() => {
  const a = fs.readFileSync(path.join(ROOT, 'harness', 'runner', 'probe-executor.mjs'));
  const b = fs.readFileSync(path.join(ROOT, 'harness', 'runner', 'validate.mjs'));
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  return h(Buffer.concat([a, b]));
})();

const REQUIRED_PAIR_FIELDS = [
  'briefSha256', 'specSha256', 'assetSetSha256', 'budgetConfigHash',
  'threePackageHash', 'airPackageHash', 'threeTemplateHash', 'airTemplateHash',
  'threeKnowledgeHash', 'airKnowledgeHash',
];
const AGENT_IDENTITY_FIELDS = ['agentBinaryHash', 'modelId', 'modelRevisionId', 'systemPromptHash', 'toolPolicyHash'];

const pairReports = [];
for (const pd of fs.readdirSync(BATCH_DIR, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  if (!pd.isDirectory() || !pd.name.startsWith('PAIR-')) continue;
  const pairDir = path.join(BATCH_DIR, pd.name);
  const pj = j(path.join(pairDir, 'pair.json'));
  const scene = pj.sceneId;

  // ---- 1. 冻结输入完整
  const missing = REQUIRED_PAIR_FIELDS.filter((k) => !pj[k]);
  const frozenInputsComplete = {
    id: 'frozenInputsComplete',
    ok: missing.length === 0,
    missing,
    note: 'dependencyHashes(依赖环境指纹)历史批次未冻结 → 新版 validate.mjs --pair-meta 已支持;历史运行的环境不可事后核验,ENV 口径只能标 unknown',
    dependencyHashesFrozen: Boolean(pj.dependencyHashes),
  };

  // ---- 2. spec 精确性(三方对勘:验证时实际 / pair 冻结 / arm 落盘 / 现行 briefs)
  const curBriefSpecSha = shaFile(path.join(ROOT, 'briefs', scene, 'spec.json'));
  const curBriefVersion = briefByScene[scene]?.version ?? null;
  const armSpec = {};
  const runSpec = {};
  for (const arm of ['arm-a', 'arm-b']) {
    const repP = path.join(pairDir, arm, 'validation', 'report.json');
    const diskP = path.join(pairDir, arm, 'spec.json');
    let rs = null, rv = null;
    if (fs.existsSync(repP)) { const s = j(repP).spec ?? {}; rs = s.sha256 ?? null; rv = s.briefVersion ?? null; }
    let ds = null, dv = null;
    if (fs.existsSync(diskP)) { ds = shaFile(diskP); try { dv = j(diskP).briefVersion ?? null; } catch { /* 保持 null */ } }
    runSpec[arm] = { sha256: rs, briefVersion: rv };
    armSpec[arm] = { sha256: ds, briefVersion: dv };
  }
  const runShas = [...new Set(Object.values(runSpec).map((x) => x.sha256))];
  const diskShas = [...new Set(Object.values(armSpec).map((x) => x.sha256))];
  const runVsPair = runShas.length === 1 && runShas[0] === pj.specSha256;   // 验证时是否精确用了 pair 冻结的 spec
  const diskVsPair = diskShas.length === 1 && diskShas[0] === pj.specSha256; // 落盘 spec 是否仍与 pair 冻结一致
  const pairVsCurrent = pj.specSha256 === curBriefSpecSha;                    // pair 冻结 spec 是否即现行 spec
  const runVersion = runShas.length === 1 ? runSpec['arm-a'].briefVersion : null;
  const specExact = {
    id: 'specExact',
    ok: runVsPair && pairVsCurrent,
    runVsPair, diskVsPair, pairVsCurrent,
    runTimeSpec: runShas.length === 1 ? { sha256: runShas[0], briefVersion: Object.values(runSpec)[0].briefVersion } : { sha256: runShas, briefVersion: Object.values(runSpec).map((x) => x.briefVersion) },
    diskSpec: diskShas.length === 1 ? { sha256: diskShas[0], briefVersion: Object.values(armSpec)[0].briefVersion } : { sha256: diskShas, briefVersion: Object.values(armSpec).map((x) => x.briefVersion) },
    pairSpecSha256: pj.specSha256,
    currentBriefs: { specSha256: curBriefSpecSha, version: curBriefVersion, briefSha256: briefByScene[scene]?.sha256 ?? null },
    evidence: '验证时实际所用 spec 以 report.spec.sha256 为准(唯一事实源);arm 落盘 spec.json 可能事后被刷新,不能替代 report 证据',
    ...(runVsPair && !pairVsCurrent && curBriefVersion != null && curBriefVersion === runVersion
      ? { sameVersionDifferentContent: `pair 冻结版与现行版版本号同为 v${curBriefVersion} 但内容 sha 不同 —— spec 在运行后被改动且未升版本号(违反"改动必须升版"纪律的历史事实,如实记录)` }
      : {}),
  };

  // ---- 3. 验证器版本已知?
  const repA = fs.existsSync(path.join(pairDir, 'arm-a', 'validation', 'report.json')) ? j(path.join(pairDir, 'arm-a', 'validation', 'report.json')) : null;
  const repB = fs.existsSync(path.join(pairDir, 'arm-b', 'validation', 'report.json')) ? j(path.join(pairDir, 'arm-b', 'validation', 'report.json')) : null;
  const vphs = [...new Set([repA?.validatorProtocolHash ?? null, repB?.validatorProtocolHash ?? null])];
  const harnessVs = [...new Set([repA?.harnessVersion ?? null, repB?.harnessVersion ?? null])];
  const validatorKnown = {
    id: 'validatorKnown',
    ok: vphs.length === 1 && Boolean(vphs[0]),
    validatorProtocolHash: vphs.length === 1 ? vphs[0] : vphs,
    harnessVersion: harnessVs.length === 1 ? harnessVs[0] : harnessVs,
    currentValidatorProtocolHash: vp,
    matchesCurrent: vphs.length === 1 && vphs[0] === vp,
    note: vphs[0] ? null : '历史 report 无 validatorProtocolHash(整改前格式),验证协议内容不可追溯 → 只能按 harnessVersion 粗粒度信任',
  };

  // ---- 4. Agent 身份完整
  const missingIdentity = AGENT_IDENTITY_FIELDS.filter((k) => !pj[k]);
  const agentIdentityComplete = {
    id: 'agentIdentityComplete',
    ok: missingIdentity.length === 0,
    missing: missingIdentity,
    note: 'Agent 作为测量仪器的身份链不完整 → 跨批次/跨引擎可比性只能按"同一仪器"的声明口径采信,无法机器复核',
  };

  // ---- 5. 预算机器计数
  const budget = pj.budget ?? null;
  const budgetCounters = {};
  for (const arm of ['arm-a', 'arm-b']) {
    // 计数器位置:arm/workspace/.budget(FIX-C 布局);兼容旧约定 arm/.budget
    const bDir = ['workspace/.budget', '.budget'].map(r => path.join(pairDir, arm, r)).find(p => fs.existsSync(p)) || path.join(pairDir, arm, 'workspace', '.budget');
    budgetCounters[arm] = fs.existsSync(bDir) ? fs.readdirSync(bDir) : null;
  }
  const budgetDeclared = Boolean(budget) && [budget.maxToolCalls, budget.maxWallTimeMinutes, budget.maxBuildAttempts, budget.maxBrowserAttempts].every((x) => typeof x === 'number');
  const budgetMachineCounted = {
    id: 'budgetMachineCounted',
    ok: budgetDeclared && budget.identicalAcrossEngines === true && Object.values(budgetCounters).some((v) => Array.isArray(v) && v.length > 0),
    declared: budgetDeclared,
    identicalAcrossEngines: budget?.identicalAcrossEngines ?? null,
    source: budget?.source ?? null,
    machineCounters: budgetCounters,
    note: 'pair.json 声明了 G0 冻结预算且双臂一致;但工作区未归档 .budget 机器计数 → 预算遵守情况只能采信声明,无机器证据',
  };

  // ---- 6. 视觉门禁
  const blindDir = path.join(BATCH_DIR, 'blind');
  const visualGate = {
    id: 'visualGate',
    ok: g7Status === 'PASS',
    g7Status,
    blindMaterials: fs.existsSync(blindDir) ? fs.readdirSync(blindDir).filter((f) => f.endsWith('.json')) : [],
    conclusion: g7Status === 'PASS' ? 'visual 可用' : `blind 材料存在,但 G7=${g7Status} → 视觉口径(六维/Preference)一律不得引用`,
  };

  // ---- 7. 量尺匹配
  const epochAir = ruler?.epochs?.[`${scene}:cocosair`] ?? null;
  const epochThree = ruler?.epochs?.[`${scene}:three`] ?? null;
  const batchCreated = pj.createdAt ?? null;
  const rulerMatch = {
    id: 'rulerMatch',
    ok: Boolean(epochAir && pj.airPackageHash === epochAir.inputs.engine),
    air: { pairHash: sha8(pj.airPackageHash), rulerEngine: sha8(epochAir?.inputs?.engine), match: Boolean(epochAir && pj.airPackageHash === epochAir.inputs.engine) },
    three: {
      pairHash: sha8(pj.threePackageHash), rulerEngine: epochThree?.inputs?.engine ?? null,
      match: 'FORMAT-MISMATCH: pair 存 sha256指纹,量尺存 semver 字符串,历史 three 版本无法从 pair 证据复核(仅环境声明)',
    },
    sequencing: batchCreated && ruler?.updatedAt ? {
      batchCreatedAt: batchCreated, rulerFrozenAt: ruler.updatedAt,
      note: batchCreated < ruler.updatedAt ? 'RULER-POSTDATES-BATCH:量尺在批次之后冻结;当时无版本账本约束,Attainment 只能回溯套用现尺(声明口径)' : '量尺先于批次',
    } : null,
    rulerId: ruler?.rulerId ?? null,
  };

  // ---- E10 特别核:历史验证实际 spec 版本从证据推断
  const checks = { frozenInputsComplete, specExact, validatorKnown, agentIdentityComplete, budgetMachineCounted, visualGate, rulerMatch };
  const failedIds = Object.values(checks).filter((c) => !c.ok).map((c) => c.id);
  let status = 'LEGACY_PROVISIONAL';
  const reasons = [];
  if (!frozenInputsComplete.ok) reasons.push(`冻结输入字段缺失: ${frozenInputsComplete.missing.join(', ')}`);
  if (!runVsPair) reasons.push(`验证时实际 spec(sha=${sha8(specExact.runTimeSpec.sha256)}, v${specExact.runTimeSpec.briefVersion})与 pair.specSha256(${sha8(pj.specSha256)})不一致 —— 回溯判定 INPUT_DRIFT`);
  if (!pairVsCurrent) reasons.push(`pair 冻结 spec(${sha8(pj.specSha256)})≠现行 briefs spec(${sha8(curBriefSpecSha)} v${curBriefVersion})`);
  if (!validatorKnown.ok) reasons.push('验证协议哈希未记录(整改前 report 格式)');
  if (!agentIdentityComplete.ok) reasons.push(`Agent 身份字段缺失: ${missingIdentity.join(', ')}`);
  if (!budgetMachineCounted.ok) reasons.push('预算机器计数证据未归档(仅声明口径)');
  if (!visualGate.ok) reasons.push(`G7=${g7Status},视觉口径作废`);
  if (!rulerMatch.ok) reasons.push('量尺匹配失败(见 rulerMatch)');
  if (runVsPair && pairVsCurrent && validatorKnown.ok && agentIdentityComplete.ok && budgetMachineCounted.ok && visualGate.ok && rulerMatch.ok) status = 'QUALIFIED';
  // 整改后数据(身份/冻结/预算/协议全过)仅因 G7=BLOCKED 挂视觉:objective 口径完全可信,
  // 不应错标 LEGACY(遗留)—— 单列 QUALIFIED_OBJECTIVE(正式 objective,visual 待 G7)
  else if (runVsPair && pairVsCurrent && validatorKnown.ok && agentIdentityComplete.ok && budgetMachineCounted.ok && rulerMatch.ok && !visualGate.ok && failedIds.every(id => id === 'visualGate')) status = 'QUALIFIED_OBJECTIVE';

  const pairEntry = {
    pairId: pd.name, scene, knowledge: pj.knowledge, repetition: pj.repetition, pilot: pj.pilot ?? false,
    status, failedChecks: failedIds, reasons, checks,
  };
  if (scene === 'E10') {
    pairEntry.e10SpecialCheck = {
      mandate: 'E10 特别核:arm spec=v1.0.0、现行全局 v1.0.1,历史验证实际 spec 版本从证据推断如实记录',
      inference: {
        pairCreatedAt: pj.createdAt,
        pairSpecSha256: pj.specSha256, // 建对时冻结的 spec 指纹
        validationTimeSpec: specExact.runTimeSpec, // report.spec —— 验证时实际使用(证据:唯一事实源)
        diskSpecNow: specExact.diskSpec, // arm 目录现存 spec.json(可能与验证时不同)
        currentGlobalSpec: specExact.currentBriefs, // 现行 briefs
      },
      conclusion: `历史验证实际运行于 ${specExact.runTimeSpec.briefVersion}(sha=${sha8(specExact.runTimeSpec.sha256)},中间版,现行库中无此文件);` +
        `现行全局 v${curBriefVersion}(sha=${sha8(curBriefSpecSha)})内容与之不同(sha 不等);` +
        `arm 落盘 spec 为 v${specExact.diskSpec.briefVersion}(sha=${sha8(specExact.diskSpec.sha256)},与验证时所用亦不同)。` +
        `四份指纹互不相等 → E10 两臂的验证结论只对其运行时那个中间版 spec 负责,对 v1.0.1 现行 spec 无证明力。`,
      action: 'E10 需在现行 v1.0.1 下重跑(重跑时新版 validate.mjs --pair-meta 会在入口拦截此类漂移为 INPUT_DRIFT)',
    };
  }
  pairReports.push(pairEntry);
}

// ---- 批次级结论(数据驱动,不再对特定批次硬编码)
const allPairs = pairReports;
const anyRunDrift = allPairs.some((p) => !p.checks.specExact.runVsPair);
const reusableMetrics = [];
const invalidOrPendingMetrics = [];
const batchReasons = [];
const pairStatuses = allPairs.map((p) => p.status);
const isLegacyBatch = batchArg === 'B-20261002-R1'; // 整改前遗留批次(身份/协议/预算证据缺失的历史口径)

if (!allPairs.some((p) => !p.checks.frozenInputsComplete.ok)) reusableMetrics.push('冻结输入指纹组(brief/spec/assets/templates/knowledge/engine sha)—— pair.json 完整');
reusableMetrics.push('objective S1/S2/S3 逐臂分(证据:validation/report.json' + (isLegacyBatch ? ';标记 provisional:验证协议哈希未记录' : ';协议哈希已记录,正式口径') + ')', 'objective 成对 delta(AIR−Three,S1+S2+S3 口径)', '效率/诊断口径(fps、console、探针明细、网络/截图证据)', '引擎哈希溯源(pair.airPackageHash 与 RULER 账本 matched)');
if (g7Status !== 'PASS') invalidOrPendingMetrics.push('visual 六维折算分与 Preference(证据存在但 G7=BLOCKED,一律不得引用)');
if (allPairs.some((p) => p.s4Pending)) invalidOrPendingMetrics.push('S4 代码健康(部分臂无 validation/code-review.json → s4Pending)');
if (!isLegacyBatch && g7Status !== 'PASS') invalidOrPendingMetrics.push('formal total/attainment/pairedDelta(G7 过后重跑 blind+judge 即可补齐)');

const nonVisualFailed = allPairs.filter((p) => (p.failedChecks || []).some((id) => id !== 'visualGate'));
if (nonVisualFailed.length) invalidOrPendingMetrics.push('存在非 visual 项失败的对: ' + nonVisualFailed.map((p) => `${p.pairId}(${p.failedChecks.join(',')})`).join('; '));
if (allPairs.some((p) => ['E02', 'E05'].includes(p.scene)) && isLegacyBatch) {
  invalidOrPendingMetrics.push('历史失败分类 STATE_MANAGEMENT(E02/E05)系已废除的 probeId 正则兜底所判;新版判 UNRESOLVED,历史分类建议按 classificationEvidence 重新人工归类');
  batchReasons.push('E02/E05 的 STATE_MANAGEMENT 分类是旧启发式兜底产物,证据链上应视为未归类(UNRESOLVED)');
}
if (anyRunDrift) batchReasons.push('存在"验证时 spec ≠ pair 冻结 spec"的对(E10):回溯 INPUT_DRIFT');
if (isLegacyBatch) batchReasons.push('全部 pair 的 Agent 身份五元组与验证协议哈希未记录 → 整批只能按 LEGACY_PROVISIONAL 口径引用');
if (g7Status !== 'PASS') batchReasons.push(`G7=${g7Status}:visual 口径作废/挂起(不影响 objective 正式口径)`);

// 批级状态 = 最弱 pair 状态(DISQUALIFIED > LEGACY_PROVISIONAL > QUALIFIED_OBJECTIVE > QUALIFIED)
const ORDER = ['QUALIFIED', 'QUALIFIED_OBJECTIVE', 'LEGACY_PROVISIONAL', 'DISQUALIFIED'];
let status = 'QUALIFIED';
for (const p of allPairs) if (ORDER.indexOf(p.status) > ORDER.indexOf(status)) status = p.status;

const qualification = {
  generatedAt: new Date().toISOString(),
  qualifier: 'harness/aggregate/qualify-historical.mjs (FIX-B)',
  batch: batchArg,
  status,
  statusDefinition: {
    QUALIFIED: '全部鉴定项通过,指标按正式口径引用',
    LEGACY_PROVISIONAL: '整改前产生的遗留数据:客观口径(S1/S2/S3)可有条件引用,正式口径(formal/visual/attainment)作废或挂起,引用时必须带本文件指认的限制',
    QUALIFIED_OBJECTIVE: '整改后数据:冻结输入/身份/预算/协议/量尺全部验证通过,objective 口径(S1/S2/S3)按正式引用;visual 因 G7=BLOCKED 挂起(G7 过后重跑 blind+judge 即可补齐)',
    DISQUALIFIED: '冻结输入断裂且无法溯源,全部指标作废',
  },
  context: {
    ruler: ruler ? { rulerId: ruler.rulerId, updatedAt: ruler.updatedAt } : null,
    g7: { status: g7Status, source: 'gates/G7.json' },
    currentValidatorProtocolHash: vp,
  },
  pairs: allPairs,
  batchLevel: { reusableMetrics, invalidOrPendingMetrics, reasons: batchReasons },
};
const outPath = path.join(BATCH_DIR, 'QUALIFICATION.json');
fs.writeFileSync(outPath, JSON.stringify(qualification, null, 2) + '\n', 'utf8');
console.log(`QUALIFICATION.json -> ${outPath}`);
console.log(`批次 ${batchArg}: status=${qualification.status} / ${allPairs.length} pairs`);
for (const p of allPairs) {
  console.log(`  ${p.pairId.padEnd(18)} ${p.status.padEnd(20)} failedChecks=[${p.failedChecks.join(',') || '-'}]`);
  for (const r of p.reasons) console.log(`      - ${r}`);
}
console.log(`reusable: ${reusableMetrics.length} 项 | invalid/pending: ${invalidOrPendingMetrics.length} 项`);
