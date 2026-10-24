(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const B = window.__bench;
  const out = {};
  // ---- P4: drag (0.50,0.50)->(0.78,0.50), then 500ms -> before, 200ms -> after ----
  const c = document.getElementById('app-canvas');
  const fire = (t, nx) => c.dispatchEvent(new PointerEvent(t, {
    clientX: Math.round(nx * 1280), clientY: 360, bubbles: true, cancelable: true,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, buttons: 1, button: 0
  }));
  const az0 = B.getState().cameraAzimuth;
  fire('pointerdown', 0.50);
  for (let i = 1; i <= 6; i++) { fire('pointermove', 0.50 + 0.28 * i / 6); await sleep(40); }
  fire('pointerup', 0.78);
  await sleep(500); const b1 = B.getState();
  await sleep(200); const b2 = B.getState();
  out.p4 = {
    dAzWindow: +(b2.cameraAzimuth - b1.cameraAzimuth).toFixed(2),
    dAzTotal: +(b2.cameraAzimuth - az0).toFixed(2),
    ok: Math.abs(b2.cameraAzimuth - b1.cameraAzimuth) > 20
  };
  // ---- P5: tone toggle, 2.5s later toneMix > 0.7 + avg color shift ----
  const avg = () => {
    const g = document.createElement('canvas'); g.width = 64; g.height = 36;
    const x = g.getContext('2d');
    x.drawImage(document.getElementById('app-canvas'), 0, 0, 64, 36);
    const d = x.getImageData(0, 0, 64, 36).data;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return [r / n, gr / n, b / n];
  };
  const a1 = avg();
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2500);
  const s5 = B.getState(); const a2 = avg();
  out.p5 = {
    toneMix: s5.toneMix,
    warmAvg: a1.map(v => +v.toFixed(1)), coolAvg: a2.map(v => +v.toFixed(1)),
    shiftAvg: +((Math.abs(a2[0] - a1[0]) + Math.abs(a2[1] - a1[1]) + Math.abs(a2[2] - a1[2])) / 3).toFixed(2),
    ok: s5.toneMix > 0.7
  };
  // ---- P6: reset #1 ----
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  const s6 = B.getState();
  out.p6 = {
    epoch: s6.epoch, assetLoaded: s6.assetLoaded, toneMix: s6.toneMix, az: s6.cameraAzimuth,
    ok: s6.epoch >= 1 && s6.assetLoaded === true && s6.toneMix < 0.05 && s6.cameraAzimuth >= 32 && s6.cameraAzimuth <= 38
  };
  // ---- P7: reset #2 ----
  document.querySelector('[data-ui="reset"]').click();
  await sleep(3000);
  const s7 = B.getState();
  out.p7 = {
    epoch: s7.epoch, assetLoaded: s7.assetLoaded, assetRequests: s7.assetRequests, toneMix: s7.toneMix,
    ok: s7.epoch >= 2 && s7.assetLoaded === true && s7.assetRequests >= 2 && s7.toneMix < 0.05
  };
  // ---- 冷调缩略图(重建后已回暖,再切一次冷调并采样画布)----
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2600);
  const g2 = document.createElement('canvas'); g2.width = 320; g2.height = 180;
  g2.getContext('2d').drawImage(document.getElementById('app-canvas'), 0, 0, 320, 180);
  out.thumbCool = g2.toDataURL('image/jpeg', 0.55);
  out.fpsFinal = B.getState().fps;
  return out;
})()
