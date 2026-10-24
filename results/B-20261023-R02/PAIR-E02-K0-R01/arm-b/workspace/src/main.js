/**
 * E02 — 落日海面与孤舟(cocosair / Arm B / K0)
 *
 * 实现路径(全程使用技能包文档核实过的 API,无自定义 shader):
 *  - 海面:CPU 动态网格(utils.MeshUtils.createDynamicMesh + Mesh.updateSubMesh,
 *    每帧重算 4 波分量正弦叠加的顶点高度与解析法线),builtin-standard 材质受光
 *    (方向光镜面高光带 = 落日海面光路)。非线性网格:近密远疏。
 *  - 天空:半球穹顶静态网格 + builtin-unlit(USE_TEXTURE)+ 程序化等距柱状渐变贴图
 *    (含太阳/月亮光盘与光晕;色调切换时按 toneMix 重绘并重新上传)。
 *  - 孤舟:GLTFLoader.loadAsync('assets/boat.glb') 运行时真实网络加载,instantiate
 *    后保留资产内嵌多部件材质;包围盒测量归一化尺寸并定位到水线;随波起伏
 *    (同一 waveAt 函数采样 = 相位耦合),带纵摇/横摇。
 *  - 相机:方位角梯形速度曲线平滑环绕(无跳变);海平线约画面上 1/3。
 *  - 色调:暖(落日橙金)↔ 冷(暮蓝),天空贴图 + 光照 + 环境光 + 海色同时演变。
 *  - Reset:销毁船/海/天空的 GPU 资源(gltf instance.dispose+asset.destroy、
 *    mesh/material/texture.destroy)后重建并重新网络加载资产,epoch+1。
 *
 * 页面契约:window.__appReady(资产加载完成且首帧渲染后 true)、
 * window.__bench = { getState, reset }。
 */

import * as engine from 'cocosair.js';

const {
    createAirApp, Scene, Node, Camera, DirectionalLight, MeshRenderer, Component,
    Layers, Vec3, Color, Material, Texture2D, ImageAsset, utils,
    GLTFLoader, director, Director,
} = engine;

// 引擎 input 单例(技能包:canvas 鼠标事件被 pal 层吞,必须走引擎 input.on;
// Input.EventType 的枚举值即 'mouse-down' 等字符串)
const inputSingleton = engine.input || engine.systemEvent || null;

// ---------------------------------------------------------------------------
// 运行状态(__bench 契约字段 + 内部控制量)
// ---------------------------------------------------------------------------
const S = {
    assetLoaded: false,      // boat.glb 成功加载并实例化
    assetRequests: 0,        // 完成加载的请求计数(reset 重载 +1)
    toneMix: 0,              // 0=暖(落日) 1=冷(暮蓝)
    toneTarget: 0,
    simTime: 0,              // 模拟时间(reset 归零);wavePhase = simTime
    azimuth: 35,             // 当前方位角(度)
    azimuthTarget: 35,
    azVel: 0,                // 方位角角速度(度/秒,梯形速度曲线)
    epoch: 0,                // 释放重建计数
    fps: 0,                  // 2s 滚动平均
    loadingBoat: false,
};

const W = {
    app: null, scene: null,
    camNode: null, camera: null,
    lightNode: null, light: null,
    sea: null, sky: null, boat: null,
};

window.__appReady = false;

function boatPosition() {
    if (W.boat && W.boat.measured) {
        return { x: 0, y: W.boat.pivot.position.y + W.boat.centerY, z: 0 };
    }
    return { x: 0, y: 0, z: 0 };
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        assetLoaded: S.assetLoaded,
        assetRequests: S.assetRequests,
        boatPosition: boatPosition(),
        wavePhase: S.simTime,
        toneMix: S.toneMix,
        cameraAzimuth: S.azimuth,
        fps: S.fps,
        epoch: S.epoch,
    }),
    reset: () => doReset(),
};

// ---------------------------------------------------------------------------
// 常量:相机 / 太阳 / 波分量 / 色板
// ---------------------------------------------------------------------------
const CAM_DIST = 11.5;
const CAM_EL = 13.5;                        // 俯角(度):海平线约画面上 1/3
const CAM_TARGET = new Vec3(0, 0.85, 0);
const CAM_FOV = 50;

const SUN_AZ = 196;                          // 太阳方位(度);相机初始方位 35 →
const SUN_ELEV_DISC = 7;                     // 视线方位 215,太阳位于中轴偏侧 ~19°
const SUN_ELEV_LIGHT = 14;                   // 主光仰角略高于光盘(利于船体受光)

const DEG = Math.PI / 180;

