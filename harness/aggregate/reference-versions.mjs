// reference/REFERENCE-VERSIONS.json 账本 + 漂移检测(FIX-B 整改版)
// 原则:Reference 的天花板 = "当前引擎 + 当前文档正典用法 + 当前 Brief" 下的最优实现,
//      即每个场景的"满分线/量尺"。量尺版本号 RULER-<日期>-R<轮次>(小白语义:第几把尺子)。
// 输入指纹分两类,漂移后果不同(FIX-B):
//   * 语义输入 engine / briefSha / specSha / docsSha —— 定义"被测对象是什么":
//     任一变化 → 天花板语义变了 → 需【重实现】(API 优化后旧绕行写法会低估上限),
//     refVersion+1 并换新量尺(新 RULER 号);
//   * 测量协议 validatorProtocolHash / judgeProtocolHash / toolchain —— 定义"怎么量":
//     变化 → 量尺语义没变但刻度可能变 → 只需【重验】(validationRevision+1,refVersion 不变)。
// 冻结时写入完整指标(FIX-B):objectiveBreakdown{s1,s2,s3} / objectiveScore /
//   visualRaw18(冻结时一次性从 results/B-*/blind/judge-pass-1.json referenceItems
//   取首个存在者) / visualScore40 / totalScore / evidenceHash(validation/report.json sha)。
// 用法:
//   node harness/aggregate/reference-versions.mjs                 # 冻结/更新账本
//   node harness/aggregate/reference-versions.mjs --check         # 漂移检测(两类分列)
//   node harness/aggregate/reference-versions.mjs --selftest-drift# 内存模拟漂移(NC10 自检)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REG = path.join(ROOT, 'reference', 'private', 'REFERENCE-VERSIONS.json');
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const shaText = (s) => crypto.createHash('sha256').update(s).digest('hex');
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CHECK = process.argv.includes('--check');
const SELFTEST = process.argv.includes('--selftest-drift');

const SEMANTIC_INPUTS = ['engine', 'briefSha', 'specSha', 'docsSha'];               // 语义输入:漂移→重实现
const PROTOCOL_INPUTS = ['validatorProtocolHash', 'judgeProtocolHash', 'toolchain']; // 测量协议:漂移→重验
const ALL_INPUT_KEYS = [...SEMANTIC_INPUTS, ...PROTOCOL_INPUTS];

// ---- 验证协议指纹:与 harness/runner/validate.mjs 完全同式(probe-executor + validate 内容合并 sha)
function validatorProtocol() {
  const a = fs.readFileSync(path.join(ROOT, 'harness', 'runner', 'probe-executor.mjs'));
  const b = fs.readFileSync(path.join(ROOT, 'harness', 'runner', 'validate.mjs'));
  return { hash: shaText(Buffer.concat([a, b])), probeExecutorSha256: shaText(a), validateSha256: shaText(b) };
}

// ---- 盲评协议指纹:docs/metric-spec.md 的盲评统计段(§8,口径来自计划书 §18"视觉偏好统计")。
// 任务书称"§18 段":metric-spec 内承载该口径的冻结段落即 §8;这里按标题锚定提取,内容变即漂移。
function judgeProtocol() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'metric-spec.md'), 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*8\./.test(l));
  if (start < 0) return { hash: null, source: 'docs/metric-spec.md#8 (heading not found)' };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start, end).join('\n');
  return { hash: shaText(section), source: 'docs/metric-spec.md §8 盲评统计(Track D)(= 计划书 §18 口径)' };
}

// ---- 漂移分类(纯函数,--selftest-drift 复用):
// 只在旧值为非空字符串时比较 —— 新键首次冻结不升版;briefSha 在旧账本中因
// briefs/index.json 解析 bug 全为 null,真实值回填不算漂移(修复的是记录,不是语义)。
function driftClassification(oldInputs, newInputs) {
  const semantic = SEMANTIC_INPUTS.filter((k) => typeof oldInputs?.[k] === 'string' && oldInputs[k] !== '' && oldInputs[k] !== newInputs[k]);
  const protocol = PROTOCOL_INPUTS.filter((k) => typeof oldInputs?.[k] === 'string' && oldInputs[k] !== '' && oldInputs[k] !== newInputs[k]);
  return { semantic, protocol };
}
const driftStatus = (d) => (d.semantic.length ? 'STALE' : d.protocol.length ? 'NEEDS_REVALIDATION' : 'CURRENT');

