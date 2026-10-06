/**
 * E03 — 太阳系仪(Orrery)cocosair 实现(K0 冷启动)
 *
 * 引擎 API 依据:本 Arm 内 dist/vendor/cocosair.module.js(dev bundle,页面自身加载的模块)
 *   + knowledge/README.md + 模板 src/main.js 已验证写法。全部只读来源位于本 Arm 目录内。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): object, reset(): void }(spec.json stateContract 全字段)。
 *   - UI 控件带 data-ui + aria-label:speed-0.5x/1x/2x/4x/8x、reset、timeControls、info-card。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    director,
    Director,
    Material,
} from 'cocosair.js';

// ============================== 常量与数据 ==============================

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// 8 颗行星:按轨道半径升序;公转周期(模拟秒)单调递增,最内 240(120–240 ✓),
// 最外 3400(1600–4000 ✓);颜色线性空间(Color 0–255),岩质灰褐锈红/气态米黄/冰巨蓝青。
const PLANET_DEFS = [
    { name: 'mercury', radius: 1.0,  orbit: 6.5,  period: 190,  spinPeriod: 14, color: [138, 126, 112], kind: '岩质行星' },
    { name: 'venus',   radius: 1.35, orbit: 9.5,  period: 420,  spinPeriod: 22, color: [222, 172, 108], kind: '岩质行星' },
    { name: 'earth',   radius: 1.45, orbit: 13.0, period: 700,  spinPeriod: 10, color: [72, 122, 210],  kind: '岩质行星' },
    { name: 'mars',    radius: 1.15, orbit: 17.0, period: 1050, spinPeriod: 11, color: [196, 92, 60],   kind: '岩质行星' },
    { name: 'jupiter', radius: 3.4,  orbit: 24.5, period: 1500, spinPeriod: 6,  color: [214, 180, 138], kind: '气态巨行星' },
    { name: 'saturn',  radius: 2.9,  orbit: 31.0, period: 2050, spinPeriod: 7,  color: [226, 200, 154], kind: '气态巨行星' },
    { name: 'uranus',  radius: 2.1,  orbit: 37.5, period: 2700, spinPeriod: 9,  color: [120, 205, 220], kind: '冰巨行星' },
    { name: 'neptune', radius: 2.0,  orbit: 44.0, period: 3400, spinPeriod: 9,  color: [70, 108, 230],  kind: '冰巨行星' },
];

// 卫星:父子层级(挂在 planetNode 下),公转周期 8–40 模拟秒 ✓,共 6 颗(≥2 ✓)
const MOON_DEFS = [
    { name: 'moon',   parent: 'earth',   dist: 2.9, radius: 0.55, period: 20 },
    { name: 'phobos', parent: 'mars',    dist: 2.2, radius: 0.32, period: 9 },
    { name: 'io',     parent: 'jupiter', dist: 5.0, radius: 0.62, period: 12 },
    { name: 'europa', parent: 'jupiter', dist: 6.4, radius: 0.50, period: 28 },
    { name: 'titan',  parent: 'saturn',  dist: 6.6, radius: 0.60, period: 34 },
    { name: 'triton', parent: 'neptune', dist: 3.2, radius: 0.52, period: 16 },
];

// 小行星带:≥500 个独立小天体(Node+MeshRenderer 各自独立渲染),位于第 4/5 条轨道之间
const ASTEROID_COUNT = 700;
const BELT_INNER = 19.0;
const BELT_OUTER = 22.6;

const SUN_RADIUS = 3.7;

// 相机:斜俯视 40°(30–60 ✓),距离按 8 条轨道占屏宽 ~67% 取值(fov 45 / 16:9)
const CAM_ELEV = 40 * DEG;
const CAM_DIST = 106;
const CAM_FOV = 45;
const CAM_MIN_DIST = 60;
const CAM_MAX_DIST = 200;

// gfx BlendFactor/BlendOp 枚举值(引擎 bundle 内核对):SRC_ALPHA=2, ONE_MINUS_SRC_ALPHA=4, ADD=0
const BLEND_SRC_ALPHA = 2;
const BLEND_ONE_MINUS_SRC_ALPHA = 4;
const BLEND_OP_ADD = 0;

// ============================== 运行时状态 ==============================

const state = {
    simTime: 0,          // 模拟秒(1x:1 实时秒 = 1 模拟秒)
    timeScale: 1,        // ∈ {0.5, 1, 2, 4, 8}
    epoch: 0,            // reset 计数
    selected: null,      // 选中行星名(小写英文)或 null
    planets: [],         // { def, angle(初始 k*45°), node, spinNode }
    moons: [],           // { def, angle0, angle, node }
    asteroids: [],       // { angle0, angle, radius, y, omega, node }
    pickTargets: [],     // { name, screenX, screenY, screenRadius } 每帧更新(CSS px)
    fps: 0,              // 最近 2s 滚动平均
    frameTimes: [],      // 渲染帧时间戳(ms)
};

// 相机(可在小范围内拖拽/滚轮,可选增强)
const cam = { azimuth: 0, dist: CAM_DIST };
let canvasEl = null;
let viewW = 1280;
let viewH = 720;
let camBasis = { px: 0, py: 0, pz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: -1, fz: 0 };

let sceneRoot = null;
let highlightNode = null;
let cardEl = null;
let cardTitleEl = null;
let cardRowsEl = null;
const speedButtons = {};

// ============================== DOM / UI ==============================

function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
#orrery-panel{position:fixed;top:10px;right:10px;z-index:100;display:flex;flex-direction:column;gap:8px;
  padding:10px 12px;background:rgba(9,13,24,0.78);border:1px solid #2a3654;border-radius:10px;
  font:12px/1.4 system-ui,sans-serif;color:#dfe6f2;user-select:none}
#orrery-panel .cap{font-size:11px;letter-spacing:1px;color:#8fa0bd}
#orrery-speeds{display:flex;gap:6px}
.ctl-btn{padding:5px 10px;font:12px system-ui,sans-serif;background:#141c30;color:#dfe6f2;
  border:1px solid #38466a;border-radius:6px;cursor:pointer}
.ctl-btn:hover{background:#1d2946}
.ctl-btn.active{background:#ffcf4d;color:#1c1608;border-color:#ffcf4d;font-weight:700}
#orrery-reset{margin-top:2px;background:#241418;border-color:#6a3844;color:#f0d9dd}
#orrery-reset:hover{background:#3a1d24}
#info-card{position:fixed;z-index:90;min-width:200px;display:none;pointer-events:none;
  padding:10px 12px;background:rgba(8,12,22,0.88);border:1px solid #3a4a6e;border-radius:10px;
  font:13px/1.5 system-ui,sans-serif;color:#e8edf6;box-shadow:0 4px 18px rgba(0,0,0,0.55)}
#info-card h3{margin:0 0 6px;font-size:15px;color:#ffd984;letter-spacing:0.5px}
#info-card table{border-collapse:collapse}
#info-card td{padding:1px 8px 1px 0;white-space:nowrap}
#info-card td.k{color:#93a4c2}
#info-card td.v{color:#f2f6ff;font-weight:600}
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'orrery-panel';
    panel.setAttribute('data-ui', 'timeControls');
    panel.setAttribute('aria-label', 'timeControls');
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = '时间倍率';
    const speeds = document.createElement('div');
    speeds.id = 'orrery-speeds';
    for (const v of [0.5, 1, 2, 4, 8]) {
        const b = document.createElement('button');
        const key = 'speed-' + String(v) + 'x';
        b.className = 'ctl-btn';
        b.textContent = String(v) + 'x';
        b.setAttribute('data-ui', key);
        b.setAttribute('aria-label', key);
        b.addEventListener('click', () => setSpeed(v));
        speeds.appendChild(b);
        speedButtons[String(v)] = b;
    }
    const resetBtn = document.createElement('button');
    resetBtn.id = 'orrery-reset';
    resetBtn.className = 'ctl-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.setAttribute('data-ui', 'reset');
    resetBtn.setAttribute('aria-label', 'reset');
    resetBtn.addEventListener('click', () => doReset());
    panel.appendChild(cap);
    panel.appendChild(speeds);
    panel.appendChild(resetBtn);
    document.body.appendChild(panel);
    refreshSpeedButtons();

    cardEl = document.createElement('div');
    cardEl.id = 'info-card';
    cardEl.setAttribute('data-ui', 'info-card');
    cardEl.setAttribute('aria-label', 'info-card');
    cardTitleEl = document.createElement('h3');
    cardRowsEl = document.createElement('table');
    cardEl.appendChild(cardTitleEl);
    cardEl.appendChild(cardRowsEl);
    document.body.appendChild(cardEl);
}

function setSpeed(v) {
    state.timeScale = v;
    refreshSpeedButtons();
}

function refreshSpeedButtons() {
    for (const k of Object.keys(speedButtons)) {
        speedButtons[k].classList.toggle('active', Number(k) === state.timeScale);
    }
}

function moonCountOf(name) {
    let n = 0;
    for (const m of MOON_DEFS) if (m.parent === name) n++;
    return n;
}

function showInfoCard(planet) {
    const def = planet.def;
    cardTitleEl.textContent = def.name;
    const rows = [
        ['类型', def.kind],
        ['轨道半径', def.orbit.toFixed(1) + ' 距离单位'],
        ['公转周期', def.period + ' 模拟秒'],
        ['卫星数量', moonCountOf(def.name) + ' 颗'],
    ];
    cardRowsEl.innerHTML = rows
        .map((r) => `<tr><td class="k">${r[0]}</td><td class="v">${r[1]}</td></tr>`)
        .join('');
    cardEl.style.display = 'block';
}

function hideInfoCard() {
    cardEl.style.display = 'none';
}

function infoCardState() {
    const visible = state.selected != null && cardEl.style.display !== 'none';
    return {
        visible,
        name: visible ? state.selected : '',
        fieldCount: visible ? 4 : 0,
    };
}

// ============================== 材质与几何 ==============================

function makeMaterial(effectName, colorRGBA, blend) {
    const m = new Material();
    const info = {
        effectName,
        defines: effectName === 'builtin-unlit' ? { USE_TEXTURE: false } : {},
    };
    if (blend) {
        info.states = [{
            blendState: {
                targets: [{
                    blend: true,
                    blendSrc: BLEND_SRC_ALPHA,
                    blendDst: BLEND_ONE_MINUS_SRC_ALPHA,
                    blendEq: BLEND_OP_ADD,
                    blendSrcAlpha: BLEND_SRC_ALPHA,
                    blendDstAlpha: BLEND_ONE_MINUS_SRC_ALPHA,
                    blendAlphaEq: BLEND_OP_ADD,
                }],
            },
            depthStencilState: { depthWrite: false },
        }];
    }
    m.initialize(info);
    m.setProperty('mainColor', new Color(colorRGBA[0], colorRGBA[1], colorRGBA[2], colorRGBA[3] === undefined ? 255 : colorRGBA[3]));
    return m;
}

function sphereMesh(radius, segments) {
    return utils.createMesh(primitives.sphere(radius, { segments }));
}

// ============================== 场景构建 ==============================

function addSphereNode(parent, name, radius, segments, material) {
    const n = new Node(name);
    n.layer = Layers.Enum.DEFAULT;
    parent.addChild(n);
    const mr = n.addComponent(MeshRenderer);
    mr.mesh = sphereMesh(radius, segments);
    mr.material = material;
    return n;
}

function buildScene(app) {
    sceneRoot = new Scene('orrery');

    // 相机
    const cameraNode = new Node('Main Camera');
    sceneRoot.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, CAM_DIST * Math.sin(CAM_ELEV), CAM_DIST * Math.cos(CAM_ELEV)));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CAM_FOV;
    camera.near = 1;
    camera.far = 600;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(6, 8, 14, 255); // 深空近黑
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    state.cameraNode = cameraNode;

    // 方向光 + 环境
    const lightNode = new Node('Main Light');
    sceneRoot.addChild(lightNode);
    lightNode.setRotationFromEuler(-50, -25, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 50000;

    // 太阳:暖黄高亮核心 + 双层柔和光晕(混合,不写深度),全画面最亮元素
    const sunCore = addSphereNode(sceneRoot, 'sun-core', SUN_RADIUS, 48, makeMaterial('builtin-unlit', [255, 233, 150, 255], false));
    sunCore.setPosition(0, 0, 0);
    const haloIn = addSphereNode(sceneRoot, 'sun-halo-in', SUN_RADIUS * 1.7, 32, makeMaterial('builtin-unlit', [255, 178, 64, 150], true));
    haloIn.setPosition(0, 0, 0);
    const haloOut = addSphereNode(sceneRoot, 'sun-halo-out', SUN_RADIUS * 2.6, 32, makeMaterial('builtin-unlit', [255, 140, 40, 95], true));
    haloOut.setPosition(0, 0, 0);

    // 轨道参考线:8 条细淡同心圆(低不透明度灰,细管圆环)
    const orbitMat = makeMaterial('builtin-unlit', [36, 42, 56, 255], false);
    for (const def of PLANET_DEFS) {
        const line = new Node('orbit-' + def.name);
        line.layer = Layers.Enum.DEFAULT;
        sceneRoot.addChild(line);
        const mr = line.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.torus(def.orbit, 0.06, { radialSegments: 4, tubularSegments: 128 }));
        mr.material = orbitMat;
    }

    // 行星:planetNode(仅位移,不旋转)→ spinNode(自转 + 球体);卫星/环挂在 planetNode 下
    const moonMat = makeMaterial('builtin-standard', [196, 194, 186, 255], false);
    for (let k = 0; k < PLANET_DEFS.length; k++) {
        const def = PLANET_DEFS[k];
        const planetNode = new Node('planet-' + def.name);
        planetNode.layer = Layers.Enum.DEFAULT;
        sceneRoot.addChild(planetNode);
        const spinNode = new Node('spin-' + def.name);
        spinNode.layer = Layers.Enum.DEFAULT;
        planetNode.addChild(spinNode);
        const mr = spinNode.addComponent(MeshRenderer);
        mr.mesh = sphereMesh(def.radius, 36);
        mr.material = makeMaterial('builtin-standard', [def.color[0], def.color[1], def.color[2], 255], false);

        const p = { def, angle: k * 45 * DEG, angle0: k * 45 * DEG, node: planetNode, spinNode, spinAngle0: (k * 37) % 360 };
        state.planets.push(p);

        if (def.name === 'saturn') {
            // 行星环:半透明扁平圆环,倾斜使初始视角可辨
            const ringMat = makeMaterial('builtin-unlit', [216, 190, 140, 168], true);
            const ring = new Node('ring-saturn');
            ring.layer = Layers.Enum.DEFAULT;
            planetNode.addChild(ring);
            const rmr = ring.addComponent(MeshRenderer);
            rmr.mesh = utils.createMesh(primitives.torus(4.7, 1.05, { radialSegments: 20, tubularSegments: 72 }));
            rmr.material = ringMat;
            ring.setScale(1, 0.14, 1);
            ring.setRotationFromEuler(11, 0, 9);
            p.hasRing = true;
        }
    }

    // 卫星(父子层级:挂在行星节点下)
    for (const mdef of MOON_DEFS) {
        const planet = state.planets.find((p) => p.def.name === mdef.parent);
        const moonNode = addSphereNode(planet.node, 'moon-' + mdef.name, mdef.radius, 16, moonMat);
        state.moons.push({ def: mdef, angle0: (state.moons.length * 73 * DEG) % TAU, angle: 0, node: moonNode });
    }
    for (const m of state.moons) m.angle = m.angle0;

    // 小行星带:独立于行星层级,520 个独立小天体
    const beltGroup = new Node('asteroid-belt');
    beltGroup.layer = Layers.Enum.DEFAULT;
    sceneRoot.addChild(beltGroup);
    const beltMesh = utils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
    const beltMat = makeMaterial('builtin-unlit', [104, 95, 84, 255], false);
    for (let i = 0; i < ASTEROID_COUNT; i++) {
        const t = i / ASTEROID_COUNT;
        // 半径在带内非均匀抖动;角速度按半径分层(内快外慢,类开普勒)
        const radius = BELT_INNER + (BELT_OUTER - BELT_INNER) * ((t * 7.13) % 1);
        const y = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 1.6 - 0.8;
        const scale = 0.16 + ((i * 2654435761) % 97) / 97 * 0.28;
        const node = new Node('asteroid-' + i);
        node.layer = Layers.Enum.DEFAULT;
        beltGroup.addChild(node);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = beltMesh;
        mr.material = beltMat;
        node.setScale(scale, scale * (0.6 + ((i * 31) % 17) / 42), scale);
        node.setRotationFromEuler((i * 47) % 360, (i * 83) % 360, (i * 29) % 360);
        const omega = TAU / (950 + (radius - BELT_INNER) / (BELT_OUTER - BELT_INNER) * 350);
        state.asteroids.push({ angle0: (t * TAU * 13.7) % TAU, angle: 0, radius, y, omega, node });
    }
    for (const a of state.asteroids) a.angle = a.angle0;

    // 选中高亮圈:单节点,选中时跟随行星位置,水平细圆环(初始视角下呈椭圆可辨)
    highlightNode = new Node('selection-highlight');
    highlightNode.layer = Layers.Enum.DEFAULT;
    sceneRoot.addChild(highlightNode);
    const hmr = highlightNode.addComponent(MeshRenderer);
    hmr.mesh = utils.createMesh(primitives.torus(1, 0.06, { radialSegments: 6, tubularSegments: 96 }));
    hmr.material = makeMaterial('builtin-unlit', [92, 226, 255, 255], false);
    highlightNode.active = false;

    const updaterNode = new Node('orrery-updater');
    sceneRoot.addChild(updaterNode);
    updaterNode.addComponent(OrreryUpdater);
    return sceneRoot;
}

// ============================== 相机与投影 ==============================

const scratchVec = new Vec3(0, 0, 0);

function applyCamera() {
    if (!state.cameraNode) return;
    const cy = Math.cos(cam.azimuth);
    const sy = Math.sin(cam.azimuth);
    scratchVec.set(cam.dist * Math.cos(CAM_ELEV) * sy, cam.dist * Math.sin(CAM_ELEV), cam.dist * Math.cos(CAM_ELEV) * cy);
    state.cameraNode.setPosition(scratchVec);
    state.cameraNode.lookAt(new Vec3(0, 0, 0));
    updateCamBasis();
}

function updateCamBasis() {
    const cy = Math.cos(cam.azimuth);
    const sy = Math.sin(cam.azimuth);
    const se = Math.sin(CAM_ELEV);
    const ce = Math.cos(CAM_ELEV);
    const px = cam.dist * ce * sy;
    const py = cam.dist * se;
    const pz = cam.dist * ce * cy;
    // forward = normalize(origin - pos)
    const fl = Math.hypot(px, py, pz);
    const fx = -px / fl, fy = -py / fl, fz = -pz / fl;
    // right = normalize(cross(forward, up(0,1,0)))
    let rx = -fz, ry = 0, rz = fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; rz /= rl;
    // up = cross(right, forward)
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    camBasis = { px, py, pz, rx, ry, rz, ux, uy, uz, fx, fy, fz };
}

function refreshViewSize() {
    if (!canvasEl) return;
    viewW = canvasEl.clientWidth || 1280;
    viewH = canvasEl.clientHeight || 720;
}

// 世界 → 屏幕(CSS 像素,原点左上)。与引擎 lookAt(+Y up)同基准的解析投影。
function projectPoint(wx, wy, wz) {
    const relx = wx - camBasis.px;
    const rely = wy - camBasis.py;
    const relz = wz - camBasis.pz;
    const depth = relx * camBasis.fx + rely * camBasis.fy + relz * camBasis.fz;
    const xc = relx * camBasis.rx + rely * camBasis.ry + relz * camBasis.rz;
    const yc = relx * camBasis.ux + rely * camBasis.uy + relz * camBasis.uz;
    const tanHalf = Math.tan(CAM_FOV * 0.5 * DEG);
    const aspect = viewW / viewH;
    const sx = (xc / (depth * tanHalf * aspect) + 1) * 0.5 * viewW;
    const sy = (1 - (yc / (depth * tanHalf) + 1) * 0.5) * viewH;
    return { sx, sy, depth };
}

function updatePickTargets() {
    const tanHalf = Math.tan(CAM_FOV * 0.5 * DEG);
    const pxPerUnit = (viewH * 0.5) / tanHalf;
    const out = [];
    for (const p of state.planets) {
        const wx = Math.cos(p.angle) * p.def.orbit;
        const wz = Math.sin(p.angle) * p.def.orbit;
        const pr = projectPoint(wx, 0, wz);
        const rProj = (p.def.radius / pr.depth) * pxPerUnit;
        out.push({
            name: p.def.name,
            screenX: pr.sx,
            screenY: pr.sy,
            screenRadius: Math.max(rProj, 9), // 契约:screenRadius >= 8 CSS px
            depth: pr.depth,
        });
    }
    state.pickTargets = out;
}

// ============================== 选中 / 信息卡 / Reset ==============================

function selectPlanet(planet) {
    state.selected = planet ? planet.def.name : null;
    if (planet) {
        highlightNode.active = true;
        const s = planet.def.radius * 1.9;
        highlightNode.setScale(s, s, s);
        showInfoCard(planet);
    } else {
        highlightNode.active = false;
        hideInfoCard();
    }
}

function tryPick(cx, cy) {
    let best = null;
    let bestD = Infinity;
    for (const t of state.pickTargets) {
        const d = Math.hypot(cx - t.screenX, cy - t.screenY);
        const pickR = Math.min(Math.max(t.screenRadius + 6, 14), 55);
        if (d <= pickR && d < bestD) {
            best = t;
            bestD = d;
        }
    }
    if (best) {
        selectPlanet(state.planets.find((p) => p.def.name === best.name));
    } else {
        selectPlanet(null); // 点击空白:取消选中 / 不产生选中(NC04)
    }
}

function doReset() {
    state.simTime = 0;
    state.timeScale = 1;
    state.selected = null;
    for (const p of state.planets) {
        p.angle = p.angle0;
        p.node.setPosition(Math.cos(p.angle) * p.def.orbit, 0, Math.sin(p.angle) * p.def.orbit);
        p.spinNode.setRotationFromEuler(0, p.spinAngle0, 0);
    }
    for (const m of state.moons) {
        m.angle = m.angle0;
        m.node.setPosition(Math.cos(m.angle) * m.def.dist, 0, Math.sin(m.angle) * m.def.dist);
    }
    for (const a of state.asteroids) {
        a.angle = a.angle0;
        a.node.setPosition(Math.cos(a.angle) * a.radius, a.y, Math.sin(a.angle) * a.radius);
    }
    highlightNode.active = false;
    hideInfoCard();
    refreshSpeedButtons();
    state.epoch += 1; // 不刷新页面,渲染连续
}

// ============================== 每帧更新器 ==============================

class OrreryUpdater extends Component {
    update(dt) {
        if (!(dt > 0)) return;
        if (dt > 0.1) dt = 0.1; // 后台标签页恢复防跳变
        const ts = state.timeScale;
        const adv = dt * ts;
        state.simTime += adv;

        for (const p of state.planets) {
            p.angle += adv * (TAU / p.def.period); // 公转分层:内快外慢(类开普勒)
            p.node.setPosition(Math.cos(p.angle) * p.def.orbit, 0, Math.sin(p.angle) * p.def.orbit);
            const spin = (p.spinAngle0 + state.simTime * (360 / p.def.spinPeriod)) % 360;
            p.spinNode.setRotationFromEuler(0, spin, 0);
        }
        for (const m of state.moons) {
            m.angle += adv * (TAU / m.def.period);
            m.node.setPosition(Math.cos(m.angle) * m.def.dist, 0, Math.sin(m.angle) * m.def.dist);
        }
        for (const a of state.asteroids) {
            a.angle += adv * a.omega;
            a.node.setPosition(Math.cos(a.angle) * a.radius, a.y, Math.sin(a.angle) * a.radius);
        }

        // 选中高亮跟随 + 屏幕投影 + 信息卡定位
        if (state.selected != null) {
            const p = state.planets.find((q) => q.def.name === state.selected);
            if (p) highlightNode.setPosition(Math.cos(p.angle) * p.def.orbit, 0, Math.sin(p.angle) * p.def.orbit);
        }
        updatePickTargets();
        positionInfoCard();
    }
}

function positionInfoCard() {
    if (state.selected == null || cardEl.style.display === 'none') return;
    const t = state.pickTargets.find((q) => q.name === state.selected);
    if (!t) return;
    const cardW = cardEl.offsetWidth || 210;
    const cardH = cardEl.offsetHeight || 120;
    let left = t.screenX + t.screenRadius + 14;
    if (left + cardW > viewW - 8) left = t.screenX - t.screenRadius - 14 - cardW;
    let top = t.screenY - cardH / 2;
    top = Math.max(8, Math.min(viewH - cardH - 8, top));
    left = Math.max(8, Math.min(viewW - cardW - 8, left));
    cardEl.style.left = left + 'px';
    cardEl.style.top = top + 'px';
}

// ============================== FPS(2s 滚动平均) ==============================

function noteFrame() {
    const now = performance.now();
    const ft = state.frameTimes;
    ft.push(now);
    while (ft.length > 2 && now - ft[0] > 2000) ft.shift();
    if (ft.length >= 2) {
        const span = (ft[ft.length - 1] - ft[0]) / 1000;
        state.fps = span > 0 ? (ft.length - 1) / span : 0;
    }
}

// ============================== 输入(点击选中 / 空白取消 / 可选相机) ==============================

function bindInput() {
    let downX = 0, downY = 0, onUI = false, dragged = false;
    const inUI = (e) => !!(e.target && e.target.closest && e.target.closest('[data-ui]'));
    window.addEventListener('pointerdown', (e) => {
        downX = e.clientX; downY = e.clientY; onUI = inUI(e); dragged = false;
    }, true);
    window.addEventListener('pointermove', (e) => {
        if (onUI || !(e.buttons & 1)) return;
        const dx = e.clientX - downX, dy = e.clientY - downY;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
            dragged = true;
            cam.azimuth += dx * 0.005;
            downX = e.clientX; downY = e.clientY;
            applyCamera();
        }
    }, true);
    window.addEventListener('pointerup', (e) => {
        if (onUI) return;
        if (dragged) { dragged = false; return; }
        tryPick(e.clientX, e.clientY);
    }, true);
    // pal 层会吞 canvas wheel:capture 监听(已知引擎坑位)
    window.addEventListener('wheel', (e) => {
        if (inUI(e)) return;
        if (e.preventDefault) e.preventDefault();
        cam.dist = Math.min(CAM_MAX_DIST, Math.max(CAM_MIN_DIST, cam.dist * Math.exp(e.deltaY * 0.0009)));
        applyCamera();
    }, { capture: true, passive: false });
    window.addEventListener('resize', refreshViewSize);
}

// ============================== 启动 ==============================

const stateForBench = {
    frame: 0,
};

window.__appReady = false;
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        planetCount: state.planets.length,
        moonCount: state.moons.length,
        asteroidCount: state.asteroids.length, // 真实渲染的独立小天体数量
        ringedPlanetCount: state.planets.filter((p) => p.hasRing).length,
        timeScale: state.timeScale,
        simulationTime: state.simTime,
        selectedPlanet: state.selected,
        planets: state.planets.map((p) => ({ name: p.def.name, orbitRadius: p.def.orbit, orbitAngle: p.angle })),
        pickTargets: state.pickTargets.map((t) => ({ name: t.name, screenX: t.screenX, screenY: t.screenY, screenRadius: t.screenRadius })),
        infoCard: infoCardState(),
        fps: state.fps,
        epoch: state.epoch,
        frame: stateForBench.frame,
    }),
    reset: doReset,
};

try {
    canvasEl = document.querySelector('#GameCanvas');
    refreshViewSize();
    buildUI();
    bindInput();

    const app = await createAirApp({ canvas: canvasEl });
    const scene = buildScene(app);
    updateCamBasis();
    for (const p of state.planets) {
        p.node.setPosition(Math.cos(p.angle) * p.def.orbit, 0, Math.sin(p.angle) * p.def.orbit);
    }

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同官方示例)
    app.run(scene);

    // 环境光(app.run 后经 scene.globals 配置;模板已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.3, 0.36, 0.48, 1.0);
    scene.globals.ambient.skyIllum = 16000;

    // 首帧就绪 + 帧率采样(Director 事件,同模板口径)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        stateForBench.frame += 1;
        noteFrame();
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[orrery] running on cocosair');
} catch (err) {
    console.error('[orrery] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
