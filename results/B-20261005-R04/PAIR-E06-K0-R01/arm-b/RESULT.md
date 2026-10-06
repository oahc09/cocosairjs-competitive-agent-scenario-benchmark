# RESULT — Arm B (cocosair) PAIR-E06-K0-R01

> 一次性 R0 自主模式交付。场景 E06「荒野篝火营地」,引擎 cocosair.js 1.0.0,K0 冷启动。
> 全部证据来自本 Arm 自检会话(verify-browser.mjs,预算内:build 6/8、browser 6/6、工具调用 <50/120)。

## 1. 实现摘要(逐 probe 一句话)

- **代码入口**:`workspace/src/main.js`(单文件,约 900 行):程序化地形圆盘(平滑法线)、16 棵低多边形树(箱体树干 + 双层锥冠,flat-shading)、石圈 10 + 斜搭柴堆 5、4 层锥体火苗 + 32 张 billboard 火苗面片、46 颗火星粒子、18 只萤火虫、160 颗批量星点、PointLight 动态火光 + 地面光斑、日夜连续插值(clearColor/环境光/月光→日光)、0.22 rad/s 可暂停环绕相机、`__bench` 状态通道与右上角 `data-ui` 控件组、内置帧级像素采样器(默认关闭,仅自检时开启)。
- **P1 营地可见**:夜景下 16 棵树环 + 地面 + 篝火暖橙光斑构成焦点,starTex 白色星点带位于画面上部深蓝夜空;state 断言 `timeOfDay=0≤0.25、treeCount=16≥12、fireflyCount=18≥16、orbitEnabled=true、cameraOrbitAngle=0.605>0` 全过,center 区域暖色像素峰值 863(远超非零)。
- **P2 火光动态**:火光强度由 1.3/3.1/5.4 Hz 三频正弦混合驱动(基准 0.55、幅度 0.23≥0.08),同时驱动真实 PointLight(luminousPower 8k-30k 流明档)与地面光斑;两次间隔 650ms 采样 |Δ|=0.102≥0.02,center-bottom 帧差非零像素峰值 739(环境真实受光:地面/石/柴/树干亮度随闪烁变化)。
- **P3 日夜切换**:点击 `data-ui=day-night` 后 timeOfDay 以 3.2s 线性渐变 0→1,500ms 采样序列 [0.156, 0.318, 0.479, 0.635, 0.797, 0.958, 1, 1, 1] 含 4 个 (0.25,0.85) 中间态,终值 1.0≥0.9;天空区域平均亮度 107→184(1.72×≥1.5×;harness 口径上三分之一含白天受光树冠,余量更大)。
- **P4 环绕相机**:orbitEnabled=true 下方位角 3.0s 内 1.848→2.512(Δ=0.664≥0.15,角速度 0.221 rad/s ∈ [0.05,0.4]),帧间全画面像素差 0.33(构图连续变化无跳变)。
- **P5 环绕暂停**:点击 `data-ui=orbit-toggle` 后 orbitEnabled=false,1600ms 窗口角度差 0 < 0.01(角度冻结),火光/粒子等局部动态不受影响。
- **P6 reset**:点击 `data-ui=reset`(等价 `__bench.reset()`)后 timeOfDay 立即归零(t0=0、t150ms=0 ≤300ms),orbitEnabled=true,cameraOrbitAngle 归零后 1s 累计 0.224<0.6,萤火虫/树数不变(18/16),火光/火苗/火星/萤火虫全部重播种,`__appReady` 保持 true,场景继续运行。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 结果 |
|---|---|---|
| 1 | `npm run build` 在 workspace/ 根执行,退出码 0 | ✅ 共执行 6 次,均退出码 0(预算 6/8) |
| 2 | 页面 10s 内 `window.__appReady === true` | ✅ 全部 6 个浏览器会话 appReady=true(首帧 EVENT_AFTER_DRAW 置位) |
| 3 | `window.__bench = { getState(): object, reset(): void }` 契约成立 | ✅ benchReady=true(getState 另含 superset 字段;setSampling/getSamples 为默认关闭的自检采样器) |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | ✅ 最终三个会话 consoleErrors=0、uncaught=[] |
| 5 | 按 spec.json probes 逐条自查(P1-P6 状态断言 + 视觉断言) | ✅ 全部通过(证据见 §1 与 selfcheck/shot6-night-final.png、采样数值) |

备注:自检过程曾出现 1 次 `techAdd is not defined` 运行错误与多轮视觉缺陷(三角形环绕方向内翻导致剔除破洞、UV 缺失导致贴图采样透明、星点仰角超出可视带),均已定位修复并在最终会话复验通过;过程全部记录于 WORKLOG.md。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;未读任何既往 trial 结果。
4. 未读 `harness/` 源码与合同模板(仅使用本 Arm workspace 内预置脚本 build/serve/count/verify-browser)。
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);K0 冷启动隔离保持,仅使用 arm 目录内 knowledge/(README+manifest)与模板,API 未证实处一律运行时探测+try/catch 降级。
6. 未读 `bench/docs/` 实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档查询、无搜索、无包 registry 访问)。
9. 未执行 `npm install`,未安装/改动任何依赖(构建经上层共享 node_modules 解析)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(workspace 内仅新增/修改 src/main.js、index.html 未动、新增 selfcheck/ 截图)。
11. 未探测或篡改 harness/validator 的行为与期望值(采样器为本场景自带调试设施,默认关闭,不改变场景行为,不针对自动化环境特判)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;构建一律经 `npm run build`(内置 count),浏览器一律经 `scripts/verify-browser.mjs`(自动计数),无任何绕过。

## 4. 交付物

- `workspace/src/main.js` — 场景实现(唯一源码改动)
- `workspace/dist/` — build #6 产物(app.js + vendor)
- `selfcheck/shot1..shot6*.png` — 自检截图(最终口径 shot6-night-final.png)
- `WORKLOG.md` — 全程动作日志
- 本文件 — 实现摘要 / 自检清单 / 合规声明
