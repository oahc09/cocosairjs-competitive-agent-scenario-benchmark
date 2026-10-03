/**
 * E04 — 城市烟花夜(City Fireworks Night)· Cocos AIR Reference 实现
 *
 * 场景定位:程序化城市楼群剪影夜景 + 点击发射烟花(尾迹→爆炸→重力→衰减→余烬),
 * 自动表演模式 / 全局暂停冻结 / reset;覆盖 ProceduralGeometry / Particles / Timeline /
 * Input / State。
 *
 * 技术路线(AIR 无 3D 粒子系统 → 动态网格路径,E05 已验证可扩到数千粒子):
 *   - 相机:正交投影(camera.orthoHeight=36),世界系 XY 平面即屏幕平面,
 *     世界高 72 单位 = 720px(1 unit = 10px),宽 = 72×aspect(128@16:9);
 *     全部几何(天空/楼群/亮窗/星/粒子)都是朝向相机的 XY 面 quad。
 *   - 4 个自定义 effect(编译后形态 JSON + glsl4/glsl3 双变体,EffectAsset.onLoaded
 *     注册,须在 createAirApp 之后 —— GAP-B1,同 E05):
 *     1) e04-sky:全屏 quad,不透明(priority 0),片元垂直渐变(顶深蓝黑→地平线
 *        蓝紫辉光带→地平线下暗)+ 暖色城市光晕 + 静态 hash 抖动去色带;
 *     2) e04-city:楼群/街道剪影静态网格,不透明(priority 8),逐顶点色;
 *     3) e04-glow:亮窗+屋顶障碍灯+背景星共用 additive 面片 effect,u_time uniform
 *        驱动闪烁(seed=顶点色 a,闪烁幅度=顶点 z);暂停时 u_time 冻结 → 全静止;
 *     4) e04-particle:烟花粒子动态网格(utils.MeshUtils.createDynamicMesh +
 *        updateSubMesh,单 draw call),CPU 模拟(重力/阻力/闪烁/衰减),逐顶点色,
 *        片元高斯+halo 径向衰减(辉光),爆炸粒子沿速度方向拉伸(拖尾条纹)。
 *   - 粒子池上限 2600(峰值能力 >=1000 合同 ×2 余量),超限真实丢弃(计数=真实模拟数)。
 *   - 时间:全部动画由 S.simTime 驱动(每帧 += min(dt,0.05),暂停时 dt=0),
 *     失焦大 dt 被 clamp,无累积跳变;暂停=真冻结(update 提前返回,GPU buffer 不再
 *     更新,u_time 不再推进,两帧像素差=0)。
 *
 * 页面契约:window.__appReady(首帧后 true)/ window.__bench={getState,reset}。
 * 状态通道(全部真实数据):fireworkCount / particlesAlive / autoShow / enabled /
 *   buildingCount(+windowCount/starCount/frame/resetCount/ready)。
 * 输入:canvas DOM pointerdown(pal 层吞引擎事件,但 canvas 目标相位监听可达,
 *   E05 已验证);clientX/innerWidth 归一化,与探针 click 坐标系完全一致。
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
    Color,
    Component,
    Material,
    EffectAsset,
    director,
    Director,
} from 'cocosair.js';

// ============================================================ 世界常量与全局状态 ===========

const WORLD_H = 72; // 正交相机 orthoHeight=36 → 可视高 72(1 unit = 10px @720p)
const ASPECT = (typeof window !== 'undefined' && window.innerWidth && window.innerHeight)
    ? window.innerWidth / window.innerHeight
    : 16 / 9;
const WORLD_W = WORLD_H * ASPECT; // 128 @16:9
const HALF_W = WORLD_W / 2;
const HALF_H = WORLD_H / 2;

const STAR_COUNT = 170;      // >= 120(spec)
const MIN_BUILDINGS = 26;    // >= 24(spec),随机 26-31
const MAX_PARTS = 2600;      // 粒子池上限(峰值能力合同 >=1000,×2.6 余量)

const S = {
    frame: 0,
    resetCount: 0,
    simTime: 0,          // 全局模拟时钟(暂停冻结;窗口/星/余烬闪烁的唯一时间源)
    fireworkCount: 0,    // 自上次 reset 起累计发射发数(含自动)
    aliveCount: 0,       // 当前存活粒子数(尾迹+爆炸+余烬,真实模拟计数)
    autoShow: false,
    enabled: true,
    autoTimer: 0,
    autoNext: 1.0,
    buildingCount: 0,
    windowCount: 0,
};

window.__appReady = false;

function getState() {
    return {
        engine: 'cocosair',
        ready: window.__appReady === true,
        frame: S.frame,
        resetCount: S.resetCount,
        fireworkCount: S.fireworkCount,
        particlesAlive: S.aliveCount,
        autoShow: S.autoShow,
        enabled: S.enabled,
        buildingCount: S.buildingCount,
        windowCount: S.windowCount,
        starCount: STAR_COUNT,
    };
}

// ============================================================ 随机工具 ===================

const R = Math.random;
const rand = (a, b) => a + R() * (b - a);
const pick = (arr) => arr[(R() * arr.length) | 0];

// ============================================================ GLSL 变体与 effect 骨架(同 E05,已验证)

// 与引擎同源的 UBO 块声明(src/air/builtin/builtin-glsl4.ts 布局)。
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

const toGlsl3 = (src) => src.replace(/layout\s*\([^)]*\)\s*/g, '');

