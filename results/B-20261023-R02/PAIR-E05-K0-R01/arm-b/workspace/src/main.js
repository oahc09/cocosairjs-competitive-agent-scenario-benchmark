/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair arm-b(K0)
 *
 * 构成:
 *   - 背景星空:340 颗静态星(球面分布四边形面片,顶点色,加法混合)
 *   - 黑洞核心:半径 1.2 的纯黑球(unlit 黑材质,深度写入 → 视觉"事件视界")
 *   - 吸积盘:XZ 平面环形网格(1.32→7.4)+ 自定义 shader(径向温度梯度/旋转螺旋
 *     条纹/多普勒不对称/内缘蓝白光子环;时间参数驱动真实旋转)
 *   - 引力透镜晕环(加分):同一环形网格绕 X 轴立起,加法混合,上亮下暗
 *   - 辉光观感:AIR 默认姿态 post-process 不可达(pipeline-reachability 合同),
 *     以"多层叠加式混合 + shader 内衰减"替代:盘本身内亮外暗软衰减 + 大尺寸
 *     径向辉光面片(mode 2)+ 星点软边
 *   - 星流:240 粒子(动态网格 utils.MeshUtils.createDynamicMesh + updateSubMesh,
 *     每帧重写顶点),螺旋轨迹吸入,近视界加速拉长,吞噬后外圈重生,总数恒定
 *   - 相机:距离 14,滚轮(capture 监听,pal 不拦 capture 相)平滑缩放 [5,28]
 *
 * 页面契约:window.__appReady(首帧后 true)/ window.__bench = { getState, reset }。
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
    director,
    Director,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量(与 spec 对齐)
// ---------------------------------------------------------------------------
const DISK_OMEGA = 0.32;          // 盘旋转角速度 rad/s(spec: 0.15-0.6)
const CAM_INIT_DIST = 14.0;
const CAM_MIN_DIST = 5.0;
const CAM_MAX_DIST = 28.0;
const CAM_ELEV = 0.42;            // 相机仰角 rad(俯视感 15-75° 倾角区间内)
const HORIZON_R = 1.2;            // 事件视界半径
const DISK_INNER = 1.32;
const DISK_OUTER = 7.4;
const STREAM_COUNT = 240;         // 星流粒子数(>=200,恒定)
const BG_STAR_COUNT = 340;        // 背景星数(>=300,恒定)

// ---------------------------------------------------------------------------
// 运行状态(getState 数据源,全部真实量)
// ---------------------------------------------------------------------------
const state = {
    frame: 0,
    resetCount: 0,
    simTime: 0,                   // 自上次 reset 起的仿真时间(驱动旋转/相位)
    camTarget: CAM_INIT_DIST,     // 滚轮目标距离
    camCur: CAM_INIT_DIST,        // 当前实际距离(平滑插值)
};

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

window.__appReady = false;

// --- UI:reset 按钮(右上角,data-ui 契约) ----------------------------------
{
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
        "font:12px sans-serif;background:#222;color:#fff;border:1px solid #555;" +
        'border-radius:4px;cursor:pointer';
    document.body.appendChild(btn);
    // 逻辑在 doReset 定义后绑定(下方 IIFE 前,先挂引用)
    window.__resetBtn = btn;
}

// ---------------------------------------------------------------------------
// GLSL(glsl4 为主稿带 layout;glsl3 为 WebGL2 实际消费变体,无 layout,
// 依 custom-glsl 合同:builtin 块按名前缀子集声明,UBO 成员仅 vec4)
// ---------------------------------------------------------------------------
const VERT_COMMON_HEAD = (extraIns, extraOuts) => `
precision highp float;
${extraIns}
uniform CCCamera {
    highp mat4 cc_matView;
    highp mat4 cc_matProj;
    highp mat4 cc_matViewProj;
};
uniform CCLocal {
    highp mat4 cc_matWorld;
    highp mat4 cc_matWorldIT;
    highp vec4 cc_worldPos;
};
${extraOuts}
`;

