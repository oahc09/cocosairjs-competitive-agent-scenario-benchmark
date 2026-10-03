# RESULT — PAIR-E02-K0-R01 Arm A(cocosair,K0)

场景:E02 落日海面与孤舟(Asset Driven)。实现位于 `workspace/`(cocosair.js 模板),单文件应用 `src/main.js`(~700 行)。

## 1. 实现摘要(逐 probe)

- **P1(就绪 + 资产 + 非空白)**:`new GLTFLoader().loadAsync('assets/boat.glb')` 真实网络请求(29KB,HTTP 200,dev server MIME=model/gltf-binary,构建产物零转译零内联);加载完成且首帧 `EVENT_AFTER_DRAW` 后置 `window.__appReady=true`(实测 ~1.2s);画面同时呈现天穹(渐变+日盘+光晕)、动态海面与船体(GLB 6 部件原材质,实测全帧 litRatio=1.000,暖端均色 (149,112,72))。
- **P2(海面波动)**:海面为双层网格(近景 160x160 段 = 25,921 顶点 + 远景 81 顶点,合计 ≥ 2,000),顶点着色器 4 波 Gerstner 位移 + 解析法线,波幅在 16-27u 半径衰减(近密远疏层次化波形);`wavePhase=simTime` 单调递增,1.5s 窗内 2.57→4.19;下 60% 区域运动像素比 0.868(阈值 0.01)。
- **P3(船体随波起伏)**:JS 侧以与 GLSL 完全相同的波形常数采样 (0,0) 处波高与坡度,驱动船体 y、纵摇/横摇(同一波形参数 → 相位耦合,非随机抖动);900ms 窗内 boatPosition.y 1.21→1.39,4s 序列极差 0.87(阈值 0.02),中心 40% 运动像素比 0.749(阈值 0.002)。
- **P4(拖拽环绕)**:canvas 指针事件(右拖 = 方位角一致方向递增,0.25°/px),逐帧指数平滑(k=10/s)无跳变;拖拽 (0.50,0.50)→(0.78,0.50) 方位角 35.0→124.5(Δ=89.5° ≥ 20°),全帧像素差异比 0.803(阈值 0.02),太阳/海平线相对船体构图正确变化。
- **P5(色调切换)**:tone-toggle 控件(id/data-ui/aria-label 三重定位)点击后 toneMix 以 1.2s 线性过渡到 1(≤ 2.5s;任意时刻可反向再点击);天空双色穹、海面双色/反射/高光、主光色温(暖金→冷蓝)与照度、环境光 skyColorHDR/skyIllum 同步演变;2.5s 后 toneMix=1.000,画面均色 (140,102,67)→(40,57,96),最大通道偏移 100.4(阈值 8),暖端 R-B=+73、冷端 B-R=+56。
- **P6(reset #1)**:reset 执行释放并重建——GLTFInstance.dispose() + GLTFAsset.destroy()(船)、mesh.destroy() + material.destroy()(海面/天穹,显式释放 GPU 资源)、节点销毁,然后重建环境并重新网络加载 GLB;恢复 toneMix=0、方位角 35°、simTime=0;epoch=1、assetLoaded=true、toneMix=0、cameraAzimuth=35(32-38 内),3s 内完成,画面 litRatio=1.000,无页面导航(非整页刷新)。
- **P7(reset #2 连续稳定性)**:第二次 reset 正常完成:epoch=2、assetRequests=3、toneMix=0、画面正常;全程 3 次 boat.glb 网络请求均 200;JS 堆 35.3MB→34.0MB(无增长);无未捕获异常、无 console error。

补充契约:`__bench.getState()` 返回 spec.stateContract 全部 8 字段;fps 为 2s 滚动平均(实测 60.5);太阳方位角 208°(相机视线 215° 偏侧 7°)、暖端仰角 5°(贴地平线,实测日盘+海面镜面高光带质心 x=0.569,maxLum=255)、冷端 15°(月盘质心 x=0.614);海平线实测位于画面 0.34 高度(≈上 1/3),海面占 ~66%。

## 2. 自检清单(§5 完成合同)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run build` 于 workspace/ 根,退出码 0 | **通过**(7 次 build 全部 exit 0) | WORKLOG;dist/app.js + dist/vendor/* |
| 2 | 页面 10s 内 `window.__appReady === true` | **通过**(实测 ~1.2s,含资产加载) | verify#3 P1 |
| 3 | `window.__bench = { getState, reset }` 契约 | **通过**(8 字段齐全,可调用) | verify#3 全部探针 |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | **通过**(pageerror=0,console.error=0,含交互与双 reset 全程) | verify#3 ALL |
| 5 | 探针自检:P1-P7 状态断言 + 视觉断言 | **通过 24/24**(verify/verify-report.json) | verify#3;截图 shots/ |

## 3. 合规声明(§4 红线逐条)

1. **另一 Arm 一切**:未访问。全程仅操作 `bench/results/PAIR-E02-K0-R01/arm-a/`。
2. **bench/reference/**:未访问。
3. **bench/results/ 其他目录 / 既往 trial**:未访问(本 Run 未读取任何本 Arm 目录之外的 results 内容)。
4. **bench/harness/ 源码与合同模板**:未访问。
5. **引擎源码仓库**(E:\AIProMax\github\cocosair.js、three.js r186 树):未访问;引擎仅使用本 Arm workspace 内 vendored 的 node_modules/cocosair.js(合同明示为模板组成部分)。
6. **bench/docs/**:未访问。
7. **bench/secret/**:未访问。
8. **联网**:无任何网络请求(验证目标仅为本机 127.0.0.1:7102 dev server;未做文档/搜索/registry 请求)。
9. **npm install / 新依赖**:未执行;仅使用 vendored 依赖与模板 build 脚本。
10. **修改冻结文件 / harness / 探针**:brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针均未修改;assets/ 只读使用(boat.glb 以字节拷贝进 workspace 供 dev server 提供,源文件未动,sha256 复核一致)。
11. **探测/篡改 harness**:未做任何针对 harness/validator 的探测或篡改;页面暴露的 `__e02Debug` 仅为自身材质对象引用(自检用途),不涉及期望值。

另:浏览器验证以本机 playwright-core + Chromium 无头实例驱动自有 dev server(127.0.0.1:7102),浏览器会话计数已在 WORKLOG 如实双口径申报(完整验证套件 3 次;若计全部诊断会话共 11 次)。

## 4. 关键技术决策(K0 冷启动,仅 README)

- 自定义 Effect 走运行时注册:`Object.assign(new EffectAsset(), {techniques, shaders}).onLoaded()`(与引擎 builtin 注册同路径);material UBO 成员全 vec4(引擎 handle 打包为顺序槽位,与 std140 对齐要求一致);`setProperty` 必须传 Vec4/Color 实例(普通数组会走 setUniformArray 逐元素写 → NaN,为本次黑屏根因#1);方向类 uniform 不得带 `linear: true`(否则被 sRGB→linear 变换扭曲,根因#2)。
- 船体起伏与海面相位耦合:GLSL 与 JS 双侧镜像同一组 Gerstner 常数(dx,dz,k,w,Q,A)。
