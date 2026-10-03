// tiny-fake-app — harness self-test fixture.
// Implements the unified page contract (MASTER-CONTEXT §10):
//   window.__appReady = false -> true after the first rendered frame
//   window.__bench = { getState(): object, reset(): void }
// Renders an animated scene on a 1280x720 canvas: moving squares + starfield.
(function () {
  'use strict';

  var canvas = document.getElementById('stage');
  var hud = document.getElementById('hud');
  var ctx = canvas.getContext('2d');

  var W = canvas.width;   // 1280
  var H = canvas.height;  // 720

  var state = {
    engine: 'tiny-fake',
    ready: false,
    frame: 0,
    resetCount: 0,
    pingCount: 0,
    keyCount: 0
  };

  // deterministic starfield (seeded LCG)
  var stars = [];
  (function () {
    var seed = 1234567;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 160; i++) {
      stars.push({ x: rnd() * W, y: rnd() * H, r: rnd() * 1.6 + 0.4, b: rnd() * 0.7 + 0.3 });
    }
  })();

  window.__appReady = false;
  window.__bench = {
    getState: function () {
      return {
        engine: state.engine,
        ready: state.ready,
        frame: state.frame,
        resetCount: state.resetCount,
        pingCount: state.pingCount,
        keyCount: state.keyCount
      };
    },
    reset: function () {
      state.frame = 0;
      state.resetCount += 1;
      t = 0; // rewind animation phase (NOT a page reload)
    }
  };

  var t = 0;

  function draw() {
    // background
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0b1020');
    grad.addColorStop(1, '#101a33');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // stars
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var tw = 0.6 + 0.4 * Math.sin(t * 2 + i);
      ctx.fillStyle = 'rgba(210,230,255,' + (s.b * tw).toFixed(3) + ')';
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }

    // big moving orange square (orbiting the screen center)
    var cx = W / 2 + Math.cos(t * 0.9) * 260;
    var cy = H / 2 + Math.sin(t * 1.3) * 140;
    ctx.fillStyle = '#ff9a3c';
    ctx.fillRect(cx - 150, cy - 150, 300, 300);
    ctx.strokeStyle = '#ffd9a8';
    ctx.lineWidth = 4;
    ctx.strokeRect(cx - 150, cy - 150, 300, 300);

    // small counter-rotating cyan square
    var dx = W / 2 + Math.cos(-t * 1.7 + 1) * 340;
    var dy = H / 2 + Math.sin(-t * 1.1 + 2) * 220;
    ctx.fillStyle = '#3cd6ff';
    ctx.fillRect(dx - 60, dy - 60, 120, 120);

    // ground strip so the bottom edge differs from the top
    ctx.fillStyle = 'rgba(40,70,120,0.55)';
    ctx.fillRect(0, H - 90, W, 90);
  }

  var fpsWindow = [];
  var lastHud = 0;

  function loop() {
    t += 1 / 60;
    state.frame += 1;
    draw();

    if (!window.__appReady) {
      state.ready = true;
      window.__appReady = true; // after first rendered frame
    }

    // HUD text twice a second (DOM evidence, mirrors __bench)
    var now = performance.now();
    fpsWindow.push(now);
    while (fpsWindow.length && now - fpsWindow[0] > 2000) fpsWindow.shift();
    if (now - lastHud > 500) {
      lastHud = now;
      var fps = fpsWindow.length > 10 ? ((fpsWindow.length - 1) * 1000) / (now - fpsWindow[0]) : 0;
      hud.textContent = 'frame ' + state.frame + ' | fps ' + fps.toFixed(0) + ' | resets ' + state.resetCount;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // controls
  document.getElementById('btn-reset').addEventListener('click', function () { window.__bench.reset(); });
  document.getElementById('btn-ping').addEventListener('click', function () { state.pingCount += 1; });
  window.addEventListener('keydown', function (e) { if (e.key === 'b') state.keyCount += 1; });
})();
