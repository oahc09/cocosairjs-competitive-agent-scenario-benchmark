/**
 * E02 — 落日海面与孤舟 (cocosair.js, K0 Agent Run)
 *
 * 场景构成:
 *   - 天穹:程序化球面(双层顶点色 warm/cool,按 toneMix 逐帧插值上传),
 *     内含太阳/月亮光盘与光晕(顶点色烘焙),双面渲染避免绕序问题。
 *   - 海面:非均匀网格(中心密、远处疏)动态网格,重力波相位推进
 *     (多方向叠加正弦波,风向一致),逐帧更新顶点与顶点色
 *     (高度渐变 + 视角相关太阳镜面高光带 + 距离雾化),与船体共用同一波形函数(相位耦合)。
 *   - 孤舟:运行时 GLTFLoader.loadAsync('/assets/boat.glb') 真实网络请求加载,
 *     asset.instantiate() 保留内嵌多部件材质;随波起伏(采样同一波形)。
 *   - 相机:环绕轨道(方位角初始 35°),水平拖拽直接跟随 + 释放后惯性滑行。
 *   - 色调:toneMix 0(落日暖)↔ 1(暮蓝冷),指数平滑 ≤2.5s;
 *     天穹/海面/光照/环境光/清屏色同时演变。
 *   - Reset:释放(mesh/material/gltf asset 显式 destroy)并重建,epoch+1,
 *     恢复初始色调与方位角,wavePhase 保持全局单调。
 *
 * 页面契约:window.__appReady(资产加载完成且首帧后 true)
 *          window.__bench = { getState, reset }
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
    Material,
    GLTFLoader,
    input,
    Input,
} from 'cocosair.js';

// ---------------- 常量 ----------------
const DEG = Math.PI / 180;
const BOAT_URL = '/assets/boat.glb';
const INITIAL_AZIMUTH = 35;      // 度,spec 冻结
const DIRECT_GAIN = 0.15;        // 拖拽直接跟随增益(deg/px)
const GLIDE_SPEED = 125;         // 释放后惯性角速度(deg/s)
const GLIDE_HOLD = 1.0;          // 惯性匀速时长(s)
const GLIDE_FADE = 0.35;         // 惯性衰减时长(s)
const TONE_TAU = 0.55;           // 色调平滑时间常数(s) → 2.5s 内 >0.98
const CAM_PITCH = 9;             // 俯角(度) → 海平线在画面上 1/3 附近,海面占屏 >=50%
const CAM_DIST = 7.2;
const CAM_TARGET_Y = 1.05;
const SEA_N = 96;                // 96x96 = 9216 顶点 (>=2000)
const SEA_EXT = 130;             // 海面半边长
const SEA_WARP = 1.6;            // 中心密远处疏
const SEA_FADE_DENSITY = 0.008;  // 距离雾化(顶点色烘焙)
const DOME_R = 320;
const DOME_LON = 220;
const DOME_RINGS = 81;           // 仰角 -12°..90°
const SUN_AZ = 203;              // 太阳方位(相机初始视线 215°,偏侧 ~12°)
const SUN_EL = 4;                // 太阳仰角(度,贴近海平线的落日)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const norm360 = (d) => ((d % 360) + 360) % 360;

const SUN_DIR = (() => {
    const az = SUN_AZ * DEG, el = SUN_EL * DEG;
    const v = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
})();

// 重力波:多方向行进波(相位推进,波峰沿风向移动);船体与海面共用(相位耦合)
const WAVES = [
    { a: 0.10, dx: 0.88, dz: 0.47, k: 0.42, w: 1.05, p: 0.0 },
    { a: 0.05, dx: 0.70, dz: -0.71, k: 1.15, w: 1.90, p: 1.7 },
    { a: 0.022, dx: -0.26, dz: 0.97, k: 2.60, w: 3.00, p: 4.1 },
    { a: 0.008, dx: 0.96, dz: 0.28, k: 5.60, w: 4.60, p: 2.2 },
];

function waveSample(x, z, t) {
    let h = 0, gx = 0, gz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        const ph = w.k * (w.dx * x + w.dz * z) - w.w * t + w.p;
        h += w.a * Math.sin(ph);
        const c = w.a * w.k * Math.cos(ph);
        gx += c * w.dx;
        gz += c * w.dz;
    }
    return { h, dhdx: gx, dhdz: gz };
}

// 暖(0)/冷(1) 双端色板(线性空间 0-1)
const PAL = {
    skyTop:     [[0.98, 0.40, 0.14], [0.07, 0.10, 0.34]],
    skyMid:     [[1.00, 0.60, 0.26], [0.17, 0.21, 0.50]],
    horizon:    [[1.00, 0.80, 0.50], [0.38, 0.42, 0.70]],
    // 海面远处雾化目标 == 天穹水平线以下色(无缝衔接)
    belowSea:   [[0.83, 0.66, 0.42], [0.31, 0.35, 0.59]],
    glow:       [[1.00, 0.55, 0.22], [0.55, 0.62, 0.95]],
    sunCore:    [[1.00, 0.96, 0.85], [0.92, 0.95, 1.00]],
    lightCol:   [[1.00, 0.72, 0.45], [0.60, 0.72, 1.00]],
    ambientSky: [[0.80, 0.55, 0.40], [0.22, 0.28, 0.58]],
    seaDeep:    [[0.045, 0.018, 0.012], [0.008, 0.02, 0.07]],
    seaCrest:   [[0.28, 0.115, 0.05], [0.05, 0.11, 0.28]],
    glint:      [[1.00, 0.62, 0.28], [0.70, 0.78, 1.00]],
};
function mixPal(key, t) {
    const a = PAL[key][0], b = PAL[key][1];
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---------------- 状态(页面契约) ----------------
const state = {
    assetLoaded: false,
    assetRequests: 0,
    boatY: 0,
    wavePhase: 0,        // 全局单调递增(弧度),reset 不回退
    toneMix: 0,
    azimuthOffset: 0,    // 相对 35° 的偏移
    fps: 0,
    epoch: 0,
};
const tone = { current: 0, target: 0, lastApplied: -1 };
const cam = {
    azOffsetTarget: 0,
    glideVel: 0,
    glideT: -1,
};
const drag = { active: false, lastX: 0, totalDx: 0, sumAbs: 0 };

window.__appReady = false;

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        assetLoaded: state.assetLoaded === true,
        assetRequests: state.assetRequests,
        boatPosition: { x: 0, y: state.boatY, z: 0 },
        wavePhase: state.wavePhase,
        toneMix: tone.current,
        cameraAzimuth: norm360(INITIAL_AZIMUTH + state.azimuthOffset),
        fps: state.fps,
        epoch: state.epoch,
    }),
    reset: () => {
        try {
            state.epoch += 1;
            buildToken += 1;
            tone.current = 0; tone.target = 0;
            state.azimuthOffset = 0; cam.azOffsetTarget = 0;
            cam.glideVel = 0; cam.glideT = -1;
            drag.active = false;
            buildWorld(buildToken);
        } catch (e) {
            console.warn('[e02] reset failed:', e && e.message ? e.message : e);
        }
    },
};

// ---------------- UI 覆盖层 ----------------
function makeButton(text, dataUi, ariaText, css, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.setAttribute('data-ui', dataUi);
    btn.setAttribute('aria-label', ariaText);
    btn.style.cssText = css;
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    return btn;
}

const BTN_CSS =
    'position:fixed;z-index:9999;padding:6px 14px;font:13px/1.4 sans-serif;' +
    'background:rgba(20,22,30,0.82);color:#fff;border:1px solid rgba(255,255,255,0.35);' +
    'border-radius:6px;cursor:pointer;';

const toneBtn = makeButton('Tone: Sunset 落日', 'tone-toggle', 'tone toggle: switch warm sunset / cool dusk',
    BTN_CSS + 'top:10px;left:10px;', () => {
        tone.target = tone.target > 0.5 ? 0 : 1;
        toneBtn.textContent = tone.target > 0.5 ? 'Tone: Dusk 暮蓝' : 'Tone: Sunset 落日';
    });

makeButton('Reset', 'reset', 'reset scene',
    BTN_CSS + 'top:10px;right:10px;', () => window.__bench.reset());

const loadDiv = document.createElement('div');
loadDiv.textContent = 'Loading boat.glb …';
loadDiv.setAttribute('data-ui', 'loading-hint');
loadDiv.style.cssText =
    'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;' +
    "font:13px sans-serif;color:#ffe9c9;background:rgba(0,0,0,0.45);padding:4px 12px;border-radius:4px;";
document.body.appendChild(loadDiv);

const errDiv = document.createElement('div');
errDiv.style.cssText =
    'position:fixed;left:50%;top:48px;transform:translateX(-50%);z-index:10000;display:none;' +
    'font:13px sans-serif;color:#ffd7d7;background:rgba(120,20,20,0.85);padding:6px 14px;border-radius:4px;';
document.body.appendChild(errDiv);

function setLoading(v) { loadDiv.style.display = v ? 'block' : 'none'; }
function showError(msg) {
    errDiv.textContent = String(msg);
    errDiv.style.display = 'block';
    console.warn('[e02] asset error:', msg);
}

// ---------------- 引擎装配 ----------------
let buildToken = 0;
let sceneRef = null;
let cameraNode = null;
let camRef = null;
let mainLight = null;
let boatPivot = null;

const loader = new GLTFLoader();
const world = { sea: null, dome: null, sun: null, boat: null };
const frameTs = [];
let tiltPitch = 0, tiltRoll = 0;

let boatLift = 0.9; // 吃水补偿(包围盒底部在水线下 0.16),loadBoat 按实际包围盒计算

function makeUnlitVertexColorMaterial(name) {
    const base = builtinResMgr.get('builtin-unlit-material');
    const m = new Material(name);
    m.copy(base, { defines: { USE_VERTEX_COLOR: true } });
    try { m.recompileShaders({ USE_VERTEX_COLOR: true }); } catch (e) { /* copy 路径已带 defines */ }
    try { m.setProperty('mainColor', new Color(255, 255, 255, 255)); } catch (e) { /* 默认白 */ }
    return m;
}

