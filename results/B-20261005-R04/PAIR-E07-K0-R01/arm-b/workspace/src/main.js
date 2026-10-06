/**
 * E07 霓虹夜城 (Neon Night City) — cocosair (K0 Code First)
 *
 * 场景构成(全部程序化,批量提交绘制):
 *   - 楼群:网格街区程序化 ~250 栋,合并为单个静态 Mesh(1 次绘制,builtin-standard + 顶点色);
 *   - 发光窗阵:每栋楼 ≥8 个发光窗点、全场景 ≥2000,窗格矩阵排布,合并为单个静态 Mesh
 *     (builtin-unlit + 顶点色,引擎距离雾自动衰减远处窗光);
 *   - 车流:72 辆车沿 3 条横穿画面的主干道连续移动(头灯白黄/尾灯红可区分),
 *   - 雨:2200 个下落粒子循环重生 —— 车/雨/霓虹/楼顶警示灯合并进单个动态 Mesh
 *     (utils.MeshUtils.createDynamicMesh + updateSubMesh 每帧更新,1 次绘制);
 *   - 雾:scene.globals.fog(EXP_SQUARED),toggle-fog 按钮即时启停;
 *   - 霓虹:竖向灯带/招牌横幅/楼顶广告牌 ≥3 种高饱和色相,呼吸/闪烁。
 *
 * 页面契约:__appReady(首帧 EVENT_AFTER_DRAW 后 true)+ __bench{getState,reset}
 *   + data-ui/data-bench 控件(toggle-fog、reset)+ __bench.debug.grab(自检区域采样)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    Material,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';

/* ============================ 确定性随机(同一种子 → 同一座城,reset 幂等) ============================ */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rng = mulberry32(20261007);
const R = () => rng();
const RR = (a, b) => a + (b - a) * rng();

/* ============================ 场景规模(恒定满规模,不随探针变化) ============================ */
const N_CARS = 72;    // ≥60
const N_RAIN = 2200;  // ≥1500
const X_ROADS = [52, 36, 20];      // 3 条横穿画面的主干道(沿 X 轴),相机在 z=75
const AVENUES = [-30, 30];         // 纵向大道(纯视觉,分割街区)
const X_MIN = -150, X_MAX = 150;   // 城市横向范围
const Z_MIN = -168, Z_MAX = 1;     // 楼群纵向范围(道路 20/36/52 在楼群前方)
const CAR_X_SPAN = 145;            // 车流循环边界

/* ============================ 顶点构建工具 ============================ */
// 静态楼群/地面网格(builtin-standard,受光+受雾)
const bPos = [], bNrm = [], bCol = [], bIdx = [];
// 静态发光网格:窗阵(builtin-unlit + 顶点色 + 引擎雾)
const wPos = [], wCol = [], wIdx = [];

