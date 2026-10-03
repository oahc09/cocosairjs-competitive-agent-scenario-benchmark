/**
 * E09 珠宝展示台 — Cocos AIR Reference 实现(Material Ceiling 探测)。
 *
 * 材质路径(本场景的实验答案,详见 REFERENCE-VERDICT.md / ceiling-notes.md):
 *   1. 引擎自带 KHR_materials_transmission(air-gltf-physical)在 v1.0.0 存在
 *      死代码缺陷:片元里 airTrFactorTex/airThickTex 恒 0,折射/色散瓣永不生效
 *      (src/air/assets/gltf/material/physical-effect.ts L170/L348;vendored tarball 同);
 *   2. 改走引擎 sanctioned 的自定义 EffectAsset + AirTransmissionCapture 两相机
 *      scene-color 管线:自定义 shader 声明 cc_sceneColorTex/airSceneColorInfo +
 *      USE_AIR_TRANSMISSION define,即被 capture 自动认领并绑定离屏场景色 →
 *      真实屏幕空间折射变形 + RGB 三通道色散火彩(非贴图烘焙、非漫反射冒充)。
 *
 * 引擎实测坑(已核实并规避):
 *   - Light.color setter 吃 Color(0-255,读 .r/.g/.b);传 Vec3 → undefined/255 = NaN
 *     → NaN 污染全部受光像素成纯白;
 *   - 亮度口径:HDR 管线,DirectionalLight.illuminance 用 lux 量级(≈5e4),
 *     SpotLight.luminance ×exposure×10000,size 是物理光源面积(大柔光箱=size 大);
 *     暗棚用 camera.iso 提曝光,而非缩小灯光物理值;
 *   - 低粗糙金属地面会把主光 GGX 镜面瓣放大成整屏白(roughness ≥0.4);
 *   - USE_TWOSIDE 只翻法线不改 cullMode,双面几何必须同时给 rasterizerState。
 *
 * 行为契约(spec.json):
 *   - rotationAngle:转台累计角(度,单调增,30°/s)
 *   - selectedColor:diamond|ruby|emerald|sapphire|amber(≥5 色板)
 *   - cameraDistance:10 →双击→ ≤6 →再双击→ ≥9(≥600ms 缓动,真实相机位移)
 *   - exportCount:canvas.toBlob → a[download] 真实下载(>10KB,序号文件名)
 *   - reset():色/相机/导出计数复位,不刷新页面,转台继续
 */

import {
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    SpotLight,
    MeshRenderer,
    Layers,
    Vec3,
    Vec4,
    Color,
    Material,
    Texture2D,
    TextureCube,
    ImageAsset,
    utils,
    primitives,
    Component,
    director,
    Director,
    AirTransmissionCapture,
    gfx,
} from 'cocosair.js';

import { buildGemEffect } from './gem-effect.js';
import { buildGemGeometry } from './gem-geometry.js';
import { buildEnvFacePixels } from './studio-env.js';

// ---------------------------------------------------------------------------
// 基准状态(spec stateContract;不折返、不伪造)
// ---------------------------------------------------------------------------

const COLORS = [
    { name: 'diamond', swatch: '#e8eef2', absorb: [1.0, 1.0, 1.0], strength: 0.12 },
    { name: 'ruby', swatch: '#d6323f', absorb: [1.0, 0.10, 0.16], strength: 1.0 },
    { name: 'emerald', swatch: '#23a96e', absorb: [0.06, 0.85, 0.42], strength: 1.0 },
    { name: 'sapphire', swatch: '#2e5fd8', absorb: [0.12, 0.28, 1.0], strength: 1.0 },
    { name: 'amber', swatch: '#e8a33d', absorb: [1.0, 0.60, 0.10], strength: 0.9 },
];

