/**
 * E10 — 动画角色展示空间 (cocosair / Cocos AIR Code First)
 *
 * 契约:
 *   - runtime 以相对路径 `assets/character.glb` 单次网络加载 GLB(骨骼 + Survey/Walk/Run 动画),
 *     双实例由同一次加载的 GLTFAsset.instantiate() 派生,动画状态完全独立;
 *   - 规范剪辑名映射:Survey → idle,Walk → walk;
 *   - UI(带 data-bench / data-ui 双属性):anim-a-idle / anim-a-walk / anim-b-idle / anim-b-walk /
 *     destroy-a / reset;
 *   - destroy-a:GLTFInstance.dispose()(root.destroy(),从场景图移除)+ 平台节点销毁;
 *   - reset:销毁双实例后由缓存 GLTFAsset 重建(不发起新网络请求、不刷新页面);
 *   - window.__bench.getState() 字段:assetLoaded / instanceCount / instances.A|B{clip,time} /
 *     destroyedInstance / resetCount / fps;
 *   - window.__appReady 在双实例就绪(Idle 播放中、归一化取景完成)后的首个渲染帧置 true。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    MeshRenderer,
    DirectionalLight,
    SpotLight,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Color,
    Material,
    Texture2D,
    ImageAsset,
    GLTFLoader,
    Animation,
    AnimationClip,
    director,
    Director,
} from 'cocosair.js';

// ---------------------------------------------------------------------------
// 全局页面契约(state 先于一切异步初始化即可用)
// ---------------------------------------------------------------------------

window.__appReady = false;

const benchState = {
    assetLoaded: false,          // GLB 解析完成且双实例就绪
    destroyedInstance: null,     // null | "A"
    resetCount: 0,
    fps: 0,
};

// 活跃实例运行时记录:A/B → { gInstance, anim, states:{idle,walk}, logical:"idle"|"walk", group }
const live = { A: null, B: null };

function instanceSnapshot(id) {
    const rec = live[id];
    if (!rec) return null;
    const state = rec.anim.getState(rec.states[rec.logical]);
    const time = state ? state.time : 0;
    return { clip: rec.logical, time: Number(time.toFixed(4)) };
}

function computeState() {
    const instanceCount = (live.A ? 1 : 0) + (live.B ? 1 : 0);
    return {
        assetLoaded: benchState.assetLoaded,
        instanceCount,
        instances: { A: instanceSnapshot('A'), B: instanceSnapshot('B') },
        destroyedInstance: benchState.destroyedInstance,
        resetCount: benchState.resetCount,
        fps: Math.round(benchState.fps * 10) / 10,
    };
}

function doReset() {
    benchState.resetCount += 1;
    destroyInstance('A', { silent: true });
    destroyInstance('B', { silent: true });
    benchState.destroyedInstance = null;
    spawnInstance('A');
    spawnInstance('B');
    playClip('A', 'idle', { immediate: true });
    playClip('B', 'idle', { immediate: true });
    benchState.assetLoaded = true; // 重建后实例就绪(资产早已加载)
    syncUi();
}

window.__bench = { getState: computeState, reset: doReset };

// ---------------------------------------------------------------------------
// UI 控件组(data-bench 与 data-ui 双属性;探针 click:ui=<name> / brief data-bench 均可定位)
// ---------------------------------------------------------------------------

const uiRefs = {};

function makeButton(name, label) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('data-bench', name);
    btn.setAttribute('data-ui', name);
    btn.addEventListener('click', () => onUiAction(name));
    uiRefs[name] = btn;
    return btn;
}

function buildUi() {
    const panel = document.createElement('div');
    panel.style.cssText =
        'position:fixed;top:10px;left:10px;z-index:9999;display:flex;flex-direction:column;' +
        'gap:6px;padding:10px;background:rgba(24,26,34,0.72);border:1px solid rgba(255,255,255,0.18);' +
        "border-radius:10px;font:12px/1.4 sans-serif;color:#eee;" +
        'user-select:none;';

    const style = document.createElement('style');
    style.textContent =
        '.bench-ui-row{display:flex;gap:6px;align-items:center;}' +
        '.bench-ui-row span{width:70px;color:#bbb;}' +
        '.bench-btn{padding:4px 12px;font:12px sans-serif;background:#2b2f3a;color:#fff;' +
        'border:1px solid #565d6e;border-radius:5px;cursor:pointer;transition:background .12s,transform .06s;}' +
        '.bench-btn:hover:not(:disabled){background:#3d4453;border-color:#8b93a6;}' +
        '.bench-btn:active:not(:disabled){transform:translateY(1px);background:#49516a;}' +
        '.bench-btn:disabled{opacity:.38;cursor:default;}' +
        '.bench-btn.on{background:#4c6a8f;border-color:#7fa0c9;}' +
        '.bench-sep{height:1px;background:rgba(255,255,255,0.14);margin:2px 0;}';
    document.head.appendChild(style);

    const rowA = document.createElement('div');
    rowA.className = 'bench-ui-row';
    const labelA = document.createElement('span');
    labelA.textContent = 'Instance A';
    rowA.appendChild(labelA);
    rowA.appendChild(makeButton('anim-a-idle', 'Idle'));
    rowA.appendChild(makeButton('anim-a-walk', 'Walk'));

    const rowB = document.createElement('div');
    rowB.className = 'bench-ui-row';
    const labelB = document.createElement('span');
    labelB.textContent = 'Instance B';
    rowB.appendChild(labelB);
    rowB.appendChild(makeButton('anim-b-idle', 'Idle'));
    rowB.appendChild(makeButton('anim-b-walk', 'Walk'));

    const sep = document.createElement('div');
    sep.className = 'bench-sep';

    const rowOps = document.createElement('div');
    rowOps.className = 'bench-ui-row';
    const labelOps = document.createElement('span');
    labelOps.textContent = 'Lifecycle';
    rowOps.appendChild(labelOps);
    rowOps.appendChild(makeButton('destroy-a', 'Destroy A'));
    rowOps.appendChild(makeButton('reset', 'Reset'));

    panel.appendChild(rowA);
    panel.appendChild(rowB);
    panel.appendChild(sep);
    panel.appendChild(rowOps);
    document.body.appendChild(panel);
}

function syncUi() {
    const aLive = !!live.A;
    const bLive = !!live.B;
    const set = (name, enabled, on) => {
        const btn = uiRefs[name];
        if (!btn) return;
        btn.disabled = !enabled;
        btn.classList.toggle('on', !!on);
    };
    set('anim-a-idle', aLive, aLive && live.A.logical === 'idle');
    set('anim-a-walk', aLive, aLive && live.A.logical === 'walk');
    set('anim-b-idle', bLive, bLive && live.B.logical === 'idle');
    set('anim-b-walk', bLive, bLive && live.B.logical === 'walk');
    set('destroy-a', aLive, false); // 实例 A 已销毁时置灰
    if (uiRefs['reset']) uiRefs['reset'].disabled = false;
}

function onUiAction(name) {
    switch (name) {
        case 'anim-a-idle':
            playClip('A', 'idle');
            break;
        case 'anim-a-walk':
            playClip('A', 'walk');
            break;
        case 'anim-b-idle':
            playClip('B', 'idle');
            break;
        case 'anim-b-walk':
            playClip('B', 'walk');
            break;
        case 'destroy-a':
            destroyInstance('A');
            benchState.destroyedInstance = 'A';
            syncUi();
            break;
        case 'reset':
            doReset();
            break;
    }
    syncUi();
}

// ---------------------------------------------------------------------------
// 场景常量与工具
// ---------------------------------------------------------------------------

const CAMERA_FOV = 50;
const CAMERA_POS = new Vec3(0, 0.98, 4.6);
const LOOK_AT = new Vec3(0, 0.62, 0);
const TARGET_HEIGHT = 1.34; // 归一化后的角色站立高度(世界单位)
const REGION_A_NDC = [-0.84, -0.16]; // 视觉断言区域 instanceA 的 NDC x 范围
const REGION_B_NDC = [0.16, 0.84];

let scene = null;
let cameraComponent = null;
let gltfAsset = null; // 缓存的 GLTFAsset;reset 由此派生新实例,绝不二次网络加载
let normalizedOnce = false; // 首次归一化(取景/缩放)只做一次,reset 沿用同一变换
const layoutCache = {}; // id → { scale, pos } 归一化结果

function jointBounds(root) {
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    const visit = (node) => {
        if (!node.isValid) return;
        const p = node.worldPosition;
        if (p.x < min.x) min.x = p.x;
        if (p.y < min.y) min.y = p.y;
        if (p.z < min.z) min.z = p.z;
        if (p.x > max.x) max.x = p.x;
        if (p.y > max.y) max.y = p.y;
        if (p.z > max.z) max.z = p.z;
        for (const child of node.children) visit(child);
    };
    visit(root);
    return { min, max };
}

function makeStdMaterial(hex, roughness) {
    const mat = new Material();
    mat.initialize({ effectName: 'builtin-standard' });
    mat.setProperty('mainColor', new Color(hex));
    if (roughness !== undefined) {
        try {
            mat.setProperty('roughness', roughness);
        } catch (e) {
            /* 该 effect 无 roughness 直属性时忽略 */
        }
    }
    return mat;
}

