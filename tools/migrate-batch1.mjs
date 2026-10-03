// 一次性迁移:扁平 results/PAIR-* 布局 → 批次布局 results/B-20261002-R1/PAIR-*
// 同时:blind/ 迁入批次;pair.json 补 batchId;生成规范化 visual-scores.json;登记 batches.json
// 幂等:目标已存在则跳过。保留原 gates/*.json 中的历史路径字符串(时点记录),legacy 说明写入 batches.json。
import fs from 'node:fs';
import path from 'node:path';

const RESULTS = 'E:/AIProMax/Y2026M10/cocosairjs-competitive-agent-scenario-benchmark/bench/results';
const BATCH = 'B-20261002-R1';
const PAIRS = ['PAIR-E01-K0-R01', 'PAIR-E02-K0-R01', 'PAIR-E05-K0-R01', 'PAIR-E10-K0-R01'];
const batchDir = path.join(RESULTS, BATCH);
fs.mkdirSync(batchDir, { recursive: true });

for (const p of PAIRS) {
  const src = path.join(RESULTS, p), dst = path.join(batchDir, p);
  if (fs.existsSync(dst)) { console.log('skip(已存在)', p); continue; }
  fs.renameSync(src, dst);
  const pj = path.join(dst, 'pair.json');
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  if (!j.batchId) {
    const out = { pairId: j.pairId, batchId: BATCH };
    Object.assign(out, j); delete out.pairId; // 保持 batchId 紧随 pairId
    fs.writeFileSync(pj, JSON.stringify(out, null, 2) + '\n');
  }
  console.log('moved', p, '→', BATCH);
}
// blind 迁入批次
const blindSrc = path.join(RESULTS, 'blind'), blindDst = path.join(batchDir, 'blind');
if (fs.existsSync(blindSrc) && !fs.existsSync(blindDst)) { fs.renameSync(blindSrc, blindDst); console.log('moved blind →', BATCH + '/blind'); }

// 规范化视觉分:双 Judge 平均(第二轮校准),按 pairId×engine
const key = JSON.parse(fs.readFileSync(path.join(blindDst, 'blinding-key.json'), 'utf8'));
const j1 = JSON.parse(fs.readFileSync(path.join(blindDst, 'judge-pass-1.json'), 'utf8'));
const j2 = JSON.parse(fs.readFileSync(path.join(blindDst, 'judge-pass-2.json'), 'utf8'));
const tot = (s) => Number(s?.total ?? s?.subtotal ?? 0);
const vis = {};
for (let i = 0; i < key.comparisons.length; i++) {
  const c = key.comparisons[i];
  const a1 = (j1.comparisons || [])[i], a2 = (j2.comparisons || [])[i];
  if (!a1 || !a2) continue;
  const scene = c.scene;
  const pair = PAIRS.find(p => p.includes(scene));
  if (!pair) continue;
  vis[pair] = {
    [c.side1.engine]: Math.round(((tot(a1.side1) + tot(a2.side1)) / 2) * 10) / 10,
    [c.side2.engine]: Math.round(((tot(a1.side2) + tot(a2.side2)) / 2) * 10) / 10,
  };
}
fs.writeFileSync(path.join(blindDst, 'visual-scores.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'judge-pass-1/2 第二轮(主题锚定校准)双 Judge 六维总分平均,口径 /18',
  pairs: vis,
}, null, 2) + '\n');
console.log('visual-scores.json:', JSON.stringify(vis));

// 批次索引
const idx = path.join(RESULTS, 'batches.json');
fs.writeFileSync(idx, JSON.stringify({
  updatedAt: new Date().toISOString(),
  legacyNote: 'G5/G7/G8 等历史门禁文件中的 results/PAIR-* 路径为迁移前时点记录;现行布局为 results/<batchId>/PAIR-*。',
  batches: [{ batchId: BATCH, createdAt: '2026-10-02T08:55:00Z', lastPairAt: '2026-10-02T15:30:00Z', pairCount: PAIRS.length, pairs: PAIRS, note: 'M6 Pilot(迁移自扁平布局)' }],
}, null, 2) + '\n');
console.log('batches.json written');
