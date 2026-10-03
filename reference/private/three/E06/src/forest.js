// ============================================================================
// forest.js — 低多边形树环
// ----------------------------------------------------------------------------
// 18 棵树(spec >=12,建议 14-24)环形围绕营地:半径 9.0-14.2、角度均匀加抖动,
// 避开场心。每棵树 = 柱状树干(CylinderGeometry 6 面)+ 2-3 层锥形树冠
// (ConeGeometry 6/7 面,平直着色),绿色微随机(HSL 抖动)、整体缩放/朝向
// 随机。树落点 y 取 terrainHeight,贴地不悬空。受火光/月光真实照明,有明暗面。
// ============================================================================

import * as THREE from 'three';
import { mulberry32, randRange } from './rng.js';
import { terrainHeight } from './terrain.js';

export const TREE_COUNT = 18;

export function createForest() {
  const group = new THREE.Group();
  const rng = mulberry32(20260214);
  const trunkMatBase = new THREE.Color('#4a3526');
  const crownMatBase = new THREE.Color('#26511f');

  for (let i = 0; i < TREE_COUNT; i++) {
    // 环形分布:均匀角度 + 抖动;半径内外两档,内圈少量(避免遮挡篝火)
    const angle = (i / TREE_COUNT) * Math.PI * 2 + randRange(rng, -0.16, 0.16);
    const radius = i % 3 === 0 ? randRange(rng, 8.8, 10.4) : randRange(rng, 10.6, 14.2);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    const tree = new THREE.Group();
    tree.position.set(x, terrainHeight(x, z), z);
    tree.rotation.y = rng() * Math.PI * 2;
    const s = randRange(rng, 0.82, 1.38); // 整体缩放
    tree.scale.setScalar(s);

    // --- 树干 ---
    const trunkH = randRange(rng, 1.05, 1.6);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.24, trunkH, 6),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(trunkMatBase).offsetHSL(0, randRange(rng, -0.03, 0.03), randRange(rng, -0.03, 0.03)),
        flatShading: true,
        roughness: 1.0,
      })
    );
    trunk.position.y = trunkH / 2;
    tree.add(trunk);

    // --- 树冠:2-3 层锥体堆叠,自下而上收窄、颜色渐亮 ---
    const layers = rng() < 0.62 ? 3 : 2;
    const crownHue = randRange(rng, 0.29, 0.4);
    const crownSat = randRange(rng, 0.42, 0.58);
    const crownLight = randRange(rng, 0.2, 0.3);
    let baseY = trunkH * 0.82;
    let coneR = randRange(rng, 1.05, 1.5);
    for (let l = 0; l < layers; l++) {
      const coneH = randRange(rng, 1.15, 1.65) * (1 - l * 0.16);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(coneR, coneH, 7),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(
            crownHue + (rng() - 0.5) * 0.02,
            crownSat,
            crownLight + l * randRange(rng, 0.015, 0.035)
          ),
          flatShading: true,
          roughness: 1.0,
        })
      );
      cone.position.y = baseY + coneH * 0.42;
      tree.add(cone);
      baseY += coneH * 0.52;
      coneR *= randRange(rng, 0.68, 0.78);
    }

    group.add(tree);
  }

  return group;
}
