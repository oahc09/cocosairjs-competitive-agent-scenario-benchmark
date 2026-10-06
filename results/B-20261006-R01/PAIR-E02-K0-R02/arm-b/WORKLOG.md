# WORKLOG — PAIR-E02-K0-R02 / arm-b (three)

- 2026-10-05T22:31:57Z | build(npm run build,误在 arm-b 根目录执行) | 失败——目录无 package.json build 脚本,未触达 count/build 管线;改在 workspace/ 内重跑
- 2026-10-05T22:33:40Z | build | 成功——build #1(npm run build @workspace),退出码 0,dist 自检 OK
- 2026-10-05T22:34:10Z | serve | 成功——PORT=7131 dev server 启动,/index.html、/dist/app.js、/assets/boat.glb 均 200
- 2026-10-05T22:34:30Z | 浏览器验证 #1 | 成功——appReady=true,assetLoaded=true,assetRequests=1,cameraAzimuth=35,toneMix=0,console 0 错误;截图发现波谷时船体吃水过深
- 2026-10-05T22:36:00Z | 探针自检(静态) | P1 通过——状态+截图+网络三证齐全;视觉微调:主波幅 0.24→0.20、船标度 2.6→3.0、吃水 -0.10→-0.02、暖端环境光 0.62→0.80
- 2026-10-05T22:34:35Z | build | 成功——build #2(视觉微调后重建),退出码 0
- 2026-10-05T22:35:02Z | 浏览器验证 #2 | 成功——探针镜像 P2-P5:wavePhase 0.46→2.01 且下60%运动像素 76.5%;boatY 1.770→1.351(900ms)且中部40%运动像素 71.9%;拖拽后 +500ms/+700ms 方位角 113.8→143.0(Δ29.2>20)且全幅像素差 46.9%;toneMix=1(2.5s)且平均色 [119,71,43]→[34,45,85](偏移 51/255);fps 58.7;console 0 错误
- 2026-10-05T22:35:35Z | 浏览器验证 #3 | 成功——reset×2 镜像:epoch 1→2、assetRequests 2→3、toneMix=0、cameraAzimuth=35、assetLoaded=true;内存 8→11→10MB 无持续增长;navMark 存活(无页面导航);console 0 错误;fps 60
- 2026-10-05T22:36:40Z | 探针自检(截图) | verify-browser 固定"先截图后 eval",两张截图均为初始暖端;冷端像素证据以 eval 内 canvas 平均色实测为准;另以计数会话补冷端截图
- 2026-10-05T22:37:10Z | 浏览器验证 #4 | 成功——先 count.mjs browser 计数的一次性会话(verify/shot-cool.mjs):冷端 toneMix=1、azimuth=35、console 0 错误;发现冷端天体高度角 24° 使月亮出画 → 修正为 13°
- 2026-10-05T22:38:28Z | build | 成功——build #3(冷端月亮高度角 24°→13°),退出码 0
- 2026-10-05T22:38:32Z | 浏览器验证 #5 | 成功——单会话全量自检(verify/full-check.mjs,先计数):暖端截图→P2-P5 镜像重跑全过(Δaz=30.1、shift=51、fps 58.8)→冷端截图;console 0 错误;浏览器预算 5/6,按"触及上限即终止"保守口径停止后续会话
- 2026-10-05T22:40:00Z | 预算核对 | build.count=3/8,browser.count=5/6;serve.log:GET /assets/boat.glb ×8 全部 200,0 次 404
- 2026-10-05T22:44:30Z | serve 停止 | 成功——7131 端口已关闭,Run 结束(交付 RESULT.md/WORKLOG.md/verify 证据)
