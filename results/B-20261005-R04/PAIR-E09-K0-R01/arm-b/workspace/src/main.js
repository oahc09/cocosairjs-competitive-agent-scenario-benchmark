/**
 * E09 珠宝展示台 — cocosair 实现(Agent Run PAIR-E09-K0-R01 / arm-b)
 *
 * 设计要点(为什么这么写):
 *  - 宝石为程序化多切面凸多面体(16 段明亮式切工,128 个三角面 ≈ 切面等价几何,落在 60–200 区间),
 *    逐面平顶着色法线 —— 切面之间的颜色跳变即"锐利高光/火彩"的物理来源。
 *  - 折射/反射/色散全部在自定义 effect 的片元里实时计算(不是贴图烘焙):
 *      reflect(-V,N) 采样程序化"摄影棚环境函数"(软光箱 + 横向灯带)→ 锐利镜面高光;
 *      refract(-V,N,1/IOR) 三个通道用三条略微不同的折射率(1.50/1.55/1.60+,色散参数可调)
 *      分别采样环境 → 切面棱线出现随视角/转台流动的彩虹边缘(火彩);
 *      Schlick 菲涅尔混合反射/折射 → 掠射角变亮。
 *    背景幕/地面也在同一环境函数语义下生成,透过宝石可见被折射弯折的背景 → 折射变形观感。
 *  - 三点棚拍:引擎内 1 盏 DirectionalLight(主光,场景仅允许一盏平行光)+ 2 盏 SphereLight(辅光/轮廓光)
 *    照亮展台与金属亮环;宝石 shader 内以固定主/辅/轮廓方向显式叠加三层受光,层次肉眼可辨。
 *  - 相机推近是真实相机位移:相机节点沿取景射线改写世界坐标(禁 viewport 缩放),
 *    cameraDistance 即相机-宝石中心的真实距离,过渡 850ms 三次缓动(≥600ms 合同)。
 *  - PNG 导出:在 EVENT_AFTER_DRAW 同一 JS 任务内对默认帧缓冲 readPixels(此时像素仍有效,
 *    不依赖 preserveDrawingBuffer),翻转后落入 2D canvas → toBlob → <a download> 真实下载;
 *    分辨率 = drawingBuffer 尺寸 = 画布 1280×720。
 *  - 双击:pal 层会吞 canvas 鼠标事件,这里用 window 捕获阶段监听 'dblclick'(捕获先于 canvas 目标层)。
 *  - uniforms 一律 Vec4 实例(AIR 坑:FLOAT4 传普通数组会 NaN);灯光 color 一律 Color 实例。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    SphereLight,
    MeshRenderer,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Vec4,
    Color,
    Component,
    director,
    Director,
    EffectAsset,
    Material,
} from 'cocosair.js';

// ============================================================================
// 页面契约状态
// ============================================================================

const COLOR_PRESETS = {
    diamond: [0.855, 0.905, 0.965], // #E8EEF2(线性近似)
    ruby: [0.687, 0.032, 0.070], // #D6323F
    emerald: [0.020, 0.395, 0.157], // #23A96E
    sapphire: [0.026, 0.140, 0.687], // #2E5FD8
    amber: [0.820, 0.375, 0.048], // #E8A33D
};
const COLOR_NAMES = ['diamond', 'ruby', 'emerald', 'sapphire', 'amber'];

const state = {
    rotationAngle: 0, // 转台累计角度(度),单调增
    selectedColor: 'diamond',
    cameraDistance: 10, // 相机-宝石中心真实距离
    exportCount: 0,
};

window.__appReady = false;

const bench = {
    getState: () => ({
        rotationAngle: state.rotationAngle,
        selectedColor: state.selectedColor,
        cameraDistance: state.cameraDistance,
        exportCount: state.exportCount,
    }),
    reset: () => {
        applyColor('diamond');
        camAnim.from = state.cameraDistance;
        camAnim.to = FAR_DIST;
        camAnim.t = 0;
        camAnim.active = true;
        state.exportCount = 0;
        // 转台相位不清零:reset 后继续运转(合同 §4.5)
    },
};
window.__bench = bench;

// ============================================================================
// 自定义 effect(e09-studio):单 pass 程序化摄影棚着色
// ============================================================================

// 与引擎内置 effect 相同的 GLSL4 书写口径(set/binding 布局限定),
// glsl3 由同一 toGlsl3 规则(内置 registerBuiltinAirAssets 使用)机械转换得到。
const GLSL_GLOBAL_BLOCKS = `
layout(set = 0, binding = 0) uniform CCGlobal {
highp   vec4 cc_time;
mediump vec4 cc_screenSize;
mediump vec4 cc_nativeSize;
mediump vec4 cc_debug_view_mode;
mediump vec4 cc_debug_view_composite_pack_1;
mediump vec4 cc_debug_view_composite_pack_2;
mediump vec4 cc_debug_view_composite_pack_3;
};
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

const GLSL_LOCAL_BLOCK = `
layout(set = 2, binding = 0) uniform CCLocal {
highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;
};`;

const VERT_SRC = `precision highp float;
${GLSL_GLOBAL_BLOCKS}
${GLSL_LOCAL_BLOCK}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_texCoord;
layout(location = 0) out vec3 v_normal;
layout(location = 1) out vec3 v_worldPos;
layout(location = 2) out vec2 v_uv;
void main() {
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  v_worldPos = wp.xyz;
  v_normal = normalize((cc_matWorldIT * vec4(a_normal, 0.0)).xyz);
  v_uv = a_texCoord;
  gl_Position = cc_matViewProj * wp;
}`;

// uTint    = (r, g, b, mode)  mode: 0 宝石 / 1 背景幕 / 2 地面 / 3 金属亮环 / 4 展台
// uParams  = (色散强度, 环境曝光, 火彩增益, 备用)
// uParams2 = (径向衰减, 辉光强度, 备用, 备用)
const FRAG_SRC = `precision highp float;
${GLSL_GLOBAL_BLOCKS}
layout(set = 1, binding = 0) uniform StudioBlock {
  vec4 uTint;
  vec4 uParams;
  vec4 uParams2;
};
layout(location = 0) in vec3 v_normal;
layout(location = 1) in vec3 v_worldPos;
layout(location = 2) in vec2 v_uv;
layout(location = 0) out vec4 fragColor;

const vec3 KEY_DIR  = normalize(vec3(-0.52, 0.72, 0.46));   // 主光(键光)方向:左前上
const vec3 FILL_DIR = normalize(vec3(0.82, 0.20, 0.53));    // 辅光方向:右前
const vec3 RIM_DIR  = normalize(vec3(-0.10, 0.38, -0.92));  // 轮廓光方向:后上

// 程序化摄影棚环境(显示域标定:引擎不做输出 gamma 转换,帧缓冲值即显示值,实测标定)
// 棚顶微亮 + 三块锐利柔光箱 + 横向灯带 + 地平线微光
vec3 studioEnv(vec3 d) {
  float y = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.085, 0.088, 0.100), vec3(0.26, 0.27, 0.30), y);
  float dk = max(dot(d, KEY_DIR), 0.0);
  c += vec3(1.00, 0.96, 0.88) * (pow(dk, 300.0) * 30.0 + smoothstep(0.20, 0.92, dk) * 1.50);
  vec3 stripD = normalize(vec3(-0.18, 0.92, 0.34));
  c += vec3(1.00, 0.98, 0.94) * smoothstep(0.865, 0.995, dot(d, stripD)) * 4.0;
  float df = max(dot(d, FILL_DIR), 0.0);
  c += vec3(0.50, 0.66, 1.00) * (pow(df, 140.0) * 6.0 + smoothstep(0.10, 0.92, df) * 0.65);
  float dr = max(dot(d, RIM_DIR), 0.0);
  c += vec3(1.00, 0.95, 0.86) * (pow(dr, 260.0) * 3.5 + smoothstep(0.30, 0.97, dr) * 0.18);
  c += vec3(0.30, 0.32, 0.38) * pow(1.0 - abs(d.y), 6.0) * 0.90; // 地平线微光:折射内容不空腔
  c += vec3(0.55, 0.60, 0.70) * pow(max(d.y, 0.0), 2.0) * 0.30;  // 棚顶渐变:冠部切面有内容
  return c;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 gemShade(vec3 n, vec3 wp, float disp, float exposure, float fire) {
  vec3 N = normalize(n);
  vec3 V = normalize(cc_cameraPos.xyz - wp);
  vec3 R = reflect(-V, N);
  vec3 envR = studioEnv(R);
  float etaR = 1.0 / (1.50 + disp);
  float etaG = 1.0 / 1.55;
  float etaB = 1.0 / (1.60 + disp);
  vec3 Tr = refract(-V, N, etaR); if (dot(Tr, Tr) < 1e-4) Tr = R;
  vec3 Tg = refract(-V, N, etaG); if (dot(Tg, Tg) < 1e-4) Tg = R;
  vec3 Tb = refract(-V, N, etaB); if (dot(Tb, Tb) < 1e-4) Tb = R;
  vec3 T = vec3(studioEnv(Tr).r, studioEnv(Tg).g, studioEnv(Tb).b) * exposure;
  envR *= exposure * 1.1;
  vec3 T2 = T / (1.0 + T * 0.55); // 软压缩:高光不让传输通道变白,保持体色
  float NdV = max(dot(N, V), 0.0);
  float F = 0.12 + 0.88 * pow(1.0 - NdV, 5.0);
  vec3 col = mix(uTint.rgb * (T2 * 1.25 + 0.10), envR, F);
  // 三点布光在宝石上的直接响应(锐利主光高光 / 冷色填充 / 轮廓掠射亮线)
  col += vec3(1.00, 0.96, 0.88) * pow(max(dot(N, KEY_DIR), 0.0), 160.0) * 2.2;
  col += vec3(0.50, 0.66, 1.00) * pow(max(dot(N, FILL_DIR), 0.0), 22.0) * 0.50;
  col += vec3(1.00, 0.97, 0.90) * pow(max(dot(N, RIM_DIR), 0.0), 10.0) * 0.80;
  // 火彩增益:三通道折射采样差即色散条纹(用压缩后的 T2,随转台/视角流动)
  vec3 fireV = abs(T2 - vec3(T2.g));
  col += fireV * fire;
  return col;
}

void main() {
  int mode = int(uTint.a + 0.5);
  vec3 col;
  if (mode == 0) {
    col = gemShade(v_normal, v_worldPos, uParams.x, uParams.y, uParams.z);
  } else if (mode == 1) {
    // 背景幕:竖直深灰渐变 + 宝石背后的柔和辉光(分离主体)
    float t = clamp((v_worldPos.y + 2.0) / 11.0, 0.0, 1.0);
    col = mix(vec3(0.190, 0.200, 0.225), vec3(0.050, 0.055, 0.070), t);
    float glow = exp(-length(v_worldPos.xy - vec2(0.0, 1.55)) * 0.55);
    col += vec3(0.85, 0.88, 0.95) * glow * uParams2.y;
  } else if (mode == 2) {
    // 地面:中心亮池 + 接触阴影 + 远处融入背景幕
    float r = length(v_worldPos.xz);
    col = vec3(0.055, 0.057, 0.064);
    col += vec3(0.95, 0.90, 0.80) * exp(-r * 0.50) * 0.50;              // 灯池
    col *= 1.0 - smoothstep(1.35, 0.45, r) * 0.45;                       // 接触阴影
    col = mix(col, vec3(0.190, 0.200, 0.225), smoothstep(5.5, 12.0, r)); // 融入背景
  } else if (mode == 3) {
    // 金属亮环:侧缘亮线,顶面压暗(避免俯视时变成一大片灰盘)
    vec3 n = normalize(v_normal);
    float sheen = 0.35 + 0.65 * pow(max(dot(n, normalize(vec3(-0.4, 0.8, 0.45))), 0.0), 3.0);
    col = vec3(0.72, 0.74, 0.80) * sheen * (1.0 - 0.88 * clamp(n.y, 0.0, 1.0));
  } else {
    // 展台:低反射深色缎面,顶面承接灯池,中心留接触阴影
    vec3 n = normalize(v_normal);
    float top = clamp(n.y, 0.0, 1.0);
    col = mix(vec3(0.062, 0.064, 0.072), vec3(0.150, 0.155, 0.170), top);
    col += vec3(1.0, 0.96, 0.88) * pow(max(dot(n, KEY_DIR), 0.0), 6.0) * 0.10;
    float r = length(v_worldPos.xz);
    col *= 1.0 - smoothstep(1.15, 0.25, r) * 0.55;
  }
  col += vec3(hash12(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0); // 细微抖动,防色带
  fragColor = vec4(col, 1.0);
}`;

function toGlsl3(src) {
    // 复刻引擎内置 registerBuiltinAirAssets 的 glsl4→glsl3 机械转换
    return src
        .replace(/#extension[^\n]*\n/g, '')
        .replace(/^[^\n]*cc_debug_view_composite_pack_\d+;[^\n]*$/gm, '')
        .replace(/layout\s*\(([^)]*)\)\s*/g, (m, inner) => (inner.indexOf('std140') !== -1 ? 'layout(std140) ' : ''))
        .replace(/\bu32vec([234])\b/g, 'vec$1');
}