function pushQuad(pos, nrm, col, idx, c, ux, uy, uz, vx, vy, vz, nx, ny, nz, r, g, b, bright) {
    // c=中心, u/v=半边向量, 颜色线性 RGB × bright
    const base = pos.length / 3;
    for (let k = 0; k < 4; k++) {
        const su = (k === 1 || k === 2) ? 1 : -1;
        const sv = (k >= 2) ? 1 : -1;
        pos.push(c[0] + su * ux + sv * vx, c[1] + su * uy + sv * vy, c[2] + su * uz + sv * vz);
        if (nrm) nrm.push(nx, ny, nz);
        col.push(r * bright, g * bright, b * bright, 1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
// 轴对齐水平/竖直 quad 的便捷封装
function quadXZ(pos, nrm, col, idx, cx, y, cz, hw, hd, r, g, b, bright) {
    // u/v 绕序保证 cross(u,v)=+Y(朝上,避免背面剔除)
    pushQuad(pos, nrm, col, idx, [cx, y, cz], 0, 0, hd, hw, 0, 0, 0, 1, 0, r, g, b, bright);
}
function quadZ(pos, col, idx, cx, cy, cz, hw, hh, r, g, b, bright) {
    pushQuad(pos, null, col, idx, [cx, cy, cz], hw, 0, 0, 0, hh, 0, 0, 0, 1, r, g, b, bright);
}

/* ============================ 楼群 + 地面(静态 standard 网格) ============================ */
const buildings = []; // {x, z, w, d, h}
{
    // 地面(暗色沥青)
    quadXZ(bPos, bNrm, bCol, bIdx, 0, 0, -170, 420, 250, 0.02, 0.021, 0.03, 1);
    // 主干道路面(略亮)+ 中央虚线(抬高 y 防 z-fighting)
    for (const rz of X_ROADS) {
        quadXZ(bPos, bNrm, bCol, bIdx, 0, 0.05, rz, 300, 4, 0.07, 0.071, 0.092, 1);
        for (let x = -148; x <= 148; x += 8) {
            quadXZ(bPos, bNrm, bCol, bIdx, x, 0.075, rz, 1.3, 0.16, 0.26, 0.23, 0.11, 1);
        }
    }
    // 纵向大道
    for (const ax of AVENUES) {
        quadXZ(bPos, bNrm, bCol, bIdx, ax, 0.05, -80, 4, 190, 0.07, 0.071, 0.092, 1);
    }
    // 路灯暖光池(静态,增强街道层可读性)
    for (const rz of X_ROADS) {
        let k = 0;
        for (let x = -144; x <= 144; x += 24, k++) {
            quadXZ(bPos, bNrm, bCol, bIdx, x, 0.09, rz + (k % 2 ? 1.7 : -1.7), 4, 2, 0.3, 0.24, 0.12, 1);
        }
    }

    // 网格街区:12×13 间距,跳过大道与随机空地
    for (let gx = X_MIN + 6; gx <= X_MAX - 6; gx += 12) {
        for (let gz = Z_MIN + 6; gz <= Z_MAX - 4; gz += 13) {
            if (Math.abs(gx + 30) < 9 || Math.abs(gx - 30) < 9) continue; // 大道避让
            if (R() < 0.12) continue; // 空地/广场
            const w = RR(5.5, 9), d = RR(5.5, 9);
            const t = R();
            const h = t < 0.65 ? RR(12, 30) : (t < 0.92 ? RR(30, 55) : RR(55, 92));
            const x = gx + RR(-1, 1), z = gz + RR(-1, 1);
            buildings.push({ x, z, w, d, h });

            // 暗色体块:5 个面(跳过底面),每栋轻微色相/明度变化,顶面最亮、背面最暗
            const tone = RR(0.85, 1.75);
            const r0 = 0.055 * tone, g0 = 0.06 * tone, b0 = 0.085 * tone;
            const hw = w / 2, hd = d / 2;
            const faces = [
                // [中心偏移, u, v, 法线, 阴影系数] —— 绕序保证 cross(u,v) 指向法线方向(正面朝观察侧)
                [[0, h / 2, hd], [hw, 0, 0], [0, h / 2, 0], [0, 0, 1], 1.25],   // 前(+Z,朝相机)
                [[0, h / 2, -hd], [0, h / 2, 0], [hw, 0, 0], [0, 0, -1], 0.5],  // 后
                [[hw, h / 2, 0], [0, h / 2, 0], [0, 0, hd], [1, 0, 0], 0.75],   // 右
                [[-hw, h / 2, 0], [0, 0, hd], [0, h / 2, 0], [-1, 0, 0], 0.65], // 左
                [[0, h, 0], [0, 0, hd], [hw, 0, 0], [0, 1, 0], 1.15],           // 顶
            ];
            for (const [off, u, v, n, sh] of faces) {
                pushQuad(bPos, bNrm, bCol, bIdx, [x + off[0], off[1], z + off[2]],
                    u[0], u[1], u[2], v[0], v[1], v[2],
                    n[0], n[1], n[2], r0, g0, b0, sh);
            }
        }
    }
}

/* ============================ 发光窗阵(静态 unlit 网格,矩阵排布 + 随机点亮) ============================ */
const WINDOW_WARM = [[1.0, 0.68, 0.32], [1.0, 0.8, 0.5], [0.95, 0.85, 0.62]];
const WINDOW_COOL = [[0.5, 0.72, 1.0], [0.62, 0.85, 1.0], [0.75, 0.9, 1.0]];
let windowCount = 0;
{
    for (const b of buildings) {
        const cols = Math.max(2, Math.floor(b.w / 1.35));
        const rows = Math.max(2, Math.floor(b.h / 2.7));
        const fz = b.z + b.d / 2 + 0.08;
        const cw = (b.w - 1.2) / cols, ch = (b.h - 4) / rows;
        let lit = 0;
        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const on = R() < 0.55;
                const isLit = on || (cy * cols + cx < 8); // 每栋保底 8 个窗点
                if (!isLit) continue;
                lit++;
                const pal = R() < 0.6 ? WINDOW_WARM : WINDOW_COOL;
                const c = pal[(R() * pal.length) | 0];
                const bright = RR(0.4, 1.2);
                const wx = b.x - b.w / 2 + 0.6 + (cx + 0.5) * cw;
                const wy = 2.6 + (cy + 0.5) * ch;
                quadZ(wPos, wCol, wIdx, wx, wy, fz, Math.min(0.7, cw * 0.46), Math.min(1.15, ch * 0.46),
                    c[0], c[1], c[2], bright);
            }
        }
        windowCount += lit;
    }
}

/* ============================ 动态网格:车流 + 雨 + 霓虹 + 楼顶警示灯 ============================ */
// 布局:车(72×3 quad) | 雨(2200 quad) | 霓虹 | 警示灯
const CAR_QUADS = N_CARS * 3;
const NEON_MAX = 56, BEACON_MAX = 12;
const Q_TOTAL = CAR_QUADS + N_RAIN + NEON_MAX + BEACON_MAX;
const V_TOTAL = Q_TOTAL * 4, I_TOTAL = Q_TOTAL * 6;
const dynPos = new Float32Array(V_TOTAL * 3);
const dynCol = new Float32Array(V_TOTAL * 4);
const dynIdx = new Uint16Array(I_TOTAL);
for (let q = 0; q < Q_TOTAL; q++) {
    const b = q * 4, o = q * 6;
    dynIdx[o] = b; dynIdx[o + 1] = b + 1; dynIdx[o + 2] = b + 2;
    dynIdx[o + 3] = b; dynIdx[o + 4] = b + 2; dynIdx[o + 5] = b + 3;
}
let quadCursor = 0;
const nextQuad = () => quadCursor++ * 4;

// --- 车流 ---
const carX = new Float32Array(N_CARS), carZ = new Float32Array(N_CARS),
    carDir = new Float32Array(N_CARS), carSpd = new Float32Array(N_CARS),
    carBodyV = new Int32Array(N_CARS), carHeadV = new Int32Array(N_CARS), carTailV = new Int32Array(N_CARS),
    carInitX = new Float32Array(N_CARS);
{
    const lanes = [];
    for (const rz of X_ROADS) { lanes.push([rz - 1.8, -1], [rz + 1.8, 1]); } // 每路双向两车道
    for (let i = 0; i < N_CARS; i++) {
        const lane = lanes[i % lanes.length];
        carZ[i] = lane[0]; carDir[i] = lane[1];
        carX[i] = RR(-CAR_X_SPAN, CAR_X_SPAN); carInitX[i] = carX[i];
        carSpd[i] = RR(9, 22);
        carBodyV[i] = nextQuad(); carHeadV[i] = nextQuad(); carTailV[i] = nextQuad();
    }
}

// --- 雨 ---
const rainX = new Float32Array(N_RAIN), rainY = new Float32Array(N_RAIN),
    rainZ = new Float32Array(N_RAIN), rainSpd = new Float32Array(N_RAIN),
    rainV = new Int32Array(N_RAIN), rainInitY = new Float32Array(N_RAIN);
for (let i = 0; i < N_RAIN; i++) {
    rainX[i] = RR(-150, 150); rainY[i] = RR(0, 100); rainZ[i] = RR(-110, 66);
    rainSpd[i] = RR(42, 68); rainV[i] = nextQuad(); rainInitY[i] = rainY[i];
}

// --- 霓虹(灯带/招牌/广告牌,呼吸与闪烁)+ 楼顶警示灯 ---
const NEON = []; // { v, r, g, b, mode:0呼吸/1爆闪/2常亮, phase, speed }
{
    const PALETTE = [
        [1.0, 0.05, 0.45],  // 品红
        [0.05, 0.85, 1.0],  // 青
        [1.0, 0.4, 0.05],   // 橙黄
        [0.45, 1.0, 0.15],  // 荧光绿
        [1.0, 0.18, 0.55],  // 粉
    ];
    const pool = buildings.filter((b) => b.h >= 24);
    const frontPool = buildings.filter((b) => b.z >= -55 && b.h >= 14); // 前排楼:招牌保证可见
    const pick = () => pool[(R() * pool.length) | 0];
    const pickFront = () => frontPool[(R() * frontPool.length) | 0];
    // 竖向边缘灯带 ×20
    for (let i = 0; i < 20; i++) {
        const b = pick(), c = PALETTE[i % PALETTE.length];
        const hh = RR(10, Math.min(42, b.h * 0.9));
        NEON.push({
            v: nextQuad(), r: c[0], g: c[1], b: c[2],
            mode: i % 3, phase: RR(0, 6.28), speed: RR(0.8, 2.2),
            x: b.x - b.w / 2 - 0.18, y: 2 + hh / 2, z: b.z + b.d / 2 + 0.18,
            hw: 0.42, hh: hh / 2,
        });
    }
    // 立面招牌横幅 ×18(偏前排,避免纵深遮挡)
    for (let i = 0; i < 18; i++) {
        const b = i % 3 === 0 ? pick() : pickFront(), c = PALETTE[(i + 2) % PALETTE.length];
        const ww = b.w * RR(0.55, 0.9);
        NEON.push({
            v: nextQuad(), r: c[0], g: c[1], b: c[2],
            mode: (i + 1) % 3, phase: RR(0, 6.28), speed: RR(1.0, 2.6),
            x: b.x, y: RR(5, Math.max(6, Math.min(17, b.h - 4))), z: b.z + b.d / 2 + 0.16,
            hw: ww / 2, hh: RR(0.65, 1.15),
        });
    }
    // 楼顶广告牌 ×5(高塔)
    const towers = buildings.filter((b) => b.h >= 55).sort((a, b2) => b2.h - a.h);
    for (let i = 0; i < Math.min(5, towers.length); i++) {
        const b = towers[i], c = PALETTE[(i + 4) % PALETTE.length];
        const ww = RR(9, 13), hh = RR(3.6, 5.2);
        NEON.push({
            v: nextQuad(), r: c[0], g: c[1], b: c[2],
            mode: i % 2, phase: RR(0, 6.28), speed: RR(0.7, 1.6),
            x: b.x, y: b.h + hh / 2 + 1.2, z: b.z + b.d / 2 + 0.2,
            hw: ww / 2, hh: hh / 2,
        });
    }
    // 楼顶航空警示灯 ×8(最高塔,红色爆闪)
    for (let i = 0; i < Math.min(8, towers.length); i++) {
        const b = towers[i];
        NEON.push({
            v: nextQuad(), r: 1.6, g: 0.09, b: 0.07,
            mode: 1, phase: i * 0.8, speed: 2.4,
            x: b.x, y: b.h + 0.8, z: b.z,
            hw: 0.42, hh: 0.42,
        });
    }
}
// 预留 quad 未用尽:零面积退化三角形,不产生像素(实际霓虹+警示灯 51 ≤ 预留 68)

// 霓虹 quad 位置一次性写入(静态几何),颜色每帧按相位更新
function writeQuadPos(v, cx, cy, cz, hw, hh) {
    const o = v * 3;
    dynPos[o] = cx - hw; dynPos[o + 1] = cy - hh; dynPos[o + 2] = cz;
    dynPos[o + 3] = cx + hw; dynPos[o + 4] = cy - hh; dynPos[o + 5] = cz;
    dynPos[o + 6] = cx + hw; dynPos[o + 7] = cy + hh; dynPos[o + 8] = cz;
    dynPos[o + 9] = cx - hw; dynPos[o + 10] = cy + hh; dynPos[o + 11] = cz;
}
for (const n of NEON) writeQuadPos(n.v, n.x, n.y, n.z, n.hw, n.hh);

/* ============================ 页面契约状态 ============================ */
const state = {
    buildingCount: buildings.length,
    carCount: N_CARS,
    rainParticleCount: N_RAIN,
    fogEnabled: true,
    fps: 0,
    resetCount: 0,
};
window.__appReady = false;

const frameTimes = [];
let simTime = 0;
let sceneRef = null;

function applyFog(on) {
    state.fogEnabled = on;
    const fog = sceneRef && sceneRef.globals && sceneRef.globals.fog;
    if (!fog) return;
    fog.enabled = on; // setter 内部触发管线宏更新(CC_USE_FOG)
    if (on) {
        fog.type = 2; // FogType.EXP_SQUARED
        fog.fogColor = new Color(13, 17, 42, 255); // 与夜空协调的深蓝(略亮,远处楼群衰减入雾色)
        fog.fogStart = 55;
        fog.fogDensity = 0.0026;
        fog.fogAtten = 1.0;
    }
}

function doReset() {
    simTime = 0;
    state.resetCount += 1;
    for (let i = 0; i < N_CARS; i++) carX[i] = carInitX[i];
    for (let i = 0; i < N_RAIN; i++) rainY[i] = rainInitY[i];
    applyFog(true); // 恢复初始:雾开
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        buildingCount: state.buildingCount,
        carCount: state.carCount,
        rainParticleCount: state.rainParticleCount,
        fogEnabled: state.fogEnabled,
        fps: Math.round(state.fps * 10) / 10,
        resetCount: state.resetCount,
    }),
    reset: doReset,
    debug: {
        // 自检用:在渲染帧内抓取归一化区域 → 128×72 亮度网格 + 均值
        grab(x, y, w, h) {
            return new Promise((resolve, reject) => {
                pendingGrabs.push({ x, y, w, h, resolve, reject });
            });
        },
    },
};