const state = {
    rotationAngle: 0,      // 度,单调累计
    selectedColor: 'diamond',
    cameraDistance: 10,
    exportCount: 0,
    resetCount: 0,
};
let exportSeq = 1; // 下载文件名序号(独立于 exportCount,避免 reset 后同名冲突)

window.__appReady = false;
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        rotationAngle: state.rotationAngle,
        selectedColor: state.selectedColor,
        cameraDistance: state.cameraDistance,
        exportCount: state.exportCount,
        resetCount: state.resetCount,
        ready: window.__appReady === true,
    }),
    reset: () => doReset(),
};

// ---------------------------------------------------------------------------
// 相机推近(真实相机位移;视口/DOM 缩放被禁止)
// ---------------------------------------------------------------------------

const CAM_TARGET = new Vec3(0, 1.73, 0);       // 宝石中心
const CAM_DIR_N = new Vec3(0.10, 0.30, 1.0).normalize();
const DIST_FAR = 10;
const DIST_NEAR = 6;
const ZOOM_MS = 900;                            // ≥600ms 缓动

let camDist = DIST_FAR;      // 当前实际距离(getState 口径)
let camDistFrom = DIST_FAR;
let camDistTo = DIST_FAR;
let zoomT = 1;               // 1 = 静止
let zoomStart = 0;
let cameraComp = null;

