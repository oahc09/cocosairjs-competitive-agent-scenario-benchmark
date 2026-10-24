/**
 * E03 — Orrery (太阳系仪) — Cocos AIR arm
 *
 * Code First 结构(以 examples/hello-cube 为准):
 *   createAirApp({ canvas }) → Scene → Camera / DirectionalLight / Node+MeshRenderer
 *   → app.run(scene) → director.on(Director.EVENT_AFTER_DRAW)
 *
 * 设计要点(为什么这样做):
 * - 全部运动由单一模拟时钟 simTime 推导:orbitAngle = base + 2π·simTime/period。
 *   这样 timeScale 真实作用于运动(不用改任何"速度变量"),reset 只是把 simTime 归零,
 *   天然满足"轨道角回到 k×45°、连续累计不取模"。
 * - 小行星带 = 12 条同心细环,每条 60 颗独立小石块合并成一个 Mesh(720 颗独立天体,
 *   12 个 draw call)。每条环角速度 ∝ 1/√r(开普勒式分层),带内因此产生差速流动。
 * - 点击拾取:工程侧自己维护 pickTargets(每帧投影),命中判定用同一份投影 → 屏幕上
 *   看到什么就点中什么。监听走 window capture 阶段(pal 层会吃掉 canvas 上的鼠标事件)。
 * - UI 为 DOM 覆盖层(信息卡/倍率/Reset),用 data-ui + aria-label 暴露给探针。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    Material,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    director,
    Director,
    gfx,
} from 'cocosair.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 场景数据(planets 必须按轨道半径升序;第 k 颗初始角 = k × 45°)
// ---------------------------------------------------------------------------
const PLANETS = [
    { name: 'mercury', orbit: 4.2,  radius: 0.50, period: 240,  spin: 24, color: [150, 134, 118], type: 'Rocky · silicate',  moons: [] },
    { name: 'venus',   orbit: 5.6,  radius: 0.62, period: 320,  spin: 40, color: [206, 168, 108], type: 'Rocky · volcanic',  moons: [] },
    { name: 'earth',   orbit: 7.2,  radius: 0.66, period: 420,  spin: 20, color: [ 72, 124, 196], type: 'Terrestrial · ocean', moons: [
        { name: 'moon', dist: 1.55, radius: 0.19, period: 12, color: [196, 196, 190] },
    ] },
    { name: 'mars',    orbit: 8.8,  radius: 0.54, period: 560,  spin: 22, color: [188,  96,  58], type: 'Rocky · iron oxide', moons: [
        { name: 'phobos', dist: 1.15, radius: 0.13, period: 8,  color: [150, 140, 132] },
        { name: 'deimos', dist: 1.80, radius: 0.11, period: 16, color: [162, 152, 144] },
    ] },
    { name: 'jupiter', orbit: 12.0, radius: 1.30, period: 900,  spin: 9,  color: [214, 186, 146], type: 'Gas giant · banded', bands: true,  moons: [] },
    { name: 'saturn',  orbit: 15.2, radius: 1.05, period: 1300, spin: 11, color: [222, 202, 152], type: 'Gas giant · ringed', bands: true,  ring: true, moons: [] },
    { name: 'uranus',  orbit: 18.6, radius: 0.82, period: 2100, spin: 15, color: [136, 204, 214], type: 'Ice giant · methane', moons: [] },
    { name: 'neptune', orbit: 22.0, radius: 0.80, period: 3000, spin: 17, color: [ 64,  98, 190], type: 'Ice giant · methane', moons: [] },
];

const BELT = { bands: 12, perBand: 60, inner: 9.55, outer: 11.15 };

// 相机取景参数(R = 最外轨道半径;焦距 f 决定画面占比)
const CAM = { radius: 22.0, distance: 66.0, elevation: 35 * DEG, fovY: 29.0, lookAtY: -3.6 };

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------
const state = {
    simTime: 0,
    timeScale: 1,
    selected: null,
    epoch: 0,
    fps: 60,
    ready: false,
};

let app = null;
let scene = null;
let cameraNode = null;
let cameraComp = null;
let canvasEl = null;
let highlightNode = null;
let byName = {};
const planetRecords = [];   // { def, pivot, meshNode, mat, baseColor, moons: [...] }
const beltBands = [];       // { node, omega, phase }
const billboards = [];      // 需要每帧朝向相机的节点(太阳光晕)
const fpsBuf = [];

// ---------------------------------------------------------------------------
// 几何 / 材质工具
// ---------------------------------------------------------------------------
function createMesh(geom) {
    // 契约:IGeometry → Mesh 资产必须先经 utils.MeshUtils.createMesh
    const MU = utils && utils.MeshUtils;
    return MU && typeof MU.createMesh === 'function' ? MU.createMesh(geom) : utils.createMesh(geom);
}

/** 平面环带(annulus)。plane='xz' 为轨道面(法线 +Y),'xy' 为面向相机的装饰环。 */
function annulusGeometry(inner, outer, segments, plane) {
    const positions = [];
    const normals = [];
    const indices = [];
    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * TAU;
        const a1 = ((i + 1) / segments) * TAU;
        const quad = [[inner, a0], [outer, a0], [outer, a1], [inner, a1]];
        const base = positions.length / 3;
        for (let q = 0; q < 4; q++) {
            const r = quad[q][0];
            const a = quad[q][1];
            const u = Math.cos(a) * r;
            const v = Math.sin(a) * r;
            if (plane === 'xz') {
                positions.push(u, 0, v);
                normals.push(0, 1, 0);
            } else {
                positions.push(u, v, 0);
                normals.push(0, 0, 1);
            }
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        // 双面:环形参考线/行星环从两侧都要可见
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    return { positions, normals, indices };
}

const OCTA_FACES = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
];

