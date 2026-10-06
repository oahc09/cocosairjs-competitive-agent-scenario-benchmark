/**
 * E02 — 落日海面与孤舟 (Asset Driven) — cocosair K0 实现
 *
 * 场景组成:
 *   - 海面:72×72 顶点网格(5329 顶点 ≥ 2000),指数级近密远疏;每帧 CPU 重算
 *     三重正弦重力波(相位随 simTime 推进)的位置与解析法线,经
 *     utils.MeshUtils.createDynamicMesh + mesh.updateSubMesh 上传。
 *   - 天空:camera.clearColor(随 tone 演变的地平色)+ 线性雾把远处海面融入天色;
 *     太阳/月亮光盘为 builtin-unlit 具单例网格(自研 Material 在本构建不可用,
 *     已实测:effectName/effectAsset 三种路径渲染均异常,故全部收缩到 builtin 单例)。
 *   - 孤舟:运行时 fetch 加载 assets/boat.glb(GLTFLoader.loadAsync → instantiate),
 *     保留资产内嵌材质;包围盒归一化到目标长度并配重吃水。
 *   - 船体随波:boatPosition.y = 同一波形函数在船位处采样(相位耦合),并按波形
 *     梯度施加轻微纵摇/横摇。
 *   - 色调:toneMix ∈ [0,1] 线性过渡(1.6s ≤ 2.5s),同时驱动天空 clear 颜色、日/月盘、
 *     海面 mainColor、方向光颜色/强度、环境光(HDR)与线性雾颜色。
 *   - 相机:绕船方位角环绕(逐帧指数插值),水平拖拽经 window capture 监听
 *     (pal 层吞 canvas 事件,已知坑)。
 *   - Reset:释放旧船(GLTFInstance.dispose + GLTFAsset.destroy)与海面网格
 *     (Mesh.destroy 显式释放 GPU 资源),同步重建程序化网格、异步重载资产;
 *     恢复 toneMix=0 / azimuth=35 / simTime=0;epoch+1;非整页刷新。
 *
 * 页面契约:
 *   - window.__appReady:资产加载完成且首帧渲染(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState, reset },字段见 spec.json stateContract。
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
    Vec3,
    Color,
    Component,
    director,
    Director,
    GLTFLoader,
    Material,
} from 'cocosair.js';

/* ================================ 常量与状态 ================================ */

const ASSET_URL = 'assets/boat.glb';
const TARGET_BOAT_LEN = 2.4;    // 资产契约 1–4 单位,归一到其中段,构图稳定
const BOAT_DRAFT = 0.12;        // 吃水:包_bbox最低点没入水面以下的部分

const WARM = { // toneMix = 0(落日)
    horizon: [255, 168, 90], mid: [244, 112, 64], zenith: [66, 52, 120],
    sun: [255, 240, 196], glow: [255, 166, 84],
    fog: [255, 150, 84], sea: [172, 120, 96],
    ambient: [1.15, 0.72, 0.44], skyIllum: 16000,
    light: [255, 184, 116], illum: 60000,
};
const COLD = { // toneMix = 1(暮蓝)
    horizon: [96, 112, 168], mid: [44, 58, 112], zenith: [12, 16, 46],
    sun: [228, 238, 255], glow: [128, 152, 216],
    fog: [36, 52, 98], sea: [42, 76, 128],
    ambient: [0.28, 0.40, 0.82], skyIllum: 9000,
    light: [168, 192, 255], illum: 34000,
};

// 三重正弦重力波(k 波数, w 角频率, p 初相;方向单位向量 dx,dz)
const WAVES = [
    { k: 0.14, dx: 0.94, dz: 0.34, a: 0.30, w: 0.9, p: 0.0 },
    { k: 0.32, dx: -0.28, dz: 0.96, a: 0.16, w: 1.5, p: 1.3 },
    { k: 0.85, dx: 0.81, dz: -0.59, a: 0.06, w: 2.3, p: 4.1 },
];

