/**
 * E01 — 深空星系巡航(Cocos AIR Reference)
 *
 * 技术路径(以 examples 真实写法为准):
 *   - 大规模星点:utils.createMesh(IGeometry)单 Mesh 承载全部星点,一次 draw call 提交。
 *     引擎坑位(实测定位,详见 WORKLOG.md):
 *       a) create-mesh 的 `primitiveMode || TRIANGLE_LIST` 判空把 POINT_LIST(=0)吞成三角形
 *          → createMesh 后补写 mesh.struct.primitives[*].primitiveMode(惰性初始化前);
 *       b) 实际 draw 的图元模式取自 Pass(effect JSON pass 的 `primitive` 字段,默认 TRIANGLE_LIST)
 *          → pass 显式声明 primitive: POINT_LIST;
 *       c) 顶点阶段读取材质 Constants/CCGlobal UBO 在本引擎自定义管线上读值不可靠(对照实验:
 *          CCCamera/CCLocal 正常 — 位置正确;CCGlobal/Constants 读到漂移值)
 *          → 点尺寸路径零 uniform:a_star.x 构建期烘焙 worldSize × pxScale,
 *             视距取透视除法前的 gl_Position.w(透视相机下 = -z_view);resize 时重建 mesh。
 *   - 材质:用户自写 GLSL 的 EffectAsset(examples/shader-custom-gradient 同款注册链路),
 *     additive 混合(ONE, ONE)+ 高斯衰减片元 → 星点辉光(引擎无 Bloom/EffectComposer,
 *     辉光以自发光粒子近似,记 ENGINE_LIMITED,见 REFERENCE-VERDICT.md)。
 *   - 相机:透视相机斜俯视(盘面法线与视线夹角 ≈ 52°),滚轮穿行 + 指针视差,
 *     全部逐帧指数平滑(帧率无关形式),reset 快速恢复(spec: 1s 内完成)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后 true。
 *   - window.__bench = { getState, reset } 按 E01 spec.stateContract(starCount = 真实渲染数)。
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
    Vec3,
    Color,
    Component,
    director,
    Director,
    gfx,
} from 'cocosair.js';

// ============================================================================
// 0. 常量与全局状态(__bench 契约,数值全部来自真实运行数据)
// ============================================================================

const STAR_RNG_SEED = 20261002;

// 星系结构配比(全部为真实渲染的独立星点)
const N_BULGE = 9000; // 核球
const N_ARMS = 40000; // 旋臂(对数螺旋 + 散布)
const N_DISK = 12000; // 盘面散布星
const N_HAZE = 1500; // 旋臂星云辉光大点
const N_DISTANT = 12000; // 远景背景星层(球壳包围相机,视野仅见其中 ~10%)
const N_GALAXY = N_BULGE + N_ARMS + N_DISK + N_HAZE;
const N_TOTAL = N_GALAXY + N_DISTANT;

const R_GAL = 62; // 星系盘半径(世界单位)
const BULGE_R = 7.5;
const WIND_B = 0.55; // 对数螺旋 r = 1.8·e^{bθ} 的 b

const OMEGA = 0.05; // rad/s 星系自转 ∈ [0.02, 0.1]
const OMEGA_DISTANT = 0.006; // 远景层慢速转
const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const WHEEL_SCALE = 0.12; // deltaY → 距离目标增量(滚轮一格 ≈ 60-72 单位穿行)
const TAU_DIST = 0.55; // 距离平滑时间常数(慢速巡航感)
const TAU_DIST_RECOVER = 0.18; // reset 恢复时间常数(spec: 1s 内完成)
const TAU_PARALLAX = 0.2; // 视差平滑时间常数
const THETA0 = 0.42; // 初始方位角
const PHI0 = 0.66; // 初始仰角 ≈ 38° → 盘面法线与视线夹角 ≈ 52° ∈ [30°, 60°]
const PARALLAX_THETA = 0.14; // 满偏视差方位摆幅(rad)
const PARALLAX_PHI = 0.1; // 满偏视差仰角摆幅(rad)
const FOV_DEG = 45;

const state = {
    starCount: N_TOTAL, // 真实提交渲染的星点数(启动后复核)
    rotationPhase: 0,
    cameraDistance: DIST_INIT,
    parallaxOffset: { x: 0, y: 0 },
    fps: 0,
    hudVisible: true,
    epoch: 0,
};

const input_rt = {
    pointer: { x: 0.5, y: 0.5 },
    hasPointer: false,
    anchor: { x: 0.5, y: 0.5 }, // 视差基准(初始画面中心;reset 重新锚定)
    distTarget: DIST_INIT,
    distActual: DIST_INIT,
    recovering: false,
    parSmooth: { x: 0, y: 0 },
};

window.__appReady = false;

let galaxyNode = null;
let distantNode = null;
let cameraNode = null;
let galaxyRenderer = null;
let distantRenderer = null;
let appCanvas = null;
let lastCanvasH = 0;
let curPxScale = 0;
let starGen = null; // 静态星点数据(positions/colors/worldSizes/seeds)
let distantPhase = 0;
let hudTick = 0;
let hudDirty = true;

function doReset() {
    state.epoch += 1;
    state.rotationPhase = 0;
    distantPhase = 0;
    if (galaxyNode && galaxyNode.isValid) galaxyNode.setRotationFromEuler(0, 0, 0);
    if (distantNode && distantNode.isValid) distantNode.setRotationFromEuler(0, 0, 0);
    input_rt.distTarget = DIST_INIT;
    input_rt.recovering = true;
    input_rt.parSmooth.x = 0;
    input_rt.parSmooth.y = 0;
    // 重新锚定指针:点击 Reset 后指针停在按钮上,重新锚定使视差归零并保持,
    // 直到指针再次移动(等价恢复"初始观察状态",非整页刷新)。
    input_rt.anchor.x = input_rt.pointer.x;
    input_rt.anchor.y = input_rt.pointer.y;
    hudDirty = true;
}

window.__bench = {
    getState: () => ({
        starCount: state.starCount,
        rotationPhase: state.rotationPhase,
        cameraDistance: Math.round(state.cameraDistance * 1000) / 1000,
        parallaxOffset: {
            x: Math.round(input_rt.parSmooth.x * 10000) / 10000,
            y: Math.round(input_rt.parSmooth.y * 10000) / 10000,
        },
        fps: Math.round(state.fps * 10) / 10,
        hudVisible: state.hudVisible,
        epoch: state.epoch,
    }),
    reset: doReset,
};

// ============================================================================
// 1. HUD DOM 覆盖层(data-ui 对齐 spec 探针:ui#reset / HUD 文本)
// ============================================================================

let hudEls = null;

function buildHud() {
    const panel = document.createElement('div');
    panel.setAttribute('data-ui', 'hud');
    panel.setAttribute('aria-label', 'hud');
    panel.style.cssText =
        'position:fixed;left:14px;top:14px;z-index:9999;pointer-events:none;' +
        "font:12px/1.6 'Consolas','Menlo',monospace;color:#cfe3ff;" +
        'background:rgba(7,11,20,0.74);border:1px solid rgba(96,148,224,0.38);' +
        'border-radius:8px;padding:10px 14px 12px;min-width:178px;' +
        'box-shadow:0 0 18px rgba(40,80,160,0.25);backdrop-filter:blur(3px);';
    panel.innerHTML =
        '<div style="letter-spacing:.14em;color:#7fa8e8;font-size:10px;margin-bottom:6px;">DEEP SPACE · GALAXY CRUISE</div>' +
        '<div>Stars <span data-ui="hud-stars" style="float:right;color:#fff">—</span></div>' +
        '<div>FPS <span data-ui="hud-fps" style="float:right;color:#fff">—</span></div>' +
        '<div>Dist <span data-ui="hud-dist" style="float:right;color:#fff">—</span></div>' +
        '<div>Phase <span data-ui="hud-phase" style="float:right;color:#fff">—</span></div>';
    const btn = document.createElement('button');
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.textContent = 'Reset';
    btn.style.cssText =
        'pointer-events:auto;display:block;width:100%;margin-top:9px;padding:4px 10px;' +
        "font:11px 'Consolas',monospace;background:#1b2a46;color:#e8f1ff;" +
        'border:1px solid #4a76b8;border-radius:5px;cursor:pointer;';
    btn.addEventListener('mouseenter', () => {
        btn.style.background = '#27406b';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.background = '#1b2a46';
    });
    btn.addEventListener('click', () => doReset());
    panel.appendChild(btn);
    document.body.appendChild(panel);
    hudEls = {
        stars: panel.querySelector('[data-ui="hud-stars"]'),
        fps: panel.querySelector('[data-ui="hud-fps"]'),
        dist: panel.querySelector('[data-ui="hud-dist"]'),
        phase: panel.querySelector('[data-ui="hud-phase"]'),
    };
}

function updateHudText() {
    if (!hudEls) return;
    hudEls.stars.textContent = state.starCount.toLocaleString('en-US');
    hudEls.fps.textContent = String(Math.round(state.fps));
    hudEls.dist.textContent = state.cameraDistance.toFixed(1);
    hudEls.phase.textContent = ((state.rotationPhase * 180) / Math.PI).toFixed(1) + '°';
}

// ============================================================================
// 2. 星系程序化生成(对数螺旋 + 核球 + 盘面散布 + 星云辉光 + 远景层)
// ============================================================================

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussOf(rng) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 沿半径颜色梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝(带随机抖动),out[0..2]。 */
function radialColor(t, rng, out) {
    let r;
    let g;
    let b;
    if (t < 0.3) {
        const k = t / 0.3;
        r = 1.0;
        g = 0.93 - 0.15 * k;
        b = 0.72 - 0.1 * k;
    } else if (t < 0.65) {
        const k = (t - 0.3) / 0.35;
        r = 1.0 - 0.38 * k;
        g = 0.78 - 0.04 * k;
        b = 0.62 + 0.38 * k;
    } else {
        const k = (t - 0.65) / 0.35;
        r = 0.62 - 0.2 * k;
        g = 0.74 - 0.16 * k;
        b = 1.0;
    }
    const j = 0.05;
    out[0] = Math.min(1, Math.max(0, r + (rng() * 2 - 1) * j));
    out[1] = Math.min(1, Math.max(0, g + (rng() * 2 - 1) * j));
    out[2] = Math.min(1, Math.max(0, b + (rng() * 2 - 1) * j));
}

