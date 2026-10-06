# RESULT — arm-b(PAIR-E03-K0-R01 · E03 太阳系仪 · cocosair · K0)

> 一次性 R0 自主 Run,遵守同目录 RUN-CONTRACT.md。实现文件:`workspace/src/main.js`(唯一源文件,esbuild 打包 → `dist/app.js`,引擎 external 经 importmap 加载)。

## 0. 实现概要

- **场景**:中心恒星(暖黄 unlit 核心 + 双层半透明光晕壳)+ 8 颗行星(名称/着色按 brief:岩质灰褐锈红、气态米黄、冰巨蓝青)+ 6 颗卫星(挂行星节点的父子层级)+ 土星半透明倾斜环 + 700 个独立小天体小行星带(独立于行星层级,位于第 4/5 轨道间 19–22.6)+ 8 条细淡轨道参考线。全部程序化几何(`primitives.sphere/torus/box` + `utils.createMesh`),无外部资产。
- **公转分层**:周期表 [190, 420, 700, 1050, 1500, 2050, 2700, 3400] 模拟秒(最内 120–240 ✓、最外 1600–4000 ✓、单调递增 ✓、内外角速比 ≈ 17.9:1),每颗初始角 = 序号 × 45°;`orbitAngle` 连续累计不取模。小行星带按半径速度分层(950–1300s)。
- **时间系统**:模拟时钟 `simulationTime += dt × timeScale`,0.5/1/2/4/8 五档 UI 按钮即时作用于全部公转/自转/卫星/带内流动,无跳变(后台标签页 dt 钳制 0.1s)。
- **拾取**:窗口捕获阶段 `pointerdown/pointerup` 监听(pal 层吞 canvas 事件的已知坑位的规避写法),命中判定基于每帧更新的 `pickTargets` 屏幕投影(解析投影,与引擎 lookAt/fov 同基准),pickRadius = clamp(screenRadius+6, 14, 55) px;点击空白(距所有投影 ≥80px)不产生选中(NC04)。
- **Reset**:状态同步复位(simTime=0、timeScale=1、选中/信息卡关闭、行星角回 k×45°、卫星/小行星回初始角),epoch+1,无页面刷新,渲染连续。
- **引擎 API 依据**:knowledge/README.md(K0 唯一知识包)+ 模板 main.js 已验证写法 + 本 Arm 内 `dist/vendor/cocosair.module.js`(页面自身加载的引擎模块,在本 Arm 白名单目录内)grep 核对:`Material.initialize({effectName, defines, states})`、`blendState.targets[0].blend → 透明队列`、`mainColor` 属性、`primitives.sphere(r,opts)/torus(r,tube,opts)`、BlendFactor 枚举值。未读 node_modules、未读 bench/vendor、未联网。

## 1. 实现摘要(逐 probe)

| Probe | 结果 | 一句话说明 |
|---|---|---|
| P1 | PASS(自检) | 初始即呈现恒星/8 行星/8 轨道线/700 体小行星带;状态 planetCount=8、moonCount=6、asteroidCount=700、ringedPlanetCount=1、timeScale=1、selectedPlanet=null;2s 采样窗内最内侧轨道角增量 0.0532 rad = 14.2× 最外侧(>4×);亮像素比远超 3%(页内实测 24.9%,阈值口径 12/255) |
| P2 | PASS(自检) | 点击 `pickTargets[2]`(earth,screenRadius 13.1px ≥8)后 `selectedPlanet=="earth"`,行星周围 5×5 屏幕格区域出现可见选中高亮圈变化(8/49 格显著变化) |
| P3 | PASS(自检) | 信息卡由点击驱动出现在行星附近(DOM `data-ui="info-card"`,实测 226×137px),含名称 earth 与 4 个数据字段(类型/轨道半径/公转周期/卫星数量),`infoCard={visible:true,name:"earth",fieldCount:4}` 与 DOM 镜像一致 |
| P4 | PASS(自检) | `ui#speed-8x` 点击后 timeScale==8,五档按钮(0.5x/1x/2x/4x/8x)均在 DOM 且 8x 高亮(`data-ui`+`aria-label` 双定位) |
| P5 | PASS(自检) | 8x 下 1.5s 采样窗:ΔsimulationTime=12.53(≥6)、最内侧行星 ΔorbitAngle=0.328 rad(≥0.05),为 1x 基线的 8 倍;页内像素运动比 1.52%(≥0.5%) |
| P6 | PASS(自检) | Reset 后 epoch=1、timeScale=1,页面标记未变(无导航/刷新),console 0 错误,画面持续渲染 |
| P7 | PASS(自检) | reset 后 ~0.93s 采样:simulationTime=0.93(<1.5)、selectedPlanet=null、信息卡关闭、planets[0].orbitAngle=0.0309(±0.06 内)、planets[7]=5.4995(5.43–5.56 内,315°+微量推进);页内像素运动比 0.48%(≥0.2%,未冻结未重载) |
| P8 | PASS(自检) | `ui#speed-0.5x` 点击后 timeScale==0.5,0.5x 档高亮,五档控件 DOM 完整,运动持续 |
| P9 | PASS(自检) | 点击 (0.08,0.08) 角点(实测距最近 pickTargets 投影 434px ≥80)不产生选中、信息卡保持关闭(NC04 负向对照) |

