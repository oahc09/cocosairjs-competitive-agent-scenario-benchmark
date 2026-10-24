/**
 * E01 — Deep Space Galaxy Cruise (cocosair arm)
 *
 * 实现要点(为什么这样做,而不是逐星点提交):
 *   - 66,000 颗星全部在启动时程序化生成,合并进两张静态 Mesh(星系盘 60k + 远景 6k),
 *     每张 Mesh 只有一个 submesh → 每帧 1 次 draw call(批量提交,符合 brief §6)。
 *   - 每颗星是 5 顶点的小扇形(corner×4 + center),中心顶点为星色、四角为近黑色,
 *     插值得到圆形辉光衰减;双绕序索引保证任何 cull 面下都可见(不依赖 pass 状态改写)。
 *   - 星系整体绕盘面法线(+Y)刚性慢旋 → 星点切向流动视觉正确,state.rotationPhase 单调递增;
 *     旋转只改 Node 变换,不重写顶点缓冲(CPU 每帧成本 ≈ 0)。
 *   - 相机:球面基座 + 指针视差横向/纵向偏移 + 距离逐帧指数插值(滚轮只改目标值)。
 *   - HUD 用 DOM 覆盖层(非画布像素),数字全部来自实时状态。
 *
 * 页面契约:window.__appReady / window.__bench = { getState, reset }
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    utils,
    Color,
    Vec3,
    Component,
    director,
    Director,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量与状态
// ---------------------------------------------------------------------------

const GALAXY_STARS = 72000; // 盘面 + 核球 + 旋臂
const BG_STARS = 6000; // 远景静态星层(同样计入 starCount)
const STAR_COUNT = GALAXY_STARS + BG_STARS;

const GALAXY_RADIUS = 44; // 世界单位;相机初始 120、fov 45 → 盘面约占画面宽度 60–70%
const ROT_SPEED = 0.05; // rad/s(合同要求 0.02–0.1)

const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const WHEEL_SENS = 0.08; // world units per wheel pixel

const ELEV = (42 * Math.PI) / 180; // 视线与盘面夹角:42°(合同 30°–60°)
const AZIM = (22 * Math.PI) / 180;
const CAZ = Math.cos(AZIM);
const SAZ = Math.sin(AZIM);
const CEL = Math.cos(ELEV);
const SEL = Math.sin(ELEV);
// 基座方向(相机相对星系中心)与相机右/上向量(手工展开,免每帧叉乘)
const DIR_X = SAZ * CEL;
const DIR_Y = SEL;
const DIR_Z = CAZ * CEL;
const RIGHT_X = CAZ;
const RIGHT_Z = -SAZ;
const UP_X = -SAZ * SEL;
const UP_Y = CEL;
const UP_Z = -CAZ * SEL;

const state = {
    starCount: STAR_COUNT,
    rotationPhase: 0,
    cameraDistance: DIST_INIT,
    parallaxOffset: { x: 0, y: 0 },
    fps: 0,
    hudVisible: true,
    epoch: 0,
};

let targetDistance = DIST_INIT;
let currentDistance = DIST_INIT;
let targetPX = 0;
let targetPY = 0;
let currentPX = 0;
let currentPY = 0;

let galaxyNode = null;
let bgNode = null;
let cameraNode = null;

// ---------------------------------------------------------------------------
// HUD(2D 覆盖层;DOM 文本,便于 domText 探针 & 与 __bench 状态一致)
// ---------------------------------------------------------------------------

const hud = document.createElement('div');
hud.id = 'galaxy-hud';
hud.style.cssText = [
    'position:fixed',
    'left:18px',
    'bottom:18px',
    'z-index:1000',
    'padding:10px 14px 12px',
    'min-width:196px',
    'font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'letter-spacing:.06em',
    'color:#d6e4ff',
    'background:rgba(6,10,20,.62)',
    'border:1px solid rgba(120,170,255,.34)',
    'border-radius:8px',
    'pointer-events:none',
    'text-shadow:0 0 8px rgba(90,150,255,.45)',
    'user-select:none',
].join(';');
hud.innerHTML =
    '<div style="font-size:9px;letter-spacing:.24em;opacity:.6;margin-bottom:2px">DEEP SPACE CRUISE</div>' +
    '<div>STARS <span id="hud-stars">0</span></div>' +
    '<div>FPS <span id="hud-fps">0</span></div>' +
    '<div>DIST <span id="hud-dist">0</span></div>' +
    '<div style="font-size:10px;opacity:.5;margin-top:1px">WHEEL cruise &middot; MOVE parallax</div>';
document.body.appendChild(hud);

const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText = [
    'display:block',
    'width:100%',
    'margin-top:8px',
    'padding:6px 10px',
    'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'letter-spacing:.12em',
    'color:#e6f0ff',
    'background:rgba(36,72,140,.8)',
    'border:1px solid rgba(130,180,255,.6)',
    'border-radius:6px',
    'cursor:pointer',
    'pointer-events:auto',
].join(';');
resetBtn.addEventListener('click', () => doReset());
hud.appendChild(resetBtn); // HUD 区域内可见控件(brief §3.5)

const hudStars = hud.querySelector('#hud-stars');
const hudFps = hud.querySelector('#hud-fps');
const hudDist = hud.querySelector('#hud-dist');

function refreshHud() {
    // position:fixed 元素的 offsetParent 恒为 null,不能用它判可见
    const rect = hud.getBoundingClientRect();
    state.hudVisible = hud.style.display !== 'none' && rect.width > 0 && rect.height > 0;
    hudStars.textContent = String(STAR_COUNT);
    hudFps.textContent = String(Math.max(0, Math.round(state.fps)));
    hudDist.textContent = String(Math.round(state.cameraDistance));
    return;
}
refreshHud();

// ---------------------------------------------------------------------------
// __bench 契约(先于引擎启动注册,保证任何时刻可调用)
// ---------------------------------------------------------------------------

window.__appReady = false;

function doReset() {
    state.epoch += 1;
    state.rotationPhase = 0;
    if (galaxyNode && galaxyNode.isValid) galaxyNode.setRotationFromEuler(0, 0, 0);
    if (bgNode && bgNode.isValid) bgNode.setRotationFromEuler(0, 0, 0);
    // 目标 + 当前同时回到初值起点:视差/相位立即归零,距离走逐帧插值并在 1s 内收敛
    targetDistance = DIST_INIT;
    targetPX = 0;
    targetPY = 0;
    currentPX = 0;
    currentPY = 0;
    state.parallaxOffset.x = 0;
    state.parallaxOffset.y = 0;
    placeCamera();
    refreshHud();
}

window.__bench = {
    getState() {
        return {
            starCount: STAR_COUNT,
            rotationPhase: state.rotationPhase,
            cameraDistance: state.cameraDistance,
            parallaxOffset: { x: state.parallaxOffset.x, y: state.parallaxOffset.y },
            fps: state.fps,
            hudVisible: state.hudVisible,
            epoch: state.epoch,
            engine: 'cocosair',
        };
    },
    reset: doReset,
};

// ---------------------------------------------------------------------------
// 交互(窗口级捕获:pal 层会吞 canvas 事件,合同 §已知坑)
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function onPointer(ev) {
    const nx = (ev.clientX / window.innerWidth) * 2 - 1;
    const ny = (ev.clientY / window.innerHeight) * 2 - 1;
    targetPX = clamp(nx, -1, 1);
    targetPY = clamp(ny, -1, 1);
}
window.addEventListener('pointermove', onPointer, { capture: true });
window.addEventListener('mousemove', onPointer, { capture: true });

window.addEventListener(
    'wheel',
    (ev) => {
        ev.preventDefault();
        const raw = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 100 : ev.deltaY;
        targetDistance = clamp(targetDistance + raw * WHEEL_SENS, DIST_MIN, DIST_MAX);
    },
    { capture: true, passive: false },
);

// ---------------------------------------------------------------------------
// 程序化星点数据
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rnd = mulberry32(0x9e3779b9);
const rndBg = mulberry32(0x51ed2701);

function gaussFrom(r) {
    // Box-Muller(每次 2 个均匀数 → 1 个标准正态)
    let u = 0;
    let v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 每颗星写 5 个顶点(中心 + 4 角)与 8 个三角形(双绕序,不依赖 cull 面)。 */
