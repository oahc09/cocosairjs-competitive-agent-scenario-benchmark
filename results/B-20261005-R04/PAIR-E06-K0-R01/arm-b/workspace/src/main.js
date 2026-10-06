/**
 * E06 — 荒野篝火营地(Wilderness Campfire)— cocosair K0 Agent Run
 *
 * 场景构成(全部程序化,无外部资产):
 *   - 低多边形起伏地面(圆盘地形,场心压平)
 *   - 16 棵低多边形树(树干 box + 双层锥体树冠,flat-shading)
 *   - 篝火组:石圈 + 交叉柴堆 + 4 层锥体火苗 + 32 张火苗面片 + 46 颗火星
 *   - 动态火光:PointLight(多频闪烁,真实照明地面/树/石),加一块随闪烁呼吸的地面光斑
 *   - 18 只萤火虫(游走 + 明灭),140 颗星点(批量面片,夜间可见/白天淡出)
 *   - 日夜连续渐变(天空 clearColor / 环境光 / 月光→日光 同步插值)
 *   - 自动环绕相机(可暂停/恢复),reset 一键归位
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后 true。
 *   - window.__bench = { getState, reset }(+ setSampling/getSamples 自检采样器,默认关闭,
 *     不影响正常运行的性能口径)。
 *   - UI:右上角 DOM 按钮,固定 data-ui = day-night / orbit-toggle / reset。
 *
 * 引擎坑位对齐(模板与已知实测经验):
 *   - Camera.visibility 必须显式 = Layers.Enum.DEFAULT;
 *   - Light.color 只传 Color 实例(普通对象 → NaN);
 *   - 环境光 skyColorHDR 原位 set(共享 Vec4 引用),skyIllum 走公开 setter;
 *   - 无 InstancedMesh/Points → 粒子走“每粒子一个 Node + 共享几何/材质”;
 *   - 自定义材质:new Material() + initialize({ effectAsset })(effectName/effectAsset 只读);
 *   - 不读引擎源码/文档(K0 冷启动),未证实 API 全部 try/catch 降级。
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
    Vec3,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';
// 未在模板中验证过的导出名走 namespace 访问(缺失时是 undefined 而不是链接期错误,便于降级)
import * as AIR from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const TREE_COUNT = 16;      // spec >= 12,建议 14-24
const FIREFLY_COUNT = 18;   // spec >= 16
const SPARK_COUNT = 46;     // spec 同屏峰值 >= 40
const FLAME_QUAD_COUNT = 32; // spec 火苗 >= 30 粒子/面片
const STAR_COUNT = 160;

const ORBIT_RATE = 0.22;    // rad/s,spec 0.05-0.4(P4 要求 3s 内 >= 0.15)
const TOD_DURATION = 3.2;   // s,spec 2.5-4s
const PIVOT = { x: 0, y: 0.9, z: 0 };
const CAM_R = 16.5;         // 必须明显大于树环外缘,否则近处树冠糊满画面
const CAM_Y = 8.2;

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(20261006);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}
const deg = (r) => (r * 180) / Math.PI;

// ---------------------------------------------------------------------------
// 几何构建(纯数据,交给 utils.createMesh)
// 低多边形风格采用 flat-shading:非索引三角形 + 面法线,轮廓更“低模”。
// ---------------------------------------------------------------------------

/** 把索引几何转成非索引 + 面法线 */
function buildFlat(pos, idx, uvIn) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vi = 0;
    const pa = new Vec3(); const pb = new Vec3(); const pc = new Vec3();
    const e1 = new Vec3(); const e2 = new Vec3(); const n = new Vec3();
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        pa.set(pos[a], pos[a + 1], pos[a + 2]);
        pb.set(pos[b], pos[b + 1], pos[b + 2]);
        pc.set(pos[c], pos[c + 1], pos[c + 2]);
        Vec3.subtract(e1, pb, pa);
        Vec3.subtract(e2, pc, pa);
        Vec3.cross(n, e1, e2);
        n.normalize();
        for (const p of [pa, pb, pc]) {
            positions.push(p.x, p.y, p.z);
            normals.push(n.x, n.y, n.z);
            if (uvIn) uvs.push(uvIn[idx[i] * 2], uvIn[idx[i] * 2 + 1]);
            else uvs.push(0, 0);
            indices.push(vi, vi + 1, vi + 2);
            vi += 3;
        }
    }
    return { positions, normals, uvs, indices };
}

/** XY 平面矩形面片,朝 +Z(火苗 billboard / 地面光斑旋转后用) */
function quadGeom(size) {
    const s = size / 2;
    return {
        positions: [-s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
    };
}

/** 锥体(低模树冠 / 火苗层),含底盖,flat-shading */
function coneGeom(radius, height, seg) {
    const pos = [];
    const idx = [];
    pos.push(0, height, 0); // apex = 0
    for (let i = 0; i < seg; i++) {
        const th = (i / seg) * TAU;
        pos.push(Math.cos(th) * radius, 0, Math.sin(th) * radius);
    }
    pos.push(0, 0, 0); // base center = seg+1
    for (let i = 0; i < seg; i++) {
        const a = 1 + i;
        const b = 1 + ((i + 1) % seg);
        // 侧面:(apex,b,a) 才是外向 CCW((apex,a,b) 推导出内向法线,会被背面剔除)
        idx.push(0, b, a);
        // 底盖:(center,a,b) 推导出 -Y 朝下,符合意图
        idx.push(seg + 1, a, b);
    }
    return buildFlat(pos, idx);
}

/** 经纬球(萤火虫/火星小亮点;低段数) */
function sphereGeom(radius, ws, hs) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let y = 0; y <= hs; y++) {
        const ty = (y / hs) * Math.PI;
        for (let x = 0; x <= ws; x++) {
            const tx = (x / ws) * TAU;
            const nx = Math.sin(ty) * Math.cos(tx);
            const ny = Math.cos(ty);
            const nz = Math.sin(ty) * Math.sin(tx);
            positions.push(nx * radius, ny * radius, nz * radius);
            normals.push(nx, ny, nz);
            uvs.push(x / ws, y / hs);
        }
    }
    for (let y = 0; y < hs; y++) {
        for (let x = 0; x < ws; x++) {
            const i00 = y * (ws + 1) + x;
            const i01 = i00 + 1;
            const i10 = i00 + (ws + 1);
            const i11 = i10 + 1;
            indices.push(i00, i11, i10);
            indices.push(i00, i01, i11);
        }
    }
    return { positions, normals, uvs, indices };
}

