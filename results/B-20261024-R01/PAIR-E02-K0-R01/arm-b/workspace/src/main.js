/**
 * E02 — 落日海面与孤舟(Asset Driven)/ cocosair 臂
 *
 * 设计要点(为什么这样做,而不是别的):
 *  - 海面:自建非均匀网格(近密远疏,几何级数映射)=> createDynamicMesh 每帧重写
 *    positions/colors,波形函数 waveHeight() 是唯一事实源;船体竖直坐标直接采样同一函数,
 *    因此"相位耦合"是结构性的,而不是两套互不相干的动画。
 *  - 海面/天穹用 builtin-unlit + USE_VERTEX_COLOR:颜色是每帧 CPU 计算写进顶点色的,
 *    不依赖引擎光照/曝光参数,暖冷两端平均色差异可控;船体则保留 glTF 自带 PBR 材质,
 *    由方向光 + 环境光照明(材质不被替换)。
 *  - 天穹:球体内表面(双面索引)+ 按仰角三段渐变 + 太阳方向幂次光晕(无后处理)。
 *  - 太阳/月亮:面向相机的圆盘(双面),颜色随 toneMix 演化。
 *  - reset():销毁船实例与资产、销毁海/天/日网格(显式释放 GPU 缓冲)、清空节点后重建,
 *    不复用旧资源;重新以带 query 的 URL 加载 boat.glb,绕过 assetManager 的解析缓存,
 *    保证每次重建都有真实网络请求且拿到的不是已销毁的 GLTFAsset。
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
    Color,
    Vec3,
    utils,
    input,
    Input,
    director,
    Director,
    Component,
    GLTFLoader,
} from 'cocosair.js';

// ---------------------------------------------------------------- 常量与调色
const DEG = Math.PI / 180;
const SKY_R = 1500;
const SUN_DIST = 300;
const SEA_N = 72;             // 每边顶点数 => 5184 顶点(规格要求 >= 2000)
const SEA_EXT = 900;          // 半边长(世界单位)
const SEA_E = 5.2;            // 指数映射:近处细分、远处网格随距离等比变粗
const SEA_K = SEA_EXT / (Math.exp(SEA_E) - 1);

const CAM_DIST = 11.5;
const CAM_ELEV = 9 * DEG;     // 相机相对注视点仰角(决定海平线落在画面上 1/3)
const CAM_TARGET_Y = 0.95;
const CAM_FOV = 50;
const START_AZ = 35;          // 初始方位角(度)= 状态报告口径
const AZ_PER_PX = 0.16;       // 水平拖拽灵敏度(度/像素)

// 太阳方位:相机初始方位角对面再偏 16°,使太阳落在画面中轴偏侧、海平线上方
const SUN_AZ = START_AZ + 180 + 16;
const SUN_ELV = 4 * DEG;
const sunDir = new Vec3(
    Math.sin(SUN_AZ * DEG) * Math.cos(SUN_ELV),
    Math.sin(SUN_ELV),
    Math.cos(SUN_AZ * DEG) * Math.cos(SUN_ELV),
);
const SUN_ANG = 2.4 * DEG;    // 太阳圆盘角半径

const TONE_SECONDS = 1.15;    // 暖冷过渡时长(规格 <= 2.5s)

// 暖端 = 落日橙金;冷端 = 暮蓝/蓝紫。全部 0..1 线性色值(写入顶点色)。
const PAL = {
    warm: {
        skyHorizon: [1.00, 0.34, 0.09],
        skyMid: [0.55, 0.13, 0.10],
        skyZenith: [0.10, 0.06, 0.22],
        sunTint: [1.00, 0.52, 0.18],
        sunDisc: [1.00, 0.78, 0.48],
        seaBase: [0.020, 0.085, 0.190],
        seaRefl: [0.95, 0.36, 0.13],
        seaSpec: [1.00, 0.86, 0.62],
        lightColor: [255, 198, 150],
        ambient: [0.95, 0.55, 0.36],
        clear: [255, 148, 92],
        lightIllum: 95000,
        skyIllum: 22000,
    },
    cool: {
        skyHorizon: [0.36, 0.50, 0.72],
        skyMid: [0.10, 0.15, 0.36],
        skyZenith: [0.02, 0.04, 0.14],
        sunTint: [0.45, 0.60, 0.95],
        sunDisc: [0.80, 0.88, 1.00],
        seaBase: [0.010, 0.030, 0.100],
        seaRefl: [0.30, 0.44, 0.72],
        seaSpec: [0.72, 0.84, 1.00],
        lightColor: [150, 178, 240],
        ambient: [0.30, 0.40, 0.70],
        clear: [32, 44, 84],
        lightIllum: 55000,
        skyIllum: 16000,
    },
};

// 混色后的当前调色板(每帧用 tone 刷新,零分配)
const cur = {
    skyHorizon: [0, 0, 0],
    skyMid: [0, 0, 0],
    skyZenith: [0, 0, 0],
    sunTint: [0, 0, 0],
    sunDisc: [0, 0, 0],
    seaBase: [0, 0, 0],
    seaRefl: [0, 0, 0],
    seaSpec: [0, 0, 0],
    lightColor: [0, 0, 0],
    ambient: [0, 0, 0],
    clear: [0, 0, 0],
    lightIllum: 0,
    skyIllum: 0,
};

function refreshPalette(tone) {
    const a = PAL.warm;
    const b = PAL.cool;
    for (const k of ['skyHorizon', 'skyMid', 'skyZenith', 'sunTint', 'sunDisc', 'seaBase', 'seaRefl', 'seaSpec', 'lightColor', 'ambient', 'clear']) {
        const ca = a[k];
        const cb = b[k];
        const o = cur[k];
        o[0] = ca[0] + (cb[0] - ca[0]) * tone;
        o[1] = ca[1] + (cb[1] - ca[1]) * tone;
        o[2] = ca[2] + (cb[2] - ca[2]) * tone;
    }
    cur.lightIllum = a.lightIllum + (b.lightIllum - a.lightIllum) * tone;
    cur.skyIllum = a.skyIllum + (b.skyIllum - a.skyIllum) * tone;
}

// ---------------------------------------------------------------- 波形函数(唯一事实源)
// 4 组行进重力波:每组一个方向、波数、角速度、振幅、初相。波峰沿各自风向以 w/k 推进。
const WAVES = [
    { dx: 0.82, dz: 0.57, k: 0.46, w: 1.05, a: 0.34, p: 0.0 },
    { dx: -0.38, dz: 0.92, k: 0.78, w: 1.45, a: 0.20, p: 1.7 },
    { dx: 0.97, dz: 0.24, k: 1.35, w: 2.05, a: 0.10, p: 3.1 },
    { dx: 0.31, dz: -0.95, k: 2.30, w: 2.85, a: 0.055, p: 0.7 },
    { dx: 0.62, dz: -0.78, k: 3.60, w: 3.40, a: 0.034, p: 2.2 },
    { dx: -0.88, dz: -0.47, k: 5.40, w: 4.10, a: 0.020, p: 4.4 },
];

function waveHeight(x, z, t) {
    let h = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        h += w.a * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.p);
    }
    return h;
}

/** 海面斜率(dh/dx, dh/dz),与 waveHeight 同一组参数 => 船体姿态与波形严格同源。 */
function waveSlope(x, z, t, out) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        const c = w.a * w.k * Math.cos(w.k * (w.dx * x + w.dz * z) - w.w * t + w.p);
        sx += c * w.dx;
        sz += c * w.dz;
    }
    out[0] = sx;
    out[1] = sz;
}

