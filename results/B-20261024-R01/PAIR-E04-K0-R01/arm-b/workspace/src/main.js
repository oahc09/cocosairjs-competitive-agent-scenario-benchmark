/**
 * E04 — 城市烟花夜(City Fireworks Night)/ Cocos AIR 实现
 *
 * 结构:
 *   1) 正交相机把世界坐标钉死成「16:9 画面 = 16 x 9 世界单位」,点击坐标 → 世界坐标是纯线性映射;
 *      主相机只画 DEFAULT 层的夜空/城市,叠加相机(priority 1 + DEPTH_ONLY)只画 UI_2D 层的
 *      加性发光四边形(烟花粒子/航空灯/地平线辉光),保证粒子永远盖在城市之上。
 *   2) 夜空(渐变 + 星点)与城市(楼群 + 亮窗)各是一张静态网格,顶点色即颜色,单 draw call。
 *   3) 全部烟花粒子写进同一个动态网格(QuadField → Mesh.updateSubMesh),材质 = builtin-unlit
 *      的 USE_VERTEX_COLOR + USE_TEXTURE(运行时生成的径向光晕贴图),再用 MaterialInstance
 *      覆盖成加性混合 + 关深度测试。
 *   4) 时间线只有一处推进点(SceneDriver.update):enabled=false 时直接 return,所有粒子、
 *      自动发射与灯闪全部冻结;dt 上限 0.05s,失焦回来不会瞬移。
 */

import {
    Layers, createAirApp, Scene, Node, Camera, MeshRenderer, Material, Texture2D, ImageAsset,
    Vec3, Color, Component, director, Director, input, Input, utils, gfx,
} from 'cocosair.js';
import { MeshBuilder, QuadField } from './mesh-builder.js';
import { Fireworks, THEMES } from './fireworks.js';

// ---------------------------------------------------------------------------
// 状态与工具
// ---------------------------------------------------------------------------

const state = {
    fireworkCount: 0,
    autoShow: false,
    enabled: true,
    time: 0,
    autoTimer: 0.7,
    buildingCount: 0,
    ready: false,
};

