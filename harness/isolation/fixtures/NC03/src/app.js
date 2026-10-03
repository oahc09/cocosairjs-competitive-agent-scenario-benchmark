// NC03 fake-asset-loaded — negative control for G4 HARNESS_TRUST.
// (E02 semantics adapted onto an E01-shaped app, per M3 isolation spec.)
// The app is otherwise FULLY functional for E01: animated rotating galaxy,
// pointer parallax and wheel cruise implemented as CONTINUOUS camera state
// (required by E01's frozen double-sample convention: probes sample before AND
// after a post-action window, so camera state must still be evolving inside
// that window — instant-jump implementations would fail P3/P4 for the wrong
// reason). HUD shows measured fps; reset restores everything.
// The fake: state claims assetLoaded === true while NO network request for any
// .glb is ever made (assetRequests stays 0) and no ship exists in the scene.
//
// Expected catch:
//  - vs E01 spec: NOT caught — E01 P1 has only starCount + nonBlank, no
//    asset/network independent observation. Honest spec-coverage gap, recorded
//    in G4.json (spec stays untouched).
//  - vs E02 spec: caught by P1 stateAssertion "$.assetLoaded == true &&
//    $.assetRequests >= 1" (assetRequests is 0) plus missing
//    networkRequest:assets/boat.glb evidence — probe FAIL.

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const W = canvas.width, H = canvas.height;

// --- pre-rendered galaxy sprite (50000 points, 2 log-spiral arms + bulge) ---
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

// --- state ---
const BASE = () => ({
  starCount: 50000,
  rotationPhase: 0,
  cameraDistance: 120,
  parallaxOffset: { x: 0, y: 0 },
  fps: 0,
  hudVisible: true,
  epoch: 0,
  // E02-semantics fake fields:
  assetLoaded: true, // LIE: claimed loaded...
  assetRequests: 0,  // ...but no request for assets/boat.glb was ever made
});
const state = BASE();

// --- continuous camera model: smoothed parallax + inertial cruise ----------
// E01's frozen probe convention double-samples AFTER the action window, so the
// parallax/camera state must still be changing inside that window.
const parallax = { x: 0, y: 0 };
const parallaxTarget = { x: 0, y: 0 };
const cam = { dist: 120, v: 0 };
const PARALLAX_TAU = 0.2;  // s — converges fast enough for P7 (±0.01 @800ms), slow enough to still move during P3's 400–1000ms window
const CAM_DAMP_TAU = 2.0;  // s — wheel gives inertial cruise (P4 sees >5 units decrease within its post-action window)

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

// --- render loop (real motion, measured fps) ---
const RATE = 0.05; // rad/s within frozen [0.02, 0.1]
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

// --- interaction (real, continuous) ---
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  parallaxTarget.x = +((nx - 0.5) * 2).toFixed(6);
  parallaxTarget.y = +((ny - 0.5) * 2).toFixed(6);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.v += e.deltaY * 0.1; // scroll up (negative deltaY) -> approach (dist decreases), inertial
});
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
  getState: () => state,
  reset: doReset,
};
window.__appReady = false;
requestAnimationFrame(() => { window.__appReady = true; }); // ready after first frame
