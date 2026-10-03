/**
 * E06 — 荒野篝火营地(Wilderness Campfire)· Cocos AIR Reference 实现
 *
 * 场景定位:探测 AIR 的 动态点光真实照明 / 程序化低多边形场景 / CPU 粒子 / 状态与相机域。
 *
 * 技术路线(全部程序化,无外部资产):
 *   - 地形:程序化低多边形圆盘(径向环 + 非索引三角形逐面法线 = flat shading),
 *     营地中央平坦、外围起伏 + 远缘抬升(碗形谷地);高度函数与树摆放共用(树落地)。
 *   - 树环:16 棵低多边形树(7 棱柱树干 + 双层 7 棱锥树冠),环形散布避开场心;
 *     builtin-standard 受光材质 —— 被火光/月光真实照亮(明暗面)。
 *   - 篝火:石圈(随机比例盒子)+ 交叉柴堆(轴角四元数斜倚圆柱)+ 焦土圆盘;
 *     火苗 = 面向相机 billboard quad + 自定义 effect(域扭曲 fbm 火焰,双层次);
 *     火光晕 = additive 径向衰减 billboard;
 *     火苗粒子(32)/ 火星(60)/ 萤火虫(20)/ 烟(12)= utils.MeshUtils.createDynamicMesh
 *     + updateSubMesh 每帧顶点写放,单 draw call,additive 顶点色直出 + 软圆衰减。
 *   - 动态火光:真实 PointLight(暖橙色,range 12),luminance 每帧随多频混合
 *     (0.43/1.9/4.6 Hz)闪烁 —— 地面/树干受光亮度随之变化(forward additive
 *     多光源路径,RenderAdditiveLightQueue)。点光不支持阴影(引擎源码明示,如实记录)。
 *   - 日夜:timeOfDay 0(夜)⇄ 1(日)3.2 s 线性渐变(中间态可采样),视觉经
 *     smoothstep 映射:天穹 shader(渐变+八面体星点+银河带+月亮/太阳+晨昏暖带)、
 *     环境光(skyColorHDR/skyIllum)、主方向光(月光⇄日光)、clearColor、
 *     星空/萤火虫可见度 全部联动。
 *   - 相机:自动环绕 0.24 rad/s(0.05-0.4 合同区间),俯角环视营地;可暂停/恢复;
 *     拖拽微调视角(可选加分)。
 *
 * 页面契约:window.__appReady(首帧后 true)/ window.__bench={getState,reset}。
 * 状态通道(真实数据):timeOfDay / fireLightIntensity / fireflyCount /
 *   cameraOrbitAngle / orbitEnabled / treeCount(+engine/frame/ready/resetCount/
 *   emberAlive/flameParticleCount)。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    PointLight,
    MeshRenderer,
    utils,
    primitives,
    Vec3,
    Quat,
    Color,
    Component,
    Material,
    EffectAsset,
    director,
    Director,
} from 'cocosair.js';

// ============================================================ 常量与状态 ==================

const CFG = {
    // 相机
    orbitRadius: 12.8,
    lookAtY: 1.15,
    fov: 50,
    orbitSpeed: 0.24, // rad/s ∈ [0.05, 0.4](spec)
    elevBase: 0.365, // 俯仰(弧度)
    // 日夜
    dayDuration: 3.2, // s ∈ [2.5, 4](spec)
    // 火光
    fireLumMax: 30000, // HDR luminance 上限(intensity=1 时;过高会致近场过曝发白)
    fireRange: 13,
    fireBase: 0.55, // 基准强度(spec ~0.55)
    // 规模
    treeCount: 16, // ≥ 12(建议 14-24)
    fireflyCount: 20, // ≥ 16
    lickCount: 32, // 火苗粒子
    sparkCount: 60, // 火星池(同屏存活 ≈ 60 ≥ 40 峰值合同)
    smokeCount: 12,
    groundRadius: 17,
};

const state = {
    frame: 0,
    resetCount: 0,
    timeOfDay: 0, // 0=深夜 1=正午
    dayTarget: 0, // 渐变目标端点
    fireTime: 0, // 火光相位时钟(reset 归零)
    fireLightIntensity: CFG.fireBase,
    orbitAngle: 0,
    orbitEnabled: true,
    elevOffset: 0, // 拖拽俯仰偏移
};

window.__appReady = false;

function doReset() {
    state.resetCount += 1;
    state.timeOfDay = 0;
    state.dayTarget = 0;
    state.fireTime = 0;
    state.orbitAngle = 0;
    state.orbitEnabled = true;
    state.elevOffset = 0;
    seedParticles(); // 火苗/火星/萤火虫/烟按同一种子复位
    syncUi();
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
        resetCount: state.resetCount,
        timeOfDay: state.timeOfDay,
        fireLightIntensity: state.fireLightIntensity,
        fireflyCount: CFG.fireflyCount,
        cameraOrbitAngle: state.orbitAngle,
        orbitEnabled: state.orbitEnabled,
        treeCount: CFG.treeCount,
        emberAlive: aliveCounters.sparks,
        flameParticleCount: aliveCounters.licks,
    }),
    reset: doReset,
};

// ---- UI 覆盖层(DOM):右上角(x>0.8, y<0.25),data-ui 契约 ------------------------------
let statusEl = null;
let orbitBtn = null;

function syncUi() {
    if (statusEl) {
        statusEl.textContent =
            (state.timeOfDay < 0.5 ? '夜' : '昼') + ' · 环绕:' + (state.orbitEnabled ? '开' : '关');
    }
    if (orbitBtn) {
        orbitBtn.textContent = state.orbitEnabled ? '暂停环绕' : '恢复环绕';
    }
}

{
    const mkBtn = (label, ui, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.setAttribute('data-ui', ui);
        btn.style.cssText =
            'position:fixed;right:12px;z-index:9999;padding:5px 14px;' +
            "font:12px sans-serif;background:#181820;color:#dfe3ee;border:1px solid #4a5068;" +
            'border-radius:4px;cursor:pointer;min-width:88px;text-align:center';
        btn.addEventListener('click', onClick);
        return btn;
    };
    const top = (i) => `top:${10 + i * 36}px`;

    const dnBtn = mkBtn('日夜切换', 'day-night', () => {
        state.dayTarget = state.timeOfDay < 0.5 ? 1 : 0;
        syncUi();
    });
    dnBtn.style.cssText += ';' + top(0);

    orbitBtn = mkBtn('暂停环绕', 'orbit-toggle', () => {
        state.orbitEnabled = !state.orbitEnabled;
        syncUi();
    });
    orbitBtn.style.cssText += ';' + top(1);

    const rsBtn = mkBtn('重置', 'reset', () => doReset());
    rsBtn.style.cssText += ';' + top(2);

    document.body.appendChild(dnBtn);
    document.body.appendChild(orbitBtn);
    document.body.appendChild(rsBtn);

    statusEl = document.createElement('div');
    statusEl.textContent = '夜 · 环绕:开';
    statusEl.style.cssText =
        'position:fixed;right:12px;top:126px;z-index:9999;pointer-events:none;' +
        "font:11px sans-serif;color:rgba(200,210,230,0.75);letter-spacing:1px;min-width:88px;text-align:center";
    document.body.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = '拖拽微调视角';
    hint.style.cssText =
        'position:fixed;left:12px;bottom:10px;z-index:9999;pointer-events:none;' +
        "font:11px sans-serif;color:rgba(190,200,225,0.5);letter-spacing:1px";
    document.body.appendChild(hint);
}

// ---- 拖拽微调视角(可选加分):水平改 orbitAngle、垂直改俯仰偏移 -------------------------
{
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const cv = document.querySelector('#GameCanvas');
    cv.addEventListener('pointerdown', (e) => {
        dragging = true;
        lx = e.clientX;
        ly = e.clientY;
        cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lx;
        const dy = e.clientY - ly;
        lx = e.clientX;
        ly = e.clientY;
        state.orbitAngle += dx * 0.004;
        state.elevOffset = Math.max(-0.22, Math.min(0.4, state.elevOffset + dy * 0.003));
    });
    const endDrag = () => {
        dragging = false;
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
}

// ============================================================ 工具 ========================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
};

/** 确定性 PRNG(mulberry32):粒子系统复位后与初始状态一致。 */
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

