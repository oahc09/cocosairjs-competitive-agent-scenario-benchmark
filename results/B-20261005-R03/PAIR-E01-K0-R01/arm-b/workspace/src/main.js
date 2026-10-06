/**
 * E01 — Deep Space Galaxy Cruise(cocosair,K0 冷启动实现)
 *
 * 实现策略(为什么这么写):
 *   - 引擎无 Points/InstancedMesh(K0 已知边界)→ 星点用"水平小 quad"批量编码进
 *     TRIANGLE_LIST 网格,每 12000 星一个 chunk(4×12000=48000 顶点,Uint16 索引安全),
 *     全场景仅 ~7 个 draw call,满足"批量提交、不逐星点绘制"。
 *   - 颜色双保险:每个 chunk 一份带色 tint 材质(builtin-unlit + mainColor),
 *     顶点色编码"星点色 / 带均色"的相对值 —— 若 unlit 启用 USE_VERTEX_COLOR,
 *     最终色 = tint × vcolor ≈ 精确目标色;若不启用,带 tint 本身也给出径向梯度。
 *   - 旋转:rotationPhase 由组件 update(dt) 累加(0.05 rad/s),galaxyRoot 绕 Y 旋转
 *     (setRotationFromEuler 用角度制);背景星层在 galaxyRoot 之外,保持静止增强纵深。
 *   - 输入:pal 层会吞 canvas 鼠标事件 → 统一用 window 捕获阶段监听
 *     (capture 在 pal 的 canvas 处理器之前触发),wheel 只读、passive。
 *   - reset:纯状态重置(相机距离/视差/相位瞬时恢复 + epoch+1),绝不刷新页面。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState, reset }:返回 spec.json stateContract 七字段。
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
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量与状态(spec.json stateContract 的唯一事实源)
// ---------------------------------------------------------------------------
const DEG = 180 / Math.PI;

const CONFIG = {
    cameraDistance: 120, // 初始相机距离(spec 冻结)
    camMin: 40,
    camMax: 400,
    elevationDeg: 38, // 斜俯视:盘面法线与视线夹角 = 90-38 = 52°(30–60° 合规)
    azimuthDeg: 32,
    omega: 0.05, // rad/s,规格区间 0.02–0.1 的中点
    parallaxShift: 16, // 视差满偏(0.5)= 8 世界单位 ≈ 视口高 8%,红线 ≤10%
    wheelGain: 0.12, // deltaY → 目标距离增量(单位/滚动单位)
    smoothDist: 3.2, // 距离指数平滑速率(1/s),逐帧插值不瞬跳
    smoothParallax: 3.0, // 视差平滑速率,指数逼近无过冲
};

const state = {
    starCount: 0, // 只统计成功提交渲染的星点
    rotationPhase: 0, // rad,单调递增,reset 归零
    cameraDistance: CONFIG.cameraDistance, // 当前平滑值
    camTarget: CONFIG.cameraDistance, // 滚轮目标值
    parallax: { x: 0, y: 0 }, // 当前平滑值(有符号,基于指针偏离中心)
    parallaxTarget: { x: 0, y: 0 },
    fps: 0, // 2s 滚动平均
    hudVisible: true,
    epoch: 0,
};

window.__appReady = false;
// 开发诊断口(非探针契约,仅 self-check 用)
window.__diag = { errors: [], chunks: 0, material: 'none', bands: 0 };

window.__bench = {
    getState: () => ({
        starCount: state.starCount,
        rotationPhase: state.rotationPhase,
        cameraDistance: state.cameraDistance,
        parallaxOffset: { x: state.parallax.x, y: state.parallax.y },
        fps: state.fps,
        hudVisible: state.hudVisible,
        epoch: state.epoch,
    }),
    reset: doReset,
};

let galaxyRoot = null;
let bgRoot = null;
let cameraNode = null;
let hudStatsEl = null;
let MaterialCtor = null; // 经动态 import 安全获取(避免静态命名导入不存在即整页失败)
let baseEffectAsset = null;

function doReset() {
    state.epoch += 1;
    state.rotationPhase = 0;
    state.cameraDistance = CONFIG.cameraDistance;
    state.camTarget = CONFIG.cameraDistance;
    state.parallax.x = 0;
    state.parallax.y = 0;
    state.parallaxTarget.x = 0;
    state.parallaxTarget.y = 0;
    if (galaxyRoot && galaxyRoot.isValid) galaxyRoot.setRotationFromEuler(0, 0, 0);
    applyCamera(); // 立即恢复观察状态(<1s,瞬时满足)
    updateHud();
}

// ---------------------------------------------------------------------------
// 输入(window 捕获阶段,先于 pal 层的 canvas 处理器)
// ---------------------------------------------------------------------------
window.addEventListener(
    'pointermove',
    (e) => {
        try {
            const w = window.innerWidth || 1;
            const h = window.innerHeight || 1;
            // 指针偏离画面中心的有符号比例偏移 ∈ [-0.5, 0.5]
            state.parallaxTarget.x = e.clientX / w - 0.5;
            state.parallaxTarget.y = e.clientY / h - 0.5;
        } catch (err) {
            /* 输入解析失败不影响渲染 */
        }
    },
    { capture: true },
);

