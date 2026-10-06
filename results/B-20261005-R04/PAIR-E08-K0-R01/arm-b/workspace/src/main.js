/**
 * E08 深海鱼群 (Deep Sea Fish School) — cocosair.js Arm
 *
 * 场景构成(全部程序化生成,无共享资产):
 *   1. 背景:全屏渐变水体板(顶亮青 → 底深蓝黑,顶点色)+ 顶部光束板 → "光线自上而下衰减";
 *      再叠加 EXP 雾做纵深衰减。
 *   2. 鱼群:90 条程序化鱼(6 环 × 8 边截面 + 尾鳍三角,有体积),全部合入**单个动态网格**
 *      (utils.MeshUtils.createDynamicMesh + mesh.updateSubMesh 逐帧重建顶点),摆尾为沿脊线的
 *      行波横向位移,随速度增幅 —— 禁止预烘焙轨迹。
 *   3. boids 三规则逐帧计算(聚集/对齐/分离,O(n²) 朴素邻域),边界软约束。
 *   4. 惊散:引擎 input.on(MOUSE_MOVE/DOWN/UP)(canvas DOM 事件会被 pal 层吞,必须走引擎输入),
 *      指针经 camera.screenPointToRay 投到 z=0 水域平面,与鱼实际距离 < 2.5 世界单位触发 panic
 *      (逐鱼加速逃逸);boidMode 恢复 normal 需要"指针离开惊散范围且静止超过 2s"(spec §4.2)。
 *   5. 投喂:单击(按下/抬起位移 < 8px 且 < 450ms,避免把 P3 的 drag 误判为点击)在水域生成
 *      3 粒发光食物(球体,亮色 unlit),鱼群受吸引聚集;逐粒被吃(每粒需多次啃食)或 8s 超时后
 *      foodActive=false。
 *   6. 悬浮颗粒:420 个微夸克(单个动态网格),慢漂移 + 上下浮动,近大远小。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench.getState() 严格按 spec.json stateContract 字段名返回;reset() 清食物、
 *     boidMode 回 normal、鱼群回初始分布(同种子重放),不刷新页面。
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
    Vec2,
    Vec3,
    Color,
    Component,
    director,
    Director,
    Material,
    input,
    Input,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const FISH_COUNT = 90; // spec: >= 80(建议 80-120)
const PLANKTON_COUNT = 420; // spec: >= 300(建议 300-600)

const HX = 11.0; // 水域半宽(x)
const HY = 6.5; // 水域半高(y)
const HZ = 3.5; // 水域半深(z),相机在 z=18 处全覆盖

const SCATTER_R = 2.5; // 惊散半径(spec §4.1 建议 2.5 世界单位)
const STATIONARY_CALM_S = 2.0; // 指针静止超过 2s 后惊散解除(spec §4.2)
const PANIC_DECAY_PER_S = 1 / 4.0; // panic 每秒衰减(惊散扑散窗口内保持逃逸,重聚仍达标)
const FOOD_TIMEOUT_S = 8.0; // spec §4.3: >=8s 超时
const FOOD_GRAINS = 3; // spec §4.3: 1-5 粒
const CLICK_MOVE_EPS2 = 8 * 8; // 判定"点击"的最大位移平方(px)
const CLICK_MAX_MS = 450;

/** 确定性随机(重放初始分布用) */
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
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// 可观测状态(spec stateContract)+ 页面契约
// ---------------------------------------------------------------------------

const sim = {
    frame: 0,
    resetCount: 0,
    time: 0,
    fps: 60,
    mode: 'normal', // "normal" | "scatter"
    scatterEngaged: false,
    foodActive: false,
    foodX: 0,
    foodY: 0,
    foodZ: 0,
    avgCohesion: 0,
    avgDistanceToFood: null,
    panicking: 0, // 诊断:panic>0.2 的个体数
};

window.__appReady = false;

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: sim.frame,
        fps: Math.round(sim.fps * 10) / 10,
        fishCount: FISH_COUNT,
        planktonCount: PLANKTON_COUNT,
        boidMode: sim.mode,
        foodActive: sim.foodActive,
        foodPosition: sim.foodActive ? { x: sim.foodX, y: sim.foodY, z: sim.foodZ } : null,
        avgCohesion: sim.avgCohesion,
        avgDistanceToFood: sim.avgDistanceToFood,
        panicking: sim.panicking,
        resetCount: sim.resetCount,
    }),
    reset: () => doReset(),
};

// --- UI 控件(探针经 data-ui 属性定位;brief 亦提到 data-bench,双属性兼容) ---
const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.setAttribute('data-bench', 'reset');
resetBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
    "font:12px sans-serif;background:#12333f;color:#cfe;background-image:none;border:1px solid #3a7a8a;" +
    'border-radius:4px;cursor:pointer;opacity:0.85';
resetBtn.addEventListener('click', () => doReset());
document.body.appendChild(resetBtn);

const hud = document.createElement('div');
hud.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:9999;font:11px monospace;color:#9fd;' +
    'background:rgba(0,10,16,0.45);padding:3px 8px;border-radius:4px;pointer-events:none;white-space:pre';
document.body.appendChild(hud);

function doReset() {
    sim.resetCount += 1;
    sim.time = 0;
    sim.mode = 'normal';
    sim.scatterEngaged = false;
    sim.foodActive = false;
    sim.avgDistanceToFood = null;
    sim.panicking = 0;
    pointer.has = false;
    pointer.lastMoveT = -1e9;
    pointer.pressed = false;
    dragSegs.length = 0;
    spawnFish();
    spawnPlankton();
    updateFoodNodes();
    // reset 后指针状态清零:探针把鼠标移到 reset 按钮途中可能触发过惊散,必须一并清除
}

// ---------------------------------------------------------------------------
// 指针输入(引擎 input 单例;canvas DOM 事件被 pal 吞,禁止直接监听 canvas)
// ---------------------------------------------------------------------------

