// regression/cases/lib.mjs — 用例共享引导:建场景 + 帧内像素采样判定
// 约定:每个用例页面 import 本库,调用 boot({...}) 拿到 {app,scene,addCamera,addLight,sample,colorAt,litRatio,finish}
export async function boot() {
  const mod = await import('cocosair.js');
  const { createAirApp, Scene, Node, Camera, DirectionalLight, Layers, Vec3, Color, MeshRenderer, builtinResMgr, utils, primitives, director, Director, Component, GLTFLoader } = mod;
  const canvas = document.querySelector('#GameCanvas');
  const app = await createAirApp({ canvas });
  const scene = new Scene('reg');
  const out = { mod, app, scene, canvas, MeshRenderer, builtinResMgr, utils, primitives, Vec3, Color, Layers, Node, Camera, DirectionalLight, Component, GLTFLoader };

  out.addCamera = (pos = new Vec3(0, 0, 4), lookAt = new Vec3(0, 0, 0), bg = new Color(16, 18, 24)) => {
    const n = new Node('cam'); scene.addChild(n); n.setPosition(pos); n.lookAt(lookAt);
    const c = n.addComponent(Camera);
    c.projection = Camera.ProjectionType.PERSPECTIVE; c.fov = 45; c.near = 0.1; c.far = 100;
    c.clearFlags = Camera.ClearFlag.SOLID_COLOR; c.clearColor = bg; c.visibility = Layers.Enum.DEFAULT; c.priority = 0;
    return n;
  };
  out.addLight = (color, illuminance = 20000) => {
    const n = new Node('light'); scene.addChild(n); n.setPosition(new Vec3(2, 4, 3)); n.setRotationFromEuler(-45, -30, 0);
    const l = n.addComponent(DirectionalLight); l.illuminance = illuminance; l.color = color; return l;
  };
  out.mesh = (geoOrMesh, material, pos = new Vec3(0, 0, 0)) => {
    const n = new Node('m'); n.layer = Layers.Enum.DEFAULT; scene.addChild(n); n.setPosition(pos);
    const r = n.addComponent(MeshRenderer);
    r.mesh = geoOrMesh && geoOrMesh.struct ? geoOrMesh : utils.createMesh(geoOrMesh); // 支持预构建 Mesh
    r.material = material; return n;
  };
  out.builtinMat = () => builtinResMgr.get('builtin-standard-material');
  // 帧内像素采样(AFTER_DRAW 回调里同步 readPixels,与 Reference 相同口径)
  out.sample = (frame = 10) => new Promise((resolve) => {
    let n = 0;
    const h = () => {
      n += 1;
      if (n === frame) {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const w = gl.drawingBufferWidth, h2 = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h2 * 4);
        gl.readPixels(0, 0, w, h2, gl.RGBA, gl.UNSIGNED_BYTE, px);
        director.off(Director.EVENT_AFTER_DRAW, h);
        resolve({ w, h: h2, px });
      }
    };
    director.on(Director.EVENT_AFTER_DRAW, h);
  });
  out.colorAt = (img, x, y) => { const i = ((img.h - 1 - y) * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
  out.litRatio = (img, bgDelta = 24) => { let lit = 0, n = 0; for (let i = 0; i < img.px.length; i += 16) { if (img.px[i] > bgDelta || img.px[i + 1] > bgDelta || img.px[i + 2] > bgDelta) lit++; n++; } return lit / n; };
  out.finish = (reg) => { window.__reg = { ...reg, done: true }; app.pause && app.pause(); };
  return out;
}
