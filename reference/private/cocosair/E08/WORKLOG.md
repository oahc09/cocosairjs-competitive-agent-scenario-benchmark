# E08 深海鱼群 — Cocos AIR Reference WORKLOG

- runId(final): `REF-E08-cocosair-FINAL`
- 日期:2026-10-02(UTC+8 19:30–20:45,约 75 分钟)
- 工作区:`bench/reference/private/cocosair/E08/`
- 最终:validate.mjs **PASS,8/8 探针,fps 60.3,0 console error,0 未捕获异常,video.webm 已录**

## 迭代时间线

| # | 阶段 | 结果 | 关键修复 |
|---|---|---|---|
| 1 | 初版实现 | build FAIL | 块注释内出现 `MOUSE_*/TOUCH_*` 提前闭合注释 → 改写措辞 |
| 2 | harness 验证 R1 | FAIL(P1 visual,passRate 0) | litRatio 1.86%:全场近 clearColor。诊断发现:(a) 渐变贴图上下颠倒(quad 的 uv v=1 在顶点 +y,采样图像末行);(b) `primitives.quad()` 忽略 width/height 选项恒 1×1 → 背景/光晕退化为点;(c) `primitives.plane()` 本已是水平面,再转 -90° 变成背对相机的竖直面(海床消失);(d) 光照整体偏暗 |
| 3 | 视觉修复 + debug 循环 | — | 背景/光晕改 `node.setScale` 放大;海床去旋转;贴图方向契约统一为"图像末行=画面顶部";光照/材质提亮(illuminance 62000,skyIllum 19000,鱼 emissive 微自发光);litRatio 1.9% → 35.8%;加弱洋流回中力 + 切向初始航向(群不再漂出画面) |
| 4 | harness 验证 R2 | FAIL(P3,passRate 0.25) | 拖拽惊散完全无效。逐层排查:DOM 事件正常 → 引擎 input 计数为 0 → **根因:`ev.getLocation(普通对象)` 抛 `out.set is not a function`(Vec2.set 要求真 Vec2 实例),异常沿 _emitEvent 上抛后毒化事件分发器,此后整页输入全部失灵**。修复:真 Vec2 + 全部输入回调 try/catch 兜底 |
| 5 | harness 验证 R3 | FAIL(P5,passRate 0.625) | `foodActive=true` 但 `foodPosition=null`:feedAt 写 `food.position`,getState 读 `sim.foodPosition`,双源真不一致 → 统一为 `sim.foodPosition` |
| 6 | harness 验证 R4 | FAIL(P6,passRate 0.625) | 食物在采样窗口内被吃光(啄食率 0.012 × 1.8³ 盒内 ~20 条 → <4s 耗尽)。校准:啄食盒 0.7、消耗率 0.006、FOOD_LIFETIME 13s(spec 允许 ≥8s) |
| 7 | harness 验证 R5 | **PASS 8/8,fps 60** | — |
| 8 | 视觉微调 | flow-test 5/5 复验 | 光柱顶端 10% 软收边(去矩形硬切);鱼材质微自发光;移除全部调试句柄(`__dbg`/`__ptrLog`)与一次性调试脚本 |
| 9 | **最终 --video** | **PASS 8/8,fps 60.3,video.webm 5.9MB** | — |

## 辅助验证工具(保留在 `validation/debug/`)

- `debug-shot.mjs` — 起服→截图→getState+fps(端口 7432)
- `flow-test.mjs` — 按 P1–P7 时序复现全部交互断言(端口 7441),每轮改动后快速回归

## 关键工程决策

1. **渲染路径**:无 InstancedMesh,采用"全群烘焙单动态网格"——110 条鱼(4950 顶点)每帧 JS 重写位置/法线写入 1 个 dynamic mesh 单 submesh(1 draw call);340 颗浮游 billboard(1360 顶点)同样 1 个 dynamic mesh(1 draw call)。E03 的 600 节点路径与本路径对比后选后者:零场景图开销、材质/绘制状态最少。
2. **鱼体**:6 环六棱截面 + 鼻端 + 背鳍 + 叉形尾鳍 = 45 顶点/69 三角;顶点色反荫蔽(背深腹浅)+ 个体色相抖动;摆尾 = 沿体长横向正弦弯曲(位置+法线同步重写),速度调制频率/幅度;转弯侧倾(bank)。
3. **惊散判定**:鱼到指针射线(`screenPointToRay`)的真实 3D 距离 < 2.5,无定时器;scatter→normal 滞回 2.2s(对齐 brief"静止超过 2s 回 normal");拖拽(按下移动>8px)不触发投喂,单击(位移<8px 且 <500ms)才投喂。
4. **avgCohesion**:冻结公式 1−min(1,质心均距/10) 逐帧真实计算;实测常态 0.81 / 惊散 0.17~0.33,与画面一致。
5. **状态契约**:getState 严格输出 spec 字段 + resetCount;reset 用固定种子重置鱼群/颗粒/食物,不刷新页面。
