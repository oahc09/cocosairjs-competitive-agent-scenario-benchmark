/**
 * E01 — 深空星系巡航(Deep Space Galaxy Cruise)— cocosair K0 实现
 *
 * 设计(全部程序化,无外部资产):
 *   - 星系 = 单个批量 Mesh:52,000 颗星 × 随机朝向四边形(双面索引,免材质 cull 定制),
 *     顶点色沿半径呈梯度(核球暖黄白 → 中段蓝白 → 外缘冷蓝,3% 橙红亮星),
 *     亮度/尺寸分档:核球亮星 / 旋臂盘面星 / 暗弱盘面星,构成 ≥3 档亮暗层级。
 *   - 旋臂:2 条对数螺旋 r = r0·e^(b·θ),叠加高斯散布;核球为高斯 3D 中心聚集。
 *   - 远景背景星:6,000 颗,静态球壳层(独立节点,不随星系旋转),增强纵深与视差。
 *   - 材质:builtin-unlit-material,经 renderer.getMaterialInstance(0) 开启
 *     USE_VERTEX_COLOR 宏并覆写混合状态为加色叠加(additive);任一步失败仅降级为
 *     不透明渲染,不影响契约(no-uncaught-errors 优先)。
 *   - 旋转:整个星系节点绕盘面法线(+Y)慢旋 ω=0.06 rad/s,rotationPhase 单调递增。
 *   - 相机:固定仰角 38°(斜俯视),滚轮改变目标距离 [40,400] 初始 120,逐帧指数
 *     插值平滑;指针视差为小幅横向偏移(≤10% 画布),由指针相对画面中心的有符号
 *     归一偏移驱动。
 *   - 输入:canvas 鼠标事件被 pal 层吞 → 指针移动走 window 捕获阶段监听(同时挂引擎
 *     input.on MOUSE_MOVE 作后备,幂等写同一绝对目标);wheel 按已知坑位用捕获监听。
 *   - HUD:左上角 2D DOM 覆盖层,实时显示星点总数/帧率/相机距离/相位(与 __bench
 *     状态同源),内含 Reset 按钮(可见文本 Reset + aria-label=reset + data-ui=reset)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): {starCount, rotationPhase, cameraDistance,
 *     parallaxOffset:{x,y}, fps, hudVisible, epoch}, reset(): void }。
 *   - reset():相位归零、距离恢复 120、视差归零、epoch+1;原地恢复,不整页刷新。
 */

import * as cc from 'cocosair.js';

const {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    builtinResMgr,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
} = cc;

// ---------- 场景常量 ----------
const GALAXY_RADIUS = 66;       // 星系盘半径:距 120 + fov60 下约占画面宽度 63%([60,75])
const ARM_COUNT = 2;            // 对数螺旋旋臂数
const N_BULGE = 6000;           // 核球星数
const N_DISK = 12000;           // 盘面随机星数
const N_ARM = 34000;            // 旋臂星数
const N_BG = 6000;              // 远景背景星数
const N_GALAXY = N_BULGE + N_DISK + N_ARM; // 52,000
const STAR_TOTAL = N_GALAXY + N_BG;        // 58,000(= 真实提交渲染数)

const CAM_DIST_INIT = 120;
const CAM_DIST_MIN = 40;
const CAM_DIST_MAX = 400;
const CAM_ELEV = (38 * Math.PI) / 180; // 仰角 38°:盘面法线与视线夹角 ∈ [30°,60°]
const CAM_FOV = 60;             // 垂直视场角:R75 星系盘约占画面宽度 6 成
const OMEGA = 0.06;             // 星系角速度 rad/s ∈ [0.02,0.1]
const DIST_TAU = 0.3;           // 相机距离指数平滑时间常数(s):P4 窗口内仍可见移动
const PARALLAX_SCALE = 0.24;    // 视差状态 = 指针归一偏移 × scale(≤10% 画布)
const PARALLAX_TAU = 0.35;      // 视差平滑时间常数(s)
const WHEEL_ZOOM_K = 0.002;     // deltaY → 距离乘子指数