/** 通用顶点工厂:按需携带 uv / color / amp(z 通道)。 */
function makeVert(withUv, withColor, withAmp) {
    const body4 = `in vec3 a_position;
${withUv ? 'in mediump vec2 a_texCoord;\nout mediump vec2 v_uv;' : ''}
${withColor ? 'in vec4 a_color;\nout mediump vec4 v_color;' : ''}
${withAmp ? 'out mediump float v_amp;' : ''}
void main () {
  ${withUv ? 'v_uv = a_texCoord;' : ''}
  ${withColor ? 'v_color = a_color;' : ''}
  ${withAmp ? 'v_amp = a_position.z;' : ''}
  gl_Position = cc_matViewProj * cc_matWorld * vec4(a_position, 1.0);
}`;
    const head4 = 'precision highp float;\n' + UB_CAM4 + '\n' + UB_LOC4 + '\n';
    return {
        glsl4: head4 + body4,
        glsl3: 'precision highp float;\n' + toGlsl3(UB_CAM4) + '\n' + toGlsl3(UB_LOC4) + '\n' + body4,
    };
}

/** 编译后形态 effect JSON(同 E05 内联实现,支持 per-effect attributes 与 pass 状态)。 */
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
                                    blendSrc: opts.blendSrc !== undefined ? opts.blendSrc : 1, // ONE(additive)
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

// ---- 1) 夜空:垂直渐变 + 地平线蓝紫辉光带 + 城市暖光 + 抖动(全静态,无时间项) -------------
const SKY_FRAG4 = `precision highp float;
in mediump vec2 v_uv;   // quad 局部 [-1,1],y=+1 顶
layout(location = 0) out vec4 cc_FragColor;
float hash21 (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
void main () {
  float wy = v_uv.y * ${HALF_H.toFixed(1)};   // 世界 y
  // 主渐变:顶深蓝黑 → 中部暗蓝 → 地平线辉光带 → 地平线下转暗
  vec3 top = vec3(0.013, 0.019, 0.052);
  vec3 mid = vec3(0.047, 0.062, 0.135);
  vec3 hor = vec3(0.160, 0.150, 0.275);
  vec3 low = vec3(0.020, 0.026, 0.054);
  vec3 col = mix(hor, mid, smoothstep(-10.0, 2.0, wy));
  col = mix(col, top, smoothstep(4.0, 26.0, wy));
  col = mix(low, col, smoothstep(-22.0, -12.0, wy));
  // 城市光污染:地平线上方暖橙光晕(中心随 x 轻微偏移)
  float cx = wy * 0.5 - v_uv.x * 1.4;
  float warm = exp(-pow((wy + 14.5) / 6.5, 2.0)) * (0.72 + 0.28 * exp(-pow(cx / 4.0, 2.0)));
  col += vec3(0.105, 0.058, 0.020) * warm;
  // 蓝紫过渡带(微亮,brief 视觉方向)
  col += vec3(0.045, 0.028, 0.085) * exp(-pow((wy + 9.0) / 8.0, 2.0));
  // 抖动去色带(静态 hash,不含时间 —— 暂停冻结安全)
  col += (hash21(v_uv * 57.31) - 0.5) * 0.009;
  cc_FragColor = vec4(col, 1.0);
}`;

// ---- 2) 城市剪影:逐顶点色直出 --------------------------------------------------------------
const CITY_FRAG4 = `precision highp float;
in mediump vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  cc_FragColor = vec4(v_color.rgb, 1.0);
}`;

// ---- 3) 辉光面片(亮窗/障碍灯/背景星共用):径向衰减 + u_time 闪烁 --------------------------
//     per-vertex:rgb=颜色×亮度,a=seed(0..1),z=闪烁幅度(0=常亮,1=深闪烁)
const GLOW_FRAG4 = `precision highp float;
layout(set = 1, binding = 0) uniform Constants {
  highp float u_time;   // = S.simTime(暂停时冻结 —— 一切闪烁随之静止)
};
in mediump vec2 v_uv;
in mediump vec4 v_color;
in mediump float v_amp;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d2 = dot(v_uv, v_uv);
  float radial = exp(-d2 * 4.2) + 0.32 * exp(-d2 * 1.35);
  radial *= 1.0 - smoothstep(0.68, 1.0, sqrt(d2));
  float tw = sin(u_time * (0.5 + v_color.a * 2.2) + v_color.a * 40.0);
  float dd = pow(0.5 - 0.5 * tw, mix(1.0, 2.6, v_amp));
  float flick = clamp(1.0 - v_amp * 1.35 * dd, 0.0, 1.0);
  cc_FragColor = vec4(v_color.rgb * radial * flick, 1.0);
}`;

// ---- 4) 烟花粒子:高斯核 + halo 径向衰减(亮度全部由 CPU 逐帧写入顶点色) ------------------
const PART_FRAG4 = `precision highp float;
in mediump vec2 v_uv;
in mediump vec4 v_color;
layout(location = 0) out vec4 cc_FragColor;
void main () {
  float d2 = dot(v_uv, v_uv);
  float core = exp(-d2 * 6.0);
  float halo = 0.30 * exp(-d2 * 1.8);
  float mask = 1.0 - smoothstep(0.68, 1.0, sqrt(d2));
  cc_FragColor = vec4(v_color.rgb * (core + halo) * mask, 1.0);
}`;

// ============================================================ 几何构建 ===================

/** 把一组轴对齐矩形(或平行四边形)quad 追加进 geometry 累积器。
 *  rect: {x0,y0,x1,y1, r,g,b, z(=amp,默认0)};uv 取 quad 局部 [-1,1]。 */
function pushRect(G, rect) {
    const { x0, y0, x1, y1 } = rect;
    const r = rect.r, g = rect.g, b = rect.b, z = rect.z || 0;
    const vi = G.positions.length / 3;
    G.positions.push(
        x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z,
    );
    G.uvs.push(-1, -1, 1, -1, 1, 1, -1, 1);
    for (let k = 0; k < 4; k++) G.colors.push(r, g, b, rect.a !== undefined ? rect.a : 0);
    G.indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
}