自检方法:`workspace/selfcheck-probe.js` 经 `scripts/verify-browser.mjs --eval` 在页面内执行 spec.json 全部 9 探针序列(含动态 import 引擎模块挂 EVENT_AFTER_DRAW 钩子做帧内 readPixels 像素/运动采样),状态断言与页内像素证据同测。原始输出:`workspace/shots/session2-raw.txt`。

## 2. 自检清单(合同 §5)

- [x] 1. `npm run build` 在 workspace 根执行,退出码 0(build #3 最终;机器计数 `.budget/build.count` 3 行)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 <1s,首帧 EVENT_AFTER_DRAW 置位)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(getState 返回 stateContract 全字段:planetCount/moonCount/asteroidCount/ringedPlanetCount/timeScale/simulationTime/selectedPlanet/planets/pickTargets/infoCard/fps/epoch)
- [x] 4. 无未捕获异常(两次浏览器会话 consoleErrors=0、uncaught=0;verify-browser 退出码 0)
- [x] 5. 探针自检:spec.json 9 探针逐条自查(状态断言 + 页内像素/运动/DOM 独立证据),全部 PASS

补充指标:fps ≈ 60(2s 滚动平均,≥30 ✓);reset 在同一帧内完成(<1s ✓);渲染 700+ 独立天体下无卡顿。

## 3. 合规声明(合同 §4 逐条)

1. 未访问另一 Arm 的任何目录/代码/日志/服务器/浏览器 profile/截图/结果 —— **声明属实**。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)—— **声明属实**。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录及既往 trial 结果 —— **声明属实**。
4. 未读 `harness/` 源码与合同模板;仅使用 workspace 内预置脚本(build/serve/count/verify-browser,只读调用)—— **声明属实**。
5. 未访问 `bench/vendor/` 与引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);API 事实仅来自 knowledge/ 包、模板文件与本 Arm 目录内的 dist 产物 —— **声明属实**。
6. 未访问 `bench/docs/` 实验计划书与合同文档目录 —— **声明属实**。
7. 未访问 `secret/` —— **声明属实**。
8. 未发起任何网络请求(无文档/搜索/包 registry 访问)—— **声明属实**。
9. 未执行 `npm install`,未安装/改动任何依赖(含上层共享 node_modules)—— **声明属实**。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件 —— **声明属实**(仅新增/修改 workspace 内自有实现与自检脚本)。
11. 未探测或篡改 harness/validator 的行为与期望值 —— **声明属实**。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs/verify-browser.mjs 计数(build 全部走 `npm run build` 串联计数,浏览器会话全部经 verify-browser.mjs)—— **声明属实**。

## 4. 预算与环境事实

- buildAttempt:3/8;browserAttempt:2/6(机器计数为准);toolCall 由 Runner 侧记录;墙钟约 55 分钟(90 上限内)。
- dev server(PORT=7109,`node scripts/serve.mjs`)在 Run 结束时保持运行,便于复核;如需释放:`taskkill //PID <pid> //F`。
- 自检产物(证据媒体,可再生):`workspace/shots/s1-initial.png`、`s2-boosted.png`、`session1-raw.txt`、`session2-raw.txt`。
- 已知局限(如实声明):(a) 外轨道椭圆占屏宽约 60%(brief 视觉锚点"约 65%–80%",受"近端轨道缘不出画"的垂直约束折衷);(b) 页内像素采样(readPixels)口径与 harness 截图/视频口径不同,其数值仅作自检证据,harness 判定以其自身口径为准;(c) 相机拖拽/滚轮为可选增强,已实现且不影响任何探针。
