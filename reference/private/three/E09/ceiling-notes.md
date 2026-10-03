# Ceiling Notes — E09 珠宝展示台 · Three.js r186 Material Ceiling 实录

> 重点:transmission / dispersion / envMap 材质链在 r186 的**真实表现**、达成广告级
> 观感的工程决策、以及仍存的缺口。供 Engine Ceiling 判定与 Cocos AIR 对照读。

## 1. 材质链真实表现(核心记录)

### 1.1 MeshPhysicalMaterial 透射/折射(transmission)

- **机制**:r186 的 transmission 走「transmission render target」回采——每帧先把
  不透明物体渲染到一张屏幕空间纹理,透射面按折射后的屏幕 UV 采样该纹理,再叠加
  thickness/ior 决定的偏移与模糊(按 roughness 采 mip)。
- **实测观感**:
  - 透过宝石能看见**倒置/位移的背景内容物**——本实现中亭部可见折射变形后的
    转台金点与金环(截图 P4 特写清晰可辨),冠部可见折射的背景光幕。
  - `thickness:1.15 + ior:2.2` 的组合变形量合适;thickness 过大(试过 1.5)会
    采样到远处暗区,宝石发闷;过小则接近平面玻璃感。
  - **性能**:RTX 4060 + 1280×720 稳 60fps;transmission 每帧多一次场景渲染 +
  色散三次采样,成本可控。SwiftShader 软渲染下预期显著掉帧(未在本机验证,
  harness launch-config 走 D3D11 ANGLE)。
- **注意**:transmission 看的是**屏幕空间**内容——宝石背后必须有可见几何/亮部,
  否则透射体就是黑的。这是 R1 剪影问题的根因之一,也是「发光幕」存在的理由。

### 1.2 色散(dispersion,r164+ 参数)

- **机制**:transmission 采样时对 R/G/B 三通道用不同 ior 偏移,亮暗边缘出现
  彩虹条纹。**只在 transmission>0 时生效**,是「火彩」的直接实现。
- **实测观感**:
  - 静帧下色散是**克制的**:0.62 强度下,折射亮边(金点、光幕边界)有可辨的
  彩虹镶边,但不夸张——符合真实宝石而非棱镜演示。
  - 转台旋转时火彩随切面扫动流动(P2/P7 的 motion 断言即来自高光与火彩的流动)。
  - **色散可见度的前提是对比度**:R2-R4 轮在柔和 LDR 环境下色散几乎不可见,
    HDR 闪点进入切面后棱边条纹才显出来。调参顺序应为:先对比度,后色散强度。
- **局限**:色散只作用于透射通道;镜面反射高光不色散。真实钻石的火彩相当一部分
  来自反射色散,three 单参数做不到 → 本实现用 HDR 多点环境 + bloom 溢光补足
  「闪」的观感。

### 1.3 环境贴图(envMap / PMREM)

- **两条链**(本实现的关键决策):
  1. `scene.environment` = **HDR 小场景 PMREM**(`PMREMGenerator.fromScene`,
     MeshBasicMaterial 颜色分量直接给 >1,峰值 25):暗房 + 8 组发光柔光箱平面。
     HDR 是珠宝闪感的**决定性因素**——LDR 环境全场景上限 1.0,切面反射再亮也
     只能到灰白,ACES 没有可滚降的超亮输入;HDR 点源反射经色调映射成为**白针尖**。
  2. `scene.background` = 暗化 LDR equirect 画布:摄影棚氛围,不抢主体。
- **环境形状即布光语言**:硬边矩形柔光箱 → 切面「要么整面亮要么整面暗」的
  镜面跳跃;小点灯 → 针尖闪点;长条灯 → 边缘勾线。R2 的柔和径向渐变环境让
  每个切面都反射一片灰渐变,即是「奶白/蜡感」的直接原因。
- 房底色(环境球本色)控制「基础亮度」:0.012 过暗(远景宝石成剪影),
  0.055 后远景仍读出亮晶体。

