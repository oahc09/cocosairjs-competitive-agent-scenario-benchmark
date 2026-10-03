/**
 * E01 — 深空星系巡航(Deep Space Galaxy Cruise) — arm-b / cocosair
 *
 * 实现路径(全部程序化,无外部资产):
 *   - 50,000 个星点以单个 Mesh(POINT_LIST 图元)一次批量提交渲染;
 *     顶点属性 a_position(RGB32F) + a_color(RGBA32F),alpha 通道编码星点亮暗/尺寸层级。
 *   - 材质 effect:克隆引擎 builtin-unlit 的反射元数据,替换为自写的 glsl4 点渲染着色器
 *     (顶点着色器按透视衰减写 gl_PointSize,片元着色器以 gl_PointCoord 做圆形软辉光),
 *     pass.primitive = POINT_LIST,加法混合(ONE/ONE),无深度写入 —— 真实 3D 渲染管线提交。
 *   - 星系结构:核球(高斯球状隆起)+ 2 条对数螺旋旋臂 + 盘面散星 + 远景暗弱背景壳,
 *     颜色沿半径暖黄白 → 蓝白 → 冷蓝梯度,并散布橙红亮星;3 档亮暗层级。
 *   - 星系整体绕盘面法线(Y 轴)慢旋(rotationPhase,0.06 rad/s);
 *     鼠标视差 = 相机沿视轴垂直方向小幅偏移;滚轮平滑改变相机距离([40,400],初始 120);
 *     HUD(DOM 覆盖层)实时显示星点总数/帧率/相机距离;Reset 恢复初始观察状态并 epoch+1。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(), reset() } — 见 spec.json stateContract。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    Mesh,
    MeshRenderer,
    Material,
    EffectAsset,
    Vec3,
    Color,
    Component,
    director,
    Director,
    gfx,
} from 'cocosair.js';

// ============================================================================
// 常量与状态
// ============================================================================
const STAR_COUNT = 50000;          // 状态报告值 == 真实提交渲染的星点数
const GALAXY_RADIUS = 55;          // 星系盘半径(状态报告单位)
const ARM_COUNT = 2;               // 对数螺旋旋臂数
const INITIAL_DISTANCE = 120;      // 初始相机距离
const MIN_DISTANCE = 40;
const MAX_DISTANCE = 400;
const ROTATION_SPEED = 0.06;       // rad/s(角速度契约 0.02–0.1)
const PARALLAX_GAIN = 0.06;        // 视差视觉位移 ≈ 指针偏移 × 6% 距离(≤ 画布 10%)
const PARALLAX_RATE = 1.2;         // 视差平滑速率(1/s,无过冲的指数趋近)
const DIST_RATE = 2.5;             // 距离平滑速率(1/s)
const FOV_DEG = 45;
const ELEV_DEG = 40;               // 斜俯视仰角(视线与盘面法线夹角 50°,处于 30°–60°)
const AZIMUTH = 0.35;

const state = {
    phase: 0,                      // rotationPhase(rad),初始 0
    dist: INITIAL_DISTANCE,        // cameraDistance(平滑值)
    targetDist: INITIAL_DISTANCE,  // 滚轮目标距离
    par: { x: 0, y: 0 },           // parallaxOffset(平滑值,有符号)
    targetPar: { x: 0, y: 0 },     // 指针目标视差(归一化 [-1,1])
    epoch: 0,                      // reset 计数
    hudVisible: true,
    frameTimes: [],                // 帧时间戳(2s 滚动窗口)
    fps: 0,
};

window.__appReady = false;

// ============================================================================
// 深拷贝 builtin-unlit 的 effect 反射元数据,构造点渲染 effect
// ============================================================================
function buildGalaxyPointEffect() {
    const VERT = `
precision mediump float;
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
};
layout(set = 2, binding = 0) uniform CCLocal {
highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;
};
layout(location = 0) in highp vec3 a_position;
layout(location = 1) in highp vec4 a_color;
layout(location = 0) out mediump vec4 v_color;
vec4 vert () {
  vec4 pos = cc_matWorld * vec4(a_position, 1.0);
  vec4 clip = cc_matViewProj * pos;
  float w = max(clip.w, 0.5);
  float sizeFactor = 0.10 + 0.45 * clamp(a_color.a, 0.0, 1.0); // 星点世界尺寸(0.1–0.55)
  float sz = sizeFactor * cc_screenSize.y * cc_matProj[1][1] * 0.5 / w;
  gl_PointSize = clamp(sz, 0.75, 20.0);
  v_color = vec4(a_color.rgb, 1.0);
  return clip;
}
void main() { gl_Position = vert(); }
`;

    const FRAG = `
precision mediump float;
layout(location = 0) in mediump vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
vec4 frag () {
  mediump vec2 d = gl_PointCoord - vec2(0.5, 0.5);
  mediump float r2 = dot(d, d);
  mediump float a = 1.0 - smoothstep(0.03, 0.25, r2);
  return vec4(v_color.rgb * a, a);
}
void main() { cc_FragColor = frag(); }
`;

    const PROGRAM_NAME = 'galaxy-point|galaxy-vs:vert|galaxy-fs:frag';

    // 克隆 builtin-unlit(反射 set/binding 已由引擎在注册期内正确赋值)
    const base = EffectAsset.get('builtin-unlit');
    const techniques = JSON.parse(JSON.stringify(base.techniques));
    const shaders = JSON.parse(JSON.stringify(base.shaders));
    const shader = shaders[0];
    shader.name = PROGRAM_NAME;
    shader.hash = 487623;
    shader.defines = [];
    shader.attributes = [
        { name: 'a_position', defines: [], format: gfx.Format.RGB32F, isNormalized: false, stream: 0, isInstanced: false, location: 0 },
        { name: 'a_color', defines: [], format: gfx.Format.RGBA32F, isNormalized: false, stream: 0, isInstanced: false, location: 1 },
    ];
    shader.blocks = [];
    shader.samplerTextures = [];
    shader.textures = [];
    shader.samplers = [];
    shader.buffers = [];
    shader.images = [];
    shader.subpassInputs = [];
    shader.builtins = {
        statistics: {},
        globals: {
            blocks: [{ name: 'CCGlobal', defines: [] }, { name: 'CCCamera', defines: [] }],
            samplerTextures: [], buffers: [], images: [],
        },
        locals: {
            blocks: [{ name: 'CCLocal', defines: [] }],
            samplerTextures: [], buffers: [], images: [],
        },
    };
    shader.glsl4 = { vert: VERT, frag: FRAG };
    // WebGL2 实际使用 glsl3(ES 3.00)变体:与引擎 builtin 同样的转换 ——
    // 去掉 Vulkan 风格 layout(set/binding) 与 debug_view composite 成员,std140 保留。
    const toGles3 = (src) => src
        .replace(/#extension[^\n]*\n/g, '')
        .replace(/^[^\n]*cc_debug_view_composite_pack_\d+;[^\n]*$/gm, '')
        .replace(/layout\s*\(([^)]*)\)\s*/g, (m, inner) => (inner.indexOf('std140') !== -1 ? 'layout(std140) ' : ''))
        .replace(/\bu32vec([234])\b/g, 'vec$1');
    shader.glsl3 = { vert: toGles3(VERT), frag: toGles3(FRAG) };

    const pass = techniques[0].passes[0];
    pass.program = PROGRAM_NAME;
    pass.primitive = gfx.PrimitiveMode.POINT_LIST;
    pass.rasterizerState = { cullMode: gfx.CullMode.NONE };
    pass.depthStencilState = { depthTest: false, depthWrite: false, depthFunc: gfx.ComparisonFunc.ALWAYS };
    pass.blendState = {
        targets: [{
            blend: true,
            blendOp: gfx.BlendOp.ADD,
            blendSrc: gfx.BlendFactor.ONE,
            blendDst: gfx.BlendFactor.ONE,
            blendSrcAlpha: gfx.BlendFactor.ONE,
            blendOpAlpha: gfx.BlendOp.ADD,
            blendDstAlpha: gfx.BlendFactor.ONE,
        }],
    };

    const effect = new EffectAsset('galaxy-point');
    effect.techniques = techniques;
    effect.shaders = shaders;
    effect.combinations = [];
    effect.onLoaded(); // 注册到 programLib 与 EffectAsset 全局表(与引擎 builtin 同路径)
    return effect;
}

