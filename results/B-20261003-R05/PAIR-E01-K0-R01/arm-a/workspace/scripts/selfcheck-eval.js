// ============================================================================
// selfcheck-eval.js — 供 verify-browser.mjs --eval "$(cat 本文件)" 使用。
// 在页面内按 spec.json 探针口径(P1–P7)做一次性自检,返回汇总 JSON。
// 注意:本文件属于 Agent 自建自检工具,不属于冻结模板。
// ============================================================================
(async () => {
  const out = { ok: true, errors: [] };
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = window.innerWidth, H = window.innerHeight;
  const shotData = () => { window.__renderOnce(); return document.getElementById('app-canvas').toDataURL('image/png'); };
  const toPixels = (url) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      res({ d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height });
    };
    im.onerror = () => rej(new Error('image decode failed'));
    im.src = url;
  });
  function stats(f, x0, y0, x1, y1, ref) {
    const X0 = Math.floor(x0 * f.w), X1 = Math.ceil(x1 * f.w);
    const Y0 = Math.floor(y0 * f.h), Y1 = Math.ceil(y1 * f.h);
    let total = 0, lit = 0, diff = 0;
    for (let y = Y0; y < Y1; y++) {
      let i = (y * f.w + X0) * 4;
      for (let x = X0; x < X1; x++, i += 4) {
        const l = 0.2126 * f.d[i] + 0.7152 * f.d[i + 1] + 0.0722 * f.d[i + 2];
        total++;
        if (l > 40) lit++;
        if (ref) {
          const l2 = 0.2126 * ref[i] + 0.7152 * ref[i + 1] + 0.0722 * ref[i + 2];
          if (Math.abs(l - l2) > 14) diff++;
        }
      }
    }
    return { litRatio: +(lit / total).toFixed(5), diffRatio: +(diff / total).toFixed(5) };
  }
  try {
    // P1 — starCount >= 50000,画面非空(亮像素 >= 2%)
    await sleep(2300);
    const s1 = S();
    const f1 = await toPixels(shotData());
    out.P1 = Object.assign({ starCount: s1.starCount }, stats(f1, 0, 0, 1, 1, null));
    // P2 — 2s 采样窗:rotationPhase 增量 > 0.001;中央 80% 区域运动像素 >= 0.5%
    const b2 = S();
    const f2a = await toPixels(shotData());
    await sleep(2000);
    const f2b = await toPixels(shotData());
    const a2 = S();
    out.P2 = Object.assign({ dPhase: +(a2.rotationPhase - b2.rotationPhase).toFixed(4) },
      stats(f2b, 0.1, 0.1, 0.9, 0.9, f2a.d));
    // P3 — 指针 (0.5,0.5)->(0.68,0.5):parallaxOffset 变化;全画面像素差 >= 0.3%
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0.68 * W, clientY: 0.5 * H, bubbles: true }));
    await sleep(400);
    const b3 = S();
    const f3a = await toPixels(shotData());
    await sleep(600);
    const f3b = await toPixels(shotData());
    const a3 = S();
    out.P3 = Object.assign({ bx: b3.parallaxOffset.x, ax: a3.parallaxOffset.x, by: b3.parallaxOffset.y, ay: a3.parallaxOffset.y },
      stats(f3b, 0, 0, 1, 1, f3a.d));
    // P4 — 滚轮 deltaY=-600:cameraDistance 降 > 5;全画面像素差 >= 1%
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, clientX: W / 2, clientY: H / 2, bubbles: true, cancelable: true }));
    await sleep(500);
    const b4 = S();
    const f4a = await toPixels(shotData());
    await sleep(300);
    const f4b = await toPixels(shotData());
    const a4 = S();
    out.P4 = Object.assign({ bDist: +b4.cameraDistance.toFixed(2), aDist: +a4.cameraDistance.toFixed(2) },
      stats(f4b, 0, 0, 1, 1, f4a.d));
    // P5 — HUD 可见且文本含星点总数与帧率
    const hudEl = document.getElementById('hud');
    out.P5 = { state: S(), hudText: hudEl.innerText, hudRect: hudEl.getBoundingClientRect().toJSON() };
    // P6 — 3s 后滚动平均 fps >= 30
    await sleep(3000);
    out.P6 = { fps: +S().fps.toFixed(2) };
    // P7 — 指针归位中心 → 点击 Reset → 800ms 后断言
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0.5 * W, clientY: 0.5 * H, bubbles: true }));
    await sleep(150);
    document.getElementById('hud-reset').click();
    await sleep(800);
    out.P7 = { state: S() };
    const f7 = await toPixels(shotData());
    out.P7.litRatio = stats(f7, 0, 0, 1, 1, null).litRatio;
  } catch (e) {
    out.ok = false;
    out.errors.push(String((e && e.stack) || e));
  }
  return out;
})()
