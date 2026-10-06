/**
 * E04 — 城市烟花夜(City Fireworks Night)— cocosair 实现
 *
 * 技术路线(只用模板已验证 + 引擎坑位记录已核实的 API 面):
 *   - 全部视觉经 WebGL 管线绘制:固定透视相机 + 共享 1×1 box 网格 + Node/MeshRenderer
 *     组成 quad;颜色用克隆 unlit 材质的 mainColor(每材质一色,粒子节点共享同色材质)。
 *   - 粒子(尾迹/爆炸/余烬)为节点粒子:物理在归一化屏幕坐标(y 向上、按屏高归一)中
 *     以真实 dt 步进(clamp 0.05s 防失焦跳变),渲染时做深度补偿映射到世界坐标。
 *   - 全局时间线 enabled=false 时 update 直接返回:sceneTime 不累计、任何节点不更新,
 *     连续两帧渲染内容逐像素一致(窗灯/障碍灯/星闪全部静止)。
 *   - 点击经引擎 input.on(pal 会吞 canvas 原生事件);坐标换算优先 getLocationInView
 *     (左上原点),退化 getLocation(左下原点,翻转)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): {fireworkCount, particlesAlive, autoShow, enabled,
 *     buildingCount}, reset(): void } — 全部为真实数据。
 */

import * as CC from 'cocosair.js';

const {
    createAirApp, Scene, Node, Camera, MeshRenderer, builtinResMgr,
    utils, primitives, Vec3, Color, Component, director, Director, Layers,
} = CC;

// ============ 状态通道(getState 的唯一事实来源,均为真实数据) ============
let fireworkCount = 0;   // 自上次 reset 起累计发射发数(含自动)
let autoShow = false;    // 自动表演开关
let enabled = true;      // 全局时间线开关(true=运行,false=暂停冻结)
let buildingCount = 0;   // 当前城市楼数
let ready = false;
let sceneTime = 0;       // 受暂停控制的时间线(暂停时不累计)
const particles = [];    // 存活粒子:尾迹/爆炸/余烬
const rockets = [];      // 存活火箭(升空段)

window.__appReady = false;
window.__bench = {
    getState: () => ({
        fireworkCount,
        particlesAlive: particles.length + rockets.length,
        autoShow,
        enabled,
        buildingCount,
    }),
    reset: () => doReset(),
};
window.__lastClick = null; // 诊断辅助:最近一次点击的归一化坐标

// ============ 小工具 ============
const rnd = (a, b) => a + Math.random() * (b - a);
const rndi = (n) => Math.floor(Math.random() * n);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// ============ 相机映射:归一化视口(nx 左→右, nyTop 上→下)↔ 世界坐标 ============
// 相机放 z=CAMZ 看 -Z 方向;粒子物理用归一化屏幕坐标,渲染时按节点深度做透视补偿,
// 保证"点击 y=0.30 → 爆点就在画面 30% 高度"的映射与深度无关。
const CAMZ = 10;
const FOV = 45;
let HALF_H = Math.tan((FOV * Math.PI) / 360) * CAMZ; // z=0 处视口半高
let HALF_W = HALF_H;                                  // 乘 aspect 后修正
const depthK = (z) => (CAMZ - z) / CAMZ;

// 数值型 setPosition/setScale 能力探测(避免每帧 new Vec3 的 GC 压力)
let NUMERIC_OK = false;
function probeNumericOverload() {
    try {
        const t = new Node('probe');
        t.setPosition(1, 2, 3);
        NUMERIC_OK = Math.abs(t.position.x - 1) < 1e-6 && Math.abs(t.position.y - 2) < 1e-6;
        t.destroy();
    } catch (e) {
        NUMERIC_OK = false;
    }
}
function setPos(n, x, y, z) {
    if (NUMERIC_OK) n.setPosition(x, y, z);
    else n.setPosition(new Vec3(x, y, z));
}
function setScl(n, sx, sy) {
    // z 向收为近零:共享网格是 1×1×1 box,z 厚 1 会让小 quad 在透视下被拉成
    // 以灭点为中心的放射状条纹(实测坑位),这里统一压成薄片
    if (NUMERIC_OK) n.setScale(sx, sy, 0.02);
    else n.setScale(new Vec3(sx, sy, 0.02));
}