const PROGRAM_NAME = 'e09-studio|studio-vs:vert|studio-fs:frag';

const STUDIO_PROPS = {
    uTint: { value: [1, 1, 1, 0], type: 16 },
    uParams: { value: [0.12, 1.0, 1.2, 0], type: 16 },
    uParams2: { value: [1, 0.20, 0, 0], type: 16 },
};

let studioEffect = null;
function registerStudioEffect() {
    const vert = VERT_SRC;
    const frag = FRAG_SRC;
    const shader = {
        name: PROGRAM_NAME,
        hash: 20261005,
        glsl4: { vert, frag },
        glsl3: { vert: toGlsl3(vert), frag: toGlsl3(frag) },
        builtins: {
            statistics: {
                CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 40,
                CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 40,
            },
            globals: {
                blocks: [{ name: 'CCGlobal', defines: [] }, { name: 'CCCamera', defines: [] }],
                samplerTextures: [],
                buffers: [],
                images: [],
            },
            locals: {
                blocks: [{ name: 'CCLocal', defines: ['!USE_INSTANCING', '!USE_BATCHING'] }],
                samplerTextures: [],
                buffers: [],
                images: [],
            },
        },
        defines: [
            { name: 'USE_INSTANCING', type: 'boolean' },
            { name: 'USE_BATCHING', type: 'boolean' },
        ],
        attributes: [
            { name: 'a_position', defines: [], format: 32, isNormalized: false, stream: 0, isInstanced: false, location: 0 },
            { name: 'a_normal', defines: [], format: 32, isNormalized: false, stream: 0, isInstanced: false, location: 1 },
            { name: 'a_texCoord', defines: [], format: 21, isNormalized: false, stream: 0, isInstanced: false, location: 2 },
        ],
        blocks: [
            {
                name: 'StudioBlock',
                binding: 0,
                stageFlags: 16,
                members: [
                    { name: 'uTint', type: 16, count: 1 },
                    { name: 'uParams', type: 16, count: 1 },
                    { name: 'uParams2', type: 16, count: 1 },
                ],
            },
        ],
        samplerTextures: [],
        buffers: [],
        images: [],
        textures: [],
        samplers: [],
        subpassInputs: [],
    };
    const effectJson = {
        name: 'e09-studio',
        techniques: [
            // technique 0:背面剔除(宝石)
            { name: 'opaque', passes: [{ program: PROGRAM_NAME, rasterizerState: { cullMode: 2 }, properties: STUDIO_PROPS }] },
            // technique 1:双面(地面/背景幕大平面)
            { name: 'doubleSided', passes: [{ program: PROGRAM_NAME, rasterizerState: { cullMode: 0 }, properties: STUDIO_PROPS }] },
        ],
        shaders: [shader],
    };
    // 与引擎 registerBuiltinAirAssets 相同的注册路径:Object.assign + onLoaded 自动注册
    const effect = new EffectAsset('e09-studio');
    Object.assign(effect, effectJson);
    effect.onLoaded();
    return effect;
}