/** 把一颗不规则小石块追加进合并缓冲(平直法线 + 双面索引)。 */
function pushRock(buf, cx, cy, cz, size, rand) {
    const v = [];
    for (let k = 0; k < 6; k++) {
        const s = size * (0.55 + rand() * 0.8);
        const px = k === 0 ? s : (k === 1 ? -s : 0);
        const py = k === 2 ? s : (k === 3 ? -s : 0);
        const pz = k === 4 ? s : (k === 5 ? -s : 0);
        v.push([px, py, pz]);
    }
    const rot = rand() * TAU;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const squash = 0.65 + rand() * 0.55;
    for (const p of v) {
        const x = p[0] * cs - p[2] * sn;
        const z = p[0] * sn + p[2] * cs;
        p[0] = x;
        p[2] = z;
        p[1] *= squash;
    }
    for (const f of OCTA_FACES) {
        const a = v[f[0]];
        const b = v[f[1]];
        const c = v[f[2]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1];
        let ny = e1[2] * e2[0] - e1[0] * e2[2];
        let nz = e1[0] * e2[1] - e1[1] * e2[0];
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const base = buf.positions.length / 3;
        for (const p of [a, b, c]) {
            buf.positions.push(cx + p[0], cy + p[1], cz + p[2]);
            buf.normals.push(nx, ny, nz);
        }
        buf.indices.push(base, base + 1, base + 2);
        buf.indices.push(base, base + 2, base + 1);
    }
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 统一材质工厂。
 * builtin-standard / builtin-unlit 是共享对象,不能直接改 → 每个天体自己 new Material()。
 * 半透明材质用 initialize 的 states 覆盖 blendState(alpha 混合);失败则退回不透明,
 * 保证"环面/光晕"这类效果不会因状态覆盖不可用而整块消失。
 */
function materialUnlit(rgb, alpha = 255) {
    const m = new Material();
    const info = { effectName: 'builtin-unlit', defines: { USE_TEXTURE: false } };
    if (alpha < 255) {
        const BF = (gfx && gfx.BlendFactor) || {};
        info.states = {
            blendState: {
                targets: [{
                    blend: true,
                    blendSrc: BF.SRC_ALPHA !== undefined ? BF.SRC_ALPHA : 2,
                    blendDst: BF.ONE_MINUS_SRC_ALPHA !== undefined ? BF.ONE_MINUS_SRC_ALPHA : 4,
                    blendSrcAlpha: BF.SRC_ALPHA !== undefined ? BF.SRC_ALPHA : 2,
                    blendDstAlpha: BF.ONE_MINUS_SRC_ALPHA !== undefined ? BF.ONE_MINUS_SRC_ALPHA : 4,
                }],
            },
        };
    }
    try {
        m.initialize(info);
    } catch (err) {
        console.warn('[orrery] blended material fallback:', err && err.message);
        m.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: false } });
    }
    m.setProperty('mainColor', new Color(rgb[0], rgb[1], rgb[2], alpha));
    return m;
}