// ============ 材质:一个克隆 unlit 材质 = 一种颜色 ============
let BASE_MAT = null;
function pickBuiltin(names) {
    for (const nm of names) {
        try {
            const m = builtinResMgr.get(nm);
            if (m) return m;
        } catch (e) { /* 继续尝试下一个名字 */ }
    }
    return null;
}

function makeMat(r, g, b) {
    const base = BASE_MAT;
    if (!base) return null;
    try {
        const m = base.clone();
        try { m.setProperty('mainColor', new Color(r, g, b, 255)); } catch (e) { /* 保底保持基色 */ }
        return m;
    } catch (eClone) {
        // 坑位记录的正规自定义材质路径:new Material() + initialize({effectAsset})
        try {
            const M = CC.Material;
            if (!M || !base.effectAsset) return base;
            const m = new M();
            m.initialize({ effectAsset: base.effectAsset });
            try { m.setProperty('mainColor', new Color(r, g, b, 255)); } catch (e) { /* 同上 */ }
            return m;
        } catch (eInit) {
            return base;
        }
    }
}

const MATS = {};
function buildMaterials() {
    BASE_MAT = pickBuiltin(['builtin-unlit-material', 'builtin-unlit', 'unlit-material'])
        || pickBuiltin(['builtin-standard-material']);

    // 夜空渐变:顶部近黑 → 地平线附近蓝紫微亮 → 底部回落(楼群剪影与地平线带拉开亮度差)
    const skyStops = [
        [0.0, [5, 7, 16]], [0.3, [12, 14, 30]], [0.5, [26, 24, 52]],
        [0.58, [40, 34, 72]], [0.68, [30, 27, 58]], [0.85, [18, 18, 38]], [1.0, [11, 12, 26]],
    ];
    const lerpStops = (t) => {
        for (let i = 0; i < skyStops.length - 1; i++) {
            const [t0, c0] = skyStops[i];
            const [t1, c1] = skyStops[i + 1];
            if (t <= t1) {
                const u = (t - t0) / Math.max(1e-6, t1 - t0);
                return [
                    Math.round(c0[0] + (c1[0] - c0[0]) * u),
                    Math.round(c0[1] + (c1[1] - c0[1]) * u),
                    Math.round(c0[2] + (c1[2] - c0[2]) * u),
                ];
            }
        }
        return skyStops[skyStops.length - 1][1];
    };
    MATS.sky = [];
    for (let i = 0; i < SKY_N; i++) {
        const c = lerpStops((i + 0.5) / SKY_N);
        MATS.sky.push(makeMat(c[0], c[1], c[2]));
    }

    MATS.stars = [
        makeMat(205, 212, 235), makeMat(255, 255, 240),
        makeMat(180, 192, 232), makeMat(255, 228, 195),
    ];
    MATS.buildings = [
        makeMat(6, 7, 11), makeMat(8, 9, 14), makeMat(5, 6, 9),
        makeMat(9, 10, 16), makeMat(7, 8, 12),
    ];
    MATS.windows = [
        makeMat(255, 196, 110), makeMat(255, 224, 160),
        makeMat(255, 176, 88), makeMat(238, 230, 195),
    ];
    MATS.obstacle = makeMat(255, 46, 46);
    MATS.trail = makeMat(255, 232, 185);
    MATS.trailHead = makeMat(255, 246, 220);
    MATS.trailHalo = makeMat(190, 150, 95);
    MATS.flash = makeMat(255, 242, 205);
    // 烟花 12 主色系(金/洋红/青/绿/紫/橙/红/蓝/粉/黄绿/琥珀/青绿)
    MATS.boom = [
        [255, 210, 80], [255, 84, 200], [84, 232, 255], [124, 255, 110],
        [190, 110, 255], [255, 150, 62], [255, 92, 84], [112, 162, 255],
        [255, 132, 180], [200, 255, 92], [255, 192, 62], [92, 255, 200],
    ].map((c) => makeMat(c[0], c[1], c[2]));
    // 余烬:暖橙系
    MATS.ember = [
        makeMat(255, 150, 62), makeMat(255, 122, 44), makeMat(255, 172, 84),
    ];
}