window.addEventListener(
    'wheel',
    (e) => {
        try {
            const next = state.camTarget + e.deltaY * CONFIG.wheelGain;
            state.camTarget = Math.min(CONFIG.camMax, Math.max(CONFIG.camMin, next));
        } catch (err) {
            /* 同上 */
        }
    },
    { capture: true, passive: true },
);

// ---------------------------------------------------------------------------
// 相机轨道 + 视差(复用向量对象,避免每帧分配)
// ---------------------------------------------------------------------------
const tmpPos = new Vec3();
const tmpLook = new Vec3(0, 0, 0);

function applyCamera() {
    if (!cameraNode || !cameraNode.isValid) return;
    const d = state.cameraDistance;
    const el = CONFIG.elevationDeg / DEG;
    const az = CONFIG.azimuthDeg / DEG;
    const ce = Math.cos(el);
    const se = Math.sin(el);
    const ca = Math.cos(az);
    const sa = Math.sin(az);

    // 轨道基点(始终看向原点)
    let px = d * ce * sa;
    let py = d * se;
    let pz = d * ce * ca;

    // 视差:沿相机 right/up 的横向平移(解析量,深度差产生星系与背景的相对位移)
    //   right = (ca, 0, -sa);up = (-se·sa, ce, -se·ca)(均垂直于视线,已验证正交)
    const k = CONFIG.parallaxShift;
    px += (ca * state.parallax.x - se * sa * state.parallax.y) * k;
    py += ce * state.parallax.y * k;
    pz += (-sa * state.parallax.x - se * ca * state.parallax.y) * k;

    tmpPos.x = px;
    tmpPos.y = py;
    tmpPos.z = pz;
    cameraNode.setPosition(tmpPos);
    cameraNode.lookAt(tmpLook);
}

// ---------------------------------------------------------------------------
// 星系程序化生成(确定性 RNG,构建期生成、运行期静态网格)
// ---------------------------------------------------------------------------
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

const RADIUS = 55; // 星系盘半径(直径 110 → 120 距离下约占屏宽 62%)
const THETA_MAX = 11.5; // 每条旋臂的对数螺旋参数域(rad ≈ 1.83 圈)
const SPIRAL_B = 0.28;
const SPIRAL_R0 = 2;

