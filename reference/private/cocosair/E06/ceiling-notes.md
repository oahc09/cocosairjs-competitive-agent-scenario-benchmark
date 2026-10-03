# ceiling-notes — E06 荒野篝火营地 · Cocos AIR 视觉上限探测

> 场景定位:动态点光真实照明(DynamicLight 域核心)/ 程序化低多边形 / CPU 粒子 / 状态与相机。
> 本文件记录 AIR 在该场景的天花板证据、动态光/阴影的真实表现、与 Three r186 的预期差距。

## 1. 动态点光:实测可用,逐帧可动画(本场景核心探测项)

- **结论:FULL(照明部分)**。`PointLight` 组件真实参与 forward 管线:
  - 光源注册:组件激活 → `renderScene.addPointLight`(render-scene/core/render-scene.ts);
  - 逐模型多 pass:`RenderAdditiveLightQueue.gatherLightPasses` 按 `cullPointLight`(AABB vs range 球)剔除后,
    对每个受影响模型追加 additive 光照 pass,上传 `cc_lightPos`(w=LightType.POINT)、
    `cc_lightColor`(xyz=color,w=luminance×exposure)、`cc_lightSizeRangeAngle`(w=range)UBO
    (src/cocos/rendering/render-additive-light-queue.ts POINT 分支);
  - 逐帧动画验证:`luminance` setter 直接写穿 `_light.luminanceHDR` → 本实现以
    0.43/1.9/4.6 Hz 多频混合驱动 `luminance = fireLightIntensity × 30000`,
    P2 两帧差 0.369(地面/树干亮度随闪烁波动),状态与画面同源。
- **量级经验值**(HDR,相机默认曝光):luminance ~30000 / range 13 / 高度 1.05
  在 ~17m 直径营地上形成"中心暖池 + 树干受光"的舒适照明;46000 时地面近场过曝发白。
- **边界**:1 个点光 = 受影响模型每帧多 1 个 pass(本场景 ~60 个受光模型 → draw call 翻倍,仍 60fps);
  多点光场景 pass 数线性增长,需自查规模。

## 2. 阴影:点光不可用(引擎明示),本场景如实不交付

- 证据:`src/cocos/render-scene/scene/point-light.ts` 类注释 "It doesn't support shadow generation currently."
  (点光在渲染场景抽象层就没有阴影生成路径)。
- spec 明示"不要求投影阴影(阴影为可选加分)" ⇒ 未达成加分项,不构成扣分。
- 替代近似(本实现采用其一):
  - 焦土盘 + 明暗面对比(树干背光面暗)已提供"接地感";
  - 如需假阴影:篝火下方贴一张径向衰减暗色 decal 面片(传统 blob shadow),本实现以焦土盘代替。
- **与 Three 的差距(如实)**:Three r186 的 `PointLight.castShadow` + `PCFSoftShadowMap`
  可让树/柴向背光侧投影,火光闪烁时地面影子同步晃动——这是 AIR 当前管线给不出的动态层次;
  方向光阴影(ShadowMap)在 AIR 有交付路径但质量待考(前序汇总:阴影交付不完整),本场景未使用。

## 3. 后处理:确认不可达(承 E05 三闸门结论)

- 无 Bloom/Tonemap:火焰辉光以 additive 光晕 billboard(exp 径向衰减)+ 火焰 shader 内
  边缘软衰减近似;"亮部向暗部全屏弥散"的空气感弱于 Three UnrealBloom 方案一档。
- 无 FXAA:火焰边缘为高对比 additive,软衰减设计下锯齿可接受。
- 夜空暗部以 hash 抖动去色带(8bit 输出的补偿手段)。

## 4. 程序化几何与天空:实测 FULL

- 低多边形地形:非索引三角形 + 逐面法线(flat shading)经 `utils.createMesh` 直接可用
  (indices 可省,triangle list 顶点直出);高度函数与摆放共用保证落地。
- primitives 全套可用(box/cone/cylinder/plane/quad(XY)/sphere/torus/circle(XY,TRIANGLE_FAN))。
- 天穹:自定义 effect 大球内面(cull off,depthWrite false),片元完成
  日夜渐变 + **八面体映射星点网格**(3×3 邻域,twinkle)+ fbm 银河带 + 月亮/太阳盘 + 晨昏暖带,
  单 draw call 覆盖全部天空需求——AIR 的可编程着色自由度对该类需求无约束。

## 5. 粒子:无内建 3D 粒子系统,CPU 动态网格替代(承 E05)

- `createDynamicMesh` + `updateSubMesh`:124 个四边形(火苗 32 / 火星 60 / 萤火虫 20 / 烟 12)
  合一网格单 draw call,每帧 ~11KB 顶点写放,60fps 无压力。
- 软圆衰减需自带 uv 通道(a_texCoord RG32F)——引擎粒子格式不可复用(不存在),全手写。

## 6. 其他引擎缺口(本场景实测)

| 缺口 | 影响 | 规避 |
|---|---|---|
| `Quaternion` 导出名不存在 | 轴角旋转初版崩溃 ×2 轮 | 用 `Quat.fromAxisAngle(out, axis, rad)`(静态方法风格) |
| `camera.clearColor`/`light.color` 原地改不生效 | 日夜颜色插值失灵 | 必须赋值(setter 内部 set+下推) |
| 点光无阴影 | 见 §2 | 如实不交付 |
| 无 OrbitControls | 环绕相机手写 | 球坐标 + 每帧 lookAt(~30 行) |
| 夜景默认过暗(ambient 量级手感) | 初版近黑不可辨 | skyIllum 夜 ~3800 + 月光 ~1900 lux |

## 7. 性能上限

- draw calls:~66 个受光模型 ×(基础 pass + 点光 pass)+ 天穹/火焰×2/光晕/粒子 ≈ 140;
  1280×720 headless Chromium:**60.1 fps**(RTX 4060 Laptop / D3D11 ANGLE)。
  瓶颈在火焰/天穹片元噪声,均有 3× 余量;scale-up(更多树/粒子)空间充足。

## 8. 六维自评汇总(与 REFERENCE-VERDICT 一致)

构图取景 2.5 / 材质光影 3 / 动效流畅 3 / 特效质感 2.5 / 交互反馈 2.5 / 整体完成度 3
= 16.5/18 → visual 37/40;客观 59.5/60;**总分 96.5/100,verdict FEASIBLE**。
本场景的实验答案:**AIR 的动态点光照明链路完整可用(逐帧强度/颜色/位置动画均生效),
天花板在点光阴影缺席与管线级后处理缺席,而非光照本身的可编程性。**