// ============ 共享网格与节点工厂 ============
let quadMesh = null;
const LAYER = Layers.Enum.DEFAULT;

function mkQuad(name, parent, mat) {
    const n = new Node(name);
    n.layer = LAYER;
    const mr = n.addComponent(MeshRenderer);
    mr.mesh = quadMesh;
    if (mat) mr.material = mat;
    parent.addChild(n);
    return n;
}

// ============ 静态背景:夜空渐变条带 ============
const SKY_N = 26;
let skyNodes = [];
function buildSky() {
    const z = -4.5;
    const k = depthK(z);
    const segH = 1 / SKY_N;
    for (let i = 0; i < SKY_N; i++) {
        const nyTop = (i + 0.5) * segH;
        const n = mkQuad('sky' + i, skyRoot, MATS.sky[i]);
        const y = (0.5 - nyTop) * 2 * HALF_H * k;
        setPos(n, 0, y, z);
        setScl(n, 2 * HALF_W * k * 1.02, segH * 2 * HALF_H * k * 1.04);
        skyNodes.push(n);
    }
}

// ============ 背景星(>=120,静态 + 轻微闪烁) ============
const STAR_N = 124;
let starNodes = [];
let twinkles = []; // {node, base, freq, phase, amp}
function buildStars() {
    for (const n of starNodes) { if (n.isValid) n.destroy(); }
    starNodes = [];
    twinkles = [];
    const z0 = -3.7, z1 = -3.2;
    for (let i = 0; i < STAR_N; i++) {
        const z = rnd(z0, z1);
        const n = mkQuad('star' + i, starRoot, MATS.stars[rndi(MATS.stars.length)]);
        const k = depthK(z);
        setPos(n, (Math.random() - 0.5) * 2 * HALF_W * k, (0.5 - rnd(0.02, 0.52)) * 2 * HALF_H * k, z);
        const base = rnd(0.003, 0.007);
        setScl(n, base * 2 * HALF_H * k, base * 2 * HALF_H * k);
        starNodes.push(n);
        if (i % 3 === 0) {
            twinkles.push({ node: n, base: base * 2 * HALF_H * k, freq: rnd(0.25, 0.8), phase: rnd(0, TAU), amp: rnd(0.1, 0.22), z });
        }
    }
}

