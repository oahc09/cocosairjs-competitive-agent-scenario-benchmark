/**
 * E02 — 落日海面与孤舟(cocosair / K0)
 *
 * 结构:
 *   - 运行时 GLB 加载:GLTFLoader().loadAsync('assets/boat.glb')(真实网络请求)
 *   - 海面:双层网格(近景 160x160 段 + 远景平板),自定义 effect 顶点 Gerstner 位移,
 *     近 16u 内全幅、16-27u 衰减至平(近密远疏的层次化波形),总顶点 25,921 + 81 >= 2000
 *   - 天穹:反向球面 + 自定义 effect(渐变 + 日/月光盘 + 双层光晕,随 toneMix 演变)
 *   - 船体:GLB 实例,JS 镜像同一组波形常数采样 y/坡度 -> 起伏 + 纵摇/横摇(相位耦合)
 *   - 相机:方位角环绕(初始 35deg),DOM 指针拖拽驱动,逐帧指数平滑
 *   - 色调:toneMix 0(暖)/1(冷),1.2s 过渡;天空/海面/主光/环境光同步演变
 *   - reset:dispose GLTF 实例 + destroy asset/mesh/material + 重建 + 重新网络加载,epoch+1
 *
 * 页面契约:
 *   window.__appReady(资产加载完成且首帧渲染后 true)
 *   window.__bench = { getState(): {assetLoaded, assetRequests, boatPosition, wavePhase,
 *                                   toneMix, cameraAzimuth, fps, epoch}, reset(): void }
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    utils,
    primitives,
    Vec3,
    Vec4,
    Color,
    Component,
    director,
    Director,
    Material,
    EffectAsset,
    GLTFLoader,
} from 'cocosair.js';

// 材质 uniform 暂存(引擎 FLOAT4 上传要求 Vec4/Color 实例,普通数组会被当作 uniform 数组)
const V4_TIME = new Vec4(0, 0, 0, 0);
const V4_TONE = new Vec4(0, 0, 0, 0);
const V4_SUN = new Vec4(0, 0, 0, 0);

// ---------------------------------------------------------------------------
// 波形常数(GLSL 与 JS 双侧镜像,修改必须两侧同步)
// wave(dx, dz, k = 2pi/L, w = sqrt(9.81*k), Q, A)
// ---------------------------------------------------------------------------
const WAVES = [
    { dx: 0.98058, dz: 0.19612, k: 0.39270, w: 1.96180, q: 0.55, a: 0.300 },
    { dx: 0.70711, dz: 0.70711, k: 0.76690, w: 2.74240, q: 0.50, a: 0.160 },
    { dx: 0.89443, dz: -0.44721, k: 1.36610, w: 3.66140, q: 0.38, a: 0.085 },
    { dx: 0.60000, dz: 0.80000, k: 2.41660, w: 4.86780, q: 0.26, a: 0.045 },
];

/** 海面高度(与顶点着色器 grid 采样口径一致:p 为网格点 xz)。 */
function waveHeightAt(x, z, t) {
    let y = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const wv = WAVES[i];
        y += wv.a * Math.sin(wv.k * (wv.dx * x + wv.dz * z) - wv.w * t);
    }
    return y;
}
function waveSlopeAt(x, z, t, axis) {
    let s = 0;
    for (let i = 0; i < WAVES.length; i++) {
        const wv = WAVES[i];
        const phi = wv.k * (wv.dx * x + wv.dz * z) - wv.w * t;
        s += wv.k * wv.a * (axis === 'x' ? wv.dx : wv.dz) * Math.cos(phi);
    }
    return s;
}

// ---------------------------------------------------------------------------
// bench 状态
// ---------------------------------------------------------------------------
const B = {
    epoch: 0,
    assetLoaded: false,
    assetRequests: 0,
    toneMix: 0, // 0=暖(落日) 1=冷(暮蓝)
    toneTarget: 0,
    azimuth: 35, // 度
    azimuthTarget: 35,
    simTime: 0,
    boatY: 0,
    fps: 0,
    frameTimes: [],
    readyPending: false,
};