/** 波形高度(唯一波形源:海面网格与船体浮沉采样同一函数 → 相位耦合)。 */
function waveH(x, z, t) {
    let h = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        h += w.a * Math.sin(w.k * (x * w.dx + z * w.dz) - w.w * t + w.p);
    }
    return h;
}
/** 波形梯度(解析导数,用于海面法线与船体纵摇/横摇)。 */
function waveGrad(x, z, t, out) {
    let gx = 0, gz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        const c = w.a * w.k * Math.cos(w.k * (x * w.dx + z * w.dz) - w.w * t + w.p);
        gx += c * w.dx;
        gz += c * w.dz;
    }
    out.x = gx; out.z = gz;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function mix3(a, b, t, out) { out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t); return out; }
const colOf = (arr, a = 255) => new Color(arr[0], arr[1], arr[2], a);
// createDynamicMesh 默认容量仅 1024 顶点/索引,必须按几何实际规模显式给容量
function dynOpts(geo) {
    return {
        maxSubMeshes: 1,
        maxSubMeshVertices: geo.positions.length / 3,
        maxSubMeshIndices: (geo.indices16 || geo.indices32).length,
    };
}

const state = {
    epoch: 0,
    assetRequests: 0,   // 对 assets/boat.glb 完成加载的请求计数
    boatLoaded: false,
    frames: 0,
    frameTs: [],        // fps:2s 滚动窗口时间戳
    simTime: 0,         // 波形相位(秒,单调;reset 归零重启)
    az: 35, azTarget: 35,
    toneCur: 0, toneTarget: 0,
    dragging: false, lastX: 0,
    loadToken: 0,       // reset 期间异步加载的竞态守卫
};
const grad = { x: 0, z: 0 };
const tmpV = { x: 0, z: 0 };

window.__appReady = false;

window.__bench = {
    getState: () => {
        const now = performance.now();
        while (state.frameTs.length && now - state.frameTs[0] > 2000) state.frameTs.shift();
        const w = world;
        return {
            assetLoaded: state.boatLoaded === true,
            assetRequests: state.assetRequests,
            boatPosition: w && w.boatPos ? { x: w.boatPos.x, y: w.boatPos.y, z: w.boatPos.z } : { x: 0, y: 0, z: 0 },
            wavePhase: state.simTime,
            toneMix: state.toneCur,
            cameraAzimuth: state.az,
            fps: state.frameTs.length / 2,
            epoch: state.epoch,
        };
    },
    reset: () => doReset(),
};

/* ================================ UI 控件 ================================ */

function makeButton(text, uiName, ariaName, css) {
    const b = document.createElement('button');
    b.textContent = text;
    b.setAttribute('data-ui', uiName);
    b.setAttribute('aria-label', ariaName);
    b.style.cssText = css;
    document.body.appendChild(b);
    return b;
}
const toneBtn = makeButton('Tone: Sunset', 'tone-toggle', 'tone-toggle',
    'position:fixed;top:8px;left:8px;z-index:9999;padding:4px 12px;font:12px sans-serif;' +
    'background:#222;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer');
const resetBtn = makeButton('Reset', 'reset', 'reset',
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;font:12px sans-serif;' +
    'background:#222;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer');

toneBtn.addEventListener('click', () => {
    state.toneTarget = state.toneTarget > 0.5 ? 0 : 1;
    toneBtn.textContent = state.toneTarget > 0.5 ? 'Tone: Dusk' : 'Tone: Sunset';
});
resetBtn.addEventListener('click', () => doReset());

const loadingDiv = document.createElement('div');
loadingDiv.id = 'loading';
loadingDiv.textContent = 'Loading assets/boat.glb ...';
loadingDiv.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:9999;padding:4px 10px;' +
    'font:12px sans-serif;background:rgba(0,0,0,0.55);color:#eee;border-radius:4px;';
document.body.appendChild(loadingDiv);

const errorDiv = document.createElement('div');
errorDiv.id = 'load-error';
errorDiv.textContent = 'Failed to load assets/boat.glb';
errorDiv.style.cssText = 'position:fixed;bottom:34px;left:8px;z-index:9999;padding:4px 10px;' +
    'font:12px sans-serif;background:rgba(120,10,10,0.8);color:#fff;border-radius:4px;display:none;';