/** 地形高度(与建面/树摆放共用,保证树落地):营地平坦,外围起伏,远缘抬升成谷地。 */
function terrainHeight(r, ang) {
    const ring = smooth01((r - 4.6) / 3.4);
    const hills =
        0.30 * Math.sin(ang * 2 + 1.7) + 0.22 * Math.sin(ang * 3 - 0.6) + 0.16 * Math.sin(ang * 5 + 2.2);
    const rim = 0.62 * smooth01((r - 11.5) / 4.0);
    return ring * hills + rim;
}

// ============================================================ GLSL 变体与 effect 骨架 =====
// 与引擎同源的 UBO 块声明(src/cocos builtin 布局;WebGL2 只消费 glsl3 变体)。

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

const wrapVert = (body4) => ({
    glsl4: 'precision highp float;\n' + UB_CAM4 + '\n' + UB_LOC4 + '\n' + body4,
    glsl3: 'precision highp float;\n' + toGlsl3(UB_CAM4) + '\n' + toGlsl3(UB_LOC4) + '\n' + body4,
});

/** billboard quad 顶点:a_position(XY 平面,[-0.5,0.5]) → v_p ∈ [-1,1]。 */
const vertQuad = () =>
    wrapVert(`in vec3 a_position;
out highp vec2 v_p;
void main () {
  v_p = a_position.xy * 2.0;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`);

/** 天穹顶点:a_position → 世界方向 v_dir(天穹置于原点半径 300)。 */
const vertSky = () =>
    wrapVert(`in vec3 a_position;
out highp vec3 v_dir;
void main () {
  v_dir = (cc_matWorld * vec4(a_position, 1.0)).xyz;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`);

/** 粒子顶点:a_position + a_texCoord(quad 局部 [-1,1])+ a_color。 */
const vertParticle = () =>
    wrapVert(`in vec3 a_position;
in vec2 a_texCoord;
in vec4 a_color;
out mediump vec2 v_soft;
out mediump vec4 v_color;
void main () {
  v_soft = a_texCoord;
  v_color = a_color;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`);

/** 编译后形态 effect JSON(E05 验证路径:同 examples/shared/shader-blocks)。 */
function makeEffectJson(opts) {
    const members = opts.members || [];
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
                                    blendSrc: opts.blendSrc !== undefined ? opts.blendSrc : 1,
                                    blendDst: opts.blendDst !== undefined ? opts.blendDst : 1,
                                    blendSrcAlpha: 1,
                                    blendDstAlpha: 1,
                                },
                            ],
                        },
                        priority: opts.priority !== undefined ? opts.priority : 128,
                        properties: opts.properties || {},
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
                attributes: opts.attributes,
                blocks: members.length
                    ? [{ name: 'Constants', defines: [], binding: 0, stageFlags: 16, members }]
                    : [],
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

/** 注册(时机纪律:必须在 createAirApp 之后)。 */
function registerEffect(json, vert, frag) {
    const eff = Object.assign(new EffectAsset(), json);
    eff.shaders[0].glsl4 = { vert: vert.glsl4, frag: frag.glsl4 };
    eff.shaders[0].glsl3 = { vert: vert.glsl3, frag: frag.glsl3 };
    eff.onLoaded();
    return eff;
}

// ============================================================ 各 effect 片元 GLSL =========