window.__appReady = false;
window.__bench = {
    getState: () => ({
        assetLoaded: B.assetLoaded,
        assetRequests: B.assetRequests,
        boatPosition: { x: 0, y: B.boatY + BOAT_REF_Y, z: 0 },
        wavePhase: B.simTime,
        toneMix: B.toneMix,
        cameraAzimuth: B.azimuth,
        fps: B.fps,
        epoch: B.epoch,
    }),
    reset: () => {
        void resetScene();
    },
};

// ---------------------------------------------------------------------------
// UI 覆盖层(探针定位:id / data-ui / aria-label 三重冗余)
// ---------------------------------------------------------------------------
const ui = {};
{
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:9999;display:flex;gap:8px;' +
        "font:13px sans-serif;";
    document.body.appendChild(bar);

    ui.tone = document.createElement('button');
    ui.tone.id = 'tone-toggle';
    ui.tone.setAttribute('data-ui', 'tone-toggle');
    ui.tone.setAttribute('aria-label', 'tone-toggle');
    ui.tone.textContent = 'Tone: Sunset';
    ui.tone.style.cssText =
        'padding:5px 12px;background:#30242a;color:#ffe9c8;border:1px solid #7a5a3a;' +
        'border-radius:4px;cursor:pointer';
    bar.appendChild(ui.tone);

    ui.reset = document.createElement('button');
    ui.reset.id = 'reset';
    ui.reset.setAttribute('data-ui', 'reset');
    ui.reset.setAttribute('aria-label', 'reset');
    ui.reset.textContent = 'Reset';
    ui.reset.style.cssText =
        'padding:5px 12px;background:#22262e;color:#d8e2f0;border:1px solid #4a5a7a;' +
        'border-radius:4px;cursor:pointer';
    bar.appendChild(ui.reset);

    ui.status = document.createElement('div');
    ui.status.id = 'loading';
    ui.status.textContent = 'Loading boat.glb ...';
    ui.status.style.cssText =
        'position:fixed;top:10px;left:10px;z-index:9999;padding:4px 10px;' +
        "font:12px sans-serif;color:#ffe9c8;background:rgba(30,20,10,0.55);" +
        'border-radius:4px';
    document.body.appendChild(ui.status);

    ui.error = document.createElement('div');
    ui.error.id = 'load-error';
    ui.error.setAttribute('role', 'alert');
    ui.error.style.cssText =
        'position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:10000;' +
        'padding:12px 20px;display:none;font:14px sans-serif;color:#ffd6d6;' +
        'background:rgba(90,10,10,0.85);border:1px solid #ff6a6a;border-radius:6px';
    document.body.appendChild(ui.error);
}

function showError(msg) {
    ui.error.textContent = String(msg);
    ui.error.style.display = 'block';
}

// ---------------------------------------------------------------------------
// 自定义 effect(运行时注册,走 legacy programLib 路径)
// glsl3 源不带 #version(引擎统一前置),UBO 按 builtin 约定声明前缀成员。
// ---------------------------------------------------------------------------

const UBO_PREFIX_COMMON = `
uniform CCGlobal {
    highp   vec4 cc_time;
    mediump vec4 cc_screenSize;
    mediump vec4 cc_nativeSize;
    mediump vec4 cc_debug_view_mode;
};
uniform CCCamera {
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
};
`;

const UBO_LOCAL = `
uniform CCLocal {
    highp mat4 cc_matWorld;
    highp mat4 cc_matWorldIT;
    highp vec4 cc_lightingMapUVParam;
    highp vec4 cc_localShadowBias;
};
`;

