// NC04 broken-interaction — negative control for G4 HARNESS_TRUST.
// The app animates a rotating galaxy for real (P1/P2 pass) with the same
// continuous camera model as NC03 (smoothed parallax + inertial cruise), and
// exposes a directly WRITABLE __bench.state (the "cheatable state" trap).
// The break: all input handlers are no-ops — pointermove never sets a parallax
// target, wheel never sets a cruise velocity, canvas clicks do nothing.
// E01 P3 (parallax) / P4 (cruise) stateAssertions fail on double sampling.
// Expected catch: E01 P3 stateAssertion "$.after.parallaxOffset.x !=
// $.before.parallaxOffset.x || ..." (and P4 cameraDistance) — probe FAIL.
// Note: P3/P4 pixelDelta may still pass because the galaxy keeps rotating
// between screenshots; the STATE assertions are the independent observation
// that catches this fixture.

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

const BASE = () => ({
  starCount: 50000,
  rotationPhase: 0,
  cameraDistance: 120,
  parallaxOffset: { x: 0, y: 0 },
  fps: 0,
  hudVisible: true,
  epoch: 0,
  interactionCount: 0,
});
const state = BASE();

// continuous camera model (same as NC03) — but nothing ever drives it
const parallax = { x: 0, y: 0 };
const parallaxTarget = { x: 0, y: 0 };
const cam = { dist: 120, v: 0 };
const PARALLAX_TAU = 0.2;
const CAM_DAMP_TAU = 2.0;

function updateCameraModel(dt) {
  const k = 1 - Math.exp(-dt / PARALLAX_TAU);
  parallax.x += (parallaxTarget.x - parallax.x) * k;
  parallax.y += (parallaxTarget.y - parallax.y) * k;
  cam.dist += cam.v * dt;
  cam.v *= Math.exp(-dt / CAM_DAMP_TAU);
  cam.dist = Math.min(400, Math.max(40, cam.dist));
}

const RATE = 0.05;
let tEpoch = performance.now();
let tPrev = tEpoch;
let frames = 0, fpsWindowStart = tEpoch;

function renderHud() {
  hud.textContent = `stars ${state.starCount}  fps ${state.fps.toFixed(0)}  cam ${state.cameraDistance.toFixed(0)}`;
}

function frame(now) {
  const dt = Math.min(0.1, (now - tPrev) / 1000);
  tPrev = now;
  updateCameraModel(dt);
  state.rotationPhase = ((now - tEpoch) / 1000) * RATE;
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- BROKEN interaction: registered but no-op (targets/velocity never set) ---
canvas.addEventListener('pointermove', () => { /* no-op: parallax never changes */ });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); /* no-op: camera never moves */ });
canvas.addEventListener('click', () => { /* no-op: no state or visual change */ });

function doReset() {
  const keep = state.epoch + 1;
  Object.assign(state, BASE());
  state.epoch = keep;
  parallax.x = 0; parallax.y = 0;
  parallaxTarget.x = 0; parallaxTarget.y = 0;
  cam.dist = 120; cam.v = 0;
  tEpoch = performance.now();
  frames = 0;
  fpsWindowStart = performance.now();
}
document.getElementById('resetBtn').addEventListener('click', doReset);

window.__bench = {
  // The trap: state is exposed as a writable live reference. A harness that
  // only reads/writes state without independent observation cannot tell the
  // difference — E01 P3/P4 double sampling does.
  state,
  getState: () => state,
  reset: doReset,
};
window.__appReady = false;
requestAnimationFrame(() => { window.__appReady = true; });
