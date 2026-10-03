/**
 * E02 — 落日海面与孤舟(cocosair,K0)
 *
 * 实现要点(spec.json 冻结契约):
 *   - 运行时经 GLTFLoader.loadAsync('assets/boat.glb') 发起真实网络请求加载共享资产,
 *     材质全部保留(资产内嵌 pbrMetallicRoughness,受主光 + 环境光照明,受光/背光面可辨)。
 *   - 海面:动态网格(51×51 = 2601 顶点 ≥ 2000,近密远疏非均匀网格),每帧 CPU 求值
 *     三向叠加重力波(位置 + 解析法线)经 mesh.updateSubMesh 上传;builtin-standard 材质受光,
 *     波面法线随波形运动产生真实明暗与太阳镜面高光带;wavePhase(模拟时间)单调递增。
 *   - 船体随波起伏:锚点 Y 取 waveH(0,0,t),纵横摇取波形梯度 —— 与海面同一波形函数(相位耦合)。
 *   - 天穹:倒扣球面穹顶 + 地平带两层 unlit(暖金落日 ↔ 暮蓝冷色,mainColor 随 toneMix 演变);
 *     日/月光盘 + 光晕同轴放置。
 *   - 相机:绕孤舟环绕,方位角初始 35°,水平拖拽 → 目标方位角(1.4°/px),指数平滑(τ=0.5s,无跳变)。
 *   - 色调:toneMix 0=暖(落日)↔ 1=冷(暮蓝);天穹/海面反照率与自发光、主光色温、环境光、
 *     光盘颜色同步演变,τ=0.45s 过渡 < 2.5s。
 *   - Reset:显式释放(gltfAsset.destroy + instance.dispose、自建 mesh/material.destroy —— GPU 资源释放)
 *     后重建,重新网络加载 assets/boat.glb,恢复 toneMix=0、方位角 35°、模拟时间 0,epoch+1,非整页刷新。
 *
 * 页面契约:window.__appReady(资产加载完成且首帧渲染后置 true);
 *           window.__bench = { getState, reset }(字段见 spec.json stateContract)。
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
    Material,
    GLTFLoader,
    macro,
} from 'cocosair.js';

// 无头/软件渲染下禁用 MSAA(引擎宏,须在设备创建前设置)
macro.ENABLE_WEBGL_ANTIALIAS = false;

// ============================================================
// 常量与调色板
// ============================================================
const GLB_URL = 'assets/boat.glb';
const INITIAL_AZIMUTH = 35; // 度
const CAM_RADIUS = 8.5;
const CAM_ELEV = 9.5 * Math.PI / 180;
const CAM_LOOK = new Vec3(0, 1.15, 0);
const AZ_SENS = 1.4;   // 拖拽灵敏度:度 / 像素
const AZ_TAU = 0.5;    // 方位角指数平滑时间常数(秒)
const TONE_TAU = 0.45; // 色调过渡时间常数(秒)
const WATERLINE = -0.12;

// 色调调色板([r,g,b] 0-255;ambient 为 HDR 0-1)
const PAL = {
    clear: [[255, 176, 96], [24, 34, 84]],
    skyDome: [[98, 86, 160], [8, 16, 54]],
    skyBand: [[255, 178, 102], [96, 94, 178]],
    sunCore: [[255, 238, 190], [232, 240, 255]],
    sunHalo: [[255, 168, 84], [128, 152, 228]],
    light: [[255, 208, 140], [142, 172, 255]],
    ambient: [[0.42, 0.34, 0.30], [0.16, 0.22, 0.42]],
    seaMain: [[70, 112, 140], [20, 42, 78]],
    seaEmissive: [[36, 64, 86], [10, 22, 44]],
    seaRough: [0.28, 0.38],
};

function mix255(key, t) {
    const w = PAL[key][0], c = PAL[key][1];
    return new Color(w[0] + (c[0] - w[0]) * t, w[1] + (c[1] - w[1]) * t, w[2] + (c[2] - w[2]) * t, 255);
}
function mixNum(key, t) {
    const w = PAL[key][0], c = PAL[key][1];
    return w + (c - w) * t;
}
function mixRaw(key, t, out) {
    const w = PAL[key][0], c = PAL[key][1];
    out[0] = (w[0] + (c[0] - w[0]) * t) / 255;
    out[1] = (w[1] + (c[1] - w[1]) * t) / 255;
    out[2] = (w[2] + (c[2] - w[2]) * t) / 255;
    return out;
}

// ============================================================
// 波形(海面与船体共用同一函数 —— 相位耦合)
// ============================================================
const WAVE_DEFS = [
    { dx: 0.94, dz: 0.34, k: (Math.PI * 2) / 11.0, w: (Math.PI * 2) / 2.37, a: 0.22 },
    { dx: -0.53, dz: 0.85, k: (Math.PI * 2) / 4.6, w: (Math.PI * 2) / 1.43, a: 0.12 },
    { dx: 0.37, dz: -0.93, k: (Math.PI * 2) / 2.1, w: (Math.PI * 2) / 0.91, a: 0.055 },
];
function waveH(x, z, t) {
    let h = 0;
    for (let i = 0; i < 3; i++) {
        const w = WAVE_DEFS[i];
        h += w.a * Math.sin((x * w.dx + z * w.dz) * w.k - w.w * t);
    }
    return h;
}
function waveGrad(x, z, t, out) {
    let gx = 0, gz = 0;
    for (let i = 0; i < 3; i++) {
        const w = WAVE_DEFS[i];
        const c = w.a * w.k * Math.cos((x * w.dx + z * w.dz) * w.k - w.w * t);
        gx += c * w.dx;
        gz += c * w.dz;
    }
    out.x = gx; out.z = gz;
}

// ============================================================
// 全局状态 + 页面契约
// ============================================================
const state = {
    assetLoaded: false,
    assetRequests: 0,
    boatPos: { x: 0, y: 0, z: 0 },
    wavePhase: 0,
    toneMix: 0,
    toneTarget: 0,
    azimuth: INITIAL_AZIMUTH,
    azimuthTarget: INITIAL_AZIMUTH,
    fps: 0,
    epoch: 0,
    simTime: 0,
    frames: 0,
    ready: false,
    token: 0,
};

window.__appReady = false;
window.__bench = {
    getState: () => ({
        assetLoaded: state.assetLoaded === true,
        assetRequests: state.assetRequests,
        boatPosition: { x: state.boatPos.x, y: state.boatPos.y, z: state.boatPos.z },
        wavePhase: state.wavePhase,
        toneMix: state.toneMix,
        cameraAzimuth: state.azimuth,
        fps: state.fps,
        epoch: state.epoch,
    }),
    reset: () => doReset(),
};

// ============================================================
// UI 覆盖层(data-ui + aria-label + 可见文本三重定位)
// ============================================================
function makeButton(text, aria, onClick, right) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.setAttribute('data-ui', aria);
    btn.setAttribute('aria-label', aria);
    btn.style.cssText =
        `position:fixed;top:8px;${right ? 'right:8px' : 'right:110px'};z-index:9999;padding:5px 14px;` +
        'font:13px sans-serif;background:#1c2230cc;color:#fff;border:1px solid #5a6b8a;' +
        'border-radius:5px;cursor:pointer';
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    return btn;
}
const toneBtn = makeButton('Tone: Sunset', 'tone-toggle', () => {
    state.toneTarget = state.toneTarget > 0.5 ? 0 : 1;
    toneBtn.textContent = state.toneTarget > 0.5 ? 'Tone: Moonlight' : 'Tone: Sunset';
}, false);
makeButton('Reset', 'reset', () => doReset(), true);

const statusDiv = document.createElement('div');
statusDiv.style.cssText =
    'position:fixed;left:12px;bottom:10px;z-index:9999;font:13px sans-serif;color:#ffe8c4;' +
    'text-shadow:0 1px 3px #0009;pointer-events:none';
statusDiv.textContent = 'Loading boat.glb …';
document.body.appendChild(statusDiv);
function showError(msg) {
    statusDiv.textContent = `Failed to load assets/boat.glb: ${msg}`;
    statusDiv.style.color = '#ff7b6b';
}

// ============================================================
// 网格工具
// ============================================================
function buildDynamicMesh(geom, maxVerts, maxIndices) {
    const mesh = utils.MeshUtils.createDynamicMesh(0, geom, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: maxVerts,
        maxSubMeshIndices: maxIndices,
    });
    mesh.updateSubMesh(0, {
        positions: geom.positions,
        normals: geom.normals,
        uvs: geom.uvs,
        indices32: geom.indices32,
        minPos: geom.minPos,
        maxPos: geom.maxPos,
    });
    return mesh;
}

/** 球面网格(天穹倒扣 / 日月光盘 / 地平带)。thetaRange = [起,止](弧度,自天顶)。 */
function buildSphere(radius, rows, cols, invert, withUv, thetaRange) {
    const t0 = thetaRange ? thetaRange[0] : 0;
    const t1 = thetaRange ? thetaRange[1] : Math.PI;
    const verts = (rows + 1) * (cols + 1);
    const positions = new Float32Array(verts * 3);
    const uvs = withUv ? new Float32Array(verts * 2) : undefined;
    const indices = new Uint32Array(rows * cols * 6);
    let p = 0, u = 0;
    for (let r = 0; r <= rows; r++) {
        const theta = t0 + (r / rows) * (t1 - t0);
        const sy = Math.cos(theta), sr = Math.sin(theta);
        for (let c = 0; c <= cols; c++) {
            const phi = (c / cols) * Math.PI * 2;
            positions[p++] = sr * Math.cos(phi) * radius;
            positions[p++] = sy * radius;
            positions[p++] = sr * Math.sin(phi) * radius;
            if (withUv) {
                uvs[u++] = 0;
                uvs[u++] = 1 - r / rows;
            }
        }
    }
    let q = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const a = r * (cols + 1) + c, b = a + cols + 1;
            if (invert) {
                indices[q++] = a; indices[q++] = a + 1; indices[q++] = b;
                indices[q++] = a + 1; indices[q++] = b + 1; indices[q++] = b;
            } else {
                indices[q++] = a; indices[q++] = b; indices[q++] = a + 1;
                indices[q++] = a + 1; indices[q++] = b; indices[q++] = b + 1;
            }
        }
    }
    return { positions, uvs, indices, verts, nIdx: indices.length };
}