// ============ 程序化城市楼群剪影 + 亮窗 + 障碍灯 ============
const BUILDING_N = 26;
const WIN_MIN = 96;      // 目标亮窗下限(spec >=80,留裕量)
let buildingNodes = [];
let windowNodes = [];
let obstacleLights = []; // {node, base, phase, freq, z}
function buildCity() {
    for (const n of buildingNodes) { if (n.isValid) n.destroy(); }
    for (const n of windowNodes) { if (n.isValid) n.destroy(); }
    for (const o of obstacleLights) { if (o.node.isValid) o.node.destroy(); }
    buildingNodes = [];
    windowNodes = [];
    obstacleLights = [];

    const heights = [];
    for (let i = 0; i < BUILDING_N; i++) {
        heights.push(clamp(0.1 + Math.pow(Math.random(), 2) * 0.33, 0.08, 0.45));
    }
    // 保证有视觉锚点:最高一栋贴近 0.45,另有若干矮楼
    heights[rndi(BUILDING_N)] = 0.44 + Math.random() * 0.01;
    const bldX = []; // 记录每栋楼的 nx 供障碍灯定位

    for (let i = 0; i < BUILDING_N; i++) {
        const slotW = 1 / BUILDING_N;
        const nx = (i + 0.5) * slotW + rnd(-0.22, 0.22) * slotW;
        bldX[i] = nx;
        const w = rnd(0.016, 0.055); // 楼宽 1.5%-6%(画面宽占比)
        const h = heights[i];        // 楼高 8%-45%(画面高占比)
        const z = rnd(-0.55, -0.42);
        const k = depthK(z);
        const worldW = w * 2 * HALF_W * k;
        const worldH = h * 2 * HALF_H * k;
        const n = mkQuad('bld' + i, cityRoot, MATS.buildings[rndi(MATS.buildings.length)]);
        setPos(n, (nx - 0.5) * 2 * HALF_W * k, -HALF_H * k + worldH / 2 - 0.03 * k, z);
        setScl(n, worldW, worldH);
        buildingNodes.push(n);

        // 亮窗:正面网格随机点亮
        const cols = Math.max(2, Math.round(w * 80));
        const rows = Math.max(2, Math.round(h * 15));
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                if (Math.random() > 0.45) continue;
                const zw = z + 0.06;
                const kw = depthK(zw);
                const cellW = (worldW * 0.78) / cols;
                const cellH = (worldH * 0.82) / rows;
                const ws = Math.min(cellW, cellH) * 0.62;
                if (ws <= 0.004) continue;
                const wn = mkQuad('win', cityRoot, MATS.windows[rndi(MATS.windows.length)]);
                const wx = (nx - 0.5) * 2 * HALF_W * k - worldW * 0.39 + cellW * (c + 0.5);
                const wyBottom = -HALF_H * k + worldH * 0.09 + cellH * (r + 0.5);
                setPos(wn, wx, wyBottom, zw);
                setScl(wn, ws, ws);
                windowNodes.push(wn);
            }
        }
    }

    // 亮窗总数下限兜底(spec: >=80)
    let guard = 0;
    while (windowNodes.length < WIN_MIN && guard++ < 400) {
        const z = rnd(-0.49, -0.36);
        const k = depthK(z);
        const nx = rnd(0.01, 0.99);
        const ws = rnd(0.006, 0.01); // 屏高占比
        const wn = mkQuad('win', cityRoot, MATS.windows[rndi(MATS.windows.length)]);
        setPos(wn, (nx - 0.5) * 2 * HALF_W * k, (-HALF_H + rnd(0.06, 0.4) * 2 * HALF_H) * k, z);
        setScl(wn, ws * 2 * HALF_H * k, ws * 2 * HALF_H * k);
        windowNodes.push(wn);
    }

    // 少数高楼顶红色航空障碍灯(缓慢闪烁,暂停时一并冻结)
    const topIdx = heights
        .map((h, i) => [h, i])
        .sort((a, b) => b[0] - a[0])
        .slice(0, 4);
    for (const [h, i] of topIdx) {
        const z = rnd(-0.45, -0.36);
        const k = depthK(z);
        const n = mkQuad('obs', cityRoot, MATS.obstacle);
        const base = 0.011; // 屏高占比
        const nx = bldX[i];
        // 楼顶世界高 = (-HALF_H + h*2*HALF_H) * k,灯再抬高一点
        const wy = (-HALF_H + h * 2 * HALF_H) * k + 0.05 * k;
        setPos(n, (nx - 0.5) * 2 * HALF_W * k, wy, z);
        setScl(n, base * 2 * HALF_H * k, base * 2 * HALF_H * k);
        obstacleLights.push({ node: n, base, phase: rnd(0, TAU), freq: rnd(0.25, 0.5), z });
    }
    buildingCount = BUILDING_N;
}

// ============ 粒子系统 ============
const MAX_ALIVE = 1250;      // 同屏存活上限(峰值能力 >=1000 的保护阀)
const BOOM_MIN = 108, BOOM_JITTER = 30; // 每发爆炸 100-240 区间内取值
const EMBER_MIN = 16, EMBER_JITTER = 6; // 余烬 >=12
const TRAIL_DT = 0.03;

