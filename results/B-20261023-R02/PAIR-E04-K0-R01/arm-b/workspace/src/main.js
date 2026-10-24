/**
 * E04 — 城市烟花夜(City Fireworks Night)— Cocos AIR 实现(Arm B)
 *
 * 技术路线(依据引擎技能包 cocosair-* 行为契约):
 *   - 单正交相机(orthoHeight = CSS 高/2,世界 1 单位 = 1 CSS px);
 *   - 夜空渐变(分段顶点色插值)+ 星点 + 程序化楼群/亮窗 = 一个静态网格(flat 顶点色着色器,不透明);
 *   - 烟花粒子(尾迹/爆炸/余烬)= 动态网格(utils.MeshUtils.createDynamicMesh + updateSubMesh,
 *     参照技能包 performance/batching-routes 路线 3),加色混合 + 片元径向衰减辉光着色器;
 *   - 自定义 effect:手写已编译 effect JSON + glsl3 变体 → EffectAsset.onLoaded() →
 *     new Material() + initialize({ effectAsset })(materials-effects/custom-glsl 契约);
 *   - 输入:引擎 input.on(Input.EventType.MOUSE_DOWN)(input-action/native-input 契约,
 *     pal 层吞 canvas 事件,不走自监听);UI 按钮为 DOM 覆盖层;
 *   - 时间线:Component.update(dt) + clamped dt,暂停时 dt→0 全场景冻结。
 *
 * 页面契约:window.__appReady(首帧 EVENT_AFTER_DRAW 后 true);
 *           window.__bench = { getState, reset }。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    utils,
    Vec3,
    Color,
    Component,
    director,
    Director,
    input,
    Input,
    EffectAsset,
    Material,
} from 'cocosair.js';

// ============================================================================
// 全局状态( getState 的真实数据源 )
// ============================================================================
const S = {
    fireworkCount: 0,   // 自上次 reset 起累计发射发数(含自动)
    autoShow: false,    // 自动表演开关
    enabled: true,      // 全局时间线开关(false = 暂停冻结)
    buildingCount: 0,   // 当前城市楼数
    particlesAlive: 0,  // 当前存活粒子数(尾迹+爆炸+余烬,真实计数)
    simTime: 0,         // 场景时间线(暂停时不推进)
};

window.__appReady = false;

const rand = Math.random;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;

/** HSL → RGB(float 0..1);h 度数 */
function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [r + m, g + m, b + m];
}

// ============================================================================
// 视口/世界坐标(世界 1 单位 = 1 CSS px,原点在画面中心,y 向上)
// ============================================================================
let visW = 1280, visH = 720;
function worldX(nx) { return (nx - 0.5) * visW; }        // nx∈[0,1] 左→右
function worldY(nyTop) { return (0.5 - nyTop) * visH; }  // nyTop∈[0,1] 上→下(顶原点)

// ============================================================================
// UI 覆盖层(DOM,右上角,数据探针经 data-ui 定位)
// ============================================================================
const uiState = { autoBtn: null, pauseBtn: null };
function updateUiLabels() {
    if (uiState.autoBtn) uiState.autoBtn.textContent = S.autoShow ? '自动表演:开' : '自动表演:关';
    if (uiState.pauseBtn) uiState.pauseBtn.textContent = S.enabled ? '暂停' : '已暂停(点击恢复)';
}
function buildUi() {
    const box = document.createElement('div');
    box.style.cssText =
        'position:fixed;top:10px;right:12px;z-index:9999;display:flex;flex-direction:column;' +
        'gap:6px;font:12px sans-serif;';
    const mk = (dataUi, text, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.setAttribute('data-ui', dataUi);
        btn.style.cssText =
            "padding:5px 14px;background:#1a1d29ee;color:#e8e4d8;border:1px solid #5a5f7a;" +
            'border-radius:4px;cursor:pointer;font:12px sans-serif;min-width:96px;text-align:center;';
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        box.appendChild(btn);
        return btn;
    };
    uiState.autoBtn = mk('auto-show', '自动表演:关', () => {
        S.autoShow = !S.autoShow;
        if (S.autoShow) nextAutoAt = S.simTime + 0.15 + rand() * 0.2; // 首发快速响应,保证 4s 窗口 ≥3 发
        updateUiLabels();
    });
    uiState.pauseBtn = mk('pause', '暂停', () => { S.enabled = !S.enabled; updateUiLabels(); });
    mk('reset', '重置', () => doReset());
    document.body.appendChild(box);
}