const pointer = {
    has: false, // 指针是否已知位于画布内
    wx: 0,
    wy: 0, // 投影到 z=0 平面的世界坐标
    lastMoveT: -1e9,
    pressed: false, // 左键按住(drag)中
    lastPressX: 0, // 上一按压移动采样点(世界系)
    lastPressY: 0,
    downUX: 0, // 按下时 UI 坐标(点击判定用)
    downUY: 0,
    downT: 0,
};

// 按压拖拽的扫掠线段(世界系):浏览器把 mousemove 合并到 rAF 节拍,一次 drag 的 25 步
// 可能只送达 2-3 个采样点;按住左键滑动的鼠标物理上必然连续经过两点之间,
// 用线段还原被扫掠的水域(仍完全由真实指针位置派生,非定时器/脚本触发)。
const dragSegs = []; // {x0,y0,x1,y1,t}
const DRAG_SEG_TTL = 0.6;

const _v2 = new Vec2();
let cameraComp = null;

// screenPointToRay(out, x, y) 只向 out.o / out.d 写入(见引擎实现 Ray.fromPoints),普通对象即可
const _rayObj = { o: new Vec3(), d: new Vec3() };

/** 把 UI 坐标(左下原点)投到水域主平面 z=0,返回世界点 */
function pointerToWorld(uiX, uiY) {
    if (!cameraComp) return null;
    cameraComp.screenPointToRay(uiX, uiY, _rayObj);
    const oz = _rayObj.o.z;
    const dz = _rayObj.d.z;
    if (Math.abs(dz) < 1e-5) return null;
    const t = -oz / dz;
    if (t <= 0) return null;
    return { x: _rayObj.o.x + _rayObj.d.x * t, y: _rayObj.o.y + _rayObj.d.y * t };
}

/** 点到线段的三维距离平方(线段 z=0) */
function segDist2(fx, fy, fz, x0, y0, x1, y1) {
    const dxs = x1 - x0,
        dys = y1 - y0;
    const l2 = dxs * dxs + dys * dys;
    let t = l2 > 1e-9 ? ((fx - x0) * dxs + (fy - y0) * dys) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + t * dxs - fx,
        cy = y0 + t * dys - fy;
    return cx * cx + cy * cy + fz * fz;
}

function onMouseMove(e) {
    e.getLocation(_v2);
    const w = pointerToWorld(_v2.x, _v2.y);
    if (w) {
        if (pointer.pressed) {
            dragSegs.push({ x0: pointer.lastPressX, y0: pointer.lastPressY, x1: w.x, y1: w.y, t: sim.time });
            if (dragSegs.length > 64) dragSegs.shift();
            pointer.lastPressX = w.x;
            pointer.lastPressY = w.y;
        }
        pointer.has = true;
        pointer.wx = w.x;
        pointer.wy = w.y;
    }
    pointer.lastMoveT = sim.time;
}

function isOverResetButton(uiX, uiY) {
    // reset 按钮固定在右上角;命中区域忽略(UI 坐标 y 向上,按钮在 y > 660 一带)
    return uiX > 1150 && uiY > 660;
}

function onMouseDown(e) {
    e.getLocation(_v2);
    pointer.downUX = _v2.x;
    pointer.downUY = _v2.y;
    pointer.downT = performance.now();
    pointer.pressed = true;
    pointer.lastPressX = pointer.wx;
    pointer.lastPressY = pointer.wy;
    onMouseMove(e); // down 也更新指针位置(惊散判定与位置同步)
}

function onMouseUp(e) {
    const dt = performance.now() - pointer.downT;
    e.getLocation(_v2);
    const dx = _v2.x - pointer.downUX;
    const dy = _v2.y - pointer.downUY;
    pointer.downT = 0;
    pointer.pressed = false;
    if (dt < CLICK_MAX_MS && dx * dx + dy * dy < CLICK_MOVE_EPS2 && !isOverResetButton(_v2.x, _v2.y)) {
        dropFoodAt(_v2.x, _v2.y);
    }
}

input.on(Input.EventType.MOUSE_MOVE, onMouseMove);
input.on(Input.EventType.MOUSE_DOWN, onMouseDown);
input.on(Input.EventType.MOUSE_UP, onMouseUp);

// ---------------------------------------------------------------------------
// 鱼群数据与程序化形体
// ---------------------------------------------------------------------------

// 鱼体:脊线沿局部 +X(头在 +X),6 个椭圆截面环 × 8 边 + 竖直尾鳍三角
const RINGS = 6;
const RING_N = 8;
const RING_X = [0.45, 0.27, 0.09, -0.09, -0.27, -0.45];
const RING_H = [0.03, 0.17, 0.21, 0.18, 0.11, 0.045]; // 截面半高
const RING_W = [0.025, 0.1, 0.12, 0.1, 0.055, 0.022]; // 截面半宽(横向)
const TAIL_BASE_X = -0.45;
const TAIL_TIP_X = -0.76;
const TAIL_HALF = 0.17;
const VERTS_PER_FISH = RINGS * RING_N + 3; // 51
const IDX_PER_FISH = (RINGS - 1) * RING_N * 6 + 3; // 243

const fish = {
    px: new Float64Array(FISH_COUNT),
    py: new Float64Array(FISH_COUNT),
    pz: new Float64Array(FISH_COUNT),
    vx: new Float64Array(FISH_COUNT),
    vy: new Float64Array(FISH_COUNT),
    vz: new Float64Array(FISH_COUNT),
    hx: new Float64Array(FISH_COUNT), // 平滑朝向(单位向量)
    hy: new Float64Array(FISH_COUNT),
    hz: new Float64Array(FISH_COUNT),
    phase: new Float64Array(FISH_COUNT), // 摆尾相位
    panic: new Float64Array(FISH_COUNT),
    scale: new Float64Array(FISH_COUNT),
    hue: new Float64Array(FISH_COUNT), // 体色变化因子
};

