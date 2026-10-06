(async () => {
  const g = () => window.__bench.getState();
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const cv = document.getElementById('GameCanvas');
  const w = window.innerWidth, h = window.innerHeight;
  // P2: 2s 旋转窗口
  out.p2before = g();
  await wait(2000);
  out.p2after = g();
  // P3: pointermove -> (0.68,0.50),400ms 后 before,600ms 窗口后 after
  const mx = Math.round(0.68 * w), my = Math.round(0.5 * h);
  cv.dispatchEvent(new MouseEvent('mousemove', { clientX: mx, clientY: my, bubbles: true }));
  cv.dispatchEvent(new PointerEvent('pointermove', { clientX: mx, clientY: my, bubbles: true }));
  await wait(400);
  out.p3before = g();
  await wait(600);
  out.p3after = g();
  // P4: wheel deltaY=-600,500ms 后 before,300ms 窗口后 after
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
  await wait(500);
  out.p4before = g();
  await wait(300);
  out.p4after = g();
  // P5: HUD 文本与状态一致性
  out.hudText = document.getElementById('bench-hud').textContent;
  out.p5state = g();
  // P6: 3s 后 fps
  await wait(3000);
  out.p6state = g();
  // P7: 指针归位中心 -> click reset -> 800ms 采样;再连击一次验证一致性
  cv.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.round(0.5 * w), clientY: Math.round(0.5 * h), bubbles: true }));
  await wait(50);
  document.querySelector('button[data-ui="reset"]').click();
  await wait(800);
  out.p7state = g();
  document.querySelector('button[data-ui="reset"]').click();
  await wait(300);
  out.p7again = g();
  return out;
})()
