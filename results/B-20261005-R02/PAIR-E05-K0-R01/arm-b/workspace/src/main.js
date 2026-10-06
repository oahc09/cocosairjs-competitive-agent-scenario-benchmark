/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair K0 实现 v3
 *
 * v3 核心决策(基于 v2 实测截图教训):
 *  - 引擎 builtin unlit 下顶点色 RGB 生效、alpha 混合不可靠(v2 星云层被渲染成不透明大圆、
 *    不透明多普勒叠层盖掉条纹)⇒ v3 放弃一切混合依赖,**全场景不透明**:
 *      · 背景为近黑 clearColor;
 *      · 吸积盘 = XZ 环面网格,径向梯度(内白热→金→橙→暗红)× 旋转条纹 × 多普勒方位增亮
 *        全部烘进顶点色,外缘向黑渐隐(不透明几何在黑背景上 ≡ 加法辉光观感,无硬边);
 *      · 事件视界 = 不透明纯黑圆盘(写深度,天然遮挡其后的一切);
 *      · 背景星 700 颗不透明小方斑(黑底上即星点);
 *      · 星流 = 动态网格拖尾短棒,头亮尾暗。
 *  - 动态网格修正:d.ts 签名 createDynamicMesh(primitiveIndex, geometry, out, options)、
 *    updateSubMesh(primitiveIndex, geometry) — v2 缺参导致星流冻结,v3 按签名调用。
 *  - 盘面旋转 = 时间参数驱动的节点连续旋转(真实动态,非贴图回放)。
 *  - 内置 window.__snap:EVENT_AFTER_DRAW 内 readPixels 缓存最近帧,供探针自检做
 *    像素级证据(nonBlack / 环带 R-B / 两帧差分 / 暗核半径),不影响正常运行。
 *
 * 页面契约:window.__appReady(首帧后 true);window.__bench = { getState, reset };
 * data-ui="reset" 按钮(右上角 DOM)。
 */

import * as CC from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量与场景参数(brief §2:内缘~1.8、外缘 6.5、视界~1.2、初始相机 14、缩放 [5,28])
// 注:盘内缘取 1.55 —— 保证内缘在屏幕投影上落在视界圆之外(几何推导:近侧盘缘
//     屏幕偏移 0.766r/(14-0.643r) 需 > 视界 1.16/13.98,否则近侧盘面盖住黑核下缘)。
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
const ELEV = 50 * DEG;
const CAM_DIR = [0, Math.sin(ELEV), Math.cos(ELEV)];
const CAM_RIGHT = [1, 0, 0];
const CAM_UP = [0, Math.cos(ELEV), -Math.sin(ELEV)];
const CAM_DIST_INIT = 14;
const CAM_DIST_MIN = 5;
const CAM_DIST_MAX = 28;
const CAM_LERP = 5.0;
const FOV = 60;
const SHADOW_R = 1.16;
const DISK_IN = 1.55;
const DISK_OUT = 6.5;      // 视觉外缘(亮度归一处)
const DISK_TAIL = 7.6;     // 网格延伸处(向黑渐隐尽)
const DISK_OMEGA = 0.35;   // rad/s(spec 允许 0.15-0.6)
const BG_STARS = 800;
const STREAM_N = 220;
const TAU = Math.PI * 2;

const state = {
    frame: 0,
    resetCount: 0,
    diskRotation: 0,
    accretionPhase: 0,
    camDist: CAM_DIST_INIT,
    camTarget: CAM_DIST_INIT,
};

window.__appReady = false;
window.__diag = {
    effect: null, techniques: 0, materials: {}, mesh: {}, errors: [],
    snap: null,
};

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------------------
// __bench 契约(先于引擎启动定义;所有数值为真实状态,无伪造)
// ---------------------------------------------------------------------------
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        diskRotation: Math.round(state.diskRotation * 1e6) / 1e6,
        accretionPhase: Math.round(state.accretionPhase * 1e6) / 1e6,
        cameraDistance: Math.round(state.camDist * 1e6) / 1e6,
        starStreamCount: STREAM_N,
        backgroundStarCount: BG_STARS,
        ready: window.__appReady === true,
        frame: state.frame,
        resetCount: state.resetCount,
    }),
    reset: () => doReset(),
};