// ---- 当前三输入指纹 ----
const engineSha = shaFile(path.join(ROOT, 'vendor', 'cocosair.js-1.0.0-k0.tgz')); // AIR 引擎指纹(three 版本由 registry 另记)
const threePkg = j(path.join(ROOT, 'node_modules', 'three', 'package.json')).version;
// FIX-B bug 修复:briefs/index.json 是 { entries: [{briefId, version, sha256}] },先建映射再取
const briefIdx = j(path.join(ROOT, 'briefs', 'index.json'));
const briefByScene = Object.fromEntries((briefIdx.entries || []).map((e) => [e.briefId, e]));
const chromeV = process.env.CHROME_V || 'unknown';
// 工具链指纹:CHROME_V 未设置时沿用旧账本记录的 Chrome 版本(前提:node+esbuild 前缀一致),
// 避免"换个没设 CHROME_V 的 shell 就误报协议漂移";显式设置或真实变化仍会被检出。
function toolchainFingerprint(prevLedgerRaw) {
  const head = `node${process.version}+esbuild${JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'esbuild', 'package.json'))).version}`;
  if (process.env.CHROME_V) return `${head}+chrome${process.env.CHROME_V}`;
  try {
    for (const v of Object.values(prevLedgerRaw.epochs || {})) {
      const m = /^([^+]+\+[^+]+)\+chrome(.+)$/.exec(v?.inputs?.toolchain || '');
      if (m && m[1] === head) return `${head}+chrome${m[2]}`;
    }
  } catch { /* 无旧账本 */ }
  return `${head}+chrome${chromeV}`;
}
const toolchain = toolchainFingerprint(fs.existsSync(REG) ? j(REG) : {});
const docsSha = {};                                                                // 文档/知识指纹(K1 manifest 为正典文档代理)
for (const e of ['three', 'cocosair']) {
  docsSha[e] = shaFile(path.join(ROOT, 'knowledge', 'K1', e, 'manifest.json'));
}
const vp = validatorProtocol();
const jp = judgeProtocol();

// ---- Reference 客观分(S1/S2/S3,与 aggregate-all runScore 同式;S4 走 code-review,Reference 未评审则不含)
function refObjective(report) {
  if (!report) return null;
  const si = report.scoreInputs ?? {};
  const s1 = (report.build?.ok ? 7 : 0)
    + (report.ready?.appReady && report.ready?.benchReady && !(report.console?.uncaughtErrors > 0) ? 5 : 0)
    + ((si.s1?.firstShotNonBlank ?? (report.probePassRate > 0)) ? 3 : 0);
  const s2 = Math.round(30 * (report.probePassRate ?? 0));
  const s3 = ((si.s3?.lifecycleProbePassed ?? false) ? 6 : 0) + ((report.fps ?? 0) >= 30 ? 4 : 0);
  return { s1, s2, s3, objectiveScore: s1 + s2 + s3 };
}