function buildStarMesh(count, fill) {
    const vertCount = count * 5;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 4);
    const indices = new Uint32Array(count * 24);

    const star = { x: 0, y: 0, z: 0, size: 1, r: 1, g: 1, b: 1 };
    let p = 0;
    let c = 0;
    let ii = 0;

    for (let i = 0; i < count; i++) {
        fill(i, star);
        const base = i * 5;
        const { x, y: sy, z, size, r, g, b } = star;

        // 中心顶点:满亮度
        positions[p++] = x;
        positions[p++] = sy;
        positions[p++] = z;
        colors[c++] = r;
        colors[c++] = g;
        colors[c++] = b;
        colors[c++] = 1;

        // 四角:近黑色(与中心插值 → 圆形辉光衰减)
        const cr = r * 0.02;
        const cg = g * 0.02;
        const cb = b * 0.02;
        for (let k = 0; k < 4; k++) {
            const sx = k === 0 || k === 3 ? -size : size;
            const sz = k === 0 || k === 1 ? -size : size;
            positions[p++] = x + sx;
            positions[p++] = sy;
            positions[p++] = z + sz;
            colors[c++] = cr;
            colors[c++] = cg;
            colors[c++] = cb;
            colors[c++] = 1;
        }

        const q1 = base + 1;
        const q2 = base + 2;
        const q3 = base + 3;
        const q4 = base + 4;
        // 正绕序(法线 +Y,从上往下看为逆时针)
        indices[ii++] = base; indices[ii++] = q2; indices[ii++] = q1;
        indices[ii++] = base; indices[ii++] = q3; indices[ii++] = q2;
        indices[ii++] = base; indices[ii++] = q4; indices[ii++] = q3;
        indices[ii++] = base; indices[ii++] = q1; indices[ii++] = q4;
        // 反绕序(双保险:无论 pass 的 cullMode 如何都能看到)
        indices[ii++] = base; indices[ii++] = q1; indices[ii++] = q2;
        indices[ii++] = base; indices[ii++] = q2; indices[ii++] = q3;
        indices[ii++] = base; indices[ii++] = q3; indices[ii++] = q4;
        indices[ii++] = base; indices[ii++] = q4; indices[ii++] = q1;
    }

    const geometry = { positions, colors, indices };
    return utils.MeshUtils.createMesh(geometry, null, { calculateBounds: true });
}

