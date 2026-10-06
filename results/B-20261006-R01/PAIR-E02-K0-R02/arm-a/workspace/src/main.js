/**
 * E02 — 落日海面与孤舟(Asset Driven)— cocosair K0 实现
 *
 * 场景构成(全部程序化,除 boat.glb 运行时网络加载):
 *   - 海面:非均匀网格动态曲面(近密远疏,>=2000 顶点),每帧由重力波相位场
 *     位移顶点 Y 并解析重算法线;createDynamicMesh + updateSubMesh 逐帧上送。
 *   - 天穹:反转 winding 的内视半球(unlit + USE_VERTEX_COLOR),顶点亮度 =
 *     垂直渐变 + 朝太阳方向的烘焙光晕;材质 mainColor 随 toneMix 暖冷演变。
 *   - 日/月光盘:unlit 双面圆盘,固定世界方位;颜色随 toneMix 演变。
 *   - 孤舟:GLTFLoader.loadAsync('assets/boat.glb') → asset.instantiate(),
 *     资产内嵌材质保留;船体 Y 采样同一波形函数(相位耦合),带纵摇/横摇。
 *   - 光照:DirectionalLight 颜色/强度 + 环境光随 toneMix 平滑演变(HDR 量级)。
 *
 * 页面契约:
 *   - window.__appReady:资产加载完成且首帧渲染后置 true(10s 内)。
 *   - window.__bench.getState():assetLoaded/assetRequests/boatPosition/wavePhase/
 *     toneMix/cameraAzimuth/fps/epoch。
 *   - window.__bench.reset():释放并重建(销毁船实例/GLTF 资产/海面网格/天穹网格
 *     与本回合材质),重载 boat.glb,恢复 toneMix=0、azimuth=35、wavePhase=0,epoch+1。
 *
 * 引擎坑位对齐(实测已知):
 *   - Camera.visibility 必须显式 = Layers.Enum.DEFAULT;
 *   - 环境光走 scene.globals.ambient.skyColorHDR 原位 set(HDR 量级 skyIllum);
 *   - Light.color / Material.setProperty FLOAT4 只传 Color 实例(且每个 uniform
 *     独立实例:setProperty 按引用存储,共享实例会在 bind 时相互串色);
 *   - canvas 鼠标事件被 pal 吞 → 一律走引擎 input.on(Input.EventType.*)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    MeshRenderer,
    Camera,
    DirectionalLight,
    Material,
    builtinResMgr,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
    input,
    Input,
    GLTFLoader,
} from 'cocosair.js';

// ---------------------------------------------------------------- 常量与全局状态

const DEG = Math.PI / 180;

// 初始与目标参数(冻结口径:azimuth 初始 35°,toneMix 初始 0)
const AZIMUTH0 = 35;
const CAMERA_ELEV = 8;      // 相机俯角(度)→ 海平线约在画面上 1/3
const CAMERA_RADIUS = 9.5;  // 环绕半径
const LOOK_AT_Y = 0.9;      // 注视点高度(船体附近)
const FOV = 50;

// 太阳/月亮固定世界方位(az 215°:初始相机 azimuth 35° 时位于画面中轴附近偏侧)
const SUN_AZ = 215 * DEG;
const SUN_EL = 10 * DEG;
const SKY_RADIUS = 420;
const SUN_DIST = 400;
const SUN_RADIUS = 26;

// 海面参数:非均匀网格(近密远疏),顶点 (81)^2 = 6561 >= 2000
const SEA_N = 80;           // 每边分段
const SEA_RADIUS = 350;
const SEA_POWER = 1.6;      // 距离指数:>1 → 中心密、边缘疏
const WAVE_SPEED = 1.35;    // wavePhase 推进速率(rad/s)

// 色调过渡时长(<=2.5s 冻结上限)
const TONE_DURATION = 1.6;

// 暖端(toneMix=0)/冷端(toneMix=1)调色板
const PALETTE = {
    warm: {
        sky: [255, 166, 84],      sea: [56, 96, 128],
        light: [255, 214, 160],   illuminance: 42000,
        ambient: [1.0, 0.62, 0.40], ambientIllum: 12000,
        disc: [255, 238, 196],    clear: [24, 34, 52],
    },
    cool: {
        sky: [96, 136, 235],      sea: [18, 36, 72],
        light: [168, 192, 255],   illuminance: 16000,
        ambient: [0.45, 0.55, 0.85], ambientIllum: 5200,
        disc: [214, 226, 255],    clear: [8, 12, 26],
    },
};

const S = {
    epoch: 0,
    toneMix: 0,          // 0=暖(落日) 1=冷(暮蓝)
    toneTarget: 0,
    wavePhase: 0,        // 持续递增(rad)
    azimuth: AZIMUTH0,   // 当前渲染方位角(平滑后,度)
    azimuthTarget: AZIMUTH0,
    assetLoaded: false,
    assetRequests: 0,
    fps: 0,
    ready: false,
    dragging: false,
};

// 运行期对象引用(每 epoch 重建)
const R = {
    app: null,
    scene: null,
    cameraNode: null,
    camera: null,
    lightNode: null,
    light: null,
    seaNode: null,
    seaMesh: null,
    seaRenderer: null,
    seaGeo: null,
    domeNode: null,
    domeMesh: null,
    discNode: null,
    discMesh: null,
    envMaterials: [],    // 本 epoch 创建、teardown 时销毁的材质
    toneColors: null,    // 每 uniform 独立 Color 实例(setProperty 按引用存储,禁止共享)
    boat: { asset: null, instance: null, node: null },
    lookAt: new Vec3(0, LOOK_AT_Y, 0),
    camPos: new Vec3(),
};

// ---------------------------------------------------------------- 波形场(船与海面共用同一函数 → 相位耦合)

// 三组不同方向/频率/速度的行进正弦波(dh/dx、dh/dz 解析导数)
const WAVES = [
    { ax: 0.861, az: 0.508, k: 0.16, amp: 0.30, sp: 1.00, ph: 0.0 },
    { ax: -0.660, az: 0.751, k: 0.34, amp: 0.16, sp: 1.73, ph: 1.3 },
    { ax: 0.316, az: -0.949, k: 0.72, amp: 0.09, sp: 2.90, ph: 4.1 },
];

// out = { h, dx, dz }
function waveField(x, z, phase, out) {
    let h = 0, dx = 0, dz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        const arg = w.k * (w.ax * x + w.az * z) + phase * w.sp + w.ph;
        h += w.amp * Math.sin(arg);
        dx += w.amp * w.k * w.ax * Math.cos(arg);
        dz += w.amp * w.k * w.az * Math.cos(arg);
    }
    out.h = h; out.dx = dx; out.dz = dz;
    return out;
}

// ---------------------------------------------------------------- 页面契约

window.__appReady = false;

function getState() {
    let bp = { x: 0, y: 0, z: 0 };
    if (R.boat.node && R.boat.node.worldPosition) {
        const p = R.boat.node.worldPosition;
        bp = { x: p.x, y: p.y, z: p.z };
    }
    return {
        assetLoaded: S.assetLoaded === true,
        assetRequests: S.assetRequests,
        boatPosition: bp,
        wavePhase: S.wavePhase,
        toneMix: S.toneMix,
        cameraAzimuth: ((S.azimuth % 360) + 360) % 360,
        fps: S.fps,
        epoch: S.epoch,
    };
}

function doReset() {
    // 同步部分:恢复初始口径 + 销毁旧资源;异步部分:重建并重载资产
    S.epoch += 1;
    const myEpoch = S.epoch;
    S.toneMix = 0;
    S.toneTarget = 0;
    S.azimuth = AZIMUTH0;
    S.azimuthTarget = AZIMUTH0;
    S.wavePhase = 0;
    S.assetLoaded = false;
    applyTone(0);
    updateToneButtonLabel();

    teardownBoat();
    teardownEnvironment();

    buildEnvironment();
    loadBoatAsync(myEpoch).catch((e) => showError('boat reload failed', e));
}

window.__bench = {
    getState,
    reset: doReset,
};

// ---------------------------------------------------------------- UI 覆盖层

function makeButton(text, dataUi, onClick, extraCss) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.setAttribute('data-ui', dataUi);
    btn.setAttribute('aria-label', dataUi);
    btn.style.cssText =
        'position:fixed;top:8px;z-index:9999;padding:6px 14px;font:13px sans-serif;' +
        'background:rgba(20,24,34,0.75);color:#fff;border:1px solid #667;' +
        'border-radius:4px;cursor:pointer;' + (extraCss || '');
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    return btn;
}

let toneBtn = null;
function updateToneButtonLabel() {
    if (toneBtn) {
        toneBtn.textContent = S.toneTarget < 0.5 ? 'Tone: Warm Sunset' : 'Tone: Cool Dusk';
    }
}

function showError(title, err) {
    const msg = String((err && err.message) || err || title);
    let el = document.getElementById('load-error');
    if (!el) {
        el = document.createElement('div');
        el.id = 'load-error';
        el.style.cssText =
            'position:fixed;left:50%;top:46px;transform:translateX(-50%);z-index:10000;' +
            'padding:8px 16px;font:13px sans-serif;background:rgba(120,20,20,0.9);' +
            'color:#fff;border-radius:4px;';
        document.body.appendChild(el);
    }
    el.textContent = title + ': ' + msg;
}

// ---------------------------------------------------------------- 材质工厂(每 epoch 新建,teardown 时销毁;builtin effect 资产共享只读)

function makeStandardMaterial(name) {
    const m = new Material(name);
    m.initialize({ effectName: 'builtin-standard' });
    return m;
}

function makeUnlitMaterial(name, vertexColor) {
    const m = new Material(name);
    m.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: false, USE_VERTEX_COLOR: !!vertexColor },
    });
    return m;
}

// ---------------------------------------------------------------- 几何构建

function buildSeaGeometry() {
    const N = SEA_N;
    const vertCount = (N + 1) * (N + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const indices16 = new Uint16Array(N * N * 6);

    // 非均匀坐标:中心密、边缘疏(u = R * |t|^P, t ∈ [-1,1])
    const coord = new Float32Array(N + 1);
    const half = N / 2;
    for (let i = 0; i <= N; i++) {
        const t = (i - half) / half;
        coord[i] = Math.sign(t) * Math.pow(Math.abs(t), SEA_POWER) * SEA_RADIUS;
    }
    for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
            const vi = j * (N + 1) + i;
            positions[vi * 3] = coord[i];      // x
            positions[vi * 3 + 1] = 0;          // y:每帧波形位移
            positions[vi * 3 + 2] = coord[j];   // z
            normals[vi * 3 + 1] = 1;
        }
    }
    // 索引:cross(edge1, edge2) = +Y(法线朝上,正面朝上可见)
    let f = 0;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const a = j * (N + 1) + i;
            const b = a + 1;
            const c = a + (N + 1);
            const d = c + 1;
            indices16[f++] = a; indices16[f++] = c; indices16[f++] = b;
            indices16[f++] = b; indices16[f++] = c; indices16[f++] = d;
        }
    }
    return { positions, normals, indices16, coord, N };
}

function updateSeaGeometry() {
    const g = R.seaGeo;
    if (!g) return;
    const { positions, normals, coord, N } = g;
    const { indices16 } = g;
    const ph = S.wavePhase;
    const out = { h: 0, dx: 0, dz: 0 };
    for (let j = 0; j <= N; j++) {
        const z = coord[j];
        for (let i = 0; i <= N; i++) {
            const vi = j * (N + 1) + i;
            waveField(coord[i], z, ph, out);
            positions[vi * 3 + 1] = out.h;
            // n = normalize(-dh/dx, 1, -dh/dz)
            const inv = 1 / Math.sqrt(out.dx * out.dx + out.dz * out.dz + 1);
            normals[vi * 3] = -out.dx * inv;
            normals[vi * 3 + 1] = inv;
            normals[vi * 3 + 2] = -out.dz * inv;
        }
    }
    R.seaMesh.updateSubMesh(0, {
        positions,
        normals,
        indices16,
        minPos: { x: -SEA_RADIUS, y: -0.6, z: -SEA_RADIUS },
        maxPos: { x: SEA_RADIUS, y: 0.6, z: SEA_RADIUS },
    });
}

// 内视天穹:半球(略过地平线下方),顶点亮度 = 垂直渐变 + 太阳方向烘焙光晕
function buildDomeGeometry() {
    const rows = 30, cols = 64;
    const vertCount = (rows + 1) * (cols + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3); // unlit 不用,但属性流缺失会断 draw
    const colors = new Float32Array(vertCount * 4);
    const indices16 = new Uint16Array(rows * cols * 12);
    const minEl = -4 * DEG, maxEl = 90 * DEG;

    const sunX = Math.cos(SUN_EL) * Math.sin(SUN_AZ);
    const sunY = Math.sin(SUN_EL);
    const sunZ = Math.cos(SUN_EL) * Math.cos(SUN_AZ);

    let vi = 0;
    for (let r = 0; r <= rows; r++) {
        const el = minEl + (maxEl - minEl) * (r / rows);
        const ce = Math.cos(el), se = Math.sin(el);
        const t = Math.max(0, se); // 0=地平线 → 1=天顶
        for (let c = 0; c <= cols; c++) {
            const az = (c / cols) * Math.PI * 2;
            const x = ce * Math.sin(az), y = se, z = ce * Math.cos(az);
            positions[vi * 3] = x * SKY_RADIUS;
            positions[vi * 3 + 1] = y * SKY_RADIUS;
            positions[vi * 3 + 2] = z * SKY_RADIUS;
            normals[vi * 3] = -x; normals[vi * 3 + 1] = -y; normals[vi * 3 + 2] = -z;
            // 垂直渐变亮度:地平线亮、天顶暗(单色亮度 × 材质染色 = 天空色)
            let lum = 0.30 + 0.70 * Math.pow(1 - t, 0.55);
            // 烘焙光晕:顶点方向与太阳方向的角距(高斯衰减 + 中心再加宽)
            let dot = x * sunX + y * sunY + z * sunZ;
            dot = Math.max(-1, Math.min(1, dot));
            const ang = Math.acos(dot);
            lum += 1.15 * Math.exp(-(ang * ang) / (2 * 0.30 * 0.30));
            lum += 0.35 * Math.exp(-(ang * ang) / (2 * 0.09 * 0.09));
            const v = Math.min(1, lum);
            colors[vi * 4] = v; colors[vi * 4 + 1] = v; colors[vi * 4 + 2] = v;
            colors[vi * 4 + 3] = 1;
            vi++;
        }
    }
    // 双面 winding:正反各一份,规避 cull 方向假设
    let f = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const a = r * (cols + 1) + c;
            const b = a + 1;
            const d = a + (cols + 1);
            const e = d + 1;
            indices16[f++] = a; indices16[f++] = b; indices16[f++] = d;
            indices16[f++] = b; indices16[f++] = e; indices16[f++] = d;
            indices16[f++] = a; indices16[f++] = d; indices16[f++] = b;
            indices16[f++] = b; indices16[f++] = d; indices16[f++] = e;
        }
    }
    // 注意:静态 createMesh 读 geometry.indices(自动判 16/32 位),仅动态路径读 indices16
    return { positions, normals, colors, indices: indices16, minPos: { x: -SKY_RADIUS, y: -SKY_RADIUS, z: -SKY_RADIUS }, maxPos: { x: SKY_RADIUS, y: SKY_RADIUS, z: SKY_RADIUS } };
}

// 日/月光盘:垂直于太阳方向的双面圆盘(正反 winding 各一份,免 cull 风险)
function buildDiscGeometry() {
    const segs = 40;
    const vertCount = segs + 2; // 圆心 + 环点(末点重合收口)
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3); // 属性流完整性(unlit 不消费)
    const indices16 = new Uint16Array(segs * 6);

    const dirX = Math.cos(SUN_EL) * Math.sin(SUN_AZ);
    const dirY = Math.sin(SUN_EL);
    const dirZ = Math.cos(SUN_EL) * Math.cos(SUN_AZ);
    // 盘面基向量:U = normalize(up × dir),V = dir × U
    const ux = dirZ, uy = 0, uz = -dirX; // up=(0,1,0) × dir
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    const U = { x: ux / ul, y: uy / ul, z: uz / ul };
    const V = {
        x: dirY * U.z - dirZ * U.y,
        y: dirZ * U.x - dirX * U.z,
        z: dirX * U.y - dirY * U.x,
    };
    positions[0] = 0; positions[1] = 0; positions[2] = 0;
    normals[0] = dirX; normals[1] = dirY; normals[2] = dirZ;
    for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const co = Math.cos(a) * SUN_RADIUS, si = Math.sin(a) * SUN_RADIUS;
        const vi = i + 1;
        positions[vi * 3] = U.x * co + V.x * si;
        positions[vi * 3 + 1] = U.y * co + V.y * si;
        positions[vi * 3 + 2] = U.z * co + V.z * si;
        normals[vi * 3] = dirX; normals[vi * 3 + 1] = dirY; normals[vi * 3 + 2] = dirZ;
    }
    let f = 0;
    for (let i = 0; i < segs; i++) {
        const n1 = i + 1, n2 = i + 2;
        indices16[f++] = 0; indices16[f++] = n2; indices16[f++] = n1; // 正面朝相机侧
        indices16[f++] = 0; indices16[f++] = n1; indices16[f++] = n2; // 反向兜底
    }
    const pad = SUN_RADIUS + 2;
    const cx = dirX * SUN_DIST, cy = dirY * SUN_DIST, cz = dirZ * SUN_DIST;
    return {
        positions, normals, indices: indices16,
        minPos: { x: cx - pad, y: cy - pad, z: cz - pad },
        maxPos: { x: cx + pad, y: cy + pad, z: cz + pad },
    };
}

// ---------------------------------------------------------------- 场景搭建 / 释放

function setNodeLayerDeep(root, layer) {
    root.layer = layer;
    const children = root.children;
    for (let i = 0; i < children.length; i++) setNodeLayerDeep(children[i], layer);
}

function buildEnvironment() {
    const scene = R.scene;

    // --- 海面(动态网格 + standard 材质,受光/高光)---
    // createDynamicMesh 默认容量只有 1024 顶点/1024 索引,必须按海面规模显式给满,
    // 否则首次 updateSubMesh 写越界(Invalid typed array length)。
    R.seaGeo = buildSeaGeometry();
    R.seaMesh = utils.MeshUtils.createDynamicMesh(0, {
        positions: R.seaGeo.positions,
        normals: R.seaGeo.normals,
        indices16: R.seaGeo.indices16,
    }, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: (SEA_N + 1) * (SEA_N + 1),
        maxSubMeshIndices: SEA_N * SEA_N * 6,
    });
    const seaMat = makeStandardMaterial('sea-mat-e' + S.epoch);
    R.envMaterials.push(seaMat);
    R.seaNode = new Node('Sea');
    R.seaNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(R.seaNode);
    R.seaRenderer = R.seaNode.addComponent(MeshRenderer);
    R.seaRenderer.mesh = R.seaMesh;
    R.seaRenderer.material = seaMat;
    updateSeaGeometry();

    // --- 天穹(内视半球,unlit + 顶点色亮度渐变 + 烘焙光晕)---
    R.domeMesh = utils.MeshUtils.createMesh(buildDomeGeometry());
    const domeMat = makeUnlitMaterial('dome-mat-e' + S.epoch, true);
    R.envMaterials.push(domeMat);
    R.domeNode = new Node('SkyDome');
    R.domeNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(R.domeNode);
    const domeRenderer = R.domeNode.addComponent(MeshRenderer);
    domeRenderer.mesh = R.domeMesh;
    domeRenderer.material = domeMat;

    // --- 日/月光盘 ---
    R.discMesh = utils.MeshUtils.createMesh(buildDiscGeometry());
    const discMat = makeUnlitMaterial('disc-mat-e' + S.epoch, false);
    R.envMaterials.push(discMat);
    R.discNode = new Node('SunDisc');
    R.discNode.layer = Layers.Enum.DEFAULT;
    const sd = SUN_DIST;
    R.discNode.setPosition(
        new Vec3(sd * Math.cos(SUN_EL) * Math.sin(SUN_AZ), sd * Math.sin(SUN_EL), sd * Math.cos(SUN_EL) * Math.cos(SUN_AZ)),
    );
    scene.addChild(R.discNode);
    const discRenderer = R.discNode.addComponent(MeshRenderer);
    discRenderer.mesh = R.discMesh;
    discRenderer.material = discMat;

    // 每 uniform 独立 Color 实例并完成首次 setProperty(此后 applyTone 原位 .set)
    R.toneColors = {
        sky: new Color(255, 166, 84, 255),
        disc: new Color(255, 238, 196, 255),
        sea: new Color(56, 96, 128, 255),
    };
    domeMat.setProperty('mainColor', R.toneColors.sky);
    discMat.setProperty('mainColor', R.toneColors.disc);
    seaMat.setProperty('mainColor', R.toneColors.sea);
    seaMat.setProperty('roughness', 0.22);
    seaMat.setProperty('metallic', 0.06);
    seaMat.setProperty('specularIntensity', 1.0);
}

function teardownEnvironment() {
    // 显式释放 GPU 侧资源:mesh.destroy() / material.destroy()(builtin effect 资产共享,不销毁)
    const pairs = [['seaNode', 'seaMesh'], ['domeNode', 'domeMesh'], ['discNode', 'discMesh']];
    for (const [nodeKey, meshKey] of pairs) {
        const node = R[nodeKey];
        const mesh = R[meshKey];
        if (node && node.isValid) {
            if (node.parent) node.parent.removeChild(node);
            node.destroy();
        }
        R[nodeKey] = null;
        if (mesh) { try { mesh.destroy(); } catch (e) { /* 已销毁 */ } }
        R[meshKey] = null;
    }
    for (const m of R.envMaterials) { try { m.destroy(); } catch (e) { /* 已销毁 */ } }
    R.envMaterials = [];
    R.toneColors = null;
    R.seaGeo = null;
    R.seaRenderer = null;
}

