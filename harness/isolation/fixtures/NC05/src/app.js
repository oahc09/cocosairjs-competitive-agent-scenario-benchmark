// NC05 lifecycle-leak — negative control for G4 HARNESS_TRUST.
// The app is fully functional (continuous parallax/cruise camera like NC03,
// real animation, HUD, reset restores epoch/camera/parallax). The leak:
// reset() spawns a NEW animation loop without clearing the old one, and a
// logging interval created at init is never cleared. After reset TWO loops
// advance rotationPhase (2 x 0.08 = 0.16 rad/s effective), so ~0.8s after
// reset phase ≈ 0.128 > 0.1 — E01 P7's "$.rotationPhase < 0.1" fails — while
// console spam ("[leak] interval survived reset") and leakedTicks keep growing
// as evidence.
// Expected catch: E01 P7 stateAssertion (reset contract violated) + persistent
// console output from the leaked interval — probe FAIL; taxonomy LIFECYCLE_MISUSE.

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const W = canvas.width, H = canvas.height;

function makeGalaxy() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 50000; i++) {
    const arm = i % 2;
    const t = Math.pow(Math.random(), 0.5);
    const r = t * 300;
    const ang = arm * Math.PI + r * 0.012 + (Math.random() - 0.5) * 0.5 * (1 - t * 0.7);
    const x = W / 2 + Math.cos(ang) * r;
    const y = H / 2 + Math.sin(ang) * r * 0.62;
    const w = r / 300;
    g.fillStyle = `rgba(${Math.round(255 * (1 - w) + 150 * w)},${Math.round(230 * (1 - w) + 190 * w)},${Math.round(200 * (1 - w) + 255 * w)},${0.35 + Math.random() * 0.65})`;
    g.fillRect(x, y, 1, 1);
  }
  const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 90);
  grad.addColorStop(0, 'rgba(255,240,210,0.9)');
  grad.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(W / 2, H / 2, 90, 60, 0, 0, Math.PI * 2);
  g.fill();
  return c;
}
const galaxy = makeGalaxy();

const RATE = 0.08; // rad/s within [0.02, 0.1]; after the leak doubles to 0.16
const BASE = () => ({
  starCount: 50000,
  rotationPhase: 0,
  cameraDistance: 120,
  parallaxOffset: { x: 0, y: 0 },
  fps: 0,
  hudVisible: true,
  epoch: 0,
  leakedTicks: 0, // grows forever: proof the leaked interval survives reset
});
const state = BASE();

// continuous camera model (same as NC03)
const parallax = { x: 0, y: 0 };
const parallaxTarget = { x: 0, y: 0 };
const cam = { dist: 120, v: 0 };
const PARALLAX_TAU = 0.2;
const CAM_DAMP_TAU = 2.0;

function updateCameraModel(dt) {
  const k = 1 - Math.exp(-dt / PARALLAX_TAU);
  parallax.x += (parallaxTarget.x - parallax.x) * k;
  parallax.y += (parallaxTarget.y - parallax.y) * k;
  if (Math.abs(parallaxTarget.x - parallax.x) < 0.0005) parallax.x = parallaxTarget.x;
  if (Math.abs(parallaxTarget.y - parallax.y) < 0.0005) parallax.y = parallaxTarget.y;
  cam.dist += cam.v * dt;
  cam.v *= Math.exp(-dt / CAM_DAMP_TAU);
  if (Math.abs(cam.v) < 0.05) cam.v = 0;
  cam.dist = Math.min(400, Math.max(40, cam.dist));
}

let tPrev = performance.now();
let frames = 0, fpsWindowStart = tPrev;
let readySet = false;

function renderHud() {
  hud.textContent = `stars ${state.starCount}  fps ${state.fps.toFixed(0)}  cam ${state.cameraDistance.toFixed(0)}  leak ${state.leakedTicks}`;
}

function frame(now) {
  const dt = Math.min(0.1, (now - tPrev) / 1000);
  tPrev = now;
  updateCameraModel(dt);
  // fixed per-frame advance at ~60fps: RATE/60 per callback. Each live loop
  // instance adds independently — after the leak there are two, so the phase
  // rate doubles (0.08 -> 0.16 rad/s), which P7 detects after reset.
  state.rotationPhase += RATE / 60;
  state.cameraDistance = cam.dist;
  state.parallaxOffset = { x: parallax.x, y: parallax.y };
  const s = 120 / cam.dist;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + parallax.x * 40, H / 2 + parallax.y * 24);
  ctx.rotate(state.rotationPhase);
  ctx.scale(s, s);
  ctx.drawImage(galaxy, -W / 2, -H / 2);
  ctx.restore();
  frames++;
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 500) {
    state.fps = (frames * 1000) / elapsed;
    frames = 0;
    fpsWindowStart = now;
  }
  renderHud();
  if (!readySet) { readySet = true; window.__appReady = true; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// LEAKED from init, never cleared by reset():
setInterval(() => {
  state.leakedTicks += 1;
  console.log(`[leak] interval survived reset: leakedTicks=${state.leakedTicks}`);
}, 250);

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  parallaxTarget.x = +((nx - 0.5) * 2).toFixed(6);
  parallaxTarget.y = +((ny - 0.5) * 2).toFixed(6);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.v += e.deltaY * 0.1;
});

function doReset() {
  const keep = state.epoch + 1;
  Object.assign(state, BASE());
  state.epoch = keep;
  parallax.x = 0; parallax.y = 0;
  parallaxTarget.x = 0; parallaxTarget.y = 0;
  cam.dist = 120; cam.v = 0;
  frames = 0;
  fpsWindowStart = performance.now();
  // BUG (intended): a NEW loop is started; the old one (and the logger above)
  // keeps running. Both loops advance the same state.rotationPhase.
  requestAnimationFrame(frame);
}
document.getElementById('resetBtn').addEventListener('click', doReset);

window.__bench = {
  getState: () => state,
  reset: doReset,
};
window.__appReady = false;