// ============================================================================
// 星点生成(全部程序化)
// ============================================================================
function makeRng(seed) {
    // mulberry32 — 可复现的确定性分布
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildStarData() {
    const rng = makeRng(20261003);
    let spare = null;
    function gauss() {
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u = 0, v = 0, s = 0;
        do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
        const mul = Math.sqrt(-2 * Math.log(s) / s);
        spare = v * mul;
        return u * mul;
    }

    const data = new Float32Array(STAR_COUNT * 7);
    let min = { x: Infinity, y: Infinity, z: Infinity };
    let max = { x: -Infinity, y: -Infinity, z: -Infinity };
    let i = 0;
    const K_WIND = 5.2;          // 对数螺旋缠绕系数 θ = k·ln(r/r0)
    const R0 = 8;
    const put = (x, y, z, r, g, b, a) => {
        const o = i * 7;
        data[o] = x; data[o + 1] = y; data[o + 2] = z;
        data[o + 3] = r; data[o + 4] = g; data[o + 5] = b; data[o + 6] = a;
        if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
        if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
        i++;
    };
    // 半径 → 色温:核心暖黄白 / 中段蓝白 / 外缘冷蓝
    function tint(rr) {
        const t = Math.min(Math.max(rr / GALAXY_RADIUS, 0), 1);
        let r, g, b;
        if (t < 0.25) { const k = t / 0.25; r = 1.0; g = 0.9 - 0.04 * k; b = 0.72 + 0.16 * k; }
        else if (t < 0.6) { const k = (t - 0.25) / 0.35; r = 1.0 - 0.18 * k; g = 0.86 + 0.0; b = 0.88 + 0.09 * k; }
        else { const k = (t - 0.6) / 0.4; r = 0.82 - 0.2 * k; g = 0.86 - 0.12 * k; b = 0.97 + 0.03 * k; }
        return [r, g, b];
    }
    const jitter = (v) => v * (0.7 + 0.45 * rng());

    // —— 1) 核球:9000 星,中央明亮聚集 + 厚度隆起 ——
    const BULGE = 9000;
    for (let n = 0; n < BULGE; n++) {
        const x = gauss() * 4.2, z = gauss() * 4.2, y = gauss() * 2.6;
        const rr = Math.sqrt(x * x + z * z);
        const [r, g, b] = tint(rr);
        const alpha = 0.78 + rng() * 0.22; // 亮星层级
        put(x, y, z, jitter(r), jitter(g), jitter(b), alpha);
    }
    // —— 2) 旋臂 + 盘面:36000 星 ——
    const DISK = 36000;
    for (let n = 0; n < DISK; n++) {
        let x, y, z, rr;
        const isArm = rng() < 0.62;
        if (isArm) {
            const arm = n % ARM_COUNT;
            const t = Math.pow(rng(), 0.72);
            rr = R0 + t * (GALAXY_RADIUS - R0);
            const theta = arm * Math.PI + K_WIND * Math.log(rr / R0)
                + gauss() * (0.16 + 0.12 * t);
            const rDev = rr + gauss() * 1.9;
            x = Math.cos(theta) * rDev;
            z = Math.sin(theta) * rDev;
            y = gauss() * (1.1 + 2.0 * t);
        } else {
            rr = GALAXY_RADIUS * Math.sqrt(rng());
            const theta = rng() * Math.PI * 2;
            x = Math.cos(theta) * rr;
            z = Math.sin(theta) * rr;
            y = gauss() * (1.0 + 2.2 * (rr / GALAXY_RADIUS));
        }
        const [r, g, b] = tint(rr);
        // 亮暗分层:核球亮星 / 盘面普通星 / 暗弱背景星
        let alpha;
        const roll = rng();
        if (roll < 0.06) alpha = 0.85 + rng() * 0.15;       // 少量超亮星(含橙红)
        else if (roll < 0.8) alpha = 0.35 + rng() * 0.3;    // 盘面普通星
        else alpha = 0.12 + rng() * 0.16;                   // 暗弱星
        if (roll < 0.012 && rr > 10) {
            put(x, y, z, jitter(1.0), jitter(0.5), jitter(0.28), 0.9); // 橙红亮星
        } else {
            put(x, y, z, jitter(r), jitter(g), jitter(b), alpha);
        }
    }
    // —— 3) 远景背景壳:5000 星,极暗弱,增强纵深 ——
    const SHELL = STAR_COUNT - BULGE - DISK;
    for (let n = 0; n < SHELL; n++) {
        const u = rng() * 2 - 1;
        const phi = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const rad = 150 + rng() * 230;
        const x = s * Math.cos(phi) * rad, y = u * rad * 0.8, z = s * Math.sin(phi) * rad;
        const [r, g, b] = tint(GALAXY_RADIUS);
        put(x, y, z, jitter(r) * 0.5, jitter(g) * 0.5, jitter(b) * 0.55, 0.06 + rng() * 0.1);
    }

    return { data, min, max, count: i };
}

function buildStarMesh(starData) {
    const mesh = new Mesh('galaxy-stars');
    mesh.reset({
        struct: {
            vertexBundles: [{
                view: { offset: 0, length: starData.data.byteLength, count: starData.count, stride: 28 },
                attributes: [
                    { name: 'a_position', format: gfx.Format.RGB32F, isNormalized: false, stream: 0, isInstanced: false, location: 0 },
                    { name: 'a_color', format: gfx.Format.RGBA32F, isNormalized: false, stream: 0, isInstanced: false, location: 1 },
                ],
            }],
            primitives: [{
                vertexBundelIndices: [0],
                primitiveMode: gfx.PrimitiveMode.POINT_LIST,
            }],
            minPosition: new Vec3(starData.min.x, starData.min.y, starData.min.z),
            maxPosition: new Vec3(starData.max.x, starData.max.y, starData.max.z),
        },
        data: new Uint8Array(starData.data.buffer),
    });
    return mesh;
}

// ============================================================================
// HUD(2D 覆盖层,真实运行数据)
// ============================================================================
const hud = {};
function buildHud() {
    const wrap = document.createElement('div');
    wrap.id = 'bench-hud';
    wrap.style.cssText = 'position:fixed;left:12px;top:10px;z-index:9999;pointer-events:none;' +
        'color:#dfe8ff;font:12px/1.6 ui-monospace,Consolas,monospace;' +
        'text-shadow:0 0 4px #000,0 1px 2px #000;user-select:none;';
    wrap.innerHTML =
        '<div>E01 Deep Space Galaxy Cruise</div>' +
        '<div id="hud-stars">STARS: 0</div>' +
        '<div id="hud-fps">FPS: 0.0</div>' +
        '<div id="hud-dist">DIST: 120.0</div>';
    document.body.appendChild(wrap);

    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.id = 'hud-reset';
    btn.setAttribute('data-ui', 'reset');
    btn.setAttribute('aria-label', 'reset');
    btn.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9999;padding:5px 16px;' +
        'font:13px sans-serif;background:rgba(20,24,36,0.85);color:#eaf0ff;' +
        'border:1px solid #5a6a9a;border-radius:4px;cursor:pointer;pointer-events:auto;';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);

    hud.stars = wrap.querySelector('#hud-stars');
    hud.fps = wrap.querySelector('#hud-fps');
    hud.dist = wrap.querySelector('#hud-dist');
    hud.wrap = wrap;
}