/** 加色混合材质:alpha 通道不参与,亮度直接由颜色编码(适合光晕/星光)。 */
function materialAdditive(rgb) {
    const m = new Material();
    const BF = (gfx && gfx.BlendFactor) || {};
    const ONE = BF.ONE !== undefined ? BF.ONE : 1;
    const info = {
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: false },
        states: { blendState: { targets: [{ blend: true, blendSrc: ONE, blendDst: ONE, blendSrcAlpha: ONE, blendDstAlpha: ONE }] } },
    };
    try {
        m.initialize(info);
    } catch (err) {
        console.warn('[orrery] additive material fallback:', err && err.message);
        m.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: false } });
    }
    m.setProperty('mainColor', new Color(rgb[0], rgb[1], rgb[2], 255));
    return m;
}

function materialStandard(rgb, opts = {}) {
    const m = new Material();
    m.initialize({ effectName: 'builtin-standard' });
    m.setProperty('mainColor', new Color(rgb[0], rgb[1], rgb[2], 255));
    m.setProperty('roughness', opts.roughness !== undefined ? opts.roughness : 0.85);
    m.setProperty('metallic', opts.metallic !== undefined ? opts.metallic : 0.0);
    if (opts.emissive) {
        m.setProperty('emissive', new Color(opts.emissive[0], opts.emissive[1], opts.emissive[2], 255));
    }
    return m;
}

function addMeshNode(parent, name, geometry, material, scale) {
    const node = new Node(name);
    node.layer = Layers.Enum.DEFAULT;
    parent.addChild(node);
    const mr = node.addComponent(MeshRenderer);
    mr.mesh = createMesh(geometry);
    mr.material = material;
    if (scale) node.setScale(new Vec3(scale, scale, scale));
    return node;
}

// ---------------------------------------------------------------------------
// DOM UI(覆盖层)
// ---------------------------------------------------------------------------
const ui = { root: null, card: null, cardName: null, cardFields: null, speedBtns: [], resetBtn: null };

