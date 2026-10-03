/**
 * E09 gem-effect.js — 自定义 EffectAsset(真实屏幕空间折射 + 色散)。
 *
 * 背景(引擎事实,2026-10-02 源码核实):
 *   cocosair.js@1.0.0 的 air-gltf-physical 折射注入存在死代码缺陷 —— 片元里
 *   `airTrFactorTex`/`airThickTex` 声明为 0.0 后从未从 airTransmission uniform 赋值,
 *   `trF = clamp(0,0,1)` 恒 0 → KHR_materials_transmission 折射/色散瓣永不生效
 *   (src/air/assets/gltf/material/physical-effect.ts L170/L348;vendored tarball 同)。
 *   但两相机 scene-color 捕获管线(AirTransmissionCapture)本身工作正常:它按
 *   pass.defines.USE_AIR_TRANSMISSION 认领 renderer,把 RenderTexture 以
 *   `cc_sceneColorTex`、视口参数以 `airSceneColorInfo` 两个属性名绑定到渲染材质实例。
 *
 * 因此本场景走引擎 sanctioned 的自定义 EffectAsset 路径(examples/shader-custom-gradient
 * 同款注册方式):自定义 shader 声明同名 sampler/uniform + USE_AIR_TRANSMISSION define,
 * 即被 capture 自动认领,拿到真实离屏场景色 → 真实折射变形 + 三通道色散火彩。
 *
 * 绑定约定(同 examples/shared/shader-blocks):GLOBAL set0(CCGlobal:0/CCCamera:1)、
 * MATERIAL set1(Constants UBO binding 0,采样器从 binding 1 起)、LOCAL set2(CCLocal:0)。
 */

import { EffectAsset } from 'cocosair.js';

// ---------------------------------------------------------------------------
// UBO 块声明(成员布局与引擎同源;glsl4 带 layout,glsl3 由正则去 layout)
// ---------------------------------------------------------------------------

export const UBO_CC_GLOBAL = `highp   vec4 cc_time;
mediump vec4 cc_screenSize;
mediump vec4 cc_nativeSize;
mediump vec4 cc_debug_view_mode;`;

export const UBO_CC_CAMERA = `highp   mat4 cc_matView;
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
mediump vec4 cc_viewPort;`;

export const UBO_CC_LOCAL = `highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;`;

// ---------------------------------------------------------------------------
// 顶点:世界坐标 + 世界法线(平直切面法线,火彩/高光扫动的来源)
// ---------------------------------------------------------------------------

const VERT_BODY = `
in vec3 a_position;
in vec3 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main () {
    vec4 wp = cc_matWorld * vec4(a_position, 1.0);
    v_world = wp.xyz;
    v_normal = normalize(mat3(cc_matWorldIT) * a_normal);
    gl_Position = cc_matViewProj * wp;
}`;

// ---------------------------------------------------------------------------
// 片元主体(不含 uniform 声明——各语言变体包装层负责声明,避免重定义)
// ---------------------------------------------------------------------------

