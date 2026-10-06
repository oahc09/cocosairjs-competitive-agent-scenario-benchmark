(async () => {
  const out = {};
  try {
    const cv = document.getElementById("app-canvas");
    const W = cv.width, H = cv.height;
    const c2 = document.createElement("canvas"); c2.width = W; c2.height = H;
    const ctx = c2.getContext("2d", { willReadFrequently: true });
    const snap = () => { ctx.drawImage(cv, 0, 0); return ctx.getImageData(0, 0, W, H).data; };
    const lumOf = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const stats = (px, x0, y0, x1, y1, step) => {
      let nonBlack = 0, n = 0, lumSum = 0, rSum = 0, bSum = 0;
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
        const i = (y * W + x) * 4;
        const L = lumOf(px, i);
        n++; lumSum += L; rSum += px[i]; bSum += px[i + 2];
        if (L > 16) nonBlack++;
      }
      return { nonBlackRatio: +(nonBlack / n).toFixed(4), avgLum: Math.round(lumSum / n), avgRB: +((rSum - bSum) / n).toFixed(1) };
    };
    const diffRatio = (a, b, x0, y0, x1, y1, step, thr) => {
      let d = 0, n = 0;
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
        const i = (y * W + x) * 4;
        const dl = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (dl > thr) d++;
        n++;
      }
      return +(d / n).toFixed(4);
    };
    const st = (ms) => new Promise(r => setTimeout(r, ms));
    const cx = W >> 1, cy = H >> 1, m = Math.min(W, H);
    const pxR = (r) => Math.round(r * m);
    await st(400);
    const A = snap();
    const s0 = window.__bench.getState();
    out.centerVeilA = (() => { let s = 0, n = 0; for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) { s += lumOf(A, (y * W + x) * 4); n++; } return Math.round(s / n); })();
    // P1
    out.p1 = {
      centerThird: stats(A, cx - Math.round(W / 6), cy - Math.round(H / 3), cx + Math.round(W / 6), cy + Math.round(H / 3), 3),
      corners: (() => {
        const rs = [stats(A, 0, 0, 320, 200, 2), stats(A, W - 320, 0, W, 200, 2), stats(A, 0, H - 200, 320, H, 2), stats(A, W - 320, H - 200, W, H, 2)];
        return +(rs.reduce((s, r) => s + r.nonBlackRatio, 0) / 4).toFixed(4);
      })()
    };
    // 盘外缘半径:沿 +x 从屏幕右缘向内扫描首个 L>45(halo 边界)
    const diskEdge = (px) => { for (let x = W - 2; x > cx; x--) if (lumOf(px, (cy * W + x) * 4) > 45) return x - cx; return -1; };
    const edgeA = diskEdge(A);
    // P2
    await st(800);
    const B = snap();
    const s1 = window.__bench.getState();
    out.p2 = {
      diskRotationDelta: +(s1.diskRotation - s0.diskRotation).toFixed(4),
      diskFrameDiff: diffRatio(A, B, cx - 320, cy - 170, cx + 320, cy + 170, 3, 24)
    };
    // P3
    const bandStat = (px, r0, r1, side) => stats(px,
      side < 0 ? cx - r1 : cx + r0, cy - pxR(0.06),
      side < 0 ? cx - r0 : cx + r1, cy + pxR(0.06), 2);
    const innerL = bandStat(A, pxR(0.06), pxR(0.14), -1), innerR = bandStat(A, pxR(0.06), pxR(0.14), 1);
    const outerL = bandStat(A, pxR(0.18), pxR(0.30), -1), outerR = bandStat(A, pxR(0.18), pxR(0.30), 1);
    out.p3 = {
      inner: [innerL, innerR], outer: [outerL, outerR],
      avgRBDiff_best: +Math.max(outerL.avgRB - innerL.avgRB, outerR.avgRB - innerR.avgRB).toFixed(1),
      lumRatio_best: +Math.max(innerL.avgLum / Math.max(outerL.avgLum, 1), innerR.avgLum / Math.max(outerR.avgLum, 1)).toFixed(2)
    };
    // P4
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, cancelable: true }));
    await st(1300);
    const C = snap();
    const s2 = window.__bench.getState();
    const edgeC = diskEdge(C);
    out.p4 = { cameraDistance: +s2.cameraDistance.toFixed(3), edgeA, edgeC, edgeGrowth: +(edgeC / Math.max(edgeA, 1)).toFixed(3) };
    // P5
    await st(1000);
    const D = snap();
    const s3 = window.__bench.getState();
    out.p5 = { starStreamCount: s3.starStreamCount, midRingDiff: diffRatio(C, D, cx - 440, cy - 130, cx + 440, cy + 130, 3, 20) };
    // P6
    document.querySelector("[data-ui=reset]").click();
    await st(450);
    const s4 = window.__bench.getState();
    const E = snap();
    out.p6 = {
      state: s4,
      fullNonBlack: stats(E, 0, 0, W, H, 4).nonBlackRatio,
      edgeAfterReset: diskEdge(E)
    };
    out.s0 = s0;
  } catch (e) { out.evalError = String(e && e.message || e); }
  return out;
})()