function dirFromAzEl(azDeg, elDeg) {
    const az = azDeg * DEG, el = elDeg * DEG;
    return {
        x: Math.sin(az) * Math.cos(el),
        y: Math.sin(el),
        z: Math.cos(az) * Math.cos(el),
    };
}
const SUN_DIR_DISC = dirFromAzEl(SUN_AZ, SUN_ELEV_DISC);   // 天空贴图光盘方向

// 4 个重力波分量:方向(dx,dz 归一化)、波数 k=2π/λ、角频率 w、振幅 a
const WAVES = [
    { dx: 0.940, dz: 0.341, k: 0.3927, w: 0.90, a: 0.240 },  // λ≈16
    { dx: -0.573, dz: 0.820, k: 0.8378, w: 1.35, a: 0.130 }, // λ≈7.5
    { dx: 0.830, dz: -0.558, k: 1.8480, w: 2.10, a: 0.048 }, // λ≈3.4
    { dx: -0.350, dz: -0.937, k: 3.6960, w: 3.20, a: 0.020 },// λ≈1.7
];

// 波高与解析梯度(距离衰减高频分量;船与海面网格共用 = 相位耦合)
function waveAt(x, z, t) {
    const d2 = x * x + z * z;
    let h = 0, dhdx = 0, dhdz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const wv = WAVES[i];
        const att = 1 / (1 + d2 * wv.k * wv.k * 0.00005);
        const ph = wv.k * (wv.dx * x + wv.dz * z) + wv.w * t;
        const s = Math.sin(ph), c = Math.cos(ph);
        const aa = wv.a * att;
        h += aa * s;
        dhdx += aa * wv.k * wv.dx * c;
        dhdz += aa * wv.k * wv.dz * c;
    }
    return { h, dhdx, dhdz };
}

// 色板(0-255 字节;Color setProperty 以 0-255 写入)
const PALETTE = {
    lightWarm: new Color(255, 196, 148, 255),
    lightCool: new Color(168, 190, 255, 255),
    ambientWarm: [0.95, 0.66, 0.50],
    ambientCool: [0.44, 0.54, 0.95],
    seaWarm: new Color(40, 98, 104, 255),
    seaCool: new Color(24, 52, 96, 255),
    // 天空(等距柱状图,按仰角渐变 + 光盘/光晕)
    skyWarm: {
        zenith: [70, 56, 118], mid: [168, 86, 96], horizon: [255, 146, 62],
        below: [48, 54, 70],   // 地平线以下:贴近远海深色,弱化海面边缘接缝
        disc: [255, 238, 186], glow: [255, 150, 62], glowPow: 120, glowAmt: 0.55,
        discCos: Math.cos(1.6 * DEG),
    },
    skyCool: {
        zenith: [14, 22, 62], mid: [34, 50, 108], horizon: [148, 168, 220],
        below: [22, 32, 58],
        disc: [236, 242, 255], glow: [108, 138, 224], glowPow: 170, glowAmt: 0.38,
        discCos: Math.cos(1.3 * DEG),
    },
};

function lerp(a, b, t) { return a + (b - a) * t; }
function mix3(a, b, t, out) {
    out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
    return out;
}
function lerpColor(a, b, t) {
    return new Color(
        Math.round(lerp(a.r, b.r, t)),
        Math.round(lerp(a.g, b.g, t)),
        Math.round(lerp(a.b, b.b, t)), 255);
}
function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// UI 覆盖层(色调切换 / Reset / 加载与错误提示)
// ---------------------------------------------------------------------------
const ui = {};
function buildUI() {
    const css =
        'position:fixed;top:10px;z-index:9999;padding:5px 14px;font:13px sans-serif;' +
        'background:rgba(20,24,32,0.78);color:#eee;border:1px solid #666;' +
        'border-radius:5px;cursor:pointer';
    ui.toneBtn = document.createElement('button');
    ui.toneBtn.textContent = 'Tone: Warm';
    ui.toneBtn.setAttribute('aria-label', 'tone-toggle');
    ui.toneBtn.setAttribute('data-ui', 'tone-toggle');
    ui.toneBtn.style.cssText = css + ';right:104px';
    ui.toneBtn.addEventListener('click', () => {
        S.toneTarget = S.toneTarget > 0.5 ? 0 : 1;
        ui.toneBtn.textContent = S.toneTarget > 0.5 ? 'Tone: Cold' : 'Tone: Warm';
    });
    document.body.appendChild(ui.toneBtn);

    ui.resetBtn = document.createElement('button');
    ui.resetBtn.textContent = 'Reset';
    ui.resetBtn.setAttribute('aria-label', 'reset');
    ui.resetBtn.setAttribute('data-ui', 'reset');
    ui.resetBtn.style.cssText = css + ';right:16px';
    ui.resetBtn.addEventListener('click', () => doReset());
    document.body.appendChild(ui.resetBtn);

    ui.loading = document.createElement('div');
    ui.loading.textContent = 'Loading boat...';
    ui.loading.style.cssText =
        'position:fixed;top:12px;left:12px;z-index:9999;padding:4px 10px;' +
        "font:12px sans-serif;color:#ffd9a0;background:rgba(20,24,32,0.7);" +
        'border-radius:4px';
    document.body.appendChild(ui.loading);

    ui.error = document.createElement('div');
    ui.error.style.cssText =
        'position:fixed;top:44px;left:12px;z-index:9999;padding:4px 10px;' +
        "font:12px sans-serif;color:#ff8080;background:rgba(40,10,10,0.8);" +
        'border-radius:4px;display:none';
    document.body.appendChild(ui.error);
}
function showError(msg) {
    ui.error.textContent = msg;
    ui.error.style.display = 'block';
}