/** 径向圆盘地形,场心压平 + 边缘微抬;平滑法线(flat 法线在点光下会产生棋盘状明暗) */
function terrainH(r, az) {
    // 噪声幅度收敛:幅度大 + 点光近地会产生强明暗交替,这里只保留“起伏”语义
    const flat = smoothstep(2.2, 8.0, r);
    const rim = smoothstep(16, 26, r) * 1.1;
    const n =
        0.45 * Math.sin(r * 0.55 + 1.7) +
        0.35 * Math.sin(az * 3 + r * 0.35) +
        0.25 * Math.sin(az * 5 - r * 0.8 + 2.1);
    return (n * 0.38 + rim) * flat + n * 0.03;
}

function terrainGeom(radius, rings, segs) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const gridIndex = [];
    const P = (r, az) => new Vec3(Math.cos(az) * r, terrainH(r, az), Math.sin(az) * r);
    // 解析式数值法线:两个切向量叉积(朝向已验证为 +Y)
    const pa = new Vec3(), pb = new Vec3(), nn = new Vec3();
    const eps = 0.05;
    function pushVertex(r, az) {
        const p = P(r, az);
        positions.push(p.x, p.y, p.z);
        uvs.push(az / TAU, r / radius);
        Vec3.subtract(pa, P(r + eps, az), P(Math.max(0, r - eps), az));
        Vec3.subtract(pb, P(r, az + eps), P(r, az - eps));
        Vec3.cross(nn, pb, pa);
        nn.normalize();
        normals.push(nn.x, nn.y, nn.z);
        return positions.length / 3 - 1;
    }
    positions.push(0, terrainH(0, 0), 0);
    normals.push(0, 1, 0);
    uvs.push(0, 0);
    for (let j = 1; j <= rings; j++) {
        gridIndex[j] = [];
        const r = (radius * j) / rings;
        for (let s = 0; s < segs; s++) {
            gridIndex[j][s] = pushVertex(r, (s / segs) * TAU);
        }
    }
    for (let s = 0; s < segs; s++) {
        const s2 = (s + 1) % segs;
        indices.push(0, gridIndex[1][s2], gridIndex[1][s]); // 圆心扇面 +Y 朝上
    }
    for (let j = 1; j < rings; j++) {
        for (let s = 0; s < segs; s++) {
            const s2 = (s + 1) % segs;
            const A = gridIndex[j][s];
            const B = gridIndex[j][s2];
            const C = gridIndex[j + 1][s2];
            const D = gridIndex[j + 1][s];
            indices.push(A, C, D); // +Y(已验证)
            indices.push(A, B, C); // +Y((A,C,B) 会内翻被剔除,呈“破洞棋盘”)
        }
    }
    return { positions, normals, uvs, indices };
}

/** 星空:一批切于球壳内侧的静止面片(单 mesh 单 draw call) */
function starFieldGeom(count, shellR) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const d = new Vec3(); const u = new Vec3(); const v = new Vec3(); const tmp = new Vec3();
    for (let i = 0; i < count; i++) {
        // 仰角 3°-35°:相机俯角大,画面内可见天空只有低仰角窄带,星点必须落在带内
        const az = rand() * TAU;
        const el = (3 + rand() * rand() * 32) * (Math.PI / 180);
        Vec3.set(d, Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        Vec3.cross(u, Vec3.UP, d); u.normalize();
        Vec3.cross(v, d, u);
        const s = (0.4 + rand() * 0.6);
        const base = positions.length / 3;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const cu of corners) {
            Vec3.set(tmp,
                d.x * shellR + u.x * cu[0] * s * 0.5 + v.x * cu[1] * s * 0.5,
                d.y * shellR + u.y * cu[0] * s * 0.5 + v.y * cu[1] * s * 0.5,
                d.z * shellR + u.z * cu[0] * s * 0.5 + v.z * cu[1] * s * 0.5);
            positions.push(tmp.x, tmp.y, tmp.z);
            normals.push(-d.x, -d.y, -d.z);
            uvs.push((cu[0] + 1) / 2, (cu[1] + 1) / 2);
        }
        // 面片须朝向原点(法线 -d)→ 索引反向保证正面朝内
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    return { positions, normals, uvs, indices };
}

// ---------------------------------------------------------------------------
// 材质 / 纹理工厂(全部 try/catch 降级,K0 下未证实 API 不至于致命)
// ---------------------------------------------------------------------------

let FX_STD = null;
let FX_UNLIT = null;
let SHARED_STD_MAT = null;

function resolveEffect(effectName, materialName) {
    let fx = null;
    try { fx = builtinResMgr.get(effectName) || null; } catch (e) { fx = null; }
    if (!fx || !fx.techniques) {
        try {
            const m = builtinResMgr.get(materialName);
            fx = (m && m.effectAsset) || null;
        } catch (e) { fx = null; }
    }
    return fx;
}