function makeUnlitMaterial(name) {
    const base = builtinResMgr.get('builtin-unlit-material');
    const m = new Material(name);
    m.copy(base);
    return m;
}

function addMeshNode(name, mesh, material, parent) {
    const node = new Node(name);
    node.layer = Layers.Enum.DEFAULT;
    (parent || sceneRef).addChild(node);
    const mr = node.addComponent(MeshRenderer);
    mr.mesh = mesh;
    mr.material = material;
    return node;
}

// ---- 天穹 ----
function buildDome() {
    const lon = DOME_LON, rings = DOME_RINGS;
    const vCount = lon * rings;
    const positions = new Float32Array(vCount * 3);
    const dirs = new Float32Array(vCount * 3);
    let p = 0;
    for (let i = 0; i < rings; i++) {
        const u = i / (rings - 1);
        const el = (-12 + 102 * (1 - (1 - u) * (1 - u))) * DEG; // 近水平线密
        const ce = Math.cos(el), se = Math.sin(el);
        for (let j = 0; j < lon; j++) {
            const az = (j / lon) * Math.PI * 2;
            const dx = ce * Math.sin(az), dy = se, dz = ce * Math.cos(az);
            dirs[p] = dx; dirs[p + 1] = dy; dirs[p + 2] = dz;
            positions[p] = dx * DOME_R; positions[p + 1] = dy * DOME_R; positions[p + 2] = dz * DOME_R;
            p += 3;
        }
    }
    const quads = (rings - 1) * lon;
    const indices = new Uint16Array(quads * 6);
    let q = 0;
    for (let i = 0; i < rings - 1; i++) {
        for (let j = 0; j < lon; j++) {
            const j2 = (j + 1) % lon;
            const a = i * lon + j, b = i * lon + j2, c = (i + 1) * lon + j, d = (i + 1) * lon + j2;
            indices[q++] = a; indices[q++] = c; indices[q++] = b;
            indices[q++] = b; indices[q++] = c; indices[q++] = d;
        }
    }
    const warm = new Float32Array(vCount * 3);
    const cool = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) {
        domeColorAt(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], 0, warm, i * 3);
        domeColorAt(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], 1, cool, i * 3);
    }
    const colors = new Float32Array(vCount * 4); // RGBA32F
    const geo = { positions, colors, indices16: indices, doubleSided: true };
    const mesh = utils.MeshUtils.createDynamicMesh(0, geo, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: vCount,
        maxSubMeshIndices: indices.length,
    });
    const mat = makeUnlitVertexColorMaterial('e02-sky-vc');
    const node = addMeshNode('SkyDome', mesh, mat);
    world.dome = { node, mesh, mat, geo, warm, cool, vCount };
}