const OCEAN_VERT = `
precision highp float;
in vec3 a_position;
in vec3 a_normal;
in vec2 a_texCoord;
${UBO_PREFIX_COMMON}
${UBO_LOCAL}
uniform OceanParams {
    vec4 u_time;
    vec4 u_toneMix;
    vec4 u_sunDir;
};
out vec3 v_world;
out vec3 v_normal;

void gerstner (vec2 p, float t, vec2 dir, float k, float w, float Q, float A, float atten,
               inout vec3 disp, inout vec3 tanX, inout vec3 tanZ) {
    float phi = k * dot(dir, p) - w * t;
    float s = sin(phi);
    float c = cos(phi);
    disp += vec3(Q * A * dir.x * c, A * s, Q * A * dir.y * c) * atten;
    float ka = k * A * atten;
    tanX += vec3(-Q * dir.x * dir.x * ka * s, dir.x * ka * c, -Q * dir.x * dir.y * ka * s);
    tanZ += vec3(-Q * dir.x * dir.y * ka * s, dir.y * ka * c, -Q * dir.y * dir.y * ka * s);
}

vec4 vert () {
    float t = u_time.x;
    vec3 wp = (cc_matWorld * vec4(a_position, 1.0)).xyz;
    vec2 p = wp.xz;
    float rad = length(p);
    float atten = 1.0 - smoothstep(16.0, 27.0, rad);
    vec3 disp = vec3(0.0);
    vec3 tanX = vec3(1.0, 0.0, 0.0);
    vec3 tanZ = vec3(0.0, 0.0, 1.0);
    gerstner(p, t, vec2( 0.98058, 0.19612), 0.39270, 1.96180, 0.55, 0.300, atten, disp, tanX, tanZ);
    gerstner(p, t, vec2( 0.70711, 0.70711), 0.76690, 2.74240, 0.50, 0.160, atten, disp, tanX, tanZ);
    gerstner(p, t, vec2( 0.89443,-0.44721), 1.36610, 3.66140, 0.38, 0.085, atten, disp, tanX, tanZ);
    gerstner(p, t, vec2( 0.60000, 0.80000), 2.41660, 4.86780, 0.26, 0.045, atten, disp, tanX, tanZ);
    vec3 pos = wp + disp;
    v_normal = normalize(cross(tanZ, tanX));
    v_world = pos;
    return cc_matViewProj * vec4(pos, 1.0);
}
void main () { gl_Position = vert(); }
`;

const OCEAN_FRAG = `
precision highp float;
in vec3 v_world;
in vec3 v_normal;
${UBO_PREFIX_COMMON}
uniform OceanParams {
    vec4 u_time;
    vec4 u_toneMix;
    vec4 u_sunDir;
};
vec4 frag () {
    float tone = u_toneMix.x;
    vec3 n = normalize(v_normal);
    vec3 V = normalize(cc_cameraPos.xyz - v_world);
    vec3 L = normalize(u_sunDir.xyz);
    vec3 deepC  = mix(vec3(0.045, 0.140, 0.170), vec3(0.012, 0.045, 0.100), tone);
    vec3 crestC = mix(vec3(0.100, 0.300, 0.300), vec3(0.040, 0.110, 0.200), tone);
    vec3 skyRef = mix(vec3(0.950, 0.520, 0.240), vec3(0.360, 0.460, 0.720), tone);
    vec3 sunC   = mix(vec3(1.000, 0.720, 0.380), vec3(0.720, 0.800, 1.000), tone);
    vec3 horC   = mix(vec3(0.990, 0.620, 0.300), vec3(0.420, 0.500, 0.750), tone);

    float slope = clamp(n.y, 0.0, 1.0);
    vec3 col = mix(deepC, crestC, pow(slope, 3.0));
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col = mix(col, skyRef, clamp(fres * 0.85 + 0.05, 0.0, 1.0));

    vec3 H = normalize(L + V);
    float spec = pow(max(dot(n, H), 0.0), mix(200.0, 340.0, tone));
    col += sunC * spec * mix(1.35, 0.85, tone);
    float glit = pow(max(dot(reflect(-V, n), L), 0.0), mix(26.0, 42.0, tone));
    col += sunC * glit * 0.22;

    float dist = length(cc_cameraPos.xyz - v_world);
    float fog = smoothstep(45.0, 320.0, dist);
    col = mix(col, horC, fog);
    return vec4(col, 1.0);
}
layout(location = 0) out vec4 cc_FragColor;
void main () { cc_FragColor = frag(); }
`;

