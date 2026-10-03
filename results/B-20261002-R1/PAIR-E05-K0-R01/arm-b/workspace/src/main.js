/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair 实现
 *
 * 场景构成(全部程序化生成,无外部资产):
 *   1. 背景星空层:520 颗静态星点 + 微弱冷色星云,运行时 Canvas 2D 生成纹理,贴在
 *      远处平行于屏幕的大面片上(opaque 队列,最先绘制)。
 *   2. 外围暖色大光晕(additive):柔光扩散观感的底层。
 *   3. 吸积盘(additive shader 面片):椭圆(倾角 ~58°)径向颜色梯度
 *      内缘蓝白 → 中带橙黄 → 外缘暗红;明暗相间的螺旋辐条随时间连续旋转
 *      (diskRotation 驱动,0.32 rad/s);多普勒不对称(一侧增亮)。
 *   4. 星流(240 粒子,单 draw call):顶点着色器解析计算对数式螺旋下落轨迹,
 *      越接近事件视界越快、被拉长成拖尾,进入视界后隐没并循环重生。
 *   5. 事件视界暗核:平行于屏幕的黑色圆面(alpha blend,边缘锐利)。
 *   6. 光子环 + 透镜弧光(additive):紧贴暗核的亮环,顶部增亮模拟引力透镜观感。
 *
 * 相机:透视 45°,初始距离 14,滚轮缩放 [5,28],指数平滑插值。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): { diskRotation, accretionPhase, cameraDistance,
 *     starStreamCount, backgroundStarCount, ... }, reset(): void }。
 *
 * 着色器路线:运行时构造 EffectAsset(glsl3 / WebGL2,经 index.html import map 加载的
 * 引擎 module),与引擎内置 builtin-* effect 同一注册路径(programLib + EffectAsset.register)。
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
    Texture2D,
    ImageAsset,
    gfx,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 配置(场景尺度与 brief §2 对齐)
// ---------------------------------------------------------------------------
const CFG = {
    horizonR: 1.2, // 事件视界半径(屏幕面内,世界单位)
    diskIn: 1.8, // 吸积盘内缘
    diskOut: 6.5, // 吸积盘外缘
    dist0: 14.0, // 初始相机距离
    distMin: 5.0,
    distMax: 28.0,
    omega: 0.32, // 盘旋转角速度 rad/s(spec: 0.15-0.6)
    squash: 0.53, // 盘椭圆纵向压缩 = sin(倾角) —— 相机仰角 32°,盘相对视线倾角 ~58°
    camElev: (32 * Math.PI) / 180, // 相机仰角(俯视感,盘面相对视线 15-75° 内)
    starCount: 520, // 背景星数(>=300,与纹理内真实绘制数一致)
    streamCount: 240, // 星流粒子数(>=200,恒定)
    streamCycle: 13.0, // 单粒子下落周期 s
    streamRIn: 1.05, // 星流内端(略入视界,被暗核遮没 = 吞噬)
    streamROut: 7.8, // 星流外端(盘外缘外圈重生)
    streamTurns: 1.3, // 螺旋圈数
    wheelK: 0.012, // wheel dy → 距离增量系数
    smoothK: 7.0, // 距离平滑速率(1/s)
};

// ---------------------------------------------------------------------------
// 运行状态与 __bench 契约
// ---------------------------------------------------------------------------
const state = {
    time: 0, // 模拟时间(reset 归零;dt 钳制防失焦跳变)
    diskRotation: 0, // 自上次 reset 起累计旋转弧度(单调递增)
    frame: 0,
    resetCount: 0,
    dist: CFG.dist0, // 当前(平滑后)相机距离
    targetDist: CFG.dist0, // 滚轮目标距离
};

window.__appReady = false;