function domeColorAt(dx, dy, dz, t, out, o) {
    const el = Math.asin(clamp(dy, -1, 1)) / DEG;
    const hor = PAL.horizon[t], mid = PAL.skyMid[t], top = PAL.skyTop[t], below = PAL.belowSea[t];
    let r, g, b;
    if (el >= 0) {
        const gg = clamp(el / 60, 0, 1);
        if (gg < 0.42) {
            const f = gg / 0.42;
            r = hor[0] + (mid[0] - hor[0]) * f;
            g = hor[1] + (mid[1] - hor[1]) * f;
            b = hor[2] + (mid[2] - hor[2]) * f;
        } else {
            const f = (gg - 0.42) / 0.58;
            r = mid[0] + (top[0] - mid[0]) * f;
            g = mid[1] + (top[1] - mid[1]) * f;
            b = mid[2] + (top[2] - mid[2]) * f;
        }
    } else {
        const f = clamp(-el / 9, 0, 1);
        r = hor[0] + (below[0] - hor[0]) * f;
        g = hor[1] + (below[1] - hor[1]) * f;
        b = hor[2] + (below[2] - hor[2]) * f;
    }
    const cd = dx * SUN_DIR[0] + dy * SUN_DIR[1] + dz * SUN_DIR[2];
    if (cd > 0.72) {
        const ang = Math.acos(clamp(cd, -1, 1)) / DEG;
        const glow = Math.exp(-(ang * ang) / (2 * 8.5 * 8.5));
        const gl = PAL.glow[t];
        r += gl[0] * glow * 0.85;
        g += gl[1] * glow * 0.85;
        b += gl[2] * glow * 0.85;
        let dm = 0;
        if (ang < 2.9) dm = ang < 2.1 ? 1 : 1 - (ang - 2.1) / 0.8;
        if (dm > 0) {
            const sc = PAL.sunCore[t];
            const cr = sc[0] * 1.3, cg = sc[1] * 1.3, cb = sc[2] * 1.3;
            r += (cr - r) * dm;
            g += (cg - g) * dm;
            b += (cb - b) * dm;
        }
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

// ---- 海面 ----
function buildSea() {
    const n = SEA_N;
    const vCount = n * n;
    const positions = new Float32Array(vCount * 3);
    const baseX = new Float32Array(vCount);
    const baseZ = new Float32Array(vCount);
    const fade = new Float32Array(vCount);
    const idxOf = (ix, iz) => iz * n + ix;
    const warp = (u) => Math.sign(u) * Math.pow(Math.abs(u), SEA_WARP);
    for (let iz = 0; iz < n; iz++) {
        const z = warp((iz / (n - 1)) * 2 - 1) * SEA_EXT;
        for (let ix = 0; ix < n; ix++) {
            const x = warp((ix / (n - 1)) * 2 - 1) * SEA_EXT;
            const i = idxOf(ix, iz);
            baseX[i] = x; baseZ[i] = z;
            positions[i * 3] = x;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = z;
            fade[i] = 1 - Math.exp(-Math.sqrt(x * x + z * z) * SEA_FADE_DENSITY);
        }
    }
    const indices = new Uint16Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let iz = 0; iz < n - 1; iz++) {
        for (let ix = 0; ix < n - 1; ix++) {
            const a = idxOf(ix, iz), b = idxOf(ix + 1, iz), c = idxOf(ix, iz + 1), d = idxOf(ix + 1, iz + 1);
            indices[q++] = a; indices[q++] = c; indices[q++] = b;
            indices[q++] = b; indices[q++] = c; indices[q++] = d;
        }
    }
    const colors = new Float32Array(vCount * 4);
    const geo = { positions, colors, indices16: indices, doubleSided: true };
    const mesh = utils.MeshUtils.createDynamicMesh(0, geo, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: vCount,
        maxSubMeshIndices: indices.length,
    });
    const mat = makeUnlitVertexColorMaterial('e02-sea-vc');
    const node = addMeshNode('Sea', mesh, mat);
    world.sea = { node, mesh, mat, geo, baseX, baseZ, fade, vCount };
}