// 画布生成纵向渐变纹理(用于柔和渐变背景)
function makeGradientTexture(c0, c1, c2) {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, c0);
    grad.addColorStop(0.55, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const tex = new Texture2D();
            tex.image = new ImageAsset(img);
            resolve(tex);
        };
        img.src = canvas.toDataURL('image/png');
    });
}

// ---------------------------------------------------------------------------
// 场景搭建
// ---------------------------------------------------------------------------

function buildStage() {
    // 地面(展台地坪)
    const ground = new Node('Ground');
    ground.layer = Layers.Enum.DEFAULT;
    scene.addChild(ground);
    const groundMr = ground.addComponent(MeshRenderer);
    groundMr.mesh = utils.createMesh(primitives.plane({ width: 40, length: 40 }));
    groundMr.material = makeStdMaterial('#b7aea1', 0.9);
    try {
        groundMr.receiveShadow = 1; // 接收阴影
        groundMr.castShadow = 0;
    } catch (e) { /* 枚举值不支持时忽略 */ }
}

function buildBackdrop(texture) {
    const dist = CAMERA_POS.z + 6.2; // 背景板在角色后方
    const halfH = Math.tan((CAMERA_FOV * Math.PI) / 360) * dist;
    const aspect = cameraComponent.aspect || 16 / 9;
    const halfW = halfH * aspect;
    const bd = new Node('Backdrop');
    bd.layer = Layers.Enum.DEFAULT;
    scene.addChild(bd);
    bd.setPosition(new Vec3(0, halfH - 0.2, -6.2));
    bd.setRotationFromEuler(90, 0, 0); // primitives.plane 为水平面(XZ),立起朝向相机
    const mr = bd.addComponent(MeshRenderer);
    mr.mesh = utils.createMesh(primitives.plane({ width: halfW * 2 + 2, length: halfH * 2 + 2 }));
    const mat = new Material();
    mat.initialize({ effectName: 'builtin-unlit', defines: { USE_TEXTURE: true } });
    mat.setProperty('mainTexture', texture);
    mr.material = mat;
}

