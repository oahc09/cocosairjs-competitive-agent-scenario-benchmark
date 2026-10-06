(async () => {
  const B = window.__bench;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.getElementById('app-canvas');
  const clickAt = (x, y) => cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
  const clickUi = (sel) => document.querySelector('[data-ui="' + sel + '"]').click();
  const out = { error: null };
  try {
    // P1: 初始状态 + 2s 采样窗(公转分层 + 非空画面 + 运动)
    out.s1a = B.getState();
    out.pr1a = B._probe();
    await sleep(2000);
    out.s1b = B.getState();
    out.pr1b = B._probe();
    // P2: 点击第 3 颗行星(earth)投影位置
    const t2 = B.getState().pickTargets[2];
    out.t2 = t2;
    clickAt(t2.screenX, t2.screenY);
    await sleep(700);
    out.s2 = B.getState();
    out.pr2 = B._probe();
    out.cardText = document.querySelector('[data-ui="info-card"]').textContent;
    // P3: 信息卡持续可见(wait 800)
    await sleep(800);
    out.s3 = B.getState();
    // P4: 切 8x
    clickUi('speed-8x');
    await sleep(500);
    out.s4 = B.getState();
    out.btn8xActiveBg = getComputedStyle(document.querySelector('[data-ui="speed-8x"]')).backgroundColor;
    // P5: 8x 下 1.5s 采样窗
    out.s5a = B.getState();
    out.pr5a = B._probe();
    await sleep(1500);
    out.s5b = B.getState();
    out.pr5b = B._probe();
    // P6: Reset
    clickUi('reset');
    await sleep(600);
    out.s6 = B.getState();
    // P7: reset 后 0.3s 采样(角度归位 + 运动持续)
    await sleep(300);
    out.s7 = B.getState();
    out.pr7a = B._probe();
    await sleep(400);
    out.pr7b = B._probe();
    // P8: 切 0.5x
    clickUi('speed-0.5x');
    await sleep(400);
    out.s8 = B.getState();
    // P9: 点击空白角落 (0.08, 0.08)
    clickAt(0.08 * window.innerWidth, 0.08 * window.innerHeight);
    await sleep(400);
    out.s9 = B.getState();
    out.cardDisplay = getComputedStyle(document.querySelector('[data-ui="info-card"]')).display;
    out.buttons = ['speed-0.5x', 'speed-1x', 'speed-2x', 'speed-4x', 'speed-8x'].map(
      (k) => !!document.querySelector('[data-ui="' + k + '"]')
    );
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
})()
