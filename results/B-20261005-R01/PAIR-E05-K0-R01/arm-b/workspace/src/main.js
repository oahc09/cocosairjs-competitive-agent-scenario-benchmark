/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair Arm(K0 冷启动实现)
 *
 * 全部视觉程序化生成,无任何外部资产(brief §5 assets=[])。实现路线(路径不限,brief §8):
 *   - 事件视界:近黑圆盘面片(y≈0 平面,半径 1.2),锐利边缘;
 *   - 吸积盘:高密度环形网格,顶点色承载径向颜色梯度(内白蓝→黄橙→暗红)、
 *     明暗相间螺旋条纹、多普勒方位角不对称;整体网格绕 Y 轴随时间刚体旋转
 *     (时间参数驱动,连续真实旋转,diskRotation 单调累加);
 *   - 辉光(无后处理,Brief 允许任意手段):内缘/外缘向外延伸"亮度平滑衰减到黑"的
 *     辉光环带 —— 纯黑深空背景上的不透明衰减等价于加色辉光,过渡无硬边;
 *   - 引力透镜观感(加分):竖直平面内的细亮环(光子环)包绕视界,下半被盘面前景自然遮挡;
 *   - 背景星空:800 颗六边形"软点"星(顶点色中心亮/边缘暗)附于远球壳,静态;
 *   - 星流:220 个细长六边形拖尾粒子(独立 Node + MeshRenderer,共享 4 种色路网格),
 *     螺旋轨迹汇入,接近视界加速、拉长,吞没后在外圈重生(总数恒定);
 *   - 相机:初始距离 14.0、俯角 30°;wheel(window capture 监听,规避 pal 层吞事件)改变
 *     目标距离,指数平滑逼近,夹在 [5, 28]。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true;
 *   - window.__bench = { getState(): { diskRotation, accretionPhase, cameraDistance,
 *     starStreamCount, backgroundStarCount, ... }, reset(): void }。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    builtinResMgr,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';

// ============================================================
// 常量与全局状态
// ============================================================
const TAU = Math.PI * 2;

const CFG = {
    diskSpeed: 0.35,        // 盘刚体旋转角速度 rad/s(规格要求 0.15–0.6)
    horizonR: 1.2,          // 事件视界半径(场景单位)
    glowInStart: 1.25,      // 内辉光起始半径
    innerR: 1.8,            // 盘内缘
    outerR: 6.5,            // 盘外缘
    swallowR: 1.32,         // 星流吞没半径(进入即在外圈重生)
    starCount: 800,         // 背景星数(>=300)
    particleCount: 220,     // 星流粒子数(>=200,恒定)
    camPitch: Math.PI / 6,  // 俯角 30°(15°–75° 区间内)
    camDist0: 14.0,
    zoomMin: 5,
    zoomMax: 28,
    wheelScale: 0.01,       // deltaY(-600)→ 距离 -6(落在 P4 期望区间)
    smoothRate: 6,          // 指数平滑速率 1/s(1s 内残差 e^-6 ≈ 0.25%)
};

const state = {
    frame: 0,
    resetCount: 0,
    diskRotation: 0,        // 累计旋转弧度,单调递增,reset 归零
    cameraDistance: CFG.camDist0,
    cameraTarget: CFG.camDist0,
    _warned: false,
};

// 相机方向(俯角固定):单位化 (0, sinP, cosP)
const CAM_Y = Math.sin(CFG.camPitch);
const CAM_Z = Math.cos(CFG.camPitch);

let diskNode = null;
let camNode = null;
let particles = [];

function applyCameraDistance(d) {
    if (!camNode) return;
    camNode.setPosition(0, CAM_Y * d, CAM_Z * d);
}

function doReset() {
    state.resetCount += 1;
    state.diskRotation = 0;
    state.cameraDistance = CFG.camDist0;
    state.cameraTarget = CFG.camDist0;
    if (diskNode) diskNode.setRotationFromEuler(0, 0, 0);
    applyCameraDistance(state.cameraDistance);
    for (let i = 0; i < particles.length; i++) particles[i].progress = particles[i].phase0;
}