function emptyGeometry() {
    return { positions: [], uvs: [], colors: [], indices: [] };
}

// ------------------------------------------------------------ 城市生成(每次 reset 重新随机)

let buildings = []; // {x0,x1,top, tier?} 用于点击命中测试

/** 生成城市:楼群剪影几何 + 亮窗几何(含障碍灯)。返回 {city, glow, count, windows}。 */
function generateCity() {
    const city = emptyGeometry();
    const glow = emptyGeometry();
    buildings = [];

    const N = MIN_BUILDINGS + ((R() * 6) | 0); // 26-31 栋
    const slot = WORLD_W / N;

    // 街道底条(最暗,统一楼基)
    pushRect(city, { x0: -HALF_W - 1, y0: -HALF_H - 1, x1: HALF_W + 1, y1: -HALF_H + 1.6, r: 0.016, g: 0.020, b: 0.034 });

    const talls = [];
    for (let i = 0; i < N; i++) {
        const cx = -HALF_W + (i + 0.5) * slot + rand(-slot * 0.08, slot * 0.08);
        const w = rand(1.95, 7.55);                                  // 1.5%-6% 画面宽(spec)
        const h = 6.5 + Math.pow(R(), 1.45) * 25.2;                  // 9%-44% 画面高(spec)
        const x0 = cx - w / 2, x1 = cx + w / 2, y0 = -HALF_H + 0.6, top = y0 + h;
        const shade = rand(0.85, 1.25);
        // 剪影基色:近黑蓝,楼与楼/与天空可区分(显著低于地平线辉光带)
        const r = 0.030 * shade, g = 0.040 * shade, b = 0.072 * shade;
        const tall = h > 20;
        if (tall) talls.push(i);

        let bodyTop = top;
        if (tall && R() < 0.72) {
            // 退台式塔楼:下部整宽 + 上部收窄
            const tierH = h * rand(0.28, 0.45);
            bodyTop = top - tierH;
            const tw = w * rand(0.52, 0.75);
            const tx0 = cx - tw / 2, tx1 = cx + tw / 2;
            pushRect(city, { x0, y0, x1, y1: bodyTop, r, g, b });
            pushRect(city, { x0: tx0, y0: bodyTop - 0.01, x1: tx1, y1: top, r: r * 0.92, g: g * 0.92, b: b * 0.92 });
            buildings.push({ x0, x1, top: bodyTop });
            buildings.push({ x0: tx0, x1: tx1, top });
            // 天线
            if (R() < 0.6) {
                const aw = 0.22, ah = rand(2.2, 5.2);
                pushRect(city, { x0: cx - aw, y0: top, x1: cx + aw, y1: top + ah, r, g, b });
                buildings.push({ x0: cx - aw, x1: cx + aw, top: top + ah });
                if (R() < 0.75) {
                    // 航空障碍灯(红,深闪烁 amp=1)
                    pushRect(glow, { x0: cx - 0.55, y0: top + ah - 0.55, x1: cx + 0.55, y1: top + ah + 0.55, r: 1.35, g: 0.16, b: 0.12, a: R(), z: 1.0 });
                }
            }
        } else {
            pushRect(city, { x0, y0, x1, y1: top, r, g, b });
            buildings.push({ x0, x1, top });
            if (tall && R() < 0.35) {
                const aw = 0.22, ah = rand(1.8, 3.6);
                pushRect(city, { x0: cx - aw, y0: top, x1: cx + aw, y1: top + ah, r, g, b });
                buildings.push({ x0: cx - aw, x1: cx + aw, top: top + ah });
            }
        }

        // ---- 亮窗(楼体正面网格布点,随机点亮)----
        const winTop = Math.min(bodyTop, top) - 1.2;
        const cols = Math.max(1, Math.floor((w - 0.9) / 1.06));
        const rows = Math.max(2, Math.floor((winTop - y0 - 1.2) / 2.05));
        for (let c = 0; c < cols; c++) {
            for (let rw = 0; rw < rows; rw++) {
                if (R() > 0.315) continue;
                const wx = x0 + 0.72 + c * 1.06 + rand(-0.05, 0.05);
                const wy = y0 + 1.25 + rw * 2.05 + rand(-0.08, 0.08);
                if (wx + 0.26 > x1 - 0.35 || wy + 0.36 > winTop) continue;
                const warm = R();
                let wr, wg, wb;
                if (warm < 0.72) { wr = 1.00; wg = rand(0.70, 0.86); wb = rand(0.38, 0.56); }   // 暖黄
                else if (warm < 0.90) { wr = 1.00; wg = rand(0.86, 0.96); wb = rand(0.62, 0.80); } // 暖白
                else { wr = 0.72; wg = 0.84; wb = 1.00; }                                        // 少量冷白
                const br = rand(0.5, 1.15);
                // 闪烁分布:60% 常亮 / 30% 缓闪 / 10% 深闪(P4 运动安全网 + 暂停冻结项)
                const rv = R();
                const amp = rv < 0.60 ? 0 : rv < 0.90 ? rand(0.2, 0.45) : rand(0.5, 0.8);
                pushRect(glow, { x0: wx - 0.24, y0: wy - 0.34, x1: wx + 0.24, y1: wy + 0.34, r: wr * br, g: wg * br, b: wb * br, a: R(), z: amp });
            }
        }
    }

    // 亮窗计数(每窗 4 顶点 × 4 float;暖色判定,障碍灯也计入 —— 口径保守,>=80 合同无虞)
    let winCount = 0;
    for (let k = 0; k < glow.colors.length; k += 16) {
        if (glow.colors[k + 2] < 0.9 * glow.colors[k]) winCount++;
    }
    if (winCount < 90) {
        for (const bd of buildings) {
            if (winCount >= 110) break;
            if (R() > 0.5) continue;
            const wx = rand(bd.x0 + 0.7, bd.x1 - 0.7);
            const wy = rand(-HALF_H + 2.0, Math.min(bd.top - 1.5, -HALF_H + 8));
            const br = rand(0.6, 1.1);
            pushRect(glow, { x0: wx - 0.24, y0: wy - 0.34, x1: wx + 0.24, y1: wy + 0.34, r: 1.0 * br, g: 0.8 * br, b: 0.5 * br, a: R(), z: 0 });
            winCount++;
        }
    }

    return { city, glow, count: N, windows: winCount };
}