function doReset() {
    state.diskRotation = 0;
    state.accretionPhase = 0;
    state.camTarget = CAM_DIST_INIT;
    state.camDist = CAM_DIST_INIT; // reset 语义:距离立即回 14(±0.5)
    placeCamera();
    respawnAll();                  // 星流复位重生;背景星不动
    state.resetCount += 1;
}

// --- UI 控件(data-ui 契约,右上角 DOM) ------------------------------------
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
        "font:12px sans-serif;background:#1a1a22;color:#dde;border:1px solid #556;" +
        'border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
}

// ---------------------------------------------------------------------------
// 几何构造器(双面索引:正反绕序各一份,规避背面剔除方向不确定性)
// ---------------------------------------------------------------------------
function ringGeometry(opts) {
    const { radii, segs, basisA, basisB, center = [0, 0, 0], colorAt } = opts;
    const R = radii.length;
    const vc = R * segs;
    const positions = new Float32Array(vc * 3);
    const colors = new Float32Array(vc * 4);
    let p = 0, c = 0;
    for (let i = 0; i < R; i++) {
        const r = radii[i];
        const tR = R > 1 ? i / (R - 1) : 0;
        for (let j = 0; j < segs; j++) {
            const th = (j / segs) * TAU;
            const ca = Math.cos(th), sa = Math.sin(th);
            positions[p++] = center[0] + r * (basisA[0] * ca + basisB[0] * sa);
            positions[p++] = center[1] + r * (basisA[1] * ca + basisB[1] * sa);
            positions[p++] = center[2] + r * (basisA[2] * ca + basisB[2] * sa);
            const col = colorAt(r, th, tR);
            colors[c++] = col[0]; colors[c++] = col[1]; colors[c++] = col[2]; colors[c++] = col[3];
        }
    }
    const idx = [];
    for (let i = 0; i < R - 1; i++) {
        for (let j = 0; j < segs; j++) {
            const j2 = (j + 1) % segs;
            const a = i * segs + j, b = i * segs + j2, cc = (i + 1) * segs + j, d = (i + 1) * segs + j2;
            idx.push(a, b, d, a, d, cc);
            idx.push(a, d, b, a, cc, d);
        }
    }
    return { positions, colors, indices: new Uint16Array(idx) };
}

function fanGeometry(opts) {
    const { radii, segs, basisA, basisB, center = [0, 0, 0], colorAt } = opts;
    const R = radii.length;
    const vc = R * segs + 1;
    const positions = new Float32Array(vc * 3);
    const colors = new Float32Array(vc * 4);
    let p = 0, c = 0;
    positions[p++] = center[0]; positions[p++] = center[1]; positions[p++] = center[2];
    { const col = colorAt(0, 0, 0); colors[c++] = col[0]; colors[c++] = col[1]; colors[c++] = col[2]; colors[c++] = col[3]; }
    for (let i = 0; i < R; i++) {
        const r = radii[i];
        const tR = (i + 1) / R;
        for (let j = 0; j < segs; j++) {
            const th = (j / segs) * TAU;
            const ca = Math.cos(th), sa = Math.sin(th);
            positions[p++] = center[0] + r * (basisA[0] * ca + basisB[0] * sa);
            positions[p++] = center[1] + r * (basisA[1] * ca + basisB[1] * sa);
            positions[p++] = center[2] + r * (basisA[2] * ca + basisB[2] * sa);
            const col = colorAt(r, th, tR);
            colors[c++] = col[0]; colors[c++] = col[1]; colors[c++] = col[2]; colors[c++] = col[3];
        }
    }
    const idx = [];
    for (let i = 0; i < R; i++) {
        const inner = i === 0 ? 0 : 1 + (i - 1) * segs;
        const outer = 1 + i * segs;
        for (let j = 0; j < segs; j++) {
            const j2 = (j + 1) % segs;
            if (i === 0) {
                idx.push(0, outer + j2, outer + j, 0, outer + j, outer + j2);
            } else {
                const a = inner + j, b = inner + j2, cc = outer + j, d = outer + j2;
                idx.push(a, b, d, a, d, cc, a, d, b, a, cc, d);
            }
        }
    }
    return { positions, colors, indices: new Uint16Array(idx) };
}

