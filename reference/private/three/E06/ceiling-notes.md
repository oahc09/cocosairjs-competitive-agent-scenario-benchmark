# E06 — Three.js 引擎能力上限笔记(ceiling-notes)

> 场景定位:Procedural / Particles / DynamicLight / State / Camera 探测。本文记录 Reference 实现实际用到的引擎能力、六维自评与能力清单,以及即便在 Three 上也存在的实现层缺口——供双引擎对照与路线图使用。

## 1. 用到的引擎能力清单

### 动态光照(本场景正片:DynamicLight 探测的核心)

| 能力 | 用途 | 备注 |
|---|---|---|
| `PointLight`(decay=2 物理衰减) | 火光:强度 (36+170·flicker)·日间衰减,distance 46 | 真实照亮地面/树干,P2 帧差 0.47 的物理来源;闪烁与 `fireLightIntensity` 状态同源 |
| `HemisphereLight` | 天光/地光双色,夜↔日插值 | 夜 #31427a×0.62 → 日 #bcd9f5×1.5 |
| `DirectionalLight` | 同一盏灯换角色:夜月光(冷蓝 0.7)↔ 日太阳(暖白 2.6),仰角 38°→56° | 避免双灯切换跳变 |
| 线性 `Fog` | 深度层次;颜色逐帧=天穹地平线色 | 地形边缘与天空无缝衔接 |

### Shader / 材质自由度(6 个自定义 ShaderMaterial)

- **天穹渐变**:BackSide 球面,指数地平线带 `mix(uTop,uHor,exp(-h·16))`——解决俯角相机下"日天空灰白"的关键(见 §4 缺口 1 的反例教训)。
- **火焰面片**:顶点摆动(sin 叠加 × pinch²,火苗尖甩动)+ 片元 fbm 双倍频噪声 + 白黄→橙→红四段梯度,AdditiveBlending + DoubleSide。
- **地面暖光斑**:径向 pow 渐变加法面片,与点光同一 flicker 驱动。
- **世界尺寸点精灵**(3 个粒子系统共用):`gl_PointSize = aSize·uScale/-mv.z`,uScale=缓冲高/(2·tan(fov/2)),resize 时统一注入;径向软圆片元 + 双色插值 + 加法混合。
- **星空点**:屏幕空间尺寸(不随距离衰减)+ 相位闪烁 + uNight 淡出。

### 粒子 / 程序化

- 3 套 CPU 粒子(44 火苗 + 64 火星 + 18 萤火虫):`BufferAttribute.setUsage(DynamicDrawUsage)` 逐帧写 position/aSize/aAlpha/aMix;`frustumCulled=false` 防包围球过期剔除。
- 程序化几何:PlaneGeometry 顶点位移地形(共享 terrainHeight 事实源)+ 顶点色;CylinderGeometry 四元数定向交叉柴堆;ConeGeometry 多层树冠;DodecahedronGeometry 石块。
- **运行时纹理生成**:月亮 Sprite 的径向渐变用 Canvas2D 生成 `CanvasTexture`(colorSpace=SRGB),零外部资产满足 asset 契约。
- mulberry32 确定性随机:布局可复现,reset 同种子重放,reset 语义确定。

### 后处理 / 时钟

- `EffectComposer` → `RenderPass` → `UnrealBloomPass`(0.55/0.7/0.85)→ `OutputPass`(ACES + sRGB):火焰/火星/萤火虫/星星/月亮统一辉光,日天空(线性亮度 ~0.4)低于阈值不受染。
- `Timer`(r186 已并入核心,`import { Timer } from 'three'`;addons 下已无 Timer.js)+ `connect(document)`(Page Visibility 大 delta 防护)+ 手动 dt 钳 0.1s → 失焦再聚焦无跳变、无崩溃。