const BULGE_STARS = 9000;
const ARM_STARS = 34000;

function fillGalaxyStar(i, s) {
    let r;
    let brightness;
    let size;

    if (i < BULGE_STARS) {
        // 核球:半径 7.5 的椭球(垂直向 2.6 散布 → 中央隆起),亮度向边缘衰减
        const t = Math.pow(rnd(), 1.7);
        r = 7.5 * t;
        const ang = rnd() * Math.PI * 2;
        s.x = Math.cos(ang) * r;
        s.z = Math.sin(ang) * r;
        s.y = gaussFrom(rnd) * 2.6 * (1 - 0.45 * (r / 7.5));
        size = 0.1 + Math.pow(rnd(), 2) * 0.26;
        brightness = 0.88 + rnd() * 0.06 + 0.06 * (1 - r / 7.5);
    } else if (i < BULGE_STARS + ARM_STARS) {
        // 两条主对数螺旋臂:θ = arm·π + k·ln(r/r0),垂直于臂的高斯散布形成盘面厚度感
        const arm = i % 2;
        const tArm = Math.pow(rnd(), 0.66);
        r = 3.2 + tArm * (GALAXY_RADIUS - 5.5);
        const theta = arm * Math.PI + 2.15 * Math.log(r / 3.2) + gaussFrom(rnd) * 0.16;
        const jitter = gaussFrom(rnd) * (0.7 + r * 0.034);
        s.x = Math.cos(theta) * (r + jitter);
        s.z = Math.sin(theta) * (r + jitter);
        s.y = gaussFrom(rnd) * (0.45 + 0.018 * r);
        size = 0.085 + Math.pow(rnd(), 2.2) * 0.21;
        brightness = 0.9 + rnd() * 0.1;
    } else {
        // 盘面随机散布星(填补旋臂之间,近指数盘)
        r = 4 + GALAXY_RADIUS * Math.pow(rnd(), 0.62);
        const theta = rnd() * Math.PI * 2;
        const jitter = gaussFrom(rnd) * (1.0 + r * 0.05);
        s.x = Math.cos(theta) * (r + jitter);
        s.z = Math.sin(theta) * (r + jitter);
        s.y = gaussFrom(rnd) * (0.4 + 0.02 * r);
        size = 0.075 + Math.pow(rnd(), 2.4) * 0.17;
        brightness = 0.62 + rnd() * 0.33;
    }

    // 颜色沿半径梯度:核心暖黄白 → 旋臂中段蓝白 → 外缘冷蓝
    const rt = clamp(Math.hypot(s.x, s.z) / GALAXY_RADIUS, 0, 1);
    let cr;
    let cg;
    let cb;
    if (rt < 0.22) {
        const k = rt / 0.22;
        cr = 1.0 + (0.96 - 1.0) * k;
        cg = 0.87 + (0.94 - 0.87) * k;
        cb = 0.6 + (1.0 - 0.6) * k;
    } else if (rt < 0.6) {
        const k = (rt - 0.22) / 0.38;
        cr = 0.96 + (0.72 - 0.96) * k;
        cg = 0.94 + (0.84 - 0.94) * k;
        cb = 1.0;
    } else {
        const k = (rt - 0.6) / 0.4;
        cr = 0.72 + (0.46 - 0.72) * k;
        cg = 0.84 + (0.6 - 0.84) * k;
        cb = 1.0;
    }

    // 核心 2.2 半径内:白热星核(比核球外缘更亮更白,形成中央亮度峰值)
    if (i < BULGE_STARS && r < 2.2) {
        cr = 1.0;
        cg = 0.94;
        cb = 0.8;
        size *= 1.3;
        brightness = 1.0;
    }

    // 少量大亮"主星"(0.4%),提供第三档亮暗层级
    if (rnd() < 0.004) {
        size *= 2.2;
        brightness = 1.0;
    }

    // 少量橙红亮星散布(4%),稍大且全亮
    if (rnd() < 0.04) {
        cr = 1.0;
        cg = 0.42;
        cb = 0.16;
        size *= 1.8;
        brightness = 1.0;
    }

    s.size = size;
    s.r = Math.min(1, cr * brightness);
    s.g = Math.min(1, cg * brightness);
    s.b = Math.min(1, cb * brightness);
}

