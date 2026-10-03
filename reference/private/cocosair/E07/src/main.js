/**
 * E07 — 霓虹夜城(Neon Night City)· Cocos AIR Reference 实现
 *
 * 场景定位:探测 AIR 的 大规模实例化(批量绘制)/ 自发光窗阵 / 持续动画 /
 * 氛围(雾/雨)/ 规模性能。AIR 无 InstancedMesh/Points 一等公民 API,
 * 本实现以「合并静态几何 + 动态网格单 draw call」路径覆盖全部大批量元素:
 *
 *   - 楼群(240 栋,程序化网格街区):全部合并为 1 个静态网格 = 1 draw call,
 *     逐面假光照烘焙进顶点色(builtin-unlit + USE_VERTEX_COLOR,引擎管线雾生效)。
 *   - 发光窗阵(≈10k 亮窗点 + 暗窗格):全部合并为 1 个静态网格 = 1 draw call,
 *     窗格矩阵结构可辨识,暖/冷色混合,点亮分布带确定性随机。
 *   - 车流(72 辆)+ 街灯(96)+ 屋顶信标(12):utils.MeshUtils.createDynamicMesh
 *     单动态网格 = 1 draw call,自定义 additive 径向光斑 shader(含线性雾衰减)。
 *   - 霓虹元素(≥14 处:竖向灯带/横向招牌/楼顶灯框):与雨共用单动态网格
 *     = 1 draw call,自定义 additive 胶囊形状 shader,呼吸/闪烁动画(≥3 种高饱和色相)。
 *   - 雨(2200 粒):同上动态网格,竖直短线粒子,落到地面重生顶部,速度感拖尾。
 *   - 雾:scene.globals.fog(引擎 FogInfo → 管线宏 CC_USE_FOG,线性雾),
 *     UI 开关实时切换,远处楼群亮度/对比肉眼可辨衰减。
 *   - 地面:程序化 canvas 纹理(路面/车道线/斑马线/街区底色)1 draw call。
 *   - 天空:自定义夜空 shader(渐变+星点+月+城市光污染带,不受雾影响)。
 *
 * 全场景合计 ~7 个 draw call(楼群/窗阵/地面/天空/光斑/胶囊/雨)。
 *
 * 页面契约:window.__appReady(首帧后 true)/ window.__bench={getState,reset}。
 * 状态通道(真实数据):buildingCount / carCount / rainParticleCount /
 *   fogEnabled / fps(最近 60 帧真实帧间隔滚动平均)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    Material,
    EffectAsset,
    Texture2D,
    director,
    Director,
} from 'cocosair.js';

// ============================================================ 配置与状态 =================

const CFG = {
    // 规模(spec:楼≥200 建议 220-260 / 车≥60 建议 64-96 / 雨≥1500 建议 1800-2500)
    buildingCount: 240,
    carCount: 84, // 动态网格预算(实际生成 80:主干道 52 + Z 向街 28)
    rainCount: 2200,
    lampCount: 96,
    beaconCount: 12,
    neonCount: 15,
    // 相机(低角度仰视天际线:下 1/3 街道层,上 2/3 楼群夜空)
    camPos: new Vec3(0, 9, 6),
    camLook: new Vec3(0, 62, 430),
    fov: 55,
    // 雾(线性;远楼全衰减,近楼清晰)
    // 亮度校准:管线 vertex/color 值经 SRGBToLinear(平方)直出、无输出 gamma —— 
    // Color(62,72,102) → linear≈(0.059,0.080,0.160) 即实际显示的雾色(夜蓝辉光,非黑)
    fogStart: 130,
    fogEnd: 640,
    fogColor: new Color(62, 72, 102, 255),
    // 城市布局
    avenues: [96, 216, 336, 456, 576, 696], // 沿 X 主干道(z 值),半宽 8
    avenueHalf: 8,
    crossX: [-340, -255, -170, -85, 0, 85, 170, 255, 340], // 沿 Z 街道(x 值),半宽 5
    crossHalf: 5,
    groundSize: 880, // 地面世界尺寸(纹理映射用)
    groundCenterZ: 400,
};

const state = {
    frame: 0,
    resetCount: 0,
    fogEnabled: true,
    fps: 0,
    buildingCount: 0,
    carCount: 0,
    rainParticleCount: 0,
    windowCount: 0,
};

// fps:最近 60 个真实渲染帧间隔的滚动平均(EVENT_AFTER_DRAW 时间戳)
const fpsTimes = new Float64Array(64);
let fpsHead = 0;
let fpsFilled = 0;

window.__appReady = false;

// ============================================================ UI(data-ui + data-bench 双契约)

let statusEl = null;
let fogBtn = null;

function syncUi() {
    if (statusEl) {
        statusEl.textContent =
            '楼 ' + state.buildingCount + ' · 车 ' + state.carCount +
            ' · 雨 ' + state.rainParticleCount + ' · 雾:' + (state.fogEnabled ? '开' : '关');
    }
    if (fogBtn) {
        fogBtn.textContent = state.fogEnabled ? '雾:开' : '雾:关';
    }
}

function applyFog() {
    if (!window.__fogInfo) return;
    window.__fogInfo.enabled = state.fogEnabled;
}

{
    const mkBtn = (label, ui, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.setAttribute('data-ui', ui);
        btn.setAttribute('data-bench', ui); // 双契约:探针 click:ui= 与 data-bench 均可定位
        btn.style.cssText =
            'position:fixed;right:12px;z-index:9999;padding:5px 14px;min-width:96px;' +
            "font:12px sans-serif;background:#181820;color:#dfe3ee;border:1px solid #4a5068;" +
            'border-radius:4px;cursor:pointer;text-align:center;transition:background .15s,border-color .15s';
        btn.addEventListener('mouseenter', () => {
            btn.style.background = '#232334';
            btn.style.borderColor = '#7a84b0';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = '#181820';
            btn.style.borderColor = '#4a5068';
        });
        btn.addEventListener('mousedown', () => {
            btn.style.background = '#2c2c44';
        });
        btn.addEventListener('mouseup', () => {
            btn.style.background = '#232334';
        });
        btn.addEventListener('click', onClick);
        return btn;
    };

    fogBtn = mkBtn('雾:开', 'toggle-fog', () => {
        state.fogEnabled = !state.fogEnabled;
        applyFog();
        syncUi();
    });
    fogBtn.style.cssText += ';top:10px';

    const rsBtn = mkBtn('重置', 'reset', () => doReset());
    rsBtn.style.cssText += ';top:48px';

    document.body.appendChild(fogBtn);
    document.body.appendChild(rsBtn);

    statusEl = document.createElement('div');
    statusEl.textContent = '';
    statusEl.style.cssText =
        'position:fixed;right:12px;top:88px;z-index:9999;pointer-events:none;min-width:96px;' +
        "font:11px sans-serif;color:rgba(200,210,230,0.75);letter-spacing:1px;text-align:center";
    document.body.appendChild(statusEl);
}

// ============================================================ 工具 ========================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 确定性 PRNG(mulberry32):reset 后城市/车流/雨与初始状态逐位一致。 */
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