/** 三档亮暗层级:亮星 / 普通星 / 暗弱星 → [worldSize, brightness]。 */
function tierOf(rng) {
    const roll = rng();
    if (roll < 0.12) {
        return [0.55 + 0.65 * rng(), 0.95 + 0.5 * rng()];
    }
    if (roll < 0.7) {
        return [0.25 + 0.3 * rng(), 0.45 + 0.45 * rng()];
    }
    return [0.13 + 0.11 * rng(), 0.2 + 0.25 * rng()];
}

/** 生成静态星点数据(与 pxScale 无关;尺寸按世界单位存,构建 mesh 时再乘 pxScale)。 */
function generateStars() {
    const rng = mulberry32(STAR_RNG_SEED);
    const c = [0, 0, 0];

    const positions = new Float32Array(N_TOTAL * 3);
    const colors = new Float32Array(N_TOTAL * 4);
    const worldSizes = new Float32Array(N_TOTAL);
    const seeds = new Float32Array(N_TOTAL);
    let i = 0;

    const put = (x, y, z, r, g, b, size, seed) => {
        const p3 = i * 3;
        positions[p3] = x;
        positions[p3 + 1] = y;
        positions[p3 + 2] = z;
        const p4 = i * 4;
        colors[p4] = r;
        colors[p4 + 1] = g;
        colors[p4 + 2] = b;
        colors[p4 + 3] = 1;
        worldSizes[i] = size;
        seeds[i] = seed;
        i += 1;
    };

    // --- 核球:中央密集亮星群(暖黄白,压扁球状,中央隆起) ---
    for (let k = 0; k < N_BULGE; k++) {
        const r = 0.25 + Math.pow(rng(), 2.2) * BULGE_R;
        const ct = r / BULGE_R;
        const u = rng() * 2 - 1;
        const phi = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const size = 0.16 + 0.34 * Math.pow(rng(), 1.6);
        const bright = 0.6 + 0.8 * Math.pow(rng(), 1.4) * (1.15 - 0.4 * ct);
        put(
            r * s * Math.cos(phi), r * u * 0.62, r * s * Math.sin(phi),
            (1.0 - 0.02 * ct) * bright,
            (0.97 - 0.17 * ct) * bright,
            (0.88 - 0.33 * ct) * bright,
            size, rng()
        );
    }

    // --- 旋臂:对数螺旋 + 随半径增大的角向/垂向散布 ---
    for (let k = 0; k < N_ARMS; k++) {
        const arm = k % 2; // 2 条臂
        const r = 2.2 + (R_GAL - 2.2) * Math.pow(rng(), 0.72);
        const thetaBase = Math.log(Math.max(r, 1.8) / 1.8) / WIND_B + arm * Math.PI;
        const theta = thetaBase + gaussOf(rng) * (0.1 + 0.0042 * r);
        const z = gaussOf(rng) * (0.7 + r * 0.028);
        const t = r / R_GAL;
        radialColor(t, rng, c);
        let [size, bright] = tierOf(rng);
        if (rng() < 0.03) {
            // 少量橙红亮星散布
            c[0] = 1.0; c[1] = 0.42; c[2] = 0.2;
            size = 0.5 + 0.6 * rng();
            bright = 1.1 + 0.5 * rng();
        }
        put(
            r * Math.cos(theta), z, r * Math.sin(theta),
            c[0] * bright, c[1] * bright, c[2] * bright,
            size, rng()
        );
    }

    // --- 盘面散布星(无结构盘成分,暗弱为主) ---
    for (let k = 0; k < N_DISK; k++) {
        const r = 2 + (R_GAL - 2) * Math.sqrt(rng());
        const theta = rng() * Math.PI * 2;
        const z = gaussOf(rng) * (1.0 + r * 0.02);
        const t = r / R_GAL;
        radialColor(t, rng, c);
        const bright = 0.22 + 0.42 * rng();
        const size = 0.13 + 0.16 * rng();
        put(
            r * Math.cos(theta), z, r * Math.sin(theta),
            c[0] * bright, c[1] * bright, c[2] * bright,
            size, rng()
        );
    }

    // --- 星云辉光层:沿旋臂的超大软光点(同为真实渲染星点) ---
    for (let k = 0; k < N_HAZE; k++) {
        const arm = k % 2;
        const r = 4 + (R_GAL - 6) * Math.pow(rng(), 0.8);
        const thetaBase = Math.log(Math.max(r, 1.8) / 1.8) / WIND_B + arm * Math.PI;
        const theta = thetaBase + gaussOf(rng) * (0.16 + 0.006 * r);
        const z = gaussOf(rng) * (1.2 + r * 0.02);
        const t = r / R_GAL;
        radialColor(t, rng, c);
        const bright = 0.026 + 0.03 * rng();
        const size = 3.5 + 5.5 * rng();
        put(
            r * Math.cos(theta), z, r * Math.sin(theta),
            c[0] * bright, c[1] * bright, c[2] * bright,
            size, rng()
        );
    }

    // --- 远景背景星层(球壳包围相机,视野立体角内仅 ~10% 可见,故数量取大) ---
    for (let k = 0; k < N_DISTANT; k++) {
        const dist = 540 + 340 * rng();
        const u = rng() * 2 - 1;
        const phi = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const warm = rng() < 0.18;
        const bright = 0.35 + 0.65 * rng();
        const size = 2.2 + 3.4 * rng();
        put(
            dist * s * Math.cos(phi), dist * u, dist * s * Math.sin(phi),
            (warm ? 1.0 : 0.72 + 0.2 * rng()) * bright,
            (warm ? 0.8 : 0.8 + 0.1 * rng()) * bright,
            (warm ? 0.62 : 1.0) * bright,
            size, rng()
        );
    }

    return { positions, colors, worldSizes, seeds, total: i };
}

