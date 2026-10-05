/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)· cocosair K0 实现
 *
 * 实现路线(全部程序化,无任何外部资产/纹理):
 *   - 运行时程序化注册自定义 EffectAsset(与引擎 builtin 效果同一注册路径:
 *     new EffectAsset → shaders[] 携带 glsl4 源 + glsl3 转换 → onLoaded() 注册),
 *     两套效果:
 *       bh-disk      吸积盘环面:径向三段色温(白→橙→暗红)+ 旋转条纹 + 螺旋缠绕
 *                    + 多普勒不对称(向相机一侧增亮)+ 内外软边(无硬边)。
 *       bh-billboard 世界空间面片:星点/星流拖尾/辉光环/星云/黑体视界圆盘
 *                    (per-vertex a_tangent.x 选模式),加色混合 + 一枚不透明技术画黑核。
 *   - 星流 220 粒子:动态网格(utils.MeshUtils.createDynamicMesh + updateSubMesh)
 *     CPU 端逐帧重建拖尾四边形,螺旋内落、近视界加速拉长、吞噬后外圈重生(总数恒定)。
 *   - 相机滚轮缩放:wheel capture 监听(canvas 事件被 pal 层吞,须捕获监听),
 *     目标距离夹在 [5,28],指数平滑插值。
 *
 * 页面契约: __appReady(首帧后 true) + __bench{getState,reset} + data-ui="reset" 按钮。
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
    Vec4,
    Color,
    Component,
    director,
    Director,
    EffectAsset,
    Material,
} from 'cocosair.js';

// ============================== 常量(场景尺度:见 brief §2) ==============================
const HORIZON_R = 1.2;        // 事件视界半径
const DISK_INNER = 1.8;       // 吸积盘内缘
const DISK_OUTER = 6.5;       // 吸积盘外缘
const CAM_DIST_INIT = 14.0;   // 初始相机距离
const CAM_DIST_MIN = 5.0;
const CAM_DIST_MAX = 28.0;
const CAM_PITCH = 62 * Math.PI / 180; // 俯仰角(15°-75° 之间)
const CAM_FOV = 65;           // 初始视角下暗核直径约占短边 ~13.5%(8%-15% 内)
const DISK_SPIN = 0.35;       // 盘角速度 rad/s(0.15-0.6)
const STAR_COUNT = 460;       // 背景星(>=300)
const STREAM_COUNT = 220;     // 星流粒子(>=200,恒定)
const WHEEL_UNIT = 0.009;     // wheel dy → 距离增量(-600 → -5.4,落入 [5,10))

// ============================== 状态通道 ==============================
const state = {
    frame: 0,
    diskRotation: 0,        // 累计旋转弧度,自上次 reset 起,单调递增
    accretionPhase: 0,      // 条纹归一化相位 [0,1)
    camDistTarget: CAM_DIST_INIT,
    camDistCurrent: CAM_DIST_INIT,
    resetCount: 0,
};
window.__appReady = false;

// 诊断:捕获 console.error 文本(只读诊断用途,不改变行为)
window.__errs = [];
{
    const origError = console.error.bind(console);
    console.error = (...args) => {
        try {
            window.__errs.push(args.map((a) => String((a && a.message) || a)).join(' ').slice(0, 240));
            if (window.__errs.length > 40) window.__errs.shift();
        } catch (e) { /* 忽略 */ }
        origError(...args);
    };
}

// ============================== GLSL 源(glsl4 风格,注册时转 glsl3) ==============================
// CCCamera 块成员顺序 = 引擎 UBO 布局(std140),与 builtin 着色器逐字一致。
const CC_CAMERA_BLOCK = `
layout(set = 0, binding = 1) uniform CCCamera {
highp   mat4 cc_matView;
highp   mat4 cc_matViewInv;
highp   mat4 cc_matProj;
highp   mat4 cc_matProjInv;
highp   mat4 cc_matViewProj;
highp   mat4 cc_matViewProjInv;
highp   vec4 cc_cameraPos;
mediump vec4 cc_surfaceTransform;
mediump vec4 cc_screenScale;
mediump vec4 cc_exposure;
mediump vec4 cc_mainLitDir;
mediump vec4 cc_mainLitColor;
mediump vec4 cc_ambientSky;
mediump vec4 cc_ambientGround;
mediump vec4 cc_fogColor;
mediump vec4 cc_fogBase;
mediump vec4 cc_fogAdd;
mediump vec4 cc_nearFar;
mediump vec4 cc_viewPort;
};`;

const CC_LOCAL_BLOCK = `
layout(set = 2, binding = 0) uniform CCLocal {
highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;
};`;

// ---- bh-disk:吸积盘(a_position: 环面局部坐标 XZ;a_texCoord: (u 径向 0..1, v 方位 0..1)) ----
const DISK_VERT = `
precision highp float;
${CC_CAMERA_BLOCK}
${CC_LOCAL_BLOCK}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_texCoord;
layout(location = 0) out mediump vec2 v_uv;
layout(location = 1) out mediump vec3 v_world;
void main() {
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  v_world = wp.xyz;
  v_uv = a_texCoord;
  gl_Position = cc_matViewProj * wp;
}`;