function generateStars() {
    const rand = mulberry32(0x0e01d2a);
    let spare = null;
    const gauss = () => {
        if (spare !== null) {
            const v = spare;
            spare = null;
            return v;
        }
        let u = 0;
        let v = 0;
        let s = 0;
        do {
            u = rand() * 2 - 1;
            v = rand() * 2 - 1;
            s = u * u + v * v;
        } while (s >= 1 || s === 0);
        const m = Math.sqrt((-2 * Math.log(s)) / s);
        spare = v * m;
        return u * m;
    };

    const stars = [];

    function push(x, y, z, r, g, b, h, band) {
        stars.push({ x, y, z, r, g, b, h, band });
    }

    // 半径梯度色:核心暖黄白 → 中段蓝白 → 外缘冷蓝
    function gradColor(t) {
        if (t < 0.55) {
            const k = t / 0.55;
            return [1.0 - 0.2 * k, 0.9 - 0.02 * k, 0.72 + 0.28 * k];
        }
        const k = (t - 0.55) / 0.45;
        return [0.8 - 0.22 * k, 0.88 - 0.16 * k, 1.0];
    }

    function bandOf(t) {
        if (t < 0.2) return 0;
        if (t < 0.4) return 1;
        if (t < 0.6) return 2;
        if (t < 0.8) return 3;
        return 4;
    }

    // --- 1) 旋臂(2 条对数螺旋,34000)---
    const ARM_STARS = 34000;
    for (let i = 0; i < ARM_STARS; i++) {
        const armIdx = i % 2;
        // 沿弧长近似均匀采样:e^{bθ} 线性分布(避免外臂过稀)
        const u = rand();
        const theta = Math.log(1 + u * 24.03) / SPIRAL_B;
        const rC = SPIRAL_R0 * Math.exp(SPIRAL_B * theta);
        const r = Math.min(RADIUS, Math.max(0.4, rC + gauss() * (1.4 + rC * 0.085)));
        const ang = theta + armIdx * Math.PI + gauss() * (0.09 + 4.5 / (rC + 3));
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        const y = gauss() * (0.65 + r * 0.016);
        const t = r / RADIUS;
        const giant = rand() < 0.035;
        const orange = rand() < 0.022;
        let cr, cg, cb, h;
        if (orange) {
            // 散布少量橙红亮星
            const b2 = 1.05 + rand() * 0.3;
            cr = 1.0 * b2;
            cg = 0.5 * b2;
            cb = 0.3 * b2;
            h = (0.16 + rand() * 0.1) * 1.6;
        } else {
            const base = gradColor(t);
            const bright = giant ? 1.2 + rand() * 0.2 : 0.78 + rand() * 0.34;
            cr = base[0] * bright;
            cg = base[1] * bright;
            cb = base[2] * bright;
            h = giant ? 0.3 + rand() * 0.22 : 0.1 + rand() * 0.12;
        }
        push(x, y, z, cr, cg, cb, h, bandOf(t));
    }

    // --- 2) 盘面普通星(12000,暗弱层级)---
    for (let i = 0; i < 12000; i++) {
        const r = Math.min(RADIUS, -Math.log(1 - rand()) * 13.5);
        const ang = rand() * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        const y = gauss() * (0.45 + r * 0.012);
        const t = r / RADIUS;
        const base = gradColor(t);
        const bright = 0.42 + rand() * 0.28;
        push(x, y, z, base[0] * bright, base[1] * bright, base[2] * bright, 0.07 + rand() * 0.09, bandOf(t));
    }

    // --- 3) 核球(12000,中央明亮聚集,计入总数)---
    for (let i = 0; i < 12000; i++) {
        const core = i < 4800; // 内核更密更亮
        const sx = core ? 1.8 : 4.2;
        const sy = core ? 1.1 : 2.4;
        const x = gauss() * sx;
        const z = gauss() * sx;
        const y = gauss() * sy;
        const giant = rand() < 0.04;
        const bright = core ? 0.95 + rand() * 0.4 : 0.7 + rand() * 0.35;
        const warm = [1.0, 0.9, 0.74];
        const h = giant ? 0.3 + rand() * 0.2 : 0.09 + rand() * 0.13;
        push(x, y, z, warm[0] * bright, warm[1] * bright, warm[2] * bright, h, 0);
    }

    // --- 4) 远景背景星(8000,静态,增强纵深)---
    for (let i = 0; i < 8000; i++) {
        let x = gauss();
        let y = gauss() * 0.5;
        let z = gauss();
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        const dist = 480 + rand() * 320;
        x = (x / len) * dist;
        y = (y / len) * dist;
        z = (z / len) * dist;
        const bright = 0.4 + rand() * 0.3;
        push(x, y, z, 0.8 * bright, 0.86 * bright, 1.0 * bright, 0.6 + rand() * 0.7, -1);
    }

    return stars;
}

