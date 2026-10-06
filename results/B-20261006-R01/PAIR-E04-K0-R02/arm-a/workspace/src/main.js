/**
 * E04 — 城市烟花夜(City Fireworks Night)— cocosair 实现
 *
 * 场景构成(全部程序化生成,无外部资产):
 *   - 夜空:大四边形顶点色垂直渐变(顶部近黑 → 地平线蓝紫),>=140 颗静态星点;
 *   - 地平线辉光:加色混合的水平渐变条;
 *   - 城市剪影:固定 30 栋程序化楼(暗色矩形)+ >=80 扇暖色亮窗 + 少数楼顶红色障碍灯(动态闪烁);
 *   - 烟花:点击夜空发射(引擎 input.on),火箭 kinematic 上升拖尾迹,
 *     爆炸成 140-220 球面粒子(重力+阻力),外加每发 20 个长寿命余烬(3-12s,分层,闪烁下坠);
 *   - 粒子全部经 WebGL 管线绘制:单张动态网格(每粒子一四边形)+ 程序化径向渐变贴图
 *     + 加色混合近似辉光(引擎无后处理 Bloom);
 *   - 状态:fireworkCount / particlesAlive / autoShow / enabled / buildingCount 经 window.__bench 暴露;
 *   - 暂停 = 场景时间线冻结(update 跳过,时间增量 0);reset = 清空粒子+重建城市。
 *
 * 已知引擎坑位规避(K0 实测清单):
 *   - 鼠标事件走引擎 input.on(canvas 直挂监听会被 pal 层吞);
 *   - Camera.visibility 显式设 Layers.Enum.DEFAULT;
 *   - 无 InstancedMesh/Points → utils.MeshUtils.createDynamicMesh + updateSubMesh 每帧重写四边形;
 *   - 自定义材质 new Material() + initialize({effectAsset});贴图用离屏 canvas 程序化生成。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    Texture2D,
    ImageAsset,
    EffectAsset,
    builtinResMgr,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
    input,
    Input,
    screen,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 全局世界参数(正交相机,世界高度 1000 单位,y ∈ [0,1000] 对应画面自下而上)
// ---------------------------------------------------------------------------
const WORLD_H = 1000;
const CAM_Y = 500;
const CAM_Z = 10;
const ORTHO_HALF = 500;          // 正交半高 → 视口高 1000 世界单位
const HORIZON_Y = 300;           // 城市带顶部参考线(画面下方 30%)
const CITY_SPAN_HALF = 1250;     // 楼群生成横跨范围(覆盖超宽屏)
const BUILDING_COUNT = 30;       // 楼数固定(reset 重建时数量不变)

const state = {
    fireworkCount: 0,
    alive: 0,            // particlesAlive(每帧实时)
    autoShow: false,
    enabled: true,
    buildingCount: 0,
    time: 0,             // 场景时间(enabled=false 时不推进)
    nextAutoAt: 0,
    uiToggles: { auto: false, paused: false },
};

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

// 烟花配色(每发一主色系)
const PALETTE = [
    [1.00, 0.82, 0.35], // 金
    [1.00, 0.35, 0.72], // 洋红
    [0.35, 0.90, 1.00], // 青
    [0.50, 1.00, 0.45], // 绿
    [0.75, 0.45, 1.00], // 紫
    [1.00, 0.60, 0.25], // 橙
    [1.00, 0.42, 0.42], // 红粉
];

// ---------------------------------------------------------------------------
// 几何构建工具:quad 累加器 → IGeometry
// ---------------------------------------------------------------------------
function makeAccumulator(capQuads) {
    return {
        n: 0,
        positions: new Float32Array(capQuads * 4 * 3),
        normals: new Float32Array(capQuads * 4 * 3),
        uvs: new Float32Array(capQuads * 4 * 2),
        colors: new Float32Array(capQuads * 4 * 4),
        indices16: new Uint16Array(capQuads * 6),
    };
}

/** 推入一个轴对齐四边形(屏幕空间,x/y 中心,z 深度,hw/hh 半宽高) */
function pushQuad(acc, cx, cy, z, hw, hh, r, g, b, a) {
    const q = acc.n;
    if (q * 4 + 3 >= acc.positions.length / 3) return; // 容量保护
    const p = q * 12, u = q * 8, c = q * 16, ii = q * 6;
    const P = acc.positions, N = acc.normals, U = acc.uvs, C = acc.colors, I = acc.indices16;
    // 顶点顺序:左下、右下、右上、左上
    P[p] = cx - hw; P[p + 1] = cy - hh; P[p + 2] = z;
    P[p + 3] = cx + hw; P[p + 4] = cy - hh; P[p + 5] = z;
    P[p + 6] = cx + hw; P[p + 7] = cy + hh; P[p + 8] = z;
    P[p + 9] = cx - hw; P[p + 10] = cy + hh; P[p + 11] = z;
    for (let k = 0; k < 4; k++) { N[p + k * 3] = 0; N[p + k * 3 + 1] = 0; N[p + k * 3 + 2] = 1; }
    U[u] = 0; U[u + 1] = 0; U[u + 2] = 1; U[u + 3] = 0;
    U[u + 4] = 1; U[u + 5] = 1; U[u + 6] = 0; U[u + 7] = 1;
    for (let k = 0; k < 4; k++) {
        C[c + k * 4] = r; C[c + k * 4 + 1] = g; C[c + k * 4 + 2] = b; C[c + k * 4 + 3] = a;
    }
    const v0 = q * 4;
    I[ii] = v0; I[ii + 1] = v0 + 1; I[ii + 2] = v0 + 2;
    I[ii + 3] = v0; I[ii + 4] = v0 + 2; I[ii + 5] = v0 + 3;
    acc.n = q + 1;
}