// ---------------------------------------------------------------------------
// 天空:穹顶网格 + 程序化等距柱状贴图(渐变 + 光盘 + 光晕)
// ---------------------------------------------------------------------------
const SKY_W = 512, SKY_H = 256;
const DOME_R = 460, DOME_ROWS = 34, DOME_COLS = 72;
const DOME_EL_MIN = -10, DOME_EL_SPAN = 100;   // 与贴图 v 映射一致

function buildDomeGeometry() {
    const vertsPerRow = DOME_COLS + 1;
    const V = (DOME_ROWS + 1) * vertsPerRow;
    const positions = new Float32Array(V * 3);
    const uvs = new Float32Array(V * 2);
    const indices = new Uint16Array(DOME_ROWS * DOME_COLS * 6);
    let p = 0, uv = 0;
    for (let i = 0; i <= DOME_ROWS; i++) {
        const el = (DOME_EL_MIN + (i / DOME_ROWS) * DOME_EL_SPAN) * DEG;
        const ce = Math.cos(el), se = Math.sin(el);
        const v = i / DOME_ROWS;
        for (let j = 0; j <= DOME_COLS; j++) {
            const az = (j / DOME_COLS) * 360 * DEG;
            positions[p++] = Math.sin(az) * ce * DOME_R;
            positions[p++] = se * DOME_R;
            positions[p++] = Math.cos(az) * ce * DOME_R;
            uvs[uv++] = j / DOME_COLS;
            uvs[uv++] = v;
        }
    }
    let idx = 0;
    for (let i = 0; i < DOME_ROWS; i++) {
        for (let j = 0; j < DOME_COLS; j++) {
            const a = i * vertsPerRow + j;
            const b = a + 1;
            const c = a + vertsPerRow;
            const d = c + 1;
            // 内向面(从穹顶内侧可见;材质亦设双面)
            indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
            indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
        }
    }
    return {
        positions, uvs, indices,
        minPos: new Vec3(-DOME_R, -DOME_R, -DOME_R),
        maxPos: new Vec3(DOME_R, DOME_R, DOME_R),
    };
}

function buildSky() {
    const mesh = utils.MeshUtils.createMesh(buildDomeGeometry());
    const node = new Node('sky');
    node.layer = Layers.Enum.DEFAULT;
    W.scene.addChild(node);
    const renderer = node.addComponent(MeshRenderer);
    renderer.mesh = mesh;

    const material = new Material();
    material.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: true },
        states: { rasterizerState: { cullMode: 2 } },   // gfx.CullMode.NONE:内侧可见
    });
    // 程序化贴图:cocosair-assets 技能口径 —— reset(info) 后用 uploadData(source, level)
    // 从类型化数组直接灌像素(ArrayBufferView → copyBuffersToTexture,可重复上传)。
    // 注意:reset 后 gfx 资源失效,必须先 uploadData 再绑定给材质。
    const texture = new Texture2D();
    texture.reset({ width: SKY_W, height: SKY_H, format: Texture2D.PixelFormat.RGBA8888 });
    const pixels = new Uint8Array(SKY_W * SKY_H * 4);
    W.sky = { mesh, renderer, material, node, texture, pixels, paintedMix: -1 };
    paintSky(S.toneMix);
    material.setProperty('mainTexture', texture);
    renderer.setSharedMaterial(material, 0);
}