function fillBackgroundStar(_i, s) {
    // 远景球壳 600–1500,颜色偏冷、暗弱(第三档亮暗层级)
    const u = rndBg() * 2 - 1;
    const phi = rndBg() * Math.PI * 2;
    const rr = 600 + rndBg() * 900;
    const sq = Math.sqrt(1 - u * u);
    s.x = sq * Math.cos(phi) * rr;
    s.y = u * rr;
    s.z = sq * Math.sin(phi) * rr;
    s.size = (0.9 + Math.pow(rndBg(), 3) * 2.4) * (rr / 700);

    const k = rndBg();
    let cr = 0.82;
    let cg = 0.88;
    let cb = 1.0;
    if (k < 0.25) {
        cr = 1.0;
        cg = 0.82;
        cb = 0.62;
    } else if (k > 0.78) {
        cr = 0.55;
        cg = 0.68;
        cb = 1.0;
    }
    const brightness = 0.3 + rndBg() * 0.55;
    s.r = Math.min(1, cr * brightness);
    s.g = Math.min(1, cg * brightness);
    s.b = Math.min(1, cb * brightness);
}

// ---------------------------------------------------------------------------
// 相机运动组件(每帧:旋转 + 距离/视差指数插值)
// ---------------------------------------------------------------------------

const camTarget = new Vec3(0, 0, 0);
const camPos = new Vec3();