/* ============================ UI 控件(data-ui + data-bench 双属性) ============================ */
function makeButton(label, name, top) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('data-ui', name);
    btn.setAttribute('data-bench', name);
    btn.style.cssText =
        `position:fixed;top:${top}px;right:8px;z-index:9999;padding:5px 14px;` +
        'font:12px/1.4 sans-serif;background:rgba(20,24,40,0.85);color:#cfd8ff;' +
        'border:1px solid #3a4a80;border-radius:4px;cursor:pointer;transition:background 0.15s;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(50,60,100,0.95)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,24,40,0.85)'; });
    btn.addEventListener('mousedown', () => { btn.style.background = 'rgba(90,110,180,1)'; });
    btn.addEventListener('mouseup', () => { btn.style.background = 'rgba(50,60,100,0.95)'; });
    document.body.appendChild(btn);
    return btn;
}
makeButton('Fog: On/Off', 'toggle-fog', 8).addEventListener('click', () => applyFog(!state.fogEnabled));
makeButton('Reset', 'reset', 42).addEventListener('click', () => doReset());

/* ============================ 帧内区域抓取(自检探针用) ============================ */
const grabCanvas = document.createElement('canvas');
grabCanvas.width = 128; grabCanvas.height = 72;
const grabCtx = grabCanvas.getContext('2d', { willReadFrequently: true });
const pendingGrabs = [];
let glCanvas = null;
function processGrabs() {
    while (pendingGrabs.length) {
        const g = pendingGrabs.shift();
        try {
            const cw = glCanvas.width, ch = glCanvas.height;
            grabCtx.drawImage(glCanvas, g.x * cw, g.y * ch, g.w * cw, g.h * ch, 0, 0, 128, 72);
            const d = grabCtx.getImageData(0, 0, 128, 72).data;
            const px = new Array(128 * 72);
            let mr = 0, mg = 0, mb = 0;
            for (let i = 0; i < 9216; i++) {
                const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
                px[i] = (r * 0.299 + gg * 0.587 + b * 0.114) | 0;
                mr += r; mg += gg; mb += b;
            }
            g.resolve({ px, mean: [(mr / 9216) | 0, (mg / 9216) | 0, (mb / 9216) | 0] });
        } catch (e) {
            g.reject(e);
        }
    }
}

