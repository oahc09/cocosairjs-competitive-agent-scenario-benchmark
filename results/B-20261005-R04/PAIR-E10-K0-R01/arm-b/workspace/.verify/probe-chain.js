(async function () {
    const S = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => window.__bench.getState();
    const click = (n) => {
        const b = document.querySelector('[data-ui="' + n + '"]');
        if (!b) throw new Error('no button ' + n);
        b.click();
    };
    const out = {};
    // P1: wait 1500 — assetLoaded + 双实例 idle
    await S(1500);
    out.P1 = st();
    // P2: wait 1000 — time 推进(双采样)
    const m1 = st();
    await S(1000);
    const m2 = st();
    out.P2 = { tA1: m1.instances.A.time, tA2: m2.instances.A.time, tB1: m1.instances.B.time, tB2: m2.instances.B.time, state: m2 };
    // P3: click anim-a-walk — 仅 A 切 Walk,B 保持 idle
    click('anim-a-walk');
    await S(1000);
    out.P3 = st();
    // P4: click destroy-a — instanceCount=1, A=null
    click('destroy-a');
    await S(800);
    out.P4 = st();
    // P5: wait 1500+200 — B 动画继续(time 推进)
    const p5a = st();
    await S(1500);
    const p5b = st();
    out.P5 = { state: p5b, bTimeDelta: +(p5b.instances.B.time - p5a.instances.B.time).toFixed(4) };
    // P6: click reset — resetCount=1,双实例恢复 idle
    click('reset');
    await S(1500);
    out.P6 = st();
    // P7: wait 1000 — 双实例 time 推进 + fps>=30
    const p7a = st();
    await S(1000);
    const p7b = st();
    out.P7 = { tA: p7b.instances.A.time, tB: p7b.instances.B.time, fps: p7b.fps, tAdelta: +(p7b.instances.A.time - p7a.instances.A.time).toFixed(4), tBdelta: +(p7b.instances.B.time - p7a.instances.B.time).toFixed(4) };
    return JSON.stringify(out);
})()
