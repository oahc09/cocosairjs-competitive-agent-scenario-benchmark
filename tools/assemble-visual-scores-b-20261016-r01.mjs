#!/usr/bin/env node
// 一次性:B-20261016-R01(S5,K0×R03×E01-E05)双 Judge 均值 → blind/visual-scores.json
// 口径沿用 tools/assemble-visual-scores-r03.mjs:pairs[engine] = 两 pass 该侧六维总分均值(/18);
// preference 两次不一致 → 记录 disagreement 并要求第 3 次决定性 pass(本脚本缺 pass-3 时直接报错,不带病出数)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = 'B-20261016-R01';
const B = path.join(BENCH, 'results', BATCH, 'blind');
const read = (f) => JSON.parse(fs.readFileSync(path.join(B, f), 'utf8'));

const jp1 = read('judge-pass-1.json');
const jp2 = read('judge-pass-2.json');
const key = read('blinding-key.json');
const hasPass3 = fs.existsSync(path.join(B, 'judge-pass-3.json'));
const jp3 = hasPass3 ? read('judge-pass-3.json') : null;

const avg = (a, b) => Math.round(((a + b) / 2) * 100) / 100;
const pairs = {}, preferences = {}, disagreements = [];
for (const cmp of key.comparisons) {
  const id = cmp.side1.pair;
  const find = (jp) => jp.comparisons.find((c) => c.cmpId === cmp.cmpId);
  const c1 = find(jp1), c2 = find(jp2);
  if (!c1 || !c2) throw new Error(`${cmp.cmpId} 缺少某 pass 的判定 —— 不得半成品出数`);
  const scores = {};
  for (const side of ['side1', 'side2']) scores[cmp[side].engine] = avg(c1[side].total, c2[side].total);
  pairs[id] = scores;
  const prefs = [c1.preference, c2.preference];
  const c3 = prefs[0] !== prefs[1] ? find(jp3 || { comparisons: [] }) : null;
  if (prefs[0] !== prefs[1] && !c3) throw new Error(`${cmp.cmpId} 双 pass 偏好不一致,需 judge-pass-3.json 决裁`);
  if (c3) prefs.push(c3.preference);
  if (new Set(prefs).size > 1) disagreements.push({ cmpId: cmp.cmpId, prefs, resolvedBy: c3 ? 'pass-3(2/3 多数)' : 'n/a' });
  const tally = {};
  for (const p of prefs) tally[p] = (tally[p] || 0) + 1;
  const win = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  preferences[id] = { preference: win[1] > prefs.length / 2 ? win[0] : 'unresolved', passes: prefs, pass3Applied: !!c3 };
}

const anon = JSON.parse(fs.readFileSync(path.join(BENCH, 'results', 'reports', 'blind-anonymization-findings.json'), 'utf8'));
const out = {
  batchId: BATCH,
  generatedAt: new Date().toISOString(),
  source: '双 Judge 六维总分平均,口径 /18(metric-spec §8)',
  passes: ['judge-pass-1.json', 'judge-pass-2.json', ...(hasPass3 ? ['judge-pass-3.json(决裁)'] : [])],
  pairs, preferences, disagreements,
  anonymizationFindings: anon.items || anon.findings || anon,
  note: '§8.4 违规(REF-E10 双侧 HUD 印引擎名、REF-E02-Y 印 boat.glb)照旧披露:Judge 已如实记录字样但未改评分;' +
    'Reference 去商标列入下次重验周期。人工抽检未做(沿既有 G7 披露口径)。',
};
fs.writeFileSync(path.join(B, 'visual-scores.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ pairs, preferences, disagreements }, null, 1));