const DISK_VERT = VERT_COMMON_HEAD(
    'in vec3 a_position;',
    'out vec3 v_local;\nout vec3 v_world;',
) + `
void main () {
    v_local = a_position;
    vec4 wp = cc_matWorld * vec4(a_position, 1.0);
    v_world = wp.xyz;
    gl_Position = cc_matViewProj * wp;
}
`;

const DISK_FRAG = `
precision highp float;
out vec4 fragColor;
in vec3 v_local;
in vec3 v_world;
uniform Constants {
    vec4 u_p0;   // x=diskAngle(累计弧度) y=mode(0盘/1透镜晕/2辉光) z=intensity w=unused
    vec4 u_p1;   // x=innerR y=outerR z=dopplerAmt w=unused
};
void main () {
    float mode = u_p0.y;
    float r = length(v_local.xz);
    float IN = u_p1.x;
    float OUT = u_p1.y;

    if (mode > 1.5) {
        // ---- 辉光面片(mode 2):围绕核心的柔和扩散光晕,中心挖空保住暗核 ----
        float hole = smoothstep(1.05, 2.1, r);
        float g1 = exp(-pow((r - 1.9) / 2.2, 2.0));       // 主晕
        float g2 = 0.30 * exp(-pow(r / 5.2, 2.0));          // 宽域淡晕
        vec3 col = vec3(1.0, 0.82, 0.55) * g1 * 0.85 + vec3(1.0, 0.60, 0.28) * g2;
        fragColor = vec4(col * hole * u_p0.z, 1.0);
        return;
    }

    // ---- 吸积盘 / 透镜晕环(mode 0/1) ----
    float ang = atan(v_local.z, v_local.x);
    float t = clamp((r - IN) / (OUT - IN), 0.0, 1.0);
    float edges = smoothstep(IN, IN + 0.20, r) * (1.0 - smoothstep(OUT - 1.5, OUT, r));

    // 旋转螺旋条纹:时间参数 u_p0.x 连续推进(真实旋转,非贴图回放)
    float s = ang - u_p0.x - r * 0.85;
    float arm = 0.5 + 0.5 * sin(s * 6.0 + 1.6 * sin(s * 2.0 + 0.8));
    arm = pow(arm, 1.6);
    float arm2 = 0.5 + 0.5 * sin(s * 13.0 + 3.1);
    float streak = 0.52 + 0.48 * arm * (0.8 + 0.2 * arm2);

    // 多普勒不对称(加分):左侧(-X)接近侧增亮
    float dop = 1.0 + u_p1.z * cos(ang + 3.14159265);

    // 径向温度梯度:内缘白/蓝白 → 中带亮橙 → 外缘暗红
    float rim = exp(-pow((r - IN - 0.06) / 0.30, 2.0));    // 内缘光子环
    vec3 cBlue = vec3(0.92, 0.97, 1.12);
    vec3 cHot  = vec3(1.05, 0.99, 0.92);
    vec3 cMid  = vec3(1.05, 0.52, 0.14);
    vec3 cOut  = vec3(0.52, 0.10, 0.035);
    vec3 col = mix(cHot, cMid, smoothstep(0.04, 0.42, t));
    col = mix(col, cOut, smoothstep(0.40, 0.94, t));
    col += cBlue * rim * (0.55 + 0.65 * streak);

    float I = (2.3 * exp(-t * 2.3) + 1.7 * rim) * streak * dop * edges;

    if (mode > 0.5) {
        // 透镜晕环:整体减光,上弧亮、下弧暗(盘前缘覆盖处的视觉让位)
        float up = clamp((v_world.y + 2.0) / 5.0, 0.0, 1.0);
        I *= 0.30 + 0.70 * smoothstep(0.10, 0.75, up);
        I *= 0.55;
    }
    fragColor = vec4(col * I * u_p0.z, 1.0);
}
`;