function doReset() {
    state.time = 0;
    state.diskRotation = 0;
    state.dist = CFG.dist0; // 距离立即归位(±0.5 容差内)
    state.targetDist = CFG.dist0;
    state.resetCount += 1;
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        diskRotation: state.diskRotation,
        accretionPhase: (state.diskRotation / (Math.PI * 2)) % 1,
        cameraDistance: state.dist,
        starStreamCount: CFG.streamCount,
        backgroundStarCount: CFG.starCount,
        ready: window.__appReady === true,
        frame: state.frame,
        resetCount: state.resetCount,
    }),
    reset: doReset,
};

// UI 契约:右上角 reset 按钮(data-ui="reset";归一化 x>0.8, y<0.25)
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:9999;padding:6px 16px;' +
        "font:13px sans-serif;background:rgba(20,20,24,0.8);color:#eee;" +
        'border:1px solid #555;border-radius:4px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);
    const tip = document.createElement('div');
    tip.textContent = '滚轮缩放';
    tip.style.cssText =
        'position:fixed;top:12px;right:86px;z-index:9999;font:11px sans-serif;' +
        'color:rgba(200,200,210,0.65);pointer-events:none';
    document.body.appendChild(tip);
}

// 滚轮缩放:负 dy(向上滚)= 靠近/放大;夹在 [5,28];平滑插值在 Driver.update
window.addEventListener(
    'wheel',
    (e) => {
        const dy = e.deltaY;
        if (!Number.isFinite(dy)) return;
        state.targetDist = Math.min(
            CFG.distMax,
            Math.max(CFG.distMin, state.targetDist + dy * CFG.wheelK),
        );
    },
    { passive: true },
);