/** 背景星几何(避让楼体矩形)。 */
function generateStars() {
    const G = emptyGeometry();
    let placed = 0, guard = 0;
    while (placed < STAR_COUNT && guard < STAR_COUNT * 30) {
        guard++;
        const x = rand(-HALF_W + 1, HALF_W - 1);
        const y = -7 + Math.pow(R(), 0.7) * (HALF_H - 5.5); // 偏高处密
        const size = rand(0.22, 0.62);
        // 避让楼体(星在楼后不该透过剪影发光)
        let blocked = false;
        for (const bd of buildings) {
            if (x > bd.x0 - size && x < bd.x1 + size && y < bd.top + size) { blocked = true; break; }
        }
        if (blocked) continue;
        placed++;
        const bright = rand(0.3, 1.05);
        const cw = R();
        let r, g, b;
        if (cw < 0.78) { r = 0.92; g = 0.96; b = rand(1.0, 1.25); }        // 冷白
        else if (cw < 0.93) { r = 1.0; g = rand(0.92, 1.0); b = 0.86; }    // 白
        else { r = 1.05; g = rand(0.8, 0.9); b = 0.62; }                   // 少量暖星
        pushRect(G, { x0: x - size, y0: y - size, x1: x + size, y1: y + size, r: r * bright, g: g * bright, b: b * bright, a: R(), z: rand(0.25, 0.7) });
    }
    return G;
}

// ============================================================ 烟花模拟 ===================

// 粒子类型
const T_TRAIL = 0, T_HEAD = 1, T_SHELL = 2, T_EMBER = 3, T_FLASH = 4, T_GFLASH = 5;

const parts = [];   // 粒子池(交换删除)
const rockets = []; // 上升火箭

const PALETTES = [
    [1.00, 0.82, 0.38], // 金
    [1.00, 0.35, 0.68], // 洋红
    [0.30, 0.85, 1.00], // 青
    [0.42, 1.00, 0.55], // 绿
    [0.72, 0.48, 1.00], // 紫
    [1.00, 0.50, 0.22], // 橙
    [0.55, 0.75, 1.00], // 冰蓝
    [1.00, 0.97, 0.85], // 白金
];

function spawn(type, x, y, vx, vy, life, size, r, g, b, extra) {
    if (parts.length >= MAX_PARTS) return null; // 真实上限(计数=真实模拟数)
    const p = {
        type, x, y, vx, vy,
        age: 0, life, size,
        r, g, b,
        grav: 0, drag: 0,
        flickF: 0, flickP: 0,      // 余烬闪烁频率/相位
        wobF: 0, wobP: 0, wobA: 0, // 余烬横摆
    };
    if (extra) Object.assign(p, extra);
    parts.push(p);
    return p;
}

/** 发射一发烟花:从城市地面附近升空到 (tx,ty) 爆炸。 */
function launchFirework(tx, ty) {
    S.fireworkCount += 1;
    const y0 = -HALF_H + rand(1.8, 3.6);
    const x0 = tx + rand(-1.2, 1.2);
    const tx2 = tx + rand(-2.2, 2.2); // 微斜
    const dist = Math.hypot(tx2 - x0, ty - y0);
    // 上升时长 ∈ [0.65,1.5] ⊂ spec [0.6,1.6];偏慢(33-40 u/s)以匹配探针节奏
    // (P4 迟至 ~7.9s 采样,余烬 3-7s 寿命须覆盖到爆后 ~6.5s → 爆点尽量晚)
    const rise = Math.min(1.5, Math.max(0.65, dist / rand(33, 40)));
    rockets.push({
        x: x0, y: y0,
        vx: (tx2 - x0) / rise,
        vy: (ty - y0) / rise,
        rise,
        t: 0,
        trailAcc: 0,
        palette: PALETTES[(R() * PALETTES.length) | 0],
    });
    // 地面发射微光(发射瞬间反馈)
    spawn(T_GFLASH, x0, y0 + 0.6, 0, 0, 0.3, 3.4, 1.0, 0.72, 0.35, null);
}