// ---- 太阳/月亮光盘 ----
function buildSun() {
    const mesh = utils.createMesh(primitives.sphere(10.5));
    const mat = makeUnlitMaterial('e02-sun');
    const node = addMeshNode('SunDisc', mesh, mat);
    node.setPosition(SUN_DIR[0] * 300, SUN_DIR[1] * 300, SUN_DIR[2] * 300);
    world.sun = { node, mesh, mat };
}

// ---- 船体 ----
async function loadBoat(token) {
    try {
        const asset = await loader.loadAsync(BOAT_URL);
        if (token !== buildToken) {
            try { asset.destroy(); } catch (e) { /* 已被新 epoch 接管 */ }
            return;
        }
        const inst = asset.instantiate(0);
        if (token !== buildToken) {
            try { inst.dispose(); asset.destroy(); } catch (e) { /* ignore */ }
            return;
        }
        const holder = new Node('BoatHolder');
        holder.layer = Layers.Enum.DEFAULT;
        boatPivot.addChild(holder);
        holder.addChild(inst.root);

        // 包围盒(网格空间)→ 居中 + 归一尺度 + 朝向
        let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        let ok = false;
        const meshes = asset.meshes || [];
        for (let i = 0; i < meshes.length; i++) {
            const s = meshes[i].struct;
            if (!s || !s.minPosition || !s.maxPosition) continue;
            ok = true;
            mnx = Math.min(mnx, s.minPosition.x); mny = Math.min(mny, s.minPosition.y); mnz = Math.min(mnz, s.minPosition.z);
            mxx = Math.max(mxx, s.maxPosition.x); mxy = Math.max(mxy, s.maxPosition.y); mxz = Math.max(mxz, s.maxPosition.z);
        }
        // 资产契约:最长边 1-4,默认不缩放;仅越界时归一到 2.4
        let scale = 1, cx = 0, cy = 0, cz = 0;
        if (ok) {
            cx = (mnx + mxx) / 2; cy = (mny + mxy) / 2; cz = (mnz + mxz) / 2;
            const maxDim = Math.max(mxx - mnx, mxy - mny, mxz - mnz);
            if (maxDim > 4.5 || maxDim < 0.8) scale = clamp(2.4 / maxDim, 0.4, 2.5);
            // 船底(包围盒最小 Y,含龙骨)位于水线下 0.20 → 波谷时船身清晰
            boatLift = clamp(-0.20 - mny * scale, 0.05, 3.0);
        }
        holder.setScale(scale, scale, scale);
        holder.setRotationFromEuler(0, 68, 0); // 侧向 3/4 视角:船身与帆均可见
        // T = -R(Y65°) * (c*scale)
        const px = cx * scale, py = cy * scale, pz = cz * scale;
        const cs = Math.cos(65 * DEG), sn = Math.sin(65 * DEG);
        const tx = px * cs + pz * sn, tz = -px * sn + pz * cs;
        holder.setPosition(-tx, -py, -tz);

        world.boat = { holder, inst, asset };
        state.assetRequests += 1;
        state.assetLoaded = true;
        setLoading(false);
    } catch (err) {
        if (token === buildToken) {
            showError('boat.glb 加载失败: ' + (err && err.message ? err.message : err));
        }
    }
}