/** 可复现的 32-bit PRNG(城市重生成需要真随机分布,不影响可复现构建)。 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rand = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

const fireworks = new Fireworks(rand, 4096);

window.__appReady = false;
window.__bench = {
    getState: () => ({
        fireworkCount: state.fireworkCount,
        particlesAlive: fireworks.alive,
        autoShow: state.autoShow,
        enabled: state.enabled,
        buildingCount: state.buildingCount,
    }),
    reset: () => resetAll(),
    // 仅供自检脚本做分层截图/材质排查,不暴露给探针状态。
    debug: {
        setFxVisible(v) { if (fxNode) fxNode.active = !!v; },
        setCityVisible(v) { if (cityNode) cityNode.active = !!v; },
        setSkyVisible(v) { if (skyNode) skyNode.active = !!v; },
        info() {
            const inst = fxRenderer && fxRenderer.getMaterialInstance(0);
            const pass = inst && inst.passes && inst.passes[0];
            const tgt = pass && pass.blendState && pass.blendState.targets[0];
            const bounds = (mesh) => {
                const st = mesh && mesh.struct;
                if (!st) return null;
                const bundle = st.vertexBundles && st.vertexBundles[0];
                return {
                    min: st.minPosition ? [st.minPosition.x, st.minPosition.y, st.minPosition.z] : null,
                    max: st.maxPosition ? [st.maxPosition.x, st.maxPosition.y, st.maxPosition.z] : null,
                    bundles: st.vertexBundles ? st.vertexBundles.map((b) => ({
                        count: b.view.count,
                        stride: b.view.stride,
                        attrs: b.attributes.map((a) => a.name + '@' + a.format),
                    })) : null,
                    primitiveCount: st.primitives ? st.primitives.length : 0,
                    bundle0Count: bundle ? bundle.view.count : null,
                };
            };
            return {
                blend: tgt ? {
                    blend: tgt.blend, src: tgt.blendSrc, dst: tgt.blendDst,
                    srcA: tgt.blendSrcAlpha, dstA: tgt.blendDstAlpha,
                } : null,
                depth: pass && pass.depthStencilState ? {
                    test: pass.depthStencilState.depthTest,
                    write: pass.depthStencilState.depthWrite,
                } : null,
                texValid: !!(glowTexture && glowTexture.validate && glowTexture.validate()),
                fxMesh: bounds(fxMesh),
                cityMesh: bounds(cityMesh),
            };
        },
    },
};

// ---------------------------------------------------------------------------
// DOM 覆盖层(不画进 3D 画面;控件固定 data-ui 且位于右上角)
// ---------------------------------------------------------------------------

function makeButton(uiName, label, top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-ui', uiName);
    btn.textContent = label;
    btn.style.cssText = [
        'position:fixed',
        `right:16px`,
        `top:${top}px`,
        'width:150px',
        'height:34px',
        'z-index:20',
        'padding:0 10px',
        'font:13px/1.1 "Segoe UI",system-ui,sans-serif',
        'letter-spacing:0.5px',
        'color:#e6ecff',
        'background:rgba(12,18,36,0.62)',
        'border:1px solid rgba(150,180,255,0.35)',
        'border-radius:6px',
        'cursor:pointer',
        'pointer-events:auto',
        'user-select:none',
    ].join(';');
    btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (uiName === 'auto-show') toggleAuto();
        else if (uiName === 'pause') togglePause();
        else resetAll();
    });
    document.body.appendChild(btn);
    return btn;
}

const uiAuto = makeButton('auto-show', '自动表演:关', 16);
const uiPause = makeButton('pause', '暂停', 58);
const uiReset = makeButton('reset', '重置', 100);
const uiControls = [uiAuto, uiPause, uiReset];

const hint = document.createElement('div');
hint.textContent = '点击夜空发射烟花 · 自动表演与暂停见右上角';
hint.style.cssText = [
    'position:fixed',
    'left:18px',
    'bottom:14px',
    'z-index:10',
    'font:12px/1.4 "Segoe UI",system-ui,sans-serif',
    'color:rgba(190,205,245,0.62)',
    'pointer-events:none',
    'text-shadow:0 1px 3px rgba(0,0,0,0.8)',
].join(';');
document.body.appendChild(hint);

function updateUi() {
    uiAuto.textContent = state.autoShow ? '自动表演:开' : '自动表演:关';
    uiAuto.style.borderColor = state.autoShow ? 'rgba(140,220,255,0.75)' : 'rgba(150,180,255,0.35)';
    uiPause.textContent = state.enabled ? '暂停' : '恢复';
    uiPause.style.borderColor = state.enabled ? 'rgba(150,180,255,0.35)' : 'rgba(255,190,120,0.8)';
    uiReset.style.borderColor = 'rgba(150,180,255,0.35)';
}

function toggleAuto() {
    state.autoShow = !state.autoShow;
    if (state.autoShow) state.autoTimer = 0.45 + rand() * 0.2;
    updateUi();
}

function togglePause() {
    state.enabled = !state.enabled;
    updateUi();
}

// ---------------------------------------------------------------------------
// 程序化贴图:径向光晕(运行时画到内存,不使用任何外部图片)
// ---------------------------------------------------------------------------

function createGlowTexture(size) {
    // 径向衰减写进 RGB(而不是只写 alpha):加性混合下 rgb 就是最终亮度,
    // 这样即使某条管线把 alpha 丢掉,粒子依然是柔和的圆形光斑而不是硬方块。
    const data = new Uint8Array(size * size * 4);
    const half = size / 2;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const dx = (x + 0.5 - half) / half;
            const dy = (y + 0.5 - half) / half;
            const r2 = dx * dx + dy * dy;
            const i = (y * size + x) * 4;
            const v = r2 >= 1 ? 0 : Math.round(255 * Math.pow(Math.max(0, 1 - r2), 1.6));
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    const tex = new Texture2D();
    tex.image = new ImageAsset({
        width: size,
        height: size,
        _data: data,
        _compressed: false,
        format: Texture2D.PixelFormat.RGBA8888,
    });
    return tex;
}

// ---------------------------------------------------------------------------
// 夜空:垂直渐变(逐行四边形)+ >=120 颗星点
// ---------------------------------------------------------------------------

const SKY_STOPS = [
    [0.00, [0.200, 0.125, 0.320]], // 地平线:城市光污染形成的紫红光带
    [0.06, [0.155, 0.100, 0.270]],
    [0.16, [0.095, 0.075, 0.210]],
    [0.32, [0.040, 0.042, 0.120]],
    [0.55, [0.018, 0.024, 0.070]],
    [0.78, [0.009, 0.013, 0.038]],
    [1.00, [0.005, 0.008, 0.024]],
];
const GROUND_SKY = [0.012, 0.016, 0.040];

function skyColorAt(t) {
    if (t <= 0) {
        // 地平线以下迅速压暗:剪影之后是深色地面,而不是一整片亮紫色。
        const k = clamp(1 + t / 0.18, 0, 1);
        const h = SKY_STOPS[0][1];
        return [
            GROUND_SKY[0] + (h[0] - GROUND_SKY[0]) * k,
            GROUND_SKY[1] + (h[1] - GROUND_SKY[1]) * k,
            GROUND_SKY[2] + (h[2] - GROUND_SKY[2]) * k,
        ];
    }
    const v = clamp(t, 0, 1);
    for (let i = 1; i < SKY_STOPS.length; i += 1) {
        const b = SKY_STOPS[i];
        if (v <= b[0]) {
            const a = SKY_STOPS[i - 1];
            const k = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
            return [
                a[1][0] + (b[1][0] - a[1][0]) * k,
                a[1][1] + (b[1][1] - a[1][1]) * k,
                a[1][2] + (b[1][2] - a[1][2]) * k,
            ];
        }
    }
    const last = SKY_STOPS[SKY_STOPS.length - 1][1];
    return [last[0], last[1], last[2]];
}

function buildSkyGeometry() {
    const b = new MeshBuilder();
    const horizonY = -2.7;
    const topY = 4.9;
    const bottomY = -4.9;
    const rows = 22;
    for (let i = 0; i < rows; i += 1) {
        const y0 = bottomY + ((topY - bottomY) * i) / rows;
        const y1 = bottomY + ((topY - bottomY) * (i + 1)) / rows;
        const t0 = (y0 - horizonY) / (topY - horizonY);
        const t1 = (y1 - horizonY) / (topY - horizonY);
        const c0 = skyColorAt(t0);
        const c1 = skyColorAt(t1);
        const yc = (y0 + y1) / 2;
        const hh = (y1 - y0) / 2;
        b.quadGradient(
            0, yc, -6, 9.2, hh,
            [c0[0], c0[1], c0[2], 1],
            [c0[0], c0[1], c0[2], 1],
            [c1[0], c1[1], c1[2], 1],
            [c1[0], c1[1], c1[2], 1],
        );
    }

    // 星点:>=120 颗,静态;颜色偏冷白,亮度分层避免"噪点感"。
    const stars = 168;
    for (let i = 0; i < stars; i += 1) {
        const x = -8.8 + rand() * 17.6;
        const y = -1.4 + rand() * 6.1;
        const big = rand() < 0.16;
        const size = big ? 0.030 + rand() * 0.026 : 0.014 + rand() * 0.016;
        const warm = rand() < 0.18;
        const shade = 0.32 + rand() * 0.68;
        const r = warm ? shade : shade * 0.86;
        const g = warm ? shade * 0.92 : shade * 0.92;
        const bl = warm ? shade * 0.78 : shade;
        b.quad(x, y, -5.9, size, size, [r, g, bl, 1]);
    }
    return b.geometry();
}

// ---------------------------------------------------------------------------
// 城市:28 栋程序化楼 + 亮窗 + 航空障碍灯位置
// ---------------------------------------------------------------------------

const CITY_LEFT = -8.7;
const CITY_RIGHT = 8.7;
const GROUND_BASE = -4.15;

const WINDOW_PALETTE = [
    [1.00, 0.82, 0.45],
    [1.00, 0.72, 0.32],
    [1.00, 0.90, 0.66],
    [0.98, 0.62, 0.28],
    [0.72, 0.86, 1.00],
];

function pickWindowColor() {
    const p = rand();
    if (p < 0.42) return WINDOW_PALETTE[0];
    if (p < 0.7) return WINDOW_PALETTE[1];
    if (p < 0.88) return WINDOW_PALETTE[2];
    if (p < 0.96) return WINDOW_PALETTE[3];
    return WINDOW_PALETTE[4];
}

function buildCity() {
    const b = new MeshBuilder();
    const lights = [];
    const buildings = 28;
    const span = CITY_RIGHT - CITY_LEFT;
    const cell = span / buildings;
    let windowCount = 0;

    for (let i = 0; i < buildings; i += 1) {
        const cx = CITY_LEFT + cell * (i + 0.5);
        const width = cell * (0.72 + rand() * 0.24);
        const distFromCenter = Math.abs(cx) / 8.7;
        let height = 1.0 + rand() * 1.35; // 约画面高 11% - 26%
        if (rand() < 0.2 && distFromCenter > 0.32) height += 0.55 + rand() * 0.5; // 侧翼高楼
        if (distFromCenter < 0.2) height = Math.min(height, 2.05); // 中央留出点击空域
        const top = GROUND_BASE + height;
        const bottom = GROUND_BASE;

        // 楼体:近黑,带一点蓝紫冷调;每栋亮度微差制造层次。
        const tint = 0.014 + rand() * 0.016;
        b.quad(cx, (top + bottom) / 2, 0, width / 2, height / 2, [
            tint * 0.9,
            tint * 1.12,
            tint * 1.95,
            1,
        ]);
        // 楼顶轮廓线(轻微提亮,避免整块纯黑)。
        b.quad(cx, top - 0.035, 0.02, width / 2, 0.035, [0.055, 0.068, 0.125, 1]);

        // 亮窗网格
        const cols = clamp(Math.round(width / 0.17), 2, 3);
        const rows = clamp(Math.round(height / 0.22), 3, 10);
        const cellW = width / cols;
        const cellH = (height - 0.14) / rows;
        for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
                if (rand() > 0.56) continue;
                const wx = cx - width / 2 + cellW * (c + 0.5);
                const wy = top - 0.16 - cellH * (r + 0.5);
                if (wy < bottom + 0.10) continue;
                const pal = pickWindowColor();
                const bright = 0.5 + rand() * 0.5;
                b.quad(
                    wx, wy, 0.04,
                    Math.min(0.030, cellW * 0.22),
                    Math.min(0.040, cellH * 0.24),
                    [pal[0] * bright, pal[1] * bright, pal[2] * bright, 1],
                );
                windowCount += 1;
            }
        }

        // 少数高楼顶的航空障碍灯(运行时在 FX 层闪烁)。
        if (height > 2.15 && rand() < 0.75) {
            lights.push({
                x: cx,
                y: top + 0.08,
                phase: rand() * Math.PI * 2,
                speed: 1.1 + rand() * 1.3,
            });
        }
    }

    return {
        geometry: b.geometry(),
        buildingCount: buildings,
        windowCount,
        lights,
    };
}

// ---------------------------------------------------------------------------
// 场景装配(引擎在顶层 await 里初始化)
// ---------------------------------------------------------------------------

const canvas = document.querySelector('#GameCanvas');
const PARTICLES_CAPACITY = 4096;
const FX_CAPACITY = PARTICLES_CAPACITY + 32;
const VIEW_HALF_HEIGHT = 4.5;

let app = null;
let cityRenderer = null;
let cityMaterial = null;
let cityMesh = null;
let cityLights = [];
let fxMesh = null;
let fxRenderer = null;
let fxField = null;
let fxNode = null;
let cityNode = null;
let skyNode = null;
let sceneReady = false;
let glowTexture = null;
let fxMaterialRef = null;
let lastFxGeometry = null;

function buildUnlitMaterial(defines) {
    const mat = new Material();
    mat.initialize({ effectName: 'builtin-unlit', defines });
    return mat;
}

/**
 * 加性 FX 材质。管线状态必须在 Material.initialize({ states }) 时就给出:
 * 渲染器首次 cook 时会把共享材质 copy 进 MaterialInstance,实例上的
 * overridePipelineStates 会被这次 copy 覆盖回默认值(表现为烟花是硬方块、
 * 地平线辉光变成不透明色块)。粒子颜色预乘 alpha,故混合因子用 ONE/ONE。
 */