function spawnParticle(kind, x, y, vx, vy, life, s0, mat, z, extra) {
    if (particles.length + rockets.length >= MAX_ALIVE) return null;
    const node = mkQuad(kind, fxRoot, mat);
    const p = {
        kind, node, x, y, vx, vy, age: 0, life, s0, z,
        drag: extra && extra.drag != null ? extra.drag : 2.5,
        g: extra && extra.g != null ? extra.g : 0.13,
        phase: rnd(0, TAU),
        freq: rnd(0.8, 1.7),
        wobA: rnd(0.008, 0.018),
        wobF: rnd(0.5, 1.3),
        vyT: extra && extra.vyT != null ? extra.vyT : null,
        relax: extra && extra.relax != null ? extra.relax : 2.5,
        shrink: extra && extra.shrink != null ? extra.shrink : 0.75,
        flicker: extra && extra.flicker != null ? extra.flicker : false,
    };
    setScl(node, s0 * 2 * HALF_H * depthK(z), s0 * 2 * HALF_H * depthK(z));
    particles.push(p);
    return p;
}

function explode(x, y, hue) {
    const mat = MATS.boom[hue];
    const speedBase = rnd(0.6, 0.95);
    // 爆闪:短寿命亮斑,提供"亮度脉冲"的峰值观感
    spawnParticle('flash', x, y, 0, 0, 0.22, 0.02, MATS.flash, 0.12, { drag: 0, g: 0, shrink: -6 });

    const N = BOOM_MIN + rndi(BOOM_JITTER);
    for (let i = 0; i < N; i++) {
        const ang = Math.random() * TAU;
        const v = speedBase * (0.35 + 0.65 * Math.sqrt(Math.random())); // 球面投影≈均匀圆盘
        spawnParticle('boom',
            x + rnd(-0.004, 0.004), y + rnd(-0.004, 0.004),
            Math.cos(ang) * v, Math.sin(ang) * v,
            rnd(1.2, 2.8), rnd(0.022, 0.042), mat,
            0.04 + Math.random() * 0.06,
            { drag: 2.5, g: 0.13, shrink: 0.75 });
    }
    // 余烬:寿命分层(60% 3-8s,40% 10-12s;spec amendment:长尾 >=30% 铺至 10-12s)
    const M = EMBER_MIN + rndi(EMBER_JITTER);
    for (let i = 0; i < M; i++) {
        const ang = Math.random() * TAU;
        const v = speedBase * (0.1 + 0.18 * Math.sqrt(Math.random()));
        const life = Math.random() < 0.4 ? rnd(10, 12) : rnd(3, 8);
        spawnParticle('ember',
            x + rnd(-0.01, 0.01), y + rnd(-0.01, 0.01),
            Math.cos(ang) * v, Math.sin(ang) * v,
            life, rnd(0.018, 0.033), MATS.ember[rndi(MATS.ember.length)],
            0.09 + Math.random() * 0.03,
            { drag: 3, g: 0, vyT: -rnd(0.045, 0.085), relax: 2.5, shrink: 0.35, flicker: true });
    }
}

function fire(nx, nyTop, hueIn) {
    if (!ready) return;
    const hue = hueIn != null ? hueIn : rndi(MATS.boom.length);
    // 轴向换算:点击 nyTop 为“自上原点”,粒子物理 y 为“自下原点(y 向上)”——
    // 世界映射 (y-0.5)*2H 与重力 vy-=g 均按自下原点,必须在此一次性换轴,
    // 否则爆点相对点击位置垂直镜像(点击上半屏却炸在下半屏)。
    const y1 = clamp((1 - nyTop) + rnd(-0.03, 0.03), 0.38, 0.88); // 爆点≈点击高度(±5% 画面高内)
    const y0 = 0.22;                                              // 从城市地面附近升空(自下原点)
    const dist = Math.max(0.05, y1 - y0);
    const T = clamp(0.6 + 0.85 * (dist / 0.5), 0.62, 1.4);   // 升空 0.6-1.6s 量级
    const head = mkQuad('rhead', fxRoot, MATS.trailHead);
    const halo = mkQuad('rhalo', fxRoot, MATS.trailHalo);
    const rocket = {
        x: clamp(nx + rnd(-0.008, 0.008), 0.02, 0.98), y0, y1, t: 0, T, hue,
        trailAcc: 0, node: head, halo,
        z: -0.1, dead: false,
    };
    rockets.push(rocket);
    fireworkCount += 1;
}

