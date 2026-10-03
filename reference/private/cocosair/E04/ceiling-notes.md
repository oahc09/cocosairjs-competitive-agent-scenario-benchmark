# Ceiling Notes — E04 城市烟花夜 · Cocos AIR Engine Ceiling

- runId:`REF-E04-cocosair` · 2026-10-02 · verdict FEASIBLE(8/8,fps 60.3)
- 用途:为 E04 的 Agent Attainment 计算与 COCOSAIRJS 路线图提供引擎能力边界证据。全部结论来自本 Reference 的实测,非文档推断。

## 1. 本场景实证的能力清单(✅ = E04 实测通过)

### 1.1 核心图形路径

| 能力 | 实证方式 | 结论 |
|---|---|---|
| Code-first 应用引导 | `createAirApp({canvas})` → Scene/Node 组件树 | ✅ 293 ms ready |
| 正交相机 2.5D | `Camera.ProjectionType.ORTHO` + `orthoHeight` | ✅ 世界-像素 1:10 精确映射,点击坐标零换算误差 |
| 静态程序化几何 | `utils.createMesh({positions,uvs,colors,indices,minPos,maxPos})` | ✅ 楼群/窗/星三张静态 mesh,每张单 draw call |
| **动态网格粒子(无 3D 粒子系统的替代路径)** | `utils.MeshUtils.createDynamicMesh` + 每帧 `updateSubMesh(0,{positions,uvs,colors})` | ✅ **单 draw call 2600 quad 池,60 fps**;E05 结论在本场景复现并加强 |
| 自定义 shader(effect) | 编译后形态 EffectAsset JSON(内联 techniques/passes/blendState/priority/UBO statistics)+ glsl4/glsl3 双变体,`onLoaded()` 注册 | ✅ 4 个自定义 effect 全部稳定运行 |
| Additive 混合与绘制排序 | pass `blendState`(ONE/ONE)+ `priority`(0/8/128/130)+ 关深度测试 | ✅ 5 层 painter's order 无闪烁 |
| 逐顶点色 / per-draw uniform | `a_color` 属性(format 44)+ `setProperty('u_time',…)` | ✅ 亮度/闪烁全 CPU 侧驱动 |

### 1.2 交互 / 状态 / 生命周期

| 能力 | 实证方式 | 结论 |
|---|---|---|
| Canvas 点击输入 | canvas DOM `pointerdown`(目标相位);`input.on(TOUCH_*)` 为等效路径 | ✅ 归一化坐标→世界坐标,楼体命中排除 |
| DOM UI 覆盖层与画布事件互不吞没 | UI 按钮 DOM 在 canvas 外 + data-ui 契约 | ✅ P5/P6/P7/P8 的 `click:ui=*` 全通过 |
| 真暂停冻结(渲染继续、模拟全停) | `Component.update` 提前返回 + u_time 停推进 + GPU buffer 停更新 | ✅ P7 两帧像素差≈0(阈值内) |
| clamped 时间步(失焦防跳变) | `min(dt, 0.05)` 单时钟源 | ✅ 全程无瞬移/爆量 |
| 运行时几何重建(reset) | 销毁旧 mesh → `createMesh` 重建城市 | ✅ buildingCount 29→26 重随机,无泄漏无异常 |
| 帧钩子/就绪信号 | `Director.EVENT_AFTER_DRAW` | ✅ 首帧置 `__appReady` |

## 2. 缺口(引擎做不到 / 只能绕行)——重点:无 3D 粒子系统的影响

### 2.1 无 3D 粒子系统(本场景最大结构性缺口)

引擎只有 2D 粒子(docs/notes/particle-2d-notes.md),无 GPU 粒子/Points/Compute 路径。影响与实测结论:

1. **CPU 全量积分成为唯一选择**:位置/速度/颜色/尺寸每帧 CPU 计算并整块上传顶点缓冲。E04 实测 2600 粒子(含积分+写放+上传)在 60 fps 内完成,余量约 2 倍于合同峰值 1000——**在该量级下不构成性能墙**;但对比 Three.js(`THREE.Points` + 自定义 ShaderMaterial,GPU 侧插值,同屏数万点仍轻)是明确的规模上限差距。推算 CPU 路径在 ~5k–8k 粒子后开始挤压帧预算(未实测,保守陈述)。
2. **无 point-sprite 原生支持** → 每粒子 4 顶点 6 索引的 quad 展开,CPU 端三角化;顶点带宽 4× 放大。
3. **无 GPU 侧生命周期/发射器语义** → spawn/回收/池管理全部手写(本实现 ~120 行基础设施,Agent 的隐性工作量)。
4. **正面结论**:动态网格路径是稳定的通用替代——E05(星尘)+ E04(烟花)两个独立场景验证了"单 draw call、任意混合模式、逐顶点全属性"的可行性,可作为路线图推荐的官方模式(建议引擎侧封装 `DynamicQuadBatch` 组件)。

### 2.2 无后处理(无 Bloom)——特效质感的实际上限

- 默认 Code First 路径无 Bloom/Glow 后处理(post-process-notes.md 结论)。烟花"峰值照亮夜空/云层受光"的溢光效果不可达。
- 绕行(本实现):shader 内双层径向衰减(core+halo)+ additive 叠加 + 爆心大尺寸闪光面片。远端视觉抽检认可"soft falloff, no blockiness",但**辉光只存在于粒子自身包围盒内**,无法溢出到周围像素——这是与 Three(EffectComposer UnrealBloom)的可感知质感差,六维自评中"材质光影/特效质感"各扣 0.5 的主因。

### 2.3 自定义 effect 的作者体验(可行性但高门槛)

- 必须手写编译后形态 JSON:UBO statistics(`CC_EFFECT_USED_VERTEX_UNIFORM_VECTORS` 等)、builtins globals/locals 绑定、attribute format/location 码表(format 32=RGB32F、21=UV、44=RGBA32F)。**无 EffectCompiler/DSL 可用**,等于要求实现者理解引擎 shader 反射内幕——K0/K1 知识级 Agent 在此的失败概率高(API_HALLUCINATION 风险集中点)。
- 注册时机约束(GAP-B1:必须在 createAirApp 后)无报错提示,早注册=静默无效。

### 2.4 其他观察

- 无 Points/无 instancing 暴露(InstancedBuffer 未在公共 API)→ 动态网格是唯一大批量路径。
- 相机 `visibility` 默认 undefined 必须显式赋值,否则静默黑屏。
- 无全局 timeScale 可冻结 shader 时间 → 暂停语义需自建模拟时钟并手动喂 uniform(本实现单时钟源方案可复用)。
- 2D 粒子系统(particle-2d)未用于本场景:其模拟语义(发射器/生命周期)可覆盖部分需求,但 blend/排序/与自定义 mesh 场景混排的控制力不足,未采用——不影响结论,仅记录取舍。

## 3. 对 Agent Attainment 的含义

- Reference FEASIBLE → E04 可作分母。
- 预期 Agent 主要失败面(按概率排序):①effect JSON 手写错误(API_HALLUCINATION/BUILD);②createDynamicMesh 空数组陷阱(SHADER/RENDERING 错乱);③P4 余烬寿命 spec 内在矛盾(见 REFERENCE-VERDICT §5,属 spec 张力非引擎差异);④camera.visibility 黑屏(RENDERING)。
- 引擎侧改进优先级建议(入路线图):①封装动态 quad 批渲染组件;②简化自定义 effect 入口(运行时编译或 DSL);③补 Bloom 后处理;④相机 visibility 默认值修复。