function buildFxMaterial() {
    const blendState = new gfx.BlendState();
    blendState.isA2C = false;
    blendState.setTarget(0, {
        blend: true,
        blendSrc: gfx.BlendFactor.ONE,
        blendDst: gfx.BlendFactor.ONE,
        blendSrcAlpha: gfx.BlendFactor.ONE,
        blendDstAlpha: gfx.BlendFactor.ONE,
        blendEq: gfx.BlendOp.ADD,
        blendAlphaEq: gfx.BlendOp.ADD,
    });
    const ds = new gfx.DepthStencilState();
    ds.depthTest = false;
    ds.depthWrite = false;
    const mat = new Material();
    mat.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_VERTEX_COLOR: true, USE_TEXTURE: true },
        states: { blendState, depthStencilState: ds },
    });
    return mat;
}

function regenerateCity() {
    const city = buildCity();
    state.buildingCount = city.buildingCount;
    cityLights = city.lights;

    const oldMesh = cityMesh;
    cityMesh = utils.MeshUtils.createMesh(city.geometry);
    cityRenderer.mesh = cityMesh;
    if (oldMesh && oldMesh !== cityMesh) oldMesh.destroy();
}

/** 每帧重写 FX 动态网格:地平线辉光 + 航空灯 + 全部烟花粒子。 */
function rebuildFxMesh() {
    const field = fxField;
    field.begin();

    // 航空障碍灯:缓慢闪烁(暂停时 time 不推进 → 同步冻结);颜色预乘 alpha。
    const t = state.time;
    for (let i = 0; i < cityLights.length; i += 1) {
        const light = cityLights[i];
        const wave = Math.sin(t * light.speed + light.phase);
        const blink = wave > 0 ? wave * wave * wave : 0;
        if (blink < 0.02) continue;
        const a = 0.7 * blink;
        field.add(light.x, light.y, 1.35, 0.075, 0.075, [1.0 * a, 0.12 * a, 0.09 * a, 1]);
    }

    fireworks.writeQuads(field);
    const geo = field.end();
    if (fxMesh && fxRenderer) {
        fxMesh.updateSubMesh(0, geo);
        fxRenderer.onGeometryChanged();
    }
}