function fireRandom() {
    fire(rnd(0.18, 0.82), rnd(0.18, 0.5));
}

function killParticle(p, i) {
    if (p.node && p.node.isValid) p.node.destroy();
    particles[i] = particles[particles.length - 1];
    particles.pop();
}

// ============ UI 覆盖层(DOM,不画进 3D) ============
const btnAuto = { el: null };
const btnPause = { el: null };
function refreshBtnLabels() {
    if (btnAuto.el) btnAuto.el.textContent = '自动表演:' + (autoShow ? '开' : '关');
    if (btnPause.el) btnPause.el.textContent = enabled ? '暂停(运行中)' : '恢复(已冻结)';
}
function mkButton(dataUi, top, onClick) {
    const b = document.createElement('button');
    b.setAttribute('data-ui', dataUi);
    b.style.cssText =
        'position:fixed;right:12px;top:' + top + 'px;z-index:9999;padding:5px 12px;' +
        "font:13px/1.4 sans-serif;background:rgba(10,14,24,0.82);color:#e8ecf4;" +
        'border:1px solid #4a5568;border-radius:5px;cursor:pointer;text-align:right;';
    const swallow = (e) => e.stopPropagation(); // UI 事件不得漏进画布输入路径
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
        b.addEventListener(ev, swallow);
    }
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });
    document.body.appendChild(b);
    return b;
}
function buildUI() {
    btnAuto.el = mkButton('auto-show', 12, () => {
        autoShow = !autoShow;
        autoTimer = 0; // 开启后立即发射第一发(0.5-1.5s 随机间隔从下一发起算)
        refreshBtnLabels();
    });
    btnPause.el = mkButton('pause', 48, () => {
        enabled = !enabled;
        refreshBtnLabels();
    });
    const rst = mkButton('reset', 84, () => doReset());
    rst.textContent = '重置';
    refreshBtnLabels();
}

// ============ 全局 reset(等价 __bench.reset 与 data-ui=reset) ============
function doReset() {
    for (const p of particles) { if (p.node && p.node.isValid) p.node.destroy(); }
    particles.length = 0;
    for (const r of rockets) {
        if (r.node && r.node.isValid) r.node.destroy();
        if (r.halo && r.halo.isValid) r.halo.destroy();
    }
    rockets.length = 0;
    fireworkCount = 0;
    autoShow = false;
    enabled = true;
    buildCity();   // 城市剪影重新随机生成(楼数不变)
    buildStars();  // 背景星一并刷新
    refreshBtnLabels();
}

// ============ 自动表演 ============
let autoTimer = 0;