let matWarned = 0;
function makeMat(fx, technique, defines) {
    const M = AIR.Material;
    if (!M || !fx) return null;
    const attempts = [];
    if (technique != null) {
        attempts.push(defines ? { effectAsset: fx, technique, defines } : { effectAsset: fx, technique });
    }
    if (defines) attempts.push({ effectAsset: fx, defines });
    attempts.push({ effectAsset: fx });
    for (const opt of attempts) {
        try {
            const m = new M();
            m.initialize(opt);
            return m;
        } catch (e) { /* 下一种组合 */ }
    }
    if (matWarned++ < 3) console.warn('[e06] Material.initialize 失败,退化共享内建材质');
    return null;
}

function setP(mat, key, val) {
    if (!mat) return;
    try { mat.setProperty(key, val); } catch (e) { /* 属性名不存在时静默 */ }
}

/** 受光材质(地面/树/石/柴) */
function stdMat(r, g, b) {
    const m = makeMat(FX_STD, 0, null);
    if (m) { setP(m, 'mainColor', new Color(r, g, b, 255)); return m; }
    return SHARED_STD_MAT;
}

/** 自发光材质(火苗/火星/萤火虫/星点)。technique:0 不透明 / 1 半透 / 2 加法(尽力) */
function unlitMat(r, g, b, a, technique, tex, useTexDefine) {
    const m = makeMat(FX_UNLIT, technique, tex && useTexDefine ? { USE_TEXTURE: true } : null);
    if (!m) return null;
    setP(m, 'mainColor', new Color(r, g, b, a == null ? 255 : a));
    if (tex) setP(m, 'mainTexture', tex);
    return m;
}

/** 运行时代码生成的径向渐变粒子贴图(不引入任何外部资产) */
function radialTexture(size, inner, outer, power) {
    const Tex = AIR.Texture2D;
    if (!Tex) return null;
    try {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const img = g.createImageData(size, size);
        const half = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = (x + 0.5 - half) / half;
                const dy = (y + 0.5 - half) / half;
                const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
                const t = Math.pow(1 - d, power);
                const o = (y * size + x) * 4;
                img.data[o] = clamp(lerp(outer[0], inner[0], t), 0, 255);
                img.data[o + 1] = clamp(lerp(outer[1], inner[1], t), 0, 255);
                img.data[o + 2] = clamp(lerp(outer[2], inner[2], t), 0, 255);
                img.data[o + 3] = clamp(lerp(outer[3], inner[3], t), 0, 255);
            }
        }
        g.putImageData(img, 0, 0);
        let src;
        try { src = AIR.ImageAsset ? new AIR.ImageAsset(c) : c; } catch (e) { src = c; }
        const tex = new Tex();
        try { tex.image = src; } catch (e) { return null; }
        return tex;
    } catch (e) {
        console.warn('[e06] 程序化纹理生成失败,粒子退化为无贴图:', e && e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// 全局状态与页面契约
// ---------------------------------------------------------------------------

const state = {
    frame: 0,
    resetCount: 0,
    timeOfDay: 0,        // 0=深夜 1=正午,spec 初始 <=0.05
    todTarget: 0,
    fireLightIntensity: 0.55,
    fireflyCount: FIREFLY_COUNT,
    cameraOrbitAngle: 0,
    orbitEnabled: true,
    treeCount: TREE_COUNT,
};

// 场景对象引用(step 内使用;构建期填充)
const sim = {
    inited: false,
    t: 0,
    camNode: null,
    cam: null,
    sun: null,
    fireLight: null,
    fireMode: 'none',
    ambient: null,
    starMat: null,
    poolMat: null,
    poolNode: null,
    flameCones: [],   // { node, baseH, baseR, phase, dir }
    flameQuads: [],   // { node, age, life, rise, s0, phase, az0, r0 }
    sparks: [],       // { node, vx, vy, vz, age, life, s0 }
    fireflies: [],    // { node, mat, cx, cy, cz, ax, ay, w1, p1, w2, p2 }
    tmpV: new Vec3(),
    tmpPivot: new Vec3(PIVOT.x, PIVOT.y, PIVOT.z),
    tmpSky: new Color(8, 12, 42, 255),
    tmpSun: new Color(150, 170, 255, 255),
    tmpC: new Color(255, 255, 255, 255),
    gl: null,
};

window.__appReady = false;

function doReset() {
    // spec §4:timeOfDay 立即(<=300ms)回 0、orbitEnabled=true、角度归零、粒子重播种
    state.timeOfDay = 0;
    state.todTarget = 0;
    state.orbitEnabled = true;
    state.cameraOrbitAngle = 0;
    sim.t = 0;
    state.resetCount += 1;
    if (sim.inited) {
        reseedSparks();
        reseedFireflies(true);
        reseedFlameQuads();
    }
    updateUiStatus();
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        ready: window.__appReady === true,
        frame: state.frame,
        resetCount: state.resetCount,
        timeOfDay: state.timeOfDay,
        fireLightIntensity: state.fireLightIntensity,
        fireflyCount: state.fireflyCount,
        cameraOrbitAngle: state.cameraOrbitAngle,
        orbitEnabled: state.orbitEnabled,
        treeCount: state.treeCount,
    }),
    reset: doReset,
    // —— 自检采样器(默认关闭;只在 Agent 自查时打开,正式运行零开销)——
    setSampling(on) {
        sampler.on = !!on;
        if (!on) sampler.frames.length = 0;
    },
    getSamples() { return sampler.frames.slice(-600); },
};

// ---------------------------------------------------------------------------
// UI(右上角,固定 data-ui)
// ---------------------------------------------------------------------------