/** 不透明 unlit 材质:final = mainColor × mainTexture(uv)。 */
function makeUnlit(texture) {
    const mat = new Material();
    mat.initialize({ effectName: 'builtin-unlit' });
    mat.setProperty('mainTexture', texture);
    return mat;
}

// ============================================================
// 海面几何(非均匀网格:近密远疏)
// ============================================================
const SEA_N = 51;               // 每边顶点数 → 2601 顶点 ≥ 2000
const SEA_EXTENT = 150;
const SEA_VERTS = SEA_N * SEA_N;
const SEA_IDX = (SEA_N - 1) * (SEA_N - 1) * 6;
const seaGridX = new Float32Array(SEA_N);
const seaGridZ = new Float32Array(SEA_N);
for (let i = 0; i < SEA_N; i++) {
    const u = (i / (SEA_N - 1)) * 2 - 1;
    const v = Math.sign(u) * Math.pow(Math.abs(u), 1.9);
    seaGridX[i] = v * SEA_EXTENT;
    seaGridZ[i] = v * SEA_EXTENT;
}
const seaPos = new Float32Array(SEA_VERTS * 3);
const seaNrm = new Float32Array(SEA_VERTS * 3);
const seaIdx = new Uint32Array(SEA_IDX);
{
    let q = 0;
    for (let j = 0; j < SEA_N - 1; j++) {
        for (let i = 0; i < SEA_N - 1; i++) {
            const a = j * SEA_N + i, b = a + SEA_N;
            seaIdx[q++] = a; seaIdx[q++] = b; seaIdx[q++] = a + 1;
            seaIdx[q++] = a + 1; seaIdx[q++] = b; seaIdx[q++] = b + 1;
        }
    }
    for (let j = 0; j < SEA_N; j++) {
        for (let i = 0; i < SEA_N; i++) {
            const k = (j * SEA_N + i) * 3;
            seaPos[k] = seaGridX[i];
            seaPos[k + 2] = seaGridZ[j];
        }
    }
}
const SEA_MIN = { x: -SEA_EXTENT, y: -0.7, z: -SEA_EXTENT };
const SEA_MAX = { x: SEA_EXTENT, y: 0.7, z: SEA_EXTENT };

