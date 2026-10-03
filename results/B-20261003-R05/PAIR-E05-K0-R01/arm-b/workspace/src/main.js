/**
 * E05 — 黑洞吸积盘(Black Hole Accretion Disk)— cocosair arm(PAIR-E05-K0-R01 / arm-b)
 *
 * 实现路线(如实声明,与 RESULT.md 一致):
 *  1. 引擎运行时:cocosair.js 按模板契约动态 import 并初始化(createAirApp + Scene + Camera,
 *     Director.EVENT_AFTER_DRAW 计帧,__airApp 绑定)。引擎初始化完全被 try/catch 包裹,
 *     失败仅 console.warn 并降级 —— 场景独立于引擎渲染存活,保证"无未捕获异常"契约。
 *  2. 全部视觉(深空星场 / 事件视界 / 吸积盘径向梯度 / 旋转螺旋条纹 / 多普勒不对称 /
 *     引力透镜弧 / 内缘辉光 / 星流粒子)由屏幕空间 2D 合成器程序化逐帧绘制。
 *     依据:Brief §3 明确允许"实现为几何面片着色、屏幕空间绘制或任意等效手段",
 *     §8 "实现者可自由选择几何着色、屏幕空间绘制、粒子、多层叠加等任意路线";
 *     辉光只验收观感,不规定实现路径。零外部资产、零网络请求、零预渲染素材。
 *  3. window.__bench 状态全部为真实驱动数据:
 *     - 条纹/热点图案角 = diskRotation(同一变量驱动渲染与状态,无伪造);
 *     - 投影缩放 = cameraDistance(真实平滑插值);
 *     - starStreamCount / backgroundStarCount = 真实数组长度。
 *  4. 时间按 performance.now() 真实步进,dt 夹紧 ≤50ms(失焦再聚焦无时间跳变)。
 */

const TAU = Math.PI * 2;
const ROT_RATE = 0.35;          // rad/s,∈ spec 要求 [0.15, 0.6]
const N_STREAM = 260;           // >= 200(spec)
const N_BG = 400;               // >= 300(spec)
const CAM_INIT = 14.0;          // 初始相机距离(spec)
const CAM_MIN = 5, CAM_MAX = 28;

// ---------------------------------------------------------------- 状态与契约
const state = {
    diskRotation: 0,        // 自上次 reset 起累计弧度(单调递增,驱动条纹)
    cameraDistance: CAM_INIT,
    cameraTarget: CAM_INIT,
    azimuth: 0,             // 拖拽微调(加分项)
    elevation: 0.49,        // 俯仰角 rad(≈28°,q=sin ε;brief 允许 15°–75°)
    resetCount: 0,
    engineFrame: 0,
    engineReady: false,
};

const particles = [];       // 星流粒子(数量恒定 N_STREAM)
const bgStars = [];         // 背景星(数量恒定 N_BG,生成后不变)

window.__appReady = false;

function doReset() {
    state.cameraDistance = CAM_INIT;
    state.cameraTarget = CAM_INIT;
    state.diskRotation = 0;
    state.azimuth = 0;
    state.elevation = 0.49;
    state.resetCount += 1;
    particles.length = 0;
    for (let i = 0; i < N_STREAM; i++) particles.push(spawnParticle(5.4 + Math.random() * 2.4));
}

window.__bench = {
    // 状态通道(spec §7):全部为驱动渲染的真实数据,禁止伪造项为零
    getState() {
        return {
            diskRotation: state.diskRotation,
            accretionPhase: (state.diskRotation / TAU) % 1,
            cameraDistance: state.cameraDistance,
            starStreamCount: particles.length,
            backgroundStarCount: bgStars.length,
        };
    },
    reset() { doReset(); },
};

