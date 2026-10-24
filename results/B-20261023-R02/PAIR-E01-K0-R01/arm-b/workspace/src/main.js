/**
 * E01 — 深空星系巡航(cocosair 臂)
 *
 * 实现要点(依据 brief.md E01 v1.0.0 / spec.json):
 *   - 60,000 个程序化星点(核球 12k + 旋臂/盘面 40k + 远景背景星 8k),
 *     全部为 POINT_LIST 单顶点束网格,galaxy 一张网格 + background 一张网格,
 *     共 2 个 draw call,共享一份自定义点着色器材质(加色混合 + gl_PointSize 透视衰减)。
 *   - 自定义 Effect:glsl3 变体(浏览器 WebGL2 实际消费的变体),
 *     CCCamera/CCLocal 内建 UBO 成员布局与引擎一字不差;材质 Constants UBO 提供
 *     u_pointParams = (pointScale, minPx, maxPx, 0)。
 *   - 交互:窗口捕获层监听 pointermove/mousemove(视差)与 wheel(穿行);
 *     相机距离/视差均指数平滑(无瞬跳);Reset 恢复初值并 epoch+1。
 *   - 状态契约:window.__bench = { getState, reset };首帧后 window.__appReady = true。
 */

import {
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Component,
    EffectAsset,
    Material,
    Layers,
    Color,
    Vec3,
    Vec4,
    utils,
    gfx,
    director,
    Director,
    input,
    Input,
} from 'cocosair.js';

// ============================ 常量(可调参数集中) ============================
const STAR_TOTAL = 60000; // 状态上报口径:真实提交渲染的顶点总数
const BULGE_COUNT = 12000;
const DISK_COUNT = 40000;
const BG_COUNT = STAR_TOTAL - BULGE_COUNT - DISK_COUNT; // 8000 远景背景星
const GALAXY_COUNT = BULGE_COUNT + DISK_COUNT;

const R_MAX = 55; // 星系盘半径(世界单位)
const OMEGA = 0.06; // rad/s,盘面慢旋(brief 要求 0.02–0.1)

const FOV = 50; // 垂直视场角(度)
const EL = (40 * Math.PI) / 180; // 相机仰角:盘法线与视线夹角 = 90°-40° = 50°(30–60 区间)
const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const DIST_RATE = 3.0; // 滚轮距离平滑速率(1/s,指数平滑无瞬跳;采样窗内保持可观变化量)
const RESET_RATE = 12.0; // reset 恢复加速率(保证 1s 内完成)
const PAR_RATE = 6.0; // 视差平滑速率(1/s)
const PAR_AMP_X = 8; // 视差相机横移幅度(世界单位,≈画布宽 5%)
const PAR_AMP_Y = 5;
const WHEEL_K = 0.16; // deltaY → 距离目标变化系数(单次 -600 滚轮 → 目标距离变化 -96,钳到 40)

// ============================ 运行状态 ============================
const state = {
    phase: 0, // rotationPhase(rad)
    epoch: 0,
    fpsTimes: [], // EVENT_AFTER_DRAW 时间戳滚动窗(2s)
    fps: 0,
    hudVisible: true,
};

window.__appReady = false;

// 每帧驱动器改写的活体参数
const camCtl = {
    distCurrent: DIST_INIT,
    distTarget: DIST_INIT,
    par: { x: 0, y: 0 }, // 平滑后的视差状态([-1,1] 归一化)
    parTarget: { x: 0, y: 0 },
    resetFast: false,
};

function reset() {
    state.epoch += 1;
    state.phase = 0;
    camCtl.distTarget = DIST_INIT;
    camCtl.parTarget.x = 0;
    camCtl.parTarget.y = 0;
    camCtl.resetFast = true; // update 循环里以 RESET_RATE 收敛,并在到位后清除
}

window.__bench = {
    getState: () => ({
        starCount: STAR_TOTAL,
        rotationPhase: state.phase,
        cameraDistance: camCtl.distCurrent,
        parallaxOffset: { x: camCtl.par.x, y: camCtl.par.y },
        fps: state.fps,
        hudVisible: state.hudVisible,
        epoch: state.epoch,
    }),
    reset,
};

// ============================ HUD(DOM 覆盖层) ============================
const hud = document.createElement('div');
hud.setAttribute('data-ui', 'hud');
hud.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:9998;padding:8px 12px;' +
    "font:12px/1.6 'Consolas',monospace;color:#dfe8ff;" +
    'background:rgba(8,10,20,0.55);border:1px solid #2a3350;border-radius:6px;' +
    'pointer-events:none;white-space:pre;';