const STAR_VERT = VERT_COMMON_HEAD(
    'in vec3 a_position;\nin vec2 a_texCoord;\nin vec4 a_color;',
    'out vec2 v_uv;\nout vec4 v_color;',
) + `
void main () {
    v_uv = a_texCoord;
    v_color = a_color;
    gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}
`;

const STAR_FRAG = `
precision highp float;
out vec4 fragColor;
in vec2 v_uv;
in vec4 v_color;
uniform Constants {
    vec4 u_p0;   // x=intensity
};
void main () {
    float d2 = dot(v_uv, v_uv);
    if (d2 > 1.0) discard;
    float fall = exp(-d2 * 4.5) + 0.18 * (1.0 - d2);   // 软边光斑(辉光观感)
    vec3 col = v_color.rgb * v_color.a * fall * u_p0.x;
    fragColor = vec4(col, 1.0);
}
`;

// glsl4 主稿(带 layout;WebGL2 设备只消费 glsl3)
const withLayout = (src) => src
    .replace('uniform CCCamera {', 'layout(set = 0, binding = 1) uniform CCCamera {')
    .replace('uniform CCLocal {', 'layout(set = 2, binding = 0) uniform CCLocal {')
    .replace('uniform Constants {', 'layout(set = 1, binding = 0) uniform Constants {');

/** 构建自定义 effect(手写已编译形态 JSON + glsl4/glsl3 双变体)。 */
function makeEffect(name, vert, frag, attributes, members) {
    const json = {
        name,
        techniques: [{
            passes: [{
                program: name,
                properties: {},
                // 加法混合(ONE/ONE,亮度在 shader 内预乘)+ 关深度写 + 不剔背面
                blendState: {
                    targets: [{
                        blend: true,
                        blendEq: gfx.BlendOp.ADD,
                        blendSrc: gfx.BlendFactor.ONE,
                        blendDst: gfx.BlendFactor.ONE,
                        blendAlphaEq: gfx.BlendOp.ADD,
                        blendSrcAlpha: gfx.BlendFactor.ONE,
                        blendDstAlpha: gfx.BlendFactor.ONE,
                    }],
                },
                depthStencilState: { depthTest: true, depthWrite: false },
                rasterizerState: { cullMode: gfx.CullMode.NONE },
                primitive: gfx.PrimitiveMode.TRIANGLE_LIST,
            }],
        }],
        shaders: [{
            name,
            hash: 'a1b2' + name.slice(-4),   // 每个模板必须唯一:ProgramLib 模板缓存键
            builtins: {
                globals: { blocks: [{ name: 'CCCamera', set: 0, binding: 1 }], samplerTextures: [] },
                locals: { blocks: [{ name: 'CCLocal', set: 2, binding: 0 }], samplerTextures: [] },
                statistics: {},
            },
            blocks: [{ name: 'Constants', set: 1, binding: 0, stageFlags: gfx.ShaderStageFlagBit.VERTEX | gfx.ShaderStageFlagBit.FRAGMENT, members }],
            samplerTextures: [],
            samplers: [],
            textures: [],
            buffers: [],
            images: [],
            subpassInputs: [],
            attributes,
            defines: [],
            combinations: [],
            glsl4: { vert: withLayout(vert), frag: withLayout(frag) },
            glsl3: { vert, frag },
        }],
    };
    const eff = Object.assign(new EffectAsset(), json);
    eff.onLoaded();
    return eff;
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------
/** XZ 平面环形网格(内→外),仅 a_position。 */
function makeRingGeometry(innerR, outerR, angularSeg, radialSeg) {
    const vertCount = (angularSeg + 1) * (radialSeg + 1);
    const positions = new Float32Array(vertCount * 3);
    let vi = 0;
    for (let i = 0; i <= angularSeg; i++) {
        const a = (i / angularSeg) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let j = 0; j <= radialSeg; j++) {
            const r = innerR + (outerR - innerR) * (j / radialSeg);
            positions[vi++] = ca * r;
            positions[vi++] = 0;
            positions[vi++] = sa * r;
        }
    }
    const indices = new Uint16Array(angularSeg * radialSeg * 6);
    let ii = 0;
    for (let i = 0; i < angularSeg; i++) {
        for (let j = 0; j < radialSeg; j++) {
            const a0 = i * (radialSeg + 1) + j;
            const b0 = (i + 1) * (radialSeg + 1) + j;
            indices[ii++] = a0; indices[ii++] = b0; indices[ii++] = a0 + 1;
            indices[ii++] = a0 + 1; indices[ii++] = b0; indices[ii++] = b0 + 1;
        }
    }
    return {
        positions,
        indices,
        minPosition: new Vec3(-outerR, -0.01, -outerR),
        maxPosition: new Vec3(outerR, 0.01, outerR),
    };
}