// ---- 释放(显式 GPU 侧) ----
function destroyGroup(g) {
    if (!g) return;
    try { if (g.node) { g.node.removeFromParent(); g.node.destroy(); } } catch (e) { /* ignore */ }
    try { if (g.mesh && g.mesh.destroy) g.mesh.destroy(); } catch (e) { /* ignore */ }
    try { if (g.mat && g.mat.destroy) g.mat.destroy(); } catch (e) { /* ignore */ }
    try { if (g.inst && g.inst.dispose) g.inst.dispose(); } catch (e) { /* ignore */ }
    try { if (g.asset && g.asset.destroy) g.asset.destroy(); } catch (e) { /* ignore */ }
}

function teardownWorld() {
    destroyGroup(world.sea); world.sea = null;
    destroyGroup(world.dome); world.dome = null;
    destroyGroup(world.sun); world.sun = null;
    destroyGroup(world.boat); world.boat = null;
}

async function buildWorld(token) {
    teardownWorld();
    state.assetLoaded = false;
    setLoading(true);
    buildDome();
    buildSea();
    buildSun();
    applyTone(true);
    await loadBoat(token);
}

// ---- 色调应用 ----
function applyTone(force) {
    const t = tone.current;
    if (!force && Math.abs(t - tone.lastApplied) < 0.002) return;
    tone.lastApplied = t;
    state.toneMix = t;

    if (world.dome) {
        const { warm, cool, geo, vCount } = world.dome;
        const colors = geo.colors;
        for (let i = 0; i < vCount; i++) {
            const w = i * 3, c = i * 4;
            colors[c] = warm[w] + (cool[w] - warm[w]) * t;
            colors[c + 1] = warm[w + 1] + (cool[w + 1] - warm[w + 1]) * t;
            colors[c + 2] = warm[w + 2] + (cool[w + 2] - warm[w + 2]) * t;
            colors[c + 3] = 1;
        }
        try { world.dome.mesh.updateSubMesh(0, geo); } catch (e) { /* 同尺寸重建上传 */ }
    }
    if (world.sun) {
        const sc = mixPal('sunCore', t);
        try { world.sun.mat.setProperty('mainColor', new Color(sc[0] * 255, sc[1] * 255, sc[2] * 255, 255)); } catch (e) { /* ignore */ }
    }
    if (mainLight) {
        const lc = mixPal('lightCol', t);
        try { mainLight.color = new Color(lc[0] * 255, lc[1] * 255, lc[2] * 255, 255); } catch (e) { /* ignore */ }
    }
    if (sceneRef) {
        const ac = mixPal('ambientSky', t);
        try { sceneRef.globals.ambient.skyColorHDR.set(ac[0], ac[1], ac[2], 1.0); } catch (e) { /* ignore */ }
    }
    if (camRef) {
        const hc = mixPal('horizon', t);
        try { camRef.clearColor = new Color(hc[0] * 255, hc[1] * 255, hc[2] * 255, 255); } catch (e) { /* ignore */ }
    }
}