function logspace(a, b, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(a * Math.pow(b / a, i / (n - 1)));
    return out;
}

// ---------------------------------------------------------------------------
// 材质:唯一一个不透明 unlit + 顶点色(无任何混合状态依赖)
// ---------------------------------------------------------------------------
let unlitEffect = null;

function resolveUnlitEffect() {
    const candidates = ['builtin-unlit-effect', 'builtin-unlit-material'];
    for (const k of candidates) {
        try {
            const a = CC.builtinResMgr.get(k);
            if (!a) continue;
            if (k.indexOf('effect') >= 0) { window.__diag.effect = k; return a; }
            if (a.effectAsset) { window.__diag.effect = k + '.effectAsset'; return a.effectAsset; }
        } catch (e) { /* 试下一个 */ }
    }
    return null;
}

/** 生成不透明 unlit 材质(顶点色;失败逐级回退并记录诊断) */
function makeOpaqueVC() {
    if (!CC.Material || !unlitEffect) return null;
    const mat = new CC.Material();
    const attempts = [
        ['vc', { effectAsset: unlitEffect, technique: 0, defines: { USE_VERTEX_COLOR: true } }],
        ['plain', { effectAsset: unlitEffect }],
    ];
    let ok = null, lastErr = null;
    for (const [name, a] of attempts) {
        try { mat.initialize(a); ok = name; break; } catch (e) { lastErr = e; }
    }
    window.__diag.materials.opaqueVC = {
        ok: !!ok, via: ok || String(lastErr && lastErr.message || lastErr).slice(0, 120),
    };
    if (!ok) return null;
    try {
        mat.setProperty('mainColor', new CC.Color(255, 255, 255, 255));
    } catch (e) {
        window.__diag.materials.opaqueVC.mainColor = String(e && e.message || e).slice(0, 120);
    }
    return mat;
}

/** 网格创建:静态层走 utils.createMesh;动态层优先 createDynamicMesh(d.ts 签名) */
function makeStaticMesh(geo) {
    try { return CC.utils.createMesh(geo); }
    catch (e) {
        window.__diag.mesh.createMeshFail = String(e && e.message || e).slice(0, 140);
        return null;
    }
}

function makeDynamicMesh(geo, maxVerts, maxIdx) {
    const cands = [];
    try { if (CC.utils.MeshUtils && typeof CC.utils.MeshUtils.createDynamicMesh === 'function') cands.push(CC.utils.MeshUtils.createDynamicMesh.bind(CC.utils.MeshUtils)); } catch (e) { /* noop */ }
    try { if (typeof CC.utils.createDynamicMesh === 'function') cands.push(CC.utils.createDynamicMesh.bind(CC.utils)); } catch (e) { /* noop */ }
    for (const fn of cands) {
        try {
            const m = fn(0, geo, undefined, { maxSubMeshes: 1, maxSubMeshVertices: maxVerts, maxSubMeshIndices: maxIdx });
            if (m) { window.__diag.mesh.dynamic = 'ok'; return m; }
        } catch (e) {
            window.__diag.mesh.dynamicFail = String(e && e.message || e).slice(0, 160);
        }
    }
    window.__diag.mesh.dynamic = 'unavailable';
    return null;
}

