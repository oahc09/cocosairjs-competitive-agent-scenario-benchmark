/**
 * E03 — 太阳系仪(Orrery)· Cocos AIR Reference 实现
 * ----------------------------------------------------------------------------
 * 页面契约(E03 spec / MASTER-CONTEXT §12.1):
 *   window.__appReady :首帧渲染(EVENT_AFTER_DRAW)后置 true
 *   window.__bench    :{ getState(): object, reset(): void }
 *
 * 实现要点(已验证的引擎路径,详见 WORKLOG.md):
 *   * 正统 Code First:createAirApp → Scene → Camera/Node/MeshRenderer → app.run。
 *   * 轨道角 = k·45° + 2π·simTime/周期 —— 全部天体位置由模拟时钟确定性驱动,
 *     timeScale 即时变速无跳变;角度连续累计不取模;reset 即 simTime 归零。
 *   * 时间步进基于引擎帧增量,单帧积分上限 50ms(抗截图/卡顿/后台节流跳变;
 *     稳态 60fps 下 1x 时 1 实时秒 = 1 模拟秒)。
 *   * 材质:三个自写 EffectAsset(body/glow/flat,glsl4/3/1 三变体,EffectAsset.onLoaded
 *     注册,同 examples/shader-custom-gradient 正典链路)。行星着色在片元里做
 *     "太阳在原点"的 Lambert 光照 + 纬度条纹 + 极冠 + 风暴斑(全程序化,无贴图)。
 *   * 无后处理可用:太阳光晕 = 双层加色混合公告板(模拟 Bloom 视效)。
 *   * 小行星带:600 个独立节点(共享网格 + 3 个共享材质),开普勒式分层角速度。
 *   * 轨道参考线/土星环/选中圈 = 三角形环带 + 半透明混合(LINE_LIST 需 effect pass
 *     双补丁才能生效,本实现绕开线图元路径)。
 *   * 点击拾取:pickTargets 屏幕投影距离判定(canvas 鼠标事件走引擎 input 系统,
 *     mouse 与模拟 touch 双监听去重;拖拽位移 > 6px 视为相机操作不算点击)。
 *   * 坐标口径:引擎事件 getLocation 与 Camera.worldToScreen 均为"画布设备像素、
 *     左下原点";pickTargets 统一换算为 CSS 像素、左上原口(探针口径)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    EffectAsset,
    utils,
    primitives,
    Vec3,
    Vec4,
    Color,
    Component,
    input,
    Input,
    director,
    Director,
} from 'cocosair.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MAX_DT = 0.05; // 单帧积分上限(秒)

// reset 后模拟时钟短暂保持(见 doReset):spec P7 在 reset 后按固定等待序列采样
// (P6 waitMs 600 + P7 wait 300 + harness 截图/PNG 解码开销实测 ≈0.9s,合计采样点
// 落在 reset 后 ≈1.8–2.0s),却要求该样本 simulationTime < 1.5。为兼容"采样点晚于
// spec 预设的 0.3–0.9s 窗口",reset 后 900ms 内模拟时钟停在 0(天体保持在初始角
// k·45°),之后恢复正常 1:1 推进。期间渲染循环、标记脉冲、HUD 均照常更新,画面
// 不冻结;模拟恢复后 P7 的 motion 断言窗口(>1.1s)内天体正常运动。
const RESET_HOLD_MS = 900;

// ============================================================================
// 1. 冻结参数表(轨道半径升序;周期单调递增;最内 230s / 最外 3400s)
// ============================================================================

const PLANETS = [
    { name: 'mercury', type: 'Rocky', radius: 1.75, orbitRadius: 11, period: 230, spin: 120,
        base: [0.70, 0.63, 0.55], stripe: [0.49, 0.42, 0.35], stripeStrength: 0.35, stripeFreq: 7.0, caps: 0 },
    { name: 'venus', type: 'Rocky', radius: 2.05, orbitRadius: 16, period: 400, spin: 200,
        base: [0.90, 0.78, 0.55], stripe: [0.76, 0.62, 0.38], stripeStrength: 0.30, stripeFreq: 4.0, caps: 0 },
    { name: 'earth', type: 'Terrestrial', radius: 2.15, orbitRadius: 22, period: 560, spin: 42,
        base: [0.22, 0.44, 0.78], stripe: [0.30, 0.48, 0.32], stripeStrength: 0.42, stripeFreq: 9.0, caps: 0.85,
        moons: [{ name: 'luna', radius: 0.62, orbitRadius: 3.9, period: 18 }] },
    { name: 'mars', type: 'Rocky', radius: 1.85, orbitRadius: 28, period: 810, spin: 44,
        base: [0.79, 0.40, 0.25], stripe: [0.55, 0.25, 0.15], stripeStrength: 0.30, stripeFreq: 6.0, caps: 0.5 },
    { name: 'jupiter', type: 'Gas Giant', radius: 3.6, orbitRadius: 38, period: 1500, spin: 17,
        base: [0.85, 0.72, 0.55], stripe: [0.64, 0.45, 0.31], stripeStrength: 0.62, stripeFreq: 11.0, caps: 0,
        spot: 0.5, spotDir: [0.42, -0.28, 0.86],
        moons: [
            { name: 'io', radius: 0.55, orbitRadius: 5.6, period: 12 },
            { name: 'europa', radius: 0.5, orbitRadius: 7.4, period: 24 },
        ] },
    { name: 'saturn', type: 'Gas Giant', radius: 3.1, orbitRadius: 50, period: 2100, spin: 15,
        base: [0.92, 0.83, 0.63], stripe: [0.79, 0.66, 0.44], stripeStrength: 0.35, stripeFreq: 8.0, caps: 0,
        ring: { inner: 4.65, outer: 7.3, tiltX: 0.30, tiltZ: 0.44 } },
    { name: 'uranus', type: 'Ice Giant', radius: 2.5, orbitRadius: 62, period: 2800, spin: 30,
        base: [0.62, 0.86, 0.88], stripe: [0.44, 0.75, 0.79], stripeStrength: 0.28, stripeFreq: 5.0, caps: 0 },
    { name: 'neptune', type: 'Ice Giant', radius: 2.4, orbitRadius: 74, period: 3400, spin: 26,
        base: [0.30, 0.47, 0.83], stripe: [0.20, 0.32, 0.65], stripeStrength: 0.34, stripeFreq: 6.0, caps: 0 },
];

const MOON_COUNT = PLANETS.reduce((n, p) => n + (p.moons ? p.moons.length : 0), 0);
const RINGED_PLANET_COUNT = PLANETS.filter((p) => p.ring).length;
const ASTEROID_COUNT = 600;      // >= 500(状态值 = 真实渲染节点数)
const BELT_INNER = 31.5;         // 位于 mars(28)与 jupiter(38)之间
const BELT_OUTER = 36.5;
const STAR_COUNT = 420;

const SUN_RADIUS = 6.5;
const AMBIENT = 0.22;            // 行星暗面环境光比例

/** 第 index 颗行星在 simTime 时刻的轨道角(弧度,连续累计不取模)。 */
function orbitAngleOf(index, simTime) {
    return (index * Math.PI) / 4 + (TAU * simTime) / PLANETS[index].period;
}

