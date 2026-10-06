/**
 * E01 — Deep Space Galaxy Cruise(深空星系巡航)— cocosair Arm
 *
 * 设计要点(为何这样实现):
 *  - 58,000 颗星全部走「单网格 + 单 draw call」批量提交:utils.MeshUtils.createMesh 一次生成
 *    TRIANGLE_LIST 静态网格,每星 4 顶点(位置 = 星心,texCoord = 以 0.5 为中心的子区域)。
 *  - 材质用引擎内置 builtin-billboard effect(technique "add"):加法混合 + depthWrite off +
 *    双面不剔除,顶点着色器以 cc_matViewInv 把 (a_texCoord-0.5) 偏移展开成相机朝向面片,
 *    片元为 col = 2 * v_color * tintColor * tex,正好满足"星点亮核 + 柔晕"的辉光需求。
 *  - 星点尺寸/亮暗分层完全由每顶点数据承载:尺寸 = texCoord 采样范围缩放(0.5±0.5s),
 *    亮度 = RGBA32F 顶点色(>1 的 HDR 值也能表达,加法混合后自然白热)。
 *  - 星体辉光贴图 = 运行时程序化生成的 64×64 径向衰减纹理(无任何外部资源,符合 Asset Contract)。
 *  - 星系旋转 = 星系根节点绕盘面法线(+Y)旋转,rotationPhase 单调递增(0.05 rad/s ∈ [0.02,0.1])。
 *  - 相机 = 固定仰角 38°,滚轮改变目标距离(逐帧指数平滑,不瞬跳),指针视差 = 垂直于视线方向的
 *    小幅横移(≤ 画布 6%,同样逐帧平滑),全部输入用 window 捕获阶段监听(绕开 pal 层吞事件)。
 *  - reset():目标值归位 + 相位清零,epoch+1,全程无页面刷新,可重复执行。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Vec3,
    Vec4,
    Color,
    Component,
    director,
    Director,
    Material,
    Texture2D,
    utils,
} from 'cocosair.js';

/* ---------------------------------------------------------------------------
 * 常量(全部由 spec.json / brief.md 推导)
 * ------------------------------------------------------------------------- */
const ROT_SPEED = 0.05;             // rad/s,spec 允许 [0.02, 0.1]
const DIST0 = 120;                  // 初始相机距离
const DIST_MIN = 40, DIST_MAX = 400;
const DIST_GLIDE = 28;              // 滚轮滑行速度 u/s(线性:任意 300ms 窗口位移恒定 ≈ 8.4 单位)
const DIST_RESET_RATE = 6.0;        // reset 回收速率(指数,1s 内从任意距离收敛到 120±0.3)
const PAR_MAX = 0.06;               // 视差最大幅度 = 画布短边的 6%(spec 上限 10%)
const PAR_SMOOTH = 6.0;             // 视差平滑速率 /s(reset 后 0.8s 内衰减 < 0.01)
const FOV_DEG = 45;
const ELEV = (38 * Math.PI) / 180;  // 盘面法线与视线夹角 38° ∈ [30°, 60°]
const BASE_STAR_SIZE = 1.7;         // billboard 满尺寸(世界单位),单星用 s∈(0,1] 缩放
const R_MAX = 56;                   // 星系盘半径(世界单位)
const SEED = 20261005;

const COUNTS = { arms: 24000, disk: 14000, dim: 8000, bulge: 8000, bg: 4000 };
const STAR_COUNT =
    COUNTS.arms + COUNTS.disk + COUNTS.dim + COUNTS.bulge + COUNTS.bg;

/* ---------------------------------------------------------------------------
 * 运行状态与 __bench 契约
 * ------------------------------------------------------------------------- */
const st = {
    phase: 0,            // rotationPhase(rad),reset 归零,随时间单调递增
    dist: DIST0,         // 当前(平滑后的)相机距离
    targetDist: DIST0,
    resetGlide: false,   // reset 回收模式(指数快收敛);滚轮输入即解除
    parX: 0, parY: 0,    // 当前(平滑后的)视差偏移,画布比例
    targetParX: 0, targetParY: 0,
    fps: 0,              // 最近 2s 滚动平均
    epoch: 0,            // reset 计数
};

