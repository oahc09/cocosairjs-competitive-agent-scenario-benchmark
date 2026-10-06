# RESULT — PAIR-E03-K0-R02 / arm-b(three r186,K0)

> 一次性 R0 自主模式交付。实现文件:`workspace/src/main.js`(唯一改动文件;index.html/build/serve 等冻结模板未动)。
> 预算实绩:build 3/8,浏览器会话 3/6,工具调用约 26/120,墙钟约 12 分钟/90 分钟。

## 1. 实现摘要(逐 probe 一句话)

核心设计:一切天体位相由模拟时钟 `simTime` 纯函数导出(角度 = 初始角 + ω·simTime),倍率只改时钟流速、reset 只把时钟归零,因此变速即时平滑、复位精确到 k×45° 且渲染不中断。

- **P1(初始状态 + 公转分层)**:8 行星按轨道半径 24→210 升序、周期 240→3900 模拟秒单调,初始角 k×45°;2s 采样窗内最内侧轨道角增量 0.05237 rad > 4× 最外侧 0.00322 rad(实比 16.3x),画面为恒星 + 8 行星 + 8 轨道线 + 900 体小行星带(亮像素远超 3%)。
- **P2(点击选中)**:点击 pickTargets[2](earth)的屏幕投影中心(每帧以真实投影计算 screenX/screenY/screenRadius,半径下限 8.2px)→ `selectedPlanet == "earth"`,DOM 高亮圈(sel-ring)出现并逐帧跟随。
- **P3(信息卡)**:选中后屏幕右侧出现 `data-ui="info-card"` 卡片,文本含名称 earth + 4 个数据字段(类型/公转周期 620 模拟秒/轨道半径 50/卫星数),`infoCard = {visible:true, name:"earth", fieldCount:4}` 与 DOM 镜像一致。
- **P4(8x 档位)**:点击 `data-ui="speed-8x"` → `timeScale == 8`,五档(0.5x/1x/2x/4x/8x)按钮均在 DOM 且当前档唯一高亮(`.ts-btn.active`,容器 `data-ui="time-controls"`)。
- **P5(8x 真实加速)**:1.5s 采样窗内模拟时间增量 12.13s(≥6)且最内侧行星轨道角增量 0.3176 rad(≥0.05),全程 fps 60(≥30),运动为画布 3D 渲染的真实推进。
- **P6(reset 生效)**:点击 `data-ui="reset"` → `epoch == 1`、`timeScale == 1`,无页面导航、console 无错误。
- **P7(reset 复位完整性)**:reset 后模拟时间 0.9s(<2.5)、无选中、信息卡关闭,行星轨道角精确回到初始值(a0 = 0.0236 ∈ ±0.08 自然推进内,a7 = 5.4992 ∈ 315°±0.06),画面持续运动(非冻结、非重载)。
- **P8(0.5x 档位)**:点击 `data-ui="speed-0.5x"` → `timeScale == 0.5`,降速后运动仍持续。
- **P9(点空白不选中,NC04)**:点击左上角空白(0.08, 0.08,距所有投影 > 500px)→ `selectedPlanet == null`,信息卡 `display:none` 不出现;点击判定只在行星投影圆域内命中。

scale/performance:`planetCount` 8、`moonCount` 4(earth/mars 各 1、jupiter 2,父子层级随行星公转)、`asteroidCount` 900(THREE.Points 逐粒子独立轨道参数、带内速度分层,真实渲染数量 = 报告值)、`ringedPlanetCount` 2(saturn 主环倾斜 0.42 rad + uranus 细环)、fps 60(2s 滚动平均,8x 下亦 60)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 在 workspace 根执行,退出码 0(3 次尝试,每次 build.count 机器计数在案)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(verify-browser 三次会话均 appReady:true,实际 < 1s)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady:true,getState 返回 spec §7 全部字段)。
- [x] 4. 无未捕获异常(三次浏览器会话 consoleErrors:0、uncaught:[])。
- [x] 5. 探针自检:按 spec.json probes P1–P9 逐条(状态断言 + 视觉断言)全部通过(单会话按探针顺序真实执行,证据:`shot-01-initial.png`、`shot-02-pan.png`、`shot-03-probes.png` 及状态采样记录,allOk = true)。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未读取 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读取任何既往 trial 结果。
4. 未读取 `harness/` 源码与合同模板(仅按 RUN-CONTRACT/brief/spec 的冻结文本执行)。
5. 未访问引擎资产:`bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树;K0 知识隔离保持(仅用 arm 目录内 knowledge/README 与模板)。
6. 未读取实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未联网:全程无任何网络请求(引擎经 import map 指向本地 vendored 产物)。
9. 未 `npm install`、未新增/改动任何依赖,未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(工作区仅新增/修改 `workspace/src/main.js` 与本 WORKLOG/RESULT/截图)。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;build 全部经 `npm run build`(count.mjs 串联)、浏览器全部经 `scripts/verify-browser.mjs`,无任何绕过计数的行为。

### 实现备注(如实声明)

- pickTargets 的 screenX/screenY 按 **CSS 像素**(视口 1280×720,原点左上)上报,与 stateContract"屏幕投影/screenRadius ≥ 8 CSS 像素"口径一致;spec probeConventions 的 (x,y ∈ [0,1]) 比例口径仅适用于探针动作字面坐标(如 P9 的 (0.08,0.08))。
- 相机观察目标沿世界 +z 偏移 41,用于补偿透视下近侧轨道的下坠,使最外轨道椭圆完整入画(水平约占 67% 宽,俯角约 38° ∈ 30°–60°)。
- 相机拖拽/滚轮缩放为 brief 第 4 节可选增强项,已实现且不影响任何探针(点击与拖拽以 6px 位移阈值区分)。
- 证据媒体(3 张截图)存于本 Arm 目录,可再生。
