(async () => {
  const S = () => window.__bench.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.appReady = window.__appReady === true;
  // P1: starCount
  await sleep(2500);
  const s1 = S();
  out.p1 = { starCount: s1.starCount, ok: s1.starCount >= 50000 };
  // P2: rotation over 2s window
  const r0 = S();
  await sleep(2000);
  const r1 = S();
  out.p2 = { delta: +(r1.rotationPhase - r0.rotationPhase).toFixed(4), ok: r1.rotationPhase - r0.rotationPhase > 0.001 };
  // P3: pointer parallax (0.50,0.50)->(0.68,0.50)
  const b3 = S();
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: Math.round(window.innerWidth * 0.68), clientY: Math.round(window.innerHeight * 0.5) }));
  await sleep(400);
  const m3 = S();
  await sleep(600);
  const a3 = S();
  out.p3 = { before: b3.parallaxOffset, mid: m3.parallaxOffset, after: a3.parallaxOffset, ok: a3.parallaxOffset.x !== b3.parallaxOffset.x || a3.parallaxOffset.y !== b3.parallaxOffset.y };
  // P4: wheel up deltaY=-600 -> camera closer
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, cancelable: true }));
  await sleep(500);
  const b4 = S();
  await sleep(300);
  const a4 = S();
  out.p4 = { before: +b4.cameraDistance.toFixed(2), after: +a4.cameraDistance.toFixed(2), ok: a4.cameraDistance < b4.cameraDistance - 5 };
  // P5/P6: hud + fps after 3s
  await sleep(3000);
  const s6 = S();
  out.p5 = { hudVisible: s6.hudVisible, fps: s6.fps, ok: s6.hudVisible === true && s6.fps > 0 };
  out.p6 = { fps: +s6.fps.toFixed(1), ok: s6.fps >= 30 };
  out.hudText = document.getElementById("hud").innerText.replace(/\n/g, " | ");
  // P7: reset (harness recenters pointer first; simulate that here)
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: Math.round(window.innerWidth * 0.5), clientY: Math.round(window.innerHeight * 0.5) }));
  await sleep(300);
  const btn = document.querySelector("[data-ui=reset]");
  btn.click();
  await sleep(800);
  const s7 = S();
  out.p7 = {
    epoch: s7.epoch, cameraDistance: +s7.cameraDistance.toFixed(2),
    parallaxOffset: { x: +s7.parallaxOffset.x.toFixed(5), y: +s7.parallaxOffset.y.toFixed(5) },
    rotationPhase: +s7.rotationPhase.toFixed(4),
    ok: s7.epoch >= 1 && s7.cameraDistance >= 115 && s7.cameraDistance <= 125 && Math.abs(s7.parallaxOffset.x) < 0.01 && Math.abs(s7.parallaxOffset.y) < 0.01 && s7.rotationPhase < 0.1,
  };
  // reset idempotence (second consecutive reset)
  btn.click();
  await sleep(800);
  const s7b = S();
  out.p7b = { epoch: s7b.epoch, cameraDistance: +s7b.cameraDistance.toFixed(2), rotationPhase: +s7b.rotationPhase.toFixed(4), ok: s7b.epoch >= 2 && Math.abs(s7b.cameraDistance - 120) <= 5 && s7b.rotationPhase < 0.1 };
  out.allOk = out.p1.ok && out.p2.ok && out.p3.ok && out.p4.ok && out.p5.ok && out.p6.ok && out.p7.ok && out.p7b.ok;
  return out;
})()