// ---- 海面逐帧更新(波形相位推进 + 顶点色光照) ----
function updateSea(t) {
    const sea = world.sea;
    if (!sea) return;
    const tc = tone.current;
    const deep = mixPal('seaDeep', tc), crest = mixPal('seaCrest', tc);
    const glint = mixPal('glint', tc), hor = mixPal('horizon', tc);
    const fadeCol = [
        lerp(PAL.belowSea[0][0], PAL.belowSea[1][0], tc),
        lerp(PAL.belowSea[0][1], PAL.belowSea[1][1], tc),
        lerp(PAL.belowSea[0][2], PAL.belowSea[1][2], tc),
    ];
    const cp = cameraNode ? cameraNode.position : { x: 0, y: 2.2, z: 0 };
    const Lx = SUN_DIR[0], Ly = SUN_DIR[1], Lz = SUN_DIR[2];
    const pos = sea.geo.positions, col = sea.geo.colors;
    const baseX = sea.baseX, baseZ = sea.baseZ, fade = sea.fade;
    for (let i = 0; i < sea.vCount; i++) {
        const x = baseX[i], z = baseZ[i];
        let h = 0, gx = 0, gz = 0;
        for (let wi = 0; wi < WAVES.length; wi++) {
            const w = WAVES[wi];
            const ph = w.k * (w.dx * x + w.dz * z) - w.w * t + w.p;
            h += w.a * Math.sin(ph);
            const c = w.a * w.k * Math.cos(ph);
            gx += c * w.dx; gz += c * w.dz;
        }
        pos[i * 3 + 1] = h;

        const nx = -gx, ny = 1, nz = -gz;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        const vx = cp.x - x, vy = cp.y - h, vz = cp.z - z;
        const vn = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        const ndl = (nx * inv) * Lx + (ny * inv) * Ly + (nz * inv) * Lz;
        const rx = 2 * ndl * (nx * inv) - Lx;
        const ry = 2 * ndl * (ny * inv) - Ly;
        const rz = 2 * ndl * (nz * inv) - Lz;
        const rn = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-6);
        const rv = (rx * vx + ry * vy + rz * vz) * vn * rn;
        let sp = 0;
        if (rv > 0) {
            // 乘法链代替 pow(帧率):r120 = r64*r32*r16*r8
            const r2 = rv * rv;
            const r4 = r2 * r2;
            const r8 = r4 * r4;
            const r16 = r8 * r8;
            const r32 = r16 * r16;
            const r64 = r32 * r32;
            sp = r64 * r32 * r16 * r8 * 1.6 + r8 * 0.10;
        }
        const frN = 1 - (ny * inv);
        const fr = frN * frN * frN * 0.40; // 菲涅尔:掠射角反射天光

        let hn = (h + 0.20) / 0.40;
        hn = hn < 0 ? 0 : hn > 1 ? 1 : hn;
        const br = deep[0] + (crest[0] - deep[0]) * hn;
        const bg = deep[1] + (crest[1] - deep[1]) * hn;
        const bb = deep[2] + (crest[2] - deep[2]) * hn;
        const f = fade[i];
        const gk = 1 - 0.7 * f;
        col[i * 4] = br + (fadeCol[0] - br) * f + (glint[0] * sp + hor[0] * fr) * gk;
        col[i * 4 + 1] = bg + (fadeCol[1] - bg) * f + (glint[1] * sp + hor[1] * fr) * gk;
        col[i * 4 + 2] = bb + (fadeCol[2] - bb) * f + (glint[2] * sp + hor[2] * fr) * gk;
        col[i * 4 + 3] = 1;
    }
    try { sea.mesh.updateSubMesh(0, sea.geo); } catch (e) { /* ignore */ }
}