/** 顶部/底部颜色不同的渐变大四边形(顶点色插值) */
function pushGradientQuad(acc, x0, x1, y0, y1, z, bottom, top) {
    const q = acc.n;
    const p = q * 12, u = q * 8, c = q * 16, ii = q * 6;
    const P = acc.positions, N = acc.normals, U = acc.uvs, C = acc.colors, I = acc.indices16;
    P[p] = x0; P[p + 1] = y0; P[p + 2] = z;
    P[p + 3] = x1; P[p + 4] = y0; P[p + 5] = z;
    P[p + 6] = x1; P[p + 7] = y1; P[p + 8] = z;
    P[p + 9] = x0; P[p + 10] = y1; P[p + 11] = z;
    for (let k = 0; k < 4; k++) { N[p + k * 3] = 0; N[p + k * 3 + 1] = 0; N[p + k * 3 + 2] = 1; }
    U[u] = 0; U[u + 1] = 0; U[u + 2] = 1; U[u + 3] = 0;
    U[u + 4] = 1; U[u + 5] = 1; U[u + 6] = 0; U[u + 7] = 1;
    // 左下、右下 = bottom;右上、左上 = top
    C[c] = bottom[0]; C[c + 1] = bottom[1]; C[c + 2] = bottom[2]; C[c + 3] = bottom[3];
    C[c + 4] = bottom[0]; C[c + 5] = bottom[1]; C[c + 6] = bottom[2]; C[c + 7] = bottom[3];
    C[c + 8] = top[0]; C[c + 9] = top[1]; C[c + 10] = top[2]; C[c + 11] = top[3];
    C[c + 12] = top[0]; C[c + 13] = top[1]; C[c + 14] = top[2]; C[c + 15] = top[3];
    const v0 = q * 4;
    I[ii] = v0; I[ii + 1] = v0 + 1; I[ii + 2] = v0 + 2;
    I[ii + 3] = v0; I[ii + 4] = v0 + 2; I[ii + 5] = v0 + 3;
    acc.n = q + 1;
}

/** 逐顶点四边形(用于地平线辉光的 alpha 渐变) */
function pushQuadV4(acc, x0, x1, y0, y1, z, c0, c1, c2, c3) {
    const q = acc.n;
    const p = q * 12, u = q * 8, c = q * 16, ii = q * 6;
    const P = acc.positions, N = acc.normals, U = acc.uvs, C = acc.colors, I = acc.indices16;
    P[p] = x0; P[p + 1] = y0; P[p + 2] = z;
    P[p + 3] = x1; P[p + 4] = y0; P[p + 5] = z;
    P[p + 6] = x1; P[p + 7] = y1; P[p + 8] = z;
    P[p + 9] = x0; P[p + 10] = y1; P[p + 11] = z;
    for (let k = 0; k < 4; k++) { N[p + k * 3] = 0; N[p + k * 3 + 1] = 0; N[p + k * 3 + 2] = 1; }
    U[u] = 0; U[u + 1] = 0; U[u + 2] = 1; U[u + 3] = 0;
    U[u + 4] = 1; U[u + 5] = 1; U[u + 6] = 0; U[u + 7] = 1;
    C[c] = c0[0]; C[c + 1] = c0[1]; C[c + 2] = c0[2]; C[c + 3] = c0[3];
    C[c + 4] = c1[0]; C[c + 5] = c1[1]; C[c + 6] = c1[2]; C[c + 7] = c1[3];
    C[c + 8] = c2[0]; C[c + 9] = c2[1]; C[c + 10] = c2[2]; C[c + 11] = c2[3];
    C[c + 12] = c3[0]; C[c + 13] = c3[1]; C[c + 14] = c3[2]; C[c + 15] = c3[3];
    const v0 = q * 4;
    I[ii] = v0; I[ii + 1] = v0 + 1; I[ii + 2] = v0 + 2;
    I[ii + 3] = v0; I[ii + 4] = v0 + 2; I[ii + 5] = v0 + 3;
    acc.n = q + 1;
}

function accumToGeometry(acc) {
    // 注意:静态 createMesh 读 geometry.indices(独立缓冲拷贝,防 subarray byteOffset 陷阱);
    // 动态 updateSubMesh 读 geometry.indices16 —— 两套键同时提供。
    const idxCopy = new Uint16Array(acc.n * 6);
    idxCopy.set(acc.indices16.subarray(0, acc.n * 6));
    return {
        positions: acc.positions.subarray(0, acc.n * 12),
        normals: acc.normals.subarray(0, acc.n * 12),
        uvs: acc.uvs.subarray(0, acc.n * 8),
        colors: acc.colors.subarray(0, acc.n * 16),
        indices: idxCopy,
        indices16: idxCopy,
        doubleSided: true,
    };
}

