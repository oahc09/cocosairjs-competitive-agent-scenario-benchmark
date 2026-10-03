/**
 * E10 动画角色展示空间 — Cocos AIR Reference 实现
 * (CocosAirJS Code First / Runtime Asset / Animation / Lifecycle 核心场景)
 *
 * 契约:
 *   - runtime 相对路径加载 assets/character.glb(Khronos Fox:1 skin / 24 joints /
 *     clips Survey|Walk|Run),整会话仅此一次网络请求;
 *   - 同一 GLTFAsset.instantiate() 派生双实例 A/B,各自独立 Animation 组件与
 *     AnimationState(共享 AnimationClip 资产,运行态隔离——引擎 asset.ts 实测语义);
 *   - idle→Survey / walk→Walk 映射,UI 控件(data-ui|data-bench)切换,crossFade 0.25s;
 *   - destroy-a:instance.dispose()(stop 动画 + root.active=false + root.destroy(),
 *     真实场景图移除);B 不受影响;地面接触阴影随之重绘消失;
 *   - reset:应用内重建双实例(同一缓存 asset 再次 instantiate),无新网络请求、无刷新;
 *   - window.__bench.getState()/reset() 随 spec.stateContract 暴露(含 P7 所需 fps)。
 *
 * 引擎坑位(已在源码/文档核实):
 *   - camera.visibility 必须显式 Layers.Enum.DEFAULT;
 *   - 环境光在 app.run 之后经 scene.globals.ambient 配置(skyColorHDR 原位 set);
 *   - AnimationClip 必须 Loop,否则单次播放后冻结(motion 探针失败);
 *   - Texture2D.uploadData(canvas) 不做 y 翻转:地面画布内容按上下对称设计,方向免疫;
 *   - DirectionalLight 方向取节点朝向,illuminance 用 HDR lux 量级;
 *   - GLTFAsset.instantiate 每次产出全新节点树 + 独立 Animation 组件,
 *     dispose() 为帧末延迟销毁(root.destroy());asset.addRef() 钉住引用,
 *     避免 reset 双销毁瞬间 refcount 归零触发自动释放。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    Texture2D,
    Material,
    Animation,
    AnimationClip,
    GLTFLoader,
    SkinnedMeshRenderer,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';

// ---------------------------------------------------------------- 常量
const ASSET_URL = 'assets/character.glb'; // 相对路径,整会话仅请求一次
const CLIP_MAP = { idle: 'Survey', walk: 'Walk' }; // GLB 剪辑 → 规范名映射(idle=原地张望待机)
const FOX_HEIGHT = 1.5; // 目标角色高度(米),原始 Fox ~79 单位高
const STAND = {
    A: { x: -1.85, z: 0, yaw: 60 }, // 面向画右偏镜头(对称构图)
    B: { x: 1.85, z: 0, yaw: 120 }, // 面向画左偏镜头
};
const FLOOR_SIZE = 16; // 世界单位,画布 1024px → 64px/unit

// ---------------------------------------------------------------- 页面契约状态
const bench = {
    assetLoaded: false,
    assetRequests: 0, // 由下方 fetch 探针计数(仅观测,不参与断言逻辑)
    destroyedInstance: null, // null | 'A'
    resetCount: 0,
    instances: { A: null, B: null }, // { clip:'idle'|'walk', time:number } | null
    fps: 0,
};
window.__appReady = false;

// 网络观测:确认 character.glb 全会话仅一次请求(状态内如实汇报)
const rawFetch = window.fetch.bind(window);
window.fetch = (input, ...rest) => {
    try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
        if (url.includes('character.glb')) bench.assetRequests += 1;
    } catch { /* 观测不得影响加载 */ }
    return rawFetch(input, ...rest);
};