// ---------- 可复现随机(固定种子,同一产物逐字节一致行为) ----------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(0x20261004);
let _gSpare = null;
function gauss() { // Box-Muller
    if (_gSpare !== null) { const v = _gSpare; _gSpare = null; return v; }
    let u = 0, v = 0, s = 0;
    do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    _gSpare = v * m;
    return u * m;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------- 运行时状态(初始值即合同要求) ----------
const state = {
    rotationPhase: 0,                 // rad,初始 0
    camDist: CAM_DIST_INIT,           // 当前渲染距离(逐帧插值)
    camDistTarget: CAM_DIST_INIT,     // 滚轮目标距离
    parallax: { x: 0, y: 0 },         // 当前视差(逐帧插值)
    parallaxTarget: { x: 0, y: 0 },
    fps: 0,                           // 2s 滚动平均
    epoch: 0,                         // reset 计数
};
window.__appReady = false;

function doReset() {
    state.epoch += 1;
    state.rotationPhase = 0;
    state.camDist = CAM_DIST_INIT;
    state.camDistTarget = CAM_DIST_INIT;
    state.parallax.x = 0; state.parallax.y = 0;
    state.parallaxTarget.x = 0; state.parallaxTarget.y = 0;
}

window.__bench = {
    getState: () => ({
        starCount: STAR_TOTAL,
        rotationPhase: state.rotationPhase,
        cameraDistance: state.camDist,
        parallaxOffset: { x: state.parallax.x, y: state.parallax.y },
        fps: state.fps,
        hudVisible: true,
        epoch: state.epoch,
    }),
    reset: doReset,
};

// ---------- HUD + Reset 控件(2D 覆盖层,置于角落,不遮挡星系主体) ----------
const hudRefs = {};
{
    const hud = document.createElement('div');
    hud.setAttribute('data-ui', 'hud');
    hud.setAttribute('aria-label', 'hud');
    hud.style.cssText =
        'position:fixed;top:10px;left:10px;z-index:9998;pointer-events:none;' +
        'font:12px/1.6 Consolas,Menlo,monospace;color:#dfe8ff;' +
        'background:rgba(4,7,14,0.55);border:1px solid rgba(120,150,220,0.35);' +
        'border-radius:6px;padding:8px 12px;user-select:none;';
    const row = (id, label) =>
        `<div id="${id}" style="white-space:pre">${label}</div>`;
    hud.innerHTML =
        '<div style="font-weight:bold;letter-spacing:1px;color:#9fc0ff">DEEP SPACE GALAXY CRUISE</div>' +
        row('e01-hud-stars', 'Stars: 0') +
        row('e01-hud-fps', 'FPS: 0') +
        row('e01-hud-dist', 'Distance: 120.0') +
        row('e01-hud-phase', 'Phase: 0.00 rad');
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.style.cssText =
        'pointer-events:auto;margin-top:6px;padding:4px 14px;' +
        'font:12px sans-serif;background:#1a2438;color:#e8f0ff;' +
        'border:1px solid #6f8fce;border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    hud.appendChild(btn);
    document.body.appendChild(hud);
    hudRefs.stars = hud.querySelector('#e01-hud-stars');
    hudRefs.fps = hud.querySelector('#e01-hud-fps');
    hudRefs.dist = hud.querySelector('#e01-hud-dist');
    hudRefs.phase = hud.querySelector('#e01-hud-phase');
}
function hudRefresh() {
    hudRefs.stars.textContent = `Stars: ${STAR_TOTAL}`;
    hudRefs.fps.textContent = `FPS: ${Math.round(state.fps)}`;
    hudRefs.dist.textContent = `Distance: ${state.camDist.toFixed(1)}`;
    hudRefs.phase.textContent = `Phase: ${state.rotationPhase.toFixed(2)} rad`;
    lastShownFps = Math.round(state.fps);
}
let lastShownFps = 0; // HUD 上次显示的 fps:为 0 时逐帧刷新,尽快给出真实帧率

// ---------- 输入:指针视差 + 滚轮穿行(捕获阶段,规避 pal 层吞事件) ----------
function isHudTarget(t) {
    return !!(t && t.closest && t.closest('[data-ui="hud"]'));
}
function setPointerNorm(nx, ny) { // nx,ny ∈ [0,1],原点左上
    state.parallaxTarget.x = clamp(nx - 0.5, -0.5, 0.5) * PARALLAX_SCALE;
    state.parallaxTarget.y = clamp(0.5 - ny, -0.5, 0.5) * PARALLAX_SCALE;
}
const onPointerMoveDom = (e) => {
    if (isHudTarget(e.target)) return; // reset 点击把指针带进按钮:不产生视差目标
    setPointerNorm(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
};
// pointermove 与 mousemove 双挂(幂等写同一绝对目标;任一通道被吞仍有另一通道)
window.addEventListener('pointermove', onPointerMoveDom, true);
window.addEventListener('mousemove', onPointerMoveDom, true);
window.addEventListener('wheel', (e) => {
    if (isHudTarget(e.target)) return;
    if (e.cancelable) e.preventDefault();
    state.camDistTarget = clamp(
        state.camDistTarget * Math.exp(e.deltaY * WHEEL_ZOOM_K),
        CAM_DIST_MIN, CAM_DIST_MAX,
    );
}, { capture: true, passive: false });
// 引擎 input.on 后备(已知坑位:canvas 鼠标事件被 pal 层吞;幂等写同一目标,无害)
try {
    if (cc.input && cc.Input && cc.Input.EventType && cc.Input.EventType.MOUSE_MOVE) {
        cc.input.on(cc.Input.EventType.MOUSE_MOVE, (ev) => {
            try {
                if (!ev || !ev.getLocation) return;
                const loc = ev.getLocation();
                setPointerNorm(loc.x / window.innerWidth, 1 - loc.y / window.innerHeight);
            } catch { /* 后备通道,失败忽略 */ }
        });
    }
} catch { /* 引擎输入不可用时主通道仍在 */ }

// ---------- 程序化几何:星系盘 + 背景星壳 ----------
// 每星一个随机朝向四边形(4 顶点 + 双面 12 索引),顶点色 RGBA(0..1 浮点,
// createMesh 默认 COLOR 通道为 RGBA32F,已从构建产物核实)。
function starColor(q, tierBright) { // q = 归一化半径 ∈ [0,1]
    // 半径梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝;3% 橙红亮星散布
    let r, g, b;
    if (rand() < 0.03) {
        r = 1.0; g = 0.5; b = 0.32; // 橙红亮星
    } else if (q < 0.5) {
        const t = q / 0.5;
        r = 1.0 + (0.85 - 1.0) * t; g = 0.88 + (0.90 - 0.88) * t; b = 0.62 + (1.0 - 0.62) * t;
    } else {
        const t = (q - 0.5) / 0.5;
        r = 0.85 + (0.60 - 0.85) * t; g = 0.90 + (0.72 - 0.90) * t; b = 1.0;
    }
    return [r * tierBright, g * tierBright, b * tierBright, 1];
}

function allocArrays(n) {
    return {
        pos: new Float32Array(n * 15),   // 每星 5 顶点(中心 + 4 角)× 3 分量
        col: new Float32Array(n * 20),   // × 4 分量
        idx: new Uint32Array(n * 24),    // 4 正面 + 4 背面三角
        v: 0, i: 0,
    };
}
function pushStar(A, cx, cy, cz, size, cr, cg, cb, ca) {
    // 随机朝向正交基
    let nx = gauss(), ny = gauss(), nz = gauss();
    let l = Math.hypot(nx, ny, nz); if (l < 1e-6) { nx = 1; l = 1; }
    nx /= l; ny /= l; nz /= l;
    let ax, ay, az; // 与 n 不平行的辅助轴
    if (Math.abs(ny) < 0.9) { ax = 0; ay = 1; az = 0; } else { ax = 1; ay = 0; az = 0; }
    let ux = ay * nz - az * ny, uy = az * nx - ax * nz, uz = ax * ny - ay * nx;
    l = Math.hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const s = size;
    const p = A.pos, base = A.v * 15;      // 每星 5 顶点 × 3 分量
    const c = A.col, cb0 = A.v * 20;       // × 4 分量
    // 顶点 0 = 中心(全亮),顶点 1..4 = 四角(12% 亮度)→ 顶点色插值出软辉光
    p[base + 0] = cx; p[base + 1] = cy; p[base + 2] = cz;
    p[base + 3] = cx + (ux + vx) * s; p[base + 4] = cy + (uy + vy) * s; p[base + 5] = cz + (uz + vz) * s;
    p[base + 6] = cx + (-ux + vx) * s; p[base + 7] = cy + (-uy + vy) * s; p[base + 8] = cz + (-uz + vz) * s;
    p[base + 9] = cx - (ux + vx) * s; p[base + 10] = cy - (uy + vy) * s; p[base + 11] = cz - (uz + vz) * s;
    p[base + 12] = cx + (ux - vx) * s; p[base + 13] = cy + (uy - vy) * s; p[base + 14] = cz + (uz - vz) * s;
    const cr2 = cr, cg2 = cg, cb3 = cb, edge = 0.12;
    c[cb0 + 0] = cr2; c[cb0 + 1] = cg2; c[cb0 + 2] = cb3; c[cb0 + 3] = ca;
    for (let k = 1; k < 5; k++) {
        c[cb0 + k * 4 + 0] = cr2 * edge; c[cb0 + k * 4 + 1] = cg2 * edge;
        c[cb0 + k * 4 + 2] = cb3 * edge; c[cb0 + k * 4 + 3] = ca;
    }
    const i0 = A.v * 5, o = A.i, ix = A.idx;
    for (let k = 0; k < 4; k++) { // 中心扇形,绕 n 逆时针
        const a = 1 + k, bNext = 1 + ((k + 1) % 4);
        ix[o + k * 3 + 0] = i0; ix[o + k * 3 + 1] = i0 + a; ix[o + k * 3 + 2] = i0 + bNext;
        const o2 = o + 12 + k * 3; // 背面(反转绕向,免材质 cull 定制)
        ix[o2 + 0] = i0; ix[o2 + 1] = i0 + bNext; ix[o2 + 2] = i0 + a;
    }
    A.v += 1; A.i += 24;
}

function buildGalaxyArrays() {
    const A = allocArrays(N_GALAXY);
    const b = Math.log(GALAXY_RADIUS / 6) / 4.6; // 对数螺旋:r = 6·e^(b·θ),θ∈[0,4.6]
    for (let i = 0; i < N_ARM; i++) {
        const arm = i % ARM_COUNT;
        const t = Math.pow(rand(), 0.72); // 内密外疏
        const theta = t * 4.6;
        const r = 6 * Math.exp(b * theta);
        const ang = theta + arm * ((Math.PI * 2) / ARM_COUNT)
            + gauss() * (0.14 - 0.05 * t);
        const rr = r + gauss() * (2.2 + 4.5 * t);
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        const y = gauss() * (2.0 - 1.3 * t); // 内厚外薄,盘面有可感知厚度
        const q = clamp(rr / GALAXY_RADIUS, 0, 1);
        const bright = 0.6 + rand() * 0.35;
        const [cr, cg, cb2, ca] = starColor(q, bright);
        pushStar(A, x, y, z, 0.34 + rand() * 0.26, cr, cg, cb2, ca);
    }
    for (let i = 0; i < N_BULGE; i++) {
        const x = gauss() * 4.5, y = gauss() * 2.8, z = gauss() * 4.5; // 中央明亮聚集 + 隆起
        const q = clamp(Math.hypot(x, z) / GALAXY_RADIUS, 0, 1);
        const bright = 0.9 + rand() * 0.1; // 第一档:核球亮星
        const [cr, cg, cb2, ca] = starColor(q * 0.35, bright);
        pushStar(A, x, y, z, 0.6 + rand() * 0.6, cr, cg, cb2, ca);
    }
    for (let i = 0; i < N_DISK; i++) {
        const r = 4 + (GALAXY_RADIUS - 4) * Math.sqrt(rand());
        const ang = rand() * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        const y = gauss() * (2.6 * (1 - r / GALAXY_RADIUS) + 0.7);
        const q = clamp(r / GALAXY_RADIUS, 0, 1);
        const bright = 0.42 + rand() * 0.28; // 第二/三档:普通盘面星与暗弱星
        const [cr, cg, cb2, ca] = starColor(q, bright);
        pushStar(A, x, y, z, 0.26 + rand() * 0.2, cr, cg, cb2, ca);
    }
    return A;
}

function buildBackgroundArrays() {
    const A = allocArrays(N_BG);
    for (let i = 0; i < N_BG; i++) {
        let x = gauss(), y = gauss(), z = gauss();
        const l = Math.hypot(x, y, z) || 1;
        const r = 550 + rand() * 350; // 远景球壳,静态层增强纵深
        x = (x / l) * r; y = (y / l) * r; z = (z / l) * r;
        const dim = 0.3 + rand() * 0.2;
        const warm = rand();
        pushStar(A, x, y, z, 2.4 + rand() * 2.4,
            (0.75 + 0.25 * warm) * dim, (0.8 + 0.15 * warm) * dim, dim + 0.15, 1);
    }
    return A;
}

function arraysToGeometry(A, bounds) {
    return {
        positions: A.pos,
        colors: A.col,
        indices: A.idx,
        minPos: { x: -bounds, y: -bounds, z: -bounds },
        maxPos: { x: bounds, y: bounds, z: bounds },
    };
}

// ---------- 材质:unlit + 顶点色 + 加色叠加(每步可降级,不抛致命) ----------
function applyStarMaterial(renderer, tag) {
    const mat = builtinResMgr.get('builtin-unlit-material');
    renderer.material = mat;
    try {
        const mi = renderer.getMaterialInstance(0);
        if (!mi) return;
        if (typeof mi.recompileShaders === 'function') {
            mi.recompileShaders({ USE_VERTEX_COLOR: true });
        }
        const BF = cc.gfx && cc.gfx.BlendFactor;
        if (BF && typeof mi.overridePipelineStates === 'function') {
            mi.overridePipelineStates({
                blendState: {
                    targets: [{
                        blend: true,
                        blendSrc: BF.ONE, blendDst: BF.ONE,
                        blendSrcAlpha: BF.ONE, blendDstAlpha: BF.ONE,
                    }],
                },
            });
        }
        console.log(`[e01] star material ready (${tag}): vertexColor+additive`);
    } catch (e) {
        console.warn(`[e01] ${tag} material override degraded:`, e && e.message);
    }
}

// ---------- 每帧行为:旋转 + 相机插值 + HUD ----------
class GalaxyController extends Component {
    constructor() {
        super();
        this._v3 = new Vec3();
        this._target = new Vec3(0, 0, 0); // lookAt(worldPos: Vec3) 单参数
        this._hudAcc = 0;
    }
    start() { hudRefresh(); }
    update(dt) {
        const d = Math.min(dt, 0.1); // 后台节流恢复不跳变
        // 旋转相位单调递增
        state.rotationPhase += OMEGA * d;
        // 相机距离:逐帧指数插值(不瞬跳)
        state.camDist += (state.camDistTarget - state.camDist) * (1 - Math.exp(-d / DIST_TAU));
        // 视差:小幅平滑,无过冲(指数趋近天然无振荡)
        const kP = 1 - Math.exp(-d / PARALLAX_TAU);
        state.parallax.x += (state.parallaxTarget.x - state.parallax.x) * kP;
        state.parallax.y += (state.parallaxTarget.y - state.parallax.y) * kP;
        // 应用星系旋转(绕盘面法线 +Y)
        if (galaxyNode && galaxyNode.isValid) {
            const deg = ((state.rotationPhase * 180) / Math.PI) % 360;
            galaxyNode.setRotationFromEuler(0, deg, 0);
        }
        // 应用相机:固定仰角球面 + 小幅横向视差,lookAt 星系中心
        if (cameraNode && cameraNode.isValid) {
            const dist = state.camDist;
            const lat = state.parallax.x * dist * 0.35;
            const ver = state.parallax.y * dist * 0.35;
            this._v3.set(lat, Math.sin(CAM_ELEV) * dist + ver, Math.cos(CAM_ELEV) * dist);
            cameraNode.setPosition(this._v3);
            cameraNode.lookAt(this._target);
        }
        // HUD 刷新:fps 未就绪或相机/视差仍在收敛时逐帧,空闲时 4Hz(真实运行数据)
        this._hudAcc += d;
        const converging = Math.abs(state.camDistTarget - state.camDist) > 0.05
            || Math.abs(state.parallaxTarget.x - state.parallax.x) > 0.0005
            || Math.abs(state.parallaxTarget.y - state.parallax.y) > 0.0005;
        if (this._hudAcc >= 0.25 || lastShownFps === 0 || converging) {
            this._hudAcc = 0;
            hudRefresh();
        }
    }
}

// ---------- 帧率:2s 滚动平均(EVENT_AFTER_DRAW 真实渲染帧) ----------
const frameTimes = [];
function onFrameDrawn() {
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length > 1 && now - frameTimes[0] > 2000) frameTimes.shift();
    if (frameTimes.length > 1) {
        const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
        state.fps = ((frameTimes.length - 1) * 1000) / Math.max(span, 1);
    }
    if (!window.__appReady) window.__appReady = true; // 首帧就绪
}

let galaxyNode = null;
let cameraNode = null;

// ---------- 自检辅助(仅供 Agent 探针自查;不参与契约) ----------
// 用法:await window.__e01.litRatio() → 全屏亮像素(亮度>40/255)占比
window.__e01 = {
    litRatio() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                try {
                    const canvas = document.querySelector('#GameCanvas');
                    const gl = canvas.getContext('webgl2');
                    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
                    const buf = new Uint8Array(w * h * 4);
                    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                    let lit = 0, total = 0;
                    for (let i = 0; i < buf.length; i += 16) { // 1/4 抽样
                        total++;
                        if ((buf[i] + buf[i + 1] + buf[i + 2]) / 3 > 40) lit++;
                    }
                    resolve({ litRatio: lit / total, w, h });
                } catch (e) {
                    resolve({ error: String((e && e.message) || e) });
                }
            });
        });
    },
    simulate: {
        wheel(deltaY) {
            window.dispatchEvent(new WheelEvent('wheel', { deltaY, cancelable: true }));
        },
        pointerMove(nx, ny) {
            const x = nx * window.innerWidth, y = ny * window.innerHeight;
            const opts = { clientX: x, clientY: y, bubbles: true };
            window.dispatchEvent(new PointerEvent('pointermove', opts));
            window.dispatchEvent(new MouseEvent('mousemove', opts));
        },
        clickReset() {
            const b = document.querySelector('[data-ui="reset"]');
            if (b) b.click();
            return !!b;
        },
    },
};

