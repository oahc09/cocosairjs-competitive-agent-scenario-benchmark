# ceiling-notes — E01 · Cocos AIR Engine Ceiling 自评

> Reference 实现者对 Cocos AIR 1.0.0 在 E01(程序化星系巡航)域的能力上界评估。
> 六维自评针对本 Reference 交付质量(0-3 分);引擎能力清单/缺口针对引擎本身。

## 1. 六维自评(0-3)

| 维度 | 分 | 理由 |
|---|---|---|
| 构图取景 | 2 | 盘面亮区 ≈66% 画宽(目标 60-75%),法线夹角 52°(目标 30-60°),亮核质心 (0.49,0.55) 基本居中,HUD 角落不遮主体;扣分:旋臂亮度不对称(右臂偏强)、相机方位固定无缓慢环绕,构图略静。 |
| 材质光影 | 2 | 自写 GLSL 材质:半径三段颜色梯度实测成立(核心 [163,156,147] 暖白 → 外缘 [96,106,135] 冷蓝,B>R)、三档亮暗层级、每星 twinkle;扣分:引擎无 HDR 输出/tonemapping/曝光链,additive 累积直接截断在 255,核球高光层次有限。 |
| 动效流畅 | 3 | 60.2fps 锁定(探针含交互态);全部平滑为帧率无关指数形式(视差 τ=200ms、距离 τ=550ms、reset 恢复 τ=180ms);双采样探针证实动作后持续变化、无瞬跳。 |
| 特效质感 | 2 | 高斯软核点辉光 + 1,500 星云大光点 + 12,000 远景球壳纵深 + twinkle;扣分:无 Bloom/屏幕空间辉光(ENGINE_LIMITED),辉光为逐点近似的叠加上限,星点密集区过曝为平白。 |
| 交互反馈 | 3 | 指针视差(满偏 ≈8° 方位摆动,画面偏移 <10%)、滚轮穿行(±72 单位/格,近距放大变疏/远距收拢可感)、Reset(快速平滑恢复 + epoch 计数);HUD 实时数字与 __bench 状态同源一致。 |
| 整体完成度 | 3 | spec 合同全项达成:74,500 真实星点、7/7 探针、0 console 错误、reset 可重复、__appReady 383ms、video 留档;红线无违反(状态全真、spec 未改、产物仅写工作区)。 |

**合计:15/18 → visual = round(15 × 40 / 18) = 33 / 40**

## 2. 引擎能力清单(E01 域,全部实测验证)

| 能力 | 状态 | 路径(以 examples 为准) |
|---|---|---|
| 自定义 GLSL Effect(glsl4/3/1 三变体) | ✓ 可用 | `EffectAsset.onLoaded()`(须在 createAirApp 后)+ `Material.initialize({effectAsset})`;链路同 examples/shader-custom-gradient |
| 自定义顶点属性 | ✓ 可用 | `IGeometry.customAttributes: [{attr: new gfx.Attribute(name, format), values}]`,按名称绑定(webgl2-commands getAttribLocation by name) |
| 大规模点云(POINT_LIST) | ✓ 可用(需双补丁) | 74,500 点 / 2 draw call / 60fps;需同时修 mesh.struct 与 pass.primitive(见缺口 G1/G2) |
| gl_PointSize / gl_PointCoord | ✓ 可用 | ANGLE 点尺寸范围 [1,1024];gl_Position.w 可作视距(透视) |
| additive 混合 pass 状态 | ✓ 可用 | pass JSON `blendState.targets[0] = {blend:true, blendSrc:1, blendDst:1, ...}` |
| 每帧相机位姿 | ✓ 可用 | `Node.lookAt(origin)` + setPosition,Component.update(dt) 驱动 |
| 帧事件/时间 | ✓ 可用 | `director.on(Director.EVENT_AFTER_DRAW)`(fps 口径)、update(dt)(后台节流恢复正确) |
| DOM HUD 覆盖层 | ✓ 可用 | 画布外 DOM 挂 data-ui;与引擎输入无冲突 |
| 指针/滚轮输入 | ✓ 可用(需捕获) | window 捕获阶段监听(见缺口 G5) |