// 天穹(天顶穹顶)与地平带(两层 unlit,色温各自随 toneMix 演变)
const SKY = buildSphere(480, 12, 24, false, false);
const BAND = buildSphere(470, 4, 24, false, false, [70 * Math.PI / 180, Math.PI]);
const SUN = buildSphere(13, 10, 20, false, false);
const HALO = buildSphere(24, 10, 20, false, false);
const SUN_AZ = 237 * Math.PI / 180;
const SUN_EL = 9 * Math.PI / 180;
const sunDir = new Vec3(
    Math.cos(SUN_AZ) * Math.cos(SUN_EL),
    Math.sin(SUN_EL),
    Math.sin(SUN_AZ) * Math.cos(SUN_EL),
);

// ============================================================
// 场景组装 / 释放 / 重建
// ============================================================
let app = null;
let scene = null;
let cameraNode = null;
let camComp = null;
let worldRoot = null;
let seaMesh = null;
let skyMesh = null;
let bandMesh = null;
let sunMesh = null;
let haloMesh = null;
let sunMat = null;
let haloMat = null;
let seaMat = null;
let skyMat = null;
let bandMat = null;
let whiteTex = null;
let lightComp = null;
let ambientSky = null;
let gltfAsset = null;
let boatInst = null;
let boatAnchor = null;
let boatCenterY = 0;