const DISK_FRAG = `
precision mediump float;
${CC_CAMERA_BLOCK}
layout(set = 1, binding = 0) uniform Constants {
vec4 diskParams;  // (time, doppler, unused, unused)
vec4 colHot;      // 内缘 白亮
vec4 colMid;      // 中带 亮橙
vec4 colCool;     // 外缘 暗红
};
layout(location = 0) in mediump vec2 v_uv;
layout(location = 1) in mediump vec3 v_world;
layout(location = 0) out vec4 fragColor;
void main() {
  float u = v_uv.x;
  vec3 col = mix(colHot.rgb, colMid.rgb, smoothstep(0.05, 0.40, u));
  col = mix(col, colCool.rgb, smoothstep(0.38, 0.86, u));
  float I = mix(1.55, 0.22, pow(u, 0.72));
  // 旋转条纹:明暗相间辐条 + 缓螺旋缠绕(v 随网格旋转 → 与 diskRotation 同步)
  float sp1 = sin(6.2831853 * (v_uv.y * 10.0 + u * 0.6));
  float sp2 = sin(6.2831853 * (v_uv.y * 6.0 - u * 0.45) + 1.7);
  float stripes = 0.80 + 0.20 * sp1 + 0.08 * sp2;
  stripes *= 1.0 + 0.06 * sin(6.2831853 * v_uv.y * 23.0 + u * 13.0);
  // 多普勒不对称:切向(逆时针)朝向相机的一侧增亮
  vec3 rel = normalize(v_world);
  vec3 tangent = normalize(vec3(rel.z, 0.0, -rel.x));
  vec3 toCam = normalize(cc_cameraPos.xyz - v_world);
  float dop = clamp(dot(tangent, toCam), -1.0, 1.0);
  float doppler = 1.0 + diskParams.y * dop;
  // 内外软边(辉光过渡,无硬边)
  float eIn = smoothstep(0.0, 0.07, u);
  float eOut = 1.0 - smoothstep(0.78, 1.0, u);
  vec3 c = col * I * stripes * doppler * eIn * eOut;
  fragColor = vec4(c, clamp(max(max(c.r, c.g), c.b), 0.0, 1.0));
}`;

// ---- bh-billboard:世界空间面片(a_position 已是最终世界坐标;CPU 端完成公告板/拉伸) ----
const BB_VERT = `
precision highp float;
${CC_CAMERA_BLOCK}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_texCoord;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_tangent; // (mode, intensity, ringR, ringW)
layout(location = 0) out mediump vec2 v_uv;
layout(location = 1) out mediump vec4 v_color;
layout(location = 2) out mediump vec4 v_data;
void main() {
  v_uv = a_texCoord;
  v_color = a_color;
  v_data = a_tangent;
  gl_Position = cc_matViewProj * vec4(a_position, 1.0);
}`;

const BB_FRAG = `
precision mediump float;
layout(set = 1, binding = 0) uniform Constants {
vec4 bbParams; // (全局强度, -, -, -)
};
layout(location = 0) in mediump vec2 v_uv;
layout(location = 1) in mediump vec4 v_color;
layout(location = 2) in mediump vec4 v_data;
layout(location = 0) out vec4 fragColor;
void main() {
  float mode = v_data.x;
  vec2 uv = v_uv;
  float a;
  if (mode < 0.5) {
    // 星点:亮核 + 柔和光晕
    float d = length(uv - 0.5) * 2.0;
    float core = smoothstep(0.35, 0.0, d);
    float halo = pow(max(1.0 - d, 0.0), 2.6);
    a = core * 0.85 + halo * 0.55;
  } else if (mode < 1.5) {
    // 星流拖尾:x 横向衰减,y 沿长度向尾部衰减(v=1 为头部)
    float wx = abs(uv.x - 0.5) * 2.0;
    float head = pow(clamp(uv.y, 0.0, 1.0), 1.6);
    a = pow(max(1.0 - wx, 0.0), 1.7) * head;
  } else if (mode < 2.5) {
    // 光子环/透镜光环:exp 高斯环,顶部略亮(包绕感)
    float d = length(uv - 0.5) * 2.0;
    float t = (d - v_data.z) / max(v_data.w, 0.001);
    a = exp(-t * t);
    a *= 1.0 + 0.45 * clamp((uv.y - 0.5) * 2.0, 0.0, 1.0);
  } else {
    // 星云/柔光:大尺度径向衰减(较平缓,保证四角外围柔和抬亮)
    float d = length(uv - 0.5) * 2.0;
    a = pow(max(1.0 - d, 0.0), 1.25);
  }
  vec3 c = v_color.rgb * v_data.y * a * bbParams.x;
  fragColor = vec4(c, clamp(max(max(c.r, c.g), c.b), 0.0, 1.0));
}`;

