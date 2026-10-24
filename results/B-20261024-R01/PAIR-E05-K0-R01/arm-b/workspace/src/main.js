/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)/ Cocos AIR 1.0.0
 *
 * 实现路线(全部程序化,无外部资产;见 brief §5):
 *   - 吸积盘: 程序化生成的环形网格 + 运行时代码生成的盘面纹理(u=半径, v=方位角),
 *     盘节点绕 Y 轴按真实时间连续旋转 → 条纹真实转动(非贴图倒放,非逐帧素材)。
 *   - 事件视界: unlit 纯黑球体(radius 1.2),轮廓即"黑盘"。
 *   - 辉光: 引擎默认姿态下后处理不可达(pipeline-reachability),故用多层叠加混合
 *     (additive ONE/ONE)几何光晕近似: 光子环 + 暖色光晕 + 外侧光环 + 星点光斑。
 *   - 星流: 单张 dynamic mesh(240 个 billboard 拖尾四边形),CPU 每帧更新顶点,
 *     螺旋内落 → 视界吞噬 → 外圈重生,总数恒定。
 *   - 背景星空: 900 个静态 billboard 星点(3 个色温桶,合并网格),外加极弱星云。
 *   - 相机: 初始距离 14,仰角 26°(盘面与视线倾角 64°,落在 brief 15°–75° 区间),
 *     wheel 改变目标距离 [5,28],指数平滑插值。
 *
 * 页面契约: __appReady(首帧后 true) / __bench.getState() / __bench.reset() / data-ui="reset"。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    Material,
    Texture2D,
    ImageAsset,
    Component,
    director,
    Director,
    utils,
    primitives,
    gfx,
    inspectAirMaterial,
    Color,
    Vec3,
    Vec4,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 常量(场景尺度严格按 brief §2)
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const DISK_INNER = 1.8;
const DISK_OUTER = 6.5;
const HORIZON_R = 1.2;
const START_DISTANCE = 14.0;
const MIN_DISTANCE = 5.0;
const MAX_DISTANCE = 28.0;
const CAMERA_ELEVATION = 26 * (Math.PI / 180);
const DISK_OMEGA = 0.35;          // rad/s, brief 要求 0.15-0.6
const STAR_STREAM_COUNT = 240;    // >= 200,恒定
const BACKGROUND_STAR_COUNT = 900; // >= 300
const STARFIELD_RADIUS = 300;

// 相机方向(单位向量):从黑洞中心指向相机
const CAM_DIR = new Vec3(0, Math.sin(CAMERA_ELEVATION), Math.cos(CAMERA_ELEVATION));

// ---------------------------------------------------------------------------
// 运行时状态(唯一事实源,getState 直接读它,绝不伪造)
// ---------------------------------------------------------------------------
const state = {
    ready: false,
    frame: 0,
    diskRotation: 0,
    cameraDistance: START_DISTANCE,
    cameraTarget: START_DISTANCE,
    resetCount: 0,
};

// ---------------------------------------------------------------------------
// 程序化随机(确定性,便于复现同一初始画面)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// 程序化纹理(全部运行时代码生成,禁止外部图片)
// ---------------------------------------------------------------------------
function makeTexture(width, height, fill) {
    const data = new Uint8Array(width * height * 4);
    fill(data, width, height);
    const tex = new Texture2D();
    tex.image = new ImageAsset({
        width,
        height,
        _data: data,
        _compressed: false,
        format: Texture2D.PixelFormat.RGBA8888,
    });
    return tex;
}

