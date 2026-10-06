/**
 * E03 — 太阳系仪(Orrery)cocosair 实现
 *
 * 场景:中心恒星(发光球 + 加色光晕)+ 8 颗分层公转行星(开普勒式周期压缩)+ 4 颗卫星
 * (行星子节点,构成父子层级)+ 土星半透明环 + 560 个独立小天体的小行星带 + 8 条轨道参考线。
 * 交互:点击行星投影区选中(DOM 信息卡 + 高亮圈)、点空白取消、时间倍率 0.5x–8x 真实作用于
 * 模拟时钟、Reset 软复位(无页面刷新)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(Director.EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): object, reset(): void }(字段口径见 spec.json stateContract)。
 *
 * 引擎坑位对策(本 Arm 实测/bundle 勘察):
 *   - Camera.visibility 必须显式 = Layers.Enum.DEFAULT(4.0-alpha 默认 undefined);
 *   - 环境光在 app.run 后经 scene.globals.ambient 原位 set(模板已验证路径);
 *   - 材质 FLOAT4 属性一律传 Color 实例(setProperty 普通数组 → NaN);
 *   - 透明/加色混合经 Material.initialize 的 states 覆盖(blendState/depthStencilState/
 *     rasterizerState,Pass.fillPipelineInfo 消费);unlit frag 输出 mainColor.a,混合有效;
 *   - canvas 指针事件被 pal 层吞:拾取监听挂 window 捕获阶段(先于 pal 的 target 阶段
 *     stopPropagation 生效);忽略 target 非 canvas 的事件,避免 UI 按钮触发拾取;
 *   - worldToScreen 输出为 GL 底左原点约定,上报 pickTargets 时翻转为左上原点 CSS 比例
 *     (翻转方向已由截图对照自检验证)。
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

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 状态(单一事实源)

const state = {
    timeScale: 1,            // ∈ {0.5, 1, 2, 4, 8}
    simTime: 0,              // 模拟秒(1x:1 实时秒 = 1 模拟秒)
    selectedPlanet: null,    // 小写行星名 | null
    epoch: 0,                // reset 计数
    frame: 0,
    fps: 0,
    pickTargets: [],         // 每帧更新 [{name, screenX, screenY, screenRadius, _px, _py, _pickR}]
    infoCard: { visible: false, name: '', fieldCount: 0 },
};

// ---------------------------------------------------------------- 天体参数表

// 公转周期按 r^1.5 压缩:mercury 240 模拟秒(内侧界),neptune 3453(1600–4000 内),单调递增。
// 初始轨道角 = 序号 × 45°。
const PLANET_DEFS = [
    { name: 'mercury', orbitRadius: 6.0,  size: 0.55, period: 240,   color: [156, 143, 128], type: 'rocky' },
    { name: 'venus',   orbitRadius: 8.0,  size: 0.80, period: 369.5, color: [200, 160, 106], type: 'rocky' },
    { name: 'earth',   orbitRadius: 10.5, size: 0.85, period: 555.6, color: [ 79, 134, 192], type: 'rocky' },
    { name: 'mars',    orbitRadius: 13.0, size: 0.70, period: 765.5, color: [181,  83,  60], type: 'rocky' },
    { name: 'jupiter', orbitRadius: 21.0, size: 1.90, period: 1571.5, color: [201, 169, 122], type: 'gas giant' },
    { name: 'saturn',  orbitRadius: 26.0, size: 1.60, period: 2165,  color: [216, 192, 144], type: 'gas giant' },
    { name: 'uranus',  orbitRadius: 31.0, size: 1.15, period: 2817,  color: [127, 196, 207], type: 'ice giant' },
    { name: 'neptune', orbitRadius: 35.5, size: 1.05, period: 3453,  color: [ 74, 111, 212], type: 'ice giant' },
];

const MOON_DEFS = [
    { parent: 'earth',   name: 'luna',   size: 0.22, orbit: 1.7, period: 16 },
    { parent: 'jupiter', name: 'io',     size: 0.24, orbit: 2.6, period: 10 },
    { parent: 'jupiter', name: 'europa', size: 0.20, orbit: 3.4, period: 20 },
    { parent: 'saturn',  name: 'titan',  size: 0.22, orbit: 4.3, period: 14 },
];

const BELT = {
    count: 560,          // ≥ 500 个独立小天体(状态报告值 = 真实渲染数)
    rInner: 15.0,        // 第 4(mars 13)与第 5(jupiter 21)条轨道之间
    rOuter: 17.5,
    ySpread: 0.4,
    basePeriod: 2000,    // 带整体基准公转周期(模拟秒),带内个体 ×(0.7–1.3) 分层
};

const MIN_PICK_RADIUS_PX = 12; // pickTargets.screenRadius 下限(≥ 8 CSS px 可点击)

// 运行时句柄
const planets = [];   // {def, node, angle, baseAngle, moons:[{def,node,phase}], highlight}
const asteroids = []; // {node, r, phi, omega, y}
let cameraComp = null;
let cameraNode = null;
let canvasEl = null;

// ---------------------------------------------------------------- 材质工具

function makeUnlit(r, g, b, a, opts) {
    const m = new Material();
    const init = { effectName: 'builtin-unlit', defines: { USE_TEXTURE: false } };
    if (opts && opts.blend) {
        // 半透明:normal blend;加色光晕:blendDst = ONE
        const dst = opts.additive ? 1 : 4; // BlendFactor.ONE=1 / ONE_MINUS_SRC_ALPHA=4
        init.states = {
            blendState: {
                targets: [{ blend: true, blendSrc: 2, blendDst: dst, blendSrcAlpha: 2, blendDstAlpha: dst }],
            },
            depthStencilState: { depthWrite: false },
            rasterizerState: { cullMode: 0 }, // CullMode.NONE,环面/参考线双面可见
        };
    }
    m.initialize(init);
    m.setProperty('mainColor', new Color(r, g, b, a)); // FLOAT4 必须传 Color 实例
    return m;
}

// XZ 平面环形网格(轨道参考线 / 行星环 / 高亮圈共用)
function annulusGeometry(inner, outer, segments) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const a = t * TAU;
        const c = Math.cos(a);
        const s = Math.sin(a);
        positions.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
        normals.push(0, 1, 0, 0, 1, 0);
        uvs.push(t, 0, t, 1);
        if (i < segments) {
            const k = i * 2;
            indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
    }
    return { positions, normals, uvs, indices };
}

function addMeshNode(parent, name, mesh, material, layer) {
    const node = new Node(name);
    node.layer = layer;
    node.setPosition(0, 0, 0);
    parent.addChild(node);
    const renderer = node.addComponent(MeshRenderer);
    renderer.mesh = mesh;
    renderer.material = material;
    return node;
}

// ---------------------------------------------------------------- UI 覆盖层(DOM)

const ui = {};

function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
        .orrery-ui { position: fixed; z-index: 9999; font: 12px/1.4 sans-serif; user-select: none; }
        .orrery-time { left: 16px; bottom: 14px; display: flex; gap: 6px; }
        .orrery-time button { padding: 5px 12px; font: 12px sans-serif; background: #1b2130;
            color: #cfd6e4; border: 1px solid #46506a; border-radius: 4px; cursor: pointer; }
        .orrery-time button.active { background: #3d78c8; color: #fff; border-color: #6fa2e8; }
        .orrery-reset { right: 16px; bottom: 14px; }
        .orrery-reset button { padding: 5px 16px; font: 12px sans-serif; background: #1b2130;
            color: #cfd6e4; border: 1px solid #46506a; border-radius: 4px; cursor: pointer; }
        .orrery-card { top: 64px; right: 12px; width: 224px; background: rgba(12, 16, 26, 0.92);
            border: 1px solid #46506a; border-radius: 6px; padding: 10px 12px; color: #e8edf6; }
        .orrery-card h3 { margin: 0 0 6px; font-size: 15px; color: #ffd97a; letter-spacing: 1px; }
        .orrery-card table { border-collapse: collapse; width: 100%; }
        .orrery-card td { padding: 2px 0; vertical-align: top; }
        .orrery-card td.k { color: #93a0b8; padding-right: 10px; white-space: nowrap; }
    `;
    document.head.appendChild(style);

    // 时间倍率五档(0.5x / 1x / 2x / 4x / 8x),当前档位高亮
    ui.speedWrap = document.createElement('div');
    ui.speedWrap.className = 'orrery-ui orrery-time';
    ui.speedButtons = {};
    for (const v of [0.5, 1, 2, 4, 8]) {
        const btn = document.createElement('button');
        btn.textContent = `${v}x`;
        btn.id = `ui-speed-${v}x`;
        btn.setAttribute('data-ui', `speed-${v}x`);
        btn.setAttribute('aria-label', `speed-${v}x`);
        btn.addEventListener('click', () => setTimeScale(v));
        ui.speedWrap.appendChild(btn);
        ui.speedButtons[v] = btn;
    }
    document.body.appendChild(ui.speedWrap);

    // Reset 按钮
    ui.resetWrap = document.createElement('div');
    ui.resetWrap.className = 'orrery-ui orrery-reset';
    ui.resetBtn = document.createElement('button');
    ui.resetBtn.textContent = 'Reset';
    ui.resetBtn.id = 'ui-reset';
    ui.resetBtn.setAttribute('data-ui', 'reset');
    ui.resetBtn.setAttribute('aria-label', 'reset');
    ui.resetBtn.addEventListener('click', () => doReset());
    ui.resetWrap.appendChild(ui.resetBtn);
    document.body.appendChild(ui.resetWrap);

    // 信息卡(点击驱动,初始隐藏)
    ui.card = document.createElement('div');
    ui.card.className = 'orrery-ui orrery-card';
    ui.card.id = 'ui-info-card';
    ui.card.setAttribute('data-ui', 'info-card');
    ui.card.style.display = 'none';
    document.body.appendChild(ui.card);

    markActiveSpeed();
}

function markActiveSpeed() {
    for (const [v, btn] of Object.entries(ui.speedButtons)) {
        const cls = 'active';
        if (Number(v) === state.timeScale) btn.classList.add(cls);
        else btn.classList.remove(cls);
    }
}

function setTimeScale(v) {
    if (![0.5, 1, 2, 4, 8].includes(v)) return;
    state.timeScale = v;
    markActiveSpeed();
}

function showInfoCard(planet) {
    const def = planet.def;
    const moonNames = planet.moons.map((m) => m.def.name).join(', ') || 'none';
    const fields = [
        ['type', def.type],
        ['orbital period', `${def.period} sim s`],
        ['orbit radius', `${def.orbitRadius.toFixed(1)} units`],
        ['moons', `${moonNames.length ? moonNames : 'none'} (${planet.moons.length})`],
    ];
    // 表格行数即 fieldCount(名称之外的数据字段 ≥ 3)
    ui.card.innerHTML =
        `<h3>${def.name}</h3><table>` +
        fields.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('') +
        `</table>`;
    ui.card.style.display = 'block';
    state.infoCard = { visible: true, name: def.name, fieldCount: fields.length };
}

function hideInfoCard() {
    ui.card.style.display = 'none';
    state.infoCard = { visible: false, name: '', fieldCount: 0 };
}

function doReset() {
    state.simTime = 0;
    state.timeScale = 1;
    state.selectedPlanet = null;
    state.epoch += 1;
    hideInfoCard();
    for (const p of planets) setHighlight(p, false);
    markActiveSpeed();
    // 轨道角 = f(simTime) 在下一帧 update 自动回到 k × 45°;渲染不中断、无页面刷新。
}

// ---------------------------------------------------------------- 拾取与选中

function setHighlight(planet, on) {
    if (planet.highlight) planet.highlight.active = on;
}

function pickAtClientPoint(clientX, clientY) {
    let best = null;
    let bestD = Infinity;
    for (const pt of state.pickTargets) {
        const dx = clientX - pt._px;
        const dy = clientY - pt._py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= pt._pickR && d < bestD) {
            best = pt.name;
            bestD = d;
        }
    }
    return best;
}

function installPickListener() {
    // pal 层会在 canvas target 阶段 stopPropagation 吞掉指针事件 → 挂 window 捕获阶段,
    // 先于一切 target 监听执行;仅接受 target 为 canvas 的事件(UI 按钮点击不参与拾取)。
    window.addEventListener(
        'pointerdown',
        (e) => {
            if (e.target !== canvasEl) return;
            const name = pickAtClientPoint(e.clientX, e.clientY);
            if (name) {
                state.selectedPlanet = name;
                for (const p of planets) setHighlight(p, p.def.name === name);
                showInfoCard(planets.find((p) => p.def.name === name));
            } else {
                state.selectedPlanet = null;
                for (const p of planets) setHighlight(p, false);
                hideInfoCard();
            }
        },
        true,
    );
}

// ---------------------------------------------------------------- 每帧行为组件

class FpsTracker {
    constructor() {
        this.frames = [];
    }
    tick(now) {
        this.frames.push(now);
        const cutoff = now - 2000;
        while (this.frames.length && this.frames[0] < cutoff) this.frames.shift();
        const span = Math.min(now - this.frames[0], 2000);
        this.fpsValue = span >= 500 ? (this.frames.length * 1000) / span : 0;
        return this.fpsValue;
    }
}
const fpsTracker = new FpsTracker();

class OrreryController extends Component {
    update(dt) {
        // 模拟时钟:倍率真实作用于时间步进(0.5x–8x 全档即时变速,连续无跳变)
        const ts = state.timeScale;
        if (dt > 0.1) dt = 0.1; // 后台节流恢复后防大步长跳变
        state.simTime += dt * ts;
        const t = state.simTime;

        // 行星公转:orbitAngle 连续累计不取模
        for (const p of planets) {
            const ang = p.def.baseAngle + (TAU * t) / p.def.period;
            p.angle = ang;
            const r = p.def.orbitRadius;
            p.node.setPosition(r * Math.cos(ang), 0, r * Math.sin(ang));
            // 卫星(子节点局部坐标,随行星公转 — 父子层级)
            for (const m of p.moons) {
                const ma = m.def.phase + (TAU * t) / m.def.period;
                m.node.setPosition(m.def.orbit * Math.cos(ma), 0, m.def.orbit * Math.sin(ma));
            }
        }

        // 小行星带:整体缓慢流动 + 带内速度分层
        for (const a of asteroids) {
            const ang = a.phi + a.omega * t;
            a.node.setPosition(a.r * Math.cos(ang), a.y, a.r * Math.sin(ang));
        }

        // pickTargets:每帧更新屏幕投影(CSS 像素比例,左上原点)
        updatePickTargets();
    }
}

const _wp = new Vec3();
const _cp = new Vec3();
function updatePickTargets() {
    if (!cameraComp) return;
    const vw = canvasEl ? canvasEl.clientWidth : 1280;
    const vh = canvasEl ? canvasEl.clientHeight : 720;
    cameraNode.getWorldPosition(_cp);
    const focal = vh / 2 / Math.tan((cameraComp.fov * DEG) / 2);
    cameraComp.node.getWorldPosition(_cp);
    const out = [];
    for (const p of planets) {
        p.node.getWorldPosition(_wp);
        const dx = _wp.x - _cp.x;
        const dy = _wp.y - _cp.y;
        const dz = _wp.z - _cp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const s = cameraComp.worldToScreen(_wp, new Vec3());
        const projR = (p.def.size * focal) / Math.max(dist, 0.001);
        const pickR = Math.max(projR, MIN_PICK_RADIUS_PX);
        out.push({
            name: p.def.name,
            screenX: s.x / vw,
            screenY: 1 - s.y / vh, // 引擎 worldToScreen 为底左原点 → 翻转为左上
            screenRadius: pickR,
            _px: s.x,
            _py: vh - s.y,
            _pickR: pickR,
        });
    }
    state.pickTargets = out;
}

// ---------------------------------------------------------------- 场景构建

async function buildScene() {
    canvasEl = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas: canvasEl });

    const scene = new Scene('orrery');

    // Camera:斜俯视 ~38°,海王星轨道直径约占画布宽 78%(65%–80% 区间)
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 38, 48));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = 45;
    cameraComp.near = 0.5;
    cameraComp.far = 400;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(4, 6, 12, 255); // 深空近黑
    cameraComp.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式设置
    cameraComp.priority = 0;

    // 光照(HDR 量级,同模板)
    const lightNode = new Node('Sun Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 10, 0));
    lightNode.setRotationFromEuler(-45, -30, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 50000;

    const L = Layers.Enum.DEFAULT;

    // 恒星:不发光材质无法表现"最亮元素",直接用 unlit 暖黄高亮 + 双层加色光晕
    const sunMesh = utils.createMesh(primitives.sphere(2.0, { segments: 32 }));
    const sunMat = makeUnlit(255, 240, 170, 255);
    addMeshNode(scene, 'sun', sunMesh, sunMat, L);
    const glowMatOuter = makeUnlit(255, 190, 80, 64, { blend: true, additive: true });
    const glowMatInner = makeUnlit(255, 214, 120, 96, { blend: true, additive: true });
    addMeshNode(scene, 'sun-glow-outer', utils.createMesh(primitives.sphere(4.8, { segments: 24 })), glowMatOuter, L);
    addMeshNode(scene, 'sun-glow-inner', utils.createMesh(primitives.sphere(3.1, { segments: 24 })), glowMatInner, L);

    // 行星 + 卫星 + 环 + 高亮圈
    const highlightGeo = utils.createMesh(annulusGeometry(0.72, 1.0, 48));
    const highlightMat = makeUnlit(130, 255, 190, 220, { blend: true });
    const ringGeo = utils.createMesh(annulusGeometry(2.1, 3.4, 96));
    const ringMat = makeUnlit(226, 210, 170, 140, { blend: true }); // 半透明环面

    PLANET_DEFS.forEach((def, k) => {
        def.baseAngle = k * (TAU / 8); // 第 k 颗初始角 = k × 45°
        const node = new Node(def.name);
        node.layer = L;
        scene.addChild(node);

        const mesh = utils.createMesh(primitives.sphere(def.size, { segments: 24 }));
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-standard' });
        mat.setProperty('mainColor', new Color(def.color[0], def.color[1], def.color[2], 255));
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = mesh;
        renderer.material = mat;

        const planet = { def, node, angle: def.baseAngle, moons: [], highlight: null };

        // 土星环(倾斜,初始斜俯视可辨)
        if (def.name === 'saturn') {
            const ringNode = addMeshNode(node, 'saturn-ring', ringGeo, ringMat, L);
            ringNode.setRotationFromEuler(24, 0, 8);
        }

        // 卫星:行星子节点(父子层级,随行星公转)
        for (const mdef of MOON_DEFS.filter((m) => m.parent === def.name)) {
            mdef.phase = planet.moons.length * 2.1 + 0.7;
            const mnode = new Node(mdef.name);
            mnode.layer = L;
            mnode.setPosition(mdef.orbit, 0, 0);
            node.addChild(mnode);
            const mm = mnode.addComponent(MeshRenderer);
            mm.mesh = utils.createMesh(primitives.sphere(mdef.size, { segments: 12 }));
            const mmat = makeUnlit(196, 192, 184, 255);
            mm.material = mmat;
            planet.moons.push({ def: mdef, node: mnode });
        }

        // 选中高亮圈(初始隐藏,选中时激活,随行星移动)
        const hl = addMeshNode(node, `hl-${def.name}`, highlightGeo, highlightMat, L);
        hl.setScale(def.size * 2.1, 1, def.size * 2.1);
        hl.active = false;
        planet.highlight = hl;

        node.setPosition(
            def.orbitRadius * Math.cos(def.baseAngle),
            0,
            def.orbitRadius * Math.sin(def.baseAngle),
        );
        planets.push(planet);
    });

    // 轨道参考线:细淡低不透明度
    const orbitMat = makeUnlit(255, 255, 255, 64, { blend: true });
    for (const def of PLANET_DEFS) {
        const geo = utils.createMesh(annulusGeometry(def.orbitRadius - 0.05, def.orbitRadius + 0.05, 128));
        addMeshNode(scene, `orbit-${def.name}`, geo, orbitMat, L);
    }

    // 小行星带:560 个独立小天体(独立 Node + 共享 box 网格/材质,速度分层)
    const rockMesh = utils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
    const rockMat = makeUnlit(138, 122, 104, 255);
    const baseOmega = TAU / BELT.basePeriod;
    for (let i = 0; i < BELT.count; i++) {
        const r = BELT.rInner + (BELT.rOuter - BELT.rInner) * (i / (BELT.count - 1)) + (i % 5) * 0.021;
        const y = (((i * 37) % 17) / 17 - 0.5) * 2 * BELT.ySpread;
        const node = new Node(`asteroid-${i}`);
        node.layer = L;
        node.setPosition(r, y, 0);
        scene.addChild(node);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = rockMesh;
        renderer.material = rockMat;
        const s = 0.08 + ((i * 53) % 23) / 23 * 0.2;
        node.setScale(s, s * 0.8 + 0.03, s * 1.15);
        node.setRotationFromEuler((i * 31) % 90, (i * 17) % 360, (i * 13) % 90);
        asteroids.push({
            node,
            r,
            y,
            phi: (i * 2.399963) % TAU, // 黄金角散布
            omega: baseOmega * (0.7 + ((i * 41) % 61) / 61 * 0.6), // 带内速度分层
        });
    }

    scene.addChild(new Node('controller'));
    const controller = scene.children[scene.children.length - 1];
    controller.addComponent(OrreryController);

    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 后经 scene.globals 显式配置(HDR 量级,模板已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.35, 0.5, 0.75, 1.0);
    scene.globals.ambient.skyIllum = 20000;

    // 帧计数 + fps + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        state.fps = fpsTracker.tick(performance.now());
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[orrery] running on cocosair');
}

// ---------------------------------------------------------------- __bench 契约

window.__appReady = false;

function benchGetState() {
    return {
        planetCount: planets.length,
        moonCount: planets.reduce((n, p) => n + p.moons.length, 0),
        asteroidCount: asteroids.length,
        ringedPlanetCount: 1,
        timeScale: state.timeScale,
        simulationTime: state.simTime,
        selectedPlanet: state.selectedPlanet,
        planets: planets.map((p) => ({
            name: p.def.name,
            orbitRadius: p.def.orbitRadius,
            orbitAngle: p.angle !== undefined ? p.angle : p.def.baseAngle,
        })),
        pickTargets: state.pickTargets.map((pt) => ({
            name: pt.name,
            screenX: pt.screenX,
            screenY: pt.screenY,
            screenRadius: pt.screenRadius,
        })),
        infoCard: { ...state.infoCard },
        fps: state.fps,
        epoch: state.epoch,
    };
}

window.__bench = {
    getState: benchGetState,
    reset: doReset,
};

// ---------------------------------------------------------------- 启动

try {
    buildUI();
    installPickListener();
    await buildScene();
} catch (err) {
    // 致命错误(如 WebGL2 不可用)显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[orrery] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