window.__appReady = false;
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        diskRotation: state.diskRotation,
        accretionPhase: (state.diskRotation / TAU) % 1,
        cameraDistance: state.cameraDistance,
        starStreamCount: CFG.particleCount,
        backgroundStarCount: CFG.starCount,
        frame: state.frame,
        resetCount: state.resetCount,
    }),
    reset: () => doReset(),
};

// --- UI 控件:data-ui="reset"(右上角,DOM,非画布内) -----------------------
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
        "font:12px sans-serif;background:#222;color:#fff;border:1px solid #555;" +
        'border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
}

// --- 滚轮缩放:window capture 监听(pal 层会吞 canvas 鼠标事件;wheel 用 capture) ---
window.addEventListener(
    'wheel',
    (e) => {
        let dy = 0;
        if (typeof e.deltaY === 'number' && e.deltaY !== 0) dy = e.deltaY;
        else if (e.wheelDelta) dy = -e.wheelDelta;
        if (!dy) return;
        if (e.deltaMode === 1) dy *= 16;        // 行模式 → 像素
        else if (e.deltaMode === 2) dy *= 100;  // 页模式 → 像素
        state.cameraTarget = Math.min(CFG.zoomMax, Math.max(CFG.zoomMin, state.cameraTarget + dy * CFG.wheelScale));
        if (typeof e.preventDefault === 'function') e.preventDefault();
    },
    { capture: true, passive: false },
);

// ============================================================
// 工具
// ============================================================
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

/**
 * 逐三角形重定向绕向:使几何法线(右手定则)朝向 dirFor(center) 给定方向。
 * 引擎默认剔除背面,水平网格须从 +Y 可见、球壳点须朝向原点 —— 统一在此保证,
 * 不依赖对材质 cullMode 默认值的假设。
 */
function orientTriangles(geo, dirFor) {
    const P = geo.positions;
    const I = geo.indices;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const mx = (P[a] + P[b] + P[c]) / 3;
        const my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
        const mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
        const d = dirFor(mx, my, mz);
        if (nx * d[0] + ny * d[1] + nz * d[2] < 0) {
            const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp;
        }
    }
}

function makeGeometry(positions, colors, indices) {
    // 显式给 minPos/maxPos,不依赖 createMesh 是否自动计算包围盒(避免被视锥剔除)
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    return {
        positions, colors, indices,
        minPos: { x: minX, y: minY, z: minZ },
        maxPos: { x: maxX, y: maxY, z: maxZ },
    };
}

/** builtin-unlit 顶点色材质(经 initialize 传 effectAsset;effectName/effectAsset 属性只读) */
function createUnlitVertexColorMaterial() {
    const info = { defines: { USE_VERTEX_COLOR: true } };
    let builtin = null;
    try { builtin = builtinResMgr.get('builtin-unlit-material'); } catch (e) { builtin = null; }
    if (builtin && builtin.effectAsset) {
        info.effectAsset = builtin.effectAsset;
    } else {
        let effect = null;
        try { effect = builtinResMgr.get('builtin-unlit-effect'); } catch (e) { effect = null; }
        if (effect) info.effectAsset = effect;
        else info.effectName = 'builtin-unlit';
    }
    const mat = new Material();
    mat.initialize(info);
    return mat;
}

// ============================================================
// 吸积盘几何(顶点色:径向梯度 × 螺旋条纹 × 多普勒不对称;内外辉光衰减到黑)
// 注:引擎输出端存在亮度提升(gamma 类变换),调色板按最终显示效果校准:
//     内环带(白蓝)显示亮度需 >= 外环带 1.5x 以上,P3 有向 R-B 差留大余量。
// ============================================================
const DISK_STOPS = [
    // 半径, R, G, B(线性设计值)
    [1.8, 0.80, 0.83, 0.90],   // 白蓝(内缘白亮)
    [2.4, 0.86, 0.76, 0.58],   // 暖白
    [3.1, 0.78, 0.52, 0.24],   // 亮黄橙(中带)
    [4.2, 0.45, 0.20, 0.07],   // 橙→暗
    [5.4, 0.28, 0.10, 0.035],  // 暗红橙
    [6.5, 0.16, 0.05, 0.02],   // 暗红(外缘)
];

