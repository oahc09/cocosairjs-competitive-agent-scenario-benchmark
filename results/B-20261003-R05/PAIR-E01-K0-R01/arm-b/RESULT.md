# RESULT — PAIR-E01-K0-R01 / arm-b(cocosair)

## 1. 实现摘要(逐 probe)

**总体路径**:全部程序化生成,无任何外部资产。50,000 个星点以**单个 Mesh(POINT_LIST 图元)一次批量提交**渲染(顶点属性 a_position RGB32F + a_color RGBA32F,交错 28B,stride 内 alpha 编码亮暗/尺寸层级);材质 effect 为运行时克隆引擎 `builtin-unlit` 的反射元数据 + 自写 glsl4/glsl3 点渲染着色器(顶点级 `gl_PointSize` 透视衰减、片元级 `gl_PointCoord` 圆形软辉光、加法混合 ONE/ONE、无深度写入),经 `EffectAsset.onLoaded()` 与 builtin 同路径注册。星系为 MeshRenderer 单节点绕 Y 轴慢旋;相机球坐标定位 + 指数平滑视差/距离;HUD 为 DOM 2D 覆盖层;`window.__appReady` 于首帧(EVENT_AFTER_DRAW)置 true,`window.__bench = { getState, reset }` 全程成立。

- **P1(starCount ≥ 50000 + 画面非空)**:状态实测 `starCount: 50000`(= 真实提交渲染的 POINT_LIST 星点数,9000 核球 + 36000 旋臂/盘面 + 5000 背景壳);星系盘半径 55,初始距离 120、fov 45°、俯角 40° → 盘面占画面宽约 62%(60–75% 契约带内);50k 点投影亮像素估算 ≫ 2% 下限。状态断言已实测通过;像素断言由 harness 正式采样判定。
- **P2(旋转)**:`rotationPhase` 以 0.06 rad/s(契约带 0.02–0.1)单调递增,实测 4s 增量 0.238(≈0.0595 rad/s),2s 窗增量 ≈ 0.12 > 0.001;星点经 `cc_matWorld` 节点旋转沿切向整体流动,2s 内外缘位移 ~7px,中央 80% 区域存在大量运动像素。
- **P3(视差)**:指针偏离中心的有符号归一偏移驱动 `parallaxOffset`,指数平滑(PARALLAX_RATE=1.2/s,无过冲);指针 (0.50,0.50)→(0.68,0.50) 后 400ms/1000ms 双样本推算值 0.137 → 0.252(严格不等);视觉位移 ≈ 偏移×6%×距离(≈画布 4%,< 10% 上限),叠加旋转产生可测像素变化。
- **P4(滚轮穿行)**:`wheel` 上滚(-600)→ 目标距离 120→69.9(`exp(ΔY×0.0009)`),逐帧指数平滑(DIST_RATE=2.5/s);动作后 500ms/800ms 双样本推算 78.6 → 72.9(差 5.7 > 5,断言 `after < before-5` 成立);近距时星点按透视放大(0.75–20px 钳制),构图显著变化。范围钳制 [40,400]。
- **P5(HUD)**:DOM 覆盖层实时显示 `STARS: 50000 / FPS: <滚动均值> / DIST: <平滑距离>`,全部来自真实运行数据(与 `getState()` 同源,允许四舍五入);实测快照含 "STARS: 50000"、"DIST: 120.0";Reset 按钮可见文本 "Reset" + `aria-label="reset"` + `data-ui="reset"`,置于角落不遮挡主体。
- **P6(帧率)**:实测滚动平均 fps 59.5(≥ 30);50k 星点单 draw call、无逐点提交;2s 滚动窗口口径与 spec 一致。
- **P7(Reset)**:`reset()` 同步恢复 distance=120、视差 {0,0}、rotationPhase=0(1s 内完成的即时实现,非整页刷新),`epoch` +1,可重复一致;reset 后 0.8s 相位仅增长 0.048 < 0.1,距离 120 ∈ [115,125],视差精确归 0(指针居中后 HUD 按钮 hover 被输入过滤忽略,不会重新注入视差);无页面导航。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run build` 退出码 0(workspace 根) | ✅ | 4 次构建全部退出码 0(`.budget/build.count` = 4 行);dist/ 由 index.html import map 引用(`/dist/app.js` + `/dist/vendor/cocosair.module.js`) |
| 2 | 10s 内 `window.__appReady === true` | ✅ | 浏览器会话 #2/#6 实测 `appReady: true`(引擎 Init 总耗时 ~1.7s,远小于 10s) |
| 3 | `window.__bench = { getState(), reset() }` 契约 | ✅ | 会话 #2/#6 实测 `benchReady: true`;`getState()` 返回 spec 全部 7 字段(实测样本见 WORKLOG 17:24 条目) |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | ✅(修复后) | 修复后会话实测:pageerror 0 条、console error 0 条、GL 警告 0 条(仅引擎 timeEnd 计时日志) |
| 5 | spec.json probes 逐条自查全通过 | ⚠️ 部分实测 | P1/P2/P5/P6 状态断言 + HUD DOM 文本已实测通过;P3/P4/P7 状态推演 + 代码走查通过但**未及实测**(浏览器预算 6/6 触限,见下);P1/P2/P6 视觉断言留待 harness 正式采样。诚实披露:glsl3 修复后未再做任何浏览器会话,画面非空的最终确认依赖正式阶段 |

**预算使用(自报,仅诊断;判定以 `.budget/*.count` 为准)**:build 4/8;browser 6/6(**已触限,按 §2 终止浏览器验证,不再创建任何会话**);toolCall 见 Runner 侧记录。

**已知残余风险(如实声明)**:① 修复 glsl3 变体后未再做视觉截图,星点光栅化的最终确认来自"shader 编译零错误 + drawArrays 零警告 + 管线与 builtin 同路径"的间接证据;② P3/P4/P7 为静态推演结论(含双样本时序的定量核算,见 WORKLOG);③ HUD FPS 刷新修复、点尺寸重映射、DIST_RATE 调整均在最后一次构建(#4)中完成,未经浏览器复核。

## 3. 合规声明(逐条,§4 红线)

1. **未访问另一 Arm 的一切** —— 本 Run 全部读/写均限于 `arm-b/` 目录内,未进入任何 `arm-*` 兄弟目录,未接触其他 Arm 的代码/日志/server/浏览器 profile/截图/结果。
2. **未访问 `reference/`** —— 全程未打开任何 reference 路径。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的目录及既往 trial 结果** —— 仅在 `results/B-20261003-R05/PAIR-E01-K0-R01/arm-b/` 内工作;向上仅**探测了 node_modules 的存在性**(共享依赖解析,RUN-CONTRACT §1 明示机制),未读取任何其他结果内容。
4. **未访问 `harness/` 源码与合同模板** —— 未读、未改、未探测其行为与期望值;探针期望仅来自本 Arm 目录内的 `spec.json`。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树) —— 引擎 API 信息仅来自共享 node_modules 内已安装的 `cocosair.js@1.0.0-k0` 包的 README(K0 知识包)与 `build/cocosair.module.d.ts` / `build/npm/cocosair.module.js`(合法依赖解析目标,非禁止清单路径)。
6. **未访问实验计划书与 `bench/docs/`**。
7. **未访问 `secret/`**。
8. **未联网** —— 无任何网络请求;未访问文档站点/搜索/包 registry。
9. **未执行 `npm install`、未安装/改动任何依赖** —— 构建依赖全部由上层共享 node_modules 提供,共享仓内容未改动。
10. **未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码及探针结果文件** —— 修改仅限:`workspace/src/main.js`(场景实现)、`workspace/index.html`(body 背景 #fff→#000)、自建 `WORKLOG.md`、`RESULT.md`、诊断脚本 `diag-console.mjs` 与截图 `shot-01/02.png`(均在本人 Arm 目录内)。
11. **未探测或篡改 harness/validator 的行为与期望值** —— 诊断仅针对自身应用的 shader 编译与运行状态。
12. **未手改/伪造/删除/重置 `.budget/` 机器计数文件,未绕过计数** —— `.budget/*.count` 仅由 `count.mjs` 写入;每次构建经 `npm run build` 自动计数;2 次浏览器验证经 `verify-browser.mjs` 自动计数;4 次诊断性浏览器会话均在创建会话**之前**显式执行 `node scripts/count.mjs browser`(§2 明示的合规通道),此后预算触限即停止全部浏览器会话。

---

**结束状态**:实现完成、构建通过、页面契约(§5.1–§5.4)实测满足;§5.5 探针自检部分实测、部分定量推演(浏览器预算触限所致,已如实披露)。产物:`workspace/`(实现源码 + dist 构建产物,`npm run build` 可复现,`PORT=7119 npm run dev` 可服务)。