let galaxyNode = null;   // 星系根节点(绕 +Y 旋转)

function doReset() {
    st.epoch += 1;
    st.phase = 0;                    // 相位立即归零(1s 内完成,0.8s 后 < 0.1)
    st.targetDist = DIST0;           // 距离:reset 走指数快回收(<1s),视差走平滑
    st.resetGlide = true;
    st.targetParX = 0;
    st.targetParY = 0;
    if (galaxyNode && galaxyNode.isValid) {
        galaxyNode.setRotationFromEuler(0, 0, 0);
    }
}

window.__appReady = false;
window.__bench = {
    getState: () => ({
        starCount: STAR_COUNT,               // == 真实提交渲染的星点数(逐星生成,无重复图元)
        rotationPhase: st.phase,
        cameraDistance: st.dist,
        parallaxOffset: { x: st.parX, y: st.parY },
        fps: Math.round(st.fps),
        hudVisible: hudRoot !== null && hudRoot.style.display !== 'none',
        epoch: st.epoch,
    }),
    reset: doReset,
};

/* ---------------------------------------------------------------------------
 * HUD(2D 覆盖层,角落布置,不遮挡中央星系)
 * ------------------------------------------------------------------------- */
let hudRoot = null;
let hudStarsEl = null, hudFpsEl = null, hudDistEl = null, hudPhaseEl = null;

function buildHud() {
    hudRoot = document.createElement('div');
    hudRoot.setAttribute('data-ui', 'hud');
    hudRoot.setAttribute('aria-label', 'HUD');
    hudRoot.style.cssText =
        'position:fixed;top:8px;left:8px;z-index:9998;padding:8px 12px;' +
        'font:12px/1.7 Consolas,Menlo,monospace;color:#e8ecff;text-align:left;' +
        'background:rgba(2,4,10,0.55);border:1px solid rgba(120,140,220,0.35);' +
        'border-radius:6px;pointer-events:none;user-select:none;';

    const mk = (label, value) => {
        const line = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        name.style.cssText = 'opacity:0.75;';
        const val = document.createElement('span');
        val.textContent = value;
        val.style.cssText = 'font-weight:bold;margin-left:8px;';
        line.appendChild(name);
        line.appendChild(val);
        hudRoot.appendChild(line);
        return val;
    };
    hudStarsEl = mk('Stars:', String(STAR_COUNT));
    hudFpsEl = mk('FPS:', '0');
    hudDistEl = mk('Distance:', DIST0.toFixed(1));
    hudPhaseEl = mk('Phase:', '0.000');
    document.body.appendChild(hudRoot);

    // Reset 控件(spec 第 4 节冻结:可见文本/aria-label = reset)
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:5px 14px;' +
        "font:13px sans-serif;background:#141a2e;color:#dfe6ff;border:1px solid #5a6cae;" +
        'border-radius:5px;cursor:pointer;';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
}

let hudAcc = 0;
function hudUpdate(dt) {
    hudAcc += dt;
    if (hudAcc < 0.1) return;   // HUD 数字 10Hz 刷新即可,仍来自真实运行数据
    hudAcc = 0;
    if (!hudFpsEl) return;
    hudFpsEl.textContent = String(Math.round(st.fps));
    hudDistEl.textContent = st.dist.toFixed(1);
    hudPhaseEl.textContent = st.phase.toFixed(3);
}

/* ---------------------------------------------------------------------------
 * 输入(window 捕获阶段:pal 层会吞 canvas 层事件,window capture 必然先触发)
 * ------------------------------------------------------------------------- */
function bindInput() {
    window.addEventListener(
        'pointermove',
        (e) => {
            const nx = (e.clientX / window.innerWidth - 0.5) * 2;    // 有符号,-1..1
            const ny = -(e.clientY / window.innerHeight - 0.5) * 2;  // 屏幕向上为正
            st.targetParX = Math.max(-1, Math.min(1, nx)) * PAR_MAX;
            st.targetParY = Math.max(-1, Math.min(1, ny)) * PAR_MAX;
        },
        { capture: true, passive: true },
    );
    window.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            st.resetGlide = false;       // 用户滚轮接管,解除 reset 回收模式
            const d = e.deltaY * 0.06;   // 单格滚轮 ±6 单位;-600 → 36 单位
            st.targetDist = Math.max(DIST_MIN, Math.min(DIST_MAX, st.targetDist + d));
        },
        { capture: true, passive: false },
    );
}

