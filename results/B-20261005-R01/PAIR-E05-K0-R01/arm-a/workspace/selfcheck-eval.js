(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  try {
    const W = innerWidth, H = innerHeight, minD = Math.min(W, H);
    const cv = document.getElementById('app-canvas');
    const grab = () => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.drawImage(cv, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    };
    const lum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;

    // ---- P1: 初始 2.5s 后(含 fps 统计) ----
    const f0 = __bench.getState().frame;
    await sleep(2500);
    const f1 = __bench.getState().frame;
    out.fps = ((f1 - f0) / 2.5);
    const d1 = grab();
    const ratio = (x0, y0, x1, y1) => {
      let n = 0, tot = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * 4; tot++;
        if (d1[i] > 16 || d1[i + 1] > 16 || d1[i + 2] > 16) n++;
      }
      return +(n / tot).toFixed(4);
    };
    out.p1center = ratio(W / 3 | 0, H / 3 | 0, 2 * W / 3 | 0, 2 * H / 3 | 0);
    const cw = W * 0.12 | 0, ch = H * 0.12 | 0;
    out.p1corners = [
      ratio(0, 0, cw, ch), ratio(W - cw, 0, W, ch),
      ratio(0, H - ch, cw, H), ratio(W - cw, H - ch, W, H),
    ];
    let coreLum = 0, cn = 0;
    for (let y = H / 2 - 12; y < H / 2 + 12; y += 2) for (let x = W / 2 - 12; x < W / 2 + 12; x += 2) { coreLum += lum(d1, (y * W + x) * 4); cn++; }
    out.coreLum = +(coreLum / cn).toFixed(2);

    // ---- P2: 800ms 状态差 + 盘区两帧差分 ----
    const s1 = __bench.getState();
    await sleep(800);
    const s2 = __bench.getState();
    out.p2rotDelta = +(s2.diskRotation - s1.diskRotation).toFixed(4);
    const d2 = grab();
    let diffN = 0, totN = 0;
    for (let y = H / 2 - 200; y < H / 2 + 200; y += 2) for (let x = W / 2 - 300; x < W / 2 + 300; x += 2) {
      const i = (y * W + x) * 4; totN++;
      const df = Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
      if (df > 24) diffN++;
    }
    out.p2diskDiffPx = diffN;

    // ---- P3: 内/外环带方位采样(镜像 validator 几何) ----
    const cx = W / 2, cy = H / 2;
    const band = (r0, r1, d) => {
      const L = { r: 0, g: 0, b: 0, n: 0 }, R = { r: 0, g: 0, b: 0, n: 0 };
      const y0 = Math.round(cy - minD * 0.06), y1 = Math.round(cy + minD * 0.06);
      for (let y = y0; y <= y1; y++) {
        for (let x = Math.round(cx - r1); x <= Math.round(cx + r1); x++) {
          const dx = x - cx, ax = Math.abs(dx);
          if (ax < r0 || ax > r1) continue;
          const i = (y * W + x) * 4;
          const T = dx < 0 ? L : R;
          T.r += d[i]; T.g += d[i + 1]; T.b += d[i + 2]; T.n++;
        }
      }
      L.r /= L.n; L.g /= L.n; L.b /= L.n; R.r /= R.n; R.g /= R.n; R.b /= R.n;
      return { L, R };
    };
    const inner = band(minD * 0.06, minD * 0.14, d1);
    const outer = band(minD * 0.18, minD * 0.30, d1);
    const rb = (S) => S.r - S.b;
    const brt = (S) => (S.r + S.g + S.b) / 3;
    const pickRight = rb(outer.R) >= rb(outer.L);
    const OB = pickRight ? outer.R : outer.L, IB = pickRight ? inner.R : inner.L;
    out.p3 = {
      side: pickRight ? "right" : "left",
      rbDiff: +(rb(OB) - rb(IB)).toFixed(1),
      innerRB: +rb(IB).toFixed(1), outerRB: +rb(OB).toFixed(1),
      innerB: +brt(IB).toFixed(1), outerB: +brt(OB).toFixed(1),
      brightRatio: +(brt(IB) / Math.max(brt(OB), 0.01)).toFixed(2),
      accretionPhase: s2.accretionPhase,
    };

    // ---- P4: 滚轮缩放 ----
    const sB = __bench.getState();
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, cancelable: true }));
    await sleep(1300);
    const sZ = __bench.getState();
    const d3 = grab();
    const coreR = (d) => { for (let r = 10; r < 500; r++) { if (lum(d, (cy * W + (cx + r)) * 4) > 40) return r; } return -1; };
    const outerR = (d) => { let last = -1; for (let r = 10; r < 635; r++) { if (lum(d, (cy * W + (cx + r)) * 4) > 14) last = r; } return last; };
    out.p4 = {
      distBefore: +sB.cameraDistance.toFixed(2), distAfter: +sZ.cameraDistance.toFixed(2),
      coreR0: coreR(d1), coreR1: coreR(d3), coreRatio: +(coreR(d3) / Math.max(coreR(d1), 1)).toFixed(2),
      outerR0: outerR(d1), outerR1: outerR(d3),
    };

    // ---- P5: 盘周区域运动(700ms 差分)+ 星流数 ----
    const s5 = __bench.getState();
    const d4 = grab();
    await sleep(700);
    const d5 = grab();
    let mdiff = 0;
    for (let y = cy - 200; y < cy + 200; y += 2) for (let x = cx - 300; x < cx + 300; x += 2) {
      const i = (y * W + x) * 4;
      const df = Math.abs(d4[i] - d5[i]) + Math.abs(d4[i + 1] - d5[i + 1]) + Math.abs(d4[i + 2] - d5[i + 2]);
      if (df > 20) mdiff++;
    }
    out.p5 = { midRingDiffPx: mdiff, starStreamCount: s5.starStreamCount };

    // ---- P6: reset ----
    const r0 = __bench.getState();
    __bench.reset();
    await sleep(400);
    const r1 = __bench.getState();
    const d6 = grab();
    let nonBlack = 0, tot6 = 0;
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4; tot6++;
      if (d6[i] > 16 || d6[i + 1] > 16 || d6[i + 2] > 16) nonBlack++;
    }
    out.p6 = {
      dist: +r1.cameraDistance.toFixed(2), diskRotation: +r1.diskRotation.toFixed(3),
      accretionPhase: +r1.accretionPhase.toFixed(3), starStreamCount: r1.starStreamCount,
      fullNonBlack: +(nonBlack / tot6).toFixed(4),
    };
    out.state = r1;
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
})()