let hudAccum = 0;
function updateHud(dt) {
    rollingFps(); // HUD 帧率来自真实滚动窗口,与 __bench 状态一致
    hudAccum += dt;
    if (hudAccum < 0.15) return;
    hudAccum = 0;
    hud.stars.textContent = 'STARS: ' + STAR_COUNT;
    hud.fps.textContent = 'FPS: ' + state.fps.toFixed(1);
    hud.dist.textContent = 'DIST: ' + state.dist.toFixed(1);
}

// ============================================================================
// 交互
// ============================================================================
function bindInput() {
    const isUiTarget = (t) => !!(t && t.closest && t.closest('[data-ui="reset"]'));
    window.addEventListener('pointermove', (e) => {
        if (isUiTarget(e.target)) return;
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        state.targetPar.x = (e.clientX / w - 0.5) * 2;   // 有符号偏移,[-1,1]
        state.targetPar.y = -(e.clientY / h - 0.5) * 2;
    });
    window.addEventListener('wheel', (e) => {
        if (isUiTarget(e.target)) return;
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0009);      // 上滚(deltaY<0)靠近,下滚远离
        state.targetDist = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, state.targetDist * factor));
    }, { passive: false });
}

function doReset() {
    state.phase = 0;
    state.dist = INITIAL_DISTANCE;
    state.targetDist = INITIAL_DISTANCE;
    state.par.x = 0; state.par.y = 0;
    state.targetPar.x = 0; state.targetPar.y = 0;
    state.epoch += 1;
}