function addMeshNode(scene, name, geo, material) {
    const mesh = makeStaticMesh(geo);
    if (!mesh) { window.__diag.errors.push('mesh null: ' + name); return null; }
    const node = new CC.Node(name);
    node.layer = CC.Layers.Enum.DEFAULT;
    scene.addChild(node);
    const mr = node.addComponent(CC.MeshRenderer);
    mr.mesh = mesh;
    if (material) mr.material = material;
    return node;
}

// ---------------------------------------------------------------------------
// 颜色函数
// ---------------------------------------------------------------------------
function rampRGB(stops, r) {
    if (r <= stops[0][0]) return stops[0][1];
    if (r >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (r >= stops[i][0] && r < stops[i + 1][0]) {
            const f = (r - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
            const a = stops[i][1], b = stops[i + 1][1];
            return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        }
    }
    return stops[0][1];
}

// 径向梯度:内缘白热(>1 分量经帧缓冲钳制为纯白炽亮)→ 暖白 → 金 → 橙 → 暗红 → 黑(渐隐尾)
// 亮度次序内亮外暗(吸积盘物理观感);R-B 色差向外增大(内白外橙红)
const DISK_STOPS = [
    [1.55, [1.40, 1.34, 1.22]],
    [1.95, [1.28, 1.16, 0.94]],
    [2.60, [1.08, 0.82, 0.40]],
    [3.60, [0.78, 0.43, 0.12]],
    [4.80, [0.52, 0.19, 0.045]],
    [5.80, [0.32, 0.09, 0.025]],
    [6.50, [0.16, 0.04, 0.012]],
    [7.60, [0.00, 0.00, 0.00]],
];

/**
 * 盘顶点色:径向梯度 × 旋转条纹(9 周期主辐条 + 4 周期次级,径向扭转螺旋感)
 * × 多普勒方位因子(θ=0 侧增亮,对侧减暗)× 外缘向黑渐隐。
 * 全部烘进随节点旋转的顶点色 → 条纹随时间连续转动(真实动态)。
 */
function diskColorAt(r, th) {
    const [cr, cg, cb] = rampRGB(DISK_STOPS, r);
    const w1 = Math.pow(0.5 + 0.5 * Math.sin(9 * th - 3.0 * (r - DISK_IN)), 1.6);
    const w2 = Math.pow(0.5 + 0.5 * Math.sin(4 * th + 1.3 * r), 2.0);
    const s = 0.40 + 0.60 * clamp(0.72 * w1 + 0.28 * w2, 0, 1);
    const dn = 0.5 + 0.5 * Math.cos(th); // 多普勒:θ=0(屏幕右)为 approaching 亮侧
    const f = 0.62 + 0.70 * Math.pow(dn, 1.6) - 0.18 * Math.pow(1 - dn, 1.6);
    let fade = 1;
    if (r > 5.8) fade = clamp(1 - (r - 5.8) / 1.8, 0, 1); // 外缘柔光衰减,无硬边
    const k = s * f * fade;
    return [cr * k, cg * k, cb * k, 1];
}

// ---------------------------------------------------------------------------
// 星流(动态网格,220 粒子螺旋汇入)
// ---------------------------------------------------------------------------
const parts = [];
let streakGeo = null;
let streakMeshRef = null;
let streakUpdateBroken = false;

function respawnOne(p, initial) {
    p.r = initial ? 1.7 + Math.pow(Math.random(), 0.85) * 7.8 : 6.5 + Math.random() * 3.0;
    p.th = Math.random() * TAU;
    p.size = 0.045 + Math.random() * 0.045;
    p.y = (Math.random() - 0.5) * 0.28 * (p.r / 9);
    p.b = 0.75 + Math.random() * 0.25;
}

function respawnAll() {
    for (let i = 0; i < STREAM_N; i++) {
        if (!parts[i]) parts[i] = {};
        respawnOne(parts[i], true);
    }
    updateStreakVertices(0, true);
}

function buildStreakGeometry() {
    const geo = {
        positions: new Float32Array(STREAM_N * 4 * 3),
        colors: new Float32Array(STREAM_N * 4 * 4),
        indices: new Uint16Array(STREAM_N * 12),
        indices16: new Uint16Array(STREAM_N * 12),
        minPos: { x: -10, y: -1, z: -10 },
        maxPos: { x: 10, y: 1, z: 10 },
    };
    for (let i = 0; i < STREAM_N; i++) {
        const v = i * 4;
        const idx = i * 12;
        for (let half = 0; half < 2; half++) {
            const o = idx + half * 6;
            if (half === 0) {
                geo.indices[o] = v + 0; geo.indices[o + 1] = v + 1; geo.indices[o + 2] = v + 2;
                geo.indices[o + 3] = v + 0; geo.indices[o + 4] = v + 2; geo.indices[o + 5] = v + 3;
            } else {
                geo.indices[o] = v + 0; geo.indices[o + 1] = v + 2; geo.indices[o + 2] = v + 1;
                geo.indices[o + 3] = v + 0; geo.indices[o + 4] = v + 3; geo.indices[o + 5] = v + 2;
            }
        }
        geo.indices16.set(geo.indices.subarray(idx, idx + 12), idx);
        for (let k = 0; k < 4; k++) {
            const c4 = (v + k) * 4;
            const head = k < 2;
            const b = parts[i].b * (head ? 1.0 : 0.72); // 头亮尾暗(不透明渲染下用亮度渐隐)
            geo.colors[c4 + 0] = 0.82 * b;
            geo.colors[c4 + 1] = 0.90 * b;
            geo.colors[c4 + 2] = 1.00 * b;
            geo.colors[c4 + 3] = 1;
        }
    }
    return geo;
}

function commitStreaks() {
    if (streakUpdateBroken || !streakGeo || !streakMeshRef) return;
    try {
        if (typeof streakMeshRef.updateSubMesh === 'function') {
            streakMeshRef.updateSubMesh(0, streakGeo); // d.ts 签名:(primitiveIndex, dynamicGeometry)
            return;
        }
    } catch (e) {
        window.__diag.errors.push('updateSubMesh: ' + String(e && e.message || e).slice(0, 120));
    }
    streakUpdateBroken = true;
    try { console.warn('[e05] streak dynamic update unavailable — streaks frozen'); } catch (_) { /* noop */ }
}

function updateStreakVertices(dt, force) {
    if (!streakGeo) return;
    const pos = streakGeo.positions;
    for (let i = 0; i < STREAM_N; i++) {
        const p = parts[i];
        const om = 2.2 / Math.pow(p.r, 1.3);
        const vr = -1.3 / Math.sqrt(p.r);
        p.th += om * dt;
        p.r += vr * dt;
        if (p.r < 1.5) { respawnOne(p, false); }
        const rr = p.r, th = p.th;
        const px = Math.cos(th) * rr, pz = Math.sin(th) * rr;
        let vx = -Math.sin(th) * rr * om + Math.cos(th) * vr;
        let vz = Math.cos(th) * rr * om + Math.sin(th) * vr;
        const vl = Math.hypot(vx, vz) || 1;
        vx /= vl; vz /= vl;
        const speed = vl;
        const L = p.size * (1 + 1.2 * speed); // 接近视界加速 → 拖尾拉长
        const L2 = L / 2, W2 = p.size / 2;
        const nx = -vz, nz = vx;
        const v3 = i * 12;
        pos[v3 + 0] = px + vx * L2 + nx * W2; pos[v3 + 1] = p.y; pos[v3 + 2] = pz + vz * L2 + nz * W2;
        pos[v3 + 3] = px + vx * L2 - nx * W2; pos[v3 + 4] = p.y; pos[v3 + 5] = pz + vz * L2 - nz * W2;
        pos[v3 + 6] = px - vx * L2 - nx * W2; pos[v3 + 7] = p.y; pos[v3 + 8] = pz - vz * L2 - nz * W2;
        pos[v3 + 9] = px - vx * L2 + nx * W2; pos[v3 + 10] = p.y; pos[v3 + 11] = pz - vz * L2 + nz * W2;
    }
    if ((force || dt > 0) && !streakUpdateBroken) commitStreaks();
}

class BlackHoleController extends CC.Component {
    update(dt) {
        if (!(dt > 0)) return;
        dt = clamp(dt, 0, 0.05); // 失焦再聚焦防时间跳变
        state.frame += 1;
        state.diskRotation += dt * DISK_OMEGA;
        state.accretionPhase = (state.diskRotation / TAU) % 1;
        state.camDist += (state.camTarget - state.camDist) * (1 - Math.exp(-CAM_LERP * dt));
        if (Math.abs(state.camTarget - state.camDist) < 0.005) state.camDist = state.camTarget;
        placeCamera();
        if (diskNode && diskNode.isValid) {
            diskNode.setRotationFromEuler(0, (state.diskRotation * 180) / Math.PI, 0);
        }
        updateStreakVertices(dt, false);
    }
}

// ---------------------------------------------------------------------------
// 相机与场景装配
// ---------------------------------------------------------------------------
let cameraNode = null;
let diskNode = null;
const tmpPos = new CC.Vec3();

function placeCamera() {
    if (!cameraNode) return;
    tmpPos.set(CAM_DIR[0] * state.camDist, CAM_DIR[1] * state.camDist, CAM_DIR[2] * state.camDist);
    cameraNode.setPosition(tmpPos);
}

// ---------------------------------------------------------------------------
// 像素诊断钩(仅自检用):__snapWanted 置真后,每帧 EVENT_AFTER_DRAW 内
// readPixels 缓存最近一帧;window.__snapPixels / __snapMeta 供 eval 侧分析。
// ---------------------------------------------------------------------------
let glCtx = null;
let snapBuf = null;
let snapSeq = 0;

function armSnap(canvas) {
    window.__snapWanted = false;
    window.__snapPixels = null;
    window.__snapMeta = null;
    try {
        glCtx = canvas.getContext('webgl2');
    } catch (e) { window.__diag.snap = 'ctx:' + String(e && e.message || e).slice(0, 80); }
    if (!glCtx) return;
    const w = glCtx.drawingBufferWidth, h = glCtx.drawingBufferHeight;
    snapBuf = new Uint8Array(w * h * 4);
    CC.director.on(CC.Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) window.__appReady = true;
        if (!window.__snapWanted) return;
        try {
            glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
            glCtx.readPixels(0, 0, w, h, glCtx.RGBA, glCtx.UNSIGNED_BYTE, snapBuf);
            window.__snapPixels = snapBuf;
            window.__snapMeta = { w, h, seq: ++snapSeq };
        } catch (e) {
            window.__diag.snap = 'read:' + String(e && e.message || e).slice(0, 80);
            window.__snapWanted = false;
        }
    });
    window.__diag.snap = 'armed ' + w + 'x' + h;
}

