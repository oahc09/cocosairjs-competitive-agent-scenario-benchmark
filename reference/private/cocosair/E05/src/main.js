/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)· Cocos AIR Reference 实现
 *
 * 场景定位:探测 AIR 的 Shader 自由度 / Blend / 后处理受限下的辉光替代手段 / 视觉上限。
 *
 * 技术路线(全部程序化,无外部资产,自定义 GLSL 全链路):
 *   - 6 个用户自定义 effect(编译后 JSON + glsl4/glsl3 双变体 → EffectAsset.onLoaded 注册):
 *     1) 吸积盘:单 quad + 片元极坐标程序化着色(径向色梯度 内白→外暗红 / 差速旋转条纹 /
 *        多普勒不对称 / 边缘软衰减辉光),additive(ONE,ONE) 混合;
 *     2) 光子环+光环:billboard quad,高斯亮环 + 上弯亮弧(引力透镜观感近似)+ 宽晕,
 *        depthTest 关、最后绘制 → 包绕黑核的辉光;
 *     3) 黑洞核心:billboard 黑盘(事件视界),opaque 队列写深度 → 遮挡盘远侧与背后星点;
 *     4) 星流:utils.createDynamicMesh + mesh.updateSubMesh 每帧顶点更新,240 粒子
 *        螺旋轨迹 + 视界吞噬重生 + 近核加速拉长拖尾,单 draw call;
 *     5) 背景星空:360 星 billboard quad 合批为单静态 mesh,片元软圆形衰减 + cc_time 闪烁;
 *     6) 星云:远景大 quad,片元 value-noise fbm,极低亮度冷色渐变。
 *   - 后处理不可用(默认 Code First legacy 管线,无 Bloom):辉光 = 多层 additive
 *     billboard + shader 内高斯/指数衰减的"bloom impostor"近似(见 ceiling-notes)。
 *
 * 页面契约:window.__appReady(首帧后 true)/ window.__bench={getState,reset}。
 * 状态通道(真实数据):diskRotation / accretionPhase / cameraDistance /
 *   starStreamCount / backgroundStarCount(+engine/frame/ready/resetCount)。
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
    director,
    Director,
    input,
    Input,
} from 'cocosair.js';

// ============================================================ 常量与状态 ==================

const CFG = {
    diskOmega: 0.35, // rad/s ∈ [0.15, 0.6](spec)
    rIn: 1.8, // 吸积盘内缘
    rOut: 6.5, // 吸积盘外缘
    coreR: 1.05, // 事件视界(黑盘)半径
    ringR: 1.32, // 光子环半径
    camDist0: 14.0, // 初始相机距离
    camDistMin: 5.0,
    camDistMax: 28.0,
    fov: 60,
    elev0: (24 * Math.PI) / 180, // 俯仰(盘相对视线倾角)
    azim0: 0.0,
    streamCount: 240, // ≥ 200
    starCount: 360, // ≥ 300
    starSphereR: 92,
    exposure: 0.92,
};

const state = {
    frame: 0,
    resetCount: 0,
    diskTime: 0, // 累计旋转弧度(= diskRotation 源)
    camDist: CFG.camDist0,
    camDistTarget: CFG.camDist0,
    elev: CFG.elev0,
    azim: CFG.azim0,
    elevTarget: CFG.elev0,
    azimTarget: CFG.azim0,
    ready: false,
};

window.__appReady = false;

function doReset() {
    state.resetCount += 1;
    state.diskTime = 0;
    state.camDist = CFG.camDist0;
    state.camDistTarget = CFG.camDist0;
    state.elev = CFG.elev0;
    state.azim = CFG.azim0;
    state.elevTarget = CFG.elev0;
    state.azimTarget = CFG.azim0;
    resetStream(); // 星流粒子按同一种子复位重生
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
        resetCount: state.resetCount,
        diskRotation: state.diskTime,
        accretionPhase: ((state.diskTime / (Math.PI * 2)) % 1 + 1) % 1,
        cameraDistance: state.camDist,
        starStreamCount: CFG.streamCount,
        backgroundStarCount: CFG.starCount,
    }),
    reset: doReset,
};

// ---- UI 覆盖层(DOM):reset 按钮(右上角)+ 操作提示(纯展示) ----------------------------
{
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:10px;right:12px;z-index:9999;padding:5px 14px;' +
        "font:12px sans-serif;background:#181820;color:#dfe3ee;border:1px solid #4a5068;" +
        'border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);

    const hint = document.createElement('div');
    hint.textContent = '滚轮缩放 · 拖拽微调视角';
    hint.style.cssText =
        'position:fixed;left:12px;bottom:10px;z-index:9999;pointer-events:none;' +
        "font:11px sans-serif;color:rgba(190,200,225,0.55);letter-spacing:1px";
    document.body.appendChild(hint);
}

