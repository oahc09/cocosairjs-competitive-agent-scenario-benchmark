/**
 * E03 — 太阳系仪(Orrery)cocosair 臂实现
 *
 * 结构(全部 Code First,引擎经 import map 从 /dist/vendor/cocosair.module.js 加载):
 *   createAirApp → Scene → 斜俯视 Camera(俯角 ~42°) → DirectionalLight + Ambient
 *   ├─ 太阳:unlit 亮黄核心 + 2 层半透明光晕球壳
 *   ├─ 8 颗行星:planetNode(轨道定位)→ tiltNode(轴倾)→ meshNode(自转),标准材质+自发光
 *   │    ├─ earth.moon / jupiter.io / jupiter.europa(卫星,行星节点子级,随行星公转)
 *   │    ├─ jupiter/saturn 纬度条纹带(半透明环形面)
 *   │    └─ saturn 光环(半透明环形面,倾斜)
 *   ├─ 8 条轨道参考线(LINE_LIST 细环,低不透明度)
 *   ├─ 小行星带:500 独立小天体 = 10 子环 × 50 盒体,每子环合并为一个静态网格,
 *   │    子环各自按开普勒分层周期绕 Y 差速旋转(带内速度分层)
 *   ├─ 背景星:320 个小盒体合并为单个静态网格
 *   └─ 选中高亮:广告牌化半透明光环(跟随选中行星 + 呼吸脉动)
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后 true
 *   - window.__bench = { getState(), reset() };pickTargets 每帧更新(CSS 像素,左上原点)
 *
 * 引擎坑位对照(来自 knowledge/skills,实现前已读):
 *   - 命名导入统一改为命名空间导入(缺失导出降级为 undefined 而非模块加载失败)
 *   - Camera.visibility 必须显式 Layers.Enum.DEFAULT
 *   - 材质:new Material() + initialize({effectName, defines, states});FLOAT4 传 Color 实例
 *   - 鼠标输入走引擎 input.on(MOUSE_DOWN)(pal 层吞 canvas DOM 事件);
 *     getLocation() 为物理像素、左下原点,与 worldToScreen 同空间,转 CSS 左上原点后再命中测试
 *   - 几何:utils.MeshUtils.createMesh(IGeometry);自定义 LINE_LIST/环形面/盒体农场
 */

import * as CCAIR from 'cocosair.js';

const {
    Layers, createAirApp, Scene, Node, Camera, DirectionalLight, MeshRenderer,
    utils, primitives, Vec3, Color, Component, director, Director, Material, gfx,
} = CCAIR;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 天体数据(冻结口径:周期最内 230s / 最外 3397s 单调递增;初始角 = k × 45°)
// ---------------------------------------------------------------------------

// type: rocky=岩质行星 / gas=气态巨行星 / ice=冰巨行星
const PLANET_DEFS = [
    { name: 'mercury', orbitRadius: 8.3,  radius: 0.95, period: 230,  spin: 50,   tilt: 2,    color: [151, 124, 104], type: 'rocky' },
    { name: 'venus',   orbitRadius: 11.8, radius: 1.25, period: 338,  spin: -140, tilt: 3,    color: [224, 193, 152], type: 'rocky' },
    { name: 'earth',   orbitRadius: 15.7, radius: 1.32, period: 496,  spin: 30,   tilt: 23.4, color: [70, 132, 222],  type: 'rocky' },
    { name: 'mars',    orbitRadius: 19.8, radius: 1.0,  period: 729,  spin: 35,   tilt: 25.2, color: [202, 96, 60],   type: 'rocky' },
    { name: 'jupiter', orbitRadius: 27.5, radius: 3.2,  period: 1071, spin: 22,   tilt: 3,    color: [226, 199, 166], type: 'gas' },
    { name: 'saturn',  orbitRadius: 32.6, radius: 2.75, period: 1574, spin: 26,   tilt: 26.7, color: [230, 210, 166], type: 'gas', ring: { inner: 3.5, outer: 6.4 } },
    { name: 'uranus',  orbitRadius: 37.8, radius: 1.85, period: 2312, spin: 30,   tilt: 82,   color: [132, 212, 226], type: 'ice' },
    { name: 'neptune', orbitRadius: 42.9, radius: 1.8,  period: 3397, spin: 28,   tilt: 28.3, color: [82, 122, 236],  type: 'ice' },
];
const TYPE_LABEL = { rocky: '岩质行星', gas: '气态巨行星', ice: '冰巨行星' };

