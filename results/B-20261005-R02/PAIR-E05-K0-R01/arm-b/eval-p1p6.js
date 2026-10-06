(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const st = () => window.__bench.getState();
  out.state0 = st();
  window.__snapWanted = true;
  await sleep(300);
  if (!window.__snapPixels || !window.__snapMeta) { out.snapError = JSON.parse(JSON.stringify(window.__diag)); return out; }
  const W = window.__snapMeta.w, H = window.__snapMeta.h;
  out.snapSize = [W, H];
  const grab = () => window.__snapPixels.slice();
  const A = grab();
  await sleep(800);
  out.stateB = st();
  const B = grab();
  const px = (buf, x, y) => { const i = ((H - 1 - y) * W + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const analyze = (buf) => {
    const res = {};
    const cw = Math.floor(W / 3), ch = Math.floor(H / 3);
    const cArea = Math.floor(W * 0.2) * Math.floor(H * 0.2) * 4;
    const cnt = { full: {}, centerThird: {}, outerCorners: {} };
    const ths = [16, 32, 48];
    for (const t of ths) { cnt.full[t] = 0; cnt.centerThird[t] = 0; cnt.outerCorners[t] = 0; }
    for (let y = 0; y < H; y++) {
      const inCY = y >= ch && y < 2 * ch;
      const inCornerY = y < H * 0.2 || y >= H * 0.8;
      const row = (H - 1 - y) * W * 4;
      for (let x = 0; x < W; x++) {
        const i = row + x * 4;
        const m = Math.max(buf[i], buf[i + 1], buf[i + 2]);
        if (m > 16) {
          cnt.full[16]++;
          if (inCY && x >= cw && x < 2 * cw) cnt.centerThird[16]++;
          if (inCornerY && (x < W * 0.2 || x >= W * 0.8)) cnt.outerCorners[16]++;
          if (m > 32) {
            cnt.full[32]++;
            if (inCY && x >= cw && x < 2 * cw) cnt.centerThird[32]++;
            if (inCornerY && (x < W * 0.2 || x >= W * 0.8)) cnt.outerCorners[32]++;
            if (m > 48) {
              cnt.full[48]++;
              if (inCY && x >= cw && x < 2 * cw) cnt.centerThird[48]++;
              if (inCornerY && (x < W * 0.2 || x >= W * 0.8)) cnt.outerCorners[48]++;
            }
          }
        }
      }
    }
    res.centerThird = {}; res.outerCorners = {}; res.full = {};
    for (const t of ths) {
      res.centerThird[t] = +(cnt.centerThird[t] / (cw * ch)).toFixed(5);
      res.outerCorners[t] = +(cnt.outerCorners[t] / cArea).toFixed(5);
      res.full[t] = +(cnt.full[t] / (W * H)).toFixed(5);
    }
    const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
    const band = (side, r0, r1) => {
      let R = 0, Bv = 0, L = 0, n = 0;
      const dyMax = Math.floor(0.06 * H);
      for (let rp = Math.floor(r0); rp <= Math.floor(r1); rp += 2) {
        const x = cx + side * rp;
        if (x < 0 || x >= W) continue;
        for (let dy = -dyMax; dy <= dyMax; dy += 2) {
          const y = cy + dy;
          if (y < 0 || y >= H) continue;
          const c = px(buf, x, y);
          R += c[0]; Bv += c[2]; L += Math.max(c[0], c[1], c[2]); n++;
        }
      }
      return n ? { rb: +((R - Bv) / n).toFixed(2), lum: +(L / n).toFixed(2), n } : null;
    };
    const sectors = {};
    for (const side of [-1, 1]) {
      const inner = band(side, 0.06 * H, 0.14 * H);
      const outer = band(side, 0.18 * H, 0.30 * H);
      sectors[side < 0 ? "left" : "right"] = {
        innerRB: inner ? inner.rb : null, innerLum: inner ? inner.lum : null,
        outerRB: outer ? outer.rb : null, outerLum: outer ? outer.lum : null,
        rbDiff: (inner && outer) ? +(outer.rb - inner.rb).toFixed(2) : null,
        lumRatio: (inner && outer && outer.lum > 1) ? +(inner.lum / outer.lum).toFixed(3) : null
      };
    }
    res.sectors = sectors;
    let coreMax = 0;
    for (let dy = -10; dy <= 10; dy += 2) for (let dx = -10; dx <= 10; dx += 2) {
      const c = px(buf, cx + dx, cy + dy); coreMax = Math.max(coreMax, Math.max(c[0], c[1], c[2]));
    }
    res.coreMaxLum = coreMax;
    const ring = band(1, 0.08 * H, 0.12 * H);
    res.ringLumAt010H = ring ? ring.lum : null;
    return res;
  };
  out.statsA = analyze(A);
  out.statsB = analyze(B);
  let fullDiff = 0, diskDiff = 0, midDiff = 0;
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  for (let y = 0; y < H; y++) {
    const row = (H - 1 - y) * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d > 10) fullDiff++;
    }
  }
  for (let rp = 60; rp <= 240; rp += 2) {
    const doMid = rp >= 130 && rp <= 216;
    for (let a = 0; a < 360; a += 3) {
      const rad = a * Math.PI / 180;
      const x = Math.round(cx + Math.cos(rad) * rp);
      const y = Math.round(cy + Math.sin(rad) * rp * 0.65);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = ((H - 1 - y) * W + x) * 4;
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d > 10) { diskDiff++; if (doMid) midDiff++; }
    }
  }
  out.frameDiff = { fullDiff, diskDiff, midDiff };
  const coreRadius = (buf) => {
    const firstBright = (dir) => {
      for (let rp = 5; rp < 400; rp += 1) {
        const x = cx + dir * rp;
        if (x < 0 || x >= W) break;
        const c = px(buf, x, cy);
        if (Math.max(c[0], c[1], c[2]) > 50) return rp;
      }
      return -1;
    };
    return { left: firstBright(-1), right: firstBright(1) };
  };
  out.coreRadiusBefore = coreRadius(A);
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, cancelable: true, bubbles: true }));
  await sleep(1300);
  out.stateC = st();
  const C = grab();
  out.coreRadiusAfter = coreRadius(C);
  const btn = document.querySelector("[data-ui=reset]");
  out.resetBtn = !!btn;
  if (btn) btn.click();
  await sleep(450);
  out.stateD = st();
  const D = grab();
  out.statsD = analyze(D);
  window.__snapWanted = false;
  out.diag = JSON.parse(JSON.stringify(window.__diag));
  return out;
})