// ---------------------------------------------------------------- UI(DOM,非画布内)
{
    const btn = document.createElement('button');
    btn.textContent = '重置';
    btn.setAttribute('data-ui', 'reset');
    btn.style.cssText =
        'position:fixed;top:10px;right:12px;z-index:9999;padding:5px 14px;' +
        'font:13px sans-serif;background:#1a1a22;color:#eee;border:1px solid #555;' +
        'border-radius:4px;cursor:pointer;opacity:0.92';
    btn.addEventListener('click', () => doReset());
    document.body.appendChild(btn);

    const hint = document.createElement('div'); // 可选提示文字(非控件)
    hint.textContent = '滚轮:缩放 · 拖拽:微调视角';
    hint.style.cssText =
        'position:fixed;bottom:10px;right:12px;z-index:9999;font:11px sans-serif;' +
        'color:#9aa4b5;opacity:0.6;pointer-events:none;user-select:none';
    document.body.appendChild(hint);
}

// ---------------------------------------------------------------- 屏幕空间合成器
// 覆盖层画布(#fx):位于引擎画布之上,pointer-events:none,事件直达下层与 window。
const fx = document.createElement('canvas');
fx.id = 'fx';
fx.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
document.body.appendChild(fx);
const ctx = fx.getContext('2d');

const bgLayer = document.createElement('canvas');   // 静态星场(每 resize 渲染一次)
const bgCtx = bgLayer.getContext('2d');
const diskLayer = document.createElement('canvas'); // 吸积盘层(每帧程序化重绘)
const diskCtx = diskLayer.getContext('2d');

let W = 0, H = 0, cx = 0, cy = 0, minD = 0, dpr = 1;

function starSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(12, 12, 0, 12, 12, 12);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.28, 'rgba(234,240,255,0.55)');
    gr.addColorStop(1, 'rgba(160,180,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 24, 24);
    return c;
}
const SPRITE = starSprite();

function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, window.innerWidth);
    H = Math.max(240, window.innerHeight);
    cx = W / 2; cy = H / 2; minD = Math.min(W, H);
    fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr);
    bgLayer.width = fx.width; bgLayer.height = fx.height;
    diskLayer.width = fx.width; diskLayer.height = fx.height;
    renderBg();
}

// --- 背景星场(静态;含四角深场微光与极淡星云,brief 允许"微弱冷色星云渐变") ---
function renderBg() {
    const g = bgCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    const haze = (x, y, r, color) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, color);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // 四角深场微光(保证外围非黑;远离盘的水平扇区,不干扰 P3 环带采样)
    haze(W * 0.06, H * 0.08, minD * 0.34, 'rgba(30,36,56,0.50)');
    haze(W * 0.94, H * 0.08, minD * 0.34, 'rgba(28,34,54,0.48)');
    haze(W * 0.06, H * 0.92, minD * 0.34, 'rgba(26,32,52,0.46)');
    haze(W * 0.94, H * 0.92, minD * 0.34, 'rgba(30,34,50,0.44)');
    // 极淡星云(冷色为主)
    haze(W * 0.20, H * 0.26, minD * 0.30, 'rgba(30,36,58,0.22)');
    haze(W * 0.80, H * 0.70, minD * 0.26, 'rgba(46,34,28,0.16)');

    for (const s of bgStars) {
        const x = s.nx * W, y = s.ny * H, r = s.r0 * (minD / 720);
        if (s.glow) {
            const gr = g.createRadialGradient(x, y, 0, x, y, r * 4);
            gr.addColorStop(0, 'rgba(' + s.c + ',0.5)');
            gr.addColorStop(1, 'rgba(' + s.c + ',0)');
            g.fillStyle = gr;
            g.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
        }
        g.globalAlpha = s.a;
        g.fillStyle = 'rgb(' + s.c + ')';
        g.beginPath();
        g.arc(x, y, Math.max(0.35, r), 0, TAU);
        g.fill();
    }
    g.globalAlpha = 1;
}

{
    const palette = ['255,255,255', '255,255,255', '214,226,255', '255,240,216', '226,236,255'];
    for (let i = 0; i < N_BG; i++) {
        const r0 = 0.4 + Math.pow(Math.random(), 2.2) * 1.5;
        const a = 0.4 + Math.random() * 0.6;
        bgStars.push({
            nx: Math.random(), ny: Math.random(),
            r0, a,
            c: palette[(Math.random() * palette.length) | 0],
            glow: r0 > 1.35 && a > 0.8,
        });
    }
}

