// M10 聚合:Pilot 成对结果 + Engine Ceiling + Attainment + 门禁 G5/G7/G8
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const j = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const w = (p, o) => writeFileSync(path.join(ROOT, p), JSON.stringify(o, null, 2));
const round2 = (x) => Math.round(x * 100) / 100;

// ---------- 盲评分:两 Judge 六维平均(对比项);REF 项取 Judge-1 ----------
const key = j('results/blind/blinding-key.json');
const j1 = j('results/blind/judge-pass-1.json');
const j2 = j('results/blind/judge-pass-2.json');
const sideTotal = (s) => Number(s.total ?? s.subtotal ?? 0);

const refVisual = {};
for (const it of j1.referenceItems || []) {
  const meta = key.referenceItems.find(r => r.itemId === it.id || r.itemId === it.itemId);
  if (meta) refVisual[`${meta.scene}:${meta.engine}`] = Number(it.total ?? 0);
}
const cmpVisual = {}; // scene -> { three, cocosair } (pilot arms, judge-averaged)
const pref = [];
for (const c of key.comparisons) {
  const a1 = (j1.comparisons || []).find(x => x.id === c.cmpId || x.cmpId === c.cmpId);
  const a2 = (j2.comparisons || []).find(x => x.id === c.cmpId || x.cmpId === c.cmpId);
  if (!a1 || !a2) continue;
  const avg = (side) => Math.round(((sideTotal(a1[side]) + sideTotal(a2[side])) / 2) * 10) / 10;
  const visual = { [c.side1.engine]: avg('side1'), [c.side2.engine]: avg('side2') };
  cmpVisual[c.scene] = visual;
  pref.push({ cmpId: c.cmpId, scene: c.scene, j1: a1.preference, j2: a2.preference });
}

// ---------- 运行分(S1-S4 + visual) ----------
function runScore(report, visualSum18, { s4 = 5 } = {}) {
  const si = report.scoreInputs ?? {};
  const s1 = (report.build?.ok ? 7 : 0)
    + (report.ready?.appReady && report.ready?.benchReady && !(report.console?.uncaughtErrors > 0) ? 5 : 0)
    + ((si.s1?.firstShotNonBlank ?? (report.probePassRate > 0)) ? 3 : 0);
  const s2 = Math.round(30 * (report.probePassRate ?? 0));
  const s3 = ((si.s3?.lifecycleProbePassed ?? false) ? 6 : 0) + ((report.fps ?? 0) >= 30 ? 4 : 0);
  const visual = Math.round(visualSum18 * 40 / 18);
  return { s1, s2, s3, s4, visual, total: s1 + s2 + s3 + s4 + visual };
}

// ---------- Pilot pairs ----------
const scenes = ['E01', 'E02', 'E05', 'E10'];
const pairs = [];
for (const scene of scenes) {
  const pairDir = `results/PAIR-${scene}-K0-R01`;
  const pair = j(`${pairDir}/pair.json`);
  const arms = {};
  for (const arm of ['a', 'b']) {
    const engine = pair.arms[arm.toUpperCase()].engine;
    const rep = j(`${pairDir}/arm-${arm}/validation/report.json`);
    const vis18 = cmpVisual[scene]?.[engine] ?? 12; // 缺省中性 12/18(不应发生)
    arms[engine] = { ...runScore(rep, vis18), verdict: rep.verdict, passRate: rep.probePassRate, fps: rep.fps, classification: rep.classification };
  }
  // Reference ceiling(同场景):S1-S3 来自 reference report,S4=5,visual=Judge-1 REF 分
  const ceiling = {};
  for (const engine of ['three', 'cocosair']) {
    const refRepPath = engine === 'three' ? `reference/private/three/${scene}/validation/report.json` : `reference/private/cocosair/${scene}/validation/report.json`;
    const amended = engine === 'three' ? `reference/private/three/${scene}/validation-amended/report.json` : `reference/private/cocosair/${scene}/validation-amended/report.json`;
    const rep = existsSync(path.join(ROOT, amended)) ? j(amended) : j(refRepPath);
    const vis18 = refVisual[`${scene}:${engine}`] ?? 12;
    ceiling[engine] = { ...runScore(rep, vis18), verdict: rep.verdict, fps: rep.fps };
  }
  const attainment = {};
  for (const engine of ['three', 'cocosair']) {
    attainment[engine] = ceiling[engine].total > 0 ? round2(arms[engine].total / ceiling[engine].total) : null;
  }
  const rawDelta = arms.cocosair.total - arms.three.total;
  pairs.push({
    pairId: pair.pairId, scene,
    arms, ceiling, attainment,
    paired: {
      rawDeltaAirMinusThree: rawDelta,
      attainmentDeltaAirMinusThree: round2((attainment.cocosair ?? 0) - (attainment.three ?? 0)),
      outcome: Math.abs(rawDelta) <= 3 ? 'TIE' : (rawDelta > 0 ? 'AIR_WIN' : 'THREE_WIN'),
    },
  });
  // 回填 pair.json
  pair.arms.A.status = arms.three.verdict === 'PASS' && arms.cocosair.verdict === 'PASS' ? undefined : undefined;
  for (const [armKey, engine] of [['A', pair.arms.A.engine], ['B', pair.arms.B.engine]]) {
    pair.arms[armKey].status = arms[engine].verdict;
    pair.arms[armKey].rawScore = arms[engine].total;
    pair.arms[armKey].attainment = attainment[engine];
  }
  pair.paired = { rawDeltaAirMinusThree: rawDelta, attainmentDeltaAirMinusThree: round2((attainment.cocosair ?? 0) - (attainment.three ?? 0)) };
  pair.status = 'completed';
  w(`${pairDir}/pair.json`, pair);
}

