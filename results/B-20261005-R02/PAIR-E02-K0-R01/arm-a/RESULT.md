# RESULT — Arm A(three.js r186 / K0)PAIR-E02-K0-R01 · E02 落日海面与孤舟

## 1. 实现摘要(逐探针)

实现要点:`workspace/src/main.js`(单文件,E import map 引用 vendored three r186)。海面 = 放射状分级网格(1+52×96=4993 顶点 ≥2000,近密远疏)+ 4 组行进正弦波(顶点位移 + 解析法线),波形参数为 CPU/GPU 单一事实源;船体 = 运行时 GLTFLoader 真实网络请求 `assets/boat.glb`(逐字保留 6 部件内嵌 PBR 材质),逐帧采样与海面同一波形函数驱动起伏/纵摇/横摇;天空 = 渐变天穹 shader + 太阳/月亮光盘与光晕;暖冷两端由同一 `uTone` 驱动天空/海面/光照/光盘同时演变;拖拽 = 即时跟随 + 释放后惯性滑行(τ=1.5s,下限 340°/s);reset = deepDispose(几何/材质/纹理)+ 重建 + 重新网络加载 GLB,非整页刷新。

| 探针 | 结论 | 一句话说明 |
|---|---|---|
| P1 | PASS | `assets/boat.glb` 真实网络请求(resource timing 记录,transferSize 29432,200),加载完成后 `__appReady=true` 且 `assetLoaded=true / assetRequests=1`;全屏 litPixelRatio=1.0(≥0.05),画面同时呈现天空/海面/多部件船体(截图 selfcheck-warm.png) |
| P2 | PASS | 1.5s 采样窗内 wavePhase 2.055→3.656(单调推进);画面下 60% 区域运动像素比 36.4%(≥1%),波形为顶点位移行进波(非贴图滚动/相机晃动) |
| P3 | PASS | 900ms 采样窗内 boatPosition.y 1.565→1.481(Δ=-0.084);中央 40% 区域运动像素比 47.5%(≥0.2%);船体 y 由与海面同一波形函数采样驱动(相位耦合),4s 极差远超 0.02 |
| P4 | PASS | 水平拖拽 (0.50,0.50)→(0.78,0.50) 后,方位角 291.94°→355°(双采样窗 Δ=63.06° ≥20°;释放后惯性滑行保证采样窗内持续变化);全屏像素差远超 0.02 |
| P5 | PASS | 点击 tone-toggle 后 2.5s toneMix=0.9937(>0.7,过渡 τ=0.5s ≪2.5s);画面平均色 avgRGB [110.7,89.1,80.5]→[32.5,44.7,88],R 分量偏移 78.2(≥8),天空/海面/光照/光盘整体演变 |
| P6 | PASS | reset 后 3s 内:epoch=1、assetLoaded=true、assetRequests=2(重新网络加载)、toneMix=0(<0.05)、cameraAzimuth=35(32–38 内)、litRatio=1.0;deepDispose 释放 GPU 资源,无页面导航、console 干净 |
| P7 | PASS | 连续第二次 reset:epoch=2、assetRequests=3、toneMix=0、litRatio=1.0、console 0 新增错误;JS 堆 33.7MB→27.9MB(reset 后回落,无持续增长征象) |

附加行为项:暖↔冷双向可反复切换(冷→暖实测 toneMix 0.9935→0.0054);海平线实测位于画面 0.356(≈上 1/3);暖端 avgRGB R>B([117,96,84]),冷端 B≫R;稳态 fps≈60.5(2s 滚动平均,≥30);构图:太阳/月亮位于中轴偏侧约 12°,船体中央偏下且完整可见。

辅助证据文件(本 Arm 目录):`selfcheck-warm.png`(暖端)、`selfcheck-dusk.png`(冷端,经 `?tone=cool` 测试钩子载入)、`selfcheck-after-reset.png`(暖端初始态)、`selfcheck-*.eval.js`(自检脚本)。

## 2. 自检清单(RUN-CONTRACT §5)

1. [x] `npm run build` 在 workspace/ 根执行,退出码 0(build 3 次,#1 初版、#2 修正吃水/相机/暖色反射、#3 加测试钩子;预算 3/8)
2. [x] 页面 10s 内 `window.__appReady === true`(实测:资产加载 + 首帧后即置 true,每次验证均命中)
3. [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true,getState 返回 spec 全部 8 字段)
4. [x] 无未捕获异常(5 次浏览器会话 consoleErrors=0、uncaught=[],error 级仅走可见错误横幅路径)
5. [x] 探针自检:P1–P7 逐条自查全部通过,每条均有状态断言 + 独立观测证据(像素统计/网络 resource timing/DOM 点击),证据见上表与 WORKLOG.md

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;未读任何既往 trial 结果。
4. 未读 `harness/` 源码与本合同模板(verify-browser.mjs / count.mjs / build.mjs / serve.mjs 为 workspace 内预置模板文件,按其头注释"不得修改"——未做任何修改)。
5. 未访问 `bench/vendor/` 与引擎上游源码仓库;K0 冷启动隔离保持(three 仅经 import map 使用 vendored 运行时,未读官方 docs/examples)。
6. 未读实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档/搜索/registry;页面仅请求本机 dev server 的本地资源)。
9. 未执行 `npm install`,未改动共享 node_modules(workspace 无自带 node_modules,构建经上层共享仓解析)。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(自检脚本仅操作本应用自身 DOM/状态)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;build 全部经 `npm run build`(内置 count),浏览器会话全部经 `scripts/verify-browser.mjs`(内置 count),无任何绕过。

预算终态:build 3/8 · browser 5/6 · toolCall ≈30/120 · 墙钟 ≈35/90 分钟。
代码注释解释"为什么";中文文档;一次提交一个意图;未发现涉及 G0 冻结合同哈希的改动。
