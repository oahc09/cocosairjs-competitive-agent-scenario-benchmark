(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__bench.getState();
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
    c.getContext('2d').drawImage(cv, 0, 0, 480, 270);
    return c.toDataURL('image/jpeg', 0.7);
  };
  const brightIn = (d, w, x0, x1, y0, y1, th) => {
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > th) n++;
    }
    return n;
  };
  const motionIn = (d1, d2, w, h, x0, x1, y0, y1) => {
    let diff = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (Math.abs(d1[i] - d2[i]) > 12 || Math.abs(d1[i + 1] - d2[i + 1]) > 12 || Math.abs(d1[i + 2] - d2[i + 2]) > 12) diff++;
      n++;
    }
    return +(diff / n).toFixed(5);
  };
  const w = cv.width, h = cv.height;
  const out = {};

  // P1:初始夜景(状态 + 像素)
  await sleep(1800);
  out.p1State = S();
  {
    const d = grab();
    let warm = 0, silLum = 0, silN = 0, skyLum = 0, skyN = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = ((y | 0) * w + (x | 0)) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (y > h * (2 / 3) && R > 90 && R > B * 1.3 && G >= B) warm++;
        if (y > h * 0.86 && y < h * 0.98) { silLum += lum; silN++; }
        if (y > h * 0.52 && y < h * 0.60) { skyLum += lum; skyN++; }
      }
    }
    out.p1Pixels = { warmBottomThird: warm, silhouetteLum: +(silLum / silN).toFixed(1), skyBandLum: +(skyLum / skyN).toFixed(1) };
    out.p1Thumb = thumb();
  }

  // P2:点击 (0.5,0.30) 发射(状态 + 中带亮像素 + 运动)
  fire(0.5, 0.30);
  await sleep(500);
  out.p2State = S();
  {
    const d = grab();
    out.p2MidBandBright = brightIn(d, w, w * 0.4, w * 0.6, 0, h, 140);
    const m1 = grab();
    await sleep(300);
    out.p2Motion = motionIn(m1, grab(), w, h, w * 0.4, w * 0.6, 0, h * 0.9) > 0.001;
  }

  // P3:爆炸(状态 + 爆点邻域亮像素)
  await sleep(1200);
  out.p3State = S();
  {
    const d = grab();
    const cx = w * 0.5, cy = h * 0.30, rad = h * 0.20;
    let bright = 0;
    for (let y = cy - rad; y <= cy + rad; y += 2) for (let x = cx - rad; x <= cx + rad; x += 2) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad) continue;
      const i = ((y | 0) * w + (x | 0)) * 4;
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 140) bright++;
    }
    out.p3BurstBright = bright;
    out.p3Thumb = thumb();
  }

  // P4:衰减与余烬(状态 + 两个时刻的 center-bottom 运动比例)
  await sleep(2600);
  {
    const d1 = grab();
    await sleep(400);
    out.p4State = S();
    out.p4MotionEarly = motionIn(d1, grab(), w, h, w * 0.25, w * 0.75, h * 0.5, h);
  }
  await sleep(2600);
  {
    const d1 = grab();
    await sleep(400);
    out.p4bState = S();
    out.p4MotionCalibrated = motionIn(d1, grab(), w, h, w * 0.25, w * 0.75, h * 0.5, h);
    out.p4bThumb = thumb();
  }

  // P5:自动表演 4s
  document.querySelector('[data-ui="auto-show"]').click();
  await sleep(4000);
  out.p5State = S();

  // P6:关闭(计数冻结)
  document.querySelector('[data-ui="auto-show"]').click();
  const f1 = S().fireworkCount;
  await sleep(2300);
  const s6 = S();
  out.p6 = { autoShow: s6.autoShow, frozen: f1 === s6.fireworkCount, count: s6.fireworkCount };

  // P7:暂停(状态 + 全画面像素冻结)
  document.querySelector('[data-ui="pause"]').click();
  await sleep(400);
  out.p7State = S();
  const pa = cv.toDataURL();
  await sleep(1000);
  out.p7FrozenPixels = pa === cv.toDataURL();

  // P8:reset(状态归零 + 城市仍在)
  document.querySelector('[data-ui="reset"]').click();
  await sleep(600);
  out.p8State = S();
  out.p8Thumb = thumb();
  return out;
})()