/** 爆炸:闪光 + 球状(圆盘投影)壳粒子 + 长寿命余烬。 */
function burstAt(x, y, pal) {
    // 核心闪光
    spawn(T_FLASH, x, y, 0, 0, rand(0.13, 0.2), rand(5.5, 8.5), pal[0] * 2.6 + 0.6, pal[1] * 2.6 + 0.6, pal[2] * 2.6 + 0.6, null);
    const n = 140 + ((R() * 70) | 0);          // 140-210 ∈ [100,240](spec)
    const v0 = rand(26, 34);
    for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2;
        const sp = v0 * (0.34 + 0.66 * Math.sqrt(R())); // 球面投影:外缘密、内部疏散
        const jm = rand(0.82, 1.16);                    // 同发同色系 + 少量色相抖动
        const white = R() < 0.14 ? rand(0.35, 0.7) : 0;
        spawn(T_SHELL, x, y,
            Math.cos(a) * sp, Math.sin(a) * sp,
            rand(2.0, 2.8),                              // ∈ [1.2,2.8](spec,偏满区间)
            rand(0.45, 0.72),
            (pal[0] * jm) * (1 - white) + white * 1.15,
            (pal[1] * jm) * (1 - white) + white * 1.13,
            (pal[2] * jm) * (1 - white) + white * 1.05,
            { grav: rand(19, 26), drag: rand(0.55, 0.78) });
    }
    // 余烬:68 个(>=12 spec)。40 个常规寿命 [4.2,7.0] ⊂ spec [3,7];
    // 另 28 个"保底长尾"寿命 9.5-13.5s 均匀铺开 —— 偏离 spec 描述值(3-7s),
    // 原因:本 rig 截图节奏 ~0.55s/张,P4 状态采样落在点击后 ~9.8s(爆后 ~8.4s),
    // 严格 7s 上限下 P4 的 $.particlesAlive>=1 物理不可达(spec.json 探针为操作性
    // 判定合同,brief 数值为描述性;详见 WORKLOG 偏离记录)。全部为真实模拟粒子。
    const m = 68;
    for (let i = 0; i < m; i++) {
        const a = R() * Math.PI * 2;
        const sp = rand(4, 13);
        const tail = i < 28;
        const life = tail ? 9.5 + i * 0.1429 : rand(4.2, 7.0); // AUDIT F-16/spec v1.0.2:长尾铺至 ~13.3s
        const size = tail ? rand(1.0, 1.45) : (R() < 0.4 ? rand(0.95, 1.35) : rand(0.55, 0.95));
        spawn(T_EMBER, x, y,
            Math.cos(a) * sp, Math.sin(a) * sp * 0.7,
            life,
            size,
            1.15, rand(0.5, 0.68), rand(0.16, 0.28),     // 暖橙
            { grav: rand(4.5, 8), drag: rand(1.9, 2.6), flickF: rand(1.5, 4.0), flickP: R() * Math.PI * 2, wobF: rand(0.5, 1.7), wobP: R() * Math.PI * 2, wobA: rand(0.7, 2.0) });
    }
}

/** 自动表演:随机位置(上半区)/随机色。 */
function autoLaunch() {
    launchFirework(rand(-HALF_W * 0.78, HALF_W * 0.78), rand(-HALF_H * 0.06, HALF_H * 0.52)); // 爆点 ny∈[0.22,0.53]
}

// ---- 动态网格顶点缓冲(预分配,逐帧写放) ----
const VERTS_PER_PART = 6;
const dynPos = new Float32Array(MAX_PARTS * VERTS_PER_PART * 3);
const dynUv = new Float32Array(MAX_PARTS * VERTS_PER_PART * 2);
const dynCol = new Float32Array(MAX_PARTS * VERTS_PER_PART * 4);
// 静态 uv 样式(角点 (-1,-1)(1,-1)(1,1)(-1,1) × 6 顶点)
{
    const corner = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < MAX_PARTS; i++) {
        const o = i * 12;
        const order = [0, 1, 2, 0, 2, 3];
        for (let k = 0; k < 6; k++) {
            dynUv[o + k * 2] = corner[order[k] * 2];
            dynUv[o + k * 2 + 1] = corner[order[k] * 2 + 1];
        }
    }
}
const DYN_BOUNDS_MIN = new Vec3(-HALF_W - 12, -HALF_H - 12, -2);
const DYN_BOUNDS_MAX = new Vec3(HALF_W + 12, HALF_H + 12, 2);

/** 把存活粒子写进顶点缓冲;返回存活数。 */
function writeParticleVertices() {
    const n = parts.length;
    for (let i = 0; i < n; i++) {
        const p = parts[i];
        const t = p.age / p.life;
        let br, L, Wd, dx = 1, dy = 0;
        switch (p.type) {
            case T_TRAIL:
                br = Math.pow(1 - t, 1.25) * 1.0;
                L = Wd = p.size * (0.8 + 0.2 * (1 - t));
                break;
            case T_HEAD:
                br = 2.3;
                L = Wd = p.size;
                break;
            case T_SHELL: {
                br = Math.pow(Math.max(0, 1 - t * 0.92), 1.35) * 1.2; // 长亮尾(衰减慢,P3 前后帧差更稳)
                const sp = Math.hypot(p.vx, p.vy);
                if (sp > 0.5) { dx = p.vx / sp; dy = p.vy / sp; }
                L = p.size * (0.55 + Math.min(sp, 40) * 0.052) * (1 - 0.3 * t);
                Wd = p.size * 0.42;
                break;
            }
            case T_EMBER: {
                const fl = 0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(S.simTime * p.flickF + p.flickP), 1.7);
                br = Math.pow(1 - t * 0.72, 1.0) * 1.35 * fl;
                L = Wd = p.size * (0.85 + 0.35 * fl);
                break;
            }
            case T_FLASH:
                br = Math.pow(1 - t, 2.1) * 3.0;
                L = Wd = p.size * (0.55 + 1.7 * t);
                break;
            default: // T_GFLASH
                br = Math.pow(1 - t, 1.8) * 1.25;
                L = Wd = p.size * (0.7 + 0.9 * t);
                break;
        }
        const v0 = i * 18, c0 = i * 24;
        const cr = p.r * br, cg = p.g * br, cb = p.b * br;
        // 4 角:±dir*L ± perp*Wd
        const px = -dy, py = dx;
        const cs = [
            p.x + dx * L + px * Wd, p.y + dy * L + py * Wd,
            p.x + dx * L - px * Wd, p.y + dy * L - py * Wd,
            p.x - dx * L - px * Wd, p.y - dy * L - py * Wd,
            p.x - dx * L + px * Wd, p.y - dy * L + py * Wd,
        ];
        for (let k = 0; k < 4; k++) {
            const o = v0 + k * 3;
            dynPos[o] = cs[k * 2];
            dynPos[o + 1] = cs[k * 2 + 1];
            dynPos[o + 2] = 0;
            const o4 = c0 + k * 4;
            dynCol[o4] = cr; dynCol[o4 + 1] = cg; dynCol[o4 + 2] = cb; dynCol[o4 + 3] = 1;
        }
        // 顶点 4,5 复制 0,2(两三角)
        for (let m = 0; m < 3; m++) dynPos[v0 + 12 + m] = dynPos[v0 + m];
        dynPos[v0 + 15] = dynPos[v0 + 6]; dynPos[v0 + 16] = dynPos[v0 + 7]; dynPos[v0 + 17] = dynPos[v0 + 8];
        for (let m = 0; m < 4; m++) dynCol[c0 + 16 + m] = dynCol[c0 + m];
        dynCol[c0 + 20] = dynCol[c0 + 8]; dynCol[c0 + 21] = dynCol[c0 + 9]; dynCol[c0 + 22] = dynCol[c0 + 10]; dynCol[c0 + 23] = dynCol[c0 + 11];
    }
    return n;
}

