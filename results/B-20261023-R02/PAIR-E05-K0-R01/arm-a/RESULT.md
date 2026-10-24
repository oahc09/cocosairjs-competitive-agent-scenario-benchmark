# RESULT — PAIR-E05-K0-R01 / Arm A(three r186 / K0)

> 交付实现:`workspace/src/main.js` → `npm run build` → `dist/`(退出码 0)。
> 本文件按 RUN-CONTRACT §7 三段交付。

## 1. 实现摘要(逐 probe)

| Probe | 实现方式 | 自检证据 |
|---|---|---|
| **P1** 初始画面非空 | 事件视界=半径 1.2 纯黑球(屏幕投影直径≈短边 15%);吸积盘内缘 1.8→外缘 6.5 的环形 ShaderMaterial(加色混合);460 颗背景星(自定义 Points 着色器,三档像素大小+冷暖色)+程序化星云背景纹理保四角非黑 | 中心 1/3 非黑比例 100%(阈值 5%);四角 100%@thr8、≥37%@thr16(阈值 1%);暗核中心 L=37.6 vs 亮环 L=178(被亮环包围的连续暗核);状态 stars=460/stream=240/dist=14/rot@2.5s≈1.07 全过 |
| **P2** 盘旋转运动 | 条纹图案 f(θ−uPhase) 随 uPhase 刚性旋转,角速度 0.4 rad/s ∈[0.15,0.6];uPhase 即 diskRotation(同源驱动,画面与状态严格一致);accretionPhase=(diskRotation mod 2π)/2π | 两帧(800ms)diskRotation 差 0.319–0.375 ≥ 0.1;帧差分:盘环形区 25.3% 像素变化、全图 8.4%;accretionPhase 采样 ∈[0,1) |
| **P3** 径向颜色梯度 | 盘着色器径向色带:内缘白/蓝白(0.92,0.96,1.06)→中带黄橙→外缘暗红(0.55,0.12,0.035);多普勒不对称 1+0.9·cosθ(一侧增亮偏蓝、对侧减暗偏红);光子环蓝白叠加 | 多普勒亮侧(右)扇区:外环带 R−B=59.2 vs 内环带 R−B=1.0,有向差 58.3 ≥ 18(3.2x 余量);内环带亮度 210.8 = 外环带 1.64x ≥ 1.5x |
| **P4** 滚轮缩放 | window wheel(passive:false)→ targetDist·exp(Δy·0.0012),clamp[5,28];指数平滑 τ=0.12s(1s 内残差<1%);仰角 24°、距离驱动相机位置 | 真实 CDP 滚轮 dy=−600 → 1.3s 后 cameraDistance=6.81 ∈[5,10);暗核屏幕半径 47px→106px(2.26x ≥ 1.25);缩放态过曝 0.02%、~66fps |
| **P5** 星流螺旋 | 240 粒子(恒定)沿 XZ 螺旋:角速度 2.4/r^1.5、径向速度随 (1.2/r)³ 加速;r≤1.16 吞噬→外圈 6.8–9.4 重生;每粒子 6 段解析拖尾(近核最长≈1 单位、色偏蓝白),被黑球深度遮挡产生"没入"观感 | starStreamCount 恒 240;中环带(130–260px)帧差 27.4% 像素变化(流向中心的运动证据);缩放态与初始态均持续 |
| **P6** reset | `data-ui="reset"` 右上角 DOM 按钮 → diskRotation=0、camDist=camDistTarget=14、粒子按新种子复位重生(总数恒定)、背景星不动、__appReady 保持 true | 真实点击后 400ms:dist=14.0∈[13.5,14.5]、rot=0.163<0.3、phase=0.026<0.1、stream=240;reset 截图与初始截图各项指标一致(核心/环带/角落/P3 全部同量级),画面非空 |