## 2. 六维自评(0–3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 3 | 篝火居中偏下焦点,俯角 ~21° 环视,树环构成前中景轮廓(视线越树冠顶,偶发遮蔽制造纵深),暖池为唯一视觉锚点 |
| 材质光影 | 3 | 低多边形平直着色 + 顶点色;物理点光真实照明(P2 帧差 0.47);夜冷暖对比/日全场景变亮 9.3x;ACES 全链 |
| 动效流畅 | 3 | 60fps;全部真实时间驱动(Timer);3.2s smootherstep 日夜渐变;失焦 dt 钳制;环绕连续无跳变 |
| 特效质感 | 2 | 火苗 = 面片 + 44 粒子 + bloom,闪烁四系统同步;但火焰非体积方案(面片交叉近似),火星偏小,无烟;月亮/星空/萤火虫达预期但单点规模克制 |
| 交互反馈 | 2 | 三按钮即时生效 + 标签状态(夜/昼、开/关);reset 全语义;但未做拖拽微调视角(可选项),无悬停以外的渐进反馈 |
| 整体完成度 | 3 | 6/6 探针、契约全项、UI 契约、录屏、文档;0 console 错误;余量最低 6.4x |
| **合计** | **16/18** | visual = round(16×40/18) = **36/40** |

## 3. 实现层缺口(即便在 Three 上也要工程手段补)

1. **俯角相机的天空渐变陷阱**:相机下俯时画面内天空只在地平线 ±7° 内,常规"顶色→地平线"pow 渐变会让整个可见天空呈地平线色(E06 实测日天空 RGB 近灰白 (215,216,217))。必须用指数地平线带让顶色在数度内接管。通用结论:**天空观感必须按实际相机仰角范围设计渐变曲线,不能照搬"标准天空 shader"**。
2. **火焰无体积方案**:shader 面片 + 粒子在多角度下经得起环绕(交叉面片 + 双倍频噪声),但近景侧面看仍偏"纸片感";真体积需 raymarching(成本高)或多层 billboard 洞察(未做)。
3. **未开阴影**:PointLight 阴影 = 立方体 6 面渲染,headless SwiftShader 下 fps 风险大;brief 明示"不要求投影阴影",主动放弃(brief 加分项)。注:r186 已移除 PCFSoftShadowMap,如需为 PCFShadowMap。
4. **世界尺寸点精灵的固有限制**:gl_PointSize 硬件上限(钳 90px)+ 无法逐粒子旋转(gl_PointCoord 无旋转)+ 近相机裁剪;更复杂的火星(拉丝/旋转)需换 InstancedMesh 面片。
5. **UnrealBloom 全局阈值**:无法按对象/色相分区控制辉光;阈值 0.85 是"日天空不泛光 vs 火焰足够出光"的折中,调亮日天空时需回头复核。
6. **萤火虫白天只淡出不停止更新**:计数恒定是 spec 要求,但日间 18 个粒子仍在逐帧积分(GPU 也在画)——量级小无性能问题,却是"视觉淡出≠逻辑休眠"的一个实例。

## 4. 对 Cocos AIR 侧的对照预期(基于 MASTER-CONTEXT §3 已知事实)

- **动态点光 + 物理衰减**:E06 的核心是"火光真实照亮地面与树干"(P2 像素差断言)。AIR 若 PointLight 等价物可用且响应稳定,此维度可平;若强度/衰减/颜色插值有缺口,P2 会直接失败(画面静止=NC 级作弊判定风险)。
- **自定义粒子系统**:44+64+18+900 四套 Points 依赖自定义顶点 attributes + 逐帧 CPU 写入 + 加法混合点精灵。AIR 若无 Points 等价物,需走 instanced 面片/精灵批,数量级(≥40 火星同屏)应可行,观感(软圆+加法)取决于纹理/混合能力。
- **天空/渐变/雾联动**:纯 ShaderMaterial 与 Fog 插值,AIR 有自定义 shader 时可迁移;指数地平线带的教训(§3.1)同样适用。
- **后处理**:本场景 bloom 非必需(火苗本体已 additive 提亮),AIR 无 Bloom 时观感降档但探针不依赖——brief 特意让"辉光观感"不在必需项里。
- 本笔记不预设 AIR 结论,以 AIR Reference 实测为准。

## 5. 产出索引

- 实现:`src/`(main/sky/terrain/forest/campfire/fireflies/glow-points/rng)+ `index.html`(title)
- 终跑验证:`validation/report.json`、`validation/probe-results.json`、`validation/video.webm`(3.1MB)、`validation/screenshots/`(26 张)
- 过程记录:`WORKLOG.md`(4 轮迭代史与关键发现)