/** builtin-unlit 顶点色走 SRGBToLinear(平方)后直出 —— 以显示值为目标反解存储值。 */
const sv = (display) => Math.sqrt(clamp(display, 0, 1));

// ============================================================ GLSL 变体与 effect 骨架 =====
// 与引擎同源的 UBO 声明(E06 验证路径;WebGL2 消费 glsl3 变体)。

const UB_CAM4 = `layout(set = 0, binding = 1) uniform CCCamera {
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
const UB_LOC4 = `layout(set = 2, binding = 0) uniform CCLocal {
  highp mat4 cc_matWorld;
  highp mat4 cc_matWorldIT;
  highp vec4 cc_lightingMapUVParam;
  highp vec4 cc_localShadowBias;
};`;
const UB_GLB4 = `layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};`;

const toGlsl3 = (src) => src.replace(/layout\s*\([^)]*\)\s*/g, '');

/** 光斑/胶囊粒子顶点:a_position + a_texCoord(quad 局部 [-1,1])+ a_color;线性雾因子。 */
const vertParticle4 = `
precision highp float;
${UB_CAM4}
${UB_LOC4}
in vec3 a_position;
in vec2 a_texCoord;
in vec4 a_color;
out mediump vec2 v_uv;
out mediump vec4 v_color;
out mediump float v_fog;
void main () {
  v_uv = a_texCoord;
  v_color = a_color;
  vec4 wp = cc_matWorld * vec4(a_position, 1.0);
  float d = distance(cc_cameraPos.xyz, wp.xyz);
  v_fog = clamp((cc_fogBase.y - d) / max(cc_fogBase.y - cc_fogBase.x, 1e-3), 0.0, 1.0);
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`;

/** 天空顶点:a_position → 世界方向。 */
const vertSky4 = `
precision highp float;
${UB_CAM4}
${UB_LOC4}
in vec3 a_position;
out highp vec3 v_dir;
void main () {
  v_dir = (cc_matWorld * vec4(a_position, 1.0)).xyz;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`;

// ---- 天空:近黑渐变 + 城市光污染带(品红/青)+ 星点 + 月 --------------------------------
const SKY_FRAG4 = `precision highp float;
${UB_GLB4}
in highp vec3 v_dir;
layout(location = 0) out vec4 cc_FragColor;
float hash21 (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
void main () {
  vec3 dir = normalize(v_dir);
  float h = dir.y;
  vec3 zen = vec3(0.006, 0.010, 0.026);
  vec3 hor = vec3(0.052, 0.072, 0.128);
  float g = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 2.2);
  vec3 sky = mix(zen, hor, g);

  // 城市光污染地平带:品红 ⇄ 青随方位渐变 + 暖钠光
  float band = exp(-pow(max(h, 0.0) * 3.4, 1.55));
  float side = 0.5 + 0.5 * clamp(dir.x * 1.4 + 0.15, -1.0, 1.0);
  vec3 glowA = vec3(0.170, 0.040, 0.130); // 品红
  vec3 glowB = vec3(0.025, 0.115, 0.185); // 青
  sky += mix(glowA, glowB, side) * band * 0.70;
  sky += vec3(0.085, 0.065, 0.040) * band * 0.50;

  // 地平线以下压暗(被楼群/地面遮挡区)
  sky *= mix(0.22, 1.0, smoothstep(-0.22, 0.02, h));

  // 星点:八面体网格 3x3 邻域,微闪烁
  float starVis = smoothstep(-0.02, 0.16, h);
  if (starVis > 0.003) {
    vec2 oct = dir.xz / (abs(dir.x) + abs(dir.y) + abs(dir.z));
    vec2 st = oct * 21.0;
    vec2 cell = floor(st);
    vec2 f = fract(st);
    float acc = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 off = vec2(float(ox), float(oy));
        vec2 id = cell + off;
        float rn = hash21(id);
        if (rn > 0.52) {
          vec2 sc = off + 0.15 + 0.70 * vec2(hash21(id + 7.13), hash21(id + 3.71));
          float d2 = dot(f - sc, f - sc);
          float sharp = mix(230.0, 720.0, hash21(id + 1.37));
          float tw = 0.72 + 0.28 * sin(cc_time.x * (0.9 + 2.2 * hash21(id + 9.9)) + rn * 40.0);
          acc += exp(-d2 * sharp) * tw;
        }
      }
    }
    sky += vec3(0.58, 0.66, 0.92) * acc * 0.80 * starVis;
  }

  // 月(小月牙感:亮盘 + 单侧暗切 + 柔晕)
  vec3 moonDir = normalize(vec3(-0.44, 0.46, 0.42));
  float md = dot(dir, moonDir);
  float moon = smoothstep(0.99930, 0.99965, md);
  float moonCut = smoothstep(0.99895, 0.99980, dot(dir, normalize(moonDir + vec3(0.0105, -0.004, 0.0))));
  float moonHalo = 0.14 * pow(max(md, 0.0), 190.0);
  sky += vec3(0.88, 0.91, 1.00) * (moon * (0.35 + 0.65 * moonCut) + moonHalo);

  // 抖动去色带
  sky += (hash21(dir.xz * 517.3 + fract(cc_time.x) * 2.9) - 0.5) * 0.005;
  cc_FragColor = vec4(sky, 1.0);
}`;

// ---- 光斑(车灯/街灯/信标):additive 径向衰减 + 线性雾 ------------------------------------
const GLOW_FRAG4 = `precision highp float;
in mediump vec2 v_uv;
in mediump vec4 v_color;
in mediump float v_fog;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d2 = dot(v_uv, v_uv);
  float i = exp(-d2 * 3.2) * 0.85 + exp(-d2 * 7.5) * 0.55;
  cc_FragColor = vec4(v_color.rgb * i * v_fog, 1.0);
}`;

// ---- 胶囊(雨丝/霓虹灯带):横软边 + 纵向端部渐隐 + 线性雾 ---------------------------------
const STREAK_FRAG4 = `precision highp float;
in mediump vec2 v_uv;
in mediump vec4 v_color;
in mediump float v_fog;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float across = exp(-v_uv.x * v_uv.x * 3.0);
  float core = exp(-v_uv.x * v_uv.x * 11.0) * 0.65;
  float taper = smoothstep(1.0, 0.22, abs(v_uv.y));
  float i = (across * 0.7 + core) * taper;
  cc_FragColor = vec4(v_color.rgb * i * v_fog, 1.0);
}`;

/** 编译后形态 effect JSON(E06 验证路径:同 examples/shared/shader-blocks)。 */
function makeEffectJson(opts) {
    return {
        name: opts.name,
        techniques: [
            {
                passes: [
                    {
                        program: opts.prog,
                        rasterizerState: { cullMode: 0 },
                        depthStencilState: {
                            depthTest: opts.depthTest !== false,
                            depthWrite: !!opts.depthWrite,
                        },
                        blendState: {
                            targets: [
                                {
                                    blend: opts.blend !== false,
                                    blendSrc: 1, // ONE
                                    blendDst: 1, // ONE(additive)
                                    blendSrcAlpha: 1,
                                    blendDstAlpha: 1,
                                },
                            ],
                        },
                        priority: opts.priority !== undefined ? opts.priority : 128,
                        properties: {},
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
                        CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 4,
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
                attributes: opts.attributes,
                blocks: [],
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

function registerEffect(json, vert4, frag4) {
    const eff = Object.assign(new EffectAsset(), json);
    eff.shaders[0].glsl4 = { vert: vert4, frag: frag4 };
    eff.shaders[0].glsl3 = {
        vert: toGlsl3(vert4),
        frag: toGlsl3(frag4),
    };
    eff.onLoaded();
    return eff;
}

const ATTR_PART = [
    { name: 'a_position', defines: [], format: 32, location: 0 },
    { name: 'a_texCoord', defines: [], format: 21, location: 1 },
    { name: 'a_color', defines: [], format: 44, location: 2 },
];
const ATTR_P = [{ name: 'a_position', defines: [], format: 32, location: 0 }];

// ============================================================ 城市生成(确定性) ===========

const CITY_SEED = 0xE07C17;

/** 生成楼群布局:5 条 z 带 × 8 街区 × 6 楼 = 240 栋;高度随带位抬升。 */
function generateBuildings() {
    const rnd = mulberry32(CITY_SEED);
    const bands = [
        { z0: 104, z1: 208, h0: 18, h1: 46 },
        { z0: 224, z1: 328, h0: 24, h1: 64 },
        { z0: 344, z1: 448, h0: 32, h1: 88 },
        { z0: 464, z1: 568, h0: 40, h1: 112 },
        { z0: 584, z1: 688, h0: 52, h1: 140 },
    ];
    const buildings = [];
    for (let bi = 0; bi < bands.length; bi++) {
        const band = bands[bi];
        for (let xi = 0; xi < CFG.crossX.length - 1; xi++) {
            const xL = CFG.crossX[xi] + CFG.crossHalf + 3;
            const xR = CFG.crossX[xi + 1] - CFG.crossHalf - 3;
            const bw = xR - xL; // ≈ 69
            const zL = band.z0 + CFG.avenueHalf - 40 + 8; // 带内起点(避开道路)
            const zR = band.z1 - CFG.avenueHalf + 8;
            const bd = zR - zL; // ≈ 48
            for (let sy = 0; sy < 2; sy++) {
                for (let sx = 0; sx < 3; sx++) {
                    const cw = bw / 3;
                    const cd = bd / 2;
                    const cx = xL + cw * (sx + 0.5) + (rnd() - 0.5) * 5;
                    const cz = zL + cd * (sy + 0.5) + (rnd() - 0.5) * 4;
                    const w = clamp(13 + rnd() * 7, 8, cw - 4);
                    const d = clamp(24 + rnd() * 10, 12, cd - 4);
                    let h = lerp(band.h0, band.h1, Math.pow(rnd(), 1.35));
                    if (rnd() < 0.10) {
                        h = Math.min(h * 1.6, 150); // 少量高塔
                    }
                    const tint = [
                        [0.80, 0.92, 1.18], // 冷蓝灰
                        [0.86, 1.00, 1.02], // 青灰
                        [1.06, 0.96, 0.86], // 暖灰
                    ][Math.floor(rnd() * 3)];
                    const bright = 0.78 + rnd() * 0.4;
                    buildings.push({
                        x: cx, z: cz, w, d, h,
                        tr: tint[0] * bright, tg: tint[1] * bright, tb: tint[2] * bright,
                        seed: rnd() * 100,
                    });
                }
            }
        }
    }
    return buildings;
}

/** 楼体合并几何:每楼 5 面(前/背/左右/顶)× 6 顶点,逐面假光照顶点色。 */
function buildCityGeometry(buildings) {
    const n = buildings.length;
    const pos = new Float32Array(n * 30 * 3);
    const col = new Float32Array(n * 30 * 4);
    // 显示目标基色(unlit 顶点色平方后直出):夜景楼体可辨的亮度带
    const F = { front: 0.34, back: 0.155, px: 0.27, nx: 0.31, top: 0.42 };
    let vi = 0;
    const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, fr, fg, fb) => {
        // 两个三角形:a-b-c, a-c-d(逆时针朝外)
        const set = (x, y, z) => {
            const o3 = vi * 3;
            pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z;
            const o4 = vi * 4;
            col[o4] = fr; col[o4 + 1] = fg; col[o4 + 2] = fb; col[o4 + 3] = 1;
            vi++;
        };
        set(ax, ay, az); set(bx, by, bz); set(cx, cy, cz);
        set(ax, ay, az); set(cx, cy, cz); set(dx, dy, dz);
    };
    for (const b of buildings) {
        const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
        const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
        const y0 = 0, y1 = b.h;
        const c = (f) => [sv(f * b.tr), sv(f * b.tg), sv(f * b.tb)];
        let k;
        // front(+Z)
        k = c(F.front);
        quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, k[0], k[1], k[2]);
        // back(-Z)
        k = c(F.back);
        quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, k[0], k[1], k[2]);
        // +X
        k = c(F.px);
        quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, k[0], k[1], k[2]);
        // -X
        k = c(F.nx);
        quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, k[0], k[1], k[2]);
        // top
        k = c(F.top);
        quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, k[0], k[1], k[2]);
    }
    return {
        positions: pos,
        colors: col,
        minPos: new Vec3(-360, 0, 60),
        maxPos: new Vec3(360, 160, 720),
    };
}

/** 窗阵合并几何:每楼 +Z 面亮窗+暗格,±X 面亮窗;矩阵排布,点亮分布随机。 */
function buildWindowGeometry(buildings) {
    const posArr = [];
    const colArr = [];
    let litTotal = 0;
    const pushQuad = (cx, cy, cz, hw, hh, axis, r, g, b) => {
        // axis: 0=面向+Z(xy 平面) 1=面向±X(zy 平面)
        if (axis === 0) {
            posArr.push(
                cx - hw, cy - hh, cz, cx + hw, cy - hh, cz, cx + hw, cy + hh, cz,
                cx - hw, cy - hh, cz, cx + hw, cy + hh, cz, cx - hw, cy + hh, cz,
            );
        } else {
            posArr.push(
                cx, cy - hh, cz - hw, cx, cy - hh, cz + hw, cx, cy + hh, cz + hw,
                cx, cy - hh, cz - hw, cx, cy + hh, cz + hw, cx, cy + hh, cz - hw,
            );
        }
        for (let k = 0; k < 6; k++) colArr.push(r, g, b, 1);
    };

    // 亮窗色板(显示值 → 存储值 sv)
    const warm = [sv(1.0), sv(0.80), sv(0.50)];
    const cool = [sv(0.72), sv(0.84), sv(1.0)];
    const pale = [sv(0.93), sv(0.93), sv(0.88)];
    const neonW = [sv(1.0), sv(0.30), sv(0.70)];
    const neonC = [sv(0.30), sv(0.95), sv(1.0)];

    for (const b of buildings) {
        const rnd = mulberry32((CITY_SEED ^ 0x514d) + Math.floor(b.seed * 7919));
        const faces = [
            { axis: 0, fx: b.x, fz: b.z + b.d / 2 + 0.07, span: b.w, dir: 1 },
            { axis: 1, fx: b.x + b.w / 2 + 0.07, fz: b.z, span: b.d, dir: -1 },
            { axis: 1, fx: b.x - b.w / 2 - 0.07, fz: b.z, span: b.d, dir: 1 },
        ];
        let litThis = 0;
        for (let fi = 0; fi < faces.length; fi++) {
            const f = faces[fi];
            const margin = 1.3;
            const cols = Math.max(2, Math.floor((f.span - margin * 2) / 2.7));
            const rows = Math.max(3, Math.floor((b.h - margin * 2) / 3.4));
            const stepC = (f.span - margin * 2) / cols;
            const stepR = (b.h - margin * 2) / rows;
            const capLit = clamp(Math.round(cols * rows * 0.24), 6, 22);
            // 确定性洗牌选亮窗
            const cells = [];
            for (let r = 0; r < rows; r++) {
                for (let cIdx = 0; cIdx < cols; cIdx++) cells.push(r * cols + cIdx);
            }
            for (let i = cells.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
            }
            const litSet = new Set(cells.slice(0, capLit));
            // 暗窗格:维持窗格矩阵可辨识(+Z 全量限量,侧面限量) —— 矩阵结构的关键
            const dimCap = fi === 0 ? Math.min(cells.length, 56) : Math.min(cells.length, 22);
            const dimSet = new Set();
            for (let i = capLit; i < cells.length && dimSet.size < dimCap; i++) {
                dimSet.add(cells[i]);
            }
            const near = b.z < 240; // 临街两层:橱窗亮化
            let idx = 0;
            for (let r = 0; r < rows; r++) {
                for (let cIdx = 0; cIdx < cols; cIdx++, idx++) {
                    const wy = margin + stepR * (r + 0.5);
                    const wc = -((f.span - margin * 2) / 2) + stepC * (cIdx + 0.5);
                    const isLit = litSet.has(idx);
                    const isDim = dimSet.has(idx);
                    const storefront = near && fi === 0 && r === 0;
                    if (isLit || storefront) {
                        const pr = rnd();
                        let cc;
                        if (pr < 0.60) cc = warm;
                        else if (pr < 0.86) cc = cool;
                        else if (pr < 0.94) cc = pale;
                        else if (pr < 0.97) cc = neonW;
                        else cc = neonC;
                        let br = 0.62 + rnd() * 0.38;
                        if (storefront) br = 0.95 + rnd() * 0.05;
                        const ww = 0.62 + rnd() * 0.20;
                        const wh = 0.95 + rnd() * 0.30;
                        pushQuad(
                            f.axis === 0 ? f.fx + wc : f.fx,
                            wy,
                            f.axis === 0 ? f.fz : f.fz + wc,
                            stepC * 0.5 * (ww + 0.62), stepR * 0.5 * (wh + 0.18),
                            f.axis,
                            cc[0] * br, cc[1] * br, cc[2] * br,
                        );
                        litThis++;
                    } else if (isDim) {
                        const k = 0.55 + rnd() * 0.7;
                        pushQuad(
                            f.axis === 0 ? f.fx + wc : f.fx,
                            wy,
                            f.axis === 0 ? f.fz : f.fz + wc,
                            stepC * 0.5 * 0.92, stepR * 0.5 * 0.80,
                            f.axis,
                            sv(0.075 * k), sv(0.090 * k), sv(0.135 * k),
                        );
                    }
                }
            }
        }
        // 保底:每楼至少 8 个亮窗(spec)
        if (litThis < 8) {
            const f = faces[0];
            const margin = 1.3;
            const cols = Math.max(2, Math.floor((f.span - margin * 2) / 2.7));
            for (let i = litThis; i < 8; i++) {
                const wx = f.fx + (rnd() - 0.5) * (f.span - margin * 2);
                const wy = 3 + rnd() * (b.h - 6);
                pushQuad(wx, wy, f.fz, 0.55, 0.85, 0, warm[0], warm[1], warm[2]);
            }
            litThis = 8;
        }
        litTotal += litThis;
    }
    return {
        positions: new Float32Array(posArr),
        colors: new Float32Array(colArr),
        litTotal,
        minPos: new Vec3(-360, 0, 60),
        maxPos: new Vec3(360, 160, 720),
    };
}

// ============================================================ 地面(canvas 纹理) ===========

/** 世界坐标 → 画布像素(plane:u=0↔x=-半宽,v=0↔局部 z=+半宽=世界远端;画布顶行↔v=0)。 */
function paintGround(buildings) {
    const S = 2048;
    const cvn = document.createElement('canvas');
    cvn.width = S;
    cvn.height = S;
    const g = cvn.getContext('2d');
    const worldToPx = (x, z) => [
        ((x + CFG.groundSize / 2) / CFG.groundSize) * S,
        ((CFG.groundCenterZ + CFG.groundSize / 2 - z) / CFG.groundSize) * S,
    ];
    const u = CFG.groundSize / S; // 世界单位/像素

    // 基底:深沥青(unlit 平方直出 → 画布值需按 sqrt(目标显示值) 补偿)
    g.fillStyle = '#4b5468';
    g.fillRect(0, 0, S, S);
    // 画街区块(道路之间的地面)
    for (let xi = 0; xi < CFG.crossX.length - 1; xi++) {
        const xL = CFG.crossX[xi] + CFG.crossHalf, xR = CFG.crossX[xi + 1] - CFG.crossHalf;
        const bands = [[104, 208], [224, 328], [344, 448], [464, 568], [584, 688]];
        for (const [z0, z1] of bands) {
            const p0 = worldToPx(xL, z1 + CFG.avenueHalf - 8);
            const p1 = worldToPx(xR, z0 - CFG.avenueHalf + 8);
            g.fillStyle = '#3c435a';
            g.fillRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p1[1]);
        }
    }

    // 主干道(沿 X):路面带 + 车道虚线 + 边线
    for (const z of CFG.avenues) {
        const [px, py] = worldToPx(-CFG.groundSize / 2 + 1, z);
        const hpx = CFG.avenueHalf * 2 * (S / CFG.groundSize);
        g.fillStyle = '#5a6580';
        g.fillRect(0, py - hpx / 2, S, hpx);
        // 中央双黄线(显示为暖色微光)
        g.fillStyle = 'rgba(235,185,95,0.9)';
        g.fillRect(0, py - 1.2 * (S / CFG.groundSize) / 2, S, 1.2 * (S / CFG.groundSize));
        // 车道白虚线
        g.fillStyle = 'rgba(190,200,220,0.7)';
        const dash = 4 * (S / CFG.groundSize);
        for (let x = -CFG.groundSize / 2; x < CFG.groundSize / 2; x += 9) {
            const [dx] = worldToPx(x, 0);
            g.fillRect(dx, py - hpx / 4 - 1, dash, 1.4);
            g.fillRect(dx, py + hpx / 4 - 1, dash, 1.4);
        }
        void 0; // (占位)
        // 路缘微亮
        g.fillStyle = 'rgba(150,170,200,0.45)';
        g.fillRect(0, py - hpx / 2, S, 1);
        g.fillRect(0, py + hpx / 2 - 1, S, 1);
    }

    // 沿 Z 街道
    for (const x of CFG.crossX) {
        const [px] = worldToPx(x, 0);
        const wpx = CFG.crossHalf * 2 * (S / CFG.groundSize);
        g.fillStyle = '#525d78';
        g.fillRect(px - wpx / 2, 0, wpx, S);
        g.fillStyle = 'rgba(190,200,220,0.6)';
        const dash = 4 * (S / CFG.groundSize);
        for (let z = -CFG.groundSize / 2; z < CFG.groundSize / 2; z += 9) {
            const [, dy] = worldToPx(0, z);
            g.fillRect(px - 0.8, dy - dash / 2, 1.5, dash);
        }
        g.fillStyle = 'rgba(150,170,200,0.4)';
        g.fillRect(px - wpx / 2, 0, 1, S);
        g.fillRect(px + wpx / 2 - 1, 0, 1, S);
    }

    // 交叉口斑马线
    g.fillStyle = 'rgba(200,208,225,0.5)';
    for (const z of CFG.avenues) {
        for (const x of CFG.crossX) {
            const [px, py] = worldToPx(x, z);
            for (let i = -3; i <= 3; i++) {
                g.fillRect(px - 9 * (S / CFG.groundSize) / 2 + i * 3.2 * (S / CFG.groundSize), py - 11 * (S / CFG.groundSize), 1.8 * (S / CFG.groundSize), 4 * (S / CFG.groundSize));
            }
        }
    }

    // 街灯光污染:第一/二条主干道沿线暖色光池 + 远处青色微光
    for (let ai = 0; ai < 2; ai++) {
        const z = CFG.avenues[ai];
        const [, py] = worldToPx(0, z);
        for (let x = -420; x <= 420; x += 40) {
            const [px] = worldToPx(x, 0);
            const grad = g.createRadialGradient(px, py, 2, px, py, 26);
            grad.addColorStop(0, 'rgba(255,196,120,0.30)');
            grad.addColorStop(1, 'rgba(255,196,120,0)');
            g.fillStyle = grad;
            g.fillRect(px - 26, py - 26, 52, 52);
        }
    }

    // 确定性细颗粒(柏油质感)
    let seed = 987654321;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 9000; i++) {
        const x = rnd() * S;
        const y = rnd() * S;
        g.fillStyle = rnd() > 0.5 ? 'rgba(200,210,230,0.045)' : 'rgba(8,10,16,0.06)';
        g.fillRect(x, y, 2, 2);
    }
    void u;
    return cvn;
}

// ============================================================ 动态系统:车流/街灯/信标/霓虹/雨 ===

const cars = [];
const lamps = [];
const beacons = [];
const neons = [];
const drops = [];

function seedVehicles() {
    cars.length = 0;
    const rnd = mulberry32(CITY_SEED ^ 0xCA2);
    // 6 条主干道(第一条加密为前景车流)对向双车道
    let total = 0;
    for (let ai = 0; ai < CFG.avenues.length; ai++) {
        const z = CFG.avenues[ai];
        const n = ai === 0 ? 12 : 8;
        for (let i = 0; i < n; i++) {
            const dir = i % 2 === 0 ? 1 : -1;
            cars.push({
                axis: 0, dir,
                x: -400 + rnd() * 800,
                z: z + dir * CFG.avenueHalf * 0.45, // 右侧车道
                speed: 17 + rnd() * 12,
                len: 2.4 + rnd() * 1.6,
            });
            total++;
        }
    }
    // 6 条 Z 向街道(含 x=0 正对相机的主街,头灯向观众)
    const xs = [-255, -85, 0, 0, 85, 255, 340];
    for (let ri = 0; ri < xs.length; ri++) {
        for (let i = 0; i < 4; i++) {
            const dir = (ri + i) % 2 === 0 ? -1 : 1; // -1:朝相机(头灯)
            cars.push({
                axis: 1, dir,
                x: xs[ri] + (i % 2 === 0 ? -CFG.crossHalf * 0.45 : CFG.crossHalf * 0.45),
                z: 110 + rnd() * 640,
                speed: 19 + rnd() * 13,
                len: 2.4 + rnd() * 1.6,
            });
            total++;
        }
    }
    state.carCount = total;
}

function seedLamps2() {
    lamps.length = 0;
    const rnd = mulberry32(CITY_SEED ^ 0x1A7B);
    // 第一/二主干道密排(画面街道层),其余每隔一根
    for (let ai = 0; ai < CFG.avenues.length; ai++) {
        const z = CFG.avenues[ai];
        const step = ai < 2 ? 40 : 80;
        for (let x = -420; x <= 420; x += step) {
            lamps.push({
                x: x + (rnd() - 0.5) * 4,
                z: z - CFG.avenueHalf - 2.2,
                ph: rnd() * 6.28,
                warm: rnd() < 0.8,
                size: 3.2 + rnd() * 1.4,
            });
            lamps.push({
                x: x + step / 2 + (rnd() - 0.5) * 4,
                z: z + CFG.avenueHalf + 2.2,
                ph: rnd() * 6.28,
                warm: rnd() < 0.8,
                size: 3.2 + rnd() * 1.4,
            });
        }
    }
}

function seedBeacons(buildings) {
    beacons.length = 0;
    const sorted = buildings.slice().sort((a, b) => b.h - a.h);
    for (let i = 0; i < CFG.beaconCount && i < sorted.length; i++) {
        const b = sorted[i];
        beacons.push({ x: b.x, y: b.h + 2.2, z: b.z, ph: i * 0.55 });
    }
}

function seedNeons(buildings) {
    neons.length = 0;
    const rnd = mulberry32(CITY_SEED ^ 0x6E0);
    const palette = [
        [1.0, 0.12, 0.52], // 品红
        [0.10, 0.85, 1.0], // 青
        [1.0, 0.52, 0.08], // 橙黄
        [0.62, 0.20, 1.0], // 紫
        [0.20, 1.0, 0.45], // 荧光绿
    ];
    const cands = buildings.filter((b) => b.h > 34 && b.z < 620);
    for (let i = 0; i < CFG.neonCount; i++) {
        const b = cands[Math.floor(rnd() * cands.length)] || cands[0];
        const col = palette[i % palette.length];
        const kind = i % 3; // 0 竖灯带 1 横招牌 2 楼顶灯框
        const mode = i % 4; // 0 呼吸 1 硬闪 2 慢脉动 3 常亮微闪
        const zf = b.z + b.d / 2 + 0.35;
        if (kind === 0) {
            const side = rnd() < 0.5 ? -1 : 1;
            neons.push({
                type: 'vstrip',
                x: b.x + side * (b.w / 2 - 1.6), y0: 4 + rnd() * 8, y1: b.h * (0.55 + rnd() * 0.3),
                z: zf, w: 1.0 + rnd() * 0.7,
                r: col[0], g: col[1], b: col[2], ph: rnd() * 6.28, freq: 0.6 + rnd() * 1.6, mode,
            });
        } else if (kind === 1) {
            neons.push({
                type: 'hsign',
                x: b.x + (rnd() - 0.5) * b.w * 0.3, y: b.h * (0.45 + rnd() * 0.3),
                z: zf, w: Math.min(b.w * 0.8, 6 + rnd() * 8), h: 1.6 + rnd() * 1.6,
                r: col[0], g: col[1], b: col[2], ph: rnd() * 6.28, freq: 0.5 + rnd() * 1.4, mode,
            });
        } else {
            neons.push({
                type: 'frame',
                x: b.x, y0: b.h - 3, y1: b.h + 1.5,
                z: zf, w: b.w * 0.9,
                r: col[0], g: col[1], b: col[2], ph: rnd() * 6.28, freq: 0.8 + rnd() * 1.2, mode,
            });
        }
    }
}

function seedRain() {
    drops.length = 0;
    const rnd = mulberry32(CITY_SEED ^ 0xA11);
    for (let i = 0; i < CFG.rainCount; i++) {
        drops.push({
            x: -480 + rnd() * 960,
            y: rnd() * 240,
            z: 18 + rnd() * 742,
            speed: 55 + rnd() * 40,
            vx: 4 + rnd() * 10,
            len: 4 + rnd() * 4.5,
            w: 0.14 + rnd() * 0.22,
            br: 0.28 + rnd() * 0.38,
            tint: rnd(),
        });
    }
    state.rainParticleCount = drops.length;
}

// ============================================================ 动态网格写放 =================

// —— 光斑网格(车灯×3/车 + 街灯 + 信标)
const GLOW_QUADS = CFG.carCount * 3 + 220 + CFG.beaconCount;
const glowPos = new Float32Array(GLOW_QUADS * 6 * 3);
const glowUV = new Float32Array(GLOW_QUADS * 6 * 2);
const glowCol = new Float32Array(GLOW_QUADS * 6 * 4);

// —— 胶囊网格(雨 + 霓虹)
const NEON_QUAD_EST = 120;
const streakTotal = CFG.rainCount + NEON_QUAD_EST;
const streakPos = new Float32Array(streakTotal * 6 * 3);
const streakUV = new Float32Array(streakTotal * 6 * 2);
const streakCol = new Float32Array(streakTotal * 6 * 4);

const QC = [
    [-1, 1], [1, 1], [1, -1],
    [-1, 1], [1, -1], [-1, -1],
];

/** 写一个任意朝向 quad(6 顶点,quad 局部 uv ∈ [-1,1])。返回下一个顶点序号。 */
function writeQuad(posA, uvA, colA, vi, cx, cy, cz, rx, ry, rz, ux, uy, uz, w, h, r, g, b) {
    for (let k = 0; k < 6; k++) {
        const a = QC[k][0] * w;
        const bq = QC[k][1] * h;
        const o3 = (vi + k) * 3;
        posA[o3] = cx + rx * a + ux * bq;
        posA[o3 + 1] = cy + ry * a + uy * bq;
        posA[o3 + 2] = cz + rz * a + uz * bq;
        const o2 = (vi + k) * 2;
        uvA[o2] = QC[k][0];
        uvA[o2 + 1] = QC[k][1];
        const o4 = (vi + k) * 4;
        colA[o4] = r; colA[o4 + 1] = g; colA[o4 + 2] = b; colA[o4 + 3] = 1;
    }
    return vi + 6;
}

const GLOW_MIN = new Vec3(-560, -4, -60);
const GLOW_MAX = new Vec3(560, 170, 860);
const STREAK_MIN = new Vec3(-560, -4, -60);
const STREAK_MAX = new Vec3(560, 260, 860);

/** 光斑写放:车(车身微光+头灯+尾灯)/街灯/信标,面向相机 billboard。 */
function writeGlow(camR, camU, t) {
    let vi = 0;
    // 车流
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const dirX = c.axis === 0 ? c.dir : 0;
        const dirZ = c.axis === 1 ? c.dir : 0;
        const y = 1.1;
        // 车身微光(冷白小光斑,标识车身)
        vi = writeQuad(glowPos, glowUV, glowCol, vi, c.x, y, c.z,
            camR[0], camR[1], camR[2], camU[0], camU[1], camU[2],
            1.3, 0.85, 0.34, 0.38, 0.50);
        // 头灯(行进方向前端,暖白,略前伸)
        vi = writeQuad(glowPos, glowUV, glowCol, vi,
            c.x + dirX * (c.len / 2 + 0.7), y + 0.25, c.z + dirZ * (c.len / 2 + 0.7),
            camR[0], camR[1], camR[2], camU[0], camU[1], camU[2],
            1.7, 1.15, 1.0, 0.93, 0.78);
        // 尾灯(尾端,红)
        vi = writeQuad(glowPos, glowUV, glowCol, vi,
            c.x - dirX * (c.len / 2 + 0.3), y + 0.25, c.z - dirZ * (c.len / 2 + 0.3),
            camR[0], camR[1], camR[2], camU[0], camU[1], camU[2],
            1.05, 0.72, 1.0, 0.16, 0.10);
    }
    // 街灯(暖钠/冷白,微闪)
    for (let i = 0; i < lamps.length; i++) {
        const L = lamps[i];
        const fl = 0.88 + 0.12 * Math.sin(t * 7.3 + L.ph) * Math.sin(t * 1.7 + L.ph * 2.1);
        const br = 0.62 * fl;
        vi = writeQuad(glowPos, glowUV, glowCol, vi, L.x, 4.6, L.z,
            camR[0], camR[1], camR[2], camU[0], camU[1], camU[2],
            L.size, L.size,
            L.warm ? 1.0 * br : 0.72 * br, L.warm ? 0.62 * br : 0.80 * br, L.warm ? 0.26 * br : 1.0 * br);
    }
    // 屋顶信标(红色方波闪)
    for (let i = 0; i < beacons.length; i++) {
        const B = beacons[i];
        const on = ((t * 0.9 + B.ph) % 2.0) < 1.0 ? 1 : 0;
        const br = on ? 0.85 : 0.06;
        vi = writeQuad(glowPos, glowUV, glowCol, vi, B.x, B.y, B.z,
            camR[0], camR[1], camR[2], camU[0], camU[1], camU[2],
            2.0, 2.0, 1.0 * br, 0.10 * br, 0.08 * br);
    }
    // 清余顶点
    while (vi < GLOW_QUADS * 6) {
        const o3 = vi * 3;
        glowPos[o3] = glowPos[o3 + 1] = glowPos[o3 + 2] = 0;
        const o4 = vi * 4;
        glowCol[o4] = glowCol[o4 + 1] = glowCol[o4 + 2] = 0;
        vi++;
    }
    return vi / 6;
}

/** 胶囊写放:霓虹(呼吸/闪烁)+ 雨丝(竖直短线,billboard 水平朝向)。 */
function writeStreaks(camRflat, t) {
    let vi = 0;
    // 霓虹:固定贴墙朝 +Z(uv v 轴沿长度)
    for (let i = 0; i < neons.length; i++) {
        const N = neons[i];
        let amp = 1;
        if (N.mode === 0) {
            amp = 0.62 + 0.38 * Math.sin(t * N.freq * 2.2 + N.ph);
        } else if (N.mode === 1) {
            const h = Math.sin(t * 13.7 + N.ph * 9.1) * Math.sin(t * 3.1 + N.ph);
            amp = h > -0.25 ? 1.0 : 0.12;
        } else if (N.mode === 2) {
            amp = 0.75 + 0.25 * Math.sin(t * N.freq + N.ph);
        } else {
            amp = 0.9 + 0.1 * Math.sin(t * 6.0 + N.ph);
        }
        const br = 0.9 * amp;
        if (N.type === 'vstrip') {
            const cy = (N.y0 + N.y1) / 2;
            const hh = (N.y1 - N.y0) / 2;
            vi = writeQuad(streakPos, streakUV, streakCol, vi, N.x, cy, N.z,
                1, 0, 0, 0, 1, 0, N.w / 2, hh / 2 / 1.0,
                N.r * br, N.g * br, N.b * br);
        } else if (N.type === 'hsign') {
            vi = writeQuad(streakPos, streakUV, streakCol, vi, N.x, N.y, N.z,
                1, 0, 0, 0, 1, 0, N.w / 2, N.h / 2,
                N.r * br, N.g * br, N.b * br);
        } else {
            // 楼顶灯框:两竖一横(简化为上横 + 两竖)
            const cy0 = N.y0, cy1 = N.y1;
            vi = writeQuad(streakPos, streakUV, streakCol, vi, N.x - N.w / 2, (cy0 + cy1) / 2, N.z,
                1, 0, 0, 0, 1, 0, 0.45, (cy1 - cy0) / 2, N.r * br, N.g * br, N.b * br);
            vi = writeQuad(streakPos, streakUV, streakCol, vi, N.x + N.w / 2, (cy0 + cy1) / 2, N.z,
                1, 0, 0, 0, 1, 0, 0.45, (cy1 - cy0) / 2, N.r * br, N.g * br, N.b * br);
            vi = writeQuad(streakPos, streakUV, streakCol, vi, N.x, cy1, N.z,
                1, 0, 0, 0, 1, 0, N.w / 2, 0.45, N.r * br, N.g * br, N.b * br);
        }
    }
    // 雨:竖直短线,水平朝向相机(速度感拖尾,底端亮)
    for (let i = 0; i < drops.length; i++) {
        const p = drops[i];
        const cy = p.y + p.len / 2;
        // 颜色:冷蓝白微差异
        const r = (0.42 + p.tint * 0.18) * p.br;
        const g = (0.54 + p.tint * 0.12) * p.br;
        const b = (0.78 + p.tint * 0.2) * p.br;
        vi = writeQuad(streakPos, streakUV, streakCol, vi, p.x, cy, p.z,
            camRflat[0], 0, camRflat[2], 0, 1, 0,
            p.w / 2, p.len / 2, r, g, b);
    }
    // 清余顶点
    while (vi < streakTotal * 6) {
        const o3 = vi * 3;
        streakPos[o3] = streakPos[o3 + 1] = streakPos[o3 + 2] = 0;
        const o4 = vi * 4;
        streakCol[o4] = streakCol[o4 + 1] = streakCol[o4 + 2] = 0;
        vi++;
    }
    return vi / 6;
}

// ============================================================ 模拟驱动 ====================

let sim = null;
const scratchVec = new Vec3();
const scratchLook = new Vec3();

class Sim extends Component {
    t = 0;

    update(dt) {
        const d = Math.min(dt, 0.1);
        this.t += d;
        const t = this.t;

        // ---- 相机:极缓慢漂移(±1.5° 摆动,保持低角度仰视构图) ----
        const sway = Math.sin(t * 0.42) * 12 + Math.sin(t * 0.19 + 1.3) * 6;
        const bob = Math.sin(t * 0.31 + 0.5) * 0.7;
        this.camNode.setPosition(scratchVec.set(CFG.camPos.x, CFG.camPos.y + bob, CFG.camPos.z));
        this.camNode.lookAt(scratchLook.set(CFG.camLook.x + sway, CFG.camLook.y, CFG.camLook.z));

        // ---- 车流推进(环路 wrap) ----
        for (let i = 0; i < cars.length; i++) {
            const c = cars[i];
            if (c.axis === 0) {
                c.x += c.dir * c.speed * d;
                if (c.x > 430) c.x = -430;
                else if (c.x < -430) c.x = 430;
            } else {
                c.z += c.dir * c.speed * d;
                if (c.z > 800) c.z = 80;
                else if (c.z < 80) c.z = 800;
            }
        }

        // ---- 雨下落 + 落地重生顶部 ----
        for (let i = 0; i < drops.length; i++) {
            const p = drops[i];
            p.y -= p.speed * d;
            p.x += p.vx * d;
            if (p.y < 0) {
                p.y = 200 + Math.random() * 40;
                p.x = -480 + Math.random() * 960;
                p.z = 18 + Math.random() * 742;
            }
            if (p.x > 500) p.x -= 980;
        }

        // ---- 动态网格写放 ----
        const r3 = this.camNode.right;
        const u3 = this.camNode.up;
        // 雨的水平朝向:相机 right 投影到 XZ
        const rl = Math.hypot(r3.x, r3.z) || 1;
        const camRflat = [r3.x / rl, 0, r3.z / rl];
        writeGlow([r3.x, r3.y, r3.z], [u3.x, u3.y, u3.z], t);
        writeStreaks(camRflat, t);

        this.glowMesh.updateSubMesh(0, {
            positions: glowPos,
            uvs: glowUV,
            colors: glowCol,
            minPos: GLOW_MIN,
            maxPos: GLOW_MAX,
        });
        this.streakMesh.updateSubMesh(0, {
            positions: streakPos,
            uvs: streakUV,
            colors: streakCol,
            minPos: STREAK_MIN,
            maxPos: STREAK_MAX,
        });
    }
}

// ============================================================ 重置 ========================

let cityRenderer = null;
let windowRenderer = null;
let cityMeshCur = null;
let windowMeshCur = null;
let buildingsCur = [];

function rebuildStaticCity() {
    buildingsCur = generateBuildings();
    const cityGeo = buildCityGeometry(buildingsCur);
    const winGeo = buildWindowGeometry(buildingsCur);

    const oldCityMesh = cityMeshCur;
    const oldWinMesh = windowMeshCur;

    cityMeshCur = utils.createMesh(cityGeo);
    windowMeshCur = utils.createMesh(winGeo);
    cityRenderer.mesh = cityMeshCur;      // 先指新网格(绑定模型),再销毁旧网格
    windowRenderer.mesh = windowMeshCur;

    if (oldCityMesh) oldCityMesh.destroy();
    if (oldWinMesh) oldWinMesh.destroy();

    state.buildingCount = buildingsCur.length;
    state.windowCount = winGeo.litTotal;
    seedBeacons(buildingsCur);
    seedNeons(buildingsCur);
}

function doReset() {
    state.resetCount += 1;
    rebuildStaticCity();      // 同一种子确定性重建(城市完整重建)
    seedVehicles();
    seedLamps2();
    seedRain();
    state.fogEnabled = true;  // 恢复初始开关
    applyFog();
    if (sim) sim.t = 0;       // 动画相位归零
    syncUi();
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
        resetCount: state.resetCount,
        buildingCount: state.buildingCount,
        carCount: state.carCount,
        rainParticleCount: state.rainParticleCount,
        fogEnabled: state.fogEnabled,
        fps: state.fps,
        windowCount: state.windowCount,
    }),
    reset: doReset,
};

// ============================================================ 启动 ========================

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    // ---- effect 注册(引擎引导后) ----
    const skyEff = registerEffect(
        makeEffectJson({
            name: 'e07-sky',
            prog: 'e07-sky|sky-vs:vert|sky-fs:frag',
            hash: 700701,
            attributes: ATTR_P,
            depthTest: true,
            depthWrite: false,
            blend: false,
            priority: 0,
        }),
        vertSky4,
        SKY_FRAG4,
    );
    const glowEff = registerEffect(
        makeEffectJson({
            name: 'e07-glow',
            prog: 'e07-glow|gl-vs:vert|gl-fs:frag',
            hash: 700702,
            attributes: ATTR_PART,
            depthTest: true,
            depthWrite: false,
            blend: true,
            priority: 130,
        }),
        vertParticle4,
        GLOW_FRAG4,
    );
    const streakEff = registerEffect(
        makeEffectJson({
            name: 'e07-streak',
            prog: 'e07-streak|st-vs:vert|st-fs:frag',
            hash: 700703,
            attributes: ATTR_PART,
            depthTest: true,
            depthWrite: false,
            blend: true,
            priority: 135,
        }),
        vertParticle4,
        STREAK_FRAG4,
    );

    // ---- 场景与相机 ----
    const scene = new Scene('e07-neon-city');

    const camNode = new Node('Main Camera');
    scene.addChild(camNode);
    camNode.setPosition(CFG.camPos);
    camNode.lookAt(CFG.camLook);
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CFG.fov;
    camera.near = 1;
    camera.far = 2600;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = CFG.fogColor; // 与雾色一致:远楼融入天际
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    const mkNode = (name) => {
        const n = new Node(name);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        return n;
    };

    /** builtin-unlit + 顶点色材质(引擎管线雾自动生效)。 */
    const matUnlitVC = () => {
        const m = new Material();
        m.initialize({ effectName: 'builtin-unlit', defines: { USE_VERTEX_COLOR: true } });
        return m;
    };

    // ---- 雾:app.run 前配置 → 场景激活时随首帧生效(无编译颠簸) ----
    {
        const fog = scene.globals.fog;
        fog.type = 0; // FogType.LINEAR
        fog.fogColor = CFG.fogColor;
        fog.fogStart = CFG.fogStart;
        fog.fogEnd = CFG.fogEnd;
        fog.enabled = true;
        window.__fogInfo = fog;
    }
    // 环境光压暗(场景无受光材质,语义完备性)
    scene.globals.ambient.skyColorHDR.set(0.05, 0.07, 0.13, 1.0);
    scene.globals.ambient.skyIllum = 1200;

    // ---- 天空(大球内面,自定义 shader,不受雾影响) ----
    {
        const node = mkNode('Sky');
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.sphere(1500, { segments: 32 }));
        const m = new Material();
        m.initialize({ effectAsset: skyEff });
        mr.setSharedMaterial(m, 0);
    }

    // ---- 楼群 + 窗阵(合并静态网格,各 1 draw call) ----
    {
        const node = mkNode('City');
        cityRenderer = node.addComponent(MeshRenderer);
        cityRenderer.material = matUnlitVC();

        const wnode = mkNode('Windows');
        windowRenderer = wnode.addComponent(MeshRenderer);
        windowRenderer.material = matUnlitVC();
    }
    rebuildStaticCity();

    // ---- 地面(canvas 纹理) ----
    {
        const cvn = paintGround();
        const tex = new Texture2D();
        tex.reset({ width: cvn.width, height: cvn.height, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(cvn);

        const node = mkNode('Ground');
        node.setPosition(new Vec3(0, -0.2, CFG.groundCenterZ));
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.plane({ width: CFG.groundSize, length: CFG.groundSize, widthSegments: 1, lengthSegments: 1 }));
        const m = new Material();
        m.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: true } });
        m.setProperty('mainTexture', tex);
        m.setProperty('mainColor', new Color(255, 255, 255, 255));
        mr.material = m;
    }

    // ---- 动态网格:光斑(车/街灯/信标) + 胶囊(雨/霓虹) ----
    const createDyn = utils.createDynamicMesh || (utils.MeshUtils && utils.MeshUtils.createDynamicMesh);
    let glowMesh = null;
    let streakMesh = null;
    {
        seedVehicles();
        seedLamps2();
        seedRain();
        writeGlow([1, 0, 0], [0, 1, 0], 0);
        writeStreaks([1, 0, 0], 0);

        const gnode = mkNode('Glow');
        const gmr = gnode.addComponent(MeshRenderer);
        glowMesh = createDyn(0, {
            positions: glowPos, uvs: glowUV, colors: glowCol,
            minPos: GLOW_MIN, maxPos: GLOW_MAX,
        }, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: GLOW_QUADS * 6 + 16,
            maxSubMeshIndices: 16,
        });
        gmr.mesh = glowMesh;
        const gm = new Material();
        gm.initialize({ effectAsset: glowEff });
        gmr.setSharedMaterial(gm, 0);

        const snode = mkNode('Streaks');
        const smr = snode.addComponent(MeshRenderer);
        streakMesh = createDyn(0, {
            positions: streakPos, uvs: streakUV, colors: streakCol,
            minPos: STREAK_MIN, maxPos: STREAK_MAX,
        }, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: streakTotal * 6 + 16,
            maxSubMeshIndices: 16,
        });
        smr.mesh = streakMesh;
        const sm = new Material();
        sm.initialize({ effectAsset: streakEff });
        smr.setSharedMaterial(sm, 0);
    }

    // ---- 模拟驱动 ----
    const simNode = new Node('Sim');
    simNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(simNode);
    sim = simNode.addComponent(Sim);
    sim.camNode = camNode;
    sim.glowMesh = glowMesh;
    sim.streakMesh = streakMesh;

    app.run(scene);

    // ---- 帧计数 + fps 真实测量 + 首帧就绪 ----
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
        const now = performance.now();
        fpsTimes[fpsHead] = now;
        fpsHead = (fpsHead + 1) % fpsTimes.length;
        if (fpsFilled < fpsTimes.length) fpsFilled++;
        if (fpsFilled >= 2) {
            const newest = fpsHead === 0 ? fpsTimes.length - 1 : fpsHead - 1;
            const count = Math.min(fpsFilled, 61); // 最近 ~60 帧窗口
            const oldestIdx = (newest - (count - 1) + fpsTimes.length * 2) % fpsTimes.length;
            const span = now - fpsTimes[oldestIdx];
            state.fps = span > 0 ? Math.round(((count - 1) / (span / 1000)) * 10) / 10 : 0;
        }
    });

    syncUi();
    console.log(
        '[e07] neon night city on cocosair — buildings:', state.buildingCount,
        'litWindows:', state.windowCount, 'cars:', state.carCount, 'rain:', state.rainParticleCount,
    );
} catch (err) {
    console.error('[e07] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