// ---- 船体逐帧(与海面同一波形函数 — 相位耦合) ----
function updateBoat(t, dt) {
    const s = waveSample(0, 0, t);
    if (boatPivot) {
        boatPivot.setPosition(0, s.h * 0.9 + boatLift, 0);
        state.boatY = boatPivot.position.y;
    }
    const kp = Math.atan(s.dhdz) * 0.7;
    const kr = Math.atan(s.dhdx) * 0.7;
    const k = 1 - Math.exp(-dt / 0.3);
    tiltPitch += (kp - tiltPitch) * k;
    tiltRoll += (kr - tiltRoll) * k;
    if (world.boat && world.boat.holder) {
        // holder 旋转会改变包围盒中心补偿,故把摇摆放在 inst.root 上
        try { world.boat.inst.root.setRotationFromEuler(tiltPitch / DEG, 0, tiltRoll / DEG); } catch (e) { /* ignore */ }
    }
}

// ---- 逐帧驱动组件 ----
class Driver extends Component {
    update(dt) {
        const d = Math.min(dt, 0.1);
        if (!isFinite(d) || d < 0) return; // 引擎异常 dt 守卫
        // 相机状态自愈(任何异常输入导致的 NaN 不外溢)
        if (!isFinite(state.azimuthOffset) || !isFinite(cam.azOffsetTarget)) {
            state.azimuthOffset = 0; cam.azOffsetTarget = 0; cam.glideVel = 0; cam.glideT = -1;
        }
        state.wavePhase += d;
        const t = state.wavePhase;

        // 色调平滑(≤2.5s)
        tone.current += (tone.target - tone.current) * (1 - Math.exp(-d / TONE_TAU));
        if (tone.target - tone.current < 0.0008 && tone.target > tone.current) tone.current = tone.target;
        applyTone(false);

        // 相机方位:直接跟随平滑 + 惯性滑行
        state.azimuthOffset += (cam.azOffsetTarget - state.azimuthOffset) * (1 - Math.exp(-d / 0.12));
        if (cam.glideT >= 0) {
            cam.glideT += d;
            let v = cam.glideVel;
            if (cam.glideT > GLIDE_HOLD) v *= Math.max(0, 1 - (cam.glideT - GLIDE_HOLD) / GLIDE_FADE);
            state.azimuthOffset += v * d;
            if (cam.glideT > GLIDE_HOLD + GLIDE_FADE) { cam.glideT = -1; cam.glideVel = 0; }
        }
        if (cameraNode) {
            const az = (INITIAL_AZIMUTH + state.azimuthOffset) * DEG;
            const pit = CAM_PITCH * DEG;
            const cy = CAM_TARGET_Y + CAM_DIST * Math.sin(pit);
            cameraNode.setPosition(
                CAM_DIST * Math.cos(pit) * Math.sin(az),
                cy,
                CAM_DIST * Math.cos(pit) * Math.cos(az),
            );
            cameraNode.lookAt(new Vec3(0, CAM_TARGET_Y, 0));
        }

        updateSea(t);
        updateBoat(t, d);

        // fps(2s 滚动平均)
        const now = Date.now();
        frameTs.push(now);
        while (frameTs.length > 0 && frameTs[0] < now - 2000) frameTs.shift();
        state.fps = frameTs.length / 2;
    }
}