/** 当前 canvas 的像素标定:世界单位 → 像素的尺寸换算系数。 */
function computePxScale() {
    if (!appCanvas || !appCanvas.height) return 720 * 0.5 / Math.tan(((FOV_DEG * 0.5) * Math.PI) / 180);
    return (appCanvas.height * 0.5) / Math.tan(((FOV_DEG * 0.5) * Math.PI) / 180);
}

/**
 * 由静态数据构建 POINT_LIST Mesh。
 * a_star.x = worldSize × pxScale(构建期烘焙,顶点阶段零 uniform);
 * resize 改变 pxScale 时重建(本场景视口固定,重建为罕见路径)。
 */
function buildStarMesh(from, count, pxScale) {
    const n = count;
    const stars = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        stars[i * 2] = starGen.worldSizes[from + i] * pxScale;
        stars[i * 2 + 1] = starGen.seeds[from + i];
    }
    const geometry = {
        positions: starGen.positions.subarray(from * 3, (from + n) * 3),
        colors: starGen.colors.subarray(from * 4, (from + n) * 4),
        customAttributes: [
            { attr: new gfx.Attribute('a_star', gfx.Format.RG32F), values: stars },
        ],
        primitiveMode: gfx.PrimitiveMode.POINT_LIST, // 引擎判空坑:POINT_LIST=0 被吞,下方补写
        minPos: from === 0 ? { x: -R_GAL - 1, y: -12, z: -R_GAL - 1 } : { x: -900, y: -900, z: -900 },
        maxPos: from === 0 ? { x: R_GAL + 1, y: 12, z: R_GAL + 1 } : { x: 900, y: 900, z: 900 },
    };
    const mesh = utils.createMesh(geometry);
    // 补写真实图元(惰性初始化前生效;实际 draw 图元另由 pass.primitive 决定)
    for (const prim of mesh.struct.primitives) {
        prim.primitiveMode = gfx.PrimitiveMode.POINT_LIST;
    }
    return mesh;
}