const FRAG_BODY = `
in vec3 v_world;
in vec3 v_normal;

// 世界坐标 → 场景色 RT 的屏幕 UV(Y 翻转规则与引擎 air-gltf-physical 一致)
vec2 sceneUV (vec3 world, out float flipY) {
    vec4 clip = cc_matViewProj * vec4(world, 1.0);
    vec2 uv = clip.xy / max(abs(clip.w), 1e-4) * 0.5 + 0.5;
    flipY = cc_cameraPos.w > 0.0 ? -1.0 : 1.0;
    return uv;
}

// 视线折射偏移(与引擎同式:折射角×厚度→RT UV 偏移)
vec2 refractOffset (vec3 N, vec3 V, float ior, float thick) {
    vec3 view = (cc_matView * vec4(v_world, 1.0)).xyz;
    vec3 base = mat3(cc_matView) * refract(-V, N, 1.0 / max(ior, 1.0001));
    return base.xy / max(abs(view.z), 1.0) * thick * 0.5;
}

float fresnel (float ior, float NV) {
    float f = (ior - 1.0) / (ior + 1.0);
    f = clamp(f * f, 0.0, 1.0);
    return clamp(f + (1.0 - f) * (1.0 - pow(NV, 5.0)), 0.0, 1.0);
}

void main () {
    vec3 N = normalize(v_normal);
    vec3 V = normalize(cc_cameraPos.xyz - v_world);
    float ior = max(gemParams.x, 1.05);
    float disp = max(gemParams.y, 0.0);
    float thick = max(gemParams.z, 0.05);
    float NV = clamp(dot(N, V), 0.0, 1.0);

    // 菲涅尔三通道(R/G/B 波长各自 IOR → 切面棱线彩虹缘)
    vec3 fres = vec3(
        fresnel(max(ior - disp, 1.02), NV),
        fresnel(ior, NV),
        fresnel(ior + disp, NV));

    // 折射体色:R/G/B 独立折射矢量采样离屏场景色 → 真实色散(火彩)
    float flipY;
    vec2 suv = sceneUV(v_world, flipY);
    vec2 texel = clamp(airSceneColorInfo.zw, vec2(1.0 / 2048.0), vec2(0.5));
    vec2 offG = refractOffset(N, V, ior, thick) * flipY;
    vec2 offR = refractOffset(N, V, max(ior - disp, 1.02), thick) * flipY;
    vec2 offB = refractOffset(N, V, ior + disp, thick) * flipY;
    vec2 uvG = clamp(suv + offG, texel, vec2(1.0) - texel);
    vec2 uvR = clamp(suv + offR, texel, vec2(1.0) - texel);
    vec2 uvB = clamp(suv + offB, texel, vec2(1.0) - texel);
    vec3 refr = vec3(
        texture(cc_sceneColorTex, uvR).r,
        texture(cc_sceneColorTex, uvG).g,
        texture(cc_sceneColorTex, uvB).b);

    // 体吸收色(JS 预混合:Beer-Lambert × mix 已在宿主算好,规避引擎 Vec4 更新丢第 4 分量的实测缺陷)
    vec3 tint = clamp(gemTint.rgb, vec3(0.0), vec3(1.0));
    vec3 body = refr * (tint * 0.82 + 0.18) * 2.6 + tint * 0.12; // 0.18 保底:彩色宝石仍保留折射流动

    // 三点棚拍镜面高光(Blinn-Phong 硬高光 + 宽裙边,随转台扫动)
    vec3 H;
    H = normalize(V + normalize(lightADir.xyz));
    float spA = pow(max(dot(N, H), 0.0), 260.0) + 0.16 * pow(max(dot(N, H), 0.0), 48.0);
    H = normalize(V + normalize(lightBDir.xyz));
    float spB = pow(max(dot(N, H), 0.0), 200.0) + 0.10 * pow(max(dot(N, H), 0.0), 40.0);
    H = normalize(V + normalize(lightCDir.xyz));
    float spC = pow(max(dot(N, H), 0.0), 320.0) + 0.20 * pow(max(dot(N, H), 0.0), 64.0);
    vec3 spec = lightAColor.rgb * spA + lightBColor.rgb * spB + lightCColor.rgb * spC;

    // 微弱漫射底(暗侧不死黑)
    float ndA = max(dot(N, normalize(lightADir.xyz)), 0.0);
    float ndB = max(dot(N, normalize(lightBDir.xyz)), 0.0);
    vec3 diffuse = (lightAColor.rgb * ndA + lightBColor.rgb * ndB) * 0.035;

    // 合成:折射体 + 菲涅尔白反射 + 镜面 + 顶部微光
    vec3 col = body * (1.0 - fres * 0.75)
        + fres * (vec3(0.30, 0.32, 0.36) + tint * 0.30)
        + spec * (0.55 + fres * 0.85)
        + diffuse * mix(vec3(1.0), sqrt(tint), 0.6);
    col += max(N.y, 0.0) * 0.035;
    col = pow(clamp(col, vec3(0.0), vec3(4.0)), vec3(0.9));
    cc_FragColor = vec4(col, 1.0);
}`;

// glsl4(带 layout;glsl3 = 去 layout)
const VERT_GLSL4 = `precision highp float;
layout(set = 0, binding = 0) uniform CCGlobal {
${UBO_CC_GLOBAL}
};
layout(set = 0, binding = 1) uniform CCCamera {
${UBO_CC_CAMERA}
};
layout(set = 2, binding = 0) uniform CCLocal {
${UBO_CC_LOCAL}
};${VERT_BODY}`;

const FRAG_GLSL4 = `precision highp float;
layout(set = 0, binding = 1) uniform CCCamera {
${UBO_CC_CAMERA}
};
layout(set = 1, binding = 0) uniform Constants {
  vec4 gemTint;
  vec4 gemParams;
  vec4 lightADir;
  vec4 lightAColor;
  vec4 lightBDir;
  vec4 lightBColor;
  vec4 lightCDir;
  vec4 lightCColor;
  vec4 airSceneColorInfo;
};
layout(set = 1, binding = 1) uniform sampler2D cc_sceneColorTex;
layout(location = 0) out vec4 cc_FragColor;${FRAG_BODY}`;

// glsl1(降写:texture→texture2D / cc_FragColor→gl_FragColor / in→varying)
const VERT_GLSL1 = `precision highp float;
${UBO_CC_CAMERA}
${UBO_CC_LOCAL}
attribute highp vec3 a_position;
attribute highp vec3 a_normal;
varying vec3 v_world;
varying vec3 v_normal;
void main () {
    vec4 wp = cc_matWorld * vec4(a_position, 1.0);
    v_world = wp.xyz;
    v_normal = normalize(mat3(cc_matWorldIT) * a_normal);
    gl_Position = cc_matViewProj * wp;
}`;

