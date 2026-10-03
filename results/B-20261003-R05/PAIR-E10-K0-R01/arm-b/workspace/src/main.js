/**
 * E10 动画角色展示空间 — cocosair 实现(arm-b)
 *
 * 场景:runtime 单次加载 assets/character.glb(Khronos Fox:1 skin / 24 joints /
 * clips Survey|Walk|Run),由同一次加载的 GLTFAsset.instantiate() 派生双实例,
 * 动画状态完全独立(每实例独立 Animation 组件 + 独立 AnimationState)。
 *
 * 剪辑映射:Survey → "idle",Walk → "walk"(以 addClip 注册规范名)。
 *
 * 生命周期:create A/B → 独立动画 → destroy-a(GLTFInstance.dispose,从场景图移除)
 * → reset(应用内重建,复用已加载资产,不重新请求 GLB,不刷新页面)。
 *
 * 页面契约:
 *   - window.__appReady:双实例就绪后首个渲染帧(EVENT_AFTER_DRAW)置 true。
 *   - window.__bench = { getState(), reset() }。
 *     getState: { assetLoaded, instanceCount, instances:{A,B}, destroyedInstance,
 *                  resetCount, fps }
 *   - UI 控件带 data-bench 与 data-ui 双属性:
 *     anim-a-idle / anim-a-walk / anim-b-idle / anim-b-walk / destroy-a / reset。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    SpotLight,
    MeshRenderer,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    director,
    Director,
    Animation,
    AnimationClip,
    GLTFLoader,
    Texture2D,
    ImageAsset,
    Material,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 状态契约(spec.json stateContract)
// ---------------------------------------------------------------------------
const state = {
    assetLoaded: false,
    instanceCount: 0,
    destroyedInstance: null, // null | 'A'
    resetCount: 0,
    fps: 0,
};

/** 存活实例表:{ A: InstanceRec|null, B: InstanceRec|null } */
const instances = { A: null, B: null };

/**
 * InstanceRec = {
 *   slot: 'A'|'B',
 *   gltf: GLTFInstance,     // 每实例独立对象状态(instantiate 产物)
 *   node: Node,             // 实例根节点(挂 scene 下)
 *   anim: Animation,        // 实例自己的 Animation 组件(状态隔离来源)
 *   clip: 'idle'|'walk',    // 当前剪辑(规范名)
 *   acc: number,            // 兜底累计播放秒数(引擎 time 不可读时使用)
 * }
 */

let gltfAsset = null; // 单次加载的共享资产数据;reset 由它派生新实例,不重新请求
let clipIdle = null; // 共享 AnimationClip(Survey)
let clipWalk = null; // 共享 AnimationClip(Walk)
let instancesReady = false;
let scene = null;

window.__appReady = false;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const WRAP_LOOP = (typeof AnimationClip !== 'undefined' && AnimationClip.WrapMode && AnimationClip.WrapMode.Loop != null)
    ? AnimationClip.WrapMode.Loop
    : 2;

function setLayerRecursive(node, layer) {
    node.layer = layer;
    const children = node.children || [];
    for (const c of children) setLayerRecursive(c, layer);
}

/** canvas → Texture2D;失败返回 null(视觉降级为纯色,不阻塞场景) */
function canvasTexture(size, draw) {
    try {
        const cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        const ctx = cv.getContext('2d');
        draw(ctx, size);
        const tex = new Texture2D();
        tex.image = new ImageAsset(cv);
        return tex;
    } catch (e) {
        console.warn('[e10] canvasTexture fallback:', e && e.message);
        return null;
    }
}

function gradientTexture() {
    // 柔和垂直渐变背景(上浅下深的 neutral)
    return canvasTexture(256, (ctx, s) => {
        const g = ctx.createLinearGradient(0, 0, 0, s);
        g.addColorStop(0, '#e9eef3');
        g.addColorStop(0.55, '#d3dae1');
        g.addColorStop(1, '#b7c1cb');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
    });
}

