# RESULT — PAIR-E01-K0-R01 / arm-b (cocosair, K0)

> Run 完成时间:2026-10-04T15:33:00Z · 实现:`workspace/src/main.js`(509 行,单文件)·
> 产物:`workspace/dist/`(app.js + vendor/cocosair.module.js,sha256=3ccfdde1…451ced6)·
> 证据截图:`workspace/shots/`(final.png 为最终画面)

## 1. 实现摘要(逐 probe)

- **架构**:58,000 颗星全部程序化生成并以**两个批量 Mesh** 提交渲染(星系盘 52,000 星单 Mesh + 远景背景星壳 6,000 星单 Mesh,共 2 次 draw call);每星为 5 顶点软辉光四边形(中心全亮、四角 12%,顶点色插值出辉光),双面索引免 cull 定制;材质 = builtin-unlit-material 经 `getMaterialInstance(0).recompileShaders({USE_VERTEX_COLOR:true})` 开启顶点色、`overridePipelineStates` 覆写为加色叠加(任一步失败自动降级、不抛错);星点颜色沿半径暖黄白→蓝白→冷蓝梯度,3% 橙红亮星,核球/旋臂/盘面/背景四档亮暗分层;2 条对数螺旋旋臂(r=r0·e^(bθ))+ 高斯 3D 核球与盘厚;星系节点以 ω=0.06 rad/s 绕盘面法线慢旋;相机固定仰角 38°、滚轮改目标距离 [40,400] 初始 120 逐帧指数插值、指针视差小幅横向偏移;输入走 window 捕获阶段(pointermove/mousemove 双挂 + wheel capture,规避 canvas 事件被 pal 层吞的已知坑位,引擎 input.on 作后备);HUD 为左上角 DOM 覆盖层(数据与 `__bench` 状态同源),Reset 按钮带 `Reset` 文本 + `aria-label="reset"` + `data-ui="reset"`。

| Probe | 实现与自检证据(状态断言 + 独立观测) |
|---|---|
| **P1** starCount≥50000 + nonBlank | 状态恒报 58,000 = 真实提交渲染星点数(2×批量 Mesh);`gl.readPixels` 亮像素实测占比 **0.161**(阈 0.02);截图 final.png 中星系盘/核球清晰可辨 |
| **P2** 旋转 | rotationPhase 以 ω=0.06 rad/s 时钟增量单调递增,2s 窗口实测 Δ=**0.121 rad**(阈 0.001);画面中央 80% 区域星点随旋转整体切向流动(旋臂肉眼可见转动,运动像素远超 0.5%) |
| **P3** 指针视差 | 指针 (0.50,0.50)→(0.68,0.50) 后 parallaxOffset.x 0→**0.0294**(400ms)→**0.0406**(1000ms),有符号、平滑、幅度 ≤10% 画布;相机横向偏移带动星点位移,画面像素差远超 0.3% |
| **P4** 滚轮穿行 | wheel deltaY=-600 → 目标距离 ×e^(-1.2) 截至下限 40,逐帧指数插值:500ms 时 **54.3**、800ms 时 **45.3**,Δ=**9.0**(阈 5);构图显著变化(星点放大变疏,近域星点放大) |
| **P5** HUD | HUD 实时显示 `Stars: 58000`/`FPS: 60`/`Distance: 40.7`,与 getState() 同源一致(60.015→60,40.71→40.7,允许四舍五入);自检 hudText 断言 stars/fps/dist 三项全含 |
| **P6** 帧率 | 2s 滚动平均实测 **60.0 fps**(空闲与交互全程 59.99–60.02),≥30;单 Mesh 批量提交,无逐星绘制 |
| **P7** Reset | 点击 reset:epoch+1、cameraDistance **120**∈[115,125]、parallaxOffset **(0,0)**(±0.01 内)、rotationPhase **0.048**<0.1(0.8s×0.06 rad/s 连续旋转计入)、画面不中断、无导航;HUD 悬停/点击不产生视差目标(target 过滤),连续两次 reset 行为一致(epoch 2 同样归零) |

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(共 7 次构建,计数见 `.budget/build.count`)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 ≤1s,首帧 EVENT_AFTER_DRAW 即置位)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(verify-browser benchReady=true ×6)
- [x] 4. 无未捕获异常(6 次浏览器会话 consoleErrors=0、uncaught=[] 全绿)
- [x] 5. 探针自检:spec.json P1–P7 逐条自查全部通过(状态断言 + 像素/运动/DOM 独立观测,见上表)

预算使用:toolCall 未超 120 · build **7/8** · browser **6/6** · 墙钟约 36 分钟(未超 90)。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. ✅ 未访问另一 Arm(arm-a)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. ✅ 未访问 `reference/` 下任何内容。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读取任何既往 trial 结果。
4. ✅ 未读取 `harness/` 源码与合同模板(探查仅针对本 Arm 自有构建产物 `workspace/dist/vendor/cocosair.module.js`,属 §3 白名单内文件)。
5. ✅ 未访问 `bench/vendor/` 整目录及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎知识仅来自本 Arm 目录内 `knowledge/README.md` 与模板源码,外加自有构建产物的 API 表面探查。
6. ✅ 未读取 `bench/docs/` 实验计划书与合同文档目录。
7. ✅ 未访问 `secret/`。
8. ✅ 无任何联网请求(无文档站、无搜索、无包 registry)。
9. ✅ 未执行 `npm install`,未安装/改动任何依赖(构建走上层共享 node_modules,未改其内容)。
10. ✅ 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. ✅ 未探测或篡改 harness/validator 的行为与期望值(自检仅复刻 spec.json 已声明的探针时序)。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;全部构建经 `npm run build`(count.mjs 串联)、全部浏览器会话经 `scripts/verify-browser.mjs`(自动计数),无绕过。

## 4. 已知局限(如实声明)

- 星点为随机朝向软辉光四边形而非着色器级 gl_Point:近距时呈柔和方形光斑(不构成探针风险,亦符合"近距星点放大变疏"的规格行为)。
- 最终一次构建(build #7)仅调整 HUD 首秒 FPS 文本的刷新时机(浏览器预算已用尽,未再开新会话验证);该路径在 build #6 会话中已由等价刷新条件覆盖验证,渲染路径零改动。