function addNode(parent, name, x, y, z) {
    const n = new Node(name);
    n.layer = Layers.Enum.DEFAULT;
    if (x !== undefined) n.setPosition(new Vec3(x, y, z));
    parent.addChild(n);
    return n;
}
function addMeshNode(parent, name, mesh, mat) {
    const n = addNode(parent, name);
    const mr = n.addComponent(MeshRenderer);
    mr.mesh = mesh;
    mr.material = mat;
    return n;
}

function buildWorld() {
    worldRoot = addNode(scene, 'World');

    // 主光:方向随太阳方位,色温随色调演变
    const lightNode = addNode(worldRoot, 'Main Light');
    lightNode.setPosition(new Vec3(sunDir.x * 100, sunDir.y * 100, sunDir.z * 100));
    lightNode.lookAt(new Vec3(0, 0, 0));
    lightComp = lightNode.addComponent(DirectionalLight);
    lightComp.illuminance = 50000;

    // 海面(builtin-standard:受光 + 镜面高光)
    seaMesh = buildDynamicMesh(
        { positions: seaPos, normals: seaNrm, indices32: seaIdx, minPos: SEA_MIN, maxPos: SEA_MAX },
        SEA_VERTS + 1, SEA_IDX,
    );
    seaMat = new Material();
    seaMat.initialize({ effectName: 'builtin-standard' });
    seaMat.setProperty('mainTexture', whiteTex);
    seaMat.setProperty('roughness', mixNum('seaRough', state.toneMix));
    seaMat.setProperty('metallic', 0);
    const seaNode = addMeshNode(worldRoot, 'Sea', seaMesh, seaMat);
    seaNode.setPosition(new Vec3(0, 0, 0));

    // 天穹两层:天顶穹顶 + 地平带(纯 unlit mainColor,色温随 toneMix 演变)
    skyMesh = buildDynamicMesh(
        {
            positions: SKY.positions, indices32: SKY.indices,
            minPos: { x: -480, y: -480, z: -480 }, maxPos: { x: 480, y: 480, z: 480 },
        },
        SKY.verts + 1, SKY.nIdx,
    );
    skyMat = makeUnlit(whiteTex);
    addMeshNode(worldRoot, 'SkyDome', skyMesh, skyMat);

    bandMesh = buildDynamicMesh(
        {
            positions: BAND.positions, indices32: BAND.indices,
            minPos: { x: -470, y: -470, z: -470 }, maxPos: { x: 470, y: 470, z: 470 },
        },
        BAND.verts + 1, BAND.nIdx,
    );
    bandMat = makeUnlit(whiteTex);
    addMeshNode(worldRoot, 'SkyBand', bandMesh, bandMat);

    // 太阳 / 月亮光盘 + 光晕
    sunMesh = buildDynamicMesh(
        {
            positions: SUN.positions, indices32: SUN.indices,
            minPos: { x: -13, y: -13, z: -13 }, maxPos: { x: 13, y: 13, z: 13 },
        },
        SUN.verts + 1, SUN.nIdx,
    );
    haloMesh = buildDynamicMesh(
        {
            positions: HALO.positions, indices32: HALO.indices,
            minPos: { x: -24, y: -24, z: -24 }, maxPos: { x: 24, y: 24, z: 24 },
        },
        HALO.verts + 1, HALO.nIdx,
    );
    sunMat = makeUnlit(whiteTex);
    haloMat = makeUnlit(whiteTex);
    const haloNode = addMeshNode(worldRoot, 'SunHalo', haloMesh, haloMat);
    haloNode.setPosition(new Vec3(sunDir.x * 452, sunDir.y * 452, sunDir.z * 452));
    const sunNode = addMeshNode(worldRoot, 'SunDisc', sunMesh, sunMat);
    sunNode.setPosition(new Vec3(sunDir.x * 430, sunDir.y * 430, sunDir.z * 430));

    // 船锚点(随波起伏)
    boatAnchor = addNode(worldRoot, 'BoatAnchor');

    applyTone(state.toneMix, true);
}

