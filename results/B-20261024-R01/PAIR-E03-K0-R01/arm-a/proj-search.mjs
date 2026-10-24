// 临时自检(不属于交付物):相机参数网格搜索——在满足构图约束(整体宽 65%-80%、
// 全部轨道不出画、行星距边缘留白、左上角 (102,58) 为空)的前提下挑选相机。
import * as THREE from 'three';

const BASE = [
  { name: 'mercury', radius: 0.62, orbitRadius: 5.2 },
  { name: 'venus', radius: 0.9, orbitRadius: 7.4 },
  { name: 'earth', radius: 0.95, orbitRadius: 9.8 },
  { name: 'mars', radius: 0.75, orbitRadius: 12.4 },
  { name: 'jupiter', radius: 2.2, orbitRadius: 18.6 },
  { name: 'saturn', radius: 1.9, orbitRadius: 23.6 },
  { name: 'uranus', radius: 1.2, orbitRadius: 28.6 },
  { name: 'neptune', radius: 1.15, orbitRadius: 33.4 },
];
const W = 1280, H = 720;

function evaluate(camY, camZ, fov, tz) {
  const camera = new THREE.PerspectiveCamera(fov, W / H, 0.5, 4000);
  camera.position.set(0, camY, camZ);
  camera.lookAt(0, 0, tz);
  camera.updateMatrixWorld(true);
  const planets = [];
  for (let k = 0; k < BASE.length; k++) {
    const p = BASE[k];
    const a = (k * 45 * Math.PI) / 180;
    const v = new THREE.Vector3(p.orbitRadius * Math.cos(a), 0, p.orbitRadius * Math.sin(a));
    const d = camera.position.distanceTo(v);
    const ndc = v.clone().project(camera);
    planets.push({
      name: p.name,
      sx: (ndc.x * 0.5 + 0.5) * W,
      sy: (-ndc.y * 0.5 + 0.5) * H,
      rpx: p.radius * (H / 2) / (Math.tan((fov * Math.PI) / 360) * d),
    });
  }
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const R of [5.2, 33.4]) {
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      const v = new THREE.Vector3(R * Math.cos(a), 0, R * Math.sin(a)).project(camera);
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  }
  const okFit = y0 >= -2 && y1 <= H + 2 && x0 >= 20 && x1 <= W - 20;
  const widthRatio = (x1 - x0) / W;
  const okWidth = widthRatio >= 0.65 && widthRatio <= 0.8;
  const margin = Math.min(...planets.map((p) => Math.min(p.sx - p.rpx - 20, W - p.sx - p.rpx - 20, p.sy - p.rpx - 20, H - p.sy - p.rpx - 20)));
  const corner = Math.min(...planets.map((p) => Math.hypot(p.sx - 102, p.sy - 58)));
  const minR = Math.min(...planets.map((p) => p.rpx));
  return { okFit, okWidth, widthRatio, x0, x1, y0, y1, margin, corner, minR, planets };
}

const results = [];
for (let camY = 34; camY <= 80; camY += 2) {
  for (let camZ = 26; camZ <= 60; camZ += 2) {
    const elev = (Math.atan2(camY, camZ) * 180) / Math.PI;
    if (elev < 31 || elev > 59) continue;
    for (let fov = 38; fov <= 62; fov += 2) {
      for (let tz = -2; tz <= 10; tz += 1) {
        const r = evaluate(camY, camZ, fov, tz);
        if (!r.okFit || !r.okWidth) continue;
        if (r.margin < 8) continue;
        if (r.corner < 90) continue;
        results.push({ camY, camZ, fov, tz, elev: +elev.toFixed(1), ...r });
      }
    }
  }
}
results.sort((a, b) => (b.widthRatio * 100 + b.minR) - (a.widthRatio * 100 + a.minR));
console.log('candidates:', results.length);
for (const r of results.slice(0, 8)) {
  console.log(`camY=${r.camY} camZ=${r.camZ} fov=${r.fov} tz=${r.tz} elev=${r.elev} width=${r.widthRatio.toFixed(3)} bbox=${r.x0.toFixed(0)},${r.y0.toFixed(0)},${r.x1.toFixed(0)},${r.y1.toFixed(0)} margin=${r.margin.toFixed(0)} corner=${r.corner.toFixed(0)} minR=${r.minR.toFixed(1)}`);
  console.log('   ' + r.planets.map((p) => `${p.name}(${p.sx.toFixed(0)},${p.sy.toFixed(0)}) r=${p.rpx.toFixed(1)}`).join(' '));
}
