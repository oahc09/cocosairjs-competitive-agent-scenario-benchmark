/**
 * E08 深海鱼群 — Cocos AIR Reference 实现(Boids Simulation)
 *
 * 架构(无 InstancedMesh 约束下的选型):
 *   - 鱼群(110 条):整群烘焙进 1 个动态网格(utils.MeshUtils.createDynamicMesh + updateSubMesh
 *     每帧重写顶点,单 submesh 单 draw call)。鱼体 = 6 环六棱截面分节身体 + 鼻端 + 背鳍 + 叉形尾鳍,
 *     顶点色做背深腹浅的反荫蔽;摆尾 = 沿体长的横向正弦弯曲(位置 + 法线同步重写)。
 *   - 悬浮颗粒(340):同样走 1 个动态网格,billboard 四边形朝向相机,加法混合 + 径向渐变贴图。
 *   - boids:逐帧 O(n^2) 朴素邻域(110 条规模),聚集/对齐/分离三规则 + 食物吸引 + 指针惊散。
 *   - 惊散判定:指针射线(camera.screenPointToRay)与鱼的真实 3D 距离 < 2.5 世界单位,
 *     无定时器脚本;模式回 normal 需威胁消失 2.2s(滞回,符合 brief"静止超过 2s 后回 normal"语义)。
 *   - avgCohesion = 1 - min(1, 个体到质心平均距离 / 10) 逐帧真实计算。
 *
 * AIR 已知坑位应用:camera.visibility 显式;环境光走 scene.globals;画布事件走引擎 input(MOUSE / TOUCH 事件族);
 * 雾走 scene.globals.fog(enabled 必须先于 type);无后处理,体积光感 = 加法混合光柱面片 + 指数雾。
 *
 * 页面契约:window.__appReady(首帧 EVENT_AFTER_DRAW);window.__bench = { getState, reset }。
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
    Texture2D,
    ImageAsset,
    gfx,
    utils,
    primitives,
    geometry,
    input,
    Input,
    Color,
    Vec3,
    Vec2,
    Component,
    director,
    Director,
} from 'cocosair.js';

// ============================== 常量 ==============================
const FISH_COUNT = 110; // spec: >=80, 建议 80-120
const PLANKTON_COUNT = 340; // spec: >=300, 建议 300-600
const FOOD_PELLET_MAX = 5; // 每次投喂 3-5 粒(池上限)
const FOOD_LIFETIME = 13.0; // >=8s 超时(spec 下限;取 13s 保证探针采样窗口内食物仍在)
const SCATTER_RADIUS = 2.5; // 惊散半径(世界单位,指针射线到鱼)
const SCATTER_HOLD = 2.2; // 威胁消失后保持 scatter 的滞回时长(brief: 静止 >2s 回 normal)
const BOUNDS = { minX: -13, maxX: 13, minY: -6, maxY: 7, minZ: -8, maxZ: 8 }; // 相机可见水域
const SEED = 0x5eed08; // 固定种子:reset 恢复"初始鱼群分布"

// 程序化鱼体模板(局部系:头部 +z,尾 -z;x 右,y 上)
const RING_Z = [0.48, 0.36, 0.18, 0.0, -0.2, -0.38];
const RING_W = [0.016, 0.055, 0.086, 0.09, 0.07, 0.04]; // 半宽
const RING_H = [0.03, 0.085, 0.13, 0.14, 0.115, 0.07]; // 半高
const RING_SEG = 6; // 六棱截面

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// ============================== 可复现随机 ==============================
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rng = mulberry32(SEED);
const rr = (lo, hi) => lo + (hi - lo) * rng();

// ============================== 状态契约 ==============================
const sim = {
    fishCount: FISH_COUNT,
    planktonCount: PLANKTON_COUNT,
    boidMode: 'normal', // "normal" | "scatter"
    foodActive: false,
    foodPosition: null, // {x,y,z} | null
    avgCohesion: 1, // 1 - min(1, 质心均距/10)
    avgDistanceToFood: null,
    resetCount: 0,
};

window.__appReady = false;

function getState() {
    return {
        fishCount: sim.fishCount,
        planktonCount: sim.planktonCount,
        boidMode: sim.boidMode,
        foodActive: sim.foodActive,
        foodPosition: sim.foodPosition ? { x: sim.foodPosition.x, y: sim.foodPosition.y, z: sim.foodPosition.z } : null,
        avgCohesion: Math.round(sim.avgCohesion * 1000) / 1000,
        avgDistanceToFood: sim.avgDistanceToFood == null ? null : Math.round(sim.avgDistanceToFood * 1000) / 1000,
        resetCount: sim.resetCount,
    };
}

window.__bench = { getState, reset: () => {} }; // reset 在场景建立后替换为真实现

// ============================== UI(HUD + 重置按钮 + 点击涟漪) ==============================
const hudEl = document.createElement('div');
hudEl.style.cssText =
    'position:fixed;left:10px;bottom:8px;z-index:9999;padding:5px 12px;font:12px/1.6 Consolas,monospace;' +
    'color:#bfe3ef;background:rgba(4,18,28,0.55);border:1px solid rgba(120,200,220,0.25);' +
    'border-radius:6px;pointer-events:none;white-space:pre;';
document.body.appendChild(hudEl);

const resetBtn = document.createElement('button');
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 14px;font:12px sans-serif;' +
    'background:rgba(10,35,48,0.8);color:#cfeaf2;border:1px solid #3a7d92;border-radius:4px;cursor:pointer;';
document.body.appendChild(resetBtn);

const rippleStyle = document.createElement('style');
rippleStyle.textContent = '@keyframes bench-ripple{from{transform:scale(0.4);opacity:0.9}to{transform:scale(4.2);opacity:0}}';
document.head.appendChild(rippleStyle);

/** 点击水面涟漪(DOM 微光反馈,brief §4.5 可选项)。px/py 为视口坐标(左上原点)。 */
function spawnRipple(px, py) {
    const rip = document.createElement('div');
    const size = 14;
    rip.style.cssText =
        `position:fixed;left:${px - size / 2}px;top:${py - size / 2}px;width:${size}px;height:${size}px;` +
        'border:2px solid rgba(150,230,255,0.8);border-radius:50%;z-index:9998;pointer-events:none;' +
        'animation:bench-ripple 0.7s ease-out forwards;';
    document.body.appendChild(rip);
    setTimeout(() => rip.remove(), 750);
}