// ---- 1) 天穹:日夜渐变 + 八面体星点 + 银河带 + 月亮/太阳 + 晨昏暖带 ----------------------
const SKY_FRAG4 = `precision highp float;
${UB_GLB4}
layout(set = 1, binding = 0) uniform Constants {
  highp float dayF;   // 视觉日夜因子(0=夜 1=日,smoothstep 映射)
};
in highp vec3 v_dir;
layout(location = 0) out vec4 cc_FragColor;
float hash21 (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise (vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm (vec2 p) {
  float v = 0.0; float a = 0.55;
  for (int k = 0; k < 3; k++) { v += a * vnoise(p); p = p * 2.13 + vec2(11.3, 7.9); a *= 0.5; }
  return v;
}
void main () {
  vec3 dir = normalize(v_dir);
  float h = dir.y;
  float e = clamp(dayF, 0.0, 1.0);

  // 基础渐变:夜(深蓝→地平微青)⇄ 日(亮蓝→地平暖白)
  vec3 zen = mix(vec3(0.010, 0.016, 0.044), vec3(0.28, 0.50, 0.87), e);
  vec3 hor = mix(vec3(0.045, 0.075, 0.140), vec3(0.87, 0.88, 0.90), e);
  float g = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 2.4);
  vec3 sky = mix(zen, hor, g);

  // 晨昏暖带(渐变中段地平线泛橙)
  float dawn = sin(3.14159265 * e);
  sky += vec3(0.60, 0.24, 0.06) * dawn * pow(g, 1.4) * 0.85;

  // 地平线以下压暗(地形边缘外的天穹)
  sky *= mix(0.30, 1.0, smoothstep(-0.30, 0.02, h));

  // 星点:八面体映射网格 + 3x3 邻域,夜间可见、白天淡出
  float starVis = (1.0 - smoothstep(0.42, 0.72, e)) * smoothstep(-0.02, 0.14, h);
  if (starVis > 0.003) {
    vec2 oct = dir.xz / (abs(dir.x) + abs(dir.y) + abs(dir.z));
    vec2 st = oct * 19.0;
    vec2 cell = floor(st); vec2 f = fract(st);
    float acc = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 off = vec2(float(ox), float(oy));
        vec2 id = cell + off;
        float rn = hash21(id);
        if (rn > 0.48) {
          vec2 sc = off + 0.15 + 0.70 * vec2(hash21(id + 7.13), hash21(id + 3.71));
          float d2 = dot(f - sc, f - sc);
          float sharp = mix(220.0, 700.0, hash21(id + 1.37));
          float tw = 0.72 + 0.28 * sin(cc_time.x * (1.2 + 2.6 * hash21(id + 9.9)) + rn * 40.0);
          acc += exp(-d2 * sharp) * tw;
        }
      }
    }
    // 银河带:沿大圆的 fbm 亮带
    float band = exp(-pow(dot(dir, normalize(vec3(0.55, 0.28, 0.83))), 2.0) * 7.0);
    float mw = fbm(oct * 6.5 + 3.7) * band;
    sky += (vec3(0.62, 0.70, 0.95) * acc * 0.85 + vec3(0.05, 0.06, 0.10) * mw * 2.2) * starVis;
  }

  // 月亮(夜)固定方向;太阳(日)另一方向
  vec3 moonDir = normalize(vec3(-0.46, 0.50, 0.38));
  float md = dot(dir, moonDir);
  float moon = smoothstep(0.99920, 0.99960, md);
  float moonShade = smoothstep(0.99900, 0.99975, dot(dir, normalize(moonDir + vec3(0.0075, 0.005, 0.0))));
  float moonHalo = 0.16 * pow(max(md, 0.0), 160.0);
  sky += vec3(0.92, 0.94, 1.00) * (moon * 1.15 + moonHalo) * (1.0 - 0.88 * e)
       * vec3(1.0, 0.99, 0.96 * (0.35 + 0.65 * moonShade));
  vec3 sunDir = normalize(vec3(0.42, 0.46, -0.55));
  float sd = dot(dir, sunDir);
  float sun = smoothstep(0.99955, 0.99985, sd);
  float sunHalo = 0.55 * pow(max(sd, 0.0), 320.0);
  sky += (vec3(1.00, 0.96, 0.82) * sun * 2.0 + vec3(1.00, 0.88, 0.66) * sunHalo) * e;

  // 抖动去色带
  sky += (hash21(dir.xz * 513.7 + fract(cc_time.x) * 3.1) - 0.5) * 0.006;
  cc_FragColor = vec4(sky, 1.0);
}`;

// ---- 2) 火苗:域扭曲 fbm 火焰,橙黄→红渐变,向上摆动 --------------------------------------
const FLAME_FRAG4 = `precision highp float;
${UB_GLB4}
layout(set = 1, binding = 0) uniform Constants {
  highp float flameI;  // 火光强度(与点光同一状态源)
  highp float phase;   // 层相位偏移
  highp float dayDim;  // 白天整体压制(仍可见)
};
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
float hash21 (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise (vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm (vec2 p) {
  float v = 0.0; float a = 0.55;
  for (int k = 0; k < 3; k++) { v += a * vnoise(p); p = p * 2.07 + vec2(9.4, 3.1); a *= 0.5; }
  return v;
}
void main () {
  float t = cc_time.x + phase;
  float y01 = v_p.y * 0.5 + 0.5;            // 0=火根 1=焰尖
  // 火焰宽度包络(泪滴形):根部收窄,下 1/4 最宽,向上收尖
  float w = 0.66 * pow(1.0 - y01, 0.75) * (0.30 + 0.70 * smoothstep(0.0, 0.24, y01));
  w *= 0.88 + 0.20 * flameI;
  // 横向摆动(多频) + 噪声域扭曲
  float sway = 0.16 * sin(t * 2.3 + y01 * 4.5 + phase) + 0.10 * sin(t * 4.1 + 1.9 + y01 * 7.0);
  float x = (v_p.x - sway * (0.25 + 0.75 * y01)) / max(w, 1e-4);
  float n = fbm(vec2(x * 1.7 + phase, y01 * 2.4 - t * 1.55));
  float body = clamp(1.0 - abs(x), 0.0, 1.0);
  float edge = smoothstep(0.92, 0.10, abs(x) + (n - 0.5) * 0.62 * (0.35 + y01));
  float vert = smoothstep(0.0, 0.05, y01) * smoothstep(1.06, 0.50, y01 + (n - 0.5) * 0.35);
  // 焰心亮核
  float core = clamp(1.0 - abs(x) * 2.6, 0.0, 1.0) * smoothstep(0.5, 0.05, y01);
  float I = (body * edge * vert + core * edge * 0.55) * (0.72 + 0.55 * flameI) * (1.0 - dayDim);
  // 色带:外缘暗红 → 橙 → 焰心黄白
  vec3 col = mix(vec3(0.55, 0.06, 0.01), vec3(1.00, 0.42, 0.06), smoothstep(0.0, 0.5, I));
  col = mix(col, vec3(1.00, 0.78, 0.28), smoothstep(0.45, 0.85, I));
  col = mix(col, vec3(1.00, 0.96, 0.78), smoothstep(0.78, 1.05, I));
  cc_FragColor = vec4(col * I * 1.35, 1.0);
}`;

// ---- 3) 火光晕:additive 径向衰减(闪烁幅度联动) -------------------------------------------
const GLOW_FRAG4 = `precision highp float;
layout(set = 1, binding = 0) uniform Constants {
  highp float glowI;
  highp float dayDim;
};
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d = length(v_p);
  float halo = exp(-d * d * 2.6) * 0.75 + exp(-d * 5.5) * 0.45;
  float I = halo * glowI * (1.0 - dayDim);
  vec3 col = mix(vec3(1.00, 0.52, 0.16), vec3(1.00, 0.72, 0.34), halo);
  cc_FragColor = vec4(col * I, 1.0);
}`;

// ---- 4) 粒子:顶点色直出 + 软圆衰减(additive,色值即贡献) ----------------------------------
const PART_FRAG4 = `precision highp float;
in mediump vec2 v_soft;
in mediump vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d2 = dot(v_soft, v_soft);
  cc_FragColor = vec4(v_color.rgb * exp(-d2 * 3.5), 1.0);
}`;

// ============================================================ 地形/几何构建 ==============