const SKY_VERT = `
precision highp float;
in vec3 a_position;
${UBO_PREFIX_COMMON}
${UBO_LOCAL}
uniform SkyParams {
    vec4 u_toneMix;
    vec4 u_sunDir;
};
out vec3 v_dir;
vec4 vert () {
    vec3 wp = (cc_matWorld * vec4(a_position, 1.0)).xyz;
    v_dir = wp - cc_cameraPos.xyz;
    return cc_matViewProj * vec4(wp, 1.0);
}
void main () { gl_Position = vert(); }
`;

const SKY_FRAG = `
precision highp float;
in vec3 v_dir;
uniform SkyParams {
    vec4 u_toneMix;
    vec4 u_sunDir;
};
vec4 frag () {
    float tone = u_toneMix.x;
    vec3 dir = normalize(v_dir);
    float h = dir.y;
    vec3 top = mix(vec3(0.100, 0.170, 0.390), vec3(0.012, 0.030, 0.095), tone);
    vec3 mid = mix(vec3(0.930, 0.440, 0.190), vec3(0.100, 0.140, 0.300), tone);
    vec3 hor = mix(vec3(0.990, 0.630, 0.310), vec3(0.420, 0.500, 0.750), tone);
    vec3 sea = mix(vec3(0.075, 0.150, 0.190), vec3(0.020, 0.050, 0.105), tone);

    float ha = clamp(h, 0.0, 1.0);
    vec3 col = mix(hor, mid, smoothstep(0.0, 0.13, ha));
    col = mix(col, top, smoothstep(0.10, 0.55, ha));
    col = mix(col, sea, smoothstep(0.0, 0.16, -h));

    float d = max(dot(dir, normalize(u_sunDir.xyz)), 0.0);
    vec3 discC = mix(vec3(1.000, 0.800, 0.450), vec3(0.850, 0.900, 1.000), tone);
    vec3 haloC = mix(vec3(1.000, 0.550, 0.220), vec3(0.450, 0.550, 0.850), tone);
    col += discC * smoothstep(0.99935, 0.99975, d) * mix(1.7, 1.15, tone);
    col += discC * pow(d, 420.0) * 0.60;
    col += haloC * pow(d, 18.0) * mix(0.34, 0.18, tone);
    return vec4(col, 1.0);
}
layout(location = 0) out vec4 cc_FragColor;
void main () { cc_FragColor = frag(); }
`;

function makeShaderInfo(name, hash, vert, frag, attributes, blocks) {
    return {
        name,
        hash,
        glsl3: { vert, frag },
        builtins: {
            statistics: {
                CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 24,
                CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 20,
            },
            globals: {
                blocks: [{ name: 'CCGlobal', defines: [] }, { name: 'CCCamera', defines: [] }],
                samplerTextures: [],
                buffers: [],
                images: [],
            },
            locals: {
                blocks: [{ name: 'CCLocal', defines: [] }],
                samplerTextures: [],
                buffers: [],
                images: [],
            },
        },
        defines: [],
        attributes,
        blocks,
        samplerTextures: [],
        buffers: [],
        images: [],
        textures: [],
        samplers: [],
        subpassInputs: [],
    };
}

