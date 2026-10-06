# RESULT — PAIR-E01-K0-R02 / arm-b (engine: three, knowledge: K0)

> 实现文件:`workspace/src/main.js`(唯一改动;index.html / scripts / brief / spec 均未改动)。
> 预算实际消耗:build 1/8(`.budget/build.count`),browser 1/6(`.budget/browser.count`)。

## 1. 实现摘要(逐 probe)

- **P1(starCount + 非空画面)**:单 `THREE.Points` 批量提交 56,000 星点(48,000 旋臂/盘面 + 8,000 核球)+ 独立 4,000 远景背景星,`starCount=60000 ≥ 50000` 且与真实顶点数一致;加法混合辉光点渲染,亮像素远超 2%,截图可见旋臂盘面与核球。
- **P2(持续旋转)**:`rotationPhase += dt × 0.05 rad/s`(规格区间 [0.02,0.1])时钟增量单调递增并作用于星系组旋转;自检 2s 窗增量 0.100 rad > 0.001,中央 80% 区域星点切向流动产生运动像素。
- **P3(指针视差)**:`pointermove` 归一化指针偏移 × 满幅 ±5% 画布(≤10% 上限),指数平滑(τ=0.3s)无过冲,驱动相机小幅横向偏移使近景星系相对远景位移;自检 x 由 0 → 0.01736 变化,画面出现可测像素变化。
- **P4(滚轮穿行)**:`wheel` deltaY 累乘 0.12 映射到目标距离,钳制 [40,400],实际距离逐帧指数插值(τ=0.5s,平滑不瞬跳);deltaY=-600 时目标 -72,自检 500ms+300ms 窗内 73.63 → 62.06(缩短 11.57 > 5),近距星点放大变疏、构图显著变化。
- **P5(HUD)**:左上角 2D 覆盖层实时显示 `Stars / FPS / Dist`,全部取自真实运行状态(四舍五入),`hudVisible=true`;自检 HUD 文本 "Stars: 60000 | FPS: 60 | Dist: 48" 与同期 getState 一致;HUD 面板自带可见背景与文字,区域非空。
- **P6(帧率)**:2s 滚动窗真实帧时间平均;60,000 星点仅 2 个 draw call,空闲与交互态均稳定 60fps(自检 60 ≥ 30)。
- **P7(Reset)**:HUD 内 `Reset` 按钮(`data-ui="reset"` + `aria-label="reset"` + 可见文本);点击后 `epoch+1`、`rotationPhase` 立即归零、相机距离与视差以更快时间常数(τ=0.12s/0.1s)逐帧平滑归位(1s 内完成,非整页刷新、无导航);自检 800ms 后 epoch=1、dist=119.91∈[115,125]、视差=0、rotationPhase=0.04<0.1;连续二次 reset 行为一致(epoch=2、dist=120、phase≈0.04)。

视觉锚点对照:背景 RGB(2,3,10) 近纯黑;颜色沿半径 暖黄白→蓝白→冷蓝 梯度并散布橙红亮星;亮度三档(核球亮星/盘面普通星/暗弱背景星);2 条对数螺旋臂 + 中央隆起核球,盘面有厚度;初始斜俯视(盘面法线与视线夹角 56°),盘面约占画宽 63–73%;星点/结构全部程序化生成,无任何外部图片/模型/预渲染资源。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(build #1,esbuild 9.3kb,产物自检 OK,`dist/` 被 index.html 引用)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(首帧渲染后即置 true,实测远小于 10s)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true)。
- [x] 4. 无未捕获异常(consoleErrors=0,uncaught=[],覆盖加载/交互/reset 全流程)。
- [x] 5. 探针自检:P1–P7 状态断言 + 视觉/运动/DOM 证据逐条通过(allOk=true,证据:`evidence/selfcheck-p1.png`、`evidence/selfcheck-eval.js`、WORKLOG 记录)。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录或既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板(仅使用模板预置于 workspace 的 scripts 以规定入口执行)。
5. 未访问 `bench/vendor/` 引擎资产目录及引擎上游源码仓库(three.js r186 源码树)。
6. 未访问实验计划书与 `bench/docs/` 合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档检索、无搜索、无包 registry 访问;页面仅加载本地 vendored 引擎)。
9. 未执行 `npm install`、未安装/改动任何依赖,未改动共享 node_modules。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(自检探针仅按 spec.json 声明的断言自行验证)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;构建经 `npm run build` 串联 count.mjs,浏览器会话一律经 `scripts/verify-browser.mjs`,无任何绕过计数的行为。

**结论**:完成合同 §5 五项全部满足,Run 判定请求 = COMPLETE(预算富余:build 1/8,browser 1/6)。