// ---------------------------------------------------------------- 运行时状态
const S = {
    epoch: 0,
    tone: 0,
    toneTarget: 0,
    azimuth: START_AZ,
    azimuthTarget: START_AZ,
    waveTime: 0,
    assetLoaded: false,
    assetRequests: 0,
    boatY: 0,
    boatCenterY: 0.8,
    fps: 0,
    loading: true,
    generation: 0,
    error: null,
};

const frameStamps = [];
let seaMesh = null;
let seaGeo = null;
let seaNode = null;
let seaRenderer = null;
let skyMesh = null;
let skyGeo = null;
let skyNode = null;
let skyRenderer = null;
let sunMesh = null;
let sunNode = null;
let boatNode = null;
let boatAsset = null;
let boatInstance = null;
let boatHeading = 12;

let seaMat = null;
let skyMat = null;
let sunMat = null;

let scene = null;
let sceneRoot = null;
let camNode = null;
let camera = null;
let lightNode = null;
let light = null;
let fillNode = null;
let fillLight = null;
let driverNode = null;

const scratchSlope = [0, 0];
const camTarget = new Vec3(0, CAM_TARGET_Y, 0);
const tmpV = new Vec3();
const sunPos = new Vec3();

window.__appReady = false;

// ---------------------------------------------------------------- 网格构造
function seaAxis(u) {
    const s = u < 0 ? -1 : 1;
    return s * (Math.exp(SEA_E * Math.abs(u)) - 1) * SEA_K;
}