// ============ 每帧行为组件(真实时间步进;暂停时整个时间线冻结) ============
class FwSystem extends Component {
    update(dt) {
        try {
            if (!enabled) return; // 冻结:不累计时间、不更新任何节点 → 两帧像素差≈0
            const d = clamp(dt, 0, 0.05); // 失焦回来不产生累积时间跳变
            sceneTime += d;

            // 自动表演:开启后立即首发,之后 0.55-0.95s 随机间隔(spec 0.5-1.5s 内)
            if (autoShow) {
                autoTimer -= d;
                if (autoTimer <= 0) {
                    fireRandom();
                    autoTimer = rnd(0.55, 0.95);
                }
            }

            // 火箭升空段
            for (let i = rockets.length - 1; i >= 0; i--) {
                const r = rockets[i];
                r.t += d;
                const u = clamp(r.t / r.T, 0, 1);
                const ease = 1 - Math.pow(1 - u, 1.7);
                const y = r.y0 + (r.y1 - r.y0) * ease;
                const k = depthK(r.z);
                const wy = (y - 0.5) * 2 * HALF_H * k;
                const wx = (r.x - 0.5) * 2 * HALF_W * k;
                setPos(r.node, wx, wy, r.z);
                const hs = 0.026 * 2 * HALF_H * k;
                setScl(r.node, hs, hs);
                setPos(r.halo, wx, wy, r.z - 0.01);
                const hl = 0.07 * 2 * HALF_H * k * (0.85 + 0.3 * Math.sin(sceneTime * 21 + r.x * 40));
                setScl(r.halo, hl, hl);
                // 尾迹:上升段持续 spawn,寿命 0.3-0.8s
                r.trailAcc += d;
                while (r.trailAcc >= TRAIL_DT) {
                    r.trailAcc -= TRAIL_DT;
                    spawnParticle('trail',
                        r.x + rnd(-0.005, 0.005), y - rnd(0, 0.012),
                        rnd(-0.01, 0.01), -rnd(0.02, 0.05),
                        rnd(0.3, 0.8), rnd(0.012, 0.026), MATS.trail,
                        -0.06 + Math.random() * 0.05,
                        { drag: 1.5, g: 0.02, shrink: 0.9 });
                }
                if (u >= 1) {
                    if (r.node && r.node.isValid) r.node.destroy();
                    if (r.halo && r.halo.isValid) r.halo.destroy();
                    rockets[i] = rockets[rockets.length - 1];
                    rockets.pop();
                    explode(r.x, r.y1, r.hue);
                }
            }

            // 粒子(尾迹/爆炸/余烬)
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.age += d;
                if (p.age >= p.life) { killParticle(p, i); continue; }
                const dr = Math.exp(-p.drag * d);
                p.vx *= dr;
                p.vy *= dr;
                p.vy -= p.g * d;
                if (p.vyT != null) {
                    // 余烬:速度向终端漂移速度松弛(持续缓慢下坠),水平加正弦摆动
                    const rl = Math.min(1, p.relax * d);
                    p.vy += (p.vyT - p.vy) * rl;
                    p.vx += (Math.sin(p.age * p.wobF * TAU + p.phase) * p.wobA - p.vx) * Math.min(1, 3 * d);
                }
                p.x += p.vx * d;
                p.y += p.vy * d;
                let s = p.s0 * (1 - p.shrink * (p.age / p.life));
                if (p.flicker) s *= 0.75 + 0.5 * Math.abs(Math.sin(p.age * p.freq * TAU + p.phase));
                if (p.kind === 'flash') s = p.s0 * (1 + p.shrink * (p.age / p.life) * -1);
                if (s <= 0.0008) { killParticle(p, i); continue; }
                const k = depthK(p.z);
                setPos(p.node, (p.x - 0.5) * 2 * HALF_W * k, (p.y - 0.5) * 2 * HALF_H * k, p.z);
                const ws = s * 2 * HALF_H * k;
                setScl(p.node, ws, ws);
            }

            // 星点轻微闪烁(尺寸呼吸;暂停时冻结)
            for (const t of twinkles) {
                const s = t.base * (1 + t.amp * Math.sin(sceneTime * t.freq * TAU + t.phase));
                setScl(t.node, s, s);
            }
            // 障碍灯缓慢闪烁(亮-暗-亮;暂停时冻结)
            for (const o of obstacleLights) {
                const v = Math.sin(sceneTime * o.freq * TAU + o.phase);
                const s = o.base * (v > 0.1 ? 1 : 0.25);
                const k = depthK(o.z);
                setScl(o.node, s * 2 * HALF_H * k, s * 2 * HALF_H * k);
            }
        } catch (e) {
            // 防御:任何单帧异常都不允许变成未捕获错误(合同 §5.4),warn 便于诊断
            console.warn('[e04] update skipped one frame:', e && e.message);
        }
    }
}

// ============ 输入:引擎 input.on(pal 会吞 canvas 原生事件) ============
function toViewport(evt) {
    try {
        if (evt && typeof evt.getLocationInView === 'function') {
            const p = evt.getLocationInView();
            if (p && typeof p.x === 'number') {
                // 视图坐标系:左上原点
                return { nx: p.x / window.innerWidth, nyTop: p.y / window.innerHeight };
            }
        }
        if (evt && typeof evt.getLocation === 'function') {
            const p = evt.getLocation();
            if (p && typeof p.x === 'number') {
                // UI 坐标系:左下原点 → 翻转
                return { nx: p.x / window.innerWidth, nyTop: 1 - p.y / window.innerHeight };
            }
        }
        if (evt && typeof evt.getLocationX === 'function') {
            return {
                nx: evt.getLocationX() / window.innerWidth,
                nyTop: 1 - evt.getLocationY() / window.innerHeight,
            };
        }
    } catch (e) { /* 落到 null */ }
    return null;
}