function spawnFish() {
    const rand = mulberry32(20261008);
    // 初始分布:中心密集球(半径 2.2),带最小间距拒绝采样
    for (let i = 0; i < FISH_COUNT; i++) {
        let x = 0,
            y = 0,
            z = 0,
            ok = false,
            tries = 0;
        while (!ok && tries < 200) {
            const th = rand() * Math.PI * 2;
            const ph = Math.acos(2 * rand() - 1);
            const r = 2.2 * Math.cbrt(rand());
            x = r * Math.sin(ph) * Math.cos(th);
            y = r * Math.sin(ph) * Math.sin(th) * 0.7;
            z = r * Math.cos(ph) * 0.5;
            ok = true;
            for (let j = 0; j < i; j++) {
                const dx = fish.px[j] - x,
                    dy = fish.py[j] - y,
                    dz = fish.pz[j] - z;
                if (dx * dx + dy * dy + dz * dz < 0.36) {
                    ok = false;
                    break;
                }
            }
            tries++;
        }
        fish.px[i] = x;
        fish.py[i] = y;
        fish.pz[i] = z;
        const dir = rand() * Math.PI * 2;
        fish.vx[i] = Math.cos(dir) * 2.2;
        fish.vy[i] = (rand() - 0.5) * 0.6;
        fish.vz[i] = Math.sin(dir) * 1.2;
        fish.hx[i] = 1;
        fish.hy[i] = 0;
        fish.hz[i] = 0;
        fish.phase[i] = rand() * Math.PI * 2;
        fish.panic[i] = 0;
        fish.scale[i] = 0.9 + rand() * 0.35;
        fish.hue[i] = rand();
    }
}

function spawnPlankton() {
    const rand = mulberry32(777001);
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        plankton.px[i] = (rand() * 2 - 1) * (HX + 2.2);
        plankton.py[i] = (rand() * 2 - 1) * (HY + 1.2);
        plankton.pz[i] = -8 + rand() * 16; // 远近错落 → 纵深
        plankton.size[i] = 0.018 + rand() * rand() * 0.042; // 细小颗粒
        plankton.phase[i] = rand() * Math.PI * 2;
        plankton.vx[i] = (rand() - 0.5) * 0.24;
        plankton.vy[i] = (rand() - 0.5) * 0.12;
        plankton.g[i] = 0.14 + rand() * 0.22;
        plankton.b[i] = 0.22 + rand() * 0.26;
    }
}

const plankton = {
    px: new Float64Array(PLANKTON_COUNT),
    py: new Float64Array(PLANKTON_COUNT),
    pz: new Float64Array(PLANKTON_COUNT),
    vx: new Float64Array(PLANKTON_COUNT),
    vy: new Float64Array(PLANKTON_COUNT),
    size: new Float64Array(PLANKTON_COUNT),
    phase: new Float64Array(PLANKTON_COUNT),
    g: new Float64Array(PLANKTON_COUNT),
    b: new Float64Array(PLANKTON_COUNT),
};

// ---------------------------------------------------------------------------
// 动态网格缓冲(预分配,逐帧复用,无 GC 压力 → 120s 无泄漏)
// ---------------------------------------------------------------------------

const fishVertCount = FISH_COUNT * VERTS_PER_FISH;
const fishIdxCount = FISH_COUNT * IDX_PER_FISH;
const fishPositions = new Float32Array(fishVertCount * 3);
const fishColors = new Float32Array(fishVertCount * 4);
const fishIndices = new Uint16Array(fishIdxCount);
const fishMin = { x: 0, y: 0, z: 0 };
const fishMax = { x: 0, y: 0, z: 0 };

const plkVertCount = PLANKTON_COUNT * 4;
const plkIdxCount = PLANKTON_COUNT * 6;
const plkPositions = new Float32Array(plkVertCount * 3);
const plkColors = new Float32Array(plkVertCount * 4);
const plkIndices = new Uint16Array(plkIdxCount);
const plkMin = { x: 0, y: 0, z: 0 };
const plkMax = { x: 0, y: 0, z: 0 };

/** 一次性构建:索引 + 顶点色(逐鱼体色变化、背深腹浅、尾鳍略暗) */
function buildFishStaticData() {
    for (let f = 0; f < FISH_COUNT; f++) {
        const vBase = f * VERTS_PER_FISH;
        const iBase = f * IDX_PER_FISH;
        // 亮度/色相随个体变化:暖银-青灰(压暗避免过曝白)
        const warm = fish.hue[f];
        const br = 0.5 + warm * 0.18;
        const bg = 0.64 + warm * 0.12;
        const bb = 0.74 + warm * 0.1;
        // 环体顶点色:背部(B)偏暗、腹部(t=0)提亮 → 体积感
        for (let r = 0; r < RINGS; r++) {
            for (let k = 0; k < RING_N; k++) {
                const th = (k / RING_N) * Math.PI * 2;
                const t = (Math.sin(th) + 1) * 0.5;
                const shade = 0.52 + 0.55 * t; // 0.52(背) → 1.07(腹)
                const vi = vBase + r * RING_N + k;
                fishColors[vi * 4 + 0] = Math.min(1, br * shade);
                fishColors[vi * 4 + 1] = Math.min(1, bg * shade);
                fishColors[vi * 4 + 2] = Math.min(1, bb * shade);
                fishColors[vi * 4 + 3] = 1;
            }
        }
        // 尾鳍顶点色(略暗)
        for (let k = 0; k < 3; k++) {
            const vi = vBase + RINGS * RING_N + k;
            fishColors[vi * 4 + 0] = br * 0.55;
            fishColors[vi * 4 + 1] = bg * 0.58;
            fishColors[vi * 4 + 2] = bb * 0.62;
            fishColors[vi * 4 + 3] = 1;
        }
        // 索引:环间四边形
        for (let r = 0; r < RINGS - 1; r++) {
            for (let k = 0; k < RING_N; k++) {
                const k1 = (k + 1) % RING_N;
                const a = vBase + r * RING_N + k;
                const b = vBase + r * RING_N + k1;
                const c = vBase + (r + 1) * RING_N + k;
                const d = vBase + (r + 1) * RING_N + k1;
                let q = iBase + (r * RING_N + k) * 6;
                fishIndices[q] = a;
                fishIndices[q + 1] = c;
                fishIndices[q + 2] = b;
                fishIndices[q + 3] = b;
                fishIndices[q + 4] = c;
                fishIndices[q + 5] = d;
            }
        }
        // 尾鳍(材质关闭背面剔除,无需担心绕序)
        const t0 = vBase + RINGS * RING_N;
        let q = iBase + (RINGS - 1) * RING_N * 6;
        fishIndices[q] = t0;
        fishIndices[q + 1] = t0 + 1;
        fishIndices[q + 2] = t0 + 2;
    }
    // 浮游生物索引 + 静态色
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        const v = i * 4;
        plkIndices[i * 6 + 0] = v;
        plkIndices[i * 6 + 1] = v + 1;
        plkIndices[i * 6 + 2] = v + 2;
        plkIndices[i * 6 + 3] = v;
        plkIndices[i * 6 + 4] = v + 2;
        plkIndices[i * 6 + 5] = v + 3;
    }
    refreshPlanktonColors();
}