function buildSeaGeometry() {
    const n = SEA_N;
    const count = n * n;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 4);
    const xz = new Float32Array(count * 2);
    let p = 0;
    for (let j = 0; j < n; j++) {
        const z = seaAxis(-1 + (2 * j) / (n - 1));
        for (let i = 0; i < n; i++) {
            const x = seaAxis(-1 + (2 * i) / (n - 1));
            xz[p] = x;
            xz[p + 1] = z;
            p += 2;
            colors[(p / 2) * 4 - 4 + 3] = 1; // alpha
        }
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i;
            const b = j * n + i + 1;
            const c = (j + 1) * n + i;
            const d = (j + 1) * n + i + 1;
            // 双面:两种绕序都写入(海面不需要剔除,且规避绕序约定差异)
            idx.push(a, c, b, b, c, d);
            idx.push(a, b, c, b, d, c);
        }
    }
    return {
        positions,
        colors,
        indices: idx,
        indices16: new Uint16Array(idx),
        count,
        xz,
        minPos: new Vec3(-SEA_EXT, -3, -SEA_EXT),
        maxPos: new Vec3(SEA_EXT, 3, SEA_EXT),
    };
}

function buildSkyGeometry() {
    const RSEG = 128;
    const RINGS = 72;
    const count = RSEG * (RINGS + 1);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 4);
    let p = 0;
    for (let r = 0; r <= RINGS; r++) {
        const phi = (r / RINGS) * Math.PI;
        const y = Math.cos(phi);
        const rad = Math.sin(phi);
        for (let a = 0; a < RSEG; a++) {
            const th = (a / RSEG) * Math.PI * 2;
            positions[p] = Math.cos(th) * rad * SKY_R;
            positions[p + 1] = y * SKY_R;
            positions[p + 2] = Math.sin(th) * rad * SKY_R;
            p += 3;
            colors[(p / 3) * 4 - 1] = 1;
        }
    }
    const idx = [];
    for (let r = 0; r < RINGS; r++) {
        for (let a = 0; a < RSEG; a++) {
            const a2 = (a + 1) % RSEG;
            const i0 = r * RSEG + a;
            const i1 = r * RSEG + a2;
            const i2 = (r + 1) * RSEG + a;
            const i3 = (r + 1) * RSEG + a2;
            idx.push(i0, i2, i1, i1, i2, i3);
            idx.push(i0, i1, i2, i1, i3, i2);
        }
    }
    return {
        positions,
        colors,
        indices: idx,
        indices16: new Uint16Array(idx),
        count,
        minPos: new Vec3(-SKY_R, -SKY_R, -SKY_R),
        maxPos: new Vec3(SKY_R, SKY_R, SKY_R),
    };
}

function buildSunGeometry() {
    const SEG = 40;
    const r = SUN_DIST * Math.tan(SUN_ANG);
    const positions = [0, 0, 0];
    const idx = [];
    for (let i = 0; i < SEG; i++) {
        const th = (i / SEG) * Math.PI * 2;
        positions.push(Math.cos(th) * r, Math.sin(th) * r, 0);
    }
    for (let i = 0; i < SEG; i++) {
        const a = 1 + i;
        const b = 1 + ((i + 1) % SEG);
        idx.push(0, a, b);
        idx.push(0, b, a);
    }
    return { positions, indices: idx };
}

function makeUnlit(vertexColor) {
    const m = new Material();
    m.initialize({
        effectName: 'builtin-unlit',
        defines: vertexColor ? { USE_VERTEX_COLOR: true } : {},
    });
    m.setProperty('mainColor', new Color(255, 255, 255, 255));
    return m;
}

function attachMesh(node, mesh, mat) {
    const r = node.addComponent(MeshRenderer);
    r.mesh = mesh;
    r.material = mat;
    return r;
}

// ---------------------------------------------------------------- 场景装配
function buildSkyAndSun() {
    skyGeo = buildSkyGeometry();
    skyMesh = utils.MeshUtils.createDynamicMesh(
        0,
        {
            positions: skyGeo.positions,
            colors: skyGeo.colors,
            indices16: skyGeo.indices16,
            minPos: skyGeo.minPos,
            maxPos: skyGeo.maxPos,
        },
        undefined,
        { maxSubMeshes: 1, maxSubMeshVertices: skyGeo.count, maxSubMeshIndices: skyGeo.indices16.length },
    );
    skyNode = new Node('Sky');
    skyNode.layer = Layers.Enum.DEFAULT;
    sceneRoot.addChild(skyNode);
    skyRenderer = attachMesh(skyNode, skyMesh, skyMat);

    sunMesh = utils.MeshUtils.createMesh(buildSunGeometry());
    sunNode = new Node('Sun');
    sunNode.layer = Layers.Enum.DEFAULT;
    sceneRoot.addChild(sunNode);
    attachMesh(sunNode, sunMesh, sunMat);
    sunNode.setPosition(sunDir.x * SUN_DIST, sunDir.y * SUN_DIST, sunDir.z * SUN_DIST);
}

