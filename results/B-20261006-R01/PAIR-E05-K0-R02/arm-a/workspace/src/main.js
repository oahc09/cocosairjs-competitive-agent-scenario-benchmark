/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair K0 实现
 *
 * 场景构成(全部程序化,无外部资产):
 *   - 背景星空:600 颗静态星点(世界空间广告牌四边形合并为单一静态网格,加色混合)
 *   - 星云:3 片超淡蓝紫渐变四边形(可选加分)
 *   - 黑洞核心:纯黑 UV 球(r=1.2,不透明,写深度)——真实深度遮挡:盘远缘被吞、近缘在前
 *   - 吸积盘:环形网格(内缘 1.8 / 外缘 6.5,局部 XZ 平面,挂在倾斜父节点下),
 *     自定义片元着色器:径向白→黄橙→暗红梯度 + 时间驱动螺旋条纹旋转 + 多普勒左右不对称
 *   - 光子环 + 大范围柔光晕:面向相机的加色径向渐变(shader 内衰减,替代 Bloom)
 *   - 星流:220 粒子动态网格,螺旋轨迹汇入视界,接近时加速并拉长拖尾,吞没后外圈重生
 *   - 相机:初始距离 14.0,滚轮平滑缩放 [5,28](window 捕获阶段监听,绕过 pal 层吞事件)
 *
 * 自定义 effect 说明(K0 无文档,以下格式自本 Arm workspace/dist 内引擎 bundle 的
 * builtin effect 注册路径逆向得到,与 gltfPhysicalEffect() 的运行时克隆模式同构):
 *   new EffectAsset() + name/shaders/techniques + onLoaded() → Material.initialize({effectAsset})
 *   glsl3 由 toGlsl3 同规则转换(builtin 注册路径 registerBuiltinAirAssets 的做法)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后 true。
 *   - window.__bench = { getState(): {diskRotation, accretionPhase, cameraDistance,
 *     starStreamCount, backgroundStarCount, ...}, reset(): void }。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    Mesh,
    EffectAsset,
    utils,
    Vec3,
    Vec4,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量(与 spec.json 场景尺度一致)
// ---------------------------------------------------------------------------
const CORE_R = 1.2;          // 事件视界半径
const INNER_R = 1.8;         // 盘内缘
const OUTER_R = 6.5;         // 盘外缘
const TILT_DEG = 26.6;       // 盘面相对视线倾角(15–75° 要求内,俯视感)
const TILT_RAD = (TILT_DEG * Math.PI) / 180;
const ELEV_DEG = TILT_DEG;   // 相机仰角 = 盘倾角(等价表达,相机绕原点)
const DIST0 = 14.0;
const DIST_MIN = 5;
const DIST_MAX = 28;
const ZOOM_K = 0.01;         // wheel dy → 距离增量(dy=-600 → 目标 8.0)
const ZOOM_RATE = 10;        // 平滑插值速率(/s),1s 内残差 <0.01%
const OMEGA = 0.45;          // 盘角速度 rad/s(0.15–0.6 要求内)
const STAR_N = 600;          // 背景星(>=300)
const STREAM_N = 220;        // 星流粒子(>=200,恒定)
const SEG_Ring = 192;        // 盘周向细分(曲率平滑)

const sinE = Math.sin((ELEV_DEG * Math.PI) / 180);
const cosE = Math.cos((ELEV_DEG * Math.PI) / 180);
const CAM_DIR = new Vec3(0, sinE, cosE);            // 单位:原点→相机方向
const CAM_RIGHT = new Vec3(1, 0, 0);
const CAM_UP = new Vec3(0, cosE, -sinE);            // 与视线正交的"屏幕上方向"

// ---------------------------------------------------------------------------
// 运行时状态(唯一事实源,getState 直接读这里)
// ---------------------------------------------------------------------------
const state = {
    frame: 0,
    diskRot: 0,          // rad,自上次 reset 起累计
    dist: DIST0,
    distTarget: DIST0,
    time: 0,
    resetCount: 0,
};

window.__appReady = false;

// --- 星流粒子 ---
const particles = [];
function respawnParticle(p, initial) {
    p.r = initial ? (1.45 + Math.random() * 5.4) : (5.2 + Math.random() * 1.8);
    p.th = Math.random() * Math.PI * 2;
    p.y = (Math.random() * 2 - 1) * 0.30 * (p.r / 7);
    p.jit = 0.7 + Math.random() * 0.6;
    p.trailK = 0.7 + Math.random() * 0.6;
    const t = Math.min(1, Math.max(0, (p.r - 1.4) / 5.4));
    // 内热(暖白)→ 外冷(蓝白)
    p.cr = 1.4 + (0.75 - 1.4) * t;
    p.cg = 1.15 + (0.85 - 1.15) * t;
    p.cb = 0.85 + (1.25 - 0.85) * t;
    p.px = 0; p.py = 0; p.pz = 0; p.hasPrev = false;
}
for (let i = 0; i < STREAM_N; i++) {
    const p = {};
    respawnParticle(p, true);
    particles.push(p);
}