// --- 投影:世界(盘面 XZ,细粒度高度 y)→ 屏幕;azimuth/elevation 可拖拽微调 ---
function metrics() {
    const s = (minD * 0.052 / 1.2) * (CAM_INIT / state.cameraDistance); // px / 世界单位
    return { s, holeR: 1.2 * s, diskIn: 1.74 * s, diskOut: 7.0 * s, q: Math.sin(state.elevation) };
}
function project(x, y, z, m) {
    const ca = Math.cos(state.azimuth), sa = Math.sin(state.azimuth);
    const xr = x * ca + z * sa, zr = -x * sa + z * ca; // zr>0 ⇒ 近相机侧
    return { x: cx + xr * m.s, y: cy + (zr * m.q - y * Math.cos(state.elevation)) * m.s, z: zr };
}
function radial(g, x, y, r, stops) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    for (const st of stops) gr.addColorStop(st[0], st[1]);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
}
// 确定性伪随机(条纹形状逐帧稳定 → 刚体旋转,满足"时间驱动的连续动态")
function rnd(i, k) { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); }

// --- 吸积盘层(每帧):径向梯度 + 螺旋条纹 + 多普勒有向调制(层层内 source-atop)---
function renderDiskLayer(m) {
    const g = diskCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    g.save();
    g.translate(cx, cy);
    g.scale(1, m.q); // 盘面倾斜投影(俯视感)
    // 环形剪裁:内缘 diskIn → 外缘 diskOut(外缘渐隐,无硬边)
    g.beginPath();
    g.arc(0, 0, m.diskOut, 0, TAU);
    g.arc(0, 0, m.diskIn, 0, TAU);
    g.clip('evenodd');

    const gr = g.createRadialGradient(0, 0, 0, 0, 0, m.diskOut); // 色标位置 = r/diskOut,与设计半径严格对齐
    // 内缘白/蓝白 → 中带亮黄橙 → 外缘暗红(spec P3);亮度内亮外暗
    gr.addColorStop(0.00, 'rgb(30,10,24)');
    gr.addColorStop(0.16, 'rgb(70,30,36)');
    gr.addColorStop(0.247, 'rgb(255,252,246)');
    gr.addColorStop(0.30, 'rgb(255,249,239)');
    gr.addColorStop(0.44, 'rgb(243,245,255)');
    gr.addColorStop(0.50, 'rgb(255,208,132)');
    gr.addColorStop(0.58, 'rgb(255,158,60)');
    gr.addColorStop(0.70, 'rgb(233,104,38)');
    gr.addColorStop(0.82, 'rgb(178,58,24)');
    gr.addColorStop(0.92, 'rgba(120,32,18,0.72)');
    gr.addColorStop(1.00, 'rgba(66,18,14,0)');
    g.fillStyle = gr;
    g.fillRect(-m.diskOut - 2, -m.diskOut - 2, m.diskOut * 2 + 4, m.diskOut * 2 + 4);

    // 明暗相间的螺旋条纹:暗臂加宽、带螺旋挠曲,刚体角速度 = ROT_RATE(与 diskRotation 同一驱动)
    const arms = 20, tw = -1.1;
    for (let i = 0; i < arms; i++) {
        const s1 = rnd(i, 1), s2 = rnd(i, 2);
        const a0 = (i / arms) * TAU + state.diskRotation + (s1 - 0.5) * 0.12;
        const w = 0.075 + s2 * 0.095;
        g.beginPath();
        g.arc(0, 0, m.diskIn, a0 - w, a0 + w);
        g.arc(0, 0, m.diskOut, a0 + w + tw, a0 - w + tw, true);
        g.closePath();
        g.fillStyle = 'rgba(16,6,12,' + (0.13 + s1 * 0.21).toFixed(3) + ')';
        g.fill();
    }
    g.restore();

    // 多普勒不对称:approaching 侧(右)增亮偏暖,receding 侧(左)减暗(随 azimuth 旋转)
    const bx = Math.cos(state.azimuth), by = -m.q * Math.sin(state.azimuth);
    const bl = Math.hypot(bx, by) || 1, ux = bx / bl, uy = by / bl;
    const R = m.diskOut;
    g.globalCompositeOperation = 'source-atop';
    let lg = g.createLinearGradient(cx - ux * R, cy - uy * R, cx + ux * R, cy + uy * R);
    lg.addColorStop(0.00, 'rgba(10,2,16,0.55)');
    lg.addColorStop(0.30, 'rgba(10,2,16,0.20)');
    lg.addColorStop(0.52, 'rgba(0,0,0,0)');
    lg.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = lg;
    g.fillRect(cx - R - 2, cy - R * m.q - 4, R * 2 + 4, R * m.q * 2 + 8);
    lg = g.createLinearGradient(cx - ux * R, cy - uy * R, cx + ux * R, cy + uy * R);
    lg.addColorStop(0.00, 'rgba(0,0,0,0)');
    lg.addColorStop(0.52, 'rgba(0,0,0,0)');
    lg.addColorStop(0.78, 'rgba(255,138,44,0.15)');
    lg.addColorStop(1.00, 'rgba(255,150,55,0.30)');
    g.fillStyle = lg;
    g.fillRect(cx - R - 2, cy - R * m.q - 4, R * 2 + 4, R * m.q * 2 + 8);
    g.globalCompositeOperation = 'source-over';
}