// ============================================================================
// 页面契约 __bench
// ============================================================================
function rollingFps() {
    const now = performance.now();
    const times = state.frameTimes;
    while (times.length > 0 && now - times[0] > 2000) times.shift();
    if (times.length >= 2) {
        const span = (now - times[0]) / 1000;
        state.fps = (times.length - 1) / Math.max(span, 1e-4);
    }
    return state.fps;
}

window.__bench = {
    getState() {
        rollingFps();
        return {
            starCount: STAR_COUNT,
            rotationPhase: state.phase,
            cameraDistance: state.dist,
            parallaxOffset: { x: state.par.x, y: state.par.y },
            fps: Math.round(state.fps * 10) / 10,
            hudVisible: state.hudVisible === true,
            epoch: state.epoch,
        };
    },
    reset: doReset,
};

// ============================================================================
// 场景组装
// ============================================================================
let galaxyNode = null;
let cameraNode = null;

function applyCamera() {
    const el = (ELEV_DEG * Math.PI) / 180;
    const az = AZIMUTH;
    const dx = Math.sin(az) * Math.cos(el), dy = Math.sin(el), dz = Math.cos(az) * Math.cos(el);
    const rx = Math.cos(az), rz = -Math.sin(az);              // 视轴的水平垂直方向
    // up = right × dir
    const ux = -dy * rz, uy = dx * rz - dz * rx, uz = dy * rx;
    const dist = state.dist;
    const px = state.par.x * PARALLAX_GAIN * dist;
    const py = state.par.y * PARALLAX_GAIN * dist;
    cameraNode.setPosition(dx * dist + rx * px + ux * py, dy * dist + uy * py, dz * dist + rz * px + uz * py);
    cameraNode.lookAt(new Vec3(0, 0, 0));
}