// ---- 黑体视界圆盘(不透明技术:锐利黑核) ----
const DISC_FRAG = `
precision mediump float;
layout(location = 0) in mediump vec2 v_uv;
layout(location = 1) in mediump vec4 v_color;
layout(location = 2) in mediump vec4 v_data;
layout(location = 0) out vec4 fragColor;
void main() {
  float d = length(v_uv - 0.5) * 2.0;
  if (d > 1.0) { discard; }
  fragColor = vec4(0.003, 0.002, 0.002, 1.0); // 近纯黑,边缘锐利
}`;

// ============================== 效果注册(与 builtin 同路径) ==============================
// glsl4 → glsl3 的转换与引擎内置实现逐字等价(去 extension / 去 layout(std140) 以外限定)
function toGlsl3(src) {
    return src
        .replace(/#extension[^\n]*\n/g, '')
        .replace(/layout\s*\(([^)]*)\)\s*/g, (m, inner) => (inner.indexOf('std140') !== -1 ? 'layout(std140) ' : ''))
        .replace(/\bu32vec([234])\b/g, 'vec$1');
}

let SHADER_SEQ = 1;
// MAT4=25, FLOAT4=16(gfx.Type);CCLocal 成员布局与引擎 UBO 一致(std140)
const CC_LOCAL_FULL = {
    name: 'CCLocal', stageFlags: 1, members: [
        { name: 'cc_matWorld', type: 25, count: 1 },
        { name: 'cc_matWorldIT', type: 25, count: 1 },
        { name: 'cc_lightingMapUVParam', type: 16, count: 1 },
        { name: 'cc_localShadowBias', type: 16, count: 1 },
    ],
};
function registerEffect(name, techniques, shaderDefs) {
    const effect = new EffectAsset(name);
    effect.techniques = techniques;
    effect.shaders = shaderDefs.map((def) => {
        const materialFull = def.blocks.map((b) => ({ name: b.name, stageFlags: b.stageFlags, members: b.members }));
        const localsFull = def.localsBlocks.length ? [CC_LOCAL_FULL] : [];
        const emptySet = { blocks: [], samplerTextures: [], buffers: [], images: [], textures: [], samplers: [], subpassInputs: [] };
        return {
            name: def.name,
            hash: (SHADER_SEQ++) * 2654435761 % 4294967291,
            glsl4: { vert: def.vert, frag: def.frag },
            glsl3: { vert: toGlsl3(def.vert), frag: toGlsl3(def.frag) },
            glsl1: { vert: toGlsl3(def.vert), frag: toGlsl3(def.frag) },
            builtins: {
                statistics: {
                    CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 64,
                    CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 46,
                },
                globals: {
                    blocks: def.globalsBlocks,
                    samplerTextures: [],
                    buffers: [],
                    images: [],
                },
                locals: {
                    blocks: def.localsBlocks,
                    samplerTextures: [],
                    buffers: [],
                    images: [],
                },
            },
            defines: [
                { name: 'USE_INSTANCING', type: 'boolean' },
                { name: 'USE_BATCHING', type: 'boolean' },
            ],
            attributes: def.attributes,
            blocks: def.blocks,
            samplerTextures: [],
            buffers: [],
            images: [],
            textures: [],
            samplers: [],
            subpassInputs: [],
            // 导入路径必需:按 UpdateFrequency 分组([0]=PER_INSTANCE 本地集,[1]=PER_BATCH 材质集)
            descriptors: [
                Object.assign({}, emptySet, { blocks: localsFull }),
                Object.assign({}, emptySet, { blocks: materialFull }),
                Object.assign({}, emptySet),
                Object.assign({}, emptySet),
            ],
        };
    });
    effect.combinations = [];
    effect.hideInEditor = true;
    effect.onLoaded(); // 注册进 programLib + EffectAsset 名字表(与 builtin 注册路径一致)
    return effect;
}

const ATTRS_BB = [
    { name: 'a_position', defines: [], format: 32, location: 0 },
    { name: 'a_texCoord', defines: [], format: 21, location: 1 },
    { name: 'a_color', defines: [], format: 44, location: 2 },
    { name: 'a_tangent', defines: [], format: 44, location: 3 },
];
const ATTRS_DISK = [
    { name: 'a_position', defines: [], format: 32, location: 0 },
    { name: 'a_texCoord', defines: [], format: 21, location: 1 },
];

// 加色混合 pass 形状取自 builtin-billboard "add" 技术(SRC_ALPHA, ONE)
const ADD_BLEND = {
    rasterizerState: { cullMode: 0 },
    blendState: { targets: [{ blend: true, blendSrc: 2, blendDst: 1, blendSrcAlpha: 2, blendDstAlpha: 1 }] },
    depthStencilState: { depthTest: true, depthWrite: false },
};

let fxBillboard = null;
let fxDisk = null;