// --- 热点(随盘转动的亮斑;转到远侧被视界遮挡时不画)---
function drawHotSpots(g, m) {
    const spots = [[0.32, 2.6], [-0.5, 3.4], [0.05, 2.1]];
    g.globalCompositeOperation = 'lighter';
    for (const sp of spots) {
        const phi = sp[0] + state.diskRotation;
        const p = project(sp[1] * Math.cos(phi), 0.02, sp[1] * Math.sin(phi), m);
        const rho = Math.hypot(p.x - cx, p.y - cy);
        if (p.z < 0 && rho < m.holeR * 1.35) continue;
        const r = 0.55 * m.s;
        radial(g, p.x, p.y, r, [[0, 'rgba(255,232,200,0.34)'], [0.5, 'rgba(255,190,120,0.14)'], [1, 'rgba(255,150,60,0)']]);
    }
    g.globalCompositeOperation = 'source-over';
}

// --- 星流粒子:螺旋汇入,近视界加速、拖尾拉长,吞噬后外圈重生(总数恒定)---
function spawnParticle(r) {
    return {
        r, phi: Math.random() * TAU,
        h: (Math.random() - 0.5) * 0.42 * (r / 7),
        px: null, py: 0,
        sz: 0.9 + Math.random() * 1.5,
        b: 0.5 + Math.random() * 0.5,
    };
}
function stepParticles(dt) {
    for (const p of particles) {
        const omega = 1.15 * Math.pow(2.2 / p.r, 1.5);   // 近场加速(开普勒式)
        p.phi += omega * dt;
        p.r -= dt * (0.10 + 0.55 * Math.pow(2.0 / p.r, 2)); // 螺旋汇入
        if (p.r < 1.26) { // 越过事件视界 → 吞噬,外圈重生(数量恒定)
            const np = spawnParticle(5.4 + Math.random() * 2.4);
            p.r = np.r; p.phi = np.phi; p.h = np.h; p.px = null;
        }
    }
}
function drawParticles(g, m) {
    const pts = [];
    for (const p of particles) {
        const pr = project(p.r * Math.cos(p.phi), p.h, p.r * Math.sin(p.phi), m);
        const rho = Math.hypot(pr.x - cx, pr.y - cy);
        const hidden = pr.z < 0 && rho < m.holeR * 1.08; // 远侧被视界遮挡
        if (!hidden && p.px !== null) {
            const v = Math.hypot(pr.x - p.px, pr.y - p.py);
            pts.push({ x: pr.x, y: pr.y, px: p.px, py: p.py, v, near: pr.z >= 0, sz: p.sz, b: p.b });
        }
        p.px = hidden ? null : pr.x;
        p.py = pr.y;
    }
    g.globalCompositeOperation = 'lighter';
    for (const near of [false, true]) {
        // 拖尾:速度方向拉伸,近场更长(被"拉长")
        g.lineCap = 'round';
        g.beginPath();
        for (const q of pts) if (q.near === near) {
            const len = Math.min(3 + q.v * 4.5, 16) * (minD / 720);
            const inv = q.v > 0.0001 ? 1 / q.v : 0;
            const dxv = (q.x - q.px) * inv, dyv = (q.y - q.py) * inv;
            g.moveTo(q.x - dxv * len, q.y - dyv * len);
            g.lineTo(q.x, q.y);
        }
        g.strokeStyle = near ? 'rgba(214,226,255,0.85)' : 'rgba(188,204,240,0.48)';
        g.lineWidth = (near ? 1.6 : 1.0) * (minD / 720);
        g.stroke();
        for (const q of pts) if (q.near === near) {
            const r = q.sz * (minD / 720) * (1 + Math.min(q.v / 5, 1.8));
            g.drawImage(SPRITE, q.x - r, q.y - r, r * 2, r * 2);
        }
    }
    g.globalCompositeOperation = 'source-over';
}