// ---------------------------------------------------------------------------
// 分带 chunk → 网格数据(quad:4 顶点 6 索引;水平朝上,法线 +Y)
// ---------------------------------------------------------------------------
const BAND_TINTS = [
    [1.0, 0.92, 0.75], // 核心 暖黄白
    [0.96, 0.9, 0.8],
    [0.88, 0.89, 0.9], // 中段 蓝白
    [0.8, 0.87, 0.97],
    [0.7, 0.8, 1.0], // 外缘 冷蓝
];
const BG_TINT = [0.78, 0.84, 1.0];
const CHUNK = 12000; // 12000×4=48000 顶点 < 65536(Uint16 索引安全)

function tintOf(band) {
    return band < 0 ? BG_TINT : BAND_TINTS[band];
}

function chunkToMeshData(part) {
    const n = part.length;
    const positions = new Array(n * 12);
    const normals = new Array(n * 12);
    const uvs = new Array(n * 8);
    const colors = new Array(n * 16);
    const indices = new Array(n * 6);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < n; i++) {
        const s = part[i];
        const h = s.h;
        const vb = i * 4;
        const p = vb * 3;
        const c = vb * 4;
        const q = vb * 2;
        const v = i * 6;

        positions[p + 0] = s.x - h; positions[p + 1] = s.y; positions[p + 2] = s.z - h;
        positions[p + 3] = s.x - h; positions[p + 4] = s.y; positions[p + 5] = s.z + h;
        positions[p + 6] = s.x + h; positions[p + 7] = s.y; positions[p + 8] = s.z - h;
        positions[p + 9] = s.x + h; positions[p + 10] = s.y; positions[p + 11] = s.z + h;

        for (let k = 0; k < 4; k++) {
            normals[p + k * 3 + 0] = 0;
            normals[p + k * 3 + 1] = 1;
            normals[p + k * 3 + 2] = 0;
        }
        uvs[q + 0] = 0; uvs[q + 1] = 0;
        uvs[q + 2] = 0; uvs[q + 3] = 1;
        uvs[q + 4] = 1; uvs[q + 5] = 0;
        uvs[q + 6] = 1; uvs[q + 7] = 1;

        // 顶点色 = 目标色 / 带均色(tint),渲染时 tint×vcolor ≈ 目标色;
        // 若引擎不启用顶点色,则 tint 单独给出该带梯度(双保险)。
        const tint = tintOf(s.band);
        colors[c + 0] = Math.min(1, s.r / tint[0]);
        colors[c + 1] = Math.min(1, s.g / tint[1]);
        colors[c + 2] = Math.min(1, s.b / tint[2]);
        colors[c + 3] = 1;
        colors[c + 4] = colors[c + 0]; colors[c + 5] = colors[c + 1]; colors[c + 6] = colors[c + 2]; colors[c + 7] = 1;
        colors[c + 8] = colors[c + 0]; colors[c + 9] = colors[c + 1]; colors[c + 10] = colors[c + 2]; colors[c + 11] = 1;
        colors[c + 12] = colors[c + 0]; colors[c + 13] = colors[c + 1]; colors[c + 14] = colors[c + 2]; colors[c + 15] = 1;

        // 上视 CCW 绕序(叉积朝 +Y,相机俯视可见)
        indices[v + 0] = vb; indices[v + 1] = vb + 1; indices[v + 2] = vb + 2;
        indices[v + 3] = vb + 2; indices[v + 4] = vb + 1; indices[v + 5] = vb + 3;

        if (s.x - h < minX) minX = s.x - h; if (s.x + h > maxX) maxX = s.x + h;
        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
        if (s.z - h < minZ) minZ = s.z - h; if (s.z + h > maxZ) maxZ = s.z + h;
    }

    return {
        positions,
        normals,
        uvs,
        colors,
        indices,
        minPos: new Vec3(minX, minY, minZ),
        maxPos: new Vec3(maxX, maxY, maxZ),
    };
}