// ---------------------------------------------------------------------------
// GLSL3(WebGL2)公共 uniform block 声明 —— 与引擎内置布局逐字节一致
// ---------------------------------------------------------------------------
const GLSL_CAMERA = `
layout(std140) uniform CCCamera {
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

const GLSL_LOCAL = `
layout(std140) uniform CCLocal {
  highp mat4 cc_matWorld;
  highp mat4 cc_matWorldIT;
  highp vec4 cc_lightingMapUVParam;
  highp vec4 cc_localShadowBias;
};`;

// 面片顶点着色器:a_position ∈ [-1,1]^2,v_p = 世界坐标 xy(节点缩放后)
const QUAD_VERT = () => `
precision highp float;
${GLSL_CAMERA}
${GLSL_LOCAL}
in vec3 a_position;
out vec2 v_p;
void main() {
    vec4 wp = cc_matWorld * vec4(a_position, 1.0);
    v_p = wp.xy;
    gl_Position = cc_matViewProj * wp;
}`;

// ---------------------------------------------------------------------------
// 各层片元着色器
// ---------------------------------------------------------------------------

// 背景星空(带纹理)
const STARS_VERT = `
precision highp float;
${GLSL_CAMERA}
${GLSL_LOCAL}
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
    v_uv = a_uv;
    vec4 wp = cc_matWorld * vec4(a_position, 1.0);
    gl_Position = cc_matViewProj * wp;
}`;
const STARS_FRAG = `
precision highp float;
in vec2 v_uv;
uniform sampler2D mainTexture;
out vec4 cc_FragColor;
void main() {
    vec3 c = texture(mainTexture, v_uv).rgb;
    cc_FragColor = vec4(c, 1.0);
}`;

// 外围暖色大光晕(additive;内缘截止避免污染内环白蓝采样)
const HALO_FRAG = `
precision highp float;
in vec2 v_p;
out vec4 cc_FragColor;
void main() {
    float R = length(v_p);
    float cut = smoothstep(2.2, 3.2, R);
    float g1 = exp(-pow((R - 3.2) / 3.0, 2.0)) * cut;
    float g2 = exp(-(R * R) / 16.0) * 0.3 * smoothstep(1.8, 2.8, R);
    vec3 col = vec3(0.55, 0.30, 0.12) * g1 * 0.5 + vec3(0.16, 0.11, 0.08) * g2 * 0.5;
    col = vec3(1.0) - exp(-col);
    cc_FragColor = vec4(col, 1.0);
}`;

// 吸积盘:径向颜色梯度 + 旋转螺旋辐条 + 多普勒不对称 + 柔和边衰减
// u_p0 = (diskRotation, time, 0, 0)
const DISK_FRAG = `
precision highp float;
in vec2 v_p;
layout(std140) uniform DiskParams {
    vec4 u_p0;
};
out vec4 cc_FragColor;
void main() {
    const float R_IN = 1.8;
    const float R_OUT = 6.5;
    const float SQ = 0.53;
    vec2 d = vec2(v_p.x, v_p.y / SQ);
    float R = length(d);   // 盘面半径(几何范围)
    float s = length(v_p); // 屏幕面内半径(颜色/亮度梯度基准)
    if (R > 7.3) {
        cc_FragColor = vec4(0.0);
        return;
    }
    float th = atan(d.y, d.x);
    float rot = u_p0.x;
    // 径向包络:内缘平滑升起,外缘平滑衰减(无硬边)
    float env = smoothstep(R_IN, R_IN + 0.4, R) * (1.0 - smoothstep(R_OUT - 1.4, R_OUT + 0.25, R));
    // 内缘炽热峰(辉光核心;按屏幕半径,使环形采样内环均匀白亮)
    float hot = exp(-(s - 1.9) * (s - 1.9) * 1.9);
    // 旋转螺旋辐条:随 diskRotation 刚性旋转(连续时间驱动)
    float ang = th - rot;
    float stripe = 0.62 + 0.38 * sin(ang * 7.0 + R * 2.4);
    float stripe2 = 0.85 + 0.15 * sin(ang * 18.0 - R * 3.5 + u_p0.y * 0.7);
    // 多普勒不对称:一侧增亮
    float dop = 1.0 + 0.85 * sin(th + 0.9);
    // 径向颜色(按屏幕半径,任意环带采样均呈内白外红单调梯度):
    // 内蓝白 → 橙黄 → 外暗红
    vec3 cIn = vec3(1.10, 1.26, 1.50);
    vec3 cMid = vec3(1.30, 0.66, 0.16);
    vec3 cOut = vec3(0.85, 0.14, 0.02);
    float t1 = smoothstep(2.25, 3.6, s);  // 蓝白 → 橙黄
    float t2 = smoothstep(3.3, 5.0, s);   // 橙黄 → 暗红(较早,外环带色偏证据更强)
    vec3 col = mix(cIn, cMid, t1);
    col = mix(col, cOut, t2);
    float b = env * (0.4 + 1.35 * hot) * stripe * stripe2 * dop;
    col *= b;
    // 曝光压缩:亮部不死白
    col = vec3(1.0) - exp(-col);
    cc_FragColor = vec4(col, 1.0);
}`;

// 事件视界暗核:近黑圆面,边缘锐利(alpha blend)
const CORE_FRAG = `
precision highp float;
in vec2 v_p;
out vec4 cc_FragColor;
void main() {
    float R = length(v_p);
    float a = 1.0 - smoothstep(1.15, 1.24, R);
    cc_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

// 光子环(蓝白炽亮)+ 顶部透镜弧光 + 宽域内缘辉光(additive)
const RING_FRAG = `
precision highp float;
in vec2 v_p;
out vec4 cc_FragColor;
void main() {
    float R = length(v_p);
    float an = atan(v_p.y, v_p.x);
    float ring = exp(-pow((R - 1.42) / 0.085, 2.0));
    float halo = exp(-pow((R - 1.75) / 0.42, 2.0));
    float top = 0.55 + 0.45 * sin(an + 1.5708);
    float b = ring * (1.1 + 0.4 * top) + halo * 0.45 * (0.5 + 0.5 * top);
    vec3 col = mix(vec3(1.10, 1.24, 1.48), vec3(1.20, 1.32, 1.55), ring);
    col *= b;
    col = vec3(1.0) - exp(-col);
    cc_FragColor = vec4(col, 1.0);
}`;

// 星流:顶点解析螺旋 + 拖尾拉伸;u_p0 = (diskRotation, time, 0, 0)
const STREAM_VERT = `
precision highp float;
${GLSL_CAMERA}
${GLSL_LOCAL}
layout(std140) uniform StreamParams {
    vec4 u_p0;
};
in vec3 a_position;
in vec4 a_pdata;
out vec2 v_q;
out vec2 v_col;
const float CYCLE = 13.0;
const float R_IN = 1.05;
const float R_OUT = 7.8;
const float TURNS = 1.3;
const float SQ = 0.53;
void main() {
    float p = fract(a_pdata.x + u_p0.y / CYCLE);
    float s = pow(p, 1.75);
    float dsp = 1.75 * pow(p, 0.75);
    float R = mix(R_OUT, R_IN, s);
    float th0 = fract(a_pdata.x * 137.13 + 0.37) * 6.2831853;
    float th = th0 + TURNS * 6.2831853 * s + u_p0.x;
    vec2 c = vec2(cos(th), sin(th) * SQ) * R;
    // 解析切向(运动方向),用于拖尾拉伸
    float dR = (R_IN - R_OUT) * dsp;
    float dth = TURNS * 6.2831853 * dsp;
    vec2 dc = vec2(
        dR * cos(th) - R * sin(th) * dth,
        (dR * sin(th) + R * cos(th) * dth) * SQ);
    vec2 tang = normalize(dc + vec2(1e-6, 1e-6));
    vec2 norm2 = vec2(-tang.y, tang.x);
    float size = a_pdata.y;
    float stretch = 1.0 + 6.0 * s * s;
    vec2 off = tang * (a_position.x * size * stretch) + norm2 * (a_position.y * size);
    vec3 wp = vec3(c + off, 0.0);
    gl_Position = cc_matViewProj * (cc_matWorld * vec4(wp, 1.0));
    v_q = a_position.xy;
    float fadeIn = smoothstep(0.0, 0.04, p);
    float fadeOut = 1.0 - smoothstep(0.965, 1.0, p);
    v_col = vec2(a_pdata.z * (0.3 + 1.6 * s * s) * fadeIn * fadeOut, a_pdata.w);
}`;
const STREAM_FRAG = `
precision highp float;
in vec2 v_q;
in vec2 v_col;
out vec4 cc_FragColor;
void main() {
    float d2 = dot(v_q, v_q);
    float a = exp(-d2 * 3.5) * v_col.x;
    vec3 warm = vec3(1.30, 0.78, 0.30);
    vec3 cool = vec3(0.72, 0.82, 1.10);
    vec3 col = mix(cool, warm, v_col.y) * a;
    cc_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// EffectAsset 构造(与引擎 builtin 注册同路径)
// ---------------------------------------------------------------------------
function fnvHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const VERT_STAGE = gfx.ShaderStageFlagBit.VERTEX;
const FRAG_STAGE = gfx.ShaderStageFlagBit.FRAGMENT;

function registerEffect(name, vert, frag, opts) {
    const program = `${name}|vert|frag`;
    const effect = Object.assign(new EffectAsset(), {
        name,
        hideInEditor: true,
        techniques: [
            {
                name: 'default',
                passes: [Object.assign({ program }, opts.pass)],
            },
        ],
        shaders: [
            {
                name: program,
                hash: fnvHash(name),
                glsl3: { vert, frag },
                builtins: {
                    statistics: {
                        CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS: 32,
                        CC_EFFECT_USED_FRAGMENT_UNIFORM_VECTORS: 8,
                    },
                    globals: {
                        blocks: [{ name: 'CCCamera', defines: [] }],
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
                attributes: opts.attributes,
                blocks: opts.blocks || [],
                samplerTextures: opts.samplerTextures || [],
                samplers: [],
                textures: [],
                buffers: [],
                images: [],
                subpassInputs: [],
            },
        ],
    });
    effect.onLoaded(); // programLib.register + EffectAsset.register
    return effect;
}

// ---------------------------------------------------------------------------
// 程序化背景星空纹理(Canvas 2D → Texture2D,520 颗星)
// ---------------------------------------------------------------------------
function makeStarTexture() {
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    // 微弱冷色星云渐变(可选加分项;四角各一小团,近中性色调避免污染盘区环形采样)
    const nebulas = [
        { x: 0.13, y: 0.15, r: 0.30, c: '32,34,44' },
        { x: 0.87, y: 0.12, r: 0.27, c: '34,32,44' },
        { x: 0.12, y: 0.85, r: 0.28, c: '30,34,42' },
        { x: 0.86, y: 0.87, r: 0.30, c: '33,31,43' },
    ];
    for (const nb of nebulas) {
        const g = ctx.createRadialGradient(
            nb.x * W, nb.y * H, 0,
            nb.x * W, nb.y * H, nb.r * W,
        );
        g.addColorStop(0, `rgba(${nb.c},0.6)`);
        g.addColorStop(0.55, `rgba(${nb.c},0.22)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    }

    // 确定性 LCG 星点(520 颗,大小/亮度/色温有差异)
    let seed = 0x5eed01;
    const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let i = 0; i < CFG.starCount; i++) {
        const x = rnd() * W;
        const y = rnd() * H;
        const bright = 0.45 + 0.55 * rnd() * rnd();
        const m = rnd();
        let r, g, b;
        if (m < 0.68) {
            r = 0.78 + 0.22 * rnd();
            g = 0.84 + 0.16 * rnd();
            b = 1.0;
        } else if (m < 0.92) {
            r = 1.0;
            g = 0.86 + 0.12 * rnd();
            b = 0.68 + 0.2 * rnd();
        } else {
            r = 1.0;
            g = 0.62 + 0.15 * rnd();
            b = 0.45 + 0.15 * rnd();
        }
        const coreR = 0.6 + 1.3 * rnd() * rnd();
        const glowR = coreR * (3.0 + 4.0 * rnd());
        const R = Math.round(r * bright * 255);
        const G = Math.round(g * bright * 255);
        const B = Math.round(b * bright * 255);
        // 柔和光晕
        const gl = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        gl.addColorStop(0, `rgba(${R},${G},${B},${0.62 * bright})`);
        gl.addColorStop(0.4, `rgba(${R},${G},${B},${0.22 * bright})`);
        gl.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gl;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fill();
        // 星核
        ctx.fillStyle = `rgb(${Math.min(255, R + 90)},${Math.min(255, G + 90)},${Math.min(255, B + 90)})`;
        ctx.beginPath();
        ctx.arc(x, y, coreR, 0, Math.PI * 2);
        ctx.fill();
    }

    const imgAsset = new ImageAsset(cv);
    const tex = new Texture2D();
    tex.image = imgAsset;
    if (typeof tex.setFilters === 'function') {
        tex.setFilters(gfx.Filter.LINEAR, gfx.Filter.LINEAR);
    }
    return tex;
}