/** 显式释放当前世界自建 GPU 资源与 GLB 资产。 */
function destroyWorld() {
    if (gltfAsset) {
        try { gltfAsset.destroy(); } catch (e) { void e; }
        gltfAsset = null;
    }
    if (boatInst) {
        try { boatInst.dispose(); } catch (e) { void e; }
        boatInst = null;
    }
    boatAnchor = null;
    const meshes = [seaMesh, skyMesh, bandMesh, sunMesh, haloMesh];
    const mats = [seaMat, skyMat, bandMat, sunMat, haloMat];
    for (const m of meshes) { if (m) { try { m.destroy(); } catch (e) { void e; } } }
    for (const m of mats) { if (m) { try { m.destroy(); } catch (e) { void e; } } }
    seaMesh = skyMesh = bandMesh = sunMesh = haloMesh = null;
    seaMat = skyMat = bandMat = sunMat = haloMat = null;
    lightComp = null;
    if (worldRoot && scene) {
        scene.removeChild(worldRoot);
        worldRoot.destroy();
    }
    worldRoot = null;
}

function doReset() {
    state.epoch += 1;
    state.token += 1;
    state.toneTarget = 0;
    state.toneMix = 0;
    state.azimuth = INITIAL_AZIMUTH;
    state.azimuthTarget = INITIAL_AZIMUTH;
    state.simTime = 0;
    state.wavePhase = 0;
    state.assetLoaded = false;
    statusDiv.textContent = 'Reloading boat.glb …';
    statusDiv.style.color = '#ffe8c4';
    destroyWorld();
    buildWorld();
    loadBoat(state.token);
}

/** 运行时网络加载 GLB(每次重建重新请求)。 */
async function loadBoat(token) {
    try {
        const asset = await new GLTFLoader().loadAsync(GLB_URL);
        if (token !== state.token) {
            try { asset.destroy(); } catch (e) { void e; }
            return;
        }
        const inst = asset.instantiate();
        if (token !== state.token) {
            try { asset.destroy(); } catch (e) { void e; }
            try { inst.dispose(); } catch (e) { void e; }
            return;
        }
        gltfAsset = asset;
        boatInst = inst;
        const root = inst.root;
        setLayerDeep(root, Layers.Enum.DEFAULT);
        boatAnchor.addChild(root);
        const bb = measureBoat(root);
        if (bb) {
            boatCenterY = (bb.minY + bb.maxY) * 0.5;
            root.setPosition(new Vec3(0, WATERLINE - bb.minY, 0));
            state.boatPos.x = bb.cx;
            state.boatPos.z = bb.cz;
        } else {
            boatCenterY = 0.5;
            root.setPosition(new Vec3(0, 0, 0));
        }
        state.assetRequests += 1;
        state.assetLoaded = true;
        statusDiv.textContent = '';
    } catch (err) {
        showError(err && err.message ? err.message : String(err));
    }
}