function easeInOutCubic (t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function applyCameraDistance (d) {
    camDist = d;
    state.cameraDistance = d;
    if (cameraComp) {
        cameraComp.node.setPosition(
            CAM_TARGET.x + CAM_DIR_N.x * d,
            CAM_TARGET.y + CAM_DIR_N.y * d,
            CAM_TARGET.z + CAM_DIR_N.z * d,
        );
        cameraComp.node.lookAt(CAM_TARGET);
    }
}

function beginZoom (target) {
    camDistFrom = camDist;
    camDistTo = target;
    zoomT = 0;
    zoomStart = performance.now();
}

function toggleZoom () {
    beginZoom(camDist > (DIST_FAR + DIST_NEAR) / 2 ? DIST_NEAR : DIST_FAR);
}

// ---------------------------------------------------------------------------
// 转台(30°/s,单调累计;切面高光/火彩随之流动)
// ---------------------------------------------------------------------------

const TURN_SPEED = 42; // 度/s(≥25)
let gemNode = null;

// 组件:每帧驱动(转台 + 相机缓动)
const softboxMats = []; // 柔光箱材质(呼吸微动:棚拍调光台的真实动作,也给远景提供持续流动感)

let rimOrbitNode = null;   // 轮廓光节点(缓慢环绕,高光持续流动)
let gemLiveMat = null;     // 宝石渲染实例(lightCDir 同步)

class E09Driver extends Component {
    update (dt) {
        const delta = Math.min(dt, 0.1);
        state.rotationAngle += TURN_SPEED * delta;
        if (gemNode && gemNode.isValid) {
            const phase = state.rotationAngle % 360;
            gemNode.setRotationFromEuler(0, phase, 0);
        }
        if (zoomT < 1) {
            zoomT = Math.min((performance.now() - zoomStart) / ZOOM_MS, 1);
            applyCameraDistance(camDistFrom + (camDistTo - camDistFrom) * easeInOutCubic(zoomT));
        }
        // 柔光箱呼吸(±18%,不饱和区间;emissive 只用 xyz,不受 Vec4 更新丢 w 影响)
        const t = performance.now() / 1000;
        softboxMats.forEach((entry, i) => {
            const k = 1 + 0.18 * Math.sin(t * 1.7 + i * 2.1);
            entry.mat.setProperty('emissive', new Vec4(entry.base.x * k, entry.base.y * k, entry.base.z * k, 1));
        });
        // 轮廓光环绕(14°/s):切面高光/背景亮边持续扫动
        if (rimOrbitNode && rimOrbitNode.isValid) {
            const a = t * 0.4; // rad/s
            const R = 11.4, H = 6.2;
            rimOrbitNode.setPosition(Math.sin(a) * R - 3.0 * Math.cos(a * 0.13), H, -Math.cos(a) * R);
            rimOrbitNode.lookAt(new Vec3(0, 1.3, 0));
            if (gemLiveMat) {
                const d = new Vec3(rimOrbitNode.position.x - 0, rimOrbitNode.position.y - 1.73, rimOrbitNode.position.z - 0).normalize();
                gemLiveMat.setProperty('lightCDir', new Vec4(d.x, d.y, d.z, 0));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function standardMaterial (opts) {
    const m = new Material();
    const defines = {};
    if (opts.twoSided) defines.USE_TWOSIDE = true;
    // 双面可见必须同时改光栅状态(USE_TWOSIDE 只翻法线,不改 cullMode)
    const states = opts.twoSided
        ? { rasterizerState: { cullMode: gfx.CullMode.NONE } }
        : undefined;
    m.initialize({ effectName: 'builtin-standard', defines, states });
    if (opts.color) m.setProperty('mainColor', opts.color);
    if (opts.roughness !== undefined || opts.metallic !== undefined) {
        // pbrParams: (occlusion, roughness, metallic, specularIntensity)
        const occl = opts.occlusion !== undefined ? opts.occlusion : 1;
        const rough = opts.roughness !== undefined ? opts.roughness : 0.8;
        const metal = opts.metallic !== undefined ? opts.metallic : 0.0;
        const spec = opts.specular !== undefined ? opts.specular : 0.5;
        m.setProperty('pbrParams', new Vec4(occl, rough, metal, spec));
    }
    if (opts.emissive) m.setProperty('emissive', opts.emissive);
    return m;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let gemMat = null;

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });
    window.__airApp = app;

    const scene = new Scene('e09-jewelry-studio');

    // ---- 相机(取景:宝石居中,轻微俯角) ----
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    const camera = cameraNode.addComponent(Camera);
    cameraComp = camera;
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 31;
    camera.near = 0.1;
    camera.far = 200;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(8, 9, 12, 255);
    camera.visibility = Layers.Enum.DEFAULT; // AIR:必须显式
    camera.priority = 0;
    camera.iso = Camera.ISO.ISO800; // 摄影曝光:暗棚提 3 挡(灯光保持引擎 HDR 物理量级)
    applyCameraDistance(DIST_FAR);

    // ---- 传输捕获(两相机 scene-color:宝石采样真实离屏场景色做折射) ----
    const captureNode = new Node('transmission-capture');
    scene.addChild(captureNode);
    const capture = captureNode.addComponent(AirTransmissionCapture);
    capture.mainCamera = camera;

    // ---- 三点棚拍布光(主/辅/轮廓,层次肉眼可辨) ----
    const LIGHTS = {
        key: { pos: new Vec3(6.5, 9.5, 7.0) },      // 主光(键光):暖白
        fill: { pos: new Vec3(-7.5, 4.5, 4.5) },    // 辅光(填充):冷调柔光
        rim: { pos: new Vec3(-3.0, 7.0, -8.5) },    // 轮廓光(逆光):勾出边缘亮线
    };
    // 主光 = 唯一 DirectionalLight(lux 量级;Light.color 必须 Color 对象)
    const keyNode = new Node('KeyLight');
    scene.addChild(keyNode);
    keyNode.setPosition(LIGHTS.key.pos);
    keyNode.lookAt(new Vec3(0, 1.0, 0));
    const key = keyNode.addComponent(DirectionalLight);
    key.illuminance = 55000;
    key.color = new Color(255, 247, 230, 255);
    // 辅光 = 大面积柔光箱 SpotLight(size=物理光源面积)
    const fillNode = new Node('FillLight');
    scene.addChild(fillNode);
    fillNode.setPosition(LIGHTS.fill.pos);
    fillNode.lookAt(new Vec3(0, 1.0, 0));
    const fill = fillNode.addComponent(SpotLight);
    fill.size = 2.0;
    fill.luminance = 5000;
    fill.range = 30;
    fill.spotAngle = 78;
    fill.angleAttenuationStrength = 1.6;
    fill.color = new Color(204, 224, 255, 255);
    // 轮廓光 = 窄角逆光 SpotLight
    const rimNode = new Node('RimLight');
    scene.addChild(rimNode);
    rimNode.setPosition(LIGHTS.rim.pos);
    rimNode.lookAt(new Vec3(0, 1.3, 0));
    rimOrbitNode = rimNode;
    const rim = rimNode.addComponent(SpotLight);
    rim.size = 1.0;
    rim.luminance = 6500;
    rim.range = 30;
    rim.spotAngle = 46;
    rim.angleAttenuationStrength = 1.2;
    rim.color = new Color(255, 245, 255, 255);

    // ---- 摄影棚环境:程序化 cubemap → skybox IBL(brief §5 自制环境贴图) ----
    const faces = buildEnvFacePixels();
    const faceTextures = ['front', 'back', 'left', 'right', 'top', 'bottom'].map((name) => {
        const img = new ImageAsset({
            width: 256, height: 256,
            _data: faces[name],
            _compressed: false,
            format: Texture2D.PixelFormat.RGBA8888,
        });
        const t = new Texture2D();
        t.image = img;
        return t;
    });
    const envCube = TextureCube.fromTexture2DArray(faceTextures);
    envCube.onLoaded();
    envCube.updateMipmaps(0, envCube.mipmaps.length);
    const skybox = scene.globals.skybox;
    skybox.envmap = envCube;
    skybox.enabled = true;      // envmap 供 IBL(可见背景由几何暗幕承担,天空盒被墙幕遮挡)
    skybox.useIBL = true;
    skybox.envLightingType = 1; // AUTOGEN_HEMISPHERE_DIFFUSE_WITH_REFLECTION
    // 环境光半球(暗棚低位环境光)
    scene.globals.ambient.skyColorHDR.set(0.04, 0.05, 0.075, 1.0);
    scene.globals.ambient.groundAlbedoHDR.set(0.015, 0.015, 0.02, 1.0);
    scene.globals.ambient.skyIllum = 18000;

    // ---- 地面(暗色微反射:中粗糙金属面 + IBL 环境反射) ----
    const floorNode = new Node('Floor');
    floorNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(floorNode);
    const floorRenderer = floorNode.addComponent(MeshRenderer);
    floorRenderer.mesh = utils.createMesh(primitives.plane({ width: 44, length: 44 }));
    floorRenderer.material = standardMaterial({
        color: new Color(26, 27, 33, 255),
        roughness: 0.46,   // 微反射:低粗糙金属面会把主光镜面瓣放大成整屏白
        metallic: 0.42,
        specular: 0.35,
    });

    // ---- 环形背景幕(暗幕包住全场:折射采样到的是真实幕布而非清屏色) ----
    const wallNode = new Node('Cyclorama');
    wallNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(wallNode);
    wallNode.setPosition(0, 7, 0);
    const wallRenderer = wallNode.addComponent(MeshRenderer);
    wallRenderer.mesh = utils.createMesh(primitives.cylinder(15, 15, 18, {
        radialSegments: 48, heightSegments: 1, capped: false,
    }));
    wallRenderer.material = standardMaterial({
        color: new Color(21, 23, 30, 255),
        roughness: 0.9,
        metallic: 0.0,
        twoSided: true,
    });

    // ---- 柔光箱实体面板(亮自发光薄盒:可见背景 + 折射/反射中的"灯") ----
    const softboxes = [
        { pos: new Vec3(-6.2, 3.4, -5.4), yaw: 42, w: 2.2, h: 3.2, color: new Vec4(1.05, 1.10, 1.22, 1) },
        { pos: new Vec3(6.4, 3.1, -5.8), yaw: -38, w: 1.8, h: 2.8, color: new Vec4(0.95, 0.90, 0.80, 1) },
        { pos: new Vec3(0, 5.2, -9.5), yaw: 0, w: 5.0, h: 2.2, color: new Vec4(0.85, 0.88, 0.98, 1) },
    ];
    for (const sb of softboxes) {
        const n = new Node('Softbox');
        n.layer = Layers.Enum.DEFAULT;
        scene.addChild(n);
        n.setPosition(sb.pos);
        n.setRotationFromEuler(0, sb.yaw, 0);
        const r = n.addComponent(MeshRenderer);
        // 薄盒(六面全包):竖立面板任意视角可见(primitives.plane 是 XZ 水平面,不可竖用)
        r.mesh = utils.createMesh(primitives.box({ width: sb.w, height: sb.h, length: 0.07 }));
        r.material = standardMaterial({
            color: new Color(255, 255, 255, 255),
            emissive: sb.color,
        });
        softboxMats.push({ mat: r.material, base: sb.color });
    }

    // ---- 展台(低反射深色圆台 + 细金属亮环) ----
    const pedestalNode = new Node('Pedestal');
    pedestalNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(pedestalNode);
    pedestalNode.setPosition(0, 0.30, 0);
    const pedestalRenderer = pedestalNode.addComponent(MeshRenderer);
    pedestalRenderer.mesh = utils.createMesh(primitives.cylinder(1.62, 1.78, 0.60, {
        radialSegments: 48, heightSegments: 2, capped: true,
    }));
    pedestalRenderer.material = standardMaterial({
        color: new Color(24, 25, 30, 255),
        roughness: 0.30,
        metallic: 0.45,
        specular: 0.6,
    });
    // 金属亮环(金色调,展台边缘细亮边)
    const ringNode = new Node('TrimRing');
    ringNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(ringNode);
    ringNode.setPosition(0, 0.618, 0);
    const ringRenderer = ringNode.addComponent(MeshRenderer);
    ringRenderer.mesh = utils.createMesh(primitives.torus(1.63, 0.025, { radialSegments: 12, tubularSegments: 72 }));
    ringRenderer.material = standardMaterial({
        color: new Color(214, 190, 130, 255),
        roughness: 0.18,
        metallic: 0.9,
        specular: 0.9,
    });

    // ---- 宝石:程序化切面几何(81 切面/100 三角)+ 自定义折射/色散材质 ----
    const gemEffect = buildGemEffect();
    const geometry = buildGemGeometry(1.42);
    const gemMesh = utils.createMesh({
        positions: geometry.positions,
        normals: geometry.normals,
        indices: geometry.indices,
    });
    gemNode = new Node('Gem');
    gemNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(gemNode);
    gemNode.setPosition(0, 1.83, 0); // 展台顶(0.6)+ 宝石入座
    const gemRenderer = gemNode.addComponent(MeshRenderer);
    gemRenderer.mesh = gemMesh;
    gemMat = new Material();
    gemMat.initialize({ effectAsset: gemEffect, defines: { USE_AIR_TRANSMISSION: true } });
    gemRenderer.material = gemMat;
    // AIR 正典:renderer.material 赋值后,实际绘制的是渲染器实例化的 MaterialInstance;
    // 运行期 setProperty(色板 tint / 灯光参数)必须写实例,模板上的后续写入不可见
    // (AirTransmissionCapture 绑定 cc_sceneColorTex 的同样是该实例)
    gemMat = gemRenderer.material;
    gemLiveMat = gemMat;

    // 与实际光源同源的方向/颜色(shader 内高光与场景灯一致,不漂移)
    const gemCenter = new Vec3(0, 1.73, 0);
    const lightDirVec = (pos) => {
        const d = Vec3.subtract(new Vec3(), pos, gemCenter).normalize();
        return new Vec4(d.x, d.y, d.z, 0);
    };
    gemMat.setProperty('lightADir', lightDirVec(LIGHTS.key.pos));
    gemMat.setProperty('lightAColor', new Vec4(3.4, 3.15, 2.55, 0));
    gemMat.setProperty('lightBDir', lightDirVec(LIGHTS.fill.pos));
    gemMat.setProperty('lightBColor', new Vec4(0.8, 0.95, 1.3, 0));
    gemMat.setProperty('lightCDir', lightDirVec(LIGHTS.rim.pos));
    gemMat.setProperty('lightCColor', new Vec4(2.6, 2.4, 3.0, 0));
    applyColor('diamond');

    // ---- 驱动组件(转台 + 相机缓动) ----
    const driverNode = new Node('E09Driver');
    scene.addChild(driverNode);
    driverNode.addComponent(E09Driver);

    app.run(scene);

    // ---- 帧回调:就绪标记 ----
    director.on(Director.EVENT_AFTER_DRAW, () => {
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[e09] cocosair jewelry studio running; transmission capture:', !!capture.sceneColor,
        'gem facets:', geometry.facets, 'tris:', geometry.triangles);
} catch (err) {
    console.error('[e09] fatal:', err && err.message ? err.message : err);
    setTimeout(() => { throw err; }, 0);
}

// ---------------------------------------------------------------------------
// 色板
// ---------------------------------------------------------------------------

function applyColor (name) {
    const c = COLORS.find((x) => x.name === name) || COLORS[0];
    state.selectedColor = c.name;
    if (gemMat) {
        // Beer-Lambert 体吸收预混合(JS 侧完成 atten 与 mix,shader 只乘 xyz):
        // 规避引擎实测缺陷 —— 运行期 Material.setProperty(Vec4) 只有 xyz 到达 shader,第 4 分量恒 0
        const exp = 0.95 * (1 + c.strength * 5) * 1.6;
        const bodyMix = c.absorb.map((v, i) => {
            const atten = Math.pow(Math.max(Math.min(c.absorb[i], 1), 0), exp);
            return 1 + (atten - 1) * c.strength;
        });
        gemMat.setProperty('gemTint', new Vec4(bodyMix[0], bodyMix[1], bodyMix[2], 1));
    }
    document.querySelectorAll('[data-bench^="swatch-"]').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-bench') === `swatch-${COLORS.indexOf(c) + 1}`);
    });
}

// ---------------------------------------------------------------------------
// PNG 导出(当前画布像素 → 真实浏览器下载;文件名带序号避免冲突)
// 引擎 WebGL2 swapchain 以 preserveDrawingBuffer:true 建上下文,DOM 回调里 toBlob 有效
// ---------------------------------------------------------------------------

function exportPNG () {
    const canvas = document.querySelector('#GameCanvas');
    canvas.toBlob((blob) => {
        if (!blob || blob.size <= 0) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gem-E09-${String(exportSeq).padStart(3, '0')}.png`;
        exportSeq += 1;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        state.exportCount += 1; // 下载已真实触发后才计数
    }, 'image/png');
}

// ---------------------------------------------------------------------------
// reset(不刷新页面;转台继续运转)
// ---------------------------------------------------------------------------

function doReset () {
    state.resetCount += 1;
    state.exportCount = 0;
    applyColor('diamond');
    if (camDist !== DIST_FAR) beginZoom(DIST_FAR);
    else applyCameraDistance(DIST_FAR);
}

// ---------------------------------------------------------------------------
// DOM UI(色板 ≥5 + 导出 + 重置;不遮挡画布中央双击区)
// ---------------------------------------------------------------------------

{
    const style = document.createElement('style');
    style.textContent = `
      #e09-ui { position: fixed; inset: 0; pointer-events: none; z-index: 1000;
                font-family: "Segoe UI", "PingFang SC", sans-serif; color: #cfd6e4; }
      #e09-title { position: absolute; top: 18px; left: 24px; letter-spacing: 2px;
                   font-size: 13px; color: #8f98a8; }
      #e09-title b { color: #d8dee9; font-weight: 600; letter-spacing: 3px; }
      #e09-swatchbar { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
                       display: flex; gap: 14px; align-items: center; padding: 10px 16px;
                       background: rgba(12,14,19,.72); border: 1px solid rgba(140,150,170,.22);
                       border-radius: 999px; backdrop-filter: blur(6px); pointer-events: auto; }
      .e09-swatch { width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
                    border: 2px solid rgba(255,255,255,.18); box-shadow: 0 2px 8px rgba(0,0,0,.5),
                    inset 0 1px 2px rgba(255,255,255,.35); transition: transform .15s ease,
                    box-shadow .15s ease; position: relative; }
      .e09-swatch:hover { transform: scale(1.12); }
      .e09-swatch.selected { transform: scale(1.22); border-color: #fff;
                    box-shadow: 0 0 0 3px rgba(255,255,255,.22), 0 3px 10px rgba(0,0,0,.6); }
      .e09-swatch .tip { position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
                    font-size: 10px; color: #aab3c2; opacity: 0; transition: opacity .15s; }
      .e09-swatch.selected .tip, .e09-swatch:hover .tip { opacity: 1; }
      #e09-actions { position: absolute; right: 22px; bottom: 26px; display: flex; gap: 10px;
                     pointer-events: auto; }
      .e09-btn { padding: 9px 18px; font-size: 13px; letter-spacing: 1px; cursor: pointer;
                 color: #e6ebf4; background: rgba(28,32,42,.85);
                 border: 1px solid rgba(150,160,180,.35); border-radius: 8px; }
      .e09-btn:hover { background: rgba(44,50,64,.95); border-color: rgba(190,200,220,.55); }
      .e09-btn.primary { background: linear-gradient(180deg, #3d4657, #2a303d); }
    `;
    document.head.appendChild(style);

    const ui = document.createElement('div');
    ui.id = 'e09-ui';
    ui.innerHTML = `<div id="e09-title">E09 · <b>JEWELRY STUDIO</b></div>`;

    const bar = document.createElement('div');
    bar.id = 'e09-swatchbar';
    COLORS.forEach((c, i) => {
        const s = document.createElement('div');
        s.className = 'e09-swatch';
        s.setAttribute('data-bench', `swatch-${i + 1}`);
        s.setAttribute('data-ui', `swatch-${i + 1}`);
        s.style.background = `radial-gradient(circle at 35% 30%, #ffffffcc, ${c.swatch} 62%, ${c.swatch}cc 100%)`;
        s.innerHTML = `<span class="tip">${c.name}</span>`;
        s.addEventListener('click', () => applyColor(c.name));
        bar.appendChild(s);
    });
    ui.appendChild(bar);

    const actions = document.createElement('div');
    actions.id = 'e09-actions';
    const btnExport = document.createElement('button');
    btnExport.className = 'e09-btn primary';
    btnExport.textContent = 'Export PNG';
    btnExport.setAttribute('data-bench', 'export-png');
    btnExport.setAttribute('data-ui', 'export-png');
    btnExport.addEventListener('click', exportPNG);
    actions.appendChild(btnExport);
    const btnReset = document.createElement('button');
    btnReset.className = 'e09-btn';
    btnReset.textContent = 'Reset';
    btnReset.setAttribute('data-bench', 'reset');
    btnReset.setAttribute('data-ui', 'reset');
    btnReset.addEventListener('click', doReset);
    actions.appendChild(btnReset);
    ui.appendChild(actions);

    document.body.appendChild(ui);
    applyColor('diamond');
}

// 画布双击 → 推近/拉回(DOM 事件直挂引擎自建 GameCanvas)
document.querySelector('#GameCanvas').addEventListener('dblclick', () => toggleZoom());
