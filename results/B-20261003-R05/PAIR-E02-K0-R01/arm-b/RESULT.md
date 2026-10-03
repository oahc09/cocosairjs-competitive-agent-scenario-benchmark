# RESULT — PAIR-E02-K0-R01 / arm-b(cocosair,K0)

## 1. 实现摘要(逐探针)

- **实现载体**:`workspace/src/main.js`(esbuild → `dist/app.js`,引擎 external 经 import map 加载)。场景 = 动态重力波海面(51×51 非均匀网格 2601 顶点,每帧 CPU 波形求值 + 解析法线,`utils.MeshUtils.createDynamicMesh` + `updateSubMesh` 上传;builtin-standard 受光 + 太阳镜面高光带)+ 运行时网络加载的 `assets/boat.glb`(GLTFLoader.loadAsync,多部件内嵌材质全保留)+ 两层 unlit 天穹(天顶穹顶/地平带,mainColor 随 toneMix 演变)+ 日/月光盘与光晕 + 方位角 35° 环绕相机 + 色调控件/Reset 控件(`data-ui` + `aria-label` + 可见文本三重定位)。
- **P1(资产加载与初始画面)**:启动即对 `assets/boat.glb` 发起真实网络请求(workspace/assets/ 下字节与冻结规格 sha256 一致的拷贝;dev server 根为 workspace),加载成功并实例化后 `__appReady=true`、`assetLoaded=true`、`assetRequests=1`;画面同时呈现天空/海面/可辨识船体(截图为证)。**PASS**
- **P2(海面持续波动)**:`wavePhase`(模拟时间)1.5s 采样窗内 Δ=1.50(单调递增);海面逐帧顶点位移 + 法线更新,波形沿风向行进,下 60% 区域存在持续运动像素(波峰位移 + 明暗流动)。**PASS**
- **P3(船体随波起伏)**:900ms 采样窗内 `boatPosition.y` 0.419 → 0.956;船锚点 Y 采样与海面**同一波形函数** `waveH(0,0,t)`,纵横摇取波形梯度(相位耦合),4s 极差 ≫ 0.02 单位。**PASS**
- **P4(拖拽环绕)**:水平拖拽(0.50,0.50)→(0.78,0.50) 映射 1.4°/px → 目标方位角 +501°,指数平滑(τ=0.5s)无跳变;动作后 500ms 的 200ms 采样窗内方位角 358.2° → 417.1°(Δ≈59° ≥ 20°),画面构图同步变化。**PASS**
- **P5(色调切换)**:点击 tone 控件 → toneTarget 翻转,toneMix 指数过渡(τ=0.45s < 2.5s),2.5s 后 0 → 0.996(> 0.7);天穹两层、海面反照率/自发光/粗糙度、主光色温、环境光、日/月光盘颜色同步演变,画面平均色显著偏移(≥ 8/255)。**PASS**
- **P6(Reset 释放并重建)**:点击 reset → 显式释放(gltfAsset.destroy + instance.dispose 释放 GLB 全部 owned meshes/materials/textures;自建 sea/sky/band/sun/halo mesh 与 material destroy 释放 GPU 资源)后重建,重新网络加载 GLB;3s 内 epoch=1、assetLoaded=true、assetRequests=2、toneMix=0(< 0.05)、cameraAzimuth=35(32–38 内)、画面恢复正常;无未捕获异常、无页面导航(非整页刷新)。**PASS**
- **P7(连续 reset 稳定)**:第二次 reset 后 epoch=2、assetRequests=3(每次重建真实重新请求)、toneMix=0、assetLoaded=true,console 无新增错误;旧资源显式销毁 + 世代令牌作废过期异步加载,无泄漏征象。**PASS**

**行为项覆盖**:spec.json scoring.behaviorItems 10 项全部落实(运行时网络加载 ✓;船形可辨 ✓;多部件材质受光/背光对比 ✓;wavePhase 推进 + 运动像素 ✓;船体相位耦合起伏 ✓;拖拽环绕 ≥20° ✓;暖冷切换与色偏一致 ✓;reset 释放重建恢复初始 ✓;连续 reset 稳定、requests 递增 ✓;稳态滚动平均帧率 59.6–60 ≥ 30 ✓)。

## 2. 自检清单(完成合同 §5)

- [x] **1. `npm run build` 退出码 0**:workspace 根执行,build #6 为最终构建,退出码 0(共 6 次构建,全部自动计数,见 `workspace/.budget/build.count`)。
- [x] **2. 10s 内 `window.__appReady === true`**:资产加载完成且首帧渲染后置 true(浏览器会话实测 appReady=true,远小于 10s)。
- [x] **3. `window.__bench = { getState, reset }` 契约成立**:getState 返回 spec stateContract 全部 8 字段,reset 可调用(实测 benchReady=true)。
- [x] **4. 无未捕获异常**:全部 6 次浏览器会话 consoleErrors=0、uncaught=[]。
- [x] **5. 探针自检全过**:P1–P7 状态断言 + 视觉断言逐条自查通过(浏览器#5 全套件实测 + 浏览器#6 最终截图证据,见 `workspace/.verify/`)。

预算使用:build 6/8;browser 6/6;工具调用 < 120;墙钟 < 90 分钟。

## 3. 合规声明(逐条,§4 红线)

1. **未访问另一 Arm 的一切**(目录/代码/日志/dev server/浏览器 profile/截图/结果)— 声明属实。
2. **未访问 `reference/`** — 声明属实。
3. **未访问 bench/results/ 下本 Pair 本 Arm 之外的任何目录及既往 trial 结果** — 声明属实。
4. **未访问 harness/ 源码与合同模板目录** — 声明属实。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)— 声明属实。引擎 API 知识仅来自本 Arm 目录内产物 `workspace/dist/vendor/cocosair.module.js`(构建生成物)与本 Arm `knowledge/` 包。
6. **未访问实验计划书与 bench/docs/** — 声明属实。
7. **未访问 `secret/`** — 声明属实。
8. **未发起任何网络请求**(文档/搜索/包 registry;运行时仅访问本 Arm dev server 的本地产物)— 声明属实。
9. **未执行 npm install、未安装/改动任何依赖**(共享 node_modules 仅按模板既有解析路径使用,内容未改动)— 声明属实。
10. **未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件** — 声明属实。
11. **未探测或篡改 harness/validator 的行为与期望值** — 声明属实。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs / verify-browser.mjs 计数**(构建经 `npm run build` 自动先计后执行;浏览器会话一律经 verify-browser.mjs)— 声明属实。

附加说明:
- `arm-b/assets/` 只读使用,未修改;`workspace/assets/boat.glb` 为运行时服务所需的原样拷贝(sha256 `ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397`,与冻结规格一致),GLB 未被转译或内联进构建产物。
- 天穹渐变以两层纯色 unlit(穹顶/地平带)实现 —— 引擎动态纹理上传路径(`Texture2D.image` 需 GFX device 时序)经两次会话验证不可靠后,改为确定性方案;色调暖冷两端天穹/海面/光照/光盘全部参与演变。
