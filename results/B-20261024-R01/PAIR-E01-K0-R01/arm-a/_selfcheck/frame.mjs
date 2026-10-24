// 临时几何分析(不参与构建):不同盘半径/仰角/注视点下 galaxy 圆盘的屏幕包围盒
const W = 1280, H = 720, FOV_V = 55, D = 120, AZ = 0.55;
const tanV = Math.tan((FOV_V * Math.PI) / 180 / 2);
const tanH = tanV * (W / H);
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function bbox(R, elDeg, targetY) {
  const el = (elDeg * Math.PI) / 180;
  const dir = [Math.sin(AZ) * Math.cos(el), Math.sin(el), Math.cos(AZ) * Math.cos(el)];
  const P = dir.map((v) => v * D);
  const T = [0, targetY, 0];
  const forward = norm([T[0] - P[0], T[1] - P[1], T[2] - P[2]]);
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  const pts = [];
  for (let i = 0; i < 720; i++) pts.push([R * Math.cos((i / 720) * Math.PI * 2), 0, R * Math.sin((i / 720) * Math.PI * 2)]);
  pts.push([0, 0, 0]);
  for (const Q of pts) {
    const d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
    const zc = dot(d, forward);
    const sx = 640 + (640 * dot(d, right)) / zc / tanH;
    const sy = 360 - (360 * dot(d, up)) / zc / tanV;
    minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
  }
  return { w: ((maxX - minX) / W).toFixed(3), x: [minX.toFixed(0), maxX.toFixed(0)], y: [minY.toFixed(0), maxY.toFixed(0)], cy: (((minY + maxY) / 2) | 0) };
}

const rows = [];
for (const R of [58, 62, 66, 70, 74]) {
  for (const el of [34, 40, 46, 52]) {
    rows.push({ R, el, ...bbox(R, el, 0) });
  }
}
console.table(rows);
for (const [R, el, ty] of [[70, 46, -6], [70, 46, -12], [70, 52, -6], [70, 52, -10], [66, 52, -4]]) {
  console.log(`R=${R} el=${el} targetY=${ty}`, bbox(R, el, ty));
}