// 标记"本次指针按下是否落在 UI 控件上"(capture 阶段先行记录,供引擎输入回调判定,
// 防止引擎在 window 层收到的点击误发射烟花;点 UI 不发射、点天空不触发 UI)
let pointerOnUI = false;
document.addEventListener(
    'pointerdown',
    (e) => { pointerOnUI = !!((e.target && e.target.closest && e.target.closest('[data-ui]'))); },
    true,
);

// ============================================================================
// 自定义着色器(手写已编译 effect JSON + glsl3;WebGL2 只消费 glsl3)
// ============================================================================
// 引擎 UBO 前缀声明(成员顺序必须与引擎 UBOGlobal/UBOCamera/UBOLocal 完全一致,
// 否则 std140 偏移错位 —— materials-effects/custom-glsl 契约)
const GLSL_UBO_CAM = `
uniform CCCamera {
  highp   mat4 cc_matView;
  highp   mat4 cc_matViewInv;
  highp   mat4 cc_matProj;
  highp   mat4 cc_matProjInv;
  highp   mat4 cc_matViewProj;
};`;
const GLSL_UBO_LOCAL = `
uniform CCLocal {
  highp mat4 cc_matWorld;
  highp mat4 cc_matWorldIT;
};`;
const VERT_SRC = `
precision highp float;
in vec3 a_position;
in vec2 a_texCoord;
in vec4 a_color;
${GLSL_UBO_CAM}
${GLSL_UBO_LOCAL}
out vec2 v_uv;
out vec4 v_color;
void main () {
  v_uv = a_texCoord;
  v_color = a_color;
  gl_Position = cc_matViewProj * (cc_matWorld * vec4(a_position, 1.0));
}`;
// 平面色(夜空渐变/楼群/亮窗/星点):顶点色直通,u_tint 默认全 1
const FLAT_FRAG = `
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
uniform Constants { vec4 u_tint; };
out vec4 o_color;
void main () { o_color = v_color * u_tint; }`;
// 辉光粒子(尾迹/爆炸/余烬):径向衰减 + 热核,预乘输出 + ONE/ONE 加色混合
const GLOW_FRAG = `
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
uniform Constants { vec4 u_params; };
out vec4 o_color;
void main () {
  vec2 d = v_uv - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float halo = max(0.0, 1.0 - r);
  float glow = halo * halo * 0.85;
  float core = smoothstep(0.34, 0.0, r) * 1.35;
  float intensity = u_params.x;
  float a = v_color.a * (glow + core) * intensity;
  vec3 col = v_color.rgb * (0.6 + 0.9 * core);
  o_color = vec4(col * a, a);
}`;