/* ============================ 动态网格每帧更新 ============================ */
function writeDynQuads() {
    // 车身(暗色块)+ 头灯(白黄)+ 尾灯(红),竖 quad 面朝相机
    for (let i = 0; i < N_CARS; i++) {
        const x = carX[i], z = carZ[i], dir = carDir[i];
        writeQuad(carBodyV[i], x, 0.55, z, 0.75, 0.32, 0.38, 0.35, 0.3);
        writeQuad(carHeadV[i], x + dir * 1.05, 0.5, z, 0.34, 0.28, 1.5, 1.42, 1.1);
        writeQuad(carTailV[i], x - dir * 1.1, 0.48, z, 0.3, 0.24, 1.55, 0.1, 0.09);
    }
    // 雨丝(细长竖 quad,带风偏)
    for (let i = 0; i < N_RAIN; i++) {
        const v = rainV[i], x = rainX[i], y = rainY[i], z = rainZ[i];
        const o = v * 3, c = v * 4;
        const hw = 0.07, hh = 0.75; // 半尺寸(总高 1.5)
        const tilt = -0.12;
        dynPos[o] = x - hw + tilt * hh; dynPos[o + 1] = y + hh; dynPos[o + 2] = z;
        dynPos[o + 3] = x + hw + tilt * hh; dynPos[o + 4] = y + hh; dynPos[o + 5] = z;
        dynPos[o + 6] = x + hw; dynPos[o + 7] = y - hh; dynPos[o + 8] = z;
        dynPos[o + 9] = x - hw; dynPos[o + 10] = y - hh; dynPos[o + 11] = z;
        const a = 0.66; // 淡蓝白
        dynCol[c] = a * 0.72; dynCol[c + 1] = a * 0.82; dynCol[c + 2] = a; dynCol[c + 3] = 1;
        dynCol[c + 4] = a * 0.72; dynCol[c + 5] = a * 0.82; dynCol[c + 6] = a; dynCol[c + 7] = 1;
        dynCol[c + 8] = a * 0.55; dynCol[c + 9] = a * 0.65; dynCol[c + 10] = a * 0.85; dynCol[c + 11] = 1;
        dynCol[c + 12] = a * 0.55; dynCol[c + 13] = a * 0.65; dynCol[c + 14] = a * 0.85; dynCol[c + 15] = 1;
    }
    // 霓虹:呼吸/爆闪/常亮
    for (const n of NEON) {
        let it;
        if (n.mode === 0) it = 0.8 + 0.45 * Math.sin(simTime * n.speed + n.phase);
        else if (n.mode === 1) it = Math.sin(simTime * n.speed + n.phase) > 0.45 ? 1.45 : 0.15;
        else it = 1.0;
        writeQuadColor(n.v, n.r * it, n.g * it, n.b * it);
    }
}

