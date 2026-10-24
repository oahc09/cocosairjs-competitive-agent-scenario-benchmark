# WORKLOG — Arm A / PAIR-E03-K0-R01 (three, K0)

> 时间戳均为 ISO-8601(UTC);机器计数见 `workspace/.budget/{build,browser}.count`。
> 浏览器验证一律经 `workspace/scripts/count.mjs browser` 先计数后开会话(headless Chrome 1280×720),
> 自检脚本 `selfcheck.mjs`(本 Arm 根目录)在一次会话内串行执行 P1–P9。

2026-10-24T06:05:13Z | 开工 | 读 RUN-CONTRACT.md / brief.md / spec.json / knowledge/README.md(v1.0.1,含 2026-10-05 P7 amendment);brief 人读版 1.0.0 与 spec 1.0.1 冲突处按 spec 执行
2026-10-24T06:07:40Z | 构图规划 | 用离线投影脚本 proj-check.mjs / proj-search.mjs 在 1280×720 下网格搜索相机参数,选定 cam=(0,42,60) pivot=(0,0,9) fov=38(俯角≈39.5°,轨道包围盒 x∈[129,1151] 即宽度≈80%,y∈[75,703] 全部入画,(102,58) 角点距最近行星 349px)
2026-10-24T06:10:00Z | 实现 | 完成 `workspace/index.html`(UI 覆盖层:信息卡 / 五档倍率 / Reset)与 `workspace/src/main.js`(程序化行星贴图、恒星与光晕、8 行星+4 卫星层级、土星环、1500 实例小行星带、屏幕投影拾取、时钟积分与状态契约)
2026-10-24T06:10:12Z | serve | `PORT=7104 node scripts/serve.mjs` 启动成功(http://127.0.0.1:7104/,日志见 arm-a/serve.log)
2026-10-24T06:10:27Z | build #1 | 成功(exit 0):dist/app.js 27.7kb、vendor three.module.js + addons 已产出,自检 OK
2026-10-24T06:11:07Z | 浏览器验证 #1 | 成功:ready 580ms,P1–P9 全部通过,console error 0、未捕获异常 0
2026-10-24T06:11:21Z | 浏览器验证 #2 | 成功:复跑 P1–P9 全通过,报告落盘 selfcheck-out/report2.raw
2026-10-24T06:12:17Z | build #2 | 成功:视觉补光(ambient/fill 提升、行星自发光、恒星光晕收紧、小行星带灰褐色、水星半径 0.66),解决「夜面全黑、光晕糊成褐色盘」
2026-10-24T06:12:22Z | 浏览器验证 #3 | 成功:P1–P9 全通过(lit 0.073、P2 regionChange 0.51、P7 reset 后 a0=0.052 / a7=5.501)
2026-10-24T06:13:00Z | build #3 | 成功:恒星光晕二次收紧、首帧前 renderer.compile 预热、fps 滚动窗口改为「样本跨度 ≥1s 才刷新」(启动着色器编译长帧不污染 2s 滚动均值)
2026-10-24T06:13:04Z | 浏览器验证 #4 | 成功:P1–P9 全通过,ready 388ms、fps 60,画面观感调整确认
2026-10-24T06:13:50Z | build #4 | 成功(源码未变:一次补丁脚本因匹配串不中而中止,重建同源产物,用作产物确定性复核)
2026-10-24T06:14:00Z | build #5 | 成功:曝光 1.05→1.22、暖黄核心、光晕中段提亮、小行星略大略亮 → 提升「亮像素≥3%」在不同阈值下的余量
2026-10-24T06:14:06Z | 浏览器验证 #5 | 成功:P1–P9 全通过;实测 lit(阈值 26/40/60)= 0.073/0.052/0.036
2026-10-24T06:14:39Z | build #6 | 成功:小行星带颜色回调为灰褐碎石色(降明度/饱和),避免米黄过亮
2026-10-24T06:14:45Z | 浏览器验证 #6(终验) | 成功:ready 424ms、fps 60;P1–P9 全通过(证据:selfcheck-out/report-final.raw 与 13 张截图)
2026-10-24T06:16:30Z | 探针自检汇总 | 状态断言 9/9 通过;视觉断言 9/9 通过(P1/P4/P6/P8 nonBlank, P2/P3/P9 regionChange, P5/P7 motion);无未捕获异常、无页面导航
2026-10-24T06:17:00Z | 收工 | 停 dev server;写 RESULT.md;预算用量 build 6/8、browser 6/6、wall≈12min(上限 90min)