function studioMaterial(mode, tint, params, params2, technique) {
    const m = new Material();
    m.initialize({ effectAsset: studioEffect, technique });
    m.setProperty('uTint', new Vec4(tint[0], tint[1], tint[2], mode));
    m.setProperty('uParams', new Vec4(params[0], params[1], params[2], params[3]));
    m.setProperty('uParams2', new Vec4(params2[0], params2[1], params2[2], params2[3]));
    return m;
}

// ============================================================================
// 程序化宝石几何:16 段明亮式切工(台面 + 冠部双带 + 腰棱 + 亭部双带 + 底尖)= 128 面三角
// ============================================================================
function buildGemGeometry() {
    const SEG = 16;
    const RING = [];
    for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        RING.push([Math.cos(a), Math.sin(a)]);
    }
    // 尺寸直接烘进几何体(引擎节点 setScale 在该版本渲染路径不可靠,实测未生效)
    const S = 1.30;
    const yTable = 0.34 * S, rTable = 0.47 * S;
    const yGT = 0.09 * S, rGirdle = 1.06 * S;
    const yGB = -0.07 * S;
    const yMid = -0.50 * S, rMid = 0.50 * S;
    const culet = [0, -0.93 * S, 0];
    const center = [0, -0.2, 0];
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vCount = 0;
    function ringPoint(r, y, i) {
        return [RING[i][0] * r, y, RING[i][1] * r];
    }
    function addTri(a, b, c) {
        // 面法线朝外(凸体):法线与(重心-中心)同向,否则翻转绕序
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const cx = (a[0] + b[0] + c[0]) / 3 - center[0];
        const cy = (a[1] + b[1] + c[1]) / 3 - center[1];
        const cz = (a[2] + b[2] + c[2]) / 3 - center[2];
        if (nx * cx + ny * cy + nz * cz < 0) {
            const t = b; b = c; c = t;
            nx = -nx; ny = -ny; nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (const p of [a, b, c]) {
            positions.push(p[0], p[1], p[2]);
            normals.push(nx, ny, nz);
            uvs.push(Math.atan2(p[2], p[0]) / (Math.PI * 2) + 0.5, (p[1] + 1) / 2);
        }
        indices.push(vCount, vCount + 1, vCount + 2);
        vCount += 3;
    }
    for (let i = 0; i < SEG; i++) {
        const t0 = ringPoint(rTable, yTable, i), t1 = ringPoint(rTable, yTable, i + 1);
        const g0 = ringPoint(rGirdle, yGT, i), g1 = ringPoint(rGirdle, yGT, i + 1);
        const h0 = ringPoint(rGirdle, yGB, i), h1 = ringPoint(rGirdle, yGB, i + 1);
        const m0 = ringPoint(rMid, yMid, i), m1 = ringPoint(rMid, yMid, i + 1);
        addTri([0, yTable, 0], t0, t1);            // 台面
        addTri(t0, g0, t1); addTri(g0, g1, t1);    // 冠部:星面 + 风筝面
        addTri(g0, h0, g1); addTri(h0, h1, g1);    // 腰棱
        addTri(h0, m0, h1); addTri(m0, m1, h1);    // 亭部上带
        addTri(m0, culet, m1);                     // 亭部主面
    }
    return {
        positions,
        normals,
        uvs,
        indices,
        min: [-rGirdle, culet[1], -rGirdle],
        max: [rGirdle, yTable, rGirdle],
    };
}

