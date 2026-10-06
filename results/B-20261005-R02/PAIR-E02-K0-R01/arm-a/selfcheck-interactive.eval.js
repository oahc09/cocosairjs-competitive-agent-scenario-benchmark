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
  const out = {};
  // P4 — 水平拖拽 (0.50,0.50)->(0.78,0.50)
  const x1 = W * 0.5, y1 = H * 0.5, x2 = W * 0.78;
  window.dispatchEvent(new PointerEvent('pointerdown', { clientX: x1, clientY: y1, bubbles: true, pointerId: 7, isPrimary: true }));
  for (let i = 1; i <= 24; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x1 + (x2 - x1) * i / 24, clientY: y1, bubbles: true, pointerId: 7, isPrimary: true }));
    await sleep(12);
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: x2, clientY: y1, bubbles: true, pointerId: 7, isPrimary: true }));
  await sleep(500);
  const b4 = S(); const d4a = grab(); await sleep(200); const a4 = S();
  out.p4 = { before: +b4.cameraAzimuth.toFixed(2), after: +a4.cameraAzimuth.toFixed(2), delta: +(a4.cameraAzimuth - b4.cameraAzimuth).toFixed(2) };
  // P5 — 点击色调控件
  const pre5 = avg(px(grab(), 0, 0, 1, 1));
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2500);
  const d5 = grab(); const post5 = avg(px(d5, 0, 0, 1, 1));
  out.p5 = { toneMix: +S().toneMix.toFixed(4), shift: [0, 1, 2].map((i) => +Math.abs(pre5[i] - post5[i]).toFixed(1)), preAvg: pre5.map((v) => +v.toFixed(1)), postAvg: post5.map((v) => +v.toFixed(1)) };
  // P6 — 第一次 reset
  const ep5 = S().epoch;
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  const s6 = S(); const d6 = grab();
  out.p6 = { epochBefore: ep5, epoch: s6.epoch, assetLoaded: s6.assetLoaded, assetRequests: s6.assetRequests, toneMix: +s6.toneMix.toFixed(4), cameraAzimuth: +s6.cameraAzimuth.toFixed(2), boatY: +s6.boatPosition.y.toFixed(4), litRatio: +lit(px(d6, 0, 0, 1, 1)).toFixed(4) };
  // P7 — 第二次 reset
  const memBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  const s7 = S(); const d7 = grab();
  out.p7 = { epoch: s7.epoch, assetLoaded: s7.assetLoaded, assetRequests: s7.assetRequests, toneMix: +s7.toneMix.toFixed(4), cameraAzimuth: +s7.cameraAzimuth.toFixed(2), litRatio: +lit(px(d7, 0, 0, 1, 1)).toFixed(4), memBefore, memAfter: performance.memory ? performance.memory.usedJSHeapSize : null };
  out.final = S();
  return out;
})()