/** 居中 XZ 平面大四边形(辉光面片用)。 */
function makeQuadGeometry(half) {
    return {
        positions: new Float32Array([
            -half, 0, -half, half, 0, -half, -half, 0, half, half, 0, half,
        ]),
        indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
        minPosition: new Vec3(-half, -0.01, -half),
        maxPosition: new Vec3(half, 0.01, half),
    };
}

/** 四边形面片星群几何(positions+uvs+colors,角点 uv ∈ [-1,1])。 */
function makeStarFieldGeometry(count, seed, radiusFn) {
    const rand = mulberry32(seed);
    const positions = new Float32Array(count * 4 * 3);
    const uvs = new Float32Array(count * 4 * 2);
    const colors = new Float32Array(count * 4 * 4);
    const indices = new Uint16Array(count * 6);
    const palettes = [
        [1.0, 1.0, 1.0], [0.72, 0.82, 1.0], [1.0, 0.86, 0.68], [1.0, 0.70, 0.52],
    ];
    for (let i = 0; i < count; i++) {
        // 球面均匀方向
        const u = rand() * 2 - 1;
        const phi = rand() * Math.PI * 2;
        const sq = Math.sqrt(1 - u * u);
        const n = new Vec3(sq * Math.cos(phi), u, sq * Math.sin(phi));
        const R = radiusFn(rand);
        const size = 0.9 + rand() * rand() * 2.6;
        const bright = 0.25 + rand() * 0.75;
        const pal = palettes[Math.floor(rand() * palettes.length)];

        // 切平面基
        const up = Math.abs(n.y) < 0.95 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
        const t1 = new Vec3().cross(n, up).normalize();
        const t2 = new Vec3().cross(n, t1).normalize();
        const center = new Vec3(n.x * R, n.y * R, n.z * R);

        const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let c = 0; c < 4; c++) {
            const [cu, cv] = corners[c];
            const vi = (i * 4 + c);
            positions[vi * 3] = center.x + t1.x * cu * size + t2.x * cv * size;
            positions[vi * 3 + 1] = center.y + t1.y * cu * size + t2.y * cv * size;
            positions[vi * 3 + 2] = center.z + t1.z * cu * size + t2.z * cv * size;
            uvs[vi * 2] = cu;
            uvs[vi * 2 + 1] = cv;
            colors[vi * 4] = pal[0];
            colors[vi * 4 + 1] = pal[1];
            colors[vi * 4 + 2] = pal[2];
            colors[vi * 4 + 3] = bright;
        }
        const b = i * 4;
        indices.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
    }
    return {
        positions, uvs, colors, indices,
        minPosition: new Vec3(-200, -200, -200),
        maxPosition: new Vec3(200, 200, 200),
    };
}