function registerCustomEffects() {
    const camOnly = [{ name: 'CCCamera', set: 0, binding: 1, defines: [] }];
    const localCCLocal = [{ name: 'CCLocal', set: 2, binding: 0, defines: ['!USE_INSTANCING', '!USE_BATCHING'] }];

    fxBillboard = registerEffect(
        'bh-billboard',
        [
            { name: 'add', passes: [Object.assign({}, ADD_BLEND, {
                program: 'bh-bb|vs|fs-add',
                properties: { bbParams: { value: [1, 0, 0, 0], type: 16 } },
            })] },
            { name: 'opaque', passes: [{
                rasterizerState: { cullMode: 0 },
                program: 'bh-bb|vs|fs-opaque',
                depthStencilState: { depthTest: true, depthWrite: true },
                properties: { bbParams: { value: [1, 0, 0, 0], type: 16 } },
            }] },
        ],
        [
            {
                name: 'bh-bb|vs|fs-add',
                vert: BB_VERT,
                frag: BB_FRAG,
                globalsBlocks: camOnly,
                localsBlocks: [],
                attributes: ATTRS_BB,
                blocks: [{ name: 'Constants', defines: [], binding: 0, set: 1, stageFlags: 16, members: [{ name: 'bbParams', type: 16, count: 1 }] }],
            },
            {
                name: 'bh-bb|vs|fs-opaque',
                vert: BB_VERT,
                frag: DISC_FRAG,
                globalsBlocks: camOnly,
                localsBlocks: [],
                attributes: ATTRS_BB,
                blocks: [{ name: 'Constants', defines: [], binding: 0, set: 1, stageFlags: 16, members: [{ name: 'bbParams', type: 16, count: 1 }] }],
            },
        ],
    );

    fxDisk = registerEffect(
        'bh-disk',
        [
            { name: 'add', passes: [Object.assign({}, ADD_BLEND, {
                program: 'bh-disk|vs|fs',
                properties: {
                    diskParams: { value: [0, 0.55, 0, 0], type: 16 },
                    colHot: { value: [1.3, 1.27, 1.18, 1], type: 16 },
                    colMid: { value: [1.35, 0.83, 0.3, 1], type: 16 },
                    colCool: { value: [0.8, 0.26, 0.085, 1], type: 16 },
                },
            })] },
        ],
        [
            {
                name: 'bh-disk|vs|fs',
                vert: DISK_VERT,
                frag: DISK_FRAG,
                globalsBlocks: camOnly,
                localsBlocks: localCCLocal,
                attributes: ATTRS_DISK,
                blocks: [{
                    name: 'Constants', defines: [], binding: 0, set: 1, stageFlags: 16, members: [
                        { name: 'diskParams', type: 16, count: 1 },
                        { name: 'colHot', type: 16, count: 1 },
                        { name: 'colMid', type: 16, count: 1 },
                        { name: 'colCool', type: 16, count: 1 },
                    ],
                }],
            },
        ],
    );
}

// ============================== 几何构建 ==============================
function makeDiskMesh() {
    const SEG = 144, RINGS = 16;
    const positions = [], uvs = [], indices = [];
    for (let i = 0; i <= SEG; i++) {
        const ang = (i / SEG) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (let j = 0; j <= RINGS; j++) {
            const u = j / RINGS;
            const r = DISK_INNER + u * (DISK_OUTER - DISK_INNER);
            positions.push(ca * r, 0, sa * r);
            uvs.push(u, i / SEG);
        }
    }
    const W = RINGS + 1;
    for (let i = 0; i < SEG; i++) {
        for (let j = 0; j < RINGS; j++) {
            const a = i * W + j, b = (i + 1) * W + j, c = a + 1, d = b + 1;
            indices.push(a, b, c, c, b, d);
        }
    }
    return utils.MeshUtils.createMesh({
        positions, uvs, indices,
        minPos: { x: -DISK_OUTER, y: 0, z: -DISK_OUTER },
        maxPos: { x: DISK_OUTER, y: 0, z: DISK_OUTER },
    });
}

// 面片四角(世界空间):center/right/up/halfExtent → 4 顶点 + uv
function pushQuad(out, cx, cy, cz, rx, ry, rz, ux, uy, uz, hx, hu, color, data) {
    const px = cx - rx * hx - ux * hu, py = cy - ry * hx - uy * hu, pz = cz - rz * hx - uz * hu;
    const qx = cx + rx * hx - ux * hu, qy = cy + ry * hx - uy * hu, qz = cz + rz * hx - uz * hu;
    const sx = cx - rx * hx + ux * hu, sy = cy - ry * hx + uy * hu, sz = cz - rz * hx + uz * hu;
    const tx = cx + rx * hx + ux * hu, ty = cy + ry * hx + uy * hu, tz = cz + rz * hx + uz * hu;
    out.positions.push(px, py, pz, qx, qy, qz, sx, sy, sz, tx, ty, tz);
    out.uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    for (let k = 0; k < 4; k++) out.colors.push(color[0], color[1], color[2], color[3]);
    for (let k = 0; k < 4; k++) out.tangents.push(data[0], data[1], data[2], data[3]);
    const b = out.vertCount;
    out.indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    out.vertCount += 4;
}