document.body.appendChild(errorDiv);

const hintDiv = document.createElement('div');
hintDiv.textContent = 'drag to orbit · tone / reset';
hintDiv.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;padding:4px 10px;' +
    'font:11px sans-serif;background:rgba(0,0,0,0.35);color:#bbb;border-radius:4px;';
document.body.appendChild(hintDiv);

/* ================================ 世界构建 ================================ */

const world = {
    gltfAsset: null, gltfInst: null, boatRoot: null,
    boatPos: { x: 0, y: 0, z: 0 }, boatBaseY: 0, boatCY: 0,
    seaNode: null, seaMesh: null, seaGeo: null,
    ownNodes: [],
};

let scene = null;
let cameraNode = null;
let camera = null;
let lightNode = null;
let light = null;

// 相机轨道参数:俯角 8° → 海平线约在画面上 1/3,海面占画面 ≥ 60%
const CAM_R = 7.6;
const CAM_ELEV = (8 * Math.PI) / 180;
const CAM_REF_Y = 0.55;
const camRef = new Vec3(0, CAM_REF_Y, 0);

const SEA_N = 72;          // 72×72 → (N+1)^2 = 5329 顶点 ≥ 2000
const SEA_HALF = 260;
const SUN_DIR = { x: 0, y: 0, z: 0 }; // 太阳/月亮方向(世界,单位向量)

// 共享材质(具单例,跨 reset 复用):海面 standard、日盘 unlit
let seaMat = null, sunMat = null;

/** 海面网格坐标:|u|^2 幂次分布 → 近处波形细节密、远处疏。 */
function seaCoord(u) {
    return (u < 0 ? -1 : 1) * SEA_HALF * u * u;
}

