// NC02 frozen-animation — negative control for G4 HARNESS_TRUST.
// Fake: a real static starfield is drawn EXACTLY ONCE (P1 nonBlank passes,
// P3/P4 redraw-on-input pass), but there is NO animation loop. The state lies:
// rotationPhase keeps increasing and fps reports 60 while the image is frozen.
// Expected catch: E01 P2 visualAssertion motion (center 80% has zero motion
// pixels across the 2s sample window) — probe FAIL. Bonus evidence: harness
// independent perfSample (rAF counter) will read ~0 fps against state's 60.

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const W = canvas.width, H = canvas.height;

const state = {
  starCount: 50000,
  rotationPhase: 0,
  cameraDistance: 120,
  parallaxOffset: { x: 0, y: 0 },
  fps: 60, // lie: no frames are ever produced after the single static draw
  hudVisible: true,
  epoch: 0,
};

// One-shot 50k point galaxy, drawn once into the live canvas.
function drawStatic() {
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < state.starCount; i++) {
    const arm = i % 2;
    const t = Math.pow(Math.random(), 0.5);
    const r = t * 300;
    const ang = arm * Math.PI + r * 0.012 + (Math.random() - 0.5) * 0.5 * (1 - t * 0.7);
    const x = W / 2 + Math.cos(ang) * r + state.parallaxOffset.x * 40;
    const y = H / 2 + Math.sin(ang) * r * 0.62 + state.parallaxOffset.y * 24;
    const w = r / 300;
    ctx.fillStyle = `rgba(${Math.round(255 * (1 - w) + 150 * w)},${Math.round(230 * (1 - w) + 190 * w)},${Math.round(200 * (1 - w) + 255 * w)},${0.35 + Math.random() * 0.65})`;
    const s = 120 / state.cameraDistance;
    ctx.fillRect(W / 2 + (x - W / 2) * s, H / 2 + (y - H / 2) * s, 1, 1);
  }
  const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 90);
  grad.addColorStop(0, 'rgba(255,240,210,0.9)');
  grad.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(W / 2 + state.parallaxOffset.x * 40, H / 2 + state.parallaxOffset.y * 24, 90 * (120 / state.cameraDistance), 60 * (120 / state.cameraDistance), 0, 0, Math.PI * 2);
  ctx.fill();
}

function renderHud() {
  hud.textContent = `stars ${state.starCount}  fps ${state.fps.toFixed(0)}  cam ${state.cameraDistance.toFixed(0)}`;
}

// The lie: state claims ongoing rotation at 0.05 rad/s.
setInterval(() => {
  state.rotationPhase += 0.05 * 0.1;
  renderHud();
}, 100);

// Input DOES update state AND redraws once synchronously (so P3/P4 pixelDelta pass;
// the only broken contract is continuous motion).
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  state.parallaxOffset = { x: +(nx - 0.5) * 2, y: +(ny - 0.5) * 2 };
  drawStatic();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.cameraDistance = Math.min(400, Math.max(40, state.cameraDistance + e.deltaY * 0.02));
  drawStatic();
});
document.getElementById('resetBtn').addEventListener('click', () => {
  state.epoch += 1;
  state.rotationPhase = 0;
  state.cameraDistance = 120;
  state.parallaxOffset = { x: 0, y: 0 };
  drawStatic();
});

window.__bench = {
  getState: () => state,
  reset: () => document.getElementById('resetBtn').click(),
};

drawStatic();
renderHud();
window.__appReady = true; // the single frame exists, so ready is legit