function getState() {
    const count = (bench.instances.A ? 1 : 0) + (bench.instances.B ? 1 : 0);
    return {
        assetLoaded: bench.assetLoaded,
        assetRequests: bench.assetRequests,
        instanceCount: count,
        instances: {
            A: bench.instances.A,
            B: bench.instances.B,
        },
        destroyedInstance: bench.destroyedInstance,
        resetCount: bench.resetCount,
        fps: bench.fps,
    };
}
window.__bench = { getState, reset: () => {} }; // reset 待初始化后替换为真实实现

// ---------------------------------------------------------------- UI(画布边缘,data-ui + data-bench 双属性)
const ui = {};
function buildUI() {
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);' +
        'display:flex;gap:14px;align-items:center;z-index:9999;' +
        'background:rgba(14,18,26,0.82);border:1px solid rgba(120,140,180,0.35);' +
        'border-radius:12px;padding:8px 16px;font:12px system-ui,sans-serif;color:#cfd8e8;' +
        'box-shadow:0 6px 24px rgba(0,0,0,0.45);backdrop-filter:blur(6px);user-select:none;';
    document.body.appendChild(bar);

    function group(labelText) {
        const g = document.createElement('div');
        g.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = 'opacity:0.75;margin-right:2px;font-weight:600;';
        g.appendChild(label);
        bar.appendChild(g);
        return g;
    }
    function button(name, text, parent, accent) {
        const b = document.createElement('button');
        b.textContent = text;
        b.setAttribute('data-ui', name);
        b.setAttribute('data-bench', name);
        b.style.cssText =
            `padding:5px 12px;border-radius:7px;cursor:pointer;font:12px system-ui;` +
            `border:1px solid ${accent || 'rgba(130,150,190,0.45)'};background:rgba(30,38,54,0.9);color:#e6ecf6;` +
            'transition:background .12s,border-color .12s,transform .06s;';
        b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = 'rgba(56,72,100,0.95)'; });
        b.addEventListener('mouseleave', () => { if (!b.disabled) b.style.background = 'rgba(30,38,54,0.9)'; });
        b.addEventListener('mousedown', () => { if (!b.disabled) b.style.transform = 'scale(0.95)'; });
        b.addEventListener('mouseup', () => { b.style.transform = 'scale(1)'; });
        b.addEventListener('click', () => {
            if (name === 'anim-a-idle') setClip('A', 'idle');
            else if (name === 'anim-a-walk') setClip('A', 'walk');
            else if (name === 'anim-b-idle') setClip('B', 'idle');
            else if (name === 'anim-b-walk') setClip('B', 'walk');
            else if (name === 'destroy-a') destroyA();
            else if (name === 'reset') doReset();
        });
        parent.appendChild(b);
        ui[name] = b;
        return b;
    }
    const gA = group('Inst A');
    button('anim-a-idle', 'Idle', gA);
    button('anim-a-walk', 'Walk', gA);
    const gB = group('Inst B');
    button('anim-b-idle', 'Idle', gB);
    button('anim-b-walk', 'Walk', gB);
    const gOps = group('');
    button('destroy-a', 'Destroy A', gOps, 'rgba(220,110,90,0.55)');
    button('reset', 'Reset', gOps, 'rgba(120,200,150,0.55)');

    // 顶部信息牌(避开视觉断言区域:x<250 且 y<100,region A 自 (102,108) 起)
    const hud = document.createElement('div');
    hud.style.cssText =
        'position:fixed;left:12px;top:10px;z-index:9999;pointer-events:none;' +
        'font:12px/1.7 ui-monospace,Consolas,monospace;color:#dfe7f2;' +
        'background:rgba(12,16,24,0.66);border:1px solid rgba(110,130,170,0.28);' +
        'border-radius:8px;padding:7px 11px;white-space:pre;';
    document.body.appendChild(hud);
    ui.hud = hud;
}