// ---- 输入:拖拽微调视角(可选加分,DOM pointer);滚轮在引擎引导后经 input API 注册 -----
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
        state.azimTarget = Math.max(-0.61, Math.min(0.61, state.azimTarget - dx * 0.003));
        state.elevTarget = Math.max(0.24, Math.min(0.96, state.elevTarget + dy * 0.003));
    });
    const endDrag = () => {
        dragging = false;
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
}

// ============================================================ 工具 ========================

/** 确定性 PRNG(mulberry32):星流/星空复位后与初始状态一致。 */
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

// ============================================================ GLSL 变体与 effect 骨架 =====

// 与引擎同源的 UBO 块声明(src/air/builtin/builtin-glsl4.ts 布局;CCGlobal 已剔除 4.0 移除成员)。
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

/** 通用顶点(仅 a_position → v_p 局部 XZ)。注意:primitives.plane 位于 XZ 平面(y=0),
 *  极坐标/billboard 计算取 (x,z) 分量。 */
function vertLocalOnly(extra) {
    const body4 = `in vec3 a_position;
out highp vec2 v_p;
${extra || ''}
void main () {
  v_p = a_position.xz;
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`;
    return {
        glsl4: 'precision highp float;\n' + UB_CAM4 + '\n' + UB_LOC4 + '\n' + body4,
        glsl3:
            'precision highp float;\n' +
            toGlsl3(UB_CAM4) +
            '\n' +
            toGlsl3(UB_LOC4) +
            '\n' +
            body4,
    };
}

/** 星空/星流顶点(a_position + a_texCoord? + a_color)。 */
function vertColored(withUv, withSeedHash) {
    const body4 = `in vec3 a_position;
${withUv ? 'in mediump vec2 a_texCoord;\nout mediump vec2 v_uv;' : ''}
in vec4 a_color;
out mediump vec4 v_color;
${withSeedHash ? 'out mediump float v_seed;' : ''}
void main () {
  ${withUv ? 'v_uv = a_texCoord;' : ''}
  v_color = a_color;
  ${
      withSeedHash
          ? 'v_seed = fract(sin(dot(a_position.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);'
          : ''
  }
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`;
    const head4 = 'precision highp float;\n' + UB_CAM4 + '\n' + UB_LOC4 + '\n';
    return {
        glsl4: head4 + body4,
        glsl3: 'precision highp float;\n' + toGlsl3(UB_CAM4) + '\n' + toGlsl3(UB_LOC4) + '\n' + body4,
    };
}

/**
 * 编译后形态 effect JSON(同 examples/shared/shader-blocks.makeUserEffectJson,本文件内联以
 * 支持 per-effect attributes 与 pass 状态)。
 */
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
                                    blendSrc: opts.blendSrc !== undefined ? opts.blendSrc : 1, // ONE(纯加法,色值即贡献)
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

/** 注册(时机纪律:必须在 createAirApp 之后,GAP-B1)。 */
function registerEffect(json, vert, frag) {
    const eff = Object.assign(new EffectAsset(), json);
    eff.shaders[0].glsl4 = { vert: vert.glsl4, frag: frag.glsl4 };
    eff.shaders[0].glsl3 = { vert: vert.glsl3, frag: frag.glsl3 };
    eff.onLoaded();
    return eff;
}

// ============================================================ 各 effect 片元 GLSL =========

