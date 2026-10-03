// ============================================================================
// terrain.js — 低多边形起伏地形 + 营地圆盘
// ----------------------------------------------------------------------------
// terrainHeight(x,z) 是唯一高度事实源:地形网格位移、树/石头的落点都调它,
// 保证物件贴地不悬空。营地中心 r<4 压平(篝火/石圈所在),4→12 平滑过渡到
// 起伏;远处(r>12)叠加缓丘陵,形成地平线轮廓。平直着色(flatShading)
// 呈低多边形风。
// ============================================================================

import * as THREE from 'three';
import { mulberry32, randRange } from './rng.js';

/** 共享高度场(确定性,与随机种子无关的解析函数)。 */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const mask = THREE.MathUtils.smoothstep(r, 4.0, 12.0); // 营地压平区
  const micro =
    Math.sin(x * 0.34 + 1.7) * Math.cos(z * 0.31 - 0.6) * 0.5 +
    Math.sin(x * 0.13 - z * 0.17 + 0.8) * 0.55;
  const hills =
    (Math.sin(x * 0.062 + 0.4) * Math.cos(z * 0.055 - 1.1) + 0.75) * 2.8;
  return (micro * 0.6 + hills) * mask;
}

/** 建地面网格(顶点色微随机 + 高处干草色)与营地泥地圆盘。 */
export function createGround() {
  const group = new THREE.Group();

  // --- 起伏地形 ---
  const geo = new THREE.PlaneGeometry(170, 170, 46, 46);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grassA = new THREE.Color('#3c5c2f');
  const grassB = new THREE.Color('#48692f');
  const grassC = new THREE.Color('#2f4b28');
  const dry = new THREE.Color('#7a7440');
  const c = new THREE.Color();
  const rng = mulberry32(20260106);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    const pick = rng();
    c.copy(pick < 0.45 ? grassA : pick < 0.75 ? grassB : grassC);
    c.offsetHSL(0, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.05);
    // 高处向干草色过渡(远丘层次)
    c.lerp(dry, THREE.MathUtils.clamp((y - 1.6) / 3.2, 0, 1) * 0.4);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1.0,
      metalness: 0.0,
    })
  );
  group.add(ground);

  // --- 营地泥地圆盘(篝火所在空地,中心区高度恒 0,无 z-fight:抬 0.02) ---
  const dirt = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 22),
    new THREE.MeshStandardMaterial({
      color: '#5b4732',
      flatShading: true,
      roughness: 1.0,
    })
  );
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.y = 0.02;
  group.add(dirt);

  // --- 营地边缘散石(丰富地面细节,火光照得到的近景) ---
  const rngS = mulberry32(20260315);
  const stoneMat = new THREE.MeshStandardMaterial({
    color: '#71717c',
    flatShading: true,
    roughness: 0.95,
  });
  const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 7; i++) {
    const a = rngS() * Math.PI * 2;
    const r = randRange(rngS, 3.6, 7.5);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const s = randRange(rngS, 0.1, 0.26);
    const m = new THREE.Mesh(stoneGeo, stoneMat);
    m.scale.set(s, s * randRange(rngS, 0.55, 0.8), s);
    m.position.set(x, terrainHeight(x, z) + s * 0.3, z);
    m.rotation.set(rngS() * 3, rngS() * 3, rngS() * 3);
    group.add(m);
  }

  return group;
}