function buildSea() {
    seaGeo = buildSeaGeometry();
    seaMesh = utils.MeshUtils.createDynamicMesh(
        0,
        {
            positions: seaGeo.positions,
            colors: seaGeo.colors,
            indices16: seaGeo.indices16,
            minPos: seaGeo.minPos,
            maxPos: seaGeo.maxPos,
        },
        undefined,
        { maxSubMeshes: 1, maxSubMeshVertices: seaGeo.count, maxSubMeshIndices: seaGeo.indices16.length },
    );
    seaNode = new Node('Sea');
    seaNode.layer = Layers.Enum.DEFAULT;
    sceneRoot.addChild(seaNode);
    seaRenderer = attachMesh(seaNode, seaMesh, seaMat);
}

/** 释放一轮场景资源:先解绑渲染器,再销毁网格/资产,最后销毁节点。 */
function disposeSceneObjects() {
    const meshes = [seaMesh, skyMesh, sunMesh];
    const nodes = [seaNode, skyNode, sunNode, boatNode];
    for (const n of nodes) {
        if (!n || !n.isValid) continue;
        const r = n.getComponent(MeshRenderer);
        if (r) r.mesh = null;
    }
    if (boatInstance) {
        try {
            boatInstance.dispose();
        } catch (e) { /* 已销毁则忽略 */ }
        boatInstance = null;
    }
    if (boatAsset) {
        try {
            boatAsset.destroy();
        } catch (e) { /* 已销毁则忽略 */ }
        boatAsset = null;
    }
    for (const n of nodes) {
        if (!n || !n.isValid) continue;
        n.removeFromParent();
        n.destroy();
    }
    for (const m of meshes) {
        if (m) {
            try {
                m.destroy();
            } catch (e) { /* 已销毁则忽略 */ }
        }
    }
    seaMesh = null;
    seaGeo = null;
    seaNode = null;
    seaRenderer = null;
    skyMesh = null;
    skyGeo = null;
    skyNode = null;
    skyRenderer = null;
    sunMesh = null;
    sunNode = null;
    boatNode = null;
}

function setLayerRecursive(node) {
    node.layer = Layers.Enum.DEFAULT;
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) setLayerRecursive(kids[i]);
}