// 按仰角取天空基色(暖/冷插值),再叠加光盘与光晕;uploadData 直接灌像素。
// 行序:缓冲行 0 → 纹理 v=0 → 穹顶底部(仰角 -10°),故行号 y 与仰角同向递增。
function paintSky(mix) {
    const sky = W.sky;
    if (!sky) return;
    const d = sky.pixels;
    const zen = mix3(PALETTE.skyWarm.zenith, PALETTE.skyCool.zenith, mix, [0, 0, 0]);
    const mid = mix3(PALETTE.skyWarm.mid, PALETTE.skyCool.mid, mix, [0, 0, 0]);
    const hor = mix3(PALETTE.skyWarm.horizon, PALETTE.skyCool.horizon, mix, [0, 0, 0]);
    const below = mix3(PALETTE.skyWarm.below, PALETTE.skyCool.below, mix, [0, 0, 0]);
    const disc = mix3(PALETTE.skyWarm.disc, PALETTE.skyCool.disc, mix, [0, 0, 0]);
    const glow = mix3(PALETTE.skyWarm.glow, PALETTE.skyCool.glow, mix, [0, 0, 0]);
    const glowPow = lerp(PALETTE.skyWarm.glowPow, PALETTE.skyCool.glowPow, mix);
    const glowAmt = lerp(PALETTE.skyWarm.glowAmt, PALETTE.skyCool.glowAmt, mix);
    const discCos = lerp(PALETTE.skyWarm.discCos, PALETTE.skyCool.discCos, mix);

    const rowColor = new Float32Array(SKY_H * 3);
    for (let y = 0; y < SKY_H; y++) {
        const v = y / (SKY_H - 1);
        const el = DOME_EL_MIN + v * DOME_EL_SPAN;
        let c;
        if (el < 0) {
            const t = smoothstep(DOME_EL_MIN, 0, el);
            c = [lerp(below[0], hor[0], t), lerp(below[1], hor[1], t), lerp(below[2], hor[2], t)];
        } else if (el < 22) {
            const t = smoothstep(0, 22, el);
            c = [lerp(hor[0], mid[0], t), lerp(hor[1], mid[1], t), lerp(hor[2], mid[2], t)];
        } else {
            const t = smoothstep(22, 75, el);
            c = [lerp(mid[0], zen[0], t), lerp(mid[1], zen[1], t), lerp(mid[2], zen[2], t)];
        }
        rowColor[y * 3] = c[0]; rowColor[y * 3 + 1] = c[1]; rowColor[y * 3 + 2] = c[2];
    }
    for (let y = 0; y < SKY_H; y++) {
        const base = y * SKY_W * 4;
        const r = rowColor[y * 3], g = rowColor[y * 3 + 1], b = rowColor[y * 3 + 2];
        for (let x = 0; x < SKY_W; x++) {
            const o = base + x * 4;
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
        }
    }

    // 光盘 + 光晕(仅在其包围盒内逐像素计算方向点积)
    const elToY = (elDeg) => Math.round((elDeg - DOME_EL_MIN) / DOME_EL_SPAN * (SKY_H - 1));
    const y0 = Math.max(0, elToY(SUN_ELEV_DISC - 26));
    const y1 = Math.min(SKY_H - 1, elToY(SUN_ELEV_DISC + 26));
    const sunAzU = SUN_AZ / 360;
    const uHalf = 30 / 360; // ±30° 经度窗口(太阳方位 196°,远离接缝)
    const x0 = Math.max(0, Math.floor((sunAzU - uHalf) * SKY_W));
    const x1 = Math.min(SKY_W - 1, Math.ceil((sunAzU + uHalf) * SKY_W));
    const sd = SUN_DIR_DISC;
    for (let y = y0; y <= y1; y++) {
        const v = y / (SKY_H - 1);
        const el = (DOME_EL_MIN + v * DOME_EL_SPAN) * DEG;
        const ce = Math.cos(el), se = Math.sin(el);
        const base = y * SKY_W * 4;
        for (let x = x0; x <= x1; x++) {
            const az = (x / (SKY_W - 1)) * 360 * DEG;
            const dx = Math.sin(az) * ce, dy = se, dz = Math.cos(az) * ce;
            const cosAng = dx * sd.x + dy * sd.y + dz * sd.z;
            if (cosAng <= 0) continue;
            let add = Math.pow(cosAng, glowPow) * glowAmt * 255;
            if (cosAng > discCos) add = Math.max(add, 255);
            if (add < 1) continue;
            const o = base + x * 4;
            d[o] = Math.min(255, d[o] + glow[0] / 255 * add);
            d[o + 1] = Math.min(255, d[o + 1] + glow[1] / 255 * add);
            d[o + 2] = Math.min(255, d[o + 2] + glow[2] / 255 * add);
        }
    }

    sky.texture.uploadData(d, 0);
    sky.paintedMix = mix;
}