// ---------------------------------------------------------------------------
// 星流粒子系统(动态网格)
// ---------------------------------------------------------------------------
const streamParts = [];
const streamRespawnRand = mulberry32(99173);   // 重生用确定性随机流(时间推进)
function seedStream(seed) {
    const rand = mulberry32(seed);
    streamParts.length = 0;
    for (let i = 0; i < STREAM_COUNT; i++) {
        streamParts.push({
            r: 1.45 + rand() * 5.0,
            th: rand() * Math.PI * 2,
            y: (rand() - 0.5) * 0.12,
            dim: 0.7 + rand() * 0.3,   // 个体亮度差
        });
    }
}
seedStream(20261023);

const streamGeom = {
    positions: new Float32Array(STREAM_COUNT * 4 * 3),
    uvs: new Float32Array(STREAM_COUNT * 4 * 2),
    colors: new Float32Array(STREAM_COUNT * 4 * 4),
    indices: (() => {
        const idx = new Uint16Array(STREAM_COUNT * 6);
        for (let i = 0; i < STREAM_COUNT; i++) {
            const b = i * 4;
            idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
        }
        return idx;
    })(),
    minPosition: new Vec3(-8, -1, -8),
    maxPosition: new Vec3(8, 1, 8),
};

/** 每帧把粒子写入 streamGeom 顶点缓冲(螺旋轨迹/近核加速拉长/吞噬重生)。 */
function updateStreamGeometry(dt) {
    for (let i = 0; i < STREAM_COUNT; i++) {
        const p = streamParts[i];
        // 开普勒-ish 角速度 + 向内漂移(近视界加速)
        const omega = 2.0 / Math.pow(p.r, 1.5);
        const vr = -(0.10 + 1.9 / Math.max(p.r - 1.05, 0.15));
        p.th += omega * dt;
        p.r += vr * dt;
        if (p.r < 1.30) {
            p.r = 5.9 + streamRespawnRand() * 0.6;
            p.th = streamRespawnRand() * Math.PI * 2;
        }
        // 拖尾拉长(近视界指数增强)
        const L = 0.14 + 0.35 * Math.exp(-(p.r - 1.3) * 1.2) + 0.90 * Math.exp(-(p.r - 1.3) * 1.8);
        const W = 0.05 + 0.06 * Math.exp(-(p.r - 1.3));
        const ct = Math.cos(p.th), st = Math.sin(p.th);
        const tx = -st, tz = ct;      // 切向(速度方向)
        const rx = ct, rz = st;       // 径向
        const cx = ct * p.r, cz = st * p.r;
        // 温度色:内白蓝热、外橙暗
        const tn = Math.min(Math.max((p.r - 1.3) / 5.2, 0), 1);
        const k = Math.min(Math.max((tn - 0.05) / 0.45, 0), 1);
        const cr = 1.0 + 0.4 * (1 - k);
        const cg = 1.0 - 0.45 * k;
        const cb = 1.0 - 0.80 * k * k;
        const bright = (1.5 * Math.exp(-tn * 2.0) + 0.30) * p.dim;
        const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let c = 0; c < 4; c++) {
            const [cu, cv] = corners[c];
            const vi = i * 4 + c;
            streamGeom.positions[vi * 3] = cx + tx * cu * (L * 0.5) + rx * cv * (W * 0.5);
            streamGeom.positions[vi * 3 + 1] = p.y;
            streamGeom.positions[vi * 3 + 2] = cz + tz * cu * (L * 0.5) + rz * cv * (W * 0.5);
            streamGeom.uvs[vi * 2] = cu;
            streamGeom.uvs[vi * 2 + 1] = cv;
            streamGeom.colors[vi * 4] = cr;
            streamGeom.colors[vi * 4 + 1] = cg;
            streamGeom.colors[vi * 4 + 2] = cb;
            streamGeom.colors[vi * 4 + 3] = bright;
        }
    }
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------
let doReset = () => {};
function bindReset(fn) { doReset = fn; }

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
        diskRotation: DISK_OMEGA * state.simTime,
        accretionPhase: ((DISK_OMEGA * state.simTime) % (Math.PI * 2)) / (Math.PI * 2),
        cameraDistance: state.camCur,
        starStreamCount: STREAM_COUNT,
        backgroundStarCount: BG_STAR_COUNT,
        resetCount: state.resetCount,
    }),
    reset: () => doReset(),
};
window.__resetBtn.addEventListener('click', () => doReset());

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
class Driver extends Component {
    constructor() {
        super();
        this.ctx = null;
    }
    update(dt) {
        const d = Math.min(dt, 0.05);   // 失焦恢复不产生时间跳变
        const ctx = this.ctx;
        state.simTime += d;
        const angle = DISK_OMEGA * state.simTime;

        // 相机平滑插值(1s 内基本到位)
        state.camCur += (state.camTarget - state.camCur) * (1 - Math.exp(-5.5 * d));
        ctx.cameraNode.setPosition(
            0,
            Math.sin(CAM_ELEV) * state.camCur,
            Math.cos(CAM_ELEV) * state.camCur,
        );

        // 盘/晕 uniform(时间参数驱动)
        ctx.uDisk0.set(angle, 0, 1.0, 0);
        ctx.diskMat.setProperty('u_p0', ctx.uDisk0);
        ctx.uHalo0.set(angle, 1, 1.0, 0);
        ctx.haloMat.setProperty('u_p0', ctx.uHalo0);

        // 星流动态网格
        updateStreamGeometry(d);
        ctx.streamMesh.updateSubMesh(0, streamGeom);
        ctx.streamRenderer.onGeometryChanged();
    }
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('E05');

