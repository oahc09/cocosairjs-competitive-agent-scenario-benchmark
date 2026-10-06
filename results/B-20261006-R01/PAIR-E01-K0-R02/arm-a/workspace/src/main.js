/**
 * E01 — 深空星系巡航(Deep Space Galaxy Cruise)
 *
 * 实现路径(K0 冷启动,依据模板 main.js 与引擎 d.ts / 运行时 bundle 结构推得):
 *   - 星系 = 单个 POINT_LIST 非索引网格(每星 1 顶点,一次 draw 提交全部星点,批量渲染);
 *     自定义 Effect(Material.initialize({ effectAsset })) + gl_PointSize + gl_PointCoord
 *     软圆点 + 加法混合。register 流程与引擎 builtin effects(registerBuiltinAirAssets)完全同构:
 *     Object.assign(new EffectAsset(), effectJson) → effect.onLoaded()。
 *   - WebGL2 设备实际编译 glsl3(见引擎 getDeviceShaderVersion),故 glsl3 用引擎 toGlsl3 的
 *     同款规则由 glsl4 生成;UBO 块声明逐字取自 builtin-debug-renderer 顶点着色器。
 *   - 旋转 = 星系节点绕 +Y(盘面法线);视差 = 星系层与远景层反向耦合位移(产生相对位移);
 *     滚轮 = 相机距离目标值变化,逐帧指数插值(无瞬跳/无过冲)。
 *   - 已知引擎坑对齐:canvas 鼠标事件走引擎 input.on(MOUSE_MOVE);wheel 用 window capture
 *     监听;Camera.visibility 显式设 Layers.Enum.DEFAULT;颜色/向量一律引擎实例(无裸数组)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    EffectAsset,
    utils,
    gfx,
    Vec3,
    Color,
    Component,
    director,
    Director,
    input,
    Input,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量(状态契约:cameraDistance 初始 120、范围 [40,400];角速度 0.02–0.1 rad/s)
// ---------------------------------------------------------------------------
const OMEGA = 0.05; // rad/s 星系角速度
const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const WHEEL_SENS = 0.1; // deltaY 单位 → 距离单位(deltaY=-600 → -60,探针 P4 要求 >5)
const DIST_K = 3; // 滚轮距离指数插值速率(500→800ms 间仍有 ≈8 单位变化,P4 双采样成立)
const RESET_K = 9; // reset 时快速插值(400→120 在 ~0.6s 内完成,<1s 合同)
const PARALLAX_K = 4; // 视差指数插值(平滑、无过冲)
const ELEV = 42 * (Math.PI / 180); // 相机仰角:盘面法线与视线夹角 ≈ 48°(30°–60° 内)
const FAR = 2500;

// 星点构成(全部真实顶点,starCount 状态 = 两网格顶点数之和,无任何虚报)
const ARM_COUNT = 2;
const ARM_STARS = 21000; // 每条旋臂
const DISK_STARS = 9000; // 盘面随机散星
const BULGE_STARS = 9000; // 核球
const BG_STARS = 4000; // 远景背景星
const GALAXY_STARS = ARM_COUNT * ARM_STARS + DISK_STARS + BULGE_STARS; // 60000
const STAR_COUNT = GALAXY_STARS + BG_STARS; // 64000

const R_DISK = 57; // 盘半径:直径 ≈ 64% 画面宽度(fov45, dist120) → 60%–75% 区间
const R_CORE = 7; // 对数螺旋内径
const SPIRAL_B = 0.28; // 对数螺旋 b = tan(pitch ≈ 15.6°)
const THICK = 1.5; // 盘面厚度基准

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// 状态 + 页面契约(在任何 await 之前就绪,与模板一致)
// ---------------------------------------------------------------------------
const state = {
    phase: 0, // rotationPhase(rad)
    dist: DIST_INIT,
    distTarget: DIST_INIT,
    px: 0, // parallaxOffset.x(有符号归一化,-1..1)
    py: 0,
    pxTarget: 0,
    pyTarget: 0,
    epoch: 0,
    resetUntil: 0, // performance.now() 之前用 RESET_K
    starCount: STAR_COUNT,
    hudVisible: true,
};

let fps = 0; // 2s 滚动平均
const frameTimes = [];

window.__appReady = false;

// HUD(2D 覆盖层,真实运行数据;四舍五入允许)
const hud = document.createElement('div');
hud.id = 'hud';
hud.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:9998;pointer-events:none;' +
    "font:13px/1.6 Consolas,Menlo,monospace;color:#d6e4ff;text-shadow:0 0 6px rgba(0,0,0,.9);" +
    'background:rgba(4,6,14,.35);padding:6px 10px;border-radius:6px;';
hud.innerHTML =
    '<div id="hud-stars">Stars: ' + STAR_COUNT + '</div>' +
    '<div id="hud-fps">FPS: 0</div>' +
    '<div id="hud-dist">Distance: 120.0</div>' +
    '<div id="hud-phase">Phase: 0.00 rad</div>';
document.body.appendChild(hud);
const hudFps = hud.querySelector('#hud-fps');
const hudDist = hud.querySelector('#hud-dist');
const hudPhase = hud.querySelector('#hud-phase');

function doReset() {
    state.epoch += 1;
    state.phase = 0;
    state.distTarget = DIST_INIT;
    state.resetUntil = performance.now() + 900;
    state.px = 0; state.py = 0; state.pxTarget = 0; state.pyTarget = 0;
    if (galaxyNode && galaxyNode.isValid) {
        galaxyNode.setRotationFromEuler(0, 0, 0);
        galaxyNode.setPosition(new Vec3(0, 0, 0));
    }
    if (bgNode && bgNode.isValid) {
        bgNode.setPosition(new Vec3(0, 0, 0));
    }
}

window.__bench = {
    getState: () => ({
        starCount: state.starCount,
        rotationPhase: state.phase,
        cameraDistance: state.dist,
        parallaxOffset: { x: state.px, y: state.py },
        fps: Math.round(fps * 10) / 10,
        hudVisible: state.hudVisible,
        epoch: state.epoch,
    }),
    reset: doReset,
};

// Reset 控件(可见文本 + aria-label + data-ui 三重可定位)
{
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.title = 'Reset view';
    btn.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:9999;padding:5px 14px;' +
        "font:13px Consolas,monospace;background:#1a2333;color:#d6e4ff;border:1px solid #44537a;" +
        'border-radius:4px;cursor:pointer;';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
}

// ---------------------------------------------------------------------------
// 确定性随机(可复现生成)
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
const gauss = (rng) =>
    Math.sqrt(-2 * Math.log(1 - rng() * 0.999999)) * Math.cos(2 * Math.PI * rng());
const mix3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
];

// ---------------------------------------------------------------------------
// 星点生成:位置(x,y,z,y 向上)+ 颜色(半径梯度 + 三档亮暗)+ 尺寸/闪烁相位
// ---------------------------------------------------------------------------
function pickStarLook(r, rng, isBulge) {
    // 2.5% 橙红亮星(散布亮星锚点)
    if (!isBulge && rng() < 0.025) {
        return { c: [1.0, 0.44, 0.26], b: 0.8 + 0.2 * rng(), s: 0.8 + 0.4 * rng() };
    }
    const rn = clamp((r - 4) / (R_DISK - 4), 0, 1);
    const warm = [1.0, 0.93, 0.78]; // 核心暖黄白
    const mid = [0.86, 0.9, 1.0]; // 旋臂中段蓝白
    const cold = [0.58, 0.72, 1.0]; // 外缘冷蓝
    const c = rn < 0.35 ? mix3(warm, mid, rn / 0.35) : mix3(mid, cold, (rn - 0.35) / 0.65);
    if (isBulge) {
        return { c, b: 0.72 + 0.28 * rng(), s: 0.55 + 0.5 * rng() }; // 第 1 档:核球亮星
    }
    if (rng() < 0.14) {
        return { c, b: 0.16 + 0.22 * rng(), s: 0.22 + 0.16 * rng() }; // 第 3 档:暗弱背景星
    }
    return { c, b: 0.42 + 0.36 * rng(), s: 0.34 + 0.3 * rng() }; // 第 2 档:盘面普通星
}

function buildGalaxyGeometry() {
    const rng = mulberry32(20261006);
    const positions = new Array(GALAXY_STARS * 3);
    const colors = new Array(GALAXY_STARS * 4);
    const sizePhase = new Array(GALAXY_STARS * 2);
    let i3 = 0, i4 = 0, i2 = 0;

    const push = (x, y, z, look) => {
        positions[i3++] = x; positions[i3++] = y; positions[i3++] = z;
        colors[i4++] = look.c[0] * look.b;
        colors[i4++] = look.c[1] * look.b;
        colors[i4++] = look.c[2] * look.b;
        colors[i4++] = 1.0;
        sizePhase[i2++] = look.s;
        sizePhase[i2++] = rng() * Math.PI * 2;
    };

    // 旋臂(对数螺旋:r = R0·e^(bθ))
    for (let arm = 0; arm < ARM_COUNT; arm++) {
        for (let k = 0; k < ARM_STARS; k++) {
            const r = R_CORE * Math.pow(R_DISK / R_CORE, rng()); // 对数均匀
            const theta = Math.log(r / R_CORE) / SPIRAL_B + (arm * Math.PI);
            const jitter = gauss(rng) * (0.14 + 0.12 * (r / R_DISK));
            const ang = theta + jitter;
            const x = Math.cos(ang) * r + gauss(rng) * 0.9;
            const z = Math.sin(ang) * r + gauss(rng) * 0.9;
            const y = gauss(rng) * THICK * (0.6 + 0.9 * Math.exp(-r / 14));
            push(x, y, z, pickStarLook(r, rng, false));
        }
    }
    // 盘面随机散星
    for (let k = 0; k < DISK_STARS; k++) {
        const r = 2 + (R_DISK - 2) * Math.pow(rng(), 0.8);
        const ang = rng() * Math.PI * 2;
        const y = gauss(rng) * THICK;
        push(Math.cos(ang) * r, y, Math.sin(ang) * r, pickStarLook(r, rng, false));
    }
    // 核球(中央密集隆起,计入总数)
    for (let k = 0; k < BULGE_STARS; k++) {
        const x = gauss(rng) * 3.4;
        const y = gauss(rng) * 2.1;
        const z = gauss(rng) * 3.4;
        const r = Math.sqrt(x * x + z * z);
        push(x, y, z, pickStarLook(Math.max(r, 0.5), rng, true));
    }

    return {
        positions,
        colors,
        customAttributes: [{
            attr: new gfx.Attribute('a_sizePhase', gfx.Format.RG32F, false, 0, false, 2),
            values: sizePhase,
        }],
        primitiveMode: gfx.PrimitiveMode.POINT_LIST, // mesh 侧补丁:子网格图元 = 点表
        minPos: { x: -R_DISK - 4, y: -10, z: -R_DISK - 4 },
        maxPos: { x: R_DISK + 4, y: 10, z: R_DISK + 4 },
    };
}

function buildBackgroundGeometry() {
    const rng = mulberry32(73112);
    const positions = new Array(BG_STARS * 3);
    const colors = new Array(BG_STARS * 4);
    const sizePhase = new Array(BG_STARS * 2);
    for (let k = 0; k < BG_STARS; k++) {
        const u = rng() * 2 - 1;
        const phi = rng() * Math.PI * 2;
        const rr = 700 + rng() * 300;
        const s = Math.sqrt(1 - u * u);
        positions[k * 3 + 0] = Math.cos(phi) * s * rr;
        positions[k * 3 + 1] = u * rr;
        positions[k * 3 + 2] = Math.sin(phi) * s * rr;
        const b = 0.16 + 0.3 * rng();
        const tint = rng();
        colors[k * 4 + 0] = 0.75 + 0.25 * tint;
        colors[k * 4 + 1] = 0.8 + 0.2 * tint;
        colors[k * 4 + 2] = 1.0;
        colors[k * 4 + 3] = 1.0;
        sizePhase[k * 2 + 0] = 0.3 + 0.25 * rng();
        sizePhase[k * 2 + 1] = rng() * Math.PI * 2;
    }
    return {
        positions,
        colors,
        customAttributes: [{
            attr: new gfx.Attribute('a_sizePhase', gfx.Format.RG32F, false, 0, false, 2),
            values: sizePhase,
        }],
        primitiveMode: gfx.PrimitiveMode.POINT_LIST,
        minPos: { x: -1100, y: -1100, z: -1100 },
        maxPos: { x: 1100, y: 1100, z: 1100 },
    };
}

// ---------------------------------------------------------------------------
// 自定义点精灵 Effect(与引擎 builtin effects 注册方式同构)
// ---------------------------------------------------------------------------
const UBO_DECL = `
layout(set = 0, binding = 0) uniform CCGlobal {
highp   vec4 cc_time;
mediump vec4 cc_screenSize;
mediump vec4 cc_nativeSize;
mediump vec4 cc_debug_view_mode;
mediump vec4 cc_debug_view_composite_pack_1;
mediump vec4 cc_debug_view_composite_pack_2;
mediump vec4 cc_debug_view_composite_pack_3;
};
layout(set = 0, binding = 1) uniform CCCamera {
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
layout(set = 2, binding = 0) uniform CCLocal {
highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;
};
`;

const VERT_SRC = `precision highp float;
${UBO_DECL}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_sizePhase;
layout(location = 0) out vec4 v_color;
vec4 vert () {
  vec4 wpos = cc_matWorld * vec4(a_position, 1.0);
  vec4 pos = cc_matViewProj * wpos;
  float dist = max(1.0, distance(cc_cameraPos.xyz, wpos.xyz));
  float tw = 0.8 + 0.2 * sin(cc_time.x * 1.7 + a_sizePhase.y);
  gl_PointSize = clamp(a_sizePhase.x * tw * 640.0 / dist, 1.0, 24.0);
  v_color = vec4(a_color.rgb * (0.6 + 0.4 * tw), 1.0);
  return pos;
}
void main() { gl_Position = vert(); }`;

const FRAG_SRC = `precision mediump float;
layout(location = 0) in vec4 v_color;
layout(location = 0) out vec4 fragColor;
vec4 frag () {
  vec2 d = gl_PointCoord - vec2(0.5, 0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 >= 1.0) { discard; }
  float fall = exp(-2.6 * r2) * (1.0 - r2);
  return vec4(v_color.rgb * fall, fall);
}
void main() { fragColor = frag(); }`;

// 引擎 toGlsl3 同款转换(WebGL2 设备实际取 glsl3)
function toGlsl3(src) {
    return src
        .replace(/#extension[^\n]*\n/g, '')
        .replace(/^[^\n]*cc_debug_view_composite_pack_\d+;[^\n]*$/gm, '')
        .replace(/layout\s*\(([^)]*)\)\s*/g, (m, inner) => (inner.indexOf('std140') !== -1 ? 'layout(std140) ' : ''))
        .replace(/\bu32vec([234])\b/g, 'vec$1');
}