function buildLights() {
    // 三点布光:主光(key,暖,投影)+ 补光(fill,冷,右侧)+ 逆光(rim,后上方) + 环境光
    const keyNode = new Node('KeyLight');
    scene.addChild(keyNode);
    keyNode.setPosition(new Vec3(-4.5, 6.5, 4.2));
    keyNode.lookAt(new Vec3(0, 0.4, 0));
    const key = keyNode.addComponent(DirectionalLight);
    key.color = new Color(255, 243, 224, 255);
    key.illuminance = 42000;
    // 接触阴影:平面阴影(Planar,沿主光方向投影到地面;ShadowMap 在该引擎
    // 构建下会使材质整体变黑,故不用 shadow map)
    try {
        scene.globals.shadows.enabled = true;
        scene.globals.shadows.type = 0; // Planar
        scene.globals.shadows.planeHeight = 0.051; // 展台上表面
        scene.globals.shadows.shadowColor.set(0, 0, 0, 120);
        key.shadowEnabled = true;
    } catch (e) {
        console.warn('[E10] planar shadow setup skipped:', e && e.message);
    }

    const fillNode = new Node('FillLight');
    scene.addChild(fillNode);
    fillNode.setPosition(new Vec3(6.0, 2.4, 3.4));
    fillNode.lookAt(new Vec3(0, 0.6, 0));
    const fill = fillNode.addComponent(SpotLight);
    fill.color = new Color(176, 200, 255, 255);
    fill.range = 25;
    fill.spotAngle = 72;
    fill.luminousFlux = 64000;

    const rimNode = new Node('RimLight');
    scene.addChild(rimNode);
    rimNode.setPosition(new Vec3(0.8, 4.2, -5.2));
    rimNode.lookAt(new Vec3(0, 0.7, 0));
    const rim = rimNode.addComponent(SpotLight);
    rim.color = new Color(210, 226, 255, 255);
    rim.range = 25;
    rim.spotAngle = 58;
    rim.luminousFlux = 42000;
}

