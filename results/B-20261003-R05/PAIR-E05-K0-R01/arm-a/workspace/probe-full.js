(async () => {
  const slp = (ms) => new Promise((r) => setTimeout(r, ms));
  const gl = document.getElementById("app-canvas");
  const W = gl.width, H = gl.height;
  const c2 = document.createElement("canvas");
  c2.width = W; c2.height = H;
  const cx2 = c2.getContext("2d", { willReadFrequently: true });
  const grab = () => { cx2.drawImage(gl, 0, 0); return cx2.getImageData(0, 0, W, H).data; };
  const minD = Math.min(W, H), ccx = W / 2, ccy = H / 2;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const snap = () => {
    const s = document.createElement("canvas");
    s.width = 320; s.height = 180;
    s.getContext("2d").drawImage(gl, 0, 0, 320, 180);
    return s.toDataURL("image/jpeg", 0.5);
  };
  await slp(2600);
  const st0 = Object.assign({}, window.__bench.getState());
  const d1 = grab();
  const snapA = snap();
  let cb = 0, cn = 0;
  for (let y = Math.floor(H / 3); y < Math.floor((2 * H) / 3); y += 2)
    for (let x = Math.floor(W / 3); x < Math.floor((2 * W) / 3); x += 2) {
      cn++;
      const i = (y * W + x) * 4;
      if (Math.max(d1[i], d1[i + 1], d1[i + 2]) > 26) cb++;
    }
  const corner = (x0, y0) => {
    let b = 0, n = 0;
    for (let y = y0; y < y0 + Math.floor(H / 4); y += 2)
      for (let x = x0; x < x0 + Math.floor(W / 4); x += 2) {
        n++;
        const i = (y * W + x) * 4;
        if (Math.max(d1[i], d1[i + 1], d1[i + 2]) > 26) b++;
      }
    return +(b / n).toFixed(4);
  };
  const corners = [corner(0, 0), corner(W - Math.floor(W / 4), 0), corner(0, H - Math.floor(H / 4)), corner(W - Math.floor(W / 4), H - Math.floor(H / 4))];
  let cl = 0, cn2 = 0;
  for (let y = ccy - 12; y < ccy + 12; y++)
    for (let x = ccx - 12; x < ccx + 12; x++) { cl += lum(d1, (y * W + x) * 4); cn2++; }
  const coreLum = +(cl / cn2).toFixed(2);
  const band = (side) => {
    let ir = 0, ib = 0, il = 0, inn = 0, orr = 0, ob = 0, ol = 0, on = 0;
    const yA = Math.max(1, Math.floor(ccy - 0.06 * minD)), yB = Math.min(H - 2, Math.ceil(ccy + 0.06 * minD));
    for (let y = yA; y <= yB; y++)
      for (let rad = Math.floor(0.05 * minD); rad <= Math.floor(0.32 * minD); rad++) {
        const x = Math.round(ccx + side * rad);
        if (x < 0 || x >= W) continue;
        const dist = Math.hypot(x - ccx, y - ccy);
        const i = (y * W + x) * 4;
        const R = d1[i], B = d1[i + 2], L = lum(d1, i);
        if (dist >= 0.06 * minD && dist <= 0.14 * minD) { ir += R; ib += B; il += L; inn++; }
        else if (dist >= 0.18 * minD && dist <= 0.3 * minD) { orr += R; ob += B; ol += L; on++; }
      }
    return { iRB: +((ir - ib) / inn).toFixed(1), oRB: +((orr - ob) / on).toFixed(1), iL: +(il / inn).toFixed(1), oL: +(ol / on).toFixed(1) };
  };
  const Rb = band(1), Lb = band(-1);
  const pickR = Rb.oRB - Rb.iRB >= Lb.oRB - Lb.iRB;
  const pk = pickR ? Rb : Lb;
  const rbDiff = +(pk.oRB - pk.iRB).toFixed(1);
  const lumRatio = +(pk.iL / Math.max(0.001, pk.oL)).toFixed(2);
  await slp(800);
  const st1 = Object.assign({}, window.__bench.getState());
  const d2 = grab();
  let diffDisk = 0, diffMid = 0;
  const rOut2 = Math.pow(0.45 * minD, 2), midLo = Math.pow(0.16 * minD, 2), midHi = Math.pow(0.42 * minD, 2);
  for (let y = 0; y < H; y += 2)
    for (let x = 0; x < W; x += 2) {
      const dx = x - ccx, dy = y - ccy, q = dx * dx + dy * dy;
      if (q > rOut2) continue;
      const i = (y * W + x) * 4;
      const dd = Math.abs(d2[i] - d1[i]) + Math.abs(d2[i + 1] - d1[i + 1]) + Math.abs(d2[i + 2] - d1[i + 2]);
      if (dd > 30) { diffDisk++; if (q > midLo && q < midHi) diffMid++; }
    }
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true, cancelable: true }));
  await slp(1300);
  const st2 = Object.assign({}, window.__bench.getState());
  const d3 = grab();
  const snapB = snap();
  const coreR = (d) => {
    let r = 0;
    for (let x = ccx; x < W; x++) {
      const i = (ccy * W + x) * 4;
      if (Math.max(d[i], d[i + 1], d[i + 2]) > 20) break;
      r++;
    }
    return r;
  };
  const diskR = (d) => {
    let last = 0, dark = 0;
    for (let x = ccx; x < W; x++) {
      const i = (ccy * W + x) * 4;
      if (Math.max(d[i], d[i + 1], d[i + 2]) > 12) { last = x - ccx; dark = 0; }
      else if (++dark > 150) break; // 连续 150px 无亮点才视为越过盘外缘(容忍放大后的暗核直径)
    }
    return last;
  };
  const coreR0 = coreR(d1), coreR1 = coreR(d3), diskR0 = diskR(d1), diskR1 = diskR(d3);
  document.querySelector("[data-ui=reset]").click();
  await slp(450);
  const st3 = Object.assign({}, window.__bench.getState());
  const d4 = grab();
  const snapC = snap();
  let full = 0, fn = 0;
  for (let y = 0; y < H; y += 3)
    for (let x = 0; x < W; x += 3) {
      fn++;
      const i = (y * W + x) * 4;
      if (Math.max(d4[i], d4[i + 1], d4[i + 2]) > 26) full++;
    }
  return {
    W, H, st0, st1, st2, st3,
    centerThirdFrac: +(cb / cn).toFixed(4),
    corners, coreLum,
    right: Rb, left: Lb, picked: pickR ? "right" : "left",
    rbDiff, lumRatio,
    dRot: +(st1.diskRotation - st0.diskRotation).toFixed(3),
    diffDisk, diffMid,
    coreR0, coreR1, coreRatio: +(coreR1 / Math.max(1, coreR0)).toFixed(2),
    diskR0, diskR1, diskRatio: +(diskR1 / Math.max(1, diskR0)).toFixed(2),
    camAfterWheel: +st2.cameraDistance.toFixed(2),
    fullFrac: +(full / fn).toFixed(4),
    snapA, snapB, snapC,
  };
})()