// ---- 冻结时一次性采集 Reference 视觉原始分(18 制):
// 扫描 results/B-*/blind/judge-pass-1.json 的 referenceItems,取首个 REF-<SCENE>-<X|Y>- 命中项。
function firstRefVisual18(scene, engine) {
  const letter = engine === 'three' ? 'X' : 'Y';
  const batches = fs.readdirSync(path.join(ROOT, 'results'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^B-\d{8}-R\d+$/.test(d.name))
    .map((d) => d.name).sort();
  for (const b of batches) {
    const jp1 = path.join(ROOT, 'results', b, 'blind', 'judge-pass-1.json');
    if (!fs.existsSync(jp1)) continue;
    let items = [];
    try { items = j(jp1).referenceItems || []; } catch { continue; }
    const it = items.find((x) => new RegExp(`^REF-${scene}-${letter}-`).test(String(x.id || '')));
    if (it && it.total != null) {
      return { visualRaw18: Number(it.total), evidence: { batchId: b, itemId: it.id } };
    }
  }
  return { visualRaw18: null, evidence: null };
}

// ---- 自测:内存模拟三类漂移(NC10 依赖;不写任何文件) ----
if (SELFTEST) {
  const base = Object.fromEntries(ALL_INPUT_KEYS.map((k, i) => [k, `v${i}`]));
  const cases = [
    { mutate: 'briefSha', expectSemantic: ['briefSha'], expectProtocol: [] },
    { mutate: 'specSha', expectSemantic: ['specSha'], expectProtocol: [] },
    { mutate: 'validatorProtocolHash', expectSemantic: [], expectProtocol: ['validatorProtocolHash'] },
  ];
  const results = cases.map((c) => {
    const mutated = { ...base, [c.mutate]: base[c.mutate] + '-drifted' };
    const d = driftClassification(base, mutated);
    const status = driftStatus(d);
    const ok = d.semantic.length === c.expectSemantic.length && d.semantic.every((k, i) => k === c.expectSemantic[i])
      && d.protocol.length === c.expectProtocol.length && d.protocol.every((k, i) => k === c.expectProtocol[i]);
    return { mutate: c.mutate, status, semantic: d.semantic, protocol: d.protocol, ok };
  });
  const pass = results.every((r) => r.ok) && results.every((r) => r.status !== 'CURRENT'); // 三者均须判为漂移(STALE 家族)
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} 改 ${r.mutate.padEnd(22)} -> ${r.status.padEnd(20)} 语义=${JSON.stringify(r.semantic)} 协议=${JSON.stringify(r.protocol)}`);
  }
  console.log(pass
    ? 'SELFTEST-DRIFT PASS(改 briefSha/specSha → STALE 需重实现;改 validatorProtocolHash → NEEDS_REVALIDATION 需重验;三者均非 CURRENT)'
    : 'SELFTEST-DRIFT FAIL');
  process.exit(pass ? 0 : 1);
}

// 旧账本(纪元/EP- 术语)兼容读取:字段与 ID 前缀就地迁移为 量尺/RULER-
const prevRaw = fs.existsSync(REG) ? j(REG) : { epochs: {} };
const migrateId = (id) => (id ? String(id).replace(/^EP-/, 'RULER-') : null);
const prev = {
  ...prevRaw,
  rulerId: prevRaw.rulerId || migrateId(prevRaw.epochId),
  rulerHistory: prevRaw.rulerHistory || (prevRaw.epochHistory || []).map((h) => ({ ...h, rulerId: migrateId(h.epochId || h.rulerId) })),
  epochs: Object.fromEntries(Object.entries(prevRaw.epochs || {}).map(([k, v]) => [k, { ...v, frozenUnderRuler: v.frozenUnderRuler || migrateId(v.frozenInEpoch) }])),
};
const epochs = {};
const report = [];
for (let i = 1; i <= 10; i++) {
  const scene = 'E' + String(i).padStart(2, '0');
  for (const engine of ['three', 'cocosair']) {
    const valDir = path.join(ROOT, 'reference', 'private', engine, scene, 'validation');
    const repP = path.join(valDir, 'report.json');
    const ok = fs.existsSync(repP);
    const rep = ok ? j(repP) : null;
    const inputs = {
      engine: engine === 'three' ? `three@${threePkg}` : engineSha,
      briefSha: briefByScene[scene] ? briefByScene[scene].sha256 : null,   // FIX-B:经 entries 映射取值(旧版直取 briefIdx[scene] 恒为 null)
      specSha: shaFile(path.join(ROOT, 'briefs', scene, 'spec.json')),    // FIX-B:场景 spec.json 内容指纹
      docsSha: docsSha[engine],
      toolchain,
      validatorProtocolHash: vp.hash,
      judgeProtocolHash: jp.hash,
    };
    const key = `${scene}:${engine}`;
    const old = prev.epochs[key];
    const drift = old ? driftClassification(old.inputs, inputs) : { semantic: [], protocol: [] };
    const status = ok ? driftStatus(drift) : 'NO_VALIDATION';
    const refVersion = old ? (drift.semantic.length ? old.refVersion + 1 : old.refVersion) : 1;
    const validationRevision = (old?.validationRevision || 1) + (drift.protocol.length ? 1 : 0);
    // ---- 冻结完整指标(FIX-B) ----
    const obj = refObjective(rep);
    const vis = ok ? firstRefVisual18(scene, engine) : { visualRaw18: null, evidence: null };
    const visualScore40 = vis.visualRaw18 != null ? Math.round(vis.visualRaw18 * 40 / 18) : null;
    const totalScore = obj && visualScore40 != null ? obj.objectiveScore + visualScore40 : null;
    epochs[key] = {
      refVersion,
      validationRevision,
      inputs,
      ...(obj ? {
        objectiveBreakdown: { s1: obj.s1, s2: obj.s2, s3: obj.s3 },
        objectiveScore: obj.objectiveScore,
      } : { objectiveBreakdown: null, objectiveScore: null }),
      visualRaw18: vis.visualRaw18,
      visualEvidence: vis.evidence,
      visualScore40,
      totalScore,                                       // = objectiveScore + visualScore40(无视觉证据时 null)
      ceiling: totalScore,                              // 兼容旧字段名;口径变更:S4 不再默认满分,见 notes
      evidenceHash: ok ? shaFile(repP) : null,          // validation/report.json 内容 sha
      validated: ok ? { passRate: rep.probePassRate, fps: rep.fps, verdict: rep.verdict } : null,
      frozenAt: new Date().toISOString(),
      frozenUnderRuler: null, // 由下方统一填充(该 Reference 冻结时用的量尺版本号)
      ...(drift.semantic.length || drift.protocol.length ? {
        changedFrom: old ? old.refVersion : null,
        changedSemantic: drift.semantic,                // 需重实现(新正典 API)
        changedProtocol: drift.protocol,                // 需重验(validationRevision+1)
        changedInputs: [...drift.semantic, ...drift.protocol], // 兼容旧字段
      } : {}),
    };
    report.push({ key, status, changedSemantic: drift.semantic, changedProtocol: drift.protocol, refVersion, validationRevision });
  }
}

// ---- 量尺版本号 RULER-YYYYMMDD-Rnn:语义输入变化才换新尺(测量协议变化不动尺子);无变化则沿用(幂等) ----
const today = new Date();
const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const changedKeys = report.filter((r) => r.status === 'STALE').map((r) => r.key);
let rulerId = prev.rulerId || null;
let rulerHistory = Array.isArray(prev.rulerHistory) ? prev.rulerHistory : [];
if (!rulerId) {
  rulerId = `RULER-${ymd}-R1`; // 首次冻结(兼容旧账本回填)
  rulerHistory.push({ rulerId, frozenAt: new Date().toISOString(), changed: ['initial-backfill'] });
} else if (changedKeys.length) {
  const seq = rulerId.startsWith(`RULER-${ymd}-R`) ? parseInt(rulerId.split('-R')[1], 10) + 1 : 1;
  rulerId = `RULER-${ymd}-R${String(seq).padStart(2, '0')}`;
  rulerHistory.push({ rulerId, frozenAt: new Date().toISOString(), changed: changedKeys });
}
for (const k of Object.keys(epochs)) {
  const wasChanged = changedKeys.includes(k);
  const prevFrozen = prev.epochs[k] && prev.epochs[k].frozenUnderRuler;
  epochs[k].frozenUnderRuler = wasChanged || !prevFrozen ? rulerId : prevFrozen;
}

if (CHECK) {
  const stale = report.filter((r) => r.status === 'STALE');
  const revalidate = report.filter((r) => r.status === 'NEEDS_REVALIDATION');
  const novalue = report.filter((r) => r.status === 'NO_VALIDATION');
  console.log(`引擎指纹: AIR=${engineSha.slice(0, 8)}… three@${threePkg} | specSha/briefSha: briefs/ 现值 | 验证协议 ${vp.hash.slice(0, 8)}… | 盲评协议 ${jp.hash ? jp.hash.slice(0, 8) + '…' : 'N/A'} (${jp.source})`);
  for (const r of report) {
    const tag = r.status === 'STALE' ? `  <- ${r.changedSemantic.join('+')} 变化【需重实现(非仅重跑)】`
      : r.status === 'NEEDS_REVALIDATION' ? `  <- ${r.changedProtocol.join('+')} 变化【需重验 validationRevision->${r.validationRevision}】`
      : r.status === 'NO_VALIDATION' ? '  <- 无验证证据' : '';
    console.log(`  ${r.status.padEnd(20)} ${r.key.padEnd(14)} v${r.refVersion}.val${r.validationRevision}${tag}`);
  }
  if (stale.length) console.log(`\n${stale.length} 个 Reference 语义输入漂移:须以新正典 API 重实现并重新冻结(换新 RULER)`);
  if (revalidate.length) console.log(`${revalidate.length} 个 Reference 测量协议漂移:量尺语义不变,重跑验证即可(validationRevision+1)`);
  if (!stale.length && !revalidate.length && !novalue.length) console.log('\n全部 CURRENT(量尺与全部输入一致)');
  process.exit(stale.length || revalidate.length || novalue.length ? 3 : 0);
}

fs.writeFileSync(REG, JSON.stringify({
  rulerId, updatedAt: new Date().toISOString(),
  principle: 'Reference 天花板 = 每个场景的满分线(量尺)。语义输入(引擎/文档/Brief/spec)变化 → 重实现并 refVersion+1,换新量尺 RULER-<日期>-R<轮次>;测量协议(validator/judge/toolchain)变化 → 仅重验,validationRevision+1,量尺不变。同一版量尺下的所有批次共用同一满分线',
  inputTaxonomy: {
    semantic: SEMANTIC_INPUTS.concat().map((k) => `${k}(漂移→重实现+换尺)`),
    protocol: PROTOCOL_INPUTS.concat().map((k) => `${k}(漂移→重验 validationRevision)`),
    note: '旧账本 briefSha=null 系 briefs/index.json 解析 bug 所致,首次以真实值回填不算漂移',
  },
  protocol: {
    validatorProtocolHash: vp.hash,
    validatorProtocolComponents: { probeExecutorSha256: vp.probeExecutorSha256, validateSha256: vp.validateSha256 },
    judgeProtocolHash: jp.hash,
    judgeProtocolSource: jp.source,
  },
  rulerHistory, epochs,
}, null, 2) + '\n');
console.log(`REFERENCE-VERSIONS.json 已冻结:量尺 ${rulerId}(历史 ${rulerHistory.length} 版);本轮语义漂移(需重实现): ${changedKeys.join(', ') || '无'};协议漂移(需重验): ${report.filter((r) => r.status === 'NEEDS_REVALIDATION').map((r) => r.key).join(', ') || '无'}`);