function teardownBoat() {
    if (R.boat.instance) { try { R.boat.instance.dispose(); } catch (e) { /* 已销毁 */ } }
    R.boat.instance = null;
    if (R.boat.node && R.boat.node.isValid) {
        if (R.boat.node.parent) R.boat.node.parent.removeChild(R.boat.node);
        R.boat.node.destroy();
    }
    R.boat.node = null;
    if (R.boat.asset) { try { R.boat.asset.destroy(); } catch (e) { /* 已销毁 */ } }
    R.boat.asset = null;
}

async function loadBoatAsync(myEpoch) {
    // 运行时真实网络请求 assets/boat.glb(构建产物不转译/不内联)
    const asset = await new GLTFLoader().loadAsync('assets/boat.glb');
    if (myEpoch !== S.epoch) { try { asset.destroy(); } catch (e) { /* 被更新的 reset 取代 */ } return; }
    const instance = asset.instantiate();
    const root = instance.root;
    setNodeLayerDeep(root, Layers.Enum.DEFAULT);
    R.scene.addChild(root);
    const out = { h: 0, dx: 0, dz: 0 };
    waveField(0, 0, S.wavePhase, out);
    root.setPosition(new Vec3(0, out.h + 0.05, 0));
    root.setRotationFromEuler(-out.dx * 22, -32, out.dz * 22);
    R.boat.asset = asset;
    R.boat.instance = instance;
    R.boat.node = root;
    S.assetRequests += 1;
    S.assetLoaded = true;
}