/** 盘面纹理:u=半径(0=内缘,1=外缘), v=方位角。条纹是周期函数,接缝天然连续。 */
function buildDiskTexture(n = 1024) {
    // 径向色带:内缘白/蓝白 → 黄橙 → 暗红(brief §2 必需项)
    const ramp = [
        [0.00, 1.00, 0.985, 0.97],
        [0.05, 1.00, 0.96, 0.90],
        [0.12, 1.00, 0.88, 0.66],
        [0.24, 1.00, 0.74, 0.36],
        [0.40, 0.95, 0.50, 0.16],
        [0.58, 0.76, 0.27, 0.075],
        [0.76, 0.48, 0.12, 0.042],
        [0.90, 0.24, 0.05, 0.022],
        [1.00, 0.09, 0.018, 0.010],
    ];
    const sampleRamp = (u) => {
        for (let i = 1; i < ramp.length; i++) {
            if (u <= ramp[i][0]) {
                const a = ramp[i - 1];
                const b = ramp[i];
                const t = (u - a[0]) / (b[0] - a[0]);
                return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
            }
        }
        const last = ramp[ramp.length - 1];
        return [last[1], last[2], last[3]];
    };

    return makeTexture(n, n, (data) => {
        for (let y = 0; y < n; y++) {
            const v = (y + 0.5) / n;
            const ang = v * TAU;
            for (let x = 0; x < n; x++) {
                const u = (x + 0.5) / n;
                // 5 条主螺旋臂 + 更细的谐波:盘面明暗相间的径向辐条
                const s1 = Math.sin(ang * 5 + u * 4.6);
                const s2 = Math.sin(ang * 11 - u * 2.2);
                const s3 = Math.sin(ang * 29 + u * 9.0);
                let stripe = 1 - 0.30 * (0.5 + 0.5 * s1) - 0.10 * (0.5 + 0.5 * s2) - 0.045 * (0.5 + 0.5 * s3);
                // 内缘保持高温平滑(条纹对比向内衰减)
                const innerSmooth = Math.min(1, u / 0.10);
                stripe = 1 + (stripe - 1) * innerSmooth;
                // 细径向纹理,避免大块纯色
                stripe *= 0.95 + 0.05 * Math.sin(u * 220 + ang * 2.0);
                // 外缘柔和收边(避免硬多边形边/硬色边)
                const edge = u > 0.84 ? Math.max(0, 1 - (u - 0.84) / 0.16) : 1;
                const c = sampleRamp(u);
                const m = stripe * edge;
                const i = (y * n + x) * 4;
                data[i] = Math.min(255, c[0] * m * 255);
                data[i + 1] = Math.min(255, c[1] * m * 255);
                data[i + 2] = Math.min(255, c[2] * m * 255);
                data[i + 3] = 255;
            }
        }
    });
}

/** 圆形软光点(星点/光晕通用):RGB 已按衰减预乘,配合 ONE/ONE 加法混合。 */
function buildDotTexture(n, tint, coreSharp, haloGain) {
    return makeTexture(n, n, (data) => {
        const half = n / 2;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const dx = (x + 0.5 - half) / half;
                const dy = (y + 0.5 - half) / half;
                const rr = Math.sqrt(dx * dx + dy * dy);
                const core = Math.exp(-rr * rr * coreSharp);
                const halo = Math.exp(-rr * rr * 5.0) * haloGain;
                let a = core + halo;
                if (rr > 1) a = 0;
                a = Math.min(1, a);
                const i = (y * n + x) * 4;
                data[i] = Math.min(255, tint[0] * a * 255);
                data[i + 1] = Math.min(255, tint[1] * a * 255);
                data[i + 2] = Math.min(255, tint[2] * a * 255);
                data[i + 3] = 255;
            }
        }
    });
}

/** 星流拖尾:V=0 为头部(靠近运动前方),V=1 为尾端;U 为横向。 */
function buildStreakTexture(w = 64, h = 128) {
    return makeTexture(w, h, (data) => {
        for (let y = 0; y < h; y++) {
            const v = (y + 0.5) / h;
            const width = 0.45 + 0.55 * v;
            for (let x = 0; x < w; x++) {
                const u = ((x + 0.5) / w) * 2 - 1;
                const across = Math.exp(-(u / width) * (u / width) * 2.6);
                const along = Math.exp(-v * 2.4) * Math.min(1, v / 0.04);
                const a = Math.min(1, across * along * 1.25);
                const i = (y * w + x) * 4;
                data[i] = 235 * a;
                data[i + 1] = 240 * a;
                data[i + 2] = 255 * a;
                data[i + 3] = 255;
            }
        }
    });
}