function makeStarMesh() {
    const g = { positions: [], uvs: [], colors: [], tangents: [], indices: [], vertCount: 0 };
    for (let i = 0; i < STAR_COUNT; i++) {
        // 均匀球面方向 + 半径层次(一部分更远)
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        const R = 46 + Math.random() * 16;
        const cx = R * Math.sin(ph) * Math.cos(th);
        const cy = R * Math.cos(ph);
        const cz = R * Math.sin(ph) * Math.sin(th);
        // 观测方向 → 面向原点的公告板(相机只在固定方位缩放,静态即可)
        const inv = 1 / Math.max(1e-4, Math.sqrt(cx * cx + cy * cy + cz * cz));
        const fx = cx * inv, fy = cy * inv, fz = cz * inv;
        let rx = fz, ry = 0, rz = -fx;
        const rl = Math.max(1e-4, Math.sqrt(rx * rx + rz * rz));
        rx /= rl; rz /= rl;
        const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
        const big = Math.random() < 0.08;
        const size = big ? 1.3 + Math.random() * 0.6 : 0.3 + Math.random() * 0.75;
        const tone = Math.random();
        let col;
        if (tone < 0.55) col = [0.92, 0.94, 1.0];
        else if (tone < 0.8) col = [0.72, 0.82, 1.0];
        else col = [1.0, 0.86, 0.68];
        const inten = big ? 1.7 + Math.random() * 0.7 : 0.45 + Math.random() * 0.9;
        pushQuad(g, cx, cy, cz, rx, ry, rz, ux, uy, uz, size * 0.5, size * 0.5,
            [col[0], col[1], col[2], 1], [0, inten, 0, 0]);
    }
    return utils.MeshUtils.createMesh({
        positions: g.positions, uvs: g.uvs, colors: g.colors, tangents: g.tangents, indices: g.indices,
        minPos: { x: -66, y: -66, z: -66 }, maxPos: { x: 66, y: 66, z: 66 },
    });
}

function cameraBasis(f) {
    // 输入:相机前向(指向原点,归一化 Vec3);输出 [right, up](归一化数组)
    let rx = -f.z, ry = 0, rz = f.x;
    const rl = Math.max(1e-4, Math.hypot(rx, rz));
    rx /= rl; rz /= rl;
    const ux = ry * f.z - rz * f.y, uy = rz * f.x - rx * f.z, uz = rx * f.y - ry * f.x;
    return [[rx, ry, rz], [ux, uy, uz]];
}

function makeGlowMesh(camForward) {
    const g = { positions: [], uvs: [], colors: [], tangents: [], indices: [], vertCount: 0 };
    const f = camForward; // 相机前向(归一化,指向原点)——所有辉光片面向相机
    const [r, u] = cameraBasis(f);
    // 辉光片置于黑核圆盘后侧 0.06(黑核不透明写深度 → 圆盘内辉光被遮挡,保持暗核纯黑)
    const cx = f.x * 0.06, cy = f.y * 0.06, cz = f.z * 0.06;
    // 1) 内缘热辉光(白热柔光,填充光子环与盘内缘之间的过渡带)
    pushQuad(g, cx, cy, cz, r[0], r[1], r[2], u[0], u[1], u[2], 2.2, 2.2,
        [1.0, 0.86, 0.6, 1], [3, 1.15, 0, 0]);
    // 2) 光子环(透镜观感:紧包暗核的细亮环,顶部略亮)
    pushQuad(g, cx, cy, cz, r[0], r[1], r[2], u[0], u[1], u[2], 2.0, 2.0,
        [1.0, 0.80, 0.45, 1], [2, 1.15, 0.675, 0.05]);
    // 3-6) 深冷星云:中心对准画面四角(投影按深度 60 标定:1 world ≈ 9.5px),覆盖四角外围
    const cpx = f.x * 46, cpy = f.y * 46, cpz = f.z * 46;
    const corner = (dx, dy, half, col, inten) => {
        pushQuad(g,
            cpx + r[0] * dx + u[0] * dy, cpy + r[1] * dx + u[1] * dy, cpz + r[2] * dx + u[2] * dy,
            r[0], r[1], r[2], u[0], u[1], u[2], half, half, col, [3, inten, 0, 0]);
    };
    corner(-54, -30, 24, [0.13, 0.19, 0.33, 1], 1.2);
    corner(56, -28, 23, [0.16, 0.13, 0.29, 1], 1.15);
    corner(-52, 32, 22, [0.11, 0.16, 0.28, 1], 1.05);
    corner(56, 32, 23, [0.10, 0.14, 0.26, 1], 1.0);
    return utils.MeshUtils.createMesh({
        positions: g.positions, uvs: g.uvs, colors: g.colors, tangents: g.tangents, indices: g.indices,
        minPos: { x: -60, y: -60, z: -60 }, maxPos: { x: 60, y: 60, z: 60 },
    });
}

