# WORKLOG — PAIR-E05-K0-R01 / arm-b

> 本文件由本 Arm Agent Run 维护(RUN-CONTRACT §6)。每次 build / serve / 浏览器验证 / 探针自检追加一行。
> 说明:.budget 机器计数器中 2026-10-05T10:36–10:57Z 的 3 次 build + 3 次 browser 为**先于本次派发(11:22:49Z)的前次中断尝试**所留(当时未产出 WORKLOG/RESULT,execution.json 注记两次派发遭平台瞬时错误)。本 Run 自续接点继续,预算按计数器实况累计(上限 build 8 / browser 6)。

```text
2026-10-05T11:40:00Z | 接手诊断 | 前次遗留 src/main.js(v2)与已构建 dist;shot1/shot2 显示:星云/辉光层被渲染成不透明大圆(engine builtin unlit 下顶点色 alpha 混合未生效),不透明多普勒叠层盖死盘面条纹,星流疑似冻结,背景星不可见
2026-10-05T11:45:00Z | 诊断 | 查包内自带 d.ts(knowledge/manifest.json 注明 K0 包内含 build/cocosair.module.d.ts,仅类型签名非文档):createDynamicMesh 应为 (primitiveIndex, geometry, out, options)、updateSubMesh 应为 (primitiveIndex, geometry) —— v2 调用缺参 ⇒ 星流动态更新失败回退静态;IDynamicGeometry 索引键为 indices16/indices32
2026-10-05T11:46:00Z | 决策 | v3 全不透明设计:零混合依赖;径向梯度×条纹×多普勒×外缘渐黑全部烘进盘面顶点色;删除星云/光晕板层;星流按 d.ts 签名修正;内置 __snap(EVENT_AFTER_DRAW 内 readPixels 缓存)供像素级自检
2026-10-05T12:24:00Z | build #4 | 成功(exit 0,build.count #4,v3 全不透明重写)
2026-10-05T12:24:30Z | serve | node scripts/serve.mjs PORT=7113 启动,GET / 200
2026-10-05T12:24:51Z | 浏览器验证 #4 | 成功:appReady=true,benchReady=true,console 0 error,0 uncaught;但 --eval 结果为 undefined(排查:new Function('return (fn)') 未调用 IIFE ⇒ playwright 序列化函数为 undefined)
2026-10-05T12:26:41Z | 浏览器验证 #5 | 成功:综合探针自检(mega-eval,单会话完成 P1-P6 状态+像素证据)。结果:P1 state ✓/center-third 85.7%✓/outer-corners 0.064% ✗(<1%);P2 ✓(Δrot 0.39rad、盘区两帧差 84% 采样点);P3 ✓(亮侧 rbDiff +150.7 ≥18);P4 ✓(camDist 6.81<10、暗核半径 70→143px=2.04x);P5 ✓(mid-ring 91% 两帧差、count 恒 220);P6 ✓(cam=14、rot 0.163<0.3、phase 0.026<0.1)
2026-10-05T12:27:30Z | 诊断 | outer-corners 长期为 ~0.1% 且逐帧波动 ⇒ 那些像素是星流而非背景星;根因:星空采样方向围绕 +CAM_DIR,而相机位于 CAM_DIR*14 lookAt 原点(视线 = -CAM_DIR)⇒ 背景星全部生成在相机背后,自 v2 起从未入画
2026-10-05T12:28:50Z | build #5 | 成功(exit 0,#5):星空改屏幕空间均匀布点(相机射线反投、相对相机位置放置)+ 尺寸/亮度上调 + 盘面梯度重调(内缘 >1 白热、外缘更暗更红,修正亮度次序)
2026-10-05T12:29:03Z | 浏览器验证 #6 | 成功:P1 state ✓/center-third 85.7%✓/outer-corners 0.144% 仍 ✗(证实恒星仍不可见);P2 ✓(Δrot 0.39rad、diskDiff 82%);P3 ✓(亮侧 rbDiff +124.9;ringLum 181.7>outerLum 163.3 亮度次序改善);P4 ✓(camDist 6.81、暗核 70→143px);P5 ✓(midDiff 91%);P6 ✓(cam=14、rot 0.158、phase 0.025);契约 ✓(appReady/bench/0 错误;diag: USE_VERTEX_COLOR 生效、createDynamicMesh ok、updateSubMesh ok)
2026-10-05T12:29:30Z | 预算判定 | browser 计数已达 6/6 上限,不可再开浏览器会话;P1 outer-corners 的半球翻转修复只能以几何推导背书
2026-10-05T12:30:03Z | build #6 | 成功(exit 0,#6):星空方向翻转为 -CAM_DIR 半球(相对相机放置不变)——修复后星位 ≈ CAM_DIR*(14-R),R∈[70,190] ⇒ 位于原点另一侧 56-176 单位处,处于视锥内(far=900),屏幕密度均匀 ≈4.4%/角区(阈值 1%)
2026-10-05T12:30:31Z | 收尾 | 写 RESULT.md;停止 dev server
```