function placeCamera() {
    const d = currentDistance;
    const offX = currentPX * d * 0.055; // 横向 ≤5.5% 距离 → 屏幕位移远小于画布 10%
    const offY = currentPY * d * 0.05;
    camPos.set(
        DIR_X * d + RIGHT_X * offX + UP_X * offY,
        DIR_Y * d + UP_Y * offY,
        DIR_Z * d + RIGHT_Z * offX + UP_Z * offY,
    );
    if (cameraNode && cameraNode.isValid) {
        cameraNode.setPosition(camPos);
        cameraNode.lookAt(camTarget);
    }
}

class CruiseMotion extends Component {
    update(dt) {
        const step = Math.max(0, Math.min(dt, 0.1));

        // 星系刚性慢旋(切向流动)
        state.rotationPhase += step * ROT_SPEED;
        if (galaxyNode && galaxyNode.isValid) {
            galaxyNode.setRotationFromEuler(0, state.rotationPhase, 0);
        }
        if (bgNode && bgNode.isValid) {
            bgNode.setRotationFromEuler(0, -state.rotationPhase * 0.06, 0);
        }

        // 距离/视差逐帧插值(滚轮只改目标 → 无瞬跳)
        currentDistance += (targetDistance - currentDistance) * (1 - Math.exp(-step / 0.12));
        currentPX += (targetPX - currentPX) * (1 - Math.exp(-step / 0.1));
        currentPY += (targetPY - currentPY) * (1 - Math.exp(-step / 0.1));

        state.cameraDistance = currentDistance;
        state.parallaxOffset.x = currentPX;
        state.parallaxOffset.y = currentPY;

        placeCamera();
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let lastHudAt = 0;
const frameTimes = [];

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('galaxy');

    cameraNode = new Node('Cruise Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(DIR_X * DIST_INIT, DIR_Y * DIST_INIT, DIR_Z * DIST_INIT));
    cameraNode.lookAt(camTarget);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.5;
    camera.far = 5000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(5, 7, 14, 255); // 近纯黑深空(远暗于 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 一颗共享的无光照顶点色材质(2 张 Mesh 共用 → 每张 1 draw call)
    const starMaterial = new Material();
    starMaterial.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_VERTEX_COLOR: true },
    });

    galaxyNode = new Node('Galaxy Disc');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const galaxyRenderer = galaxyNode.addComponent(MeshRenderer);
    galaxyRenderer.mesh = buildStarMesh(GALAXY_STARS, fillGalaxyStar);
    galaxyRenderer.material = starMaterial;

    bgNode = new Node('Far Starfield');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgRenderer = bgNode.addComponent(MeshRenderer);
    bgRenderer.mesh = buildStarMesh(BG_STARS, fillBackgroundStar);
    bgRenderer.material = starMaterial;

    cameraNode.addComponent(CruiseMotion);

    window.__airApp = app;
    app.run(scene);

    // 帧率:最近 2s 滚动平均(AFTER_DRAW 时间戳)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        while (frameTimes.length > 2 && now - frameTimes[0] > 2000) frameTimes.shift();
        if (frameTimes.length >= 2) {
            const span = now - frameTimes[0];
            if (span > 0) state.fps = ((frameTimes.length - 1) * 1000) / span;
        }
        if (!window.__appReady) window.__appReady = true;
        if (now - lastHudAt > 100) {
            lastHudAt = now;
            refreshHud();
        }
    });

    console.log('[galaxy] running · stars=' + STAR_COUNT);
} catch (err) {
    console.error('[galaxy] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