/** 光子环 + 引力透镜弧(面向相机的加法贴图)。 */
function buildPhotonRingTexture(n = 512) {
    const ringR = 0.372;       // 世界 7.4 尺寸 quad 的一半 = 3.7 → 环半径 ≈ 1.38
    return makeTexture(n, n, (data) => {
        const half = n / 2;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const dx = (x + 0.5 - half) / half;
                const dy = (y + 0.5 - half) / half;
                const rr = Math.sqrt(dx * dx + dy * dy);
                const ang = Math.atan2(dy, dx); // 屏幕坐标 y 向下,取上半弧 = ang < 0
                // 细亮光环
                const ring = Math.exp(-Math.pow((rr - ringR) / 0.016, 2));
                // 环内侧的冷色填充(事件视界边缘的微光)
                const inside = rr < ringR ? Math.exp(-Math.pow((rr - ringR) / 0.16, 2)) * 0.16 : 0;
                // 环外侧柔和扩散
                const outside = rr >= ringR ? Math.exp(-Math.pow((rr - ringR) / 0.06, 2)) * 0.30 : 0;
                // 透镜弧:上半部稍上方再叠一条更淡的弧(盘后缘被引力抬起)
                const upper = (dy < 0 ? 1 : 0) * Math.max(0, Math.sin(ang)) ** 2;
                const arc = Math.exp(-Math.pow((rr - ringR - 0.05) / 0.035, 2)) * 0.55 * upper;
                const warm = Math.exp(-Math.pow(Math.max(rr - ringR - 0.02, 0) / 0.22, 2)) * 0.10;
                const r = 1.00 * (ring + outside * 0.85 + arc * 0.55) + 1.00 * warm;
                const g = 0.97 * (ring + outside * 0.82 + arc * 0.52) + 0.45 * warm;
                const b = 0.94 * (ring + outside * 0.9 + arc * 0.55) + 0.16 * warm + inside * 0.5;
                const i = (y * n + x) * 4;
                data[i] = Math.min(255, r * 255);
                data[i + 1] = Math.min(255, g * 255);
                data[i + 2] = Math.min(255, b * 255);
                data[i + 3] = 255;
            }
        }
    });
}

/** 环形暖色光环(加法):inner~outer 之间柔和峰,提供"亮部向外扩散"的辉光观感。 */
function buildGlowRingTexture(n, inner, peak, outer, color, gain) {
    return makeTexture(n, n, (data) => {
        const half = n / 2;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const dx = (x + 0.5 - half) / half;
                const dy = (y + 0.5 - half) / half;
                const rr = Math.sqrt(dx * dx + dy * dy);
                let a = 0;
                if (rr > inner && rr < outer) {
                    const t = (rr - inner) / (peak - inner);
                    const t2 = (rr - peak) / (outer - peak);
                    a = rr <= peak ? Math.exp(-t * t * 1.6) : Math.exp(-t2 * t2 * 2.4);
                }
                a *= gain;
                const i = (y * n + x) * 4;
                data[i] = Math.min(255, color[0] * a * 255);
                data[i + 1] = Math.min(255, color[1] * a * 255);
                data[i + 2] = Math.min(255, color[2] * a * 255);
                data[i + 3] = 255;
            }
        }
    });
}