// ============================================================================
// 行为组件:转台自转 / 相机推拉
// ============================================================================

const GEM_CENTER = new Vec3(0, 1.69, 0);
const FAR_DIST = 10;
const NEAR_DIST = 5.3; // ≤6(合同 P4)
const SPIN_SPEED = 32; // 度/s(≥25)

class Turntable extends Component {
    update(dt) {
        state.rotationAngle += dt * SPIN_SPEED;
        const deg = state.rotationAngle % 360;
        this.node.setRotationFromEuler(0, deg, 0);
    }
}

const camAnim = { from: FAR_DIST, to: FAR_DIST, t: 0, active: false, dur: 0.85 };
class CameraRig extends Component {
    update(dt) {
        if (camAnim.active) {
            camAnim.t += dt;
            const k = Math.min(camAnim.t / camAnim.dur, 1);
            const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
            state.cameraDistance = camAnim.from + (camAnim.to - camAnim.from) * e;
            if (k >= 1) { camAnim.active = false; state.cameraDistance = camAnim.to; }
        }
        const d = state.cameraDistance;
        const el = (9 * Math.PI) / 180;
        const pos = new Vec3(
            GEM_CENTER.x,
            GEM_CENTER.y + Math.sin(el) * d,
            GEM_CENTER.z + Math.cos(el) * d,
        );
        this.node.setPosition(pos);
        this.node.lookAt(GEM_CENTER);
    }
}