// ---------- 主流程 ----------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E01-galaxy');

    // 相机:斜俯视 38°,初始距离 120,fov 60(星系盘约占画面宽度 6 成)
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, Math.sin(CAM_ELEV) * CAM_DIST_INIT, Math.cos(CAM_ELEV) * CAM_DIST_INIT));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CAM_FOV;
    camera.near = 0.5;
    camera.far = 3000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(3, 5, 9, 255); // 接近纯黑深空色(< RGB 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;     // 已知坑位:必须显式设置
    camera.priority = 0;

    // 星系盘(52,000 星,批量单 Mesh)
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const galaxyMr = galaxyNode.addComponent(MeshRenderer);
    galaxyMr.mesh = utils.createMesh(arraysToGeometry(buildGalaxyArrays(), GALAXY_RADIUS * 1.4));
    applyStarMaterial(galaxyMr, 'galaxy');
    galaxyNode.addComponent(GalaxyController);

    // 远景背景星壳(6,000 星,静态,不随星系旋转 → 纵深视差)
    const bgNode = new Node('BackgroundStars');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgMr = bgNode.addComponent(MeshRenderer);
    bgMr.mesh = utils.createMesh(arraysToGeometry(buildBackgroundArrays(), 950));
    applyStarMaterial(bgMr, 'background');

    window.__airApp = app; // 开发面板/agent session 显式绑定入口
    app.run(scene);

    director.on(Director.EVENT_AFTER_DRAW, onFrameDrawn);

    console.log('[e01] galaxy cruise running:', app.getScene() && app.getScene().name,
        'stars =', STAR_TOTAL);
} catch (err) {
    // 致命错误(如 WebGL2 不可用 → WEBGL2_REQUIRED):显式抛出为未捕获错误,便于 harness 分类
    console.error('[e01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