/** 极弱冷色星云(可选加分项;保证深空不是纯黑一片)。 */
function buildNebulaTexture(n = 256) {
    const perm = new Uint8Array(512);
    const rnd = mulberry32(9137);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = p[i];
        p[i] = p[j];
        p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const fade = (t) => t * t * (3 - 2 * t);
    const grad = (h, x, y) => {
        const a = h & 3;
        const u = a < 2 ? x : y;
        const v = a < 2 ? y : x;
        return (a & 1 ? -u : u) + (a & 2 ? -v : v);
    };
    const noise = (x, y) => {
        const xi = Math.floor(x) & 255;
        const yi = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const u = fade(xf);
        const v = fade(yf);
        const aa = perm[perm[xi] + yi];
        const ab = perm[perm[xi] + yi + 1];
        const ba = perm[perm[xi + 1] + yi];
        const bb = perm[perm[xi + 1] + yi + 1];
        const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
        const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
        return (x1 + v * (x2 - x1)) * 0.5 + 0.5;
    };
    const fbm = (x, y) => {
        let s = 0;
        let amp = 0.55;
        let f = 1;
        for (let o = 0; o < 4; o++) {
            s += amp * noise(x * f, y * f);
            amp *= 0.5;
            f *= 2.1;
        }
        return s;
    };
    return makeTexture(n, n, (data) => {
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const nx = (x / n) * 6;
                const ny = (y / n) * 4;
                const n1 = fbm(nx, ny);
                const n2 = fbm(nx * 2.3 + 11.7, ny * 2.3 + 4.1);
                // 近黑深空:峰值仅 ~10-30/255,避免"暗部糊成一片黑"又不喧宾夺主
                const r = 0.004 + 0.030 * n1 * n1;
                const g = 0.006 + 0.038 * n1 * n1;
                const b = 0.014 + 0.085 * n2 * n2;
                const i = (y * n + x) * 4;
                data[i] = Math.min(255, r * 255);
                data[i + 1] = Math.min(255, g * 255);
                data[i + 2] = Math.min(255, b * 255);
                data[i + 3] = 255;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 几何构建
// ---------------------------------------------------------------------------
/** 环面网格(XZ 平面,uv: u=半径归一, v=方位角归一)。 */
function buildDiskGeometry(radialSegs = 72, angularSegs = 320) {
    const verts = (radialSegs + 1) * (angularSegs + 1);
    const positions = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const indices = new Uint16Array(radialSegs * angularSegs * 6);
    let vi = 0;
    for (let i = 0; i <= radialSegs; i++) {
        const u = i / radialSegs;
        const r = DISK_INNER + (DISK_OUTER - DISK_INNER) * u;
        for (let j = 0; j <= angularSegs; j++) {
            const v = j / angularSegs;
            const a = v * TAU;
            positions[vi * 3] = Math.cos(a) * r;
            positions[vi * 3 + 1] = 0;
            positions[vi * 3 + 2] = Math.sin(a) * r;
            uvs[vi * 2] = u;
            uvs[vi * 2 + 1] = v;
            vi++;
        }
    }
    let ii = 0;
    for (let i = 0; i < radialSegs; i++) {
        for (let j = 0; j < angularSegs; j++) {
            const a = i * (angularSegs + 1) + j;
            const b = a + angularSegs + 1;
            // 从上往下看逆时针;材质关闭背面剔除,双面都正确着色
            indices[ii++] = a;
            indices[ii++] = b;
            indices[ii++] = a + 1;
            indices[ii++] = b;
            indices[ii++] = b + 1;
            indices[ii++] = a + 1;
        }
    }
    return { positions, uvs, indices, primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST };
}

/** 静态星空:每个星点一个朝向球心的四边形。 */
function buildStarfieldGeometry(seed, count, sizeMin, sizeMax, tintIdx, radius) {
    const rnd = mulberry32(seed);
    const positions = new Float32Array(count * 4 * 3);
    const uvs = new Float32Array(count * 4 * 2);
    const indices = new Uint16Array(count * 6);
    const up = new Vec3(0, 1, 0);
    for (let i = 0; i < count; i++) {
        // 球面均匀采样
        const z = 1 - 2 * rnd();
        const phi = rnd() * TAU;
        const rxy = Math.sqrt(Math.max(0, 1 - z * z));
        const dir = new Vec3(Math.cos(phi) * rxy, z, Math.sin(phi) * rxy);
        const center = dir.clone().multiplyScalar(radius);
        // 切平面基
        let t1 = new Vec3(0, 1, 0).cross(dir);
        if (t1.length() < 1e-4) t1 = new Vec3(1, 0, 0).cross(dir);
        t1.normalize();
        const t2 = dir.clone().cross(t1).normalize();
        const size = sizeMin + (sizeMax - sizeMin) * Math.pow(rnd(), 2.2);
        const hx = size * 0.5;
        const hy = size * 0.5 * (0.85 + 0.3 * rnd());
        const base = i * 4;
        const corners = [
            [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy],
        ];
        for (let c = 0; c < 4; c++) {
            const [cx, cy] = corners[c];
            const px = center.x + t1.x * cx + t2.x * cy;
            const py = center.y + t1.y * cx + t2.y * cy;
            const pz = center.z + t1.z * cx + t2.z * cy;
            positions[(base + c) * 3] = px;
            positions[(base + c) * 3 + 1] = py;
            positions[(base + c) * 3 + 2] = pz;
            uvs[(base + c) * 2] = c === 1 || c === 2 ? 1 : 0;
            uvs[(base + c) * 2 + 1] = c >= 2 ? 1 : 0;
        }
        const ii = i * 6;
        indices[ii] = base;
        indices[ii + 1] = base + 1;
        indices[ii + 2] = base + 2;
        indices[ii + 3] = base;
        indices[ii + 4] = base + 2;
        indices[ii + 5] = base + 3;
    }
    return { positions, uvs, indices, primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST };
}

/** 面向相机的四边形(XY 平面,+Z 法线;材质关闭剔除)。 */
function buildQuadGeometry(size) {
    const h = size * 0.5;
    return {
        positions: new Float32Array([
            -h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0,
        ]),
        uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
    };
}

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------
/** 加法混合 + 关闭深度写入 + 高优先级(保证叠加层画在不透明底盘之后)。 */
function additiveStates(priority) {
    return {
        priority,
        blendState: {
            targets: [{
                blend: true,
                blendSrc: gfx.BlendFactor.ONE,
                blendDst: gfx.BlendFactor.ONE,
                blendSrcAlpha: gfx.BlendFactor.ONE,
                blendDstAlpha: gfx.BlendFactor.ONE,
            }],
        },
        depthStencilState: {
            depthTest: true,
            depthWrite: false,
            depthFunc: gfx.ComparisonFunc.LESS_EQUAL,
        },
        rasterizerState: { cullMode: gfx.CullMode.NONE },
    };
}

function makeUnlitMaterial({ texture = null, color = null, states = null }) {
    const mat = new Material();
    mat.initialize({
        effectName: 'builtin-unlit',
        defines: texture ? { USE_TEXTURE: true } : {},
        ...(states ? { states } : {}),
    });
    if (texture) mat.setProperty('mainTexture', texture);
    if (color) mat.setProperty('mainColor', color);
    refs.materials.push(mat);
    return mat;
}

// ---------------------------------------------------------------------------
// 星流粒子状态
// ---------------------------------------------------------------------------
function createParticles(count) {
    const rnd = mulberry32(20261024);
    const list = [];
    for (let i = 0; i < count; i++) {
        const p = {
            r: 0, ang: 0, y: 0,
            vr: 0, va: 0,
            size: 0, spin: 0, seed: rnd(),
        };
        respawnParticle(p, rnd, true);
        list.push(p);
    }
    return list;
}

function respawnParticle(p, rnd, initial) {
    const t = initial ? Math.pow(rnd(), 0.7) : Math.pow(rnd(), 0.55);
    p.r = 7.2 + 2.8 * (1 - t);          // 外圈重生半径 7.2–10.0
    p.ang = rnd() * TAU;
    p.y = (rnd() - 0.5) * 0.55;
    p.vr = 0.55 + 0.85 * rnd();          // 径向内落速度
    p.va = 0.32 + 0.35 * rnd();          // 切向角速度(同向旋转)
    p.size = 0.10 + 0.10 * rnd();
    p.spin = (rnd() - 0.5) * 0.2;
}

// ---------------------------------------------------------------------------
// 主程序
// ---------------------------------------------------------------------------
window.__appReady = false;
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        ready: state.ready,
        frame: state.frame,
        diskRotation: state.diskRotation,
        accretionPhase: (state.diskRotation / TAU) % 1,
        cameraDistance: state.cameraDistance,
        starStreamCount: STAR_STREAM_COUNT,
        backgroundStarCount: BACKGROUND_STAR_COUNT,
        diskAngularSpeed: DISK_OMEGA,
        resetCount: state.resetCount,
    }),
    reset: () => doReset(),
};