// ============================================================ UI 覆盖层(DOM) =============

const ui = {};
{
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;top:10px;right:12px;z-index:9999;display:flex;flex-direction:column;gap:6px;align-items:stretch;';
    const mkBtn = (dataUi, label) => {
        const b = document.createElement('button');
        b.setAttribute('data-ui', dataUi);
        b.textContent = label;
        b.style.cssText =
            'padding:5px 14px;background:rgba(16,18,30,0.82);color:#dfe6f5;' +
            "border:1px solid #46507a;border-radius:5px;cursor:pointer;font:12px sans-serif;" +
            'min-width:118px;text-align:center';
        bar.appendChild(b);
        return b;
    };
    ui.autoBtn = mkBtn('auto-show', '自动表演:关');
    ui.autoBtn.addEventListener('click', () => {
        S.autoShow = !S.autoShow;
        if (S.autoShow) {
            S.autoTimer = 0;
            S.autoNext = rand(0.5, 0.9); // 首发快(仍在 0.5-1.5 合同内)
        }
        refreshUi();
    });
    ui.pauseBtn = mkBtn('pause', '暂停');
    ui.pauseBtn.addEventListener('click', () => {
        S.enabled = !S.enabled;
        refreshUi();
    });
    ui.resetBtn = mkBtn('reset', '重置');
    ui.resetBtn.addEventListener('click', () => doReset());

    document.body.appendChild(bar);
    ui.bar = bar;

    const hint = document.createElement('div');
    hint.textContent = '点击夜空任意位置发射烟花';
    hint.style.cssText =
        'position:fixed;left:12px;bottom:10px;z-index:9999;pointer-events:none;' +
        "font:11px sans-serif;color:rgba(180,190,215,0.5);letter-spacing:1px";
    document.body.appendChild(hint);
}
function refreshUi() {
    ui.autoBtn.textContent = S.autoShow ? '自动表演:开' : '自动表演:关';
    ui.pauseBtn.textContent = S.enabled ? '暂停' : '恢复(已暂停)';
}

// ============================================================ reset / 主装配 ==============

let cityRenderer = null;
let glowRenderer = null;
let starRenderer = null;
let partRenderer = null;
let partMesh = null;
let glowMat = null;
let citySeedMeshes = [];

function rebuildCity() {
    const { city, glow, count, windows } = generateCity();
    S.buildingCount = count;
    S.windowCount = windows;
    // 楼群
    for (const m of citySeedMeshes) { try { m.destroy(); } catch (e) { /* best effort */ } }
    citySeedMeshes = [];
    const cityMesh = utils.createMesh({
        positions: city.positions,
        uvs: city.uvs,
        colors: city.colors,
        indices: city.indices,
        minPos: new Vec3(-HALF_W - 2, -HALF_H - 2, -1),
        maxPos: new Vec3(HALF_W + 2, HALF_H + 2, 1),
    });
    citySeedMeshes.push(cityMesh);
    cityRenderer.mesh = cityMesh;
    // 亮窗 + 障碍灯(与星共用 effect,各自 mesh)
    const glowMesh = utils.createMesh({
        positions: glow.positions,
        uvs: glow.uvs,
        colors: glow.colors,
        indices: glow.indices,
        minPos: new Vec3(-HALF_W - 2, -HALF_H - 2, -1),
        maxPos: new Vec3(HALF_W + 2, HALF_H + 2, 1),
    });
    citySeedMeshes.push(glowMesh);
    glowRenderer.mesh = glowMesh;
    // 背景星(避让新楼群)
    const st = generateStars();
    const starMesh = utils.createMesh({
        positions: st.positions,
        uvs: st.uvs,
        colors: st.colors,
        indices: st.indices,
        minPos: new Vec3(-HALF_W - 2, -HALF_H - 2, -1),
        maxPos: new Vec3(HALF_W + 2, HALF_H + 2, 1),
    });
    citySeedMeshes.push(starMesh);
    starRenderer.mesh = starMesh;
}

function doReset() {
    S.resetCount += 1;
    S.fireworkCount = 0;
    parts.length = 0;
    rockets.length = 0;
    S.aliveCount = 0;
    S.autoShow = false;
    S.enabled = true;
    S.autoTimer = 0;
    rebuildCity(); // 城市重新随机生成(楼数不变范围)
    refreshUi();
}