// ---------------------------------------------------------------------------
// 程序化辉光贴图(离屏 canvas 径向渐变 → Texture2D)
// ---------------------------------------------------------------------------
function makeGlowTexture() {
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.07)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new Texture2D();
    tex.image = new ImageAsset(cv);
    try { tex.setFilters(2, 2); } catch (e) { /* 默认过滤即可 */ }
    return tex;
}

// ---------------------------------------------------------------------------
// 材质(builtin-unlit + 顶点色;粒子/辉光加加色混合与无深度)
// ---------------------------------------------------------------------------
function getUnlitEffect() {
    const fx = EffectAsset.get('builtin-unlit');
    if (fx) return fx;
    const m = builtinResMgr.get('builtin-unlit-material');
    if (m && m.effectAsset) return m.effectAsset;
    return 'builtin-unlit';
}

function makeSolidMaterial() {
    const mat = new Material();
    mat.initialize({
        effectAsset: getUnlitEffect(),
        defines: { USE_VERTEX_COLOR: true },
        states: {
            rasterizerState: { cullMode: gfx.CullMode.NONE },
            depthStencilState: { depthTest: true, depthWrite: true },
        },
    });
    return mat;
}

function makeAdditiveMaterial(withTexture) {
    const defines = { USE_VERTEX_COLOR: true };
    if (withTexture) defines.USE_TEXTURE = true;
    const mat = new Material();
    mat.initialize({
        effectAsset: getUnlitEffect(),
        defines,
        states: {
            rasterizerState: { cullMode: gfx.CullMode.NONE },
            depthStencilState: { depthTest: false, depthWrite: false },
            blendState: {
                targets: [{
                    blend: true,
                    blendSrc: gfx.BlendFactor.SRC_ALPHA,
                    blendDst: gfx.BlendFactor.ONE,
                    blendSrcAlpha: gfx.BlendFactor.SRC_ALPHA,
                    blendDstAlpha: gfx.BlendFactor.ONE,
                }],
            },
        },
    });
    return mat;
}

// ---------------------------------------------------------------------------
// 粒子池(SoA)+ 烟花系统
// ---------------------------------------------------------------------------
const MAXQ = 4500;               // 粒子四边形容量(峰值需求 >=1000)
const TYPE_TRAIL = 0, TYPE_BOOM = 1, TYPE_EMBER = 2, TYPE_FLASH = 3;

const P = {
    n: 0,
    x: new Float32Array(MAXQ),
    y: new Float32Array(MAXQ),
    vx: new Float32Array(MAXQ),
    vy: new Float32Array(MAXQ),
    life: new Float32Array(MAXQ),
    maxLife: new Float32Array(MAXQ),
    s0: new Float32Array(MAXQ),   // 初始半宽
    s1: new Float32Array(MAXQ),   // 末态半宽
    r: new Float32Array(MAXQ),
    g: new Float32Array(MAXQ),
    b: new Float32Array(MAXQ),
    a0: new Float32Array(MAXQ),   // 初始 alpha
    type: new Uint8Array(MAXQ),
    phase: new Float32Array(MAXQ), // 闪烁相位
    freq: new Float32Array(MAXQ),  // 闪烁频率
    drag: new Float32Array(MAXQ),
    grav: new Float32Array(MAXQ),
    stretchY: new Float32Array(MAXQ), // 纵向拉伸系数(1=圆形)
};

function spawnParticle(type, x, y, vx, vy, life, s0, s1, r, g, b, a0, drag, grav, flickerFreq, stretchY) {
    if (P.n >= MAXQ) return -1;
    const i = P.n++;
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy;
    P.life[i] = life; P.maxLife[i] = life;
    P.s0[i] = s0; P.s1[i] = s1;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.a0[i] = a0;
    P.type[i] = type;
    P.phase[i] = rand(0, Math.PI * 2);
    P.freq[i] = flickerFreq || 0;
    P.drag[i] = drag; P.grav[i] = grav;
    P.stretchY[i] = stretchY || 1;
    return i;
}

function killParticle(i) {
    const last = --P.n;
    if (i !== last) {
        P.x[i] = P.x[last]; P.y[i] = P.y[last]; P.vx[i] = P.vx[last]; P.vy[i] = P.vy[last];
        P.life[i] = P.life[last]; P.maxLife[i] = P.maxLife[last];
        P.s0[i] = P.s0[last]; P.s1[i] = P.s1[last];
        P.r[i] = P.r[last]; P.g[i] = P.g[last]; P.b[i] = P.b[last]; P.a0[i] = P.a0[last];
        P.type[i] = P.type[last];
        P.phase[i] = P.phase[last]; P.freq[i] = P.freq[last];
        P.drag[i] = P.drag[last]; P.grav[i] = P.grav[last];
        P.stretchY[i] = P.stretchY[last];
    }
}

function updateParticles(dt, now) {
    for (let i = P.n - 1; i >= 0; i--) {
        P.life[i] -= dt;
        if (P.life[i] <= 0) { killParticle(i); continue; }
        const d = Math.max(0, 1 - P.drag[i] * dt);
        P.vx[i] *= d; P.vy[i] *= d;
        P.vy[i] -= P.grav[i] * dt;
        P.x[i] += P.vx[i] * dt;
        P.y[i] += P.vy[i] * dt;
        if (P.y[i] < -40) { killParticle(i); }
    }
}

// 火箭(不在粒子池中;kinematic 上升)
const rockets = [];