function setLayerDeep(node, layer) {
    node.layer = layer;
    const children = node.children;
    for (let i = 0; i < children.length; i++) setLayerDeep(children[i], layer);
}

/** 近似包围盒:节点平移 + 网格 struct min/maxPosition(规则静态姿态)。 */
function measureBoat(root) {
    let minY = Infinity, maxY = -Infinity, cx = 0, cz = 0, n = 0;
    const stack = [root];
    while (stack.length) {
        const nd = stack.pop();
        const mr = nd.getComponent ? nd.getComponent(MeshRenderer) : null;
        if (mr && mr.mesh && mr.mesh.struct) {
            const lo = mr.mesh.struct.minPosition;
            const hi = mr.mesh.struct.maxPosition;
            if (lo && hi) {
                const p = nd.worldPosition;
                const y0 = p.y + lo.y, y1 = p.y + hi.y;
                if (y0 < minY) minY = y0;
                if (y1 > maxY) maxY = y1;
                cx += p.x; cz += p.z; n += 1;
            }
        }
        const ch = nd.children;
        for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    if (!n || minY === Infinity) return null;
    return { minY, maxY, cx: cx / n, cz: cz / n };
}

// ============================================================
// 色调应用(天空 uv / 海面反照率 / 光照 / 环境 / 光盘 / 清屏色)
// ============================================================
const _c3 = [0, 0, 0];
function applyTone(t, force) {
    if (camComp) camComp.clearColor = mix255('clear', t);
    if (lightComp) lightComp.color = mix255('light', t);
    if (ambientSky) {
        mixRaw('ambient', t, _c3);
        ambientSky.set(_c3[0], _c3[1], _c3[2], 1.0);
    }
    if (seaMat) {
        seaMat.setProperty('mainColor', mix255('seaMain', t));
        seaMat.setProperty('emissive', mix255('seaEmissive', t));
        seaMat.setProperty('roughness', mixNum('seaRough', t));
    }
    if (skyMat) skyMat.setProperty('mainColor', mix255('skyDome', t));
    if (bandMat) bandMat.setProperty('mainColor', mix255('skyBand', t));
    if (sunMat) sunMat.setProperty('mainColor', mix255('sunCore', t));
    if (haloMat) haloMat.setProperty('mainColor', mix255('sunHalo', t));
}

// ============================================================
// 每帧驱动组件(挂在常驻相机节点上,跨 epoch 存活)
// ============================================================
const frameStamps = [];
const _grad = { x: 0, z: 0 };
const _camPos = new Vec3();
class SceneUpdater extends Component {
    update(dt) {
        const d = Math.min(dt, 0.05); // 后台节流恢复防跳变
        state.simTime += d;
        state.wavePhase = state.simTime;

        // fps:2s 滚动平均
        const now = performance.now();
        frameStamps.push(now);
        while (frameStamps.length > 0 && now - frameStamps[0] > 2000) frameStamps.shift();
        if (frameStamps.length >= 2) {
            state.fps = (frameStamps.length - 1) * 1000 / Math.max(1, now - frameStamps[0]);
        }

        // 色调过渡
        if (state.toneMix !== state.toneTarget) {
            const k = 1 - Math.exp(-d / TONE_TAU);
            state.toneMix += (state.toneTarget - state.toneMix) * k;
            if (Math.abs(state.toneTarget - state.toneMix) < 0.0004) state.toneMix = state.toneTarget;
        }

        // 方位角指数平滑(无跳变;拖拽后持续追赶)
        if (state.azimuth !== state.azimuthTarget) {
            const k = 1 - Math.exp(-d / AZ_TAU);
            state.azimuth += (state.azimuthTarget - state.azimuth) * k;
            if (Math.abs(state.azimuthTarget - state.azimuth) < 0.01) state.azimuth = state.azimuthTarget;
        }

        // 相机环绕
        const az = state.azimuth * Math.PI / 180;
        const ce = Math.cos(CAM_ELEV), se = Math.sin(CAM_ELEV);
        _camPos.set(Math.cos(az) * ce * CAM_RADIUS, 0.95 + se * CAM_RADIUS, Math.sin(az) * ce * CAM_RADIUS);
        cameraNode.setPosition(_camPos);
        cameraNode.lookAt(CAM_LOOK);

        // 色调相关资源
        applyTone(state.toneMix, false);

        // 海面逐帧波形(位置 + 解析法线;明暗与高光由 standard 材质光照实时产生)
        const t = state.simTime;
        let idx = 0;
        for (let j = 0; j < SEA_N; j++) {
            const z = seaGridZ[j];
            for (let i = 0; i < SEA_N; i++) {
                const x = seaGridX[i];
                let h = 0, gx = 0, gz = 0;
                for (let w = 0; w < 3; w++) {
                    const wd = WAVE_DEFS[w];
                    const ph = (x * wd.dx + z * wd.dz) * wd.k - wd.w * t;
                    h += wd.a * Math.sin(ph);
                    const c = wd.a * wd.k * Math.cos(ph);
                    gx += c * wd.dx;
                    gz += c * wd.dz;
                }
                seaPos[idx] = x;
                seaPos[idx + 1] = h;
                seaPos[idx + 2] = z;
                const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
                seaNrm[idx] = -gx * inv;
                seaNrm[idx + 1] = inv;
                seaNrm[idx + 2] = -gz * inv;
                idx += 3;
            }
        }
        if (seaMesh) {
            seaMesh.updateSubMesh(0, {
                positions: seaPos, normals: seaNrm, indices32: seaIdx,
                minPos: SEA_MIN, maxPos: SEA_MAX,
            });
        }

        // 船体随波起伏(同一波形函数采样 → 相位耦合)+ 轻微纵横摇
        if (boatAnchor) {
            const h = waveH(0, 0, t);
            boatAnchor.setPosition(new Vec3(0, h, 0));
            waveGrad(0, 0, t, _grad);
            const pitch = Math.max(-0.3, Math.min(0.3, _grad.x * 0.85));
            const roll = Math.max(-0.3, Math.min(0.3, _grad.z * 0.85));
            boatAnchor.setRotationFromEuler(pitch, 0, roll);
            state.boatPos.y = h + boatCenterY + WATERLINE;
        }

        // 资产就绪 → __appReady
        if (!state.ready && state.assetLoaded) {
            state.ready = true;
            window.__appReady = true;
        }
    }
}

// ============================================================
// 拖拽环绕(水平指针位移 → 目标方位角)
// ============================================================
function bindDrag(canvas) {
    let dragging = false;
    let lastX = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        state.azimuthTarget += dx * AZ_SENS;
    });
    const stop = () => { dragging = false; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
}