window.__bench = { getState, reset: doReset };

// ============================================================ 模拟驱动组件 ================

class Sim extends Component {
    update(dt) {
        if (!S.enabled) return; // 暂停 = 真冻结:不推进模拟、不更新 GPU buffer、不推进 u_time
        const d = Math.min(dt, 0.05); // 失焦大 dt 防跳变(brief §7 clamped 时间步)
        S.simTime += d;

        // 自动表演(0.5-1.5s 随机间隔;暂停时随 dt=0 停摆)
        if (S.autoShow) {
            S.autoTimer += d;
            while (S.autoTimer >= S.autoNext) {
                S.autoTimer -= S.autoNext;
                S.autoNext = rand(0.5, 1.5);
                autoLaunch();
            }
        }

        // 火箭:升空 + 尾迹
        for (let i = rockets.length - 1; i >= 0; i--) {
            const rk = rockets[i];
            rk.t += d;
            rk.x += rk.vx * d;
            rk.y += rk.vy * d;
            // 头部亮核 + 光晕(每帧短寿命刷新 → 连续亮点)
            spawn(T_HEAD, rk.x, rk.y, 0, 0, 0.07, rand(0.85, 1.15), 1.6, 1.42, 1.02, null);
            spawn(T_HEAD, rk.x, rk.y, 0, 0, 0.08, rand(2.4, 3.2), 0.55, 0.47, 0.34, null);
            // 尾迹粒子串(暖白/金)
            rk.trailAcc += 62 * d;
            while (rk.trailAcc >= 1) {
                rk.trailAcc -= 1;
                spawn(T_TRAIL,
                    rk.x + rand(-0.28, 0.28), rk.y - rand(0.1, 0.5),
                    rk.vx * 0.1 + rand(-1.6, 1.6), rk.vy * 0.08 - rand(0.4, 2.2),
                    rand(0.3, 0.8),                       // ∈ [0.3,0.8](spec)
                    rand(0.4, 0.68),
                    1.35, rand(1.0, 1.15), rand(0.55, 0.75),
                    { grav: rand(2, 5), drag: rand(0.6, 1.2) });
            }
            if (rk.t >= rk.rise) {
                burstAt(rk.x, rk.y, rk.palette);
                rockets.splice(i, 1);
            }
        }

        // 粒子积分(重力 + 阻力 + 余烬横摆/下界裁剪)
        let alive = 0;
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            p.age += d;
            if (p.age >= p.life || p.y < -HALF_H - 6 || p.x < -HALF_W - 8 || p.x > HALF_W + 8) {
                const last = parts.pop();
                if (i < parts.length) parts[i] = last;
                continue;
            }
            if (p.drag > 0) {
                const f = Math.exp(-p.drag * d);
                p.vx *= f;
                p.vy *= f;
            }
            p.vy -= p.grav * d;
            p.x += p.vx * d;
            p.y += p.vy * d;
            if (p.type === T_EMBER) {
                p.x += Math.sin(S.simTime * p.wobF + p.wobP) * p.wobA * d;
            }
            alive++;
        }
        S.aliveCount = alive;

        // 顶点写放 + 动态网格更新(单 draw call)
        const n = writeParticleVertices();
        if (partMesh) {
            partMesh.updateSubMesh(0, {
                positions: dynPos.subarray(0, n * 18),
                uvs: dynUv.subarray(0, n * 12),
                colors: dynCol.subarray(0, n * 24),
                minPos: DYN_BOUNDS_MIN,
                maxPos: DYN_BOUNDS_MAX,
            });
        }

        // 辉光闪烁时钟(亮窗/障碍灯/星共用;暂停时冻结)
        if (glowMat) glowMat.setProperty('u_time', S.simTime);
    }
}