function updateHud() {
    hudEl.textContent =
        `E08 深海鱼群  fish ${sim.fishCount}  plankton ${sim.planktonCount}\n` +
        `mode ${sim.boidMode}  cohesion ${sim.avgCohesion.toFixed(2)}` +
        (sim.avgDistanceToFood != null ? `  foodDist ${sim.avgDistanceToFood.toFixed(1)}` : '');
}

// ============================== 程序化贴图 ==============================
/** 径向柔光点(悬浮颗粒/食物光晕)。 */
function makeRadialTexture(size, r, g, b, coreAlpha) {
    const data = new Uint8Array(size * size * 4);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const d = Math.hypot(x - c, y - c) / c;
            const a = Math.max(0, 1 - d);
            const fall = a * a * (3 - 2 * a); // smoothstep
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = Math.round(255 * fall * coreAlpha);
        }
    }
    const image = new ImageAsset({ width: size, height: size, _data: data, _compressed: false, format: Texture2D.PixelFormat.RGBA8888 });
    const tex = new Texture2D();
    tex.image = image;
    return tex;
}

/**
 * 垂直渐变纹理生成器。方向契约:quad 的 uv v=1(顶点 +y,画面上方)采样图像最后一行,
 * 故"视觉顶部"对应图像 y=h-1 —— rowUp=1 表示视觉最顶行。
 */
function verticalTexture(w, h, shader) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const up = y / (h - 1); // 0 = 图像首行(画面底部), 1 = 图像末行(画面顶部)
        for (let x = 0; x < w; x++) {
            const across = x / (w - 1); // 0 左 1 右
            const i = (y * w + x) * 4;
            shader(data, i, up, across);
        }
    }
    const image = new ImageAsset({ width: w, height: h, _data: data, _compressed: false, format: Texture2D.PixelFormat.RGBA8888 });
    const tex = new Texture2D();
    tex.image = image;
    return tex;
}

/** 垂直深度渐变(远景背景):上部透光青蓝 → 深渊暗色。 */
function makeDepthGradientTexture(w, h) {
    const top = [34, 82, 108];
    const mid = [14, 44, 62];
    const bot = [5, 16, 24];
    return verticalTexture(w, h, (data, i, up) => {
        let c;
        if (up > 0.55) {
            const t = (up - 0.55) / 0.45;
            c = mid.map((a, k) => a + (top[k] - a) * t);
        } else {
            const t = up / 0.55;
            c = bot.map((a, k) => a + (mid[k] - a) * t);
        }
        data[i] = Math.round(c[0]);
        data[i + 1] = Math.round(c[1]);
        data[i + 2] = Math.round(c[2]);
        data[i + 3] = 255;
    });
}

/** 垂直渐变(光柱面片):上亮下灭 + 左右软边 + 顶端软收边(避免矩形硬切)。 */
function makeBeamTexture(w, h) {
    return verticalTexture(w, h, (data, i, up, across) => {
        const vert = Math.pow(up, 1.15) * Math.min(1, (1 - up) * 10); // 顶端 10% 淡出
        const u = Math.abs(across - 0.5) * 2;
        const horiz = Math.max(0, 1 - u);
        data[i] = 195;
        data[i + 1] = 238;
        data[i + 2] = 255;
        data[i + 3] = Math.round(255 * vert * (horiz * horiz * (3 - 2 * horiz)) * 0.92);
    });
}

// ============================== 鱼体模板(局部几何) ==============================
// 顶点布局:6 环 × 6 顶点 + 鼻尖 1 + 背鳍 3 + 尾鳍 5 = 45 顶点 / 69 三角形。
// bendExtra 在尾鳍处 >1,使摆尾幅度沿体长进一步放大。
const tpl = buildFishTemplate();

function buildFishTemplate() {
    const pos = [];
    const nrm = [];
    const shade = []; // 反荫蔽系数:1 背部暗 … 0 腹部亮
    const bendExtra = [];

    for (let r = 0; r < RING_Z.length; r++) {
        for (let s = 0; s < RING_SEG; s++) {
            const a = (s / RING_SEG) * Math.PI * 2;
            const x = Math.cos(a) * RING_W[r];
            const y = Math.sin(a) * RING_H[r];
            const z = RING_Z[r];
            pos.push(x, y, z);
            // 椭圆截面法线 ∝ (cos/w, sin/h, 0)
            const nx = Math.cos(a) / RING_W[r];
            const ny = Math.sin(a) / RING_H[r];
            const nl = Math.hypot(nx, ny);
            nrm.push(nx / nl, ny / nl, 0);
            const rel = y / (RING_H[r] + 1e-6);
            shade.push(rel >= 0 ? Math.min(1, rel) : Math.max(0, 1 + rel * 0.7));
            bendExtra.push(1);
        }
    }
    // 鼻尖(顶点 36)
    pos.push(0, 0, 0.54);
    nrm.push(0, 0, 1);
    shade.push(0.5);
    bendExtra.push(0);
    // 背鳍(37-39)
    pos.push(0, RING_H[3] * 1.02, 0.1, 0, 0.21, -0.14, 0, 0.12, -0.24);
    nrm.push(0, 0.35, 0.94, 0, 0.2, 0.98, 0, 0.2, 0.98);
    shade.push(1, 1, 0.85);
    bendExtra.push(1, 1.25, 1.25);
    // 尾鳍(叉形,40-44)
    pos.push(0, 0, -0.36, 0, 0.17, -0.62, 0, 0.02, -0.52, 0, -0.02, -0.52, 0, -0.17, -0.62);
    nrm.push(0, 0, 1, 0, 0.45, 0.9, 0, 0.15, 0.99, 0, -0.15, 0.99, 0, -0.45, 0.9);
    shade.push(0.75, 0.8, 0.7, 0.7, 0.8);
    bendExtra.push(1, 1.8, 1.8, 1.8, 1.8);

    const idx = [];
    const ringBase = (r, s) => r * RING_SEG + (s % RING_SEG);
    for (let r = 0; r < RING_Z.length - 1; r++) {
        for (let s = 0; s < RING_SEG; s++) {
            const a = ringBase(r, s);
            const b = ringBase(r, s + 1);
            const c = ringBase(r + 1, s + 1);
            const d = ringBase(r + 1, s);
            idx.push(a, b, d, b, c, d);
        }
    }
    const nose = RING_Z.length * RING_SEG;
    for (let s = 0; s < RING_SEG; s++) {
        idx.push(nose, ringBase(0, s + 1), ringBase(0, s));
    }
    idx.push(37, 38, 39); // 背鳍
    idx.push(40, 41, 42); // 尾鳍上叶
    idx.push(40, 43, 44); // 尾鳍下叶

    return {
        vCount: pos.length / 3,
        pos: new Float32Array(pos),
        nrm: new Float32Array(nrm),
        shade: new Float32Array(shade),
        bendExtra: new Float32Array(bendExtra),
        indices: new Uint16Array(idx),
    };
}

