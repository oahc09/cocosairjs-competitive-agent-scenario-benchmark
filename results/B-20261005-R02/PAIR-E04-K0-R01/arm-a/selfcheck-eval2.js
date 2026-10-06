(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.getElementById('app-canvas');
  const r = cv.getBoundingClientRect();
  const fire = (nx, ny) => cv.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + nx * r.width, clientY: r.top + ny * r.height, bubbles: true, pointerId: 1,
  }));
  const grab = () => {
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0);
    return g.getImageData(0, 0, c.width, c.height).data;
  };
  const thumb = () => {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0, 480, 270);
    return c.toDataURL('image/jpeg', 0.7);
  };
  const out = {};
  // ---- P1:bottom-third 暖色像素计数;剪影带 vs 天空地平线带平均亮度 ----
  await sleep(1800);
  {
    const d = grab(), w = cv.width, h = cv.height;
    let warm = 0, silLum = 0, silN = 0, skyLum = 0, skyN = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (y > h * (2 / 3)) { if (R > 90 && R > B * 1.3 && G >= B) warm++; }
        if (y > h * 0.86 && y < h * 0.98) { silLum += lum; silN++; }
        if (y > h * 0.52 && y < h * 0.60) { skyLum += lum; skyN++; }
      }
    }
    out.p1 = { warmBottomThird: warm, silhouetteLum: +(silLum / silN).toFixed(1), skyBandLum: +(skyLum / skyN).toFixed(1) };
  }
  // ---- P2:点击后 500ms,中带亮像素 ----
  fire(0.5, 0.30);
  await sleep(500);
  {
    const d = grab(), w = cv.width, h = cv.height;
    let bright = 0;
    for (let y = 0; y < h; y += 2) for (let x = w * 0.4; x < w * 0.6; x += 2) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 140) bright++;
    }
    out.p2 = { midBandBright: bright };
  }
  // ---- P3:爆点邻域亮像素(要求 ~3x P2) ----
  await sleep(1200);
  {
    const d = grab(), w = cv.width, h = cv.height;
    const cx = w * 0.5, cy = h * 0.30, rad = h * 0.20;
    let bright = 0;
    for (let y = cy - rad; y <= cy + rad; y += 2) for (let x = cx - rad; x <= cx + rad; x += 2) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad) continue;
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 140) bright++;
    }
    out.p3 = { burstNeighborhoodBright: bright, ratioVsP2: +(bright / Math.max(1, out.p2.midBandBright)).toFixed(2) };
    out.p3Thumb = thumb();
  }
  // ---- P4:center-bottom 运动比例(两帧差分,阈值 0.005) ----
  await sleep(2600);
  {
    const d1 = grab(), w = cv.width, h = cv.height;
    await sleep(400);
    const d2 = grab();
    let diff = 0, n = 0;
    for (let y = h * 0.5; y < h; y += 2) for (let x = w * 0.25; x < w * 0.75; x += 2) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (Math.abs(d1[i] - d2[i]) > 12 || Math.abs(d1[i + 1] - d2[i + 1]) > 12 || Math.abs(d1[i + 2] - d2[i + 2]) > 12) diff++;
      n++;
    }
    out.p4 = { motionRatio: +(diff / n).toFixed(5), pass005: diff / n >= 0.005, state: window.__bench.getState() };
    out.p4Thumb = thumb();
  }
  // ---- P4b:模拟真实 harness 采样时刻(点击后 ~7.3s)再测一次运动 ----
  await sleep(2600);
  {
    const d1 = grab(), w = cv.width, h = cv.height;
    await sleep(400);
    const d2 = grab();
    let diff = 0, n = 0;
    for (let y = h * 0.5; y < h; y += 2) for (let x = w * 0.25; x < w * 0.75; x += 2) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (Math.abs(d1[i] - d2[i]) > 12 || Math.abs(d1[i + 1] - d2[i + 1]) > 12 || Math.abs(d1[i + 2] - d2[i + 2]) > 12) diff++;
      n++;
    }
    out.p4b = { motionRatio: +(diff / n).toFixed(5), pass005: diff / n >= 0.005, state: window.__bench.getState() };
    out.p4bThumb = thumb();
  }
  return out;
})()