## 3. 引擎缺口(具体可复现)

- **G1 · createMesh POINT_LIST falsy-zero(正确性级,静默)**
  位置:`src/cocos/3d/misc/create-mesh.ts`(IGeometry 分支)`primitiveMode: geometry.primitiveMode || PrimitiveMode.TRIANGLE_LIST`
  复现:`utils.createMesh({ positions:[0,0,0], primitiveMode: gfx.PrimitiveMode.POINT_LIST }).struct.primitives[0].primitiveMode` 返回 `7`(TRIANGLE_LIST)而非 `0`。
  后果:点云意图被静默画成垃圾三角形(additive 下全屏过曝;本 Reference 首轮 P2 即此症状)。
  绕行:createMesh 后立即 `mesh.struct.primitives[*].primitiveMode = POINT_LIST`(RenderingSubMesh 惰性创建于首次访问 renderingSubMeshes,公开 API 路径可达)。

- **G2 · draw 图元取自 Pass 而非 Mesh(无文档)**
  位置:`src/cocos/render-scene/core/pass.ts` `_primitive` 默认 TRIANGLE_LIST;PSO 组装用 `pass.primitive`(src/cocos/rendering/pipeline-state-manager.ts:55)。
  复现:仅修 mesh.struct(G1 绕行)仍按三角形绘制;effect JSON 的 pass 增加 `"primitive": 0` 后才按点绘制。
  后果:mesh 侧 primitiveMode 与实际 draw 不一致,两条路径割裂且均无文档。

- **G3 · 顶点阶段 UBO 读取漂移(正确性级,现象确凿/根因未定位)**
  现象:自定义 Constants 块与 CCGlobal 在顶点着色器读到随顶点变化的"uniform"值;CCCamera/CCLocal 顶点阶段正常。
  复现:顶点着色器 `v_dbg = vec2(pxScale/1000.0, cc_screenSize.y/1000.0)` 经片元输出成像:不同星点呈 27~232 离散值簇(恒定 uniform 应全场一致)。
  绕行:点尺寸零 uniform(构建期烘焙 pxScale 进 a_star.x,视距用 gl_Position.w);resize 重建 mesh(本场景视口固定,罕见路径)。

- **G4 · 无后处理(EffectComposer/Bloom 缺失)**
  Code First 路径无可稳定使用的后处理;星系辉光只能以 additive 点精灵近似(ENGINE_LIMITED,spec 允许)。对视觉上限的实质影响:密集区过曝平白、无屏幕空间泛光/tonemapping。

- **G5 · canvas 层吞 wheel 事件**
  复现:window 冒泡 `addEventListener('wheel', h, {passive:true})` 不触发;canvas-bubble 处观察 `defaultPrevented=true`;同 handler `{capture:true}` 正常收到。
  绕行:捕获阶段监听(交互类场景通用防御)。

- **G6 · 无 Points/InstancedMesh 一等公民 API(门槛差)**
  Three.js 对照:`THREE.Points + BufferGeometry.setAttribute + PointsMaterial` 两步即成;Cocos AIR 需 EffectAsset JSON(shaders/blocks/builtins 反射)+ 三变体 GLSL + customAttributes + G1/G2 双补丁。规模上限本身不差(74.5k 点 60fps,单 draw call),是**易用性/文档缺口**而非能力缺口。

## 4. 对 Agent Run 的预期校准(供对照实验解读)

- E01 在 Cocos AIR 上 Engine Ceiling = FEASIBLE:50k+ 点、30fps+、全套交互与状态合同在原生路径可全量达成。
- Agent 若失败,最可能栽在 G1/G2(症状:全屏过曝或静止三角噪点 — 易被误判为"着色器写错")与 G5(滚轮无响应 — 易被误判为"事件词表不符")。这两个坑的可见症状与真实根因距离远,是 Engine-Attainment 分离度的主要来源。
- G3 属于"引擎行为与常识偏差"型:顶点阶段 uniform 不可靠会逼迫 Agent 改架构(烘焙/重建),增加试错轮次但不封顶。
