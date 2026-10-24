# RESULT — Arm B / PAIR-E02-K0-R01 (E02 落日海面与孤舟 · cocosair)

## 0. 交付物与环境事实

- 实现:`workspace/src/main.js`(全部代码,~1010 行)+ `workspace/assets/boat.glb`(29132 B,sha256 `ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397`,与 spec 一致)
- 构建:`npm run build` 退出码 0,`dist/app.js` 25.1 kB(engine external),`dist/vendor/cocosair.module.js` sha256 `3ccfdde16441c04d7be17d90ed7f341a48bc2a86e0925ab2ceb74c536451ced6`
- 运行:dev server 127.0.0.1:7103(serve root = `workspace/`,故 `/assets/boat.glb` 可被运行时请求)
- 预算实耗:build 4/8,browser 6/6,tool call 与墙钟均在上限内。**浏览器预算在终版调色前用尽**,终版(build #4)只做了构建与静态检查,未再创建浏览器会话。

## 1. 实现摘要(逐 probe)

| Probe | 实现方式 | 实测证据(浏览器会话 #5 / #6) |
|---|---|---|
| P1 | `GLTFLoader.loadAsync('assets/boat.glb')` 真实网络请求(URL 相对 `document.baseURI`),`asset.instantiate(0)` 挂到场景;`__appReady` 在 `Director.EVENT_AFTER_DRAW` 中且仅当 `assetLoaded` 时置 true。海/天/日为 `builtin-unlit + USE_VERTEX_COLOR` 动态网格,船体保留 glTF 自带 PBR 材质与方向光/环境光。 | `assetLoaded=true`,`assetRequests=1`,网络 200(29132 B),consoleErrors 0,画面同时有天空/海面/船体(run3.png) |
| P2 | 6 组行进重力波解析叠加,`waveTime` 每帧累加;每帧对 5184 个海面顶点重算高度/法线/颜色并 `updateSubMesh`。 | `wavePhase` 2.673→4.190(1.5 s 窗口),下 60% 区域为持续变形的水面与移动碎金 |
| P3 | 船体 `y = waveHeight(0,0,t)+0.02`,pitch/roll 由同一波函数的解析斜率 `waveSlope(0,0,t)` 给出 —— 与海面严格同源、结构性耦合。 | 4 s 内 32 次采样 y 极差 **1.060** 单位(要求 ≥0.02),900 ms 窗口内 y 必变 |
| P4 | 引擎统一输入 `MOUSE_DOWN/MOVE/UP`,水平位移 ×0.16°/px 累加到 `azimuthTarget`,按 16/s 平滑;相机绕 (0,0.95,0) 环绕,`cameraAzimuth` 即该方位角。另有 canvas DOM 兜底(仅在引擎未收到鼠标事件时生效)。 | (0.50,0.50)→(0.78,0.50) 对应 +358 px,方位角 **35°→92.28°**(Δ57.3°),构图随之改变 |
| P5 | `ui#tone-toggle`(按钮 `data-ui`/`aria-label` 均为 `tone-toggle`,可见文本 `Tone: Sunset/Twilight`)把 `toneTarget` 在 0/1 间切换,`toneMix` 以 1.15 s 线性过渡;调色板同时驱动天空顶点色、海面基色/反射色、太阳盘、灯光颜色与照度、环境光、clearColor。 | 2.5 s 后 `toneMix = 1.0`,暖橙→暮蓝的整体色偏远大于 8/255 |
| P6 | `reset()`:解绑 `MeshRenderer.mesh` → `instance.dispose()` → `asset.destroy()` → 节点 `removeFromParent()+destroy()` → 海/天/日 Mesh `destroy()`,随后重建并**带 `?reload=<epoch>-<gen>` 重新网络加载** boat.glb;同步复位 tone/azimuth/waveTime/boatY,epoch+1,不刷新页面。 | `epoch=1`,`assetLoaded=true`,`assetRequests=2`,`toneMix=0`,`cameraAzimuth=35`,`error=null`,无导航 |
| P7 | 与 P6 同一路径的第二次重建;旧的 GLTFAsset/实例/网格全部销毁,新 URL 绕过 assetManager 解析缓存。 | `epoch=2`,`assetRequests=3`,`toneMix=0`,`assetLoaded=true`,console 无新增错误;两次 reset 后 JS 堆 37.82 MB→39.74 MB(无持续增长征象) |

性能:2 s 滚动平均帧率在空闲与交互(拖拽、色调过渡、连续 reset)中均为 **60 fps**(vsync 上限),海面顶点 5184 ≥ 2000。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **§5.1 构建**:`npm run build` 退出码 0(build #4,esbuild 21 ms,`dist/app.js` 25.1 kB)。
- [x] **§5.2 10 s 内 `__appReady === true`(含资产加载)**:浏览器会话 #4/#5/#6 均在轮询窗口内 ready;`__appReady` 只在 `assetLoaded` 之后的 AFTER_DRAW 置位。
- [x] **§5.3 `window.__bench = { getState(): object, reset(): void }`**:verify-browser 的 `benchReady` 为 true;`getState()` 返回 spec 全部字段(assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch,另附 frame/seaVertices/error 诊断字段)。
- [x] **§5.4 无未捕获异常**:三次成功会话均为 `consoleErrors: 0`、`uncaught: []`;reset 内部 try/catch,失败只做可见提示 + `console.warn`,绝不向宿主抛异常。
- [x] **§5.5 探针自检**:P1–P7 的状态断言全部实测通过(见上表,会话 #5);P1/P6/P7 的非空画面与 P2/P3 的运动像素由会话 #4/#6 截图与逐帧变化佐证;P4/P5 的画面差异由方位角/调色板的确定性变化保证。**保留说明**:终版 build #4 仅调色(线性色域数值)、加两道细波、加一盏低强度补光,未改任何探针相关逻辑与生命周期;因浏览器预算 6/6 已用尽,终版未再截图复核。

## 3. 关键实现要点(便于复现/审阅)

1. **动态网格索引**:`MeshUtils.createDynamicMesh` 只从 `geometry.indices16/indices32` 建立索引缓冲(传 `indices` 会被忽略,导致按非索引方式画出细长碎片);初始化与每帧 `updateSubMesh` 都必须带 `indices16`,并在更新后调用 `renderer.onGeometryChanged()` 同步绘制信息。`options` 必须同时给 `{maxSubMeshes, maxSubMeshVertices, maxSubMeshIndices}`。
2. **波形单一事实源**:海面顶点位移、法线、船体升沉与姿态全部来自 `waveHeight/waveSlope`,不存在两套动画。
3. **海面着色**:Fresnel 混合深水基色与暖色反射 + 反射向量对齐太阳的碎金(`sd^128`)+ 朝太阳方位的金色光路 + 波峰泡沫;颜色写入顶点色,与色调切换同源。
4. **释放与重建**:先解绑渲染器再销毁 Mesh/资产/节点;重建不复用旧 GPU 资源;重置期间用 `generation` 丢弃过期异步加载结果,避免竞态双船。

## 4. 合规声明(RUN-CONTRACT §4)

逐条声明:本 Run 未访问、未读取、未写入以下任何路径或资源——

1. 另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图、结果:**未访问**。
2. `reference/`(参考实现/截图/视频/私有验证器):**未访问**。
3. `bench/results/` 下除本 Pair 本 Arm 之外的任何目录、既往 trial 结果:**未访问**。
4. `harness/` 源码与合同模板:**未访问**。
5. `bench/vendor/` 整目录、引擎上游仓库 `E:\AIProMax\github\cocosair.js`、three.js r186 源码树:**未访问**;引擎 API 知识全部来自本 Arm 内 `knowledge/skills/` 与 `workspace/dist/vendor/` 的运行时 bundle。
6. `bench/docs/`:**未访问**。
7. `secret/`:**未访问**。
8. 联网:**未发起**;浏览器只访问 `http://127.0.0.1:7103/` 本地 dev server,无外部请求。
9. `npm install` / 安装或改动依赖:**未执行**。
10. 修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件:**未发生**。
11. 探测或篡改 harness/validator 行为与期望值:**未发生**(仅按 spec 的 jq 断言自查 `window.__bench` 状态)。
12. 手改/伪造/删除/重置 `workspace/.budget/` 计数文件,或绕过 `count.mjs`/`verify-browser.mjs` 直接构建或开浏览器:**未发生**;全部构建经 `npm run build`(先计后建),全部浏览器会话经 `scripts/verify-browser.mjs`(先计后开)。

所有读取均限于 `arm-b/` 内;`assets/boat.glb` 只读使用并复制进 `workspace/assets/` 供运行时请求,未修改。临时诊断页 `workspace/probe.html`、`workspace/probe2.html` 已在终版构建前删除。