function groundTexture() {
    // 地坪光斑:中心亮、边缘略暗的径向过渡(接触明暗),叠加细微网格暗纹
    return canvasTexture(512, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.62);
        g.addColorStop(0, '#dfe3e7');
        g.addColorStop(0.45, '#c3c9cf');
        g.addColorStop(1, '#9aa2ab');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = 'rgba(70,80,92,0.10)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 8; i++) {
            const p = (i / 8) * s;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
        }
    });
}

/** 从 GLB 动画列表中按名称语义映射规范剪辑 */
function pickClip(anims, re) {
    for (const c of anims) {
        if (re.test(c.name || '')) return c;
    }
    return null;
}

// ---------------------------------------------------------------------------
// 实例管理(单次加载派生;每实例独立 Animation 组件 → 动画状态隔离)
// ---------------------------------------------------------------------------
const STAND_X = { A: -1.7, B: 1.7 };
const MODEL_SCALE = 0.022; // Fox 原始身高 ~79 单位 → ~1.74 单位

/** 带 USE_TEXTURE 宏的 unlit 材质实例(共享 builtin 材质不可改宏,必须 copy 出实例) */
function texturedUnlit(tex) {
    try {
        const tpl = builtinResMgr.get('builtin-unlit-material');
        const mat = new Material();
        mat.copy(tpl, { defines: { USE_TEXTURE: 1 } });
        if (tex) {
            try { mat.setProperty('mainTexture', tex); } catch (e) { /* 纯色降级 */ }
        }
        return mat;
    } catch (e) {
        console.warn('[e10] texturedUnlit fallback:', e && e.message);
        return builtinResMgr.get('builtin-unlit-material');
    }
}

/** Fox 网格无 NORMAL 属性(POSITION/TEXCOORD/JOINTS/WEIGHTS),PBR 光照全黑;
 *  改用 unlit 材质呈现原贴图颜色(不依赖法线;蒙皮由管线按 SkinningModel 注入)。 */
function applyUnlitFoxMaterial(node) {
    try {
        let smr = null;
        const stack = [node];
        while (stack.length && !smr) {
            const n = stack.pop();
            const comps = n.components || [];
            for (const c of comps) {
                if (c.mesh !== undefined && c.skeleton !== undefined) { smr = c; break; }
            }
            if (!smr) for (const ch of n.children || []) stack.push(ch);
        }
        if (!smr) return;
        smr.material = texturedUnlit((gltfAsset.textures && gltfAsset.textures[0]) || null);
    } catch (e) {
        console.warn('[e10] unlit material fallback:', e && e.message);
    }
}

function createInstance(slot) {
    const gltfInst = gltfAsset.instantiate(0); // 由缓存资产派生,零网络请求
    const node = gltfInst.root;
    node.setScale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    node.setPosition(new Vec3(STAND_X[slot], 0, 0));
    setLayerRecursive(node, Layers.Enum.DEFAULT);
    applyUnlitFoxMaterial(node);
    scene.addChild(node);

    // 每实例独立 Animation 组件;以规范名注册共享剪辑(独立 AnimationState → 状态隔离)
    const anim = node.getComponent(Animation) || node.addComponent(Animation);
    try {
        if (clipIdle) anim.addClip(clipIdle, 'idle');
        if (clipWalk) anim.addClip(clipWalk, 'walk');
        anim.playOnLoad = false;
        anim.play('idle');
    } catch (e) {
        console.warn('[e10] animation setup fallback:', e && e.message);
    }

    return { slot, gltf: gltfInst, node, anim, clip: 'idle', acc: 0 };
}

function teardownInstance(rec) {
    if (!rec) return;
    try {
        if (rec.anim && rec.anim.stop) rec.anim.stop();
    } catch (e) { /* 已失效则忽略 */ }
    try {
        scene.removeChild(rec.node); // 场景图移除(仅设不可见不算销毁)
    } catch (e) { /* 忽略 */ }
    try {
        rec.gltf.dispose(); // 停止并释放该实例资源(节点/动画/变形状态)
    } catch (e) { /* 忽略 */ }
}