// ---------------------------------------------------------------------------
// 海面:极坐标分块静态网格场(每块 createMesh —— 与穹顶同款已验证渲染路径;
// 每帧按同一 waveAt 函数更新各块的竖直位置与倾斜 = 真实几何波浪 + 相位耦合)。
// 注:utils.MeshUtils.createDynamicMesh + updateSubMesh 路径在本臂实测中
// 静默不渲染(结构/边界/更新均正常执行、无控制台输出),故改用本方案。
// ---------------------------------------------------------------------------
const SEA_RMAX = 400, SEA_R0 = 0.85, SEA_GROW = 1.35, SEA_TILE_SEG = 2;

function buildSeaTileSpecs() {
    const specs = [];
    let r = 0, rNext = SEA_R0;
    while (r < SEA_RMAX) {
        const dr = rNext - r;
        // 扇区数使弧长 ≈ 径向宽(块接近方形);≥6、≤48
        const n = Math.max(6, Math.min(48,
            Math.round((Math.PI * 2 * (r + rNext) / 2) / dr)));
        for (let j = 0; j < n; j++) {
            const az0 = (j / n) * Math.PI * 2, az1 = ((j + 1) / n) * Math.PI * 2;
            specs.push({
                r0: r, r1: rNext, az0, az1,
                cx: Math.sin((az0 + az1) / 2) * (r + rNext) / 2,
                cz: Math.cos((az0 + az1) / 2) * (r + rNext) / 2,
            });
        }
        r = rNext; rNext = Math.min(SEA_RMAX, rNext * SEA_GROW);
    }
    return specs;
}
const SEA_TILE_SPECS = buildSeaTileSpecs();

function tileGeometry(sp) {
    const SEG = SEA_TILE_SEG;
    const positions = [], normals = [], uvs = [], tangents = [], indices = [];
    for (let a = 0; a <= SEG; a++) {
        const rr = lerp(sp.r0, sp.r1, a / SEG);
        for (let b = 0; b <= SEG; b++) {
            const az = lerp(sp.az0, sp.az1, b / SEG);
            const x = rr * Math.sin(az) - sp.cx;   // 局部坐标(相对块中心)
            const z = rr * Math.cos(az) - sp.cz;
            positions.push(x, 0, z);
            normals.push(0, 1, 0);
            uvs.push(a / SEG * 4, b / SEG * 4);
            tangents.push(Math.cos(az), 0, -Math.sin(az), 1);
        }
    }
    for (let a = 0; a < SEG; a++) {
        for (let b = 0; b < SEG; b++) {
            const A = a * (SEG + 1) + b, B = A + 1, C = A + SEG + 1, D = C + 1;
            indices.push(A, C, B, B, C, D);
        }
    }
    const arc = sp.r1 * (sp.az1 - sp.az0);
    const mr = (sp.r1 - sp.r0) + arc + 0.6;
    return {
        positions, normals, uvs, tangents, indices,
        minPos: new Vec3(-mr, -0.5, -mr),
        maxPos: new Vec3(mr, 0.5, mr),
    };
}

function buildSea() {
    const root = new Node('sea');
    root.layer = Layers.Enum.DEFAULT;
    W.scene.addChild(root);

    const material = new Material();
    material.initialize({
        effectName: 'builtin-standard',
        states: { rasterizerState: { cullMode: 2 } },  // 双面:倾斜后底面不可见问题双保险
    });
    material.setProperty('metallic', 0.42);
    material.setProperty('roughness', 0.30);
    material.setProperty('mainColor', lerpColor(PALETTE.seaWarm, PALETTE.seaCool, S.toneMix));

    const tiles = [];
    for (let i = 0; i < SEA_TILE_SPECS.length; i++) {
        const sp = SEA_TILE_SPECS[i];
        const mesh = utils.MeshUtils.createMesh(tileGeometry(sp));
        const node = new Node('t' + i);
        node.layer = Layers.Enum.DEFAULT;
        root.addChild(node);
        const renderer = node.addComponent(MeshRenderer);
        renderer.setSharedMaterial(material, 0);
        renderer.mesh = mesh;
        tiles.push({ mesh, node, cx: sp.cx, cz: sp.cz });
    }
    W.sea = { root, material, tiles };
    updateSeaTiles(S.simTime);
    window.__seaDiag = () => ({ tiles: tiles.length, verts: tiles.length * (SEA_TILE_SEG + 1) * (SEA_TILE_SEG + 1) });
}

