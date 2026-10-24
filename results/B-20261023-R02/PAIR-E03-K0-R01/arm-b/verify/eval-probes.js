// P1–P9 探针自检模拟(镜像 spec.json 时序与断言;点击经 DOM 事件派发到画布)
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.querySelector('#GameCanvas');
  const c2 = document.createElement('canvas');
  c2.width = cv.width || 1280; c2.height = cv.height || 720;
  const ctx = c2.getContext('2d', { willReadFrequently: true });
  const grab = () => new Promise((res) => requestAnimationFrame(() => {
    ctx.drawImage(cv, 0, 0, c2.width, c2.height);
    res(ctx.getImageData(0, 0, c2.width, c2.height).data);
  }));
  const lumStats = (d) => {
    let lit = 0; const N = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 18) lit++;
    }
    return { lit: +(lit / N).toFixed(4) };
  };
  const diffRatio = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 10 || Math.abs(a[i + 1] - b[i + 1]) > 10 || Math.abs(a[i + 2] - b[i + 2]) > 10) n++;
    }
    return +(n / (a.length / 4)).toFixed(4);
  };
  const clickCanvas = (cssX, cssY) => {
    const r = cv.getBoundingClientRect();
    const cx = r.left + cssX, cy = r.top + cssY;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      cv.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 }));
      window.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 }));
    }
  };
  const uiClick = (id) => { const el = document.getElementById(id); if (!el) throw new Error('missing ' + id); el.click(); return true; };
  const G = () => window.__bench.getState();
  const out = { probes: {} };
  const check = (pid, label, ok, detail) => {
    (out.probes[pid] = out.probes[pid] || []).push({ label, ok: !!ok, detail });
  };

  await wait(1000); // 启动稳定

  // ---- P1: wait500 + 2s 采样窗 ----
  await wait(500);
  const p1a = G();
  const p1frameA = await grab();
  await wait(2000);
  const p1b = G();
  const p1frameB = await grab();
  const dAng0 = p1b.planets[0].orbitAngle - p1a.planets[0].orbitAngle;
  const dAng7 = p1b.planets[7].orbitAngle - p1a.planets[7].orbitAngle;
  check('P1', 'counts', p1b.planetCount === 8 && p1b.moonCount >= 2 && p1b.asteroidCount >= 500 && p1b.ringedPlanetCount >= 1, [p1b.planetCount, p1b.moonCount, p1b.asteroidCount, p1b.ringedPlanetCount]);
  check('P1', 'init', p1b.timeScale === 1 && p1b.selectedPlanet === null, [p1b.timeScale, p1b.selectedPlanet]);
  check('P1', 'kepler', dAng0 > 4 * dAng7, [+dAng0.toFixed(4), +dAng7.toFixed(4), 'ratio=' + (dAng0 / dAng7).toFixed(1)]);
  check('P1', 'lit>=0.03', lumStats(p1frameB).lit >= 0.03, lumStats(p1frameB));
  out.p1SimDelta = +(p1b.simulationTime - p1a.simulationTime).toFixed(2);

  // ---- P2: 点击 pickTargets[2](earth) ----
  const pt = G().pickTargets[2];
  const p2before = await grab();
  clickCanvas(pt.screenX, pt.screenY);
  await wait(600);
  const p2 = G();
  const p2after = await grab();
  let p2diff = 0;
  { // earth 投影区域 ±40px 的变化比例
    const r0 = Math.max(0, Math.floor(pt.screenX - 40)), r1 = Math.min(c2.width, Math.ceil(pt.screenX + 40));
    const c0 = Math.max(0, Math.floor(pt.screenY - 40)), c1 = Math.min(c2.height, Math.ceil(pt.screenY + 40));
    let n = 0, tot = 0;
    for (let y = c0; y < c1; y++) for (let x = r0; x < r1; x++) {
      const i = (y * c2.width + x) * 4; tot++;
      if (Math.abs(p2before[i] - p2after[i]) > 10 || Math.abs(p2before[i + 1] - p2after[i + 1]) > 10) n++;
    }
    p2diff = +(n / tot).toFixed(3);
  }
  const haloActive = !!(window.__airApp.getScene().getChildByName('selection-halo') || { active: false }).active;
  check('P2', 'selected=earth', p2.selectedPlanet === 'earth', p2.selectedPlanet);
  check('P2', 'pickTarget name', pt.name === 'earth' && pt.screenRadius >= 8, pt);
  check('P2', 'region-change', p2diff > 0.02, 'regionDiff=' + p2diff);
  check('P2', 'halo-active', haloActive, haloActive);

  // ---- P3: 信息卡 ----
  await wait(800);
  const p3 = G();
  const cardEl = document.querySelector('#info-card');
  const cardText = cardEl ? cardEl.textContent : '';
  const fieldRows = cardEl ? cardEl.querySelectorAll('.row').length : 0;
  check('P3', 'infoCard state', p3.infoCard.visible === true && p3.infoCard.name === 'earth' && p3.infoCard.fieldCount >= 3, p3.infoCard);
  check('P3', 'DOM text', cardEl && cardEl.style.display !== 'none' && /earth/.test(cardText) && fieldRows >= 3, { rows: fieldRows, text: cardText.slice(0, 120) });

  // ---- P4: 切 8x ----
  uiClick('speed-8x');
  await wait(500);
  const p4 = G();
  const btns = [...document.querySelectorAll('#time-controls button')].map((b) => b.textContent);
  const activeBtn = document.querySelector('#time-controls button.active');
  check('P4', 'timeScale=8', p4.timeScale === 8, p4.timeScale);
  check('P4', '5 buttons', btns.length === 5 && btns.join(',') === '0.5x,1x,2x,4x,8x', btns);
  check('P4', 'highlight', !!activeBtn && activeBtn.textContent === '8x', activeBtn && activeBtn.textContent);

  // ---- P5: 8x 采样窗 1.5s ----
  await wait(300);
  const p5a = G();
  const f5a = await grab();
  await wait(1500);
  const p5b = G();
  const f5b = await grab();
  const dSim = p5b.simulationTime - p5a.simulationTime;
  const d5Ang = p5b.planets[0].orbitAngle - p5a.planets[0].orbitAngle;
  check('P5', 'simDelta>=6', dSim >= 6, +dSim.toFixed(2));
  check('P5', 'angleDelta>=0.05', d5Ang >= 0.05, +d5Ang.toFixed(4));
  check('P5', 'motion>=0.005', diffRatio(f5a, f5b) >= 0.005, 'motion=' + diffRatio(f5a, f5b));
  out.p5SimDelta = +dSim.toFixed(2); out.p5RatioVs1x = +(dSim / out.p1SimDelta).toFixed(2);

  // ---- P6: Reset ----
  uiClick('reset');
  await wait(600);
  const p6 = G();
  check('P6', 'epoch&scale', p6.epoch >= 1 && p6.timeScale === 1, [p6.epoch, p6.timeScale]);

  // ---- P7: reset 后状态回初值且仍运动 ----
  await wait(300);
  const f7a = await grab();
  await wait(700);
  const p7 = G();
  const f7b = await grab();
  const a0 = p7.planets[0].orbitAngle, a7 = p7.planets[7].orbitAngle;
  check('P7', 'simTime<2.5', p7.simulationTime < 2.5, +p7.simulationTime.toFixed(2));
  check('P7', 'deselected', p7.selectedPlanet === null && p7.infoCard.visible === false, [p7.selectedPlanet, p7.infoCard.visible]);
  check('P7', 'angles', a0 >= -0.08 && a0 <= 0.08 && a7 >= 5.43 && a7 <= 5.56, [+a0.toFixed(4), +a7.toFixed(4)]);
  check('P7', 'motion>=0.002', diffRatio(f7a, f7b) >= 0.002, 'motion=' + diffRatio(f7a, f7b));

  // ---- P8: 0.5x ----
  uiClick('speed-0.5x');
  await wait(400);
  const p8 = G();
  check('P8', 'timeScale=0.5', p8.timeScale === 0.5, p8.timeScale);

  // ---- P9: 空白角点负向对照 ----
  const corners = [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]];
  let corner = null, cornerPx = null, minDist = 0;
  for (const [fx, fy] of corners) {
    const x = fx * 1280, y = fy * 720;
    const md = Math.min(...G().pickTargets.map((t) => Math.hypot(t.screenX - x, t.screenY - y)));
    if (md >= 80) { corner = [fx, fy]; cornerPx = [Math.round(x), Math.round(y)]; minDist = Math.round(md); break; }
  }
  if (corner) clickCanvas(cornerPx[0], cornerPx[1]);
  await wait(500);
  const p9 = G();
  check('P9', 'empty corner', !!corner, cornerPx ? [cornerPx, 'minDist=' + minDist] : 'none');
  check('P9', 'no select', p9.selectedPlanet === null, p9.selectedPlanet);
  check('P9', 'card hidden', p9.infoCard.visible === false && document.querySelector('#info-card').style.display === 'none', p9.infoCard.visible);

  out.fps = +G().fps.toFixed(1);
  out.summary = {};
  for (const [pid, items] of Object.entries(out.probes)) out.summary[pid] = items.every((x) => x.ok);
  out.allPass = Object.values(out.summary).every(Boolean);
  return out;
})()