function buildUi() {
    const style = document.createElement('style');
    style.textContent = `
      #hud { position: fixed; inset: 0; pointer-events: none; z-index: 50;
             font-family: "Segoe UI", system-ui, sans-serif; color: #dfe7f5; }
      #hud .panel { pointer-events: auto; }
      #info-card { position: fixed; top: 88px; right: 24px; width: 236px;
                   background: rgba(12,16,26,.82); border: 1px solid rgba(120,160,220,.45);
                   border-radius: 10px; padding: 12px 14px; box-shadow: 0 8px 26px rgba(0,0,0,.55);
                   backdrop-filter: blur(4px); }
      #info-card[data-visible="false"] { display: none; }
      #info-card h2 { margin: 0 0 8px; font-size: 17px; letter-spacing: .06em;
                      text-transform: capitalize; color: #9fd0ff; font-weight: 600; }
      #info-card .row { display: flex; justify-content: space-between; gap: 8px;
                        font-size: 12px; padding: 3px 0; border-bottom: 1px solid rgba(120,160,220,.14); }
      #info-card .row:last-child { border-bottom: none; }
      #info-card .k { color: #8fa3bf; }
      #info-card .v { color: #eaf2ff; font-variant-numeric: tabular-nums; }
      #speed-panel { position: fixed; left: 22px; bottom: 20px; display: flex; gap: 6px;
                     background: rgba(12,16,26,.78); border: 1px solid rgba(120,160,220,.35);
                     border-radius: 9px; padding: 6px; }
      #speed-panel button { pointer-events: auto; cursor: pointer; font: 12px/1 "Segoe UI", sans-serif;
                     min-width: 46px; padding: 8px 6px; border-radius: 6px; color: #c8d6ea;
                     background: #18202e; border: 1px solid #2b3a52; transition: all .12s; }
      #speed-panel button:hover { background: #22304a; }
      #speed-panel button[aria-pressed="true"] { background: #2f6fd0; border-color: #6aa9ff;
                     color: #fff; box-shadow: 0 0 10px rgba(90,160,255,.55); }
      #reset { position: fixed; top: 20px; right: 24px; pointer-events: auto; cursor: pointer;
                   font: 12px/1 "Segoe UI", sans-serif; padding: 9px 16px; border-radius: 7px;
                   color: #ffd9d9; background: #3a1d22; border: 1px solid #7a3a44; }
      #reset:hover { background: #4d262d; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'hud';
    root.setAttribute('data-ui', 'hud');

    const card = document.createElement('div');
    card.id = 'info-card';
    card.className = 'panel';
    card.setAttribute('data-ui', 'info-card');
    card.setAttribute('aria-label', 'info-card');
    card.setAttribute('data-visible', 'false');
    card.setAttribute('role', 'dialog');
    const h2 = document.createElement('h2');
    h2.setAttribute('data-ui', 'info-card-name');
    card.appendChild(h2);
    const fields = document.createElement('div');
    fields.setAttribute('data-ui', 'info-card-fields');
    card.appendChild(fields);

    const speedPanel = document.createElement('div');
    speedPanel.id = 'speed-panel';
    speedPanel.className = 'panel';
    speedPanel.setAttribute('data-ui', 'time-controls');
    speedPanel.setAttribute('aria-label', 'time-controls');
    const SPEEDS = [0.5, 1, 2, 4, 8];
    const btns = SPEEDS.map((s) => {
        const b = document.createElement('button');
        const label = `${s}x`;
        b.textContent = label;
        b.type = 'button';
        b.id = `speed-${label}`;
        b.setAttribute('data-ui', `speed-${label}`);
        b.setAttribute('aria-label', `speed-${label}`);
        b.setAttribute('aria-pressed', s === 1 ? 'true' : 'false');
        b.addEventListener('click', () => setTimeScale(s));
        speedPanel.appendChild(b);
        return { value: s, el: b };
    });

    const resetBtn = document.createElement('button');
    resetBtn.id = 'reset';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.setAttribute('data-ui', 'reset');
    resetBtn.setAttribute('aria-label', 'reset');
    resetBtn.addEventListener('click', () => resetScene());

    root.appendChild(card);
    root.appendChild(speedPanel);
    root.appendChild(resetBtn);
    document.body.appendChild(root);

    ui.root = root;
    ui.card = card;
    ui.cardName = h2;
    ui.cardFields = fields;
    ui.speedBtns = btns;
    ui.resetBtn = resetBtn;
}

function setTimeScale(next) {
    if (![0.5, 1, 2, 4, 8].includes(next)) return;
    state.timeScale = next;
    for (const b of ui.speedBtns) b.el.setAttribute('aria-pressed', b.value === next ? 'true' : 'false');
}

function updateInfoCard() {
    if (!ui.card) return;
    const def = state.selected ? byName[state.selected] : null;
    if (!def) {
        ui.card.setAttribute('data-visible', 'false');
        ui.cardName.textContent = '';
        ui.cardFields.textContent = '';
        return;
    }
    const d = def.def;
    ui.card.setAttribute('data-visible', 'true');
    ui.cardName.textContent = d.name;
    const rows = [
        ['Type', d.type],
        ['Orbital period', `${d.period} sim s`],
        ['Orbit radius', `${d.orbit.toFixed(1)} AU*`],
        ['Body radius', `${(d.radius * 6371 / 0.66).toFixed(0)} km*`],
        ['Moons', String(d.moons.length)],
    ];
    ui.cardFields.textContent = '';
    for (const [k, v] of rows) {
        const row = document.createElement('div');
        row.className = 'row';
        const ks = document.createElement('span');
        ks.className = 'k';
        ks.textContent = k;
        const vs = document.createElement('span');
        vs.className = 'v';
        vs.textContent = v;
        row.appendChild(ks);
        row.appendChild(vs);
        ui.cardFields.appendChild(row);
    }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
let sphereMesh = null; // 单位球共享一份 Mesh

function buildScene() {
    scene = new Scene('orrery');

    // --- 相机(4.0-alpha 必须显式设置 visibility)---
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    const d = CAM.distance;
    cameraNode.setPosition(new Vec3(0, d * Math.sin(CAM.elevation), d * Math.cos(CAM.elevation)));
    cameraNode.lookAt(new Vec3(0, CAM.lookAtY, 0));
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = CAM.fovY;
    cameraComp.near = 0.5;
    cameraComp.far = 900;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(4, 5, 10, 255); // 深空近黑
    cameraComp.visibility = Layers.Enum.DEFAULT;
    cameraComp.priority = 0;

    // --- 光照:一盏主平行光 + 冷色环境光(恒星本身用 unlit 自发光)---
    const lightNode = new Node('Key Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(6, 18, 12));
    lightNode.setRotationFromEuler(-38, 34, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 52000;

    sphereMesh = createMesh(primitives.sphere(1, { segments: 24 }));

    // --- 恒星:高亮核心 + 面向相机的两层光晕环 ---
    // 为什么用"环"而不是同心球:同心不透明球会互相遮挡,同心透明球又依赖排序;
    // 面向相机的中空环永远只在核心外缘出现,渲染顺序稳定。
    const sunGeo = primitives.sphere(1, { segments: 32 });
    addMeshNode(scene, 'sun-core', sunGeo, materialUnlit([255, 246, 214], 255), 1.5);
    // 光晕:加色混合(ONE/ONE),亮度由颜色本身编码 → 近黑背景上可预测的"亮→暗"柔和衰减
    const sunGlowA = addMeshNode(scene, 'sun-glow-1',
        annulusGeometry(1.0, 1.18, 96, 'xy'), materialAdditive([255, 226, 150]), 1.5);
    const sunGlowB = addMeshNode(scene, 'sun-glow-2',
        annulusGeometry(1.18, 1.45, 96, 'xy'), materialAdditive([150, 82, 26]), 1.5);
    const sunGlowC = addMeshNode(scene, 'sun-glow-3',
        annulusGeometry(1.45, 1.85, 96, 'xy'), materialAdditive([64, 34, 12]), 1.5);
    billboards.push(sunGlowA, sunGlowB, sunGlowC);

    // --- 轨道参考线(细、淡)---
    const orbitMat = materialUnlit([104, 120, 148], 210);
    for (const def of PLANETS) {
        const g = annulusGeometry(def.orbit - 0.016, def.orbit + 0.016, 256, 'xz');
        addMeshNode(scene, `orbit-${def.name}`, g, orbitMat);
    }

    // --- 行星 / 卫星 / 环 / 条纹 ---
    const ringMat = materialUnlit([214, 196, 158], 165);
    PLANETS.forEach((def, idx) => {
        const pivot = new Node(`planet-${def.name}`);
        scene.addChild(pivot);
        pivot.setPosition(new Vec3(Math.cos(idx * 45 * DEG) * def.orbit, 0, Math.sin(idx * 45 * DEG) * def.orbit));

        const mat = materialStandard(def.color, { roughness: 0.9, metallic: 0.0 });
        const meshNode = new Node(`${def.name}-body`);
        meshNode.layer = Layers.Enum.DEFAULT;
        pivot.addChild(meshNode);
        const mr = meshNode.addComponent(MeshRenderer);
        mr.mesh = sphereMesh;              // 共享单位球,靠 scale 体现层级尺寸
        mr.material = mat;
        meshNode.setScale(new Vec3(def.radius, def.radius, def.radius));

        // 气态巨行星的"条纹感":赤道附近的几条细窄色带(挂在未缩放的 pivot 上)
        if (def.bands) {
            const bandColors = [
                [def.color[0] * 0.82, def.color[1] * 0.78, def.color[2] * 0.70],
                [def.color[0] * 1.02, def.color[1] * 0.96, def.color[2] * 0.86],
                [def.color[0] * 0.74, def.color[1] * 0.70, def.color[2] * 0.62],
            ];
            [-0.30, 0.10, 0.44].forEach((lat, bi) => {
                const rr = Math.cos(lat) * def.radius * 1.012;
                const h = def.radius * 0.15;
                const g = primitives.cylinder(rr, rr, h, { radialSegments: 32, capped: false });
                const bn = addMeshNode(pivot, `${def.name}-band-${bi}`, g,
                    materialUnlit([bandColors[bi][0] | 0, bandColors[bi][1] | 0, bandColors[bi][2] | 0], 255));
                bn.setPosition(new Vec3(0, Math.sin(lat) * def.radius, 0));
            });
        }

        // 行星环(土星):赤道面环形带,略微倾斜以便初始视角可辨
        if (def.ring) {
            const ringGeo = annulusGeometry(def.radius * 1.35, def.radius * 2.2, 160, 'xz');
            const ringNode = addMeshNode(pivot, `${def.name}-ring`, ringGeo, ringMat);
            ringNode.setRotationFromEuler(14, 0, 9);
        }

        // 卫星:父节点 = 行星 pivot → 天然随行星公转
        const moons = def.moons.map((m, mi) => {
            const node = new Node(`${def.name}-${m.name}`);
            node.layer = Layers.Enum.DEFAULT;
            pivot.addChild(node);
            const mr2 = node.addComponent(MeshRenderer);
            mr2.mesh = sphereMesh;
            mr2.material = materialStandard(m.color, { roughness: 0.95, metallic: 0.0 });
            node.setScale(new Vec3(m.radius, m.radius, m.radius));
            return { ...m, node, phase: idx * 45 * DEG + mi * Math.PI * 0.7, def: m };
        });

        const rec = {
            def,
            index: idx,
            pivot,
            meshNode,
            mat,
            baseColor: def.color.slice(),
            moons,
            angle: idx * 45 * DEG,
        };
        planetRecords.push(rec);
        byName[def.name] = rec;
    });

    // --- 小行星带:12 条同心细环 × 60 颗独立石块 = 720 颗 ---
    const rand = mulberry32(20261024);
    const beltRoot = new Node('asteroid-belt');
    scene.addChild(beltRoot);
    const shades = [[142, 128, 112], [120, 108, 96], [158, 142, 124]];
    const bandWidth = (BELT.outer - BELT.inner) / BELT.bands;
    for (let b = 0; b < BELT.bands; b++) {
        const rCenter = BELT.inner + bandWidth * (b + 0.5);
        const buf = { positions: [], normals: [], indices: [] };
        for (let i = 0; i < BELT.perBand; i++) {
            const a = (i / BELT.perBand) * TAU + rand() * 0.09;
            const r = rCenter + (rand() * 2 - 1) * bandWidth * 0.42;
            const y = (rand() * 2 - 1) * 0.14;
            const size = 0.09 + rand() * 0.16;
            pushRock(buf, Math.cos(a) * r, y, Math.sin(a) * r, size, rand);
        }
        const mat = materialUnlit(shades[b % shades.length], 255);
        const node = new Node(`belt-${b}`);
        node.layer = Layers.Enum.DEFAULT;
        beltRoot.addChild(node);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = createMesh(buf);
        mr.material = mat;
        beltBands.push({ node, omega: 0.062 / Math.sqrt(rCenter), phase: rand() * TAU });
    }

    // --- 背景星(静态,一次 draw call)---
    const starBuf = { positions: [], normals: [], indices: [] };
    const srand = mulberry32(77123);
    for (let i = 0; i < 760; i++) {
        const u = srand() * 2 - 1;
        const theta = srand() * TAU;
        const s = Math.sqrt(1 - u * u);
        const rr = 150;
        pushRock(starBuf, Math.cos(theta) * s * rr, u * rr, Math.sin(theta) * s * rr,
            0.16 + srand() * 0.3, srand);
    }
    addMeshNode(scene, 'star-field', starBuf, materialUnlit([196, 214, 246], 255));

    // --- 选中高亮圈(面向相机的圆环)---
    const hlGeo = annulusGeometry(1.0, 1.14, 72, 'xy');
    highlightNode = addMeshNode(scene, 'selection-ring', hlGeo, materialUnlit([120, 232, 255], 235));
    highlightNode.active = false;
}

// ---------------------------------------------------------------------------
// 模拟驱动
// ---------------------------------------------------------------------------
class OrreryDriver extends Component {
    update(dt) {
        const step = Math.min(Math.max(dt, 0), 0.1); // 后台节流恢复时不跳变
        state.simTime += step * state.timeScale;

        // fps:最近 2s 滚动平均
        const now = performance.now() / 1000;
        fpsBuf.push([now, dt]);
        while (fpsBuf.length > 2 && now - fpsBuf[0][0] > 2) fpsBuf.shift();
        let sum = 0;
        for (const e of fpsBuf) sum += e[1];
        if (sum > 0) state.fps = fpsBuf.length / sum;

        for (const rec of planetRecords) {
            const a = rec.index * 45 * DEG + (TAU * state.simTime) / rec.def.period;
            rec.angle = a;
            rec.pivot.setPosition(new Vec3(Math.cos(a) * rec.def.orbit, 0, Math.sin(a) * rec.def.orbit));
            rec.meshNode.setRotationFromEuler(0, (TAU * state.simTime) / rec.def.spin, 0);
            for (const m of rec.moons) {
                const ma = m.phase + (TAU * state.simTime) / m.period;
                m.node.setPosition(new Vec3(Math.cos(ma) * m.dist, 0.0, Math.sin(ma) * m.dist));
                m.node.setRotationFromEuler(0, ma * 3, 0.3);
            }
        }

        for (const band of beltBands) {
            band.node.setRotationFromEuler(0, band.phase + state.simTime * band.omega, 0);
        }

        // 太阳光晕环:始终面向相机
        const camWorld = cameraNode.worldPosition;
        for (const bb of billboards) {
            bb.lookAt(new Vec3(camWorld.x, camWorld.y, camWorld.z));
        }

        if (state.selected && byName[state.selected]) {
            const rec = byName[state.selected];
            const p = rec.pivot.worldPosition;
            highlightNode.setPosition(new Vec3(p.x, p.y, p.z));
            const cam = cameraNode.worldPosition;
            highlightNode.lookAt(new Vec3(cam.x, cam.y, cam.z));
            const s = rec.def.radius * 1.9;
            highlightNode.setScale(new Vec3(s, s, s));
            highlightNode.active = true;
        } else if (highlightNode.active) {
            highlightNode.active = false;
        }
    }
}

// ---------------------------------------------------------------------------
// 屏幕投影 / 点击拾取
// ---------------------------------------------------------------------------
const _tmpScreen = new Vec3();

function projectToCss(worldPos) {
    if (!cameraComp || !cameraComp.camera) return null;
    const rc = cameraComp.camera;           // 渲染相机:width/height 为物理像素
    if (!rc.width || !rc.height) return null;
    const cw = (canvasEl && canvasEl.clientWidth) || window.innerWidth;
    const ch = (canvasEl && canvasEl.clientHeight) || window.innerHeight;
    const out = cameraComp.worldToScreen(worldPos, _tmpScreen);
    if (!out) return null;
    // worldToScreen:左下原点、物理像素 → CSS 左上原点
    return {
        x: (out.x / rc.width) * cw,
        y: (1 - out.y / rc.height) * ch,
        w: cw,
        h: ch,
    };
}

function computePickTargets() {
    const targets = [];
    if (!cameraComp) return targets;
    const rc = cameraComp.camera;
    const chCss = (canvasEl && canvasEl.clientHeight) || window.innerHeight;
    const fh = rc ? rc.height : chCss;
    const camPos = cameraNode ? cameraNode.worldPosition : new Vec3();
    const focal = fh / (2 * Math.tan((cameraComp.fov * DEG) / 2));
    for (const rec of planetRecords) {
        const wp = rec.pivot.worldPosition;
        const sp = projectToCss(new Vec3(wp.x, wp.y, wp.z));
        if (!sp) continue;
        const dist = Math.hypot(wp.x - camPos.x, wp.y - camPos.y, wp.z - camPos.z) || 1;
        const projectedCss = (rec.def.radius * focal) / dist * (chCss / fh);
        // 契约:屏幕投影半径不低于 8px;小天体靠"最小可选圈"保证可点击
        const screenRadius = Math.max(projectedCss, 12);
        targets.push({
            name: rec.def.name,
            screenX: Math.round(sp.x * 10) / 10,
            screenY: Math.round(sp.y * 10) / 10,
            screenRadius: Math.round(screenRadius * 10) / 10,
        });
    }
    return targets;
}

function pickAt(cssX, cssY) {
    const targets = computePickTargets();
    let best = null;
    let bestD = Infinity;
    for (const t of targets) {
        const d = Math.hypot(t.screenX - cssX, t.screenY - cssY);
        if (d <= t.screenRadius + 5 && d < bestD) {
            bestD = d;
            best = t.name;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// 选中 / 复位
// ---------------------------------------------------------------------------
function setSelected(name) {
    state.selected = name;
    for (const rec of planetRecords) {
        const isSel = rec.def.name === name;
        const c = rec.baseColor;
        // 选中时提亮本体(每个行星独占材质,不会串色)
        const k = isSel ? 1.55 : 1.0;
        rec.mat.setProperty('mainColor', new Color(
            Math.min(255, Math.round(c[0] * k)),
            Math.min(255, Math.round(c[1] * k)),
            Math.min(255, Math.round(c[2] * k)),
            255,
        ));
        if (isSel) {
            rec.mat.setProperty('emissive', new Color(60, 120, 150, 255));
        } else {
            rec.mat.setProperty('emissive', new Color(0, 0, 0, 255));
        }
    }
    updateInfoCard();
}

function resetScene() {
    state.simTime = 0;
    setTimeScale(1);
    setSelected(null);
    state.epoch += 1;
    if (highlightNode) highlightNode.active = false;
}

// 点击拾取:window capture 阶段(pal 会吃掉 canvas 上的原生鼠标事件)
function onPointerDown(e) {
    if (!state.ready) return;
    if (e.button !== undefined && e.button !== 0) return;
    const target = e.target;
    if (target && target !== canvasEl) return; // UI 覆盖层自己的点击
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const hit = pickAt(x, y);
    setSelected(hit); // 点空白 → null,不产生选中
}

// ---------------------------------------------------------------------------
// 对外状态
// ---------------------------------------------------------------------------
function getState() {
    const targets = computePickTargets();
    const selDef = state.selected ? byName[state.selected] : null;
    return {
        planetCount: planetRecords.length,
        moonCount: planetRecords.reduce((n, r) => n + r.moons.length, 0),
        asteroidCount: BELT.bands * BELT.perBand,
        ringedPlanetCount: PLANETS.filter((p) => p.ring).length,
        timeScale: state.timeScale,
        simulationTime: state.simTime,
        selectedPlanet: state.selected,
        planets: planetRecords.map((r) => ({
            name: r.def.name,
            orbitRadius: r.def.orbit,
            orbitAngle: r.angle,
        })),
        pickTargets: targets,
        infoCard: {
            visible: !!(selDef && ui.card && ui.card.getAttribute('data-visible') === 'true'),
            name: selDef ? selDef.def.name : '',
            fieldCount: selDef ? ui.cardFields.children.length : 0,
        },
        fps: Math.round(state.fps * 10) / 10,
        epoch: state.epoch,
    };
}

window.__appReady = false;
window.__bench = {
    getState,
    reset: () => resetScene(),
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    buildUi();

    canvasEl = document.querySelector('#GameCanvas');
    app = await createAirApp({ canvas: canvasEl });

    buildScene();
    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 之后经 scene.globals 生效(模板已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.16, 0.2, 0.3, 1.0);
    scene.globals.ambient.skyIllum = 16000;

    // 驱动组件:挂在场景根的一个空节点上
    const driverNode = new Node('driver');
    scene.addChild(driverNode);
    driverNode.addComponent(OrreryDriver);

    window.addEventListener('pointerdown', onPointerDown, true);

    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) {
            state.ready = true;
            window.__appReady = true;
        }
    });

    updateInfoCard();
    console.log('[orrery] ready — planets', planetRecords.length);
} catch (err) {
    console.error('[orrery] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