// ---------------------------------------------------------------------------
// 角色实例生命周期
// ---------------------------------------------------------------------------

// 材质接线修正(见调用处注释):以 builtin-standard + GLB baseColor 贴图
// 重建双实例共享的材质槽。GLB baseColorFactor 默认白色 → mainColor 白,
// 让贴图本身呈现狐狸毛色分区。
function fixupFoxMaterials() {
    const source = gltfAsset.materials && gltfAsset.materials[0];
    let albedoTex = null;
    try {
        albedoTex = source && source.getProperty('mainTexture');
    } catch (e) {
        albedoTex = null;
    }

    const mat = new Material();
    if (albedoTex) {
        mat.initialize({ effectName: 'builtin-standard', defines: { USE_DIFFUSEMAP: true } });
        mat.setProperty('diffuseMap', albedoTex);
    } else {
        mat.initialize({ effectName: 'builtin-standard' });
    }
    mat.setProperty('mainColor', new Color(255, 255, 255, 255));
    try {
        mat.setProperty('roughness', 0.58); // GLB roughnessFactor
        mat.setProperty('metallic', 0); // GLB metallicFactor
    } catch (e) { /* 属性不存在时忽略 */ }

    // GLTFAsset 每次 instantiate 都引用 meshMaterials 槽位内的同一材质对象,
    // 原位替换槽位即可覆盖双实例(含 reset 重建)。
    try {
        const doc = gltfAsset.document;
        const meshCount = (doc && doc.meshes && doc.meshes.length) || 1;
        for (let m = 0; m < meshCount; m++) {
            const prims = ((doc && doc.meshes[m] && doc.meshes[m].primitives) || []).length || 1;
            for (let p = 0; p < prims; p++) {
                gltfAsset.meshMaterials[m][p] = mat;
            }
        }
    } catch (e) {
        console.warn('[E10] material slot patch failed:', e && e.message);
    }
    return mat;
}

function resolveClipNames() {
    // GLB 剪辑名 → 规范名:Survey → idle,Walk → walk
    const names = (gltfAsset.animations || []).map((c) => c.name || '');
    const find = (re) => names.find((n) => re.test(n.toLowerCase()));
    return {
        idle: find(/survey|idle/) || names[0],
        walk: find(/walk/) || names[1] || names[0],
    };
}