let gemMaterial = null;
function applyColor(name) {
    state.selectedColor = name;
    if (gemMaterial) {
        const t = COLOR_PRESETS[name];
        // mode 0 保持不变:uTint = (r,g,b,mode)
        gemMaterial.setProperty('uTint', new Vec4(t[0], t[1], t[2], 0));
    }
}

// ============================================================================
// UI(色板 / 导出 / 重置)
// ============================================================================
function buildUI() {
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;left:0;right:0;bottom:14px;display:flex;justify-content:center;gap:26px;' +
        'align-items:center;z-index:9999;pointer-events:none;';
    const group = document.createElement('div');
    group.style.cssText =
        'display:flex;gap:12px;align-items:center;padding:10px 16px;border-radius:999px;' +
        'background:rgba(12,13,16,0.55);border:1px solid rgba(255,255,255,0.10);' +
        'backdrop-filter:blur(6px);pointer-events:auto;';
    const swatchHex = ['#E8EEF2', '#D6323F', '#23A96E', '#2E5FD8', '#E8A33D'];
    const buttons = [];
    COLOR_NAMES.forEach((name, i) => {
        const b = document.createElement('button');
        b.setAttribute('data-ui', 'swatch-' + (i + 1));
        b.title = name;
        b.style.cssText =
            `width:26px;height:26px;border-radius:50%;background:${swatchHex[i]};` +
            'border:2px solid rgba(255,255,255,0.25);cursor:pointer;padding:0;' +
            'transition:transform .15s ease, box-shadow .15s ease;';
        b.addEventListener('click', () => {
            applyColor(name);
            buttons.forEach((x) => {
                const on = x.title === name;
                x.style.boxShadow = on ? '0 0 0 2px rgba(255,255,255,0.85)' : 'none';
                x.style.transform = on ? 'scale(1.22)' : 'scale(1)';
            });
        });
        buttons.push(b);
        group.appendChild(b);
    });
    buttons[0].style.boxShadow = '0 0 0 2px rgba(255,255,255,0.85)';
    buttons[0].style.transform = 'scale(1.22)';
    bar.appendChild(group);

    const actions = document.createElement('div');
    actions.style.cssText =
        'display:flex;gap:10px;padding:8px 12px;border-radius:999px;' +
        'background:rgba(12,13,16,0.55);border:1px solid rgba(255,255,255,0.10);' +
        'backdrop-filter:blur(6px);pointer-events:auto;';
    function mkBtn(label, dataUi, handler) {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('data-ui', dataUi);
        b.style.cssText =
            "font:12px/1 'Segoe UI',sans-serif;color:#e8e8ec;background:rgba(255,255,255,0.08);" +
            'border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:7px 14px;cursor:pointer;';
        b.addEventListener('click', handler);
        actions.appendChild(b);
        return b;
    }
    mkBtn('导出 PNG', 'export-png', () => exportPNG());
    mkBtn('重置', 'reset', () => bench.reset());
    bar.appendChild(actions);
    document.body.appendChild(bar);
}

