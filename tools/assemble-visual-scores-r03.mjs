#!/usr/bin/env node
// 一次性:B-20261005-R03 双 Judge 均值 → visual-scores.json(§8 契约;E01 相持经 pass-3 决裁)
import fs from 'node:fs';
const B = 'results/B-20261005-R03/blind';
const jp1 = JSON.parse(fs.readFileSync(`${B}/judge-pass-1.json`, 'utf8'));
const jp2 = JSON.parse(fs.readFileSync(`${B}/judge-pass-2.json`, 'utf8'));
const jp3 = JSON.parse(fs.readFileSync(`${B}/judge-pass-3.json`, 'utf8'));
const key = JSON.parse(fs.readFileSync(`${B}/blinding-key.json`, 'utf8'));
const avg = (a, b) => Math.round(((a + b) / 2) * 100) / 100;
const pairs = {}, preferences = {}, disagreements = [];
for (const cmp of key.comparisons) {
  const id = cmp.side1.pair;
  const c1 = jp1.comparisons.find((c) => c.cmpId === cmp.cmpId);
  const c2 = jp2.comparisons.find((c) => c.cmpId === cmp.cmpId);
  const scores = {};
  for (const side of ['side1', 'side2']) {
    scores[cmp[side].engine] = avg(c1[side].total, c2[side].total);
  }
  pairs[id] = scores;
  const prefs = [c1.preference, c2.preference];
  const isE01 = cmp.cmpId.startsWith('CMP-E01');
  const c3 = isE01 ? jp3.comparisons.find((c) => c.cmpId === cmp.cmpId) : null;
  if (c3) prefs.push(c3.preference);
  if (new Set(prefs).size > 1) disagreements.push({ cmpId: cmp.cmpId, prefs, resolvedBy: c3 ? 'pass-3(2/3 多数)' : 'n/a' });
  const tally = {};
  for (const p of prefs) tally[p] = (tally[p] || 0) + 1;
  const win = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  preferences[id] = { preference: win[1] > prefs.length / 2 ? win[0] : 'unresolved', passes: prefs, pass3Applied: !!c3 };
}
const out = {
  batchId: 'B-20261005-R03',
  generatedAt: new Date().toISOString(),
  source: '双 Judge 六维总分平均,口径 /18(metric-spec §8);E01 两 pass 偏好相持 → pass-3 决裁(R01 先例)',
  passes: ['judge-pass-1.json', 'judge-pass-2.json', 'judge-pass-3.json(E01 决裁)'],
  pairs, preferences, disagreements,
  anonymizationFindings: [
    'REF-E10-X HUD 显示 three.js r0.186.1 / REF-E10-Y HUD 显示 Cocos AIR(双 Judge 独立发现)—— 违反 §8.4 匿名化;双 Judge 均声明评分未受影响',
    'REF-E02-Y 底部状态栏含资产文件名 boat.glb(pass2 发现)—— 同上',
  ],
  note: '§8.4 违规系 Reference 盲评材料自带 HUD 所致,须 Owner 决断是否重制无水印参考截图;preference 统计维持参考口径(人工抽检未做,沿 G7 round-3 披露)',
};
fs.writeFileSync(`${B}/visual-scores.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ pairs, preferences, disagreements }, null, 1));