function makeDiscMesh(camForward) {
    const g = { positions: [], uvs: [], colors: [], tangents: [], indices: [], vertCount: 0 };
    const f = camForward;
    const [r, u] = cameraBasis(f);
    // 直径 2.4 = 视界半径 1.2(初始视角下约占短边 13%,处于 8%-15% 内)
    pushQuad(g, 0, 0, 0, r[0], r[1], r[2], u[0], u[1], u[2], 1.2, 1.2,
        [1, 1, 1, 1], [4, 1, 0, 0]);
    return utils.MeshUtils.createMesh({
        positions: g.positions, uvs: g.uvs, colors: g.colors, tangents: g.tangents, indices: g.indices,
        minPos: { x: -1.4, y: -1.4, z: -1.4 }, maxPos: { x: 1.4, y: 1.4, z: 1.4 },
    });
}

// ============================== 星流(动态网格,CPU 逐帧) ==============================
const stream = {
    mesh: null,
    geom: null,
    posArr: new Float32Array(STREAM_COUNT * 4 * 3),
    uvArr: new Float32Array(STREAM_COUNT * 4 * 2),
    colArr: new Float32Array(STREAM_COUNT * 4 * 4),
    tanArr: new Float32Array(STREAM_COUNT * 4 * 4),
    idxArr: new Uint16Array(STREAM_COUNT * 6),
    seeds: [],      // 复位用初始分布
    p: [],          // {r, ang, py, prev:{x,y,z}, speed}
    camPos: new Vec3(),
};

function streamSpawn(p, first) {
    p.r = first ? 1.7 + Math.random() * 6.6 : 6.8 + Math.random() * 1.6;
    p.ang = Math.random() * Math.PI * 2;
    p.py = (Math.random() - 0.5) * 0.16 * (p.r / 8);
    p.prev = null;
    p.trail = 0.2;
}

function streamInit() {
    stream.p = [];
    for (let i = 0; i < STREAM_COUNT; i++) {
        const p = {};
        streamSpawn(p, true);
        stream.p.push(p);
        stream.seeds.push({ r: p.r, ang: p.ang, py: p.py });
    }
    for (let i = 0; i < STREAM_COUNT; i++) {
        const b = i * 4;
        const v = i * 6;
        stream.idxArr[v] = b; stream.idxArr[v + 1] = b + 1; stream.idxArr[v + 2] = b + 2;
        stream.idxArr[v + 3] = b + 2; stream.idxArr[v + 4] = b + 1; stream.idxArr[v + 5] = b + 3;
    }
    for (let i = 0; i < STREAM_COUNT * 4; i++) {
        stream.uvArr[i * 2] = (i % 2); stream.uvArr[i * 2 + 1] = (i % 4) >> 1 ? 0 : 1;
        stream.tanArr[i * 4] = 1; stream.tanArr[i * 4 + 1] = 1.8;
        stream.tanArr[i * 4 + 2] = 0; stream.tanArr[i * 4 + 3] = 0;
    }
}

function streamReset() {
    for (let i = 0; i < STREAM_COUNT; i++) {
        const p = stream.p[i], s = stream.seeds[i];
        p.r = s.r; p.ang = s.ang; p.py = s.py; p.prev = null; p.trail = 0.2;
    }
}