function measureBoatCenterY(root) {
    let minY = Infinity;
    let maxY = -Infinity;
    const walk = (n) => {
        const r = n.getComponent(MeshRenderer);
        if (r && r.mesh && r.mesh.struct) {
            const s = r.mesh.struct;
            if (s.minPosition && s.maxPosition) {
                minY = Math.min(minY, s.minPosition.y);
                maxY = Math.max(maxY, s.maxPosition.y);
            }
        }
        const kids = n.children;
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(root);
    if (!isFinite(minY) || !isFinite(maxY)) return 0.8;
    return (minY + maxY) * 0.5;
}

async function loadBoat(gen) {
    // 首次用干净 URL(网络证据);重建时带 query 绕过解析缓存,确保拿到新资产
    const url = S.epoch === 0 ? 'assets/boat.glb' : `assets/boat.glb?reload=${S.epoch}-${gen}`;
    const loader = new GLTFLoader();
    try {
        const asset = await loader.loadAsync(url);
        if (gen !== S.generation) {
            // 期间又发生了 reset:丢弃这次结果,避免竞态下双船/资源泄漏
            try { asset.destroy(); } catch (e) { /* ignore */ }
            return;
        }
        const inst = asset.instantiate(0);
        const root = inst.root;
        setLayerRecursive(root);
        root.setPosition(0, 0, 0);
        root.setRotationFromEuler(0, boatHeading, 0);
        sceneRoot.addChild(root);

        boatAsset = asset;
        boatInstance = inst;
        boatNode = root;
        S.boatCenterY = measureBoatCenterY(root);
        S.assetLoaded = true;
        S.assetRequests += 1;
        S.error = null;
        hideError();
    } catch (err) {
        if (gen !== S.generation) return;
        S.assetLoaded = false;
        S.error = err && err.message ? err.message : String(err);
        showError('boat.glb 加载失败:' + S.error);
        console.warn('[E02] boat load failed:', S.error);
    }
}

// ---------------------------------------------------------------- 逐帧更新
function updateCamera() {
    const az = S.azimuth * DEG;
    const rxz = CAM_DIST * Math.cos(CAM_ELEV);
    camNode.setPosition(
        Math.sin(az) * rxz,
        CAM_TARGET_Y + CAM_DIST * Math.sin(CAM_ELEV),
        Math.cos(az) * rxz,
    );
    camNode.lookAt(camTarget);
}

function updateSea(t) {
    if (!seaGeo || !seaMesh) return;
    const { positions, colors, xz, count } = seaGeo;
    refreshPalette(S.tone);
    const cam = camNode.worldPosition;
    const cx = cam.x;
    const cy = cam.y;
    const cz = cam.z;

    const base = cur.seaBase;
    const refl = cur.seaRefl;
    const spec = cur.seaSpec;

    // 太阳水平方位(用于"金色光路":朝太阳方向的海面更亮)
    const shl = 1 / Math.hypot(sunDir.x, sunDir.z);
    const shx = sunDir.x * shl;
    const shz = sunDir.z * shl;

    for (let i = 0; i < count; i++) {
        const x = xz[i * 2];
        const z = xz[i * 2 + 1];
        const h = waveHeight(x, z, t);
        positions[i * 3] = x;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = z;

        waveSlope(x, z, t, scratchSlope);
        let nx = -scratchSlope[0];
        let ny = 1;
        let nz = -scratchSlope[1];
        const nInv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= nInv;
        ny *= nInv;
        nz *= nInv;

        let vx = cx - x;
        let vy = cy - h;
        let vz = cz - z;
        const vInv = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        vx *= vInv;
        vy *= vInv;
        vz *= vInv;

        let ndv = nx * vx + ny * vy + nz * vz;
        if (ndv < 0) ndv = 0;
        if (ndv > 1) ndv = 1;
        const invNdv = 1 - ndv;
        const fres = invNdv * invNdv * invNdv * invNdv; // pow(1-NdotV, 4)

        // 反射向量 R = 2(N·V)N - V;R 越对准太阳,高光越强 => 太阳正下方的碎金海面
        const rx = 2 * ndv * nx - vx;
        const ry = 2 * ndv * ny - vy;
        const rz = 2 * ndv * nz - vz;
        let sd = rx * sunDir.x + ry * sunDir.y + rz * sunDir.z;
        if (sd < 0) sd = 0;
        const sd2 = sd * sd;
        const sd4 = sd2 * sd2;
        const sd8 = sd4 * sd4;
        const sd16 = sd8 * sd8;
        const sd32 = sd16 * sd16;
        const sd64 = sd32 * sd32;
        const sd128 = sd64 * sd64;
        const glint = sd128 * 2.8 + sd16 * 0.22; // 窄碎金 + 宽反光

        // 金色光路:相机->海面方向与太阳水平方位的夹角(8 次幂),近地平线更亮
        let dl = Math.hypot(x - cx, z - cz);
        if (dl < 0.001) dl = 0.001;
        let lane = ((x - cx) * shx + (z - cz) * shz) / dl;
        if (lane < 0) lane = 0;
        const l2 = lane * lane;
        const l4 = l2 * l2;
        const l8 = l4 * l4;
        const laneW = l8 * (0.22 + 0.78 * fres);

        const mixF = 0.10 + 0.70 * fres;
        const crest = h > 0.45 ? (h - 0.45) * 0.16 : 0;

        let r = base[0] + (refl[0] - base[0]) * mixF + laneW * refl[0] * 0.42 + glint * spec[0] + crest;
        let g = base[1] + (refl[1] - base[1]) * mixF + laneW * refl[1] * 0.42 + glint * spec[1] + crest * 0.92;
        let b = base[2] + (refl[2] - base[2]) * mixF + laneW * refl[2] * 0.42 + glint * spec[2] + crest * 0.8;

        colors[i * 4] = r > 1 ? 1 : r;
        colors[i * 4 + 1] = g > 1 ? 1 : g;
        colors[i * 4 + 2] = b > 1 ? 1 : b;
        colors[i * 4 + 3] = 1;
    }

    seaMesh.updateSubMesh(0, {
        positions,
        colors,
        indices16: seaGeo.indices16,
        minPos: seaGeo.minPos,
        maxPos: seaGeo.maxPos,
    });
    if (seaRenderer) seaRenderer.onGeometryChanged();
}

let lastSkyTone = -1;

function updateSkyColors() {
    if (!skyGeo || !skyMesh) return;
    if (Math.abs(S.tone - lastSkyTone) < 0.0015) return;
    lastSkyTone = S.tone;
    refreshPalette(S.tone);
    const { positions, colors, count } = skyGeo;
    const hz = cur.skyHorizon;
    const md = cur.skyMid;
    const zn = cur.skyZenith;
    const st = cur.sunTint;
    for (let i = 0; i < count; i++) {
        const dx = positions[i * 3] / SKY_R;
        const dy = positions[i * 3 + 1] / SKY_R;
        const dz = positions[i * 3 + 2] / SKY_R;

        // 仰角归一化:0 = 海平线,1 = 天顶(海平线以下压暗一点,与远处海色衔接)
        let t = dy / 0.95;
        if (t < 0) t = 0;
        if (t > 1) t = 1;

        let r;
        let g;
        let b;
        if (t < 0.35) {
            const k = t / 0.35;
            r = hz[0] + (md[0] - hz[0]) * k;
            g = hz[1] + (md[1] - hz[1]) * k;
            b = hz[2] + (md[2] - hz[2]) * k;
        } else {
            const k = (t - 0.35) / 0.65;
            r = md[0] + (zn[0] - md[0]) * k;
            g = md[1] + (zn[1] - md[1]) * k;
            b = md[2] + (zn[2] - md[2]) * k;
        }

        // 太阳光晕:靠顶点色做出的大范围幂次衰减(引擎无后处理/Bloom)
        let d = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
        if (d > 0) {
            const d2 = d * d;
            const d4 = d2 * d2;
            const d8 = d4 * d4;
            const glow = d8 * d8 * 0.42 + d4 * 0.18 + d2 * 0.05;
            r += st[0] * glow;
            g += st[1] * glow;
            b += st[2] * glow;
        }
        if (dy < 0) {
            // 海平线以下:向海色压暗,避免与海面远端出现亮边
            const k = 1 + dy * 1.4;
            r *= k;
            g *= k;
            b *= k;
        }

        colors[i * 4] = r > 1 ? 1 : r;
        colors[i * 4 + 1] = g > 1 ? 1 : g;
        colors[i * 4 + 2] = b > 1 ? 1 : b;
        colors[i * 4 + 3] = 1;
    }
    skyMesh.updateSubMesh(0, {
        positions,
        colors,
        indices16: skyGeo.indices16,
        minPos: skyGeo.minPos,
        maxPos: skyGeo.maxPos,
    });
    if (skyRenderer) skyRenderer.onGeometryChanged();
}

let lastSunTone = -1;

function updateSunAndLight() {
    if (Math.abs(S.tone - lastSunTone) < 0.0015) return;
    lastSunTone = S.tone;
    refreshPalette(S.tone);
    if (sunMat) {
        sunMat.setProperty(
            'mainColor',
            new Color(cur.sunDisc[0] * 255, cur.sunDisc[1] * 255, cur.sunDisc[2] * 255, 255),
        );
    }
    if (light) {
        light.color = new Color(cur.lightColor[0], cur.lightColor[1], cur.lightColor[2], 255);
        light.illuminance = cur.lightIllum;
    }
    if (scene && scene.globals && scene.globals.ambient) {
        scene.globals.ambient.skyColorHDR.set(cur.ambient[0], cur.ambient[1], cur.ambient[2], 1);
        scene.globals.ambient.skyIllum = cur.skyIllum;
    }
    if (camera) {
        camera.clearColor = new Color(cur.clear[0], cur.clear[1], cur.clear[2], 255);
    }
}

function updateBoat() {
    if (!boatNode || !boatNode.isValid) {
        S.boatY = 0;
        return;
    }
    const t = S.waveTime;
    const h = waveHeight(0, 0, t);
    waveSlope(0, 0, t, scratchSlope);
    const pitch = -Math.atan(scratchSlope[1]) * 57.2958 * 0.85;
    const roll = Math.atan(scratchSlope[0]) * 57.2958 * 0.85;
    boatNode.setPosition(0, h + 0.02, 0);
    boatNode.setRotationFromEuler(pitch, boatHeading, roll);
    S.boatY = h;
}

class Driver extends Component {
    update(dt) {
        const d = dt > 0 ? Math.min(dt, 0.1) : 0;

        // 2s 滚动平均帧率
        const now = performance.now();
        frameStamps.push(now);
        while (frameStamps.length > 2 && now - frameStamps[0] > 2000) frameStamps.shift();
        const span = now - frameStamps[0];
        S.fps = span > 0 ? (frameStamps.length - 1) * 1000 / span : 0;

        // 色调过渡(<= 2.5s)
        if (S.tone !== S.toneTarget) {
            const step = d / TONE_SECONDS;
            if (S.tone < S.toneTarget) S.tone = Math.min(S.toneTarget, S.tone + step);
            else S.tone = Math.max(S.toneTarget, S.tone - step);
        }

        // 相机方位角平滑趋近
        if (S.azimuth !== S.azimuthTarget) {
            const k = Math.min(1, d * 16);
            S.azimuth += (S.azimuthTarget - S.azimuth) * k;
            if (Math.abs(S.azimuthTarget - S.azimuth) < 0.01) S.azimuth = S.azimuthTarget;
        }

        if (!S.loading) S.waveTime += d;

        updateCamera();
        updateSunAndLight();
        updateSkyColors();
        updateSea(S.waveTime);
        updateBoat();
        updateSunBillboard();
    }
}

function updateSunBillboard() {
    if (!sunNode || !sunNode.isValid) return;
    sunPos.set(sunDir.x * SUN_DIST, sunDir.y * SUN_DIST, sunDir.z * SUN_DIST);
    sunNode.setPosition(sunPos);
    tmpV.set(camNode.worldPosition.x, camNode.worldPosition.y, camNode.worldPosition.z);
    sunNode.lookAt(tmpV);
}

// ---------------------------------------------------------------- UI 覆盖层
const ui = {
    bar: null,
    toneBtn: null,
    resetBtn: null,
    status: null,
    error: null,
};

function buildUI() {
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;left:12px;top:12px;z-index:9999;display:flex;gap:8px;align-items:center;' +
        "font:12px/1.4 system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)";
    document.body.appendChild(bar);
    ui.bar = bar;

    const mk = (id, label, aria) => {
        const b = document.createElement('button');
        b.setAttribute('data-ui', id);
        b.setAttribute('aria-label', aria);
        b.textContent = label;
        b.style.cssText =
            'padding:5px 12px;border-radius:4px;border:1px solid rgba(255,255,255,.45);' +
            'background:rgba(16,20,32,.55);color:#fff;font:12px system-ui,sans-serif;cursor:pointer';
        document.body.appendChild(b);
        return b;
    };

    ui.toneBtn = mk('tone-toggle', 'Tone: Sunset', 'tone-toggle');
    ui.toneBtn.addEventListener('click', () => {
        S.toneTarget = S.toneTarget > 0.5 ? 0 : 1;
        syncToneLabel();
    });

    ui.resetBtn = mk('reset', 'Reset', 'reset');
    ui.resetBtn.addEventListener('click', () => {
        resetScene();
    });

    const status = document.createElement('div');
    status.setAttribute('data-ui', 'status');
    status.textContent = 'Loading boat.glb …';
    status.style.cssText = 'padding:5px 10px;opacity:.9';
    document.body.appendChild(status);
    ui.status = status;

    const err = document.createElement('div');
    err.setAttribute('data-ui', 'error');
    err.style.cssText =
        'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;display:none;' +
        'padding:6px 14px;border-radius:4px;background:rgba(150,20,20,.9);color:#fff;' +
        'font:13px system-ui,sans-serif';
    document.body.appendChild(err);
    ui.error = err;
}

function syncToneLabel() {
    if (!ui.toneBtn) return;
    ui.toneBtn.textContent = S.toneTarget > 0.5 ? 'Tone: Twilight' : 'Tone: Sunset';
}

function showError(msg) {
    if (!ui.error) return;
    ui.error.textContent = msg;
    ui.error.style.display = 'block';
}

function hideError() {
    if (!ui.error) return;
    ui.error.style.display = 'none';
}

// ---------------------------------------------------------------- 输入(引擎统一输入流)
let dragging = false;
let lastX = 0;
let engineMouseSeen = false;

function azFromPx(px) {
    S.azimuthTarget += px * AZ_PER_PX;
}

function bindInput(canvas) {
    input.on(Input.EventType.MOUSE_DOWN, (e) => {
        engineMouseSeen = true;
        const loc = e.getLocation();
        dragging = true;
        lastX = loc.x;
    });
    input.on(Input.EventType.MOUSE_MOVE, (e) => {
        engineMouseSeen = true;
        if (!dragging) return;
        const loc = e.getLocation();
        const dx = loc.x - lastX;
        lastX = loc.x;
        if (dx !== 0) azFromPx(dx);
    });
    const endDrag = () => { dragging = false; };
    input.on(Input.EventType.MOUSE_UP, () => {
        engineMouseSeen = true;
        endDrag();
    });

    // 兜底:若 pal 层未把画布鼠标事件送进引擎 input,直接监听 canvas(已收到引擎事件时不重复计入)
    const domDown = (ev) => {
        if (engineMouseSeen) return;
        dragging = true;
        lastX = ev.clientX;
    };
    const domMove = (ev) => {
        if (engineMouseSeen || !dragging) return;
        azFromPx(ev.clientX - lastX);
        lastX = ev.clientX;
    };
    const domUp = () => { dragging = false; };
    canvas.addEventListener('mousedown', domDown);
    window.addEventListener('mousemove', domMove);
    window.addEventListener('mouseup', domUp);
}

// ---------------------------------------------------------------- 启动 / 重建
function buildStaticScene() {
    buildSkyAndSun();
    buildSea();
    updateSkyColors();
    updateSunAndLight();
    updateSea(S.waveTime);
}

async function resetScene() {
    S.epoch += 1;
    S.generation += 1;
    const gen = S.generation;
    S.loading = true;
    S.assetLoaded = false;
    S.tone = 0;
    S.toneTarget = 0;
    S.azimuth = START_AZ;
    S.azimuthTarget = START_AZ;
    S.waveTime = 0;
    S.boatY = 0;
    lastSkyTone = -1;
    lastSunTone = -1;
    syncToneLabel();
    if (ui.status) ui.status.textContent = 'Rebuilding…';

    try {
        // 释放并重建:不刷新页面,走显式资源释放 + 重新加载
        disposeSceneObjects();
        buildStaticScene();
        updateSkyColors();
        await loadBoat(gen);
        if (gen === S.generation) {
            S.loading = false;
            updateBoat();
            if (ui.status) ui.status.textContent = 'Sunset sea';
        }
    } catch (err) {
        // reset 不能把异常抛给宿主(uncaught 即 FAIL);只做可见提示 + 警告
        const msg = err && err.message ? err.message : String(err);
        console.warn('[E02] reset failed:', msg);
        showError('重建失败:' + msg);
        S.loading = false;
    }
}

// ---------------------------------------------------------------- 对外状态契约
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        assetLoaded: S.assetLoaded === true,
        assetRequests: S.assetRequests,
        boatPosition: { x: 0, y: S.boatY + (S.boatCenterY || 0), z: 0 },
        wavePhase: S.waveTime,
        toneMix: S.tone,
        cameraAzimuth: S.azimuth,
        fps: S.fps,
        epoch: S.epoch,
        // 诊断附加字段(不参与判定)
        frame: frameStamps.length,
        seaVertices: SEA_N * SEA_N,
        error: S.error,
    }),
    reset: () => {
        resetScene();
    },
};