function refreshPlanktonColors() {
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        const dep = clamp((plankton.pz[i] + 8) / 16, 0, 1); // 近处更亮更大
        const lum = 0.55 + dep * 0.75;
        for (let k = 0; k < 4; k++) {
            const vi = i * 4 + k;
            plkColors[vi * 4 + 0] = 0.18 * lum;
            plkColors[vi * 4 + 1] = plankton.g[i] * lum;
            plkColors[vi * 4 + 2] = plankton.b[i] * lum;
            plkColors[vi * 4 + 3] = 1;
        }
    }
}

/** 逐帧重建鱼群顶点(位置);返回 minPos/maxPos 供包围盒 */
function fillFishVertices() {
    fishMin.x = fishMin.y = fishMin.z = 1e9;
    fishMax.x = fishMax.y = fishMax.z = -1e9;
    for (let i = 0; i < FISH_COUNT; i++) {
        let vx = fish.vx[i],
            vy = fish.vy[i],
            vz = fish.vz[i];
        let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vl < 1e-6) {
            vx = 1;
            vl = 1;
        }
        // 平滑朝向(避免急转抖动)
        const k = 0.12;
        fish.hx[i] += (vx / vl - fish.hx[i]) * k;
        fish.hy[i] += (vy / vl - fish.hy[i]) * k;
        fish.hz[i] += (vz / vl - fish.hz[i]) * k;
        let hxn = fish.hx[i],
            hyn = fish.hy[i],
            hzn = fish.hz[i];
        const hl = Math.sqrt(hxn * hxn + hyn * hyn + hzn * hzn) || 1;
        hxn /= hl;
        hyn /= hl;
        hzn /= hl;
        // right = up(0,1,0) × forward
        let rx = hzn,
            ry = 0,
            rz = -hxn;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl < 1e-4) {
            rx = 0;
            ry = 0;
            rz = 1;
        } else {
            rx /= rl;
            ry /= rl;
            rz /= rl;
        }
        // up = forward × right
        const ux = hyn * rz - hzn * ry;
        const uy = hzn * rx - hxn * rz;
        const uz = hxn * ry - hyn * rx;

        const p = fish.px[i],
            py = fish.py[i],
            pz = fish.pz[i];
        const s = fish.scale[i];
        const speedN = clamp(vl / 12, 0, 1);
        const amp = (0.09 + 0.11 * speedN) * s;
        const ph = fish.phase[i];

        const vBase = i * VERTS_PER_FISH;
        for (let r = 0; r < RINGS; r++) {
            const lx = RING_X[r];
            const hh = RING_H[r] * s;
            const hw = RING_W[r] * s;
            const taper = 0.22 + (1.9 * (0.45 - lx)) / 0.9; // 越靠尾部摆幅越大
            const wave = Math.sin(ph + (0.45 - lx) * 5.2) * amp * taper;
            for (let kk = 0; kk < RING_N; kk++) {
                const th = (kk / RING_N) * Math.PI * 2;
                const cth = Math.cos(th);
                const sth = Math.sin(th);
                const offR = cth * hw + wave;
                const offU = sth * hh;
                const X = p + hxn * lx * s + rx * offR + ux * offU;
                const Y = py + hyn * lx * s + ry * offR + uy * offU;
                const Z = pz + hzn * lx * s + rz * offR + uz * offU;
                const vi = (vBase + r * RING_N + kk) * 3;
                fishPositions[vi] = X;
                fishPositions[vi + 1] = Y;
                fishPositions[vi + 2] = Z;
                if (X < fishMin.x) fishMin.x = X;
                if (Y < fishMin.y) fishMin.y = Y;
                if (Z < fishMin.z) fishMin.z = Z;
                if (X > fishMax.x) fishMax.x = X;
                if (Y > fishMax.y) fishMax.y = Y;
                if (Z > fishMax.z) fishMax.z = Z;
            }
        }
        // 尾鳍:基点 + 上下两尖,横向行波放大
        const wBase = Math.sin(ph + (0.45 - TAIL_BASE_X) * 5.2) * amp * 2.15;
        const wTip = Math.sin(ph + (0.45 - TAIL_TIP_X) * 5.2) * amp * 2.6;
        const pts = [
            [TAIL_BASE_X, 0, wBase],
            [TAIL_TIP_X, TAIL_HALF * s, wTip],
            [TAIL_TIP_X, -TAIL_HALF * s, wTip],
        ];
        for (let kk = 0; kk < 3; kk++) {
            const lx = pts[kk][0],
                ou = pts[kk][1],
                orr = pts[kk][2];
            const X = p + hxn * lx * s + rx * orr + ux * ou;
            const Y = py + hyn * lx * s + ry * orr + uy * ou;
            const Z = pz + hzn * lx * s + rz * orr + uz * ou;
            const vi = (vBase + RINGS * RING_N + kk) * 3;
            fishPositions[vi] = X;
            fishPositions[vi + 1] = Y;
            fishPositions[vi + 2] = Z;
            if (X < fishMin.x) fishMin.x = X;
            if (Y < fishMin.y) fishMin.y = Y;
            if (Z < fishMin.z) fishMin.z = Z;
            if (X > fishMax.x) fishMax.x = X;
            if (Y > fishMax.y) fishMax.y = Y;
            if (Z > fishMax.z) fishMax.z = Z;
        }
    }
}