function spawnInstance(id) {
    const gInstance = gltfAsset.instantiate();
    const anim = gInstance.root.getComponent(Animation);
    const clipNames = resolveClipNames();

    // 实例容器:平台圆盘 + GLTF 根;destroy-a 时整体从场景图移除
    const group = new Node(`InstanceGroup_${id}`);
    group.layer = Layers.Enum.DEFAULT;
    scene.addChild(group);
    group.addChild(gInstance.root);

    // 展台圆盘(每实例,销毁时随组移除)
    const disc = new Node(`Platform_${id}`);
    disc.layer = Layers.Enum.DEFAULT;
    group.addChild(disc);
    const discMr = disc.addComponent(MeshRenderer);
    discMr.mesh = utils.createMesh(
        primitives.cylinder({ radius: 1.28, height: 0.05, segVertices: 48 }),
    );
    discMr.material = makeStdMaterial('#837d70', 0.85);
    try {
        discMr.receiveShadow = 1;
    } catch (e) { /* ignore */ }

    live[id] = { gInstance, anim, states: { idle: clipNames.idle, walk: clipNames.walk }, logical: 'idle', group };

    if (normalizedOnce) {
        const cached = layoutCache[id];
        gInstance.root.setScale(cached.scale, cached.scale, cached.scale);
        if (id === 'B') gInstance.root.setRotationFromEuler(0, 180, 0);
        group.setPosition(cached.pos);
        disc.setPosition(new Vec3(0, 0.025, 0));
    }
    return live[id];
}

function playClip(id, logical, opts) {
    const rec = live[id];
    if (!rec) return;
    rec.logical = logical;
    const stateName = rec.states[logical];
    if (opts && opts.immediate) {
        rec.anim.play(stateName);
    } else {
        rec.anim.crossFade(stateName, 0.18); // <=300ms 内开始过渡
    }
    syncUi();
}

function destroyInstance(id) {
    const rec = live[id];
    if (!rec) return;
    live[id] = null;
    try {
        rec.gInstance.dispose(); // root.destroy():从场景图移除并释放实例资源
    } catch (e) {
        console.warn(`[E10] dispose ${id} error:`, e && e.message);
    }
    if (rec.group && rec.group.isValid) {
        rec.group.destroy();
    }
}

// 首次归一化:按骨骼关节世界包围盒把角色缩放到目标身高、落地面板、左右分立
function normalizeInstances() {
    const aspect = cameraComponent.aspect || 16 / 9;
    const dist = CAMERA_POS.z; // 实例位于 z≈0 平面
    const halfH = Math.tan((CAMERA_FOV * Math.PI) / 360) * dist;
    const halfW = halfH * aspect;

    for (const id of ['A', 'B']) {
        const rec = live[id];
        if (!rec) continue;

        // 1) 缩放到目标身高
        const b0 = jointBounds(rec.gInstance.root);
        const s = TARGET_HEIGHT / Math.max(0.001, b0.max.y - b0.min.y);
        rec.gInstance.root.setScale(s, s, s);

        // 2) B 镜像朝向(构图对称:两头相对)
        if (id === 'B') rec.gInstance.root.setRotationFromEuler(0, 180, 0);

        // 3) 依据变换后的世界包围盒定位:区带中心 x、脚底贴台面、z 居中
        const b1 = jointBounds(rec.gInstance.root);
        const ndc = id === 'A' ? REGION_A_NDC : REGION_B_NDC;
        const targetX = ((ndc[0] + ndc[1]) / 2) * halfW;
        const pos = new Vec3(
            targetX - (b1.min.x + b1.max.x) / 2,
            0.052 - b1.min.y, // 0.052 = 平台上表面高度
            -(b1.min.z + b1.max.z) / 2,
        );
        rec.group.setPosition(pos);
        layoutCache[id] = { scale: s, pos: pos.clone() };
    }
    normalizedOnce = true;
}