function streamUpdate(dt, camWorld, diskAngle) {
    // 相机基向量(列主序:col0=right(m00..m02), col1=up(m10..m12), col3=位置(m30..m32))
    const crx = camWorld.m00, cry = camWorld.m01, crz = camWorld.m02;
    const cpx = camWorld.m30, cpy = camWorld.m31, cpz = camWorld.m32;
    const { posArr, colArr, p } = stream;
    for (let i = 0; i < STREAM_COUNT; i++) {
        const s = p[i];
        const omega = 3.2 * Math.pow(2.2 / s.r, 1.5);   // 内快外慢(类开普勒)
        const infall = 0.55 + 1.9 * Math.pow(2.2 / s.r, 2);
        s.r -= infall * dt;
        s.ang += omega * dt * 0.55;                      // 星流与盘同向
        if (s.r < HORIZON_R + 0.08) { streamSpawn(s, false); continue; }
        const x = Math.cos(s.ang) * s.r;
        const z = Math.sin(s.ang) * s.r;
        const y = s.py * (s.r / 8);
        if (!s.prev) s.prev = { x: x * 1.02, y, z: z * 1.02 };
        const dx = x - s.prev.x, dy = y - s.prev.y, dz = z - s.prev.z;
        const dl = Math.hypot(dx, dy, dz);
        // 拖尾方向:运动方向;宽度方向:垂直运动与视线
        let tx, ty, tz;
        if (dl > 1e-5) { tx = dx / dl; ty = dy / dl; tz = dz / dl; }
        else { tx = -Math.sin(s.ang); ty = 0; tz = Math.cos(s.ang); }
        const len = Math.min(0.12 + (omega * s.r) * 0.13, 1.6);
        // 视线方向(粒子 → 相机)
        let vx = cpx - x, vy = cpy - y, vz = cpz - z;
        const vl = Math.max(1e-4, Math.hypot(vx, vy, vz));
        vx /= vl; vy /= vl; vz /= vl;
        let wx = ty * vz - tz * vy, wy = tz * vx - tx * vz, wz = tx * vy - ty * vx;
        const wl = Math.max(1e-4, Math.hypot(wx, wy, wz));
        wx /= wl; wy /= wl; wz /= wl;
        const w = 0.16 * (0.35 + 0.65 * Math.min(1, s.r / 8));
        const b = i * 12;
        // 头部/尾部四角
        const hx = x + wx * w * 0.5, hy = y + wy * w * 0.5, hz = z + wz * w * 0.5;
        const gx = x - wx * w * 0.5, gy = y - wy * w * 0.5, gz = z - wz * w * 0.5;
        const kx = x - tx * len + wx * w * 0.5, ky = y - ty * len + wy * w * 0.5, kz = z - tz * len + wz * w * 0.5;
        const lx = x - tx * len - wx * w * 0.5, ly = y - ty * len - wy * w * 0.5, lz = z - tz * len - wz * w * 0.5;
        posArr[b] = hx; posArr[b + 1] = hy; posArr[b + 2] = hz;
        posArr[b + 3] = gx; posArr[b + 4] = gy; posArr[b + 5] = gz;
        posArr[b + 6] = kx; posArr[b + 7] = ky; posArr[b + 8] = kz;
        posArr[b + 9] = lx; posArr[b + 10] = ly; posArr[b + 11] = lz;
        // 近视界白热,外圈橙;拖尾亮度渐隐
        const heat = Math.max(0, Math.min(1, 1 - (s.r - HORIZON_R) / 6.2));
        const rr = 1.0, gr = 0.55 + 0.42 * heat, bl = 0.22 + 0.72 * heat;
        const alpha = 0.85 + 0.15 * heat;
        const cbase = i * 16;
        colArr[cbase] = rr; colArr[cbase + 1] = gr; colArr[cbase + 2] = bl; colArr[cbase + 3] = alpha;
        colArr[cbase + 4] = rr; colArr[cbase + 5] = gr; colArr[cbase + 6] = bl; colArr[cbase + 7] = alpha;
        colArr[cbase + 8] = rr * 0.9; colArr[cbase + 9] = gr * 0.85; colArr[cbase + 10] = bl * 0.8; colArr[cbase + 11] = alpha * 0.25;
        colArr[cbase + 12] = rr * 0.9; colArr[cbase + 13] = gr * 0.85; colArr[cbase + 14] = bl * 0.8; colArr[cbase + 15] = alpha * 0.25;
        s.prev = { x, y, z };
    }
    stream.geom.positions = posArr;
    stream.geom.uvs = stream.uvArr;
    stream.geom.colors = colArr;
    stream.geom.tangents = stream.tanArr;
    stream.geom.indices16 = stream.idxArr;
    stream.mesh.updateSubMesh(0, stream.geom);
}

// ============================== 场景驱动组件 ==============================
class SceneDriver extends Component {
    constructor() {
        super();
        this.diskNode = null;
        this.streamMesh = null;
    }
    start() {
        streamInit();
    }
    update(dt) {
        const d = Math.min(dt, 0.1); // 失焦回归防时间跳变
        // 盘旋转(时间参数驱动,连续)
        state.diskRotation += DISK_SPIN * d;
        state.accretionPhase = (state.diskRotation / (Math.PI * 2)) % 1;
        if (this.diskNode) this.diskNode.setRotationFromEuler(0, (state.diskRotation * 180) / Math.PI, 0);
        // 相机平滑缩放(指数趋近,1s 内残差 < 0.1%)
        state.camDistTarget = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, state.camDistTarget));
        const k = 1 - Math.exp(-8 * d);
        state.camDistCurrent += (state.camDistTarget - state.camDistCurrent) * k;
        const node = this.node;
        const sp = Math.sin(CAM_PITCH), cp = Math.cos(CAM_PITCH);
        node.setPosition(new Vec3(0, state.camDistCurrent * sp, state.camDistCurrent * cp));
        node.lookAt(new Vec3(0, 0, 0));
        // 星流推进
        if (this.streamMesh) {
            streamUpdate(d, node.worldMatrix, state.diskRotation);
        }
    }
}

function doReset() {
    state.diskRotation = 0;
    state.accretionPhase = 0;
    state.camDistTarget = CAM_DIST_INIT;
    if (stream.p && stream.p.length) streamReset();
    state.resetCount += 1;
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        ready: window.__appReady === true,
        frame: state.frame,
        diskRotation: state.diskRotation,
        accretionPhase: state.accretionPhase,
        cameraDistance: state.camDistCurrent,
        starStreamCount: STREAM_COUNT,
        backgroundStarCount: STAR_COUNT,
        resetCount: state.resetCount,
    }),
    reset: doReset,
};

