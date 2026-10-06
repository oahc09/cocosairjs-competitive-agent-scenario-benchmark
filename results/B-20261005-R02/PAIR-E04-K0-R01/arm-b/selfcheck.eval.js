(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => window.__bench.getState();
  const cv = document.querySelector('#GameCanvas');
  const gl = cv.getContext('webgl2') || cv.getContext('webgl');
  const out = { hasGL: !!gl };

  // ---- 像素采样:在 rAF 中(引擎本帧绘制之后)drawImage 到 2D 画布再读像素 ----
  let snapCtx = null, SW = 0, SH = 0, snapCanvas = null;
  function ensureSnap() {
    SW = gl.drawingBufferWidth; SH = gl.drawingBufferHeight;
    snapCanvas = document.createElement('canvas');
    snapCanvas.width = SW; snapCanvas.height = SH;
    snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
  }
  function snap() {
    return new Promise((res) => {
      requestAnimationFrame(() => { try { snapCtx.drawImage(cv, 0, 0); } catch (e) { out.snapErr = String(e && e.message); } res(); });
    });
  }
  // 一次遍历产出多区域度量(stride=2)
  function metrics() {
    const d = snapCtx.getImageData(0, 0, SW, SH).data;
    const stride = 2;
    const m = {
      warmBottom: 0, brightUpper: 0, brightBand: 0, brightBandYSum: 0, brightBandN: 0,
      starTop: 0, silLum: 0, silN: 0, skyLum: 0, skyN: 0, anyLum: 0,
      grid: new Float32Array((SH / 8 >> 0) * (SW / 8 >> 0)), gw: SW / 8 >> 0, gh: SH / 8 >> 0,
    };
    for (let y = 0; y < SH; y += stride) {
      const ny = y / SH; // top-origin
      for (let x = 0; x < SW; x += stride) {
        const nx = x / SW;
        const i = (y * SW + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (ny >= 2 / 3 && nx >= 0 && nx <= 1) {
          if (r > 150 && r > b + 40 && g > 70) m.warmBottom++;
        }
        if (ny <= 0.5) {
          if (lum > 170) m.brightUpper++;
          if (lum > 120) m.starTop++;
        }
        if (nx >= 0.4 && nx <= 0.6) {
          if (lum > 150) { m.brightBand++; m.brightBandYSum += ny; m.brightBandN++; }
        }
        if (ny >= 0.8 && nx >= 0.2 && nx <= 0.8) { m.silLum += lum; m.silN++; }
        if (ny >= 0.56 && ny <= 0.66 && nx >= 0.1 && nx <= 0.9) { m.skyLum += lum; m.skyN++; }
        if (lum > 0) m.anyLum++;
        const gx = SW / 8 >> 0, gy = SH / 8 >> 0;
        if (x % 8 === 0 && y % 8 === 0) m.grid[(y / 8 >> 0) * gx + (x / 8 >> 0)] = lum;
      }
    }
    m.silLum = m.silN ? m.silLum / m.silN : 0;
    m.skyLum = m.skyN ? m.skyLum / m.skyN : 0;
    m.bandMeanY = m.brightBandN ? m.brightBandYSum / m.brightBandN : -1;
    return m;
  }
  function diffRatio(a, b, x0, x1, y0, y1) {
    let changed = 0, total = 0;
    for (let gy = 0; gy < a.gh; gy++) {
      const ny = gy / a.gh;
      for (let gx = 0; gx < a.gw; gx++) {
        const nx = gx / a.gw;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        total++;
        if (Math.abs(a.grid[gy * a.gw + gx] - b.grid[gy * a.gw + gx]) > 22) changed++;
      }
    }
    return total ? changed / total : -1;
  }

  if (!gl || !cv) { out.fatal = 'no canvas/gl'; return out; }
  ensureSnap();

  // ===== P1:初始夜景 =====
  await sleep(2500);
  await snap();
  out.P1_state = st();
  out.P1 = metrics();

  // ===== P2:点击 (0.5, 0.30) 发射 =====
  const cx = 0.5 * window.innerWidth, cy = 0.30 * window.innerHeight;
  cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }));
  cv.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true }));
  cv.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, bubbles: true }));
  out.lastClick = window.__lastClick;
  await sleep(500);
  out.P2_state = st();
  await snap(); out.P2_a = metrics();
  await sleep(350);
  out.P2_state2 = st();
  await snap(); out.P2_b = metrics();
  out.P2_motionBand = diffRatio(out.P2_a, out.P2_b, 0.4, 0.6, 0.0, 1.0);

  // ===== P3:爆炸 =====
  await sleep(1400);
  out.P3_state = st();
  await snap(); out.P3 = metrics();

  // ===== P4:衰减与余烬(多采样点,含 amendment 对齐的 ~7.3s / ~9s) =====
  out.aliveTrend = [];
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    out.aliveTrend.push({ t: Math.round(performance.now() / 1000), n: st().particlesAlive });
  }
  await snap(); out.P4_early = metrics();
  out.P4_state_5s = st();
  await sleep(2200);
  out.P4_state_7s = st();
  await snap(); out.P4_a = metrics();
  await sleep(400);
  await snap(); out.P4_b = metrics();
  out.P4_motionCB = diffRatio(out.P4_a, out.P4_b, 0.15, 0.85, 0.45, 0.95);
  out.P4_motionUpper = diffRatio(out.P4_a, out.P4_b, 0.15, 0.85, 0.0, 0.45);
  await sleep(1800);
  out.P4_state_9s = st();

  // ===== P5:自动表演开启 =====
  document.querySelector('[data-ui="auto-show"]').click();
  await sleep(4000);
  out.P5_state = st();
  // fps 采样(自动表演常态)
  let frames = 0; const t0 = performance.now();
  await new Promise((res) => {
    const cnt = () => { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(cnt); else res(); };
    requestAnimationFrame(cnt);
  });
  out.fpsAutoShow = frames;
  await snap(); out.P5 = metrics();

  // ===== P6:自动表演关闭,fireworkCount 冻结 =====
  document.querySelector('[data-ui="auto-show"]').click();
  await sleep(400);
  out.P6_state = st();
  const f1 = st().fireworkCount;
  await sleep(2100);
  const f2 = st().fireworkCount;
  out.P6_frozen = { f1, f2, delta: f2 - f1 };
  out.P6_state_after = st();

  // ===== P7:暂停冻结 =====
  document.querySelector('[data-ui="pause"]').click();
  await sleep(300);
  out.P7_state = st();
  await snap(); const fa = metrics();
  await sleep(1000);
  await snap(); const fb = metrics();
  out.P7_diffFull = diffRatio(fa, fb, 0, 1, 0, 1);

  // ===== P8:reset =====
  document.querySelector('[data-ui="reset"]').click();
  await sleep(600);
  out.P8_state = st();
  await snap(); out.P8 = metrics();

  out.done = true;
  return out;
})()
