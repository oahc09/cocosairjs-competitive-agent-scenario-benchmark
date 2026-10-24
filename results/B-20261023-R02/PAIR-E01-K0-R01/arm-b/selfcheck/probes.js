(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__bench.getState();
  const out = {};

  // P2: 旋转相位 2s 采样窗
  await sleep(500);
  const p2b = S();
  await sleep(2000);
  const p2a = S();
  out.P2 = { dPhase: p2a.rotationPhase - p2b.rotationPhase, pass: p2a.rotationPhase - p2b.rotationPhase > 0.001 };

  // P3: 指针 0.50→0.68 视差
  const fire = (x, y) => document.body.dispatchEvent(new PointerEvent('pointermove', { clientX: Math.round(x * innerWidth), clientY: Math.round(y * innerHeight), bubbles: true, cancelable: true }));
  fire(0.5, 0.5);
  await sleep(200);
  fire(0.68, 0.5);
  await sleep(400);
  const p3b = S();
  await sleep(600);
  const p3a = S();
  out.P3 = { before: p3b.parallaxOffset, after: p3a.parallaxOffset, pass: p3a.parallaxOffset.x !== p3b.parallaxOffset.x || p3a.parallaxOffset.y !== p3b.parallaxOffset.y };

  // P4: 滚轮向上(deltaY=-600)
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, cancelable: true }));
  await sleep(500);
  const p4b = S();
  await sleep(300);
  const p4a = S();
  out.P4 = { before: p4b.cameraDistance, after: p4a.cameraDistance, pass: p4a.cameraDistance < p4b.cameraDistance - 5 };

  // P7: 指针归位中心 → Reset → 800ms
  fire(0.5, 0.5);
  await sleep(300);
  document.querySelector('[data-ui="reset"]').click();
  await sleep(800);
  const p7 = S();
  out.P7 = {
    epoch: p7.epoch, dist: p7.cameraDistance, par: p7.parallaxOffset, phase: p7.rotationPhase,
    pass: p7.epoch >= 1 && p7.cameraDistance >= 115 && p7.cameraDistance <= 125 && Math.abs(p7.parallaxOffset.x) < 0.01 && Math.abs(p7.parallaxOffset.y) < 0.01 && p7.rotationPhase < 0.1,
  };

  // P5: HUD 文本
  const hud = document.querySelector('[data-ui="hud"]');
  out.P5 = { text: hud ? hud.innerText.replace(/\n/g, ' | ') : null };

  // P6: 再等 3s 的 fps
  await sleep(3000);
  const p6 = S();
  out.P6 = { fps: p6.fps, pass: p6.fps >= 30 };

  // 连续 reset 幂等
  window.__bench.reset();
  window.__bench.reset();
  await sleep(900);
  const rr = S();
  out.resetIdempotent = { epoch: rr.epoch, dist: rr.cameraDistance, phase: rr.rotationPhase };

  return out;
})()