// ---------------------------------------------------------------- 色调演变(天空/海面/光照/船体受光同时演变)

function lerp(a, b, t) { return a + (b - a) * t; }

function applyTone(mix) {
    const w = PALETTE.warm, c = PALETTE.cool;
    const tc = R.toneColors;

    // 天穹/日盘/海面染色(实例已通过 setProperty 绑定,原位 .set 即生效于下次 bind)
    if (tc) {
        tc.sky.set(Math.round(lerp(w.sky[0], c.sky[0], mix)), Math.round(lerp(w.sky[1], c.sky[1], mix)), Math.round(lerp(w.sky[2], c.sky[2], mix)), 255);
        tc.disc.set(Math.round(lerp(w.disc[0], c.disc[0], mix)), Math.round(lerp(w.disc[1], c.disc[1], mix)), Math.round(lerp(w.disc[2], c.disc[2], mix)), 255);
        tc.sea.set(Math.round(lerp(w.sea[0], c.sea[0], mix)), Math.round(lerp(w.sea[1], c.sea[1], mix)), Math.round(lerp(w.sea[2], c.sea[2], mix)), 255);
    }

    // 主光:颜色(Color 实例原位 set)+ 强度(HDR 量级)
    if (R.light) {
        R.light.color.set(
            Math.round(lerp(w.light[0], c.light[0], mix)),
            Math.round(lerp(w.light[1], c.light[1], mix)),
            Math.round(lerp(w.light[2], c.light[2], mix)), 255);
        R.light.illuminance = lerp(w.illuminance, c.illuminance, mix);
    }

    // 环境光(skyColorHDR 为共享引用,原位 set;skyIllum 走 setter)
    const amb = R.scene && R.scene.globals && R.scene.globals.ambient;
    if (amb) {
        amb.skyColorHDR.set(
            lerp(w.ambient[0], c.ambient[0], mix),
            lerp(w.ambient[1], c.ambient[1], mix),
            lerp(w.ambient[2], c.ambient[2], mix), 1.0);
        amb.skyIllum = lerp(w.ambientIllum, c.ambientIllum, mix);
    }

    // 相机兜底清屏色(正常被天穹遮挡)
    if (R.camera) {
        R.camera.clearColor.set(
            Math.round(lerp(w.clear[0], c.clear[0], mix)),
            Math.round(lerp(w.clear[1], c.clear[1], mix)),
            Math.round(lerp(w.clear[2], c.clear[2], mix)), 255);
    }
}