/** 需要跨帧引用的对象(挂在模块作用域,供 update/reset 使用)。 */
const refs = {
    cameraNode: null,
    camera: null,
    diskNode: null,
    billboards: [],       // 需要逐帧朝向相机的节点
    particles: null,
    streamMesh: null,
    streamRenderer: null,
    streamPositions: null,
    streamUVs: null,
    streamIndices: null,
    streamReady: false,
    materials: [],
    rnd: mulberry32(77123),
    camForward: new Vec3(0, 0, -1),
    camRight: new Vec3(1, 0, 0),
    camUp: new Vec3(0, 1, 0),
};

function doReset() {
    state.diskRotation = 0;
    state.cameraDistance = START_DISTANCE;
    state.cameraTarget = START_DISTANCE;
    state.resetCount += 1;
    if (refs.diskNode && refs.diskNode.isValid) {
        refs.diskNode.setRotationFromEuler(0, 0, 0);
    }
    if (refs.cameraNode && refs.cameraNode.isValid) {
        refs.cameraNode.setPosition(CAM_DIR.clone().multiplyScalar(START_DISTANCE));
        refs.cameraNode.lookAt(new Vec3(0, 0, 0));
    }
    // 星流复位:全体回到外圈重生点(总数恒定)
    const rnd = refs.rnd;
    if (refs.particles) {
        for (const p of refs.particles) respawnParticle(p, rnd, true);
        if (refs.streamReady) updateStreamGeometry(0);
    }
}

// --- 相机朝向基向量(用于 billboard / 拖尾四边形) -------------------------
function updateCameraBasis() {
    const camPos = refs.cameraNode.worldPosition;
    const fwd = new Vec3(-camPos.x, -camPos.y, -camPos.z).normalize();
    refs.camForward.set(fwd.x, fwd.y, fwd.z);
    const upWorld = new Vec3(0, 1, 0);
    const right = upWorld.clone().cross(fwd);
    if (right.length() < 1e-5) right.set(1, 0, 0);
    right.normalize();
    refs.camRight.set(right.x, right.y, right.z);
    const up = fwd.clone().cross(right).normalize();
    refs.camUp.set(up.x, up.y, up.z);
}