function diskBaseColor(r) {
    if (r <= DISK_STOPS[0][0]) { const s = DISK_STOPS[0]; return [s[1], s[2], s[3]]; }
    for (let i = 1; i < DISK_STOPS.length; i++) {
        if (r <= DISK_STOPS[i][0]) {
            const a = DISK_STOPS[i - 1], b = DISK_STOPS[i];
            const t = (r - a[0]) / (b[0] - a[0]);
            return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
        }
    }
    const s = DISK_STOPS[DISK_STOPS.length - 1];
    return [s[1], s[2], s[3]];
}

// 多普勒不对称(加分项):随盘一起旋转的亮侧(任一时刻一侧明显亮于另一侧)
function dopplerFactor(theta) { return 1 + 0.26 * Math.cos(theta - 0.8); }

const DISK_AZ = 240;
const DISK_RADII = [
    1.25, 1.33, 1.42, 1.52, 1.63, 1.74,                                  // 内辉光(衰减到黑)
    1.8, 1.92, 2.05, 2.2, 2.36, 2.53, 2.7, 2.9, 3.1, 3.32, 3.55, 3.8,    // 主盘(内密外疏)
    4.06, 4.33, 4.6, 4.88, 5.17, 5.47, 5.78, 6.1,
    6.5, 6.85, 7.2, 7.6, 8.1, 8.6,                                       // 外辉光(衰减到黑)
];

function buildDiskGeometry() {
    const cols = DISK_AZ + 1; // 重复一列缝合,配合 clamp 采样无缝
    const rows = DISK_RADII.length;
    const positions = new Array(rows * cols * 3);
    const colors = new Array(rows * cols * 4);
    const indices = [];
    for (let ri = 0; ri < rows; ri++) {
        const r = DISK_RADII[ri];
        for (let ci = 0; ci < cols; ci++) {
            const theta = (ci % DISK_AZ) / DISK_AZ * TAU;
            const k = ri * cols + ci;
            positions[k * 3] = r * Math.cos(theta);
            positions[k * 3 + 1] = 0;
            positions[k * 3 + 2] = r * Math.sin(theta);
            let c0, c1, c2;
            if (r < 1.8) {
                // 内辉光:内缘白蓝亮度向内平滑衰减到黑(光子环观感,不侵入视界)
                const g = clamp((r - CFG.glowInStart) / (CFG.innerR - CFG.glowInStart), 0, 1);
                const f = Math.pow(g, 1.8) * dopplerFactor(theta);
                c0 = 0.82 * f; c1 = 0.84 * f; c2 = 0.92 * f;
            } else if (r <= CFG.outerR) {
                const base = diskBaseColor(r);
                // 明暗相间螺旋条纹:9 重对称、方位角主导 + 轻微径向扭转(随网格整体旋转)
                const s = 0.62 + 0.38 * Math.sin(9 * theta + 1.6 * Math.log(r / CFG.innerR));
                const f = s * dopplerFactor(theta);
                c0 = base[0] * f; c1 = base[1] * f; c2 = base[2] * f;
            } else {
                // 外辉光:指数衰减到黑(黑背景上的加色近似,过渡平滑无硬边)
                const f = Math.exp(-(r - CFG.outerR) / 0.95) * dopplerFactor(theta);
                c0 = 0.16 * f; c1 = 0.05 * f; c2 = 0.02 * f;
            }
            colors[k * 4] = clamp(c0, 0, 1);
            colors[k * 4 + 1] = clamp(c1, 0, 1);
            colors[k * 4 + 2] = clamp(c2, 0, 1);
            colors[k * 4 + 3] = 1;
        }
    }
    for (let ri = 0; ri < rows - 1; ri++) {
        for (let ci = 0; ci < DISK_AZ; ci++) {
            const a = ri * cols + ci;
            const b = ri * cols + ci + 1;
            const c = (ri + 1) * cols + ci + 1;
            const d = (ri + 1) * cols + ci;
            indices.push(a, b, c, a, c, d);
        }
    }
    return makeGeometry(positions, colors, indices);
}