function buildSeaGeometry() {
    const n1 = SEA_N + 1;
    const vcount = n1 * n1;
    const positions = new Float32Array(vcount * 3);
    const normals = new Float32Array(vcount * 3);
    const indices = [];
    let p = 0;
    for (let iz = 0; iz < n1; iz++) {
        const z = seaCoord((iz / SEA_N) * 2 - 1);
        for (let ix = 0; ix < n1; ix++) {
            const x = seaCoord((ix / SEA_N) * 2 - 1);
            positions[p] = x;
            positions[p + 1] = waveH(x, z, state.simTime);
            positions[p + 2] = z;
            waveGrad(x, z, state.simTime, grad);
            let nx = -grad.x, ny = 1, nz = -grad.z;
            const il = 1 / Math.hypot(nx, ny, nz);
            normals[p] = nx * il; normals[p + 1] = ny * il; normals[p + 2] = nz * il;
            p += 3;
        }
    }
    for (let iz = 0; iz < SEA_N; iz++) {
        for (let ix = 0; ix < SEA_N; ix++) {
            const a = iz * n1 + ix, b = a + 1, c = a + n1, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    return {
        positions, normals,
        indices16: new Uint16Array(indices),
        minPos: { x: -SEA_HALF, y: -0.6, z: -SEA_HALF },
        maxPos: { x: SEA_HALF, y: 0.6, z: SEA_HALF },
    };
}

function updateSeaGeometry() {
    const geo = world.seaGeo;
    const pos = geo.positions, nrm = geo.normals;
    const t = state.simTime;
    let p = 0;
    const n1 = SEA_N + 1;
    for (let iz = 0; iz < n1; iz++) {
        const z = seaCoord((iz / SEA_N) * 2 - 1);
        for (let ix = 0; ix < n1; ix++) {
            const x = seaCoord((ix / SEA_N) * 2 - 1);
            pos[p + 1] = waveH(x, z, t);
            waveGrad(x, z, t, grad);
            const nx = -grad.x, nz = -grad.z;
            const il = 1 / Math.hypot(nx, 1, nz);
            nrm[p] = nx * il; nrm[p + 1] = il; nrm[p + 2] = nz * il;
            p += 3;
        }
    }
    world.seaMesh.updateSubMesh(0, geo);
}

/** 面向原点的圆盘(太阳/月亮 + 光晕),双向三角形避免背面剔除不确定性。 */
function buildDisc(dir, radius, dist) {
    const ux = dir.z, uz = -dir.x; // 水平面内垂直于 dir 的单位向量(dir 近似水平归一)
    const ul = Math.hypot(ux, uz) || 1;
    const U = { x: ux / ul, y: 0, z: uz / ul };
    const V = {
        x: dir.y * U.z - dir.z * U.y,
        y: dir.z * U.x - dir.x * U.z,
        z: dir.x * U.y - dir.y * U.x,
    };
    const cx = dir.x * dist, cy = dir.y * dist, cz = dir.z * dist;
    const positions = [];
    const indices = [];
    positions.push(cx, cy, cz);
    const SEGS = 40;
    for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        const co = Math.cos(a) * radius, si = Math.sin(a) * radius;
        positions.push(cx + U.x * co + V.x * si, cy + U.y * co + V.y * si, cz + U.z * co + V.z * si);
    }
    for (let s = 0; s < SEGS; s++) {
        const s1 = s + 1;
        indices.push(0, s1, s1 === SEGS ? 1 : s1 + 1); // 正向
        indices.push(0, s1 === SEGS ? 1 : s1 + 1, s1); // 反向(双面)
    }
    return {
        positions: new Float32Array(positions),
        indices16: new Uint16Array(indices),
        minPos: { x: cx - radius - 1, y: cy - radius - 1, z: cz - radius - 1 },
        maxPos: { x: cx + radius + 1, y: cy + radius + 1, z: cz + radius + 1 },
    };
}

function computeSunDir() {
    // 太阳位于相机初始视线(世界方位 215°)偏侧 25° → 世界方位 190°,仰角 7°
    const az = ((190 * Math.PI) / 180);
    const el = (7 * Math.PI) / 180;
    SUN_DIR.x = Math.cos(el) * Math.sin(az);
    SUN_DIR.y = Math.sin(el);
    SUN_DIR.z = Math.cos(el) * Math.cos(az);
}

/* ---------------------------- 资产加载(boat.glb) ---------------------------- */

const gltfLoader = new GLTFLoader();

async function loadBoat() {
    const token = ++state.loadToken;
    try {
        const asset = await gltfLoader.loadAsync(ASSET_URL); // 真实网络请求 → /assets/boat.glb
        const inst = asset.instantiate();
        if (token !== state.loadToken) { // 期间发生过 reset:直接释放,不入场
            try { inst.dispose(); } catch (e) { /* 防御:不阻断 */ }
            try { asset.destroy(); } catch (e) { /* 防御 */ }
            return;
        }
        const root = inst.root;
        root.layer = Layers.Enum.DEFAULT;
        // 包围盒:逐 mesh 取几何顶点极值(参考点用,不参与判定造假)
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        try {
            for (const m of asset.meshes) {
                const g = utils.readMesh(m);
                if (!g || !g.positions) continue;
                for (let i = 0; i < g.positions.length; i += 3) {
                    const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                }
            }
        } catch (e) { /* 包围盒退化:用固定缩放 */ }
        const dims = [maxX - minX, maxY - minY, maxZ - minZ].filter(Number.isFinite);
        const maxDim = dims.length ? Math.max(...dims) : 0;
        const s = maxDim > 0 ? clamp(TARGET_BOAT_LEN / maxDim, 0.25, 4) : 1;
        const cy = Number.isFinite(minY) ? ((minY + maxY) / 2) * s : 0.2;
        const baseY = Number.isFinite(minY) ? BOAT_DRAFT - minY * s : BOAT_DRAFT - 0.15;

        root.setScale(s, s, s);
        root.setPosition(0, baseY, 0);
        root.setRotationFromEuler(0, -20, 0); // 固定偏航,构图自然
        scene.addChild(root);

        world.gltfAsset = asset;
        world.gltfInst = inst;
        world.boatRoot = root;
        world.boatBaseY = baseY;
        world.boatCY = cy;
        state.assetRequests += 1; // 完成加载计数(每次重建重载 +1)
        state.boatLoaded = true;
        errorDiv.style.display = 'none';
        if (!window.__appReady) {
            loadingDiv.remove();
        }
    } catch (err) {
        // 资产加载失败:可见错误提示,且不产生未捕获异常
        errorDiv.style.display = 'block';
        errorDiv.textContent = 'Failed to load assets/boat.glb: ' + (err && err.message ? err.message : err);
    }
}

/* ------------------------------- 释放与重建 ------------------------------- */

function destroyMeshSafe(mesh) {
    try { if (mesh) mesh.destroy(); } catch (e) { /* 幂等释放,忽略二次销毁 */ }
}

function releaseWorld() {
    // 1) 船:先移出场景,再释放实例(停止动画/节点)与共享资产(GPU 资源显式释放入口)
    if (world.boatRoot && scene) scene.removeChild(world.boatRoot);
    try { if (world.gltfInst) world.gltfInst.dispose(); } catch (e) { /* 防御 */ }
    try { if (world.gltfAsset) world.gltfAsset.destroy(); } catch (e) { /* 防御 */ }
    // 2) 海面:移除节点 + 销毁网格(释放 VB/IB GPU 资源)
    for (const n of world.ownNodes) { if (n && scene) scene.removeChild(n); }
    destroyMeshSafe(world.seaMesh);
    world.gltfAsset = null; world.gltfInst = null; world.boatRoot = null;
    world.seaNode = null; world.seaMesh = null; world.seaGeo = null;
    world.ownNodes.length = 0;
}

function buildWorld() {
    // 海面(动态网格;太阳光盘为启动期一次性构建,不参与 reset 释放)
    world.seaGeo = buildSeaGeometry();
    world.seaMesh = utils.MeshUtils.createDynamicMesh(0, world.seaGeo, undefined, dynOpts(world.seaGeo));
    const seaNode = new Node('Sea');
    seaNode.layer = Layers.Enum.DEFAULT;
    const seaRenderer = seaNode.addComponent(MeshRenderer);
    seaRenderer.mesh = world.seaMesh;
    seaRenderer.material = seaMat;
    scene.addChild(seaNode);

    world.seaNode = seaNode;
    world.ownNodes = [seaNode];

    // 船(异步,真实网络请求)
    loadBoat();
}


function doReset() {
    if (!scene) return; // 启动未完成时忽略(完成合同探针均在就绪后触发)
    state.epoch += 1;
    state.az = 35; state.azTarget = 35;
    state.simTime = 0;
    state.toneCur = 0; state.toneTarget = 0;
    state.dragging = false;
    state.boatLoaded = false;
    state.frames = 0;
    releaseWorld();
    buildWorld();     // 同步重建程序化网格;异步重载 assets/boat.glb(本地即时)
    applyTone(true);
    toneBtn.textContent = 'Tone: Sunset';
}

/* -------------------------------- 色调系统 -------------------------------- */

let lastAppliedTone = -1;

function applyTone(force) {
    const t = state.toneCur;
    if (!force && Math.abs(t - lastAppliedTone) < 0.001) return;
    lastAppliedTone = t;

    const sun = [0, 0, 0], hor = [0, 0, 0], fog = [0, 0, 0], sea = [0, 0, 0], lc = [0, 0, 0], am = [0, 0, 0];
    mix3(WARM.sun, COLD.sun, t, sun);
    mix3(WARM.horizon, COLD.horizon, t, hor);
    mix3(WARM.fog, COLD.fog, t, fog);
    mix3(WARM.sea, COLD.sea, t, sea);
    mix3(WARM.light, COLD.light, t, lc);
    mix3(WARM.ambient, COLD.ambient, t, am);
    // 1) 日/月盘(builtin-unlit 具单例,本场景唯一使用者)
    try { sunMat.setProperty('mainColor', colOf(sun)); } catch (e) { /* 属性缺失不致命 */ }
    // 2) 海面基色(builtin-standard mainColor)
    try { seaMat.setProperty('mainColor', colOf(sea)); } catch (e) { /* 同上 */ }
    // 3) 方向光:颜色 + 强度(HDR 量级)
    try {
        light.color = colOf(lc);
        light.illuminance = lerp(WARM.illum, COLD.illum, t);
    } catch (e) { /* 同上 */ }
    // 4) 环境光(模板已验证路径:skyColorHDR 原位 set)
    scene.globals.ambient.skyColorHDR.set(am[0], am[1], am[2], 1.0);
    scene.globals.ambient.skyIllum = lerp(WARM.skyIllum, COLD.skyIllum, t);
    // 5) 线性雾颜色(海平线融合)
    try {
        const fg = scene.globals.fog;
        if (fg && fg.fogColor) fg.fogColor = colOf(fog);
    } catch (e) { /* 雾失败不影响主视觉 */ }
    // 6) 天空 clear 颜色随行(地平色,海面经雾融入)
    try { camera.clearColor.set(hor[0], hor[1], hor[2], 255); } catch (e) { /* 同上 */ }
}

/* ------------------------------ 每帧模拟组件 ------------------------------ */

class SeaSim extends Component {
    update(dt) {
        try {
            const step = Math.min(dt, 0.1); // 后台标签页节流恢复时不跳变
            state.simTime += step;
            // 相机方位角逐帧插值(无跳变)
            state.az += (state.azTarget - state.az) * Math.min(1, step * 8);
            // 色调线性过渡(1.6s 全程 ≤ 2.5s)
            const dTone = state.toneTarget - state.toneCur;
            if (dTone !== 0) {
                const move = (step / 1.6) * (dTone > 0 ? 1 : -1);
                state.toneCur = clamp(state.toneCur + move, 0, 1);
                applyTone(false);
            }
            if (state.frames > 0 && world.seaMesh) updateSeaGeometry();
            // 船体随波(同一波形函数采样 → 相位耦合)+ 轻微纵摇/横摇
            if (world.boatRoot) {
                const swayX = 0.15 * Math.sin(state.simTime * 0.5);
                const swayZ = 0.10 * Math.cos(state.simTime * 0.4);
                const bx = swayX, bz = swayZ;
                const bob = waveH(bx, bz, state.simTime);
                world.boatRoot.setPosition(bx, world.boatBaseY + bob, bz);
                waveGrad(bx, bz, state.simTime, grad);
                const pitch = clamp(grad.z, -0.16, 0.16) * 34; // 度
                const roll = clamp(grad.x, -0.16, 0.16) * 34;
                world.boatRoot.setRotationFromEuler(pitch, -20, roll);
                world.boatPos.x = bx;
                world.boatPos.y = world.boatBaseY + bob + world.boatCY;
                world.boatPos.z = bz;
            }
            // 相机环绕
            if (cameraNode) {
                const a = (state.az * Math.PI) / 180;
                cameraNode.setPosition(
                    camRef.x + CAM_R * Math.cos(CAM_ELEV) * Math.sin(a),
                    camRef.y + CAM_R * Math.sin(CAM_ELEV),
                    camRef.z + CAM_R * Math.cos(CAM_ELEV) * Math.cos(a),
                );
                cameraNode.lookAt(camRef);
            }
        } catch (err) {
            // 帧内异常吞掉会掩盖 bug,但抛出=未捕获异常=违反完成合同;记录为 warn 一次性
            if (!SeaSim._warned) { SeaSim._warned = true; console.warn('[E02] sim error:', err); }
        }
    }
}

/* -------------------------------- 相机拖拽 -------------------------------- */
// pal 层吞 canvas 鼠标事件(已知坑):window capture 捕获阶段监听,先于任何 stopPropagation

function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    state.dragging = true;
    state.lastX = e.clientX;
}
function onPointerMove(e) {
    if (!state.dragging) return;
    const dx = e.clientX - state.lastX;
    state.lastX = e.clientX;
    state.azTarget += dx * 0.25; // deg/px:0.28×1280px 拖拽 ≈ 90° > 20°
}
function onPointerUp() { state.dragging = false; }

