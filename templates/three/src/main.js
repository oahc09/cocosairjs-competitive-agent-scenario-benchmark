// ============================================================================
// bench-template-three — Smoke 场景:旋转的受光立方体
// ----------------------------------------------------------------------------
// 这是模板的唯一样例代码。后续 Agent 以本文件为起点,替换为各 benchmark 场景实现。
// 必须保持的页面契约(MASTER-CONTEXT §12.1,harness 会断言):
//   window.__appReady : 初始为 false(index.html 内联脚本),首帧渲染完成后置 true
//   window.__bench    : {
//     getState: () => ({ engine: "three", frame: <累计渲染帧数>, ready: true }),
//     reset:    () => void   // frame 清零、立方体旋转角归零
//   }
// 引擎经 index.html 的 import map 解析("three" -> /dist/vendor/three.module.js),
// 因此这里只 import 裸名,构建时 esbuild 会把它保持为外部依赖(不打进 app.js)。
// ============================================================================

import * as THREE from 'three';

// --- 画布与渲染器 ------------------------------------------------------------
// WebGL 渲染;canvas 尺寸交给 CSS(100% 铺满视口),绘制缓冲按窗口物理尺寸设置。
const canvas = document.getElementById('app-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

// --- 场景与透视相机 ----------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // 与页面 CSS 黑底一致

const camera = new THREE.PerspectiveCamera(
  60,                                   // fov(竖直)
  window.innerWidth / window.innerHeight, // aspect
  0.1,                                  // near
  100                                   // far
);
camera.position.set(0, 0, 5); // 立方体位于原点,相机在 +Z 直视

// --- 光照:环境光 + 方向光(r155+ 默认物理光照,方向光强度给足) ---------------
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(3, 4, 5);
scene.add(dirLight);

// --- 主角:旋转立方体(非纯黑颜色,受光可见) ----------------------------------
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x3d8bff, roughness: 0.35, metalness: 0.1 })
);
scene.add(cube);

// --- bench 状态 ---------------------------------------------------------------
let frame = 0; // 累计渲染帧数:getState().frame 每帧 +1
let angle = 0; // 立方体累计旋转角:reset() 时归零
let resetCount = 0; // reset() 调用次数(探针 P4 断言 $.resetCount >= 1)

function doReset() {
  frame = 0;
  angle = 0;
  resetCount += 1;
  cube.rotation.set(0, 0, 0);
}

window.__bench = {
  getState: () => ({ engine: 'three', frame, ready: true, resetCount }),
  reset: doReset,
};

// --- UI 约定示范:探针通过 data-ui 属性定位控件(click:ui=reset) -----------------
// 各场景实现自定义控件(HUD/按钮/滑杆)时必须同样带 data-ui 属性。
{
  const btn = document.createElement('button');
  btn.textContent = 'Reset';
  btn.setAttribute('data-ui', 'reset');
  btn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 12px;' +
    "font:12px sans-serif;background:#222;color:#fff;border:1px solid #555;" +
    'border-radius:4px;cursor:pointer';
  btn.addEventListener('click', () => doReset());
  document.body.appendChild(btn);
}

// --- 主循环 -------------------------------------------------------------------
// 每帧固定步长旋转(reset 语义确定,与帧率无关的确定性角度);渲染完成后置 ready。
function tick() {
  frame += 1;
  angle += 0.01;
  cube.rotation.x = angle * 0.5;
  cube.rotation.y = angle;
  renderer.render(scene, camera);
  if (window.__appReady !== true) {
    window.__appReady = true; // 首帧渲染完成,页面就绪
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- 视口自适应 ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
