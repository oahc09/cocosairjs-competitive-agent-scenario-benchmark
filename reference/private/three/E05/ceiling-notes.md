# E05 — Three.js 引擎能力上限笔记(ceiling-notes)

> 场景定位:Shader / Blend / Postprocess / VisualCeiling 探测。本文记录 Reference 实现实际用到的引擎能力(重点:后处理链)、六维自评,以及即便在 Three 上也存在的实现层缺口——供双引擎对照与路线图使用。

## 1. 用到的引擎能力清单

### 后处理链(本场景正片,Three 的决定性优势)

| Pass | 用途 | 备注 |
|---|---|---|
| `EffectComposer` | HDR 合成管线(默认 HalfFloat RT) | addons 标准件;`composer.setSize` 联动全部 pass |
| `RenderPass` | 场景 → HDR buffer | — |
| `UnrealBloomPass` | 多级 mip 辉光(strength 0.65 / radius 0.38 / threshold 0.72) | "辉光观感"的核心;阈值作用于线性 HDR 亮度 |
| `OutputPass` | ACES Filmic 色调映射 + sRGB 编码 | 读 renderer.toneMapping/Exposure,管线末端统一变换 |
| `FXAAPass` | sRGB 域抗锯齿 | 修光子环/细丝边缘锯齿(composer 链无 MSAA) |
| 自定义 `ShaderPass` | 暗角 + 径向色差 + **事件视界暗核遮罩** | 全自由片元 shader,uniform 每帧注入投影轮廓 |

整链 5 个标准件 + 1 个自定义 pass,零引擎补丁;fps 60(1280×720,RTX 4060)。

### Shader / 材质自由度

- 6 个自定义 `ShaderMaterial`(星云球、星点、吸积盘、透镜弧、光子环、星流拖尾+头部),全部手写 GLSL(value-noise fbm、对数螺旋坐标、极坐标渐变)。
- `AdditiveBlending` + `depthWrite:false` 的发光体叠加,与不透明黑球(写深度)配合实现正确的"暗核遮挡背后盘/星"分层——混合自由度是本场景第二支柱。

### 几何 / 粒子 / 相机

- `RingGeometry`(极坐标扇区参数直接给出透镜弧半环)、`SphereGeometry`(BackSide 天球)、`PlaneGeometry`(公告板光子环)。
- `Points` 自定义 attributes(size/bright/phase/color;星流头部 heat)+ `LineSegments` 逐帧 CPU 更新(320 粒子解析轨迹 + 速度方向拖尾)。
- 公告板:`quaternion.copy(camera.quaternion)`;透视视轮廓半径公式 `R·d/√(d²−R²)` 用于暗核遮罩。
- 相机距离指数平滑(τ=0.12s)满足"1s 内基本到位"。

## 2. 六维自评(0–3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 3 | 黑洞居中、盘面倾角 24°(15–75° 内)、暗核占短边 14.5%、缩放单调改变占比、画面稳定 |
| 材质光影 | 3 | 全程序化;径向梯度像素直测 R-B 3→68→1;多普勒不对称 + 色移;ACES 全链 |
| 动效流畅 | 3 | 60fps;旋转/湍流/星流全部真实时间驱动;缩放 τ=0.12s 平滑;失焦 dt 钳制防跳变 |
| 特效质感 | 3 | UnrealBloom 辉光 + 光子环 + 透镜光弧 + 暗核遮罩锐边 + 星流拖尾;辉光与暗核共存(见 §3 矛盾及解法) |
| 交互反馈 | 2 | 滚轮缩放平滑、reset 即时复位、拖拽微调(加分);但无距离 HUD 反馈/缩放惯性曲线 |
| 整体完成度 | 3 | 6/6 探针、契约全项、UI 契约、录屏、文档;0 console 错误 |
| **合计** | **17/18** | visual = round(17×40/18) = **38/40** |

## 3. 实现层缺口(即便在 Three 上也要工程手段补)

1. **屏幕空间辉光会淹没小暗核**:UnrealBloom 无深度概念,104px 暗核被 360° 亮环的 bloom 淹没(实测中心 luma 185/255)。必须自建 core matte(合成末端按投影轮廓压暗)。通用结论:**辉光强度与暗核尺寸存在结构性冲突,任何引擎的屏幕空间 bloom 都需要类似 matte 手段**。
2. **后处理链无 MSAA**:EffectComposer 渲染到 RT 无多采样,细亮结构(光子环)锯齿,需追加 FXAA/SMAA(近似,非原生 AA)。
3. **无内置体积/引力透镜**:真实光线弯曲需自定义 ray-marching shader(本次以公告板光弧 + 暗核遮罩近似观感,未做背景星弯曲)。上限仍有空间:屏幕空间黑洞透镜 shader(对背景采样做偏折)是明确的下一步。
4. **UnrealBloomPass 阈值只支持线性亮度软膝**,无法按色相/遮罩分区控制辉光(想要"盘辉光强、星辉光弱"只能调全局参数或分层渲染)。
5. **LineSegments 线宽恒 1px**(WebGL 限制),拖尾粗细只能靠亮度/bloom 补偿;更粗的流需改为面片/实例化条带。

## 4. 对 Cocos AIR 侧的对照预期(基于 MASTER-CONTEXT §3 已知事实)

- AIR code-first 路径**无稳定后处理/无 Bloom**:本场景的"辉光观感(必需)"在 AIR 侧只能走替代路径(多层加法光晕片、径向渐变贴片、粒子堆叠)——这正是 brief 特意"不规定实现路径"的原因;预期 AIR Reference 会在此维度显著落后,若观感达不到同档,按 ENGINE_LIMITED 如实记录而非降级场景。
- Shader 自由度:AIR 若具备 ShaderMaterial 等价物(自定义 GLSL),盘梯度/条纹/多普勒可迁移;混合模式(additive)与深度分层为第二道门槛。
- 本笔记不预设 AIR 结论,以 AIR Reference 实测为准。

## 5. 产出索引

- 实现:`src/main.js`(+`index.html` title)
- 终跑验证:`validation/report.json`、`validation/probe-results.json`、`validation/video.webm`、`validation/screenshots/`(27 张)
- 过程记录:`WORKLOG.md`(14 轮迭代史与关键发现)
