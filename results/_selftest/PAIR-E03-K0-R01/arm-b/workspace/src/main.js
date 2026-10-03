/**
 * bench-template-cocosair — Smoke 场景(与 three 模板行为等价,MASTER-CONTEXT §12.1)
 *
 * 正统 Code First 写法(以 examples/hello-cube、examples/render-composite 为准):
 *   createAirApp({ canvas }) → Scene → Camera/DirectionalLight/MeshRenderer(Node+Component)
 *   → app.run(scene)。引擎经 index.html import map 从 /dist/vendor/cocosair.module.js 加载,
 *   不打进本 bundle(build.mjs 中 external)。
 *
 * 页面契约:
 *   - window.__appReady:首帧(EVENT_AFTER_DRAW)后置 true。
 *   - window.__bench = { getState(): { engine:"cocosair", frame, ready }, reset(): void }。
 */

import {
    Layers,
    createAirApp,
    Scene,
    Node,
    Camera,
    DirectionalLight,
    MeshRenderer,
    builtinResMgr,
    utils,
    primitives,
    Vec3,
    Color,
    Component,
    director,
    Director,
} from 'cocosair.js';

const state = { frame: 0 };

window.__appReady = false;
window.__bench = {
    getState: () => ({
        engine: 'cocosair',
        frame: state.frame,
        ready: window.__appReady === true,
    }),
    reset: () => {
        state.frame = 0;
        if (cubeNode && cubeNode.isValid) {
            cubeNode.setRotationFromEuler(0, 0, 0);
        }
    },
};

/** 每节点行为组件:随场景生命周期启停/销毁(同 examples/hello-cube Rotator)。 */
class Rotator extends Component {
    speed = 45; // deg/s

    update(dt) {
        this.node.setRotationFromEuler(0, this.node.eulerAngles.y + dt * this.speed, 0);
    }
}

let cubeNode = null;

try {
    const canvas = document.querySelector('#GameCanvas');
    const app = await createAirApp({ canvas });

    const scene = new Scene('smoke');

    // Camera(透视;引擎 4.0-alpha 默认 visibility 为 undefined,必须显式设置)
    const cameraNode = new Node('Main Camera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(new Vec3(0, 1.5, 4.5));
    cameraNode.lookAt(new Vec3(0, 0, 0));
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 45;
    camera.near = 0.1;
    camera.far = 1000;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(30, 40, 60, 255);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.priority = 0;

    // Directional light(HDR 量级 illuminance,同 examples/hello-cube)
    const lightNode = new Node('Main Light');
    scene.addChild(lightNode);
    lightNode.setPosition(new Vec3(0, 10, 0));
    lightNode.setRotationFromEuler(-45, -30, 0);
    const light = lightNode.addComponent(DirectionalLight);
    light.illuminance = 50000;

    // Cube(builtin standard material:受光材质,环境光+方向光共同作用)
    cubeNode = new Node('Cube');
    cubeNode.layer = Layers.Enum.DEFAULT;
    scene.addChild(cubeNode);
    const meshRenderer = cubeNode.addComponent(MeshRenderer);
    meshRenderer.mesh = utils.createMesh(primitives.box({ width: 1.5, height: 1.5, length: 1.5 }));
    meshRenderer.material = builtinResMgr.get('builtin-standard-material');
    cubeNode.addComponent(Rotator);

    window.__airApp = app; // 开发面板/agent session 显式绑定入口(同 examples)
    app.run(scene);

    // 环境光:app.run 后经由 scene.globals 显式配置。
    // skyColorHDR 原位 set 是引擎已验证路径(Ambient.initialize 按引用共享该 Vec4,
    // 见 examples/render-composite P2a);skyIllum 走公开 setter(HDR 量级)。
    scene.globals.ambient.skyColorHDR.set(0.35, 0.5, 0.75, 1.0);
    scene.globals.ambient.skyIllum = 20000;

    // 帧计数 + 首帧就绪(每渲染帧触发,Director 事件,同 render-composite 采样口径)
    director.on(Director.EVENT_AFTER_DRAW, () => {
        state.frame += 1;
        if (!window.__appReady) {
            window.__appReady = true;
        }
    });

    console.log('[smoke] running on cocosair', app.getScene() && app.getScene().name);
} catch (err) {
    // 致命错误(如 WebGL2 不可用 → WEBGL2_REQUIRED):显式抛出为未捕获错误,便于 harness 捕获分类
    console.error('[smoke] fatal:', err && err.message ? err.message : err);
    setTimeout(() => {
        throw err;
    }, 0);
}