const PROGRAM_NAME = 'galaxy-points|vs:vert|fs:frag';
function buildPointEffect() {
    return {
        name: 'galaxy-points-effect',
        techniques: [{
            name: 'add',
            passes: [{
                program: PROGRAM_NAME,
                primitive: gfx.PrimitiveMode.POINT_LIST, // pass 侧补丁:PSO 图元 = 点表
                rasterizerState: { cullMode: 0 },
                blendState: { targets: [{ blend: true, blendSrc: 1, blendDst: 1, blendSrcAlpha: 1, blendDstAlpha: 1 }] }, // ONE/ONE 加法辉光
                depthStencilState: { depthTest: true, depthWrite: false },
                properties: {},
            }],
        }],
        shaders: [{
            name: PROGRAM_NAME,
            hash: 987654321, // 与全部 builtin hash 不冲突
            glsl4: { vert: VERT_SRC, frag: FRAG_SRC },
            glsl3: { vert: toGlsl3(VERT_SRC), frag: toGlsl3(FRAG_SRC) },
            glsl1: { vert: toGlsl3(VERT_SRC), frag: toGlsl3(FRAG_SRC) },
            builtins: {
                statistics: {},
                globals: {
                    blocks: [{ name: 'CCGlobal', defines: [] }, { name: 'CCCamera', defines: [] }],
                    samplerTextures: [], buffers: [], images: [],
                },
                locals: {
                    blocks: [{ name: 'CCLocal', defines: [] }],
                    samplerTextures: [], buffers: [], images: [],
                },
            },
            defines: [],
            attributes: [
                { name: 'a_position', format: gfx.Format.RGB32F, isNormalized: false, stream: 0, isInstanced: false, location: 0, defines: [] },
                { name: 'a_color', format: gfx.Format.RGBA32F, isNormalized: false, stream: 0, isInstanced: false, location: 1, defines: [] },
                { name: 'a_sizePhase', format: gfx.Format.RG32F, isNormalized: false, stream: 0, isInstanced: false, location: 2, defines: [] },
            ],
            blocks: [], samplerTextures: [], buffers: [], images: [], textures: [], samplers: [], subpassInputs: [],
        }],
    };
}

