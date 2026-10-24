(async () => {
  const app = window.__airApp, sc = app.getScene();
  const cv = document.querySelector('#GameCanvas');
  const c2 = document.createElement('canvas');
  c2.width = cv.width || cv.clientWidth; c2.height = cv.height || cv.clientHeight;
  const ctx = c2.getContext('2d', { willReadFrequently: true });
  const readStats = () => new Promise((res) => requestAnimationFrame(() => {
    ctx.drawImage(cv, 0, 0, c2.width, c2.height);
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
    let lit = 0, sum = 0; const N = c2.width * c2.height;
    const at = (x, y) => { const i = (y * c2.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += L; if (L > 18) lit++;
    }
    res({ avg: +(sum / N).toFixed(1), lit: +(lit / N).toFixed(3), tl: at(30, 30), mid: at(640, 500), bl: at(30, 690) });
  }));
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 160))));
  const setNames = (prefix, active) => {
    let n = 0; sc.children.forEach((c) => { if (c.name.startsWith(prefix)) { c.active = active; n++; } }); return n;
  };
  const setTiltExtras = (active) => {
    let n = 0;
    sc.children.forEach((p) => {
      if (!p.name.startsWith('planet-')) return;
      const tilt = p.children.find((c) => c.name.startsWith('tilt-'));
      if (!tilt) return;
      tilt.children.forEach((c) => { if (c.name.startsWith('band-') || c.name.startsWith('ring-')) { c.active = active; n++; } });
    });
    return n;
  };

  await new Promise((r) => setTimeout(r, 3500)); // 填满 2s fps 窗口
  const steps = [];
  const step = async (label) => { await settle(); steps.push(Object.assign({ label }, await readStats())); };

  const s0 = window.__bench.getState();
  await step('baseline');
  setNames('orbit-', false); await step('orbit-off');
  setNames('starfield', false); await step('starfield-off');
  setNames('belt-ring-', false); await step('belt-off');
  setNames('sun-glow-', false); await step('glow-off');
  setTiltExtras(false); await step('bands-rings-off');
  setNames('planet-', false); await step('planets-off');
  setNames('sun', false); await step('sun-off'); // 应只剩 clearColor
  // 恢复
  setNames('orbit-', true); setNames('starfield', true); setNames('belt-ring-', true);
  setNames('sun-glow-', true); setTiltExtras(true); setNames('planet-', true); setNames('sun', true);
  await step('restored');
  const s1 = window.__bench.getState();
  return { fps: [+s0.fps.toFixed(1), +s1.fps.toFixed(1)], simTime: [+s0.simulationTime.toFixed(1), +s1.simulationTime.toFixed(1)], steps };
})()