function buildBothInstances() {
    instances.A = createInstance('A');
    instances.B = createInstance('B');
    state.instanceCount = 2;
    state.destroyedInstance = null;
}

function currentClipTime(rec) {
    if (!rec) return 0;
    // 优先读引擎 AnimationState 的播放相位(秒);不可读时用兜底累计值
    let t = NaN;
    try {
        const st = rec.anim && rec.anim.getState ? rec.anim.getState(rec.clip) : null;
        if (st) {
            if (typeof st.current === 'number' && Number.isFinite(st.current)) t = st.current;
            else if (typeof st.time === 'number' && Number.isFinite(st.time) && st.duration > 0) {
                t = st.time % st.duration;
            }
        }
    } catch (e) { /* fallback below */ }
    if (!Number.isFinite(t)) t = rec.acc;
    return t;
}

function snapshot(slot) {
    const rec = instances[slot];
    if (!rec) return null;
    return { clip: rec.clip, time: Math.round(currentClipTime(rec) * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// 交互(与 spec probes 的 UI 定位点一致;data-bench + data-ui 双属性)
// ---------------------------------------------------------------------------
const btnDestroyA = { el: null };

function switchClip(slot, clip) {
    const rec = instances[slot];
    if (!rec || rec.clip === clip) return;
    rec.clip = clip;
    try {
        rec.anim.play(clip); // 直接切换(允许;≤300ms 即时生效)
    } catch (e) {
        console.warn('[e10] switchClip failed:', e && e.message);
    }
    rec.acc = 0;
}

function destroyA() {
    if (state.destroyedInstance || !instances.A) return;
    teardownInstance(instances.A);
    instances.A = null;
    state.instanceCount = 1;
    state.destroyedInstance = 'A';
    if (btnDestroyA.el) btnDestroyA.el.disabled = true;
}

function doReset() {
    state.resetCount += 1;
    state.destroyedInstance = null;
    teardownInstance(instances.A);
    teardownInstance(instances.B);
    instances.A = null;
    instances.B = null;
    buildBothInstances(); // 应用内重建:由已加载资产派生,无网络请求、无页面刷新
    if (btnDestroyA.el) btnDestroyA.el.disabled = false;
}

function makeButton(id, label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('data-bench', id);
    btn.setAttribute('data-ui', id);
    btn.className = 'bench-btn';
    btn.style.cssText =
        'padding:5px 12px;margin:0 3px;font:12px/1.4 sans-serif;color:#eef2f6;' +
        'background:#2b3138;border:1px solid #4a545e;border-radius:5px;cursor:pointer;' +
        'transition:filter .12s, transform .05s;';
    btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.3)'; });
    btn.addEventListener('mouseleave', () => { btn.style.filter = ''; });
    btn.addEventListener('mousedown', () => { btn.style.transform = 'translateY(1px)'; });
    btn.addEventListener('mouseup', () => { btn.style.transform = ''; });
    btn.addEventListener('click', onClick);
    return btn;
}

function buildUI() {
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'display:flex;align-items:center;gap:2px;padding:5px 8px;border-radius:8px;' +
        'background:rgba(20,24,29,0.72);border:1px solid rgba(255,255,255,0.14);' +
        'box-shadow:0 2px 10px rgba(0,0,0,0.35);';

    const mk = (id, label, fn) => bar.appendChild(makeButton(id, label, fn));
    mk('anim-a-idle', 'A · Idle', () => switchClip('A', 'idle'));
    mk('anim-a-walk', 'A · Walk', () => switchClip('A', 'walk'));
    const sep1 = document.createElement('span');
    sep1.style.cssText = 'width:1px;height:18px;background:rgba(255,255,255,0.18);margin:0 6px;';
    bar.appendChild(sep1);
    mk('anim-b-idle', 'B · Idle', () => switchClip('B', 'idle'));
    mk('anim-b-walk', 'B · Walk', () => switchClip('B', 'walk'));
    const sep2 = document.createElement('span');
    sep2.style.cssText = 'width:1px;height:18px;background:rgba(255,255,255,0.18);margin:0 6px;';
    bar.appendChild(sep2);
    btnDestroyA.el = mk('destroy-a', 'Destroy A', () => destroyA());
    mk('reset', 'Reset', () => doReset());

    document.body.appendChild(bar);

    const style = document.createElement('style');
    style.textContent =
        '.bench-btn[disabled]{opacity:0.38;cursor:not-allowed;filter:grayscale(0.8)!important;}';
    document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// __bench 契约
// ---------------------------------------------------------------------------
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        assetLoaded: state.assetLoaded === true,
        instanceCount: state.instanceCount,
        instances: { A: snapshot('A'), B: snapshot('B') },
        destroyedInstance: state.destroyedInstance,
        resetCount: state.resetCount,
        fps: Math.round(state.fps * 100) / 100,
    }),
    reset: () => doReset(),
};