**辉光观感(必需,路径不限)**:三层手段——① UnrealBloom(strength 0.36/radius 0.4/threshold 1.4,仅 HDR>1.4 的最热部分柔化);② 核心辉光 billboard(7.5×7.5 径向指数衰减板,中心被黑球深度遮挡→围绕暗核的环状柔光);③ 盘/晕 Shader 内外缘 smoothstep+指数衰减(无硬边)。亮部不死白(过曝 0)、暗部不糊黑(四角星云 ~(30,40,60))。
**加分项**:多普勒不对称(亮侧 R−B 差 58 与亮度 1.64x,双侧不对称可见)+ 透镜观感(蓝白光子环围绕暗核 + 盘远缘上弧 + 近缘盘面横越暗核下缘,Interstellar 式构图)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. `npm run build` 退出码 0** — build #1–#4 全部成功,产物自检通过(app.js 15.7KB、vendor、dist/index.html)
- [x] **2. 10s 内 `window.__appReady === true`** — 5 次会话均在首次轮询(≈200ms 内)即 true
- [x] **3. `window.__bench = { getState, reset }` 契约成立** — benchReady=true×5;getState 返回 spec §7 全部字段(diskRotation/accretionPhase/cameraDistance/starStreamCount/backgroundStarCount),reset 见 P6
- [x] **4. 无未捕获异常** — 5 次会话 consoleErrors=0、uncaught=[]
- [x] **5. 探针自检(P1–P6 全部通过)** — 状态断言 + 独立可观证据(截图/帧差/半径比)逐条见上表;证据文件:`shots/final-initial.png`、`shots/p2-frameA/B.png`、`shots/p4-zoomed.png`、`shots/p6-reset.png`,像素统计脚本与输出见 `selfcheck/`

预算消耗(机器计数 `.budget/`):build 4/8,browser 5/6;工具调用约 45/120;墙钟约 50/90 分钟。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. **另一 Arm(arm-b)**:未访问其任何目录/代码/日志/server/截图/结果。✔
2. **reference/**:未访问(本 Arm 目录内本就不存在,也未去仓库其他位置找)。✔
3. **bench/results 其他目录 / 既往 trial**:仅访问本 Pair 本 Arm 目录(`results/B-20261023-R02/PAIR-E05-K0-R01/arm-a/`)。✔
4. **harness/ 源码与合同模板**:未读、未改;仅调用模板自带 `scripts/count.mjs`、`scripts/verify-browser.mjs`、`scripts/serve.mjs`、`scripts/build.mjs`(以使用者身份执行,未读 harness 目录)。✔
5. **引擎资产 vendor/ 与上游源码仓库**:未访问 `bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树;引擎仅通过共享 node_modules 安装产物与模板 import map 使用(构建由 build.mjs 完成),未读其 docs/examples。✔
6. **bench/docs/ 合同文档目录**:未访问(仅读本 Arm 内拷贝的 RUN-CONTRACT.md/brief.md/spec.json)。✔
7. **secret/**:未访问、未探测。✔
8. **联网**:零网络请求;所有验证与像素分析均本地完成(selfcheck 脚本为纯 Node 离线 PNG 解码),未使用任何联网检索/分析服务。✔
9. **npm install / 改共享仓**:未安装任何依赖,未改动共享 node_modules 与仓内其他内容。✔
10. **修改冻结文件**:brief.md / spec.json / RUN-CONTRACT.md / 模板 scripts / 探针结果——均未修改;仅新建 workspace/src/main.js(模板起点文件的既定替换)、WORKLOG.md、RESULT.md、shots/、selfcheck/。✔
11. **探测/篡改 harness 行为**:未做;实现不含任何自动化环境检测或特判(URL 参数分支、UA 嗅探等均无)。✔
12. **预算计数完整性**:未手改/伪造/删除/重置 `.budget/*.count`;全部 4 次 build 经 `npm run build`(串联 count)、5 次浏览器会话中 4 次经 `verify-browser.mjs` 自动计数、1 次(capture.mjs)在会话创建前显式执行 `count.mjs browser`(合同 §2 口径)。✔
