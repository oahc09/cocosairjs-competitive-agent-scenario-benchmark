(async () => {
  // E05 probe self-check(P1–P6):状态断言 + 像素证据,单会话内完成
  const TAU = Math.PI * 2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fx = document.querySelector('#fx');
  const BW = fx.width, BH = fx.height;
  const cx = BW / 2, cy = BH / 2, minD = Math.min(BW, BH);
  const grab = () => {
    const t = document.createElement('canvas'); t.width = BW; t.height = BH;
    const g = t.getContext('2d'); g.drawImage(fx, 0, 0);
    return g.getImageData(0, 0, BW, BH).data;
  };
  const regionStats = (d, x0, y0, x1, y1) => {
    let n = 0, nonBlack = 0, lum = 0, rb = 0;
    for (let y = Math.max(0, y0); y < Math.min(BH, y1); y++) for (let x = Math.max(0, x0); x < Math.min(BW, x1); x++) {
      const i = (y * BW + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      n++; const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (Math.max(r, g, b) > 16) nonBlack++;
      lum += L; rb += (r - b);
    }
    const c = Math.max(1, n);
    return { px: n, nonBlackRatio: +(nonBlack / c).toFixed(4), avgLum: +(lum / c).toFixed(1), avgRB: +(rb / c).toFixed(1) };
  };
  // P3 扇区采样(amendment 几何:0.06–0.14 / 0.18–0.30 × minD,±6% 高度带)
  const bandStats = (d, r0f, r1f, side) => {
    const r0 = r0f * minD, r1 = r1f * minD, band = Math.floor(0.06 * minD);
    let n = 0, lum = 0, rb = 0;
    for (let dy = -band; dy <= band; dy++) {
      const y = Math.round(cy + dy); if (y < 0 || y >= BH) continue;
      for (let x = 0; x < BW; x++) {
        const dx = x - cx, rr = Math.hypot(dx, dy);
        if (rr < r0 || rr > r1) continue;
        if (side > 0 ? dx < 0 : dx > 0) continue;
        const i = (y * BW + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
        n++; lum += 0.299 * R + 0.587 * G + 0.114 * B; rb += (R - B);
      }
    }
    const c = Math.max(1, n);
    return { n, avgLum: +(lum / c).toFixed(1), avgRB: +(rb / c).toFixed(1) };
  };
  const diffCount = (a, b, x0, y0, x1, y1, thr) => {
    let c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * BW + x) * 4;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > thr) c++;
    }
    return c;
  };
  const coreR = (d) => { // +X 扫描:首个亮度>60 的半径(≈光子环外缘,视界像素半径)
    const y = Math.round(cy);
    for (let r = 4; r < minD * 0.45; r++) {
      const i = (y * BW + Math.round(cx + r)) * 4;
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 60) return r;
    }
    return -1;
  };
  const diskR = (d) => { // +X 扫描:最后一个 R-B>30 的半径(盘外缘像素半径)
    const y = Math.round(cy); let last = -1;
    for (let r = 4; r < minD * 0.55; r++) {
      const i = (y * BW + Math.round(cx + r)) * 4;
      if (d[i] - d[i + 2] > 30) last = r;
    }
    return last;
  };

  const B = window.__bench;
  const out = { bw: BW, bh: BH, minD };

  // 等待就绪
  let t0 = Date.now();
  while (!(window.__appReady === true) && Date.now() - t0 < 10000) await sleep(100);
  out.appReady = window.__appReady === true;
  out.benchOk = !!(B && typeof B.getState === 'function' && typeof B.reset === 'function');

  // ---- P1 初始画面 ----
  await sleep(2500);
  out.p1_state = B.getState();
  const d1 = grab();
  out.p1_centerThird = regionStats(d1, Math.round(BW / 3), Math.round(BH / 3), Math.round(2 * BW / 3), Math.round(2 * BH / 3));
  const cw = Math.round(BW * 0.16), ch = Math.round(BH * 0.2);
  out.p1_cornerMinRatio = Math.min(
    regionStats(d1, 0, 0, cw, ch).nonBlackRatio,
    regionStats(d1, BW - cw, 0, BW, ch).nonBlackRatio,
    regionStats(d1, 0, BH - ch, cw, BH).nonBlackRatio,
    regionStats(d1, BW - cw, BH - ch, BW, BH).nonBlackRatio
  );
  out.p1_core = regionStats(d1, Math.round(cx - 14), Math.round(cy - 14), Math.round(cx + 14), Math.round(cy + 14));
  out.p1_ring = regionStats(d1, Math.round(cx + 44), Math.round(cy - 8), Math.round(cx + 58), Math.round(cy + 8));

  // ---- P2 旋转运动证据 ----
  const sa = B.getState();
  await sleep(800);
  const d2 = grab(); const sb = B.getState();
  out.p2_rotDelta = +(sb.diskRotation - sa.diskRotation).toFixed(4);
  out.p2_frameDiffDisk = diffCount(d1, d2, Math.round(cx - 240), Math.round(cy - 130), Math.round(cx + 240), Math.round(cy + 130), 10);

  // ---- P3 径向颜色梯度(多普勒亮侧扇区有向 R-B 差)----
  out.p3_state = B.getState();
  const sideR = { inner: bandStats(d2, 0.06, 0.14, +1), outer: bandStats(d2, 0.18, 0.30, +1) };
  const sideL = { inner: bandStats(d2, 0.06, 0.14, -1), outer: bandStats(d2, 0.18, 0.30, -1) };
  out.p3_right = sideR; out.p3_left = sideL;
  out.p3_pickedSide = sideR.outer.avgRB >= sideL.outer.avgRB ? 'right' : 'left';
  const P = out.p3_pickedSide === 'right' ? sideR : sideL;
  out.p3_rbDiff = +(P.outer.avgRB - P.inner.avgRB).toFixed(1);   // 期望 >= 18
  out.p3_lumRatio = +(P.inner.avgLum / Math.max(1, P.outer.avgLum)).toFixed(2); // 期望 >= 1.5

  // ---- P4 滚轮缩放 ----
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
  await sleep(1200);
  const d3 = grab();
  out.p4_state = B.getState();
  out.p4_coreBefore = coreR(d1); out.p4_coreAfter = coreR(d3);
  out.p4_diskBefore = diskR(d1); out.p4_diskAfter = diskR(d3);

  // ---- P5 星流螺旋运动证据 ----
  const s5a = B.getState(); const d4 = grab();
  await sleep(800);
  const d5 = grab(); const s5b = B.getState();
  out.p5_starConst = s5a.starStreamCount === s5b.starStreamCount && s5b.starStreamCount >= 200;
  out.p5_frameDiffMidRing = diffCount(d4, d5, Math.round(cx - minD * 0.28), Math.round(cy - minD * 0.20), Math.round(cx + minD * 0.28), Math.round(cy + minD * 0.20), 10);

  // ---- P6 reset ----
  document.querySelector('[data-ui="reset"]').click();
  await sleep(400);
  out.p6_state = B.getState();
  const d6 = grab();
  out.p6_full = regionStats(d6, 0, 0, BW, BH);
  return out;
})()