function writeQuad(v, cx, cy, cz, hw, hh, r, g, b) {
    const o = v * 3, c = v * 4;
    dynPos[o] = cx - hw; dynPos[o + 1] = cy - hh; dynPos[o + 2] = cz;
    dynPos[o + 3] = cx + hw; dynPos[o + 4] = cy - hh; dynPos[o + 5] = cz;
    dynPos[o + 6] = cx + hw; dynPos[o + 7] = cy + hh; dynPos[o + 8] = cz;
    dynPos[o + 9] = cx - hw; dynPos[o + 10] = cy + hh; dynPos[o + 11] = cz;
    dynCol[c] = r; dynCol[c + 1] = g; dynCol[c + 2] = b; dynCol[c + 3] = 1;
    dynCol[c + 4] = r; dynCol[c + 5] = g; dynCol[c + 6] = b; dynCol[c + 7] = 1;
    dynCol[c + 8] = r; dynCol[c + 9] = g; dynCol[c + 10] = b; dynCol[c + 11] = 1;
    dynCol[c + 12] = r; dynCol[c + 13] = g; dynCol[c + 14] = b; dynCol[c + 15] = 1;
}

function writeQuadColor(v, r, g, b) {
    const c = v * 4;
    for (let k = 0; k < 4; k++) {
        dynCol[c + k * 4] = r; dynCol[c + k * 4 + 1] = g; dynCol[c + k * 4 + 2] = b; dynCol[c + k * 4 + 3] = 1;
    }
}

