/**
 * E02 — 落日海面与孤舟(Cocos AIR Reference 实现,Asset-Driven)
 *
 * 正统 Code First 写法(以 examples/hello-cube / gltf-basic / shader-custom-gradient /
 * docs/manual/custom-buffergeometry.md 为准):
 *   createAirApp({ canvas }) → Scene → Camera/DirectionalLight/MeshRenderer → app.run(scene)
 *   引擎经 index.html import map 从 /dist/vendor/cocosair.module.js 加载(build.mjs external)。
 *
 * 实现结构:
 *   - 天空穹:primitives.sphere + 自定义 EffectAsset(GLSL 三变体)渐变天穹 + 日/月光盘与光晕;
 *   - 海面:手写 IGeometry 非均匀细分网格(110x110,12321 顶点 >= 2000)→ utils.createMesh,
 *     顶点着色器做 3 波分量叠加位移(重力波相位推进),片元做 Fresnel/镜面高光带/远距雾化;
 *     AIR 未暴露"就地改写顶点缓冲"API(docs/manual/custom-buffergeometry.md §2),
 *     故动态海面走 shader 通道位移 —— 引擎自定义着色器 glsl4/3/1 三变体正典路径;
 *   - 孤舟:GLTFLoader.loadAsync('assets/boat.glb') 真实网络请求 → instantiate → 挂场景,
 *     材质/层级保留(6 部件 6 材质);JS 侧以与 GLSL 完全相同的波形函数采样相位耦合起伏;
 *   - 相机:鼠标水平拖拽环绕(速度受限的逐帧平滑追踪,无跳变);
 *   - 色调:toneMix 0(落日暖)↔1(暮蓝冷),1.9s smoothstep 过渡,驱动天空/海面/主光/环境光;
 *   - reset:释放并重建 —— boat instance.dispose + asset.destroy、海/天 mesh.destroy +
 *     material.destroy(GPU 侧显式释放),随后重建网格与材质并重新加载 GLB,epoch+1。
 *
 * 页面契约:
 *   window.__appReady(资产加载完成且首帧渲染后 true);
 *   window.__bench = { getState, reset }。
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
    EffectAsset,
    utils,
    primitives,
    GLTFLoader,
    Component,
    Vec3,
    Vec4,
    Color,
    director,
    Director,
    input,
    Input,
} from 'cocosair.js';

// ============================================================================
// 1. 波形参数(JS 与 GLSL 同源:uniform 下发,JS 侧用同一常量采样)
// ============================================================================

const WAVES = [
    { dir: [0.8827, 0.47], amp: 0.16, k: 0.9, speed: 1.15 },
    { dir: [0.8344, -0.5511], amp: 0.09, k: 1.7, speed: 1.6 },
    { dir: [0.9511, 0.309], amp: 0.05, k: 3.1, speed: 2.3 },
].map((w) => {
    const len = Math.hypot(w.dir[0], w.dir[1]);
    return { dir: [w.dir[0] / len, w.dir[1] / len], amp: w.amp, k: w.k, speed: w.speed };
});

/** 海面高度 h(x,z,t):与顶点着色器完全一致的波形函数(相位耦合来源)。 */
function waveHeight(x, z, t) {
    let h = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        h += w.amp * Math.sin((w.dir[0] * x + w.dir[1] * z) * w.k + t * w.speed);
    }
    return h;
}

/** 海面坡度(解析偏导),用于船体纵摇/横摇。 */
function waveSlope(x, z, t) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i];
        const c = Math.cos((w.dir[0] * x + w.dir[1] * z) * w.k + t * w.speed) * w.amp * w.k;
        dx += c * w.dir[0];
        dz += c * w.dir[1];
    }
    return [dx, dz];
}

// ============================================================================
// 2. 色调调色板(toneMix 0=落日暖,1=暮蓝冷;线性域着色器值)
// ============================================================================

const SUN_DIR = (() => {
    // 太阳/月亮方位 203°、仰角 4°(初始相机方位 35°、视线方位 215° → 位于画面中轴偏右侧、贴近海平线)
    const az = (203 * Math.PI) / 180;
    const el = (4 * Math.PI) / 180;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
})();

const PALETTE_WARM = {
    zenith: [0.055, 0.075, 0.24],
    horizon: [1.15, 0.44, 0.16],
    haze: [0.48, 0.26, 0.16],
    seaDeep: [0.012, 0.052, 0.105],
    seaCrest: [0.11, 0.26, 0.33],
    sun: [1.45, 0.83, 0.42],
    disc: [0.9994, 0.99987, 55, 0.85], // cosOuter, cosInner, glowPow, glowStr
    ambient: [0.95, 0.45, 0.22],
    ambientIllum: 20000,
    lightColor: [255, 168, 88],
    lightIllum: 36000,
};