document.body.appendChild(hud);

const hudRows = {
    stars: document.createElement('div'),
    fps: document.createElement('div'),
    dist: document.createElement('div'),
    phase: document.createElement('div'),
    epoch: document.createElement('div'),
};
for (const key of Object.keys(hudRows)) hud.appendChild(hudRows[key]);
function refreshHud() {
    // HUD 数字来自真实运行状态(与 __bench 同源,允许四舍五入)
    const s = window.__bench.getState();
    hudRows.stars.textContent = `Stars  ${s.starCount}`;
    hudRows.fps.textContent = `FPS    ${s.fps}`;
    hudRows.dist.textContent = `Dist   ${Math.round(s.cameraDistance)}`;
    hudRows.phase.textContent = `Phase  ${s.rotationPhase.toFixed(2)}`;
    hudRows.epoch.textContent = `Epoch  ${s.epoch}`;
}
refreshHud();

{
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:9999;padding:4px 14px;' +
        "font:12px sans-serif;background:#1b2233;color:#e8eeff;border:1px solid #4a5878;" +
        'border-radius:4px;cursor:pointer;';
    btn.addEventListener('click', () => reset());
    document.body.appendChild(btn);
}

// ============================ 输入(视差 + 滚轮) ============================
// 窗口捕获层监听:先于 pal/canvas 目标层触发,不受事件吞没影响;CDP 可信事件与
// 页面合成事件(dispatchEvent 冒泡)都会到达。
function setPointerFromClient(cx, cy) {
    const nx = Math.min(1, Math.max(0, cx / window.innerWidth));
    const ny = Math.min(1, Math.max(0, cy / window.innerHeight));
    camCtl.parTarget.x = (nx - 0.5) * 2; // 偏离中心的有符号偏移(画面中心 = 0)
    camCtl.parTarget.y = (ny - 0.5) * 2;
}
window.addEventListener(
    'pointermove',
    (e) => setPointerFromClient(e.clientX, e.clientY),
    { capture: true, passive: true },
);
window.addEventListener(
    'mousemove',
    (e) => setPointerFromClient(e.clientX, e.clientY),
    { capture: true, passive: true },
);
// 引擎 input 流(可信鼠标事件的冗余路径,坐标口径同为 CSS 像素)
input.on(Input.EventType.MOUSE_MOVE, (e) => {
    const loc = e.getLocation();
    setPointerFromClient(loc.x, loc.y);
});
// 滚轮:捕获层监听 wheel(deltaY<0 = 向上 = 靠近)
window.addEventListener(
    'wheel',
    (e) => {
        camCtl.distTarget = Math.min(
            DIST_MAX,
            Math.max(DIST_MIN, camCtl.distTarget + e.deltaY * WHEEL_K),
        );
    },
    { capture: true, passive: true },
);

// ============================ 星系生成(纯程序化) ============================
// 简易高斯(Box–Muller)
function gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const C_CORE = [1.0, 0.94, 0.78]; // 核球暖黄白
const C_INNER = [1.0, 0.92, 0.74]; // 盘内缘暖白
const C_MID = [0.74, 0.84, 1.0]; // 旋臂中段蓝白
const C_OUTER = [0.4, 0.56, 1.0]; // 外缘冷蓝
const C_RED = [1.0, 0.42, 0.2]; // 橙红亮星

const TAN_PITCH = Math.tan((13 * Math.PI) / 180); // 对数螺线螺距角 13°
const ARM_COUNT = 2;