function updateSeaTiles(t) {
    const sea = W.sea;
    if (!sea) return;
    const tiles = sea.tiles;
    for (let i = 0; i < tiles.length; i++) {
        const tl = tiles[i];
        const w = waveAt(tl.cx, tl.cz, t);
        tl.node.setPosition(tl.cx, w.h * 0.9, tl.cz);
        const pitch = Math.atan(w.dhdz) / DEG * 0.8;
        const roll = Math.atan(w.dhdx) / DEG * 0.8;
        tl.node.setRotationFromEuler(pitch, 0, -roll);
    }
}

// ---------------------------------------------------------------------------
// 孤舟:运行时 GLB 加载、包围盒测量归一化、随波起伏
// ---------------------------------------------------------------------------
function setLayerRecursive(node) {
    node.layer = Layers.Enum.DEFAULT;
    for (let i = 0; i < node.children.length; i++) setLayerRecursive(node.children[i]);
}

async function loadBoat() {
    S.loadingBoat = true;
    S.assetLoaded = false;
    ui.loading.style.display = 'block';
    ui.loading.textContent = 'Loading boat...';
    try {
        const loader = new GLTFLoader();
        const asset = await loader.loadAsync('assets/boat.glb');
        const inst = asset.instantiate(0);
        setLayerRecursive(inst.root);
        const pivot = new Node('boat');
        pivot.layer = Layers.Enum.DEFAULT;
        W.scene.addChild(pivot);
        pivot.addChild(inst.root);
        W.boat = { pivot, inst, asset, measured: false, scale: 1, baseY: 0, centerY: 0 };
        S.assetRequests += 1;
        S.assetLoaded = true;
        ui.loading.style.display = 'none';
        console.log('[e02] boat.glb loaded: meshes=', asset.meshes.length);
    } catch (err) {
        console.error('[e02] boat load failed:', err && err.message ? err.message : err);
        showError('Failed to load assets/boat.glb: ' +
            (err && err.message ? err.message : String(err)));
        ui.loading.style.display = 'none';
    } finally {
        S.loadingBoat = false;
    }
}