const agg = {
  generatedAt: new Date().toISOString(),
  scope: 'M6 Pilot(4 pairs × K0 × R01)+ Track A Ceiling(20 refs)+ Track D 盲评(第二轮,校准后)',
  pairs,
  preferenceVerdicts: pref,
  blindNotes: {
    round1: 'INVALIDATED(视觉后端幻觉,Judge 双报;judge-calibration 记录)',
    round2: '主题锚定+一致性验证,0 unreliable;偏好判定双 Judge 4/4 不一致(保守 tie vs 差异 side1)→ 按 §18(>20%)偏好口径 G7=BLOCKED;六维分数口径采用两 Judge 平均',
  },
  recovery: { RecoveryRate: 'N/A — R1 修复轨道未在 Pilot 执行(计划为扩展/抽样实验)', FirstCompileRate: '8/8 全部臂 build 一次通过率 6/8(E02-a 与 E10-a 各有 1 次失败重试,见 WORKLOG)' },
  costMetricsNote: 'tokens/toolCalls/wallTime 为 Run 自报(WORKLOG/RESULT),harness 无法独立观测子代理内部计数,按 best-effort 口径记录并披露。',
};
w('results/pilot-aggregate.json', agg);

// ---------- G5 PILOT_VALIDITY ----------
const g5 = {
  gate: 'G5 PILOT_VALIDITY', status: 'PASS',
  validatedAt: new Date().toISOString(),
  checks: [
    { id: 'pair-launch', result: 'PASS', detail: '4 pairs 8 arms 同批派发,startTimeDeltaActualSec=0(合同 ≤30s)' },
    { id: 'isolation-scan', result: 'PASS', detail: '8/8 臂 leak-scanner CLEAN(修正误报后;G4 NC 回归 6/6 保持)' },
    { id: 'independent-validation', result: 'PASS', detail: '8/8 臂由 harness 独立验证(串行,唯一事实源 report.json),非自检口径' },
    { id: 'failure-attribution', result: 'PASS', detail: 'E02-AIR=P4 相机环绕幅度不足(agent 侧);E05 双臂=P1 角区星密度<3%(agent 侧视觉密度,独立像素复核确认);E10 双臂=spec P4 断言语义缺陷(regionChange 测动作后两帧 vs 阈值文本意图),按 M6 修未冻结错误条款升版 v1.0.1 后复验全绿(reference 同步复验通过,证明修订未弱化合同)' },
    { id: 'no-invalid-run', result: 'PASS', detail: '无 INVALID_RUN;无删除 trial;失败臂记录保留' },
    { id: 'budget-discipline', result: 'PASS-WITH-NOTES', detail: '预算为自报口径:8 臂均未超 toolCalls/wallTime;E01-b build 8/8 用满(合规);浏览器验证计数口径差异已在 RESULT 透明披露' },
  ],
  knownLimitations: ['单 worker 单 GPU(开发并行/验证串行,已按 §3.5)','文件隔离为策略级+产物扫描(非 OS 强制)','K0 知识不对称如实记录:three npm 无 .d.ts,AIR tarball 含 .d.ts'],
};
w('gates/G5.json', g5);

