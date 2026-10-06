(async () => {
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = 320, H = 180;
  const mkCtx = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const grab = (ctx) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, W, H); res(true); };
    img.src = window.__capture();
  });
  const diffRatio = (a, b, region) => {
    const da = a.getImageData(0, 0, W, H).data, db = b.getImageData(0, 0, W, H).data;
    let n = 0, tot = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!region(x, y)) continue;
      tot++;
      const i = (y * W + x) * 4;
      if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) n++;
    }
    return tot ? +(n / tot).toFixed(4) : 0;
  };
  const avgRGB = (a) => {
    const d = a.getImageData(0, 0, W, H).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const px = d.length / 4;
    return [Math.round(r / px), Math.round(g / px), Math.round(b / px)];
  };
  const out = {};
  const lower60 = (x, y) => y >= H * 0.4;
  const center40 = (x, y) => x >= W * 0.3 && x <= W * 0.7 && y >= H * 0.3 && y <= H * 0.7;

  // P2 — 海面持续波动:wavePhase 推进 + 下 60% 区域运动像素
  const ca = mkCtx(), cb = mkCtx();
  const s0 = S(); await grab(ca); await sleep(1500); const s1 = S(); await grab(cb);
  out.p2 = { wavePhase: [s0.wavePhase, s1.wavePhase], motionLower60: diffRatio(ca, cb, lower60) };

  // P3 — 船体随波起伏:900ms 窗内 boatPosition.y 变化 + 中部 40% 运动像素
  const cc = mkCtx(), cd = mkCtx();
  const b0 = S(); await grab(cc); await sleep(900); const b1 = S(); await grab(cd);
  out.p3 = { boatY: [b0.boatPosition.y, b1.boatPosition.y], motionCenter40: diffRatio(cc, cd, center40) };

  // P4 — 水平拖拽环绕:合成 pointer 事件(0.50->0.78),+500ms 与 +700ms 双采样
  const cv = document.getElementById('app-canvas');
  const r = cv.getBoundingClientRect();
  const yMid = r.top + r.height * 0.5;
  const x0 = r.left + r.width * 0.5, x1 = r.left + r.width * 0.78;
  const pe = (type, x, xx, buttons) => cv.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    clientX: x, clientY: xx, buttons }));
  pe('pointerdown', x0, yMid, 1);
  for (let i = 1; i <= 8; i++) { pe('pointermove', x0 + (x1 - x0) * i / 8, yMid, 1); await sleep(16); }
  pe('pointerup', x1, yMid, 0);
  await sleep(500);
  const d0 = S();
  const ce = mkCtx(), cf = mkCtx();
  await grab(ce); await sleep(200); const d1 = S(); await grab(cf);
  out.p4 = { az: [d0.cameraAzimuth, d1.cameraAzimuth], pixelDeltaFull: diffRatio(ce, cf, () => true) };

  // P5 — 色调切换:点击 tone-toggle,2500ms 后 toneMix 与画面平均色偏
  const cg = mkCtx(), ch = mkCtx();
  await grab(cg); const avgB = avgRGB(cg);
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2500);
  const t1 = S(); await grab(ch); const avgA = avgRGB(ch);
  out.p5 = {
    toneMix: t1.toneMix, avgWarm: avgB, avgCool: avgA,
    shift: +((Math.abs(avgA[0] - avgB[0]) + Math.abs(avgA[1] - avgB[1]) + Math.abs(avgA[2] - avgB[2])) / 3).toFixed(2),
  };
  out.fps = S().fps;
  return out;
})()