function bindFireInput() {
    const onEvent = (evt) => {
        try {
            const pt = toViewport(evt);
            if (!pt) return;
            const nx = clamp(pt.nx, 0, 1);
            const nyTop = clamp(pt.nyTop, 0, 1);
            window.__lastClick = { nx, nyTop };
            if (nyTop >= 0.9) return; // 只忽略最底缘(城市地面以下),天空点击一律发射
            fire(nx, nyTop);
        } catch (e) {
            console.warn('[e04] click handler error:', e && e.message);
        }
    };
    const inputNS = CC.input;
    const ET = CC.Input && CC.Input.EventType ? CC.Input.EventType : null;
    if (inputNS && typeof inputNS.on === 'function') {
        inputNS.on(ET ? ET.MOUSE_DOWN : 'mouse-down', onEvent);
        return;
    }
    // 保底:pal 若未提供 input 单例,直接挂 canvas(可能被 pal 吞,仅降级路径)
    const cv = document.querySelector('#GameCanvas');
    if (cv) {
        cv.addEventListener('mousedown', (e) => {
            onEvent({ getLocationInView: () => ({ x: e.clientX, y: e.clientY }) });
        });
    }
}

// ============ 启动 ============
let skyRoot = null, starRoot = null, cityRoot = null, fxRoot = null;

try {
    probeNumericOverload();

    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('e04-fireworks-night');

    // 相机:固定正视,-Z 朝向场景(整个场景当作 2D 平面用)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 0, CAMZ));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = FOV;
    camera.near = 0.1;
    camera.far = 100;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(5, 7, 16, 255);
    camera.visibility = Layers.Enum.DEFAULT; // 坑位:4.0-alpha 默认 undefined,必须显式设置
    camera.priority = 0;

    // 视口半宽:优先相机 aspect,退化用窗口比
    const asp = (typeof camera.aspect === 'number' && camera.aspect > 0)
        ? camera.aspect
        : (window.innerWidth / Math.max(1, window.innerHeight));
    HALF_H = Math.tan((FOV * Math.PI) / 360) * CAMZ;
    HALF_W = HALF_H * asp;

    // 场景根节点(全部 DEFAULT 层)
    skyRoot = new Node('SkyRoot'); skyRoot.layer = LAYER; scene.addChild(skyRoot);
    starRoot = new Node('StarRoot'); starRoot.layer = LAYER; scene.addChild(starRoot);
    cityRoot = new Node('CityRoot'); cityRoot.layer = LAYER; scene.addChild(cityRoot);
    fxRoot = new Node('FxRoot'); fxRoot.layer = LAYER; scene.addChild(fxRoot);

    quadMesh = utils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));

    buildMaterials();
    buildSky();
    buildStars();
    buildCity();
    buildUI();
    bindFireInput();

    const sysNode = new Node('FwSystem');
    sysNode.layer = LAYER;
    scene.addChild(sysNode);
    sysNode.addComponent(FwSystem);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同模板约定)
    // 自检辅助钩子(不改变任何行为,仅暴露内部发射函数供诊断;正式交互走引擎 input)
    window.__e04 = { fire };
    app.run(scene);

    // 环境光:仅影响退化路径(standard 材质兜底时保持可见);unlit 不受影响
    scene.globals.ambient.skyColorHDR.set(0.6, 0.65, 0.8, 1.0);
    scene.globals.ambient.skyIllum = 20000;

    // 首帧就绪(EVENT_AFTER_DRAW,同模板口径)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) {
            window.__appReady = true;
            ready = true;
        }
    });

    console.log('[e04] city fireworks night running on cocosair');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类(同模板约定)
    console.error('[e04] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