function registerEffects() {
    const ATTR_PNU = [
        { name: 'a_position', defines: [], format: 32, isNormalized: false, stream: 0, isInstanced: false, location: 0 },
        { name: 'a_normal', defines: [], format: 32, isNormalized: false, stream: 0, isInstanced: false, location: 1 },
        { name: 'a_texCoord', defines: [], format: 21, isNormalized: false, stream: 0, isInstanced: false, location: 2 },
    ];

    const ocean = Object.assign(new EffectAsset(), {
        name: 'e02-ocean',
        techniques: [
            {
                name: 'opaque',
                passes: [
                    {
                        program: 'e02-ocean|ocean-vs|ocean-fs',
                        rasterizerState: { cullMode: 0 },
                        depthStencilState: { depthTest: true, depthWrite: true },
                        properties: {
                            u_time: { value: [0, 0, 0, 0], type: 16 },
                            u_toneMix: { value: [0, 0, 0, 0], type: 16 },
                            u_sunDir: { value: [0.33, 0.21, 0.92, 0], type: 16 },
                        },
                    },
                ],
            },
        ],
        shaders: [
            makeShaderInfo(
                'e02-ocean|ocean-vs|ocean-fs',
                783421091,
                OCEAN_VERT,
                OCEAN_FRAG,
                ATTR_PNU,
                [
                    {
                        name: 'OceanParams',
                        binding: 0,
                        stageFlags: 17,
                        members: [
                            { name: 'u_time', type: 16, count: 1 },
                            { name: 'u_toneMix', type: 16, count: 1 },
                            { name: 'u_sunDir', type: 16, count: 1 },
                        ],
                    },
                ],
            ),
        ],
        combinations: [{}],
    });
    ocean.hideInEditor = true;
    ocean.onLoaded();

    const sky = Object.assign(new EffectAsset(), {
        name: 'e02-sky',
        techniques: [
            {
                name: 'opaque',
                passes: [
                    {
                        program: 'e02-sky|sky-vs|sky-fs',
                        rasterizerState: { cullMode: 0 },
                        depthStencilState: { depthTest: true, depthWrite: false },
                        properties: {
                            u_toneMix: { value: [0, 0, 0, 0], type: 16 },
                            u_sunDir: { value: [0.33, 0.21, 0.92, 0], type: 16 },
                        },
                    },
                ],
            },
        ],
        shaders: [
            makeShaderInfo(
                'e02-sky|sky-vs|sky-fs',
                783421237,
                SKY_VERT,
                SKY_FRAG,
                ATTR_PNU,
                [
                    {
                        name: 'SkyParams',
                        binding: 0,
                        stageFlags: 17,
                        members: [
                            { name: 'u_toneMix', type: 16, count: 1 },
                            { name: 'u_sunDir', type: 16, count: 1 },
                        ],
                    },
                ],
            ),
        ],
        combinations: [{}],
    });
    sky.hideInEditor = true;
    sky.onLoaded();
}

// ---------------------------------------------------------------------------
// 场景构建
// ---------------------------------------------------------------------------
const BOAT_URL = 'assets/boat.glb';
const BOAT_SCALE = 1.35;
const BOAT_REF_Y = 0.9 * BOAT_SCALE; // boatPosition 参考点:视觉中心高度偏移
const CAM_DIST = 11.5;
const CAM_HEIGHT = 3.0;
const CAM_LOOK = new Vec3(0, 0.85, 0);
// 太阳方位:相机初始位于方位角 35°(朝 215° 看),太阳放在视线方位附近偏侧 17°,
// 使光盘出现在画面中轴附近偏侧、贴近视平线;冷端月亮升高。
const SUN_AZIMUTH = 208 * (Math.PI / 180);

let app = null;
let scene = null;
let cameraNode = null;
let camera = null;
let lightNode = null;
let light = null;
let driverNode = null;
let envRoot = null; // 每次重建:sky + ocean 节点/网格/材质
let boatRoot = null; // GLTF 实例 root
let boatInstance = null;
let boatAsset = null;
let oceanMat = null;
let skyMat = null;
let oceanMeshNear = null;
let oceanMeshFar = null;
let skyMesh = null;
let resetting = false;
let lastToneApplied = -1;

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function sunDirAt(tone) {
    const el = lerp(5, 15, tone) * (Math.PI / 180);
    return new Vec3(
        Math.cos(el) * Math.sin(SUN_AZIMUTH),
        Math.sin(el),
        Math.cos(el) * Math.cos(SUN_AZIMUTH),
    );
}

