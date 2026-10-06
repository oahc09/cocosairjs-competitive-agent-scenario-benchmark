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
  const avg = (a) => { let r = 0, g = 0, b = 0; const n = a.length / 3; for (let i = 0; i < a.length; i += 3) { r += a[i]; g += a[i + 1]; b += a[i + 2]; } return [r / n, g / n, b / n]; };
  const lit = (a) => { let n = 0; for (let i = 0; i < a.length; i += 3) if (a[i] + a[i + 1] + a[i + 2] > 30) n++; return n / (a.length / 3); };
  const motion = (a, b) => { let m = 0; for (let i = 0; i < a.length; i += 3) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); if (d > 18) m++; } return m / (a.length / 3); };
  const out = {};
  out.net = performance.getEntriesByType('resource').filter((e) => e.name.includes('boat.glb')).map((e) => ({ name: e.name, size: e.transferSize, dur: Math.round(e.duration) }));
  await sleep(1500);
  const d1 = grab();
  out.p1 = { state: S(), litRatio: +lit(px(d1, 0, 0, 1, 1)).toFixed(4), avg: avg(px(d1, 0, 0, 1, 1)).map((v) => +v.toFixed(1)) };
  const b2 = S(); const g1 = grab(); await sleep(700); const g1b = grab(); await sleep(800); const a2 = S();
  out.p2 = { waveBefore: +b2.wavePhase.toFixed(3), waveAfter: +a2.wavePhase.toFixed(3), motionLower60: +motion(px(g1, 0, 0.4, 1, 1), px(g1b, 0, 0.4, 1, 1)).toFixed(4) };
  await sleep(300);
  const b3 = S(); const c1 = grab(); await sleep(900); const a3 = S(); const c2 = grab();
  out.p3 = { yBefore: +b3.boatPosition.y.toFixed(4), yAfter: +a3.boatPosition.y.toFixed(4), dy: +(a3.boatPosition.y - b3.boatPosition.y).toFixed(4), motionCenter40: +motion(px(c1, 0.3, 0.3, 0.7, 0.7), px(c2, 0.3, 0.3, 0.7, 0.7)).toFixed(4) };
  out.state = S();
  return out;
})()