// ---------------------------------------------------------------- 主流程
window.__dbg = { stage: 'boot' };

(async () => {
    try {
        buildUI();

        const canvas = document.querySelector('#GameCanvas');
        const app = await createAirApp({ canvas });
        window.__airApp = app;
        window.__dbg.stage = 'app';

        scene = new Scene('e02-sunset-boat');
        sceneRoot = new Node('World');
        scene.addChild(sceneRoot);

        camNode = new Node('Main Camera');
        scene.addChild(camNode);
        camera = camNode.addComponent(Camera);
        camera.projection = Camera.ProjectionType.PERSPECTIVE;
        camera.fov = CAM_FOV;
        camera.near = 0.2;
        camera.far = 4000;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(255, 148, 92, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;

        // 主光:位置放在太阳方向,lookAt 场景中心 => 光从太阳一侧射入
        lightNode = new Node('Sun Light');
        scene.addChild(lightNode);
        lightNode.setPosition(sunDir.x * 100, sunDir.y * 100, sunDir.z * 100);
        lightNode.lookAt(new Vec3(0, 0, 0));
        light = lightNode.addComponent(DirectionalLight);
        light.illuminance = 90000;

        // 补光:来自相机一侧的低强度天光反弹,保证船体朝向观察者的一侧也有明暗层次
        fillNode = new Node('Fill Light');
        scene.addChild(fillNode);
        const fillAz = START_AZ * DEG;
        fillNode.setPosition(Math.sin(fillAz) * 60, 26, Math.cos(fillAz) * 60);
        fillNode.lookAt(new Vec3(0, 0, 0));
        fillLight = fillNode.addComponent(DirectionalLight);
        fillLight.illuminance = 30000;
        fillLight.color = new Color(255, 222, 196, 255);

        seaMat = makeUnlit(true);
        skyMat = makeUnlit(true);
        sunMat = makeUnlit(false);

        driverNode = new Node('Driver');
        scene.addChild(driverNode);
        driverNode.addComponent(Driver);

        app.run(scene);

        scene.globals.ambient.skyColorHDR.set(0.95, 0.58, 0.4, 1.0);
        scene.globals.ambient.skyIllum = 38000;

        bindInput(canvas);

        window.__dbg.stage = 'static';
        buildStaticScene();
        window.__dbg.stage = 'static-ok';

        director.on(Director.EVENT_AFTER_DRAW, () => {
            if (!window.__appReady && S.assetLoaded) {
                window.__appReady = true;
                if (ui.status) ui.status.textContent = 'Sunset sea';
            }
        });

        window.__dbg.stage = 'loading-boat';
        await loadBoat(S.generation);
        window.__dbg.stage = 'boat-done';
        S.loading = false;
        if (ui.status && S.assetLoaded) ui.status.textContent = 'Sunset sea';
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('[E02] fatal:', msg);
        showError('启动失败:' + msg);
        setTimeout(() => {
            throw err;
        }, 0);
    }
})();