// ============================================================
// 启动
// ============================================================
try {
    whiteTex = builtinResMgr.get('white-texture');

    const canvas = document.querySelector('#GameCanvas');
    app = await createAirApp({ canvas });
    scene = new Scene('e02');

    // 常驻相机(跨 reset 存活)
    cameraNode = addNode(scene, 'Main Camera');
    camComp = cameraNode.addComponent(Camera);
    camComp.projection = Camera.ProjectionType.PERSPECTIVE;
    camComp.fov = 45;
    camComp.near = 0.1;
    camComp.far = 2000;
    camComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camComp.clearColor = new Color(255, 176, 96, 255);
    camComp.visibility = Layers.Enum.DEFAULT;
    camComp.priority = 0;
    cameraNode.addComponent(SceneUpdater);
    bindDrag(canvas);

    // 首帧世界
    buildWorld();

    window.__airApp = app;
    app.run(scene);

    // 环境光(app.run 后经 scene.globals 显式配置;Ambient.initialize 按引用共享 Vec4)
    ambientSky = scene.globals.ambient.skyColorHDR;
    scene.globals.ambient.skyIllum = 20000;
    applyTone(state.toneMix, true);

    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frames += 1;
    });

    loadBoat(state.token);

    console.log('[e02] running on cocosair — Sunset Sea & Lone Boat');
} catch (err) {
    console.error('[e02] fatal:', err && err.message ? err.message : err);
    showError(err && err.message ? err.message : String(err));
    setTimeout(() => {
        throw err;
    }, 0);
}