// ============================================================
// 事件视界(近黑圆盘)/ 光子环(竖直细环,透镜观感)
// ============================================================
function buildHorizonGeometry() {
    const SEG = 96;
    const y = 0.001;
    const positions = [0, y, 0];
    const colors = [0.004, 0.005, 0.008, 1];
    const indices = [];
    for (let i = 0; i < SEG; i++) {
        const th = i / SEG * TAU;
        positions.push(CFG.horizonR * Math.cos(th), y, CFG.horizonR * Math.sin(th));
        colors.push(0.004, 0.005, 0.008, 1);
        indices.push(0, 1 + i, 1 + ((i + 1) % SEG));
    }
    const geo = makeGeometry(positions, colors, indices);
    orientTriangles(geo, () => [0, 1, 0]);
    return geo;
}

function buildPhotonRingGeometry(camX, camY, camZ) {
    const SEG = 96;
    const rows = [1.3, 1.4, 1.5];
    const rowF = [0.15, 0.7, 0.12];
    const base = [0.85, 0.9, 1.0];
    const cols = SEG + 1;
    const positions = new Array(rows.length * cols * 3);
    const colors = new Array(rows.length * cols * 4);
    const indices = [];
    for (let ri = 0; ri < rows.length; ri++) {
        for (let ci = 0; ci < cols; ci++) {
            const phi = (ci % SEG) / SEG * TAU;
            const k = ri * cols + ci;
            positions[k * 3] = rows[ri] * Math.cos(phi);
            positions[k * 3 + 1] = rows[ri] * Math.sin(phi);
            positions[k * 3 + 2] = 0;
            colors[k * 4] = clamp(base[0] * rowF[ri], 0, 1);
            colors[k * 4 + 1] = clamp(base[1] * rowF[ri], 0, 1);
            colors[k * 4 + 2] = clamp(base[2] * rowF[ri], 0, 1);
            colors[k * 4 + 3] = 1;
        }
    }
    for (let ri = 0; ri < rows.length - 1; ri++) {
        for (let ci = 0; ci < SEG; ci++) {
            const a = ri * cols + ci, b = ri * cols + ci + 1;
            const c = (ri + 1) * cols + ci + 1, d = (ri + 1) * cols + ci;
            indices.push(a, b, c, a, c, d);
        }
    }
    const geo = makeGeometry(positions, colors, indices);
    // 面向相机(三角法线朝向相机位置)
    orientTriangles(geo, (mx, my, mz) => {
        const dx = camX - mx, dy = camY - my, dz = camZ - mz;
        const L = Math.hypot(dx, dy, dz) || 1;
        return [dx / L, dy / L, dz / L];
    });
    return geo;
}