/* ---------------------------------------------------------------------------
 * 程序化星体辉光纹理(运行时生成,无外部资源)
 * ------------------------------------------------------------------------- */
function makeGlowTexture() {
    const N = 64;
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const dx = (x + 0.5) / N - 0.5;
            const dy = (y + 0.5) / N - 0.5;
            const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
            const t = 1 - r;                        // 中心 1 → 边缘 0
            const i = Math.round(255 * t * t);      // 平方衰减(叠加混合的 SRC_COLOR 因子再平方 → 尖核柔晕)
            const o = (y * N + x) * 4;
            data[o] = i;
            data[o + 1] = i;
            data[o + 2] = i;
            data[o + 3] = 255;
        }
    }
    const tex = new Texture2D();
    tex.create(N, N);           // RGBA8888,单 mip
    tex.uploadData(data);
    return tex;
}

/* ---------------------------------------------------------------------------
 * 星星材质(builtin-billboard / technique "add")
 * ------------------------------------------------------------------------- */
function makeStarMaterial(glowTex) {
    const mtl = new Material();
    mtl.initialize({ effectName: 'builtin-billboard' });
    mtl.setProperty('mainTexture', glowTex);
    mtl.setProperty('tintColor', new Vec4(1, 1, 1, 1));
    // cc_size_rotation = billboard 满尺寸(x,y)与屏幕内旋转(z);必须给 Vec4 实例(FLOAT4)
    const sizeVec = () => new Vec4(BASE_STAR_SIZE, BASE_STAR_SIZE, 0, 0);
    mtl.setProperty('cc_size_rotation', sizeVec());
    const pass = mtl.passes && mtl.passes[0];
    if (pass && typeof pass.getHandle === 'function') {
        const h = pass.getHandle('cc_size_rotation');
        if (h) pass.setUniform(h, sizeVec());   // 双保险:直接写 pass uniform
    }
    return mtl;
}