function launchAt(nx, ny, theme) {
    if (!sceneReady) return;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const halfW = VIEW_HALF_HEIGHT * aspect;
    const x = clamp((nx - 0.5) * halfW * 2, -halfW + 0.35, halfW - 0.35);
    const y = clamp((0.5 - ny) * VIEW_HALF_HEIGHT * 2, -1.6, VIEW_HALF_HEIGHT - 0.4);
    fireworks.launch(x, y, theme);
    state.fireworkCount += 1;
}

function autoLaunch() {
    const nx = 0.12 + rand() * 0.76;
    const ny = 0.14 + rand() * 0.4;
    launchAt(nx, ny, THEMES[Math.floor(rand() * THEMES.length)]);
}

function resetAll() {
    state.fireworkCount = 0;
    state.autoShow = false;
    state.enabled = true;
    state.time = 0;
    state.autoTimer = 0.7;
    fireworks.reset();
    if (sceneReady) {
        rand = mulberry32((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
        fireworks.rand = rand;
        regenerateCity();
        rebuildFxMesh();
    }
    updateUi();
}

function isOverUiButtons(nx, ny) {
    for (let i = 0; i < uiControls.length; i += 1) {
        const rect = uiControls[i].getBoundingClientRect();
        const x0 = rect.left / window.innerWidth - 0.004;
        const x1 = rect.right / window.innerWidth + 0.004;
        const y0 = rect.top / window.innerHeight - 0.006;
        const y1 = rect.bottom / window.innerHeight + 0.006;
        if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) return true;
    }
    return false;
}

/** 每帧驱动:enabled=false 时整个时间线冻结。 */
class SceneDriver extends Component {
    update(dt) {
        if (!state.enabled) return;
        const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
        state.time += step;
        if (state.autoShow) {
            state.autoTimer -= step;
            if (state.autoTimer <= 0) {
                autoLaunch();
                state.autoTimer = 0.5 + rand() * 0.2;
            }
        }
        fireworks.update(step);
        rebuildFxMesh();
    }
}

updateUi();

try {
    app = await createAirApp({ canvas });
    const scene = new Scene('city-fireworks');

    // --- 主相机:正交,DEFAULT 层(夜空 / 城市) --------------------------------
    const camNode = new Node('MainCamera');
    camNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(camNode);
    camNode.setPosition(new Vec3(0, 0, 12));
    camNode.lookAt(new Vec3(0, 0, 0));
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = VIEW_HALF_HEIGHT;
    camera.near = 0.1;
    camera.far = 60;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(2, 3, 9, 255);
    camera.visibility = Layers.makeMaskInclude([Layers.Enum.DEFAULT]);
    camera.priority = 0;

    // --- 叠加相机:UI_2D 层(全部加性发光),DEPTH_ONLY 保留主相机颜色 ----------
    const fxCamNode = new Node('FXCamera');
    fxCamNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(fxCamNode);
    fxCamNode.setPosition(new Vec3(0, 0, 12));
    fxCamNode.lookAt(new Vec3(0, 0, 0));
    const fxCamera = fxCamNode.addComponent(Camera);
    fxCamera.projection = Camera.ProjectionType.ORTHO;
    fxCamera.orthoHeight = VIEW_HALF_HEIGHT;
    fxCamera.near = 0.1;
    fxCamera.far = 60;
    fxCamera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
    fxCamera.visibility = Layers.makeMaskInclude([Layers.Enum.UI_2D]);
    fxCamera.priority = 1;

    // --- 材质 ------------------------------------------------------------------
    cityMaterial = buildUnlitMaterial({ USE_VERTEX_COLOR: true, USE_TEXTURE: false });
    cityMaterial.setProperty('mainColor', new Color(255, 255, 255, 255));

    glowTexture = createGlowTexture(64);
    const fxMaterial = buildFxMaterial();
    fxMaterial.setProperty('mainTexture', glowTexture);
    fxMaterial.setProperty('mainColor', new Color(255, 255, 255, 255));

    // --- 夜空节点 --------------------------------------------------------------
    skyNode = new Node('Sky');
    skyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(skyNode);
    const skyRenderer = skyNode.addComponent(MeshRenderer);
    skyRenderer.mesh = utils.MeshUtils.createMesh(buildSkyGeometry());
    skyRenderer.setSharedMaterial(cityMaterial, 0);

    // --- 城市节点(每次 reset 重生成) ------------------------------------------
    cityNode = new Node('City');
    cityNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(cityNode);
    cityRenderer = cityNode.addComponent(MeshRenderer);
    cityRenderer.setSharedMaterial(cityMaterial, 0);

    // --- FX 节点(动态四边形池) ------------------------------------------------
    fxField = new QuadField(FX_CAPACITY);
    lastFxGeometry = fxField.geometry();
    fxMesh = utils.MeshUtils.createDynamicMesh(0, lastFxGeometry, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: FX_CAPACITY * 4,
        maxSubMeshIndices: FX_CAPACITY * 6,
    });
    fxNode = new Node('FX');
    fxNode.layer = Layers.Enum.UI_2D;
    scene.addChild(fxNode);
    fxRenderer = fxNode.addComponent(MeshRenderer);
    fxRenderer.mesh = fxMesh;
    fxRenderer.setSharedMaterial(fxMaterial, 0);
    fxMaterialRef = fxMaterial;

    const driverNode = new Node('Driver');
    driverNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(driverNode);
    driverNode.addComponent(SceneDriver);

    window.__airApp = app;
    app.run(scene);

    regenerateCity();
    rebuildFxMesh();
    sceneReady = true;
    updateUi();

    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) window.__appReady = true;
    });

    // --- 点击发射(引擎 input,canvas 事件被 pal 层接管后仍能收到) ---------------
    input.on(Input.EventType.MOUSE_DOWN, (event) => {
        if (!state.enabled) return;
        let nx = 0.5;
        let ny = 0.3;
        try {
            const p = event.getLocation(); // 物理像素,左下原点
            nx = p.x / Math.max(1, canvas.width);
            ny = 1 - p.y / Math.max(1, canvas.height);
        } catch (err) {
            return;
        }
        if (isOverUiButtons(nx, ny)) return;
        if (ny >= 0.9) return; // 贴近画面底缘(纯地面)不发射
        launchAt(nx, ny, THEMES[Math.floor(rand() * THEMES.length)]);
    });

    console.log('[E04] city fireworks ready — buildings:', state.buildingCount);
} catch (err) {
    console.error('[E04] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