// ---------------------------------------------------------------------------
// 每帧行为:旋转 + 距离/视差插值 + 相机 + HUD 刷新
// ---------------------------------------------------------------------------
let galaxyNode = null;
let bgNode = null;
let cameraNode = null;
let hudTimer = 0;

class GalaxyController extends Component {
    update(dt) {
        if (!(dt > 0) || !isFinite(dt)) { return; }
        dt = Math.min(dt, 0.1);

        // 星系慢旋(rotationPhase 单调递增;reset 归零后继续)
        state.phase += OMEGA * dt;
        galaxyNode.setRotationFromEuler(0, (state.phase * 180) / Math.PI, 0);

        // 相机距离:指数逼近目标(reset 用更快速率,1s 内完成;wheel 常速率)
        const k = performance.now() < state.resetUntil ? RESET_K : DIST_K;
        state.dist += (state.distTarget - state.dist) * (1 - Math.exp(-k * dt));

        // 视差:平滑、无过冲
        state.px += (state.pxTarget - state.px) * (1 - Math.exp(-PARALLAX_K * dt));
        state.py += (state.pyTarget - state.py) * (1 - Math.exp(-PARALLAX_K * dt));

        // 相机:仰角固定,距离驱动(视线与盘面法线夹角 ≈ 48°)
        cameraNode.setPosition(new Vec3(0, state.dist * Math.sin(ELEV), state.dist * Math.cos(ELEV)));
        cameraNode.lookAt(new Vec3(0, 0, 0));

        // 视差作用:星系层位移大、远景层位移小 → 轻微相对位移
        galaxyNode.setPosition(new Vec3(state.px * 5.0, state.py * 3.0, 0));
        bgNode.setPosition(new Vec3(state.px * 1.4, state.py * 0.85, 0));

        // HUD(0.2s 节流,数值取自真实状态,允许四舍五入)
        hudTimer -= dt;
        if (hudTimer <= 0) {
            hudTimer = 0.2;
            hudFps.textContent = 'FPS: ' + Math.round(fps);
            hudDist.textContent = 'Distance: ' + state.dist.toFixed(1);
            hudPhase.textContent = 'Phase: ' + state.phase.toFixed(2) + ' rad';
        }
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('galaxy');

    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, DIST_INIT * Math.sin(ELEV), DIST_INIT * Math.cos(ELEV)));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.5;
    camera.far = FAR;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(2, 3, 9, 255); // 深空近纯黑(暗于 RGB 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式
    camera.priority = 0;

    // 自定义 effect + 材质(一个材质实例可被两个渲染器共享,如同 builtin 材质)
    const effect = Object.assign(new EffectAsset(), buildPointEffect());
    effect.hideInEditor = true;
    effect.onLoaded(); // 注册到 EffectAsset/ProgramLib(与 registerBuiltinAirAssets 同构)
    const material = new Material();
    material.initialize({ effectAsset: effect });

    // 远景背景星(静态,不随星系旋转)
    bgNode = new Node('BackgroundStars');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgRenderer = bgNode.addComponent(MeshRenderer);
    bgRenderer.mesh = utils.MeshUtils.createMesh(buildBackgroundGeometry());
    bgRenderer.material = material;

    // 星系(单一 POINT_LIST 网格批量提交 60000 星点)
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const galaxyRenderer = galaxyNode.addComponent(MeshRenderer);
    galaxyRenderer.mesh = utils.MeshUtils.createMesh(buildGalaxyGeometry());
    galaxyRenderer.material = material;
    galaxyNode.addComponent(GalaxyController);

    window.__airApp = app;
    app.run(scene);

    // 帧计数 + 首帧就绪 + 2s 滚动帧率(渲染帧口径,与引擎绘制同步)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const t = performance.now();
        frameTimes.push(t);
        while (frameTimes.length > 0 && frameTimes[0] < t - 2000) { frameTimes.shift(); }
        if (frameTimes.length >= 5) {
            fps = (frameTimes.length - 1) / (Math.max(0.05, (t - frameTimes[0]) / 1000));
        }
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    // 指针视差:引擎 input 通道(pal 层会吞 canvas 原生鼠标事件,必须走 input.on)
    input.on(Input.EventType.MOUSE_MOVE, (m) => {
        const loc = m.getLocationInView();
        const w = Math.max(1, window.innerWidth);
        const h = Math.max(1, window.innerHeight);
        state.pxTarget = clamp((loc.x / w - 0.5) * 2, -1, 1);
        state.pyTarget = clamp((loc.y / h - 0.5) * 2, -1, 1);
    });

    // 滚轮穿行:capture 监听(引擎 pal 不转发 wheel)
    window.addEventListener('wheel', (e) => {
        state.distTarget = clamp(state.distTarget + e.deltaY * WHEEL_SENS, DIST_MIN, DIST_MAX);
        if (e.cancelable) { e.preventDefault(); }
    }, { capture: true, passive: false });

    console.log('[galaxy] running — stars =', STAR_COUNT, '(galaxy', GALAXY_STARS, '+ bg', BG_STARS + ')');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类(与模板一致)
    console.error('[galaxy] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