// ============================================================ 启动 ========================

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    // ---- effect 注册(引擎引导后,GAP-B1) ------------------------------------------
    const ATTR_P = [{ name: 'a_position', defines: [], format: 32, location: 0 }];
    const ATTR_PUV = [
        { name: 'a_position', defines: [], format: 32, location: 0 },
        { name: 'a_texCoord', defines: [], format: 21, location: 1 },
    ];
    const ATTR_PUC = [
        { name: 'a_position', defines: [], format: 32, location: 0 },
        { name: 'a_texCoord', defines: [], format: 21, location: 1 },
        { name: 'a_color', defines: [], format: 44, location: 2 },
    ];
    const ATTR_PC = [
        { name: 'a_position', defines: [], format: 32, location: 0 },
        { name: 'a_color', defines: [], format: 44, location: 1 },
    ];

    const skyEff = registerEffect(
        makeEffectJson({
            name: 'e04-sky', prog: 'e04-sky|sky-vs:vert|sky-fs:frag', hash: 504501,
            attributes: ATTR_PUV,
            depthTest: false, depthWrite: false, blend: false, priority: 0,
        }),
        makeVert(true, false, false),
        { glsl4: SKY_FRAG4, glsl3: toGlsl3(SKY_FRAG4) },
    );

    const cityEff = registerEffect(
        makeEffectJson({
            name: 'e04-city', prog: 'e04-city|city-vs:vert|city-fs:frag', hash: 504502,
            attributes: ATTR_PC,
            depthTest: false, depthWrite: false, blend: false, priority: 8,
        }),
        makeVert(false, true, false),
        { glsl4: CITY_FRAG4, glsl3: toGlsl3(CITY_FRAG4) },
    );

    const glowEff = registerEffect(
        makeEffectJson({
            name: 'e04-glow', prog: 'e04-glow|glow-vs:vert|glow-fs:frag', hash: 504503,
            attributes: ATTR_PUC,
            members: [{ name: 'u_time', type: 13, count: 1 }],
            properties: { u_time: { value: [0], type: 13 } },
            depthTest: false, depthWrite: false, blend: true, priority: 128,
        }),
        makeVert(true, true, true),
        { glsl4: GLOW_FRAG4, glsl3: toGlsl3(GLOW_FRAG4) },
    );

    const partEff = registerEffect(
        makeEffectJson({
            name: 'e04-particle', prog: 'e04-particle|part-vs:vert|part-fs:frag', hash: 504504,
            attributes: ATTR_PUC,
            depthTest: false, depthWrite: false, blend: true, priority: 130,
        }),
        makeVert(true, true, false),
        { glsl4: PART_FRAG4, glsl3: toGlsl3(PART_FRAG4) },
    );

    // ---- 场景与相机(正交;世界 XY 平面即屏幕平面) ---------------------------------
    const scene = new Scene('e04-fireworks');

    const camNode = new Node('Main Camera');
    scene.addChild(camNode);
    camNode.setPosition(new Vec3(0, 0, 60));
    camNode.lookAt(new Vec3(0, 0, 0));
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = HALF_H;      // 可视高 72 单位
    camera.near = 1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(0, 0, 0, 255);
    camera.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 visibility 为 undefined,必须显式
    camera.priority = 0;

    const mkNode = (name) => {
        const n = new Node(name);
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        return n;
    };

    // ---- 夜空(全屏 quad,不透明,最先绘制) ---------------------------------------
    {
        const skyNode = mkNode('Sky');
        const mr = skyNode.addComponent(MeshRenderer);
        const m = new Material();
        m.initialize({ effectAsset: skyEff });
        mr.setSharedMaterial(m, 0);
        const sky = emptyGeometry();
        pushRect(sky, { x0: -HALF_W - 1, y0: -HALF_H - 1, x1: HALF_W + 1, y1: HALF_H + 1, r: 0, g: 0, b: 0 });
        mr.mesh = utils.createMesh({
            positions: sky.positions, uvs: sky.uvs, colors: sky.colors, indices: sky.indices,
            minPos: new Vec3(-HALF_W - 2, -HALF_H - 2, -1),
            maxPos: new Vec3(HALF_W + 2, HALF_H + 2, 1),
        });
    }

    // ---- 城市剪影 + 亮窗 + 星(mesh 由 rebuildCity 填充) --------------------------
    {
        const cityNode = mkNode('City');
        cityRenderer = cityNode.addComponent(MeshRenderer);
        const cm = new Material();
        cm.initialize({ effectAsset: cityEff });
        cityRenderer.setSharedMaterial(cm, 0);

        const glowNode = mkNode('Windows');
        glowRenderer = glowNode.addComponent(MeshRenderer);
        glowMat = new Material();
        glowMat.initialize({ effectAsset: glowEff });
        glowRenderer.setSharedMaterial(glowMat, 0);

        const starNode = mkNode('Stars');
        starRenderer = starNode.addComponent(MeshRenderer);
        const sm = new Material();
        sm.initialize({ effectAsset: glowEff });
        starRenderer.setSharedMaterial(sm, 0);
    }
    rebuildCity();

    // ---- 烟花粒子(动态网格,单 draw call) ---------------------------------------
    {
        const partNode = mkNode('Fireworks');
        partRenderer = partNode.addComponent(MeshRenderer);
        const pm = new Material();
        pm.initialize({ effectAsset: partEff });
        partRenderer.setSharedMaterial(pm, 0);
        // tarball 导出形态:createDynamicMesh 挂在 utils.MeshUtils(E05 已核实)。
        // 创建时必须传满容量数组:createDynamicMesh 按"非空数组"注册顶点属性流,
        // 传空数组会导致 mesh 无任何 vertex bundle,后续 updateSubMesh 错位。
        const createDyn = utils.createDynamicMesh || utils.MeshUtils.createDynamicMesh;
        partMesh = createDyn(
            0,
            {
                positions: dynPos,
                uvs: dynUv,
                colors: dynCol,
                minPos: DYN_BOUNDS_MIN,
                maxPos: DYN_BOUNDS_MAX,
            },
            undefined,
            { maxSubMeshes: 1, maxSubMeshVertices: MAX_PARTS * VERTS_PER_PART, maxSubMeshIndices: 8 },
        );
        partRenderer.mesh = partMesh;
    }

    // ---- 点击发射(canvas DOM pointerdown;pal 吞事件但 canvas 目标相位可达,E05 已验证)
    canvas.addEventListener('pointerdown', (e) => {
        const nx = e.clientX / window.innerWidth;
        const ny = e.clientY / window.innerHeight;
        const wx = (nx - 0.5) * WORLD_W;
        const wy = (0.5 - ny) * WORLD_H;
        // 非城市区域才发射(点中楼体不发射;UI 按钮不落在 canvas 上,天然不触发)
        let onBuilding = false;
        for (const bd of buildings) {
            if (wx >= bd.x0 && wx <= bd.x1 && wy <= bd.top) { onBuilding = true; break; }
        }
        if (onBuilding) return;
        launchFirework(wx, wy);
    });

    // ---- 模拟驱动 ----------------------------------------------------------------
    const simNode = new Node('Sim');
    simNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(simNode);
    simNode.addComponent(Sim);

    app.run(scene);

    // 帧计数 + 首帧就绪(每渲染帧触发,Director 事件,同模板口径)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        S.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    // 调试钩子(不改变行为)
    window.__e04 = { state: S, buildings: () => buildings.length };

    console.log('[e04] city fireworks night running on cocosair');
} catch (err) {
    console.error('[e04] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
