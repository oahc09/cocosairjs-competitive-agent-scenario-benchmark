# WORKLOG — Arm B of PAIR-E02-K0-R01 (cocosair / K0)

计时口径:本文件时间戳取自 `workspace/.budget/*.count` 机器计数文件(UTC)。
预算消耗:build 7/8,browser 6/6,均在 RUN-CONTRACT §2 上限内。

```text
2026-10-23T16:20:40Z | build #1 | 成功 — 首版实现(动态网格海面 + ImageAsset 贴图天空 + GLB 船)
2026-10-23T16:20:51Z | 浏览器验证 #1(serve :7207) | 成功 — __appReady 10s 内 true、console 0 错误、assetLoaded=true;截图:船体/光照正常,天空全黑,水面为 clearColor
2026-10-23T16:24:29Z | build #2 | 成功 — 天空行序翻转修正、船吃水加深、波幅上调、海面扩至 ±400m
2026-10-23T16:24:35Z | 浏览器验证 #2 + 全探针序列 eval | 成功 — P2 wavePhase 推进、P4 方位角 +95°、P5 toneMix=0.996、P6/P7 双 reset 稳定(epoch 1/2, assetRequests 2/3, fps 60, console 0 错误);截图像素探针:天空仍黑(texture.image 重赋值不重传),下半屏=(40,32,52)=clearColor → 海面未渲染
2026-10-23T16:26:18Z | 浏览器验证 #3(诊断 eval) | 成功 — 船节点树正常(6×MeshRenderer),但 MeshRenderer 无 worldBounds 属性 → measureBoat 一直未生效
2026-10-23T16:30:34Z | build #3 | 成功 — 船测量改用 renderer.model.worldBounds + mesh.struct.minPosition/maxPosition×worldMatrix 回退;相机拖拽灵敏度 0.5°/px + 梯形限速 120°/s(保证松手后 500–700ms 窗口内仍有 >20° 运动)
2026-10-23T16:30:41Z | 浏览器验证 #4(诊断) | 成功 — 船测量经 struct 回退生效(boatPosition.y≈1.2–1.6 随波变化),P3 通过;天空贴图改 canvas 路径仍黑
2026-10-23T16:35:08Z | build #4 | 成功 — 天空贴图改 Texture2D.reset + uploadData(技能包文档的 typed-array 重灌路线)
2026-10-23T16:35:09Z | 浏览器验证 #5 + 像素探针 | 成功 — 天空渲染正确:暖金渐变 + 太阳光晕(顶部 y=0–200, 亮度 180),船体/帆像素正常;海面仍为 clearColor(动态网格静默不渲染)
2026-10-23T16:40:59Z | build #5 | 成功 — 动态网格 struct 边界显式刷新 + 容量余量 + 挂接后立即 updateSubMesh + __seaDiag 诊断
2026-10-23T16:41:00Z | 浏览器验证 #6(最终全探针序列) | 成功 — 全部状态断言通过:P1 assetLoaded/assetRequests=1;P2 相位推进+fps 56;P3 船 y 变化;P4 方位角 35→108→131.5(窗口内 Δ=23.4°>20°);P5 toneMix=0.996;P6 epoch=1 复位正常;P7 epoch=2/assetRequests=3 无泄漏无异常;__seaDiag:dynamic=true、边界已写、bundles=4/prims=1 —— 但截图像素证明海面仍不渲染(浏览器预算 6/6 用尽)
2026-10-23T16:43:59Z | build #6 | 成功 — 海面方案 pivot:弃用 createDynamicMesh(该臂实测静默不渲染、无控制台输出、struct/边界/更新均正常执行),改为极坐标分块静态网格场(467 块 × createMesh,与穹顶同款已验证渲染路径),每帧按同一 waveAt 更新位置+倾斜;首版分块数 159(顶点 1431<2000)不达标
2026-10-23T16:44:21Z | build #7(最终) | 成功 — 扇区公式改为弧长≈径向宽:467 块 / 4203 顶点(≥2000),maxR=400m;浏览器预算已用尽,本版未经浏览器复验,基于已验证原语(createMesh 静态网格=穹顶渲染路径、节点变换=船体动画路径、共享材质=文档 route 1)
```

## 关键工程事实(供复现/归因)

1. **Texture2D 程序化贴图**:`texture.image = new ImageAsset(...)` 重赋值在本引擎上不触发重新上传(首赋零数据 → 永远黑)。可行路线:`new Texture2D()` → `texture.reset({width,height,format})` → 每次重绘后 `texture.uploadData(uint8, 0)`。
2. **MeshRenderer 无 `worldBounds` 属性**(该组件面);船体包围盒经 `renderer.model.worldBounds` 不可用/为空时,`mesh.struct.minPosition/maxPosition × node.worldMatrix`(8 角点变换)可用 —— 实测走的是 struct 回退。
3. **utils.MeshUtils.createDynamicMesh + Mesh.updateSubMesh 在本臂实测静默不渲染**:创建/容量校验/struct(dynamic=true)/每帧 updateSubMesh+onGeometryChanged 全部正常执行、console 零输出、显式 struct 边界也无济于事,画面像素恒为 clearColor。已按替代方案(静态分块 + 节点动画)交付。
4. 相机方位角采用梯形速度曲线(加速 600°/s²、限速 120°/s),保证拖拽松手后 500–700ms 采样窗内仍有 >20° 持续运动(对 P4 双解释口径稳健)。
