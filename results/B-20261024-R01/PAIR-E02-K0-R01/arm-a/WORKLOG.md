# WORKLOG — PAIR-E02-K0-R01 / arm-a (three.js r186)

> 时间戳为 ISO-8601(本地 UTC+08:00)。每次 build 与每次浏览器验证均逐条记录。
> 预算计数器(`workspace/.budget/*.count`)为系统事实源;以下时间与计数文件一致。

```text
2026-10-24T13:40:08+08:00 | run start | Agent 开工;读 RUN-CONTRACT.md / brief.md / spec.json / knowledge(README+manifest)
2026-10-24T13:42:30+08:00 | 资产准备 | 复制 assets/boat.glb -> workspace/assets/boat.glb(sha256 校验 = ed22ff2f…9397,与 spec 一致,只读使用未改原文件)
2026-10-24T13:44:10+08:00 | 实现 | index.html:HUD(色调/Reset 控件,可见文本 + aria-label + data-ui)、加载/错误提示、import map 保持模板契约
2026-10-24T13:44:50+08:00 | 实现 | src/main.js:极坐标海面(150×224=33,824 顶点)+ 4 组 Gerstner 波、天穹/日月光晕、GLTF 运行时加载、相机环绕、色调混合、reset 释放重建
2026-10-24T13:45:00+08:00 | 实现 | scripts/build.mjs:增加 assets -> dist/assets 原样镜像(仅保证 dist/ 独立 serve 时仍是运行时网络请求,不转译/不内联)
2026-10-24T13:45:06+08:00 | build #1 | 成功(exit 0;dist/app.js 22.3kb;自检 OK)
2026-10-24T13:45:17+08:00 | 浏览器验证 #1 | 成功:__appReady=true、assetLoaded=true、assetRequests=1、consoleErrors=0、uncaught=[];发现日/月方位算反(在相机身后)且海面过亮偏平
2026-10-24T13:47:03+08:00 | build #2 | 成功:修正日/月世界方位(222°)、重排天空渐变/光晕、海面改为距离 LOD + 逐像素细波法线、加正面补光
2026-10-24T13:47:10+08:00 | 浏览器验证 #2 | 成功:GPU=NVIDIA RTX 5060、稳态 60.5fps;拖拽 35°→323°(|Δ|=72°);色调 toneMix=1;暖 [186,136,76] / 冷 [25,52,104];reset 后 epoch=1、requests=2、az=35、toneMix=0
2026-10-24T13:47:56+08:00 | build #3 | 成功:加强多倍频法线细节、镜头拉近(9.2m)、太阳移到 228°/5.0°
2026-10-24T13:47:58+08:00 | 浏览器验证 #3 | 成功:60.5fps、暖均值 [176,127,71]、无 console error
2026-10-24T13:48:48+08:00 | build #4 | 成功:方向性细波(5 组)、高角反射转冷、降几何波幅
2026-10-24T13:48:51+08:00 | 浏览器验证 #4 | 成功:60.5fps、boatPosition.y 随波变化、无异常
2026-10-24T13:49:40+08:00 | build #5 | 成功:水体本体改为深青(与天空反射分离)、反射亮度按菲涅尔衰减 0.62、扩宽高光通路
2026-10-24T13:49:44+08:00 | 浏览器验证 #5 | 成功:60.5fps、暖均值 [175,124,70]、近景出现青绿水色
2026-10-24T13:50:46+08:00 | build #6 | 成功(最终产物):细波斜率增强并对齐风向、高角反射更冷(冷/暖细纹对比)、几何涌浪幅 0.355
2026-10-24T13:50:59+08:00 | 浏览器验证 #6(最终) | 成功:P1–P7 全量探针模拟通过 —— nonBlank=1.0、waveΔ=1.45rad、下 60% 运动像素 0.769、boatΔy=0.223(4s 极差 0.349)、拖拽 |Δaz|=288°(回绕后)、拖拽像素差 0.649、toneMix=1、色偏 88.9/255、reset1(epoch1/req2/az35/tone0/lit1.0)、reset2(epoch2/req3/lit1.0)、consoleErrors=0、uncaught=[]
2026-10-24T13:52:40+08:00 | 产物复核 | dist/assets/boat.glb sha256 = ed22ff2f…9397;dist/index.html 引用 dist/app.js;serve 日志确认 "GET /assets/boat.glb" 200 29132
2026-10-24T13:53:00+08:00 | 停止 dev server | 关闭 7102 端口进程,避免与后续 harness 端口冲突
```

## 备注

- build 计数 6 / 8,browser 计数 6 / 6(自检用满,未超限)。
- 视觉迭代 6 轮:主要修正「日月方位在相机背后」「海面像沙丘」两类问题;最终保留低多边形风格下的
  暖橙天空 + 深青水体 + 日光高光带。已用满浏览器预算,故后续不再做未验证的着色器改动。
- `workspace/assets/boat.glb` 与 `dist/assets/boat.glb` 均为资产原样拷贝,运行时由 GLTFLoader 发起真实网络请求。
