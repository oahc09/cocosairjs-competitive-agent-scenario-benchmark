(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const S = () => window.__bench.getState();
  const cv = document.getElementById("app-canvas");
  const grabCanvas = document.createElement("canvas");
  const gctx = grabCanvas.getContext("2d", { willReadFrequently: true });
  function grab(rx, ry, rw, rh) {
    const w = cv.width, h = cv.height;
    if (grabCanvas.width !== w || grabCanvas.height !== h) { grabCanvas.width = w; grabCanvas.height = h; }
    gctx.drawImage(cv, 0, 0);
    const img = gctx.getImageData(Math.floor(rx * w), Math.floor(ry * h), Math.max(2, Math.floor(rw * w)), Math.max(2, Math.floor(rh * h)));
    return img.data;
  }
  function diffRatio(a, b) {
    let n = 0; const t = 30;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > t || Math.abs(a[i + 1] - b[i + 1]) > t || Math.abs(a[i + 2] - b[i + 2]) > t) n++;
    }
    return n / (a.length / 4);
  }
  await sleep(2000);
  out.p1_state = S();
  const st1 = grab(0, 0.62, 1, 0.38); await sleep(600); const st2 = grab(0, 0.62, 1, 0.38);
  out.p2_streetChange600ms = Number(diffRatio(st1, st2).toFixed(4));
  const f1 = grab(0, 0, 1, 1); await sleep(100); const f2 = grab(0, 0, 1, 1);
  out.p3_fullChange100ms = Number(diffRatio(f1, f2).toFixed(4));
  await sleep(3000);
  out.p4_state = S();
  const u1 = grab(0, 0, 1, 0.45);
  document.querySelector("[data-bench=toggle-fog]").click();
  await sleep(800);
  out.p5_state = S();
  const u2 = grab(0, 0, 1, 0.45);
  out.p5_upperChange = Number(diffRatio(u1, u2).toFixed(4));
  const u3 = grab(0, 0, 1, 0.45);
  document.querySelector("[data-bench=toggle-fog]").click();
  await sleep(800);
  out.p6_state = S();
  const u4 = grab(0, 0, 1, 0.45);
  out.p6_upperChange = Number(diffRatio(u3, u4).toFixed(4));
  document.querySelector("[data-bench=reset]").click();
  await sleep(2000);
  out.p7_state = S();
  await sleep(1500);
  out.p8_state = S();
  return out;
})()