// ---------------------------------------------------------------------------
// 每帧:实例播放计时兜底累计 + fps(最近 60 帧平均)
// ---------------------------------------------------------------------------
class ShowcaseTicker extends Component {
    update(dt) {
        const d = Math.min(dt, 0.1);
        for (const slot of ['A', 'B']) {
            const rec = instances[slot];
            if (!rec) continue;
            rec.acc += d;
            try {
                const st = rec.anim && rec.anim.getState ? rec.anim.getState(rec.clip) : null;
                if (st && st.duration > 0) rec.acc = rec.acc % st.duration;
            } catch (e) { /* keep accumulating */ }
        }
    }
}

const frameTimes = [];
let frameCount = 0;

function onAfterDraw() {
    frameCount += 1;
    const now = performance.now();
    frameTimes.push(now);
    if (frameTimes.length > 60) frameTimes.shift();
    if (frameTimes.length >= 12) {
        const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
        if (span > 0) state.fps = (1000 * (frameTimes.length - 1)) / span;
    }
    if (instancesReady && !window.__appReady) window.__appReady = true;
}

// ---------------------------------------------------------------------------
// 场景搭建
// ---------------------------------------------------------------------------
function buildStage(app) {
    scene = new Scene('E10-showcase');

    // 相机:中景平视,轻微俯视;双实例(±1.7)完整入画
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 1.35, 4.6));
    cameraNode.lookAt(new Vec3(0, 0.85, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(214, 221, 228, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // 三点布光:键光(主方向光,含阴影)+ 补光(斜上点光)+ 逆光(背后轮廓光)
    const keyNode = new Node('KeyLight');
    scene.addChild(keyNode);
    keyNode.setPosition(new Vec3(0, 10, 0));
    keyNode.setRotationFromEuler(-42, -32, 0);
    const key = keyNode.addComponent(DirectionalLight);
    key.illuminance = 60000;
    try {
        key.shadowEnabled = true;
        key.shadowDistance = 25;
    } catch (e) { /* 阴影不可用则退化为明暗过渡 */ }

    const fillNode = new Node('FillLight');
    scene.addChild(fillNode);
    fillNode.setPosition(new Vec3(-6, 4.5, 6));
    fillNode.lookAt(new Vec3(0, 1, 0));
    const fill = fillNode.addComponent(SpotLight);
    try {
        fill.luminousFlux = 26000;
        fill.range = 40;
        fill.spotAngle = 75;
    } catch (e) { /* 保持默认 */ }

    const rimNode = new Node('RimLight');
    scene.addChild(rimNode);
    rimNode.setPosition(new Vec3(1.5, 4.2, -6.5));
    rimNode.lookAt(new Vec3(0, 1, 0));
    const rim = rimNode.addComponent(SpotLight);
    try {
        rim.luminousFlux = 32000;
        rim.range = 40;
        rim.spotAngle = 60;
    } catch (e) { /* 保持默认 */ }

    // 地面:薄盒(顶面 y=0,无旋转歧义)+ 地坪光斑贴图(标准材质受光/可承接阴影)
    const groundNode = new Node('Ground');
    scene.addChild(groundNode);
    const groundRenderer = groundNode.addComponent(MeshRenderer);
    groundRenderer.mesh = utils.createMesh(primitives.box({ width: 40, height: 0.1, length: 40 }));
    const gTex = groundTexture();
    if (gTex) {
        try {
            const groundMat = new Material();
            groundMat.copy(builtinResMgr.get('builtin-standard-material'), { defines: { USE_ALBEDO_MAP: 1 } });
            groundMat.setProperty('mainTexture', gTex);
            groundRenderer.material = groundMat;
        } catch (e) {
            groundRenderer.material = builtinResMgr.get('builtin-standard-material');
        }
    } else {
        groundRenderer.material = builtinResMgr.get('builtin-standard-material');
    }
    groundNode.setPosition(new Vec3(0, -0.05, 0));
    groundNode.layer = Layers.Enum.DEFAULT;

    // 背景:远处大立板 + 柔和渐变(unlit 带贴图实例,不受光,保持背景干净)
    const bgNode = new Node('Backdrop');
    scene.addChild(bgNode);
    const bgRenderer = bgNode.addComponent(MeshRenderer);
    bgRenderer.mesh = utils.createMesh(primitives.box({ width: 60, height: 24, length: 0.1 }));
    bgRenderer.material = texturedUnlit(gradientTexture());
    bgNode.setPosition(new Vec3(0, 6, -8));
    bgNode.layer = Layers.Enum.DEFAULT;

    // 环境光(app.run 后经 scene.globals 配置,引擎已验证路径)
    scene.globals.ambient.skyColorHDR.set(0.35, 0.5, 0.75, 1.0);
    scene.globals.ambient.skyIllum = 20000;
    try {
        scene.globals.shadows.enabled = true;
    } catch (e) { /* 阴影全局开关不可用时忽略 */ }

    // 计时组件
    const tickerNode = new Node('ShowcaseTicker');
    scene.addChild(tickerNode);
    tickerNode.addComponent(ShowcaseTicker);

    app.run(scene);

    director.on(Director.EVENT_AFTER_DRAW, onAfterDraw);
}

// ---------------------------------------------------------------------------
// 启动:页面就绪 → 场景 → 单次 GLB 请求 → 双实例 → Idle → __appReady
// ---------------------------------------------------------------------------
try {
    buildUI();

    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    buildStage(app); // 内部 app.run(scene)

    // runtime 单次加载(整会话仅此一次网络请求;reset 由该资产派生,不再请求)
    const loader = new GLTFLoader();
    gltfAsset = await loader.loadAsync('assets/character.glb');

    const anims = gltfAsset.animations || [];
    clipIdle = pickClip(anims, /survey|idle|stand|rest/i) || anims[0] || null;
    clipWalk = pickClip(anims, /walk/i) || anims[1] || clipIdle;
    if (clipIdle) { try { clipIdle.wrapMode = WRAP_LOOP; } catch (e) { /* ignore */ } }
    if (clipWalk && clipWalk !== clipIdle) { try { clipWalk.wrapMode = WRAP_LOOP; } catch (e) { /* ignore */ } }
    console.log('[e10] clips:', anims.map((c) => c.name).join(','),
        '| idle<=', clipIdle && clipIdle.name, '| walk<=', clipWalk && clipWalk.name);

    buildBothInstances();
    state.assetLoaded = true;
    instancesReady = true; // 下一个 EVENT_AFTER_DRAW 置 window.__appReady = true

    console.log('[e10] ready on cocosair');
} catch (err) {
    console.error('[e10] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
