(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__bench.getState();
  const cv = document.getElementById('app-canvas');
  const r = cv.getBoundingClientRect();
  const fire = (nx, ny) => cv.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + nx * r.width, clientY: r.top + ny * r.height, bubbles: true, pointerId: 1,
  }));
  const out = {};
  out.p1 = S();
  await sleep(2000);
  out.p1NonBlank = cv.toDataURL().length > 20000;
  fire(0.5, 0.30); // P2 点击夜空发射
  await sleep(500);
  out.p2 = S();
  const ma = cv.toDataURL();
  await sleep(300);
  out.p2Motion = ma !== cv.toDataURL();
  await sleep(1200);
  out.p3 = S();
  await sleep(2600);
  out.p4 = S();
  document.querySelector('[data-ui="auto-show"]').click();
  await sleep(4000);
  out.p5 = S();
  document.querySelector('[data-ui="auto-show"]').click();
  const f1 = S().fireworkCount;
  await sleep(2300);
  const s6 = S();
  out.p6 = { autoShow: s6.autoShow, frozen: f1 === s6.fireworkCount, count: s6.fireworkCount };
  document.querySelector('[data-ui="pause"]').click();
  await sleep(400);
  out.p7 = S();
  const pa = cv.toDataURL();
  await sleep(1000);
  out.p7FrozenPixels = pa === cv.toDataURL();
  document.querySelector('[data-ui="reset"]').click();
  await sleep(600);
  out.p8 = S();
  return out;
})()