// ============================================================================
// PNG 导出:EVENT_AFTER_DRAW 同任务内 readPixels(默认帧缓冲)→ 2D canvas → toBlob → 真实下载
// ============================================================================
window.__e09 = { lastExportBytes: 0, lastExportError: '' };
// 诊断钩子:在渲染帧后同步回调(与导出同一像素有效性窗口)
window.__e09.captureAfterDraw = (fn) => {
    director.once(Director.EVENT_AFTER_DRAW, () => fn());
};
function exportPNG() {
    return new Promise((resolve) => {
        director.once(Director.EVENT_AFTER_DRAW, () => {
            try {
                const gl = canvasEl.getContext('webgl2');
                if (!gl) throw new Error('webgl2 context unavailable');
                const w = gl.drawingBufferWidth;
                const h = gl.drawingBufferHeight;
                const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null); // 读合成后的默认帧缓冲
                const px = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
                const c2 = document.createElement('canvas');
                c2.width = w; c2.height = h;
                const ctx = c2.getContext('2d');
                const img = ctx.createImageData(w, h);
                const row = w * 4;
                for (let y = 0; y < h; y++) {
                    img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
                }
                ctx.putImageData(img, 0, 0);
                c2.toBlob((blob) => {
                    try {
                        if (!blob) throw new Error('toBlob returned null');
                        window.__e09.lastExportBytes = blob.size;
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `E09-gem-${Date.now()}.png`; // 带时间戳,避免同名冲突
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 5000);
                        state.exportCount += 1;
                        resolve(blob.size);
                    } catch (e) {
                        window.__e09.lastExportError = String(e && e.message || e);
                        resolve(-1);
                    }
                }, 'image/png');
            } catch (e) {
                window.__e09.lastExportError = String(e && e.message || e);
                resolve(-1);
            }
        });
    });
}