class GalaxyController extends Component {
    update(dt) {
        const d = Math.min(dt, 0.1); // 后台标签页恢复时限制单帧步长
        // 旋转相位:单调递增
        state.phase += ROTATION_SPEED * d;
        // 距离与视差的逐帧指数平滑(无过冲)
        state.dist += (state.targetDist - state.dist) * (1 - Math.exp(-DIST_RATE * d));
        state.par.x += (state.targetPar.x - state.par.x) * (1 - Math.exp(-PARALLAX_RATE * d));
        state.par.y += (state.targetPar.y - state.par.y) * (1 - Math.exp(-PARALLAX_RATE * d));
        if (galaxyNode && galaxyNode.isValid) {
            galaxyNode.setRotationFromEuler(0, (state.phase * 180) / Math.PI, 0);
        }
        applyCamera();
        updateHud(d);
    }
}

try {
    buildHud();
    bindInput();

    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('galaxy');

    // 相机
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    applyCamera();
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = FOV_DEG;
    camera.near = 0.5;
    camera.far = 1200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(5, 6, 10, 255); // 深空背景,暗于 RGB(16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 星系(单 Mesh,POINT_LIST,一次批量提交 50,000 星点)
    const starData = buildStarData();
    const mesh = buildStarMesh(starData);
    galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const renderer = galaxyNode.addComponent(MeshRenderer);
    renderer.mesh = mesh;
    const material = new Material();
    material.initialize({ effectAsset: buildGalaxyPointEffect(), technique: 0 });
    renderer.material = material;
    galaxyNode.addComponent(GalaxyController);

    window.__airApp = app;
    app.run(scene);

    // 首帧就绪 + 帧时间采集(滚动 fps 窗口)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frameTimes.push(performance.now());
        if (state.frameTimes.length > 400) state.frameTimes.shift();
        if (!window.__appReady) window.__appReady = true;
    });

    console.log('[galaxy] running on cocosair — ' + STAR_COUNT + ' points, 1 draw batch');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[galaxy] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}
