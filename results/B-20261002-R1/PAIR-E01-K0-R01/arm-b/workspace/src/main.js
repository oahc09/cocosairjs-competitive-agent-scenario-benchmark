/**
 * E01 — 深空星系巡航(Deep Space Galaxy Cruise)— cocosair 实现
 *
 * 架构:
 *   - 60,000 个程序化生成的星点,单 Mesh、POINT_LIST 图元、单次批量提交(1 draw call)。
 *   - 自定义 Effect(galaxy-stars):WebGL2 glsl3 顶点着色器按 material uniform u_spin.x
 *     绕盘面法线(Y 轴)旋转星点并输出 gl_PointSize(透视衰减);片元做软辉光 + 加色混合。
 *   - 旋转在 GPU 顶点着色器完成:每星带 spinWeight(a_data.y),星系盘 =1,远景背景星 =0。
 *   - 相机:斜俯视(仰角 48°,视线与盘面法线夹角 42°),滚轮插值改变距离 [40,400],
 *     指针偏离画面中心的有符号偏移驱动小幅平移视差。
 *   - HUD(DOM 覆盖层):星点总数 / 滚动平均帧率 / 相机距离,数值来自真实运行数据。
 *   - 页面契约:window.__appReady(首帧 EVENT_AFTER_DRAW 后 true)与
 *     window.__bench = { getState, reset }。
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
    renderer,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量(状态契约)
// ---------------------------------------------------------------------------
const STAR_COUNT = 60000; // >= 50,000;等于真实提交渲染的顶点数
const OMEGA = 0.09; // rad/s,盘面法线旋转角速度(0.02-0.1 区间;P7 余量:0.09*0.8=0.072<0.1)
const DIST_INIT = 120;
const DIST_MIN = 40;
const DIST_MAX = 400;
const ELEV = (48 * Math.PI) / 180; // 相机仰角(盘面之上);与法线夹角 = 90-48 = 42°(30–60 区间)
const POINT_SCALE = 110; // gl_PointSize 世界系数:size_px = POINT_SCALE * a_size / w
const PARALLAX_GAIN = 6.0; // 视差世界位移幅度(≈画面宽度 3.4%,< 10% 上限)
const K_DIST = 2.5; // 距离插值速率(1/s)
const K_DIST_RESET = 6.0; // reset 恢复期间的更快插值(仍逐帧平滑,1s 内收敛)
const K_PARALLAX = 8.0; // 视差插值速率

// ---------------------------------------------------------------------------
// 可复现随机数(mulberry32 + Box-Muller)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(0x2026e01);
function gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// 星系程序化生成:核球 + 2 条对数螺旋臂 + 盘面散布星 + 远景背景星
// 输出:positions[3N](星系局部坐标), colors[4N](rgb 预乘亮度), data[2N](尺寸, 自旋权重)
// ---------------------------------------------------------------------------
function generateGalaxy() {
    const positions = new Array(STAR_COUNT * 3);
    const colors = new Array(STAR_COUNT * 4);
    const data = new Array(STAR_COUNT * 2);

    const R_DISK = 58;
    const ARM_PITCH = Math.tan((13 * Math.PI) / 180); // 对数螺距
    const R0 = 3.5;
    let i = 0;

    function put(x, y, z, r, g, b, size, spin) {
        const i3 = i * 3;
        const i4 = i * 4;
        const i2 = i * 2;
        positions[i3] = x;
        positions[i3 + 1] = y;
        positions[i3 + 2] = z;
        colors[i4] = r;
        colors[i4 + 1] = g;
        colors[i4 + 2] = b;
        colors[i4 + 3] = 1;
        data[i2] = size;
        data[i2 + 1] = spin;
        i += 1;
    }

    // 半径 -> 颜色梯度:核心暖黄白 -> 旋臂中段蓝白 -> 外缘冷蓝
    function radialColor(t) {
        let r;
        let g;
        let b;
        if (t < 0.35) {
            const k = t / 0.35;
            r = 1.0 + (0.78 - 1.0) * k;
            g = 0.93 + (0.85 - 0.93) * k;
            b = 0.78 + (1.0 - 0.78) * k;
        } else {
            const k = (t - 0.35) / 0.65;
            r = 0.78 + (0.52 - 0.78) * k;
            g = 0.85 + (0.66 - 0.85) * k;
            b = 1.0;
        }
        return [r, g, b];
    }

    // 1) 核球:中央密集亮星群(计入总数)
    const N_BULGE = 9000;
    for (let k = 0; k < N_BULGE; k++) {
        const x = gauss() * 4.2;
        const z = gauss() * 4.2;
        const y = gauss() * 2.6;
        const bright = 0.9 + rng() * 0.9;
        const size = 1.8 + rng() * 2.7;
        put(x, y, z, 1.0 * bright, 0.9 * bright, 0.72 * bright, size, 1);
    }

    // 2) 旋臂:2 条对数螺旋 theta = ln(r/R0)/tan(pitch) + 臂相位 + 角向散布
    const N_ARM = 42000;
    for (let k = 0; k < N_ARM; k++) {
        const arm = k % 2; // 两条臂,相位差 π
        const u = rng();
        const r = 4 + (R_DISK - 4) * Math.pow(u, 0.75);
        const spread = 0.16 + 0.0045 * r; // 臂宽随半径缓慢展开
        const theta =
            arm * Math.PI + Math.log(r / R0) / ARM_PITCH + gauss() * spread;
        const y = gauss() * (0.9 + 2.4 * Math.exp(-r / 16)); // 盘厚:内厚外薄
        const x = r * Math.cos(theta);
        const z = r * Math.sin(theta);
        const t = Math.min(r / R_DISK, 1);
        let [cr, cg, cb] = radialColor(t);
        let bright = (0.4 + 0.9 * Math.exp(-r / 20)) * (0.65 + rng() * 0.7);
        let size = 1.1 + 1.9 * Math.exp(-r / 20) + rng() * 0.7;
        if (r > 6 && rng() < 0.022) {
            // 少量橙红亮星(红巨星)
            cr = 1.0;
            cg = 0.42;
            cb = 0.18;
            bright *= 1.6;
            size *= 1.8;
        }
        put(x, y, z, cr * bright, cg * bright, cb * bright, size, 1);
    }

    // 3) 盘面随机散布星(填充臂间)
    const N_DISK_SCATTER = 6000;
    for (let k = 0; k < N_DISK_SCATTER; k++) {
        const rIn = 5;
        const r = Math.sqrt(rIn * rIn + (R_DISK * R_DISK - rIn * rIn) * rng());
        const theta = rng() * Math.PI * 2;
        const y = gauss() * (1.0 + 2.0 * Math.exp(-r / 16));
        const t = Math.min(r / R_DISK, 1);
        const [cr, cg, cb] = radialColor(t);
        const bright = (0.3 + 0.6 * Math.exp(-r / 24)) * (0.5 + rng() * 0.8);
        const size = 0.9 + rng() * 1.4;
        put(
            r * Math.cos(theta),
            y,
            r * Math.sin(theta),
            cr * bright,
            cg * bright,
            cb * bright,
            size,
            1,
        );
    }

    // 4) 远景背景星(静态,不随星系自旋;增强纵深与视差参照)
    const N_BG = STAR_COUNT - i;
    for (let k = 0; k < N_BG; k++) {
        const rad = 420 + rng() * 140;
        const ct = rng() * 2 - 1;
        const st = Math.sqrt(Math.max(0, 1 - ct * ct));
        const phi = rng() * Math.PI * 2;
        const bright = 0.3 + rng() * 0.4;
        const size = 2.6 + rng() * 1.6;
        put(
            rad * st * Math.cos(phi),
            rad * ct,
            rad * st * Math.sin(phi),
            0.62 * bright,
            0.7 * bright,
            1.0 * bright,
            size,
            0,
        );
    }

    return { positions, colors, data, count: i };
}

// ---------------------------------------------------------------------------
// 自定义 Effect:point-sprite 星点着色器
//   - glsl3(WebGL2):uniform 块不带 set/binding 限定(引擎按块名绑定,同 toGlsl3 约定)
//   - CCCamera 引擎全局块提供 cc_matViewProj;Params 为 material 级 UBO(set1,binding0)
// ---------------------------------------------------------------------------
const PROGRAM_NAME = 'galaxy-stars';

const CCCAMERA_BLOCK = `
layout(std140) uniform CCCamera {
    highp mat4 cc_matView;
    highp mat4 cc_matViewInv;
    highp mat4 cc_matProj;
    highp mat4 cc_matProjInv;
    highp mat4 cc_matViewProj;
    highp mat4 cc_matViewProjInv;
    highp vec4 cc_cameraPos;
    highp vec4 cc_surfaceTransform;
    highp vec4 cc_screenScale;
    highp vec4 cc_exposure;
    highp vec4 cc_mainLitDir;
    highp vec4 cc_mainLitColor;
    highp vec4 cc_ambientSky;
    highp vec4 cc_ambientGround;
    highp vec4 cc_fogColor;
    highp vec4 cc_fogBase;
    highp vec4 cc_fogAdd;
    highp vec4 cc_nearFar;
    highp vec4 cc_viewPort;
};`;

const PARAMS_BLOCK = `
layout(std140) uniform Params {
    vec4 u_spin;
};`;

const VERT_BODY = `
    float w = a_data.y;
    float ang = u_spin.x * w;
    float c = cos(ang);
    float s = sin(ang);
    vec3 p = vec3(a_position.x * c - a_position.z * s, a_position.y, a_position.x * s + a_position.z * c);
    vec4 clip = cc_matViewProj * vec4(p, 1.0);
    gl_Position = clip;
    float dist = max(clip.w, 0.1);
    gl_PointSize = clamp(u_spin.y * a_data.x / dist, 1.0, 64.0);
    v_color = a_color;`;

const FRAG_BODY = `
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    float fall = exp(-10.0 * r2) - 0.0821;
    if (fall <= 0.0) discard;
    cc_FragColor = vec4(v_color.rgb * fall, 1.0);`;

const VERT_GLSL3 = `precision highp float;
in vec3 a_position;
in vec4 a_color;
in vec2 a_data;
${CCCAMERA_BLOCK}
${PARAMS_BLOCK}
out vec4 v_color;
void main() {${VERT_BODY}
}
`;
const FRAG_GLSL3 = `precision highp float;
in vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main() {${FRAG_BODY}
}
`;
const VERT_GLSL4 = `precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_data;
${CCCAMERA_BLOCK}
layout(set = 1, binding = 0) uniform Params {
    vec4 u_spin;
};
layout(location = 0) out vec4 v_color;
void main() {${VERT_BODY}
}
`;
const FRAG_GLSL4 = `precision highp float;
layout(location = 0) in vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main() {${FRAG_BODY}
}
`;

const STAGE_VS_FS = gfx.ShaderStageFlagBit.VERTEX | gfx.ShaderStageFlagBit.FRAGMENT;

function buildStarEffect() {
    const effect = new EffectAsset();
    effect.name = PROGRAM_NAME;
    effect.combinations = [];
    effect.hideInEditor = true;
    effect.shaders = [
        {
            name: PROGRAM_NAME,
            hash: 1388210901,
            glsl4: { vert: VERT_GLSL4, frag: FRAG_GLSL4 },
            glsl3: { vert: VERT_GLSL3, frag: FRAG_GLSL3 },
            builtins: {
                statistics: {},
                globals: {
                    blocks: [{ name: 'CCCamera' }],
                    samplerTextures: [],
                },
                locals: { blocks: [], samplerTextures: [] },
            },
            defines: [],
            attributes: [
                {
                    name: 'a_position',
                    format: gfx.Format.RGB32F,
                    isNormalized: false,
                    stream: 0,
                    isInstanced: false,
                    location: 0,
                    defines: [],
                },
                {
                    name: 'a_color',
                    format: gfx.Format.RGBA32F,
                    isNormalized: false,
                    stream: 0,
                    isInstanced: false,
                    location: 1,
                    defines: [],
                },
                {
                    name: 'a_data',
                    format: gfx.Format.RG32F,
                    isNormalized: false,
                    stream: 0,
                    isInstanced: false,
                    location: 2,
                    defines: [],
                },
            ],
            blocks: [
                {
                    name: 'Params',
                    members: [{ name: 'u_spin', type: gfx.Type.FLOAT4, count: 1 }],
                    binding: 0,
                    // set 必须显式给出(1 = SetIndex.MATERIAL):MATERIAL set 的 GL UBO
                    // 绑定点带 bindingMappings.blockOffsets 偏移,缺省 set 会让
                    // uniformBlockBinding 映射到错误槽位、读到未绑定缓冲。
                    set: 1,
                    stageFlags: STAGE_VS_FS,
                },
            ],
            samplerTextures: [],
            samplers: [],
            textures: [],
            buffers: [],
            images: [],
            subpassInputs: [],
        },
    ];
    effect.techniques = [
        {
            name: 'additive-points',
            passes: [
                {
                    program: PROGRAM_NAME,
                    primitive: gfx.PrimitiveMode.POINT_LIST,
                    blendState: {
                        targets: [
                            {
                                blend: true,
                                blendSrc: gfx.BlendFactor.ONE,
                                blendDst: gfx.BlendFactor.ONE,
                                blendSrcAlpha: gfx.BlendFactor.ONE,
                                blendDstAlpha: gfx.BlendFactor.ONE,
                            },
                        ],
                    },
                    depthStencilState: { depthTest: false, depthWrite: false },
                    rasterizerState: { cullMode: gfx.CullMode.NONE },
                    properties: {},
                },
            ],
        },
    ];
    renderer.programLib.register(effect);
    EffectAsset.register(effect);
    return effect;
}

// ---------------------------------------------------------------------------
// HUD(DOM 覆盖层)+ Reset 控件
// ---------------------------------------------------------------------------
const hudEl = document.createElement('div');
hudEl.id = 'hud';
hudEl.setAttribute('data-ui', 'hud');
hudEl.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:1000;padding:8px 12px;' +
    "font:12px/1.7 'Consolas','Courier New',monospace;color:#bfe0ff;" +
    'background:rgba(6,10,20,0.62);border:1px solid rgba(110,160,220,0.35);' +
    'border-radius:6px;pointer-events:none;white-space:pre;';
document.body.appendChild(hudEl);

const resetBtn = document.createElement('button');
resetBtn.id = 'resetBtn';
resetBtn.textContent = 'Reset';
resetBtn.setAttribute('aria-label', 'reset');
resetBtn.setAttribute('data-ui', 'reset');
resetBtn.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:1000;padding:5px 14px;' +
    "font:12px sans-serif;background:#16233a;color:#cfe4ff;" +
    'border:1px solid #4a76a8;border-radius:4px;cursor:pointer;';
document.body.appendChild(resetBtn);

// ---------------------------------------------------------------------------
// 运行时状态(全部真实数据,__bench 直读)
// ---------------------------------------------------------------------------
const state = {
    rotationPhase: 0,
    cameraDistance: DIST_INIT,
    distanceTarget: DIST_INIT,
    restoring: false,
    parallax: { x: 0, y: 0 },
    parallaxTarget: { x: 0, y: 0 },
    epoch: 0,
    fps: 0,
    hudVisible: true,
};

function doReset() {
    state.epoch += 1;
    state.rotationPhase = 0;
    state.distanceTarget = DIST_INIT;
    state.restoring = true; // 以更快但仍逐帧平滑的插值在 1s 内恢复 120
    state.parallaxTarget.x = 0;
    state.parallaxTarget.y = 0;
    state.parallax.x = 0;
    state.parallax.y = 0;
}

window.__appReady = false;
window.__bench = {
    getState() {
        return {
            starCount: STAR_COUNT,
            rotationPhase: state.rotationPhase,
            cameraDistance: state.cameraDistance,
            parallaxOffset: { x: state.parallax.x, y: state.parallax.y },
            fps: state.fps,
            hudVisible: state.hudVisible,
            epoch: state.epoch,
        };
    },
    reset: doReset,
};
resetBtn.addEventListener('click', () => doReset());

// ---------------------------------------------------------------------------
// 输入:指针视差 + 滚轮穿行(窗口级 DOM 事件)
// ---------------------------------------------------------------------------
function onPointer(clientX, clientY) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    state.parallaxTarget.x = (clientX / w) * 2 - 1;
    state.parallaxTarget.y = (clientY / h) * 2 - 1;
}
window.addEventListener('pointermove', (e) => onPointer(e.clientX, e.clientY), { passive: true });
window.addEventListener('mousemove', (e) => onPointer(e.clientX, e.clientY), { passive: true });
function onWheel(e) {
    // window 与 document 双注册,同一事件只处理一次
    if (e.__galaxyWheelHandled) return;
    e.__galaxyWheelHandled = true;
    e.preventDefault();
    state.distanceTarget = Math.min(
        DIST_MAX,
        Math.max(DIST_MIN, state.distanceTarget + e.deltaY * 0.15),
    );
    state.restoring = false;
}
// 捕获阶段监听:引擎在 canvas 目标阶段的 wheel 监听会 stopPropagation,
// 冒泡阶段的 window/document 监听收不到事件;capture 先于其执行,不受影响。
window.addEventListener('wheel', onWheel, { passive: false, capture: true });

// ---------------------------------------------------------------------------
// 帧率:2s 滚动平均
// ---------------------------------------------------------------------------
const frameTimes = [];
function pushFrameTime(now) {
    frameTimes.push(now);
    while (frameTimes.length > 2 && now - frameTimes[0] > 2000) {
        frameTimes.shift();
    }
    if (frameTimes.length >= 2) {
        const span = Math.max(now - frameTimes[0], 250);
        state.fps = Math.min(240, ((frameTimes.length - 1) * 1000) / span);
    }
}

// ---------------------------------------------------------------------------
// 主启动
// ---------------------------------------------------------------------------
let galaxyMaterial = null;
let cameraNode = null;
// FLOAT4 uniform 必须传 Vec4(引擎按 .x/.y/.z/.w 写入,普通数组会写成 NaN)
const spinUniform = new Vec4(0, POINT_SCALE, 0, 0);

class GalaxyDriver extends Component {
    update(dt) {
        const d = Math.min(Math.max(dt, 0), 0.1);

        // 1) 星系自旋(状态相位,单调递增;reset 归零)
        state.rotationPhase += d * OMEGA;

        // 2) 相机距离平滑插值(reset 期间用更快速率,1s 内收敛)
        const kD = state.restoring ? K_DIST_RESET : K_DIST;
        state.cameraDistance +=
            (state.distanceTarget - state.cameraDistance) * (1 - Math.exp(-kD * d));
        if (state.restoring && Math.abs(state.distanceTarget - state.cameraDistance) < 0.4) {
            state.restoring = false;
        }

        // 3) 视差平滑
        const aP = 1 - Math.exp(-K_PARALLAX * d);
        state.parallax.x += (state.parallaxTarget.x - state.parallax.x) * aP;
        state.parallax.y += (state.parallaxTarget.y - state.parallax.y) * aP;

        // 4) 相机位姿:距离 * 仰角方向 + 视差横移,始终看向星系中心
        if (cameraNode && cameraNode.isValid) {
            const sE = Math.sin(ELEV);
            const cE = Math.cos(ELEV);
            const dist = state.cameraDistance;
            const ox = state.parallax.x * PARALLAX_GAIN;
            const oy = -state.parallax.y * PARALLAX_GAIN;
            // forward(相机->中心)= -(0,sE,cE);right=(1,0,0);camUp=(0,cE,-sE)
            cameraNode.setPosition(ox, dist * sE + oy * cE, dist * cE - oy * sE);
            cameraNode.lookAt(_lookTarget);
        }

        // 5) 上传自旋 uniform
        if (galaxyMaterial && galaxyMaterial.isValid) {
            spinUniform.set(state.rotationPhase, POINT_SCALE, 0, 0);
            galaxyMaterial.setProperty('u_spin', spinUniform);
        }
    }
}

// lookAt 目标复用对象,避免每帧分配
const _lookTarget = new Vec3(0, 0, 0);

let hudClock = 0;
function refreshHud(dt) {
    hudClock += dt;
    if (hudClock < 0.1) return;
    hudClock = 0;
    // 注意:position:fixed 元素 offsetParent 恒为 null,用几何尺寸判定可见性
    const rect = hudEl.getBoundingClientRect();
    state.hudVisible =
        document.body.contains(hudEl) &&
        rect.width > 0 &&
        rect.height > 0 &&
        window.getComputedStyle(hudEl).visibility !== 'hidden';
    const s = window.__bench.getState();
    hudEl.textContent =
        `STARS ${s.starCount}\n` +
        `FPS ${Math.max(0, Math.round(s.fps))}\n` +
        `DIST ${s.cameraDistance.toFixed(1)}`;
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('galaxy');

    // 相机
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, DIST_INIT * Math.sin(ELEV), DIST_INIT * Math.cos(ELEV));
    cameraNode.lookAt(_lookTarget);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.5;
    camera.far = 4000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(6, 6, 12, 255); // 深空底色,暗于 RGB(16,16,24)
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 星系:自定义 Effect + 60k 点 Mesh,单 MeshRenderer 批量提交
    buildStarEffect();
    galaxyMaterial = new Material();
    galaxyMaterial.initialize({ effectName: PROGRAM_NAME });
    galaxyMaterial.setProperty('u_spin', spinUniform);

    const galaxy = generateGalaxy();
    if (galaxy.count !== STAR_COUNT) {
        throw new Error(`star count mismatch: ${galaxy.count} != ${STAR_COUNT}`);
    }
    const mesh = utils.createMesh({
        positions: galaxy.positions,
        colors: galaxy.colors,
        attributes: [
            new gfx.Attribute('a_position', gfx.Format.RGB32F, false, 0, false, 0),
            new gfx.Attribute('a_color', gfx.Format.RGBA32F, false, 0, false, 1),
        ],
        customAttributes: [
            {
                attr: new gfx.Attribute('a_data', gfx.Format.RG32F, false, 0, false, 2),
                values: galaxy.data,
            },
        ],
        primitiveMode: gfx.PrimitiveMode.POINT_LIST,
        minPos: { x: -600, y: -600, z: -600 },
        maxPos: { x: 600, y: 600, z: 600 },
        boundingRadius: 600,
    });

    const galaxyNode = new Node('Galaxy');
    galaxyNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(galaxyNode);
    const meshRenderer = galaxyNode.addComponent(MeshRenderer);
    meshRenderer.mesh = mesh;
    meshRenderer.material = galaxyMaterial;
    meshRenderer.castShadow = false;
    meshRenderer.receiveShadow = false;
    galaxyNode.addComponent(GalaxyDriver);

    window.__airApp = app;
    app.run(scene);

    // 每帧:帧率滚动采样 + HUD 刷新 + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, (dt) => {
        pushFrameTime(performance.now());
        refreshHud(typeof dt === 'number' ? dt : 0.016);
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log(
        '[E01] galaxy cruise on cocosair — stars:',
        STAR_COUNT,
        'scene:',
        app.getScene() && app.getScene().name,
    );
} catch (err) {
    console.error('[E01] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
