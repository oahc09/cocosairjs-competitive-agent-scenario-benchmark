# RESULT — PAIR-E02-K0-R01 / Arm B (engine: three, K0)

Run 完成:2026-10-02T13:40Z | build 尝试 1/8 | 浏览器验证 4/6 | 详见 WORKLOG.md

---

## 1. 实现摘要(逐 probe)

- **P1(就绪+资产+网络+非空白)**:`GLTFLoader` 在运行时对 `assets/boat.glb` 发起真实 fetch(构建不内联;文件由 `arm-b/assets/boat.glb` 只读拷贝至 `workspace/assets/`,sha256 与 spec 一致);加载完成且含船体首帧渲染后 `__appReady=true`(实测 418ms),`assetLoaded=true`、`assetRequests=1`;截图 99.93% 非空白。自检实测:网络响应 200,avgColor R=159.2 > B=80.9(暖端)。
- **P2(海面持续运动)**:海面为 177×177=31,329 顶点的程序化曲面,顶点着色器内 5 个重力行进波叠加(相位 `k·(d·p)−ωt`,波峰沿风向推进),`uTime=simTime` 每帧推进;`wavePhase`(=simTime)采样窗 2.667→4.517;下 60% 区域 1500ms 运动像素 75.99%。
- **P3(船体随波起伏)**:船体 y 由与 GPU 完全同一组波参数的 CPU 函数 `waveHeight(0,0,t)` 驱动(船位于原点,GPU 距离衰减=1,严格相位耦合),纵摇/横摇取自波面坡度;900ms 窗 y 1.5939→1.5733 变化,中央 40% 运动像素 63.37%,4s stateSeries 竖直极差 0.3129(≥0.02)。
- **P4(拖拽环绕)**:指针水平拖拽→方位角目标增量(0.28 视口宽 ≈175°,窗口期 39.69° >20°),逐帧指数平滑无跳变;构图改变 full 帧差 78.56%(窗口期 43.57%)。
- **P5(色调切换)**:`button[data-ui=tone-toggle]`(可见文本 "Tone 色调",aria-label 同)点击后 toneMix 以 2.0s smoothstep 0→1(<2.5s),天空渐变/太阳-月亮光盘/海面深色-反射-高光/方向光-半球光-补光同时插值;2.5s 后 toneMix=1>0.7,avgColorShift=58.21(≥8),暖端 R−B=+79.4、冷端 B−暖端B=+20.6。
- **P6(Reset #1)**:`button[data-ui=reset]` 执行释放并重建——遍历 dispose 船网格 geometry/material/texture 与海面 geometry/material(显式释放 GPU 资源),重建海面并重新 `GLTFLoader.load`(boat.glb 再次 200);toneMix 立即回 0、方位角/俯角回 35°/10°、simTime 回 0,epoch+1;3s 内 assetLoaded=true、az=35、画面 99.93% 非空白;无页面导航(navCount=1)。
- **P7(Reset #2 连续稳定性)**:第二次 reset 同样完成,epoch=2、assetRequests=3(≥2)、toneMix=0,画面正常;零 console error/pageerror;内存证据见下。

**NC05/泄漏补充证据**:5x 与 12x reset 循环全部恢复、零错误;CDP `HeapProfiler.collectGarbage` 强制 GC 后残留 JS 堆:8.0→8.5→8.6→8.7 MB(每批 6 次 reset 共 18 次,增量收敛)— 无泄漏征象。fps 全程 60(2s 滚动平均,≥30)。

实现文件:`workspace/src/main.js`(场景全部逻辑);`workspace/scripts/probe-verify.mjs`(探针自检)、`workspace/scripts/analyze-shots.mjs`(本地像素分析)、`workspace/scripts/reset-loop.mjs`(reset 稳定性);模板 build/serve 脚本与 index.html 未改动。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. `npm run build` 退出码 0**(workspace 根执行;dist/app.js 15.8KB,引擎 external,产物自检 OK;dist/index.html 由根 index.html 生成并被引用)
- [x] **2. 页面 10s 内 `window.__appReady === true`**(实测 418ms,含 boat.glb 加载;`assetLoaded` 同步为 true)
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立**(getState 返回 assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch;reset 可调用且语义正确)
- [x] **4. 无未捕获异常**(加载、拖拽、切换、多次 reset 全程 console 零 error、零 pageerror)
- [x] **5. 探针自检按 spec.json 逐条通过**(probe-verify.mjs 22/22 PASS,状态断言+视觉断言+网络/DOM 证据;另以本地像素分析佐证构图锚点)

## 3. 合规声明(RUN-CONTRACT §4 红线逐条)

1. **未访问另一 Arm 的任何内容**:本 Run 全程未读取/探测 `arm-a/`(目录、代码、日志、server、profile、截图、结果)。
2. **未访问 `bench/reference/`**。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录,未读取任何既往 trial 结果**(工作目录仅为 `bench/results/PAIR-E02-K0-R01/arm-b/`)。
4. **未访问 `bench/harness/` 源码与合同模板**。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅使用本 Arm workspace 内 vendored 的 npm 包(`node_modules/three@0.186.1` 及其 examples/jsm,属模板拷贝、允许使用)。
6. **未访问 `bench/docs/`**。
7. **未访问 `bench/secret/`**。
8. **无任何联网行为**:未发起文档/搜索/registry 等网络请求;仅与本机 `127.0.0.1:7103` dev server 通信(本地回环,用于加载页面与资产);未使用任何会访问远程 URL 的工具。
9. **未执行 `npm install` 或安装任何新依赖**(仅用模板 vendored 依赖:three/esbuild/playwright-core)。
10. **未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件**(本 Arm 的 `assets/` 共享资产同样只读未改;所有写入仅发生在 `workspace/`、`WORKLOG.md`、`RESULT.md`)。
11. **未探测或篡改 harness/validator 的行为与期望值**(自检脚本为本 Run 自建,仅观测自身页面)。

补充:dev server 按合同 §0 括号指示以 `PORT=7103` 启动(§0 表格标称 7101,以括号内执行指令为准),验证结束后已停止并释放端口。

## 4. Forbidden Shortcuts 对照(spec.json)

- GLB 为运行时网络请求加载,未构建期转译/内联(实测 3 次请求均 200);
- 船体为资产本体(6 部件、6 材质),非占位几何;材质原样保留,受光/背光面对比可见;
- 海面为顶点级行进波,非贴图滚动/静止几何/相机晃动;
- 船体运动与波形同源同相位,非随机抖动;
- 状态声称均有像素/网络/DOM 佐证;画面为 WebGL 3D 渲染;
- reset 无整页刷新(navCount=1),旧资源显式 dispose,强制 GC 后堆平坦;
- 画布全视口 1280×720,无隐藏/遮挡/1px 缩放手段。