function rebuildMeshes() {
    curPxScale = computePxScale();
    if (galaxyRenderer) galaxyRenderer.mesh = buildStarMesh(0, N_GALAXY, curPxScale);
    if (distantRenderer) distantRenderer.mesh = buildStarMesh(N_GALAXY, N_DISTANT, curPxScale);
}

// ============================================================================
// 3. 自定义 Effect(additive 点精灵;glsl4/3/1 三变体,引擎无 chunk 系统需自带源码)
//    顶点阶段仅用 CCCamera/CCLocal(与 examples/shared/shader-blocks.js standardVert
//    同款已被验证的块);点尺寸零 uniform。
// ============================================================================

const STAR_VERT_GLSL4 = `precision highp float;
layout(set = 0, binding = 1) uniform CCCamera {
  highp   mat4 cc_matView;
  highp   mat4 cc_matViewInv;
  highp   mat4 cc_matProj;
  highp   mat4 cc_matProjInv;
  highp   mat4 cc_matViewProj;
  highp   mat4 cc_matViewProjInv;
  mediump vec4 cc_cameraPos;
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
in vec3 a_position;
in vec4 a_color;
in vec2 a_star;
out mediump vec4 v_color;
out mediump float v_seed;
void main () {
  gl_Position = cc_matProj * (cc_matView * (cc_matWorld * vec4(a_position, 1.0)));
  // 透视除法前的 gl_Position.w = -z_view(透视相机)即视距;
  // a_star.x 构建期已烘焙 worldSize × pxScale → 透视正确的点尺寸,零 uniform。
  gl_PointSize = clamp(a_star.x / gl_Position.w, 1.0, 96.0);
  v_color = a_color;
  v_seed = a_star.y;
}`;

