// NC09 spec-drift — negative control for G4 HARNESS_TRUST.
// The app itself is a *working* minimal scene (real pixels, real state): the
// defect under test is NOT in the app — it is the pair.json meta claiming a
// specSha256 that does not match this workspace's spec.json. Expected catch:
// validate.mjs --pair-meta input-drift gate (INPUT_DRIFT) BEFORE any build /
// serve / browser work (seconds, browserless).
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

const state = { starCount: 50000, rotationPhase: 0, epoch: 0 };
const t0 = performance.now();

function render() {
  const w = canvas.width, h = canvas.height;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#024');
  g.addColorStop(1, '#113');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // deterministic pseudo star field, phase-scrolled so motion probes would pass
  state.rotationPhase = ((performance.now() - t0) / 1000) * 0.05;
  for (let i = 0; i < 400; i++) {
    const a = (i * 2.3999632) + state.rotationPhase;
    const r = 30 + (i % 17) * 38;
    const x = w / 2 + Math.cos(a) * r * 2.2;
    const y = h / 2 + Math.sin(a) * r;
    const s = (i % 3) + 1;
    ctx.fillStyle = i % 5 === 0 ? '#ffd9a0' : '#cfe4ff';
    ctx.fillRect(x, y, s, s);
  }
  hud.textContent = `stars ${state.starCount}  phase ${state.rotationPhase.toFixed(3)}`;
}
setInterval(render, 100);

window.__bench = { getState: () => state, reset: () => { state.epoch += 1; } };
window.__appReady = false;
setTimeout(() => { render(); window.__appReady = true; }, 100);