function resetScene() {
    state.diskRot = 0;
    state.dist = DIST0;
    state.distTarget = DIST0;
    for (let i = 0; i < STREAM_N; i++) respawnParticle(particles[i], true);
    state.resetCount += 1;
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
        diskRotation: state.diskRot,
        accretionPhase: (state.diskRot / (Math.PI * 2)) % 1,
        cameraDistance: state.dist,
        starStreamCount: STREAM_N,
        backgroundStarCount: STAR_N,
        resetCount: state.resetCount,
    }),
    reset: resetScene,
};

// --- UI:reset 按钮(右上角,DOM,探针 click:ui=reset) ---
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 14px;' +
        "font:13px sans-serif;background:#14161c;color:#dfe3ea;border:1px solid #4a5060;" +
        'border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => resetScene());
    document.body.appendChild(btn);
}

// --- 滚轮缩放:window 捕获阶段监听(pal 层会吞 canvas 鼠标事件;wheel 须 capture) ---
window.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= 720;
    state.distTarget = Math.min(DIST_MAX, Math.max(DIST_MIN, state.distTarget + dy * ZOOM_K));
}, { capture: true, passive: false });

// ---------------------------------------------------------------------------
// 自定义 effect 工具(K0:由引擎 bundle 内置 effect 注册路径逆向的格式)
// ---------------------------------------------------------------------------
function toGlsl3(src) {
    // 与引擎 registerBuiltinAirAssets 内置转换完全同规则
    return src
        .replace(/#extension[^\n]*\n/g, '')
        .replace(/^[^\n]*cc_debug_view_composite_pack_\d+;[^\n]*$/gm, '')
        .replace(/layout\s*\(([^)]*)\)\s*/g, (m, inner) => (inner.indexOf('std140') !== -1 ? 'layout(std140) ' : ''))
        .replace(/\bu32vec([234])\b/g, 'vec$1');
}

// 全局 uniform 块成员表:与 builtin 着色器逐字一致(std140 布局依赖成员顺序)
const CC_GLOBAL_BLOCK = [
    'highp   vec4 cc_time;',
    'mediump vec4 cc_screenSize;',
    'mediump vec4 cc_nativeSize;',
    'mediump vec4 cc_debug_view_mode;',
    'mediump vec4 cc_debug_view_composite_pack_1;',
    'mediump vec4 cc_debug_view_composite_pack_2;',
    'mediump vec4 cc_debug_view_composite_pack_3;',
].join('\n');
const CC_CAMERA_BLOCK = [
    'highp   mat4 cc_matView;',
    'highp   mat4 cc_matViewInv;',
    'highp   mat4 cc_matProj;',
    'highp   mat4 cc_matProjInv;',
    'highp   mat4 cc_matViewProj;',
    'highp   mat4 cc_matViewProjInv;',
    'highp   vec4 cc_cameraPos;',
    'mediump vec4 cc_surfaceTransform;',
    'mediump vec4 cc_screenScale;',
    'mediump vec4 cc_exposure;',
    'mediump vec4 cc_mainLitDir;',
    'mediump vec4 cc_mainLitColor;',
    'mediump vec4 cc_ambientSky;',
    'mediump vec4 cc_ambientGround;',
    'mediump vec4 cc_fogColor;',
    'mediump vec4 cc_fogBase;',
    'mediump vec4 cc_fogAdd;',
    'mediump vec4 cc_nearFar;',
    'mediump vec4 cc_viewPort;',
].join('\n');
const CC_LOCAL_BLOCK = [
    'highp mat4 cc_matWorld;',
    'highp mat4 cc_matWorldIT;',
    'highp vec4 cc_lightingMapUVParam;',
    'highp vec4 cc_localShadowBias;',
].join('\n');

const VERT_SRC = `
precision highp float;
layout(set = 0, binding = 0) uniform CCGlobal {
${CC_GLOBAL_BLOCK}
};
layout(set = 0, binding = 1) uniform CCCamera {
${CC_CAMERA_BLOCK}
};
layout(set = 2, binding = 0) uniform CCLocal {
${CC_LOCAL_BLOCK}
};
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 0) out vec3 v_local;
layout(location = 1) out vec4 v_color;
void main() {
  v_local = a_position;
  v_color = a_color;
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  gl_Position = cc_matViewProj * wp;
}
`;