function launchFirework(tx, ty, paletteIdx) {
    const aspect = screen.windowSize.width / Math.max(1, screen.windowSize.height);
    const halfW = ORTHO_HALF * aspect;
    const sx = clamp(tx + rand(-40, 40), -halfW * 0.95, halfW * 0.95);
    const sy = 28;
    const dist = Math.max(60, ty - sy);
    const speed = rand(550, 850);
    const riseT = clamp(dist / speed, 0.6, 1.6);
    rockets.push({
        sx, sy, tx, ty, t: 0, riseT,
        hue: paletteIdx === undefined ? randInt(0, PALETTE.length - 1) : paletteIdx,
        trailAcc: 0,
    });
    state.fireworkCount += 1;
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function updateRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.t += dt;
        const k = clamp(r.t / r.riseT, 0, 1);
        const e = easeOutCubic(k);
        const cx = r.sx + (r.tx - r.sx) * e;
        const cy = r.sy + (r.ty - r.sy) * e;
        // 尾迹:暖白/金细亮粒子串(纵向拉伸呈运动拖影)+ 高亮头部
        r.trailAcc += dt;
        while (r.trailAcc > 0.006) {
            r.trailAcc -= 0.006;
            const warm = 0.75 + Math.random() * 0.25;
            spawnParticle(
                TYPE_TRAIL,
                cx + rand(-2.5, 2.5), cy + rand(-5, 2),
                rand(-12, 12) - (r.tx - r.sx) / r.riseT * 0.06, rand(-30, -6),
                rand(0.35, 0.85), rand(2.5, 4.0), 1.0,
                1.0 * warm, 0.92 * warm, 0.62 * warm,
                rand(0.7, 1.0), 1.2, 60, 0,
                rand(6, 11),  // 纵向拉伸(运动拖影)
            );
            // 亮头部
            spawnParticle(
                TYPE_TRAIL,
                cx, cy, 0, 0,
                0.12, rand(7, 10), 6,
                1.0, 0.98, 0.88, 0.95, 0, 0, 0,
                rand(7, 10),
            );
        }
        if (k >= 1) {
            explode(cx, cy, r.hue);
            rockets.splice(i, 1);
        }
    }
}

function explode(x, y, hueIdx) {
    const base = PALETTE[hueIdx % PALETTE.length];
    const n = randInt(140, 220);
    for (let j = 0; j < n; j++) {
        // 球面近似均匀方向(含 z 分量 → 正对相机时投影呈圆形壳层)
        const zz = rand(-1, 1);
        const th = rand(0, Math.PI * 2);
        const rr = Math.sqrt(Math.max(0, 1 - zz * zz));
        const dx = rr * Math.cos(th), dy = rr * Math.sin(th);
        const S = rand(0.55, 1.0) * rand(150, 270);
        const jit = rand(0.85, 1.15);
        const life = rand(1.2, 2.8);
        spawnParticle(
            TYPE_BOOM,
            x, y,
            dx * S, dy * S,
            life, rand(5.5, 9.5), 1.6,
            clamp(base[0] * jit, 0, 1), clamp(base[1] * jit, 0, 1), clamp(base[2] * jit, 0, 1),
            0.95, 1.7, 210, 0,
        );
    }
    // 中心闪光(大而淡)
    for (let f = 0; f < 4; f++) {
        spawnParticle(
            TYPE_FLASH,
            x + rand(-8, 8), y + rand(-8, 8), 0, 0,
            rand(0.22, 0.4), rand(55, 95), rand(70, 110),
            1.0, 0.97, 0.9, rand(0.28, 0.4), 0, 0, 0,
        );
    }
    // 余烬:30 个长寿命(分层 3-12s,长尾 ~30% 铺到 10-12s),偏暖橙、缓降、强闪烁
    const emberN = 30;
    for (let j = 0; j < emberN; j++) {
        let life;
        const roll = j / emberN;
        if (roll < 0.3) life = rand(10, 12);
        else if (roll < 0.5) life = rand(7, 9.5);
        else life = rand(3, 6.5);
        const a = rand(0, Math.PI * 2);
        const sp = rand(10, 46);
        const warmJ = rand(0.88, 1.08);
        spawnParticle(
            TYPE_EMBER,
            x + rand(-16, 16), y + rand(-16, 16),
            Math.cos(a) * sp, Math.sin(a) * sp * 0.6 + rand(-30, 6),
            life, rand(6.5, 10.5), 3.5,
            1.0 * warmJ, 0.62 * warmJ, 0.22 * warmJ,
            rand(0.8, 1.0), 0.9, 48, rand(2.5, 6.0),
            rand(1.4, 2.2),
        );
    }
}

// ---------------------------------------------------------------------------
// 场景节点搭建
// ---------------------------------------------------------------------------
let app = null;
let sceneRef = null;
let particleMesh = null, particleGeo = null, particleRenderer = null;
let glowMesh = null, glowGeo = null, glowRenderer = null;
let cityMesh = null, cityRenderer = null;
let aviation = [];             // { x, y, phase } 楼顶障碍灯
let horizonRenderer = null;
let fwComponent = null;

