# RESULT — Arm B (cocosair) PAIR-E03-K0-R01

场景 E03 太阳系仪(Orrery)· 引擎 cocosair.js 1.0.0 · 知识等级 K0 + 引擎技能包
预算消耗:build 3/8 · browser 6/6(触及上限,详见 WORKLOG 备注)· 墙钟约 70/90 分钟。

## 1. 实现摘要(逐 probe)

- **P1(初始画面与公转分层)**:8 颗行星按半径 8.3–42.9 升序、周期 230–3397 模拟秒单调递增(类开普勒分层,轨道角 = k×45° + 2π·t/T 由模拟时钟派生);恒星 unlit 亮黄核心 + 双层半透明光晕球壳;8 条 LINE_LIST 细淡轨道线;500 小行星(10 子环 × 50 独立盒体,子环间差速旋转)位于 mars(19.8)与 jupiter(27.5)之间;320 背景星合并静态网格。自检:counts [8,3,500,1]、timeScale 1、selected null、Δangle₀/Δangle₇ = 14.8 倍(>4)、lit 像素 7.17%(≥3%)全部 PASS。
- **P2(点击选中 earth)**:pickTargets 每帧更新(worldToScreen 物理像素→CSS 左上原点换算,screenRadius = max(12, 角尺寸) ≥ 8px);点击经引擎 `input.on(Input.EventType.MOUSE_DOWN)`(getLocation 物理像素左下原点,同空间反演),按屏幕距离最近者命中;选中出现广告牌化半透明光圈(跟随行星 + 相机朝向 + 呼吸脉动)。自检:选中 earth、earth 投影区域像素变化率 3.9%、halo active 全 PASS。
- **P3(信息卡)**:DOM 侧边面板(data-ui/id/aria-label="info-card"),含名称 + 5 个数据字段(类型/公转周期/轨道半径/直径/卫星数),值与状态数据同源;仅由点击驱动出现。自检:infoCard {visible:true, name:"earth", fieldCount:5}、DOM 文本含 earth 与 5 行字段 PASS。
- **P4(8x 档位)**:五档按钮 0.5x/1x/2x/4x/8x(data-ui="speed-Nx" + aria-label + 可见文本),当前档 .active 高亮;timeScale 作用于模拟时钟(轨道角派生自 simulationTime ⇒ 变速即时、平滑无跳变)。自检:timeScale==8、五按钮存在、高亮 "8x" PASS。
- **P5(8x 运动证据)**:1.5s 采样窗 ΔsimulationTime = 12.18s(≥6),mercury 轨道角增量 0.3326 rad(≥0.05),全屏运动像素比 2.74%(≥0.5%);等窗换算 8x/1x 速度比 ≈ 7.9(≥4)PASS。
- **P6(Reset)**:reset() 置零 simulationTime(轨道角自动回 k×45°)、timeScale=1、取消选中并隐藏信息卡、epoch+1;无页面刷新。自检:epoch 1、timeScale 1 PASS。
- **P7(reset 后状态与运动)**:采样时 simulationTime 1.64s(<2.5)、无选中、信息卡关闭、mercury 角 0.0448(容差 ±0.08 内)、neptune 角 5.5008(315°=5.4978±0.06 内)、画面持续运动(0.38% ≥0.2%)PASS。
- **P8(0.5x 档位)**:五档全部可用。自检:timeScale==0.5 PASS。
- **P9(空白负向对照)**:点击 (0.08,0.08)→(102,58)(经校验距全部 pickTargets ≥80px,实测最近 408px)不产生选中、信息卡保持隐藏 PASS。

实现要点(引擎技能包路径):`createAirApp({canvas:'#GameCanvas'})` 先于一切材质/网格;`Camera.visibility = Layers.Enum.DEFAULT`;材质 `new Material().initialize({effectName, defines, states})`(blend/depthWrite/cullNone 用于光晕/环/带/轨道线,FLOAT4 一律 Color 实例);几何全部 `utils.MeshUtils.createMesh(IGeometry)`(primitives.sphere / 自建 LINE_LIST 环线 / 自建 annulus 环形面 / 自建盒体农场合并网格);父子层级 planet→tilt→mesh(自转)与 planet→moon(卫星随行星公转);带独立于行星层级;无外部模型/贴图(Asset Contract 合规)。

## 2. 自检清单(§5 完成合同)

1. **npm run build 退出码 0** — ✅ 3 次构建全部成功(dist/app.js + dist/vendor/cocosair.module.js,index.html 经 import map 引用)。
2. **10s 内 `window.__appReady === true`** — ✅ 6 次浏览器会话均 appReady:true(verify-browser 10s 轮询内达成,无超时)。
3. **`window.__bench = { getState, reset }`** — ✅ benchReady:true(全部会话),getState 返回 spec.stateContract 全部字段,reset 可调用并生效。
4. **无未捕获异常** — ✅ 全部 6 次会话 consoleErrors 0、uncaught [](含点击/变速/reset/空白点击全交互序列)。
5. **spec.json probes 逐条自检** — ✅ P1–P9 共 26 项子断言(状态断言 + 像素/DOM 观测证据)全部 PASS(证据:verify/shot4-final.png 截图、页面内像素统计、DOM 文本核验;fps 56.5 ≥ 30)。

## 3. 合规声明(§4 红线逐条)

1. **另一 Arm(arm-a)**:未访问其任何目录/代码/日志/服务器/截图/结果 — 未触碰。
2. **reference/**:未访问 — 未触碰。
3. **bench/results/ 其他目录 / 既往 trial**:仅在本 Pair 本 Arm 目录(results/B-20261023-R02/PAIR-E03-K0-R01/arm-b/)内工作 — 未触碰。
4. **harness/ 源码与合同模板**:未读取、未修改 — 未触碰。
5. **bench/vendor/ 与引擎上游仓库**(E:\AIProMax\github\cocosair.js、three.js r186 源码树):未访问 — 引擎知识仅来自本 Arm 目录内 knowledge/(K0 包 README + 官方技能包 skills/);node_modules 仅经 npm run build/serve 脚本隐式使用,未读取引擎源码。
6. **bench/docs/**:未访问 — 未触碰。
7. **secret/**:未访问 — 未触碰。
8. **联网**:零网络请求(页面仅加载 127.0.0.1:7209 本机 dev server;截图分析用本地 zlib 解码,未用任何外部服务)。
9. **npm install / 安装依赖**:未执行;依赖由共享 node_modules 提供,未改动。
10. **修改 brief/spec/RUN-CONTRACT/harness/探针**:未修改任何冻结文件;仅创建/修改 workspace/src/main.js 与本 Arm 目录内自建文件(WORKLOG/RESULT/verify/)。
11. **探测/篡改 harness/validator**:未探测、未篡改;探针自检为镜像 spec 断言的独立自验,未接触任何判定器。
12. **预算计数**:build 3 次全部经 `npm run build`(count 先计后执行);browser 6 次全部经 `scripts/verify-browser.mjs`(先计后会话);未手改/伪造/删除/重置 `.budget/*.count`;browser 计数 6/6 已触及上限(其中 2 次为自检脚本笔误浪费,如实记录于 WORKLOG,由 budget-check 判定器裁定)。

补充声明:开发期 dev server(127.0.0.1:7209)已停止,端口已释放;产物在 `workspace/dist/`;证据媒体与自检脚本在 `arm-b/verify/`(shot1-initial / shot3-fixed / shot4-final 截图、analyze-shot.mjs 本地 PNG 分析器、eval-isolate.js / eval-probes.js 自检表达式)。