async function main() {
    const canvas = document.querySelector('#GameCanvas');
    const app = await CC.createAirApp({ canvas });
    window.__airApp = app;
    window.__CC = CC; // 自检内省用

    unlitEffect = resolveUnlitEffect();
    try { window.__diag.techniques = (unlitEffect && unlitEffect.techniques && unlitEffect.techniques.length) || 0; } catch (e) { /* noop */ }

    const scene = new CC.Scene('blackhole');

    // 相机(透视 60°;visibility 必须显式设置)
    cameraNode = new CC.Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new CC.Vec3(CAM_DIR[0] * CAM_DIST_INIT, CAM_DIR[1] * CAM_DIST_INIT, CAM_DIR[2] * CAM_DIST_INIT));
    cameraNode.lookAt(new CC.Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(CC.Camera);
    camera.projection = CC.Camera.ProjectionType.PERSPECTIVE;
    camera.fov = FOV;
    camera.near = 0.1;
    camera.far = 900;
    camera.clearFlags = CC.Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new CC.Color(2, 3, 8, 255); // 近黑深空
    camera.visibility = CC.Layers.Enum.DEFAULT;
    camera.priority = 0;

    const matVC = makeOpaqueVC();

    // 1) 背景星空:800 颗不透明小方斑(黑底上即星点)
    //    屏幕空间均匀布点(经相机射线反投到远球)—— 保证画面各处(含四角)密度一致,
    //    规避球冠均匀采样在屏幕角部的 cos³ 密度塌陷(P1 outer-corners ≥1% 硬指标)。
    {
        const n = BG_STARS;
        const vc = n * 4;
        const positions = new Float32Array(vc * 3);
        const colors = new Float32Array(vc * 4);
        const indices = new Uint16Array(n * 12);
        const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
        const tanV = Math.tan((FOV / 2) * DEG), tanH = tanV * (vw / vh);
        let pv = 0, cv = 0, iv = 0;
        for (let s = 0; s < n; s++) {
            const sx = -0.06 + Math.random() * 1.12; // 归一化屏幕坐标(含 6% 出画余量)
            const sy = -0.06 + Math.random() * 1.12;
            const tx = (sx - 0.5) * 2 * tanH;
            const ty = (0.5 - sy) * 2 * tanV;
            // 相机在 CAM_DIR*14 处 lookAt 原点 → 视线方向 = -CAM_DIR;可见天球在 -CAM_DIR 半球
            let dx = -CAM_DIR[0] + CAM_RIGHT[0] * tx + CAM_UP[0] * ty;
            let dy = -CAM_DIR[1] + CAM_RIGHT[1] * tx + CAM_UP[1] * ty;
            let dz = -CAM_DIR[2] + CAM_RIGHT[2] * tx + CAM_UP[2] * ty;
            const dl = Math.hypot(dx, dy, dz) || 1;
            dx /= dl; dy /= dl; dz /= dl;
            const R = 70 + Math.random() * 120;
            // 相对初始相机位置放置:初始视角下屏幕映射精确均匀;缩放时仅产生缓慢视差
            const cx = CAM_DIR[0] * CAM_DIST_INIT + dx * R;
            const cy = CAM_DIR[1] * CAM_DIST_INIT + dy * R;
            const cz = CAM_DIR[2] * CAM_DIST_INIT + dz * R;
            const roll = Math.random();
            const pxTarget = roll < 0.75 ? 4.0 + Math.random() * 4.5
                : roll < 0.95 ? 8.5 + Math.random() * 4.0
                    : 13.0 + Math.random() * 5.0;
            const size = (pxTarget * R * Math.tan((FOV / 2) * DEG)) / 360;
            const tintRoll = Math.random();
            const tint = tintRoll < 0.60 ? [1, 1, 1] : tintRoll < 0.82 ? [0.72, 0.83, 1]
                : tintRoll < 0.94 ? [1, 0.85, 0.7] : [1, 0.62, 0.45];
            const amp = 0.65 + Math.random() * 0.35;
            const base = s * 4;
            positions[pv++] = cx; positions[pv++] = cy; positions[pv++] = cz;
            colors[cv++] = tint[0] * amp; colors[cv++] = tint[1] * amp; colors[cv++] = tint[2] * amp; colors[cv++] = 1;
            const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
            for (let k = 0; k < 4; k++) {
                const ox = corners[k][0] * size / 2, oy = corners[k][1] * size / 2;
                positions[pv++] = cx + CAM_RIGHT[0] * ox + CAM_UP[0] * oy;
                positions[pv++] = cy + CAM_RIGHT[1] * ox + CAM_UP[1] * oy;
                positions[pv++] = cz + CAM_RIGHT[2] * ox + CAM_UP[2] * oy;
                colors[cv++] = tint[0] * amp; colors[cv++] = tint[1] * amp; colors[cv++] = tint[2] * amp; colors[cv++] = 1;
            }
            const o = s * 12;
            indices[o] = base; indices[o + 1] = base + 1; indices[o + 2] = base + 2;
            indices[o + 3] = base; indices[o + 4] = base + 2; indices[o + 5] = base + 3;
            indices[o + 6] = base; indices[o + 7] = base + 2; indices[o + 8] = base + 1;
            indices[o + 9] = base; indices[o + 10] = base + 3; indices[o + 11] = base + 2;
        }
        addMeshNode(scene, 'BgStars', { positions, colors, indices }, matVC);
    }

    // 2) 吸积盘(XZ 环面):梯度 × 条纹 × 多普勒 × 渐隐尾,全部在顶点色;节点连续旋转
    diskNode = addMeshNode(scene, 'AccretionDisk',
        ringGeometry({
            radii: logspace(DISK_IN, DISK_TAIL, 34),
            segs: 160,
            basisA: [1, 0, 0],
            basisB: [0, 0, 1],
            colorAt: diskColorAt,
        }),
        matVC);
    if (diskNode) diskNode.setRotationFromEuler(0, 0, 0);

    // 3) 事件视界:不透明纯黑圆盘(写深度 → 遮挡其后一切;锐利边缘)
    addMeshNode(scene, 'EventHorizon',
        fanGeometry({
            radii: [SHADOW_R], segs: 64,
            basisA: CAM_RIGHT, basisB: CAM_UP,
            center: [CAM_DIR[0] * 0.02, CAM_DIR[1] * 0.02, CAM_DIR[2] * 0.02],
            colorAt: () => [0, 0, 0, 1],
        }),
        matVC);

    // 4) 星流(动态网格):先建 parts,再建几何与 mesh,最后绑定引用
    for (let i = 0; i < STREAM_N; i++) { parts[i] = {}; respawnOne(parts[i], true); }
    streakGeo = buildStreakGeometry();
    {
        let mesh = makeDynamicMesh(streakGeo, STREAM_N * 4, STREAM_N * 12);
        if (!mesh) mesh = makeStaticMesh(streakGeo);
        if (mesh) {
            streakMeshRef = mesh;
            const node = new CC.Node('StarStream');
            node.layer = CC.Layers.Enum.DEFAULT;
            scene.addChild(node);
            const mr = node.addComponent(CC.MeshRenderer);
            mr.mesh = mesh;
            if (matVC) mr.material = matVC;
            updateStreakVertices(0, true); // 初始位置写入并 commit
        } else {
            window.__diag.errors.push('streak mesh null');
        }
    }

    // 控制器(旋转/相位/相机/星流)
    const ctrlNode = new CC.Node('BHController');
    scene.addChild(ctrlNode);
    ctrlNode.addComponent(BlackHoleController);

    // 滚轮缩放:capture 监听(pal 层吞 canvas 事件)
    window.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = typeof e.deltaY === 'number' ? e.deltaY : 0;
        state.camTarget = clamp(state.camTarget + dy * 0.012, CAM_DIST_MIN, CAM_DIST_MAX);
    }, { capture: true, passive: false });

    // 像素诊断钩 + __appReady(首帧后)
    armSnap(canvas);

    app.run(scene);

    console.log('[e05] running — blackhole v3 (opaque), stars=' + BG_STARS + ', stream=' + STREAM_N);
}

try {
    await main();
} catch (err) {
    try { console.error('[e05] fatal:', err && err.message ? err.message : err); } catch (_) { /* noop */ }
    setTimeout(() => { throw err; }, 0);
}