// ---- 1) 吸积盘:径向色梯度 + 差速旋转条纹 + 多普勒 + 软边辉光 --------------------------------
const DISK_FRAG4 = `precision highp float;
layout(set = 1, binding = 0) uniform Constants {
  highp float phase;    // = getState().diskRotation(真实状态驱动画面;无限累加,须 highp)
  highp float exposure;
};
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float r = length(v_p);
  float th = atan(v_p.y, v_p.x);
  float t = (r - 1.8) / (6.5 - 1.8);            // 0=内缘 1=外缘(负值=内隙)

  // 径向亮度包络:内缘软升 + 外缘幂衰减
  float inEdge  = smoothstep(-0.05, 0.16, t);
  float outFade = pow(clamp(1.0 - t, 0.0, 1.0), 1.35);
  float body = inEdge * outFade;

  // 边缘外溢辉光(bloom 近似的一部分):向内被事件视界截断(视界内无辐射),向外指数衰减
  float glow = 0.20 * exp(-abs(t) * 6.5) * smoothstep(-0.34, -0.10, t)
             + 0.15 * exp(-max(t - 1.0, 0.0) * 4.5);

  // 旋转条纹:5 臂 + 半径扭曲螺旋 + 慢速调制;相位 = phase(状态驱动,内缘差速更快)
  float lag = 1.25 - 0.25 * clamp(t, 0.0, 1.0);
  float sw = 5.0 * th + 9.0 * t - phase * lag;
  float stripes = 0.60 + 0.40 * sin(sw);
  stripes *= 0.78 + 0.22 * sin(sw * 0.43 + 1.7);
  stripes *= 0.92 + 0.08 * sin(th * 23.0 - phase * 1.5 + t * 31.0);

  // 多普勒不对称:接近侧增亮
  float dop = 1.0 + 0.52 * sin(th + 2.3);

  // 内缘热点微脉动(活性)
  float pulse = 1.0 + 0.05 * sin(phase * 7.0 + th * 2.0);

  float I = (body * stripes * dop * pulse) + glow * (0.75 + 0.25 * dop);

  // 径向色梯度:内白(微蓝)→ 亮黄橙 → 橙红 → 外缘暗红
  vec3 col = mix(vec3(1.00, 0.97, 0.90), vec3(1.00, 0.80, 0.42), smoothstep(0.02, 0.42, t));
  col = mix(col, vec3(0.88, 0.32, 0.10), smoothstep(0.38, 0.78, t));
  col = mix(col, vec3(0.42, 0.08, 0.035), smoothstep(0.75, 1.05, t));
  col = mix(vec3(0.93, 0.96, 1.00), col, smoothstep(-0.02, 0.22, t));

  cc_FragColor = vec4(col * I * exposure, 1.0);
}`;

// ---- 2) 光子环 + 光环(引力透镜观感近似):高斯亮环 + 上弯亮弧 + 宽晕 + 核心微光 --------------
const RING_FRAG4 = `precision highp float;
layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float r = length(v_p);
  float ang = atan(v_p.y, v_p.x);

  float ring = exp(-pow((r - 1.32) / 0.085, 2.0));           // 光子环(细亮)
  float arc  = 0.55 + 0.45 * smoothstep(-0.6, 1.0, sin(ang)); // 上弯弧更亮(透镜远侧)
  float halo = 0.26 * exp(-pow((r - 1.55) / 0.80, 2.0));      // 宽晕
  float core = 0.035 * exp(-pow(r / 1.1, 2.0)) * smoothstep(0.30, 0.80, r); // 核心向内微光(视界内截断)

  float shimmer = 0.93 + 0.07 * sin(cc_time.x * 2.6 + ang * 2.0);
  vec3 ringCol = mix(vec3(1.00, 0.86, 0.58), vec3(1.00, 0.98, 0.96), 0.30 + 0.45 * (0.5 + 0.5 * sin(ang)));
  vec3 I = ringCol * (ring * arc * shimmer * 1.35)
         + vec3(1.00, 0.58, 0.26) * halo
         + vec3(0.65, 0.72, 1.00) * core;
  cc_FragColor = vec4(I * 0.92, 1.0);
}`;

// ---- 3) 黑洞核心:纯黑圆盘(事件视界),discard 圆形化 ----------------------------------------
const CORE_FRAG4 = `precision highp float;
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  if (length(v_p) > 1.0) { discard; }
  cc_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`;

// ---- 4) 星流:顶点色直出(additive,色值即贡献,亮度含头尾渐变) -------------------------------
const STREAM_FRAG4 = `precision highp float;
in mediump vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  cc_FragColor = vec4(v_color.rgb, 1.0);
}`;

// ---- 5) 背景星空:软圆星点 + cc_time 闪烁 ---------------------------------------------------
const STAR_FRAG4 = `precision highp float;
layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};
in mediump vec2 v_uv;      // quad 局部坐标 [-1,1]
in mediump vec4 v_color;   // rgb=亮度(>1 允许), a=柔度
in mediump float v_seed;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d2 = dot(v_uv, v_uv);
  float d = sqrt(d2);
  float core = exp(-d2 * 4.5);
  float halo = 0.22 * exp(-d2 * 1.1);
  // 圆形软边界:quad 边缘(d→1)贡献归零,避免方形剪影
  float mask = 1.0 - smoothstep(0.62, 0.98, d);
  float tw = 0.80 + 0.20 * sin(cc_time.x * (1.0 + v_seed * 2.5) + v_seed * 40.0);
  float I = (core + halo * v_color.a) * tw * mask;
  cc_FragColor = vec4(v_color.rgb * I, 1.0);
}`;