function pickBuiltinMaterial() {
    const candidates = ['builtin-unlit-material', 'builtin-unlit', 'unlit-material', 'unlit'];
    for (const name of candidates) {
        try {
            const m = builtinResMgr.get(name);
            if (m) {
                window.__diag.material = name;
                return m;
            }
        } catch (err) {
            /* 尝试下一个候选名 */
        }
    }
    window.__diag.material = 'builtin-standard-material(fallback)';
    return builtinResMgr.get('builtin-standard-material');
}

function makeBandMaterial(tint) {
    // 自定义材质正路:new Material() + initialize({effectAsset})(effectName 只读)
    try {
        if (MaterialCtor && baseEffectAsset) {
            const m = new MaterialCtor();
            m.initialize({ effectAsset: baseEffectAsset });
            m.setProperty('mainColor', new Color(tint[0] * 255, tint[1] * 255, tint[2] * 255, 255));
            return m;
        }
    } catch (err) {
        window.__diag.errors.push('bandMat:' + (err && err.message ? err.message : err));
    }
    return baseMaterialShared; // 兜底:共享基础材质(梯度退化为顶点色或单色)
}

let baseMaterialShared = null;
const bandMaterialCache = new Map();
function materialForBand(band) {
    const key = band;
    if (!bandMaterialCache.has(key)) {
        bandMaterialCache.set(key, makeBandMaterial(tintOf(band)));
    }
    return bandMaterialCache.get(key);
}

// ---------------------------------------------------------------------------
// HUD(2D DOM 覆盖层;数值全部来自运行状态,允许四舍五入)
// ---------------------------------------------------------------------------
function buildHud() {
    const panel = document.createElement('div');
    panel.id = 'bench-hud';
    panel.setAttribute('data-ui', 'hud');
    panel.style.cssText =
        'position:fixed;top:10px;left:10px;z-index:9990;padding:8px 12px;' +
        'background:rgba(6,10,22,0.78);border:1px solid #2b3a5c;border-radius:6px;' +
        'color:#e8efff;font:12px/1.55 Consolas,monospace;user-select:none;';
    const title = document.createElement('div');
    title.textContent = 'E01 · DEEP SPACE GALAXY CRUISE';
    title.style.cssText = 'font-weight:700;color:#9fc0ff;letter-spacing:1px;';
    const stats = document.createElement('div');
    stats.id = 'bench-hud-stats';
    stats.setAttribute('data-ui', 'hud-stats');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.style.cssText =
        'margin-top:6px;padding:4px 18px;font:12px sans-serif;background:#1d2b4a;color:#fff;' +
        'border:1px solid #4a6ea8;border-radius:4px;cursor:pointer;';
    btn.addEventListener('click', () => {
        try {
            doReset();
        } catch (err) {
            /* reset 失败不抛未捕获异常 */
        }
    });
    panel.appendChild(title);
    panel.appendChild(stats);
    panel.appendChild(btn);
    document.body.appendChild(panel);
    return stats;
}

function updateHud() {
    if (!hudStatsEl) return;
    const fps = Math.round(state.fps);
    const dist = Math.round(state.cameraDistance * 10) / 10;
    hudStatsEl.textContent =
        'Stars: ' + state.starCount + ' | FPS: ' + fps + ' | Dist: ' + dist + ' | Epoch: ' + state.epoch;
}

// ---------------------------------------------------------------------------
// 每帧推进组件:旋转 / 平滑 / 相机 / HUD
// ---------------------------------------------------------------------------
class CruiseController extends Component {
    hudAccum = 0;