function fillPlanktonVertices(tNow) {
    plkMin.x = plkMin.y = plkMin.z = 1e9;
    plkMax.x = plkMax.y = plkMax.z = -1e9;
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        const s = plankton.size[i] * (1 + 0.18 * Math.sin(tNow * 1.7 + plankton.phase[i]));
        const x = plankton.px[i];
        const y = plankton.py[i] + Math.sin(tNow * 0.6 + plankton.phase[i]) * 0.18;
        const z = plankton.pz[i];
        const vi = i * 12;
        plkPositions[vi] = x - s;
        plkPositions[vi + 1] = y - s;
        plkPositions[vi + 2] = z;
        plkPositions[vi + 3] = x + s;
        plkPositions[vi + 4] = y - s;
        plkPositions[vi + 5] = z;
        plkPositions[vi + 6] = x + s;
        plkPositions[vi + 7] = y + s;
        plkPositions[vi + 8] = z;
        plkPositions[vi + 9] = x - s;
        plkPositions[vi + 10] = y + s;
        plkPositions[vi + 11] = z;
        if (x - s < plkMin.x) plkMin.x = x - s;
        if (y - s < plkMin.y) plkMin.y = y - s;
        if (z < plkMin.z) plkMin.z = z;
        if (x + s > plkMax.x) plkMax.x = x + s;
        if (y + s > plkMax.y) plkMax.y = y + s;
        if (z > plkMax.z) plkMax.z = z;
    }
}

// ---------------------------------------------------------------------------
// boids 模拟核心(逐帧,禁止预烘焙)
// ---------------------------------------------------------------------------

const NORMAL_MAX_SPEED = 4.6;
const NORMAL_MIN_SPEED = 2.0;
const PANIC_MAX_SPEED = 12.0;
const PANIC_MIN_SPEED = 5.0;
const PERCEPTION2 = 3.4 * 3.4;
const SEP_R = 1.25; // 最小间距:防穿插(线性衰减权重,避免 1/d² 爆冲把鱼群炸散)
const SEP_R2 = SEP_R * SEP_R;

let foodGrains = []; // {bites, lastBiteT, x,y,z}

function dropFoodAt(uiX, uiY) {
    const w = pointerToWorld(uiX, uiY);
    if (!w) return;
    sim.foodX = clamp(w.x, -HX * 0.85, HX * 0.85);
    sim.foodY = clamp(w.y, -HY * 0.85, HY * 0.85);
    sim.foodZ = 0;
    sim.foodActive = true;
    sim.foodDropT = sim.time;
    foodGrains = [];
    const rand = mulberry32((sim.resetCount + 1) * 7919 + Math.floor(sim.time * 1000));
    for (let i = 0; i < FOOD_GRAINS; i++) {
        foodGrains.push({
            bites: 3, // 每粒需 3 次啃食才消失 → 投喂闭环可持续数秒
            lastBiteT: -10,
            x: sim.foodX + (rand() - 0.5) * 0.5,
            y: sim.foodY + (rand() - 0.5) * 0.5,
            z: (rand() - 0.5) * 0.4,
        });
    }
    updateFoodNodes();
}

function updateFood() {
    if (!sim.foodActive) return;
    // 被吃:任意鱼距粮 < 0.45 且距上次啃食 > 0.7s
    for (const g of foodGrains) {
        if (g.bites <= 0) continue;
        if (sim.time - g.lastBiteT < 0.7) continue;
        for (let i = 0; i < FISH_COUNT; i++) {
            const dx = fish.px[i] - g.x,
                dy = fish.py[i] - g.y,
                dz = fish.pz[i] - g.z;
            if (dx * dx + dy * dy + dz * dz < 0.2) {
                g.bites -= 1;
                g.lastBiteT = sim.time;
                break;
            }
        }
    }
    if (foodGrains.every((g) => g.bites <= 0) || sim.time - sim.foodDropT > FOOD_TIMEOUT_S) {
        sim.foodActive = false;
        sim.avgDistanceToFood = null;
        updateFoodNodes();
    }
}