/** 建环境(天空 + 海面)。每次 epoch 重建。 */
function buildEnvironment() {
    envRoot = new Node('env');
    envRoot.layer = Layers.Enum.DEFAULT;
    scene.addChild(envRoot);

    oceanMat = new Material();
    oceanMat.initialize({ effectName: 'e02-ocean' });
    // 立即以 Vec4 写入(effect 默认值数组路径会产生 NaN,首帧前必须覆盖)
    oceanMat.setProperty('u_time', V4_TIME.set(0, 0, 0, 0));
    oceanMat.setProperty('u_toneMix', V4_TONE.set(0, 0, 0, 0));
    oceanMat.setProperty('u_sunDir', V4_SUN);

    skyMat = new Material();
    skyMat.initialize({ effectName: 'e02-sky' });
    skyMat.setProperty('u_toneMix', V4_TONE);
    skyMat.setProperty('u_sunDir', V4_SUN);

    // 近景海面:60x60,160x160 段(25,921 顶点,0.375u 间距)
    oceanMeshNear = utils.createMesh(
        primitives.plane({ width: 60, length: 60, widthSegments: 160, lengthSegments: 160 }),
    );
    const nearNode = new Node('ocean-near');
    nearNode.layer = Layers.Enum.DEFAULT;
    envRoot.addChild(nearNode);
    const nearMR = nearNode.addComponent(MeshRenderer);
    nearMR.mesh = oceanMeshNear;
    nearMR.material = oceanMat;

    // 远景海面:1400x1400 平板(81 顶点),低于波谷,雾色衔接地平线
    oceanMeshFar = utils.createMesh(
        primitives.plane({ width: 1400, length: 1400, widthSegments: 8, lengthSegments: 8 }),
    );
    const farNode = new Node('ocean-far');
    farNode.layer = Layers.Enum.DEFAULT;
    farNode.setPosition(0, -0.75, 0);
    envRoot.addChild(farNode);
    const farMR = farNode.addComponent(MeshRenderer);
    farMR.mesh = oceanMeshFar;
    farMR.material = oceanMat;

    // 天穹:半径 900 球(反向可见,cullMode none)
    skyMesh = utils.createMesh(primitives.sphere(900, { segments: 48 }));
    const skyNode = new Node('sky');
    skyNode.layer = Layers.Enum.DEFAULT;
    envRoot.addChild(skyNode);
    const skyMR = skyNode.addComponent(MeshRenderer);
    skyMR.mesh = skyMesh;
    skyMR.material = skyMat;
}

/** 释放环境 GPU 资源。 */
function destroyEnvironment() {
    if (envRoot && envRoot.isValid) {
        envRoot.destroy();
    }
    envRoot = null;
    const oldMeshes = [oceanMeshNear, oceanMeshFar, skyMesh];
    oceanMeshNear = oceanMeshFar = skyMesh = null;
    const oldMats = [oceanMat, skyMat];
    oceanMat = skyMat = null;
    for (const m of oldMeshes) {
        if (m && m.isValid) m.destroy();
    }
    for (const m of oldMats) {
        if (m && m.isValid) m.destroy();
    }
}

/** 加载船(真实网络请求)。 */
async function loadBoat() {
    const loader = new GLTFLoader();
    const asset = await loader.loadAsync(BOAT_URL);
    const instance = asset.instantiate(0);
    boatAsset = asset;
    boatInstance = instance;
    boatRoot = instance.root;
    boatRoot.layer = Layers.Enum.DEFAULT;
    boatRoot.children?.forEach?.((c) => {
        c.layer = Layers.Enum.DEFAULT;
    });
    boatRoot.setScale(BOAT_SCALE, BOAT_SCALE, BOAT_SCALE);
    scene.addChild(boatRoot);
    B.assetLoaded = true;
    B.assetRequests += 1;
    B.readyPending = true;
    ui.status.style.display = 'none';
}

