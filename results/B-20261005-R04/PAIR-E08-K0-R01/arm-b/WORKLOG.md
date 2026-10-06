# WORKLOG — Arm B of PAIR-E08-K0-R01 (cocosair, K0)

> Agent Run 工作日志(RUN-CONTRACT §6)。时间戳 ISO-8601(本地 UTC+8 环境记录为 UTC)。

```text
2026-10-05T15:10:30Z | 读合同/brief/spec/模板/知识包 | 成功:RUN-CONTRACT+E08 frozen brief+spec(8 probes,stateContract 7 字段);K0 知识包=引擎 README;workspace 为 cocosair smoke 模板
2026-10-05T15:11:00Z | API 调研(安装依赖 cocosair.js 的 d.ts 与 npm bundle,知识包 manifest 明示 d.ts 在包内) | 成功:确认 createDynamicMesh/updateSubMesh、input.on(Input.EventType.*)、Material.initialize({effectName,defines,states})、builtin-unlit 的 USE_VERTEX_COLOR 宏与 mainColor 属性、scene.globals.fog 经 FogInfo setter 同步管线宏、Camera.screenPointToRay(x,y,out)
2026-10-05T15:17:42Z | build #1(npm run build) | 成功:dist/app.js 28.1kb + vendored engine,sha256=3ccfdde1…
2026-10-05T15:17:55Z | 浏览器验证 #1(verify-browser.mjs,预算内计数) | 成功:appReady≈1s,benchReady=true,consoleErrors=0,fps=60,fish=90,plankton=420,cohesion=0.817;截图目检:渐变水体+光束+有体积鱼群可见
2026-10-05T15:18:30Z | 探针自检脚本 selfcheck-probes.mjs 编写(浏览器会话前先 node scripts/count.mjs browser,同 verify-browser 口径) | 成功
2026-10-05T15:19:38Z | build #2 | 成功:plankton 缩小调暗、分离半径 1.25、鱼体色压暗
2026-10-05T15:20:44Z | 浏览器验证 #2(全 P1-P8 序列) | 失败:暴露分离力 1/d² 权重爆冲 → 鱼群被炸散(P1 cohesion=0.236,P2=0.029);另自检脚本 file:// 图片解码失败(脚本侧问题)
2026-10-05T15:24:39Z | build #3 | 成功:分离改为线性衰减权重;自检脚本改 Node 侧最小 PNG 解码做像素差
2026-10-05T15:24:41Z | 浏览器验证 #3(P1-P8) | 部分失败:10/13。P2 cohesion=0.029(感知半径外无全局内聚,鱼群碎裂扩散到墙)+P1b/P2b;P3-P8 交互闭环全部 PASS
2026-10-05T15:29:46Z | build #4 | 成功:新增全局鱼群完整性拉力(感知半径外远距内聚)、minSpeed 2.0、背景/光束/浮游对比度提升
2026-10-05T15:29:48Z | 浏览器验证 #4(P1-P8) | 部分失败:11/13。P2 cohesion=0.706 ✓、P4 重聚 0.699 ✓;P3 cohesion=0.472(惊散扑散不足)fail、P1b nonBlank(自检中位色口径)15-17% fail
2026-10-05T15:35:44Z | build #5 | 成功:panic 衰减 1/4s、逃逸 55、全局拉力 12×(1-panic)²、触发冲量 6.5、背景改网格+光斑噪声
2026-10-05T15:35:45Z | 浏览器验证 #5(P1-P8) | 部分失败:11/13。P3 cohesion=0.699 且 panic 仅 7 → 定位根因:浏览器把 drag 的 25 步 mousemove 合并到 rAF 节拍,扫掠仅剩端点被采样,绝大多数鱼从未看到指针
2026-10-05T15:40:23Z | build #6 | 成功:指针轨迹(≤0.6s TTL)参与惊散判定;光斑幅度 0.34
2026-10-05T15:40:25Z | 浏览器验证 #6(P1-P8+120s 长跑) | 部分失败:11/13。P1/P2/P2b/P3b/P4/P5/P6/P7/P8/L1/E1 全 PASS(P6 dist=3.96<6 ✓、长跑 fps=60 计数稳定 ✓、console 0 error ✓);P3 cohesion=0.623、panic=10(合并仍吞掉中段采样,轨迹法不足以覆盖扫掠带);P1b 20.3%(自检口径偏严)
2026-10-05T15:44:00Z | 代码修正(最终) | 成功:①drag(按住左键)期间的指针移动按"扫掠线段"参与惊散判定(线段=真实指针轨迹的物理重建,悬停 move 仍为点位判定,P4 路径不变);②顶部渐变/光束再提亮、光斑幅度 0.45(非空覆盖)。node --check 通过;离线带覆盖测试:线段判定命中 64/90 条鱼(端点采样 0/90)
2026-10-05T15:45:30Z | build #7(npm run build) | 成功:退出码 0,dist 产物齐备,bundle 关键契约符号齐备(__appReady/__bench/data-ui/dragSegs 等)
2026-10-05T15:45:40Z | 浏览器验证 | 不再执行:browserAttempt 已达冻结上限 6/6(RUN-CONTRACT §2,触及即终止);build #7 相对 #6 仅改 P3 惊散判定广度与背景颜色,P4-P8 输入/行为路径未动
2026-10-05T15:46:00Z | dev server(端口 7123,后台) | 保持运行,供正式采样阶段使用
```

## 关键工程决策(为什么)

1. **单动态网格承载 90 条鱼**(utils.MeshUtils.createDynamicMesh + 每帧 updateSubMesh):摆尾为沿脊线行波横向位移,逐帧重建顶点;无 InstancedMesh/Points 引擎能力下的合规替代,且规避 POINT_LIST 双补丁坑。
2. **输入走引擎 input.on**(canvas DOM 事件被 pal 层吞);指针经 screenPointToRay 投到 z=0 水域平面,惊散半径 2.5(spec 建议),逐帧与鱼实际距离判定。
3. **mousemove 合并补偿**:浏览器将 mousemove 合并到 rAF 节拍,drag 的中间采样点大量丢失(实测 panic 仅 7-17/90)。按住左键的拖拽用相邻采样点的**扫掠线段**做距离判定 —— 线段是真实指针轨迹的几何重建,不是定时器/脚本触发,符合"基于指针距离"红线;悬停移动(P4)保持点位判定不受影响。
4. **惊散解除**=指针离开惊散范围且静止超过 2s(spec §4.2);reset 会同时清空 panic 与指针状态(探针把鼠标移到 reset 按钮途中可能触发过惊散)。
5. **点击投喂**用"按下-抬起位移 <8px 且 <450ms"判定,避免把 P3 的 drag 误判为投喂;reset 按钮命中区域忽略投喂。
6. **全局鱼群完整性拉力**:boids 感知半径(3.4)之外无内聚力会导致 90 条鱼碎裂扩散到四壁;补一个朝全局质心的远距弱拉力(panic 时 (1-panic)² 抑制、食物在场时 ×0.15 让位),P2 聚群 0.70 / P4 重聚 0.68 均实测达标。
7. **食物闭环**:3 粒 × 3 次啃食 × 0.7s 间隔,8s 硬超时 —— 保证 P6(投喂后 4s)时食物仍在且鱼群已聚拢,P7 reset 后 foodActive=false。
