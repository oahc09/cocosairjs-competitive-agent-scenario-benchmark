// NC01 empty-renderer — negative control for G4 HARNESS_TRUST.
// Fake: __bench returns a fully "correct" E01 state (starCount 50000, rotating
// rotationPhase, wheel-driven cameraDistance, pointer parallax, fps, HUD, reset).
// The canvas stays completely BLACK — nothing is ever rendered.
// Expected catch: E01 P1 visualAssertion nonBlank (lit ratio < 2%) — probe FAIL.

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

// All-black canvas, painted once, never touched again.
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, canvas.width, canvas.height);

const BASE = () => ({
  starCount: 50000,
  rotationPhase: 0,
  cameraDistance: 120,
  parallaxOffset: { x: 0, y: 0 },
  fps: 60,
  hudVisible: true,
  epoch: 0,
});

const state = BASE();
const t0 = performance.now();
const lastReset = { t: t0, phase: 0 };

function renderHud() {
  hud.textContent =
    `stars ${state.starCount}  fps ${state.fps.toFixed(0)}  cam ${state.cameraDistance.toFixed(0)}`;
}

// State-only "animation": phase advances by wall clock, nothing is drawn.
function tick() {
  const rate = 0.05; // rad/s, inside the frozen [0.02, 0.1] window
  state.rotationPhase = lastReset.phase + ((performance.now() - lastReset.t) / 1000) * rate;
  renderHud();
}
setInterval(tick, 100);

// State-only interaction: handlers mutate state, never the canvas.
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  state.parallaxOffset = { x: +(nx - 0.5) * 2, y: +(ny - 0.5) * 2 };
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.cameraDistance = Math.min(400, Math.max(40, state.cameraDistance + e.deltaY * 0.02));
});
document.getElementById('resetBtn').addEventListener('click', () => {
  const keep = state.epoch + 1;
  Object.assign(state, BASE());
  state.epoch = keep;
  lastReset.t = performance.now();
  lastReset.phase = 0;
});

window.__bench = {
  getState: () => state,
  reset: () => document.getElementById('resetBtn').click(),
};
window.__appReady = false;
setTimeout(() => {
  tick();
  window.__appReady = true;
}, 100);
