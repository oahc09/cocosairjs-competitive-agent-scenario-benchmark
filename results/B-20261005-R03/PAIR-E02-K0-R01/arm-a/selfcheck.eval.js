(async () => {
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cvs = document.getElementById('app-canvas');
  const gl = cvs.getContext('webgl2') || cvs.getContext('webgl');
  const W = cvs.width, H = cvs.height;
  const buf = new Uint8Array(W * H * 4);
  const grab = () => { gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf); return buf.slice(); }; // slice: 各帧独立快照
  function stats(a) {
    let lit = 0, r = 0, g = 0, b = 0;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const R = a[i * 4], G = a[i * 4 + 1], B = a[i * 4 + 2];
      if (R + G + B > 24) lit++;
      r += R; g += G; b += B;
    }
    return { lit: +(lit / n).toFixed(4), mr: +(r / n).toFixed(2), mg: +(g / n).toFixed(2), mb: +(b / n).toFixed(2) };
  }
  // glY0/glY1 为 GL 坐标(原点在左下):图像下 60% = GL [0, 0.6H];图像中 40% = GL [0.3H, 0.7H]
  function motion(a, b, glY0f, glY1f) {
    const y0 = Math.floor(H * glY0f), y1 = Math.floor(H * glY1f);
    let moved = 0, tot = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        tot++;
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > 18) moved++;
      }
    }
    return +(moved / tot).toFixed(4);
  }
  const out = { W, H };
  // P1: 就绪态 + 全帧非空白
  await sleep(1500);
  out.p1 = S();
  const f1 = grab();
  out.p1stats = stats(f1);
  // P2: wavePhase 推进 + 画面下 60% 运动像素
  const w0 = S();
  await sleep(1500);
  const w1 = S();
  const f2 = grab();
  out.p2 = { phase0: w0.wavePhase, phase1: w1.wavePhase, motionLower60: motion(f1, f2, 0, 0.6) };
  // P3: 船体竖直起伏 + 画面中 40% 运动像素
  const b0 = S();
  await sleep(900);
  const b1 = S();
  const f3 = grab();
  out.p3 = { y0: b0.boatPosition.y, y1: b1.boatPosition.y, motionCenter40: motion(f2, f3, 0.3, 0.7) };
  // P4: 水平拖拽 (0.50,0.50)->(0.78,0.50) → 方位角变化 + 全帧像素变化
  const rect = cvs.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.5;
  const ex = rect.left + rect.width * 0.78;
  cvs.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: cx, clientY: cy, bubbles: true }));
  for (let i = 1; i <= 12; i++) {
    await sleep(16);
    cvs.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: cx + ((ex - cx) * i) / 12, clientY: cy, bubbles: true }));
  }
  cvs.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: ex, clientY: cy, bubbles: true }));
  await sleep(500);
  const d0 = S();
  await sleep(200);
  const d1 = S();
  const f4 = grab();
  out.p4 = { az0: d0.cameraAzimuth, az1: d1.cameraAzimuth, delta: +(Math.abs(d1.cameraAzimuth - d0.cameraAzimuth)).toFixed(2), pixDeltaFull: motion(f3, f4, 0, 1) };
  // P5: 色调切换 → toneMix 与全帧平均色偏
  const pre = stats(grab());
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2500);
  const t1 = S();
  const post = stats(grab());
  out.p5 = {
    toneMix: t1.toneMix,
    avgShift: +((Math.abs(post.mr - pre.mr) + Math.abs(post.mg - pre.mg) + Math.abs(post.mb - pre.mb)) / 3).toFixed(2),
    pre: pre, post: post,
  };
  // P6: 第一次 reset → epoch/资产/色调/方位角恢复
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  out.p6 = S();
  // P7: 连续第二次 reset → 稳定性
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  out.p7 = S();
  return out;
})()