/* ---------------------------------------------------------------------------
 * 程序化星系几何(每星 4 顶点 + 6 索引,TRIANGLE_LIST)
 *   位置 = 星心;texCoord = [0.5-0.5s, 0.5+0.5s](居中缩放 → 尺寸 s×BASE,采样辉光中心区);
 *   color = RGBA32F 线性值(>1 允许,加法混合下自然白热)。
 * ------------------------------------------------------------------------- */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildGalaxyGeometry() {
    const rand = mulberry32(SEED);
    const gauss = () => {
        let u = 0, v = 0;
        while (u === 0) u = rand();
        while (v === 0) v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    const galaxyTotal = COUNTS.arms + COUNTS.disk + COUNTS.dim + COUNTS.bulge;
    const pos = new Float32Array(galaxyTotal * 12);
    const uv = new Float32Array(galaxyTotal * 8);
    const col = new Float32Array(galaxyTotal * 16);
    const idx = new Array(galaxyTotal * 6);
    let vi = 0;

    function star(x, y, z, s, r, g, b) {
        const p0 = vi * 12, u0 = vi * 8, c0 = vi * 16, i0 = vi * 6;
        for (let k = 0; k < 4; k++) {
            pos[p0 + k * 3] = x;
            pos[p0 + k * 3 + 1] = y;
            pos[p0 + k * 3 + 2] = z;
            col[c0 + k * 4] = r;
            col[c0 + k * 4 + 1] = g;
            col[c0 + k * 4 + 2] = b;
            col[c0 + k * 4 + 3] = 1;
        }
        const lo = 0.5 - 0.5 * s, hi = 0.5 + 0.5 * s;
        uv[u0] = lo; uv[u0 + 1] = lo;
        uv[u0 + 2] = hi; uv[u0 + 3] = lo;
        uv[u0 + 4] = hi; uv[u0 + 5] = hi;
        uv[u0 + 6] = lo; uv[u0 + 7] = hi;
        idx[i0] = vi; idx[i0 + 1] = vi + 1; idx[i0 + 2] = vi + 2;
        idx[i0 + 3] = vi; idx[i0 + 4] = vi + 2; idx[i0 + 5] = vi + 3;
        vi += 4;   // 每星占 4 个顶点槽(此前 +1 会让四边形索引跨到相邻星心,渲染成长条)
    }

    const lerp = (a, b, t) => a + (b - a) * t;
    // 半径梯度:核暖黄白 → 中段蓝白 → 外缘冷蓝(spec 视觉方向)
    const C_CORE = [1.0, 0.9, 0.7], C_MID = [0.88, 0.92, 1.0], C_RIM = [0.55, 0.72, 1.0];
    function diskColor(rNorm, bright) {
        let c;
        if (rNorm < 0.35) {
            const t = rNorm / 0.35;
            c = [lerp(C_CORE[0], C_MID[0], t), lerp(C_CORE[1], C_MID[1], t), lerp(C_CORE[2], C_MID[2], t)];
        } else {
            const t = (rNorm - 0.35) / 0.65;
            c = [lerp(C_MID[0], C_RIM[0], t), lerp(C_MID[1], C_RIM[1], t), lerp(C_MID[2], C_RIM[2], t)];
        }
        return [c[0] * bright, c[1] * bright, c[2] * bright];
    }

    // --- 1) 对数螺旋旋臂(2 主臂):r = R0·e^(B·θ),散布随半径增大 ---
    {
        const R0 = 5, B = Math.log(R_MAX / R0) / 10, THETA_MAX = 10;
        const perArm = Math.floor(COUNTS.arms / 2);
        for (let arm = 0; arm < 2; arm++) {
            const phase = arm * Math.PI;
            for (let i = 0; i < perArm; i++) {
                const t = Math.pow(rand(), 0.75);            // 内密外疏
                const u = t * THETA_MAX;
                let r = R0 * Math.exp(B * u);
                r *= 1 + gauss() * 0.06;                     // 半径抖动
                const spread = 0.1 + 0.3 * t;                // 角向散布随半径增大
                const phi = u + phase + gauss() * spread;
                const thick = 0.6 + 1.8 * Math.exp(-r / 16); // 中央隆起 + 外缘变薄
                const y = gauss() * thick;
                const x = r * Math.cos(phi);
                const z = r * Math.sin(phi);
                const rNorm = Math.min(1, r / R_MAX);
                let c;
                if (rand() < 0.02) {                          // 少量橙红亮星
                    const b2 = 0.8 + 0.4 * rand();
                    c = [1.0 * b2, 0.5 * b2, 0.28 * b2];
                } else {
                    c = diskColor(rNorm, 0.55 + 0.45 * rand());
                }
                const s = 0.15 + 0.35 * rand() * rand();
                star(x, y, z, s, c[0], c[1], c[2]);
            }
        }
    }

    // --- 2) 盘面随机散布星(旋臂之间的场星)---
    for (let i = 0; i < COUNTS.disk; i++) {
        const r = R_MAX * Math.pow(rand(), 0.7);
        const phi = rand() * Math.PI * 2;
        const y = gauss() * (0.5 + 1.4 * Math.exp(-r / 14));
        const rNorm = Math.min(1, r / R_MAX);
        const c = diskColor(rNorm, 0.35 + 0.4 * rand());
        const s = 0.12 + 0.22 * rand();
        star(r * Math.cos(phi), y, r * Math.sin(phi), s, c[0], c[1], c[2]);
    }

    // --- 3) 暗弱背景盘星(第三档亮暗层级)---
    for (let i = 0; i < COUNTS.dim; i++) {
        const r = R_MAX * Math.pow(rand(), 0.6);
        const phi = rand() * Math.PI * 2;
        const y = gauss() * (0.4 + 1.0 * Math.exp(-r / 12));
        const rNorm = Math.min(1, r / R_MAX);
        const c = diskColor(rNorm, 0.1 + 0.16 * rand());
        const s = 0.07 + 0.1 * rand();
        star(r * Math.cos(phi), y, r * Math.sin(phi), s, c[0], c[1], c[2]);
    }

    // --- 4) 核球(中央明亮聚集,计入星点总数)---
    for (let i = 0; i < COUNTS.bulge; i++) {
        const inner = i < 1600;   // 最内圈热核
        const r = Math.min(15, Math.abs(gauss()) * (inner ? 1.6 : 4.6) + rand() * 1.2);
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(2 * rand() - 1);
        const x = r * Math.sin(ph) * Math.cos(th);
        const z = r * Math.sin(ph) * Math.sin(th);
        const y = r * Math.cos(ph) * 0.55;   // 扁椭球
        const b2 = inner ? 1.3 + 0.7 * rand() : 0.7 + 0.5 * rand();
        const warm = 0.92 + 0.08 * rand();
        star(x, y, z, inner ? 0.5 + 0.5 * rand() : 0.3 + 0.4 * rand(),
            1.0 * b2, warm * b2 * 0.96, 0.72 * b2 * warm);
    }

    const geo = {
        positions: pos,
        uvs: uv,
        colors: col,
        indices: idx,
        minPos: { x: -R_MAX, y: -10, z: -R_MAX },
        maxPos: { x: R_MAX, y: 10, z: R_MAX },
        boundingRadius: R_MAX + 4,
    };
    if (vi !== galaxyTotal * 4) throw new Error('galaxy vertex count mismatch: ' + vi);
    return geo;
}

function buildBackgroundGeometry() {
    const rand = mulberry32(SEED + 1);
    const n = COUNTS.bg;
    const pos = new Float32Array(n * 12);
    const uv = new Float32Array(n * 8);
    const col = new Float32Array(n * 16);
    const idx = new Array(n * 6);
    let vi = 0;
    for (let i = 0; i < n; i++) {
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(2 * rand() - 1);
        const r = 260 + 300 * rand();
        const x = r * Math.sin(ph) * Math.cos(th);
        const y = r * Math.cos(ph);
        const z = r * Math.sin(ph) * Math.sin(th);
        const b2 = 0.25 + 0.5 * rand() * rand();
        const p0 = vi * 12, u0 = vi * 8, c0 = vi * 16, i0 = vi * 6;
        for (let k = 0; k < 4; k++) {
            pos[p0 + k * 3] = x; pos[p0 + k * 3 + 1] = y; pos[p0 + k * 3 + 2] = z;
            col[c0 + k * 4] = 0.75 * b2; col[c0 + k * 4 + 1] = 0.82 * b2; col[c0 + k * 4 + 2] = 1.0 * b2;
            col[c0 + k * 4 + 3] = 1;
        }
        const s = 0.35 + 0.5 * rand();
        const lo = 0.5 - 0.5 * s, hi = 0.5 + 0.5 * s;
        uv[u0] = lo; uv[u0 + 1] = lo;
        uv[u0 + 2] = hi; uv[u0 + 3] = lo;
        uv[u0 + 4] = hi; uv[u0 + 5] = hi;
        uv[u0 + 6] = lo; uv[u0 + 7] = hi;
        idx[i0] = vi; idx[i0 + 1] = vi + 1; idx[i0 + 2] = vi + 2;
        idx[i0 + 3] = vi; idx[i0 + 4] = vi + 2; idx[i0 + 5] = vi + 3;
        vi += 4;   // 同 galaxy:每星 4 顶点
    }
    return {
        positions: pos,
        uvs: uv,
        colors: col,
        indices: idx,
        minPos: { x: -560, y: -560, z: -560 },
        maxPos: { x: 560, y: 560, z: 560 },
        boundingRadius: 575,
    };
}

/* ---------------------------------------------------------------------------
 * 每帧控制器:旋转 / 距离平滑 / 视差 / 相机位姿 / HUD / fps(渲染帧口径)
 * ------------------------------------------------------------------------- */
const ORIGIN = new Vec3(0, 0, 0);
class CruiseController extends Component {
    update(dt) {
        if (!(dt > 0)) return;
        if (dt > 0.1) dt = 0.1;   // 后台节流恢复不跳变,相位仍单调

        // 1) 星系慢旋(绕盘面法线 +Y;euler 角为度)
        st.phase += ROT_SPEED * dt;
        if (galaxyNode && galaxyNode.isValid) {
            galaxyNode.setRotationFromEuler(0, (st.phase * 180) / Math.PI, 0);
        }

        // 2) 滚轮距离:线性滑行(逐帧插值,不瞬跳);reset 走指数快回收
        const gap = st.targetDist - st.dist;
        if (Math.abs(gap) < (st.resetGlide ? 0.3 : 0.5)) {
            st.dist = st.targetDist;
            st.resetGlide = false;
        } else if (st.resetGlide) {
            st.dist += gap * (1 - Math.exp(-DIST_RESET_RATE * dt));
        } else {
            st.dist += Math.sign(gap) * Math.min(Math.abs(gap), DIST_GLIDE * dt);
        }

        // 3) 指针视差:小幅平滑,无过冲
        const k = 1 - Math.exp(-PAR_SMOOTH * dt);
        st.parX += (st.targetParX - st.parX) * k;
        st.parY += (st.targetParY - st.parY) * k;

        // 4) 相机位姿:固定仰角 38°、方位 0°,视线指向原点;视差沿视线右/上方向横移
        const sinE = Math.sin(ELEV), cosE = Math.cos(ELEV);
        const span = 2 * st.dist * Math.tan((FOV_DEG * Math.PI) / 360); // 视口高(世界)
        const ox = st.parX * span, oy = st.parY * span;
        // right = (1,0,0);upv = cross(right, forward) = (0, cosE, -sinE)
        this.node.setPosition(new Vec3(
            ox,
            sinE * st.dist + cosE * oy,
            cosE * st.dist - sinE * oy,
        ));
        this.node.lookAt(ORIGIN);

        // 5) HUD 刷新(数值全部来自真实运行状态)
        hudUpdate(dt);
    }
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E01-galaxy');

    // --- 相机(引擎 4.0-alpha 默认 visibility 为 undefined,必须显式设置)---
    const cameraNode = new Node('Main Camera');
    cameraNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(cameraNode);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = FOV_DEG;
    camera.near = 0.5;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(4, 5, 10, 255);   // 接近纯黑的深空色(暗于 RGB 16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    cameraNode.setPosition(new Vec3(0, Math.sin(ELEV) * DIST0, Math.cos(ELEV) * DIST0));
    cameraNode.lookAt(ORIGIN);
    cameraNode.addComponent(CruiseController);

    // --- 材质与网格(批量提交:58,000 星 = 2 个 MeshRenderer / 2 次 draw call)---
    const glowTex = makeGlowTexture();
    const starMtl = makeStarMaterial(glowTex);

    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const galaxyMeshNode = new Node('GalaxyStars');
    galaxyMeshNode.layer = Layers.Enum.DEFAULT;
    galaxyNode.addChild(galaxyMeshNode);
    const galaxyMr = galaxyMeshNode.addComponent(MeshRenderer);
    galaxyMr.mesh = utils.createMesh(buildGalaxyGeometry());
    galaxyMr.material = starMtl;

    const bgNode = new Node('BackgroundStars');   // 远景星层:静态,增强纵深
    bgNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(bgNode);
    const bgMr = bgNode.addComponent(MeshRenderer);
    bgMr.mesh = utils.createMesh(buildBackgroundGeometry());
    bgMr.material = starMtl;

    buildHud();
    bindInput();

    window.__airApp = app;
    app.run(scene);

    // --- 渲染帧计数 + fps(2s 滚动)+ 首帧就绪 ---
    const frameStamps = [];
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        frameStamps.push(now);
        while (frameStamps.length && now - frameStamps[0] > 2000) frameStamps.shift();
        if (frameStamps.length > 5) {
            const el = (now - frameStamps[0]) / 1000;
            if (el > 0) st.fps = (frameStamps.length - 1) / el;
        }
        if (!window.__appReady) {
            window.__appReady = true;   // 首帧渲染完成
        }
    });

    console.log('[e01] deep space galaxy cruise running —', STAR_COUNT, 'stars (cocosair)');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[e01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