// ============================================================
// 背景星空(六边形软点,中心亮/边缘暗) + 微弱冷色星云
// ============================================================
function buildStarGeometry(rng) {
    const positions = [];
    const colors = [];
    const indices = [];
    const PALETTES = [
        [1.0, 1.0, 1.0],
        [0.75, 0.85, 1.0],
        [1.0, 0.87, 0.68],
        [0.85, 1.0, 1.0],
    ];

    function addSoftHexagon(px, py, pz, size, cr, cg, cb) {
        const base = positions.length / 3;
        positions.push(px, py, pz);
        colors.push(clamp(cr, 0, 1), clamp(cg, 0, 1), clamp(cb, 0, 1), 1);
        // 单位径向方向(切平面基必须由单位向量参与叉积)
        const L0 = Math.hypot(px, py, pz) || 1;
        const dx = px / L0, dy = py / L0, dz = pz / L0;
        // 切平面基
        let ux = 0, uy = 1, uz = 0;
        let t1x = uy * pz - uz * py, t1y = uz * px - ux * pz, t1z = ux * py - uy * px;
        let L = Math.hypot(t1x, t1y, t1z);
        if (L < 1e-4) { ux = 1; uy = 0; uz = 0; t1x = uy * pz - uz * py; t1y = uz * px - ux * pz; t1z = ux * py - uy * px; L = Math.hypot(t1x, t1y, t1z); }
        t1x /= L; t1y /= L; t1z /= L;
        // 副切线 = 单位方向 × t1(必须用单位方向;误用位置向量会使模长 = 星距 → 星点被拉成巨棒)
        const t2x = dy * t1z - dz * t1y, t2y = dz * t1x - dx * t1z, t2z = dx * t1y - dy * t1x;
        // 双层环软化:内环 0.5×size(亮度 0.6)、外环 1.0×size(亮度 0.16)→ 无生硬六边形轮廓
        const RINGS = [[0.5, 0.6], [1.0, 0.16]];
        const ringStart = [];
        for (let ri = 0; ri < RINGS.length; ri++) {
            const rr = cr * RINGS[ri][1], rg = cg * RINGS[ri][1], rb = cb * RINGS[ri][1];
            ringStart.push(base + 1 + ri * 6);
            for (let k = 0; k < 6; k++) {
                const a = k / 6 * TAU;
                const ca = Math.cos(a), sa = Math.sin(a);
                const off = RINGS[ri][0] * size;
                positions.push(px + (t1x * ca + t2x * sa) * off, py + (t1y * ca + t2y * sa) * off, pz + (t1z * ca + t2z * sa) * off);
                colors.push(clamp(rr, 0, 1), clamp(rg, 0, 1), clamp(rb, 0, 1), 1);
            }
        }
        for (let k = 0; k < 6; k++) indices.push(base, ringStart[0] + k, ringStart[0] + ((k + 1) % 6));
        for (let k = 0; k < 6; k++) {
            const ik0 = ringStart[0] + k, ik1 = ringStart[0] + ((k + 1) % 6);
            const ok0 = ringStart[1] + k, ok1 = ringStart[1] + ((k + 1) % 6);
            indices.push(ik0, ok0, ok1, ik0, ok1, ik1);
        }
    }

    for (let i = 0; i < CFG.starCount; i++) {
        const z = rng() * 2 - 1;
        const a = rng() * TAU;
        const xy = Math.sqrt(Math.max(0, 1 - z * z));
        const dx = xy * Math.cos(a), dy = z, dz = xy * Math.sin(a);
        const R = 55 + rng() * 30;
        let size = 0.45 + rng() * rng() * 1.05;
        if (rng() < 0.08) size *= 1.5;
        const pal = PALETTES[(rng() * PALETTES.length) | 0];
        const bright = 0.6 + rng() * 0.4;
        addSoftHexagon(dx * R, dy * R, dz * R, size, pal[0] * bright, pal[1] * bright, pal[2] * bright);
    }
    // 微弱冷色星云渐变(可选加分,非常暗)
    for (let i = 0; i < 3; i++) {
        const z = rng() * 1.2 - 0.6;
        const a = rng() * TAU;
        const xy = Math.sqrt(Math.max(0, 1 - z * z));
        const R = 65;
        addSoftHexagon(xy * Math.cos(a) * R, z * R, xy * Math.sin(a) * R, 9 + rng() * 5, 0.05, 0.07, 0.12);
    }
    const geo = makeGeometry(positions, colors, indices);
    orientTriangles(geo, (mx, my, mz) => [-mx, -my, -mz]); // 面向原点(相机侧)
    return geo;
}

