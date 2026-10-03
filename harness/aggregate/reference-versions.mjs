// reference/REFERENCE-VERSIONS.json 账本 + 漂移检测
// 原则:Reference 的天花板 = "当前引擎 + 当前文档正典用法 + 当前 Brief" 下的最优实现,
//      即每个场景的"满分线/量尺"。量尺版本号 RULER-<日期>-R<轮次>(小白语义:第几把尺子)。
// 四输入(引擎/文档/Brief/工具链)任一变化 → 受影响 Reference 视为 STALE,
//      需重实现(非仅重验)并冻结为新 refVersion,同时换新量尺(新 RULER 号)。
// 用法:
//   node harness/aggregate/reference-versions.mjs            # 冻结/更新账本(输入变化时 refVersion+1)
//   node harness/aggregate/reference-versions.mjs --check    # 漂移检测:逐 scene×engine 报 CURRENT/STALE+原因
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REG = path.join(ROOT, 'reference', 'private', 'REFERENCE-VERSIONS.json');
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CHECK = process.argv.includes('--check');

// ---- 当前三输入指纹 ----
const engineSha = shaFile(path.join(ROOT, 'vendor', 'cocosair.js-1.0.0-k0.tgz')); // AIR 引擎指纹(three 版本由 registry 另记)
const threePkg = j(path.join(ROOT, 'node_modules', 'three', 'package.json')).version;
const briefIdx = j(path.join(ROOT, 'briefs', 'index.json'));                       // briefSha per scene
const chromeV = process.env.CHROME_V || 'unknown';
const toolchain = `node${process.version}+esbuild${JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'esbuild', 'package.json'))).version}+chrome${chromeV}`;
const docsSha = {};                                                                // 文档/知识指纹(K1 manifest 为正典文档代理)
for (const e of ['three', 'cocosair']) {
  docsSha[e] = shaFile(path.join(ROOT, 'knowledge', 'K1', e, 'manifest.json'));
}
let ceiling = null;
try { ceiling = j(path.join(ROOT, 'results', 'aggregated.json')).referenceCeiling || null; } catch { /* 可选 */ }

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
      briefSha: briefIdx[scene] ? briefIdx[scene].sha256 : null,
      docsSha: docsSha[engine],
      toolchain,
    };
    const key = `${scene}:${engine}`;
    const old = prev.epochs[key];
    const changed = old ? ['engine', 'briefSha', 'docsSha', 'toolchain'].filter(k => old.inputs[k] !== undefined && old.inputs[k] !== inputs[k]) : []; // toolchain 首次回填不升版
    const refVersion = old ? (changed.length ? old.refVersion + 1 : old.refVersion) : 1;
    epochs[key] = {
      refVersion,
      inputs,
      validated: ok ? { passRate: rep.probePassRate, fps: rep.fps, verdict: rep.verdict } : null,
      ceiling: ceiling && ceiling[`${scene}/${engine}`] ? ceiling[`${scene}/${engine}`].total : null,
      frozenAt: new Date().toISOString(),
      frozenUnderRuler: null, // 由下方统一填充(该 Reference 冻结时用的量尺版本号)
      ...(changed.length ? { changedFrom: old.refVersion, changedInputs: changed } : {}),
    };
    report.push({ key, status: !ok ? 'NO_VALIDATION' : changed.length ? 'STALE' : 'CURRENT', changedInputs: changed, refVersion });
  }
}

// ---- 量尺版本号 RULER-YYYYMMDD-Rnn:任一 scene 升版即换新尺;无变化则沿用(幂等) ----
const today = new Date();
const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const changedKeys = report.filter(r => r.status === 'STALE').map(r => r.key);
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
  const stale = report.filter(r => r.status !== 'CURRENT');
  console.log(`引擎指纹: AIR=${engineSha.slice(0, 8)}… three@${threePkg} | 文档指纹: three=${docsSha.three.slice(0, 8)}… air=${docsSha.cocosair.slice(0, 8)}…`);
  for (const r of report) console.log(`  ${r.status.padEnd(13)} ${r.key.padEnd(14)} v${r.refVersion}${r.changedInputs.length ? '  ← ' + r.changedInputs.join('+') + ' 变化' : ''}`);
  console.log(stale.length ? `\n${stale.length} 个 Reference 需重实现(以新正典 API)并重新冻结` : '\n全部 CURRENT(量尺与三输入一致)');
  process.exit(stale.length ? 3 : 0);
}

fs.writeFileSync(REG, JSON.stringify({
  rulerId, updatedAt: new Date().toISOString(),
  principle: 'Reference 天花板 = 每个场景的满分线(量尺)。四输入(引擎/文档/Brief/工具链)任一变化 → 重实现并 refVersion+1,同时换新量尺 RULER-<日期>-R<轮次>(与批次 B-* 同构,单日多轮安全);同一版量尺下的所有批次共用同一满分线',
  rulerHistory, epochs,
}, null, 2) + '\n');
console.log(`REFERENCE-VERSIONS.json 已冻结:量尺 ${rulerId}(历史 ${rulerHistory.length} 版);本轮升版项: ${changedKeys.join(', ') || '无'}`);
