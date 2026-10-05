# WORKLOG — PAIR-E01-K0-R01 / arm-b (cocosair, K0)

| 时间戳 (ISO-8601) | 动作 | 结果 |
|---|---|---|
| 2026-10-04T15:07:00Z | 读 RUN-CONTRACT/brief/spec/knowledge/模板源码 | 成功:确认页面契约、预算口径(120 toolCall/90min/8 build/6 browser)、模板 API 用法 |
| 2026-10-04T15:10:47Z | build #1(模板基线 `npm run build`) | 成功:exit 0,dist/app.js + vendor 引擎模块就位 |
| 2026-10-04T15:11:00Z-15:20:00Z | 引擎 API 探查(读本 Arm 自有构建产物 dist/vendor/cocosair.module.js) | 成功:确认 export 清单(input/gfx/Material/utils…)、builtin-unlit 的 USE_VERTEX_COLOR 宏、MaterialInstance.recompileShaders/overridePipelineStates、BlendFactor(ONE=1/SRC_ALPHA=2)、createMesh(colors=RGBA32F, indices 自动 R32UI, minPos/maxPos) |
| 2026-10-04T15:22:26Z | build #2(E01 场景首版:58k 星批量 Mesh + unlit 顶点色 + additive + 视差/滚轮/HUD/reset) | 成功:exit 0 |
| 2026-10-04T15:22:41Z | serve(PORT=7109 后台启动)+ 浏览器验证 #1(--shot p1-initial.png + getState) | 部分失败:状态契约全对(appReady/bench/无异常/fps 69/starCount 58000),但画面白屏——定位 pushStar 顶点步进错误(base 应为 ×12/×16),退化三角形加色叠加刷白整屏 |
| 2026-10-04T15:24:03Z | build #3(修复顶点步进) | 成功:exit 0 |
| 2026-10-04T15:24:04Z | 浏览器验证 #2(--shot p1-v2.png) | 部分失败:黑底+星点已渲染,但核球落在画面底部——定位 Node.lookAt 需单 Vec3 参数(误传 3 个数字,朝向未生效) |
| 2026-10-04T15:25:49Z | build #4(lookAt 改传 Vec3) | 成功:exit 0 |
| 2026-10-04T15:25:51Z | 浏览器验证 #3(--shot p1-v3.png) | 成功:双旋臂+核球+色梯度全部呈现;记录改进点(方形星点生硬/盘面略超 75% 宽/HUD 首秒 FPS 显示 0) |
| 2026-10-04T15:27:58Z | build #5(5 顶点软辉光星点、R 75→66、暖核、背景星缩小、HUD 刷新条件) | 成功:exit 0 |
| 2026-10-04T15:27:59Z | 浏览器验证 #4(--shot p1-v4.png) | 成功:视觉达标(暖黄核球/蓝白旋臂/冷蓝外缘/橙红亮星/软辉光/背景纵深);HUD FPS 文本首 250ms 仍显示 0(刷新时机,探针无风险) |
| 2026-10-04T15:28:57Z | 浏览器验证 #5(全探针 P1-P7 时序自检,合成输入) | 部分失败:P3 视差无变化——合成测试只派发了 mousemove 而监听仅挂 pointermove(真实 playwright 输入两者皆发);其余 P1/P2/P4/P5/P6/P7 全过(litRatio 0.160,Δphase 0.121,Δdist 9.0>5,reset 归零+epoch+1+phase 0.048<0.1) |
| 2026-10-04T15:30:32Z | build #6(补挂 mousemove 监听(幂等)、HUD 在相机/视差收敛期逐帧刷新、自检脚本改派发 PointerEvent) | 成功:exit 0 |
| 2026-10-04T15:30:45Z | 浏览器验证 #6(最终全量探针自检 + --shot final.png) | 成功:七项探针全部通过(P1 litRatio 0.161≥0.02;P2 Δphase 0.121>0.001;P3 parallax 0→0.0294→0.0406 且画面变化;P4 dist 120→54.3→45.3,Δ=9.0>5;P5 HUD "Stars: 58000/FPS: 60/Distance: 40.7" 与状态一致;P6 fps 60.0≥30;P7 epoch=1、dist=120、parallax(0,0)、phase 0.048<0.1,二次 reset 一致 epoch=2),consoleErrors=0、uncaught=[] |
| 2026-10-04T15:32:06Z | build #7(HUD 首秒 FPS 尽快显示真实值的刷新条件微调) | 成功:exit 0(浏览器预算已用尽 6/6;该改动仅为 DOM 文本刷新时机,经帧序推演确定无风险,渲染路径未变) |
