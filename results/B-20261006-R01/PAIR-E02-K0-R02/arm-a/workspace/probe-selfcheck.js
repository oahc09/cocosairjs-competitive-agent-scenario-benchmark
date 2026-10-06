(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const get = () => window.__bench.getState();
    const out = {};
    await sleep(2200);

    // P1: 就绪与资产
    out.p1 = get();

    // P2: 海面波动(wavePhase 推进)
    const w0 = get(); await sleep(1500); const w1 = get();
    out.p2 = { dw: +(w1.wavePhase - w0.wavePhase).toFixed(4), ok: w1.wavePhase !== w0.wavePhase };

    // P3: 船体随波起伏(y 变化)
    const b0 = get(); await sleep(900); const b1 = get();
    out.p3 = { dy: +(b1.boatPosition.y - b0.boatPosition.y).toFixed(4), ok: b1.boatPosition.y !== b0.boatPosition.y };

    // P4: 水平拖拽 → 方位角变化(合成 MouseEvent 走引擎 input)
    const canvas = document.querySelector('#GameCanvas');
    const rect = canvas.getBoundingClientRect();
    const X = (f) => rect.left + f * rect.width, Y = (f) => rect.top + f * rect.height;
    const fire = (type, x, y, buttons) => {
        canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons }));
    };
    const az0 = get().cameraAzimuth;
    fire('mousedown', X(0.50), Y(0.50), 1);
    for (let i = 1; i <= 12; i++) { fire('mousemove', X(0.50 + (0.28 * i) / 12), Y(0.50), 1); await sleep(16); }
    fire('mouseup', X(0.78), Y(0.50), 0);
    await sleep(600);
    const az1 = get().cameraAzimuth;
    out.p4 = { before: az0, after: az1, dAz: +(az1 - az0).toFixed(2), ok: Math.abs(az1 - az0) > 20 };

    // P5: 色调切换(暖→冷,过渡 <=2.5s)
    document.querySelector('[data-ui="tone-toggle"]').click();
    await sleep(500);
    const tMid = get();
    await sleep(2100);
    const t1 = get();
    out.p5 = { mid: +tMid.toneMix.toFixed(3), final: +t1.toneMix.toFixed(3), ok: t1.toneMix > 0.7 };

    // P5b: 反向切换回暖(控件可再次点击)
    document.querySelector('[data-ui="tone-toggle"]').click();
    await sleep(2200);
    out.p5b = { toneBack: +get().toneMix.toFixed(3) };

    // P6: 第一次 reset(释放并重建)
    document.querySelector('[data-ui="reset"]').click();
    await sleep(3000);
    const r1 = get();
    out.p6 = {
        epoch: r1.epoch, loaded: r1.assetLoaded, tone: +r1.toneMix.toFixed(3), az: +r1.cameraAzimuth.toFixed(2),
        ok: r1.epoch >= 1 && r1.assetLoaded && r1.toneMix < 0.05 && r1.cameraAzimuth >= 32 && r1.cameraAzimuth <= 38,
    };

    // P7: 连续第二次 reset(稳定性;assetRequests 递增)
    document.querySelector('[data-ui="reset"]').click();
    await sleep(3000);
    const r2 = get();
    out.p7 = {
        epoch: r2.epoch, loaded: r2.assetLoaded, requests: r2.assetRequests, tone: +r2.toneMix.toFixed(3),
        ok: r2.epoch >= 2 && r2.assetLoaded && r2.assetRequests >= 2 && r2.toneMix < 0.05,
    };

    out.fpsIdle = +get().fps.toFixed(1);
    out.ready = window.__appReady === true;
    return out;
})()
