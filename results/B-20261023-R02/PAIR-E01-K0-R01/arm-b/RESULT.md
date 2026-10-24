# RESULT — PAIR-E01-K0-R01 arm-b (cocosair)

## 1. 实现摘要(逐 probe)

- **P1(50k 星点 + 非空画面)**:60,000 个程序化星点(核球 12,000 高斯椭球 + 盘面 40,000 双对数螺线旋臂 82%/随机散布 18% + 远景背景星 8,000 球壳),以两个 POINT_LIST 单顶点束网格提交( galaxy 52k + background 8k,共 2 draw call,共享一份材质),`starCount=60000` 与真实顶点数一致;`utils.MeshUtils.createMesh` + 显式 minPos/maxPos;截图经视觉分析确认旋涡结构、核球、盘面占宽 60–75%、亮像素占比 ≈3–6%(> 2% 阈值)。
- **P2(旋转)**:星系节点绕盘法线 Y 轴持续旋转,角速度 0.06 rad/s(合同区间 0.02–0.1),`rotationPhase` 单调递增;实测 2s 采样窗 Δphase=0.121 > 0.001,画面运动像素由真实星点位移提供。
- **P3(视差)**:窗口捕获层 pointermove/mousemove + 引擎 `input.on(MOUSE_MOVE)` 双路径,归一化有符号偏移目标,指数平滑(6/s);实测指针 0.50→0.68 后 parallaxOffset.x 0.327→0.359(采样窗内仍在收敛,断言 `!=` 成立),相机横移幅度 8 世界单位 ≈ 画布宽 5%(< 10% 上限),远景背景星层与星系盘的透视差异构成真实相对位移。
- **P4(滚轮穿行)**:捕获层 wheel 监听,deltaY=-600 → 目标距离 -96(钳制 [40,400]),指数平滑 3/s 逐帧插值;实测 before 57.85 → after 47.25(Δ10.59 > 5,双倍裕度,可抗采样时延),画面构图随距离变化。
- **P5(HUD)**:DOM 覆盖层(左上、pointer-events:none)显示 Stars/FPS/Dist/Phase/Epoch,数值直接取自 `__bench.getState()` 同源数据,4Hz 刷新;实测文本 "Stars 60000 | FPS 61 | Dist 120 …" 与状态一致。
- **P6(帧率)**:EVENT_AFTER_DRAW 时间戳 2s 滚动窗平均;实测空闲态 fps=60–61 ≥ 30;静态网格 + 单材质 2 draw call,无逐帧顶点上传,交互态同等负载。
- **P7(Reset)**:HUD 区域右上 Reset 按钮(data-ui="reset" + aria-label="reset" + 可见文本),点击后 epoch+1、相机距离以 12/s 快速平滑回 120、视差归零、旋转相位归零,无整页刷新;实测 epoch=1、dist=119.92(∈[115,125])、par {0.0005,~0}(<0.01)、phase=0.048(<0.1);连续多次 reset 幂等(epoch=3, dist=120.0)。

技术要点:自定义手写 Effect JSON(glsl3 变体,WebGL2 实际消费),CCCamera/CCLocal 内建 UBO 成员布局与引擎逐字对齐,材质 Constants UBO(set=1/binding=0)提供 u_pointParams(设备像素高/(2·tan(fov/2)) 的透视点尺寸因子);pass.primitive 与 mesh.primitiveMode 双 POINT_LIST(PSO 契约);顶点着色器写 gl_PointSize(1.5–40px 钳制),片元 gl_PointCoord 圆形软边 + 加色混合(SRC_ALPHA, ONE)。

## 2. 自检清单(§5 完成合同)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 0(build #3,`dist/app.js` + `dist/vendor/cocosair.module.js`,index.html 经 importmap 引用 dist)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测首帧后立即置 true,5 次会话均通过)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true,字段 starCount/rotationPhase/cameraDistance/parallaxOffset/fps/hudVisible/epoch 齐全)。
- [x] 4. 无未捕获异常(5 次浏览器会话 console error = 0,uncaught = [])。
- [x] 5. 探针自检:P1–P7 按合同口径逐条模拟(状态断言 + 时序 waitMs/sampleWindowMs),全部通过(见 WORKLOG 与实现摘要);视觉证据截图 3 张存 selfcheck/。

## 3. 合规声明(§4 红线逐条)

1. **另一 Arm**:未访问 arm-a 的任何目录/代码/日志/服务器/截图/结果。
2. **reference/**:未访问。
3. **bench/results 其他目录 / 既往 trial**:未访问;本 Run 仅读写本 Arm 目录。
4. **harness/ 源码与合同模板**:未访问、未修改。
5. **bench/vendor/ 与引擎上游源码仓库**:未访问(含 `E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。引擎运行时仅使用本 Arm workspace 内自带的 `dist/vendor/cocosair.module.js`(模板预置产物、页面 importmap 的运行时依赖),并以其内嵌数据核对 UBO 布局——该文件位于本 Arm 白名单目录内。
6. **bench/docs/ 合同文档目录**:未访问。
7. **secret/**:未访问。
8. **联网**:全程无任何网络请求(仅 127.0.0.1:7205 本地 dev server)。
9. **npm install / 依赖改动**:未执行;依赖由上层共享 node_modules 解析,未改动共享仓内容。
10. **brief/spec/合同/harness/探针文件**:未修改。
11. **探测/篡改 harness/validator**:未进行;所有自检均为黑盒页面侧验证(verify-browser.mjs + 页面内求值)。
12. **机器计数**:未手改/伪造/删除/重置 `workspace/.budget/`;build 全部经 `npm run build`(3 次)、浏览器会话全部经 `verify-browser.mjs`(5 次),均自动计数。

## 附:预算消耗

build 3/8 · 浏览器验证 5/6 · toolCall ≈45/120 · 墙钟 ≈55 分钟(未触顶)。