function releaseBoat() {
    if (boatInstance) {
        try {
            boatInstance.dispose();
        } catch (e) {
            console.warn('[e02] boat instance dispose warn:', e && e.message ? e.message : e);
        }
        boatInstance = null;
    }
    if (boatAsset && boatAsset.isValid) {
        boatAsset.destroy();
    }
    boatAsset = null;
    boatRoot = null;
    B.assetLoaded = false;
}

/** reset:释放并重建(非整页刷新)。 */
async function resetScene() {
    if (resetting) return;
    resetting = true;
    ui.reset.disabled = true;
    try {
        B.epoch += 1;
        releaseBoat();
        destroyEnvironment();
        // 恢复初始
        B.toneMix = 0;
        B.toneTarget = 0;
        B.azimuth = 35;
        B.azimuthTarget = 35;
        B.simTime = 0;
        updateToneUI();
        buildEnvironment();
        applyTone(0, true);
        await loadBoat();
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[e02] reset failed:', msg);
        showError('Reset failed: ' + msg);
    } finally {
        resetting = false;
        ui.reset.disabled = false;
    }
}

function updateToneUI() {
    ui.tone.textContent = B.toneTarget > 0.5 ? 'Tone: Dusk Blue' : 'Tone: Sunset';
}

// ---------------------------------------------------------------------------
// 每帧驱动组件
// ---------------------------------------------------------------------------
class SimDriver extends Component {
    update(dt) {
        const d = Math.min(Math.max(dt, 0), 0.1);
        B.simTime += d;

        // toneMix 过渡(<= 1.2s)
        const tSpeed = 1 / 1.2;
        const tDiff = B.toneTarget - B.toneMix;
        const tStep = Math.sign(tDiff) * Math.min(Math.abs(tDiff), tSpeed * d);
        B.toneMix += tStep;

        // 方位角平滑(指数趋近)
        const k = 1 - Math.exp(-d * 10);
        B.azimuth += (B.azimuthTarget - B.azimuth) * k;

        applyTone(B.toneMix);

        // 相机环绕
        const az = B.azimuth * (Math.PI / 180);
        cameraNode.setPosition(
            Math.sin(az) * CAM_DIST,
            CAM_HEIGHT,
            Math.cos(az) * CAM_DIST,
        );
        cameraNode.lookAt(CAM_LOOK);

        // 船体随波(与海面同一波形参数,相位耦合)
        const wy = waveHeightAt(0, 0, B.simTime);
        B.boatY = wy;
        if (boatRoot && boatRoot.isValid) {
            const sx = waveSlopeAt(0, 0, B.simTime, 'x');
            const sz = waveSlopeAt(0, 0, B.simTime, 'z');
            boatRoot.setPosition(0, wy - 0.06, 0);
            boatRoot.setRotationFromEuler(
                Math.atan(sz) * 0.55,
                20 * (Math.PI / 180),
                -Math.atan(sx) * 0.55,
            );
        }

        // 海面 uniforms
        if (oceanMat && oceanMat.isValid) {
            oceanMat.setProperty('u_time', V4_TIME.set(B.simTime, 0, 0, 0));
            oceanMat.setProperty('u_toneMix', V4_TONE.set(B.toneMix, 0, 0, 0));
        }
        if (skyMat && skyMat.isValid) {
            skyMat.setProperty('u_toneMix', V4_TONE);
        }
    }
}

