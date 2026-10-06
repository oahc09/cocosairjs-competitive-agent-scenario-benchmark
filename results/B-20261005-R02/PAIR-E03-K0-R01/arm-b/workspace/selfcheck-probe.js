(async () => {
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errors: [], marker: (window.__probeMarker = 'alive-' + Date.now()) };
  window.addEventListener('error', (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push('rej:' + String(e && e.reason).slice(0, 150)));
  const near = (x, a, b) => x >= a && x <= b;

  // ---- 像素采样:经引擎模块同实例 director EVENT_AFTER_DRAW 钩子内 readPixels(同任务内缓冲仍有效) ----
  let snap = null;
  try {
    const mod = await import('/dist/vendor/cocosair.module.js');
    const gl = document.querySelector('#GameCanvas').getContext('webgl2');
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const buf = new Uint8Array(W * H * 4);
    const GW = 64, GH = 36;
    let want = 0, have = 0, lastLit = 0, lastGrid = null;
    mod.director.on(mod.Director.EVENT_AFTER_DRAW, () => {
      if (want <= have) return;
      want = have + 1; // 只取最新一帧
      try {
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let lit = 0;
        const grid = new Float32Array(GW * GH);
        const cw = Math.floor(W / GW), ch = Math.floor(H / GH);
        for (let gy = 0; gy < GH; gy++) {
          for (let gx = 0; gx < GW; gx++) {
            let s = 0;
            const x0 = gx * cw, y0 = H - 1 - (gy + 1) * ch;
            for (let y = y0; y < y0 + ch; y += 2) {
              if (y < 0) continue;
              for (let x = x0; x < x0 + cw; x += 2) {
                const i = (y * W + x) * 4;
                if (buf[i] > 12 || buf[i + 1] > 12 || buf[i + 2] > 12) lit++;
                s += buf[i] + buf[i + 1] + buf[i + 2];
              }
            }
            grid[gy * GW + gx] = s;
          }
        }
        lastLit = lit / (W * H);
        lastGrid = grid;
        have++;
      } catch (e) { out.snapError = String(e).slice(0, 120); have++; }
    });
    const nextSnap = async () => { const h0 = have, w0 = want; want = w0 + 1; let n = 0; while (have <= h0 && n < 200) { await sleep(25); n++; } return { lit: lastLit, grid: lastGrid }; };
    const cellOf = (x, y) => ({ gx: Math.min(GW - 1, Math.max(0, Math.floor((x / W) * GW))), gy: Math.min(GH - 1, Math.max(0, Math.floor((y / H) * GH))) });
    const diffRatio = (g1, g2, thr) => {
      if (!g1 || !g2) return -1;
      let c = 0;
      for (let i = 0; i < g1.length; i++) if (Math.abs(g1[i] - g2[i]) > thr) c++;
      return c / g1.length;
    };
    snap = { nextSnap, cellOf, diffRatio, size: [W, H] };
  } catch (e) { out.snapInitError = String(e).slice(0, 150); }

  const canvas = document.querySelector('#GameCanvas');
  const clickAt = (x, y) => {
    const opt = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0, buttons: 1 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opt));
    const opt2 = Object.assign({}, opt, { buttons: 0 });
    canvas.dispatchEvent(new PointerEvent('pointerup', opt2));
  };
  const ui = (name) => document.querySelector('[data-ui="' + name + '"]');

  // ================= P1:初始状态 + 公转分层(2s 采样窗)+ 非空像素 =================
  const p1before = S();
  const p1grid0 = snap ? (await snap.nextSnap()).grid : null;
  await sleep(2000);
  const p1after = S();
  const dA0 = p1after.planets[0].orbitAngle - p1before.planets[0].orbitAngle;
  const dA7 = p1after.planets[7].orbitAngle - p1before.planets[7].orbitAngle;
  const p1snap = snap ? await snap.nextSnap() : null;
  out.P1 = {
    pass: p1before.planetCount === 8 && p1before.moonCount >= 2 && p1before.asteroidCount >= 500 &&
      p1before.ringedPlanetCount >= 1 && p1before.timeScale === 1 && p1before.selectedPlanet === null &&
      dA0 > 4 * dA7 && (!p1snap || p1snap.lit >= 0.03),
    counts: { p: p1before.planetCount, m: p1before.moonCount, a: p1before.asteroidCount, r: p1before.ringedPlanetCount, ts: p1before.timeScale, sel: p1before.selectedPlanet },
    dA0, dA7, ratio: dA7 > 0 ? dA0 / dA7 : -1,
    litRatio: p1snap ? p1snap.lit : null,
    simTime: p1after.simulationTime, fps: p1after.fps,
  };

  // ================= P2:点击 pickTargets[2](earth)→ 选中 + 高亮 =================
  const t2 = S().pickTargets[2];
  const pre2 = snap ? await snap.nextSnap() : null;
  clickAt(Math.round(t2.screenX), Math.round(t2.screenY));
  await sleep(600);
  const s2 = S();
  let hl = null;
  if (snap && pre2) {
    const after2 = await snap.nextSnap();
    const c = snap.cellOf(t2.screenX, t2.screenY);
    let chg = 0, tot = 0;
    for (let gy = Math.max(0, c.gy - 3); gy <= Math.min(35, c.gy + 3); gy++)
      for (let gx = Math.max(0, c.gx - 3); gx <= Math.min(63, c.gx + 3); gx++) {
        tot++;
        if (Math.abs((pre2.grid || [])[gy * 64 + gx] - after2.grid[gy * 64 + gx]) > 1400) chg++;
      }
    hl = { regionChangeCells: chg, regionCells: tot };
  }
  out.P2 = { pass: s2.selectedPlanet === 'earth' && (!hl || hl.regionChangeCells >= 2), picked: t2, selected: s2.selectedPlanet, highlight: hl };

  // ================= P3:信息卡(等待 800ms 后仍可见,字段>=3,DOM 文本一致) =================
  await sleep(800);
  const s3 = S();
  const card = ui('info-card');
  const cardText = card ? card.innerText : '';
  const cardRect = card ? card.getBoundingClientRect() : null;
  out.P3 = {
    pass: s3.infoCard.visible === true && s3.infoCard.name === 'earth' && s3.infoCard.fieldCount >= 3 &&
      card && cardText.indexOf('earth') >= 0 && cardRect && cardRect.width > 50 && cardRect.height > 40,
    infoCard: s3.infoCard, domText: cardText.replace(/\s+/g, ' ').slice(0, 220),
    rect: cardRect ? { x: Math.round(cardRect.x), y: Math.round(cardRect.y), w: Math.round(cardRect.width), h: Math.round(cardRect.height) } : null,
  };

  // ================= P4:8x 档位 + 五档控件 + 档位高亮 =================
  ui('speed-8x').click();
  await sleep(500);
  const s4 = S();
  const btns = ['0.5x', '1x', '2x', '4x', '8x'].map((v) => ui('speed-' + v));
  const tcText = ui('timeControls') ? ui('timeControls').innerText : '';
  out.P4 = {
    pass: s4.timeScale === 8 && btns.every((b) => !!b) && ui('speed-8x').classList.contains('active') &&
      ['0.5', '1', '2', '4', '8'].every((v) => tcText.indexOf(v) >= 0),
    timeScale: s4.timeScale, buttonsPresent: btns.map((b) => !!b), active8x: ui('speed-8x').classList.contains('active'),
    timeControlsText: tcText.replace(/\s+/g, ' '),
    litRatio: snap ? (await snap.nextSnap()).lit : null,
  };

  // ================= P5:8x 下模拟时间与轨道角推进 + 像素运动 =================
  const p5b = S();
  const g5a = snap ? (await snap.nextSnap()).grid : null;
  await sleep(400);
  const g5b = snap ? (await snap.nextSnap()).grid : null;
  await sleep(1100);
  const p5a = S();
  const dSim = p5a.simulationTime - p5b.simulationTime;
  const dAng = p5a.planets[0].orbitAngle - p5b.planets[0].orbitAngle;
  const motion = snap ? snap.diffRatio(g5a, g5b, 1400) : -1;
  out.P5 = { pass: dSim >= 6 && dAng >= 0.05 && (!snap || motion >= 0.005), dSim, dAng, motionPixelRatio: motion };

  // ================= P6:Reset → epoch+1、timeScale=1、无导航 =================
  ui('reset').click();
  await sleep(600);
  const s6 = S();
  out.P6 = {
    pass: s6.epoch >= 1 && s6.timeScale === 1 && window.__probeMarker === out.marker && window.__bench && !!window.__bench.getState,
    epoch: s6.epoch, timeScale: s6.timeScale, noReload: window.__probeMarker === out.marker,
    litRatio: snap ? (await snap.nextSnap()).lit : null,
  };

  // ================= P7:reset 后轨道角复位、无选中、卡关闭、画面仍运动 =================
  await sleep(300);
  const s7 = S();
  const g7a = snap ? (await snap.nextSnap()).grid : null;
  await sleep(400);
  const g7b = snap ? (await snap.nextSnap()).grid : null;
  const motion7 = snap ? snap.diffRatio(g7a, g7b, 900) : -1;
  const a0 = s7.planets[0].orbitAngle, a7 = s7.planets[7].orbitAngle;
  out.P7 = {
    pass: s7.simulationTime < 1.5 && s7.selectedPlanet === null && s7.infoCard.visible === false &&
      near(a0, -0.06, 0.06) && near(a7, 5.43, 5.56) && (!snap || motion7 >= 0.002),
    simTime: s7.simulationTime, a0, a7, motionPixelRatio: motion7,
    angles: s7.planets.map((p) => Math.round(p.orbitAngle * 1000) / 1000),
  };

  // ================= P8:0.5x 档位 + 五档 DOM =================
  ui('speed-0.5x').click();
  await sleep(400);
  const s8 = S();
  const tcText8 = ui('timeControls') ? ui('timeControls').innerText : '';
  out.P8 = {
    pass: s8.timeScale === 0.5 && ['0.5x', '1x', '2x', '4x', '8x'].every((v) => !!ui('speed-' + v)) &&
      ui('speed-0.5x').classList.contains('active'),
    timeScale: s8.timeScale, active05: ui('speed-0.5x').classList.contains('active'),
    timeControlsText: tcText8.replace(/\s+/g, ' '),
    litRatio: snap ? (await snap.nextSnap()).lit : null,
  };

  // ================= P9:点击空白角落 → 不选中、卡不出现(NC04) =================
  const blank = { x: Math.round(0.08 * window.innerWidth), y: Math.round(0.08 * window.innerHeight) };
  const targets = S().pickTargets;
  const minDist = Math.min.apply(null, targets.map((t) => Math.hypot(t.screenX - blank.x, t.screenY - blank.y)));
  clickAt(blank.x, blank.y);
  await sleep(500);
  const s9 = S();
  const card9 = ui('info-card');
  out.P9 = {
    pass: s9.selectedPlanet === null && card9.style.display === 'none' && minDist >= 80,
    selected: s9.selectedPlanet, cardDisplay: card9.style.display, minTargetDist: Math.round(minDist),
    blankPoint: blank,
  };

  out.final = S();
  out.consoleNote = 'console errors 由 verify-browser 汇总';
  return out;
})()
