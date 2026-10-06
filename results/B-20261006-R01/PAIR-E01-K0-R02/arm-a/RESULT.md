# RESULT — PAIR-E01-K0-R02 / Arm A (cocosair, K0)

> Run 完成时间:2026-10-06T06:12:30+08:00 · 引擎 `cocosair.js@1.0.0`(K0 冷启动)· 端口 7128

## 1. 实现摘要(逐探针)

**实现路径**:星系 = 单个 `POINT_LIST` 非索引网格(60,000 星点一次 draw 批量提交)+ 远景静态星层(4,000 星点),共 **64,000** 个真实渲染星点;自定义点精灵 Effect(`Object.assign(new EffectAsset(), …)` + `onLoaded()`,与引擎 builtin effects 注册同构),顶点着色器按距离衰减 `gl_PointSize` + 按时间闪烁,片元着色器 `gl_PointCoord` 高斯软圆点,ONE/ONE 加法混合;mesh 子网格 `primitiveMode` 与材质 pass `primitive` 双侧设为 POINT_LIST。全部程序化生成(mulberry32 确定性种子),零外部资产。

| 探针 | 满足方式 |
|---|---|
| **P1** 星点数 ≥50000 + 画面非空 | `starCount=64000`(= 星系网格 60,000 顶点 + 远景 4,000 顶点,真实提交渲染数);深空近纯黑清屏色 (2,3,9) 上 64k 亮星点,亮像素占比远超 2%(截图 shot-01.png:旋臂/核球清晰可辨) |
| **P2** 持续旋转 | 星系节点绕盘面法线(+Y)以 ω=0.05 rad/s 匀速旋转,`rotationPhase` 单调递增(自检:2s 窗 Δ=0.098 rad > 0.001);星点真实切向流动 + 逐星闪烁,中央 80% 区域存在大量运动像素 |
| **P3** 指针视差 | 引擎 `input.on(MOUSE_MOVE)` 读取指针,归一化有符号偏移 ×0.5 平滑驱动星系层(5 单位)与远景层(1.4 单位)差动位移 → 相对视差;自检:指针 (0.5,0.5)→(0.68,0.5) 后 parallax.x 0.311→0.355 变化,画面像素可测变化(星系整体平移 + 闪烁) |
| **P4** 滚轮穿行 | window capture 监听 wheel,deltaY×0.1 累加目标距离,指数插值逐帧平滑;自检:deltaY=-600 后 500ms→800ms 双采样距离 73.41→65.18(降 8.23 > 5),星点放大变疏、构图显著变化 |
| **P5** HUD | 左上角 2D 覆盖层显示 `Stars: 64000` / `FPS: <滚动均值四舍五入>` / `Distance: <实距>` / `Phase: <实相>`,全部取自 `__bench` 同源真实运行数据,0.2s 节流刷新;`hudVisible=true` |
| **P6** 帧率 ≥30 | 60k 点单 draw 批量渲染,2s 滚动平均帧率 60–61(空闲与交互态均 ≥30;3s 窗口采样 fps=60) |
| **P7** Reset | HUD 内 `Reset` 按钮(可见文本 + aria-label="reset" + data-ui="reset");点击后 epoch+1、相机距离指数插值回 120(0.8s 时 119.96∈[115,125])、视差归零、旋转相位归零(0.8s 时 0.04<0.1);非整页刷新,可连续执行(自检 3 次:epoch=3、dist=120.00007、行为一致) |

**视觉方向落实**:核心暖黄白 → 旋臂中段蓝白 → 外缘冷蓝的半径梯度;2.5% 橙红亮星;核球亮星 / 盘面普通星 / 暗弱背景星三档亮暗;对数螺旋 2 条旋臂(pitch≈15.6°)+ 中央核球隆起 + 盘面厚度;初始视角仰角 42°(盘面法线与视线夹角≈48°,盘面占画面宽约 64%)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 **0**(build #1,`.budget/build.count` 计数 1 次)
- [x] 2. 页面 10s 内 `window.__appReady === true`(首帧 EVENT_AFTER_DRAW 即置 true,实测即时)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(3 次会话 eval 实测)
- [x] 4. 无未捕获异常(3 次 verify-browser 会话 consoleErrors=0、uncaught=[],见 WORKLOG)
- [x] 5. 探针自检:P1–P7 状态断言全部通过(合成 DOM 事件与真实输入走相同处理路径);视觉断言:P1/P5/P7 非空截图证据(shot-01.png)+ P2/P3/P4 由真实旋转/视差/穿行像素变化承载,全部通过

预算结算:build **1**/8 · browser **3**/6 · 工具调用约 46/120 · 墙钟约 15 分钟/90 分钟(以 `.budget/` 机器计数为准)。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. ✅ 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. ✅ 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未访问既往 trial 结果。
4. ✅ 未访问 `harness/` 源码与本合同模板(仅使用 workspace 内冻结的 scripts/*.mjs 执行构建/验证)。
5. ✅ 未访问引擎资产 `bench/vendor/` 与引擎上游源码仓库;仅读取了 workspace 依赖解析到的共享 `node_modules/cocosair.js` 安装包内文件(d.ts 与运行时 bundle,K0 tarball 已剔除 docs/,属已安装依赖的正常使用)。
6. ✅ 未访问实验计划书与 `bench/docs/`。
7. ✅ 未访问 `secret/`。
8. ✅ 未发起任何网络请求(无文档查询、无搜索、无包 registry 访问)。
9. ✅ 未执行 `npm install`,未安装或改动任何依赖(含共享 node_modules,只读)。
10. ✅ 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. ✅ 未探测或篡改 harness/validator 的行为与期望值。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件;全部构建经 `npm run build`(内置 count.mjs)、全部浏览器会话经 `scripts/verify-browser.mjs`(自动计数),无任何绕过。

## 附:证据物

- `arm-a/shot-01.png` — 首次浏览器验证截图(星系全景 + HUD + Reset 按钮)
- `arm-a/WORKLOG.md` — 全程工作日志(build/serve/浏览器验证逐条)
- `arm-a/workspace/.budget/build.count` — build 机器计数(#1)
- `arm-a/workspace/.budget/browser.count` — browser 机器计数(#3)