/** 低多边形地面:径向环离散 + 非索引三角形(逐面法线 = flat shading)。 */
function buildGroundGeometry() {
    const rings = [0, 1.6, 3.2, 4.6, 6.2, 8.0, 10.0, 12.2, 14.6, CFG.groundRadius];
    const segs = 44;
    const pos = [];
    const nor = [];
    const tri = (a, b, c) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // 统一朝上
        for (const p of [a, b, c]) {
            pos.push(p[0], p[1], p[2]);
            nor.push(nx, ny, nz);
        }
    };
    const pt = (ri, si) => {
        const r = rings[ri];
        const a = (si / segs) * Math.PI * 2;
        return [r * Math.cos(a), terrainHeight(r, a), r * Math.sin(a)];
    };
    for (let ri = 0; ri < rings.length - 1; ri++) {
        for (let si = 0; si < segs; si++) {
            const a = pt(ri, si);
            const b = pt(ri + 1, si);
            const c = pt(ri + 1, si + 1);
            const d = pt(ri, si + 1);
            if (ri === 0) {
                tri(a, c, b);
            } else {
                tri(a, b, c);
                tri(a, c, d);
            }
        }
    }
    return {
        positions: new Float32Array(pos),
        normals: new Float32Array(nor),
        minPos: new Vec3(-CFG.groundRadius, -0.5, -CFG.groundRadius),
        maxPos: new Vec3(CFG.groundRadius, 1.6, CFG.groundRadius),
    };
}