/** 每帧行为组件:车流推进、雨循环、霓虹相位,动态网格单次提交。 */
class CityAnimator extends Component {
    update(dt) {
        const step = Math.min(dt, 0.1);
        simTime += step;
        for (let i = 0; i < N_CARS; i++) {
            carX[i] += carDir[i] * carSpd[i] * step;
            if (carX[i] > CAR_X_SPAN) carX[i] = -CAR_X_SPAN;
            else if (carX[i] < -CAR_X_SPAN) carX[i] = CAR_X_SPAN;
        }
        for (let i = 0; i < N_RAIN; i++) {
            rainY[i] -= rainSpd[i] * step;
            rainX[i] -= 5.5 * step; // 风偏
            if (rainX[i] < -150) rainX[i] += 300;
            if (rainY[i] < -2) rainY[i] += 102; // 落地即重生顶部,无粒子泄漏
        }
        writeDynQuads();
        if (this.dynMesh) {
            this.dynMesh.updateSubMesh(0, {
                positions: dynPos,
                colors: dynCol,
                indices16: dynIdx,
                minPos: { x: -160, y: -2, z: -180 },
                maxPos: { x: 160, y: 100, z: 70 },
            });
        }
    }
}

/* ============================ 材质 ============================ */
function makeUnlitVC() {
    const m = new Material();
    m.initialize({ effectName: 'builtin-unlit', defines: { USE_VERTEX_COLOR: true } });
    return m;
}
function makeStandardVC() {
    const m = new Material();
    m.initialize({ effectName: 'builtin-standard', defines: { USE_VERTEX_COLOR: true } });
    return m;
}