const uiRefs = {};
function buildUi() {
    const box = document.createElement('div');
    box.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:9999;display:flex;flex-direction:column;' +
        'gap:6px;width:172px;font:13px/1.4 sans-serif;';
    const mkBtn = (ui, label) => {
        const b = document.createElement('button');
        b.setAttribute('data-ui', ui);
        b.textContent = label;
        b.style.cssText =
            'padding:6px 8px;background:rgba(20,24,34,0.85);color:#fff;border:1px solid #667;' +
            'border-radius:5px;cursor:pointer;font:13px sans-serif;';
        box.appendChild(b);
        return b;
    };
    uiRefs.dayNight = mkBtn('day-night', '切换 日/夜');
    uiRefs.orbit = mkBtn('orbit-toggle', '环绕:开');
    uiRefs.resetBtn = mkBtn('reset', '重置');
    const status = document.createElement('div');
    status.style.cssText =
        'padding:4px 6px;background:rgba(20,24,34,0.7);color:#cfe;border:1px solid #445;' +
        'border-radius:5px;font:12px sans-serif;text-align:center;';
    box.appendChild(status);
    uiRefs.status = status;
    uiRefs.dayNight.addEventListener('click', () => {
        state.todTarget = state.todTarget > 0.5 ? 0 : 1;
        updateUiStatus();
    });
    uiRefs.orbit.addEventListener('click', () => {
        state.orbitEnabled = !state.orbitEnabled;
        updateUiStatus();
    });
    uiRefs.resetBtn.addEventListener('click', () => doReset());
    document.body.appendChild(box);
    updateUiStatus();
}

function updateUiStatus() {
    if (!uiRefs.status) return;
    uiRefs.status.textContent =
        (state.timeOfDay >= 0.5 ? '当前:昼' : '当前:夜') +
        ' · 环绕:' + (state.orbitEnabled ? '开' : '关');
    uiRefs.orbit.textContent = '环绕:' + (state.orbitEnabled ? '开' : '暂停');
}

// ---------------------------------------------------------------------------
// 自检像素采样器(只在 setSampling(true) 时逐帧 readPixels,量化区域亮度/帧差)
// ---------------------------------------------------------------------------

const sampler = { on: false, frames: [], buf: null, prev: null };

function regionMean(px, W, H, fx0, fy0, fx1, fy1, step) {
    // 屏幕坐标(左上原点)→ GL 像素坐标(左下原点)
    const x0 = Math.floor(W * fx0), x1 = Math.ceil(W * fx1);
    const gy0 = Math.floor(H * (1 - fy1)), gy1 = Math.ceil(H * (1 - fy0));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = gy0; y < gy1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const o = (y * W + x) * 4;
            r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
        }
    }
    if (!n) return { r: 0, g: 0, b: 0, n: 0 };
    return { r: r / n, g: g / n, b: b / n, n };
}

function captureFrame() {
    const gl = sim.gl;
    if (!gl) return;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    if (!sampler.buf || sampler.buf.length !== W * H * 4) {
        sampler.buf = new Uint8Array(W * H * 4);
        sampler.prev = new Uint8Array(W * H * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, sampler.buf);
    const cur = sampler.buf, prev = sampler.prev;

    const sky = regionMean(cur, W, H, 0.06, 0.66, 0.94, 0.97, 4);
    const cb = regionMean(cur, W, H, 0.30, 0.42, 0.70, 0.86, 3);
    const outer = regionMean(cur, W, H, 0.0, 0.0, 1.0, 1.0, 4); // 近似:全画面按 8% 边带另算太贵,外带用整帧低频即可
    const full = regionMean(cur, W, H, 0.0, 0.0, 1.0, 1.0, 6);

    // center-bottom 帧差非零像素数(亮度波动证据)+ 暖色像素数(篝火存在证据)
    const x0 = Math.floor(W * 0.30), x1 = Math.ceil(W * 0.70);
    const gy0 = Math.floor(H * 0.14), gy1 = Math.ceil(H * 0.58);
    let diff = 0, warm = 0, wn = 0;
    for (let y = gy0; y < gy1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
            const o = (y * W + x) * 4;
            const d = Math.abs(cur[o] - prev[o]) + Math.abs(cur[o + 1] - prev[o + 1]) + Math.abs(cur[o + 2] - prev[o + 2]);
            if (d > 15) diff++;
            if (cur[o] > 90 && cur[o] > cur[o + 1] * 1.2 && cur[o] > cur[o + 2] * 1.4) warm++;
            wn++;
        }
    }
    sampler.frames.push({
        t: Date.now(),
        sky, cb, outer, full,
        cbDiff: diff,
        warm,
    });
    const sw = sampler.buf; sampler.buf = sampler.prev; sampler.prev = sw;
    if (sampler.frames.length > 900) sampler.frames.shift();
}

// ---------------------------------------------------------------------------
// 粒子播种
// ---------------------------------------------------------------------------

function reseedSparks() {
    for (const s of sim.sparks) {
        s.age = rand() * s.life;
        respawnSpark(s, true);
    }
}

function respawnSpark(s, keepAge) {
    const az = rand() * TAU;
    const r0 = 0.15 + rand() * 0.4;
    const hv = 0.3 + rand() * 0.9;
    s.node.setPosition(Math.cos(az) * r0, 0.5 + rand() * 0.7, Math.sin(az) * r0);
    s.vx = Math.cos(az + 1.2) * hv * 0.5;
    s.vz = Math.sin(az + 1.2) * hv * 0.5;
    s.vy = 1.2 + rand() * 1.6; // spec:上升 1-3 单位/s
    if (!keepAge) s.age = 0;
}