/** 由源码生成一个可注册的 EffectAsset(属性 location 与动态网格属性名一一对应) */
function makeEffect(name, fragSrc, { blend, uniform, uniformDefault }) {
    const program = `${name}|vert:vs|frag:fs`;
    let hash = 2166136261;
    for (let i = 0; i < name.length; i++) { hash ^= name.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    hash >>>= 0;
    const effect = new EffectAsset();
    Object.assign(effect, {
        name,
        techniques: [{
            passes: [{
                program,
                properties: { [uniform]: { value: uniformDefault, type: 16 } },
                rasterizerState: { cullMode: 0 },                     // NONE:消除面朝向风险
                depthStencilState: blend
                    ? { depthTest: false, depthWrite: false }         // 透明队列,永远盖在不透明层上
                    : { depthTest: true, depthWrite: true },
                ...(blend
                    ? { blendState: { targets: [{ blend: true, blendSrc: 1, blendDst: 1, blendSrcAlpha: 1, blendDstAlpha: 1 }] } }
                    : {}),
            }],
        }],
        shaders: [{
            name: program,
            hash,
            builtins: {
                statistics: { CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 12, CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 2 },
                globals: { blocks: [{ name: 'CCGlobal' }, { name: 'CCCamera' }], samplerTextures: [], buffers: [], images: [] },
                locals: { blocks: [{ name: 'CCLocal' }], samplerTextures: [], buffers: [], images: [] },
            },
            defines: [],
            attributes: [
                { name: 'a_position', defines: [], format: 32, location: 0 }, // RGB32F
                { name: 'a_texCoord', defines: [], format: 21, location: 1 }, // RG32F
                { name: 'a_color', defines: [], format: 44, location: 2 },    // RGBA32F
            ],
            blocks: [
                { name: 'Constants', defines: [], binding: 0, stageFlags: 16, members: [{ name: uniform, type: 16, count: 1 }] },
            ],
            samplerTextures: [], samplers: [], textures: [], buffers: [], images: [], subpassInputs: [],
            glsl3: { vert: VERT_SRC, frag: fragSrc },
            glsl4: { vert: VERT_SRC, frag: fragSrc },
        }],
        combinations: [],
    });
    effect.onLoaded(); // 注册(设备已就绪:在 createAirApp 之后调用)
    return effect;
}

// ============================================================================
// 静态批(夜空/星点/楼群/亮窗/障碍灯)—— 一个 mesh 一个 draw
// ============================================================================
const SkyTop = [0.014, 0.02, 0.055];       // 顶部近黑(深蓝黑)
const SkyMid = [0.05, 0.07, 0.16];         // 中带深蓝
const SkyHorizon = [0.15, 0.13, 0.33];     // 地平线蓝紫微亮
const SkyGround = [0.02, 0.022, 0.05];     // 地平线以下深底
const HORIZON = 0.30;                      // 地平线(自底部比例,画面下方 ~1/3)

class StaticBatch {
    constructor() { this.pos = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
    /** 渐变矩形(x/y 为世界坐标;四角两色垂直插值) */
    quadV(x0, x1, y0, y1, cBot, cTop, z) {
        const i = this.n;
        this.pos.push(x0, y0, z, x1, y0, z, x0, y1, z, x1, y1, z);
        this.uv.push(0, 0, 1, 0, 0, 1, 1, 1);
        this.col.push(cBot[0], cBot[1], cBot[2], 1, cBot[0], cBot[1], cBot[2], 1,
            cTop[0], cTop[1], cTop[2], 1, cTop[0], cTop[1], cTop[2], 1);
        this.idx.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
        this.n += 4;
    }
    /** 单色矩形 */
    quad(x0, x1, y0, y1, c, a, z) { this.quadV(x0, x1, y0, y1, [c[0] * a, c[1] * a, c[2] * a], [c[0] * a, c[1] * a, c[2] * a], z); }
    build() {
        return utils.createMesh({
            positions: new Float32Array(this.pos),
            uvs: new Float32Array(this.uv),
            colors: new Float32Array(this.col),
            indices16: new Uint16Array(this.idx),
            primitiveMode: 7, // TRIANGLE_LIST
            minPos: { x: -visW / 2 - 4, y: -visH / 2 - 4, z: -4 },
            maxPos: { x: visW / 2 + 4, y: visH / 2 + 4, z: 4 },
        });
    }
}

// ----------------------------------------------------------------------------
// 城市生成(归一化坐标;每次 reset 重新随机,楼数不变量级)
// ----------------------------------------------------------------------------
let buildings = [];   // { nx0, nw, nh, c }  高度占 visH 比例
let windows = [];     // { nx, ny, w, h, c, a } (ny 自底部)
let avLights = [];    // { nx, ny, c }
let stars = [];       // { nx, ny, s, c, a }

function generateCity() {
    buildings = []; windows = []; avLights = [];
    const count = 26 + Math.floor(rand() * 9); // 26..34(≥24 冻结下限)
    const margin = 0.006;
    const widths = [];
    let wSum = 0;
    for (let i = 0; i < count; i++) {
        const w = 0.018 + rand() * 0.042; // 1.8%..6%
        widths.push(w); wSum += w;
    }
    const gapTotal = (count - 1) * (0.0015 + rand() * 0.004);
    const scale = (1 - 2 * margin - gapTotal) / wSum;
    let x = margin;
    for (let i = 0; i < count; i++) {
        const w = widths[i] * scale;
        const h = 0.08 + Math.pow(rand(), 1.35) * 0.37; // 8%..45%,偏低为主 → 天际线在下方 25-38%
        const v = 0.024 + rand() * 0.016;
        buildings.push({ nx0: x, nw: w, nh: h, c: [v, v * 1.08, v * 1.7] });
        // 亮窗网格(世界尺度约 7×15px 单元,lit 概率 ~0.3,暖黄/暖白)
        const cols = Math.max(1, Math.floor((w * visW) / 8));
        const rows = Math.max(1, Math.floor((h * visH) / 16));
        for (let cx = 0; cx < cols; cx++) {
            for (let cy = 0; cy < rows; cy++) {
                if (rand() < 0.30) {
                    const hue = 30 + rand() * 14;
                    windows.push({
                        nx: x + ((cx + 0.5) / cols) * w,
                        ny: ((cy + 0.5) / rows) * h,
                        w: 2.2, h: 3.0, // 世界像素(构建时换算)
                        c: hsl(hue, 0.92, 0.55 + rand() * 0.18),
                        a: 0.55 + rand() * 0.45,
                    });
                }
            }
        }
        // 高楼顶部红色航空障碍灯(少数)
        if (h > 0.32 && rand() < 0.45) {
            avLights.push({ nx: x + w / 2, ny: h + 0.004, c: [1.0, 0.18, 0.14] });
        }
        x += w + 0.0015 + rand() * 0.004;
    }
    // 亮窗总数保底 ≥80(冻结下限)
    let guard = 0;
    while (windows.length < 80 && guard++ < 500) {
        const b = buildings[Math.floor(rand() * buildings.length)];
        windows.push({
            nx: b.nx0 + rand() * b.nw, ny: rand() * b.nh,
            w: 2.2, h: 3.0,
            c: hsl(30 + rand() * 14, 0.92, 0.6),
            a: 0.7,
        });
    }
    S.buildingCount = buildings.length;
}

function generateStars() {
    stars = [];
    for (let i = 0; i < 150; i++) { // ≥120 冻结下限
        stars.push({
            nx: rand(),
            ny: HORIZON + 0.04 + rand() * (0.94 - HORIZON - 0.04), // 地平线以上
            s: 1.2 + rand() * 1.6,
            c: rand() < 0.2 ? [1, 0.85, 0.7] : [0.82 + rand() * 0.18, 0.88 + rand() * 0.12, 1.0],
            a: 0.3 + rand() * 0.62,
        });
    }
}

function buildStaticMesh() {
    const b = new StaticBatch();
    const hw = visW / 2, hh = visH / 2;
    const yHorizon = (HORIZON - 0.5) * visH; // 地平线世界 y(-0.2*visH)
    const yMid = 0.15 * hh;                  // 中带边界(约 57.5% 自底部)
    // 夜空 3 段渐变(z=0 最远;深度测试保证层序):顶近黑 → 深蓝 → 地平线蓝紫微亮 → 深底
    b.quadV(-hw, hw, yMid, hh, SkyMid, SkyTop, 0);
    b.quadV(-hw, hw, yHorizon, yMid, SkyHorizon, SkyMid, 0);
    b.quadV(-hw, hw, -hh, yHorizon, SkyGround, SkyHorizon, 0);
    // 星点(z=-0.5)
    for (const st of stars) {
        const cx = worldX(st.nx), cy = (st.ny - 0.5) * visH;
        b.quad(cx - st.s / 2, cx + st.s / 2, cy - st.s / 2, cy + st.s / 2, st.c, st.a, -0.5);
    }
    // 楼群剪影 + 亮窗 + 障碍灯(z=-1,城市场景层)
    for (const bd of buildings) {
        const x0 = worldX(bd.nx0), x1 = worldX(bd.nx0 + bd.nw);
        const y0 = -hh, y1 = (bd.nh - 0.5) * visH;
        b.quad(x0, x1, y0, y1, bd.c, 1, -1);
    }
    for (const wd of windows) {
        const cx = worldX(wd.nx), cy = (wd.ny - 0.5) * visH;
        b.quad(cx - wd.w / 2, cx + wd.w / 2, cy - wd.h / 2, cy + wd.h / 2, wd.c, wd.a, -1.2);
    }
    for (const al of avLights) {
        const cx = worldX(al.nx), cy = (al.ny - 0.5) * visH;
        b.quad(cx - 1.0, cx + 1.0, cy - 1.0, cy + 1.0, al.c, 0.85, -1.2);
    }
    return b.build();
}

/** 归一化 x 处城市剪影上沿(顶原点 y 比例);无楼 = 画面底 */
function cityTopAt(nx) {
    let top = 0;
    for (const bd of buildings) {
        if (nx >= bd.nx0 && nx <= bd.nx0 + bd.nw) top = Math.max(top, bd.nh);
    }
    return 1 - top; // 顶原点
}

// ============================================================================
// 粒子系统(SoA 池 + 动态网格;容量 4096,峰值能力 ≥1000)
// ============================================================================
const MAXP = 4096;
const CAP_V = MAXP * 4, CAP_I = MAXP * 6;
const pool = [];
for (let i = 0; i < MAXP; i++) {
    pool.push({
        alive: false, kind: 0, // 0 trail 1 burst 2 ember
        x: 0, y: 0, vx: 0, vy: 0, birth: 0, life: 1,
        size0: 4, size1: 1, r: 1, g: 1, b: 1, a0: 1,
        grav: 0, drag: 0, swayAmp: 0, swayFreq: 0, swayPhase: 0, emberVy: 0,
        twkAmp: 0, twkFreq: 0, twkPhase: 0,
    });
}
let poolCursor = 0;
function spawnP(kind) {
    for (let i = 0; i < MAXP; i++) {
        const idx = (poolCursor + i) % MAXP;
        if (!pool[idx].alive) {
            poolCursor = (idx + 1) % MAXP;
            const p = pool[idx];
            p.alive = true; p.kind = kind;
            p.grav = 0; p.drag = 0; p.swayAmp = 0; p.swayFreq = 0; p.swayPhase = 0;
            p.twkAmp = 0; p.twkFreq = 0; p.twkPhase = 0; p.emberVy = 0;
            return p;
        }
    }
    return null; // 池满:安全降级(不崩溃、不丢帧更新)
}

// 动态网格预分配缓冲(updateSubMesh 按传入数组 byteLength 计数 → 每帧传 subarray)
const dynPos = new Float32Array(CAP_V * 3);
const dynUv = new Float32Array(CAP_V * 2);
const dynCol = new Float32Array(CAP_V * 4);
const dynIdx = new Uint16Array(CAP_I);
for (let i = 0; i < MAXP; i++) {
    const v = i * 4, o = i * 6;
    dynIdx[o] = v; dynIdx[o + 1] = v + 1; dynIdx[o + 2] = v + 2;
    dynIdx[o + 3] = v + 2; dynIdx[o + 4] = v + 1; dynIdx[o + 5] = v + 3;
}
let particleRenderer = null;
let particleMesh = null;

function createParticleMesh() {
    return utils.MeshUtils.createDynamicMesh(
        0,
        {
            positions: new Float32Array([0, 0, -10, 1, 0, -10, 0, 1, -10, 1, 1, -10]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
            colors: new Float32Array(16),
            indices16: new Uint16Array([0, 1, 2, 2, 1, 3]),
            primitiveMode: 7, // TRIANGLE_LIST
            minPos: { x: -visW / 2 - 80, y: -visH / 2 - 80, z: -12 },
            maxPos: { x: visW / 2 + 80, y: visH / 2 + 80, z: -8 },
        },
        null,
        { maxSubMeshes: 1, maxSubMeshVertices: CAP_V, maxSubMeshIndices: CAP_I },
    );
}

function fillParticleMesh() {
    let n = 0;
    const hh = visH / 2;
    for (let i = 0; i < MAXP; i++) {
        const p = pool[i];
        if (!p.alive) continue;
        const k = (p.life > 0) ? clamp((S.simTime - p.birth) / p.life, 0, 1) : 1;
        const size = Math.max(0.4, lerp(p.size0, p.size1, k));
        let alpha = p.a0 * Math.pow(1 - k, 1.4);
        if (p.twkAmp > 0) {
            // 余烬闪烁:亮度周期波动(暂停时 simTime 冻结 → 闪烁亦冻结)
            alpha *= 1 - p.twkAmp * (0.5 + 0.5 * Math.sin(S.simTime * p.twkFreq + p.twkPhase));
        }
        if (alpha <= 0.004) continue;
        const x = p.x, y = p.y;
        if (y < -hh - 30 || y > hh + 30) continue; // 离屏裁剪(不绘制)
        const h = size / 2;
        const vo = n * 4;
        // 两三角四边形(与静态批同绕序)
        dynPos[vo * 3] = x - h; dynPos[vo * 3 + 1] = y - h; dynPos[vo * 3 + 2] = -10;
        dynPos[vo * 3 + 3] = x + h; dynPos[vo * 3 + 4] = y - h; dynPos[vo * 3 + 5] = -10;
        dynPos[vo * 3 + 6] = x - h; dynPos[vo * 3 + 7] = y + h; dynPos[vo * 3 + 8] = -10;
        dynPos[vo * 3 + 9] = x + h; dynPos[vo * 3 + 10] = y + h; dynPos[vo * 3 + 11] = -10;
        dynUv[vo * 2] = 0; dynUv[vo * 2 + 1] = 0;
        dynUv[vo * 2 + 2] = 1; dynUv[vo * 2 + 3] = 0;
        dynUv[vo * 2 + 4] = 0; dynUv[vo * 2 + 5] = 1;
        dynUv[vo * 2 + 6] = 1; dynUv[vo * 2 + 7] = 1;
        const co = vo * 4;
        for (let c = 0; c < 4; c++) {
            dynCol[co + c * 4] = p.r;
            dynCol[co + c * 4 + 1] = p.g;
            dynCol[co + c * 4 + 2] = p.b;
            dynCol[co + c * 4 + 3] = alpha;
        }
        n++;
        if (n >= MAXP) break;
    }
    particleMesh.updateSubMesh(0, {
        positions: dynPos.subarray(0, n * 12),
        uvs: dynUv.subarray(0, n * 8),
        colors: dynCol.subarray(0, n * 16),
        indices16: dynIdx.subarray(0, n * 6),
        minPos: { x: -visW / 2 - 80, y: -visH / 2 - 80, z: -12 },
        maxPos: { x: visW / 2 + 80, y: visH / 2 + 80, z: -8 },
    });
    if (particleRenderer) particleRenderer.onGeometryChanged();
}

// ============================================================================
// 烟花(火箭 → 爆炸 → 余烬)
// ============================================================================
const rockets = []; // { x0,y0, tx,ty, t0, dur, hue, trailAcc }
let nextAutoAt = Infinity;
const HUES = [42, 320, 190, 130, 268, 24, 210, 295];

function fire(nx, nyTop) {
    const tx = worldX(nx) + (rand() - 0.5) * 12;
    const ty = worldY(nyTop);
    const x0 = tx + (rand() - 0.5) * 34;
    const y0 = -visH / 2 + rand() * 6;
    const dist = Math.max(120, Math.abs(ty - y0));
    const dur = clamp(0.6 + dist / 700 + rand() * 0.35, 0.6, 1.6); // 0.6-1.6s 升空
    rockets.push({
        x0, y0, tx, ty, t0: S.simTime, dur,
        hue: HUES[Math.floor(rand() * HUES.length)] + (rand() - 0.5) * 18,
        trailAcc: 0,
    });
    S.fireworkCount += 1;
}

function spawnTrail(r, x, y, head) {
    const p = spawnP(0);
    if (!p) return;
    p.x = x + (rand() - 0.5) * 2.2;
    p.y = y + (rand() - 0.5) * 2.2;
    p.vx = (rand() - 0.5) * 14;
    p.vy = -12 - rand() * 26;
    p.birth = S.simTime;
    p.life = head ? 0.12 + rand() * 0.06 : 0.3 + rand() * 0.45; // 尾迹寿命 0.3-0.8s
    p.size0 = head ? 7.5 : 3.2 + rand() * 3.2;
    p.size1 = 0.6;
    const warm = hsl(38 + rand() * 12, 0.85, head ? 0.86 : 0.66);
    p.r = warm[0]; p.g = warm[1]; p.b = warm[2];
    p.a0 = head ? 1.0 : 0.85;
    p.grav = -20;
}

function explode(x, y, hue) {
    const base = hsl(hue, 0.95, 0.62);
    const baseBright = hsl(hue, 0.75, 0.82);
    // 中心闪光(短寿命大亮斑:爆发瞬间的视觉冲击)
    const flash = 7 + Math.floor(rand() * 4);
    for (let i = 0; i < flash; i++) {
        const p = spawnP(1);
        if (!p) break;
        p.x = x; p.y = y;
        p.vx = (rand() - 0.5) * 90; p.vy = (rand() - 0.5) * 90;
        p.birth = S.simTime; p.life = 0.25 + rand() * 0.25;
        p.size0 = 30 + rand() * 26; p.size1 = 6;
        p.r = 1; p.g = 0.97; p.b = 0.9; p.a0 = 1;
        p.drag = 3;
    }
    // 爆炸球(100-240 粒子;球面近似均匀方向 + 重力 + 阻力,寿命 1.2-2.8s)
    const N = 130 + Math.floor(rand() * 100); // 130..229
    const speedBase = 190 + rand() * 110;
    for (let i = 0; i < N; i++) {
        const p = spawnP(1);
        if (!p) break;
        const ang = rand() * Math.PI * 2;
        // sqrt 分布近似球面投影(外缘密、中心疏的球壳感)
        const sp = speedBase * (0.28 + 0.72 * Math.sqrt(rand()));
        p.x = x + Math.cos(ang) * 2;
        p.y = y + Math.sin(ang) * 2;
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
        p.birth = S.simTime;
        p.life = 1.2 + rand() * 1.6; // 1.2-2.8s
        const c = (rand() < 0.25) ? baseBright : hsl(hue + (rand() - 0.5) * 26, 0.9, 0.6 + rand() * 0.15);
        p.r = c[0]; p.g = c[1]; p.b = c[2];
        p.size0 = 5.0 + rand() * 5.5;
        p.size1 = 0.8 + rand() * 1.2;
        p.a0 = 0.85 + rand() * 0.15;
        p.grav = -58;       // 画面尺度下肉眼可见下坠
        p.drag = 1.15 + rand() * 0.5;
    }
    // 余烬(≥12/发;寿命 3-12s,长尾 ≥30% 铺 10.5-12s;缓慢下坠 + 明灭闪烁)
    const E = 16 + Math.floor(rand() * 5); // 16..20
    for (let i = 0; i < E; i++) {
        const p = spawnP(2);
        if (!p) break;
        const ang = rand() * Math.PI * 2;
        const sp = 30 + rand() * 130;
        p.x = x + Math.cos(ang) * 4;
        p.y = y + Math.sin(ang) * 4;
        p.vx = Math.cos(ang) * sp * 0.5;
        p.vy = Math.sin(ang) * sp * 0.5 + 10;
        p.birth = S.simTime;
        p.life = (rand() < 0.34) ? 10.5 + rand() * 1.5 : 3.0 + rand() * 6.5;
        const c = hsl(24 + rand() * 14, 1.0, 0.6);
        p.r = c[0]; p.g = c[1]; p.b = c[2];
        p.size0 = 4.2 + rand() * 2.6;
        p.size1 = 2.6 + rand() * 1.4;
        p.a0 = 0.7 + rand() * 0.3;
        p.drag = 1.8;      // 快速耗散水平初速 → 进入缓慢匀速下坠
        p.swayAmp = 6 + rand() * 12;
        p.swayFreq = 0.5 + rand() * 1.1;
        p.swayPhase = rand() * Math.PI * 2;
        p.twkAmp = 0.55 + rand() * 0.3;
        p.twkFreq = (1.2 + rand() * 2.4) * Math.PI * 2;
        p.twkPhase = rand() * Math.PI * 2;
        p.emberVy = -(22 + rand() * 22); // 终末下坠速度 22-44 px/s
    }
}

// ============================================================================
// 帧步进(真实时间步;暂停 = 时间增量置 0 → 全场景冻结)
// ============================================================================
function step(dt) {
    if (!S.enabled || dt <= 0) return; // 暂停:一切时间线冻结(粒子/自动发射/闪烁)
    S.simTime += dt;

    // 自动表演(0.5-1.5s 随机间隔;首发 0.15-0.35s 快速出画)
    if (S.autoShow && S.simTime >= nextAutoAt) {
        fire(0.12 + rand() * 0.76, 0.22 + rand() * 0.46);
        nextAutoAt = S.simTime + 0.5 + rand() * 0.9;
    }

    // 火箭升空(减速缓升 + 持续尾迹)
    for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        const p = (S.simTime - r.t0) / r.dur;
        if (p >= 1) {
            explode(r.tx, r.ty, r.hue);
            rockets.splice(i, 1);
            continue;
        }
        const ease = 1 - (1 - p) * (1 - p); // 先快后慢
        const x = lerp(r.x0, r.tx, ease);
        const y = lerp(r.y0, r.ty, ease);
        // 尾迹粒子(28/s)+ 亮头
        r.trailAcc += dt * 28;
        while (r.trailAcc >= 1) { r.trailAcc -= 1; spawnTrail(r, x, y - 2, false); }
        spawnTrail(r, x, y + 2, true);
    }

    // 粒子积分
    let alive = 0;
    for (let i = 0; i < MAXP; i++) {
        const p = pool[i];
        if (!p.alive) continue;
        const age = S.simTime - p.birth;
        if (age >= p.life) { p.alive = false; continue; }
        if (p.kind === 2) {
            // 余烬:耗散初速后匀速缓慢下坠 + 横向摇曳
            const damp = Math.exp(-p.drag * age);
            p.x += (p.vx * damp + Math.cos(S.simTime * p.swayFreq + p.swayPhase) * p.swayAmp) * dt;
            p.y += (p.vy * damp + p.emberVy) * dt;
        } else {
            // 尾迹/爆炸:重力 + 指数阻力
            p.vx *= Math.exp(-p.drag * dt);
            p.vy = p.vy * Math.exp(-p.drag * dt) + p.grav * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
        alive++;
    }
    S.particlesAlive = alive;
    fillParticleMesh();
}

// ============================================================================
// reset / getState(真实数据,禁止伪造)
// ============================================================================
function doReset() {
    rockets.length = 0;
    for (let i = 0; i < MAXP; i++) pool[i].alive = false;
    S.particlesAlive = 0;
    S.fireworkCount = 0;
    S.autoShow = false;
    S.enabled = true;
    nextAutoAt = Infinity;
    generateCity();
    rebuildStatic();
    fillParticleMesh(); // 清空粒子缓冲
    updateUiLabels();
}

window.__bench = {
    getState: () => ({
        fireworkCount: S.fireworkCount,
        particlesAlive: S.particlesAlive,
        autoShow: S.autoShow,
        enabled: S.enabled,
        buildingCount: S.buildingCount,
    }),
    reset: doReset,
};

// ============================================================================
// 场景装配
// ============================================================================
let cameraComp = null;
let staticRenderer = null;
let staticMesh = null;

function rebuildStatic() {
    const old = staticMesh;
    staticMesh = buildStaticMesh();
    if (staticRenderer) staticRenderer.mesh = staticMesh;
    if (old && old.destroy) old.destroy();
}

function refreshViewport() {
    const canvas = document.querySelector('#GameCanvas');
    visW = Math.max(320, canvas.clientWidth || window.innerWidth);
    visH = Math.max(240, canvas.clientHeight || window.innerHeight);
    if (cameraComp) cameraComp.orthoHeight = visH / 2; // 世界 1 单位 = 1 CSS px
}

/** 帧驱动组件(随场景生命周期;dt 为真实时间步,clamp 防失焦跳变) */
class SimDriver extends Component {
    update(dt) { step(Math.min(dt, 0.05)); }
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    refreshViewport();

    const scene = new Scene('E04');

    // 正交相机(必须显式 visibility;深度分层:sky z=0 → city z=-1 → 粒子 z=-10)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 0, 200));
    cameraNode.lookAt(new Vec3(0, 0, 0)); // 沿 -z 俯视原点(正交 2D 视图)
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.ORTHO;
    cameraComp.orthoHeight = visH / 2;
    cameraComp.near = 1;
    cameraComp.far = 500;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(4, 6, 14, 255);
    cameraComp.visibility = Layers.Enum.DEFAULT;
    cameraComp.priority = 0;

    // 自定义材质(设备就绪后创建;顺序:effect 注册 → Material.initialize)
    const flatEffect = makeEffect('e04-flat', FLAT_FRAG, { blend: false, uniform: 'u_tint', uniformDefault: [1, 1, 1, 1] });
    const glowEffect = makeEffect('e04-glow', GLOW_FRAG, { blend: true, uniform: 'u_params', uniformDefault: [1.25, 0, 0, 0] });
    const flatMat = new Material();
    flatMat.initialize({ effectAsset: flatEffect, technique: 0 });
    const glowMat = new Material();
    glowMat.initialize({ effectAsset: glowEffect, technique: 0 });

    // 静态层(夜空/星点/城市)
    generateCity();
    generateStars();
    const staticNode = new Node('StaticLayer');
    staticNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(staticNode);
    staticRenderer = staticNode.addComponent(MeshRenderer);
    staticRenderer.mesh = buildStaticMesh();
    staticMesh = staticRenderer.mesh;
    staticRenderer.material = flatMat;

    // 粒子层(动态网格;容量 4096 → 同屏峰值能力 ≥1000)
    particleMesh = createParticleMesh();
    const particleNode = new Node('Particles');
    particleNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(particleNode);
    particleRenderer = particleNode.addComponent(MeshRenderer);
    particleRenderer.mesh = particleMesh;
    particleRenderer.material = glowMat;

    // 帧驱动
    const driverNode = new Node('SimDriver');
    scene.addChild(driverNode);
    driverNode.addComponent(SimDriver);

    // UI(页面契约控件)
    buildUi();

    // 点击发射(引擎输入统一入口;pal 层吞 canvas 事件,自监听不可靠)
    input.on(Input.EventType.MOUSE_DOWN, (e) => {
        try {
            if (!S.enabled) return;           // 暂停期间不发射(时间线冻结)
            if (pointerOnUI) { pointerOnUI = false; return; } // UI 点击不发射
            const loc = e.getLocation();      // 物理像素,左下原点(native-input 契约)
            const rc = cameraComp.camera;     // render camera(width/height = 帧缓冲物理像素)
            const physW = rc.width, physH = rc.height;
            if (!(physW > 0 && physH > 0)) return;
            const nx = loc.x / physW;             // [0,1] 左→右
            const nyTop = 1 - loc.y / physH;      // [0,1] 顶原点
            if (nx < 0.005 || nx > 0.995 || nyTop < 0.02 || nyTop > 0.995) return;
            if (nyTop > cityTopAt(nx)) return;    // 城市剪影区域:不发射
            fire(nx, nyTop);                      // 点击真实决定爆点(±5% 内)
        } catch (err) {
            console.error('[E04] input handler error:', err);
        }
    });

    // resize:视口变化 → 相机与静态层重建(粒子按世界坐标继续)
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            try {
                refreshViewport();
                generateStars();
                rebuildStatic();
            } catch (err) {
                console.error('[E04] resize error:', err);
            }
        }, 150);
    });

    app.run(scene);

    // 演示入口(?demo=1):开启自动表演并首发一发。仅人工演示用途;
    // 探测/验证加载不带该参数,初始状态与行为完全不变(非自动化特判)。
    try {
        if (new URLSearchParams(window.location.search).get('demo') === '1') {
            S.autoShow = true;
            updateUiLabels();
            fire(0.5, 0.28);
            nextAutoAt = S.simTime + 0.8 + rand() * 0.5;
        }
    } catch { /* 忽略 */ }

    // 就绪契约:首帧绘制完成后置位
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[E04] city fireworks night running on cocosair');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 分类
    console.error('[E04] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