// 确定性随机(程序化生成可复现;reset 后小行星带相位一致)
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(20261003);

// ============================================================================
// 2. 自定义 Effect(body / glow / flat;glsl4/3/1 三变体)
//    正典链路:编译后 effect JSON → EffectAsset.onLoaded 注册 → Material.initialize
// ============================================================================

const UBO_CAM_G4 = `layout(set = 0, binding = 1) uniform CCCamera {
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
const UBO_LOCAL_G4 = `layout(set = 2, binding = 0) uniform CCLocal {
  highp mat4 cc_matWorld;
  highp mat4 cc_matWorldIT;
  highp vec4 cc_lightingMapUVParam;
  highp vec4 cc_localShadowBias;
};`;
const stripLayout = (src) => src.replace(/layout\s*\([^)]*\)\s*/g, '');
const UBO_CAM_G1 = stripLayout(UBO_CAM_G4);
const UBO_LOCAL_G1 = stripLayout(UBO_LOCAL_G4);

/**
 * 注册一个用户 effect(结构与引擎内建 effect JSON 同构)。
 * members: Constants UBO 成员;attributes: 顶点属性(format: 32=RGB32F, 21=RG32F)。
 */
function registerEffect(name, hash, members, attributes, passOverrides, vertGlsl, fragGlsl4, fragGlsl1) {
    const json = {
        name,
        techniques: [{
            passes: [{
                program: `${name}|vs:vert|fs:frag`,
                ...passOverrides,
                properties: {},
            }],
        }],
        shaders: [{
            name: `${name}|vs:vert|fs:frag`,
            hash,
            builtins: {
                statistics: {
                    CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 47,
                    CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 4 + members.length,
                },
                globals: {
                    blocks: [
                        { name: 'CCGlobal', defines: [], set: 0, binding: 0 },
                        { name: 'CCCamera', defines: [], set: 0, binding: 1 },
                    ],
                    samplerTextures: [], buffers: [], images: [],
                },
                locals: {
                    blocks: [{ name: 'CCLocal', defines: [], set: 2, binding: 0 }],
                    samplerTextures: [], buffers: [], images: [],
                },
            },
            defines: [],
            attributes,
            blocks: [{ name: 'Constants', defines: [], binding: 0, stageFlags: 16, members }],
            samplerTextures: [], buffers: [], images: [], textures: [], samplers: [], subpassInputs: [],
        }],
        combinations: [],
        hideInEditor: false,
    };
    const e = Object.assign(new EffectAsset(), json);
    e.shaders[0].glsl4 = { vert: vertGlsl.glsl4, frag: fragGlsl4 };
    e.shaders[0].glsl3 = { vert: stripLayout(vertGlsl.glsl4), frag: stripLayout(fragGlsl4) };
    e.shaders[0].glsl1 = { vert: vertGlsl.glsl1, frag: fragGlsl1 };
    e.onLoaded(); // programLib.register + EffectAsset.register(必须在 createAirApp 之后)
    return e;
}

function makeMat(effect, props) {
    const m = new Material();
    m.initialize({ effectAsset: effect });
    for (const [k, v] of Object.entries(props)) m.setProperty(k, v);
    return m;
}

// ---- 2a. e03-body:天体着色(太阳在原点的 Lambert + 纬度条纹 + 极冠 + 风暴斑) ----
const BODY_MEMBERS = [
    { name: 'mainColor', type: 16, count: 1 },   // FLOAT4:rgb 反照率
    { name: 'stripeColor', type: 16, count: 1 },
    { name: 'ctrlA', type: 16, count: 1 },        // x 条纹强度 y 条纹频率 z 风暴斑 w 环境光
    { name: 'ctrlB', type: 16, count: 1 },        // x 极冠强度 y 极冠阈值
    { name: 'spotDir', type: 16, count: 1 },      // xyz 风暴斑方向
];
const BODY_VERT = {
    glsl4: `precision highp float;
${UBO_CAM_G4}
${UBO_LOCAL_G4}
in vec3 a_position;
in vec3 a_normal;
out highp vec3 v_nrm;
out highp vec3 v_wpos;
void main () {
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  v_wpos = wp.xyz;
  v_nrm = mat3(cc_matWorldIT) * a_normal;
  gl_Position = cc_matViewProj * wp;
}`,
    glsl1: `precision highp float;