// 动态网格缓冲(粒子)
const dPos = new Float32Array(MAXQ * 4 * 3);
const dNor = new Float32Array(MAXQ * 4 * 3);
const dUv = new Float32Array(MAXQ * 4 * 2);
const dCol = new Float32Array(MAXQ * 4 * 4);
const dIdx = new Uint16Array(MAXQ * 6);
for (let q = 0; q < MAXQ; q++) {
    const v0 = q * 4, ii = q * 6;
    dIdx[ii] = v0; dIdx[ii + 1] = v0 + 1; dIdx[ii + 2] = v0 + 2;
    dIdx[ii + 3] = v0; dIdx[ii + 4] = v0 + 2; dIdx[ii + 5] = v0 + 3;
}
// 动态网格缓冲(障碍灯/城市微光)
const GLOW_CAP = 64;
const gPos = new Float32Array(GLOW_CAP * 4 * 3);
const gNor = new Float32Array(GLOW_CAP * 4 * 3);
const gUv = new Float32Array(GLOW_CAP * 4 * 2);
const gCol = new Float32Array(GLOW_CAP * 4 * 4);
const gIdx = new Uint16Array(GLOW_CAP * 6);
for (let q = 0; q < GLOW_CAP; q++) {
    const v0 = q * 4, ii = q * 6;
    gIdx[ii] = v0; gIdx[ii + 1] = v0 + 1; gIdx[ii + 2] = v0 + 2;
    gIdx[ii + 3] = v0; gIdx[ii + 4] = v0 + 2; gIdx[ii + 5] = v0 + 3;
}

let lastUploadedQuads = -1;
let lastUploadedGlow = -1;

/** 粒子 → 动态网格上传(空帧上传 1 个退化四边形以清空 draw count) */
function uploadParticles(zBase) {
    const alive = P.n;
    if (alive === 0 && lastUploadedQuads === 0) return;
    const quads = Math.max(1, alive);
    const limit = Math.min(quads, MAXQ);
    for (let i = 0; i < limit; i++) {
        const p = i * 12, u = i * 8, c = i * 16;
        let hw, hh, r, g, b, a;
        if (i < alive) {
            const lt = 1 - P.life[i] / P.maxLife[i]; // 0→1 随寿命
            const s = P.s0[i] + (P.s1[i] - P.s0[i]) * lt;
            hw = s; hh = s * P.stretchY[i];
            let flick = 1;
            if (P.type[i] === TYPE_EMBER) {
                flick = 0.18 + 0.82 * Math.pow(0.5 + 0.5 * Math.sin(state.time * P.freq[i] + P.phase[i]), 2);
            }
            const fade = (P.type[i] === TYPE_FLASH)
                ? P.a0[i] * (1 - lt) * (1 - lt)
                : P.a0[i] * (1 - lt * lt); // 平方淡出
            r = P.r[i]; g = P.g[i]; b = P.b[i];
            a = P.a0[i] === 0 ? 0 : fade * flick;
            const x = P.x[i], y = P.y[i];
            dPos[p] = x - hw; dPos[p + 1] = y - hh; dPos[p + 2] = zBase;
            dPos[p + 3] = x + hw; dPos[p + 4] = y - hh; dPos[p + 5] = zBase;
            dPos[p + 6] = x + hw; dPos[p + 7] = y + hh; dPos[p + 8] = zBase;
            dPos[p + 9] = x - hw; dPos[p + 10] = y + hh; dPos[p + 11] = zBase;
        } else {
            // 退化四边形(清空残留)
            hw = hh = 0; r = g = b = 0; a = 0;
            for (let k = 0; k < 12; k++) dPos[p + k] = 0;
        }
        for (let k = 0; k < 4; k++) { dNor[p + k * 3] = 0; dNor[p + k * 3 + 1] = 0; dNor[p + k * 3 + 2] = 1; }
        dUv[u] = 0; dUv[u + 1] = 0; dUv[u + 2] = 1; dUv[u + 3] = 0;
        dUv[u + 4] = 1; dUv[u + 5] = 1; dUv[u + 6] = 0; dUv[u + 7] = 1;
        for (let k = 0; k < 4; k++) {
            dCol[c + k * 4] = r; dCol[c + k * 4 + 1] = g; dCol[c + k * 4 + 2] = b; dCol[c + k * 4 + 3] = a;
        }
    }
    particleGeo.positions = dPos.subarray(0, limit * 12);
    particleGeo.normals = dNor.subarray(0, limit * 12);
    particleGeo.uvs = dUv.subarray(0, limit * 8);
    particleGeo.colors = dCol.subarray(0, limit * 16);
    particleGeo.indices16 = dIdx.subarray(0, limit * 6);
    particleMesh.updateSubMesh(0, particleGeo);
    lastUploadedQuads = alive;
}

