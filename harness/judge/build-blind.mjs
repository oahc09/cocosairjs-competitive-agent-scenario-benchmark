// Track D 盲评材料构建(通用版):按批次构建跨引擎对比材料 + 可选 Reference 单项
// 用法:node judge/build-blind.mjs --batch B-20261002-R1 [--refs]
// 语义(计划书 §18):同一 (scene, knowledge) 下,N 个 three 产物 × N 个 cocosair 产物
//   → N×N 个 unique 跨引擎对比(N=3 时 9 个);每对比侧别随机(种子=sha256(cmpId));
//   侧别映射只写入 blinding-key.json(judge 不可读)。
// 截图来源:各臂 validation/screenshots/{initial,mid,final}.png;--refs 时附 20 个 Reference
//   单项(REF-<scene>-<X|Y>-<hash4>,X=three/Y=cocosair)。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wantRefs = process.argv.includes('--refs');
const batchId = process.argv[process.argv.indexOf('--batch') + 1];
if (!batchId || !/^B-\d{8}-R\d+$/.test(batchId)) {
  console.error('用法: node judge/build-blind.mjs --batch B-YYYYMMDD-Rnn [--refs]');
  process.exit(2);
}
const BATCH_DIR = path.join(BENCH, 'results', batchId);
if (!existsSync(BATCH_DIR)) { console.error('批次不存在: ' + batchId); process.exit(2); }
const OUT = path.join(BATCH_DIR, 'blind');

const prng = (seedHex) => { let s = parseInt(seedHex.slice(0, 8), 16); return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; };
const sha = (x) => createHash('sha256').update(x).digest('hex');

// 收集批次内 (scene,knowledge) → 各引擎臂(有截图才算有效产物)
const groups = new Map();
for (const pd of readdirSync(BATCH_DIR, { withFileTypes: true })) {
  if (!pd.isDirectory() || !pd.name.startsWith('PAIR-')) continue;
  const pj = JSON.parse(readFileSync(path.join(BATCH_DIR, pd.name, 'pair.json'), 'utf8'));
  for (const armKey of ['A', 'B']) {
    const engine = pj.arms[armKey].engine;
    const shots = ['initial.png', 'mid.png', 'final.png']
      .map((s, i) => ({ i, f: path.join(BATCH_DIR, pd.name, 'arm-' + armKey.toLowerCase(), 'validation', 'screenshots', s) }))
      .filter((x) => existsSync(x.f));
    if (!shots.length) continue;
    const gk = `${pj.sceneId}|${pj.knowledge}`;
    if (!groups.has(gk)) groups.set(gk, { scene: pj.sceneId, knowledge: pj.knowledge, three: [], cocosair: [] });
    groups.get(gk)[engine].push({ engine, pair: pd.name, arm: armKey.toLowerCase(), shots });
  }
}

const key = { generatedAt: new Date().toISOString(), batchId, comparisons: [], referenceItems: [] };
for (const g of groups.values()) {
  for (const t of g.three) {
    for (const c of g.cocosair) {
      const cmpId = `CMP-${g.scene}-${g.knowledge}-${t.pair}-vs-${c.pair}`;
      const flip = prng(sha(cmpId))() < 0.5;
      const s1 = flip ? t : c, s2 = flip ? c : t;
      for (const [side, item] of [['side1', s1], ['side2', s2]]) {
        const dst = path.join(OUT, cmpId, side);
        mkdirSync(dst, { recursive: true });
        for (const s of item.shots) copyFileSync(s.f, path.join(dst, `shot-${s.i + 1}.png`));
      }
      key.comparisons.push({
        cmpId, scene: g.scene, knowledge: g.knowledge,
        side1: { engine: s1.engine, pair: s1.pair, arm: s1.arm },
        side2: { engine: s2.engine, pair: s2.pair, arm: s2.arm },
      });
    }
  }
}

if (wantRefs) {
  for (let i = 1; i <= 10; i++) {
    const scene = 'E' + String(i).padStart(2, '0');
    for (const engine of ['three', 'cocosair']) {
      const base = path.join(BENCH, 'reference', 'private', engine, scene, 'validation', 'screenshots');
      if (!existsSync(base)) continue;
      const itemId = `REF-${scene}-${engine === 'three' ? 'X' : 'Y'}-${sha(scene + engine).slice(0, 4)}`;
      const dst = path.join(OUT, itemId);
      mkdirSync(dst, { recursive: true });
      ['initial.png', 'final.png'].forEach((shot, idx) => {
        if (existsSync(path.join(base, shot))) copyFileSync(path.join(base, shot), path.join(dst, `shot-${idx + 1}.png`));
      });
      key.referenceItems.push({ itemId, scene, engine });
    }
  }
}

writeFileSync(path.join(OUT, 'blinding-key.json'), JSON.stringify(key, null, 2));
console.log(`batch=${batchId} groups=${groups.size} comparisons=${key.comparisons.length} refs=${key.referenceItems.length} → results/${batchId}/blind/`);