// UI 契约:data-ui="reset" DOM 按钮,右上角(归一化 x>0.8, y<0.25)
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
        "font:12px sans-serif;background:#1a1a22;color:#eee;border:1px solid #555;" +
        'border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
}

// wheel 捕获监听(pal 层会吞 canvas 冒泡阶段事件,capture 先于目标阶段触发)
window.addEventListener('wheel', (e) => {
    if (!e.deltaY) return;
    state.camDistTarget = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, state.camDistTarget + e.deltaY * WHEEL_UNIT));
}, { capture: true, passive: true });

// ============================== 启动 ==============================
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    // 自定义效果注册(渲染首帧之前)
    registerCustomEffects();

    const scene = new Scene('blackhole');

    // 相机
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, CAM_DIST_INIT * Math.sin(CAM_PITCH), CAM_DIST_INIT * Math.cos(CAM_PITCH)));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CAM_FOV;
    camera.near = 0.1;
    camera.far = 240;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(2, 3, 9, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 相机基向量(构建面向相机的静态面片用)
    const fwd = new Vec3(0, 0, 0).subtract(cameraNode.position).normalize();

    // 黑体视界圆盘(不透明,写深度 → 遮挡其后一切,形成锐利黑核)
    const discNode = new Node('EventHorizon');
    discNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(discNode);
    const discRenderer = discNode.addComponent(MeshRenderer);
    discRenderer.mesh = makeDiscMesh(fwd);
    const mDisc = new Material();
    mDisc.initialize({ effectAsset: fxBillboard, technique: 1 });
    mDisc.setProperty('bbParams', new Vec4(1, 0, 0, 0));
    discRenderer.material = mDisc;

    // 吸积盘(节点旋转 = diskRotation,与状态通道一致)
    const diskNode = new Node('AccretionDisk');
    diskNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(diskNode);
    const diskRenderer = diskNode.addComponent(MeshRenderer);
    diskRenderer.mesh = makeDiskMesh();
    const mDisk = new Material();
    mDisk.initialize({ effectAsset: fxDisk, technique: 0 });
    mDisk.setProperty('diskParams', new Vec4(0, 0.55, 0, 0));
    mDisk.setProperty('colHot', new Vec4(1.30, 1.27, 1.18, 1));
    mDisk.setProperty('colMid', new Vec4(1.35, 0.83, 0.30, 1));
    mDisk.setProperty('colCool', new Vec4(0.80, 0.26, 0.085, 1));
    diskRenderer.material = mDisk;

    // 辉光层(内缘热辉光 + 光子环 + 星云)
    const glowNode = new Node('Glow');
    glowNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(glowNode);
    const glowRenderer = glowNode.addComponent(MeshRenderer);
    glowRenderer.mesh = makeGlowMesh(fwd);
    const mGlow = new Material();
    mGlow.initialize({ effectAsset: fxBillboard, technique: 0 });
    mGlow.setProperty('bbParams', new Vec4(1, 0, 0, 0));
    glowRenderer.material = mGlow;

    // 背景星空
    const starNode = new Node('Stars');
    starNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(starNode);
    const starRenderer = starNode.addComponent(MeshRenderer);
    starRenderer.mesh = makeStarMesh();
    const mStar = new Material();
    mStar.initialize({ effectAsset: fxBillboard, technique: 0 });
    mStar.setProperty('bbParams', new Vec4(1, 0, 0, 0));
    starRenderer.material = mStar;

    // 星流(动态网格)
    const trailNode = new Node('StarStream');
    trailNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(trailNode);
    const trailRenderer = trailNode.addComponent(MeshRenderer);
    {
        const geom = {
            positions: stream.posArr,
            uvs: stream.uvArr,
            colors: stream.colArr,
            tangents: stream.tanArr,
            indices16: stream.idxArr,
            minPos: { x: -9.5, y: -1, z: -9.5 },
            maxPos: { x: 9.5, y: 1, z: 9.5 },
        };
        stream.geom = geom;
        stream.mesh = utils.MeshUtils.createDynamicMesh(0, geom, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: STREAM_COUNT * 4,
            maxSubMeshIndices: STREAM_COUNT * 6,
        });
    }
    trailRenderer.mesh = stream.mesh;
    const mTrail = new Material();
    mTrail.initialize({ effectAsset: fxBillboard, technique: 0 });
    mTrail.setProperty('bbParams', new Vec4(1, 0, 0, 0));
    trailRenderer.material = mTrail;

    // 驱动组件挂在相机节点(先动相机 → 后推星流,顺序一致)
    const driver = cameraNode.addComponent(SceneDriver);
    driver.diskNode = diskNode;
    driver.streamMesh = stream.mesh;

    window.__airApp = app;
    app.run(scene);

    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) window.__appReady = true;
    });
} catch (err) {
    console.error('[blackhole] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