function boidsStep(dt) {
    const now = sim.time;
    // --- 惊散触发:指针(及按住拖拽的扫掠线段)与鱼的实际距离判定(禁止定时器/脚本触发) ---
    let inRange = false;
    if (pointer.has && cameraComp) {
        const r2 = SCATTER_R * SCATTER_R;
        // 清理过期拖拽线段
        for (let k = dragSegs.length - 1; k >= 0; k--) {
            if (sim.time - dragSegs[k].t > DRAG_SEG_TTL) dragSegs.splice(k, 1);
        }
        for (let i = 0; i < FISH_COUNT; i++) {
            let hit = false;
            const dx0 = fish.px[i] - pointer.wx,
                dy0 = fish.py[i] - pointer.wy,
                dz0 = fish.pz[i];
            if (dx0 * dx0 + dy0 * dy0 + dz0 * dz0 < r2) hit = true;
            else {
                for (let k = 0; k < dragSegs.length; k++) {
                    const sg = dragSegs[k];
                    if (segDist2(fish.px[i], fish.py[i], fish.pz[i], sg.x0, sg.y0, sg.x1, sg.y1) < r2) {
                        hit = true;
                        break;
                    }
                }
            }
            if (hit) {
                inRange = true;
                if (fish.panic[i] < 1) {
                    fish.panic[i] = 1;
                    const dx = fish.px[i] - pointer.wx,
                        dy = fish.py[i] - pointer.wy;
                    const dl = Math.sqrt(dx * dx + dy * dy + dz0 * dz0) || 1;
                    // 立即逃逸冲量
                    fish.vx[i] += (dx / dl) * 6.5;
                    fish.vy[i] += (dy / dl) * 6.5;
                    fish.vz[i] += (dz0 / dl) * 6.5;
                }
            }
        }
    }
    if (inRange) sim.scatterEngaged = true;
    if (sim.scatterEngaged) {
        const stationary = now - pointer.lastMoveT > STATIONARY_CALM_S;
        if (!inRange && stationary) sim.scatterEngaged = false;
        if (!pointer.has) sim.scatterEngaged = false;
    }
    sim.mode = sim.scatterEngaged ? 'scatter' : 'normal';

    // --- 质心(用于聚集与 cohesion 指标) ---
    let cx = 0,
        cy = 0,
        cz = 0;
    for (let i = 0; i < FISH_COUNT; i++) {
        cx += fish.px[i];
        cy += fish.py[i];
        cz += fish.pz[i];
    }
    cx /= FISH_COUNT;
    cy /= FISH_COUNT;
    cz /= FISH_COUNT;
    let meanDist = 0;
    for (let i = 0; i < FISH_COUNT; i++) {
        const dx = fish.px[i] - cx,
            dy = fish.py[i] - cy,
            dz = fish.pz[i] - cz;
        meanDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    meanDist /= FISH_COUNT;
    sim.avgCohesion = 1 - Math.min(1, meanDist / 10); // spec §8 定义

    // --- 逐鱼三规则 + 惊散 + 觅食 ---
    let panicCount = 0;
    let distFoodSum = 0;
    const foodOn = sim.foodActive;
    for (let i = 0; i < FISH_COUNT; i++) {
        const panic = fish.panic[i];
        if (panic > 0.2) panicCount++;
        let ax = 0,
            ay = 0,
            az = 0;
        let cnt = 0,
            cox = 0,
            coy = 0,
            coz = 0,
            alx = 0,
            aly = 0,
            alz = 0,
            sx = 0,
            sy = 0,
            sz = 0,
            sepCnt = 0;
        for (let j = 0; j < FISH_COUNT; j++) {
            if (j === i) continue;
            const dx = fish.px[j] - fish.px[i];
            const dy = fish.py[j] - fish.py[i];
            const dz = fish.pz[j] - fish.pz[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < PERCEPTION2) {
                cnt++;
                cox += dx;
                coy += dy;
                coz += dz;
                alx += fish.vx[j];
                aly += fish.vy[j];
                alz += fish.vz[j];
                if (d2 < SEP_R2 && d2 > 1e-9) {
                    const d = Math.sqrt(d2);
                    const w = (SEP_R - d) / SEP_R; // 线性衰减:近处强推、远处温和
                    const inv = w / d;
                    sx -= dx * inv;
                    sy -= dy * inv;
                    sz -= dz * inv;
                    sepCnt++;
                }
            }
        }
        if (cnt > 0) {
            // 聚集:朝邻域质心转向;常态权重高(重聚快),panic 时权重塌缩
            const wCoh = (panic > 0 ? 1.4 * (1 - panic) : 1.4) + (sim.mode === 'normal' ? 1.3 : 0);
            ax += (cox / cnt) * wCoh;
            ay += (coy / cnt) * wCoh;
            az += (coz / cnt) * wCoh;
            // 对齐:邻域平均航向
            const wAli = panic > 0 ? 1.5 * (1 - 0.7 * panic) : 1.5;
            ax += (alx / cnt - fish.vx[i]) * wAli * 0.5;
            ay += (aly / cnt - fish.vy[i]) * wAli * 0.5;
            az += (alz / cnt - fish.vz[i]) * wAli * 0.5;
        }
        if (sepCnt > 0) {
            const wSep = (panic > 0 ? 4.6 : 3.6) * 30;
            ax += sx * wSep;
            ay += sy * wSep;
            az += sz * wSep;
        }
        // 全局鱼群完整性拉力:感知半径(3.4)之外的远距内聚,保证 90 条鱼始终是一个鱼群
        // (panic 时按 (1-panic)² 释放让位逃逸;食物在场时让位觅食)
        {
            const gx = cx - fish.px[i],
                gy = cy - fish.py[i],
                gz = cz - fish.pz[i];
            const gd = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
            if (gd > 3.5) {
                let pull = Math.min(12, (gd - 3.5) * 1.6);
                if (panic > 0) pull *= (1 - panic) * (1 - panic);
                if (foodOn) pull *= 0.15;
                ax += (gx / gd) * pull;
                ay += (gy / gd) * pull;
                az += (gz / gd) * pull;
            }
        }
        // 边界软约束(不得游出画面)
        const m = 1.0;
        if (fish.px[i] > HX - m) ax -= (fish.px[i] - (HX - m)) * 9;
        if (fish.px[i] < -HX + m) ax -= (fish.px[i] + HX - m) * 9;
        if (fish.py[i] > HY - m) ay -= (fish.py[i] - (HY - m)) * 9;
        if (fish.py[i] < -HY + m) ay -= (fish.py[i] + HY - m) * 9;
        if (fish.pz[i] > HZ - m) az -= (fish.pz[i] - (HZ - m)) * 9;
        if (fish.pz[i] < -HZ + m) az -= (fish.pz[i] + HZ - m) * 9;
        // 游走噪声(常态轻微,panic 强烈 → 炸开不扎堆)
        const wn = panic > 0 ? 3.2 : 0.55;
        ax += (Math.random() - 0.5) * wn;
        ay += (Math.random() - 0.5) * wn;
        az += (Math.random() - 0.5) * wn;
        // 觅食吸引(食物在场时恐惧让位饥饿:逃逸 × 0.2)
        if (foodOn) {
            const gx = sim.foodX - fish.px[i],
                gy = sim.foodY - fish.py[i],
                gz = sim.foodZ - fish.pz[i];
            const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
            const pull = gl > 4 ? 16 : 7;
            ax += (gx / gl) * pull;
            ay += (gy / gl) * pull;
            az += (gz / gl) * pull;
            distFoodSum += gl;
        } else if (panic > 0.02) {
            // 无食物时:远离指针持续逃逸
            const gx = fish.px[i] - pointer.wx,
                gy = fish.py[i] - pointer.wy,
                gz = fish.pz[i];
            const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
            const flee = 55 * panic;
            ax += (gx / gl) * flee;
            ay += (gy / gl) * flee;
            az += (gz / gl) * flee;
        }
        // 积分
        fish.vx[i] += ax * dt;
        fish.vy[i] += ay * dt;
        fish.vz[i] += az * dt;
        let sp = Math.sqrt(fish.vx[i] ** 2 + fish.vy[i] ** 2 + fish.vz[i] ** 2) || 1e-6;
        const maxSp = panic > 0.02 ? PANIC_MAX_SPEED * (0.55 + 0.45 * panic) : NORMAL_MAX_SPEED;
        const minSp = panic > 0.05 ? PANIC_MIN_SPEED : NORMAL_MIN_SPEED;
        if (sp > maxSp) {
            const f = maxSp / sp;
            fish.vx[i] *= f;
            fish.vy[i] *= f;
            fish.vz[i] *= f;
            sp = maxSp;
        } else if (sp < minSp) {
            const f = minSp / sp;
            fish.vx[i] *= f;
            fish.vy[i] *= f;
            fish.vz[i] *= f;
            sp = minSp;
        }
        fish.px[i] += fish.vx[i] * dt;
        fish.py[i] += fish.vy[i] * dt;
        fish.pz[i] += fish.vz[i] * dt;
        // 硬钳制在水域内(不得游出画面外消失)
        fish.px[i] = clamp(fish.px[i], -HX, HX);
        fish.py[i] = clamp(fish.py[i], -HY, HY);
        fish.pz[i] = clamp(fish.pz[i], -HZ, HZ);
        // 摆尾相位随速度推进
        fish.phase[i] += dt * (3.2 + sp * 1.9);
        // panic 衰减
        if (panic > 0) fish.panic[i] = Math.max(0, panic - dt * PANIC_DECAY_PER_S);
    }
    sim.panicking = panicCount;
    sim.avgDistanceToFood = foodOn ? distFoodSum / FISH_COUNT : null;
}

// ---------------------------------------------------------------------------
// 渲染装配
// ---------------------------------------------------------------------------

let fishMesh = null;
let plkMesh = null;
const foodNodes = [];
let foodRootNode = null;
let hudTimer = 0;

function makeVertexColorMaterial() {
    // 自定义材质:new Material() + initialize(…)(effectName/effectAsset 属性只读,只能走 initialize)。
    // builtin-unlit 的 USE_VERTEX_COLOR 宏开启顶点色;关闭背面剔除 → 鱼体/尾鳍/背板绕序免担忧。
    const mat = new Material();
    mat.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_VERTEX_COLOR: true, USE_TEXTURE: false },
        states: { rasterizerState: { cullMode: gfx.CullMode.NONE } },
    });
    return mat;
}