function galaxyGeometry() {
    const positions = new Float32Array(GALAXY_COUNT * 3);
    const colors = new Float32Array(GALAXY_COUNT * 4); // rgb = 颜色×亮度,a = 世界半径
    let p = 0;
    let c = 0;

    // --- 核球:中央密集亮星群(暖色、偏亮、尺寸大) ---
    for (let i = 0; i < BULGE_COUNT; i++) {
        let x = 0;
        let y = 0;
        let z = 0;
        let r2 = 1e9;
        for (let tries = 0; tries < 4 && r2 > 144; tries++) {
            // 限制核球半径 ≲ 12
            x = gauss() * 4.4;
            y = gauss() * 2.9; // 扁椭球(中央隆起)
            z = gauss() * 4.4;
            r2 = x * x + y * y + z * z;
        }
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;
        const bright = 0.85 + Math.random() * 0.5 + (Math.random() < 0.05 ? 0.5 : 0);
        const col = lerp3(C_CORE, [1.0, 0.86, 0.62], Math.random() * 0.6);
        colors[c++] = col[0] * bright;
        colors[c++] = col[1] * bright;
        colors[c++] = col[2] * bright;
        colors[c++] = 0.22 + Math.random() * Math.random() * 0.55 + (bright > 1.3 ? 0.25 : 0);
    }

    // --- 盘面 + 双对数螺线旋臂 ---
    for (let i = 0; i < DISK_COUNT; i++) {
        const onArm = Math.random() < 0.82;
        const u = Math.random();
        const r = 3 + (R_MAX - 3) * Math.pow(u, 0.72); // 内密外疏
        let theta;
        if (onArm) {
            const arm = i % ARM_COUNT;
            const base = Math.log(r / 1.5) / TAN_PITCH + (arm * Math.PI * 2) / ARM_COUNT;
            const scatter = gauss() * (0.16 + 0.0022 * r); // 越外越散
            theta = base + scatter;
        } else {
            theta = Math.random() * Math.PI * 2; // 盘面随机散布星
        }
        const sigmaY = 0.5 + 2.8 * Math.exp(-r / 9); // 盘厚度 + 中央隆起
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        const y = gauss() * sigmaY;
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;

        const t = (r - 3) / (R_MAX - 3);
        let col;
        let bright;
        let size;
        if (Math.random() < 0.03) {
            // 少量橙红亮星散布全盘
            col = C_RED;
            bright = 1.05 + Math.random() * 0.35;
            size = 0.4 + Math.random() * 0.3;
        } else {
            col =
                t < 0.45
                    ? lerp3(C_INNER, C_MID, t / 0.45)
                    : lerp3(C_MID, C_OUTER, (t - 0.45) / 0.55);
            bright = (0.55 + Math.random() * 0.5) * (1.15 - 0.35 * t);
            size = 0.16 + Math.random() * Math.random() * 0.26;
        }
        colors[c++] = col[0] * bright;
        colors[c++] = col[1] * bright;
        colors[c++] = col[2] * bright;
        colors[c++] = size;
    }
    return { positions, colors };
}

function backgroundGeometry() {
    const positions = new Float32Array(BG_COUNT * 3);
    const colors = new Float32Array(BG_COUNT * 4);
    let p = 0;
    let c = 0;
    for (let i = 0; i < BG_COUNT; i++) {
        const z = Math.random() * 2 - 1;
        const phi = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        const r = 170 + 430 * Math.pow(Math.random(), 0.6);
        positions[p++] = s * Math.cos(phi) * r;
        positions[p++] = z * r;
        positions[p++] = s * Math.sin(phi) * r;
        const bright = 0.35 + Math.random() * 0.35;
        colors[c++] = 0.72 * bright;
        colors[c++] = 0.78 * bright;
        colors[c++] = 0.92 * bright;
        colors[c++] = 0.8 + Math.random() * 1.3;
    }
    return { positions, colors };
}

// ============================ 自定义点着色器 Effect ============================
// glsl3 = WebGL2 设备实际消费的变体;CCCamera/CCLocal 成员布局逐字对齐引擎
// (build/cocosair.module.js 内建 effect 声明),材质 Constants UBO 在 set=1/binding=0。
const VERT_SRC = `
precision highp float;
in vec3 a_position;
in vec4 a_color;
uniform CCCamera {
    highp   mat4 cc_matView;
    highp   mat4 cc_matViewInv;
    highp   mat4 cc_matProj;
    highp   mat4 cc_matProjInv;
    highp   mat4 cc_matViewProj;
    highp   mat4 cc_matViewProjInv;
    highp   vec4 cc_cameraPos;
    mediump vec4 cc_surfaceTransform;
    mediump vec4 cc_screenScale;
    mediump vec4 cc_exposure;
    mediump vec4 cc_mainLitDir;
    mediump vec4 cc_mainLitColor;
    mediump vec4 cc_ambientSky;
    mediump vec4 cc_ambientGround;
    mediump vec4 cc_fogColor;
    mediump vec4 cc_fogBase;
    mediump vec4 cc_fogAdd;
    mediump vec4 cc_nearFar;
    mediump vec4 cc_viewPort;
};
uniform CCLocal {
    highp mat4 cc_matWorld;
    highp mat4 cc_matWorldIT;
    highp vec4 cc_lightingMapUVParam;
    highp vec4 cc_localShadowBias;
};
uniform Constants {
    vec4 u_pointParams; // x=像素比例因子 y=minPx z=maxPx
};
out vec4 v_color;
void main () {
    vec4 world = cc_matWorld * vec4(a_position, 1.0);
    vec4 viewPos = cc_matView * world;
    gl_Position = cc_matViewProj * world;
    float viewZ = max(0.5, -viewPos.z);
    float px = a_color.a * u_pointParams.x / viewZ;
    gl_PointSize = clamp(px, u_pointParams.y, u_pointParams.z);
    v_color = vec4(a_color.rgb, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main () {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float glow = 1.0 - r2 * 4.0;
    glow *= glow;
    fragColor = vec4(v_color.rgb * glow, glow);
}
`;

