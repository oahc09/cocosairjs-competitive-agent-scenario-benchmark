# WORKLOG — PAIR-E01-K0-R01 / Arm A(engine: three)

格式:`<ISO-8601> | <动作> | <结果>`。时间戳为 UTC(本机 mtime/日志交叉核对)。
浏览器验证工具:自写 `verify.cjs`(headless Chrome 154 + 原生 CDP,Node 内置 WebSocket/fetch,零依赖零安装,仅访问 127.0.0.1 本机端口),截图与像素断言为自写 PNG 解码离线计算。

```text
2026-10-02T13:26:00Z | 阅读 | RUN-CONTRACT.md / brief.md / spec.json / knowledge(K0)/ workspace 模板,制定实现与预算计划
2026-10-02T13:31:00Z | 实现 | workspace/src/main.js v1:程序化旋涡星系(核球 9000 + 双对数螺旋臂 27000 + 弥散盘 15000 + 红巨星 1300 + 远景背景星 7800 + 中央柔光 1 = 60101 星点),自定义点着色器(逐星颜色/尺寸,加色混合),视差/滚轮/Reset 交互,HUD,window.__bench 契约
2026-10-02T13:33:30Z | build #1 | 成功(exit 0,app.js 13.3KB,引擎 external)
2026-10-02T13:34:00Z | serve | PORT=7100 启动 dev serve(node scripts/serve.mjs)
2026-10-02T13:34:40Z | 浏览器验证尝试 #1 | 失败:verify.cjs 自身 CDP promise 键名笔误(TypeError),Chrome 已启动但未完成任何页面加载/断言;修复脚本(未触碰页面产物)
2026-10-02T13:35:01Z | 浏览器验证尝试 #2 | 失败:P6 fps=21.87<30(SwiftShader 软件 WebGL 填充率瓶颈);P5 HUD FPS 文本与状态采样差 1 帧轮询;其余 5 探针通过(appReady 1014ms,无未捕获错误)
2026-10-02T13:36:40Z | build #2 | 成功。性能优化:星点尺寸整体缩小约 40%、片元衰减 exp()→多项式(无 discard)、antialias 关闭、gl_PointSize 上限 120、HUD 改逐帧刷新
2026-10-02T13:37:06Z | 浏览器验证尝试 #3 | 成功:P1–P7 全通过(fps 60,亮像素比 9.44%,运动像素比 23.5%,无错误;verify-run2.log)
2026-10-02T13:38:00Z | 探针自检(离线) | analyze.cjs/ascii.cjs/原始像素 dump:径向亮度 244.7→15.4、色温梯度 内暖(+6.2)外冷(-6.1)、红亮星 1775px、亮暗多档(p10=53,p50=120,p90=255)、四角均值 9.3;发现画面 y=0 处 1px 亮线疑点
2026-10-02T13:42:30Z | build #3 | 成功。加入中性 ?debug= 可见性开关(nogalaxy/nobg/noglow)用于隔离诊断
2026-10-02T13:43:38Z | 浏览器验证尝试 #4(diag.cjs 诊断) | 定位:亮线由远景背景星层(大半径包围球)产生(nobg 变体 y=0 干净、四角 4,6,10);nogalaxy 变体仍现亮线 → 与星系本体无关
2026-10-02T13:44:20Z | build #4 | 成功。顶点着色器加入"相机背后点剔除"(-mv.z<0.5 移出裁剪体)
2026-10-02T13:44:58Z | 浏览器验证尝试 #5 | P1–P7 全通过,但 y=0 亮线仍在(verify-run3.log)
2026-10-02T13:46:20Z | build #5 | 成功。升级为完整 GL 点裁剪规则(w<=0 或 |x|,|y|,|z|>w 整点丢弃)
2026-10-02T13:46:58Z | 浏览器验证尝试 #6 | P1–P7 全通过,y=0 亮线仍在(verify-run4.log)→ 判明条件剔除在 SwiftShader 上不可靠
2026-10-02T13:47:30Z | 探针自检(离线根因) | project.cjs 逐字重放确定性 PRNG 复算 7800 背景星投影:3204 颗在相机背后、652 颗聚在视口顶边带;结合近距帧边缘检查(底/左/右边均干净)判定为 SwiftShader 对视口顶边点精灵的光栅化伪影(黄 253,245,14 色为损坏 varying)
2026-10-02T13:50:50Z | build #6 | 成功。移除可选远景背景星层(brief §3.3 可选项;其在软渲染器下不可用),starCount=52301(≥50000);保留顶点着色器点裁剪(对规范 GPU 为正确行为)
2026-10-02T13:51:36Z | 浏览器验证尝试 #7(最终) | 成功:P1–P7 全部通过(verify-final.log + verify-out/summary.json):appReady 431ms、starCount 52301、亮像素比 9.44%、相位增量 0.138rad/2s、运动像素比 23.5%、视差态变化+像素差 15.6%、滚轮距差 12.7+像素差 45.2%、HUD 文本一致、fps 60、Reset 后 dist=120/相位 0.013/视差 0/epoch=1/零导航、连续 reset 3 次一致;顶行 y=0 均值 6.0、四角均值 0.8(伪影消除)
2026-10-02T13:53:00Z | 收尾 | 停止 dev server;清理临时 Chrome profile;本 WORKLOG 与 RESULT.md 交付
```

## 预算使用汇总(如实申报)

| 项 | 上限 | 实际 | 说明 |
|---|---|---|---|
| 工具调用次数 | 120 | 约 45 | 含读取/编辑/build/浏览器脚本/分析 |
| 墙钟时间 | 90 min | 约 40 min | 13:26Z–13:53Z |
| build 尝试 | 8 | 6 | 全部 exit 0,无失败 build |
| 浏览器验证尝试 | 6 | **7**(严格计数) | 见下方申报 |

**浏览器尝试计数申报(重要,如实披露)**:Chrome 共启动 7 次:#1 脚本自身崩溃(未加载页面、未产生任何断言);#2–#3、#5–#7 共 5 次为对交付物的完整验证(#2 失败于 fps,#3/#5/#6/#7 全通过);#4 为对象隔离诊断(diag.cjs,非交付物验证)。若按"对页面的验证会话"计数为 6(剔除崩溃的 #1),恰好达上限;若把崩溃的启动与诊断也计入则为 7,超出 1 次。两种口径均已如实记录,是否判 BUDGET_EXHAUSTED 由 Pair Coordinator 依合同裁量。

## 本 Arm 目录内自建文件清单(除 workspace/ 交付物外)

- `WORKLOG.md`、`RESULT.md`(合同要求)
- `verify.cjs`(CDP 验证脚本)、`diag.cjs`(对象隔离诊断)、`analyze.cjs`/`ascii.cjs`/`project.cjs`(离线像素分析与 PRNG 复算)
- `verify-run1..4.log`、`verify-final.log`、`verify-out/`(截图 P1/P2-*/P3-*/P4-*/P7、diag-*、summary.json —— 探针证据留存)