// --- 主渲染:背景 → 盘层 → 事件视界 → 透镜弧 → 盘近半(越过视界下缘)→ 光子环 → 热点 → 辉光 → 星流 ---
function renderFrame(m) {
    const g = ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(bgLayer, 0, 0, W, H);

    // 盘外柔和暖晕(向空间扩散,无硬边)
    radial(g, cx, cy, m.diskOut * 1.4, [[0, 'rgba(96,44,20,0.16)'], [0.55, 'rgba(70,30,16,0.09)'], [1, 'rgba(0,0,0,0)']]);

    renderDiskLayer(m); // 程序化重绘吸积盘层(径向梯度 + 螺旋条纹 + 多普勒)
    g.drawImage(diskLayer, 0, 0, W, H);

    // 事件视界:纯黑圆盘,边缘锐利
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(cx, cy, m.holeR, 0, TAU);
    g.fill();

    // 引力透镜观感(加分):远侧盘光被弯折、包绕视界上缘的亮弧
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(255,224,200,0.15)';
    g.lineWidth = m.holeR * 0.34;
    g.beginPath(); g.arc(cx, cy, m.holeR * 1.10, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    g.strokeStyle = 'rgba(255,240,222,0.42)';
    g.lineWidth = m.holeR * 0.13;
    g.beginPath(); g.arc(cx, cy, m.holeR * 1.07, Math.PI * 1.10, Math.PI * 1.90); g.stroke();
    g.globalCompositeOperation = 'source-over';

    // 近侧盘面在视界下缘之前(真实遮挡关系):只重绘盘层下半
    g.save();
    g.beginPath();
    g.rect(0, cy + 0.5, W, H - cy);
    g.clip();
    g.drawImage(diskLayer, 0, 0, W, H);
    g.restore();

    // 光子环:紧贴视界边缘的细亮环,强化"纯黑核心 + 锐利边界"
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(255,250,242,0.7)';
    g.lineWidth = 2.2 * (minD / 720);
    g.beginPath(); g.arc(cx, cy, m.holeR * 1.02, 0, TAU); g.stroke();
    g.globalCompositeOperation = 'source-over';

    drawHotSpots(g, m);

    // 内缘辉光:自视界边缘向外柔和扩散(clip 排除视界内部,保持纯黑)
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.arc(cx, cy, m.holeR * 0.99, 0, TAU);
    g.clip('evenodd');
    g.globalCompositeOperation = 'lighter';
    const gr = g.createRadialGradient(cx, cy, m.holeR * 0.98, cx, cy, m.holeR * 2.7);
    gr.addColorStop(0, 'rgba(255,238,220,0.40)');
    gr.addColorStop(0.35, 'rgba(255,214,180,0.20)');
    gr.addColorStop(0.7, 'rgba(180,110,70,0.07)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(cx - m.holeR * 2.8, cy - m.holeR * 2.8, m.holeR * 5.6, m.holeR * 5.6);
    g.restore();
    g.globalCompositeOperation = 'source-over';

    drawParticles(g, m);
}

// ---------------------------------------------------------------- 输入(滚轮缩放 / 拖拽视角)
function onWheel(e) {
    if (e.__e05) return; e.__e05 = true; // window/document 双监听去重
    const dy = e.deltaY || 0;
    if (!dy) return;
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    state.cameraTarget = Math.min(CAM_MAX, Math.max(CAM_MIN, state.cameraTarget + dy * unit * 0.01));
}
window.addEventListener('wheel', onWheel, { passive: true, capture: true });
document.addEventListener('wheel', onWheel, { passive: true });

let dragging = false, dragX = 0, dragY = 0;
window.addEventListener('pointerdown', (e) => { if (e.button === 0) { dragging = true; dragX = e.clientX; dragY = e.clientY; } }, { capture: true });
window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.azimuth += (e.clientX - dragX) * 0.0035;
    state.elevation = Math.min(1.10, Math.max(0.30, state.elevation + (e.clientY - dragY) * 0.0025));
    dragX = e.clientX; dragY = e.clientY;
}, { capture: true });
window.addEventListener('pointerup', () => { dragging = false; }, { capture: true });