/** 障碍灯闪烁 → 动态辉光网格(红色小四边形) */
function uploadGlow() {
    let q = 0;
    for (const L of aviation) {
        if (q >= GLOW_CAP) break;
        const blink = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(state.time * 1.7 + L.phase), 3);
        const p = q * 12, u = q * 8, c = q * 16;
        const hw = 4.5, hh = 4.5;
        gPos[p] = L.x - hw; gPos[p + 1] = L.y - hh; gPos[p + 2] = L.z;
        gPos[p + 3] = L.x + hw; gPos[p + 4] = L.y - hh; gPos[p + 5] = L.z;
        gPos[p + 6] = L.x + hw; gPos[p + 7] = L.y + hh; gPos[p + 8] = L.z;
        gPos[p + 9] = L.x - hw; gPos[p + 10] = L.y + hh; gPos[p + 11] = L.z;
        for (let k = 0; k < 4; k++) { gNor[p + k * 3] = 0; gNor[p + k * 3 + 1] = 0; gNor[p + k * 3 + 2] = 1; }
        gUv[u] = 0; gUv[u + 1] = 0; gUv[u + 2] = 1; gUv[u + 3] = 0;
        gUv[u + 4] = 1; gUv[u + 5] = 1; gUv[u + 6] = 0; gUv[u + 7] = 1;
        for (let k = 0; k < 4; k++) {
            gCol[c + k * 4] = 1.0; gCol[c + k * 4 + 1] = 0.16; gCol[c + k * 4 + 2] = 0.13; gCol[c + k * 4 + 3] = blink;
        }
        q++;
    }
    if (q === 0 && lastUploadedGlow === 0) return;
    const quads = Math.max(1, q);
    if (q === 0) {
        const p = 0;
        for (let k = 0; k < 12; k++) gPos[p + k] = 0;
        for (let k = 0; k < 4; k++) gCol[k * 4 + 3] = 0;
        glowGeo.positions = gPos.subarray(0, 12);
        glowGeo.normals = gNor.subarray(0, 12);
        glowGeo.uvs = gUv.subarray(0, 8);
        glowGeo.colors = gCol.subarray(0, 16);
        glowGeo.indices16 = gIdx.subarray(0, 6);
    } else {
        glowGeo.positions = gPos.subarray(0, quads * 12);
        glowGeo.normals = gNor.subarray(0, quads * 12);
        glowGeo.uvs = gUv.subarray(0, quads * 8);
        glowGeo.colors = gCol.subarray(0, quads * 16);
        glowGeo.indices16 = gIdx.subarray(0, quads * 6);
    }
    glowMesh.updateSubMesh(0, glowGeo);
    lastUploadedGlow = q;
}

// ---------------------------------------------------------------------------
// 城市生成(静态网格;reset 时重建)
// ---------------------------------------------------------------------------
function buildCity() {
    const acc = makeAccumulator(2600); // 楼 + 窗 + 天线
    aviation = [];

    // —— 楼群:固定 BUILDING_COUNT 栋,横跨 [-CITY_SPAN_HALF, +CITY_SPAN_HALF]
    const totalW = CITY_SPAN_HALF * 2;
    const slot = totalW / BUILDING_COUNT;
    for (let i = 0; i < BUILDING_COUNT; i++) {
        const w = clamp(rand(0.45, 0.95) * slot, 26, 108);
        const h = 80 + Math.pow(Math.random(), 1.5) * 340; // 80-420,偏低矮
        const cx = -CITY_SPAN_HALF + slot * i + rand(0.15, 0.85) * slot;
        const shade = rand(0.8, 1.6);
        const br = 0.020 * shade, bg = 0.023 * shade, bb = 0.038 * shade;
        pushQuad(acc, cx, h / 2, -20, w / 2, h / 2, br, bg, bb, 1);
        // 少数楼加天线
        if (h > 240 && Math.random() < 0.35) {
            pushQuad(acc, cx + rand(-w * 0.3, w * 0.3), h + 12, -20, 1.6, 12, br, bg, bb, 1);
        }
        // 亮窗:暖黄/暖白小方块
        const cols = Math.max(1, Math.floor(w / 16));
        const rows = Math.max(1, Math.floor((h - 16) / 18));
        for (let cIdx = 0; cIdx < cols; cIdx++) {
            for (let rIdx = 0; rIdx < rows; rIdx++) {
                if (Math.random() > 0.26) continue;
                const wx = cx - w / 2 + (cIdx + 0.5) * (w / cols) + rand(-1.5, 1.5);
                const wy = 10 + (rIdx + 0.5) * ((h - 10) / rows) + rand(-1.5, 1.5);
                const warm = Math.random();
                const wr = 1.0, wg = warm < 0.5 ? 0.80 : 0.90, wb = warm < 0.5 ? 0.38 : 0.68;
                const dim = rand(0.55, 1.0);
                pushQuad(acc, wx, wy, -19, 3.2, 4.6, wr * dim, wg * dim, wb * dim, 1);
            }
        }
        // 少数高楼顶红色障碍灯(动态部分在 glow 网格闪烁;此处放一个常亮基座)
        if (h > 230 && Math.random() < 0.5) {
            aviation.push({ x: cx, y: h + (h > 240 && Math.random() < 0.35 ? 30 : 4), z: -12, phase: rand(0, Math.PI * 2) });
        }
    }

    // —— 地平线辉光在启动时单独构建一次(见 HorizonGlow 分支),不随城市重建
    // —— 重建/替换城市静态网格
    const geo = accumToGeometry(acc);
    const newMesh = utils.MeshUtils.createMesh(geo);
    if (cityMesh) {
        cityRenderer.mesh = newMesh;
        cityMesh.destroy();
    } else {
        cityRenderer.mesh = newMesh;
    }
    cityMesh = newMesh;

    state.buildingCount = BUILDING_COUNT;
}