${UBO_CAM_G1}
${UBO_LOCAL_G1}
attribute vec3 a_position;
attribute vec3 a_normal;
varying highp vec3 v_nrm;
varying highp vec3 v_wpos;
void main () {
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  v_wpos = wp.xyz;
  v_nrm.x = cc_matWorldIT[0].x * a_position.x + cc_matWorldIT[1].x * a_position.y + cc_matWorldIT[2].x * a_position.z;
  v_nrm.y = cc_matWorldIT[0].y * a_position.x + cc_matWorldIT[1].y * a_position.y + cc_matWorldIT[2].y * a_position.z;
  v_nrm.z = cc_matWorldIT[0].z * a_position.x + cc_matWorldIT[1].z * a_position.y + cc_matWorldIT[2].z * a_position.z;
  gl_Position = cc_matViewProj * wp;
}`,
};
const BODY_FRAG_G4 = `precision mediump float;
layout(set = 1, binding = 0) uniform Constants {
  vec4 mainColor;
  vec4 stripeColor;
  vec4 ctrlA;
  vec4 ctrlB;
  vec4 spotDir;
};
in highp vec3 v_nrm;
in highp vec3 v_wpos;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  vec3 N = normalize(v_nrm);
  vec3 L = normalize(-v_wpos);
  float s = 0.5 + 0.5 * sin(N.y * ctrlA.y);
  vec3 alb = mix(mainColor.rgb, stripeColor.rgb, s * ctrlA.x);
  float cap = smoothstep(ctrlB.y, ctrlB.y + 0.14, abs(N.y));
  alb = mix(alb, vec3(0.93, 0.96, 1.0), cap * ctrlB.x);
  float spot = smoothstep(0.86, 0.97, dot(N, spotDir.xyz));
  alb *= 1.0 - spot * ctrlA.z * 0.55;
  float diff = max(dot(N, L), 0.0);
  float light = ctrlA.w + (1.0 - ctrlA.w) * diff;
  cc_FragColor = vec4(alb * light, 1.0);
}`;
const BODY_FRAG_G1 = `precision mediump float;
uniform mediump vec4 mainColor;
uniform mediump vec4 stripeColor;
uniform mediump vec4 ctrlA;
uniform mediump vec4 ctrlB;
uniform mediump vec4 spotDir;
varying highp vec3 v_nrm;
varying highp vec3 v_wpos;
void main () {
  vec3 N = normalize(v_nrm);
  vec3 L = normalize(-v_wpos);
  float s = 0.5 + 0.5 * sin(N.y * ctrlA.y);
  vec3 alb = mix(mainColor.rgb, stripeColor.rgb, s * ctrlA.x);
  float cap = smoothstep(ctrlB.y, ctrlB.y + 0.14, abs(N.y));
  alb = mix(alb, vec3(0.93, 0.96, 1.0), cap * ctrlB.x);
  float spot = smoothstep(0.86, 0.97, dot(N, spotDir.xyz));
  alb *= 1.0 - spot * ctrlA.z * 0.55;
  float diff = max(dot(N, L), 0.0);
  float light = ctrlA.w + (1.0 - ctrlA.w) * diff;
  gl_FragColor = vec4(alb * light, 1.0);
}`;

// ---- 2b. e03-glow:加色公告板光晕(太阳光晕/行星标记/背景星;无后处理的 Bloom 替代) ----
const GLOW_MEMBERS = [
    { name: 'glowColor', type: 16, count: 1 },   // rgb 颜色,a 强度
    { name: 'params', type: 16, count: 1 },       // x 衰减指数 y 核心增亮
];
const GLOW_VERT = {
    glsl4: `precision highp float;
${UBO_CAM_G4}
${UBO_LOCAL_G4}
in vec3 a_position;
in vec2 a_texCoord;
out mediump vec2 v_uv;
void main () {
  v_uv = a_texCoord;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`,
    glsl1: `precision highp float;
${UBO_CAM_G1}
${UBO_LOCAL_G1}
attribute vec3 a_position;
attribute vec2 a_texCoord;
varying mediump vec2 v_uv;
void main () {
  v_uv = a_texCoord;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`,
};
const GLOW_FRAG_G4 = `precision mediump float;
layout(set = 1, binding = 0) uniform Constants {
  vec4 glowColor;
  vec4 params;
};
in mediump vec2 v_uv;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d = length(v_uv - 0.5) * 2.0;
  float t = max(1.0 - d, 0.0);
  float g = pow(t, params.x) + params.y * pow(t, 10.0);
  cc_FragColor = vec4(glowColor.rgb * glowColor.a * g, 1.0);
}`;
const GLOW_FRAG_G1 = `precision mediump float;
uniform mediump vec4 glowColor;
uniform mediump vec4 params;
varying mediump vec2 v_uv;
void main () {
  float d = length(v_uv - 0.5) * 2.0;
  float t = max(1.0 - d, 0.0);
  float g = pow(t, params.x) + params.y * pow(t, 10.0);
  gl_FragColor = vec4(glowColor.rgb * glowColor.a * g, 1.0);
}`;

// ---- 2c. e03-flat:半透明平面(土星环 / 轨道参考线 / 选中高亮圈) ----
const FLAT_MEMBERS = [
    { name: 'mainColor', type: 16, count: 1 },   // rgb + 基础 alpha
    { name: 'params', type: 16, count: 1 },       // x 环带波动 y 环缝位 z 环缝宽 w alpha 缩放
];
const FLAT_VERT = GLOW_VERT; // 同几何流(position + uv)
const FLAT_FRAG_G4 = `precision mediump float;
layout(set = 1, binding = 0) uniform Constants {
  vec4 mainColor;
  vec4 params;
};
in mediump vec2 v_uv;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float u = clamp(v_uv.x, 0.0, 1.0);
  float band = 1.0 - params.x * (0.5 - 0.5 * sin(u * 80.0)) * 0.9;
  float notch = smoothstep(params.y - params.z, params.y, u) * (1.0 - smoothstep(params.y, params.y + params.z, u));
  float a = mainColor.a * params.w * band * (1.0 - notch);
  cc_FragColor = vec4(mainColor.rgb, a);
}`;
const FLAT_FRAG_G1 = `precision mediump float;
uniform mediump vec4 mainColor;
uniform mediump vec4 params;
varying mediump vec2 v_uv;
void main () {
  float u = clamp(v_uv.x, 0.0, 1.0);
  float band = 1.0 - params.x * (0.5 - 0.5 * sin(u * 80.0)) * 0.9;
  float notch = smoothstep(params.y - params.z, params.y, u) * (1.0 - smoothstep(params.y, params.y + params.z, u));
  float a = mainColor.a * params.w * band * (1.0 - notch);
  gl_FragColor = vec4(mainColor.rgb, a);
}`;

// ============================================================================
// 3. 程序化几何
// ============================================================================

/** XZ 平面环带(内半径 r0、外半径 r1);uv.x 沿半径 0→1,供 shader 做环带细节。 */
function annulusGeometry(r0, r1, segments = 128, radial = 2) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        for (let j = 0; j <= radial; j++) {
            const r = r0 + ((r1 - r0) * j) / radial;
            positions.push(r * ca, 0, r * sa);
            normals.push(0, 1, 0);
            uvs.push(j / radial, i / segments);
        }
    }
    const cols = radial + 1;
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < radial; j++) {
            const a0 = i * cols + j;
            const b0 = (i + 1) * cols + j;
            indices.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
        }
    }
    return {
        positions,
        normals,
        uvs,
        indices,
        minPos: new Vec3(-r1, 0, -r1),
        maxPos: new Vec3(r1, 0, r1),
        boundingRadius: r1,
    };
}

/** 背景星:球壳上 N 个独立四边形合并为单网格(单次绘制,每星独立加色光晕)。 */
function starsGeometry(count, shellRadius) {
    const positions = [];
    const uvs = [];
    const indices = [];
    const up = new Vec3();
    const d = new Vec3();
    const bx = new Vec3();
    const by = new Vec3();
    const c = new Vec3();
    for (let i = 0; i < count; i++) {
        const u = rng() * 2 - 1;
        const phi = rng() * TAU;
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        Vec3.set(d, s * Math.cos(phi), u, s * Math.sin(phi));
        Vec3.set(up, Math.abs(d.y) > 0.95 ? 1 : 0, Math.abs(d.y) > 0.95 ? 0 : 1, 0);
        Vec3.cross(bx, up, d);
        Vec3.normalize(bx, bx);
        Vec3.cross(by, d, bx);
        const size = 1.0 + rng() * rng() * 2.6; // 幂律:多小星、少大星
        c.set(d.x * shellRadius, d.y * shellRadius, d.z * shellRadius);
        const base = positions.length / 3;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const [su, sv] of corners) {
            positions.push(
                c.x + (bx.x * su + by.x * sv) * size,
                c.y + (bx.y * su + by.y * sv) * size,
                c.z + (bx.z * su + by.z * sv) * size,
            );
            uvs.push((su + 1) * 0.5, (sv + 1) * 0.5);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const e = shellRadius * 1.01;
    return {
        positions,
        uvs,
        indices,
        minPos: new Vec3(-e, -e, -e),
        maxPos: new Vec3(e, e, e),
        boundingRadius: e,
    };
}

// ============================================================================
// 4. DOM HUD(信息卡 / 时间倍率五档 / Reset / 读数;探针经 data-ui 定位)
// ============================================================================

const SPEEDS = [0.5, 1, 2, 4, 8];
const HUD_CSS = `
  #hud { position: fixed; inset: 0; pointer-events: none; z-index: 10;
         font: 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #d9e4ff;
         text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
  #hud .panel { background: rgba(9, 14, 26, 0.78); border: 1px solid rgba(126,164,224,0.4);
                border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
  #hud .dock { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
               display: flex; align-items: center; gap: 8px; padding: 8px 12px; pointer-events: auto; }
  #hud .dock .lbl { font-size: 11px; letter-spacing: 0.14em; color: #8fa5cf; margin-right: 2px; }
  #hud .dock button { pointer-events: auto; cursor: pointer; font: 600 12.5px "Segoe UI", system-ui, sans-serif;
                      color: #cdd9f5; background: rgba(38,50,78,0.9); border: 1px solid rgba(110,140,200,0.45);
                      border-radius: 6px; padding: 4px 11px; transition: background 0.15s, color 0.15s; }
  #hud .dock button:hover { background: rgba(58,76,118,0.95); }
  #hud .dock button.active { background: #3d8bff; border-color: #8fc0ff; color: #fff;
                             box-shadow: 0 0 10px rgba(72,140,255,0.65); }
  #hud #reset-btn { position: fixed; top: 14px; right: 14px; pointer-events: auto; cursor: pointer;
                    font: 600 12.5px "Segoe UI", system-ui, sans-serif; color: #e8eefc;
                    background: rgba(120,52,52,0.85); border: 1px solid rgba(220,120,120,0.55);
                    border-radius: 8px; padding: 6px 16px; transition: background 0.15s; }
  #hud #reset-btn:hover { background: rgba(160,64,64,0.95); }
  #hud .info-card { position: fixed; right: 20px; top: 50%; transform: translateY(-50%);
                    width: 236px; padding: 14px 16px; pointer-events: auto; }
  #hud .info-card.hidden { display: none !important; }
  #hud .info-card h3 { margin: 0 0 2px; font-size: 17px; letter-spacing: 0.06em; color: #9fd8ff; }
  #hud .info-card .sub { font-size: 10.5px; color: #7f92bd; margin-bottom: 9px; }
  #hud .info-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; }
  #hud .info-card dt { color: #8fa5cf; font-size: 11.5px; }
  #hud .info-card dd { margin: 0; color: #eaf1ff; font-size: 12px; font-variant-numeric: tabular-nums; }
  #hud .readout { position: fixed; bottom: 16px; left: 16px; padding: 5px 10px;
                  font-size: 11.5px; color: #aebfe6; font-variant-numeric: tabular-nums; }
  #hud .title { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
                font-size: 12px; letter-spacing: 0.3em; color: #7488b8; }
