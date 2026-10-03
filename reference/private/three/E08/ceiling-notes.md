# ceiling-notes — E08 深海鱼群(Three.js r186 Reference)

供 Engine Ceiling 标定与 AIR 侧对照。六维自评为 Reference 实现者的诚实评估(0–3),
代表"熟练实现者在合理工作量内达到的水位",非盲评分。

## 六维自评

| 维度 | 自评 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 满幅水域、鱼群居中、海床/海草前景 + 光束顶光分层;但相机为近静止机位(微漂移),无运镜叙事;喂食时鱼团略偏高。 |
| 材质光影 | 2.0 | 标准材质 + ACES + 半球/方向光 + FogExp2 深度衰减,鱼体银青个体色差异;但无环境贴图(金属感受限)、鱼无贴图细节(纯程序化色),阴影未开(水下弥散可辩护)。 |
| 动效流畅 | 2.5 | 60fps;逐实例摆尾行波 + 转弯侧倾 + 速度自适应摆频;惊散炸开/重聚回漩动态可辨识(P3 regionChange diff 0.14、P2 motion diff 0.23)。 |
| 特效质感 | 2.0 | 加色光束 ×6(摆动呼吸)、水面焦散滚动 ×2、520 悬浮颗粒(近大远小)、食物辉光 + 点光闪烁、CSS 暗角;未用后处理(无 Bloom/景深)——头部发光体是主要质感损失点。 |
| 交互反馈 | 2.5 | 指针接近即惊散(距离驱动)、单击投喂、指针水域微光、HUD 实时模式/内聚条/食物距离、reset 按钮与 R 键;无涟漪扩散等更强反馈。 |
| 整体完成度 | 2.5 | 合同全项达成(8/8、60fps、无错误、reset/长稳);代码单文件可读;但无音景、无多样性(单一种群)。 |

合计 ≈ 14/18 → `visual ≈ round(14×40/18) = 31`。
S1 15/15、S2 30/30(8 探针 + 10 行为项)、S3 10/10(fps 达标、lifecycle 探针 PASS、120s 内无泄漏迹象)、S4 估 4–5。

## 能力清单(本场景实际调用的 Three.js 能力)

1. **InstancedMesh** 单 draw call ×110 + `instanceMatrix` 每帧更新(DynamicDrawUsage)+ `setColorAt` 实例色。
2. **顶点着色器注入**(`Material.onBeforeCompile`):实例属性 `InstancedBufferAttribute` ×2 + 行波变形——程序化鱼体的核心,无需蒙皮/骨骼。
3. **几何程序化**:LatheGeometry 车削剖面、ConeGeometry 压扁变形、`mergeGeometries`(addons)拼合。
4. **Points 粒子**:sizeAttenuation + canvas 径向渐变贴图 + AdditiveBlending,520 粒 CPU 缓漂(近大远小纵深)。
5. **Raycaster.ray ∩ Plane**:屏幕指针 → 世界坐标(惊散距离判定与投喂定位的公共基础)。
6. **氛围栈**:CanvasTexture 渐变背景、FogExp2、HemisphereLight+DirectionalLight、PointLight(食物)、Sprite 辉光、ACESFilmicToneMapping。
7. **状态契约**:window.__bench.getState/reset,种子化 RNG 保证 reset 复现初始分布。

## 缺口与未用能力(诚实声明)

- **后处理未用**(EffectComposer/Bloom 可得):食物辉光与光束本可更佳;权衡 SwiftShader 无头渲染的稳定性与复杂度后放弃。这是"水位选择",不是引擎缺口。
- **无阴影、无环境贴图、无粒子 GPU 化**(520 粒 CPU 更新已足;上万粒应转 shader 驱动)。
- **摆尾不修正法线**:弯曲只位移顶点,尾部光照未随之摆动(帧率优先;视觉影响微小)。
- **鱼体无贴图/无 LOD**:110 条 O(n²) 邻域在 ~6k 对/帧量级,未触发空间网格需求;扩到 500+ 才需要。

## 给 AIR 侧(ceiling 对照)的技术要点

1. 本场景的能力门槛是:实例化渲染 + 逐实例变形(着色器级)+ 指针拾取到世界坐标 + 加色混合粒子 + 雾。AIR 若缺"实例属性 + 材质着色器注入"等价物,程序化摆尾需退化为 CPU 变形或骨骼蒙皮(成本上升)。
2. 探针时序陷阱与引擎无关:harness 采样时刻 ≈ waitMs + 每探针 1–4s 开销;动态状态存活期(食物超时、惊散持续)必须按最慢采样路径设计(本实现:食物 16s)。
3. 惊散/趋食是同一指针的两种语义(移动=威胁,单击=投喂):必须在行为层显式消歧(本实现"进食压过恐惧"),否则 P5/P6 不可同时满足。
