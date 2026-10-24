#!/usr/bin/env node
// report/audit-evidence-g8.mjs — G8 EVIDENCE_COMPLETENESS 复跑器(只读审计,不改任何产物)
// ---------------------------------------------------------------------------
// 为什么存在:量尺每次重冻结都会重写 evidenceHash / visualEvidence.sha256,
// G8 的 PASS 不能靠历史断言,必须重新对账。本脚本把 gates/G8.json 里手写披露的 5 项
// Reference 检查变成可复跑判据,并追加"当前合格 core 测量"的臂级证据链(报告/spec 指纹/
// 身份/时序/机器计数/盲评材料)。审计结果写 results/reports/evidence-audit-g8.json。
// 用法:node harness/report/audit-evidence-g8.mjs
// 退出码:0=PASS,3=有缺口(逐条打印 MISSING)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

const ledger = rj(path.join(ROOT, 'reference', 'private', 'REFERENCE-VERSIONS.json'));

// ---- A. Reference 证据链(分母 = 量尺账本全部条目)----
const refChecks = [];
for (const [key, e] of Object.entries(ledger.epochs)) {
  const [scene, engine] = key.split(':');
  const dir = path.join(ROOT, 'reference', 'private', engine, scene);
  const repP = path.join(dir, 'validation', 'report.json');
  const items = {};
  items.reportExists = fs.existsSync(repP);
  items.evidenceHashMatches = items.reportExists && e.evidenceHash === shaFile(repP);
  items.codeReviewExists = fs.existsSync(path.join(dir, 'validation', 'code-review.json'));
  items.visualSelfContained = fs.existsSync(path.join(dir, 'visual-score.json')) && rj(path.join(dir, 'visual-score.json')).visualRaw18 != null;
  items.visualEvidenceShaMatches = !!e.visualEvidence?.sha256 && fs.existsSync(path.join(ROOT, e.visualEvidence.path))
    && shaFile(path.join(ROOT, e.visualEvidence.path)) === e.visualEvidence.sha256;
  items.scoresFrozen = e.objectiveScore != null && e.totalScore != null;
  const missing = Object.entries(items).filter(([, v]) => v !== true).map(([k]) => k);
  refChecks.push({ key, ok: missing.length === 0, missing, items });
}

// ---- B. 合格 core 测量的臂级证据链(资格外批次不入分母,如实披露)----
const QUAL_OK = new Set(['QUALIFIED', 'QUALIFIED_OBJECTIVE']);
const armChecks = [];
const skippedBatches = [];
for (const b of fs.readdirSync(path.join(ROOT, 'results'), { withFileTypes: true })) {
  if (!b.isDirectory() || !/^B-\d{8}-R\d+$/.test(b.name)) continue;
  const batchDir = path.join(ROOT, 'results', b.name);
  const qf = path.join(batchDir, 'QUALIFICATION.json');
  if (!fs.existsSync(qf)) { skippedBatches.push(b.name + '(未鉴定)'); continue; }
  const qual = rj(qf);
  const statusOf = Object.fromEntries((qual.pairs || []).map((p) => [p.pairId, p.status]));
  for (const pe of fs.readdirSync(batchDir, { withFileTypes: true })) {
    if (!pe.isDirectory() || !pe.name.startsWith('PAIR-')) continue;
    const pairDir = path.join(batchDir, pe.name);
    const pjP = path.join(pairDir, 'pair.json');
    if (!fs.existsSync(pjP)) continue;
    const pj = rj(pjP);
    if (pj.track !== 'core' || !QUAL_OK.has(statusOf[pe.name] ?? qual.status)) continue;
    for (const dir of ['arm-a', 'arm-b']) {
      const ad = path.join(pairDir, dir);
      const repP = path.join(ad, 'validation', 'report.json');
      const rep = fs.existsSync(repP) ? rj(repP) : null;
      const items = {};
      items.reportExists = !!rep;
      items.specShaEqualsPair = !!rep?.spec?.sha256 && rep.spec.sha256 === pj.specSha256;
      items.runMetaIdentity = (() => { try { const m = rj(path.join(ad, 'RUN-META.json')); return !!m.modelId && !!m.systemPromptSha256; } catch { return false; } })();
      items.timingStamped = (() => { try { const x = rj(path.join(ad, 'execution.json')); return !!x.agentStartedAt && !!x.agentFinishedAt && !!x.hostFingerprint; } catch { return false; } })();
      items.toolcallCountExists = fs.existsSync(path.join(ad, 'workspace', '.budget', 'toolcall.count'));
      items.blindItemPresent = (() => {
        const vs = path.join(batchDir, 'blind', 'visual-scores.json');
        return fs.existsSync(vs) && JSON.stringify(rj(vs)).includes(pe.name);
      })();
      const missing = Object.entries(items).filter(([, v]) => v !== true).map(([k]) => k);
      armChecks.push({ pair: `${b.name}/${pe.name}`, arm: dir, engine: pj.arms[dir === 'arm-a' ? 'A' : 'B'].engine, qualStatus: statusOf[pe.name], ok: missing.length === 0, missing });
    }
  }
}

const refFail = refChecks.filter((c) => !c.ok);
const armFail = armChecks.filter((c) => !c.ok);
const out = {
  gate: 'G8 EVIDENCE_COMPLETENESS',
  auditedAt: new Date().toISOString(),
  generator: 'harness/report/audit-evidence-g8.mjs',
  basis: `量尺 ${ledger.rulerId}(账本 validationRevision 见各条目)+ track=core 且 qualification ∈ ${JSON.stringify([...QUAL_OK])} 的臂`,
  references: { checked: refChecks.length, missing: refFail.length, detail: refChecks },
  qualifiedArms: { checked: armChecks.length, missing: armFail.length, detail: armChecks },
  skippedBatches,
  missingCount: refFail.length + armFail.length,
  status: refFail.length + armFail.length === 0 ? 'PASS' : 'FAIL',
};
const outP = path.join(ROOT, 'results', 'reports', 'evidence-audit-g8.json');
fs.mkdirSync(path.dirname(outP), { recursive: true });
fs.writeFileSync(outP, JSON.stringify(out, null, 2) + '\n');
console.log(`[g8-audit] Reference ${refChecks.length - refFail.length}/${refChecks.length} 通过;合格 core 臂 ${armChecks.length - armFail.length}/${armChecks.length} 通过 → ${out.status}`);
for (const f of [...refFail, ...armFail]) console.log('  MISSING', JSON.stringify(f).slice(0, 240));
if (skippedBatches.length) console.log('  未入分母(未鉴定批次): ' + skippedBatches.join(', '));
console.log('  → ' + rel(outP));
process.exit(out.missingCount ? 3 : 0);