const PROGRAM_NAME = 'e01-galaxy-points|galaxy-vs:vert|galaxy-fs:frag';

function makeGalaxyEffect() {
    return {
        name: 'e01-galaxy-points',
        techniques: [
            {
                name: 'additive-points',
                passes: [
                    {
                        program: PROGRAM_NAME,
                        properties: {
                            u_pointParams: {
                                value: [770, 1.5, 40, 0],
                                type: gfx.Type.FLOAT4,
                            },
                        },
                        primitive: gfx.PrimitiveMode.POINT_LIST, // PSO 取 pass.primitive(与 mesh 双补丁)
                        rasterizerState: { cullMode: gfx.CullMode.NONE },
                        depthStencilState: { depthTest: true, depthWrite: false },
                        blendState: {
                            targets: [
                                {
                                    blend: true,
                                    blendSrc: gfx.BlendFactor.SRC_ALPHA,
                                    blendDst: gfx.BlendFactor.ONE,
                                    blendEq: gfx.BlendOp.ADD,
                                    blendSrcAlpha: gfx.BlendFactor.ONE,
                                    blendDstAlpha: gfx.BlendFactor.ONE,
                                    blendAlphaEq: gfx.BlendOp.ADD,
                                },
                            ],
                        },
                    },
                ],
            },
        ],
        shaders: [
            {
                name: PROGRAM_NAME,
                hash: 81010001,
                glsl3: { vert: VERT_SRC, frag: FRAG_SRC },
                builtins: {
                    statistics: {
                        CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 0,
                        CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 0,
                    },
                    globals: {
                        blocks: [{ name: 'CCCamera', defines: [] }],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                    locals: {
                        blocks: [{ name: 'CCLocal', defines: [] }],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                },
                defines: [],
                attributes: [
                    { name: 'a_position', defines: [], format: gfx.Format.RGB32F, location: 0 },
                    { name: 'a_color', defines: [], format: gfx.Format.RGBA32F, location: 1 },
                ],
                blocks: [
                    {
                        name: 'Constants',
                        defines: [],
                        binding: 0,
                        stageFlags: gfx.ShaderStageFlagBit.VERTEX,
                        members: [{ name: 'u_pointParams', type: gfx.Type.FLOAT4, count: 1 }],
                    },
                ],
                samplerTextures: [],
                buffers: [],
                images: [],
                textures: [],
                samplers: [],
                subpassInputs: [],
            },
        ],
    };
}

// ============================ 每帧驱动组件 ============================
let galaxyNode = null;
let cameraNode = null;
let cameraComp = null;
let hudAccum = 0;

class GalaxyDriver extends Component {
    update(dt) {
        const d = Math.min(dt, 0.1); // 后台标签恢复后的巨帧钳制
        // 旋转
        state.phase += OMEGA * d;
        if (galaxyNode && galaxyNode.isValid) {
            galaxyNode.setRotationFromEuler(0, (state.phase * 180) / Math.PI, 0);
        }
        // 距离平滑(普通滚轮慢速;reset 快速收敛)
        const rate = camCtl.resetFast ? RESET_RATE : DIST_RATE;
        camCtl.distCurrent += (camCtl.distTarget - camCtl.distCurrent) * (1 - Math.exp(-rate * d));
        // 视差平滑
        camCtl.par.x += (camCtl.parTarget.x - camCtl.par.x) * (1 - Math.exp(-PAR_RATE * d));
        camCtl.par.y += (camCtl.parTarget.y - camCtl.par.y) * (1 - Math.exp(-PAR_RATE * d));
        if (
            camCtl.resetFast &&
            Math.abs(camCtl.distCurrent - DIST_INIT) < 0.3 &&
            Math.abs(camCtl.par.x) < 0.005 &&
            Math.abs(camCtl.par.y) < 0.005
        ) {
            camCtl.resetFast = false;
        }
        // 相机位姿:固定仰角绕原点 + 视差横向偏移
        const dist = camCtl.distCurrent;
        const px = camCtl.par.x * PAR_AMP_X;
        const py = camCtl.par.y * PAR_AMP_Y;
        cameraNode.setPosition(px, Math.sin(EL) * dist - py * 0.6, Math.cos(EL) * dist);
        cameraNode.lookAt(new Vec3(0, 0, 0));
        // HUD 4Hz 刷新(避免每帧改 DOM)
        hudAccum += d;
        if (hudAccum > 0.25) {
            hudAccum = 0;
            refreshHud();
        }
    }
}

// ============================ 启动 ============================
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('e01-galaxy');

    // 相机(visibility 必须显式设置 —— 4.0-alpha 默认 undefined)
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = FOV;
    cameraComp.near = 0.5;
    cameraComp.far = 2500;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(5, 6, 14, 255); // 近黑深空
    cameraComp.visibility = Layers.Enum.DEFAULT;
    cameraComp.priority = 0;
    cameraNode.setPosition(0, Math.sin(EL) * DIST_INIT, Math.cos(EL) * DIST_INIT);
    cameraNode.lookAt(new Vec3(0, 0, 0));

    // 自定义点材质
    const effect = Object.assign(new EffectAsset(), makeGalaxyEffect());
    effect.onLoaded();
    const material = new Material();
    material.initialize({ effectAsset: effect });

    // 点尺寸参数:设备像素高 / (2·tan(fov/2)) → 世界单位→像素比例
    function updatePointParams() {
        const h = canvas.height || window.innerHeight;
        const scale = h / (2 * Math.tan(((FOV / 2) * Math.PI) / 180));
        material.setProperty('u_pointParams', new Vec4(scale, 1.5, 40, 0));
    }
    updatePointParams();
    window.addEventListener('resize', updatePointParams, { passive: true });

    // 星系盘(旋转)
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const geoGalaxy = galaxyGeometry();
    const meshGalaxy = utils.MeshUtils.createMesh({
        positions: geoGalaxy.positions,
        colors: geoGalaxy.colors,
        primitiveMode: gfx.PrimitiveMode.POINT_LIST,
        minPos: { x: -R_MAX - 6, y: -24, z: -R_MAX - 6 },
        maxPos: { x: R_MAX + 6, y: 24, z: R_MAX + 6 },
    });
    const galaxyRenderer = galaxyNode.addComponent(MeshRenderer);
    galaxyRenderer.mesh = meshGalaxy;
    galaxyRenderer.setSharedMaterial(material, 0);

    // 远景背景星(静态,增强纵深与视差层次)
    const bgNode = new Node('BackgroundStars');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const geoBg = backgroundGeometry();
    const meshBg = utils.MeshUtils.createMesh({
        positions: geoBg.positions,
        colors: geoBg.colors,
        primitiveMode: gfx.PrimitiveMode.POINT_LIST,
        minPos: { x: -650, y: -650, z: -650 },
        maxPos: { x: 650, y: 650, z: 650 },
    });
    const bgRenderer = bgNode.addComponent(MeshRenderer);
    bgRenderer.mesh = meshBg;
    bgRenderer.setSharedMaterial(material, 0);

    // 驱动组件
    const driverNode = new Node('Driver');
    scene.addChild(driverNode);
    driverNode.addComponent(GalaxyDriver);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口
    app.run(scene);

    // 帧率(2s 滚动窗,EVENT_AFTER_DRAW 口径)+ 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        state.fpsTimes.push(now);
        while (state.fpsTimes.length > 0 && now - state.fpsTimes[0] > 2000) {
            state.fpsTimes.shift();
        }
        // 滚动 2s 窗平均;窗口不足 250ms 数据时保持 0(真实测量口径,不虚报)
        const span = state.fpsTimes.length > 1 ? now - state.fpsTimes[0] : 0;
        state.fps = span >= 250 ? Math.round((state.fpsTimes.length / span) * 1000) : 0;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[e01] galaxy running on cocosair — stars:', STAR_TOTAL);
} catch (err) {
    // 致命错误(如 WebGL2 不可用):显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[e01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