// 卫星(父子层级:挂在 planetNode 下,随行星公转;周期 8–40 模拟秒)
const MOON_DEFS = [
    { name: 'moon',   parent: 'earth',   orbitRadius: 2.6, radius: 0.36, period: 20, phase: 0.8, color: [172, 172, 178] },
    { name: 'io',     parent: 'jupiter', orbitRadius: 4.6, radius: 0.42, period: 14, phase: 2.1, color: [216, 198, 140] },
    { name: 'europa', parent: 'jupiter', orbitRadius: 6.0, radius: 0.36, period: 26, phase: 4.4, color: [204, 208, 212] },
];

// 小行星带:第 4(mars)与第 5(jupiter)条轨道之间,10 子环 × 50 天体 = 500
const BELT_SUBRINGS = 10;
const BELT_PER_RING = 50;
const ASTEROID_COUNT = BELT_SUBRINGS * BELT_PER_RING;
const BELT_R0 = 21.6, BELT_R1 = 25.4;

const STAR_COUNT = 320;

// ---------------------------------------------------------------------------
// 运行时状态 + __bench 契约(先挂,加载期也可查询)
// ---------------------------------------------------------------------------

const state = {
    timeScale: 1,
    simulationTime: 0,
    selectedPlanet: null,
    epoch: 0,
    fps: 0,
    infoCard: { visible: false, name: '', fieldCount: 0 },
    pickTargets: [],
};

let planets = [];   // {def, node, tiltNode, meshNode, angle, angle0, screenX, screenY, screenRadius, moonCount}
let moons = [];     // {def, node}
let beltRings = []; // {node, period}
let selectedRef = null;
let cameraComp = null;
let cameraNode = null;
let canvasEl = null;
let highlightNode = null;
const frameTimes = [];

function getStateSnapshot() {
    return {
        planetCount: PLANET_DEFS.length,
        moonCount: MOON_DEFS.length,
        asteroidCount: ASTEROID_COUNT,
        ringedPlanetCount: PLANET_DEFS.filter((p) => p.ring).length,
        timeScale: state.timeScale,
        simulationTime: state.simulationTime,
        selectedPlanet: state.selectedPlanet,
        planets: planets.map((p) => ({
            name: p.def.name,
            orbitRadius: p.def.orbitRadius,
            orbitAngle: p.angle,
        })),
        pickTargets: state.pickTargets,
        infoCard: { visible: state.infoCard.visible, name: state.infoCard.name, fieldCount: state.infoCard.fieldCount },
        fps: state.fps,
        epoch: state.epoch,
    };
}

function doReset() {
    state.simulationTime = 0;
    state.timeScale = 1;
    state.epoch += 1;
    deselect(); // 关信息卡 + 隐藏高亮;轨道角由 simulationTime 派生,自动回 k×45°
    refreshSpeedButtons();
}

window.__appReady = false;
window.__bench = { getState: getStateSnapshot, reset: doReset };

// ---------------------------------------------------------------------------
// 确定性随机(mulberry32):天体带/星场布局可复现
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// 几何构造(全部程序化,无外部资产)
// ---------------------------------------------------------------------------

/** 轨道参考线:XZ 平面 LINE_LIST 细环。 */
function ringLineGeometry(radius, segments = 144) {
    const positions = new Float32Array(segments * 3);
    const indices = new Uint16Array(segments * 2);
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * TAU;
        positions[i * 3] = Math.cos(a) * radius;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = Math.sin(a) * radius;
        indices[i * 2] = i;
        indices[i * 2 + 1] = (i + 1) % segments;
    }
    return { positions, indices, primitiveMode: gfx.PrimitiveMode.LINE_LIST };
}

