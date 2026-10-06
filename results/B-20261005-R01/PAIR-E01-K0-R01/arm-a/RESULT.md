# RESULT — PAIR-E01-K0-R01 / arm-a(three r186,K0)

> 实现入口:`workspace/src/main.js`(单文件、全程序化,无任何外部图片/模型/预烘焙资源)。
> 构建:`npm run build` 退出码 0(build #1);dev server 运行于 `http://127.0.0.1:7100/`(本 Arm 保留端口,保持运行)。
> 证据:`probe1.png`(会话 #1 初始态截图)、`probe2.png`(会话 #2 初始态截图,人工核验旋臂/核球/梯度/HUD)。

## 1. 实现摘要(逐 probe 一句话)

- **P1(starCount + 非空画面)**:两份 BufferGeometry 的真实顶点数之和 60,000(旋转星系 54,000:核球 10,000 + 2 条对数螺旋旋臂 32,000 + 盘面散星 12,000;静态远景星壳 6,000)作为 `starCount` 上报,两次批量 draw call 渲染,自检实测 60000 ≥ 50000,加色混合星点在近黑背景上亮像素占比远超 2%。
- **P2(持续旋转)**:`rotationPhase` 每帧累加 ω=0.05 rad/s×时钟增量并作用于星系组绕 +Y 的旋转,2s 采样窗实测增量 0.1 rad(> 0.001),中央 80% 区域星点切向流动产生运动像素。
- **P3(指针视差)**:指针偏离画面中心的有符号归一化偏移驱动相机小幅横移后回看原点(近处星系与 1400–3000 单位外远景星产生真实 3D 相对位移),指数平滑无过冲,实测视差 0 → 0.1746,画面整体位移约 16px(> 0.3% 像素差)。
- **P4(滚轮穿行)**:`wheel` 以 `targetDist = clamp(targetDist·e^(ΔY·0.0008), 40, 400)` 改变目标距离,逐帧指数平滑(速率 2.5/s,无瞬跳),deltaY=-600 后距离 120 → 80.2,动作后即采(Δ=39.8)与 500ms 后采(Δ=6.6)两种时序均满足"> 5",星点明显放大变疏。
- **P5(HUD)**:左上角 DOM 覆盖层实时显示星点总数(60000)、FPS(整数四舍五入)、相机距离(0.1 精度)与轮次,数值全部取自与 `__bench.getState()` 同源的运行时变量,`hudVisible=true`,面板含可见文本 "Reset" 按钮(`data-ui="reset"` + `aria-label="reset"`)。
- **P6(帧率)**:最近 2s 滚动帧时间戳窗口计算平均帧率,自检实测稳态 fps=60(≥ 30),交互与 reset 过程中同样满足;50,000+ 星点仅 2 次 draw call,无逐点提交。
- **P7(Reset)**:`reset()` 原子地恢复距离 120、视差 {0,0}、旋转相位 0 并使 `epoch` +1(瞬时完成 < 1s,非整页刷新,无导航),并忽略旧指针残留位置直至下一次 pointermove;自检在距离 100.9、指针偏右的偏离状态下执行,实测 epoch=1、d=120、视差 0、phase=0.04(< 0.1)。

视觉锚点达成:近黑背景(#000);颜色沿半径梯度(核心暖黄白 → 旋臂中段蓝白 → 外缘冷蓝 + 约 2.5% 橙红亮星);≥3 档亮暗层级(核球亮星/旋臂普通星/盘面暗弱星/远景微光星);45° 斜俯视(法线与视线夹角 ∈ [30°,60°] 中点),盘面投影宽度约 60–67% 画面宽;2 条对数螺旋旋臂(b=0.33,螺距角约 18°)+ 中央明亮核球 + 可感盘面厚度与中央隆起。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(build 尝试 1/8,机器计数 `.budget/build.count` #1)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(两次浏览器会话均 true;60k 星点生成 ~10ms + 首帧编译,远小于 10s)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(两会话 benchReady=true;getState 返回 starCount/rotationPhase/cameraDistance/parallaxOffset/fps/hudVisible/epoch 全字段)。
- [x] 4. 无未捕获异常(两会话 consoleErrors=0、uncaught=[],加载/交互/reset 全程)。
- [x] 5. 探针自检:P1–P7 逐条(状态断言 + 独立观测证据)全部通过——会话 #2 `allPass=true`(状态双采样实测;视觉侧:probe2.png 非空可辨、旋转/视差/穿行的状态增量均伴随对应画面变化机制;浏览器尝试 2/6,机器计数 `.budget/browser.count` #2)。

预算用量:工具调用约 16/120;build 1/8;browser 2/6;墙钟约 20 分钟/90 分钟。

## 3. 合规声明(逐条对照 RUN-CONTRACT §4)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未访问既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板(仅使用本 Arm 目录内冻结模板自带脚本:build/count/serve/verify-browser,未修改)。
5. 未访问引擎资产:未读 `bench/vendor/`、未读引擎上游源码仓库;未读共享 node_modules 内 three 包内容(K0 隔离:仅凭知识包 README、模板样例与自身知识实现)。
6. 未访问实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档查询、无搜索、无包 registry 访问;页面零外部资源依赖)。
9. 未执行 `npm install`,未安装或改动任何依赖,未改动共享 node_modules。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(仅新增/修改 workspace/src/main.js、WORKLOG.md、RESULT.md 及自检截图)。
11. 未探测或篡改 harness/validator 的行为与期望值(自检 eval 仅操作本 Arm 页面自身)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;build 与浏览器会话分别严格经 `npm run build`(count 串联)与 `scripts/verify-browser.mjs`(自动 count)执行,无任何绕行。

声明:以上逐条属实,本 Run 全程在白名单(本 Arm 目录)内完成。