/** 平顶圆盘(焦土),朝上法线,非索引扇形。 */
function buildDiscGeometry(radius, segs) {
    const pos = [0, 0, 0];
    const nor = [0, 1, 0];
    for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        pos.push(0, 0, 0, Math.cos(a0) * radius, 0, Math.sin(a0) * radius, Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    return {
        positions: new Float32Array(pos),
        normals: new Float32Array(nor),
        minPos: new Vec3(-radius, 0, -radius),
        maxPos: new Vec3(radius, 0, radius),
    };
}

// ============================================================ 粒子系统 ===================

const licks = [];
const sparks = [];
const flies = [];
const smokes = [];
const aliveCounters = { licks: 0, sparks: 0 };

function spawnLick(rnd, p) {
    p.x = (rnd() - 0.5) * 0.26;
    p.z = (rnd() - 0.5) * 0.26;
    p.y = 0.16 + rnd() * 0.22;
    p.vy = 0.55 + rnd() * 0.75;
    p.life = 0.32 + rnd() * 0.45;
    p.age = 0;
    p.size = 0.075 + rnd() * 0.07;
    p.seed = rnd() * 10;
    return p;
}
function spawnSpark(rnd, p) {
    const a = rnd() * Math.PI * 2;
    const rr = rnd() * 0.2;
    p.x = Math.cos(a) * rr;
    p.z = Math.sin(a) * rr;
    p.y = 0.35 + rnd() * 0.35;
    p.vx = (rnd() - 0.5) * 0.5;
    p.vz = (rnd() - 0.5) * 0.5;
    p.vy = 1.2 + rnd() * 1.8; // ∈ [1, 3] 合同
    p.life = 0.9 + rnd() * 1.1; // ∈ [0.8, 2] 合同
    p.age = rnd() < 0.5 ? rnd() * p.life : 0; // 初始铺场:一半在途中
    p.size = 0.02 + rnd() * 0.03;
    p.seed = rnd() * 10;
    return p;
}
function spawnFly(rnd, p, i) {
    p.ang = (i / CFG.fireflyCount) * Math.PI * 2 + rnd() * 0.5;
    p.rad = 4.6 + rnd() * 6.2;
    p.h = 0.5 + rnd() * 1.9;
    p.fx = 0.16 + rnd() * 0.22;
    p.fy = 0.12 + rnd() * 0.18;
    p.phx = rnd() * Math.PI * 2;
    p.phy = rnd() * Math.PI * 2;
    p.blf = 0.35 + rnd() * 0.55; // 明灭频率 Hz
    p.phb = rnd() * Math.PI * 2;
    p.amp = 0.5 + rnd() * 0.8;
    p.size = 0.042 + rnd() * 0.028;
    return p;
}
function spawnSmoke(rnd, p) {
    p.x = (rnd() - 0.5) * 0.2;
    p.z = (rnd() - 0.5) * 0.2;
    p.y = 1.5 + rnd() * 0.3;
    p.vy = 0.35 + rnd() * 0.3;
    p.life = 2.6 + rnd() * 1.6;
    p.age = rnd() * p.life; // 初始铺场
    p.size0 = 0.22 + rnd() * 0.12;
    p.seed = rnd() * 10;
    return p;
}

function seedParticles() {
    licks.length = 0;
    for (let i = 0; i < CFG.lickCount; i++) {
        licks.push(spawnLick(mulberry32(0x6c1c0 ^ (i * 7919)), {}));
    }
    sparks.length = 0;
    for (let i = 0; i < CFG.sparkCount; i++) {
        sparks.push(spawnSpark(mulberry32(0x5ea7a ^ (i * 7919)), {}));
    }
    flies.length = 0;
    for (let i = 0; i < CFG.fireflyCount; i++) {
        flies.push(spawnFly(mulberry32(0xf1e5a ^ (i * 104729)), {}, i));
    }
    smokes.length = 0;
    for (let i = 0; i < CFG.smokeCount; i++) {
        smokes.push(spawnSmoke(mulberry32(0x5007e ^ (i * 7919)), {}));
    }
}

// ---- 粒子顶点写放(火苗/火星/萤火虫/烟 → 单动态网格) --------------------------------------

const TOTAL_QUADS = CFG.lickCount + CFG.sparkCount + CFG.fireflyCount + CFG.smokeCount;
const partPos = new Float32Array(TOTAL_QUADS * 6 * 3);
const partUV = new Float32Array(TOTAL_QUADS * 6 * 2);
const partCol = new Float32Array(TOTAL_QUADS * 6 * 4);
const PMIN = new Vec3(-14, 0, -14);
const PMAX = new Vec3(14, 8, 14);
const V_DYN_OPTS = {
    maxSubMeshes: 1,
    maxSubMeshVertices: TOTAL_QUADS * 6 + 8,
    maxSubMeshIndices: 8,
};

const QUAD_CORNERS = [
    [-1, 1], [1, 1], [1, -1], [-1, 1], [1, -1], [-1, -1],
];

/** 写一个面向相机的 quad(6 顶点 + 软圆 uv)。 */
function writeQuad(vi, cx, cy, cz, rx, ry, rz, ux, uy, uz, size, cr, cg, cb) {
    for (let k = 0; k < 6; k++) {
        const a = QUAD_CORNERS[k][0] * size;
        const b = QUAD_CORNERS[k][1] * size;
        const o = (vi + k) * 3;
        partPos[o] = cx + rx * a + ux * b;
        partPos[o + 1] = cy + ry * a + uy * b;
        partPos[o + 2] = cz + rz * a + uz * b;
        const o2 = (vi + k) * 2;
        partUV[o2] = QUAD_CORNERS[k][0];
        partUV[o2 + 1] = QUAD_CORNERS[k][1];
        const o4 = (vi + k) * 4;
        partCol[o4] = cr;
        partCol[o4 + 1] = cg;
        partCol[o4 + 2] = cb;
        partCol[o4 + 3] = 1;
    }
    return vi + 6;
}

function writeParticles(camRight, camUp, e, fi) {
    const t = state.fireTime;
    let vi = 0;
    const rx = camRight[0], ry = camRight[1], rz = camRight[2];
    const ux = camUp[0], uy = camUp[1], uz = camUp[2];

    // 火苗粒子:亮黄白 → 橙 → 暗红,尺寸收缩
    for (const p of licks) {
        const u = p.age / p.life;
        const b = smooth01(u / 0.15) * (1 - smooth01((u - 0.55) / 0.45)) * (0.65 + 0.5 * fi);
        if (b <= 0.003) {
            vi += 6;
            continue;
        }
        const cr = lerp(1.0, 0.55, u);
        const cg = lerp(0.85, 0.12, u);
        const cb = lerp(0.38, 0.02, u);
        vi = writeQuad(vi, p.x, p.y, p.z, rx, ry, rz, ux, uy, uz, p.size * (1 - 0.5 * u), cr * b, cg * b, cb * b);
    }
    // 火星:持续上升消散,亮橙 → 红
    for (const p of sparks) {
        const u = p.age / p.life;
        const b = Math.pow(1 - u, 1.25) * (0.8 + 0.45 * fi);
        const tw = 0.75 + 0.25 * Math.sin(t * 12 + p.seed * 7);
        vi = writeQuad(vi, p.x, p.y, p.z, rx, ry, rz, ux, uy, uz, p.size * (1 - 0.4 * u),
            1.0 * b * tw, lerp(0.68, 0.25, u) * b * tw, lerp(0.25, 0.05, u) * b * tw);
    }
    // 萤火虫:黄绿,缓慢游走 + 明灭;白天淡出(计数不变)
    const nightVis = 1 - smooth01((e - 0.35) / 0.3);
    for (const p of flies) {
        const drift = t * 0.3;
        const cx = Math.cos(p.ang + drift * p.fx) * p.rad + Math.sin(t * p.fx + p.phx) * p.amp;
        const cz = Math.sin(p.ang + drift * p.fy) * p.rad + Math.cos(t * p.fy + p.phy) * p.amp;
        const cy = p.h + Math.sin(t * (p.fx + 0.11) + p.phy) * 0.55;
        let b = Math.sin(t * p.blf * Math.PI * 2 + p.phb);
        b = Math.pow(Math.max(b, 0), 2.6); // 明灭(灭段全暗)
        const I = b * (0.85 + 0.45 * fi) * nightVis;
        vi = writeQuad(vi, cx, cy, cz, rx, ry, rz, ux, uy, uz, p.size * 1.3, 0.55 * I, 1.0 * I, 0.28 * I);
    }
    // 烟:低亮度暖灰,上升扩散
    for (const p of smokes) {
        const u = p.age / p.life;
        const b = 0.05 * smooth01(u / 0.2) * (1 - smooth01((u - 0.6) / 0.4)) * (1 - 0.45 * e);
        vi = writeQuad(vi, p.x, p.y, p.z, rx, ry, rz, ux, uy, uz, p.size0 + u * 0.85,
            0.55 * b, 0.55 * b, 0.62 * b);
    }
    // 余下顶点清零(防御,理论上无)
    while (vi < TOTAL_QUADS * 6) {
        const o = vi * 3;
        partPos[o] = partPos[o + 1] = partPos[o + 2] = 0;
        const o2 = vi * 2;
        partUV[o2] = partUV[o2 + 1] = 0;
        const o4 = vi * 4;
        partCol[o4] = partCol[o4 + 1] = partCol[o4 + 2] = partCol[o4 + 3] = 0;
        vi++;
    }
}

// ============================================================ 模拟驱动组件 ===============

let sim = null;
const scratchVec = new Vec3();
const scratchQuat = new Quat(0, 0, 0, 1);
const scratchColor = new Color(0, 0, 0, 255);

class Sim extends Component {
    lastE = -1;

    update(dt) {
        const d = Math.min(dt, 0.1); // 失焦回归防时间跳变

        // ---- 日夜推进(线性 3.2s;视觉 smoothstep 映射) ----
        const rate = 1 / CFG.dayDuration;
        const dd = state.dayTarget - state.timeOfDay;
        if (dd !== 0) {
            state.timeOfDay += clamp(dd, -rate * d, rate * d);
            if (Math.abs(state.dayTarget - state.timeOfDay) < 1e-6) {
                state.timeOfDay = state.dayTarget;
            }
            syncUi();
        }
        const e = smooth01(state.timeOfDay);
        const dayDim = 0.42 * e; // 白天火苗/光晕压制(仍可见)

        // ---- 火光闪烁(多频混合 ~0.43/1.9/4.6 Hz,幅度 ≥ 0.08 合同) ----
        state.fireTime += d;
        const ft = state.fireTime;
        const flick =
            0.062 * Math.sin(ft * 2.7 + 0.7) +
            0.047 * Math.sin(ft * 11.9 + 2.1) +
            0.030 * Math.sin(ft * 28.9 + 4.4) +
            0.018 * Math.sin(ft * 5.3 + 1.3);
        state.fireLightIntensity = clamp(CFG.fireBase + flick, 0, 1);
        const fi = state.fireLightIntensity;

        // 点光真实照明(luminance 逐帧驱动;位置微抖)
        this.fireLight.luminance = fi * CFG.fireLumMax;
        this.fireLightNode.setPosition(
            0.04 * Math.sin(ft * 9.3),
            1.05 + 0.07 * Math.sin(ft * 6.1 + 1.0),
            0.04 * Math.cos(ft * 7.7),
        );

        // 火苗/光晕 uniform 同源驱动(画面与状态同一来源)
        this.flameMat1.setProperty('flameI', fi);
        this.flameMat1.setProperty('dayDim', dayDim);
        this.flameMat2.setProperty('flameI', fi);
        this.flameMat2.setProperty('dayDim', dayDim);
        this.glowMat.setProperty('glowI', 0.45 + 0.5 * fi);
        this.glowMat.setProperty('dayDim', dayDim);

        // ---- 环境联动(仅 e 变化时更新:天穹/环境光/主光/clearColor) ----
        if (Math.abs(e - this.lastE) > 1e-5) {
            this.lastE = e;
            this.skyMat.setProperty('dayF', e);
            const amb = this.scene.globals.ambient;
            amb.skyColorHDR.set(lerp(0.16, 0.62, e), lerp(0.20, 0.74, e), lerp(0.34, 0.95, e), 1.0);
            amb.skyIllum = lerp(3800, 23000, e);
            this.dirLight.illuminance = lerp(1900, 50000, e);
            scratchColor.set(
                Math.round(lerp(150, 255, e)),
                Math.round(lerp(172, 250, e)),
                Math.round(lerp(238, 235, e)),
                255,
            );
            this.dirLight.color = scratchColor; // setter 克隆并下推渲染光
            scratchColor.set(
                Math.round(lerp(7, 118, e)),
                Math.round(lerp(11, 168, e)),
                Math.round(lerp(26, 224, e)),
                255,
            );
            this.camera.clearColor = scratchColor; // setter 内部 set + 下推渲染相机
        }

        // ---- 环绕相机 ----
        if (state.orbitEnabled) {
            state.orbitAngle += CFG.orbitSpeed * d;
        }
        const elev = clamp(CFG.elevBase + state.elevOffset, 0.14, 0.82);
        const ca = Math.cos(state.orbitAngle);
        const sa = Math.sin(state.orbitAngle);
        const R = CFG.orbitRadius;
        const H = Math.tan(elev) * R;
        this.camNode.setPosition(scratchVec.set(sa * R, H, ca * R));
        this.camNode.lookAt(scratchVec.set(0, CFG.lookAtY, 0));

        // ---- billboard 朝向相机(火苗/光晕) ----
        const q = this.camNode.rotation;
        this.flameBB1.setRotation(q);
        this.flameBB2.setRotation(q);
        this.glowBB.setRotation(q);

        // ---- 粒子模拟 + 动态网格 ----
        this.stepParticles(d);
        const r = this.camNode.right;
        const u = this.camNode.up;
        writeParticles([r.x, r.y, r.z], [u.x, u.y, u.z], e, fi);
        this.partMesh.updateSubMesh(0, {
            positions: partPos,
            uvs: partUV,
            colors: partCol,
            minPos: PMIN,
            maxPos: PMAX,
        });
    }

    stepParticles(d) {
        aliveCounters.licks = 0;
        aliveCounters.sparks = 0;
        for (let i = 0; i < licks.length; i++) {
            const p = licks[i];
            p.age += d;
            if (p.age >= p.life) {
                spawnLick(mulberry32((0x6c1c0 ^ (i * 7919)) + Math.floor(p.age * 997)), p);
            }
            p.y += p.vy * d;
            p.vy += 0.28 * d;
            p.x *= 1 - 1.6 * d; // 向火焰轴心收拢
            p.z *= 1 - 1.6 * d;
            aliveCounters.licks++;
        }
        for (let i = 0; i < sparks.length; i++) {
            const p = sparks[i];
            p.age += d;
            if (p.age >= p.life) {
                spawnSpark(mulberry32((0x5ea7a ^ (i * 7919)) + Math.floor(p.age * 997)), p);
            }
            p.vy -= 0.14 * d;
            p.x += (p.vx + 0.22 * Math.sin(p.age * 6.5 + p.seed)) * d;
            p.z += (p.vz + 0.22 * Math.cos(p.age * 5.1 + p.seed)) * d;
            p.y += p.vy * d;
            aliveCounters.sparks++;
        }
        for (let i = 0; i < smokes.length; i++) {
            const p = smokes[i];
            p.age += d;
            if (p.age >= p.life) {
                spawnSmoke(mulberry32((0x5007e ^ (i * 7919)) + Math.floor(p.age * 997)), p);
            }
            p.y += p.vy * d;
            p.x += (0.18 + 0.1 * Math.sin(p.age * 1.3 + p.seed)) * d;
            p.z += 0.08 * Math.cos(p.age * 0.9 + p.seed) * d;
        }
        // 萤火虫为连续漂移(位置在 writeParticles 即时计算),无生命周期
    }
}

// ============================================================ 启动 ========================

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    const ATTR_P = [{ name: 'a_position', defines: [], format: 32, location: 0 }];

    // ---- effect 注册(引擎引导后) ----------------------------------------------------
    const skyEff = registerEffect(
        makeEffectJson({
            name: 'e06-sky',
            prog: 'e06-sky|sky-vs:vert|sky-fs:frag',
            hash: 601601,
            attributes: ATTR_P,
            members: [{ name: 'dayF', type: 13, count: 1 }],
            properties: { dayF: { value: [0], type: 13 } },
            depthTest: true,
            depthWrite: false,
            blend: false,
            priority: 0,
        }),
        vertSky(),
        { glsl4: SKY_FRAG4, glsl3: toGlsl3(SKY_FRAG4) },
    );

    const mkFlameEff = (name, hash, phase) =>
        registerEffect(
            makeEffectJson({
                name,
                prog: `${name}|fl-vs:vert|fl-fs:frag`,
                hash,
                attributes: ATTR_P,
                members: [
                    { name: 'flameI', type: 13, count: 1 },
                    { name: 'phase', type: 13, count: 1 },
                    { name: 'dayDim', type: 13, count: 1 },
                ],
                properties: {
                    flameI: { value: [CFG.fireBase], type: 13 },
                    phase: { value: [phase], type: 13 },
                    dayDim: { value: [0], type: 13 },
                },
                depthTest: true,
                depthWrite: false,
                blend: true,
                blendSrc: 1,
                blendDst: 1,
                priority: 130,
            }),
            vertQuad(),
            { glsl4: FLAME_FRAG4, glsl3: toGlsl3(FLAME_FRAG4) },
        );
    const flameEff1 = mkFlameEff('e06-flame-a', 601602, 0);
    const flameEff2 = mkFlameEff('e06-flame-b', 601603, 2.7);

    const glowEff = registerEffect(
        makeEffectJson({
            name: 'e06-glow',
            prog: 'e06-glow|gl-vs:vert|gl-fs:frag',
            hash: 601604,
            attributes: ATTR_P,
            members: [
                { name: 'glowI', type: 13, count: 1 },
                { name: 'dayDim', type: 13, count: 1 },
            ],
            properties: {
                glowI: { value: [0.8], type: 13 },
                dayDim: { value: [0], type: 13 },
            },
            depthTest: true,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
            priority: 140,
        }),
        vertQuad(),
        { glsl4: GLOW_FRAG4, glsl3: toGlsl3(GLOW_FRAG4) },
    );

    const partEff = registerEffect(
        makeEffectJson({
            name: 'e06-particles',
            prog: 'e06-particles|pt-vs:vert|pt-fs:frag',
            hash: 601605,
            attributes: [
                { name: 'a_position', defines: [], format: 32, location: 0 },
                { name: 'a_texCoord', defines: [], format: 21, location: 1 },
                { name: 'a_color', defines: [], format: 44, location: 2 },
            ],
            depthTest: true,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
            priority: 150,
        }),
        vertParticle(),
        { glsl4: PART_FRAG4, glsl3: toGlsl3(PART_FRAG4) },
    );

    // ---- 场景 ------------------------------------------------------------------------
    const scene = new Scene('e06-campfire');

    const camNode = new Node('Main Camera');
    scene.addChild(camNode);
    camNode.setPosition(
        new Vec3(0, Math.tan(CFG.elevBase) * CFG.orbitRadius, CFG.orbitRadius),
    );
    camNode.lookAt(new Vec3(0, CFG.lookAtY, 0));
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CFG.fov;
    camera.near = 0.1;
    camera.far = 700;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(7, 11, 26, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // ---- 主方向光(月光 ⇄ 日光,日夜插值;单一主光) ----
    const dirLightNode = new Node('MainLight');
    scene.addChild(dirLightNode);
    dirLightNode.setPosition(new Vec3(14, 20, -10));
    dirLightNode.setRotationFromEuler(-52, -38, 0);
    const dirLight = dirLightNode.addComponent(DirectionalLight);
    dirLight.illuminance = 1900; // 夜(月光量级;日插值到 50000)
    dirLight.color = new Color(150, 172, 238, 255);

    const mkNode = (name) => {
        const n = new Node(name);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        return n;
    };

    /** builtin-standard 受光材质(被点光/环境光/主光真实照亮)。 */
    function matStd(r, g, b) {
        const m = new Material();
        m.initialize({ effectName: 'builtin-standard' });
        m.setProperty('mainColor', new Color(r, g, b, 255));
        return m;
    }

    // ---- 天穹(大球内面,cull off;渐变+星点+银河+月/日) ----
    let skyMat = null;
    {
        const node = mkNode('Sky');
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.sphere(300, { segments: 24 }));
        skyMat = new Material();
        skyMat.initialize({ effectAsset: skyEff });
        mr.setSharedMaterial(skyMat, 0);
    }

    // ---- 地面(低多边形起伏圆盘)+ 焦土 ----
    {
        const node = mkNode('Ground');
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(buildGroundGeometry());
        mr.material = matStd(56, 86, 46);

        const sc = mkNode('Scorched');
        sc.setPosition(new Vec3(0, 0.02, 0));
        const smr = sc.addComponent(MeshRenderer);
        smr.mesh = utils.createMesh(buildDiscGeometry(1.5, 14));
        smr.material = matStd(74, 56, 40);
    }

    // ---- 树环(16 棵:7 棱柱树干 + 双层 7 棱锥树冠) ----
    {
        const rndT = mulberry32(0x7ee06);
        const trunkMats = [matStd(78, 55, 36), matStd(66, 46, 30)];
        const canopyMats = [
            matStd(36, 96, 58),
            matStd(46, 114, 66),
            matStd(30, 82, 54),
            matStd(58, 122, 72),
            matStd(40, 100, 78),
        ];
        const trunkGeo = primitives.cylinder(0.09, 0.14, 1, { radialSegments: 7, heightSegments: 1 });
        const coneGeo = primitives.cone(0.5, 1, { radialSegments: 7, heightSegments: 1 });
        for (let i = 0; i < CFG.treeCount; i++) {
            const ang = (i / CFG.treeCount) * Math.PI * 2 + (rndT() - 0.5) * 0.34;
            const rad = 6.4 + rndT() * 3.2; // 上限 ~9.6:与环绕相机轨道(12.8)保持距离,避免近景巨树挡画面
            const scale = 0.8 + rndT() * 0.75;
            const bx = Math.cos(ang) * rad;
            const bz = Math.sin(ang) * rad;
            const by = terrainHeight(rad, ang);
            const tree = mkNode(`Tree${i}`);
            tree.setPosition(new Vec3(bx, by, bz));
            tree.setRotationFromEuler(0, rndT() * 360, 0);

            const trunkH = (1.0 + rndT() * 0.5) * scale;
            const trunk = new Node('trunk');
            trunk.layer = Layers.Enum.DEFAULT;
            tree.addChild(trunk);
            trunk.setPosition(new Vec3(0, trunkH / 2, 0));
            trunk.setScale(new Vec3(scale, trunkH, scale));
            const tmr = trunk.addComponent(MeshRenderer);
            tmr.mesh = utils.createMesh(trunkGeo);
            tmr.material = trunkMats[i % 2];

            const c1h = (1.9 + rndT() * 0.9) * scale;
            const c1r = (0.95 + rndT() * 0.35) * scale;
            const c1 = new Node('canopy1');
            c1.layer = Layers.Enum.DEFAULT;
            tree.addChild(c1);
            c1.setPosition(new Vec3(0, trunkH + c1h * 0.34, 0));
            c1.setScale(new Vec3(c1r, c1h, c1r));
            const c1mr = c1.addComponent(MeshRenderer);
            c1mr.mesh = utils.createMesh(coneGeo);
            c1mr.material = canopyMats[i % canopyMats.length];

            const c2 = new Node('canopy2');
            c2.layer = Layers.Enum.DEFAULT;
            tree.addChild(c2);
            c2.setPosition(new Vec3(0, trunkH + c1h * 0.72, 0));
            c2.setScale(new Vec3(c1r * 0.66, c1h * 0.62, c1r * 0.66));
            const c2mr = c2.addComponent(MeshRenderer);
            c2mr.mesh = utils.createMesh(coneGeo);
            c2mr.material = canopyMats[(i + 2) % canopyMats.length];
        }
    }

    // ---- 篝火:石圈 + 交叉柴堆 + 坐柴 ----
    {
        const rndS = mulberry32(0x57e0e);
        const stoneMats = [matStd(112, 116, 122), matStd(94, 97, 104), matStd(126, 124, 118)];
        const stoneGeo = primitives.box({ width: 1, height: 1, length: 1 });
        for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI * 2 + rndS() * 0.3;
            const r = 0.98 + rndS() * 0.14;
            const s = 0.15 + rndS() * 0.1;
            const stone = mkNode(`Stone${i}`);
            stone.setPosition(new Vec3(Math.cos(a) * r, s * 0.32, Math.sin(a) * r));
            stone.setScale(new Vec3(s * (1 + rndS() * 0.5), s * (0.7 + rndS() * 0.5), s));
            stone.setRotationFromEuler(rndS() * 20, rndS() * 360, rndS() * 20);
            const mr = stone.addComponent(MeshRenderer);
            mr.mesh = utils.createMesh(stoneGeo);
            mr.material = stoneMats[i % 3];
        }
        // 交叉柴(轴角四元数:绕切向轴倾斜 τ,顶端向中心聚拢)
        const logMat = matStd(96, 62, 36);
        const darkLogMat = matStd(70, 45, 26);
        const logGeo = primitives.cylinder(0.05, 0.065, 1, { radialSegments: 6, heightSegments: 1 });
        const tilt = 0.72; // rad ≈ 41°
        const logLen = 1.05;
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 + 0.4;
            const cosA = Math.cos(a);
            const sinA = Math.sin(a);
            const log = mkNode(`Log${i}`);
            // 轴方向 = +Y 绕切向轴 (−sinA,0,cosA) 旋 tilt(指向中心上方)
            const dx = -cosA * Math.sin(tilt);
            const dy = Math.cos(tilt);
            const dz = -sinA * Math.sin(tilt);
            // 底部放在石圈内侧,节点置于中点
            const baseR = 0.74;
            const bx = cosA * baseR;
            const bz = sinA * baseR;
            log.setPosition(new Vec3(bx + dx * logLen * 0.5, 0.07 + dy * logLen * 0.5, bz + dz * logLen * 0.5));
            Quat.fromAxisAngle(scratchQuat, scratchVec.set(-sinA, 0, cosA), tilt);
            log.setRotation(scratchQuat);
            log.setScale(new Vec3(1, logLen, 1));
            const mr = log.addComponent(MeshRenderer);
            mr.mesh = utils.createMesh(logGeo);
            mr.material = i % 2 ? darkLogMat : logMat;
        }
        // 两根坐柴(营地感)
        const seatGeo = primitives.cylinder(0.13, 0.15, 1, { radialSegments: 7, heightSegments: 1 });
        const seat1 = mkNode('Seat1');
        seat1.setPosition(new Vec3(2.0, 0.15, 1.35));
        seat1.setRotationFromEuler(90, 55, 0);
        seat1.setScale(new Vec3(1, 1.7, 1));
        const s1mr = seat1.addComponent(MeshRenderer);
        s1mr.mesh = utils.createMesh(seatGeo);
        s1mr.material = logMat;
        const seat2 = mkNode('Seat2');
        seat2.setPosition(new Vec3(-1.7, 0.15, 1.9));
        seat2.setRotationFromEuler(90, -70, 0);
        seat2.setScale(new Vec3(1, 1.5, 1));
        const s2mr = seat2.addComponent(MeshRenderer);
        s2mr.mesh = utils.createMesh(seatGeo);
        s2mr.material = darkLogMat;
    }

    // ---- 火苗 billboard(双层)+ 光晕 billboard ----
    let flameMat1 = null;
    let flameMat2 = null;
    let glowMat = null;
    let flameBB1 = null;
    let flameBB2 = null;
    let glowBB = null;

    function makeBillboard(name, eff, w, h) {
        const parent = mkNode(name);
        const child = new Node(name + '-quad');
        child.layer = Layers.Enum.DEFAULT;
        parent.addChild(child);
        const mr = child.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.quad());
        const m = new Material();
        m.initialize({ effectAsset: eff });
        mr.setSharedMaterial(m, 0);
        child.setScale(new Vec3(w, h, 1));
        return { parent, mat: m };
    }
    {
        const f1 = makeBillboard('FlameA', flameEff1, 1.3, 1.62);
        f1.parent.setPosition(new Vec3(0, 0.82, 0));
        flameBB1 = f1.parent;
        flameMat1 = f1.mat;

        const f2 = makeBillboard('FlameB', flameEff2, 0.72, 1.05);
        f2.parent.setPosition(new Vec3(0.05, 0.55, -0.04));
        flameBB2 = f2.parent;
        flameMat2 = f2.mat;

        const g = makeBillboard('Glow', glowEff, 4.4, 4.4);
        g.parent.setPosition(new Vec3(0, 0.75, 0));
        glowBB = g.parent;
        glowMat = g.mat;
    }

    // ---- 粒子(单动态网格) ----
    let partMesh = null;
    {
        seedParticles();
        writeParticles([1, 0, 0], [0, 1, 0], 0, CFG.fireBase);
        const node = mkNode('Particles');
        const mr = node.addComponent(MeshRenderer);
        const createDyn = utils.createDynamicMesh || (utils.MeshUtils && utils.MeshUtils.createDynamicMesh);
        partMesh = createDyn(
            0,
            {
                positions: partPos,
                uvs: partUV,
                colors: partCol,
                minPos: PMIN,
                maxPos: PMAX,
            },
            undefined,
            V_DYN_OPTS,
        );
        mr.mesh = partMesh;
        const m = new Material();
        m.initialize({ effectAsset: partEff });
        mr.setSharedMaterial(m, 0);
    }

    // ---- 动态火光(真实点光) ----
    const fireLightNode = mkNode('FireLight');
    fireLightNode.setPosition(new Vec3(0, 0.85, 0));
    const fireLight = fireLightNode.addComponent(PointLight);
    fireLight.range = CFG.fireRange;
    fireLight.color = new Color(255, 147, 45, 255);
    fireLight.luminance = CFG.fireBase * CFG.fireLumMax;

    // ---- 模拟驱动组件 ----
    const simNode = new Node('Sim');
    simNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(simNode);
    sim = simNode.addComponent(Sim);
    sim.camNode = camNode;
    sim.scene = scene;
    sim.camera = camera;
    sim.dirLight = dirLight;
    sim.fireLight = fireLight;
    sim.fireLightNode = fireLightNode;
    sim.flameMat1 = flameMat1;
    sim.flameMat2 = flameMat2;
    sim.glowMat = glowMat;
    sim.skyMat = skyMat;
    sim.flameBB1 = flameBB1;
    sim.flameBB2 = flameBB2;
    sim.glowBB = glowBB;
    sim.partMesh = partMesh;

    app.run(scene);

    // 环境光初始(夜):app.run 后经由 scene.globals 显式配置(E05 验证路径)
    scene.globals.ambient.skyColorHDR.set(0.16, 0.20, 0.34, 1.0);
    scene.globals.ambient.skyIllum = 3800;

    // 帧计数 + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    // 调试钩子(不改变行为)
    window.__e06 = { nodes: { camNode, fireLightNode }, state };

    console.log('[e06] wilderness campfire running on cocosair');
} catch (err) {
    console.error('[e06] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