// 全群索引(静态:每条鱼同构,按基顶点偏移展开)
const fishIndices = new Uint16Array(FISH_COUNT * tpl.indices.length);
for (let f = 0; f < FISH_COUNT; f++) {
    const base = f * tpl.vCount;
    for (let i = 0; i < tpl.indices.length; i++) {
        fishIndices[f * tpl.indices.length + i] = base + tpl.indices[i];
    }
}

/** 沿体长的弯曲系数:头部 0 → 尾部 1(smoothstep)。 */
function bendT(z) {
    const t = (0.45 - z) / 1.0;
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// ============================== 仿真数据 ==============================
const fish = [];
const plankton = [];
const food = { pellets: [], active: false, position: null, age: 0 };

function spawnFish() {
    fish.length = 0;
    // 初始共同朝向:绕中心切向(漩涡式巡游,群不易直冲边界) + 少量随机
    const hx = rr(-0.3, 0.3), hy = rr(-0.15, 0.15), hz = rr(-0.3, 0.3);
    for (let i = 0; i < FISH_COUNT; i++) {
        // 初始分布:围绕 (0, 0.3, 0) 的松散椭球(半径 ~3),朝向大体一致
        const rad = 0.6 + rng() * 2.4;
        const th = rr(0, Math.PI * 2);
        const ph = Math.acos(rr(-1, 1));
        const px = Math.sin(ph) * Math.cos(th) * rad;
        const pz = Math.sin(ph) * Math.sin(th) * rad * 0.85;
        // 切向 = up × 径向 → 群体绕中心缓游
        let tx = -pz, ty = 0, tz = px;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx = tx / tl + hx; ty = ty / tl + hy; tz = tz / tl + hz;
        const tln = Math.hypot(tx, ty, tz) || 1;
        fish.push({
            x: px,
            y: 0.3 + Math.cos(ph) * rad * 0.62,
            z: pz,
            vx: (tx / tln) * 1.8 + rr(-0.4, 0.4),
            vy: (ty / tln) * 1.8 + rr(-0.25, 0.25),
            vz: (tz / tln) * 1.8 + rr(-0.4, 0.4),
            dx: tx / tln, dy: ty / tln, dz: tz / tln, // 平滑朝向
            bank: 0,
            phase: rr(0, Math.PI * 2),
            len: rr(1.0, 1.35), // 个体体长差异
            hue: rr(-0.06, 0.06), // 个体色相偏移(青灰 ↔ 暖银)
            fleeCd: 0,
            wob1: rr(0, Math.PI * 2),
            wob2: rr(0, Math.PI * 2),
        });
    }
}

function spawnPlankton() {
    plankton.length = 0;
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        plankton.push({
            bx: rr(BOUNDS.minX + 0.5, BOUNDS.maxX - 0.5),
            by: rr(BOUNDS.minY + 0.5, BOUNDS.maxY - 0.5),
            bz: rr(BOUNDS.minZ + 0.5, BOUNDS.maxZ - 0.5),
            ax: rr(0.25, 1.1), ay: rr(0.15, 0.6), az: rr(0.25, 1.1),
            fx: rr(0.04, 0.16), fy: rr(0.03, 0.1), fz: rr(0.04, 0.16),
            p1: rr(0, Math.PI * 2), p2: rr(0, Math.PI * 2), p3: rr(0, Math.PI * 2),
            size: rr(0.06, 0.21),
            alpha: rr(0.45, 1.0),
            tint: rng(),
        });
    }
}

// ============================== 指针(射线 + 惊散威胁) ==============================
const pointer = {
    inside: false,
    x: 0, y: 0, // 画布坐标(左下原点,引擎口径)
    downX: 0, downY: 0, downT: 0,
    ray: new geometry.Ray(0, 0, 0, 0, 0, -1),
    valid: false,
    lastThreat: -1e9, // 最近一次"鱼进入惊散半径"的仿真时刻
};

