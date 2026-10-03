# WORKLOG — E01 深空星系巡航 · Cocos AIR Reference

- 实现者:Reference(trusted),可读引擎源码/docs/examples
- 日期:2026-10-02
- 工作区:`bench/reference/private/cocosair/E01/`
- 最终结果:**PASS(7/7 probes,fps 60.2,含 --video 轮)**

## 0. 时间线与迭代计数

| # | 阶段 | 结果 |
|---|---|---|
| 1 | 读 MASTER-CONTEXT / brief / spec / 引擎 examples & 源码(create-mesh、pass、program-lib、webgl2-commands、shader-blocks) | 确认技术路线 |
| 2 | 首版实现 + build | exit 0 |
| 3 | validate 轮 1(REF-E01-cocosair) | 3/7:P2 motion 失败(画面全白、静态) |
| 4 | 浏览器内交互调试 ~12 轮(build+dbg 脚本,`debug/dbg*.mjs`) | 定位 3 个引擎坑(见 §2) |
| 5 | validate 轮 2 | 5/7:P4 失败(滚轮无效) |
| 6 | 捕获阶段监听修复 + dbg7 手动复验 P3/P4/P7 状态断言 | 全部通过 |
| 7 | validate 轮 3 | **7/7 PASS,fps 60.1** |
| 8 | 视觉量化复核(构图/梯度/旋臂,见 §4) | 达标 |
| 9 | 最终 --video 轮(REF-E01-cocosair-final,port 7403) | **7/7 PASS,fps 60.2,video.webm 4.9MB** |

效率口径(独立报告,不入分):validate 4 轮;总 build ~16 次(全部 exit 0,零失败构建);浏览器会话 ~14 次;修复要点 4 个(2 个为引擎坑位绕行、1 个输入捕获、1 个参数调优)。

## 1. 技术路线(最终)

- **星点渲染**:全部 74,500 星点 = 2 个 POINT_LIST Mesh(星系 62,500 + 远景球壳 12,000),共享 1 个自定义 Effect/Material,合计 2 次 draw call。
- **自定义 Effect**:glsl4/3/1 三变体手写(examples/shader-custom-gradient 同款注册链路:`EffectAsset.onLoaded()` 必须在 `createAirApp` 之后)。
  - 顶点:仅引用 CCCamera/CCLocal(与 examples/shared/shader-blocks.js `standardVert` 同款已验证块);`gl_PointSize = clamp(a_star.x / gl_Position.w, 1, 96)`,其中 `a_star.x` 构建期烘焙 `worldSize × pxScale`(pxScale=(canvas 高/2)/tan(fov/2)),视距取透视除法前的 `gl_Position.w`(= -z_view)→ **顶点阶段零 uniform**。
  - 片元:CCGlobal(cc_time)+ 高斯软核衰减 `exp(-14·r²)` + 每星种子 twinkle;additive 混合(ONE,ONE)→ 星系辉光(引擎无 Bloom,spec 允许的近似,记 ENGINE_LIMITED)。
- **自定义顶点属性**:`utils.createMesh` 的 `customAttributes`(`a_star`:RG32F = 尺寸烘焙值 + 种子)+ 内建 colors 通道(a_color:RGBA32F)。
- **相机**:透视 45°,斜俯视(仰角 38° → 盘面法线与视线夹角 ≈52° ∈ [30°,60°]),距离 [40,400] 初始 120;滚轮 -600 → 距离目标 -72,τ=0.55s 指数平滑(双采样窗内 Δ≈10-12 > 5 阈值);视差 τ=0.2s,满偏摆幅方位 0.14rad/仰角 0.10rad(≈画布 10% 以内)。
- **reset**:epoch+1、相位归零、距离 τ=0.18s 快速恢复(800ms 时残差 <1 单位)、**视差重新锚定当前指针**(否则点击 Reset 后指针停在按钮上,视差目标非零会导致 P7 的 |parallax|<0.01 失败)。
- **HUD**:DOM 覆盖层(左上角,`data-ui`=hud/hud-stars/hud-fps/hud-dist/hud-phase/reset),约 8Hz 刷新,数值与 `__bench.getState()` 同源。
- **fps**:EVENT_AFTER_DRAW 时间戳 2s 滚动窗(harness 独立 rAF 采样 60.2 与状态 ~60 互证)。