const STAR_FRAG_GLSL4 = `precision mediump float;
layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};
in mediump vec4 v_color;
in mediump float v_seed;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float falloff = exp(-r2 * 14.0) * 1.06; // 高斯软核,边缘平滑衰减
  float twinkle = 0.82 + 0.18 * sin(cc_time.x * 2.1 + v_seed * 23.0);
  cc_FragColor = vec4(v_color.rgb * (falloff * twinkle), 1.0);
}`;

const STAR_VERT_GLSL1 = `precision highp float;
uniform highp mat4 cc_matView;
uniform highp mat4 cc_matProj;
uniform highp mat4 cc_matWorld;
attribute highp vec3 a_position;
attribute mediump vec4 a_color;
attribute mediump vec2 a_star;
varying mediump vec4 v_color;
varying mediump float v_seed;
void main () {
  gl_Position = cc_matProj * (cc_matView * (cc_matWorld * vec4(a_position, 1.0)));
  gl_PointSize = clamp(a_star.x / gl_Position.w, 1.0, 96.0);
  v_color = a_color;
  v_seed = a_star.y;
}`;

const STAR_FRAG_GLSL1 = `precision mediump float;
uniform highp vec4 cc_time;
varying mediump vec4 v_color;
varying mediump float v_seed;
void main () {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float falloff = exp(-r2 * 14.0) * 1.06;
  float twinkle = 0.82 + 0.18 * sin(cc_time.x * 2.1 + v_seed * 23.0);
  gl_FragColor = vec4(v_color.rgb * (falloff * twinkle), 1.0);
}`;