// ---------------------------------------------------------------- 相机环绕

let lastDt = 1 / 60;

function updateCamera() {
    // 平滑趋近目标方位角(逐帧插值,无跳变)
    let d = S.azimuthTarget - S.azimuth;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    S.azimuth += d * Math.min(1, lastDt * 10);
    const az = S.azimuth * DEG;
    const el = CAMERA_ELEV * DEG;
    R.camPos.set(
        R.lookAt.x + CAMERA_RADIUS * Math.cos(el) * Math.sin(az),
        R.lookAt.y + CAMERA_RADIUS * Math.sin(el),
        R.lookAt.z + CAMERA_RADIUS * Math.cos(el) * Math.cos(az),
    );
    if (R.cameraNode) {
        R.cameraNode.setPosition(R.camPos);
        R.cameraNode.lookAt(R.lookAt);
    }
}

// ---------------------------------------------------------------- 每帧驱动组件

const waveOut = { h: 0, dx: 0, dz: 0 };

class Driver extends Component {
    update(dt) {
        lastDt = Math.min(dt, 0.1);
        // 波形相位推进(时钟增量;后台节流恢复前台后继续正确推进)
        S.wavePhase += WAVE_SPEED * lastDt;

        // 海面几何位移
        if (R.seaMesh) updateSeaGeometry();

        // 船体随波起伏(同一波形函数 → 相位耦合;伴纵摇/横摇)
        if (R.boat.node && R.boat.node.isValid) {
            waveField(0, 0, S.wavePhase, waveOut);
            R.boat.node.setPosition(0, waveOut.h + 0.05, 0);
            R.boat.node.setRotationFromEuler(-waveOut.dx * 20, -32, waveOut.dz * 20);
        }

        // 色调平滑过渡(<=2.5s)
        if (S.toneMix !== S.toneTarget) {
            const step = lastDt / TONE_DURATION;
            if (S.toneMix < S.toneTarget) S.toneMix = Math.min(S.toneTarget, S.toneMix + step);
            else S.toneMix = Math.max(S.toneTarget, S.toneMix - step);
            applyTone(S.toneMix);
        }

        updateCamera();
    }
}