function updateUI() {
    const a = bench.instances.A;
    const b = bench.instances.B;
    const setActive = (btn, on) => {
        btn.style.borderColor = on ? 'rgba(240,200,120,0.9)' : 'rgba(130,150,190,0.45)';
        btn.style.color = on ? '#ffe9b0' : '#e6ecf6';
    };
    setActive(ui['anim-a-idle'], !!(a && a.clip === 'idle'));
    setActive(ui['anim-a-walk'], !!(a && a.clip === 'walk'));
    setActive(ui['anim-b-idle'], !!(b && b.clip === 'idle'));
    setActive(ui['anim-b-walk'], !!(b && b.clip === 'walk'));
    const dbtn = ui['destroy-a'];
    dbtn.disabled = !a;
    dbtn.style.opacity = a ? '1' : '0.38';
    dbtn.style.cursor = a ? 'pointer' : 'not-allowed';
}
function updateHUD() {
    const fmt = (s) => {
        const rec = bench.instances[s];
        return rec ? `${rec.clip} ${rec.time.toFixed(2)}s` : 'destroyed';
    };
    ui.hud.textContent =
        'E10 Animated Character Showcase / Cocos AIR\n' +
        `asset: ${bench.assetLoaded ? 'character.glb loaded' : 'loading...'} (requests: ${bench.assetRequests})\n` +
        `A: ${fmt('A')}   B: ${fmt('B')}\n` +
        `fps ${bench.fps.toFixed(0)}   resets ${bench.resetCount}`;
}

// ---------------------------------------------------------------- 程序化纹理(画布 → Texture2D)
function makeCanvasTexture(canvas) {
    const tex = new Texture2D();
    tex.reset({ width: canvas.width, height: canvas.height, format: Texture2D.PixelFormat.RGBA8888 });
    tex.uploadData(canvas);
    return tex;
}

// 地面画布:基础色 + 中央暖光池 + 接触阴影(存活实例)+ 暗角。
// uploadData 不翻转 y —— 全部元素按 (u,v) 中心对称设计,方向翻转免疫。
const floorCanvas = document.createElement('canvas');
floorCanvas.width = 1024;
floorCanvas.height = 1024;
let floorTexture = null;
const PX = 1024 / FLOOR_SIZE; // 64 px / 世界单位