const FRAG_GLSL1_FULL = `precision highp float;
${UBO_CC_CAMERA}
uniform sampler2D cc_sceneColorTex;
uniform vec4 gemTint;
uniform vec4 gemParams;
uniform vec4 lightADir;
uniform vec4 lightAColor;
uniform vec4 lightBDir;
uniform vec4 lightBColor;
uniform vec4 lightCDir;
uniform vec4 lightCColor;
uniform vec4 airSceneColorInfo;
${FRAG_BODY
    .replace(/\bin vec3 /g, 'varying vec3 ')
    .replace(/texture\(/g, 'texture2D(')
    .replace(/cc_FragColor/g, 'gl_FragColor')}`;

const EFFECT_NAME = 'e09-gem';
const PROG = 'e09-gem|gem-vs:vert|gem-fs:frag';

const MEMBERS = [
    { name: 'gemTint', type: 16, count: 1 },
    { name: 'gemParams', type: 16, count: 1 },
    { name: 'lightADir', type: 16, count: 1 },
    { name: 'lightAColor', type: 16, count: 1 },
    { name: 'lightBDir', type: 16, count: 1 },
    { name: 'lightBColor', type: 16, count: 1 },
    { name: 'lightCDir', type: 16, count: 1 },
    { name: 'lightCColor', type: 16, count: 1 },
    { name: 'airSceneColorInfo', type: 16, count: 1 },
];

/** 注册并返回自定义宝石 EffectAsset(必须在 createAirApp 之后调用)。 */
export function buildGemEffect () {
    const json = {
        name: EFFECT_NAME,
        techniques: [
            {
                passes: [
                    {
                        program: PROG,
                        rasterizerState: { cullMode: 1 }, // BACK:封闭凸多面体
                        depthStencilState: { depthTest: true, depthWrite: true },
                        blendState: { targets: [{ blend: false }] },
                        properties: {
                            gemTint: { value: [1, 1, 1, 1], type: 16 },
                            gemParams: { value: [2.4, 0.18, 1.8, 5.0], type: 16 },
                            lightADir: { value: [0.5, 0.75, 0.55, 0], type: 16 },
                            lightAColor: { value: [1.0, 0.98, 0.92, 0], type: 16 },
                            lightBDir: { value: [-0.7, 0.5, 0.45, 0], type: 16 },
                            lightBColor: { value: [0.55, 0.62, 0.75, 0], type: 16 },
                            lightCDir: { value: [-0.25, 0.6, -0.85, 0], type: 16 },
                            lightCColor: { value: [0.95, 0.93, 1.0, 0], type: 16 },
                            airSceneColorInfo: { value: [1280, 720, 1 / 1280, 1 / 720], type: 16 },
                            cc_sceneColorTex: { value: 'black', type: 28 },
                        },
                    },
                ],
            },
        ],
        shaders: [
            {
                name: PROG,
                hash: 790231,
                builtins: {
                    statistics: {
                        CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 47,
                        CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 4 + MEMBERS.length + 4,
                    },
                    globals: {
                        blocks: [
                            { name: 'CCGlobal', defines: [], set: 0, binding: 0 },
                            { name: 'CCCamera', defines: [], set: 0, binding: 1 },
                        ],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                    locals: {
                        blocks: [{ name: 'CCLocal', defines: [], set: 2, binding: 0 }],
                        samplerTextures: [],
                        buffers: [],
                        images: [],
                    },
                },
                defines: [{ name: 'USE_AIR_TRANSMISSION', type: 'boolean' }],
                attributes: [
                    { name: 'a_position', defines: [], format: 32, location: 0 },
                    { name: 'a_normal', defines: [], format: 32, location: 1 },
                ],
                blocks: [
                    { name: 'Constants', defines: [], binding: 0, stageFlags: 16, members: MEMBERS },
                ],
                samplerTextures: [
                    { name: 'cc_sceneColorTex', type: 28, count: 1, defines: [], stageFlags: 16, set: 1, binding: 1 },
                ],
                buffers: [],
                images: [],
                textures: [],
                samplers: [],
                subpassInputs: [],
            },
        ],
        combinations: [],
        hideInEditor: false,
    };

    const effect = Object.assign(new EffectAsset(), json);
    effect.shaders[0].glsl4 = { vert: VERT_GLSL4, frag: FRAG_GLSL4 };
    effect.shaders[0].glsl3 = {
        vert: VERT_GLSL4.replace(/layout\s*\([^)]*\)\s*/g, ''),
        frag: FRAG_GLSL4.replace(/layout\s*\([^)]*\)\s*/g, ''),
    };
    effect.shaders[0].glsl1 = { vert: VERT_GLSL1, frag: FRAG_GLSL1_FULL };
    effect.onLoaded(); // programLib.register(必须在 createAirApp 之后)
    return effect;
}