// ---- 6) 星云:程序化 value-noise fbm,冷色低亮度 ---------------------------------------------
const NEB_FRAG4 = `precision highp float;
layout(set = 0, binding = 0) uniform CCGlobal {
  highp   vec4 cc_time;
  mediump vec4 cc_screenSize;
  mediump vec4 cc_nativeSize;
  mediump vec4 cc_debug_view_mode;
};
in highp vec2 v_p;
layout(location = 0) out vec4 cc_FragColor;
float hash21 (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise (vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm (vec2 p) {
  float v = 0.0; float a = 0.55;
  for (int k = 0; k < 4; k++) { v += a * vnoise(p); p = p * 2.03 + vec2(19.7, 7.3); a *= 0.5; }
  return v;
}
void main () {
  vec2 q = v_p * 0.021;
  float n1 = fbm(q);
  float n2 = fbm(q * 2.6 + vec2(4.7, 9.2));
  float m = 0.60 + 0.40 * smoothstep(0.30, 0.85, n1 * 0.72 + n2 * 0.38);
  float edge = 0.55 + 0.45 * smoothstep(28.0, 95.0, length(v_p)); // 边缘(四角)增强,中心保持深空
  vec3 cool = mix(vec3(0.125, 0.150, 0.275), vec3(0.240, 0.165, 0.340), n2);
  float warm = 0.10 * smoothstep(0.70, 0.98, n2) * smoothstep(0.50, 0.95, n1) * edge;
  vec3 I = cool * m * edge + vec3(0.85, 0.45, 0.22) * warm;
  // 抖动去色带(暗部平滑渐变,8bit 量化掩饰)
  I += (hash21(v_p * 7.13 + fract(cc_time.x) * 3.7) - 0.5) * 0.008;
  cc_FragColor = vec4(I, 1.0);
}`;

// ============================================================ 几何构建 ====================