// ---------------------------------------------------------------------------
// fps 采样(最近 60 帧平均)
// ---------------------------------------------------------------------------

const frameTimes = [];
let lastFrameTs = 0;

function tickFps(now) {
    if (lastFrameTs) {
        frameTimes.push(now - lastFrameTs);
        if (frameTimes.length > 60) frameTimes.shift();
        if (frameTimes.length >= 10) {
            const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            benchState.fps = 1000 / Math.max(avg, 0.001);
        }
    }
    lastFrameTs = now;
}

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------

buildUi();

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    scene = new Scene('E10-Showcase');

    // 相机(中景平视,轻微俯角,双实例完整入画)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(CAMERA_POS.clone());
    cameraNode.lookAt(LOOK_AT);
    cameraComponent = cameraNode.addComponent(Camera);
    cameraComponent.projection = Camera.ProjectionType.PERSPECTIVE;
    cameraComponent.fov = CAMERA_FOV;
    cameraComponent.near = 0.1;
    cameraComponent.far = 200;
    cameraComponent.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cameraComponent.clearColor = new Color(0x62, 0x6f, 0x8a, 255);
    cameraComponent.visibility = Layers.Enum.DEFAULT;
    cameraComponent.priority = 0;

    window.__airApp = app;
    app.run(scene);

    // 环境光(app.run 后经 scene.globals 配置)
    scene.globals.ambient.skyColorHDR.set(0.52, 0.58, 0.72, 1.0);
    scene.globals.ambient.skyIllum = 9000;

    buildStage();
    buildLights();

    // 帧计数 + fps + 首帧就绪
    director.on(Director.EVENT_AFTER_DRAW, () => {
        const now = performance.now();
        tickFps(now);
        if (!window.__appReady && benchState.assetLoaded && normalizedOnce) {
            window.__appReady = true;
        }
    });

    // GLB 单次网络加载(相对路径;harness 观测该请求)
    const loader = new GLTFLoader();
    gltfAsset = await loader.loadAsync('assets/character.glb');

    // 展示场景要求持续循环播放(GLTF 原生 wrapMode 为 Normal:播放一次即冻结)
    for (const clip of gltfAsset.animations) {
        clip.wrapMode = AnimationClip.WrapMode.Loop;
    }

    // 材质接线修正:该引擎构建的 air-gltf-standard 效果在本场景整体渲染为黑
    // (albedo 采样与受光路径异常),改用等价受光材质 builtin-standard 承载
    // GLB 的 baseColor 贴图与颜色因子 —— 仍渲染 GLB 网格 + GLB 贴图,双实例共享。
    fixupFoxMaterials();

    const clipNames = resolveClipNames();
    console.log('[E10] character.glb loaded; clips:', JSON.stringify(clipNames));

    // 建立双实例并播放 Idle
    spawnInstance('A');
    spawnInstance('B');
    playClip('A', 'idle', { immediate: true });
    playClip('B', 'idle', { immediate: true });

    // 等待数个动画帧(关节进入动画姿势)后归一化取景,再宣布就绪
    setTimeout(() => {
        try {
            normalizeInstances();
            benchState.assetLoaded = true;
            syncUi();
            console.log('[E10] dual instances ready', JSON.stringify(computeState()));
        } catch (err) {
            console.error('[E10] normalize failed:', err);
        }
    }, 350);

    // 柔和渐变背景(异步贴图就绪后挂上,不阻塞启动)
    makeGradientTexture('#c9bfae', '#a7a294', '#7f8dab').then((tex) => {
        try {
            buildBackdrop(tex);
        } catch (err) {
            console.warn('[E10] backdrop failed:', err && err.message);
        }
    });
} catch (err) {
    // 致命错误(如 WebGL2 不可用):显式抛出为未捕获错误,便于 harness 分类
    console.error('[E10] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