// ============================================================================
// 双击推近/拉回:window 捕获阶段(pal 层吞 canvas 事件,捕获先于其目标层处理)
// ============================================================================
let canvasEl = null;
function setupDblClick() {
    window.addEventListener(
        'dblclick',
        () => {
            const near = state.cameraDistance <= 6.5;
            camAnim.from = state.cameraDistance;
            camAnim.to = near ? FAR_DIST : NEAR_DIST;
            camAnim.t = 0;
            camAnim.active = true;
        },
        true,
    );
}

// ============================================================================
// 主流程
// ============================================================================
try {
    canvasEl = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas: canvasEl });

    const scene = new Scene('E09-jewelry-studio');

    // --- 相机 ---
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.layer = Layers.Enum.DEFAULT;
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 30;
    camera.near = 0.1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(8, 8, 11, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    cameraNode.addComponent(CameraRig);
    state.cameraDistance = FAR_DIST;

    // --- 三点棚拍布光(引擎侧:1 平行光主光 + 2 球灯辅/轮廓;宝石 shader 内同步三层响应)---
    const keyNode = new Node('KeyLight');
    scene.addChild(keyNode);
    keyNode.layer = Layers.Enum.DEFAULT;
    keyNode.setPosition(new Vec3(-4.5, 7.5, 4.5));
    keyNode.lookAt(GEM_CENTER);
    const keyLight = keyNode.addComponent(DirectionalLight);
    keyLight.color = new Color(255, 244, 224, 255); // 暖白主光
    keyLight.illuminance = 32000;

    const fillNode = new Node('FillLight');
    scene.addChild(fillNode);
    fillNode.layer = Layers.Enum.DEFAULT;
    fillNode.setPosition(new Vec3(5.8, 1.9, 3.6));
    const fillLight = fillNode.addComponent(SphereLight);
    fillLight.color = new Color(150, 190, 255, 255); // 冷色辅光
    fillLight.luminousFlux = 130;
    fillLight.range = 18;
    fillLight.size = 0.6;

    const rimNode = new Node('RimLight');
    scene.addChild(rimNode);
    rimNode.layer = Layers.Enum.DEFAULT;
    rimNode.setPosition(new Vec3(-1.6, 4.4, -4.6));
    const rimLight = rimNode.addComponent(SphereLight);
    rimLight.color = new Color(255, 246, 230, 255); // 逆光轮廓
    rimLight.luminousFlux = 190;
    rimLight.range = 16;
    rimLight.size = 0.4;

    // --- 自定义 effect 注册(需在 app/device 就绪后)---
    studioEffect = registerStudioEffect();

    // --- 宝石(程序化 128 面明亮式切工)---
    const gemNode = new Node('Gem');
    gemNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(gemNode);
    gemNode.setPosition(new Vec3(GEM_CENTER.x, 2.069, GEM_CENTER.z));
    const gemRenderer = gemNode.addComponent(MeshRenderer);
    gemRenderer.mesh = utils.MeshUtils.createMesh(buildGemGeometry());
    gemMaterial = studioMaterial(0, COLOR_PRESETS.diamond, [0.12, 1.0, 1.2, 0], [1, 0.20, 0, 0], 0);
    gemRenderer.material = gemMaterial;
    gemNode.addComponent(Turntable);

    // --- 展台(深色缎面圆台)+ 顶缘金属亮环 ---
    const podiumNode = new Node('Podium');
    podiumNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(podiumNode);
    podiumNode.setPosition(new Vec3(0, 0.43, 0));
    const podiumRenderer = podiumNode.addComponent(MeshRenderer);
    podiumRenderer.mesh = utils.MeshUtils.createMesh(
        primitives.cylinder(1.30, 1.42, 0.86, { radialSegments: 48 }),
    );
    podiumRenderer.material = studioMaterial(4, [1, 1, 1], [0.05, 1, 0.6, 0], [1, 0.2, 0, 0], 0);

    const ringNode = new Node('PodiumRing');
    ringNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(ringNode);
    ringNode.setPosition(new Vec3(0, 0.878, 0));
    // 金属亮环:真实 PBR 标准材质,直接受三点棚拍光照射(主光高光/辅光冷反/轮廓亮边)
    const ringRenderer = ringNode.addComponent(MeshRenderer);
    ringRenderer.mesh = utils.MeshUtils.createMesh(
        primitives.cylinder(1.44, 1.44, 0.035, { radialSegments: 48 }),
    );
    const ringMtl = builtinResMgr.get('builtin-standard-material');
    ringMtl.setProperty('mainColor', new Color(205, 210, 220, 255));
    ringMtl.setProperty('roughness', 0.25);
    ringMtl.setProperty('metallic', 1.0);
    ringRenderer.material = ringMtl;

    // --- 地面(接收灯池/接触阴影,远处融入背景)---
    const groundNode = new Node('Ground');
    groundNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(groundNode);
    groundNode.setPosition(new Vec3(0, 0, 3.5));
    const groundRenderer = groundNode.addComponent(MeshRenderer);
    groundRenderer.mesh = utils.MeshUtils.createMesh(primitives.plane({ width: 44, length: 26 }));
    groundRenderer.material = studioMaterial(2, [1, 1, 1], [0.05, 1, 0.6, 0], [1, 0.2, 0, 0], 1);

    // --- 背景幕(竖直渐变弧幕近似)---
    const backNode = new Node('Backdrop');
    backNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(backNode);
    backNode.setPosition(new Vec3(0, 5, -9));
    backNode.setRotationFromEuler(90, 0, 0);
    const backRenderer = backNode.addComponent(MeshRenderer);
    backRenderer.mesh = utils.MeshUtils.createMesh(primitives.plane({ width: 46, length: 18 }));
    backRenderer.material = studioMaterial(1, [1, 1, 1], [0.05, 1, 0.6, 0], [1, 0.20, 0, 0], 1);

    // --- 环境光(暗棚:低强度冷灰)---
    scene.globals.ambient.skyColorHDR.set(0.18, 0.20, 0.26, 1.0);
    scene.globals.ambient.skyIllum = 1200;

    window.__airApp = app;
    app.run(scene);

    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) window.__appReady = true;
    });

    buildUI();
    setupDblClick();
    console.log('[e09] jewelry studio running on cocosair');
} catch (err) {
    console.error('[e09] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