    update(dt) {
        try {
            const s = Math.min(Math.max(dt, 0), 0.1); // 后台恢复的大 dt 钳制,相位仍单调
            state.rotationPhase += CONFIG.omega * s;
            if (galaxyRoot && galaxyRoot.isValid) {
                galaxyRoot.setRotationFromEuler(0, state.rotationPhase * DEG, 0);
            }

            // 距离与视差:指数平滑逼近目标,逐帧插值、无过冲
            const kd = 1 - Math.exp(-s * CONFIG.smoothDist);
            state.cameraDistance += (state.camTarget - state.cameraDistance) * kd;
            const kp = 1 - Math.exp(-s * CONFIG.smoothParallax);
            state.parallax.x += (state.parallaxTarget.x - state.parallax.x) * kp;
            state.parallax.y += (state.parallaxTarget.y - state.parallax.y) * kp;

            applyCamera();

            this.hudAccum += s;
            if (this.hudAccum >= 0.2) {
                this.hudAccum = 0;
                updateHud();
            }
        } catch (err) {
            window.__diag.errors.push('update:' + (err && err.message ? err.message : err));
        }
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    // Material 不在模板已验证导出清单内 → 动态 namespace 获取,缺失也不致命
    try {
        const engineNS = await import('cocosair.js');
        MaterialCtor = engineNS.Material || null;
    } catch (err) {
        window.__diag.errors.push('nsImport:' + (err && err.message ? err.message : err));
    }

    const scene = new Scene('E01-galaxy');

    // Camera(引擎 4.0-alpha 默认 visibility undefined → 必须显式 DEFAULT)
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(4, 6, 12, 255); // 接近纯黑深空(暗于 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 方向光(仅为 standard 材质兜底路径保留;unlit 星点不受光照影响)
    const lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 10, 0));
    lightNode.setRotationFromEuler(-45, -30, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 50000;

    // 星系根节点(旋转载体)与静态背景层
    galaxyRoot = new Node('Galaxy');
    galaxyRoot.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyRoot);
    bgRoot = new Node('Background');
    bgRoot.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgRoot);

    // 生成 + 分 chunk + 提交
    const stars = generateStars();
    baseMaterialShared = pickBuiltinMaterial();
    baseEffectAsset = baseMaterialShared && baseMaterialShared.effectAsset ? baseMaterialShared.effectAsset : null;

    const byBand = new Map();
    for (const s of stars) {
        if (!byBand.has(s.band)) byBand.set(s.band, []);
        byBand.get(s.band).push(s);
    }
    window.__diag.bands = byBand.size;

    const bandKeys = Array.from(byBand.keys()).sort((a, b) => a - b);
    for (const band of bandKeys) {
        const list = byBand.get(band);
        const parent = band < 0 ? bgRoot : galaxyRoot;
        for (let off = 0; off < list.length; off += CHUNK) {
            const part = list.slice(off, off + CHUNK);
            let mesh = null;
            try {
                mesh = utils.createMesh(chunkToMeshData(part));
            } catch (err) {
                window.__diag.errors.push('mesh:' + (err && err.message ? err.message : err));
                continue; // 失败 chunk 不计入 starCount(状态值=真实提交数)
            }
            const node = new Node('stars-b' + band + '-' + off);
            node.layer = Layers.Enum.DEFAULT;
            parent.addChild(node);
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = materialForBand(band);
            state.starCount += part.length;
            window.__diag.chunks += 1;
        }
    }

    applyCamera();

    const ctrlNode = new Node('CruiseController');
    ctrlNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(ctrlNode);
    ctrlNode.addComponent(CruiseController);

    app.run(scene);

    // 环境光(模板已验证路径:app.run 后原位 set 共享 Vec4)
    scene.globals.ambient.skyColorHDR.set(0.35, 0.5, 0.75, 1.0);
    scene.globals.ambient.skyIllum = 20000;

    hudStatsEl = buildHud();
    updateHud();

    // 帧计数 + fps(2s 滚动平均)+ 首帧就绪
    const frameTimes = [];
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameTimes.push(now);
        while (frameTimes.length > 0 && now - frameTimes[0] > 2000) frameTimes.shift();
        state.fps = frameTimes.length / 2;
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[E01] galaxy running, stars =', state.starCount);
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类(同模板约定)
    console.error('[E01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
