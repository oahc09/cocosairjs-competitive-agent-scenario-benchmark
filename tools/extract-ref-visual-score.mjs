#!/usr/bin/env node
// tools/extract-ref-visual-score.mjs — Reference 视觉证据自包含化(R4/Phase 4)
// ---------------------------------------------------------------------------
// 为什么:REFERENCE-VERSIONS.json 冻结 visualRaw18 时曾从 results/B-*/blind/judge-pass-1.json
// 扫描取得(批次依赖)——方案A 清理历史批次后该来源已不可复现,量尺的证据链悬空。
// 本工具把每个 Reference 的视觉判定提取为自包含证据文件:
//   reference/private/<engine>/<scene>/visual-score.json
// 之后 reference-versions.mjs 冻结/校验直接读该文件(path+sha256 入账),不再依赖任何批次产物。
//
// 用法:
//   node tools/extract-ref-visual-score.mjs [--from <batchId>]   # 默认 --from 最近含 judge-pass 的批次
// 只写 reference/private/(Reference 实现者域);不触碰 results/。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'results');
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const argv = process.argv.slice(2);
const fromIdx = argv.includes('--from') ? argv.indexOf('--from') + 1 : null;
let batchId = fromIdx ? argv[fromIdx] : null;
if (!batchId) {
  const batches = fs.readdirSync(RESULTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^B-\d{8}-R\d+$/.test(d.name)).map((d) => d.name).sort();
  batchId = batches.findLast((b) => fs.existsSync(path.join(RESULTS, b, 'blind', 'judge-pass-1.json')));
}
if (!batchId) { console.error('[extract-ref-visual] 未找到含 blind/judge-pass-1.json 的批次'); process.exit(2); }

const jp1Path = path.join(RESULTS, batchId, 'blind', 'judge-pass-1.json');
const jp2Path = path.join(RESULTS, batchId, 'blind', 'judge-pass-2.json');
const jp1 = j(jp1Path);
const jp2 = fs.existsSync(jp2Path) ? j(jp2Path) : null;
let rulerId = null;
try { rulerId = j(path.join(ROOT, 'reference', 'private', 'REFERENCE-VERSIONS.json')).rulerId; } catch { /* 无账本 */ }

const letterFor = (engine) => (engine === 'three' ? 'X' : 'Y');
let written = 0, skipped = [];
for (let i = 1; i <= 10; i++) {
  const scene = 'E' + String(i).padStart(2, '0');
  for (const engine of ['three', 'cocosair']) {
    const idRe = new RegExp(`^REF-${scene}-${letterFor(engine)}-`);
    const it1 = (jp1.referenceItems || []).find((x) => idRe.test(String(x.id || '')));
    if (!it1 || it1.total == null) { skipped.push(`${scene}:${engine}(pass1 无判定项)`); continue; }
    const it2 = jp2 ? (jp2.referenceItems || []).find((x) => idRe.test(String(x.id || ''))) : null;
    const out = {
      scene,
      engine,
      rulerId,
      visualRaw18: Number(it1.total),                    // 量尺冻结值 = pass1(与账本历史口径一致)
      visualScore40: Math.round(Number(it1.total) * 40 / 18),
      dimsPrimary: it1.dims ?? null,                     // 六维(主 Judge,即账本口径来源)
      totalPrimary: Number(it1.total),
      judgeCorroboration: it2 && it2.total != null ? {  // 第二独立 Judge 佐证(不改变冻结值)
        dims: it2.dims ?? null,
        total: Number(it2.total),
        average18: Math.round(((Number(it1.total) + Number(it2.total)) / 2) * 100) / 100,
        itemId: it2.id,
      } : null,
      provenance: {
        itemId: it1.id,
        extractedFrom: `results/${batchId}/blind/judge-pass-1.json`,
        sha256Source: shaFile(jp1Path),
        ...(jp2 ? { corroboratedFrom: `results/${batchId}/blind/judge-pass-2.json`, sha256Corroboration: shaFile(jp2Path) } : {}),
        extractedAt: new Date().toISOString(),
        extractor: 'tools/extract-ref-visual-score.mjs',
      },
      protocol: { judgeProtocolHash: jp1.protocol?.hash ?? jp1.protocolHash ?? null },
      note: 'Reference 视觉证据自包含文件(R4/Phase 4):REFERENCE-VERSIONS.json 以本文件(path+sha256)冻结 visualRaw18,不再依赖 results/ 批次产物;删除批次不影响 ceiling-check。',
    };
    const outPath = path.join(ROOT, 'reference', 'private', engine, scene, 'visual-score.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    written++;
  }
}
console.log(`[extract-ref-visual] from=${batchId} ruler=${rulerId ?? '?'}: 写入 ${written} 个 visual-score.json` + (skipped.length ? `;跳过: ${skipped.join(', ')}` : ''));
if (written !== 20) { console.error('[extract-ref-visual] 警告:未达 20 个(References 视觉判定可能不全)'); process.exit(1); }