const stripLayout = (src) => src.replace(/layout\s*\([^)]*\)\s*/g, '');

const EFFECT_NAME = 'e01-star-points';
const PROG = 'e01-star-points|star-vs:vert|star-fs:frag';

function buildStarEffect() {
    const json = {
        name: EFFECT_NAME,
        techniques: [
            {
                passes: [
                    {
                        program: PROG,
                        // 实际 draw 图元由 Pass.primitive 决定(默认 TRIANGLE_LIST,必须显式声明)
                        primitive: gfx.PrimitiveMode.POINT_LIST,
                        // additive 混合:src·ONE + dst·ONE(颜色已在片元内预乘衰减)
                        rasterizerState: { cullMode: 0 },
                        depthStencilState: { depthTest: false, depthWrite: false },
                        blendState: {
                            targets: [
                                { blend: true, blendSrc: 1, blendDst: 1, blendSrcAlpha: 1, blendDstAlpha: 1 },
                            ],
                        },
                    },
                ],
            },
        ],
        shaders: [
            {
                name: PROG,
                hash: 731100,
                builtins: {
                    statistics: {
                        CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 47,
                        CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 4,
                    },
                    globals: {
                        blocks: [
                            { name: 'CCGlobal', defines: [], set: 0, binding: 0 },
                            { name: 'CCCamera', defines: [], set: 0, binding: 1 },
                        ],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                    locals: {
                        blocks: [{ name: 'CCLocal', defines: [], set: 2, binding: 0 }],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                },
                defines: [],
                attributes: [
                    { name: 'a_position', defines: [], format: gfx.Format.RGB32F, location: 0 },
                    { name: 'a_color', defines: [], format: gfx.Format.RGBA32F, location: 1 },
                    { name: 'a_star', defines: [], format: gfx.Format.RG32F, location: 2 },
                ],
                blocks: [],
                samplerTextures: [],
                buffers: [],
                images: [],
                textures: [],
                samplers: [],
                subpassInputs: [],
            },
        ],
        combinations: [],
        hideInEditor: false,
    };
    const e = Object.assign(new EffectAsset(), json);
    e.shaders[0].glsl4 = { vert: STAR_VERT_GLSL4, frag: STAR_FRAG_GLSL4 };
    e.shaders[0].glsl3 = { vert: stripLayout(STAR_VERT_GLSL4), frag: stripLayout(STAR_FRAG_GLSL4) };
    e.shaders[0].glsl1 = { vert: STAR_VERT_GLSL1, frag: STAR_FRAG_GLSL1 };
    e.onLoaded(); // programLib.register(必须在 createAirApp 之后)
    return e;
}

// ============================================================================
// 4. 巡航控制器:旋转 / 相机 / 平滑 / HUD / fps
// ============================================================================

const _origin = new Vec3(0, 0, 0);
const _camPos = new Vec3(0, 0, 0);
const frameTimes = [];

class CruiseCtrl extends Component {
    update(dt) {
        const dts = Math.min(Math.max(dt, 0), 0.1); // 后台恢复时钳制异常步长

        // --- 星系旋转 ---
        state.rotationPhase += OMEGA * dts;
        distantPhase += OMEGA_DISTANT * dts;
        if (galaxyNode && galaxyNode.isValid) {
            galaxyNode.setRotationFromEuler(0, (state.rotationPhase * 180) / Math.PI, 0);
        }
        if (distantNode && distantNode.isValid) {
            distantNode.setRotationFromEuler(0, (distantPhase * 180) / Math.PI, 0);
        }

        // --- 视差平滑(帧率无关指数;基于指针偏离画面中心的有符号偏移) ---
        const parTx = input_rt.pointer.x - input_rt.anchor.x;
        const parTy = input_rt.pointer.y - input_rt.anchor.y;
        const kPar = 1 - Math.exp(-dts / TAU_PARALLAX);
        input_rt.parSmooth.x += (parTx - input_rt.parSmooth.x) * kPar;
        input_rt.parSmooth.y += (parTy - input_rt.parSmooth.y) * kPar;
        state.parallaxOffset.x = input_rt.parSmooth.x;
        state.parallaxOffset.y = input_rt.parSmooth.y;

        // --- 距离平滑(巡航慢速;reset 后快速恢复) ---
        const tau = input_rt.recovering ? TAU_DIST_RECOVER : TAU_DIST;
        input_rt.distActual += (input_rt.distTarget - input_rt.distActual) * (1 - Math.exp(-dts / tau));
        if (input_rt.recovering && Math.abs(input_rt.distTarget - input_rt.distActual) < 0.5) {
            input_rt.recovering = false;
        }
        state.cameraDistance = input_rt.distActual;

        // --- 相机位姿(斜俯视 + 视差摆动 + 距离穿行) ---
        const theta = THETA0 + input_rt.parSmooth.x * PARALLAX_THETA;
        const phi = Math.min(1.25, Math.max(0.18, PHI0 - input_rt.parSmooth.y * PARALLAX_PHI));
        const d = input_rt.distActual;
        const cp = Math.cos(phi);
        _camPos.set(d * cp * Math.sin(theta), d * Math.sin(phi), d * cp * Math.cos(theta));
        cameraNode.setPosition(_camPos);
        cameraNode.lookAt(_origin);

        // --- 点尺寸标定(canvas 设备像素高变化 → 重建 mesh 烘焙新 pxScale) ---
        if (appCanvas && appCanvas.height !== lastCanvasH) {
            lastCanvasH = appCanvas.height;
            rebuildMeshes();
        }

        // --- HUD(约 8Hz 刷新,数值与 __bench 状态一致) ---
        hudTick += 1;
        if (hudTick % 8 === 0 || hudDirty) {
            hudDirty = false;
            updateHudText();
        }
    }
}

// ============================================================================
// 5. 启动
// ============================================================================

try {
    buildHud();
    updateHudText();

    const canvas = document.querySelector('#GameCanvas');
    appCanvas = canvas;
    const app = await createAirApp({ canvas });

    // 星点静态数据 + 效果注册(EffectAsset.onLoaded 必须在 createAirApp 之后)
    starGen = generateStars();
    state.starCount = starGen.total; // 真实提交渲染的星点数

    const effect = buildStarEffect();
    const starMaterial = new Material();
    starMaterial.initialize({ effectAsset: effect });

    const scene = new Scene('e01-galaxy');

    // Camera(visibility 必须显式设置 — 引擎 4.0-alpha 默认 undefined)
    cameraNode = new Node('Cruise Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(80, 70, 96));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = FOV_DEG;
    camera.near = 1;
    camera.far = 4000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(10, 10, 16, 255); // 接近纯黑深空色
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 星系节点(自转)+ 远景节点(极慢转)
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    galaxyRenderer = galaxyNode.addComponent(MeshRenderer);
    galaxyRenderer.material = starMaterial;

    distantNode = new Node('DistantStars');
    distantNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(distantNode);
    distantRenderer = distantNode.addComponent(MeshRenderer);
    distantRenderer.material = starMaterial;

    // 初始 mesh(含 pxScale 烘焙)
    lastCanvasH = appCanvas ? appCanvas.height : 0;
    rebuildMeshes();

    // 控制组件(随场景生命周期)
    const ctrlNode = new Node('CruiseCtrl');
    scene.addChild(ctrlNode);
    ctrlNode.addComponent(CruiseCtrl);

    // --- 输入:指针视差 + 滚轮穿行(DOM 捕获阶段监听 — 引擎在 canvas 上
    //     对 wheel preventDefault+stopPropagation,冒泡阶段到不了 window,实测定位) ---
    window.addEventListener(
        'pointermove',
        (e) => {
            input_rt.pointer.x = e.clientX / window.innerWidth;
            input_rt.pointer.y = e.clientY / window.innerHeight;
            input_rt.hasPointer = true;
        },
        { passive: true, capture: true }
    );
    window.addEventListener(
        'mousemove',
        (e) => {
            if (input_rt.hasPointer) return; // pointermove 已覆盖,仅兜底
            input_rt.pointer.x = e.clientX / window.innerWidth;
            input_rt.pointer.y = e.clientY / window.innerHeight;
            input_rt.hasPointer = true;
        },
        { passive: true, capture: true }
    );
    window.addEventListener(
        'wheel',
        (e) => {
            const dy = e.deltaY;
            if (!Number.isFinite(dy) || dy === 0) return;
            let t = input_rt.distTarget + dy * WHEEL_SCALE;
            t = Math.min(DIST_MAX, Math.max(DIST_MIN, t));
            input_rt.distTarget = t;
            input_rt.recovering = false; // 用户重新接管,恢复正常巡航平滑
        },
        { passive: true, capture: true }
    );

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // --- 帧率:2s 滚动平均(EVENT_AFTER_DRAW 每渲染帧触发) ---
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        const cutoff = now - 2000;
        while (frameTimes.length > 0 && frameTimes[0] < cutoff) frameTimes.shift();
        if (frameTimes.length >= 2) {
            const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
            if (span > 0.1) {
                state.fps = (frameTimes.length - 1) / span;
            }
        }
        if (!window.__appReady) {
            window.__appReady = true;
            hudDirty = true;
        }
    });

    console.log(
        '[e01] galaxy cruise on cocosair — stars:',
        starGen.total,
        '(galaxy', N_GALAXY, '+ distant', N_DISTANT, ') pxScale:', Math.round(curPxScale)
    );
} catch (err) {
    console.error('[e01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
