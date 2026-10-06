/**
 * E10 动画角色展示空间 — cocosair (K0 Code First)
 *
 * 规格:spec.json v1.0.1(冻结)。
 * 核心:GLTFLoader.loadAsync('assets/character.glb') 全会话仅一次网络请求;
 *   双实例由同一 GLTFAsset.instantiate() 派生(引擎契约:实例创建独立 node/animation 状态);
 *   剪辑映射 idle→'Survey'、walk→'Walk'(资产剪辑命名不限,状态暴露规范名);
 *   销毁 A = removeFromParent + GLTFInstance.dispose(B 完全不动);
 *   reset = 同步 dispose 存活实例并从缓存资产重建双实例(零网络请求、不刷新页面)。
 *
 * 页面契约:__appReady(双实例就绪且首帧绘制后 true)+ __bench = { getState, reset }。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    SphereLight,
    MeshRenderer,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Color,
    Material,
    director,
    Director,
    GLTFLoader,
    Animation,
    AnimationClip,
    Texture2D,
    ImageAsset,
} from 'cocosair.js';

// --- 剪辑映射:资产内为 Survey/Walk/Run,状态契约要求暴露 idle/walk -------------
const CLIP = { idle: 'Survey', walk: 'Walk' };

// 站位:P1/P3-P6 视觉断言区 A=[0.08,0.42] B=[0.58,0.92](归一化 x),屏幕 25%/75% 处。
// fox 原始身高 ~79 单位 → scale 0.02 ≈ 1.58 单位,符合 brief 建议 1.5-1.8。
const FOX_SCALE = 0.02;
const POS_X = { A: -1.35, B: 1.35 };
// fox_material baseColorFactor ≈ [0.708, 0.476, 0.355](无贴图纯色 PBR)
const FOX_COLOR = new Color(180, 121, 90, 255);

const world = {
    scene: null,
    asset: null, // GLTFAsset:单次加载缓存,reset/重建实例均由它派生
    clips: null, // { idle, walk } AnimationClip
    recs: { A: null, B: null }, // { inst, root, anim, clip, stateName }
    destroyed: null, // null | 'A'
    resetCount: 0,
    assetLoaded: false,
    fps: 0,
};

window.__appReady = false;

// --- fps:最近 60 帧滑动平均(Director 帧事件,spec minFps=30) -------------------
// 预热 2s:排除启动期(GLB 解析/着色器编译)长帧,窗口只统计稳态帧
const frameDts = [];
let lastFrameTs = 0;
const bootTs = performance.now();
director.on(Director.EVENT_AFTER_UPDATE, () => {
    const now = performance.now();
    if (now - bootTs > 2000) {
        if (lastFrameTs > 0) frameDts.push((now - lastFrameTs) / 1000);
        if (frameDts.length > 60) frameDts.shift();
        let sum = 0;
        for (const d of frameDts) sum += d;
        world.fps = sum > 0 ? Math.min(240, frameDts.length / sum) : 0;
    }
    lastFrameTs = now;
});

function describe(id) {
    const r = world.recs[id];
    if (!r) return null;
    let time = 0;
    try {
        const st = r.anim.getState(r.stateName);
        if (st) time = st.time;
    } catch (e) { /* 状态未建:time 保持 0 */ }
    return { clip: r.clip, time: Math.round(time * 10000) / 10000 };
}

window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        assetLoaded: world.assetLoaded,
        instanceCount: (world.recs.A ? 1 : 0) + (world.recs.B ? 1 : 0),
        instances: { A: describe('A'), B: describe('B') },
        destroyedInstance: world.destroyed,
        resetCount: world.resetCount,
        fps: Math.round(world.fps * 10) / 10,
    }),
    reset: () => resetAll(),
};