/** 平坦环形面(annulus):XZ 平面,内/外半径,用于行星环、条纹带、选中光圈。 */
function annulusGeometry(innerR, outerR, segments = 96) {
    const positions = new Float32Array(segments * 2 * 3);
    const indices = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * TAU;
        const a1 = ((i + 1) / segments) * TAU;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);
        const v0 = i * 2, v1 = i * 2 + 1;
        positions[v0 * 3] = c0 * innerR; positions[v0 * 3 + 1] = 0; positions[v0 * 3 + 2] = s0 * innerR;
        positions[v1 * 3] = c0 * outerR; positions[v1 * 3 + 1] = 0; positions[v1 * 3 + 2] = s0 * outerR;
        const w0 = ((i + 1) % segments) * 2, w1 = w0 + 1;
        const b = i * 6;
        indices[b] = v0; indices[b + 1] = v1; indices[b + 2] = w0;
        indices[b + 3] = v1; indices[b + 4] = w1; indices[b + 5] = w0;
    }
    return { positions, indices };
}

/** 盒体农场:向 out 追加一个(经缩放/旋转/平移的)立方体,供小行星与背景星合并网格。 */
const BOX_FACES = [
    { n: [1, 0, 0],  c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0],  c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [0, 0, 1],  c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], c: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];
function pushBox(out, cx, cy, cz, sx, sy, sz, yaw, pitch) {
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Ry(yaw)·Rx(pitch)
    const m00 = cyw, m01 = syw * sp, m02 = syw * cp;
    const m10 = 0, m11 = cp, m12 = -sp;
    const m20 = -syw, m21 = cyw * sp, m22 = cyw * cp;
    for (const f of BOX_FACES) {
        const nx = m00 * f.n[0] + m01 * f.n[1] + m02 * f.n[2];
        const ny = m10 * f.n[0] + m11 * f.n[1] + m12 * f.n[2];
        const nz = m20 * f.n[0] + m21 * f.n[1] + m22 * f.n[2];
        const base = out.vcount;
        for (const c of f.c) {
            const x = c[0] * sx, y = c[1] * sy, z = c[2] * sz;
            out.positions.push(m00 * x + m01 * y + m02 * z + cx);
            out.positions.push(m10 * x + m11 * y + m12 * z + cy);
            out.positions.push(m20 * x + m21 * y + m22 * z + cz);
            out.normals.push(nx, ny, nz);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        out.vcount += 4;
    }
}
/**
 * 盒体农场:inserter 一次性向 out 追加全部盒体,合并为单个几何(小行星子环 / 背景星)。
 * 注意 inserter 只被调用一次,循环由 inserter 自身完成(勿双重循环)。
 */
function boxFarmGeometry(inserter) {
    const out = { positions: [], normals: [], indices: [], vcount: 0 };
    inserter((...args) => pushBox(out, ...args));
    return {
        positions: new Float32Array(out.positions),
        normals: new Float32Array(out.normals),
        indices: out.vcount > 65535 ? new Uint32Array(out.indices) : new Uint16Array(out.indices),
    };
}

// ---------------------------------------------------------------------------
// 材质工厂(createAirApp 之后才能 initialize;FLOAT4 一律 Color 实例)
// ---------------------------------------------------------------------------

function makeUnlitMaterial(r, g, b, a, opts = {}) {
    const m = new Material();
    const states = {};
    if (opts.blend) {
        states.blendState = { targets: [{ blend: true }] };
        states.depthStencilState = { depthWrite: false };
    }
    if (opts.cullNone) {
        states.rasterizerState = { cullMode: gfx.CullMode.NONE };
    }
    m.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: false },
        ...(Object.keys(states).length ? { states } : {}),
    });
    m.setProperty('mainColor', new Color(r, g, b, a));
    return m;
}

function makePlanetMaterial(rgb, emissive = 0.5) {
    const m = new Material();
    m.initialize({ effectName: 'builtin-standard' });
    m.setProperty('mainColor', new Color(rgb[0], rgb[1], rgb[2], 255));
    m.setProperty('roughness', 0.9);
    m.setProperty('metallic', 0.02);
    if (emissive > 0) {
        // emissive 为 linear:true 的 FLOAT4;Color 字节自动除以 255 后再 sRGB→linear
        m.setProperty('emissive', new Color(
            Math.round(rgb[0] * emissive), Math.round(rgb[1] * emissive), Math.round(rgb[2] * emissive), 255,
        ));
    }
    return m;
}

