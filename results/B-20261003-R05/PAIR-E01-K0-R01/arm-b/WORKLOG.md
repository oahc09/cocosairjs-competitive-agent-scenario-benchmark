# WORKLOG — PAIR-E01-K0-R01 / arm-b (cocosair)

```text
2026-10-03T17:08:00+08:00 | 读合同/brief/spec/knowledge/模板与引擎 d.ts 调研 | 成功:确定渲染路径(克隆 builtin-unlit 反射 + 自写点渲染 GLSL + pass.primitive=POINT_LIST;PSO primitive 来自 pass.primitive,已从 bundle 源码核实)
2026-10-03T17:12:00+08:00 | 场景实现(src/main.js) | 成功:50k 星点(核球9000+旋臂/盘面36000+背景壳5000)、2 条对数旋臂、半径色温梯度、3 档亮暗层级、视差/滚轮平滑、HUD、reset
2026-10-03T17:14:00+08:00 | build #1 (npm run build) | 成功:dist/app.js 15.0kb,引擎 external,退出码 0
2026-10-03T17:15:00+08:00 | serve 启动(PORT=7119, 后台) | 成功:GET / 200
2026-10-03T17:16:00+08:00 | 浏览器验证 #1(verify-browser,计数 browser#1) | 失败:gfx.Factor 不存在(Cocos4 命名为 gfx.BlendFactor),effect 构建抛错 → 画面黑
2026-10-03T17:18:00+08:00 | 修复 + build #2 + 浏览器验证 #2(browser#2) | 部分成功:__appReady=true、__bench 契约成立、无未捕获异常;但画面全黑,console 3 条 error
2026-10-03T17:20:00+08:00 | 诊断会话(browser#3,已先 count.mjs browser) | 失败:playwright 默认 chromium 未安装,launch 失败(无会话创建,计数已按规先计)
2026-10-03T17:21:00+08:00 | 诊断会话 #2(browser#4,已先计数) | 成功:抓到 shader 编译失败原因 —— WebGL2 使用 glsl3(ES 3.00)变体,builtin 经 toGlsl3 剥离 layout(set/binding),我直接照抄 glsl4 源导致编译失败
2026-10-03T17:22:00+08:00 | 诊断会话 #3(browser#5,已先计数) | 成功:确认错误明细(invalid layout qualifier),同上
2026-10-03T17:24:00+08:00 | 修复(glsl3 变体 = toGlsl3 同构转换)+ build #3 + 诊断会话 #4(browser#6) | 成功:shader 编译零错误、无未捕获异常、无 GL 警告;state 实测 {starCount:50000, rotationPhase:0.238@4s(≈0.06rad/s), fps:59.5, cameraDistance:120, parallaxOffset:{0,0}, epoch:0};HUD 文本实测含 STARS: 50000 / DIST: 120.0;发现 HUD FPS 显示恒 0(仅 getState 内刷新)
2026-10-03T17:27:00+08:00 | 预算核对 | browser.count 已达 6/6 上限(RUN-CONTRACT §2 触限即终止浏览器验证)→ 停止一切浏览器会话
2026-10-03T17:29:00+08:00 | 代码终修(静态推演)+ build #4 | 成功:①HUD FPS 改为每帧 rollingFps() 刷新;②DIST_RATE 3.5→2.5(保证 P4 双样本窗内距离增量 ≥5);③点尺寸重映射为世界尺寸 0.10–0.55(避免 17–20px 巨点);退出码 0
2026-10-03T17:30:00+08:00 | serve 停止 | 成功:释放 7119 端口交还正式采样阶段
```