### 1.4 双层宝石(透射壳 + 内金属核)

- 透射壳(78 面宝石本体)+ 42% 缩放同形**金属核心**(metalness 1, flatShading):
  内核的镜面切面反光透过折射外壳被看见并再次折射 → 「内部切面光影」。
  这是对 three 单层 transmission 无多次内反射的**廉价补足**,成本一个 draw call。

### 1.5 微 bloom(EffectComposer + UnrealBloomPass)

- 阈值 1.0(线性 HDR 域):只有超过白点的输入(切面针尖闪点、金边镜面)溢光,
  暗场与中等亮度不被糊化;strength 0.35 保持克制。OutputPass 统一做 ACES + sRGB,
  与直渲观感一致,仅给超亮源加 1-2px 光晕。
- 导出链同步换 `composer.render()`(导出像素 = 当前合成画面)。

## 2. 六维自评(0-3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 宝石居中主体、暗场留白、展台/地面/光幕层次完整;仰角与透视经过调整;但机位变化仅两档,未做构图式运镜 |
| 材质光影 | 3 | transmission 折射(倒置内容可辨)+ dispersion 火彩 + HDR 环境闪点 + 三点布光层次 + ACES;材质链完整达成 Brief §2 全部观感要求 |
| 动效流畅 | 3 | 全程 60fps(含双击过渡与导出瞬间);950ms easeInOutCubic 推拉无跳变;转台 32°/s 高光/火彩流动连续 |
| 特效质感 | 2.5 | 阈值化 bloom + 假焦散光池 + 浮尘微粒 + 接触阴影,广告氛围成立;无真正的焦散/多次内反射/各向异性高光 |
| 交互反馈 | 2.5 | 色板即点即变(材质+光池+UI 三处同步)、双击推拉、导出 toast、拖拽环绕;缺少 hover 微高亮宝石、无镜头惯性回正等细节 |
| 整体完成度 | 3 | 8/8 探针、导出/重置/色板/推拉全部按合同工作,UI 克制精致,无调试残留 |
| 合计 | 16.5/18 | visual = round(16.5 × 40 / 18) = **37** |

## 3. 缺口与如实声明(Gap)

1. **反射通道无色散**: dispersion 只作用于透射采样;镜面反射高光不产生彩虹。
   真实钻石火彩约半数来自反射色散 → 需自定义 ShaderMaterial/TSL 才能补,
   本 Reference 未做。
2. **单次折射近似**: transmission 是单表面折射 + 屏幕空间回采,无多次内反射、
   无真实焦散(地面光池是 Additive 假焦散)。物理正确性与 Blender/Cycles 级
   path tracing 有差距,观感靠 HDR 对比 + 双层宝石近似。
3. **转台硬旋转**: 自转恒速 32°/s,无启动惯性/变速编排(广告片常见缓入缓出)。
4. **D3D info-log warning**: 1 条 X4122 精度提示(transmission/dispersion 着色器
   编译期,驱动级,非错误)。harness 只计 error/uncaught,不影响判定。
5. **导出为主循环同帧渲染**: `composer.render()` + `toBlob` 同任务内完成,实测
   导出瞬间无掉帧(60fps 曲线平稳);但严格说 toBlob 编码在工作线程,主循环
   未冻结,符合「≤200ms」合同。
6. **远景 vs 特写不可兼得的亮度**: 远景(距离 10)下切面反射的 HDR 源仅占少量
   像素,宝石亮度依赖房底色/发光幕托底;特写下闪点密度更高。已取折中(R6)。

## 4. 对 Cocos AIR 对照的预期判读

若 Cocos AIR 侧无 MeshPhysicalMaterial 等价物(transmission/dispersion/envMapPMREM
三件套),本场景将落在 Product Capability Gap:折射/火彩/环境闪点三项观感无法用
漫反射+平面贴图合法替代(Brief 禁止项 1/2)。Three.js 侧天花板 = 本文档第 1 节
的完整链路,Agent Attainment 的分母以此为准。