    // --- 相机(远裁剪覆盖背景星球壳) ---
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, Math.sin(CAM_ELEV) * CAM_INIT_DIST, Math.cos(CAM_ELEV) * CAM_INIT_DIST);
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 60;
    camera.near = 0.5;
    camera.far = 500;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(5, 7, 16, 255);   // 近黑深空底色
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // --- 自定义 effects(须在 createAirApp 之后注册/实例化) ---
    console.log('[E05] stage: effects');
    const ATTR_DISK = [{ name: 'a_position', format: gfx.Format.RGB32F, isNormalized: false, isInstanced: false, location: 0, defines: [] }];
    const ATTR_STAR = [
        { name: 'a_position', format: gfx.Format.RGB32F, isNormalized: false, isInstanced: false, location: 0, defines: [] },
        { name: 'a_color', format: gfx.Format.RGBA32F, isNormalized: false, isInstanced: false, location: 1, defines: [] },
        { name: 'a_texCoord', format: gfx.Format.RG32F, isNormalized: false, isInstanced: false, location: 2, defines: [] },
    ];
    const MEMBERS2 = [
        { name: 'u_p0', type: 16, count: 1 },
        { name: 'u_p1', type: 16, count: 1 },
    ];
    const MEMBERS1 = [{ name: 'u_p0', type: 16, count: 1 }];
    const diskEffect = makeEffect('e05-disk', DISK_VERT, DISK_FRAG, ATTR_DISK, MEMBERS2);
    const starEffect = makeEffect('e05-star', STAR_VERT, STAR_FRAG, ATTR_STAR, MEMBERS1);

    const uP1 = new Vec4(DISK_INNER, DISK_OUTER, 0.5, 0);

    function makeLayerNode(name, mesh, material) {
        const node = new Node(name);
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = mesh;
        r.material = material;   // setter 存共享引用;此后不再读 getter
        return { node, renderer: r };
    }

    // --- 背景星空(静态,一次性) ---
    console.log('[E05] stage: bg-stars');
    const starMat = new Material();
    starMat.initialize({ effectAsset: starEffect });
    starMat.setProperty('u_p0', new Vec4(1.15, 0, 0, 0));
    const bgStarMesh = utils.MeshUtils.createMesh(
        makeStarFieldGeometry(BG_STAR_COUNT, 424242, (rand) => 120 + rand() * 40),
    );
    makeLayerNode('bg-stars', bgStarMesh, starMat);

    // --- 黑洞核心:纯黑不透明球(深度写入 → 视觉事件视界 + 遮挡盘远侧) ---
    console.log('[E05] stage: core');
    const coreMat = new Material();
    coreMat.initialize({ effectName: 'builtin-unlit' });
    coreMat.setProperty('mainColor', new Color(0, 0, 0, 255));
    makeLayerNode(
        'black-core',
        utils.MeshUtils.createMesh(primitives.sphere({ radius: HORIZON_R, segments: 32 })),
        coreMat,
    );

    // --- 吸积盘(mode 0) ---
    console.log('[E05] stage: disk');
    const diskMat = new Material();
    diskMat.initialize({ effectAsset: diskEffect });
    diskMat.setProperty('u_p1', uP1);
    diskMat.setProperty('u_p0', new Vec4(0, 0, 1.0, 0));
    makeLayerNode(
        'accretion-disk',
        utils.MeshUtils.createMesh(makeRingGeometry(DISK_INNER, DISK_OUTER, 240, 30)),
        diskMat,
    );

    // --- 引力透镜晕环(mode 1,立环) ---
    console.log('[E05] stage: halo');
    const haloMat = new Material();
    haloMat.initialize({ effectAsset: diskEffect });
    haloMat.setProperty('u_p1', uP1);
    haloMat.setProperty('u_p0', new Vec4(0, 1, 1.0, 0));
    const halo = makeLayerNode(
        'lens-halo',
        utils.MeshUtils.createMesh(makeRingGeometry(1.4, 6.9, 240, 24)),
        haloMat,
    );
    halo.node.setRotationFromEuler(Math.PI / 2, 0, 0);

    // --- 辉光面片(mode 2) ---
    console.log('[E05] stage: glow');
    const glowMat = new Material();
    glowMat.initialize({ effectAsset: diskEffect });
    glowMat.setProperty('u_p1', uP1);
    glowMat.setProperty('u_p0', new Vec4(0, 2, 1.0, 0));
    makeLayerNode('glow', utils.MeshUtils.createMesh(makeQuadGeometry(13)), glowMat);

    // --- 星流(动态网格) ---
    console.log('[E05] stage: stream');
    const streamMat = new Material();
    streamMat.initialize({ effectAsset: starEffect });
    streamMat.setProperty('u_p0', new Vec4(1.0, 0, 0, 0));
    const streamMesh = utils.MeshUtils.createDynamicMesh(0, streamGeom, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: 1024,
        maxSubMeshIndices: 4096,
    });
    const stream = makeLayerNode('star-stream', streamMesh, streamMat);

    // --- 驱动组件 ---
    const driverNode = new Node('driver');
    scene.addChild(driverNode);
    const driver = driverNode.addComponent(Driver);
    driver.ctx = {
        cameraNode,
        diskMat, haloMat,
        uDisk0: new Vec4(0, 0, 1, 0),
        uHalo0: new Vec4(0, 1, 1, 0),
        streamMesh,
        streamRenderer: stream.renderer,
    };

    // --- reset 语义:距离回 14、旋转/相位归零、星流复位重生、背景星不变 ---
    bindReset(() => {
        state.resetCount += 1;
        state.simTime = 0;
        state.camTarget = CAM_INIT_DIST;
        state.camCur = CAM_INIT_DIST;
        seedStream(20261023 + state.resetCount * 17);
    });

    // --- 滚轮缩放(capture 监听:pal 层不拦捕获相;负 dy=靠近放大) ---
    window.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
        state.camTarget = Math.min(CAM_MAX_DIST, Math.max(CAM_MIN_DIST, state.camTarget + dy * 0.012));
    }, { capture: true, passive: false });

    window.__airApp = app;
    app.run(scene);

    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[E05] running on cocosair', app.getScene() && app.getScene().name);
} catch (err) {
    console.error('[E05] fatal:', err && err.message ? err.message : err);
    window.__fatal = String((err && err.stack) || err);
    setTimeout(() => { throw err; }, 0);
}