// ============================================================
// 星流粒子(细长六边形拖尾,共享 4 种色路网格;Node 变换驱动运动)
// ============================================================
function buildStreakGeometry(tint) {
    const V = [
        [-0.5, 0, 0, 0.12],
        [-0.22, 0, 0.065, 0.65],
        [0.22, 0, 0.065, 1.0],
        [0.5, 0, 0, 0.85],
        [0.22, 0, -0.065, 1.0],
        [-0.22, 0, -0.065, 0.65],
    ];
    const positions = [];
    const colors = [];
    for (let i = 0; i < V.length; i++) {
        positions.push(V[i][0], V[i][1], V[i][2]);
        colors.push(clamp(tint[0] * V[i][3], 0, 1), clamp(tint[1] * V[i][3], 0, 1), clamp(tint[2] * V[i][3], 0, 1), 1);
    }
    const indices = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5];
    const geo = makeGeometry(positions, colors, indices);
    orientTriangles(geo, () => [0, 1, 0]);
    return geo;
}

const STREAK_TINTS = [
    [0.92, 0.96, 1.0],
    [0.78, 0.88, 1.0],
    [1.0, 0.92, 0.82],
    [0.68, 0.78, 0.92],
];

function particleRadius(p, u) {
    return p.r0 - (p.r0 - CFG.swallowR) * Math.pow(u, 1.35);
}
function particleTheta(p, u) {
    return p.theta0 + p.windA * u + p.windB * Math.pow(u, 2.2);
}

function updateParticle(p, dt) {
    p.progress += dt / p.period;
    if (p.progress >= 1) p.progress -= 1; // 吞没 → 外圈重生,总数恒定
    const u = p.progress;
    const r = particleRadius(p, u);
    const th = particleTheta(p, u);
    const x = r * Math.cos(th);
    const z = r * Math.sin(th);
    // 数值微分求速度方向(拖尾沿运动方向)
    const eps = 0.0025;
    const u2 = Math.min(u + eps, 1);
    const r2 = particleRadius(p, u2);
    const th2 = particleTheta(p, u2);
    const dx = r2 * Math.cos(th2) - x;
    const dz = r2 * Math.sin(th2) - z;
    const dl = Math.hypot(dx, dz) || 1e-6;
    // 局部 +X 对齐速度方向(绕 Y 旋转 yaw)
    const yaw = Math.atan2(-dz / dl, dx / dl);
    // 接近视界加速拉长(拖尾)
    const stretch = Math.min(1.8, 0.35 + 1.5 * Math.pow(1.9 / Math.max(r, 0.5), 1.7));
    p.node.setPosition(x, p.yOff, z);
    p.node.setRotationFromEuler(0, yaw, 0);
    p.node.setScale(stretch * p.baseLen, 1, p.wScale);
}

function makeParticles(rng) {
    const arr = [];
    for (let i = 0; i < CFG.particleCount; i++) {
        const rv = rng();
        const meshIdx = rv < 0.35 ? 0 : (rv < 0.65 ? 1 : (rv < 0.8 ? 2 : 3));
        arr.push({
            r0: 5.2 + rng() * 3.0,        // 外圈重生半径 5.2–8.2
            theta0: rng() * TAU,
            phase0: rng(),                 // 错峰初始进度(稳态星流)
            progress: 0,
            period: 9 + rng() * 8,         // 生命周期 s
            yOff: 0.04 + rng() * 0.14,     // 略高于盘面,避免 z-fighting
            baseLen: 0.3 + rng() * 0.25,   // 基准长度(单位化网格 1.0)
            wScale: 0.5 + rng() * 0.4,     // 宽度缩放(基准 0.13)
            windA: 2.2 + rng() * 1.6,      // 螺旋缠绕(渐进项)
            windB: 3.5 + rng() * 3.0,      // 近核加速缠绕
            meshIdx,
            node: null,
        });
    }
    return arr;
}