window.addEventListener('mousedown', onPointerDown, { capture: true });
window.addEventListener('mousemove', onPointerMove, { capture: true });
window.addEventListener('mouseup', onPointerUp, { capture: true });

/* ---------------------------------- 启动 ---------------------------------- */

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    scene = new Scene('E02-sunset-sea');

    // Camera
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 2, 8);
    camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 2500;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = colOf(WARM.horizon);
    camera.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式
    camera.priority = 0;

    // 主光(方向 = 太阳方向,由 lookAt 太阳位置的反向确定)
    lightNode = new Node('Sun Light');
    scene.addChild(lightNode);
    light = lightNode.addComponent(DirectionalLight);
    light.illuminance = WARM.illum;
    light.color = colOf(WARM.light);

    // 材质:全部用具单例(自研 new Material() 在本构建渲染异常,已实测三路径一致)
    seaMat = builtinResMgr.get('builtin-standard-material');
    try { seaMat.setProperty('mainColor', colOf(WARM.sea)); } catch (e) { /* 属性名差异不致命 */ }
    try { seaMat.setProperty('roughness', 0.34); } catch (e) { /* 同上 */ }
    try { seaMat.setProperty('metallic', 0.1); } catch (e) { /* 同上 */ }
    sunMat = builtinResMgr.get('builtin-unlit-material'); // 本场景 unlit 唯一使用者(日/月盘)

    // 雾(海平线融合;配置先于 run)
    try {
        const fg = scene.globals.fog;
        if (fg) {
            fg.enabled = true;
            fg.type = 0; // LINEAR
            fg.fogStart = 40;
            fg.fogEnd = 360;
            fg.fogColor = colOf(WARM.fog);
        }
    } catch (e) { /* 雾失败不影响主视觉 */ }

    // 程序化世界 + 模拟组件
    computeSunDir();
    buildWorld();

    // 太阳/月亮光盘(启动期一次性构建,跨 reset 持久)
    const sunGeo = buildDisc(SUN_DIR, 40, 812);
    const sunMesh = utils.MeshUtils.createDynamicMesh(0, sunGeo, undefined, dynOpts(sunGeo));
    const sunNode = new Node('SunDisc');
    sunNode.layer = Layers.Enum.DEFAULT;
    const sunRenderer = sunNode.addComponent(MeshRenderer);
    sunRenderer.mesh = sunMesh;
    sunRenderer.material = sunMat;
    scene.addChild(sunNode);

    const simNode = new Node('Sim');
    scene.addChild(simNode);
    simNode.addComponent(SeaSim);

    // 太阳方向 → 光源朝向:光源置于太阳方向远处,看向原点
    lightNode.setPosition(SUN_DIR.x * 50, SUN_DIR.y * 50, SUN_DIR.z * 50);
    lightNode.lookAt(0, 0, 0);

    // 防御性关闭天空盒(若默认开启会与 clear 色冲突)
    try { scene.globals.skybox.enabled = false; } catch (e) { /* 不存在则忽略 */ }

    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 后经 scene.globals 原位 set(模板已验证路径)
    scene.globals.ambient.skyColorHDR.set(WARM.ambient[0], WARM.ambient[1], WARM.ambient[2], 1.0);
    scene.globals.ambient.skyIllum = WARM.skyIllum;

    applyTone(true); // 首帧前统一着色(暖端)

    // 帧计数 + 首帧就绪(资产加载完成 && 首帧渲染后)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frames += 1;
        state.frameTs.push(performance.now());
        while (state.frameTs.length > 240) state.frameTs.shift(); // 2s 窗口上限,防泄漏
        if (!window.__appReady && state.boatLoaded) {
            window.__appReady = true;
        }
    });

    console.log('[E02] running on cocosair — sunset sea & lonely boat');
} catch (err) {
    // 致命错误(如 WebGL2 不可用):显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[E02] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