// 渲染器世界包围盒:优先 renderer.model.worldBounds(updateWorldBound 后;
// frameObject 同源 API),回退 mesh.struct.minPosition/maxPosition × 节点世界矩阵。
function rendererWorldAABB(r) {
    try {
        if (r.model) {
            if (typeof r.model.updateWorldBound === 'function') r.model.updateWorldBound();
            const b = r.model.worldBounds;
            if (b && b.min && b.max) return b;
        }
    } catch (e) { /* 走回退 */ }
    try {
        const st = r.mesh && r.mesh.struct;
        if (st && st.minPosition && st.maxPosition) {
            const wm = r.node.worldMatrix;
            const mn = st.minPosition, mx = st.maxPosition;
            const out = {
                min: { x: Infinity, y: Infinity, z: Infinity },
                max: { x: -Infinity, y: -Infinity, z: -Infinity },
            };
            const p = new Vec3(), q = new Vec3();
            for (let i = 0; i < 8; i++) {
                q.set(i & 1 ? mx.x : mn.x, i & 2 ? mx.y : mn.y, i & 4 ? mx.z : mn.z);
                Vec3.transformMat4(p, q, wm);
                if (p.x < out.min.x) out.min.x = p.x;
                if (p.y < out.min.y) out.min.y = p.y;
                if (p.z < out.min.z) out.min.z = p.z;
                if (p.x > out.max.x) out.max.x = p.x;
                if (p.y > out.max.y) out.max.y = p.y;
                if (p.z > out.max.z) out.max.z = p.z;
            }
            return out;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 激活后测量:归一化尺寸(最长水平边→2.4)并定位水线
function measureBoat(b) {
    const renderers = b.pivot.getComponentsInChildren(MeshRenderer);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let got = false, src = 'none';
    for (let i = 0; i < renderers.length; i++) {
        const bb = rendererWorldAABB(renderers[i]);
        if (!bb) continue;
        if (bb.model) src = 'model'; else if (src === 'none') src = 'struct';
        got = true;
        if (bb.min.x < minX) minX = bb.min.x;
        if (bb.min.y < minY) minY = bb.min.y;
        if (bb.min.z < minZ) minZ = bb.min.z;
        if (bb.max.x > maxX) maxX = bb.max.x;
        if (bb.max.y > maxY) maxY = bb.max.y;
        if (bb.max.z > maxZ) maxZ = bb.max.z;
    }
    window.__boatMeasure = { renderers: renderers.length, got, src };
    if (!got || !isFinite(minY)) return;   // 包围盒尚未就绪,下一帧再试
    const sx = maxX - minX, sz = maxZ - minZ;
    const s = 2.4 / Math.max(sx, sz, 1e-6);
    b.scale = s;
    b.pivot.setScale(s, s, s);
    b.baseY = -0.10 - minY * s;                      // 龙骨尖端没入平均水线下 0.10
    b.centerY = ((minY + maxY) * 0.5) * s;           // 报告用包围盒中心偏移
    b.measured = true;
}

function updateBoat() {
    const b = W.boat;
    if (!b) return;
    if (!b.measured) { measureBoat(b); if (!b.measured) return; }
    const w = waveAt(0, 0, S.simTime);
    b.pivot.setPosition(0, b.baseY + w.h * 0.95, 0); // 与海面同源波形:相位耦合
    // 纵摇/横摇(度):由同一波形梯度驱动
    const pitch = Math.atan(w.dhdz) / DEG * 0.55;
    const roll = Math.atan(w.dhdx) / DEG * 0.55;
    b.pivot.setRotationFromEuler(pitch, 0, -roll);
}

// ---------------------------------------------------------------------------
// 色调演变(天空贴图 + 主光 + 环境光 + 海色同时变化)
// ---------------------------------------------------------------------------
function applyTone(force) {
    const m = S.toneMix;
    if (W.light) {
        W.light.color = lerpColor(PALETTE.lightWarm, PALETTE.lightCool, m);
        W.light.illuminance = lerp(34000, 21000, m);
    }
    const amb = W.scene && W.scene.globals && W.scene.globals.ambient;
    if (amb) {
        const c = mix3(PALETTE.ambientWarm, PALETTE.ambientCool, m, [0, 0, 0]);
        amb.skyColorHDR.set(c[0], c[1], c[2], 1.0);
        amb.skyIllum = lerp(14000, 9500, m);
    }
    if (W.sea) {
        W.sea.material.setProperty('mainColor',
            lerpColor(PALETTE.seaWarm, PALETTE.seaCool, m));
    }
    if (W.sky && (force || Math.abs(m - W.sky.paintedMix) > 0.02)) paintSky(m);
}

// ---------------------------------------------------------------------------
// 相机:方位角梯形速度曲线(平滑、无跳变、松手后仍有持续运动)
// ---------------------------------------------------------------------------
const AZ_VMAX = 120, AZ_ACC = 600;   // 度/秒,度/秒²

function updateCamera(dt) {
    const rem = S.azimuthTarget - S.azimuth;
    if (Math.abs(rem) > 1e-4 || S.azVel > 1e-4) {
        const vLimit = Math.min(AZ_VMAX, Math.sqrt(2 * AZ_ACC * Math.abs(rem)));
        const dv = vLimit - S.azVel;
        const maxDv = AZ_ACC * dt;
        S.azVel += dv > maxDv ? maxDv : (dv < -maxDv ? -maxDv : dv);
        if (S.azVel < 0) S.azVel = 0;
        const step = S.azVel * dt;
        if (step >= Math.abs(rem)) { S.azimuth = S.azimuthTarget; S.azVel = 0; }
        else S.azimuth += rem > 0 ? step : -step;
    }
    const az = S.azimuth * DEG, el = CAM_EL * DEG;
    W.camNode.setPosition(
        CAM_TARGET.x + Math.sin(az) * Math.cos(el) * CAM_DIST,
        CAM_TARGET.y + Math.sin(el) * CAM_DIST,
        CAM_TARGET.z + Math.cos(az) * Math.cos(el) * CAM_DIST);
    W.camNode.lookAt(CAM_TARGET);
}

// ---------------------------------------------------------------------------
// Reset:释放船/海/天空 GPU 资源 → 状态归零 → 重建 + 重新网络加载
// ---------------------------------------------------------------------------
function destroyNodeTree(entry) {
    try {
        if (entry.mesh) entry.mesh.destroy();
        if (entry.material) entry.material.destroy();
        if (entry.texture) entry.texture.destroy();
        if (entry.node) {
            entry.node.removeFromParent();
            entry.node.destroy();
        }
    } catch (err) {
        console.error('[e02] destroy error:', err && err.message ? err.message : err);
    }
}

function doReset() {
    if (S.loadingBoat) return;   // 加载中禁止重入
    // 1) 释放旧资源(显式 GPU 侧释放)
    if (W.boat) {
        try { W.boat.inst.dispose(); } catch (e) { /* 已销毁则忽略 */ }
        try { W.boat.asset.destroy(); } catch (e) { /* ignore */ }
        W.boat = null;
    }
    if (W.sea) {
        try {
            for (let i = 0; i < W.sea.tiles.length; i++) W.sea.tiles[i].mesh.destroy();
            W.sea.material.destroy();
            W.sea.root.removeFromParent();
            W.sea.root.destroy();   // 递归销毁全部 tile 节点/渲染组件
        } catch (err) {
            console.error('[e02] sea destroy error:', err && err.message ? err.message : err);
        }
        W.sea = null;
    }
    if (W.sky) { destroyNodeTree(W.sky); W.sky = null; }
    // 2) 状态恢复初始
    S.epoch += 1;
    S.simTime = 0;
    S.toneMix = 0; S.toneTarget = 0;
    ui.toneBtn.textContent = 'Tone: Warm';
    S.azimuth = 35; S.azimuthTarget = 35; S.azVel = 0;
    // 3) 重建(相机由 SimDriver 继续驱动,天空立即恢复暖色)
    buildSky();
    buildSea();
    applyTone(true);
    loadBoat();
}

// ---------------------------------------------------------------------------
// 输入:引擎 input 单例(canvas 事件被 pal 层吞,走 input.on;枚举值为字符串)
// ---------------------------------------------------------------------------
function setupInput() {
    let dragging = false, lastX = 0;
    const onDown = (x) => { dragging = true; lastX = x; };
    const onMove = (x) => {
        if (!dragging) return;
        S.azimuthTarget += (x - lastX) * 0.5;    // 0.5°/px:松手后环绕运动持续 >0.9s
        lastX = x;
    };
    const onUp = () => { dragging = false; };
    const xOf = (e) => (e.getUILocation ? e.getUILocation().x : e.getLocation().x);
    if (inputSingleton) {
        inputSingleton.on('mouse-down', (e) => onDown(xOf(e)));
        inputSingleton.on('mouse-move', (e) => onMove(xOf(e)));
        inputSingleton.on('mouse-up', () => onUp());
        window.addEventListener('blur', onUp);
    } else {
        // 兜底:capture 阶段窗口监听(pal 拦截 canvas 冒泡时的保险)
        window.addEventListener('mousedown', (e) => onDown(e.clientX), true);
        window.addEventListener('mousemove', (e) => onMove(e.clientX), true);
        window.addEventListener('mouseup', onUp, true);
    }
}

// ---------------------------------------------------------------------------
// 帧驱动:模拟时间 / 海面 / 船 / 相机 / 色调 / fps
// ---------------------------------------------------------------------------
const frameTimes = [];

class SimDriver extends Component {
    update(dt) {
        if (dt > 0.1) dt = 0.1;
        S.simTime += dt;
        if (W.sea) updateSeaTiles(S.simTime);
        updateBoat();
        updateCamera(dt);
        if (Math.abs(S.toneTarget - S.toneMix) > 1e-4) {
            S.toneMix += (S.toneTarget - S.toneMix) * (1 - Math.exp(-2.2 * dt));
            if (Math.abs(S.toneTarget - S.toneMix) < 0.002) S.toneMix = S.toneTarget;
            applyTone(false);
        }
    }
}

function onAfterDraw() {
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
    S.fps = frameTimes.length > 1
        ? (frameTimes.length - 1) / Math.min(2, (now - frameTimes[0]) / 1000)
        : 0;
    if (S.assetLoaded && !window.__appReady) {
        window.__appReady = true;   // 资产加载完成且首帧渲染后
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    buildUI();
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    W.app = app;

    const scene = new Scene('e02');
    W.scene = scene;

    // 相机(visibility 必须显式设 DEFAULT —— 4.0-alpha 默认 undefined)
    const camNode = new Node('Main Camera');
    scene.addChild(camNode);
    W.camNode = camNode;
    updateCamera(0);
    const camera = camNode.addComponent(Camera);
    W.camera = camera;
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CAM_FOV;
    camera.near = 0.1;
    camera.far = 1200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(40, 32, 52, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 主光(方向/色温随 toneMix 演变;方向固定指向原点)
    const lightNode = new Node('sun');
    scene.addChild(lightNode);
    W.lightNode = lightNode;
    const ld = dirFromAzEl(SUN_AZ, SUN_ELEV_LIGHT);
    lightNode.setPosition(ld.x * 100, ld.y * 100, ld.z * 100);
    W.light = lightNode.addComponent(DirectionalLight);
    W.light.illuminance = 34000;

    camNode.addComponent(SimDriver);

    window.__airApp = app;
    app.run(scene);

    // app.run 后:光照朝向 / 环境光(场景全局量在 run 后经 scene.globals 配置)
    lightNode.lookAt(new Vec3(0, 0, 0));
    applyTone(true);

    buildSky();
    buildSea();
    setupInput();
    director.on(Director.EVENT_AFTER_DRAW, onAfterDraw);

    loadBoat();
    console.log('[e02] sunset sea scene running on cocosair');
} catch (err) {
    // 致命错误(如 WEBGL2_REQUIRED):显式抛出为未捕获错误,便于 harness 分类
    console.error('[e02] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