// ---------------------------------------------------------------------------
// 场景级 Component:统一时间线
// ---------------------------------------------------------------------------
class FireworksTimeline extends Component {
    update(dtRaw) {
        if (!state.enabled) return;           // 暂停 = 冻结(时间增量 0)
        const dt = Math.min(dtRaw, 0.05);     // 失焦回来防时间跳变
        state.time += dt;

        // 自动表演
        if (state.autoShow) {
            if (state.time >= state.nextAutoAt) {
                const aspect = screen.windowSize.width / Math.max(1, screen.windowSize.height);
                const halfW = ORTHO_HALF * aspect;
                launchFirework(rand(-halfW * 0.82, halfW * 0.82), rand(450, 850));
                state.nextAutoAt = state.time + rand(0.5, 0.95);
            }
        }

        updateRockets(dt);
        updateParticles(dt, state.time);
        state.alive = P.n;
        uploadParticles(0);
        uploadGlow();
    }
}

// ---------------------------------------------------------------------------
// UI(DOM,不画进 3D 画面)
// ---------------------------------------------------------------------------
function setupUI() {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;display:flex;flex-direction:column;gap:6px;align-items:flex-end';

    const btnAuto = document.createElement('button');
    const btnPause = document.createElement('button');
    const btnReset = document.createElement('button');
    for (const b of [btnAuto, btnPause, btnReset]) {
        b.style.cssText = 'padding:5px 12px;font:13px/1.4 sans-serif;background:rgba(15,18,30,0.82);' +
            'color:#e8ecff;border:1px solid #5a628a;border-radius:5px;cursor:pointer;text-align:right';
    }
    btnAuto.setAttribute('data-ui', 'auto-show');
    btnPause.setAttribute('data-ui', 'pause');
    btnReset.setAttribute('data-ui', 'reset');

    const refreshLabels = () => {
        btnAuto.textContent = '自动表演:' + (state.autoShow ? '开' : '关');
        btnPause.textContent = (state.enabled ? '运行中 · 暂停' : '已暂停 · 恢复');
        btnReset.textContent = '重置';
    };

    btnAuto.addEventListener('click', () => {
        state.autoShow = !state.autoShow;
        state.uiToggles.auto = state.autoShow;
        if (state.autoShow) state.nextAutoAt = state.time + rand(0.4, 0.8);
        refreshLabels();
    });
    btnPause.addEventListener('click', () => {
        state.enabled = !state.enabled;
        state.uiToggles.paused = !state.enabled;
        refreshLabels();
    });
    btnReset.addEventListener('click', () => { doReset(); refreshLabels(); });

    bar.appendChild(btnAuto); bar.appendChild(btnPause); bar.appendChild(btnReset);
    document.body.appendChild(bar);
    refreshLabels();
}

function doReset() {
    state.fireworkCount = 0;
    state.alive = 0;
    P.n = 0;
    rockets.length = 0;
    state.autoShow = false;
    state.enabled = true;
    state.time = 0;
    state.nextAutoAt = 0;
    state.uiToggles.auto = false;
    state.uiToggles.paused = false;
    lastUploadedQuads = -1; // 强制上传一帧清空粒子绘制
    lastUploadedGlow = -1;
    if (sceneRef && cityRenderer) {
        buildCity();
        uploadParticles(0);
        uploadGlow();
    }
}

// ---------------------------------------------------------------------------
// 输入(引擎 input.on;canvas 直挂监听会被 pal 层吞)
// ---------------------------------------------------------------------------
let flipY = false; // 若实测事件原点约定相反,置 true 翻转(自检用)