/** 背景星空:均匀分布星点 + 四角锚定星(保证角落可见性),合并为单静态 mesh。 */
function buildStarfieldGeometry(anchorDirs) {
    const rnd = mulberry32(0x5eed05);
    const n = CFG.starCount - anchorDirs.length;
    const positions = new Float32Array(CFG.starCount * 4 * 3);
    const uvs = new Float32Array(CFG.starCount * 4 * 2);
    const colors = new Float32Array(CFG.starCount * 4 * 4);
    const indices = [];
    const R = CFG.starSphereR;
    for (let i = 0; i < CFG.starCount; i++) {
        let dx, dy, dz, size, bright, soft, cR, cG, cB;
        if (i < n) {
            // 球面均匀方向 d
            const u = rnd() * 2 - 1;
            const phi = rnd() * Math.PI * 2;
            const s = Math.sqrt(Math.max(0, 1 - u * u));
            dx = s * Math.cos(phi);
            dy = u;
            dz = s * Math.sin(phi);
            size = 0.55 + rnd() * 1.3;
            bright = 0.5 + rnd() * 0.85;
            soft = 0.4 + rnd() * 0.6;
            cR = bright * (0.82 + rnd() * 0.18);
            cG = bright * (0.85 + rnd() * 0.15);
            cB = bright * (0.95 + rnd() * 0.25);
        } else {
            // 四角锚定星:方向由外部给定(初始视角四角区域),尺寸/亮度偏大
            const a = anchorDirs[i - n];
            dx = a[0]; dy = a[1]; dz = a[2];
            size = 1.1 + rnd() * 0.9;
            bright = 0.9 + rnd() * 0.5;
            soft = 0.6 + rnd() * 0.4;
            cR = bright * (0.85 + rnd() * 0.15);
            cG = bright * (0.88 + rnd() * 0.12);
            cB = bright * (1.0 + rnd() * 0.2);
        }
        // 切平面正交基:right = normalize(d × (0,1,0)) = (-dz, 0, dx),up = right × d
        let rx = -dz; const ry = 0; let rz = dx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; rz /= rl;
        const ux = ry * dz - rz * dy;
        const uy = rz * dx - rx * dz;
        const uz = rx * dy - ry * dx;
        const px = dx * R, py = dy * R, pz = dz * R;
        const corners = [
            [-1, 1], [1, 1], [1, -1], [-1, -1],
        ];
        for (let c = 0; c < 4; c++) {
            const cu = corners[c][0];
            const cv = corners[c][1];
            const o = (i * 4 + c) * 3;
            positions[o] = px + (rx * cu + ux * cv) * size;
            positions[o + 1] = py + (ry * cu + uy * cv) * size;
            positions[o + 2] = pz + (rz * cu + uz * cv) * size;
            const o2 = (i * 4 + c) * 2;
            uvs[o2] = cu;
            uvs[o2 + 1] = cv;
            const o4 = (i * 4 + c) * 4;
            colors[o4] = cR; colors[o4 + 1] = cG; colors[o4 + 2] = cB; colors[o4 + 3] = soft;
        }
        const b = i * 4;
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return {
        positions,
        uvs,
        colors,
        indices,
        minPos: new Vec3(-R - 2, -R - 2, -R - 2),
        maxPos: new Vec3(R + 2, R + 2, R + 2),
    };
}

// ============================================================ 星流模拟 ====================

const STREAM_N = CFG.streamCount;
const streamParts = [];
function resetStream() {
    streamParts.length = 0;
    for (let i = 0; i < STREAM_N; i++) {
        const rnd = mulberry32(0x51ea7 ^ (i * 7919));
        streamParts.push(makeParticle(rnd));
        streamParts[i].rnd = rnd;
    }
}
function makeParticle(rnd) {
    return {
        r: 6.4 + rnd() * 2.8,
        th: rnd() * Math.PI * 2,
        sp: 0.72 + rnd() * 0.62,
        wob: rnd() * Math.PI * 2,
        rnd: null,
    };
}
function stepStream(dt) {
    for (let i = 0; i < STREAM_N; i++) {
        const p = streamParts[i];
        const omega = (2.3 / Math.pow(p.r, 1.5)) * p.sp;
        const vr = (0.10 + 1.5 / (p.r * p.r)) * p.sp;
        p.th += omega * dt;
        p.r -= vr * dt;
        if (p.r < 1.30) {
            // 视界吞噬 → 外圈重生(总数恒定)
            const np = makeParticle(p.rnd);
            p.r = np.r; p.th = np.th; p.sp = np.sp; p.wob = np.wob;
        }
    }
}

// 每帧顶点写放(CPU → updateSubMesh)
const streamPos = new Float32Array(STREAM_N * 6 * 3);
const streamCol = new Float32Array(STREAM_N * 6 * 4);
const V_DYN_OPTS = { maxSubMeshes: 1, maxSubMeshVertices: STREAM_N * 6 + 8, maxSubMeshIndices: 8 };

function writeStreamVertices(camRight, camFwd) {
    for (let i = 0; i < STREAM_N; i++) {
        const p = streamParts[i];
        const ct = Math.cos(p.th), st = Math.sin(p.th);
        // 盘面为世界 XZ 平面:轨道在 XZ 内,y 为微小摆动
        const px = p.r * ct;
        const py = 0.05 * Math.sin(p.th * 3.0 + p.wob);
        const pz = p.r * st;
        // 速度方向(切向 + 内向)
        const omg = (2.3 / Math.pow(p.r, 1.5)) * p.sp;
        const vrr = 0.10 + 1.5 / (p.r * p.r);
        let tx = -st * omg * p.r - ct * vrr;
        let ty = 0.12 * Math.cos(p.th * 3.0 + p.wob);
        let tz = ct * omg * p.r - st * vrr;
        const tl0 = Math.hypot(tx, ty, tz) || 1;
        tx /= tl0; ty /= tl0; tz /= tl0;
        // 速度轴投影到与视线垂直的平面(避免速度指向相机时面片退化成扁平矩形)
        const fdot = tx * camFwd[0] + ty * camFwd[1] + tz * camFwd[2];
        tx -= camFwd[0] * fdot; ty -= camFwd[1] * fdot; tz -= camFwd[2] * fdot;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        // 速度拉伸长度:近核显著拉长(拖尾)
        const len = 0.13 + 1.15 * Math.pow(1.35 / p.r, 2.0);
        const wid = 0.045 + 0.028 * (1.35 / p.r);
        // 亮度:外圈淡、近核亮;近核色偏蓝白
        const b = 0.28 + 1.05 * Math.pow(1.6 / p.r, 1.35);
        const mixW = Math.min(1, Math.pow(2.2 / p.r, 1.2));
        const cr = (0.92 - 0.10 * mixW);
        const cg = (0.90 - 0.02 * mixW);
        const cb = (0.85 + 0.15 * mixW);
        // 头尾亮度渐变(头亮尾暗)
        const fades = [1.0, 0.85, 0.12, 0.22];

        const v0 = i * 18; // 6 verts × 3
        const c0 = i * 24; // 6 verts × 4
        const hL = len, tL = len * 0.8;
        const offs = [
            [hL, wid, 0], [hL, -wid, 1], [-tL, -wid, 2], [-tL, wid, 3],
        ];
        for (let k = 0; k < 4; k++) {
            const al = offs[k][0];
            const aw = offs[k][1];
            const o = v0 + k * 3;
            streamPos[o] = px + tx * al + camRight[0] * aw;
            streamPos[o + 1] = py + ty * al + camRight[1] * aw;
            streamPos[o + 2] = pz + tz * al + camRight[2] * aw;
            // 注:py 已含 y 分量(camRight[1] 为相机右向量 y 分量,通常近 0)
            const o4 = c0 + k * 4;
            const bb = b * fades[k];
            streamCol[o4] = cr * bb;
            streamCol[o4 + 1] = cg * bb;
            streamCol[o4 + 2] = cb * bb;
            streamCol[o4 + 3] = 1.0;
        }
        // 补 2 个顶点构成 2 个三角形:(0,1,2) + (0,2,3) → v4=v0, v5=v2
        for (let k = 0; k < 2; k++) {
            const src = k === 0 ? 0 : 2;
            const dst = 4 + k;
            for (let m = 0; m < 3; m++) streamPos[v0 + dst * 3 + m] = streamPos[v0 + src * 3 + m];
            for (let m = 0; m < 4; m++) streamCol[c0 + dst * 4 + m] = streamCol[c0 + src * 4 + m];
        }
    }
}

// ============================================================ 主装配 ======================

let sim = null;

class Sim extends Component {
    update(dt) {
        const d = Math.min(dt, 0.1); // 失焦回归防时间跳变
        // 状态推进
        state.diskTime += d * CFG.diskOmega;

        // 相机平滑(指数插值:1s 内基本到位,残差 <<10%)
        const k = 5.0;
        state.camDist += (state.camDistTarget - state.camDist) * (1 - Math.exp(-k * d));
        state.elev += (state.elevTarget - state.elev) * (1 - Math.exp(-k * d));
        state.azim += (state.azimTarget - state.azim) * (1 - Math.exp(-k * d));

        const ce = Math.cos(state.elev), se = Math.sin(state.elev);
        const ca = Math.cos(state.azim), sa = Math.sin(state.azim);
        this.camNode.setPosition(new Vec3(sa * ce * state.camDist, se * state.camDist, ca * ce * state.camDist));
        this.camNode.lookAt(new Vec3(0, 0, 0));

        // billboard 朝向相机(光子环/黑核);黑核沿视线向相机微移,避免与盘平面穿插闪烁
        const q = this.camNode.rotation;
        this.ringNode.setRotation(q);
        this.coreNode.setRotation(q);
        this.coreNode.setPosition(sa * ce * 0.07, se * 0.07, ca * ce * 0.07);

        // 盘相位 uniform(状态驱动画面)
        this.diskMat.setProperty('phase', state.diskTime);

        // 星流模拟 + 动态网格更新
        stepStream(d);
        // 相机右向量/视线方向(世界系;粒子面片朝向与速度拉伸轴投影)
        const r = this.camNode.right;
        const f = this.camNode.forward;
        writeStreamVertices([r.x, r.y, r.z], [f.x, f.y, f.z]);
        this.streamMesh.updateSubMesh(0, {
            positions: streamPos,
            colors: streamCol,
            minPos: new Vec3(-9.5, -9.5, -1),
            maxPos: new Vec3(9.5, 9.5, 1),
        });
    }
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    // 滚轮缩放:必须走引擎 input API(引擎 canvas wheel 监听会 stopPropagation,
    // window 级 DOM 监听收不到)。引擎约定 getScrollY = -DOM deltaY × 5(上游
    // EventMouse.setScrollData(wheelSensitivityFactor=5)),此处还原为 DOM 方向:
    // 负(向上滚)= 靠近放大 = 距离减小。
    input.on(Input.EventType.MOUSE_WHEEL, (event) => {
        const dy = -event.getScrollY() / 5;
        state.camDistTarget = Math.max(
            CFG.camDistMin,
            Math.min(CFG.camDistMax, state.camDistTarget + dy * 0.01),
        );
    });

    // ---- effect 注册(引擎引导后) ----------------------------------------------------
    const ATTR_P = [{ name: 'a_position', defines: [], format: 32, location: 0 }];

    const diskVert = vertLocalOnly();
    const diskEff = registerEffect(
        makeEffectJson({
            name: 'e05-disk',
            prog: 'e05-disk|disk-vs:vert|disk-fs:frag',
            hash: 501501,
            attributes: ATTR_P,
            members: [
                { name: 'phase', type: 13, count: 1 },
                { name: 'exposure', type: 13, count: 1 },
            ],
            properties: {
                phase: { value: [0], type: 13 },
                exposure: { value: [CFG.exposure], type: 13 },
            },
            depthTest: true,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
        }),
        diskVert,
        { glsl4: DISK_FRAG4, glsl3: toGlsl3(DISK_FRAG4) },
    );

    const ringEff = registerEffect(
        makeEffectJson({
            name: 'e05-ring',
            prog: 'e05-ring|ring-vs:vert|ring-fs:frag',
            hash: 501502,
            attributes: ATTR_P,
            depthTest: false,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
            priority: 200,
        }),
        vertLocalOnly(),
        { glsl4: RING_FRAG4, glsl3: toGlsl3(RING_FRAG4) },
    );

    const coreEff = registerEffect(
        makeEffectJson({
            name: 'e05-core',
            prog: 'e05-core|core-vs:vert|core-fs:frag',
            hash: 501503,
            attributes: ATTR_P,
            depthTest: true,
            depthWrite: true,
            blend: false,
        }),
        vertLocalOnly(),
        { glsl4: CORE_FRAG4, glsl3: toGlsl3(CORE_FRAG4) },
    );

    const streamEff = registerEffect(
        makeEffectJson({
            name: 'e05-stream',
            prog: 'e05-stream|stream-vs:vert|stream-fs:frag',
            hash: 501504,
            attributes: [
                { name: 'a_position', defines: [], format: 32, location: 0 },
                { name: 'a_color', defines: [], format: 44, location: 1 },
            ],
            depthTest: true,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
        }),
        vertColored(false, false),
        { glsl4: STREAM_FRAG4, glsl3: toGlsl3(STREAM_FRAG4) },
    );

    const starEff = registerEffect(
        makeEffectJson({
            name: 'e05-starfield',
            prog: 'e05-starfield|star-vs:vert|star-fs:frag',
            hash: 501505,
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
        }),
        vertColored(true, true),
        { glsl4: STAR_FRAG4, glsl3: toGlsl3(STAR_FRAG4) },
    );

    const nebEff = registerEffect(
        makeEffectJson({
            name: 'e05-nebula',
            prog: 'e05-nebula|neb-vs:vert|neb-fs:frag',
            hash: 501506,
            attributes: ATTR_P,
            depthTest: true,
            depthWrite: false,
            blend: true,
            blendSrc: 1,
            blendDst: 1,
        }),
        vertLocalOnly(),
        { glsl4: NEB_FRAG4, glsl3: toGlsl3(NEB_FRAG4) },
    );

    // ---- 场景 ------------------------------------------------------------------------
    const scene = new Scene('e05-blackhole');

    const camNode = new Node('Main Camera');
    scene.addChild(camNode);
    const ce = Math.cos(CFG.elev0), se = Math.sin(CFG.elev0);
    camNode.setPosition(new Vec3(0, se * CFG.camDist0, ce * CFG.camDist0));
    camNode.lookAt(new Vec3(0, 0, 0));
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = CFG.fov;
    camera.near = 0.1;
    camera.far = 400;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(0, 0, 0, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    const mkNode = (name) => {
        const n = new Node(name);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        return n;
    };

    /** billboard quad:primitives.plane 法线为 +Y,子节点绕 X +90° 使法线对齐父节点 +Z;
     *  父节点复制相机旋转后,quad 平面即正对相机(v_p 取子节点局部 xz,极坐标不受影响)。 */
    function makeBillboard(name, size, eff) {
        const parent = mkNode(name);
        const child = new Node(name + '-quad');
        child.layer = Layers.Enum.DEFAULT;
        child.setRotationFromEuler(90, 0, 0);
        parent.addChild(child);
        const mr = child.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.plane({ width: size, length: size, widthSegments: 1, lengthSegments: 1 }));
        const m = new Material();
        m.initialize({ effectAsset: eff });
        mr.setSharedMaterial(m, 0);
        return parent;
    }

    // 星云(远景 billboard,固定朝向初始视线;相机只沿该视线推拉)
    const nebNode = makeBillboard('Nebula', 220, nebEff);
    nebNode.setPosition(0, -se * 85, -ce * 85);
    nebNode.setRotation(camNode.rotation);

    // 背景星空(均匀星 + 初始视角四角锚定星)
    const starNode = mkNode('Starfield');
    {
        const anchors = [];
        {
            // 用初始相机基向量生成四角方向(NDC (±0.92, ±0.82) 附近,含随机抖动)
            const f = camNode.forward, r = camNode.right, u = camNode.up;
            const t = Math.tan(((CFG.fov * Math.PI) / 180) / 2);
            const asp = 1280 / 720;
            const arnd = mulberry32(0xc0ffee);
            for (const sx of [-1, 1]) {
                for (const sy of [-1, 1]) {
                    for (let k = 0; k < 5; k++) {
                        const nx = sx * (0.72 + arnd() * 0.2) * t * asp;
                        const ny = sy * (0.60 + arnd() * 0.22) * t;
                        let dx = f.x + r.x * nx + u.x * ny;
                        let dy = f.y + r.y * nx + u.y * ny;
                        let dz = f.z + r.z * nx + u.z * ny;
                        const dl = Math.hypot(dx, dy, dz) || 1;
                        anchors.push([dx / dl, dy / dl, dz / dl]);
                    }
                }
            }
        }
        const mr = starNode.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(buildStarfieldGeometry(anchors));
        const m = new Material();
        m.initialize({ effectAsset: starEff });
        mr.setSharedMaterial(m, 0);
    }

    // 吸积盘(世界 XZ 水平平面,极坐标程序化着色;相机俯仰 24° 观察)
    const diskNode = mkNode('Disk');
    let diskMat = null;
    {
        const mr = diskNode.addComponent(MeshRenderer);
        mr.mesh = utils.createMesh(primitives.plane({ width: 22, length: 22, widthSegments: 1, lengthSegments: 1 }));
        diskMat = new Material();
        diskMat.initialize({ effectAsset: diskEff });
        diskMat.setProperty('phase', 0);
        diskMat.setProperty('exposure', CFG.exposure);
        mr.setSharedMaterial(diskMat, 0);
    }

    // 星流(动态网格)
    const streamNode = mkNode('StarStream');
    let streamMesh = null;
    {
        resetStream();
        // 相机右向量/视线初始值
        const r0 = camNode.right;
        const f0 = camNode.forward;
        writeStreamVertices([r0.x, r0.y, r0.z], [f0.x, f0.y, f0.z]);
        const mr = streamNode.addComponent(MeshRenderer);
        // tarball 导出形态:createDynamicMesh 挂在 utils.MeshUtils(不直接在 utils 上)
        const createDyn = utils.createDynamicMesh || utils.MeshUtils.createDynamicMesh;
        streamMesh = createDyn(
            0,
            {
                positions: streamPos,
                colors: streamCol,
                minPos: new Vec3(-9.5, -9.5, -1),
                maxPos: new Vec3(9.5, 9.5, 1),
            },
            undefined,
            V_DYN_OPTS,
        );
        mr.mesh = streamMesh;
        const m = new Material();
        m.initialize({ effectAsset: streamEff });
        mr.setSharedMaterial(m, 0);
    }

    // 黑洞核心(黑盘 billboard,opaque 写深度)与 光子环+光环(billboard,最后绘制)
    const coreNode = makeBillboard('Core', CFG.coreR * 2.06, coreEff);
    const ringNode = makeBillboard('Ring', 7.6, ringEff);

    // 模拟驱动组件(addChild 返回 void,需分步)
    const simNode = new Node('Sim');
    simNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(simNode);
    sim = simNode.addComponent(Sim);
    sim.camNode = camNode;
    sim.ringNode = ringNode;
    sim.coreNode = coreNode;
    sim.diskMat = diskMat;
    sim.streamMesh = streamMesh;

    app.run(scene);

    // 调试钩子(与 __airApp 同级的节点引用,不改变任何行为;隔离排查各层渲染用)
    window.__e05 = { nodes: { nebNode, starNode, diskNode, streamNode, coreNode, ringNode, camNode } };

    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[e05] black-hole accretion disk running on cocosair');
} catch (err) {
    console.error('[e05] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
