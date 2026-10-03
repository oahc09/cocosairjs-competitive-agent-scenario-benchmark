// ============================================================================
// rng.js — 确定性伪随机(mulberry32)
// ----------------------------------------------------------------------------
// 场景全部程序化布局(树环/石圈/柴堆/粒子初值/萤火虫路径)都吃同一个种子,
// reset() 时用相同种子重放 → "恢复初始默认状态"具有确定语义,且多次构建
// 画面一致(便于 harness 证据对比)。
// ============================================================================

/** 返回 [0,1) 的确定性伪随机函数。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [lo, hi) 均匀采样。 */
export const randRange = (rng, lo, hi) => lo + (hi - lo) * rng();

/** [lo, hi] 整数均匀采样。 */
export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** 洗牌(Fisher-Yates,确定性)。 */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