// ---------------------------------------------------------------- 输入:水平拖拽环绕(引擎 input,绕开 pal 吞事件)

function bindInput() {
    input.on(Input.EventType.MOUSE_DOWN, () => { S.dragging = true; });
    input.on(Input.EventType.MOUSE_MOVE, (event) => {
        if (!S.dragging) return;
        // EventMouse.getDeltaX() 为主,movementX 兜底
        const dx = typeof event.getDeltaX === 'function' ? event.getDeltaX() : (event.movementX || 0);
        S.azimuthTarget += dx * 0.16; // 拖拽 → 环绕;全屏宽 ≈ 115°
    });
    const end = () => { S.dragging = false; };
    input.on(Input.EventType.MOUSE_UP, end);
    input.on(Input.EventType.MOUSE_LEAVE, end);
    input.on(Input.EventType.TOUCH_START, () => { S.dragging = true; });
    input.on(Input.EventType.TOUCH_MOVE, (event) => {
        if (!S.dragging) return;
        if (typeof event.getDeltaX === 'function') S.azimuthTarget += event.getDeltaX() * 0.16;
    });
    input.on(Input.EventType.TOUCH_END, end);
    input.on(Input.EventType.TOUCH_CANCEL, end);
}

// ---------------------------------------------------------------- 启动

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    R.app = app;
    const scene = new Scene('e02-sunset-sea');
    R.scene = scene;

    // Camera
    R.cameraNode = new Node('Main Camera');
    scene.addChild(R.cameraNode);
    R.cameraNode.setPosition(new Vec3(0, 2.2, 9.5));
    R.cameraNode.lookAt(R.lookAt);
    R.camera = R.cameraNode.addComponent(Camera);
    R.camera.projection = Camera.ProjectionType.PERSPECTIVE;
    R.camera.fov = FOV;
    R.camera.near = 0.1;
    R.camera.far = 1000;
    R.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    R.camera.clearColor = new Color(24, 34, 52, 255);
    R.camera.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式
    R.camera.priority = 0;

    // 主光:初始方向 = 太阳方向(位置 + lookAt 定 forward;DirectionalLight 只取方向)
    R.lightNode = new Node('Sun Light');
    scene.addChild(R.lightNode);
    R.lightNode.setPosition(
        new Vec3(SUN_DIST * Math.cos(SUN_EL) * Math.sin(SUN_AZ), SUN_DIST * Math.sin(SUN_EL), SUN_DIST * Math.cos(SUN_EL) * Math.cos(SUN_AZ)),
    );
    R.lightNode.lookAt(new Vec3(0, 0, 0));
    R.light = R.lightNode.addComponent(DirectionalLight);
    R.light.color = new Color(255, 214, 160, 255);
    R.light.illuminance = 42000;

    // 环境光(app.run 后经 scene.globals 配置,原位 set)
    app.run(scene);
    scene.globals.ambient.skyColorHDR.set(1.0, 0.62, 0.40, 1.0);
    scene.globals.ambient.skyIllum = 12000;

    // UI 控件(可见文本 + aria-label + data-ui 三重定位口径)
    makeButton('Reset', 'reset', () => doReset(), 'right:8px;');
    toneBtn = makeButton('Tone: Warm Sunset', 'tone-toggle', () => {
        S.toneTarget = S.toneTarget < 0.5 ? 1 : 0;
        updateToneButtonLabel();
    }, 'right:96px;');

    // 每帧驱动(波形/船体/色调/相机)
    const driverNode = new Node('Driver');
    scene.addChild(driverNode);
    driverNode.addComponent(Driver);

    // 输入
    bindInput();

    // 环境初建 + 资产加载(运行时真实网络请求)
    buildEnvironment();
    loadBoatAsync(S.epoch).catch((e) => showError('boat load failed', e));

    // 帧计数 + FPS(2s 滚动窗口)+ 就绪判定(资产加载完成且首帧已渲染)
    const frameTimes = [];
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
        if (frameTimes.length >= 2) {
            const span = (now - frameTimes[0]) / 1000;
            S.fps = span > 0 ? (frameTimes.length - 1) / span : 0;
        }
        if (!S.ready && S.assetLoaded) {
            S.ready = true;
            window.__appReady = true;
        }
    });

    console.log('[e02] running on cocosair — E02 sunset sea');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[e02] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