// 片元 A:顶色直出(星空/星云/星流/光晕通用);sqrt 即引擎 unlit 输出的 gamma 约定
const FRAG_VCOL_SRC = `
precision highp float;
layout(location = 0) in vec3 v_local;
layout(location = 1) in vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
vec4 CCFragOutput (vec4 color) {
  color.rgb = sqrt(max(color.rgb, vec3(0.0)));
  return color;
}
void main() { cc_FragColor = CCFragOutput(v_color); }
`;

// 片元 B:吸积盘(径向温度梯度 + 旋转螺旋条纹 + 多普勒不对称 + 软边羽化)
const FRAG_DISK_SRC = `
precision highp float;
layout(location = 0) in vec3 v_local;
layout(set = 1, binding = 0) uniform Params {
  vec4 p0; // (innerR, outerR, stripeCount, unused)
  vec4 p1; // (angle, doppler, brightness, unused)
};
layout(location = 0) out vec4 cc_FragColor;
vec4 CCFragOutput (vec4 color) {
  color.rgb = sqrt(max(color.rgb, vec3(0.0)));
  return color;
}
void main() {
  float inner = p0.x;
  float outer = p0.y;
  float stripes = p0.z;
  float angle = p1.x;
  float dop = p1.y;
  float bright = p1.z;
  float r = length(v_local.xz);
  float u = clamp((r - inner) / (outer - inner), 0.0, 1.0);
  float theta = atan(v_local.z, v_local.x);
  // 径向温度梯度:内缘蓝白 → 亮黄白 → 橙 → 外缘暗红
  vec3 c0 = vec3(0.92, 0.97, 1.12);
  vec3 c1 = vec3(1.30, 1.12, 0.78);
  vec3 c2 = vec3(1.22, 0.55, 0.16);
  vec3 c3 = vec3(0.48, 0.11, 0.05);
  vec3 col = mix(c0, c1, smoothstep(0.00, 0.10, u));
  col = mix(col, c2, smoothstep(0.10, 0.45, u));
  col = mix(col, c3, smoothstep(0.55, 1.00, u));
  // 旋转螺旋条纹(时间参数驱动连续旋转;内圈相位超前 → 螺旋感)
  float sp = stripes * theta + 3.2 * u - angle;
  float stripe = 0.74 + 0.26 * sin(sp);
  // 多普勒不对称:一侧增亮、对侧减暗(世界方向固定,不随条纹旋转)
  float doppler = 1.0 + dop * cos(theta);
  col *= doppler * bright;
  // 内缘白热 rim
  float rim = smoothstep(inner + 0.55, inner, r);
  col = mix(col, vec3(1.02, 1.00, 0.97), rim * 0.30);
  // 径向亮度轮廓:内热外暗
  float lum = 1.10 * pow(1.0 - u, 1.35) + 0.20;
  // 软边羽化(辉光过渡,无生硬边界)
  float aIn = smoothstep(inner - 0.42, inner + 0.10, r);
  float aOut = 1.0 - smoothstep(outer - 0.55, outer + 0.65, r);
  float alpha = lum * stripe * aIn * aOut;
  cc_FragColor = CCFragOutput(vec4(col, clamp(alpha, 0.0, 1.25)));
}
`;

// 片元 C:径向光晕(mode 0=大范围柔光晕,mode 1=光子环)
const FRAG_RAD_SRC = `
precision highp float;
layout(location = 0) in vec3 v_local;
layout(set = 1, binding = 0) uniform Params {
  vec4 p0; // (mode, unused, unused, unused)
};
layout(location = 0) out vec4 cc_FragColor;
vec4 CCFragOutput (vec4 color) {
  color.rgb = sqrt(max(color.rgb, vec3(0.0)));
  return color;
}
void main() {
  float mode = p0.x;
  float rw = length(v_local.xz);
  vec3 col;
  float alpha;
  if (mode < 0.5) {
    // 大范围柔光晕:从核心外柔和衰减,绝不压住暗核
    col = vec3(1.00, 0.74, 0.46);
    alpha = 0.38 * pow(clamp(1.0 - rw / 7.2, 0.0, 1.0), 1.9);
    alpha *= smoothstep(1.26, 1.85, rw);
  } else {
    // 光子环:紧贴视界的亮环(引力透镜观感的"光环")
    col = vec3(1.00, 0.97, 0.92);
    float d1 = (rw - 1.42) / 0.17;
    float d2 = (rw - 1.30) / 0.42;
    alpha = 0.62 * exp(-d1 * d1) + 0.16 * exp(-d2 * d2);
    alpha *= smoothstep(1.20, 1.26, rw);
  }
  cc_FragColor = CCFragOutput(vec4(col, clamp(alpha, 0.0, 1.0)));
}
`;