function buildBackgroundMesh() {
    // 单一静态网格:全屏水体渐变板(带大尺度光斑噪声 → 水体质感)+ 3 条顶部光束
    const W = 64,
        H = 44,
        Z = -10;
    const pos = [];
    const col = [];
    const idx = [];
    let vi = 0;
    const topC = [0.1, 0.4, 0.48];
    const botC = [0.004, 0.02, 0.042];
    // 渐变板:14×10 网格,顶点色 = 垂直渐变 + 两层正弦光斑(水下光斑观感,同时提高画面信息量)
    const NX = 14,
        NY = 10;
    for (let iy = 0; iy <= NY; iy++) {
        for (let ix = 0; ix <= NX; ix++) {
            const u = ix / NX,
                v = iy / NY;
            const x = (u - 0.5) * W,
                y = (v - 0.5) * H;
            pos.push(x, y, Z);
            const t = v; // 0=底 1=顶
            const mottle =
                0.5 +
                0.5 * Math.sin(x * 0.32 + 1.7) * Math.sin(y * 0.42 + 0.6) +
                0.25 * Math.sin(x * 0.11 - y * 0.23 + 2.4);
            const m = 1 + 0.45 * mottle;
            col.push(topC[0] * t * m, topC[1] * t * m, topC[2] * t * m + botC[2], 1);
        }
    }
    for (let iy = 0; iy < NY; iy++) {
        for (let ix = 0; ix < NX; ix++) {
            const a = iy * (NX + 1) + ix;
            idx.push(a, a + NX + 1, a + 1, a + 1, a + NX + 1, a + NX + 2);
        }
    }
    vi = (NX + 1) * (NY + 1);
    // 光束:上宽下窄的微斜四边形
    const beam = (bx, w0, w1, tilt) => {
        const yTop = H / 2 - 1,
            yBot = -H / 2 + 2;
        const xt = bx + tilt * yTop;
        const xb = bx + tilt * yBot;
        pos.push(xb - w1, yBot, Z + 0.35, xb + w1, yBot, Z + 0.35, xt + w0, yTop, Z + 0.35, xt - w0, yTop, Z + 0.35);
        const t = [0.16, 0.52, 0.58],
            b = [0.022, 0.11, 0.15];
        col.push(b[0], b[1], b[2], 1, b[0], b[1], b[2], 1, t[0], t[1], t[2], 1, t[0], t[1], t[2], 1);
        idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
    };
    beam(-9, 2.6, 0.9, 0.16);
    beam(-1.5, 3.4, 1.1, -0.1);
    beam(7.5, 2.2, 0.8, 0.2);
    return utils.MeshUtils.createMesh({
        positions: pos,
        colors: col,
        indices: idx,
        primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
        doubleSided: true,
    });
}

function createDynamicMeshFrom(vertCount, idxCount, positions, colors, indices) {
    // 动态网格:先按最大容量建结构(引擎内部会立即 initialize + 首次 updateSubMesh)
    return utils.MeshUtils.createDynamicMesh(
        0,
        { positions, colors, indices16: indices, primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST, doubleSided: true },
        undefined,
        { maxSubMeshes: 1, maxSubMeshVertices: vertCount, maxSubMeshIndices: idxCount },
    );
}

function updateFoodNodes() {
    const pulse = 1 + 0.1 * Math.sin(sim.time * 6);
    for (let i = 0; i < foodNodes.length; i++) {
        const n = foodNodes[i];
        const g = foodGrains[i];
        if (sim.foodActive && g && g.bites > 0) {
            n.active = true;
            n.setPosition(g.x, g.y, g.z);
            const s = (0.7 + 0.3 * (g.bites / 3)) * pulse;
            n.setScale(s, s, s);
        } else {
            n.active = false;
        }
    }
}