## 2. 引擎坑位(实测定位,ceiling-notes.md 有可复现细节)

1. **`utils.createMesh` 的 POINT_LIST 被 `||` 判空吞掉**:`src/cocos/3d/misc/create-mesh.ts` `primitiveMode: geometry.primitiveMode || PrimitiveMode.TRIANGLE_LIST` — POINT_LIST(=0)为 falsy。症状:62,500 顶点按 2 万个垃圾三角形绘制 → additive 全屏白。修复:createMesh 后、首次访问 `renderingSubMeshes` 前补写 `mesh.struct.primitives[*].primitiveMode = POINT_LIST`(Mesh.reset 只写 struct,RenderingSubMesh 惰性创建,公开 API 路径可达)。
2. **实际 draw 图元取自 Pass 而非 Mesh**:仅修 mesh 侧仍画三角形;`src/cocos/render-scene/core/pass.ts` `Pass._primitive` 默认 TRIANGLE_LIST,PSO 从 `pass.primitive` 取图元。修复:effect JSON 的 pass 里显式 `primitive: gfx.PrimitiveMode.POINT_LIST`(该字段无任何文档,由 pass.ts:122 反推)。
3. **顶点阶段 UBO 读取漂移**:自定义 Constants(set1/binding0,stageFlags VERTEX|FRAGMENT)与 CCGlobal 在顶点着色器中读到逐顶点漂移值(对照实验:CCCamera/CCLocal 正常——位置/变换始终正确;把 uniform 值经 varying 输出成像,同一点位内随星点变化,非恒定)。规避:尺寸计算完全去 uniform 化(见 §1)。未根因到引擎具体行,按"实测现象+规避"如实记录。
4. **引擎在 canvas 上吞 wheel 事件**:window 冒泡阶段收不到(preventDefault+stopPropagation 发生在 canvas 层)。修复:`addEventListener('wheel', ..., { capture: true, passive: true })`(pointermove/mousemove 同样加 capture 防御)。

## 3. 探针关键数据(最终轮)

- P1 nonBlank:lit 19.7%(阈值 2%)✓;starCount=74,500 ≥ 50,000(真实顶点数,2 mesh 顶点合计)
- P2 motion:center 80% 运动像素达标;2s 相位增量 ≈0.1 rad(ω=0.05 rad/s)✓
- P3 视差:pointermove 后 parallaxOffset.x ≈0.168→0.18 持续变化 + pixelDelta ✓
- P4 穿行:before 76.2 → after 64.3(Δ=11.8 > 5)✓
- P5 HUD:hudVisible=true、fps≈60>0、文本含星点数/帧率/距离 ✓
- P6 fps:60.2 ≥ 30(harness rAF 独立采样 181 帧/3005ms)✓
- P7 reset:epoch=1、dist=119.4 ∈[115,125]、|parallax|=0、phase=0.042<0.1、无导航 ✓

## 4. 视觉量化复核(P1-vis.png)

- 构图:亮核居中(质心 0.49/0.55),盘面亮区横向 ≈66% 画宽 ∈ [60%,75%];法线夹角 ≈52° ∈ [30°,60°]
- 色彩梯度实测:核心 [163,156,147](暖白)→ 中段 [55,53,64](蓝白)→ 外缘 [96,106,135](冷蓝,B>R);含 3% 橙红亮星;三档亮暗层级(核球亮星/盘面普通星/暗弱星)在 blob 尺寸分布(1px 暗星 → 3px+ 亮星 → 大面积核球合并区)中可辨
- 旋臂:2 条对数螺旋(b=0.55,臂间 π),ASCII 亮度图双叶结构清晰;核球 9,000 星中央聚集;远景球壳 12,000 星(视野立体角内 ~1,300 可见)提供纵深
- 背景:纯色 (10,10,16),无梯度断层

## 5. 产物清单

- `src/main.js` — 全部实现(单文件,~700 行,含引擎坑位注释)
- `index.html` — 模板结构(仅改 title)
- `validation/` — 最终轮 report.json / probe-results.json / screenshots/ / video.webm / console.json / perf.json
- `debug/` — 调查过程脚本(dbg.mjs~dbg7.mjs)与截图(保留作为调查证据)
- `WORKLOG.md`(本文件)/ `REFERENCE-VERDICT.md` / `ceiling-notes.md`