// --- 星流动态网格更新 -------------------------------------------------------
function updateStreamGeometry(dt) {
    const positions = refs.streamPositions;
    const particles = refs.particles;
    const fwd = refs.camForward;
    const right = refs.camRight;
    const tmpVel = new Vec3();
    const tmpDir = new Vec3();
    const side = new Vec3();
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (dt > 0) {
            // 越靠近视界内落越快(接近黑洞时加速)
            const boost = 1 + 1.6 / Math.max(p.r, 1.15);
            p.r -= p.vr * dt * boost;
            p.ang += p.va * dt * boost;
            if (p.r <= HORIZON_R * 1.03) {
                respawnParticle(p, refs.rnd, false);
            }
        }
        const ca = Math.cos(p.ang);
        const sa = Math.sin(p.ang);
        const px = p.r * ca;
        const py = p.y * (1 - 0.5 * Math.min(1, HORIZON_R * 2 / Math.max(p.r, 0.5)));
        const pz = p.r * sa;
        // 速度方向(径向内落 + 切向)
        tmpVel.set(
            -p.vr * ca - p.r * p.va * sa,
            0,
            -p.vr * sa + p.r * p.va * ca,
        );
        // 投影到相机平面,拖尾只沿屏幕方向伸展
        const d = tmpVel.dot(fwd);
        tmpDir.set(tmpVel.x - fwd.x * d, tmpVel.y - fwd.y * d, tmpVel.z - fwd.z * d);
        if (tmpDir.length() < 1e-5) tmpDir.set(right.x, right.y, right.z);
        tmpDir.normalize();
        side.copy(right);

        const trail = 0.28 + 2.4 / (p.r * p.r);          // 近视界被拉长
        const halfLen = trail * 0.5;
        const halfW = p.size * 0.5 * (1 + 0.9 / Math.max(p.r, 1.4));
        const hx = px + tmpDir.x * halfLen;
        const hy = py + tmpDir.y * halfLen;
        const hz = pz + tmpDir.z * halfLen;
        const tx = px - tmpDir.x * halfLen;
        const ty = py - tmpDir.y * halfLen;
        const tz = pz - tmpDir.z * halfLen;
        const base = i * 12;
        // 头部两侧
        positions[base] = hx + side.x * halfW;
        positions[base + 1] = hy + side.y * halfW;
        positions[base + 2] = hz + side.z * halfW;
        positions[base + 3] = hx - side.x * halfW;
        positions[base + 4] = hy - side.y * halfW;
        positions[base + 5] = hz - side.z * halfW;
        // 尾端两侧
        positions[base + 6] = tx - side.x * halfW;
        positions[base + 7] = ty - side.y * halfW;
        positions[base + 8] = tz - side.z * halfW;
        positions[base + 9] = tx + side.x * halfW;
        positions[base + 10] = ty + side.y * halfW;
        positions[base + 11] = tz + side.z * halfW;
    }
    try {
        refs.streamMesh.updateSubMesh(0, {
            positions: refs.streamPositions,
            uvs: refs.streamUVs,
            indices: refs.streamIndices,
            minPos: { x: -11, y: -11, z: -11 },
            maxPos: { x: 11, y: 11, z: 11 },
        });
        if (refs.streamRenderer && typeof refs.streamRenderer.onGeometryChanged === 'function') {
            refs.streamRenderer.onGeometryChanged();
        }
    } catch (err) {
        if (!refs.streamUpdateWarned) {
            refs.streamUpdateWarned = true;
            console.log('[e05] stream update skipped:', err && err.message ? err.message : err);
        }
    }
}

