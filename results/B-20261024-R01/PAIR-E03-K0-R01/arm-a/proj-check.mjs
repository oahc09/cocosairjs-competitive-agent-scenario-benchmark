// 临时自检(不属于交付物):用 three 投影计算初始视角下行星/小行星带屏幕位置,
// 用于在实现前确定相机参数与构图,避免浪费浏览器验证预算。
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
function evalCam(camPos, fov, targetZ = 0) {
  const camera = new THREE.PerspectiveCamera(fov, W / H, 0.5, 4000);
  camera.position.set(...camPos);
  camera.lookAt(0, 0, targetZ);
  camera.updateMatrixWorld(true);
  const out = [];
  for (let k = 0; k < BASE.length; k++) {
    const p = BASE[k];
    const a = (k * 45 * Math.PI) / 180;
    const v = new THREE.Vector3(p.orbitRadius * Math.cos(a), 0, p.orbitRadius * Math.sin(a));
    const dist = camera.position.distanceTo(v);
    const ndc = v.clone().project(camera);
    const sx = (ndc.x * 0.5 + 0.5) * W;
    const sy = (-ndc.y * 0.5 + 0.5) * H;
    const pxPerWorld = (H / 2) / (Math.tan((fov * Math.PI) / 360) * dist);
    out.push({ name: p.name, sx: Math.round(sx), sy: Math.round(sy), rpx: +(p.radius * pxPerWorld).toFixed(1) });
  }
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const R of [5.2, 33.4]) {
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const v = new THREE.Vector3(R * Math.cos(a), 0, R * Math.sin(a)).project(camera);
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  }
  return { out, bbox: { x0: Math.round(x0), x1: Math.round(x1), y0: Math.round(y0), y1: Math.round(y1) }, widthRatio: +((x1 - x0) / W).toFixed(2), heightRatio: +((y1 - y0) / H).toFixed(2) };
}

// 俯角 = atan(camY / camZ)
for (const [pos, fov, tz] of [
  [[0, 104, 60], 26, 0],
  [[0, 100, 50], 24, 0],
  [[0, 95, 45], 22, 0],
  [[0, 82, 50], 30, 0],
  [[0, 75, 50], 34, 0],
  [[0, 90, 45], 25, 0],
]) {
  const r = evalCam(pos, fov, tz);
  const deg = (Math.atan2(pos[1], pos[2]) * 180 / Math.PI).toFixed(0);
  console.log(`\ncam=${pos.join(',')} (-${deg}deg) fov=${fov} tz=${tz} width=${r.widthRatio} height=${r.heightRatio} bbox=${JSON.stringify(r.bbox)}`);
  console.log(r.out.map((p) => `${p.name}(${p.sx},${p.sy}) r=${p.rpx}`).join('  '));
}