const ATTRS_META = [
    { name: 'a_position', defines: [], format: 32, location: 0 },
    { name: 'a_color', defines: [], format: 44, location: 1 },
];

function makeEffect(effectsHint, name, programName, fragSrc, passJson, properties) {
    const shaderMeta = {
        name: programName,
        hash: effectsHint.hash(),
        builtins: {
            globals: {
                blocks: [{ name: 'CCGlobal', defines: [] }, { name: 'CCCamera', defines: [] }],
                samplerTextures: [], buffers: [], images: [],
            },
            locals: {
                blocks: [{ name: 'CCLocal', defines: ['!USE_INSTANCING', '!USE_BATCHING'] }],
                samplerTextures: [], buffers: [], images: [],
            },
        },
        defines: [],
        attributes: ATTRS_META,
        blocks: properties && properties.length ? [{
            name: 'Params', defines: [], binding: 0, stageFlags: 16,
            members: properties.map((p) => ({ name: p, type: 16, count: 1 })),
        }] : [],
        samplerTextures: [], buffers: [], images: [], textures: [], samplers: [], subpassInputs: [],
        glsl4: { vert: VERT_SRC, frag: fragSrc },
        glsl3: { vert: toGlsl3(VERT_SRC), frag: toGlsl3(fragSrc) },
    };
    const effect = new EffectAsset(name);
    effect.name = name;
    effect.shaders = [shaderMeta];
    effect.techniques = [{
        name: 'default',
        passes: [Object.assign({ program: programName, rasterizerState: { cullMode: 0 } }, passJson)],
    }];
    effect.onLoaded();
    return effect;
}

const ADD_BLEND = {
    blendState: { targets: [{ blend: true, blendSrc: 2, blendDst: 1, blendSrcAlpha: 2, blendDstAlpha: 1 }] },
    depthStencilState: { depthTest: true, depthWrite: false },
};
const OPAQUE_DS = { depthStencilState: { depthTest: true, depthWrite: true } };

let hashSeed = 7919;
function nextHash() { hashSeed = (hashSeed * 1103515245 + 12345) >>> 0; return hashSeed; }

// ---------------------------------------------------------------------------
// 几何构建
// ---------------------------------------------------------------------------
function makeStaticMesh(positions, colors, indices, minP, maxP) {
    return utils.MeshUtils.createMesh({
        positions, colors, indices,
        minPos: minP, maxPos: maxP,
    });
}