const PALETTE_COLD = {
    zenith: [0.018, 0.05, 0.15],
    horizon: [0.18, 0.3, 0.62],
    haze: [0.06, 0.11, 0.24],
    seaDeep: [0.006, 0.02, 0.07],
    seaCrest: [0.05, 0.13, 0.27],
    sun: [0.85, 0.95, 1.15],
    disc: [0.99975, 0.99994, 180, 0.45],
    ambient: [0.24, 0.33, 0.58],
    ambientIllum: 8500,
    lightColor: [140, 178, 255],
    lightIllum: 15000,
};

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function mix3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function mix4(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

// ============================================================================
// 3. 自定义着色器(GLSL 三变体;块声明与 examples/shared/shader-blocks.js 同源)
// ============================================================================

const UBO_CC_GLOBAL_4 = `layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};`;

const UBO_CC_CAMERA_4 = `layout(set = 0, binding = 1) uniform CCCamera {
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

const UBO_CC_LOCAL_4 = `layout(set = 2, binding = 0) uniform CCLocal {
  highp mat4 cc_matWorld;
  highp mat4 cc_matWorldIT;
  highp vec4 cc_lightingMapUVParam;
  highp vec4 cc_localShadowBias;
};`;

const UBO_CC_CAMERA_1 = `uniform highp mat4 cc_matView;
uniform highp mat4 cc_matViewInv;
uniform highp mat4 cc_matProj;
uniform highp mat4 cc_matProjInv;
uniform highp mat4 cc_matViewProj;
uniform highp mat4 cc_matViewProjInv;
uniform highp vec4 cc_cameraPos;
uniform mediump vec4 cc_surfaceTransform;
uniform mediump vec4 cc_screenScale;
uniform mediump vec4 cc_exposure;
uniform mediump vec4 cc_mainLitDir;
uniform mediump vec4 cc_mainLitColor;
uniform mediump vec4 cc_ambientSky;
uniform mediump vec4 cc_ambientGround;
uniform mediump vec4 cc_fogColor;
uniform mediump vec4 cc_fogBase;
uniform mediump vec4 cc_fogAdd;
uniform mediump vec4 cc_nearFar;
uniform mediump vec4 cc_viewPort;`;

const UBO_CC_LOCAL_1 = `uniform highp mat4 cc_matWorld;
uniform highp mat4 cc_matWorldIT;
uniform highp vec4 cc_lightingMapUVParam;
uniform highp vec4 cc_localShadowBias;`;

const stripLayout = (src) => src.replace(/layout\s*\([^)]*\)\s*/g, '');

// ---- Constants 块成员(vec4 在前、float 在尾,与 effect JSON members 顺序一致) ----
const SEA_MEMBERS = [
    { name: 'u_waveAmp', type: 16, count: 1 },
    { name: 'u_waveK', type: 16, count: 1 },
    { name: 'u_waveSpd', type: 16, count: 1 },
    { name: 'u_dir1', type: 16, count: 1 },
    { name: 'u_dir2', type: 16, count: 1 },
    { name: 'u_dir3', type: 16, count: 1 },
    { name: 'u_sunDir', type: 16, count: 1 },
    { name: 'u_seaDeep', type: 16, count: 1 },
    { name: 'u_seaCrest', type: 16, count: 1 },
    { name: 'u_horizon', type: 16, count: 1 },
    { name: 'u_sunColor', type: 16, count: 1 },
    { name: 'u_specParams', type: 16, count: 1 },
    { name: 'u_fade', type: 16, count: 1 },
    { name: 'u_time', type: 13, count: 1 },
];

const SKY_MEMBERS = [
    { name: 'u_sunDir', type: 16, count: 1 },
    { name: 'u_zenith', type: 16, count: 1 },
    { name: 'u_horizon', type: 16, count: 1 },
    { name: 'u_haze', type: 16, count: 1 },
    { name: 'u_sunColor', type: 16, count: 1 },
    { name: 'u_discParams', type: 16, count: 1 },
    { name: 'u_time', type: 13, count: 1 },
];

function membersToGLSL4(members) {
    return members
        .map((m) => (m.type === 16 ? `  mediump vec4 ${m.name};` : `  highp float ${m.name};`))
        .join('\n');
}

function membersToGLSL1(members) {
    return members
        .map((m) => (m.type === 16 ? `uniform mediump vec4 ${m.name};` : `uniform highp float ${m.name};`))
        .join('\n');
}

// ---- 海面顶点:3 波分量位移 + 解析法线(相位由 u_time 推进 → 波峰沿风向行进) ----
const SEA_VERT_BODY = `
vec2 p = a_position.xz;
float ph1 = dot(u_dir1.xy, p) * u_waveK.x + u_time * u_waveSpd.x;
float ph2 = dot(u_dir2.xy, p) * u_waveK.y + u_time * u_waveSpd.y;
float ph3 = dot(u_dir3.xy, p) * u_waveK.z + u_time * u_waveSpd.z;
float h = u_waveAmp.x * sin(ph1) + u_waveAmp.y * sin(ph2) + u_waveAmp.z * sin(ph3);
float dhx = u_waveAmp.x * u_waveK.x * u_dir1.x * cos(ph1)
          + u_waveAmp.y * u_waveK.y * u_dir2.x * cos(ph2)
          + u_waveAmp.z * u_waveK.z * u_dir3.x * cos(ph3);
float dhz = u_waveAmp.x * u_waveK.x * u_dir1.y * cos(ph1)
          + u_waveAmp.y * u_waveK.y * u_dir2.y * cos(ph2)
          + u_waveAmp.z * u_waveK.z * u_dir3.y * cos(ph3);
vec3 pos = vec3(a_position.x, a_position.y + h, a_position.z);
vec4 wp = cc_matWorld * vec4(pos, 1.0);
v_worldPos = wp.xyz;
v_normal = normalize(vec3(-dhx, 1.0, -dhz));
v_h = h;
gl_Position = cc_matViewProj * wp;
`;

const SEA_VERT_4 = `precision highp float;
${UBO_CC_GLOBAL_4}
${UBO_CC_CAMERA_4}
${UBO_CC_LOCAL_4}
layout(set = 1, binding = 0) uniform Constants {
${membersToGLSL4(SEA_MEMBERS)}
};
in vec3 a_position;
in vec2 a_texCoord;
out highp vec3 v_worldPos;
out mediump vec3 v_normal;
out mediump float v_h;
void main () {${SEA_VERT_BODY}}`;

const SEA_VERT_1 = `precision highp float;
${UBO_CC_CAMERA_1}
${UBO_CC_LOCAL_1}
${membersToGLSL1(SEA_MEMBERS)}
attribute highp vec3 a_position;
attribute mediump vec2 a_texCoord;
varying highp vec3 v_worldPos;
varying mediump vec3 v_normal;
varying mediump float v_h;
void main () {${SEA_VERT_BODY}}`;

// ---- 海面片元:Fresnel 天光反射 + 日光镜面高光带 + 浪峰透光 + 远距雾化 ----
const SEA_FRAG_BODY = `
vec3 N = normalize(v_normal);
N.x += 0.045 * sin(v_worldPos.x * 5.7 + u_time * 2.6);
N.z += 0.045 * sin(v_worldPos.z * 4.9 + u_time * 2.2 + 1.7);
N = normalize(N);
vec3 V = normalize(cc_cameraPos.xyz - v_worldPos);
float fres = pow(1.0 - max(dot(N, V), 0.0), u_specParams.z);
float hN = clamp(v_h * 2.4 + 0.5, 0.0, 1.0);
vec3 col = mix(u_seaDeep.rgb, u_seaCrest.rgb, hN);
col = mix(col, u_horizon.rgb * 0.8, clamp(fres * 0.85, 0.0, 0.85));
vec3 R = reflect(-V, N);
float sd = max(dot(R, u_sunDir.xyz), 0.0);
float spec = pow(sd, u_specParams.x) * 0.5 + pow(sd, u_specParams.x * 6.0) * u_specParams.y;
col += u_sunColor.rgb * spec;
col += u_sunColor.rgb * max(v_h, 0.0) * u_specParams.w;
float dist = length(cc_cameraPos.xyz - v_worldPos);
col = mix(col, u_horizon.rgb, smoothstep(u_fade.x, u_fade.y, dist));
cc_FragColor = vec4(col, 1.0);
`;

const SEA_FRAG_4 = `precision mediump float;
${UBO_CC_CAMERA_4}
layout(set = 1, binding = 0) uniform Constants {
${membersToGLSL4(SEA_MEMBERS)}
};
in highp vec3 v_worldPos;
in mediump vec3 v_normal;
in mediump float v_h;
layout(location = 0) out vec4 cc_FragColor;
void main () {${SEA_FRAG_BODY}}`;

const SEA_FRAG_1 = `precision mediump float;
uniform highp vec4 cc_cameraPos;
${membersToGLSL1(SEA_MEMBERS)}
varying highp vec3 v_worldPos;
varying mediump vec3 v_normal;
varying mediump float v_h;
void main () {${SEA_FRAG_BODY.replace(/cc_FragColor/g, 'gl_FragColor')}}`;

// ---- 天空穹:方向渐变 + 日/月光盘(smoothstep 边缘)与光晕 ----
const SKY_VERT_BODY = `
vec4 wp = cc_matWorld * vec4(a_position, 1.0);
v_worldPos = wp.xyz;
gl_Position = cc_matViewProj * wp;
`;

const SKY_VERT_4 = `precision highp float;
${UBO_CC_GLOBAL_4}
${UBO_CC_CAMERA_4}
${UBO_CC_LOCAL_4}
layout(set = 1, binding = 0) uniform Constants {
${membersToGLSL4(SKY_MEMBERS)}
};
in vec3 a_position;
in vec2 a_texCoord;
out highp vec3 v_worldPos;
void main () {${SKY_VERT_BODY}}`;

const SKY_VERT_1 = `precision highp float;
${UBO_CC_CAMERA_1}
${UBO_CC_LOCAL_1}
${membersToGLSL1(SKY_MEMBERS)}
attribute highp vec3 a_position;
attribute mediump vec2 a_texCoord;
varying highp vec3 v_worldPos;
void main () {${SKY_VERT_BODY}}`;

const SKY_FRAG_BODY = `
vec3 dir = normalize(v_worldPos - cc_cameraPos.xyz);
float t = clamp(dir.y * 1.15 + 0.06, 0.0, 1.0);
vec3 col = mix(u_horizon.rgb, u_zenith.rgb, pow(t, 0.58));
col = mix(col, u_haze.rgb, clamp(-dir.y * 8.0, 0.0, 1.0));
float d = dot(dir, u_sunDir.xyz);
float disc = smoothstep(u_discParams.x, u_discParams.y, d);
float glow = pow(max(d, 0.0), u_discParams.z) * u_discParams.w;
col += u_sunColor.rgb * (disc * 1.15 + glow);
cc_FragColor = vec4(col, 1.0);
`;

const SKY_FRAG_4 = `precision mediump float;
${UBO_CC_CAMERA_4}
layout(set = 1, binding = 0) uniform Constants {
${membersToGLSL4(SKY_MEMBERS)}
};
in highp vec3 v_worldPos;
layout(location = 0) out vec4 cc_FragColor;
void main () {${SKY_FRAG_BODY}}`;

const SKY_FRAG_1 = `precision mediump float;
uniform highp vec4 cc_cameraPos;
${membersToGLSL1(SKY_MEMBERS)}
varying highp vec3 v_worldPos;
void main () {${SKY_FRAG_BODY.replace(/cc_FragColor/g, 'gl_FragColor')}}`;

/** 与 examples/shared/shader-blocks.js makeUserEffectJson 同构的 effect JSON 骨架。 */
function makeEffectJson(opts) {
    const members = opts.members;
    const properties = {};
    for (const [name, value] of Object.entries(opts.defaults)) {
        properties[name] = { value, type: value.length === 1 ? 13 : 16 };
    }
    return {
        name: opts.name,
        techniques: [
            {
                passes: [
                    {
                        program: opts.prog,
                        rasterizerState: { cullMode: 0 },
                        depthStencilState: { depthTest: true, depthWrite: opts.depthWrite },
                        blendState: { targets: [{ blend: false }] },
                        properties,
                    },
                ],
            },
        ],
        shaders: [
            {
                name: opts.prog,
                hash: opts.hash,
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
                defines: [],
                attributes: [
                    { name: 'a_position', defines: [], format: 32, location: 0 },
                    { name: 'a_texCoord', defines: [], format: 21, location: 2 },
                ],
                blocks: [
                    {
                        name: 'Constants',
                        defines: [],
                        binding: 0,
                        stageFlags: 17, // VERTEX | FRAGMENT
                        members,
                    },
                ],
                samplerTextures: [],
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
}

function registerEffect(name, json, glsl4Vert, glsl4Frag, glsl1Vert, glsl1Frag) {
    const effect = Object.assign(new EffectAsset(), json);
    effect.shaders[0].glsl4 = { vert: glsl4Vert, frag: glsl4Frag };
    effect.shaders[0].glsl3 = { vert: stripLayout(glsl4Vert), frag: stripLayout(glsl4Frag) };
    effect.shaders[0].glsl1 = { vert: glsl1Vert, frag: glsl1Frag };
    effect.onLoaded(); // programLib.register + EffectAsset.register(必须在 createAirApp 之后,GAP-B1)
    EffectAsset.register(effect);
    return effect;
}

// ============================================================================
// 4. 海面几何(非均匀细分:中心密、边缘疏;12321 顶点 >= 2000)
// ============================================================================

const SEA_SEG = 110;
const SEA_HALF = 55;
const SEA_VERTICES = (SEA_SEG + 1) * (SEA_SEG + 1);

function buildSeaGeometry() {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const n = SEA_SEG + 1;
    for (let j = 0; j <= SEA_SEG; j++) {
        const tz = -1 + (2 * j) / SEA_SEG;
        const z = SEA_HALF * tz * Math.abs(tz); // 符号平方:近中心加密
        for (let i = 0; i <= SEA_SEG; i++) {
            const tx = -1 + (2 * i) / SEA_SEG;
            const x = SEA_HALF * tx * Math.abs(tx);
            positions.push(x, 0, z);
            normals.push(0, 1, 0); // 真实法线由顶点着色器解析计算
            uvs.push(i / SEA_SEG, j / SEA_SEG);
        }
    }
    for (let j = 0; j < SEA_SEG; j++) {
        for (let i = 0; i < SEA_SEG; i++) {
            const a = j * n + i;
            const b = a + 1;
            const c = a + n;
            const d = c + 1;
            indices.push(a, c, b, b, c, d); // 绕序同 primitives.plane(正面朝上)
        }
    }
    return {
        positions,
        normals,
        uvs,
        indices,
        minPos: new Vec3(-SEA_HALF, -1.6, -SEA_HALF), // 包围盒覆盖位移幅度(剔除安全)
        maxPos: new Vec3(SEA_HALF, 1.6, SEA_HALF),
    };
}

// ============================================================================
// 5. 运行时状态
// ============================================================================

const S = {
    simTime: 0,
    toneMix: 0,
    toneTarget: 0,
    toneFrom: 0,
    toneT: 1, // 过渡进度(1 = 已完成)
    toneDuration: 1.9,
    camAz: 35,
    camAzTarget: 35,
    camEl: 10.5,
    camElTarget: 10.5,
    camDist: 9.5,
    lookY: 0.85,
    boatHeading: 25,
    boatLift: 0.8, // 船体包围盒中心高出静水面
    assetLoaded: false,
    assetRequests: 0,
    epoch: 0,
    fps: 0,
    // 场景对象(reset 时释放重建)
    seaNode: null,
    seaMesh: null,
    seaMat: null, // 共享材质资产(销毁对象)
    seaLive: null, // renderer.material 读回实例(运行期 setProperty 正典路径)
    skyNode: null,
    skyMesh: null,
    skyMat: null,
    skyLive: null,
    boatParent: null,
    boatAsset: null,
    boatInstance: null,
    boatCenter: new Vec3(0, 0.8, 0),
};

// 复用对象(避免每帧分配)
const scratchVec3a = new Vec3();
const scratchVec3b = new Vec3();
const scratchVec4 = new Vec4();
const scratchColor = new Color();

window.__appReady = false;

function getState() {
    const by = waveHeight(0, 0, S.simTime) + S.boatLift;
    return {
        engine: 'cocosair',
        assetLoaded: S.assetLoaded,
        assetRequests: S.assetRequests,
        boatPosition: { x: 0, y: Math.round(by * 1000) / 1000, z: 0 },
        wavePhase: Math.round(S.simTime * 1000) / 1000,
        toneMix: Math.round(S.toneMix * 1000) / 1000,
        cameraAzimuth: Math.round(S.camAz * 100) / 100,
        fps: S.fps,
        epoch: S.epoch,
        resetCount: S.epoch,
        seaVertices: SEA_VERTICES,
    };
}

function doReset() {
    S.epoch += 1;
    releaseSceneContent();
    // 恢复初始状态
    S.simTime = 0;
    S.toneMix = 0;
    S.toneTarget = 0;
    S.toneFrom = 0;
    S.toneT = 1;
    S.camAz = 35;
    S.camAzTarget = 35;
    S.camEl = 10.5;
    S.camElTarget = 10.5;
    if (ui.toneBtn) ui.toneBtn.textContent = 'Tone: Warm → Cold';
    // 重建(海/天同步重建;船异步重新加载 → assetRequests 递增)
    buildSea();
    buildSky();
    applyTone(0);
    loadBoat();
}

window.__bench = { getState, reset: doReset };

// ============================================================================
// 6. UI 覆盖层(色调切换 / Reset / 加载与错误提示)
// ============================================================================

const ui = {};

function buildUI() {
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;top:10px;left:10px;z-index:9999;display:flex;gap:8px;align-items:center;';

    const toneBtn = document.createElement('button');
    toneBtn.setAttribute('data-ui', 'tone-toggle');
    toneBtn.setAttribute('aria-label', 'tone toggle: sunset warm / dusk cold');
    toneBtn.style.cssText =
        'padding:6px 14px;background:rgba(30,20,10,0.72);color:#ffd9a0;' +
        "border:1px solid #a9743a;border-radius:6px;cursor:pointer;font:13px sans-serif;";
    toneBtn.textContent = 'Tone: Warm → Cold';
    toneBtn.addEventListener('click', () => {
        S.toneFrom = S.toneMix;
        S.toneTarget = S.toneTarget >= 0.5 ? 0 : 1;
        S.toneT = 0;
        toneBtn.textContent = S.toneTarget >= 0.5 ? 'Tone: Cold → Warm' : 'Tone: Warm → Cold';
    });
    bar.appendChild(toneBtn);

    const resetBtn = document.createElement('button');
    resetBtn.setAttribute('data-ui', 'reset');
    resetBtn.setAttribute('aria-label', 'reset scene');
    resetBtn.style.cssText =
        'padding:6px 14px;background:rgba(20,24,34,0.72);color:#cfe0ff;' +
        "border:1px solid #4a5a7a;border-radius:6px;cursor:pointer;font:13px sans-serif;";
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => doReset());
    bar.appendChild(resetBtn);

    document.body.appendChild(bar);
    ui.toneBtn = toneBtn;

    const status = document.createElement('div');
    status.style.cssText =
        'position:fixed;bottom:10px;left:10px;z-index:9999;color:#e8eef7;' +
        'background:rgba(10,16,26,0.7);padding:4px 10px;border-radius:4px;' +
        "font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;";
    status.textContent = 'Loading assets/boat.glb …';
    document.body.appendChild(status);
    ui.status = status;
    ui.statusTimer = 0;
}

function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
}

// ============================================================================
// 7. 相机输入(引擎 input 系统,同 examples/input 拖拽范式;方向一致:右拖方位角递增)
//    注:引擎 pal 层对 canvas 鼠标事件 stopPropagation(src/pal/input/web/mouse-input.js),
//    DOM window 监听收不到 mousemove —— 必须走 input.on(Input.EventType.*)。
// ============================================================================

function installCameraInput() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const dpr = () => window.devicePixelRatio || 1;
    input.on(Input.EventType.TOUCH_START, (event) => {
        dragging = true;
        const loc = event.getLocation();
        lastX = loc.x;
        lastY = loc.y;
    });
    input.on(Input.EventType.TOUCH_MOVE, (event) => {
        if (!dragging) return;
        const loc = event.getLocation();
        const d = dpr();
        const dx = (loc.x - lastX) / d; // CSS 像素
        const dy = (loc.y - lastY) / d; // 引擎 y 轴向上
        lastX = loc.x;
        lastY = loc.y;
        S.camAzTarget += dx * 1.15; // 度/CSS 像素
        S.camElTarget = Math.min(30, Math.max(3, S.camElTarget + dy * 0.1));
    });
    const stop = () => {
        dragging = false;
    };
    input.on(Input.EventType.TOUCH_END, stop);
    input.on(Input.EventType.TOUCH_CANCEL, stop);
}

// ============================================================================
// 8. 场景构建 / 释放(reset 语义:释放并重建,GPU 侧显式释放)
// ============================================================================

let scene = null;
let cameraNode = null;
let light = null;
let gltfLoader = null;

function buildSea() {
    S.seaMesh = utils.createMesh(buildSeaGeometry());
    S.seaNode = new Node('Sea');
    S.seaNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(S.seaNode);
    const renderer = S.seaNode.addComponent(MeshRenderer);
    renderer.mesh = S.seaMesh;
    S.seaMat = new Material();
    S.seaMat.initialize({ effectAsset: EffectAsset.get('bench-e02-sea') });
    renderer.setSharedMaterial(S.seaMat, 0);
    S.seaLive = renderer.material; // 读回实例:运行期 uniform 一律走它(正典教训)
    applySeaStaticUniforms(S.seaLive);
}

function buildSky() {
    S.skyMesh = utils.createMesh(primitives.sphere(420, { segments: 48 }));
    S.skyNode = new Node('SkyDome');
    S.skyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(S.skyNode);
    const renderer = S.skyNode.addComponent(MeshRenderer);
    renderer.mesh = S.skyMesh;
    S.skyMat = new Material();
    S.skyMat.initialize({ effectAsset: EffectAsset.get('bench-e02-sky') });
    renderer.setSharedMaterial(S.skyMat, 0);
    S.skyLive = renderer.material;
    S.skyLive.setProperty('u_sunDir', scratchVec4.set(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2], 0));
}

function applySeaStaticUniforms(m) {
    m.setProperty('u_waveAmp', scratchVec4.set(WAVES[0].amp, WAVES[1].amp, WAVES[2].amp, 0));
    m.setProperty('u_waveK', scratchVec4.set(WAVES[0].k, WAVES[1].k, WAVES[2].k, 0));
    m.setProperty('u_waveSpd', scratchVec4.set(WAVES[0].speed, WAVES[1].speed, WAVES[2].speed, 0));
    m.setProperty('u_dir1', scratchVec4.set(WAVES[0].dir[0], WAVES[0].dir[1], 0, 0));
    m.setProperty('u_dir2', scratchVec4.set(WAVES[1].dir[0], WAVES[1].dir[1], 0, 0));
    m.setProperty('u_dir3', scratchVec4.set(WAVES[2].dir[0], WAVES[2].dir[1], 0, 0));
    m.setProperty('u_sunDir', scratchVec4.set(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2], 0));
    m.setProperty('u_specParams', scratchVec4.set(110, 1.2, 3.0, 0.1));
    m.setProperty('u_fade', scratchVec4.set(16, 50, 0, 0));
}

/** 释放渲染内容(船 + 海 + 天;mesh.destroy 销毁 GPU 侧缓冲,material.destroy 销毁 pass)。 */
function releaseSceneContent() {
    if (S.boatInstance) {
        try {
            S.boatInstance.dispose();
        } catch (e) {
            /* 已销毁则忽略 */
        }
        S.boatInstance = null;
    }
    if (S.boatAsset) {
        try {
            S.boatAsset.destroy();
        } catch (e) {
            /* ignore */
        }
        S.boatAsset = null;
    }
    if (S.boatParent && S.boatParent.isValid) {
        S.boatParent.removeFromParent();
        S.boatParent.destroy();
        S.boatParent = null;
    }
    S.assetLoaded = false;

    for (const kind of ['sea', 'sky']) {
        const node = S[kind + 'Node'];
        const mesh = S[kind + 'Mesh'];
        const mat = S[kind + 'Mat'];
        if (node && node.isValid) {
            node.removeFromParent();
            node.destroy();
        }
        if (mesh && mesh.isValid) {
            try {
                mesh.destroy(); // 显式释放 GPU 缓冲(renderingSubMeshes)
            } catch (e) {
                /* ignore */
            }
        }
        if (mat && mat.isValid) {
            try {
                mat.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        S[kind + 'Node'] = null;
        S[kind + 'Mesh'] = null;
        S[kind + 'Mat'] = null;
        S[kind + 'Live'] = null;
    }
}

async function loadBoat() {
    const gen = S.epoch;
    // 首次(epoch 0)用纯净 URL(对齐网络证据);重建时带 reset 查询串强制真实重新请求
    const url = S.epoch > 0 ? 'assets/boat.glb?reset=' + S.epoch : 'assets/boat.glb';
    setStatus('Loading assets/boat.glb … (epoch ' + S.epoch + ')');
    try {
        const asset = await gltfLoader.loadAsync(url);
        if (gen !== S.epoch) {
            // 已被更新的 reset 取代:立即释放过期资产
            try {
                asset.destroy();
            } catch (e) {
                /* ignore */
            }
            return;
        }
        const instance = asset.instantiate();
        scene.addChild(instance.root);

        // 包围盒中心(gltf-viewer 同款:mesh struct 角点经 worldMatrix 变换)
        const min = scratchVec3a.set(Infinity, Infinity, Infinity);
        const max = scratchVec3b.set(-Infinity, -Infinity, -Infinity);
        const corner = new Vec3();
        for (const renderer of instance.root.getComponentsInChildren(MeshRenderer)) {
            const b = renderer.mesh.struct;
            if (!b.minPosition || !b.maxPosition) continue;
            for (let c = 0; c < 8; c++) {
                corner.set(
                    c & 1 ? b.maxPosition.x : b.minPosition.x,
                    c & 2 ? b.maxPosition.y : b.minPosition.y,
                    c & 4 ? b.maxPosition.z : b.minPosition.z,
                );
                Vec3.transformMat4(corner, corner, renderer.node.worldMatrix);
                Vec3.min(min, min, corner);
                Vec3.max(max, max, corner);
            }
        }
        if (Number.isFinite(min.x)) {
            S.boatCenter.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        }

        S.boatParent = new Node('Boat');
        scene.addChild(S.boatParent);
        instance.root.removeFromParent();
        S.boatParent.addChild(instance.root);
        // 包围盒中心对齐父节点原点 → boatPosition 即包围盒中心世界坐标
        instance.root.setPosition(-S.boatCenter.x, -S.boatCenter.y, -S.boatCenter.z);

        S.boatAsset = asset;
        S.boatInstance = instance;
        S.assetLoaded = true;
        S.assetRequests += 1; // 完成加载的请求计数
        setStatus('boat.glb loaded (' + S.assetRequests + ' request(s)) · sea ' + SEA_VERTICES + ' verts · epoch ' + S.epoch);
    } catch (err) {
        // 资产加载失败:可见错误提示,不产生未捕获异常(brief §4)
        setStatus('[error] failed to load assets/boat.glb: ' + (err && err.message ? err.message : err));
        S.assetLoaded = false;
    }
}

// ============================================================================
// 9. 色调应用(toneMix → 天空/海面/主光/环境光统一插值)
// ============================================================================

function applyTone(mix) {
    const w = PALETTE_WARM;
    const c = PALETTE_COLD;

    if (S.seaLive) {
        const deep = mix3(w.seaDeep, c.seaDeep, mix);
        S.seaLive.setProperty('u_seaDeep', scratchVec4.set(deep[0], deep[1], deep[2], 1));
        const crest = mix3(w.seaCrest, c.seaCrest, mix);
        S.seaLive.setProperty('u_seaCrest', scratchVec4.set(crest[0], crest[1], crest[2], 1));
        const hor = mix3(w.horizon, c.horizon, mix);
        S.seaLive.setProperty('u_horizon', scratchVec4.set(hor[0], hor[1], hor[2], 1));
        const sun = mix3(w.sun, c.sun, mix);
        S.seaLive.setProperty('u_sunColor', scratchVec4.set(sun[0], sun[1], sun[2], 1));
    }
    if (S.skyLive) {
        const zen = mix3(w.zenith, c.zenith, mix);
        S.skyLive.setProperty('u_zenith', scratchVec4.set(zen[0], zen[1], zen[2], 1));
        const hor = mix3(w.horizon, c.horizon, mix);
        S.skyLive.setProperty('u_horizon', scratchVec4.set(hor[0], hor[1], hor[2], 1));
        const haze = mix3(w.haze, c.haze, mix);
        S.skyLive.setProperty('u_haze', scratchVec4.set(haze[0], haze[1], haze[2], 1));
        const sun = mix3(w.sun, c.sun, mix);
        S.skyLive.setProperty('u_sunColor', scratchVec4.set(sun[0], sun[1], sun[2], 1));
        const disc = mix4(w.disc, c.disc, mix);
        S.skyLive.setProperty('u_discParams', scratchVec4.set(disc[0], disc[1], disc[2], disc[3]));
    }
    if (light) {
        const lc = mix3(w.lightColor, c.lightColor, mix);
        light.color = scratchColor.set(lc[0], lc[1], lc[2], 255);
        light.illuminance = lerp(w.lightIllum, c.lightIllum, mix);
    }
    if (scene && scene.globals && scene.globals.ambient) {
        const amb = mix3(w.ambient, c.ambient, mix);
        scene.globals.ambient.skyColorHDR.set(amb[0], amb[1], amb[2], 1);
        scene.globals.ambient.skyIllum = lerp(w.ambientIllum, c.ambientIllum, mix);
    }
}

// ============================================================================
// 10. 帧驱动(Component.update,场景生命周期托管;同 Rotator 正典)
// ============================================================================

const fpsTimes = [];

function moveToward(current, target, dt, rateK, minSpeed, maxSpeed) {
    const rem = target - current;
    if (Math.abs(rem) < 1e-4) return target;
    const speed = Math.min(Math.max(Math.abs(rem) * rateK, minSpeed), maxSpeed);
    const step = Math.min(Math.abs(rem), speed * dt);
    return current + Math.sign(rem) * step;
}

function tick(dt) {
    S.simTime += dt;

    // fps:2s 滚动平均
    const now = performance.now();
    fpsTimes.push(now);
    while (fpsTimes.length > 1 && now - fpsTimes[0] > 2000) fpsTimes.shift();
    if (fpsTimes.length >= 2) {
        S.fps = Math.round(((fpsTimes.length - 1) / ((now - fpsTimes[0]) / 1000)) * 10) / 10;
    }

    // toneMix 过渡(<= 2.5s 契约,实际 1.9s smoothstep)
    if (S.toneT < 1) {
        S.toneT = Math.min(1, S.toneT + dt / S.toneDuration);
        const e = S.toneT * S.toneT * (3 - 2 * S.toneT);
        S.toneMix = S.toneFrom + (S.toneTarget - S.toneFrom) * e;
    } else {
        S.toneMix = S.toneTarget;
    }
    applyTone(S.toneMix);

    // 海面相位推进
    if (S.seaLive) S.seaLive.setProperty('u_time', S.simTime);
    if (S.skyLive) S.skyLive.setProperty('u_time', S.simTime);

    // 相机平滑追踪(速度受限,无跳变)
    S.camAz = moveToward(S.camAz, S.camAzTarget, dt, 3.2, 24, 240);
    S.camEl = moveToward(S.camEl, S.camElTarget, dt, 3.2, 8, 120);
    const az = (S.camAz * Math.PI) / 180;
    const el = (S.camEl * Math.PI) / 180;
    cameraNode.setPosition(
        Math.sin(az) * Math.cos(el) * S.camDist,
        S.lookY + Math.sin(el) * S.camDist,
        Math.cos(az) * Math.cos(el) * S.camDist,
    );
    cameraNode.lookAt(scratchVec3a.set(0, S.lookY, 0));

    // 船体随波起伏(与海面同一波形函数采样 → 相位耦合)
    if (S.boatParent && S.boatParent.isValid) {
        const h = waveHeight(0, 0, S.simTime);
        const slope = waveSlope(0, 0, S.simTime);
        S.boatParent.setPosition(0, h + S.boatLift, 0);
        S.boatParent.setRotationFromEuler(
            Math.atan(slope[1]) * 0.8, // 纵摇(沿船体 z 轴的波面坡度)
            S.boatHeading,
            Math.atan(slope[0]) * 0.8, // 横摇
        );
    }

    // HUD(2Hz 刷新,避免高频文本抖动)
    ui.statusTimer += dt;
    if (ui.status && ui.statusTimer > 0.5 && S.assetLoaded) {
        ui.statusTimer = 0;
        setStatus(
            'fps ' + S.fps.toFixed(0) + ' · toneMix ' + S.toneMix.toFixed(2) + ' · az ' + S.camAz.toFixed(0) + '° · epoch ' + S.epoch,
        );
    }
}

class Driver extends Component {
    update(dt) {
        tick(dt);
    }
}

// ============================================================================
// 11. 主流程
// ============================================================================

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    scene = new Scene('e02-sunset-sea');

    // Camera(visibility 显式设置:引擎默认为 undefined,必须显式)
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(8, 12, 24, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 主光(方向/色温随 toneMix 演变;初始暖金;方向与太阳方位一致)
    const lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 10, 0));
    lightNode.setRotationFromEuler(-30, -157, 0); // 光向 az 23°(太阳 az 203° 的对向),仰角抬利于甲板/帆受光
    light = lightNode.addComponent(DirectionalLight);
    light.illuminance = PALETTE_WARM.lightIllum;

    // 帧驱动节点(不随 reset 释放)
    const driverNode = new Node('SimDriver');
    scene.addChild(driverNode);
    driverNode.addComponent(Driver);

    // 注册自定义着色器(必须在 createAirApp 之后,GAP-B1)
    registerEffect(
        'bench-e02-sea',
        makeEffectJson({
            name: 'bench-e02-sea',
            prog: 'bench-e02-sea|sea-vs:vert|sea-fs:frag',
            hash: 926201,
            members: SEA_MEMBERS,
            depthWrite: true,
            defaults: {
                u_waveAmp: [WAVES[0].amp, WAVES[1].amp, WAVES[2].amp, 0],
                u_waveK: [WAVES[0].k, WAVES[1].k, WAVES[2].k, 0],
                u_waveSpd: [WAVES[0].speed, WAVES[1].speed, WAVES[2].speed, 0],
                u_dir1: [WAVES[0].dir[0], WAVES[0].dir[1], 0, 0],
                u_dir2: [WAVES[1].dir[0], WAVES[1].dir[1], 0, 0],
                u_dir3: [WAVES[2].dir[0], WAVES[2].dir[1], 0, 0],
                u_sunDir: [SUN_DIR[0], SUN_DIR[1], SUN_DIR[2], 0],
                u_seaDeep: [0.012, 0.052, 0.105, 1],
                u_seaCrest: [0.11, 0.26, 0.33, 1],
                u_horizon: [1.15, 0.44, 0.16, 1],
                u_sunColor: [1.45, 0.83, 0.42, 1],
                u_specParams: [110, 1.2, 3.0, 0.1],
                u_fade: [16, 50, 0, 0],
                u_time: [0],
            },
        }),
        SEA_VERT_4,
        SEA_FRAG_4,
        SEA_VERT_1,
        SEA_FRAG_1,
    );
    registerEffect(
        'bench-e02-sky',
        makeEffectJson({
            name: 'bench-e02-sky',
            prog: 'bench-e02-sky|sky-vs:vert|sky-fs:frag',
            hash: 926202,
            members: SKY_MEMBERS,
            depthWrite: false,
            defaults: {
                u_sunDir: [SUN_DIR[0], SUN_DIR[1], SUN_DIR[2], 0],
                u_zenith: [0.055, 0.075, 0.24, 1],
                u_horizon: [1.15, 0.44, 0.16, 1],
                u_haze: [0.48, 0.26, 0.16, 1],
                u_sunColor: [1.45, 0.83, 0.42, 1],
                u_discParams: [0.9994, 0.99987, 55, 0.85],
                u_time: [0],
            },
        }),
        SKY_VERT_4,
        SKY_FRAG_4,
        SKY_VERT_1,
        SKY_FRAG_1,
    );

    // 场景内容(海面/天空)
    buildSea();
    buildSky();

    gltfLoader = new GLTFLoader();

    buildUI();
    installCameraInput();

    window.__appReady = false;
    app.run(scene);

    // 环境光:app.run 后经由 scene.globals 显式配置(模板已验证路径)
    applyTone(0);

    // 首帧就绪:资产加载完成且首帧渲染后置 true
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady && S.assetLoaded) {
            window.__appReady = true;
        }
    });

    await loadBoat();

    console.log('[e02] running on cocosair; sea verts =', SEA_VERTICES);
} catch (err) {
    // 致命错误(如 WebGL2 不可用):显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[e02] fatal:', err && err.message ? err.message : err);
    setStatus('[fatal] ' + (err && err.message ? err.message : err));
    setTimeout(() => {
        throw err;
    }, 0);
}