function onSkyClick(ev) {
    const loc = ev.getLocation();
    const ws = screen.windowSize;
    const nx = clamp(loc.x / Math.max(1, ws.width), 0, 1);
    const nyBottom = clamp(loc.y / Math.max(1, ws.height), 0, 1); // Creator 约定:左下原点
    const nyTop = flipY ? nyBottom : 1 - nyBottom;                 // 归一化(左上原点)
    // UI 区域过滤(右上角控件带):点 UI 不发射
    if (nx > 0.78 && nyTop < 0.30) return;
    const aspect = ws.width / Math.max(1, ws.height);
    const halfW = ORTHO_HALF * aspect;
    const worldX = (nx - 0.5) * 2 * halfW;
    const worldY = CAM_Y + ((1 - nyTop) - 0.5) * 2 * ORTHO_HALF;
    // 非城市区域才发射(城市带内点击忽略)
    if (worldY < HORIZON_Y + 30) return;
    launchFirework(worldX, worldY);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    app = await createAirApp({ canvas });

    const scene = new Scene('E04-fireworks-night');
    sceneRef = scene;

    // —— 相机(正交,恒定映射:世界高 1000 ↔ 视口)
    const cameraNode = new Node('Main Camera');
    cameraNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, CAM_Y, CAM_Z));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = ORTHO_HALF;
    camera.near = 0.1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(3, 4, 10, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    const matSolid = makeSolidMaterial();
    const matAddTex = makeAdditiveMaterial(true);   // 粒子(带径向辉光贴图)
    const matAddSolid = makeAdditiveMaterial(false); // 地平线辉光/障碍灯
    matAddTex.setProperty('mainTexture', makeGlowTexture());

    const mkNode = (name) => {
        const n = new Node(name);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        return n;
    };

    // —— 夜空(渐变)+ 星点(静态)
    {
        const skyAcc = makeAccumulator(220);
        pushGradientQuad(skyAcc, -2400, 2400, -120, 470, -60,
            [0.075, 0.062, 0.20, 1], [0.030, 0.032, 0.10, 1]);
        pushGradientQuad(skyAcc, -2400, 2400, 470, 1050, -60,
            [0.030, 0.032, 0.10, 1], [0.008, 0.010, 0.038, 1]);
        // >=140 颗背景星(避地平线以下)
        for (let i = 0; i < 150; i++) {
            const sy = rand(330, 1020);
            const sx = rand(-1900, 1900);
            const s = rand(1.2, 2.8) * (Math.random() < 0.12 ? 1.9 : 1.0);
            const br = rand(0.5, 1.0);
            const tint = Math.random() < 0.25 ? [0.75, 0.85, 1.0] : [1.0, 1.0, 0.96];
            pushQuad(skyAcc, sx, sy, -55, s, s, tint[0] * br, tint[1] * br, tint[2] * br, 1);
        }
        const skyNode = mkNode('SkyStars');
        const skyRenderer = skyNode.addComponent(MeshRenderer);
        skyRenderer.mesh = utils.MeshUtils.createMesh(accumToGeometry(skyAcc));
        skyRenderer.material = matSolid;
    }

    // —— 城市剪影(楼+窗;静态网格)
    {
        const cityNode = mkNode('City');
        cityRenderer = cityNode.addComponent(MeshRenderer);
        cityRenderer.material = matSolid;
        buildCity();
    }

    // —— 地平线辉光(静态加色,只构建一次)
    {
        const hzNode = mkNode('HorizonGlow');
        horizonRenderer = hzNode.addComponent(MeshRenderer);
        horizonRenderer.material = matAddSolid;
        const accGlow = makeAccumulator(8);
        const aspectNow = screen.windowSize.width / Math.max(1, screen.windowSize.height);
        const spanHalf = Math.max(CITY_SPAN_HALF, ORTHO_HALF * aspectNow * 1.1);
        pushQuadV4(accGlow, -spanHalf, spanHalf, 240, 296, -30, [0.05, 0.04, 0.14, 0.0], [0.05, 0.04, 0.14, 0.0], [0.30, 0.24, 0.62, 0.34], [0.30, 0.24, 0.62, 0.34]);
        pushQuadV4(accGlow, -spanHalf, spanHalf, 296, 330, -30, [0.30, 0.24, 0.62, 0.34], [0.30, 0.24, 0.62, 0.34], [0.16, 0.13, 0.38, 0.14], [0.16, 0.13, 0.38, 0.14]);
        pushQuadV4(accGlow, -spanHalf, spanHalf, 330, 384, -30, [0.16, 0.13, 0.38, 0.14], [0.16, 0.13, 0.38, 0.14], [0.10, 0.10, 0.30, 0.0], [0.10, 0.10, 0.30, 0.0]);
        horizonRenderer.mesh = utils.MeshUtils.createMesh(accumToGeometry(accGlow));
    }

    // —— 粒子动态网格(尾迹+爆炸+余烬,单 draw call)
    {
        const pNode = mkNode('FireworkParticles');
        particleRenderer = pNode.addComponent(MeshRenderer);
        particleMesh = utils.MeshUtils.createDynamicMesh(0, {
            positions: dPos, normals: dNor, uvs: dUv, colors: dCol, indices16: dIdx, doubleSided: true,
        }, undefined, { maxSubMeshes: 1, maxSubMeshVertices: MAXQ * 4, maxSubMeshIndices: MAXQ * 6 });
        particleGeo = {
            positions: dPos, normals: dNor, uvs: dUv, colors: dCol, indices16: dIdx, doubleSided: true,
        };
        particleRenderer.mesh = particleMesh;
        particleRenderer.material = matAddTex;
    }

    // —— 城市障碍灯动态网格
    {
        const gNode = mkNode('CityGlow');
        glowRenderer = gNode.addComponent(MeshRenderer);
        glowMesh = utils.MeshUtils.createDynamicMesh(0, {
            positions: gPos, normals: gNor, uvs: gUv, colors: gCol, indices16: gIdx, doubleSided: true,
        }, undefined, { maxSubMeshes: 1, maxSubMeshVertices: GLOW_CAP * 4, maxSubMeshIndices: GLOW_CAP * 6 });
        glowGeo = {
            positions: gPos, normals: gNor, uvs: gUv, colors: gCol, indices16: gIdx, doubleSided: true,
        };
        glowRenderer.mesh = glowMesh;
        glowRenderer.material = matAddSolid;
    }

    // —— 时间线组件
    const tlNode = mkNode('Timeline');
    fwComponent = tlNode.addComponent(FireworksTimeline);

    // —— 输入
    input.on(Input.EventType.MOUSE_DOWN, onSkyClick);

    // —— 页面契约
    setupUI();

    window.__airApp = app;
    window.__bench = {
        getState: () => ({
            fireworkCount: state.fireworkCount,
            particlesAlive: state.alive,
            autoShow: state.autoShow === true,
            enabled: state.enabled === true,
            buildingCount: state.buildingCount,
        }),
        reset: () => doReset(),
    };

    app.run(scene);

    // 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) {
            window.__appReady = true;
            uploadParticles(0); // 保证首帧粒子网格 draw count 干净
            uploadGlow();
        }
    });

    console.log('[E04] fireworks night running on cocosair');
} catch (err) {
    console.error('[E04] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