/** 每帧动画组件:真实时间步进,dt 夹紧以避免失焦恢复时跳变。 */
class SceneAnimator extends Component {
    update(dt) {
        const d = Math.min(Math.max(dt, 0), 0.05);
        // 1) 盘旋转(状态 = 画面旋转角,同一参数)
        state.diskRotation += DISK_OMEGA * d;
        if (refs.diskNode && refs.diskNode.isValid) {
            refs.diskNode.setRotationFromEuler(0, (state.diskRotation * 180) / Math.PI, 0);
        }
        // 2) 相机平滑缩放
        const k = 1 - Math.exp(-d * 9.5);
        state.cameraDistance += (state.cameraTarget - state.cameraDistance) * k;
        if (refs.cameraNode && refs.cameraNode.isValid) {
            const dist = state.cameraDistance;
            refs.cameraNode.setPosition(CAM_DIR.x * dist, CAM_DIR.y * dist, CAM_DIR.z * dist);
            refs.cameraNode.lookAt(new Vec3(0, 0, 0));
        }
        // 3) 相机朝向基向量 + billboard
        updateCameraBasis();
        const camPos = refs.cameraNode.worldPosition;
        for (const node of refs.billboards) {
            if (node.isValid) node.lookAt(camPos);
        }
        // 4) 星流
        if (refs.streamReady) updateStreamGeometry(d);
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('e05-black-hole');

    // --- 相机 -------------------------------------------------------------
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(CAM_DIR.clone().multiplyScalar(START_DISTANCE));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 62;
    camera.near = 0.1;
    camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(3, 5, 10, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    refs.cameraNode = cameraNode;
    refs.camera = camera;

    // --- 纹理 -------------------------------------------------------------
    const texDisk = buildDiskTexture(1024);
    const texStarWhite = buildDotTexture(64, [1.0, 1.0, 1.0], 40, 0.5);
    const texStarBlue = buildDotTexture(64, [0.82, 0.9, 1.0], 40, 0.55);
    const texStarWarm = buildDotTexture(64, [1.0, 0.9, 0.76], 40, 0.5);
    const texStream = buildStreakTexture();
    const texRing = buildPhotonRingTexture(512);
    const texHalo = buildGlowRingTexture(512, 0.10, 0.34, 1.0, [1.0, 0.42, 0.15], 0.55);
    const texAura = buildGlowRingTexture(512, 0.30, 0.50, 1.0, [1.0, 0.40, 0.12], 0.38);
    const texBlob = buildDotTexture(128, [1.0, 0.55, 0.24], 7.5, 0.35);
    const texNebula = buildNebulaTexture(256);

    // --- 星云背景(最远,加法) --------------------------------------------
    {
        const node = new Node('Nebula');
        node.layer = Layers.Enum.DEFAULT;
        node.setPosition(new Vec3(0, 0, -400));
        scene.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = utils.MeshUtils.createMesh(buildQuadGeometry(1250));
        r.setSharedMaterial(makeUnlitMaterial({
            texture: texNebula,
            color: new Vec4(1, 1, 1, 1),
            states: additiveStates(5),
        }), 0);
    }

    // --- 背景星空(3 个色温桶,合并网格) ----------------------------------
    {
        const groups = [
            { seed: 11, n: Math.round(BACKGROUND_STAR_COUNT * 0.5), min: 3.5, max: 9.5, tex: texStarWhite },
            { seed: 22, n: Math.round(BACKGROUND_STAR_COUNT * 0.3), min: 3.0, max: 7.5, tex: texStarBlue },
            { seed: 33, n: Math.round(BACKGROUND_STAR_COUNT * 0.2), min: 4.0, max: 13.0, tex: texStarWarm },
        ];
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const node = new Node(`Stars-${gi}`);
            node.layer = Layers.Enum.DEFAULT;
            scene.addChild(node);
            const r = node.addComponent(MeshRenderer);
            r.mesh = utils.MeshUtils.createMesh(
                buildStarfieldGeometry(g.seed, g.n, g.min, g.max, gi, STARFIELD_RADIUS),
            );
            r.setSharedMaterial(makeUnlitMaterial({
                texture: g.tex,
                color: new Vec4(1, 1, 1, 1),
                states: additiveStates(10 + gi),
            }), 0);
        }
    }

    // --- 事件视界(不透明纯黑球) ------------------------------------------
    {
        const node = new Node('EventHorizon');
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = utils.MeshUtils.createMesh(primitives.sphere(HORIZON_R, { segments: 64 }));
        r.setSharedMaterial(makeUnlitMaterial({
            color: new Color(0, 0, 0, 255),
            states: { priority: 0 },
        }), 0);
    }

    // --- 吸积盘(不透明,程序化纹理 + 节点真实旋转) ------------------------
    {
        const node = new Node('AccretionDisk');
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = utils.MeshUtils.createMesh(buildDiskGeometry(72, 320));
        r.setSharedMaterial(makeUnlitMaterial({
            texture: texDisk,
            color: new Vec4(1, 1, 1, 1),
            states: { priority: 0, rasterizerState: { cullMode: gfx.CullMode.NONE } },
        }), 0);
        refs.diskNode = node;
    }

    // --- 加法辉光层 --------------------------------------------------------
    const addBillboard = (name, size, texture, priority, pos, scaleY = 1) => {
        const node = new Node(name);
        node.layer = Layers.Enum.DEFAULT;
        node.setPosition(pos);
        if (scaleY !== 1) node.setScale(new Vec3(1, scaleY, 1));
        scene.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = utils.MeshUtils.createMesh(buildQuadGeometry(size));
        r.setSharedMaterial(makeUnlitMaterial({
            texture,
            color: new Vec4(1, 1, 1, 1),
            states: additiveStates(priority),
        }), 0);
        refs.billboards.push(node);
        return node;
    };

    // 外围暖色光晕(盘面外侧的柔和扩散)
    addBillboard('GlowHalo', 24, texHalo, 60, new Vec3(0, 0, 0));
    // 外侧环形暖光:保证盘外环带在任意方位角上都有"橙红"色相证据(P3)
    addBillboard('GlowAura', 16.5, texAura, 62, new Vec3(0, 0, 0));
    // 光子环 + 透镜弧(面向相机,半径约 1.38 单位)
    addBillboard('PhotonRing', 7.4, texRing, 66, new Vec3(0, 0, 0));
    // 多普勒增亮侧(固定在世界 +X 一侧,不随盘旋转)
    addBillboard('DopplerGlow', 7.0, texBlob, 64, new Vec3(4.1, 0.15, 1.4), 0.62);

    // --- 星流(dynamic mesh,240 个拖尾四边形) ----------------------------
    {
        const count = STAR_STREAM_COUNT;
        refs.particles = createParticles(count);
        const positions = new Float32Array(count * 4 * 3);
        const uvs = new Float32Array(count * 4 * 2);
        const indices = new Uint16Array(count * 6);
        for (let i = 0; i < count; i++) {
            const b = i * 4;
            // 头部在 V=0,尾端在 V=1
            uvs[b * 2] = 0; uvs[b * 2 + 1] = 0;
            uvs[b * 2 + 2] = 1; uvs[b * 2 + 3] = 0;
            uvs[b * 2 + 4] = 1; uvs[b * 2 + 5] = 1;
            uvs[b * 2 + 6] = 0; uvs[b * 2 + 7] = 1;
            indices[i * 6] = b;
            indices[i * 6 + 1] = b + 1;
            indices[i * 6 + 2] = b + 2;
            indices[i * 6 + 3] = b;
            indices[i * 6 + 4] = b + 2;
            indices[i * 6 + 5] = b + 3;
        }
        refs.streamPositions = positions;
        refs.streamUVs = uvs;
        refs.streamIndices = indices;
        const node = new Node('StarStream');
        node.layer = Layers.Enum.DEFAULT;
        scene.addChild(node);
        const renderer = node.addComponent(MeshRenderer);
        const dynMesh = utils.MeshUtils.createDynamicMesh(
            0,
            { positions, uvs, indices, primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST },
            undefined,
            { maxSubMeshes: 1, maxSubMeshVertices: 1024, maxSubMeshIndices: 2048 },
        );
        renderer.mesh = dynMesh;
        renderer.setSharedMaterial(makeUnlitMaterial({
            texture: texStream,
            color: new Vec4(1, 1, 1, 1),
            states: additiveStates(58),
        }), 0);
        refs.streamMesh = dynMesh;
        refs.streamRenderer = renderer;
    }

    // --- 动画组件 ---------------------------------------------------------
    const animatorNode = new Node('Animator');
    scene.addChild(animatorNode);
    animatorNode.addComponent(SceneAnimator);

    window.__airApp = app;
    app.run(scene);

    // 首帧之后:初始化星流顶点(设备已就绪)并置 ready
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!state.ready) {
            // 相机基向量就绪后写入首帧星流数据
            updateCameraBasis();
            updateStreamGeometry(0);
            refs.streamReady = true;
            state.ready = true;
            if (!window.__appReady) window.__appReady = true;
        }
    });

    // --- 滚轮缩放(引擎 canvas 会吞掉鼠标事件,故在 window 捕获阶段监听) --
    const onWheel = (e) => {
        if (e.ctrlKey) return; // 触控板捏合交给浏览器
        const dy = typeof e.deltaY === 'number' ? e.deltaY : 0;
        if (!dy) return;
        if (e.cancelable) e.preventDefault();
        const next = state.cameraTarget * Math.exp(dy * 0.0012);
        state.cameraTarget = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, next));
    };
    // 只挂 window 捕获阶段:目标为 canvas 的合成事件在捕获阶段同样会经过 window,
    // 挂两处会让同一事件被应用两次(缩放跳变)。
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });

    // --- UI:唯一 data-ui="reset" 按钮(右上角,归一化 x>0.8,y<0.25) ------
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;padding:5px 14px;' +
        'font:12px/1.4 system-ui,sans-serif;background:rgba(20,24,32,.85);color:#dfe8ff;' +
        'border:1px solid rgba(120,160,255,.5);border-radius:5px;cursor:pointer';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);

    console.log('[e05] black hole scene ready — stars', BACKGROUND_STAR_COUNT, 'stream', STAR_STREAM_COUNT);
    // 自检诊断入口(只读材质快照,不影响画面/状态)
    window.__diag = {
        materials: () => refs.materials.map((m) => {
            try { return inspectAirMaterial(m); } catch (e) { return { error: String(e && e.message) }; }
        }),
    };
} catch (err) {
    console.error('[e05] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