// 背景星空 + 星云:世界空间静态四边形合并网格(面向相机方向)
function buildStarMesh() {
    const positions = [];
    const colors = [];
    const indices = [];
    const half = new Vec3();
    function quad(cx, cy, cz, size, r, g, b, a) {
        const base = positions.length / 3;
        const rx = CAM_RIGHT.x * size, ry = CAM_RIGHT.y * size, rz = CAM_RIGHT.z * size;
        const ux = CAM_UP.x * size, uy = CAM_UP.y * size, uz = CAM_UP.z * size;
        positions.push(
            cx + rx + ux, cy + ry + uy, cz + rz + uz,
            cx - rx + ux, cy - ry + uy, cz - rz + uz,
            cx - rx - ux, cy - ry - uy, cz - rz - uz,
            cx + rx - ux, cy + ry - uy, cz + rz - uz,
        );
        for (let k = 0; k < 4; k++) colors.push(r, g, b, a);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    for (let i = 0; i < STAR_N; i++) {
        // 球面均匀方向(拒绝法)
        let x, y, z, l;
        do {
            x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1;
            l = x * x + y * y + z * z;
        } while (l > 1 || l < 0.01);
        l = Math.sqrt(l);
        const R = 55 + Math.random() * 40;
        const t = Math.random();
        const size = t < 0.6 ? (0.13 + Math.random() * 0.14)
            : t < 0.9 ? (0.27 + Math.random() * 0.16)
                : (0.43 + Math.random() * 0.17);
        const warm = Math.random();
        let r = 1.0, g = 1.0, b = 1.0;
        if (warm < 0.55) { r = 0.85; g = 0.92; b = 1.30; }       // 蓝白
        else if (warm < 0.85) { r = 1.25; g = 1.15; b = 0.95; }  // 暖白
        else { r = 1.30; g = 0.85; b = 0.70; }                   // 橙
        const a = 0.30 + Math.random() * 0.65;
        quad(x / l * R, y / l * R, z / l * R, size, r, g, b, a);
    }
    // 星云:3 片超淡蓝紫渐变(顶点色四角渐变)
    const nebulae = [
        { d: [-0.85, 0.55, -0.10], R: 60, s: 26, c: [0.30, 0.45, 1.00], a: 0.10 },
        { d: [0.88, 0.40, -0.45], R: 62, s: 30, c: [0.35, 0.40, 1.00], a: 0.08 },
        { d: [0.10, -0.80, 0.60], R: 64, s: 24, c: [0.30, 0.50, 1.00], a: 0.07 },
    ];
    for (const n of nebulae) {
        const il = 1 / Math.hypot(n.d[0], n.d[1], n.d[2]);
        const cx = n.d[0] * il * n.R, cy = n.d[1] * il * n.R, cz = n.d[2] * il * n.R;
        const base = positions.length / 3;
        const s = n.s;
        const rx = CAM_RIGHT.x * s, ry = CAM_RIGHT.y * s, rz = CAM_RIGHT.z * s;
        const ux = CAM_UP.x * s, uy = CAM_UP.y * s, uz = CAM_UP.z * s;
        positions.push(
            cx + rx + ux, cy + ry + uy, cz + rz + uz,
            cx - rx + ux, cy - ry + uy, cz - rz + uz,
            cx - rx - ux, cy - ry - uy, cz - rz - uz,
            cx + rx - ux, cy + ry - uy, cz + rz - uz,
        );
        const r0 = n.c[0], g0 = n.c[1], b0 = n.c[2];
        colors.push(r0, g0, b0, 0);            // 角渐变:一角亮,其余透明 → 柔和贴片
        colors.push(r0 * 0.6, g0 * 0.6, b0, n.a * 0.5);
        colors.push(r0 * 0.4, g0 * 0.4, b0 * 0.9, 0);
        colors.push(r0, g0, b0, n.a);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return makeStaticMesh(positions, colors, indices,
        new Vec3(-100, -100, -100), new Vec3(100, 100, 100));
}

// 黑洞核心:UV 球(纯黑,不透明写深度 → 真实遮挡盘远缘/星流)
function buildCoreMesh() {
    const positions = [];
    const colors = [];
    const indices = [];
    const latB = 24, lonB = 36;
    for (let la = 0; la <= latB; la++) {
        const th = (la / latB) * Math.PI;
        const st = Math.sin(th), ct = -Math.cos(th);
        for (let lo = 0; lo <= lonB; lo++) {
            const ph = ((lo / lonB) * Math.PI * 2) - Math.PI / 2;
            positions.push(CORE_R * st * Math.cos(ph), CORE_R * ct, CORE_R * st * Math.sin(ph));
            colors.push(0, 0, 0, 1);
        }
    }
    for (let la = 0; la < latB; la++) {
        for (let lo = 0; lo < lonB; lo++) {
            const a = la * (lonB + 1) + lo;
            const b = a + lonB + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return makeStaticMesh(positions, colors, indices,
        new Vec3(-CORE_R, -CORE_R, -CORE_R), new Vec3(CORE_R, CORE_R, CORE_R));
}

// 吸积盘:局部 XZ 平面环形网格(y=0;着色全部在片元内完成,顶点只需平面位置)
function buildDiskMesh() {
    const positions = [];
    const colors = [];
    const indices = [];
    const rIn = INNER_R - 0.55;   // 留羽化余量
    const rOut = OUTER_R + 0.75;
    const rows = [rIn, (rIn + rOut) * 0.5, rOut];
    for (let ri = 0; ri < rows.length; ri++) {
        for (let si = 0; si <= SEG_Ring; si++) {
            const a = (si / SEG_Ring) * Math.PI * 2;
            positions.push(Math.cos(a) * rows[ri], 0, Math.sin(a) * rows[ri]);
            colors.push(1, 1, 1, 1);
        }
    }
    const W = SEG_Ring + 1;
    for (let ri = 0; ri < rows.length - 1; ri++) {
        for (let si = 0; si < SEG_Ring; si++) {
            const a = ri * W + si;
            const b = a + W;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return makeStaticMesh(positions, colors, indices,
        new Vec3(-rOut, -0.1, -rOut), new Vec3(rOut, 0.1, rOut));
}

// 面向相机的径向渐变片(光晕/光子环):局部 XZ 平面四边形,
// 由节点旋转 (90°−仰角) 使 +Y 指向相机方向 → 片元内 length(v_local.xz) 即面内径向距离
function buildRadQuadMesh(size) {
    const positions = [];
    const colors = [];
    const indices = [];
    const s = size;
    positions.push(
        s, 0, s,
        -s, 0, s,
        -s, 0, -s,
        s, 0, -s,
    );
    for (let k = 0; k < 4; k++) colors.push(1, 1, 1, 1);
    indices.push(0, 1, 2, 0, 2, 3);
    return makeStaticMesh(positions, colors, indices,
        new Vec3(-s, -s, -s), new Vec3(s, s, s));
}

// 星流:动态网格(每帧重建 220×4 顶点拖尾四边形)
// 注意:createDynamicMesh 内部立即 Mesh.initialize()(需要 gfxDevice),
// 必须在 createAirApp() 完成后调用 —— 见 init 中的 createStreamMesh()。
const streamMesh = new Mesh();
const STREAM_IDX = new Uint16Array(STREAM_N * 6); // 索引静态;每帧 update 需随 geometry 重传(见下)
function createStreamMesh() {
    const g0 = {
        positions: new Float32Array(STREAM_N * 4 * 3),
        colors: new Float32Array(STREAM_N * 4 * 4),
        // 关键:createDynamicMesh 的索引键是 indices16/indices32(不是 indices),
        // 传错键 → 无索引缓冲 → TRIANGLE_LIST 非索引绘制 → 跨粒子三角形(长线条伪影)
        indices16: STREAM_IDX,
    };
    for (let i = 0; i < STREAM_N; i++) {
        const b = i * 4;
        const ii = i * 6;
        STREAM_IDX[ii] = b; STREAM_IDX[ii + 1] = b + 1; STREAM_IDX[ii + 2] = b + 2;
        STREAM_IDX[ii + 3] = b; STREAM_IDX[ii + 4] = b + 2; STREAM_IDX[ii + 5] = b + 3;
    }
    utils.MeshUtils.createDynamicMesh(0, g0, streamMesh, {
        maxSubMeshes: 1, maxSubMeshVertices: STREAM_N * 4 + 8, maxSubMeshIndices: STREAM_N * 6 + 8,
    });
}
function tiltToWorld(x, y, z, out) {
    // 与盘父节点 setRotationFromEuler(TILT_DEG,0,0)(= Rx(TILT_RAD))完全一致的旋转
    const c = Math.cos(TILT_RAD), s = Math.sin(TILT_RAD);
    out.x = x;
    out.y = y * c - z * s;
    out.z = y * s + z * c;
}
function updateStreamGeometry() {
    const pos = new Float32Array(STREAM_N * 4 * 3);
    const col = new Float32Array(STREAM_N * 4 * 4);
    const w = new Vec3();
    for (let i = 0; i < STREAM_N; i++) {
        const p = particles[i];
        const lx = Math.cos(p.th) * p.r;
        const lz = Math.sin(p.th) * p.r;
        tiltToWorld(lx, p.y, lz, w);
        // 速度方向(优先真实帧间位移)
        let dx, dy, dz;
        if (p.hasPrev) {
            dx = w.x - p.px; dy = w.y - p.py; dz = w.z - p.pz;
            const dl = Math.hypot(dx, dy, dz);
            if (dl < 1e-5) { dx = -Math.sin(p.th); dy = 0; dz = Math.cos(p.th); }
            else { dx /= dl; dy /= dl; dz /= dl; }
        } else {
            dx = -Math.sin(p.th); dy = 0; dz = Math.cos(p.th);
        }
        p.px = w.x; p.py = w.y; p.pz = w.z; p.hasPrev = true;
        // 拖尾长度:接近视界拉长
        const near = Math.max(0, 1 - p.r / 4.2);
        const len = 0.05 + 0.62 * near * near * p.trailK;
        const hw = 0.028 + 0.030 * (1 - p.r / 7.5);
        // 宽度方向 = normalize(cross(velDir, camDir))
        let px = dy * CAM_DIR.z - dz * CAM_DIR.y;
        let py = dz * CAM_DIR.x - dx * CAM_DIR.z;
        let pz = dx * CAM_DIR.y - dy * CAM_DIR.x;
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl; py /= pl; pz /= pl;
        const tx = w.x - dx * len, ty = w.y - dy * len, tz = w.z - dz * len;
        const b = i * 4;
        // 头(亮)→ 尾(暗)
        pos[(b) * 3] = w.x + px * hw; pos[(b) * 3 + 1] = w.y + py * hw; pos[(b) * 3 + 2] = w.z + pz * hw;
        pos[(b + 1) * 3] = w.x - px * hw; pos[(b + 1) * 3 + 1] = w.y - py * hw; pos[(b + 1) * 3 + 2] = w.z - pz * hw;
        pos[(b + 2) * 3] = tx - px * hw; pos[(b + 2) * 3 + 1] = ty - py * hw; pos[(b + 2) * 3 + 2] = tz - pz * hw;
        pos[(b + 3) * 3] = tx + px * hw; pos[(b + 3) * 3 + 1] = ty + py * hw; pos[(b + 3) * 3 + 2] = tz + pz * hw;
        col[b * 4] = p.cr; col[b * 4 + 1] = p.cg; col[b * 4 + 2] = p.cb; col[b * 4 + 3] = 0.95;
        col[(b + 1) * 4] = p.cr; col[(b + 1) * 4 + 1] = p.cg; col[(b + 1) * 4 + 2] = p.cb; col[(b + 1) * 4 + 3] = 0.95;
        col[(b + 2) * 4] = p.cr * 0.35; col[(b + 2) * 4 + 1] = p.cg * 0.35; col[(b + 2) * 4 + 2] = p.cb * 0.35; col[(b + 2) * 4 + 3] = 0.30;
        col[(b + 3) * 4] = p.cr * 0.35; col[(b + 3) * 4 + 1] = p.cg * 0.35; col[(b + 3) * 4 + 2] = p.cb * 0.35; col[(b + 3) * 4 + 3] = 0.30;
    }
    // updateSubMesh:顶点缓冲按创建时属性序(positions → colors)重传;
    // 创建时带 indices16 → primitive.indexView 存在 → 每帧必须重传 indices16,否则
    // updateSubMesh 读 dynamicGeometry.indices16.length 抛 TypeError(引擎按帧 console.error)
    streamMesh.updateSubMesh(0, { positions: pos, colors: col, indices16: STREAM_IDX });
}

// ---------------------------------------------------------------------------
// 每帧行为组件
// ---------------------------------------------------------------------------
const tmpV = new Vec3();
class E05Updater extends Component {
    constructor() {
        super();
        this.diskMtl = null;
        this.cameraNode = null;
    }
    update(dt) {
        // 真实时间步进;钳制失焦→聚焦的大 dt(防状态突变)
        if (!(dt > 0)) dt = 0;
        if (dt > 0.05) dt = 0.05;
        state.time += dt;
        state.diskRot += OMEGA * dt;
        // 相机平滑缩放
        const d = state.distTarget - state.dist;
        if (Math.abs(d) < 0.0008) state.dist = state.distTarget;
        else state.dist += d * Math.min(1, ZOOM_RATE * dt);
        const cn = this.cameraNode;
        if (cn) {
            tmpV.set(CAM_DIR.x * state.dist, CAM_DIR.y * state.dist, CAM_DIR.z * state.dist);
            cn.setPosition(tmpV);
            cn.lookAt(new Vec3(0, 0, 0));
        }
        // 盘 uniform:角度随 diskRotation 推进(状态与画面严格同源)
        if (this.diskMtl) {
            this.diskMtl.setProperty('p0', new Vec4(INNER_R, OUTER_R, 14, 0));
            this.diskMtl.setProperty('p1', new Vec4(state.diskRot, 0.55, 1.0, 0));
        }
        // 星流推进 + 网格重建
        for (let i = 0; i < STREAM_N; i++) {
            const p = particles[i];
            p.th += 1.35 * Math.pow(p.r, -1.5) * dt;
            p.r -= 0.14 * Math.pow(2.5 / p.r, 2) * p.jit * dt;
            if (p.r < CORE_R + 0.06) respawnParticle(p, false);
        }
        updateStreamGeometry();
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    // 动态网格(需要 gfxDevice,必须在 createAirApp 之后)
    createStreamMesh();

    // 自定义 effects(builtin 注册完成后才可创建)
    const solidFx = makeEffect({ hash: nextHash }, 'e05-solid', 'e05a|e05-vs:vert|e05-vcf:frag',
        FRAG_VCOL_SRC, OPAQUE_DS, null);
    const addFx = makeEffect({ hash: nextHash }, 'e05-add', 'e05b|e05-vs:vert|e05-vcf:frag',
        FRAG_VCOL_SRC, ADD_BLEND, null);
    const diskFx = makeEffect({ hash: nextHash }, 'e05-disk', 'e05c|e05-vs:vert|e05-dskf:frag',
        FRAG_DISK_SRC,
        {
            blendState: { targets: [{ blend: true, blendSrc: 2, blendDst: 1, blendSrcAlpha: 2, blendDstAlpha: 1 }] },
            depthStencilState: { depthTest: true, depthWrite: false },
        },
        ['p0', 'p1']);
    const radFx = makeEffect({ hash: nextHash }, 'e05-rad', 'e05d|e05-vs:vert|e05-radf:frag',
        FRAG_RAD_SRC,
        {
            blendState: { targets: [{ blend: true, blendSrc: 2, blendDst: 1, blendSrcAlpha: 2, blendDstAlpha: 1 }] },
            depthStencilState: { depthTest: true, depthWrite: false },
        },
        ['p0']);

    const solidMtl = new Material();
    solidMtl.initialize({ effectAsset: solidFx });
    const addMtl = new Material();
    addMtl.initialize({ effectAsset: addFx });
    const diskMtl = new Material();
    diskMtl.initialize({ effectAsset: diskFx });
    const haloMtl = new Material();
    haloMtl.initialize({ effectAsset: radFx });
    haloMtl.setProperty('p0', new Vec4(0, 0, 0, 0));
    const ringMtl = new Material();
    ringMtl.initialize({ effectAsset: radFx });
    ringMtl.setProperty('p0', new Vec4(1, 0, 0, 0));

    const scene = new Scene('e05-blackhole');

    // 相机
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(CAM_DIR.x * DIST0, CAM_DIR.y * DIST0, CAM_DIR.z * DIST0));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 60;
    camera.near = 0.1;
    camera.far = 300;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(13, 15, 28, 255); // 近黑深空(非纯黑,保证四角外围非空)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 背景星空 + 星云
    const starNode = new Node('Stars');
    starNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(starNode);
    const starMr = starNode.addComponent(MeshRenderer);
    starMr.mesh = buildStarMesh();
    starMr.material = addMtl;

    // 黑洞核心(不透明,写深度)
    const coreNode = new Node('Core');
    coreNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(coreNode);
    const coreMr = coreNode.addComponent(MeshRenderer);
    coreMr.mesh = buildCoreMesh();
    coreMr.material = solidMtl;

    // 吸积盘(倾斜父节点)
    const tiltNode = new Node('DiskTilt');
    tiltNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(tiltNode);
    // setRotationFromEuler 为角度口径(模板 Rotator 同口径);Rx(TILT_DEG) 使盘远缘上抬。
    // (此前误判为弧度口径:竖直环实际是光晕 quad 的 v_local.xz 基底错位伪影,已修复)
    tiltNode.setRotationFromEuler(TILT_DEG, 0, 0);
    const diskNode = new Node('Disk');
    diskNode.layer = Layers.Enum.DEFAULT;
    tiltNode.addChild(diskNode);
    const diskMr = diskNode.addComponent(MeshRenderer);
    diskMr.mesh = buildDiskMesh();
    diskMr.material = diskMtl;

    // 光子环 + 柔光晕(局部 XZ 平面 quad,节点 +Y 旋向相机方向;相机方位恒定 → 静态)
    const FACE_CAM_DEG = 90 - ELEV_DEG; // Rx(FACE_CAM_DEG): +Y → (0, sinE, cosE) = CAM_DIR
    const ringNode = new Node('PhotonRing');
    ringNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(ringNode);
    ringNode.setRotationFromEuler(FACE_CAM_DEG, 0, 0);
    const ringMr = ringNode.addComponent(MeshRenderer);
    ringMr.mesh = buildRadQuadMesh(3.0);
    ringMr.material = ringMtl;

    const haloNode = new Node('Halo');
    haloNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(haloNode);
    haloNode.setRotationFromEuler(FACE_CAM_DEG, 0, 0);
    const haloMr = haloNode.addComponent(MeshRenderer);
    haloMr.mesh = buildRadQuadMesh(7.4);
    haloMr.material = haloMtl;

    // 星流(动态网格)
    const streamNode = new Node('StarStream');
    streamNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(streamNode);
    const streamMr = streamNode.addComponent(MeshRenderer);
    streamMr.mesh = streamMesh;
    streamMr.material = addMtl;

    // 每帧更新器
    const updaterNode = new Node('Updater');
    scene.addChild(updaterNode);
    const updater = updaterNode.addComponent(E05Updater);
    updater.diskMtl = diskMtl;
    updater.cameraNode = cameraNode;

    window.__airApp = app;
    app.run(scene);

    // 首帧就绪(每渲染帧触发,同模板口径)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) window.__appReady = true;
    });
} catch (err) {
    console.error('[e05] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
