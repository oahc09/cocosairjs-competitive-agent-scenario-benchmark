(async () => {
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.getElementById('app-canvas');
  const W = cv.width, H = cv.height;
  const grab = () => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(cv, 0, 0);
    return g.getImageData(0, 0, W, H);
  };
  const px = (d, x0, y0, x1, y1) => {
    const out = []; const ox = Math.floor(W * x0), oy = Math.floor(H * y0);
    const w = Math.floor(W * (x1 - x0)), h = Math.floor(H * (y1 - y0));
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = ((oy + y) * W + (ox + x)) * 4; out.push(d.data[i], d.data[i + 1], d.data[i + 2]);
    }
    return out;
  };
  const avg = (a) => { let r = 0, g = 0, b = 0; const n = a.length / 3; for (let i = 0; i < a.length; i += 3) { r += a[i]; g += a[i + 1]; b += a[i + 2]; } return [r / n, g / n, b / n].map((v) => +v.toFixed(1)); };
  const out = {};
  document.querySelector('[data-ui="tone-toggle"]').click(); // 暖 → 冷
  await sleep(2500);
  out.cool = { toneMix: +S().toneMix.toFixed(4), avg: avg(px(grab(), 0, 0, 1, 1)) };
  document.querySelector('[data-ui="tone-toggle"]').click(); // 冷 → 暖(反向切换)
  await sleep(2500);
  out.warmAgain = { toneMix: +S().toneMix.toFixed(4), avg: avg(px(grab(), 0, 0, 1, 1)) };
  // 地平线位置测量:自上而下扫描每行平均亮度,最大跳变处即海平线
  const d = grab();
  const rowAvg = [];
  for (let y = 0; y < H; y += 4) { let s = 0; for (let x = 0; x < W; x += 8) { const i = (y * W + x) * 4; s += d.data[i] + d.data[i + 1] + d.data[i + 2]; } rowAvg.push(s); }
  let horizonY = 0, maxDrop = 0;
  for (let i = 1; i < rowAvg.length; i++) { const drop = rowAvg[i - 1] - rowAvg[i]; if (drop > maxDrop) { maxDrop = drop; horizonY = (i * 4) / H; } }
  out.horizonRatio = +horizonY.toFixed(3);
  out.state = S();
  return out;
})()