// --- UI 控件:同时带 data-ui 与 data-bench,hover/active 反馈,销毁后置灰 ---------
function makeButton(label, uiName, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('data-ui', uiName);
    btn.setAttribute('data-bench', uiName);
    btn.style.cssText =
        'padding:4px 10px;font:12px sans-serif;background:#2d323c;color:#dfe4ec;' +
        'border:1px solid #5a6272;border-radius:4px;cursor:pointer;transition:background .12s;';
    btn.addEventListener('mouseenter', () => { btn.style.background = '#3d4450'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#2d323c'; });
    btn.addEventListener('mousedown', () => { btn.style.background = '#4c5provoking462'; });
    btn.addEventListener('mouseup', () => { btn.style.background = '#3d4450'; });
    btn.addEventListener('click', onClick);
    return btn;
}
const uiRoot = document.createElement('div');
uiRoot.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:9999;display:flex;gap:6px;align-items:center;';
const group = (label, ids) => {
    const span = document.createElement('span');
    span.textContent = label;
    span.style.cssText = 'font:11px sans-serif;color:#9aa3b2;margin-right:2px;';
    uiRoot.appendChild(span);
    ids.forEach(([lbl, name, fn]) => uiRoot.appendChild(makeButton(lbl, name, fn)));
};
group('A:', [
    ['Idle', 'anim-a-idle', () => setClip('A', 'idle')],
    ['Walk', 'anim-a-walk', () => setClip('A', 'walk')],
]);
group('B:', [
    ['Idle', 'anim-b-idle', () => setClip('B', 'idle')],
    ['Walk', 'anim-b-walk', () => setClip('B', 'walk')],
]);
const btnDestroy = makeButton('Destroy A', 'destroy-a', () => destroyA());
const btnReset = makeButton('Reset', 'reset', () => resetAll());
uiRoot.appendChild(btnDestroy);
uiRoot.appendChild(btnReset);
document.body.appendChild(uiRoot);
function updateDestroyUI() {
    const gone = world.recs.A === null;
    btnDestroy.disabled = gone;
    btnDestroy.style.opacity = gone ? '0.4' : '1';
    btnDestroy.style.cursor = gone ? 'not-allowed' : 'pointer';
}

// --- 实例操作 ------------------------------------------------------------------
function setClip(id, clip) {
    const r = world.recs[id];
    if (!r || !world.clips) return;
    r.autoplayPending = false; // 手动切换后取消待起播
    if (r.clip === clip) return;
    r.anim.crossFade(CLIP[clip], 0.2); // ≤300ms 内开始过渡
    r.clip = clip;
    r.stateName = CLIP[clip];
}

function destroyA() {
    const r = world.recs.A;
    if (!r) return; // 已销毁:置灰无效
    r.root.removeFromParent(); // 明确从场景图移除(非仅不可见)
    r.inst.dispose(); // 停止并释放该实例的节点/动画状态
    world.recs.A = null;
    world.destroyed = 'A';
    updateDestroyUI();
}

function resetAll() {
    for (const id of ['A', 'B']) {
        const r = world.recs[id];
        if (r) {
            r.root.removeFromParent();
            r.inst.dispose();
            world.recs[id] = null;
        }
    }
    world.destroyed = null;
    // 应用内重建:同一缓存 GLTFAsset 再 instantiate,不发起任何新的资产网络请求
    spawnInstance('A');
    spawnInstance('B');
    world.resetCount += 1;
    updateDestroyUI();
}

function setLayerDeep(node, layer) {
    node.layer = layer;
    for (const c of node.children) setLayerDeep(c, layer);
}

// 独立材质工厂:new Material + initialize(正统 Code First 写法;共享内置材质实例
// 会被跨渲染器改色串扰 —— 实测 clone 不存在导致地面/展台被刷成狐狸色)
function makeStdMaterial(color, roughness) {
    const m = new Material();
    m.initialize({ effectName: 'builtin-standard' });
    m.setProperty('mainColor', color);
    if (roughness !== undefined) {
        try { m.setProperty('roughness', roughness); } catch (e) { /* 可选属性 */ }
    }
    return m;
}

function spawnInstance(id) {
    const inst = world.asset.instantiate(); // 独立节点树 + 独立动画状态
    const root = inst.root;
    setLayerDeep(root, Layers.Enum.DEFAULT); // 相机 visibility 只含 DEFAULT
    root.setScale(new Vec3(FOX_SCALE, FOX_SCALE, FOX_SCALE));
    root.setPosition(new Vec3(POS_X[id], 0.04, 0));
    root.setRotationFromEuler(0, id === 'A' ? -20 : 20, 0); // 轻微相对站位感
    world.scene.addChild(root);
    // 渲染器:阴影 + 材质修复(实测 air-gltf-standard 效果在本环境蒙皮路径输出全黑;
    // 狐狸本体为无贴图纯色 PBR 材质,逐渲染器克隆 builtin-standard 做等价替换,
    // 逐实例克隆同时杜绝双实例/地面间共享材质串扰)
    for (const r of root.getComponentsInChildren(MeshRenderer)) {
        try {
            r.shadowCastingMode = 1; // ON
            r.receiveShadow = 1;
        } catch (e) { /* 个别渲染器属性只读时忽略 */ }
        try {
            const mat = makeStdMaterial(FOX_COLOR, 0.76); // 每渲染器独立材质
            r.material = mat;
        } catch (e) { /* 替换失败时保留 GLTF 原材质 */ }
    }
    // 动画:直接驱动 GLTF 加载器挂在实例根上的 Animation(已含全部剪辑与状态;
    // 不再另加第二个 Animation —— 同节点双 Animation 会与动画管理器冲突导致状态冻结)
    const anim = root.getComponent(Animation);
    const rec = { inst, root, anim, clip: 'idle', stateName: CLIP.idle, autoplayPending: true };
    world.recs[id] = rec;
    // 组件激活后下一帧显式起播 Idle(不依赖激活时序,确定性起播)
    director.once(Director.EVENT_AFTER_UPDATE, () => {
        if (world.recs[id] === rec && rec.autoplayPending) {
            rec.autoplayPending = false;
            try { anim.play(CLIP.idle); } catch (e) { /* 已起播则忽略 */ }
        }
    });
}

// --- 渐变背景(canvas 程序化纹理,失败可跳过,不影响契约) -----------------------
function makeBackdrop(scene) {
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 256;
    const ctx = cv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2c3a57');
    grad.addColorStop(0.55, '#46536c');
    grad.addColorStop(1, '#8b93a4');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new Texture2D();
    tex.image = new ImageAsset(cv);
    const node = new Node('Backdrop');
    node.layer = Layers.Enum.DEFAULT;
    scene.addChild(node);
    const mr = node.addComponent(MeshRenderer);
    mr.mesh = utils.createMesh(primitives.plane({ width: 44, length: 16 }));
    let mat = builtinResMgr.get('builtin-unlit-material') || builtinResMgr.get('builtin-standard-material');
    mat = typeof mat.clone === 'function' ? mat.clone() : mat; // clone:不污染共享内置资源
    mat.setProperty('mainTexture', tex);
    mr.material = mat;
    node.setPosition(new Vec3(0, 3.5, -10));
    node.setRotationFromEuler(90, 0, 0); // XZ 平面竖起,法线朝 +Z(相机)
}

// --- 主流程 --------------------------------------------------------------------
try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    const scene = new Scene('E10-showcase');
    world.scene = scene;

    // 相机:中景平视轻微俯角,双实例完整入画
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 1.35, 4.6));
    cameraNode.lookAt(new Vec3(0, 0.72, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 42;
    camera.near = 0.1;
    camera.far = 100;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(43, 52, 70, 255);
    camera.visibility = Layers.Enum.DEFAULT; // 4.0-alpha 默认 undefined,必须显式
    camera.priority = 0;

    // 三点布光:主光(唯一实时平行光,带实时阴影)+ 补光 + 逆光;环境光见 app.run 后
    const keyNode = new Node('KeyLight');
    scene.addChild(keyNode);
    keyNode.setPosition(new Vec3(0, 8, 0));
    keyNode.setRotationFromEuler(-42, -35, 0);
    const key = keyNode.addComponent(DirectionalLight);
    key.illuminance = 45000;
    key.shadowEnabled = true;

    const fillNode = new Node('FillLight');
    scene.addChild(fillNode);
    fillNode.setPosition(new Vec3(-4, 2.5, 3.5));
    fillNode.lookAt(new Vec3(0, 0.8, 0));
    const fill = fillNode.addComponent(SphereLight);
    fill.luminousFlux = 3000;
    fill.range = 20;

    const rimNode = new Node('RimLight');
    scene.addChild(rimNode);
    rimNode.setPosition(new Vec3(3.5, 3.2, -4));
    rimNode.lookAt(new Vec3(0, 0.9, 0));
    const rim = rimNode.addComponent(SphereLight);
    rim.luminousFlux = 5000;
    rim.range = 20;

    // 地面(XZ 平面)接收阴影
    const groundNode = new Node('Ground');
    groundNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(groundNode);
    const groundMr = groundNode.addComponent(MeshRenderer);
    groundMr.mesh = utils.createMesh(primitives.plane({ width: 40, length: 40 }));
    groundMr.material = makeStdMaterial(new Color(104, 110, 120, 255));
    groundMr.shadowCastingMode = 0;
    groundMr.receiveShadow = 1;

    // 展台圆盘(staging):双实例脚下;clone 避免与地面材质串扰
    for (const id of ['A', 'B']) {
        const disc = new Node('Disc-' + id);
        disc.layer = Layers.Enum.DEFAULT;
        scene.addChild(disc);
        const dmr = disc.addComponent(MeshRenderer);
        dmr.mesh = utils.createMesh(primitives.cylinder(0.85, 0.9, 0.08));
        dmr.material = makeStdMaterial(new Color(130, 136, 148, 255));
        dmr.receiveShadow = 1;
        disc.setPosition(new Vec3(POS_X[id], 0.04, 0));
    }

    try { makeBackdrop(scene); } catch (e) { /* 背景为装饰项,失败不阻断 */ }

    window.__airApp = app;
    app.run(scene);

    // 环境光:app.run 后经 scene.globals 配置(引擎已验证路径,同模板)
    scene.globals.ambient.skyColorHDR.set(0.35, 0.5, 0.75, 1.0);
    scene.globals.ambient.skyIllum = 15000;

    // __appReady:双实例就绪后的首帧绘制
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady && world.assetLoaded) window.__appReady = true;
    });

    // 全会话唯一一次资产网络加载(相对路径,harness 观测 200 与"仅一次")
    const asset = await new GLTFLoader().loadAsync('assets/character.glb');
    world.asset = asset;
    world.clips = {
        idle: asset.animations.find((c) => c.name === CLIP.idle),
        walk: asset.animations.find((c) => c.name === CLIP.walk),
    };
    if (!world.clips.idle || !world.clips.walk) {
        throw new Error('character.glb 缺少预期动画剪辑: ' + asset.animations.map((c) => c.name).join(','));
    }
    // 循环播放:glTF 导入剪辑默认 wrapMode=Normal(单次播完即停 —— 实测 Survey 3.4167s
    // 播完 time 冻结、画面定格)。必须在首次 instantiate 之前设 Loop,
    // instantiate 的 sceneClips 拷贝会继承源剪辑的 wrapMode。
    const LOOP = AnimationClip.WrapMode && AnimationClip.WrapMode.Loop !== undefined
        ? AnimationClip.WrapMode.Loop
        : 2; // WrapModeMask.Loop
    for (const c of asset.animations) {
        c.wrapMode = LOOP;
    }
    spawnInstance('A');
    spawnInstance('B');
    world.assetLoaded = true;
    updateDestroyUI();
    window.__e10 = world; // 运行时诊断入口(dev 用,无副作用)
    if (asset.warnings && asset.warnings.length) {
        console.log('[E10] gltf warnings:', asset.warnings.join(' | '));
    }
    const foxMr = world.recs.A.root.getComponentsInChildren(MeshRenderer)[0];
    if (foxMr && foxMr.material) {
        console.log('[E10] fox material:', foxMr.material.name,
            '| effect:', foxMr.material.effectName,
            '| props:', JSON.stringify(foxMr.material.getPropertyNames ? foxMr.material.getPropertyNames() : []));
    }

    console.log('[E10] ready — instances A/B idle on cocosair');
} catch (err) {
    // 致命错误显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[E10] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
