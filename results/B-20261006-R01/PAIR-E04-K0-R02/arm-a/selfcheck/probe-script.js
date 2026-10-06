(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__bench.getState();
  const cv = document.querySelector('#GameCanvas');
  const gl = cv.getContext('webgl2');
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const grab = () => new Promise((res) => {
    requestAnimationFrame(() => setTimeout(() => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      res(px);
    }, 0));
  });
  // 区域亮像素计数(归一化坐标,y 自下而上,匹配 readPixels 原点)
  const bright = (px, x0, x1, y0, y1, thr) => {
    let c = 0;
    const X0 = Math.floor(x0 * W), X1 = Math.floor(x1 * W), Y0 = Math.floor(y0 * H), Y1 = Math.floor(y1 * H);
    for (let y = Y0; y < Y1; y += 2) for (let x = X0; x < X1; x += 2) {
      const o = (y * W + x) * 4;
      if (px[o] + px[o + 1] + px[o + 2] > (thr || 150)) c++;
    }
    return c;
  };
  // 暖色像素计数(R 明显高于 B)
  const warm = (px, x0, x1, y0, y1) => {
    let c = 0;
    const X0 = Math.floor(x0 * W), X1 = Math.floor(x1 * W), Y0 = Math.floor(y0 * H), Y1 = Math.floor(y1 * H);
    for (let y = Y0; y < Y1; y += 1) for (let x = X0; x < X1; x += 1) {
      const o = (y * W + x) * 4;
      if (px[o] > 90 && px[o] > px[o + 2] + 25) c++;
    }
    return c;
  };
  // 两帧差分非零像素比例(区域内,采样步长 2)
  const diffRatio = (a, b, x0, x1, y0, y1) => {
    let c = 0, n = 0;
    const X0 = Math.floor(x0 * W), X1 = Math.floor(x1 * W), Y0 = Math.floor(y0 * H), Y1 = Math.floor(y1 * H);
    for (let y = Y0; y < Y1; y += 2) for (let x = X0; x < X1; x += 2) {
      const o = (y * W + x) * 4;
      const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
      if (d > 24) c++; n++;
    }
    return n ? c / n : 0;
  };
  const out = {};

  // ---------- P1 初始夜景 ----------
  await wait(1200);
  out.P1 = { state: S(), bottomWarm: null, skyNonBlack: null };
  {
    const px = await grab();
    out.P1.bottomWarm = warm(px, 0, 1, 0, 0.33);
    out.P1.skyNonBlack = bright(px, 0, 1, 0.45, 0.98, 40);
    out.P1.horizonRowSample = bright(px, 0, 1, 0.26, 0.34, 40);
  }

  // ---------- P2 点击发射(合成事件走真实 DOM→引擎输入链路) ----------
  const clickNx = 0.5, clickNyTop = 0.30;
  const cx = Math.round(clickNx * cv.clientWidth), cy = Math.round(clickNyTop * cv.clientHeight);
  cv.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true }));
  await wait(500);
  out.P2 = { state: S() };
  const p2a = await grab();
  await wait(260);
  const p2b = await grab();
  out.P2.trailBandDiff = +diffRatio(p2a, p2b, 0.40, 0.60, 0.35, 0.95).toFixed(5);
  out.P2.burstRegionBrightAtP2 = bright(p2b, 0.30, 0.70, 0.50, 0.90);

  // ---------- P3 爆炸 ----------
  await wait(1200);
  out.P3 = { state: S() };
  const p3 = await grab();
  out.P3.burstRegionBright = bright(p3, 0.30, 0.70, 0.50, 0.90);
  out.P3.ratioVsP2 = out.P2.burstRegionBrightAtP2 > 0 ? +(out.P3.burstRegionBright / out.P2.burstRegionBrightAtP2).toFixed(2) : null;
  // 爆点高度:在 x∈[0.4,0.6] 带内找最亮行(y 自下而上)
  {
    let bestY = -1, bestL = -1;
    for (let y = 0; y < H; y += 4) {
      let l = 0;
      for (let x = Math.floor(0.4 * W); x < Math.floor(0.6 * W); x += 4) {
        const o = (y * W + x) * 4; l += px3(p3, o);
      }
      if (l > bestL) { bestL = l; bestY = y; }
    }
    out.P3.burstRowFromBottom = +(bestY / H).toFixed(3);
  }
  function px3(buf, o) { return buf[o] + buf[o + 1] + buf[o + 2]; }

  // ---------- P4 衰减与余烬 ----------
  await wait(2600);
  out.P4 = { state: S() };
  const p4a = await grab();
  await wait(300);
  const p4b = await grab();
  out.P4.centerBottomDiff = +diffRatio(p4a, p4b, 0.20, 0.80, 0.22, 0.62).toFixed(5);

  // ---------- P5 自动表演 ----------
  document.querySelector('[data-ui="auto-show"]').click();
  const c5s = S().fireworkCount;
  await wait(4000);
  out.P5 = { state: S(), countAtStart: c5s };

  // ---------- P6 关闭自动表演 ----------
  document.querySelector('[data-ui="auto-show"]').click();
  await wait(2500);
  const c6a = S();
  await wait(2100);
  const c6b = S();
  out.P6 = { stateAfterOff: c6a, stateAfter2s: c6b, countFrozen: c6a.fireworkCount === c6b.fireworkCount };

  // ---------- P7 暂停冻结 ----------
  document.querySelector('[data-ui="pause"]').click();
  await wait(300);
  out.P7 = { state: S() };
  const p7a = await grab();
  await wait(1000);
  const p7b = await grab();
  out.P7.fullDiff = +diffRatio(p7a, p7b, 0, 1, 0, 1).toFixed(6);

  // ---------- P8 reset ----------
  document.querySelector('[data-ui="reset"]').click();
  await wait(600);
  out.P8 = { state: S() };
  {
    const px = await grab();
    out.P8.upperBright = bright(px, 0, 1, 0.5, 1.0, 150);
    out.P8.bottomWarm = warm(px, 0, 1, 0, 0.33);
  }
  out.ok = true;
  // 重新开启自动表演,供 post-eval 截图捕捉烟花飞行画面
  document.querySelector('[data-ui="auto-show"]').click();
  await wait(1700);
  out.showReenabled = S();
  return out;
})()
