# RESULT — Arm B / PAIR-E03-K0-R01

场景:E03 Orrery(太阳系仪),引擎 cocosair.js 1.0.0(K0),实现文件 `workspace/src/main.js`(交付构建 `workspace/dist/app.js`),开发端口 7105(验证后已释放)。

## 1. 实现摘要(逐 probe)

- **P1(初始场景 + 公转分层)**:`main.js` 在 `createAirApp` 后一次性建出太阳(核心球 + 相机朝向加性光晕)、8 颗行星(初始黄经恰为 k×45°)、3 颗卫星、12 环带 × 60 = 720 颗小行星的合并网格、土星倾斜环与轨道线;全部角度由 `simTime` 驱动,角速度 ∝ 1/√r,实测 2s 窗内最内/最外行星轨道角增量比 **12.57**(断言 ≥4),全屏亮像素 **46,224 / 518,400 = 8.9%**(断言 ≥3%)。
- **P2(点选行星)**:在 `window` 捕获阶段监听 `pointerdown`(绕开 pal 层吞事件),用 `camera.worldToScreen` 把行星世界坐标投成 CSS 像素生成 `pickTargets`(屏幕半径下限 12px,实测 12–27px),点击 `pickTargets[2]` 命中 **earth**,并出现青蓝高亮圈 + 本体提亮(选中区 cyan 像素 68→1482)。
- **P3(信息卡)**:选中即写入 `infoCard{visible:true,name,fieldCount}` 并显示 DOM 卡片,内含类型/公转周期/轨道半径/本体半径/卫星数共 **5** 个字段(断言 ≥3),内容随选中行星刷新(实测 bbox `990,88,266×170`,display:block)。
- **P4(8x 档位)**:底部 `time-controls` 提供 0.5/1/2/4/8 五档按钮(每个都有 id + data-ui + aria-label),点击 8x 后 `timeScale == 8`,当前档 `aria-pressed=true` 高亮,画面仍非空白。
- **P5(8x 加速 + 运动)**:所有运动统一按 `simTime += dt × timeScale` 推进,8x 下 1.5s 采样窗实测 **ΔsimTime = 12.0s**(断言 ≥6)、最内行星 **ΔorbitAngle = 0.3142rad**(断言 ≥0.05);720 颗差速小行星持续提供像素级 motion 证据。
- **P6(reset)**:Reset 按钮把 `simTime` 归零、`timeScale` 回 1、清空选中并关闭卡片、`epoch++`;按钮为普通 DOM 按钮不引起导航,console 无未捕获错误(实测 `epoch=1, timeScale=1`)。
- **P7(reset 后初态 + 仍在运动)**:reset 后近零时刻采样 **simTime = 0.9s(<2.5)**,行星回到初始角 **a₀ = 0.0236rad**(±0.08 内)、**a₇ = 5.4997rad**(5.43–5.56 内,315°),`selectedPlanet=null`、信息卡关闭,而小行星带差速旋转仍在运动(非冻结/非重载)。
- **P8(0.5x 档位)**:点击 0.5x 后 **timeScale == 0.5**,降速后运动持续、画面非空白,五档控件在 DOM 中齐备。
- **P9(空白负向对照)**:同一 pointer 分支对命中半径外(测试点距所有 pickTargets ≥80 CSS px)的点击判定为未命中,`selectedPlanet == null` 且 `info-card` 关闭,不误选、不弹卡。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. `npm run build` 退出码 0** — 5 次构建(`count.mjs build` + esbuild)全部 exit 0,交付前最后一次构建产出 `workspace/dist/app.js`(25,470 bytes,与上一版同尺寸,确认 dist 与 src 同步)与 `dist/vendor/`。
- [x] **2. 10s 内 `window.__appReady === true`** — 在 `director.on(Director.EVENT_AFTER_DRAW)` 首帧置 true,6 次浏览器会话中均在首帧后即可见,远小于 10s。
- [x] **3. `window.__bench = { getState(): object, reset(): void }`** — 二者均存在;`getState()` 返回 planetCount/moonCount/asteroidCount/ringedPlanetCount/timeScale/simulationTime/selectedPlanet/planets[]/pickTargets[]/infoCard/fps/epoch,`reset()` 归零 simTime、倍率回 1、清选中并 epoch++。
- [x] **4. 无未捕获异常** — `verify-browser.mjs` 的 console 采集 0 条 error 级未捕获错误(含 reset 前后)。
- [x] **5. 探针自检 P1–P9 全部通过** — 浏览器会话 #3 按 spec.json 逐条复演:P1 ratio 12.57 / P2 sel=earth / P3 card{true,earth,5} / P4 ts=8 / P5 Δsim=12,Δa=0.3142 / P6 epoch=1,ts=1 / P7 sim=0.9,a₀=0.0236,a₇=5.4997,sel=null,card=false / P8 ts=0.5 / P9 sel=null,card=false;视觉侧由 `workspace/shots/run3.png`、`run5.png` 及亮像素/region 变化采样佐证。交付前又对 build #5 最终产物做会话 #6 端到端复验:appReady/benchReady=true、consoleErrors=0、pc8/mc3/ac720/rc1、minR 12px、点选 earth + card(5 字段)、8x ts=8 且 aria-pressed、reset 后 epoch=1/ts=1/sel=null/card=false/a₀=0.0072/a₇=5.4984(截图 `workspace/shots/run6.png`)。

预算用量(run 结束):build **5/8**,浏览器会话 **6/6**,工具调用低于 120;`.budget/` 计数文件仅被 `count.mjs` / `verify-browser.mjs` 写入,未手改。后台 dev server 已关闭,端口 7105 释放。

## 3. 合规声明(RUN-CONTRACT §4)

逐条声明:本 Arm 在整个 run 内**未访问**下列任何禁止路径/行为。

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录,未读取任何既往 trial 结果。
4. 未读取 `harness/` 源码或本合同模板。
5. 未访问引擎资产:`bench/vendor/` 目录从未打开(K0 引擎包由模板既有依赖解析参与构建,本人未浏览其 docs/examples),未访问上游源码仓库 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树;引擎用法仅来自本 Arm 内的 `knowledge/skills/`。
6. 未访问 `bench/docs/` 或实验计划书。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档/搜索/registry 访问)。
9. 未执行 `npm install`,未安装任何新依赖,未改动共享仓内容(仅用模板已提供的 esbuild 与 cocosair.js)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`,未修改 harness/validator/探针代码或探针结果文件;唯一代码改动在 `workspace/src/main.js`。
11. 未探测、未篡改 harness/validator 的行为与期望值。
12. 未手改、伪造、删除或重置 `workspace/.budget/` 机器计数文件,未绕过 `count.mjs` / `verify-browser.mjs` 直接构建或直接创建浏览器会话(全部构建与浏览器验证均经由这二者)。

补充:所有读取均限于本 Arm 目录(`workspace/`、`knowledge/`、`assets/`、`brief.md`、`spec.json`、`RUN-CONTRACT.md`)及本地 node/chrome 运行时;截图证据仅存于 `workspace/shots/run1–run6.png`。开发用 dev server 仅监听 `127.0.0.1:7105`,run 结束时已关闭。