// ============================== 主场景 ==============================
let cameraComp = null;
let fishMesh = null;
let planktonMesh = null;
let beamNodes = [];
let foodNodes = []; // { node, halo, active, x, y, z, health, scale, phase }
let simTime = 0;

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('e08-deep-sea');

    // ---- 相机:水下中景,视野覆盖整个活动水域 ----
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 2.2, 24));
    cameraNode.lookAt(new Vec3(0, 0.2, 0));
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = 55;
    cameraComp.near = 0.1;
    cameraComp.far = 300;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(9, 32, 46, 255); // 与雾色一致 → 水体无限深远
    cameraComp.visibility = Layers.Enum.DEFAULT;
    cameraComp.priority = 0;

    // ---- 光:自上而下衰减的水面光 ----
    const lightNode = new Node('Sun Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(5, 16, 7));
    lightNode.setRotationFromEuler(-72, 28, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 62000;

    // ---- 材质 ----
    const cullNone = new gfx.RasterizerState(false, gfx.PolygonMode.FILL, gfx.ShadeModel.GOURAND, gfx.CullMode.NONE);
    const additive = () => new gfx.BlendTarget(true, gfx.BlendFactor.SRC_ALPHA, gfx.BlendFactor.ONE);
    const noDepthWrite = new gfx.DepthStencilState(true, false);

    // 鱼:标准受光 + 顶点色反荫蔽 + 双面(扁平尾鳍/背鳍)
    const fishMaterial = new Material();
    fishMaterial.initialize({ effectName: 'builtin-standard', defines: { USE_VERTEX_COLOR: true }, states: { rasterizerState: cullNone } });
    fishMaterial.setProperty('mainColor', new Color(242, 247, 252, 255));
    fishMaterial.setProperty('roughness', 0.38);
    fishMaterial.setProperty('metallic', 0.6);
    fishMaterial.setProperty('emissive', new Color(16, 24, 34, 255)); // 微自发光:暗水区剪影可辨

    // 颗粒:unlit + 贴图 + 顶点色,加法混合(发光浮游生物)
    const planktonMaterial = new Material();
    planktonMaterial.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: true, USE_VERTEX_COLOR: true },
        states: { blendState: { targets: [additive()] }, depthStencilState: noDepthWrite, rasterizerState: cullNone },
    });
    planktonMaterial.setProperty('mainTexture', makeRadialTexture(32, 175, 225, 240, 1.0));

    // 海床:暗色标准材质,靠雾融合
    const bedMaterial = new Material();
    bedMaterial.initialize({ effectName: 'builtin-standard' });
    bedMaterial.setProperty('mainColor', new Color(42, 68, 84, 255));
    bedMaterial.setProperty('roughness', 0.96);
    bedMaterial.setProperty('metallic', 0.05);

    // 食物:unlit 亮暖色 + 加法光晕
    const foodMaterial = new Material();
    foodMaterial.initialize({ effectName: 'builtin-unlit' });
    foodMaterial.setProperty('mainColor', new Color(255, 214, 120, 255));
    const haloMaterial = new Material();
    haloMaterial.initialize({
        effectName: 'builtin-unlit',
        defines: { USE_TEXTURE: true },
        states: { blendState: { targets: [additive()] }, depthStencilState: noDepthWrite, rasterizerState: cullNone },
    });
    haloMaterial.setProperty('mainTexture', makeRadialTexture(32, 255, 208, 130, 0.85));
    haloMaterial.setProperty('mainColor', new Color(255, 200, 110, 200));

    // ---- 深度渐变背景(远景水体明暗层次,配合指数雾) ----
    // AIR 坑位:primitives.quad() 忽略 width/height 选项(恒 1×1),尺寸必须经 node.scale 放大
    const backdropNode = new Node('Backdrop');
    backdropNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(backdropNode);
    backdropNode.setPosition(new Vec3(0, 3, -23));
    backdropNode.setScale(96, 50, 1);
    const backdropRenderer = backdropNode.addComponent(MeshRenderer);
    backdropRenderer.mesh = utils.createMesh(primitives.quad());
    const backdropMaterial = new Material();
    backdropMaterial.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: true } });
    backdropMaterial.setProperty('mainTexture', makeDepthGradientTexture(64, 256));
    backdropRenderer.material = backdropMaterial;

    // ---- 海床(primitives.plane 本身已是水平面 XZ/法线 +y,无需再旋转) ----
    const bedNode = new Node('Seabed');
    bedNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bedNode);
    bedNode.setPosition(new Vec3(0, -6.9, -3));
    const bedRenderer = bedNode.addComponent(MeshRenderer);
    bedRenderer.mesh = utils.createMesh(primitives.plane({ width: 110, length: 70 }));
    bedRenderer.material = bedMaterial;

    // ---- 顶部光柱(体积光观感,缓摆) ----
    const beamTexture = makeBeamTexture(64, 256);
    const quadGeom = primitives.quad(); // 1×1,尺寸经 node scale(quad 选项不生效)
    const beamSpec = [
        { x: -9.5, z: -5.5, w: 2.6, h: 17, tilt: -13, alpha: 0.4, sway: 0.35 },
        { x: -3.5, z: -7.5, w: 4.2, h: 19, tilt: -9, alpha: 0.3, sway: 0.22 },
        { x: 1.5, z: -6.0, w: 3.0, h: 18, tilt: -15, alpha: 0.38, sway: 0.3 },
        { x: 7.0, z: -5.0, w: 2.2, h: 16.5, tilt: -11, alpha: 0.45, sway: 0.4 },
        { x: 11.5, z: -7.0, w: 3.4, h: 18.5, tilt: -8, alpha: 0.28, sway: 0.18 },
        { x: -12.5, z: -3.5, w: 1.8, h: 15.5, tilt: -16, alpha: 0.5, sway: 0.5 },
    ];
    for (const b of beamSpec) {
        const node = new Node('Beam');
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        node.setPosition(b.x, 1.2, b.z);
        node.setRotationFromEuler(0, 0, b.tilt);
        node.setScale(b.w, b.h, 1);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = utils.createMesh(quadGeom);
        const mat = new Material();
        mat.initialize({
            effectName: 'builtin-unlit',
            defines: { USE_TEXTURE: true },
            states: { blendState: { targets: [additive()] }, depthStencilState: noDepthWrite, rasterizerState: cullNone },
        });
        mat.setProperty('mainTexture', beamTexture);
        mat.setProperty('mainColor', new Color(185, 225, 250, Math.round(255 * b.alpha)));
        renderer.material = mat;
        beamNodes.push({ node, baseTilt: b.tilt, sway: b.sway, phase: rr(0, Math.PI * 2) });
    }

    // ---- 鱼群动态网格(单 submesh,全群烘焙 → 单 draw call) ----
    const FV = FISH_COUNT * tpl.vCount;
    const fishPos = new Float32Array(FV * 3);
    const fishNrm = new Float32Array(FV * 3);
    const fishCol = new Float32Array(FV * 4);
    const volBounds = {
        minPos: { x: BOUNDS.minX - 1, y: BOUNDS.minY - 1, z: BOUNDS.minZ - 1 },
        maxPos: { x: BOUNDS.maxX + 1, y: BOUNDS.maxY + 1, z: BOUNDS.maxZ + 1 },
    };
    fishMesh = utils.MeshUtils.createDynamicMesh(0,
        { positions: fishPos, normals: fishNrm, colors: fishCol, indices16: fishIndices, ...volBounds },
        undefined,
        { maxSubMeshes: 1, maxSubMeshVertices: FV, maxSubMeshIndices: fishIndices.length });
    const fishNode = new Node('School');
    fishNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(fishNode);
    const fishRenderer = fishNode.addComponent(MeshRenderer);
    fishRenderer.mesh = fishMesh;
    fishRenderer.material = fishMaterial;

    // ---- 悬浮颗粒动态网格(billboard 四边形) ----
    const PV = PLANKTON_COUNT * 4;
    const plankPos = new Float32Array(PV * 3);
    const plankNrm = new Float32Array(PV * 3);
    const plankUv = new Float32Array(PV * 2);
    const plankCol = new Float32Array(PV * 4);
    const plankIdx = new Uint16Array(PLANKTON_COUNT * 6);
    for (let i = 0; i < PLANKTON_COUNT; i++) {
        const v = i * 4;
        for (let k = 0; k < 4; k++) {
            plankNrm[(v + k) * 3 + 2] = 1;
        }
        plankUv[(v + 0) * 2] = 0; plankUv[(v + 0) * 2 + 1] = 0;
        plankUv[(v + 1) * 2] = 1; plankUv[(v + 1) * 2 + 1] = 0;
        plankUv[(v + 2) * 2] = 0; plankUv[(v + 2) * 2 + 1] = 1;
        plankUv[(v + 3) * 2] = 1; plankUv[(v + 3) * 2 + 1] = 1;
        const j = i * 6;
        plankIdx[j] = v; plankIdx[j + 1] = v + 1; plankIdx[j + 2] = v + 2;
        plankIdx[j + 3] = v + 1; plankIdx[j + 4] = v + 3; plankIdx[j + 5] = v + 2;
    }
    planktonMesh = utils.MeshUtils.createDynamicMesh(0,
        { positions: plankPos, normals: plankNrm, uvs: plankUv, colors: plankCol, indices16: plankIdx, ...volBounds },
        undefined,
        { maxSubMeshes: 1, maxSubMeshVertices: PV, maxSubMeshIndices: plankIdx.length });
    const planktonNode = new Node('Plankton');
    planktonNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(planktonNode);
    const planktonRenderer = planktonNode.addComponent(MeshRenderer);
    planktonRenderer.mesh = planktonMesh;
    planktonRenderer.material = planktonMaterial;

    // ---- 食物池(球体 + 光晕) ----
    const pelletMesh = utils.createMesh(primitives.sphere(0.12));
    const haloGeom = primitives.quad(); // 1×1,实际大小经 halo.setScale
    for (let i = 0; i < FOOD_PELLET_MAX; i++) {
        const node = new Node('Pellet');
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        node.active = false;
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = pelletMesh;
        renderer.material = foodMaterial;
        const halo = new Node('Halo');
        halo.layer = Layers.Enum.DEFAULT;
        node.addChild(halo);
        const haloRenderer = halo.addComponent(MeshRenderer);
        haloRenderer.mesh = utils.createMesh(haloGeom);
        haloRenderer.material = haloMaterial;
        foodNodes.push({ node, halo, active: false, x: 0, y: 0, z: 0, health: 1, scale: 1, phase: rr(0, Math.PI * 2) });
    }

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // ---- 全局面:环境光 + 指数雾(AIR 坑位:app.run 后经 scene.globals;enabled 必须先于 type) ----
    scene.globals.ambient.skyColorHDR.set(0.16, 0.3, 0.42, 1.0);
    scene.globals.ambient.skyIllum = 19000;
    const fog = scene.globals.fog;
    fog.enabled = true;
    fog.type = 2; // FogType.EXP2
    fog.fogColor = new Color(9, 32, 46, 255);
    fog.fogDensity = 0.014;

    spawnFish();
    spawnPlankton();
    buildFishColors(fishCol);
    buildPlanktonColors(plankCol);

    // ============================== 输入:惊散指针 + 投喂点击 ==============================
    const _loc = new Vec2(); // AIR 坑位:getLocation(out) 的 out 必须为 Vec2 实例(Vec2.set 调 out.set,普通对象会抛异常并毒化事件分发器)
    function updatePointerFromEvent(ev) {
        try {
            ev.getLocation(_loc);
            pointer.x = _loc.x;
            pointer.y = _loc.y;
            pointer.inside = true;
            pointer.valid = true;
            cameraComp.screenPointToRay(pointer.x, pointer.y, pointer.ray); // Component 签名:(x, y, out)
        } catch (e) {
            console.error('[e08] pointer event error:', e && e.message);
        }
    }
    function pointerDown(ev) {
        updatePointerFromEvent(ev);
        pointer.downX = pointer.x;
        pointer.downY = pointer.y;
        pointer.downT = performance.now();
    }
    input.on(Input.EventType.MOUSE_MOVE, updatePointerFromEvent);
    input.on(Input.EventType.TOUCH_MOVE, updatePointerFromEvent);
    input.on(Input.EventType.MOUSE_DOWN, pointerDown);
    input.on(Input.EventType.TOUCH_START, pointerDown);

    let lastFeedMs = 0;
    input.on(Input.EventType.MOUSE_UP, tryFeed);
    input.on(Input.EventType.TOUCH_END, tryFeed);
    /** 单击投喂:按下→抬起位移 <8px 且间隔 <500ms 视为点击(拖拽惊散不误投)。 */
    function tryFeed() {
        try {
            const now = performance.now();
            const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY);
            if (now - pointer.downT < 500 && moved < 8 && now - lastFeedMs > 200) {
                lastFeedMs = now;
                feedAt(pointer.ray);
                spawnRipple(pointer.x, window.innerHeight - pointer.y);
            }
        } catch (e) {
            console.error('[e08] feed error:', e && e.message);
        }
    }
    input.on(Input.EventType.MOUSE_LEAVE, () => { pointer.inside = false; });

    /** 投喂:点击射线 ∩ 过体积中心的视深平面,裁剪进水域。 */
    function feedAt(ray) {
        const o = ray.o, d = ray.d;
        const fwd = cameraComp.node.forward; // 世界空间 -z(视线反方向)
        const nx = -fwd.x, ny = -fwd.y, nz = -fwd.z; // 视线方向
        const denom = d.x * nx + d.y * ny + d.z * nz;
        let t = 20;
        if (Math.abs(denom) > 1e-4) {
            t = ((0 - o.x) * nx + (0.3 - o.y) * ny + (0 - o.z) * nz) / denom;
            if (!isFinite(t) || t < 2 || t > 60) t = 20;
        }
        sim.foodPosition = {
            x: clamp(o.x + d.x * t, BOUNDS.minX + 1.5, BOUNDS.maxX - 1.5),
            y: clamp(o.y + d.y * t, BOUNDS.minY + 1.2, BOUNDS.maxY - 1.2),
            z: clamp(o.z + d.z * t, BOUNDS.minZ + 1.5, BOUNDS.maxZ - 1.5),
        };
        food.active = true;
        sim.foodActive = true;
        food.age = 0;
        const count = 3 + Math.floor(rng() * 3); // 3-5 粒
        for (let i = 0; i < FOOD_PELLET_MAX; i++) {
            const p = foodNodes[i];
            if (i < count) {
                p.active = true;
                p.health = 1;
                p.scale = rr(0.85, 1.2);
                p.x = sim.foodPosition.x + rr(-0.45, 0.45);
                p.y = sim.foodPosition.y + rr(-0.35, 0.35);
                p.z = sim.foodPosition.z + rr(-0.45, 0.45);
                p.node.active = true;
                p.node.setPosition(p.x, p.y, p.z);
            } else {
                p.active = false;
                p.node.active = false;
            }
        }
    }

    // ============================== boids 核心 ==============================
    const _fwd = { x: 0, y: 0, z: 1 };

    function stepBoids(dt) {
        const n = fish.length;

        // 1) 指针威胁检测(基于真实 3D 距离:鱼到指针射线,禁定时器/脚本)
        let anyThreat = false;
        if (pointer.valid && pointer.inside) {
            const ro = pointer.ray.o, rd = pointer.ray.d;
            for (let i = 0; i < n; i++) {
                const f = fish[i];
                const wx = f.x - ro.x, wy = f.y - ro.y, wz = f.z - ro.z;
                const tp = wx * rd.x + wy * rd.y + wz * rd.z;
                const cl = tp > 0 ? tp : 0;
                const ddx = wx - rd.x * cl, ddy = wy - rd.y * cl, ddz = wz - rd.z * cl;
                if (ddx * ddx + ddy * ddy + ddz * ddz < SCATTER_RADIUS * SCATTER_RADIUS) {
                    anyThreat = true;
                    break;
                }
            }
        }
        if (anyThreat) pointer.lastThreat = simTime;
        // 模式:存在威胁,或威胁消失未超过滞回时长 → scatter
        const shouldScatter = anyThreat || (pointer.valid && simTime - pointer.lastThreat < SCATTER_HOLD);
        if (shouldScatter) sim.boidMode = 'scatter';
        else sim.boidMode = 'normal';
        const modeScatter = sim.boidMode === 'scatter';

        // 2) 参数按模式切换(惊散:弱聚集 + 强分离 + 高速)
        const maxSpeed = modeScatter ? 7.6 : 3.4;
        const wCoh = modeScatter ? 0.25 : 2.1;
        const wAli = modeScatter ? 0.5 : 1.6;
        const wSep = modeScatter ? 5.5 : 3.1;
        const sepRadius = modeScatter ? 2.1 : 1.05;
        const cohRadius = 4.6;
        const aliRadius = 3.2;

        // 3) 质心 + 内聚指标(冻结公式:1 - min(1, 质心均距/10),逐帧真实计算)
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < n; i++) {
            cx += fish[i].x; cy += fish[i].y; cz += fish[i].z;
        }
        cx /= n; cy /= n; cz /= n;
        let sumDist = 0;
        for (let i = 0; i < n; i++) {
            const f = fish[i];
            sumDist += Math.hypot(f.x - cx, f.y - cy, f.z - cz);
        }
        const avgDist = sumDist / n;
        sim.avgCohesion = 1 - Math.min(1, avgDist / 10);

        // 离散时的集群回归助力(常态 avgDist 偏大时增强向心 → 5s 内重聚)
        const gatherW = (!modeScatter && !sim.foodActive && avgDist > 3.2) ? (avgDist - 3.2) * 1.5 * 0.55 : 0;

        // 4) 逐鱼合力
        for (let i = 0; i < n; i++) {
            const f = fish[i];
            let ax = 0, ay = 0, az = 0;
            let cohX = 0, cohY = 0, cohZ = 0, cohN = 0;
            let aliX = 0, aliY = 0, aliZ = 0, aliN = 0;
            let sepX = 0, sepY = 0, sepZ = 0;

            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                const o = fish[j];
                const dx = o.x - f.x, dy = o.y - f.y, dz = o.z - f.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > cohRadius * cohRadius || d2 < 1e-8) continue;
                cohX += o.x; cohY += o.y; cohZ += o.z; cohN++;
                aliX += o.vx; aliY += o.vy; aliZ += o.vz; aliN++;
                const d = Math.sqrt(d2);
                if (d < sepRadius) {
                    const s = (sepRadius / d) * (sepRadius / d) / sepRadius; // 反比平方,归一尺度
                    sepX -= dx * s; sepY -= dy * s; sepZ -= dz * s;
                }
            }
            if (cohN > 0) {
                ax += (cohX / cohN - f.x) * wCoh;
                ay += (cohY / cohN - f.y) * wCoh;
                az += (cohZ / cohN - f.z) * wCoh;
            }
            if (aliN > 0) {
                ax += (aliX / aliN - f.vx) * wAli;
                ay += (aliY / aliN - f.vy) * wAli;
                az += (aliZ / aliN - f.vz) * wAli;
            }
            ax += sepX * wSep;
            ay += sepY * wSep;
            az += sepZ * wSep;

            // 集群回归:朝全局质心
            if (gatherW > 0) {
                ax += (cx - f.x) * gatherW;
                ay += (cy - f.y) * gatherW;
                az += (cz - f.z) * gatherW;
            }

            // 食物吸引(强于常规聚集 → 围绕食物形成密集球)
            if (sim.foodActive) {
                ax += (sim.foodPosition.x - f.x) * 1.4;
                ay += (sim.foodPosition.y - f.y) * 1.4;
                az += (sim.foodPosition.z - f.z) * 1.4;
            }

            // 惊散斥力:远离指针射线最近点(连续转向 + 一次性爆发冲量)
            if (pointer.valid && pointer.inside) {
                const ro = pointer.ray.o, rd = pointer.ray.d;
                const wx = f.x - ro.x, wy = f.y - ro.y, wz = f.z - ro.z;
                const tp = wx * rd.x + wy * rd.y + wz * rd.z;
                const cl = tp > 0 ? tp : 0;
                const ddx = wx - rd.x * cl, ddy = wy - rd.y * cl, ddz = wz - rd.z * cl;
                const dist = Math.hypot(ddx, ddy, ddz);
                if (dist < SCATTER_RADIUS && dist > 1e-4) {
                    const s = 1 - dist / SCATTER_RADIUS;
                    const inv = 1 / dist;
                    ax += ddx * inv * s * 34;
                    ay += ddy * inv * s * 34;
                    az += ddz * inv * s * 34;
                    if (f.fleeCd <= 0) {
                        f.vx += ddx * inv * 5.2; // 瞬时爆发(炸开的急加速感)
                        f.vy += ddy * inv * 5.2;
                        f.vz += ddz * inv * 5.2;
                        f.fleeCd = 0.45;
                    }
                }
            }
            f.fleeCd -= dt;

            // 个体游荡(低频摆动 → 群体缓慢巡游,避免静止堆积)
            const w1 = Math.sin(simTime * 0.5 + f.wob1);
            const w2 = Math.sin(simTime * 0.37 + f.wob2);
            ax += (w1 * 0.6 - f.dx * 0.25) * 0.55;
            ay += w2 * 0.22;
            az += (w2 * 0.6 - f.dz * 0.25) * 0.55;

            // 弱洋流回中力:群整体缓慢巡游但始终留在取景水域中央
            if (!modeScatter) {
                ax += (0 - f.x) * 0.16;
                ay += (0.3 - f.y) * 0.12;
                az += (0 - f.z) * 0.1;
            }

            // 软边界(鱼群约束在可视角内,不出画面)
            const margin = 1.6;
            const wall = 9;
            if (f.x < BOUNDS.minX + margin) ax += (BOUNDS.minX + margin - f.x) * wall;
            if (f.x > BOUNDS.maxX - margin) ax -= (f.x - (BOUNDS.maxX - margin)) * wall;
            if (f.y < BOUNDS.minY + margin) ay += (BOUNDS.minY + margin - f.y) * wall;
            if (f.y > BOUNDS.maxY - margin) ay -= (f.y - (BOUNDS.maxY - margin)) * wall;
            if (f.z < BOUNDS.minZ + margin) az += (BOUNDS.minZ + margin - f.z) * wall;
            if (f.z > BOUNDS.maxZ - margin) az -= (f.z - (BOUNDS.maxZ - margin)) * wall;

            // 积分 + 限速(下限维持游动感)
            f.vx += ax * dt;
            f.vy += ay * dt;
            f.vz += az * dt;
            const sp = Math.hypot(f.vx, f.vy, f.vz);
            if (sp > maxSpeed) {
                const k = maxSpeed / sp;
                f.vx *= k; f.vy *= k; f.vz *= k;
            } else if (sp < 1.1 && sp > 1e-4) {
                const k = 1.1 / sp;
                f.vx *= k; f.vy *= k; f.vz *= k;
            }
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            f.z += f.vz * dt;
            f.x = clamp(f.x, BOUNDS.minX, BOUNDS.maxX);
            f.y = clamp(f.y, BOUNDS.minY, BOUNDS.maxY);
            f.z = clamp(f.z, BOUNDS.minZ, BOUNDS.maxZ);

            // 朝向平滑 + 转弯侧倾
            const spd = Math.hypot(f.vx, f.vy, f.vz) || 1;
            const blend = 1 - Math.exp(-dt * 7);
            let ndx = f.dx + (f.vx / spd - f.dx) * blend;
            let ndy = f.dy + (f.vy / spd - f.dy) * blend;
            let ndz = f.dz + (f.vz / spd - f.dz) * blend;
            const nl = Math.hypot(ndx, ndy, ndz) || 1;
            ndx /= nl; ndy /= nl; ndz /= nl;
            const yawRate = (f.dx * ndz - f.dz * ndx) / Math.max(dt, 1e-3);
            const bankTarget = clamp(yawRate * 0.22, -0.65, 0.65);
            f.bank += (bankTarget - f.bank) * Math.min(1, dt * 5);
            f.dx = ndx; f.dy = ndy; f.dz = ndz;

            // 摆尾相位(速度越快摆得越快)
            f.phase += dt * (3.2 + spd * 2.0);
        }

        // 5) 到食物的平均距离
        if (sim.foodActive) {
            let sd = 0;
            for (let i = 0; i < n; i++) {
                const f = fish[i];
                sd += Math.hypot(f.x - sim.foodPosition.x, f.y - sim.foodPosition.y, f.z - sim.foodPosition.z);
            }
            sim.avgDistanceToFood = sd / n;
        } else {
            sim.avgDistanceToFood = null;
        }
    }

    /** 每帧重写鱼群网格:基变换(朝向+侧倾)+ 沿体长正弦弯曲摆尾,法线同步。 */
    function writeFishMesh() {
        const P = fishPos, N = fishNrm, T = tpl;
        let vi = 0;
        for (let fi = 0; fi < fish.length; fi++) {
            const f = fish[fi];
            _fwd.x = f.dx; _fwd.y = f.dy; _fwd.z = f.dz;
            // right = cross((0,1,0), fwd),forward 近竖直时兜底
            let rx = _fwd.z, rz = -_fwd.x;
            let rl = Math.hypot(rx, rz);
            if (rl < 0.08) { rx = 1; rz = 0; rl = 1; }
            rx /= rl; rz /= rl;
            // 侧倾(bank 绕 fwd 旋转 right/up)
            const cb = Math.cos(f.bank), sb = Math.sin(f.bank);
            const rX = rx * cb, rY = sb, rZ = rz * cb; // right' = right·cosB + up0·sinB
            const uX = -rx * sb, uY = cb, uZ = -rz * sb; // up' = up0·cosB − right·sinB
            const spd = Math.hypot(f.vx, f.vy, f.vz);
            const amp = 0.05 + Math.min(0.075, spd * 0.016);
            const ph = f.phase;
            const L = f.len;
            const base = vi * 3;
            for (let k = 0; k < T.vCount; k++) {
                const k3 = k * 3;
                const lx = T.pos[k3], ly = T.pos[k3 + 1], lz = T.pos[k3 + 2];
                const bendAmp = amp * T.bendExtra[k];
                const arg = ph + lz * 2.4;
                const t = bendT(lz);
                const bend = bendAmp * Math.sin(arg) * t;
                const db = bendAmp * Math.cos(arg) * 2.4 * t;
                const x = (lx + bend) * L, y = ly * L, z = lz * L;
                P[base + k3] = f.x + rX * x + uX * y + _fwd.x * z;
                P[base + k3 + 1] = f.y + rY * x + uY * y + _fwd.y * z;
                P[base + k3 + 2] = f.z + rZ * x + uZ * y + _fwd.z * z;
                const nx0 = T.nrm[k3], ny0 = T.nrm[k3 + 1], nz0 = T.nrm[k3 + 2];
                const nx = nx0 - db * nz0;
                const nz = nz0 + db * nx0;
                N[base + k3] = rX * nx + uX * ny0 + _fwd.x * nz;
                N[base + k3 + 1] = rY * nx + uY * ny0 + _fwd.y * nz;
                N[base + k3 + 2] = rZ * nx + uZ * ny0 + _fwd.z * nz;
            }
            vi += T.vCount;
        }
        fishMesh.updateSubMesh(0, {
            positions: fishPos, normals: fishNrm, colors: fishCol,
            indices16: fishIndices, minPos: volBounds.minPos, maxPos: volBounds.maxPos,
        });
    }

    /** 颗粒缓漂 + billboard 重写(朝向相机)。 */
    function stepPlankton() {
        const cr = cameraComp.node.right;
        const cu = cameraComp.node.up;
        const P = plankPos;
        const riseRange = BOUNDS.maxY - BOUNDS.minY;
        for (let i = 0; i < plankton.length; i++) {
            const p = plankton[i];
            const x = p.bx + Math.sin(simTime * p.fx + p.p1) * p.ax;
            let y = p.by + Math.sin(simTime * p.fy + p.p2) * p.ay - ((simTime * 0.07) % 2.2);
            if (y < BOUNDS.minY) y += riseRange;
            const z = p.bz + Math.sin(simTime * p.fz + p.p3) * p.az;
            const s = p.size;
            const v = i * 12;
            P[v] = x - (cr.x + cu.x) * s; P[v + 1] = y - (cr.y + cu.y) * s; P[v + 2] = z - (cr.z + cu.z) * s;
            P[v + 3] = x + (cr.x - cu.x) * s; P[v + 4] = y + (cr.y - cu.y) * s; P[v + 5] = z + (cr.z - cu.z) * s;
            P[v + 6] = x + (-cr.x + cu.x) * s; P[v + 7] = y + (-cr.y + cu.y) * s; P[v + 8] = z + (-cr.z + cu.z) * s;
            P[v + 9] = x + (cr.x + cu.x) * s; P[v + 10] = y + (cr.y + cu.y) * s; P[v + 11] = z + (cr.z + cu.z) * s;
        }
        planktonMesh.updateSubMesh(0, {
            positions: plankPos, normals: plankNrm, uvs: plankUv, colors: plankCol,
            indices16: plankIdx, minPos: volBounds.minPos, maxPos: volBounds.maxPos,
        });
    }

    /** 食物:下沉/呼吸/被啄食(真实消耗)/超时消失。 */
    function stepFood(dt) {
        if (!food.active) return;
        food.age += dt;
        let anyAlive = false;
        for (const p of foodNodes) {
            if (!p.active) continue;
            let near = 0;
            for (const f of fish) {
                if (Math.abs(f.x - p.x) < 0.7 && Math.abs(f.y - p.y) < 0.7 && Math.abs(f.z - p.z) < 0.7) near++;
            }
            // 啄食消耗率校准:无指针威胁时 ~20 条围食 → ~8s 吃尽;有指针悬停时鱼群在惊散半径外环绕,主要走超时
            p.health -= near * dt * 0.006;
            if (p.health > 0) {
                anyAlive = true;
                p.y = Math.max(p.y - dt * 0.22, BOUNDS.minY + 0.8);
                const pul = 0.85 + 0.25 * Math.sin(simTime * 5 + p.phase);
                const fade = Math.min(1, p.health * 2.2);
                const sc = p.scale * pul * (0.35 + 0.65 * fade);
                p.node.setPosition(p.x, p.y + Math.sin(simTime * 2 + p.phase) * 0.05, p.z);
                p.node.setScale(sc, sc, sc);
                const hs = p.scale * 0.9 * (1.15 + 0.18 * Math.sin(simTime * 3.3 + p.phase)) * (0.4 + 0.6 * fade);
                p.halo.setScale(hs, hs, 1);
                const wr = cameraComp.node.worldRotation; // 光晕朝向相机
                p.halo.setRotation(wr.x, wr.y, wr.z, wr.w);
            } else {
                p.active = false;
                p.node.active = false;
            }
        }
        if (!anyAlive || food.age >= FOOD_LIFETIME) clearFood();
    }

    function clearFood() {
        food.active = false;
        sim.foodPosition = null;
        sim.foodActive = false;
        sim.avgDistanceToFood = null;
        for (const p of foodNodes) {
            p.active = false;
            p.node.active = false;
        }
    }

    /** 光柱缓摆。 */
    function stepBeams() {
        for (const b of beamNodes) {
            b.node.setRotationFromEuler(0, 0, b.baseTilt + Math.sin(simTime * 0.24 + b.phase) * 2.4 * b.sway);
        }
    }

    /** 鱼群顶点色(反荫蔽 + 个体色相微调),仅构建/reset 时计算。 */
    function buildFishColors(col) {
        let ci = 0;
        for (const f of fish) {
            const topR = 0.46 + f.hue, topG = 0.56 + f.hue * 0.5, topB = 0.68;
            const botR = 0.88 + f.hue * 0.5, botG = 0.93, botB = 0.98;
            for (let k = 0; k < tpl.vCount; k++) {
                const w = tpl.shade[k] * tpl.shade[k];
                col[ci] = topR * w + botR * (1 - w);
                col[ci + 1] = topG * w + botG * (1 - w);
                col[ci + 2] = topB * w + botB * (1 - w);
                col[ci + 3] = 1;
                ci += 4;
            }
        }
    }

    /** 颗粒顶点色:青白色调 + 个体透明度(静态)。 */
    function buildPlanktonColors(col) {
        let ci = 0;
        for (const p of plankton) {
            const r = 0.72 + p.tint * 0.28;
            const g = 0.9 + p.tint * 0.1;
            for (let k = 0; k < 4; k++) {
                col[ci] = r; col[ci + 1] = g; col[ci + 2] = 1.0; col[ci + 3] = p.alpha;
                ci += 4;
            }
        }
    }

    // ============================== 仿真驱动组件 ==============================
    class SchoolDriver extends Component {
        update(dt) {
            dt = Math.min(dt, 0.05);
            simTime += dt;
            stepBoids(dt);
            writeFishMesh();
            stepPlankton();
            stepFood(dt);
            stepBeams();
        }
    }
    const driverNode = new Node('Sim');
    scene.addChild(driverNode);
    driverNode.addComponent(SchoolDriver);

    // ============================== reset(禁止页面刷新) ==============================
    function doReset() {
        sim.resetCount += 1;
        rng = mulberry32(SEED); // 可复现初始分布
        clearFood();
        sim.boidMode = 'normal';
        sim.avgCohesion = 1;
        sim.avgDistanceToFood = null;
        pointer.lastThreat = -1e9;
        simTime = 0;
        spawnFish();
        spawnPlankton();
        buildFishColors(fishCol);
        buildPlanktonColors(plankCol);
        beamNodes.forEach((b) => { b.phase = rr(0, Math.PI * 2); });
        updateHud();
    }
    window.__bench.reset = doReset;
    resetBtn.addEventListener('click', doReset);

    // ---- HUD 低频刷新 ----
    let hudTimer = 0;
    director.on(Director.EVENT_AFTER_UPDATE, () => {
        if (++hudTimer >= 15) {
            hudTimer = 0;
            updateHud();
        }
    });

    // ---- 首帧就绪契约 ----
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) {
            window.__appReady = true;
            updateHud();
        }
    });

    console.log('[e08] deep sea fish school running on cocosair', app.getScene() && app.getScene().name);
} catch (err) {
    console.error('[e08] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
