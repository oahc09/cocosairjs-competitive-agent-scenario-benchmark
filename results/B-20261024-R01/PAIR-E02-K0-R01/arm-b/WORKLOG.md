# WORKLOG — Arm B (PAIR-E02-K0-R01)

格式:`<ISO-8601 时间戳> | <动作> | <结果>`。仅记录实际执行过的 build / dev server / 浏览器验证 / 探针自检动作;预算计数以 `workspace/.budget/*.count` 为准。

2026-10-24T05:45:50Z | serve | 成功 — `PORT=7103` 启动 dev server(首个请求 05:45:50.266Z,`/assets/boat.glb` 200)
2026-10-24T05:45:53.222Z | build #1 | 成功 — 初版实现构建通过(esbuild,engine external)
2026-10-24T05:45:57.054Z | 浏览器验证 #1 | 失败 — `__appReady` true 但 `createDynamicMesh` 抛 RangeError(`Failed to set 'length' on Array`),画面仅剩 clearColor
2026-10-24T05:46:45.957Z | 浏览器验证 #2 | 诊断 — probe.html 隔离 `createDynamicMesh` options 契约:缺键即抛错
2026-10-24T05:47:08.283Z | 浏览器验证 #3 | 诊断 — probe2.html 确认必须同时提供 `{maxSubMeshes, maxSubMeshVertices, maxSubMeshIndices}` 三键
2026-10-24T05:47:50.265Z | build #2 | 成功 — 修复三个 capacity 键(海面/天空)
2026-10-24T05:47:51.222Z | 浏览器验证 #4 | 成功 — appReady / consoleErrors 0 / uncaught [] / assetLoaded / assetRequests 1;截图 run2.png(船体可见,海面与天空未按索引绘制)
2026-10-24T05:49:35.543Z | 浏览器验证 #5 | 成功 — 跑完整 P1–P7 状态序列:wavePhase 2.673→4.190;船体 y 4s 采样 32 次极差 1.060;拖拽 35°→92.28°;toneMix 1.0;reset 两次 epoch 1/2、assetRequests 2/3、toneMix 0、azimuth 35;fps 60;堆 37.82MB→39.74MB(+5%)
2026-10-24T05:52:10Z | 静态自检 | 失败→定位 — 对 run2.png 逐像素分析:天空均值恒为 clearColor(255,148,92),确认动态网格仅以非索引方式画出细长碎片;查引擎 bundle 发现 `createDynamicMesh` 只从 `indices16/indices32` 建索引缓冲
2026-10-24T05:53:31.841Z | build #3 | 成功 — 动态网格改传 `indices16`(初始化 + 每帧 updateSubMesh),补 `onGeometryChanged()`;海面指数网格、太阳光路/反射碎金、天空 128×72
2026-10-24T05:53:36.084Z | 浏览器验证 #6 | 成功 — 天空/海面/太阳/船体全部正确绘制(截图 run3.png),consoleErrors 0、uncaught []、appReady、assetLoaded、fps 60、wavePhase 前进;browser 预算用尽(6/6),此后不再创建浏览器会话
2026-10-24T05:55:07.879Z | build #4 | 成功 — 终版:线性色域下的落日调色(天空/海面)、两道细波、相机侧补光;`dist/app.js` 25.1kb
2026-10-24T05:56:40Z | 静态自检 | 成功 — dist/app.js 含 `indices16`×8、`Fill Light`、`tone-toggle`、`__appReady`、`__bench`、`boat.glb?reload`;构建产物与源码一致