/** 每节点行为组件:驱动整场模拟 */
class ShoalSim extends Component {
    update(dt) {
        if (!window.__appReady) return;
        dt = Math.min(dt, 1 / 20);
        sim.time += dt;
        this.fpsAcc = (this.fpsAcc || 0) + dt;
        this.fpsN = (this.fpsN || 0) + 1;
        if (this.fpsN >= 30) {
            sim.fps = this.fpsN / this.fpsAcc;
            this.fpsAcc = 0;
            this.fpsN = 0;
        }
        boidsStep(dt);
        updateFood();
        // 食物脉冲发光(位置/尺寸以粮食状态为准)
        if (sim.foodActive) updateFoodNodes();
        // plankton 漂移
        for (let i = 0; i < PLANKTON_COUNT; i++) {
            plankton.px[i] += plankton.vx[i] * dt;
            plankton.py[i] += plankton.vy[i] * dt;
            if (plankton.px[i] > HX + 2.2) plankton.px[i] = -HX - 2.2;
            if (plankton.px[i] < -HX - 2.2) plankton.px[i] = HX + 2.2;
            if (plankton.py[i] > HY + 1.2) plankton.py[i] = -HY - 1.2;
            if (plankton.py[i] < -HY - 1.2) plankton.py[i] = HY + 1.2;
        }
        // 顶点重建 + 上传
        fillFishVertices();
        fishMesh.updateSubMesh(0, { positions: fishPositions, colors: fishColors, indices16: fishIndices, minPos: fishMin, maxPos: fishMax });
        fillPlanktonVertices(sim.time);
        plkMesh.updateSubMesh(0, { positions: plkPositions, colors: plkColors, indices16: plkIndices, minPos: plkMin, maxPos: plkMax });
        // HUD(4Hz)
        hudTimer += dt;
        if (hudTimer > 0.25) {
            hudTimer = 0;
            hud.textContent =
                `E08 深海鱼群  fish:${FISH_COUNT}  plankton:${PLANKTON_COUNT}\n` +
                `mode:${sim.mode}  cohesion:${sim.avgCohesion.toFixed(2)}  fps:${sim.fps.toFixed(0)}` +
                (sim.foodActive ? `  food:${sim.avgDistanceToFood.toFixed(1)}` : '');
        }
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E08-DeepSea');

    // 相机:水下中景,全水域在取景框内(z=18,fov45 → 13.25×7.45 @z=0 ⊇ 11×6.5 水域)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 0, 18));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = 45;
    cameraComp.near = 0.1;
    cameraComp.far = 200;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(6, 16, 26, 255);
    cameraComp.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式设置
    cameraComp.priority = 0;

    // 微弱方向光(unlit 材质不受光,保留以维持水面高光层级的场景完整性)
    const lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 10, 0));
    lightNode.setRotationFromEuler(-70, 0, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 20000;

    // 背景(渐变水体 + 顶部光束)
    const bgNode = new Node('WaterBackdrop');
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgRenderer = bgNode.addComponent(MeshRenderer);
    bgRenderer.mesh = buildBackgroundMesh();
    bgRenderer.material = makeVertexColorMaterial();

    // 鱼群动态网格
    spawnFish();
    buildFishStaticData();
    fillFishVertices();
    fishMesh = createDynamicMeshFrom(fishVertCount, fishIdxCount, fishPositions, fishColors, fishIndices);
    const fishNode = new Node('Shoal');
    fishNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(fishNode);
    const fishRenderer = fishNode.addComponent(MeshRenderer);
    fishRenderer.mesh = fishMesh;
    fishRenderer.material = makeVertexColorMaterial();

    // 浮游生物动态网格
    spawnPlankton();
    refreshPlanktonColors();
    fillPlanktonVertices(0);
    plkMesh = createDynamicMeshFrom(plkVertCount, plkIdxCount, plkPositions, plkColors, plkIndices);
    const plkNode = new Node('Plankton');
    plkNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(plkNode);
    const plkRenderer = plkNode.addComponent(MeshRenderer);
    plkRenderer.mesh = plkMesh;
    plkRenderer.material = makeVertexColorMaterial();

    // 食物:3 粒发光小球(亮色 unlit,脉冲缩放在 update 中处理)
    foodRootNode = new Node('FoodRoot');
    foodRootNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(foodRootNode);
    const foodMat = new Material();
    foodMat.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: false },
        states: { rasterizerState: { cullMode: gfx.CullMode.NONE } },
    });
    foodMat.setProperty('mainColor', new Color(255, 226, 120, 255));
    const grainMesh = utils.MeshUtils.createMesh(primitives.sphere(0.24));
    for (let i = 0; i < FOOD_GRAINS; i++) {
        const gn = new Node('FoodGrain' + i);
        gn.layer = Layers.Enum.DEFAULT;
        foodRootNode.addChild(gn);
        const gr = gn.addComponent(MeshRenderer);
        gr.mesh = grainMesh;
        gr.material = foodMat;
        gn.active = false;
        foodNodes.push(gn);
    }

    // 模拟驱动组件
    const simNode = new Node('ShoalSim');
    scene.addChild(simNode);
    simNode.addComponent(ShoalSim);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // 环境光 + 雾(水下体积感:EXP 雾随深度衰减,app.run 后经 scene.globals 配置)
    scene.globals.ambient.skyColorHDR.set(0.25, 0.42, 0.5, 1.0);
    scene.globals.ambient.skyIllum = 8000;
    scene.globals.fog.enabled = true;
    scene.globals.fog.type = 1; // FogType.EXP
    scene.globals.fog.fogColor = new Color(10, 42, 52, 255);
    scene.globals.fog.fogDensity = 0.03;

    // 帧计数 + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        sim.frame += 1;
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[e08] deep-sea shoal running on cocosair');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类(模板约定)
    console.error('[e08] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