/** 色调 -> 天空/海面/主光/环境光(仅在 toneMix 变化时更新光照)。 */
function applyTone(tone, force) {
    if (!force && Math.abs(tone - lastToneApplied) < 0.002) {
        // 仍需更新太阳方向给材质(便宜,每帧)
        const sd0 = sunDirAt(tone);
        V4_SUN.set(sd0.x, sd0.y, sd0.z, 0);
        if (oceanMat && oceanMat.isValid) oceanMat.setProperty('u_sunDir', V4_SUN);
        if (skyMat && skyMat.isValid) skyMat.setProperty('u_sunDir', V4_SUN);
        return;
    }
    lastToneApplied = tone;
    const sd = sunDirAt(tone);
    V4_SUN.set(sd.x, sd.y, sd.z, 0);
    if (oceanMat && oceanMat.isValid) {
        oceanMat.setProperty('u_sunDir', V4_SUN);
    }
    if (skyMat && skyMat.isValid) {
        skyMat.setProperty('u_sunDir', V4_SUN);
    }
    // 主光(暖金 -> 冷蓝)
    lightNode.setPosition(sd.x * 80, sd.y * 80, sd.z * 80);
    lightNode.lookAt(new Vec3(0, 0, 0));
    light.color = new Color(
        Math.round(lerp(255, 158, tone)),
        Math.round(lerp(168, 178, tone)),
        Math.round(lerp(97, 255, tone)),
        255,
    );
    light.illuminance = lerp(42000, 26000, tone);
    // 环境光
    const amb = scene.globals.ambient;
    amb.skyColorHDR.set(lerp(0.85, 0.22, tone), lerp(0.42, 0.30, tone), lerp(0.22, 0.55, tone), 1.0);
    amb.skyIllum = lerp(9000, 6000, tone);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');

    // 指针拖拽 -> 环绕(不依赖引擎输入系统;按钮为独立 DOM,不会误触)
    let dragging = false;
    let lastX = 0;
    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch (_) {
            /* capture 非必需 */
        }
        e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        B.azimuthTarget += dx * 0.25;
    });
    const endDrag = () => {
        dragging = false;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);

    ui.tone.addEventListener('click', () => {
        B.toneTarget = B.toneTarget > 0.5 ? 0 : 1;
        updateToneUI();
    });
    ui.reset.addEventListener('click', () => {
        window.__bench.reset();
    });

    app = await createAirApp({ canvas });
    window.__airApp = app;

    scene = new Scene('e02-sunset-sea');

    // 相机
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(
        Math.sin(35 * (Math.PI / 180)) * CAM_DIST,
        CAM_HEIGHT,
        Math.cos(35 * (Math.PI / 180)) * CAM_DIST,
    );
    cameraNode.lookAt(CAM_LOOK);
    camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 55;
    camera.near = 0.1;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(16, 18, 28, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 主光
    lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 42000;
    light.color = new Color(255, 168, 97, 255);

    // 驱动组件(常驻,不参与重建)
    driverNode = new Node('SimDriver');
    scene.addChild(driverNode);
    driverNode.addComponent(SimDriver);

    registerEffects();
    buildEnvironment();
    applyTone(0, true);

    scene.globals.skybox.enabled = false;

    app.run(scene);

    // 帧率(2s 滚动平均)+ 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        B.frameTimes.push(now);
        while (B.frameTimes.length > 0 && now - B.frameTimes[0] > 2000) {
            B.frameTimes.shift();
        }
        if (B.frameTimes.length >= 2) {
            const span = (now - B.frameTimes[0]) / 1000;
            B.fps = span > 0 ? B.frameTimes.length / span : 0;
        }
        if (B.readyPending && !window.__appReady) {
            B.readyPending = false;
            window.__appReady = true;
        }
    });

    console.log('[e02] cocosair scene running');
    window.__e02Debug = {
        get oceanMat() { return oceanMat; },
        get skyMat() { return skyMat; },
        get envRoot() { return envRoot; },
        B,
    };
    await loadBoat();
} catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[e02] fatal:', msg);
    showError('Fatal: ' + msg);
    ui.status.style.display = 'none';
    // 致命错误(如 WebGL2 不可用)显式上抛,便于 harness 分类
    setTimeout(() => {
        throw err;
    }, 0);
}