// ============================================================
// 场景驱动器(每帧:盘旋转 / 相机平滑 / 星流推进)
// ============================================================
class Driver extends Component {
    update(dt) {
        const step = Math.min(typeof dt === 'number' && dt > 0 ? dt : 0.016, 0.1); // 失焦回来防时间跳变
        try {
            state.diskRotation += step * CFG.diskSpeed;
            if (diskNode) diskNode.setRotationFromEuler(0, -state.diskRotation, 0);

            const k = 1 - Math.exp(-CFG.smoothRate * step);
            state.cameraDistance += (state.cameraTarget - state.cameraDistance) * k;
            if (Math.abs(state.cameraTarget - state.cameraDistance) < 0.0005) state.cameraDistance = state.cameraTarget;
            applyCameraDistance(state.cameraDistance);

            for (let i = 0; i < particles.length; i++) updateParticle(particles[i], step);
        } catch (e) {
            if (!state._warned) {
                state._warned = true;
                console.warn('[e05] update step error:', e && e.message ? e.message : e);
            }
        }
    }
}

// ============================================================
// 主流程
// ============================================================
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    const scene = new Scene('E05-Blackhole');
    const rng = mulberry32(20261005);

    const matVC = createUnlitVertexColorMaterial();

    // 相机(先建,光子环朝向要用其位置)
    camNode = new Node('Main Camera');
    scene.addChild(camNode);
    camNode.setPosition(new Vec3(0, CAM_Y * CFG.camDist0, CAM_Z * CFG.camDist0));
    camNode.lookAt(new Vec3(0, 0, 0));
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 70; // 垂直 FOV:视界直径约占短边 12%
    camera.near = 0.1;
    camera.far = 300;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(3, 4, 10, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    function addMeshNode(name, mesh, parent) {
        const n = new Node(name);
        (parent || scene).addChild(n);
        n.layer = Layers.Enum.DEFAULT;
        const mr = n.addComponent(MeshRenderer);
        mr.mesh = mesh;
        mr.material = matVC;
        return n;
    }

    // 吸积盘(整体刚体旋转的载体)
    const diskGeo = buildDiskGeometry();
    orientTriangles(diskGeo, () => [0, 1, 0]);
    diskNode = addMeshNode('AccretionDisk', utils.createMesh(diskGeo));

    // 事件视界 + 光子环
    addMeshNode('EventHorizon', utils.createMesh(buildHorizonGeometry()));
    addMeshNode('PhotonRing', utils.createMesh(buildPhotonRingGeometry(0, CAM_Y * CFG.camDist0, CAM_Z * CFG.camDist0)));

    // 背景星空 + 星云
    addMeshNode('Starfield', utils.createMesh(buildStarGeometry(rng)));

    // 星流粒子
    particles = makeParticles(rng);
    const streakMeshes = STREAK_TINTS.map((t) => utils.createMesh(buildStreakGeometry(t)));
    const particleRoot = new Node('StarStream');
    scene.addChild(particleRoot);
    particleRoot.layer = Layers.Enum.DEFAULT;
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const n = new Node('star' + i);
        n.layer = Layers.Enum.DEFAULT;
        particleRoot.addChild(n);
        const mr = n.addComponent(MeshRenderer);
        mr.mesh = streakMeshes[p.meshIdx];
        mr.material = matVC;
        p.node = n;
        p.progress = p.phase0;
        updateParticle(p, 0);
    }

    const driverNode = new Node('SceneDriver');
    scene.addChild(driverNode);
    driverNode.addComponent(Driver);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // 帧计数 + 首帧就绪(Director 事件,同模板)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[e05] black hole accretion disk running');
} catch (err) {
    // 致命错误(如 WebGL2 不可用):显式抛出为未捕获错误,便于 harness 捕获分类
    console.warn('[e05] fatal:', err && (err.stack || err.message) ? (err.message || 'stack-logged') : err);
    setTimeout(() => { throw err; }, 0);
}