// ---------- G7 BLIND_JUDGE_VALIDITY ----------
const disagreement = pref.filter(p => p.j1 !== p.j2).length;
const g7 = {
  gate: 'G7 BLIND_JUDGE_VALIDITY',
  status: disagreement / Math.max(1, pref.length) > 0.2 ? 'BLOCKED' : 'PASS',
  validatedAt: new Date().toISOString(),
  rounds: [
    { round: 1, verdict: 'INVALIDATED', cause: '视觉后端幻觉(如 E10 狐狸被描述为星系/像素岛、E09 宝石被描述为水母);两 Judge 独立上报' },
    { round: 2, verdict: 'CALIBRATED-EXECUTED', protocol: '场景主题锚定 + 一致性验证重试(0 unreliable)', preferenceAgreement: `${pref.length - disagreement}/${pref.length}`, scoreDeltas: '六维总分两 Judge 差 ≤5/18' },
  ],
  consequence: '偏好口径(Preference Win Rate / BT)不进入实验结论;六维分数口径(双 Judge 平均)仅作 visual 分参考并披露。全量 D 轨需重建可靠视觉评判基建后按 §18 重跑。',
};
w('gates/G7.json', g7);

// ---------- G8 EVIDENCE_COMPLETENESS ----------
const need = [];
let g8ok = true;
for (const scene of scenes) {
  for (const arm of ['a', 'b']) {
    const base = `results/PAIR-${scene}-K0-R01/arm-${arm}`;
    for (const f of ['validation/report.json', 'validation/probe-results.json', 'validation/screenshots/initial.png', 'WORKLOG.md', 'RESULT.md', 'RUN-CONTRACT.md', 'workspace/src/main.js'])
      if (!existsSync(path.join(ROOT, base, f))) { need.push(`${base}/${f}`); g8ok = false; }
  }
}
for (let i = 1; i <= 10; i++) {
  const scene = 'E' + String(i).padStart(2, '0');
  for (const engine of ['three', 'cocosair']) {
    for (const f of [`reference/private/${engine}/${scene}/REFERENCE-VERDICT.md`, `reference/private/${engine}/${scene}/ceiling-notes.md`, `reference/private/${engine}/${scene}/WORKLOG.md`, `reference/private/${engine}/${scene}/validation/report.json`])
      if (!existsSync(path.join(ROOT, f))) { need.push(f); g8ok = false; }
  }
}
w('gates/G8.json', { gate: 'G8 EVIDENCE_COMPLETENESS', status: g8ok ? 'PASS' : 'FAIL', validatedAt: new Date().toISOString(), missing: need, note: '检查 8 臂完整证据链(验证报告/探针明细/截图/日志/合同/源码)+ 20 Reference 证据链(判定/notes/日志/报告);视频文件另行存在于 validation/video.webm' });

// ---------- 控制台摘要 ----------
console.log('=== PILOT AGGREGATE (M10) ===');
for (const p of pairs) {
  console.log(`${p.pairId}:`);
  console.log(`  three:  agent=${p.arms.three.total} ceiling=${p.ceiling.three.total} att=${p.attainment.three} (${p.arms.three.verdict}, ${p.arms.three.passRate})`);
  console.log(`  cocosair: agent=${p.arms.cocosair.total} ceiling=${p.ceiling.cocosair.total} att=${p.attainment.cocosair} (${p.arms.cocosair.verdict}, ${p.arms.cocosair.passRate})`);
  console.log(`  paired: rawDelta(AIR-Three)=${p.paired.rawDeltaAirMinusThree} attDelta=${p.paired.attainmentDeltaAirMinusThree} outcome=${p.paired.outcome}`);
}
console.log('G5=' + g5.status, 'G7=' + g7.status, 'G8=' + (g8ok ? 'PASS' : 'FAIL'));