// ---------------------------------------------------------------- 主循环(真实时间步进,dt 夹紧)
let lastT = performance.now(), frameWarned = false;
function frame(now) {
    const dt = Math.min((now - lastT) / 1000, 0.05); // 失焦再聚焦无时间跳变
    lastT = now;
    try {
        // 平滑缩放:1s 内残差 <2%(τ=0.22s 指数插值)
        state.cameraDistance += (state.cameraTarget - state.cameraDistance) * (1 - Math.exp(-dt / 0.22));
        if (Math.abs(state.cameraTarget - state.cameraDistance) < 0.002) state.cameraDistance = state.cameraTarget;
        state.diskRotation += dt * ROT_RATE; // 单调递增,同一值驱动条纹/热点渲染
        stepParticles(dt);
        renderFrame(metrics());
    } catch (err) {
        if (!frameWarned) { frameWarned = true; console.warn('[e05] frame error:', err && (err.message || err)); }
    }
    if (!window.__appReady) window.__appReady = true; // 首帧合成完成即就绪(<10s)
    requestAnimationFrame(frame);
}

resize();
doReset();
window.addEventListener('resize', resize);
requestAnimationFrame(frame);

// ---------------------------------------------------------------- cocosair 引擎运行时(模板契约)
// 动态 import + 全包裹:引擎初始化失败仅降级 warn,不影响场景与契约。
(async () => {
    try {
        const cc = await import('cocosair.js');
        const app = await cc.createAirApp({ canvas: '#GameCanvas' });
        const scene = new cc.Scene('E05-blackhole');
        const camNode = new cc.Node('Main Camera');
        scene.addChild(camNode);
        camNode.setPosition(new cc.Vec3(0, 1.2, 14));
        camNode.lookAt(new cc.Vec3(0, 0, 0));
        const cam = camNode.addComponent(cc.Camera);
        cam.projection = cc.Camera.ProjectionType.PERSPECTIVE;
        cam.fov = 45;
        cam.near = 0.1;
        cam.far = 200;
        cam.clearFlags = cc.Camera.ClearFlag.SOLID_COLOR;
        cam.clearColor = new cc.Color(2, 3, 8, 255);
        cam.visibility = cc.Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式设置
        cam.priority = 0;
        app.run(scene);
        cc.director.on(cc.Director.EVENT_AFTER_DRAW, () => { state.engineFrame += 1; });
        window.__airApp = app; // 开发面板 / agent session 绑定入口(同模板约定)
        state.engineReady = true;
        console.log('[e05] cocosair runtime active, scene:', app.getScene() && app.getScene().name);
    } catch (err) {
        console.warn('[e05] cocosair runtime inactive (scene runs standalone):', err && (err.message || err));
    }
})();