// ---------------------------------------------------------------------------
// DOM UI 覆盖层(信息卡 / 五档时间倍率 / Reset;data-ui + id + aria-label 三重定位)
// ---------------------------------------------------------------------------

const ui = {};

function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
        #bench-hud { position: fixed; inset: 0; pointer-events: none; z-index: 9999;
                     font: 13px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                     color: #d8e2ef; user-select: none; }
        #bench-hud .panel { background: rgba(10, 16, 28, 0.82); border: 1px solid rgba(140, 170, 220, 0.35);
                            border-radius: 8px; padding: 10px 14px; }
        #bench-title { position: absolute; top: 10px; left: 14px; }
        #bench-title h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: 1px; }
        #bench-title p { margin: 0; font-size: 11px; color: #9fb2cc; }
        #bench-status { position: absolute; top: 78px; left: 14px; font-size: 11px; color: #9fb2cc;
                        text-shadow: 0 1px 2px #000; }
        #info-card { position: absolute; top: 64px; right: 14px; width: 232px; display: none; pointer-events: none; }
        #info-card h2 { margin: 0 0 8px; font-size: 16px; color: #ffe9b0; letter-spacing: 1.5px;
                        text-transform: lowercase; }
        #info-card .row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
        #info-card .row .k { color: #8fa3c0; }
        #info-card .row .v { color: #e8eef7; }
        #info-card .hint { margin-top: 8px; font-size: 10px; color: #7487a1; }
        #time-controls { position: absolute; left: 50%; transform: translateX(-50%); bottom: 18px;
                         display: flex; gap: 6px; padding: 8px 10px; pointer-events: auto; }
        #time-controls button, #reset { pointer-events: auto; cursor: pointer; border-radius: 6px;
                         border: 1px solid rgba(150, 180, 230, 0.4); background: rgba(28, 40, 62, 0.9);
                         color: #cfe0f5; font: 12px/1 "Segoe UI", "PingFang SC", sans-serif;
                         padding: 7px 12px; transition: background .15s, color .15s; }
        #time-controls button:hover, #reset:hover { background: rgba(52, 74, 110, 0.95); }
        #time-controls button.active { background: #3d6db5; color: #fff; border-color: #7fa8e0; font-weight: 700; }
        #reset { position: absolute; top: 12px; right: 14px; font-weight: 700; letter-spacing: 1px; }
    `;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.id = 'bench-hud';
    hud.innerHTML = `
        <div id="bench-title" class="panel"><h1>太阳系仪 Orrery</h1><p>E03 · cocosair · 8 planets / 3 moons / ${ASTEROID_COUNT} asteroids</p></div>
        <div id="bench-status"></div>
        <div id="info-card" class="panel" data-ui="info-card" aria-label="info card">
            <h2 id="info-card-name"></h2>
            <div class="row"><span class="k">类型</span><span class="v" id="info-card-type"></span></div>
            <div class="row"><span class="k">公转周期</span><span class="v" id="info-card-period"></span></div>
            <div class="row"><span class="k">轨道半径</span><span class="v" id="info-card-radius"></span></div>
            <div class="row"><span class="k">直径</span><span class="v" id="info-card-diameter"></span></div>
            <div class="row"><span class="k">卫星</span><span class="v" id="info-card-moons"></span></div>
            <div class="hint">点击空白处取消选中</div>
        </div>
        <div id="time-controls" data-ui="time-controls" aria-label="time controls"></div>
        <button id="reset" data-ui="reset" aria-label="reset" title="恢复初始状态">Reset</button>
    `;
    document.body.appendChild(hud);

    ui.status = hud.querySelector('#bench-status');
    ui.card = hud.querySelector('#info-card');
    ui.cardName = hud.querySelector('#info-card-name');
    ui.cardFields = {
        type: hud.querySelector('#info-card-type'),
        period: hud.querySelector('#info-card-period'),
        radius: hud.querySelector('#info-card-radius'),
        diameter: hud.querySelector('#info-card-diameter'),
        moons: hud.querySelector('#info-card-moons'),
    };
    ui.speedButtons = {};
    const tc = hud.querySelector('#time-controls');
    for (const s of [0.5, 1, 2, 4, 8]) {
        const id = `speed-${String(s).replace('.', '.')}x`;
        const btn = document.createElement('button');
        btn.id = id;
        btn.setAttribute('data-ui', id);
        btn.setAttribute('aria-label', `speed ${s}x`);
        btn.textContent = `${s}x`;
        btn.addEventListener('click', () => {
            state.timeScale = s;
            refreshSpeedButtons();
        });
        tc.appendChild(btn);
        ui.speedButtons[s] = btn;
    }
    hud.querySelector('#reset').addEventListener('click', () => doReset());
    refreshSpeedButtons();
    refreshStatus();
}

function refreshSpeedButtons() {
    for (const s of [0.5, 1, 2, 4, 8]) {
        ui.speedButtons[s].classList.toggle('active', state.timeScale === s);
    }
}

function refreshInfoCard() {
    const p = selectedRef;
    if (!p) {
        ui.card.style.display = 'none';
        state.infoCard = { visible: false, name: '', fieldCount: 0 };
        return;
    }
    const d = p.def;
    ui.cardName.textContent = d.name;
    ui.cardFields.type.textContent = TYPE_LABEL[d.type];
    ui.cardFields.period.textContent = `${d.period} 模拟秒`;
    ui.cardFields.radius.textContent = `${d.orbitRadius.toFixed(1)} AU′`;
    ui.cardFields.diameter.textContent = `${(d.radius * 2).toFixed(2)} R⊕′`;
    ui.cardFields.moons.textContent = p.moonCount === 0 ? '无' : `${p.moonCount} 颗`;
    ui.card.style.display = 'block';
    // 名称之外 5 个数据字段(类型/公转周期/轨道半径/直径/卫星)
    state.infoCard = { visible: true, name: d.name, fieldCount: 5 };
}

let statusTimer = 0;
function refreshStatus() {
    ui.status.textContent =
        `模拟时间 ${state.simulationTime.toFixed(1)}s · 倍率 ${state.timeScale}x · FPS ${state.fps.toFixed(0)} · epoch ${state.epoch}`;
}

// ---------------------------------------------------------------------------
// 选中 / 命中测试(pickTargets 为 CSS 像素、左上原点;命中半径即 screenRadius)
// ---------------------------------------------------------------------------

const MIN_PICK_PX = 12;

function selectPlanet(p) {
    selectedRef = p;
    state.selectedPlanet = p.def.name;
    if (highlightNode) highlightNode.active = true;
    refreshInfoCard();
}

function deselect() {
    selectedRef = null;
    state.selectedPlanet = null;
    if (highlightNode) highlightNode.active = false;
    refreshInfoCard();
}

function handlePointerDown(cssX, cssY) {
    let best = null, bestD = Infinity;
    for (const p of planets) {
        const dx = cssX - p.screenX, dy = cssY - p.screenY;
        const d = Math.hypot(dx, dy);
        if (d <= Math.max(p.screenRadius, MIN_PICK_PX) && d < bestD) { best = p; bestD = d; }
    }
    if (best) selectPlanet(best);
    else deselect();
}

// ---------------------------------------------------------------------------
// 每帧驱动组件(公转/自转/卫星/差速带/屏幕投影/高亮广告牌)
// ---------------------------------------------------------------------------

const _v3 = new Vec3();

function screenMetrics() {
    const rc = cameraComp.camera; // 渲染相机:width/height 为物理像素
    const cssW = canvasEl.clientWidth || 1;
    const cssH = canvasEl.clientHeight || 1;
    return {
        dprX: (rc && rc.width ? rc.width : cssW) / cssW,
        dprY: (rc && rc.height ? rc.height : cssH) / cssH,
        cssW, cssH,
        // 垂直焦距(CSS 像素):depth=1 处每世界单位的像素数
        fPx: (cssH / 2) / Math.tan((cameraComp.fov * DEG) / 2),
    };
}

function updatePickTargets() {
    if (!cameraComp || !cameraComp.camera) return;
    const m = screenMetrics();
    state.pickTargets = planets.map((p) => {
        cameraComp.worldToScreen(p.node.worldPosition, _v3); // 物理像素,左下原点
        const sx = _v3.x / m.dprX;
        const sy = m.cssH - _v3.y / m.dprY;
        const dist = Vec3.distance(cameraNode.worldPosition, p.node.worldPosition) || 1;
        const r = Math.max(MIN_PICK_PX, (p.def.radius / dist) * m.fPx);
        p.screenX = sx; p.screenY = sy; p.screenRadius = r;
        return {
            name: p.def.name,
            screenX: Math.round(sx * 10) / 10,
            screenY: Math.round(sy * 10) / 10,
            screenRadius: Math.round(r * 10) / 10,
        };
    });
}

class OrreryDriver extends Component {
    update(dt) {
        // 时间倍率作用于模拟时钟;轨道角 = 初值 + 2π·t/T(由 t 派生 ⇒ 变速无跳变、reset 自动回初值)
        state.simulationTime += dt * state.timeScale;
        const t = state.simulationTime;

        for (const p of planets) {
            p.angle = p.angle0 + (TAU * t) / p.def.period;
            p.node.setPosition(
                Math.cos(p.angle) * p.def.orbitRadius, 0, -Math.sin(p.angle) * p.def.orbitRadius,
            );
            p.meshNode.setRotationFromEuler(0, (TAU * t) / p.def.spin, 0);
        }
        for (const mn of moons) {
            const a = mn.def.phase + (TAU * t) / mn.def.period;
            mn.node.setPosition(Math.cos(a) * mn.def.orbitRadius, 0, -Math.sin(a) * mn.def.orbitRadius);
        }
        for (const sr of beltRings) {
            sr.node.setRotationFromEuler(0, (TAU * t) / sr.period, 0);
        }

        updatePickTargets();

        // 选中高亮:跟随行星 + 相机朝向广告牌 + 呼吸脉动(真实时钟驱动,与倍率无关)
        if (selectedRef && highlightNode) {
            const p = selectedRef;
            highlightNode.setPosition(p.node.worldPosition);
            highlightNode.setRotation(cameraNode.worldRotation);
            const pulse = 1 + 0.08 * Math.sin((performance.now() / 1000) * TAU * 1.6);
            highlightNode.setScale(new Vec3(p.highlightR * pulse, p.highlightR * pulse, p.highlightR * pulse));
        }

        statusTimer += dt;
        if (statusTimer > 0.2) { statusTimer = 0; refreshStatus(); }
    }
}

// ---------------------------------------------------------------------------
// 场景构建
// ---------------------------------------------------------------------------

function addMeshNode(parent, name, geometry, material, opts = {}) {
    const node = new Node(name);
    node.layer = Layers.Enum.DEFAULT;
    parent.addChild(node);
    const mr = node.addComponent(MeshRenderer);
    mr.mesh = utils.MeshUtils.createMesh(geometry);
    mr.material = material;
    if (opts.tiltEuler) node.setRotationFromEuler(...opts.tiltEuler);
    return node;
}

function buildScene(scene) {
    // —— 相机:斜俯视,俯角 atan(60/67) ≈ 41.9°;系统横向占屏 ~67%(65–80% 区间),
    //     uranus 初始(270°,轨道最近点)投影 y≈713 保持在屏内 ——
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 60, 67));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = 45;
    cameraComp.near = 0.5;
    cameraComp.far = 1400;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(5, 7, 13, 255); // 深空近黑
    cameraComp.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式
    cameraComp.priority = 0;

    // —— 光照:方向光(HDR 量级)+ 环境光(app.run 后经 scene.globals 配置,见 main 末尾)——
    const lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 80, 30));
    lightNode.setRotationFromEuler(-62, -28, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 50000;

    // —— 恒星:亮黄核心(unlit,全画面最亮)+ 两层柔光晕 ——
    addMeshNode(scene, 'sun', primitives.sphere(5.2, { segments: 36 }),
        makeUnlitMaterial(255, 243, 186, 255));
    addMeshNode(scene, 'sun-glow-1', primitives.sphere(5.6, { segments: 24 }),
        makeUnlitMaterial(255, 226, 150, 64, { blend: true }));
    addMeshNode(scene, 'sun-glow-2', primitives.sphere(7.0, { segments: 24 }),
        makeUnlitMaterial(255, 216, 140, 30, { blend: true }));

    // —— 轨道参考线:细淡灰蓝 ——
    const orbitMat = makeUnlitMaterial(148, 158, 176, 64, { blend: true });
    for (const d of PLANET_DEFS) {
        addMeshNode(scene, `orbit-${d.name}`, ringLineGeometry(d.orbitRadius), orbitMat);
    }

    // —— 8 颗行星(+ 卫星 + 条纹带 + 土星环)——
    const bandMatDark = makeUnlitMaterial(122, 92, 62, 150, { blend: true, cullNone: true });
    const bandMatLight = makeUnlitMaterial(246, 232, 202, 120, { blend: true, cullNone: true });
    const ringMat = makeUnlitMaterial(214, 196, 152, 130, { blend: true, cullNone: true });

    const byName = new Map();
    for (let k = 0; k < PLANET_DEFS.length; k++) {
        const d = PLANET_DEFS[k];
        const planetNode = new Node(`planet-${d.name}`);
        planetNode.layer = Layers.Enum.DEFAULT;
        scene.addChild(planetNode);

        const tiltNode = new Node(`tilt-${d.name}`);
        tiltNode.layer = Layers.Enum.DEFAULT;
        planetNode.addChild(tiltNode);
        tiltNode.setRotationFromEuler(d.tilt * DEG, 0, d.tilt * DEG * 0.35);

        const meshNode = addMeshNode(tiltNode, `mesh-${d.name}`,
            primitives.sphere(d.radius, { segments: 28 }), makePlanetMaterial(d.color));

        const p = { def: d, node: planetNode, tiltNode, meshNode, angle0: (k * Math.PI) / 4, angle: (k * Math.PI) / 4, moonCount: 0, screenX: 0, screenY: 0, screenRadius: MIN_PICK_PX, highlightR: d.radius * 2.1 };
        planets.push(p);
        byName.set(d.name, p);

        if (d.type === 'gas') { // 气态巨行星纬度条纹带:水平半透明环面浮于对应纬度(内缘沉入球体被深度遮挡)
            const lats = d.name === 'jupiter' ? [-30, -12, 12, 30] : [-22, 22];
            lats.forEach((lat, i) => {
                const rr = d.radius * Math.cos(lat * DEG) * 1.03;
                const w = d.radius * (d.name === 'jupiter' ? 0.15 : 0.2);
                const band = addMeshNode(tiltNode, `band-${d.name}-${i}`,
                    annulusGeometry(rr - w, rr + w, 72), i % 2 === 0 ? bandMatDark : bandMatLight);
                band.setPosition(0, d.radius * Math.sin(lat * DEG) * 1.06, 0);
            });
        }
        if (d.ring) { // 行星环:平坦环形面,处于 tiltNode 本地水平面(倾斜由 tiltNode 提供)
            addMeshNode(tiltNode, `ring-${d.name}`,
                annulusGeometry(d.ring.inner, d.ring.outer, 108), ringMat);
        }
    }

    // —— 卫星:行星节点的子节点(父有公转 ⇒ 卫星随行);本地绕行星公转 ——
    for (const md of MOON_DEFS) {
        const parent = byName.get(md.parent);
        const node = addMeshNode(parent.node, `moon-${md.name}`,
            primitives.sphere(md.radius, { segments: 18 }), makePlanetMaterial(md.color, 0.35));
        moons.push({ def: md, node });
        parent.moonCount += 1;
    }

    // —— 小行星带:10 子环 × 50 独立盒体;子环差速旋转(开普勒分层,周期介于 mars/jupiter 之间)——
    const rnd = mulberry32(20261023);
    for (let i = 0; i < BELT_SUBRINGS; i++) {
        const frac = BELT_SUBRINGS === 1 ? 0 : i / (BELT_SUBRINGS - 1);
        const ringR = BELT_R0 + (BELT_R1 - BELT_R0) * frac;
        const period = 729 + (1071 - 729) * Math.pow((ringR - 19.8) / (27.5 - 19.8), 1.5);
        const shade = 0.86 + 0.28 * frac;
        const geo = boxFarmGeometry((push) => {
            for (let j = 0; j < BELT_PER_RING; j++) {
                const a = rnd() * TAU;
                const rr = ringR + (rnd() - 0.5) * 0.55;
                const y = (rnd() - 0.5) * 1.5;
                const s = 0.14 + rnd() * 0.3;
                push(
                    Math.cos(a) * rr, y, Math.sin(a) * rr,
                    s * (0.7 + rnd() * 0.6), s * (0.7 + rnd() * 0.6), s * (0.7 + rnd() * 0.6),
                    rnd() * TAU, (rnd() - 0.5) * 1.2,
                );
            }
        });
        const node = addMeshNode(scene, `belt-ring-${i}`, geo,
            makeUnlitMaterial(Math.round(122 * shade), Math.round(108 * shade), Math.round(94 * shade), 255));
        beltRings.push({ node, period });
    }

    // —— 背景星:320 小盒体,合并为单个静态网格(半径 240–420 球壳)——
    const starGeo = boxFarmGeometry((push) => {
        for (let j = 0; j < STAR_COUNT; j++) {
            const u = rnd() * 2 - 1;
            const phi = rnd() * TAU;
            const rr = 240 + rnd() * 180;
            const s = 0.7 + rnd() * rnd() * 2.4;
            const sq = Math.sqrt(1 - u * u);
            push(sq * Math.cos(phi) * rr, u * rr, sq * Math.sin(phi) * rr, s, s, s, rnd() * TAU, rnd() * TAU);
        }
    });
    addMeshNode(scene, 'starfield', starGeo, makeUnlitMaterial(196, 206, 224, 255));

    // —— 选中高亮:广告牌化半透明光圈(单位环形面,按行星缩放)——
    highlightNode = addMeshNode(scene, 'selection-halo',
        annulusGeometry(0.86, 1.0, 72), makeUnlitMaterial(120, 255, 225, 190, { blend: true, cullNone: true }));
    highlightNode.active = false;

    // —— 每帧驱动 ——
    const driverNode = new Node('OrreryDriver');
    scene.addChild(driverNode);
    driverNode.addComponent(OrreryDriver);
}

// ---------------------------------------------------------------------------
// 输入:优先引擎 input.on(pal 吞 canvas DOM 事件);不可用时退回 window 捕获阶段监听
// ---------------------------------------------------------------------------

function setupInput() {
    const inp = CCAIR.input;
    const InputEnum = CCAIR.Input && CCAIR.Input.EventType;
    if (inp && InputEnum && typeof inp.on === 'function') {
        inp.on(InputEnum.MOUSE_DOWN, (e) => {
            try {
                const loc = e.getLocation(); // 物理像素,左下原点
                const m = screenMetrics();
                handlePointerDown(loc.x / m.dprX, m.cssH - loc.y / m.dprY);
            } catch (err) { console.warn('[orrery] input handler:', err && err.message); }
        });
    } else {
        window.addEventListener('mousedown', (e) => {
            const rect = canvasEl.getBoundingClientRect();
            handlePointerDown(e.clientX - rect.left, e.clientY - rect.top);
        }, true);
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

try {
    canvasEl = document.querySelector('#GameCanvas');
    buildUI();

    const app = await createAirApp({ canvas: '#GameCanvas' });
    window.__airApp = app;

    const scene = new Scene('orrery');
    buildScene(scene);
    app.run(scene);

    // 环境光:app.run 后经由 scene.globals 显式配置(skyColorHDR 原位 set 为已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.30, 0.33, 0.42, 1.0);
    scene.globals.ambient.skyIllum = 20000;

    setupInput();

    // 帧率(2s 滚动平均)+ 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
        state.fps = frameTimes.length / 2;
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[orrery] running on cocosair', app.getScene() && app.getScene().name);
} catch (err) {
    // 致命错误(如 WebGL2 不可用 → WEBGL2_REQUIRED):显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[orrery] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
