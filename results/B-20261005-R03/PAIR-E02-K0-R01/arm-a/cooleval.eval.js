(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[data-ui="tone-toggle"]').click();
  await sleep(2200);
  const st = window.__bench.getState();
  const src = document.getElementById('app-canvas');
  const small = document.createElement('canvas');
  small.width = 320; small.height = 180;
  small.getContext('2d').drawImage(src, 0, 0, 320, 180);
  return { toneMix: st.toneMix, fps: st.fps, png: small.toDataURL('image/png') };
})()