// ---- 输入:canvas 直接监听 ----
// 经 bundle 核实:pal 层对 canvas 鼠标事件仅 stopPropagation(不阻断同元素更早注册的监听),
// 故本模块在引擎之前注册的 canvas 监听可稳定收到原生/合成拖拽事件。
// 所有坐标过 isFinite 守卫,杜绝 NaN 进入相机状态。
function inputDown(x) {
    x = Number(x);
    if (!isFinite(x)) return;
    drag.active = true; drag.totalDx = 0; drag.sumAbs = 0; drag.lastX = x;
}
function inputMove(x) {
    if (!drag.active) return;
    x = Number(x);
    if (!isFinite(x)) return;
    const dx = x - drag.lastX;
    drag.lastX = x;
    drag.totalDx += dx;
    drag.sumAbs += Math.abs(dx);
    cam.azOffsetTarget += dx * DIRECT_GAIN;
}
function inputUp() {
    if (!drag.active) return;
    drag.active = false;
    if (drag.sumAbs > 24 && drag.totalDx !== 0 && isFinite(drag.totalDx)) {
        cam.glideVel = GLIDE_SPEED * Math.sign(drag.totalDx);
        cam.glideT = 0;
    }
}
(() => {
    const cv = document.querySelector('#GameCanvas');
    if (!cv) return;
    cv.addEventListener('mousedown', (e) => inputDown(e.clientX));
    cv.addEventListener('mousemove', (e) => { if (drag.active || (e.buttons & 1)) inputMove(e.clientX); });
    cv.addEventListener('mouseup', () => inputUp());
    window.addEventListener('mouseup', () => { if (drag.active) inputUp(); });
    window.addEventListener('blur', () => { if (drag.active) inputUp(); });
    cv.addEventListener('touchstart', (e) => { const t = e.changedTouches && e.changedTouches[0]; if (t) inputDown(t.clientX); }, { passive: true });
    cv.addEventListener('touchmove', (e) => { const t = e.changedTouches && e.changedTouches[0]; if (t) inputMove(t.clientX); }, { passive: true });
    cv.addEventListener('touchend', () => inputUp());
    cv.addEventListener('touchcancel', () => inputUp());
})();

// ---------------- 启动 ----------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E02-SunsetSea');
    sceneRef = scene;

    // Camera
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 2.2, 8);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 1000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(255, 200, 128, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    camRef = camera;

    // 主光(方向/色温随 toneMix 演变)
    const lightNode = new Node('SunLight');
    scene.addChild(lightNode);
    lightNode.setRotationFromEuler(-SUN_EL, SUN_AZ, 0);
    mainLight = lightNode.addComponent(DirectionalLight);
    mainLight.illuminance = 50000;

    // 环境光
    scene.globals.ambient.skyColorHDR.set(0.80, 0.55, 0.40, 1.0);
    scene.globals.ambient.skyIllum = 28000;

    // 船体挂点(持久;摇摆作用于 inst.root,不破坏包围盒补偿)
    boatPivot = new Node('BoatPivot');
    boatPivot.layer = Layers.Enum.DEFAULT;
    scene.addChild(boatPivot);
    boatPivot.setPosition(0, boatLift, 0);

    // 逐帧驱动
    const driverNode = new Node('Driver');
    scene.addChild(driverNode);
    driverNode.addComponent(Driver);

    window.__airApp = app;
    app.run(scene);

    // 首帧 + 就绪(资产加载完成后)
    let readySet = false;
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!readySet && state.assetLoaded) {
            readySet = true;
            window.__appReady = true;
        }
    });

    buildWorld(++buildToken);

    // 本地视觉调试入口(仅当 URL 带 #cool;默认页面 toneMix 恒为 0,不影响规格初始态)
    if (window.location && window.location.hash && window.location.hash.indexOf('cool') >= 0) {
        setTimeout(() => { tone.current = 1; tone.target = 1; applyTone(true); }, 300);
    }

    console.log('[e02] running on cocosair — scene', app.getScene() ? app.getScene().name : '?');
} catch (err) {
    console.error('[e02] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
