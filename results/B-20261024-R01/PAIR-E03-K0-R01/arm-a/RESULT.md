# RESULT — Arm A / PAIR-E03-K0-R01 (E03 太阳系仪, three 0.186.1, K0)

交付物:`workspace/`(index.html + src/main.js,`npm run build` 产出 dist/)、`selfcheck.mjs`(自检脚本)、
`selfcheck-out/`(探针自检证据:report*.raw + 13 张 1280×720 截图)、`WORKLOG.md`。

---

## 1. 实现摘要(逐 probe)

| Probe | 实现要点(如何满足) | 终验实测 |
|---|---|---|
| **P1** 初始分层公转 + 画面非空 | 中心恒星(高亮核心 + 加色光晕)+ 8 颗行星按 `orbitRadius` 升序(5.2 → 33.4),角速度 = 2π/周期且周期 230 → 3400 模拟秒单调递增;每帧积分角度、不取模;初始角 = k×45°;8 条细淡轨道线;1500 颗实例化小行星带 + 3200 颗背景星。 | 内/外行星 2s 内角增量 0.0587 vs 0.0040(14.7× > 4×);lit 0.072;motion 0.035 |
| **P2** 点击 earth 选中 | 点击判定用「屏幕投影近邻」:每帧把 8 颗行星世界坐标投影成 CSS 像素 `pickTargets`,pointerup 时距某行星 ≤ 其 `screenRadius` 即选中;选中时出现始终面向相机的青色高亮环(Sprite)+ 行星轻微放大 + 所属轨道线提亮。 | 点击 `pickTargets[2]` → `selectedPlanet = "earth"`;该点屏幕半径 36.6px(≥8);区域变化 51% |
| **P3** 信息卡 | DOM 卡片 `[data-ui="info-card"]` 与状态同源渲染:名称 + 类型 + 轨道半径 + 公转周期 + 直径 + 卫星数 + 实时轨道角(5 个 `<dd>` 数据行),默认 `display:none`,由选中驱动显示;`getState().infoCard` 镜像(visible/name/fieldCount=5)。 | DOM 文本含 earth 与 5 个字段;`infoCard={visible:true,name:"earth",fieldCount:5}` |
| **P4** 8x 档位 | 底部五档按钮(0.5/1/2/4/8x,`data-ui=speed-<v>`、可见文本与 aria-label 一致、`aria-pressed` 同步),当前档 `.active` 高亮;倍率只改时钟倍率,运动由此真实变速。 | `timeScale = 8`,5 个按钮文本齐全,仅 8x 高亮 |
| **P5** 8x 运动量 | 模拟时间按 `dt×timeScale` 累加(1x 时 1 实时秒 = 1 模拟秒),所有天体(行星公转、卫星、小行星带)共用同一 simDt。 | 1.5s 内 Δsim = 12.8s(≥6),Δangle₁ = 0.35 rad(≥0.05),画面 motion 0.049 |
| **P6** Reset | `reset()`(按钮与 `__bench.reset` 同一函数):模拟时钟归零、倍率回 1x、清空选中与信息卡、各行星角回 k×45°、卫星/小行星带角复位、相机回初始构图、`epoch+1`;**不刷新页面**,下一帧继续渲染。 | `epoch = 1`、`timeScale = 1`;页面导航条目数仍为 1(无 reload) |
| **P7** reset 后归位且仍在动 | 复位是原子赋值(不重建场景),复位后同一 rAF 循环继续推进;采样延迟内最内侧行星仅自然推进 2π·1.9/230 ≈ 0.052 rad。 | `simulationTime 1.90`(<2.5)、a₀=0.052(±0.08 内)、a₇=5.501([5.43,5.56] 内)、无选中/卡片隐藏、motion 0.028 |
| **P8** 0.5x | 同一套倍率状态机,0.5x 立即生效(所有天体同步减速),按钮高亮切换。 | `timeScale = 0.5`,仅 0.5x 高亮 |
| **P9** 空白点击不选中 | 拾取仅在阈值内命中最靠前行星,否则 `setSelected(null)`;左上角 (102,58) 距最近行星投影 349px,无 UI 元素覆盖(UI 全部在右侧/底部)。 | `selectedPlanet = null`、卡片隐藏、该角点区域像素零变化 |

**其它规格点**:`planetCount=8`、`moonCount=4`(地球 1、木星 2、土星 1,均为行星→moonPivot 父子层级,周期 10/14/24/34 模拟秒)、`ringedPlanetCount=1`(土星半透明环面,轴向倾斜 0.42 rad,初始视角清晰可辨)、`asteroidCount=1500`(InstancedMesh 独立实例,带内速度分层,分布于 13.6–17.6 之间即第 4、5 条轨道之间)。所有贴图(行星表面、恒星、光晕、环缝、选中环)均由 Canvas 程序化生成,无外部模型/贴图;K0 冷启动下未接触 vendor/docs。帧率 60fps(2s 滚动均值,含 8x)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1** `npm run build` 在 `workspace/` 根执行、退出码 0(.budget/build.count 共 6 次,上限 8)
- [x] **2** 页面 `window.__appReady === true`:终验 424ms(≤10s)
- [x] **3** `window.__bench = { getState(): object, reset(): void }` 存在且可调用(reset 经按钮与 API 双路径验证)
- [x] **4** 无未捕获异常:console error 0、pageerror 0(六次会话均为 0)
- [x] **5** 探针自检:P1–P9 状态断言 9/9 + 视觉断言 9/9 通过(证据 `selfcheck-out/report-final.raw`、截图 `P1-before … P9-after`)

## 3. 合规声明

逐条声明未访问 §4 任一禁止路径 / 未执行任一禁止行为:

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、profile、截图或结果(全程只读写本 `arm-a/` 目录)。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录,也未读取任何既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板;`scripts/{build,count,serve,verify-browser,smoke-verify}.mjs` 均为模板原样,未修改。
5. 未访问引擎资产 `bench/vendor/` 整目录、未访问 `cocosair.js` 与 three.js r186 上游源码树;`three` 仅作为已安装依赖被 import(运行期),未阅读其源码。
6. 未访问 `bench/docs/`(实验计划书与合同文档目录)。
7. 未访问 `secret/`。
8. 未联网:页面零外部请求(空 data-URI favicon、无 CDN 字体、无远程贴图),Agent 侧未发起任何网络请求。
9. 未执行 `npm install`、未安装新依赖、未改动共享 `node_modules`。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件;
    `workspace/index.html` 与 `workspace/src/main.js` 是场景实现文件(模板即以此两文件为起点),`scripts/` 未动。
11. 未探测或篡改 harness/validator 行为与期望值;自检脚本只调用页面公开契约 `__appReady` / `__bench.getState` / `__bench.reset` 与真实鼠标点击。
12. 未手改、伪造、删除或重置 `.budget/*.count`;所有 build 均经 `npm run build`(内置 count.mjs),所有浏览器会话均先执行 `node scripts/count.mjs browser` 再创建(共 6 次,未超上限)。

**预算用量**:toolCalls 远低于 120;wall ≈ 12 min / 90 min;build 6 / 8;browser 6 / 6(恰达上限,未超出)。
**已知风险备注**:browser 计数恰好用满 6 次;终验针对最终产物(build #6)完成,结论有效。
