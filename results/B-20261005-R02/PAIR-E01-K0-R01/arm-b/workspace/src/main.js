/**
 * E01 — 深空星系巡航(Deep Space Galaxy Cruise) — cocosair 实现
 *
 * 设计(全部程序化生成,无外部资产):
 *   - 52,000 颗星 = 星系盘 48,000(2 条对数螺旋旋臂 28k + 核球 8k + 盘面散星 12k)
 *     + 远景背景星壳 4,000(静态、不随盘旋转 → 与星系间存在真实视差)。
 *   - 每颗星为一个贴地(XZ 面)小方片,4 顶点 2 三角形,颜色/尺寸按半径与层级程序化分布;
 *     全部星点合并进 2 个静态 Mesh(2 次批量 draw call 提交),星点数即真实提交渲染数。
 *   - 材质:builtin-unlit + USE_VERTEX_COLOR,关闭背面剔除;颜色经顶点色直出。
 *   - 星系绕盘面法线(+Y)慢旋(0.05 rad/s),rotationPhase 单调递增。
 *   - 指针视差:相机横向小偏移(≤ 视宽 ~3%),指数平滑无过冲。
 *   - 滚轮穿行:目标距离 [40,400] 初始 120,逐帧指数插值(τ≈0.65s,平滑无瞬跳);
 *     reset 后用快速 τ(0.2s)在 1s 内恢复,parallax/相位直接复位。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): {starCount,rotationPhase,cameraDistance,parallaxOffset,fps,hudVisible,epoch}, reset() }。
 *   - HUD 为 DOM 覆盖层,数值每 ~150ms 从真实状态刷新(四舍五入显示)。
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
    Vec3,
    Color,
    Component,
    director,
    Director,
    input,
    Input,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------- 状态(单一样本源)

const ANGULAR_SPEED = 0.05;      // rad/s,规格区间 [0.02, 0.1]
const PARALLAX_UNITS = 5;        // 视差满偏移对应的相机位移(world 单位;≈视宽 3%,<10%)
const ELEVATION = 42 * Math.PI / 180; // 仰角 → 盘面法线与视线夹角 48°(规格 30°–60°)
const DIST_INIT = 120, DIST_MIN = 40, DIST_MAX = 400;
const TAU_DIST = 0.65, TAU_DIST_RESET = 0.2, TAU_PAR = 0.55;

const S = {
    starCount: 0,
    phase: 0,                    // rotationPhase(rad),reset 归零
    curDist: DIST_INIT,
    tgtDist: DIST_INIT,
    tauDist: TAU_DIST,
    par: { x: 0, y: 0 },         // 平滑后的实际视差(状态报告口径)
    parTgt: { x: 0, y: 0 },      // 指针目标视差(有符号归一化 [-1,1])
    fps: 0,
    hudVisible: true,
    epoch: 0,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

window.__appReady = false;
function doReset() {
    S.epoch += 1;
    S.phase = 0;                                  // 旋转相位复位(下一帧起继续单调递增)
    if (galaxyNode && galaxyNode.isValid) galaxyNode.setRotationFromEuler(0, 0, 0);
    S.parTgt.x = 0; S.parTgt.y = 0;               // 视差目标归零(指针参考位回到画面中心)
    S.par.x = 0; S.par.y = 0;                     // 视差直接复位(幅度 <10% 画布,瞬时复位不可感)
    S.tgtDist = DIST_INIT;
    S.tauDist = TAU_DIST_RESET;                   // 距离快速平滑恢复(≤1s,逐帧插值,不瞬跳)
}
window.__bench = {
    getState: () => ({
        starCount: S.starCount,
        rotationPhase: S.phase,
        cameraDistance: S.curDist,
        parallaxOffset: { x: S.par.x, y: S.par.y },
        fps: S.fps,
        hudVisible: S.hudVisible,
        epoch: S.epoch,
    }),
    reset: doReset,
};

// ---------------------------------------------------------------- 输入(视差 + 滚轮穿行)

function onPointerMove(cx, cy) {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    S.parTgt.x = clamp((cx / w) * 2 - 1, -1, 1);
    S.parTgt.y = clamp((cy / h) * 2 - 1, -1, 1);
}
// canvas 鼠标事件可能被 pal 层吞:窗口捕获阶段监听(先于任何目标层拦截)+ 引擎 input 双保险
window.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY), { capture: true, passive: true });
window.addEventListener('pointermove', (e) => onPointerMove(e.clientX, e.clientY), { capture: true, passive: true });
window.addEventListener('wheel', (e) => {
    const d = Number(e.deltaY);
    if (!isFinite(d) || d === 0) return;
    // deltaY<0(向上)= 靠近:距离减小;灵敏度 0.1 → deltaY=-600 ⇒ -60 单位
    S.tgtDist = clamp(S.tgtDist + d * 0.1, DIST_MIN, DIST_MAX);
}, { capture: true, passive: true });
try {
    input.on(Input.EventType.MOUSE_MOVE, (e) => {
        const p = e.getLocation();
        onPointerMove(p.x, p.y);
    });
} catch (e) {
    console.warn('[e01] engine input unavailable, using DOM capture listeners only');
}

// ---------------------------------------------------------------- 星系几何(程序化生成)

// 可复现 PRNG(mulberry32)—— 程序化且每次运行一致
function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildGalaxy(rng, counts) {
    // 旋臂对数螺旋参数:r = A·e^(B·θ)
    const R = 62, A = 5, B = 0.24;
    const THETA_MAX = Math.log(R / A) / B; // ≈10.45 rad ≈ 1.66 圈/臂
    const positions = [], colors = [], indices = [];
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;

    let spare = null;
    const gauss = () => { // Box-Muller
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u = 0, v = 0, s = 0;
        do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
        const mul = Math.sqrt((-2 * Math.log(s)) / s);
        spare = v * mul; return u * mul;
    };

    function addStar(x, y, z, r, g, b, size) {
        const base = positions.length / 3;
        const hs = size / 2;
        // XZ 面小方片(盘面贴片;俯视 42° 仰角下始终可见)
        positions.push(x - hs, y, z - hs, x + hs, y, z - hs, x + hs, y, z + hs, x - hs, y, z + hs);
        for (let k = 0; k < 4; k++) colors.push(r, g, b, 1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        if (x - hs < minX) minX = x - hs; if (x + hs > maxX) maxX = x + hs;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z - hs < minZ) minZ = z - hs; if (z + hs > maxZ) maxZ = z + hs;
    }

    // 半径 → 颜色梯度:核心暖黄白 → 中段蓝白 → 外缘冷蓝
    function rampColor(fr) {
        const t = clamp(fr, 0, 1);
        let r, g, b;
        if (t < 0.35) {
            const k = t / 0.35;
            r = 1.0 + (0.88 - 1.0) * k; g = 0.93 + (0.91 - 0.93) * k; b = 0.76 + (1.0 - 0.76) * k;
        } else {
            const k = (t - 0.35) / 0.65;
            r = 0.88 + (0.60 - 0.88) * k; g = 0.91 + (0.76 - 0.91) * k; b = 1.0;
        }
        return [r, g, b];
    }

    // 1) 旋臂(2 × 15000)
    for (let arm = 0; arm < 2; arm++) {
        const baseAng = arm * Math.PI;
        for (let i = 0; i < counts.arm; i++) {
            const t = Math.pow(rng(), 0.8);
            const th = t * THETA_MAX;
            const r0 = A * Math.exp(B * th);
            const rr = Math.max(1.5, r0 + gauss() * (0.7 + r0 * 0.042));
            const ang = baseAng + th + gauss() * 0.038;
            const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
            const y = gauss() * (0.7 + r0 * 0.028);      // 盘厚随半径缓增
            const fr = clamp(rr / R, 0, 1);
            if (rng() < 0.008) {                          // 少量橙红亮星(散布)
                addStar(x, y, z, 1.0, 0.44, 0.28, 0.7 + rng() * 0.5);
            } else {
                const [r, g, b] = rampColor(fr);
                const br = (0.6 + rng() * 0.4) * (1.08 - 0.3 * fr); // 外缘渐暗增强梯度
                addStar(x, y, z, r * br, g * br, b * br, 0.42 + rng() * 0.5);
            }
        }
    }
    // 2) 核球(8000,中央隆起:扁高斯)
    for (let i = 0; i < counts.bulge; i++) {
        const x = gauss() * 4.2, y = gauss() * 2.4, z = gauss() * 4.2;
        const core = i < 300;                              // 核心最亮一档
        const br = core ? 1.15 + rng() * 0.2 : 0.85 + rng() * 0.35;
        const w = 0.94 + rng() * 0.06;
        addStar(x, y, z, 1.0 * br, w * br, 0.78 * br, core ? 1.6 + rng() * 1.0 : 0.7 + rng() * 1.0);
    }
    // 3) 盘面散星(10000,更暗一档)
    for (let i = 0; i < counts.field; i++) {
        const rr = Math.sqrt(rng()) * R;
        const ang = rng() * Math.PI * 2;
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        const y = gauss() * 1.5;
        const [r, g, b] = rampColor(rr / R);
        const br = 0.3 + rng() * 0.34;                     // 暗弱背景星档
        addStar(x, y, z, r * br, g * br, b * br, 0.32 + rng() * 0.45);
    }
    return { positions, colors, indices, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function buildBackgroundShell(rng, n) {
    // 远景静态星壳:r∈[650,1100],不随星系旋转 → 与星系间存在真实视差
    const positions = [], colors = [], indices = [];
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (let i = 0; i < n; i++) {
        const u = rng() * 2 - 1, ph = rng() * Math.PI * 2;
        const sq = Math.sqrt(1 - u * u);
        const rr = 650 + rng() * 450;
        const x = sq * Math.cos(ph) * rr, y = u * rr, z = sq * Math.sin(ph) * rr;
        const s = 2.5 + rng() * 2.5;
        const base = positions.length / 3;
        const hs = s / 2;
        // 尺寸相对世界方向取水平/竖直片(距离远,朝向影响可忽略)
        positions.push(x - hs, y - hs, z, x + hs, y - hs, z, x + hs, y + hs, z, x - hs, y + hs, z);
        const mix = rng();
        const r = 0.75 + mix * 0.2, g = 0.8 + rng() * 0.15, b = 0.85 + rng() * 0.15;
        const br = 0.45 + rng() * 0.4;
        for (let k = 0; k < 4; k++) colors.push(r * br, g * br, b * br, 1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        if (x - hs < minX) minX = x - hs; if (x + hs > maxX) maxX = x + hs;
        if (y - hs < minY) minY = y - hs; if (y + hs > maxY) maxY = y + hs;
        if (z < minZ) minZ = z - hs; if (z > maxZ) maxZ = z + hs;
    }
    return { positions, colors, indices, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// ---------------------------------------------------------------- HUD(2D DOM 覆盖层)

const hud = document.createElement('div');
hud.id = 'bench-hud';
hud.style.cssText =
    'position:fixed;left:12px;top:10px;z-index:9998;pointer-events:none;user-select:none;' +
    "font:13px/1.55 Consolas,'Courier New',monospace;color:#e8eeff;" +
    'text-shadow:0 0 4px #000,0 0 2px #000;white-space:pre;';
hud.innerHTML =
    '<div>Stars: <span id="hud-stars">0</span></div>' +
    '<div>FPS: <span id="hud-fps">0</span></div>' +
    '<div>Distance: <span id="hud-dist">120</span></div>';
document.body.appendChild(hud);
const hudStars = hud.querySelector('#hud-stars');
const hudFps = hud.querySelector('#hud-fps');
const hudDist = hud.querySelector('#hud-dist');
// 逐帧按需刷新:仅在四舍五入后的显示值变化时写 DOM(滞后 ≤1 帧,滑行期间也与状态一致)
const hudShow = { stars: -1, fps: -1, dist: -1 };
function hudFlush() {
    const stars = S.starCount;
    const fps = Math.round(S.fps);
    const dist = Math.round(S.curDist);
    if (stars !== hudShow.stars) { hudShow.stars = stars; hudStars.textContent = String(stars); }
    if (fps !== hudShow.fps) { hudShow.fps = fps; hudFps.textContent = String(fps); }
    if (dist !== hudShow.dist) { hudShow.dist = dist; hudDist.textContent = String(dist); }
}

// Reset 控件(可见文本 + aria-label 双定位)
const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:9999;padding:5px 14px;' +
    "font:13px sans-serif;background:rgba(20,24,36,0.85);color:#e8eeff;" +
    'border:1px solid #5a6a8a;border-radius:4px;cursor:pointer;';
resetBtn.addEventListener('click', () => doReset());
document.body.appendChild(resetBtn);

// ---------------------------------------------------------------- 逐帧行为组件

class GalaxySpin extends Component {
    update(dt) {
        const d = clamp(dt, 0, 0.2);
        S.phase += d * ANGULAR_SPEED;                  // 单调递增
        this.node.setRotationFromEuler(0, (S.phase * 180) / Math.PI, 0);
    }
}

const tmpPos = new Vec3();
const ORIGIN = new Vec3(0, 0, 0);
class CameraRig extends Component {
    update(dt) {
        const d = clamp(dt, 0, 0.2);
        // 距离逐帧指数插值(平滑无瞬跳);reset 后短暂使用快速 τ,收敛后恢复常规 τ
        S.curDist += (S.tgtDist - S.curDist) * (1 - Math.exp(-d / S.tauDist));
        if (S.tauDist < TAU_DIST && Math.abs(S.curDist - DIST_INIT) < 0.5) S.tauDist = TAU_DIST;
        // 视差指数平滑(无过冲振荡)
        const kp = 1 - Math.exp(-d / TAU_PAR);
        S.par.x += (S.parTgt.x - S.par.x) * kp;
        S.par.y += (S.parTgt.y - S.par.y) * kp;
        const offX = S.par.x * PARALLAX_UNITS;
        const offY = S.par.y * PARALLAX_UNITS * 0.6;
        const by = Math.sin(ELEVATION) * S.curDist;
        const bz = Math.cos(ELEVATION) * S.curDist;
        tmpPos.set(offX, by + offY, bz);
        this.node.setPosition(tmpPos);
        this.node.lookAt(ORIGIN);
    }
}

// ---------------------------------------------------------------- 场景装配

let galaxyNode = null;

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E01-GalaxyCruise');

    // Camera:深空近黑清屏色,初始斜俯视 48°,距离 120
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.5;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(3, 4, 9, 255);      // 接近纯黑深空色(RGB 3,4,9 < 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;          // 4.0-alpha 必须显式设置
    camera.priority = 0;
    cameraNode.addComponent(CameraRig);

    // 星点材质:unlit + 顶点色,双面(方片俯视;滚轮俯冲不翻面)
    const starMat = new Material();
    starMat.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: false, USE_VERTEX_COLOR: true },
        states: { rasterizerState: { cullMode: gfx.CullMode.NONE } },
    });

    // 星系盘:48,000 星(旋臂 28k + 核球 8k + 盘面散星 12k)合并为 1 个静态 Mesh
    const rng = makeRng(20261005);
    const galaxyGeo = buildGalaxy(rng, { arm: 15000, bulge: 8000, field: 10000 });
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const galaxyMr = galaxyNode.addComponent(MeshRenderer);
    galaxyMr.mesh = utils.MeshUtils.createMesh({
        positions: galaxyGeo.positions,
        colors: galaxyGeo.colors,
        indices: galaxyGeo.indices,
        primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
        minPos: { x: galaxyGeo.min[0], y: galaxyGeo.min[1], z: galaxyGeo.min[2] },
        maxPos: { x: galaxyGeo.max[0], y: galaxyGeo.max[1], z: galaxyGeo.max[2] },
    });
    galaxyMr.material = starMat;
    galaxyNode.addComponent(GalaxySpin);

    // 远景背景星壳:4,000 星,静态(不随盘旋转),与星系形成真实视差纵深
    const bgGeo = buildBackgroundShell(rng, 4000);
    const bgNode = new Node('BackgroundStars');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgMr = bgNode.addComponent(MeshRenderer);
    bgMr.mesh = utils.MeshUtils.createMesh({
        positions: bgGeo.positions,
        colors: bgGeo.colors,
        indices: bgGeo.indices,
        primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
        minPos: { x: bgGeo.min[0], y: bgGeo.min[1], z: bgGeo.min[2] },
        maxPos: { x: bgGeo.max[0], y: bgGeo.max[1], z: bgGeo.max[2] },
    });
    bgMr.material = starMat;

    S.starCount = 48000 + 4000; // 与实际提交渲染的星点数一致(两 Mesh 顶点块的星数)

    window.__airApp = app;
    app.run(scene);

    // 帧计数 + FPS(2s 滚动平均)+ 首帧就绪
    const frameStamps = [];
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameStamps.push(now);
        while (frameStamps.length > 0 && now - frameStamps[0] > 2000) frameStamps.shift();
        S.fps = frameStamps.length >= 2
            ? ((frameStamps.length - 1) * 1000) / (now - frameStamps[0])
            : 0;
        hudFlush();                                    // HUD 数值与状态同帧一致
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[e01] galaxy cruise running on cocosair; stars =', S.starCount);
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[e01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
