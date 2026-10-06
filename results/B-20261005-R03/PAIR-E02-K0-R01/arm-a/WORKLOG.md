# WORKLOG — PAIR-E02-K0-R01 / arm-a (three, K0)

- 2026-10-05T16:40:00+08:00 | 读合同 | RUN-CONTRACT.md / brief.md / spec.json / knowledge(K0=three README)/ 模板文件已读,预算口径确认(120 tool / 90min / 8 build / 6 browser)。
- 2026-10-05T16:43:30+08:00 | 资产就位 | assets/boat.glb(sha256 ed22ff2f…)复制到 workspace/assets/(源 assets/ 只读未动),供 dev server 以 /assets/boat.glb 返回 200。
- 2026-10-05T16:45:00+08:00 | 实现 | 重写 workspace/src/main.js:程序化波浪海面(31,155 顶点,CPU/GPU 同参同相)+ 渐变天穹太阳/月亮 + GLTF 运行时加载船体(材质保留)+ 拖拽环绕 + 暖冷色调切换 + reset 释放重建 + __appReady/__bench/data-ui 契约。
- 2026-10-05T16:46:10+08:00 | build #1 | 成功(esbuild 16.5kb,自检 OK,退出码 0;机器计数 .budget/build.count=1)。
- 2026-10-05T16:47:00+08:00 | serve | PORT=7116 启动 dev server(后台),GET / 与 GET /assets/boat.glb 均 200。
- 2026-10-05T16:49:00+08:00 | 浏览器验证 #1 | 会话完成:appReady=true、console 0 错误;状态断言全部通过(assetLoaded/toneMix/epoch/azimuth),但自检脚本像素对比全 0;截图显示海面/船体渲染过闷:无太阳(初始机位背对 SUN_AZ=53°)、波形法线失效(GLSL out 参数误用)、船体没入水中。计数 .budget/browser.count=1。
- 2026-10-05T16:50:30+08:00 | 修复 | 三处:① buildWaveGLSL 累加变量 g→acc(修平法线);② SUN_AZ 53→197(初始视线方位 215°,太阳入画偏侧 18°);③ 船体水线抬升 baseY=size.y*s*0.28;雾从 60 起始降强度。
- 2026-10-05T16:52:00+08:00 | build #2 | 成功(退出码 0;机器计数 build.count=2)。
- 2026-10-05T16:53:30+08:00 | 浏览器验证 #2 | 会话完成:画面正常(太阳/波浪高光/船体水线正确),运动像素仍全 0 —— 定位为自检脚本缺陷:grab() 复用同一 Uint8Array,帧对自身比较恒 0。计数 browser.count=2。
- 2026-10-05T16:54:00+08:00 | 修复自检 | grab() 改为 buf.slice() 独立快照(应用代码无改动,无需重建)。
- 2026-10-05T16:56:20+08:00 | 浏览器验证 #3(探针全量自检)| 全部通过:P1 assetLoaded=true/requests=1/lit=1.0;P2 wavePhase 2.267→3.800、下60%运动像素比 0.835(阈值0.01);P3 船体 y 0.604→0.558、中40%运动像素比 0.508(阈值0.002);P4 拖拽方位角 Δ30.8°(阈值20)、全帧像素差 0.877(阈值0.02);P5 toneMix=1、平均色偏 78.2/255(阈值8),暖端均值(167,96,56)红主导、冷端(23,40,92)蓝主导;P6 epoch=1/assetLoaded=true/toneMix=0/方位角35;P7 epoch=2/requests=3/toneMix=0/fps60;console 0 错误、无未捕获异常、无页面导航。计数 browser.count=3。
- 2026-10-05T16:58:00+08:00 | 浏览器验证 #4(冷端视觉)| 点击 tone-toggle 2.2s 后 toneMix=1,截图确认暮蓝海面 + 月亮光盘 + 冷色高光带 + 船体剪影;console 0 错误。计数 browser.count=4。
- 2026-10-05T16:59:00+08:00 | 网络证据 | dev server 日志:每个会话 GET /assets/boat.glb 200 29132 bytes ×(1 次初始加载 + 每次 reset 各 +1),共 11 次(含 1 次启动前 curl 探活)。
- 2026-10-05T17:00:00+08:00 | 收尾 | 机器预算核对:build 2/8、browser 4/6、tool 调用约 38/120、墙钟约 20/90 分钟;停止 dev server;写 RESULT.md。