/* ============================ 启动 ============================ */
try {
    const canvas = document.querySelector('#GameCanvas');
    glCanvas = canvas;
    const app = await createAirApp({ canvas });

    const scene = new Scene('neon-city');
    sceneRef = scene;

    // 相机:低角度仰视天际线(画面下 1/3 街道层,上 2/3 楼群+夜空)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 12, 75));
    cameraNode.lookAt(new Vec3(0, 22, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 50;
    camera.near = 0.5;
    camera.far = 900;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(5, 7, 18, 255); // 近黑夜空
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 月光方向光(冷色夜光,量级同模板 HDR 口径)
    const lightNode = new Node('Moon Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 60, 10));
    lightNode.setRotationFromEuler(-52, -25, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 12000;

    // 雾(运行前启用,避免首帧无雾闪帧)
    applyFog(true);

    // 楼群+地面:静态 standard 网格(单次绘制)
    const cityNode = new Node('CityBlocks');
    cityNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(cityNode);
    const cityMr = cityNode.addComponent(MeshRenderer);
    cityMr.mesh = utils.createMesh({
        positions: bPos, normals: bNrm, colors: bCol, indices: bIdx,
        minPos: { x: -420, y: -1, z: -425 },
        maxPos: { x: 420, y: 95, z: 62 },
    });
    cityMr.material = makeStandardVC();

    // 窗阵:静态 unlit 网格(单次绘制,引擎雾自动衰减远处窗光)
    const winNode = new Node('Windows');
    winNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(winNode);
    const winMr = winNode.addComponent(MeshRenderer);
    winMr.mesh = utils.createMesh({
        positions: wPos, colors: wCol, indices: wIdx,
        minPos: { x: -150, y: 1, z: -160 },
        maxPos: { x: 150, y: 95, z: 12 },
    });
    winMr.material = makeUnlitVC();

    // 车/雨/霓虹:动态 unlit 网格(每帧单次 updateSubMesh)
    const dynNode = new Node('TrafficRainNeon');
    dynNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(dynNode);
    const dynMr = dynNode.addComponent(MeshRenderer);
    const dynGeom = {
        positions: dynPos, colors: dynCol, indices16: dynIdx, primitiveMode: 0, // TRIANGLE_LIST
    };
    dynMr.mesh = utils.MeshUtils.createDynamicMesh(0, dynGeom, null, {
        maxSubMeshes: 1,
        maxSubMeshVertices: V_TOTAL,
        maxSubMeshIndices: I_TOTAL,
    });
    dynMr.material = makeUnlitVC();
    const animator = dynNode.addComponent(CityAnimator);
    animator.dynMesh = dynMr.mesh;

    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 后经 scene.globals 配置(引擎已验证路径,同模板)
    scene.globals.ambient.skyColorHDR.set(0.3, 0.42, 0.7, 1.0);
    scene.globals.ambient.skyIllum = 10000;

    // 帧计数 + fps 滚动窗口 + 首帧就绪 + 帧内抓取
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        if (frameTimes.length > 61) frameTimes.splice(0, frameTimes.length - 61);
        if (frameTimes.length > 6) {
            const avg = (now - frameTimes[0]) / (frameTimes.length - 1);
            state.fps = avg > 0 ? 1000 / avg : 0;
        }
        if (!window.__appReady) window.__appReady = true;
        if (pendingGrabs.length) processGrabs();
    });

    console.log('[e07] neon city running:', state.buildingCount, 'buildings,',
        windowCount, 'windows,', N_CARS, 'cars,', N_RAIN, 'rain particles');
} catch (err) {
    console.error('[e07] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
