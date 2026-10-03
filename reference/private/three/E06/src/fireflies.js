// ============================================================================
// fireflies.js — 萤火虫(18 只,spec >=16,数量恒定)
// ----------------------------------------------------------------------------
// 每只萤火虫一条利萨茹游走轨迹(3 个不同频率正弦分量,绕营地 3.5-11 半径、
// 0.7-3.4 高度),亮度按 pow(sin, 5) 深脉冲明灭;夜间全亮,白天淡出
// (alpha × (1-smoothstep(day)),计数不变)。CPU 逐帧写 position/alpha。
// ============================================================================

import * as THREE from 'three';
import { mulberry32, randRange } from './rng.js';
import { makeGlowPointsMaterial } from './glow-points.js';
import { terrainHeight } from './terrain.js';

export const FIREFLY_COUNT = 18;

export function createFireflies(scene, pointMats) {
  const rng = mulberry32(20260520);
  const flies = [];
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const a = rng() * Math.PI * 2;
    const r = randRange(rng, 3.5, 11.0);
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const baseY = Math.max(terrainHeight(cx, cz), 0) + randRange(rng, 0.7, 2.6);
    flies.push({
      cx,
      cz,
      baseY,
      ax: randRange(rng, 1.0, 2.6),
      az: randRange(rng, 1.0, 2.6),
      ay: randRange(rng, 0.3, 0.8),
      fx: randRange(rng, 0.1, 0.3),
      fz: randRange(rng, 0.09, 0.26),
      fy: randRange(rng, 0.16, 0.4),
      px: rng() * Math.PI * 2,
      pz: rng() * Math.PI * 2,
      py: rng() * Math.PI * 2,
      blinkF: randRange(rng, 0.45, 1.1), // 明灭频率 Hz
      blinkP: rng() * Math.PI * 2,
      size: randRange(rng, 0.13, 0.2),
    });
  }

  const pos = new Float32Array(FIREFLY_COUNT * 3);
  const size = new Float32Array(FIREFLY_COUNT);
  const alpha = new Float32Array(FIREFLY_COUNT);
  const mix = new Float32Array(FIREFLY_COUNT);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aMix', new THREE.BufferAttribute(mix, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = makeGlowPointsMaterial('#e8ff7a', '#9fe030', pointMats);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  function update(dt, ctx) {
    const t = ctx.simTime;
    const dayFade = 1 - THREE.MathUtils.smoothstep(ctx.dayFactor, 0.45, 0.8);
    for (let i = 0; i < FIREFLY_COUNT; i++) {
      const f = flies[i];
      pos[i * 3] = f.cx + Math.sin(t * f.fx * Math.PI * 2 + f.px) * f.ax;
      pos[i * 3 + 1] = f.baseY + Math.sin(t * f.fy * Math.PI * 2 + f.py) * f.ay;
      pos[i * 3 + 2] = f.cz + Math.sin(t * f.fz * Math.PI * 2 + f.pz) * f.az;
      // 明灭:深脉冲(多数时间暗,周期性亮起)
      const pulse = Math.pow(Math.max(0, Math.sin(t * f.blinkF * Math.PI * 2 + f.blinkP)), 5.0);
      alpha[i] = (0.1 + 0.9 * pulse) * dayFade;
      size[i] = f.size * (0.75 + 0.45 * pulse);
      mix[i] = pulse;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aMix.needsUpdate = true;
  }

  return { update };
}