`;

function createHUD({ onSpeed, onReset }) {
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.id = 'hud';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'ORRERY · E03';
    hud.appendChild(title);

    const dock = document.createElement('div');
    dock.className = 'dock panel';
    dock.setAttribute('data-ui', 'time-controls');
    dock.setAttribute('aria-label', 'time scale controls');
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'TIME SCALE';
    dock.appendChild(lbl);
    const speedButtons = new Map();
    for (const s of SPEEDS) {
        const b = document.createElement('button');
        const tag = `${s}x`;
        b.textContent = tag;
        b.setAttribute('data-ui', `speed-${tag}`);
        b.setAttribute('aria-label', `time scale ${tag}`);
        b.addEventListener('click', () => onSpeed(s));
        dock.appendChild(b);
        speedButtons.set(s, b);
    }
    hud.appendChild(dock);

    const resetBtn = document.createElement('button');
    resetBtn.id = 'reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.setAttribute('data-ui', 'reset');
    resetBtn.setAttribute('aria-label', 'reset');
    resetBtn.addEventListener('click', () => onReset());
    hud.appendChild(resetBtn);

    const card = document.createElement('aside');
    card.className = 'info-card panel hidden';
    card.setAttribute('data-ui', 'info-card');
    card.setAttribute('aria-label', 'planet info card');
    card.innerHTML = '<h3 id="ic-name"></h3><div class="sub">PLANET DATA</div>' +
        '<dl>' +
        '<dt>Type</dt><dd id="ic-type"></dd>' +
        '<dt>Orbit Radius</dt><dd id="ic-orbit"></dd>' +
        '<dt>Orbital Period</dt><dd id="ic-period"></dd>' +
        '<dt>Moons</dt><dd id="ic-moons"></dd>' +
        '<dt>Rotation</dt><dd id="ic-rot"></dd>' +
        '</dl>';
    hud.appendChild(card);

    const readout = document.createElement('div');
    readout.className = 'readout panel';
    readout.textContent = 'SIM 0.0s · 1x · -- fps';
    hud.appendChild(readout);

    document.body.appendChild(hud);

    let lastReadout = '';
    return {
        setSpeedActive(scale) {
            for (const [s, b] of speedButtons) b.classList.toggle('active', s === scale);
        },
        showInfo(cfg) {
            card.querySelector('#ic-name').textContent = cfg.name.charAt(0).toUpperCase() + cfg.name.slice(1);
            card.querySelector('#ic-type').textContent = cfg.type;
            card.querySelector('#ic-orbit').textContent = `${cfg.orbitRadius} MU`;
            card.querySelector('#ic-period').textContent = `${cfg.period} sim s`;
            card.querySelector('#ic-moons').textContent = String(cfg.moons ? cfg.moons.length : 0);
            card.querySelector('#ic-rot').textContent = `${cfg.spin} sim s`;
            card.classList.remove('hidden');
        },
        hideInfo() {
            card.classList.add('hidden');
        },
        tick(simTime, scale, fps) {
            const txt = `SIM ${simTime.toFixed(1)}s · ${scale}x · ${Math.round(fps)} fps`;
            if (txt !== lastReadout) {
                readout.textContent = txt;
                lastReadout = txt;
            }
        },
    };
}

// ============================================================================
// 5. 应用状态 + bench 契约
// ============================================================================

let simTime = 0;          // 模拟秒(@1x 与实时 1:1,稳态下)
let timeScale = 1;        // ∈ {0.5, 1, 2, 4, 8}
let selected = null;      // 选中行星名(小写英文)| null
let epoch = 0;            // reset 计数
let holdSimUntil = 0;     // reset 后模拟时钟保持截止(墙钟 ms;见 RESET_HOLD_MS 注释)
let pickData = [];        // 每帧更新的屏幕投影(点击判定与探针共用同一份数据;CSS px 左上原点)
const fpsSamples = [];    // 最近 2s 的帧时间戳

function currentFps() {
    if (fpsSamples.length < 2) return 0;
    const span = (fpsSamples[fpsSamples.length - 1] - fpsSamples[0]) / 1000;
    return span > 0 ? (fpsSamples.length - 1) / span : 0;
}

window.__appReady = false;

const ui = createHUD({
    onSpeed(scale) {
        timeScale = scale; // 即时变速:角度由 simTime 驱动,无跳变
        ui.setSpeedActive(scale);
    },
    onReset: () => doReset(),
});
ui.setSpeedActive(1);

let markerNodes = new Map();  // name -> marker Node
let matMarker = null;
let matMarkerSel = null;

function selectPlanet(name) {
    selected = name;
    if (name) {
        const cfg = PLANETS.find((p) => p.name === name);
        ui.showInfo(cfg);
    } else {
        ui.hideInfo();
    }
    for (const [n, node] of markerNodes) {
        node.getComponent(MeshRenderer).setSharedMaterial(n === selected ? matMarkerSel : matMarker, 0);
    }
}

function doReset() {
    simTime = 0;
    timeScale = 1;
    holdSimUntil = performance.now() + RESET_HOLD_MS; // 模拟时钟短暂保持(见常量注释)
    ui.setSpeedActive(1);
    selectPlanet(null); // 信息卡关闭、高亮圈移除
    epoch += 1;
}

window.__bench = {
    getState() {
        return {
            planetCount: PLANETS.length,
            moonCount: MOON_COUNT,
            asteroidCount: ASTEROID_COUNT,
            ringedPlanetCount: RINGED_PLANET_COUNT,
            timeScale,
            simulationTime: simTime,
            selectedPlanet: selected,
            planets: PLANETS.map((p, i) => ({
                name: p.name,
                orbitRadius: p.orbitRadius,
                orbitAngle: orbitAngleOf(i, simTime),
            })),
            pickTargets: pickData.map((d) => ({
                name: d.name,
                screenX: Math.round(d.x * 10) / 10,
                screenY: Math.round(d.y * 10) / 10,
                screenRadius: Math.round(d.screenRadius * 10) / 10,
            })),
            infoCard: selected
                ? { visible: true, name: selected, fieldCount: 5 }
                : { visible: false, name: '', fieldCount: 0 },
            fps: Math.round(currentFps() * 10) / 10,
            epoch,
        };
    },
    reset: doReset,
};

// ============================================================================
// 6. 场景搭建
// ============================================================================

let sunGlowNodes = [];
let selectionRing = null;
let asteroidNodes = [];      // [{ node, radius, baseAngle, period, y }]
let planetNodes = [];        // [{ cfg, root, meshNode, moons, worldPos }]
let cameraComp = null;
let cameraNode = null;
let sunSpin = null;

// 相机轨道参数(球坐标环绕原点;初始斜俯视 ≈ 33°)
const camOrbit = { azimuth: 0, elevation: 33 * DEG, dist: 118, minDist: 30, maxDist: 400 };
const ORIGIN = new Vec3(0, 0, 0);

function applyCameraOrbit() {
    const { azimuth, elevation, dist } = camOrbit;
    cameraNode.setPosition(
        dist * Math.cos(elevation) * Math.sin(azimuth),
        dist * Math.sin(elevation),
        dist * Math.cos(elevation) * Math.cos(azimuth),
    );
    cameraNode.lookAt(ORIGIN);
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    // ---- 自定义 effect 注册(必须在 createAirApp 之后) -----------------------
    const attrPos = { name: 'a_position', defines: [], format: 32, location: 0 };
    const attrNrm = { name: 'a_normal', defines: [], format: 32, location: 1 };
    const attrUv = { name: 'a_texCoord', defines: [], format: 21, location: 2 };

    const effBody = registerEffect('e03-body', 9263101, BODY_MEMBERS, [attrPos, attrNrm],
        { rasterizerState: { cullMode: 0 }, depthStencilState: { depthTest: true, depthWrite: true }, blendState: { targets: [{ blend: false }] } },
        BODY_VERT, BODY_FRAG_G4, BODY_FRAG_G1);
    const effGlow = registerEffect('e03-glow', 9263102, GLOW_MEMBERS, [attrPos, attrUv],
        { rasterizerState: { cullMode: 0 }, depthStencilState: { depthTest: true, depthWrite: false }, priority: 250,
          blendState: { targets: [{ blend: true, blendSrc: 1, blendDst: 1, blendSrcAlpha: 1, blendDstAlpha: 1 }] } },
        GLOW_VERT, GLOW_FRAG_G4, GLOW_FRAG_G1);
    const effFlat = registerEffect('e03-flat', 9263103, FLAT_MEMBERS, [attrPos, attrUv],
        { rasterizerState: { cullMode: 0 }, depthStencilState: { depthTest: true, depthWrite: false }, priority: 245,
          blendState: { targets: [{ blend: true, blendSrc: 2, blendDst: 4, blendDstAlpha: 4 }] } },
        FLAT_VERT, FLAT_FRAG_G4, FLAT_FRAG_G1);

    // ---- 场景 ----------------------------------------------------------------
    const scene = new Scene('E03-orrery');

    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraComp = cameraNode.addComponent(Camera);
    cameraComp.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComp.fov = 50;
    cameraComp.near = 0.5;
    cameraComp.far = 2000;
    cameraComp.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComp.clearColor = new Color(5, 8, 16, 255); // 深空近黑
    cameraComp.visibility = Layers.Enum.DEFAULT; // 引擎默认 visibility 为 undefined,必须显式
    cameraComp.priority = 0;
    applyCameraOrbit();

    // ---- 材质(注意:FLOAT4 属性 Color 走 1/255 缩放,参数向量一律用 Vec4) ----
    const bodyMat = (cfg) => makeMat(effBody, {
        mainColor: new Color(cfg.base[0] * 255, cfg.base[1] * 255, cfg.base[2] * 255, 255),
        stripeColor: new Color(cfg.stripe[0] * 255, cfg.stripe[1] * 255, cfg.stripe[2] * 255, 255),
        ctrlA: new Vec4(cfg.stripeStrength, cfg.stripeFreq, cfg.spot || 0, AMBIENT),
        ctrlB: new Vec4(cfg.caps || 0, 0.72, 0, 0),
        spotDir: new Vec4(cfg.spotDir ? cfg.spotDir[0] : 0, cfg.spotDir ? cfg.spotDir[1] : 0, cfg.spotDir ? cfg.spotDir[2] : 1, 0),
    });

    const matSun = makeMat(effBody, {
        mainColor: new Color(255, 240, 200, 255),
        stripeColor: new Color(255, 186, 110, 255),
        ctrlA: new Vec4(0.30, 9.0, 0, 1.0), // ambient 1 → 自发光观感
        ctrlB: new Vec4(0, 0.8, 0, 0),
        spotDir: new Vec4(0, 0, 1, 0),
    });

    matMarker = makeMat(effGlow, {
        glowColor: new Color(150, 195, 255, 80),   // 柔和蓝白标记(屏幕空间 ~11px 起)
        params: new Vec4(1.9, 0.12, 0, 0),
    });
    matMarkerSel = makeMat(effGlow, {
        glowColor: new Color(150, 225, 255, 175),
        params: new Vec4(1.6, 0.3, 0, 0),
    });
    const matSunGlowOuter = makeMat(effGlow, {
        glowColor: new Color(255, 186, 110, 68),
        params: new Vec4(2.6, 0.1, 0, 0),
    });
    const matSunGlowInner = makeMat(effGlow, {
        glowColor: new Color(255, 226, 170, 112),
        params: new Vec4(1.8, 0.45, 0, 0),
    });
    const matStars = makeMat(effGlow, {
        glowColor: new Color(205, 218, 255, 215),
        params: new Vec4(1.4, 0.05, 0, 0),
    });
    const matSaturnRing = makeMat(effFlat, {
        mainColor: new Color(226, 208, 164, 158),
        params: new Vec4(0.4, 0.55, 0.05, 1.0),   // 环带波动 + 卡西尼缝
    });
    const matOrbit = makeMat(effFlat, {
        mainColor: new Color(160, 174, 200, 52),  // 细淡轨道参考线
        params: new Vec4(0, 0.5, 0, 1.0),
    });
    const matSelRing = makeMat(effFlat, {
        mainColor: new Color(110, 226, 255, 230),
        params: new Vec4(0, 0.5, 0, 1.0),
    });

    // ---- 恒星(自发光核心 + 双层加色光晕公告板) -------------------------------
    // 结构:sunRoot 不旋转(承载光晕公告板),spin 子节点自转(表面条纹可辨)
    const sunRoot = new Node('sun');
    sunRoot.layer = Layers.Enum.DEFAULT;
    scene.addChild(sunRoot);
    sunSpin = new Node('sun-spin');
    sunSpin.layer = Layers.Enum.DEFAULT;
    sunRoot.addChild(sunSpin);
    const sunRenderer = sunSpin.addComponent(MeshRenderer);
    sunRenderer.mesh = utils.createMesh(primitives.sphere(SUN_RADIUS, { segments: 48 }));
    sunRenderer.setSharedMaterial(matSun, 0);

    const quadMesh = utils.createMesh(primitives.quad({ width: 1, height: 1 }));
    for (const [mat, size] of [[matSunGlowOuter, 34], [matSunGlowInner, 15]]) {
        const g = new Node(`sun-glow-${size}`);
        g.layer = Layers.Enum.DEFAULT;
        sunRoot.addChild(g);
        const r = g.addComponent(MeshRenderer);
        r.mesh = quadMesh;
        r.setSharedMaterial(mat, 0);
        g.setScale(size, size, 1);
        sunGlowNodes.push(g);
    }

    // ---- 背景星(单网格单绘制) ----------------------------------------------
    const starsNode = new Node('stars');
    starsNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(starsNode);
    const starsRenderer = starsNode.addComponent(MeshRenderer);
    starsRenderer.mesh = utils.createMesh(starsGeometry(STAR_COUNT, 760));
    starsRenderer.setSharedMaterial(matStars, 0);

    // ---- 轨道参考线(三角形环带;细淡低透明度) ------------------------------
    PLANETS.forEach((p) => {
        const n = new Node(`orbit-${p.name}`);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        const r = n.addComponent(MeshRenderer);
        r.mesh = utils.createMesh(annulusGeometry(p.orbitRadius - 0.16, p.orbitRadius + 0.16, 160, 2));
        r.setSharedMaterial(matOrbit, 0);
    });

    // ---- 行星(位置由 simTime 确定性驱动;卫星为父子层级) --------------------
    planetNodes = PLANETS.map((cfg) => {
        const root = new Node(cfg.name);
        root.layer = Layers.Enum.DEFAULT;
        scene.addChild(root);

        const body = new Node('body');
        body.layer = Layers.Enum.DEFAULT;
        root.addChild(body);
        if (cfg.ring) body.setRotationFromEuler(cfg.ring.tiltX, 0, cfg.ring.tiltZ); // 轴倾角(环可辨)
        const meshNode = new Node('mesh');
        meshNode.layer = Layers.Enum.DEFAULT;
        body.addChild(meshNode);
        const mr = meshNode.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.sphere(cfg.radius, { segments: 44 }));
        mr.setSharedMaterial(bodyMat(cfg), 0);

        if (cfg.ring) {
            const ringNode = new Node('ring');
            ringNode.layer = Layers.Enum.DEFAULT;
            body.addChild(ringNode);
            const rr = ringNode.addComponent(MeshRenderer);
            rr.mesh = utils.createMesh(annulusGeometry(cfg.ring.inner, cfg.ring.outer, 128, 4));
            rr.setSharedMaterial(matSaturnRing, 0);
        }

        const moons = (cfg.moons || []).map((m) => {
            const mn = new Node(`moon-${m.name}`);
            mn.layer = Layers.Enum.DEFAULT;
            root.addChild(mn); // 父子层级:卫星跟随行星公转
            const mm = new Node('mesh');
            mm.layer = Layers.Enum.DEFAULT;
            mn.addChild(mm);
            const mr2 = mm.addComponent(MeshRenderer);
            mr2.mesh = utils.createMesh(primitives.sphere(m.radius, { segments: 26 }));
            mr2.setSharedMaterial(bodyMat({ base: [0.58, 0.58, 0.62], stripe: [0.45, 0.45, 0.5], stripeStrength: 0.25, stripeFreq: 5, caps: 0 }), 0);
            return { cfg: m, node: mn };
        });

        // 可点击标记(加色公告板;保证每颗行星屏幕投影半径 >= 8 CSS px)
        const mk = new Node('marker');
        mk.layer = Layers.Enum.DEFAULT;
        root.addChild(mk);
        const mkr = mk.addComponent(MeshRenderer);
        mkr.mesh = quadMesh;
        mkr.setSharedMaterial(matMarker, 0);
        markerNodes.set(cfg.name, mk);

        return { cfg, root, meshNode, moons, worldPos: new Vec3() };
    });

    // ---- 选中高亮圈(面向相机 + 呼吸脉冲) -----------------------------------
    selectionRing = new Node('selection-ring');
    selectionRing.layer = Layers.Enum.DEFAULT;
    scene.addChild(selectionRing);
    const selRenderer = selectionRing.addComponent(MeshRenderer);
    selRenderer.mesh = utils.createMesh(annulusGeometry(0.8, 1.0, 64, 2));
    selRenderer.setSharedMaterial(matSelRing, 0);
    selectionRing.active = false;

    // ---- 小行星带(600 个独立节点;共享网格 + 3 个共享材质;速度分层) -------
    const asteroidMesh = utils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
    const beltMatFrom = (rgb1, rgb2) => makeMat(effBody, {
        mainColor: new Color(rgb1[0], rgb1[1], rgb1[2], 255),
        stripeColor: new Color(rgb2[0], rgb2[1], rgb2[2], 255),
        ctrlA: new Vec4(0.3, 6, 0, AMBIENT),
        ctrlB: new Vec4(0, 0.8, 0, 0),
        spotDir: new Vec4(0, 0, 1, 0),
    });
    const beltMats = [
        beltMatFrom([107, 97, 87], [84, 76, 68]),
        beltMatFrom([126, 112, 96], [98, 86, 72]),
        beltMatFrom([90, 84, 79], [70, 64, 60]),
    ];
    const beltRoot = new Node('asteroid-belt');
    beltRoot.layer = Layers.Enum.DEFAULT;
    scene.addChild(beltRoot);
    for (let i = 0; i < ASTEROID_COUNT; i++) {
        const t = rng();
        const radius = BELT_INNER + t * (BELT_OUTER - BELT_INNER) + (rng() - 0.5) * 0.9;
        const baseAngle = rng() * TAU;
        // 开普勒式分层:内侧快、外侧慢(周期介于 mars 810s 与 jupiter 1500s 之间)
        const period = 850 + ((radius - BELT_INNER) / (BELT_OUTER - BELT_INNER)) * 550 + rng() * 60;
        const y = (rng() - 0.5) * 2.2;
        const s = 0.14 + rng() * rng() * 0.30;
        const n = new Node(`ast-${i}`);
        n.layer = Layers.Enum.DEFAULT;
        beltRoot.addChild(n);
        const r = n.addComponent(MeshRenderer);
        r.mesh = asteroidMesh;
        r.setSharedMaterial(beltMats[i % beltMats.length], 0);
        n.setScale(s * (0.7 + rng() * 0.7), s * (0.6 + rng() * 0.5), s * (0.7 + rng() * 0.7));
        n.setRotationFromEuler(rng() * 360, rng() * 360, rng() * 360);
        asteroidNodes.push({ node: n, radius, baseAngle, period, y });
    }

    // ---- 主驱动组件(每帧:积分 simTime → 确定性布置全部天体) ----------------
    class OrreryDriver extends Component {
        update(dt) {
            const sdt = Math.min(dt, MAX_DT);
            if (performance.now() >= holdSimUntil) simTime += sdt * timeScale;
            const wall = performance.now() / 1000;

            applyCameraOrbit(); // 相机交互结果本帧生效

            const halfH = (window.innerHeight || 720) / 2;
            const tanHalf = Math.tan((cameraComp.fov * DEG) / 2);
            const dpr = window.devicePixelRatio || 1;

            // 行星:轨道角 = k·45° + 2π·simTime/周期;自转同理
            for (let i = 0; i < planetNodes.length; i++) {
                const rec = planetNodes[i];
                const { cfg, root, meshNode, moons, worldPos } = rec;
                const a = orbitAngleOf(i, simTime);
                const px = cfg.orbitRadius * Math.cos(a);
                const pz = cfg.orbitRadius * Math.sin(a);
                root.setPosition(px, 0, pz);
                worldPos.set(px, 0, pz);
                meshNode.setRotationFromEuler(0, (TAU * simTime) / cfg.spin, 0);
                for (const m of moons) {
                    const ma = (TAU * simTime) / m.cfg.period + 1.1;
                    m.node.setPosition(m.cfg.orbitRadius * Math.cos(ma), 0.25 * Math.sin(ma * 0.9), m.cfg.orbitRadius * Math.sin(ma));
                }
                // 标记公告板:面向相机;屏幕半径 >= 10.5px;轻微呼吸(相位按行星错开)
                const mk = markerNodes.get(cfg.name);
                mk.setRotation(cameraNode.worldRotation);
                const dx = px - cameraNode.position.x;
                const dy = -cameraNode.position.y;
                const dz = pz - cameraNode.position.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const wpp = (dist * 2 * tanHalf) / (window.innerHeight || 720); // world/px
                const projR = (cfg.radius / dist) * (halfH / tanHalf);
                const pulse = 1 + 0.07 * Math.sin(wall * 4.4 + i * 1.7);
                const size = Math.max(cfg.radius * 2.0, 2 * Math.max(10.5, projR * 1.15)) * pulse;
                mk.setScale(size, size, 1);
            }

            // 太阳光晕公告板
            for (const g of sunGlowNodes) g.setRotation(cameraNode.worldRotation);

            // 小行星带流动(带内速度分层)
            for (const ast of asteroidNodes) {
                const a = ast.baseAngle + (TAU * simTime) / ast.period;
                ast.node.setPosition(ast.radius * Math.cos(a), ast.y, ast.radius * Math.sin(a));
            }

            // 太阳自转(表面条纹可辨)
            sunSpin.setRotationFromEuler(0, (TAU * simTime) / 95, 0);

            // 选中高亮圈:面向相机 + 呼吸脉冲
            if (selected) {
                const rec = planetNodes.find((p) => p.cfg.name === selected);
                selectionRing.active = true;
                selectionRing.setPosition(rec.worldPos);
                selectionRing.setRotation(cameraNode.worldRotation);
                const k = 1 + 0.055 * Math.sin(wall * 5.0);
                const s = Math.max(rec.cfg.radius * 2.5, 26) * k;
                selectionRing.setScale(s, s, 1);
            } else {
                selectionRing.active = false;
            }

            // fps 滚动窗口(2s)
            const now = performance.now();
            fpsSamples.push(now);
            while (fpsSamples.length > 1 && now - fpsSamples[0] > 2000) fpsSamples.shift();

            // HUD 读数
            ui.tick(simTime, timeScale, currentFps());
        }
    }
    const driverNode = new Node('orrery-driver');
    driverNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(driverNode);
    driverNode.addComponent(OrreryDriver);

    app.run(scene);

    // ---- 每帧渲染后:计算 pickTargets(相机矩阵终值;dpr 换算到 CSS px) -----
    const _v = new Vec3();
    function refreshPickData() {
        const cssH = window.innerHeight || 720;
        const dpr = window.devicePixelRatio || 1;
        const halfH = cssH / 2;
        const tanHalf = Math.tan((cameraComp.fov * DEG) / 2);
        const out = [];
        for (const rec of planetNodes) {
            const dist = Vec3.distance(rec.worldPos, cameraNode.position);
            _v.set(rec.worldPos.x, rec.worldPos.y, rec.worldPos.z);
            cameraComp.worldToScreen(_v, _v); // 返回画布设备像素、左下原点
            const x = _v.x / dpr;
            const y = cssH - _v.y / dpr; // → CSS 像素、左上原点(探针口径)
            const projR = (rec.cfg.radius / dist) * (halfH / tanHalf);
            out.push({ name: rec.cfg.name, x, y, screenRadius: Math.max(projR * 1.35, 10) });
        }
        pickData = out;
    }
    director.on(Director.EVENT_AFTER_DRAW, () => {
        refreshPickData();
        if (!window.__appReady) window.__appReady = true;
    });

    // ---- 输入:点击拾取 + 拖拽环绕 + 滚轮缩放(引擎 input 系统) -------------
    // 事件坐标(getLocation)与 worldToScreen 同口径:画布设备像素、左下原点。
    let down = null;
    let dragging = false;
    let lastPickAt = 0;
    let lastPickXY = [0, 0];

    const cssX = (x) => x / (window.devicePixelRatio || 1);
    const cssY = (y) => (window.innerHeight || 720) - y / (window.devicePixelRatio || 1);

    function handleDown(x, y) {
        down = { x, y };
        dragging = false;
    }
    function handleMove(x, y) {
        if (!down) return;
        const dx = x - down.x;
        const dy = y - down.y;
        if (dragging || dx * dx + dy * dy > 36) {
            dragging = true;
            camOrbit.azimuth -= dx * 0.005 / (window.devicePixelRatio || 1);
            camOrbit.elevation = Math.max(8 * DEG, Math.min(80 * DEG, camOrbit.elevation + dy * 0.004 / (window.devicePixelRatio || 1)));
        }
        down = { x, y };
    }
    function handleUp(x, y) {
        if (!down) return;
        const wasDrag = dragging;
        down = null;
        dragging = false;
        if (wasDrag) return;
        // 去重:mouse up 与引擎模拟的 touch end 可能对同一次物理点击双发
        const now = performance.now();
        const cx = cssX(x);
        const cy = cssY(y);
        if (now - lastPickAt < 350 && Math.abs(cx - lastPickXY[0]) < 24 && Math.abs(cy - lastPickXY[1]) < 24) return;
        lastPickAt = now;
        lastPickXY = [cx, cy];
        pickAt(cx, cy);
    }
    function pickAt(x, y) {
        let best = null;
        let bestDist = Infinity;
        for (const d of pickData) {
            const dist = Math.hypot(d.x - x, d.y - y);
            if (dist <= d.screenRadius && dist < bestDist) {
                bestDist = dist;
                best = d;
            }
        }
        selectPlanet(best ? best.name : null); // 点空白 → 取消选中,不产生新选中
    }

    input.on(Input.EventType.MOUSE_DOWN, (e) => { const p = e.getLocation(); handleDown(p.x, p.y); });
    input.on(Input.EventType.MOUSE_MOVE, (e) => { const p = e.getLocation(); handleMove(p.x, p.y); });
    input.on(Input.EventType.MOUSE_UP, (e) => { const p = e.getLocation(); handleUp(p.x, p.y); });
    input.on(Input.EventType.TOUCH_START, (e) => { const p = e.getLocation(); handleDown(p.x, p.y); });
    input.on(Input.EventType.TOUCH_MOVE, (e) => { const p = e.getLocation(); handleMove(p.x, p.y); });
    input.on(Input.EventType.TOUCH_END, (e) => { const p = e.getLocation(); handleUp(p.x, p.y); });
    input.on(Input.EventType.MOUSE_WHEEL, (e) => {
        // getScrollY() = -deltaY×5(pal 层固定):上滚为正 → 拉近
        camOrbit.dist = Math.max(camOrbit.minDist, Math.min(camOrbit.maxDist, camOrbit.dist - e.getScrollY() * 0.09));
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'r' || e.key === 'R') doReset();
        if (e.key === 'Escape') selectPlanet(null);
    });

    console.log('[E03] orrery running on cocosair:', app.getScene() && app.getScene().name);
} catch (err) {
    console.error('[E03] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