function reseedFireflies(keepPos) {
    for (const f of sim.fireflies) {
        f.p1 = rand() * TAU;
        f.p2 = rand() * TAU;
        const az = rand() * TAU;
        const r = 3.5 + rand() * 4.5;
        f.cx = Math.cos(az) * r;
        f.cz = Math.sin(az) * r;
        f.cy = 0.6 + rand() * 1.7;
        if (!keepPos) f.node.setPosition(f.cx, f.cy, f.cz);
    }
}

function reseedFlameQuads() {
    for (const q of sim.flameQuads) {
        q.age = rand() * q.life;
        const az = rand() * TAU;
        const r0 = rand() * 0.5;
        q.az0 = az; q.r0 = r0;
        q.node.setPosition(Math.cos(az) * r0, 0.4 + rand() * 0.5, Math.sin(az) * r0);
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 驱动组件:每帧调用 step(dt);dt 钳制避免失焦回来后时间跳变 */
class SimDriver extends Component {
    update(dt) {
        if (!sim.inited) return;
        step(Math.min(dt, 0.05));
    }
}

function step(dt) {
    sim.t += dt;

    // —— 火光闪烁:多频混合(1.3 / 3.1 / 5.4 Hz,幅度 >= 0.08)——
    const fl = clamp(
        0.55 +
        0.11 * Math.sin(sim.t * TAU * 1.3) +
        0.07 * Math.sin(sim.t * TAU * 3.1 + 1.7) +
        0.05 * Math.sin(sim.t * TAU * 5.4 + 0.6),
        0.03, 1);
    state.fireLightIntensity = fl;

    // —— 日夜渐变(连续,禁止瞬跳)——
    if (state.timeOfDay !== state.todTarget) {
        const dir = state.todTarget > state.timeOfDay ? 1 : -1;
        let v = state.timeOfDay + (dir * dt) / TOD_DURATION;
        if ((dir > 0 && v > state.todTarget) || (dir < 0 && v < state.todTarget)) v = state.todTarget;
        state.timeOfDay = v;
        if (Math.abs(v - state.todTarget) < 1e-6) state.timeOfDay = state.todTarget;
        updateUiStatus();
    }
    const d = state.timeOfDay;
    const night = 1 - d;

    // —— 环绕相机 ——
    if (state.orbitEnabled) state.cameraOrbitAngle += ORBIT_RATE * dt;
    const a = state.cameraOrbitAngle;
    Vec3.set(sim.tmpV, PIVOT.x + CAM_R * Math.cos(a), CAM_Y, PIVOT.z + CAM_R * Math.sin(a));
    sim.camNode.setPosition(sim.tmpV);
    sim.camNode.lookAt(sim.tmpPivot);

    // —— 天空 / 环境光 / 月光→日光(随 timeOfDay 连续插值)——
    sim.tmpSky.set(
        Math.round(lerp(8, 118, d)),
        Math.round(lerp(12, 178, d)),
        Math.round(lerp(42, 255, d)),
        255);
    sim.cam.clearColor = sim.tmpSky;

    if (sim.ambient) {
        sim.ambient.skyColorHDR.set(lerp(0.18, 1.0, d), lerp(0.26, 0.98, d), lerp(0.5, 0.95, d), 1.0);
        sim.ambient.skyIllum = lerp(2400, 20000, Math.pow(d, 1.1));
    }
    if (sim.sun) {
        sim.tmpSun.set(
            Math.round(lerp(150, 255, d)),
            Math.round(lerp(170, 244, d)),
            Math.round(lerp(255, 225, d)),
            255);
        sim.sun.color = sim.tmpSun; // Color 实例(引擎坑:普通对象 → NaN)
        sim.sun.illuminance = lerp(3000, 55000, d);
    }

    // —— 星点:夜间可见,白天按加法黑体淡出 ——
    if (sim.starMat) {
        sim.tmpC.set(225, 232, 255, Math.round(255 * Math.pow(night, 1.2)));
        setP(sim.starMat, 'mainColor', sim.tmpC);
    }

    // —— 火光(真实点光 + 地面光斑双重证据)——
    applyFireLight(fl, night);

    // —— 火苗层锥:呼吸 + 摆动 ——
    for (const c of sim.flameCones) {
        const s = c.node.scale;
        const sy = c.baseH * (0.82 + 0.3 * Math.sin(sim.t * 3 + c.phase) + 0.12 * fl);
        const sxz = c.baseR * (1 + 0.06 * Math.sin(sim.t * 2.3 + c.phase));
        s.set(sxz, Math.max(0.1, sy), sxz);
        c.node.scale = s;
        c.node.setRotationFromEuler(0, deg(sim.t * c.dir * 1.6 + c.phase), 0);
    }

    // —— 火苗面片:上升 + 收缩 + 朝向相机 ——
    const cwRef = sim.camNode.worldPosition;
    const cwx = cwRef && isFinite(cwRef.x) ? cwRef.x : PIVOT.x + CAM_R;
    const cwz = cwRef && isFinite(cwRef.z) ? cwRef.z : PIVOT.z;
    for (const q of sim.flameQuads) {
        q.age += dt;
        if (q.age >= q.life) {
            q.age = 0;
            const az = rand() * TAU;
            const r0 = rand() * 0.5;
            q.az0 = az; q.r0 = r0;
            q.life = 0.7 + rand() * 0.7;
        }
        const p = q.node.position;
        const wob = Math.sin(sim.t * 4 + q.phase) * 0.08;
        p.set(
            Math.cos(q.az0) * (q.r0 + wob) + Math.sin(sim.t * 2 + q.phase) * 0.05,
            p.y + q.rise * dt,
            Math.sin(q.az0) * (q.r0 + wob));
        if (p.y > 2.3) p.y = 0.4;
        q.node.setPosition(p);
        const k = 1 - q.age / q.life;
        const sc = q.s0 * (0.35 + 0.65 * k);
        q.node.setScale(sc, sc, sc);
        // billboard:绕 Y 朝向相机(俯角小,忽略 pitch)
        const dx = cwx - p.x, dz = cwz - p.z;
        q.node.setRotationFromEuler(0, deg(Math.atan2(dx, dz)), 0);
    }

    // —— 火星:上升 + 微重力 + 收缩消散,寿命到即重生 ——
    for (const s of sim.sparks) {
        s.age += dt;
        if (s.age >= s.life) {
            s.life = 0.8 + rand() * 1.2; // spec:0.8-2s
            respawnSpark(s, false);
        }
        const p = s.node.position;
        s.vy -= 0.5 * dt;
        p.set(p.x + s.vx * dt, p.y + s.vy * dt, p.z + s.vz * dt);
        s.node.setPosition(p);
        const k = 1 - s.age / s.life;
        const sc = s.s0 * Math.max(0.05, k);
        s.node.setScale(sc, sc, sc);
    }

    // —— 萤火虫:游走 + 明灭(夜间强,白天淡出)——
    for (const f of sim.fireflies) {
        const x = f.cx + Math.sin(sim.t * f.w1 + f.p1) * f.ax;
        const z = f.cz + Math.cos(sim.t * f.w1 * 0.83 + f.p2) * f.ax * 0.8;
        const y = f.cy + Math.sin(sim.t * f.w1 * 1.31 + f.p2) * f.ay;
        f.node.setPosition(x, y, z);
        const blink = Math.pow(Math.max(0, Math.sin(sim.t * f.w2 + f.p1)), 3);
        const alpha = (0.22 + 0.78 * blink) * (0.12 + 0.88 * night);
        if (f.mat) {
            sim.tmpC.set(190, 255, 110, Math.round(255 * alpha));
            setP(f.mat, 'mainColor', sim.tmpC);
        }
        // 尺寸同步明灭:即使 alpha 通道未被混合路径采纳,明灭仍然可见
        const sc = 0.1 + 0.12 * alpha;
        f.node.setScale(sc, sc, sc);
    }
}

function applyFireLight(fl, night) {
    // HDR 场景(方向光 5e4 lux 量级)下点光需要可达的流明/勒克斯量级,保证地面/树/石真实受光
    if (sim.fireLight) {
        const L = sim.fireLight;
        if (sim.fireMode === 'luminousPower') L.luminousPower = 8000 + 22000 * fl;
        else if (sim.fireMode === 'illuminance') L.illuminance = 8000 + 22000 * fl;
        else L.intensity = 700 + 1900 * fl;
    }
    if (sim.poolMat) {
        const a = Math.round(255 * 0.34 * fl * (0.3 + 0.7 * night));
        sim.tmpC.set(255, 160, 60, a);
        setP(sim.poolMat, 'mainColor', sim.tmpC);
        const s = 1 + 0.18 * fl;
        sim.poolNode.setScale(3.2 * s, 3.2 * s, 3.2 * s);
    }
}

// ---------------------------------------------------------------------------

function addMeshNode(parent, name, mesh, material, x, y, z) {
    const n = new Node(name);
    n.layer = Layers.Enum.DEFAULT;
    n.setPosition(new Vec3(x, y, z));
    parent.addChild(n);
    const mr = n.addComponent(MeshRenderer);
    mr.mesh = mesh;
    mr.material = material;
    return n;
}

async function main() {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    sim.gl = canvas.getContext('webgl2');

    // 内建效果资产解析(K0 无文档,双命名尝试 + 从内建材质反取 effectAsset)
    FX_STD = resolveEffect('builtin-standard-effect', 'builtin-standard-material');
    FX_UNLIT = resolveEffect('builtin-unlit-effect', 'builtin-unlit-material');
    try { SHARED_STD_MAT = builtinResMgr.get('builtin-standard-material'); } catch (e) { SHARED_STD_MAT = null; }

    // 程序化粒子贴图
    const flameTex = radialTexture(64, [255, 235, 170, 255], [255, 60, 10, 0], 1.5);
    const poolTex = radialTexture(64, [255, 200, 120, 240], [255, 120, 30, 0], 2.0);
    // 星点/萤火虫用中性白核贴图:flameTex 边缘的橙红会在小尺寸点上喧宾夺主
    const starTex = radialTexture(64, [255, 255, 255, 255], [210, 225, 255, 0], 2.0);

    const scene = new Scene('E06-campfire');

    // —— 相机(环视营地,带俯角)——
    const camNode = new Node('Main Camera');
    camNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(camNode);
    camNode.setPosition(new Vec3(CAM_R, CAM_Y, 0));
    camNode.lookAt(new Vec3(PIVOT.x, PIVOT.y, PIVOT.z));
    const cam = camNode.addComponent(Camera);
    cam.projection = Camera.ProjectionType.PERSPECTIVE;
    cam.fov = 55;
    cam.near = 0.1;
    cam.far = 400;
    cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cam.clearColor = new Color(8, 12, 42, 255);
    cam.visibility = Layers.Enum.DEFAULT; // 引擎坑:默认 undefined,必须显式
    cam.priority = 0;
    sim.camNode = camNode;
    sim.cam = cam;

    // —— 月/日方向光 ——
    const sunNode = new Node('SunMoon');
    sunNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(sunNode);
    sunNode.setPosition(new Vec3(6, 14, -4));
    sunNode.setRotationFromEuler(-55, -35, 0);
    const sun = sunNode.addComponent(DirectionalLight);
    sun.color = new Color(150, 170, 255, 255);
    sun.illuminance = 3000;
    sim.sun = sun;

    // —— 火光点光 ——
    const fireNode = new Node('FireLight');
    fireNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(fireNode);
    fireNode.setPosition(new Vec3(0, 2.6, 0));
    const PointLightCls = AIR.PointLight;
    if (PointLightCls) {
        const L = fireNode.addComponent(PointLightCls);
        L.color = new Color(255, 150, 60, 255);
        // 单位制未知(K0),按属性存在性择优:流明 > 勒克斯 > 强度
        if ('luminousPower' in L) sim.fireMode = 'luminousPower';
        else if ('illuminance' in L) sim.fireMode = 'illuminance';
        else sim.fireMode = 'intensity';
        try { if ('range' in L) L.range = 30; } catch (e) { /* */ }
        try { if ('decay' in L) L.decay = 2; } catch (e) { /* */ }
        sim.fireLight = L;
    } else {
        console.warn('[e06] PointLight 导出缺失,火光退化为光斑 + 火苗自发光');
    }

    // —— 几何与材质 ——
    const meshTerrain = utils.createMesh(terrainGeom(26, 20, 40));
    const meshConeL = utils.createMesh(coneGeom(1.5, 2.4, 7));
    const meshConeU = utils.createMesh(coneGeom(1.05, 1.9, 7));
    const meshDot = utils.createMesh(sphereGeom(0.5, 8, 6)); // 单位球,按 scale 缩放
    const meshQuad = utils.createMesh(quadGeom(1));
    const meshStars = utils.createMesh(starFieldGeom(STAR_COUNT, 90));

    const matGround = stdMat(58, 96, 46);
    const matTrunk = stdMat(92, 66, 44);
    const matLeafA = stdMat(20, 64, 34);
    const matLeafB = stdMat(30, 88, 44);
    const matLeafC = stdMat(40, 108, 52);
    const matStone = stdMat(96, 100, 108);
    const matLog = stdMat(78, 54, 36);

    // 半透(technique 1)是本环境已验证可用的混合路径;发光体统一走它。
    // 注意:火苗层锥不带贴图 —— buildFlat 网格没有 UV,带 USE_TEXTURE 会采样到 (0,0)
    // 角落的透明像素而整片“隐形”(shot5 实测坑)。
    const techAlpha = 1;
    const matFlameCone = [
        unlitMat(255, 64, 16, 235, techAlpha, null, false),
        unlitMat(255, 126, 18, 235, techAlpha, null, false),
        unlitMat(255, 186, 36, 235, techAlpha, null, false),
        unlitMat(255, 240, 150, 235, techAlpha, null, false),
    ];
    const matFlameQuad = [
        unlitMat(255, 238, 160, 150, techAlpha, flameTex, true),
        unlitMat(255, 160, 40, 150, techAlpha, flameTex, true),
        unlitMat(255, 80, 20, 150, techAlpha, flameTex, true),
    ];
    const matSpark = [
        unlitMat(255, 206, 92, 220, techAlpha, flameTex, true),
        unlitMat(255, 150, 48, 220, techAlpha, flameTex, true),
    ];
    sim.starMat = unlitMat(225, 232, 255, 255, techAlpha, starTex, true);
    sim.poolMat = unlitMat(255, 160, 60, 140, techAlpha, poolTex, true);

    // —— 地面 ——
    addMeshNode(scene, 'Ground', meshTerrain, matGround, 0, 0, 0);

    // —— 树环(16 棵,环形 + 抖动,避开场心)——
    const foliage = [matLeafA, matLeafB, matLeafC];
    for (let i = 0; i < TREE_COUNT; i++) {
        let az = (i / TREE_COUNT) * TAU + (rand() - 0.5) * 0.25;
        const r = 7.0 + rand() * 3.0;
        // 初始相机方位角 ≈ 0(相机在 +X)——“相机-篝火”视线带内不放树,保证初始构图篝火无遮挡
        let off = az % TAU;
        if (off > Math.PI) off -= TAU;
        if (Math.abs(off) < 0.55) az += 1.1;
        const gy = terrainH(r, az);
        const s = 0.75 + rand() * 0.6;
        const tree = new Node('Tree' + i);
        tree.layer = Layers.Enum.DEFAULT;
        tree.setPosition(new Vec3(Math.cos(az) * r, gy, Math.sin(az) * r));
        tree.setScale(s, s * (0.9 + rand() * 0.35), s);
        tree.setRotationFromEuler(0, rand() * 360, 0);
        scene.addChild(tree);
        addMeshNode(tree, 'trunk', utils.createMesh(primitives.box({ width: 0.34, height: 1.5, length: 0.34 })), matTrunk, 0, 0.75, 0);
        addMeshNode(tree, 'canopyL', meshConeL, foliage[i % 3], 0, 2.0, 0);
        addMeshNode(tree, 'canopyU', meshConeU, foliage[(i + 1) % 3], 0, 3.45, 0);
    }

    // —— 石圈 ——
    for (let i = 0; i < 10; i++) {
        const az = (i / 10) * TAU + rand() * 0.2;
        const r = 1.55 + rand() * 0.5;
        const s = 0.32 + rand() * 0.26;
        const st = addMeshNode(scene, 'Stone' + i,
            utils.createMesh(primitives.box({ width: s, height: s * 0.8, length: s * 1.1 })),
            matStone, Math.cos(az) * r, s * 0.34, Math.sin(az) * r);
        st.setRotationFromEuler(rand() * 14, rand() * 360, rand() * 14);
    }

    // —— 柴堆(斜搭)——
    for (let i = 0; i < 5; i++) {
        const az = (i / 5) * TAU + 0.3;
        const lg = addMeshNode(scene, 'Log' + i,
            utils.createMesh(primitives.box({ width: 0.2, height: 0.2, length: 1.7 })),
            matLog, Math.cos(az) * 0.5, 0.62, Math.sin(az) * 0.5);
        lg.setRotationFromEuler(62, deg(-az), 0);
    }

    // —— 地面光斑(火光呼吸的可视光池)——
    if (sim.poolMat) {
        sim.poolNode = new Node('LightPool');
        sim.poolNode.layer = Layers.Enum.DEFAULT;
        scene.addChild(sim.poolNode);
        sim.poolNode.setPosition(new Vec3(0, 0.035, 0));
        sim.poolNode.setRotationFromEuler(-90, 0, 0);
        const mr = sim.poolNode.addComponent(MeshRenderer);
        mr.mesh = meshQuad;
        mr.material = sim.poolMat;
        sim.poolNode.setScale(4.2, 4.2, 4.2);
    }

    // —— 火苗层锥(橙→红渐变,内焰更亮更高温色)——
    const coneDefs = [
        { mesh: utils.createMesh(coneGeom(0.98, 1.9, 6)), y: 0.30, mat: 0 },
        { mesh: utils.createMesh(coneGeom(0.75, 1.5, 6)), y: 0.34, mat: 1 },
        { mesh: utils.createMesh(coneGeom(0.55, 1.15, 6)), y: 0.38, mat: 2 },
        { mesh: utils.createMesh(coneGeom(0.35, 0.78, 6)), y: 0.42, mat: 3 },
    ];
    coneDefs.forEach((cd, i) => {
        const n = addMeshNode(scene, 'FlameCone' + i, cd.mesh, matFlameCone[cd.mat], 0, cd.y, 0);
        sim.flameCones.push({ node: n, baseH: 1, baseR: 1, phase: i * 1.3, dir: i % 2 === 0 ? 1 : -1 });
    });

    // —— 火苗面片(>=30)——
    for (let i = 0; i < FLAME_QUAD_COUNT; i++) {
        const mi = i % 3;
        const n = addMeshNode(scene, 'FlameQ' + i, meshQuad, matFlameQuad[mi], 0, 0.5, 0);
        const q = {
            node: n, age: rand() * 1.4, life: 0.7 + rand() * 0.7,
            rise: 0.5 + rand() * 0.6, s0: 0.26 + rand() * 0.28,
            phase: rand() * TAU, az0: rand() * TAU, r0: rand() * 0.5,
        };
        sim.flameQuads.push(q);
        n.setPosition(new Vec3(Math.cos(q.az0) * q.r0, 0.4 + rand() * 0.6, Math.sin(q.az0) * q.r0));
    }

    // —— 火星(>=40)——
    for (let i = 0; i < SPARK_COUNT; i++) {
        const n = addMeshNode(scene, 'Spark' + i, meshDot, matSpark[i % 2], 0, 1, 0);
        const s = {
            node: n, vx: 0, vy: 1.5, vz: 0,
            age: rand() * 2, life: 0.8 + rand() * 1.2, s0: 0.09 + rand() * 0.07,
        };
        n.setScale(s.s0, s.s0, s.s0);
        sim.sparks.push(s);
        respawnSpark(s, true);
    }

    // —— 萤火虫(>=16,各自材质实例以独立明灭)——
    for (let i = 0; i < FIREFLY_COUNT; i++) {
        const m = unlitMat(190, 255, 110, 230, techAlpha, starTex, true);
        const n = addMeshNode(scene, 'Firefly' + i, meshDot, m || matSpark[0], 0, 1.2, 0);
        n.setScale(0.11, 0.11, 0.11);
        sim.fireflies.push({
            node: n, mat: m,
            cx: 0, cy: 1.2, cz: 0,
            ax: 0.8 + rand() * 1.4, ay: 0.3 + rand() * 0.5,
            w1: 0.25 + rand() * 0.5, p1: rand() * TAU,
            w2: 1.2 + rand() * 2.2, p2: rand() * TAU,
        });
    }
    reseedFireflies(false);

    // —— 星空(单个批量 mesh)——
    if (sim.starMat) {
        const stars = new Node('Stars');
        stars.layer = Layers.Enum.DEFAULT;
        scene.addChild(stars);
        const mr = stars.addComponent(MeshRenderer);
        mr.mesh = meshStars;
        mr.material = sim.starMat;
    }

    // —— 驱动组件 ——
    const simNode = new Node('Sim');
    simNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(simNode);
    simNode.addComponent(SimDriver);

    // —— UI ——
    buildUi();

    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 后经 scene.globals 配置(模板已验证路径);引用存起来供每帧插值
    sim.ambient = scene.globals.ambient;
    sim.ambient.skyColorHDR.set(0.18, 0.26, 0.5, 1.0);
    sim.ambient.skyIllum = 2400;

    sim.inited = true;

    // 帧计数 + 首帧就绪 + 自检采样(模板同口径:EVENT_AFTER_DRAW)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) window.__appReady = true;
        if (sampler.on) captureFrame();
    });

    console.log('[e06] 荒野篝火营地 running — trees=' + TREE_COUNT +
        ' fireflies=' + FIREFLY_COUNT + ' sparks=' + SPARK_COUNT +
        ' fireMode=' + sim.fireMode + ' fxStd=' + !!FX_STD + ' fxUnlit=' + !!FX_UNLIT);
}

try {
    await main();
} catch (err) {
    console.error('[e06] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