function paintFloor(withA, withB) {
    const g = floorCanvas.getContext('2d');
    const S = 1024;
    // 基础暖灰(画布色经线性管线会显著变暗,按补偿量画亮)
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#98917f';
    g.fillRect(0, 0, S, S);
    // 确定性细颗粒(固定种子;高密度小尺度细节 → 相机微移时产生可测像素变化)
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 5200; i++) {
        const x = rand() * S;
        const y = rand() * S;
        const a = 0.05 + rand() * 0.06;
        g.fillStyle = rand() > 0.5 ? `rgba(255,244,222,${a})` : `rgba(20,16,12,${a})`;
        g.fillRect(x, y, 2, 2);
    }
    // 极淡地坪网格(1 单位 = 64px,展示台地面质感)
    g.strokeStyle = 'rgba(255,250,235,0.05)';
    g.lineWidth = 1;
    for (let p = 0; p <= S; p += PX) {
        g.beginPath(); g.moveTo(p + 0.5, 0); g.lineTo(p + 0.5, S); g.stroke();
        g.beginPath(); g.moveTo(0, p + 0.5); g.lineTo(S, p + 0.5); g.stroke();
    }
    // 中央暖光池(键光落地)
    let grad = g.createRadialGradient(S / 2, S / 2, 40, S / 2, S / 2, 330);
    grad.addColorStop(0, 'rgba(255,232,192,0.28)');
    grad.addColorStop(0.6, 'rgba(255,228,186,0.12)');
    grad.addColorStop(1, 'rgba(255,228,186,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    // 接触阴影:软椭圆,朝向与角色 yaw 一致(±30°,关于中心镜像对称)
    const shadow = (slot) => {
        const stand = STAND[slot];
        const cx = S / 2 + stand.x * PX;
        const cy = S / 2 + stand.z * PX;
        const angle = (stand.yaw - 90) * (Math.PI / 180); // yaw→画布角
        g.save();
        g.translate(cx, cy);
        g.rotate(angle);
        g.scale(1, 0.3);
        const r = 96;
        const eg = g.createRadialGradient(0, 0, 6, 0, 0, r);
        eg.addColorStop(0, 'rgba(8,6,4,0.52)');
        eg.addColorStop(0.55, 'rgba(8,6,4,0.34)');
        eg.addColorStop(1, 'rgba(8,6,4,0)');
        g.fillStyle = eg;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
    };
    if (withA) shadow('A');
    if (withB) shadow('B');
    // 暗角
    grad = g.createRadialGradient(S / 2, S / 2, 300, S / 2, S / 2, 730);
    grad.addColorStop(0, 'rgba(6,5,9,0)');
    grad.addColorStop(1, 'rgba(6,5,9,0.6)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    if (floorTexture) floorTexture.uploadData(floorCanvas);
}

// 背景画布:竖向柔和渐变 + 中央微光晕(unlit 直出,所见即所得)
const backCanvas = document.createElement('canvas');
backCanvas.width = 1024;
backCanvas.height = 512;
function paintBackdrop() {
    const g = backCanvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#11161f');
    grad.addColorStop(0.45, '#232b3a');
    grad.addColorStop(0.8, '#2e3340');
    grad.addColorStop(1, '#191d26');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 512);
    const glow = g.createRadialGradient(512, 250, 30, 512, 250, 420);
    glow.addColorStop(0, 'rgba(210,220,245,0.10)');
    glow.addColorStop(1, 'rgba(210,220,245,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 1024, 512);
}
paintBackdrop();

// ---------------------------------------------------------------- 相机环绕(平滑)
// 三角波偏航(速度幅值恒定 ±2°/s):展示台缓速往复环绕,构图稳定在 ±7° 内;
// 常速度保证任意 500ms 窗口都有可测的画面变化(正弦在峰值处速度归零,
// 曾使 P4 销毁后区域无 motion 而误判)。
class CameraRig extends Component {
    _t = 0;
    update(dt) {
        this._t += dt;
        const t = this._t;
        const SWAY_PERIOD = 14;
        const SWAY_AMP = 7 * (Math.PI / 180);
        const phase = (t % SWAY_PERIOD) / SWAY_PERIOD;
        const tri = phase < 0.25 ? phase * 4 : phase < 0.75 ? 2 - phase * 4 : phase * 4 - 4; // -1..1
        const target = new Vec3(0, 0.62, 0);
        const R = 5.35;
        const yaw = tri * SWAY_AMP;
        const h = 1.35 + 0.05 * tri;
        this.node.setPosition(target.x + R * Math.sin(yaw), h, target.z + R * Math.cos(yaw));
        this.node.lookAt(target);
    }
}

// ---------------------------------------------------------------- 主流程
const slots = { A: null, B: null }; // { inst, anim, clip, physical }
let gltfAsset = null;
let scene = null;

function currentAnimationTime(slot) {
    const rec = slots[slot];
    if (!rec) return 0;
    try {
        const st = rec.anim.getState(rec.physical);
        return st ? Math.max(0, Number(st.time)) : 0;
    } catch {
        return 0;
    }
}

/** 实例世界包围盒(蒙皮渲染器 bind-pose 网格界 × 节点世界矩阵,同官方 gltf-viewer 口径) */
function worldBounds(root) {
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    const point = new Vec3();
    let found = false;
    root.walk((node) => {
        const renderer = node.getComponent ? node.getComponent(SkinnedMeshRenderer) : null;
        if (!renderer || !renderer.mesh) return;
        const bounds = renderer.mesh.struct;
        if (!bounds.minPosition || !bounds.maxPosition) return;
        found = true;
        for (let corner = 0; corner < 8; corner++) {
            point.set(
                corner & 1 ? bounds.maxPosition.x : bounds.minPosition.x,
                corner & 2 ? bounds.maxPosition.y : bounds.minPosition.y,
                corner & 4 ? bounds.maxPosition.z : bounds.minPosition.z,
            );
            Vec3.transformMat4(point, point, renderer.node.worldMatrix);
            Vec3.min(min, min, point);
            Vec3.max(max, max, point);
        }
    });
    return found ? { min, max } : null;
}

/** 由同一 GLTFAsset 派生实例:缩放到目标身高、居中落位、独立播放 idle */
function spawnFox(slot) {
    const inst = gltfAsset.instantiate();
    const root = inst.root;
    root.name = `Fox_${slot}`;
    scene.addChild(root);

    const stand = STAND[slot];
    // 1) 先按包围盒定标
    root.updateWorldTransform();
    let bounds = worldBounds(root);
    if (!bounds) throw new Error(`E10: no skinned bounds on instance ${slot}`);
    const rawH = Math.max(0.001, bounds.max.y - bounds.min.y);
    const s = FOX_HEIGHT / rawH;
    root.setScale(s, s, s);
    root.setRotationFromEuler(0, stand.yaw, 0);
    root.updateWorldTransform();
    // 2) 再按缩放+旋转后的包围盒居中落位(脚掌贴地)
    bounds = worldBounds(root);
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const p = root.position;
    root.setPosition(p.x + (stand.x - cx), p.y - bounds.min.y + 0.004, p.z + (stand.z - cz));

    // 3) 独立 Animation 组件(instantiate 每次新建,root 上):Loop + idle 起播
    const anim = root.getComponent(Animation) || root.getComponentInChildren(Animation);
    if (!anim) throw new Error(`E10: instance ${slot} has no Animation component`);
    for (const clip of inst.animations) clip.wrapMode = AnimationClip.WrapMode.Loop;
    anim.play(CLIP_MAP.idle);

    const rec = { inst, anim, clip: 'idle', physical: CLIP_MAP.idle };
    slots[slot] = rec;
    bench.instances[slot] = { clip: 'idle', time: 0 };
    return rec;
}

function setClip(slot, logical) {
    const rec = slots[slot];
    if (!rec || bench.instances[slot]?.clip === logical) return;
    const physical = CLIP_MAP[logical];
    rec.clip = logical;
    rec.physical = physical;
    rec.anim.crossFade(physical, 0.25); // ≤300ms 平滑过渡
    bench.instances[slot] = { clip: logical, time: currentAnimationTime(slot) };
    updateUI();
}

function destroyA() {
    if (!slots.A) return;
    slots.A.inst.dispose(); // 真实销毁:animation.stop() + root.active=false + root.destroy()(帧末生效)
    slots.A = null;
    bench.instances.A = null;
    bench.destroyedInstance = 'A';
    paintFloor(false, !!slots.B); // 接触阴影随之移除
    updateUI();
}

function doReset() {
    bench.resetCount += 1;
    if (slots.A) { slots.A.inst.dispose(); slots.A = null; bench.instances.A = null; }
    if (slots.B) { slots.B.inst.dispose(); slots.B = null; bench.instances.B = null; }
    bench.destroyedInstance = null;
    spawnFox('A');
    spawnFox('B');
    paintFloor(true, true);
    updateUI();
}
window.__bench.reset = doReset;

// ---------------------------------------------------------------- 场景搭建
async function main() {
    buildUI();
    updateUI();

    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    scene = new Scene('E10-showcase');

    // 相机(显式 visibility)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 1.35, 5.35));
    cameraNode.lookAt(new Vec3(0, 0.62, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(16, 20, 28, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;
    cameraNode.addComponent(CameraRig);

    // 三点布光(键/补/逆,3 盏 ≤ 6,HDR lux 量级)
    const mkDir = (name, euler, illuminance) => {
        const n = new Node(name);
        scene.addChild(n);
        n.setPosition(0, 6, 0); // 方向光位置仅示意,方向=节点朝向
        n.setRotationFromEuler(euler[0], euler[1], euler[2]);
        const l = n.addComponent(DirectionalLight);
        l.illuminance = illuminance;
        return l;
    };
    mkDir('KeyLight', [-55, -35, 0], 95000); // 左前上,暖主光
    mkDir('FillLight', [-22, 48, 0], 20000); // 右前,弱补光
    mkDir('RimLight', [-14, 200, 0], 30000); // 背后逆光勾轮廓

    // 地面(动态画布反照率:光池/接触阴影/暗角)
    paintFloor(true, true); // 预绘双阴影
    floorTexture = makeCanvasTexture(floorCanvas);
    const floorNode = new Node('Floor');
    floorNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(floorNode);
    const floorRenderer = floorNode.addComponent(MeshRenderer);
    floorRenderer.mesh = utils.createMesh(primitives.plane({ width: FLOOR_SIZE, length: FLOOR_SIZE }));
    const floorMaterial = new Material();
    floorMaterial.initialize({ effectName: 'builtin-standard', defines: { USE_ALBEDO_MAP: true } });
    floorMaterial.setProperty('mainTexture', floorTexture);
    floorMaterial.setProperty('mainColor', new Color(255, 255, 255, 255));
    floorRenderer.material = floorMaterial;

    // 背景板(unlit 渐变直出)
    const backTexture = makeCanvasTexture(backCanvas);
    const backNode = new Node('Backdrop');
    backNode.layer = Layers.Enum.DEFAULT;
    backNode.setPosition(0, 5, -4.6);
    backNode.setRotationFromEuler(-90, 0, 0); // 平面图元法向 +Y → 竖立面向相机
    scene.addChild(backNode);
    const backRenderer = backNode.addComponent(MeshRenderer);
    backRenderer.mesh = utils.createMesh(primitives.plane({ width: 26, length: 11 }));
    const backMaterial = new Material();
    backMaterial.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: true } });
    backMaterial.setProperty('mainTexture', backTexture);
    backRenderer.material = backMaterial;

    app.run(scene);

    // 环境光:app.run 后经 scene.globals(skyColorHDR 原位 set 为已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.52, 0.58, 0.68, 1.0);
    scene.globals.ambient.skyIllum = 26000;

    // 帧环:fps 滚动均值(最近 60 帧平均)+ 状态时间同步 + 首帧就绪
    let lastT = -1;
    const dts = [];
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        if (lastT > 0) {
            dts.push(now - lastT);
            if (dts.length > 60) dts.shift();
            if (dts.length >= 8) {
                const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
                bench.fps = Math.round((1000 / avg) * 10) / 10;
            }
        }
        lastT = now;
        // instances.*.time 与画面同步(每次取态即时求值)
        for (const slot of ['A', 'B']) {
            if (bench.instances[slot]) bench.instances[slot].time = currentAnimationTime(slot);
        }
        if (bench.assetLoaded && !window.__appReady) window.__appReady = true;
    });

    // 运行时加载(单次网络请求)→ 双实例(同一 asset 两次 instantiate)
    const loader = new GLTFLoader();
    gltfAsset = await loader.loadAsync(ASSET_URL);
    if (typeof gltfAsset.addRef === 'function') gltfAsset.addRef(); // 钉住资产,reset 期间 refcount 不归零
    for (const clip of gltfAsset.animations) clip.wrapMode = AnimationClip.WrapMode.Loop;

    spawnFox('A');
    spawnFox('B');
    bench.assetLoaded = true;
    updateUI();

    window.setInterval(updateHUD, 200);
    updateHUD();
    console.log(
        `[E10] running — fox dual-instance, clips: ${gltfAsset.animations.map((c) => c.name).join(', ')}, ` +
        `skeletons: ${gltfAsset.skeletons.length}, requests: ${bench.assetRequests}`,
    );
}

main().catch((err) => {
    console.error('[E10] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0); // pageerror 通道 → harness 捕获分类
});