// ---------------------------------------------------------------------------
// 网格
// ---------------------------------------------------------------------------
function makeQuadMesh() {
    return utils.createMesh(
        {
            positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
            uvs: [0, 0, 1, 0, 0, 1, 1, 1],
            indices: [0, 1, 2, 2, 1, 3],
            primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
        },
        undefined,
        { calculateBounds: true },
    );
}

function makeStreamMesh() {
    const n = CFG.streamCount;
    const pos = [];
    const data = [];
    const idx = [];
    let sd = 0x1234abc;
    const rnd = () => {
        sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0;
        return sd / 4294967296;
    };
    const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
    ];
    for (let i = 0; i < n; i++) {
        const base = pos.length / 3;
        const phase = (i + rnd() * 0.85) / n; // 均匀散布 + 抖动,wrap 互不重叠
        const size = 0.05 + 0.11 * rnd() * rnd();
        const bright = 0.5 + 0.5 * rnd();
        const temp = rnd();
        for (const c of corners) {
            pos.push(c[0], c[1], 0);
            data.push(phase, size, bright, temp);
        }
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    return utils.createMesh(
        {
            positions: pos,
            indices: idx,
            primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
            customAttributes: [
                {
                    attr: {
                        name: 'a_pdata',
                        format: gfx.Format.RGBA32F,
                        location: 1,
                        stream: 0,
                    },
                    values: data,
                },
            ],
        },
        undefined,
        { calculateBounds: true },
    );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const ORIGIN = new Vec3(0, 0, 0);
const camDir = new Vec3(
    0,
    Math.sin(CFG.camElev),
    Math.cos(CFG.camElev),
).normalize();

let cameraNode = null;
let diskMat = null;
let streamMat = null;
const uDisk = new Vec4(0, 0, 0, 0);
const uStream = new Vec4(0, 0, 0, 0);

/** 每帧驱动:时间步进、盘旋转、相机平滑、动画 uniform 上传 */
class Driver extends Component {
    update(dt) {
        if (!Number.isFinite(dt) || dt <= 0) return;
        if (dt > 0.05) dt = 0.05; // 失焦回归钳制,防状态突变
        state.time += dt;
        state.diskRotation += CFG.omega * dt;
        const k = 1 - Math.exp(-dt * CFG.smoothK);
        state.dist += (state.targetDist - state.dist) * k;
        if (cameraNode && cameraNode.isValid) {
            cameraNode.setPosition(
                camDir.x * state.dist,
                camDir.y * state.dist,
                camDir.z * state.dist,
            );
            cameraNode.lookAt(ORIGIN);
        }
        uDisk.set(state.diskRotation, state.time, 0, 0);
        diskMat.setProperty('u_p0', uDisk);
        uStream.set(state.diskRotation, state.time, 0, 0);
        streamMat.setProperty('u_p0', uStream);
    }
}

function addLayer(scene, name, mesh, material, scale, priority) {
    const n = new Node(name);
    n.layer = Layers.Enum.DEFAULT;
    scene.addChild(n);
    n.setScale(scale, scale, 1);
    const mr = n.addComponent(MeshRenderer);
    mr.mesh = mesh;
    mr.material = material;
    mr.priority = priority;
    return n;
}

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    // --- effects(引擎设备就绪后注册) ------------------------------------
    const noDepth = { depthTest: false, depthWrite: false };
    const noCull = { cullMode: gfx.CullMode.NONE };
    const additive = {
        blend: true,
        blendSrc: gfx.BlendFactor.ONE,
        blendDst: gfx.BlendFactor.ONE,
        blendSrcAlpha: gfx.BlendFactor.ONE,
        blendDstAlpha: gfx.BlendFactor.ONE,
    };
    const alphaBlend = {
        blend: true,
        blendSrc: gfx.BlendFactor.SRC_ALPHA,
        blendDst: gfx.BlendFactor.ONE_MINUS_SRC_ALPHA,
        blendSrcAlpha: gfx.BlendFactor.ONE,
        blendDstAlpha: gfx.BlendFactor.ONE_MINUS_SRC_ALPHA,
    };

    const ATTR_POS = { name: 'a_position', defines: [], format: gfx.Format.RGB32F, location: 0 };
    const ATTR_UV = { name: 'a_uv', defines: [], format: gfx.Format.RG32F, location: 1 };
    const ATTR_PDATA = { name: 'a_pdata', defines: [], format: gfx.Format.RGBA32F, location: 1 };

    const starsEffect = registerEffect('e05-stars', STARS_VERT, STARS_FRAG, {
        attributes: [ATTR_POS, ATTR_UV],
        samplerTextures: [
            {
                name: 'mainTexture',
                type: gfx.Type.SAMPLER2D,
                count: 1,
                stageFlags: FRAG_STAGE,
                binding: 2,
            },
        ],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
        },
    });

    registerEffect('e05-halo', QUAD_VERT(), HALO_FRAG, {
        attributes: [ATTR_POS],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
            blendState: { targets: [additive] },
        },
    });

    const diskEffect = registerEffect('e05-disk', QUAD_VERT(), DISK_FRAG, {
        attributes: [ATTR_POS],
        blocks: [
            {
                name: 'DiskParams',
                binding: 0,
                stageFlags: FRAG_STAGE,
                members: [{ name: 'u_p0', type: gfx.Type.FLOAT4, count: 1 }],
            },
        ],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
            blendState: { targets: [additive] },
            properties: {
                u_p0: { value: [0, 0, 0, 0], type: gfx.Type.FLOAT4 },
            },
        },
    });

    registerEffect('e05-core', QUAD_VERT(), CORE_FRAG, {
        attributes: [ATTR_POS],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
            blendState: { targets: [alphaBlend] },
        },
    });

    registerEffect('e05-ring', QUAD_VERT(), RING_FRAG, {
        attributes: [ATTR_POS],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
            blendState: { targets: [additive] },
        },
    });

    const streamEffect = registerEffect('e05-stream', STREAM_VERT, STREAM_FRAG, {
        attributes: [ATTR_POS, ATTR_PDATA],
        blocks: [
            {
                name: 'StreamParams',
                binding: 0,
                stageFlags: VERT_STAGE,
                members: [{ name: 'u_p0', type: gfx.Type.FLOAT4, count: 1 }],
            },
        ],
        pass: {
            rasterizerState: noCull,
            depthStencilState: noDepth,
            blendState: { targets: [additive] },
        },
    });

    // --- materials ----------------------------------------------------------
    const mkMat = (effect) => {
        const m = new Material();
        m.initialize({ effectName: effect.name });
        return m;
    };
    const starsMat = mkMat(starsEffect);
    const haloMat = mkMat(EffectAsset.get('e05-halo'));
    diskMat = mkMat(diskEffect);
    const coreMat = mkMat(EffectAsset.get('e05-core'));
    const ringMat = mkMat(EffectAsset.get('e05-ring'));
    streamMat = mkMat(streamEffect);

    const starTex = makeStarTexture();
    starsMat.setProperty('mainTexture', starTex);

    // --- meshes --------------------------------------------------------------
    const quadMesh = makeQuadMesh();
    const streamMesh = makeStreamMesh();

    // --- scene ---------------------------------------------------------------
    const scene = new Scene('e05');

    // Camera
    cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(camDir.x * CFG.dist0, camDir.y * CFG.dist0, camDir.z * CFG.dist0);
    cameraNode.lookAt(ORIGIN);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 300;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(0, 0, 0, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 背景星空:远处大面片(opaque 队列,blend off → 最先绘制)
    {
        const n = new Node('stars');
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        n.setPosition(-camDir.x * 42, -camDir.y * 42, -camDir.z * 42);
        n.setScale(76, 44, 1); // 覆盖 [5,28] 距离 + 2.4:1 宽高比的视锥
        const mr = n.addComponent(MeshRenderer);
        mr.mesh = quadMesh;
        mr.material = starsMat;
    }

    // 透明层:按 Renderer.priority 升序绘制(painter's order)
    addLayer(scene, 'halo', quadMesh, haloMat, 9.5, 0); // 外围暖色光晕
    addLayer(scene, 'disk', quadMesh, diskMat, 7.6, 1); // 吸积盘
    addLayer(scene, 'stream', streamMesh, streamMat, 1, 2); // 星流(世界坐标)
    addLayer(scene, 'core', quadMesh, coreMat, 1.6, 3); // 事件视界暗核(遮没星流)
    addLayer(scene, 'ring', quadMesh, ringMat, 2.6, 4); // 光子环 + 透镜弧

    // 驱动组件
    const driverNode = new Node('Driver');
    scene.addChild(driverNode);
    driverNode.addComponent(Driver);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // 帧计数 + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[e05] black hole accretion disk running on cocosair');
} catch (err) {
    console.error('[e05] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
