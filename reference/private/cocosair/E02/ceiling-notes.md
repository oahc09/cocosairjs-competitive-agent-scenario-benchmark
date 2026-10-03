# E02 Ceiling Notes — Cocos AIR(引擎上限视角)

> Reference 实现自评。六维各 0–3 分,`visual = round(sum × 40 / 18)` 口径换算。
> 自评分是 Reference(可信实现者)对**本实现达成度**的评估,同时标注引擎能力边界。

## 1. 六维自评

| 维度 | 分 | 依据(可对照 validation/screenshots 与 video.webm) |
|---|---|---|
| 构图取景 | 2.5 | 海平线约画面上 28–35%(soft haze 带);太阳/月亮中轴偏右、贴近海平线;孤舟中央偏下完整可见(桅杆上探海平线);俯角使海面占 ~70%。扣分:海平线为渐变过渡而非锐利线,构图经数值校验而非逐像素设计 |
| 材质光影 | 2.5 | 船体 6 部件 6 材质完整保留(帆亮至 RGB(255,255,183)、船身暗至 (28,21,14),受光/背光对比显著);暖端落日逆光+金色 rim,冷端月光顶照。扣分:海面为风格化 unlit 着色(Fresnel/高光带近似),非 PBR 水面;无 Bloom 使太阳核心过曝为纯白 |
| 动效流畅 | 3 | 全程 60fps(RTX 4060 真硬件);海面 3 波分量 GPU 位移相位持续推进(波峰沿风向行进,非 UV 滚动);相机速度受限逐帧追踪无跳变;toneMix 1.9s smoothstep 全场景同步演变 |
| 特效质感 | 2 | 太阳光盘+宽光晕、海面镜面高光带(sun glitter path)、浪峰透光(subsurface 近似)、远距雾化融入地平线;冷端小而锐的月亮+冷调高光。扣分:无后处理(Bloom/tonemap 不可稳定使用),高光带为解析镜面模型而非微平面法线贴图级细节 |
| 交互反馈 | 3 | 拖拽环绕方向一致、平滑、幅值充足(358px 拖拽 → 300°+ 环绕);色调控件任意时刻可反向切换(过渡中途点击实测正确);Reset <1s 完成释放+重建+恢复;HUD 实时反馈 fps/toneMix/azimuth/epoch;加载失败有可见错误提示路径 |
| 整体完成度 | 3 | 合同全绿:7/7 探针、真实网络消费、材质保留、相位耦合、释放重建、20 次 reset 无泄漏、0 控制台错误;brief 全部 10 条行为项有状态+独立观测双证据 |

**合计 16 / 18 → visual = round(16 × 40 / 18) = 36 / 40**

## 2. 引擎能力清单(E02 视角,实证)

### 可用且已验证
- `GLTFLoader.loadAsync` → `instantiate()` 内建 glTF-Binary 直载(无压缩 GLB 零配置);材质/层级/双面渲染保留
- 自定义 EffectAsset:手写 GLSL 三变体(glsl4/3/1)、UBO(Constants, set1, VERTEX|FRAGMENT 双阶段)、运行期 setProperty 逐帧更新 —— **顶点位移通道完整可用**(本场景海面即证)
- `utils.createMesh(IGeometry)` 手写顶点数组(12321 顶点非均匀网格)
- `primitives.sphere` 天穹;`Node.lookAt`/`setPosition` 相机控制
- `input.on(Input.EventType.TOUCH_*)` 鼠标拖拽(鼠标事件路由到 TOUCH_*)
- `DirectionalLight.color/illuminance` 动态改;`scene.globals.ambient.skyColorHDR.set()/skyIllum` 逐帧改
- 生命周期:`instance.dispose()` + `asset.destroy()` + `mesh.destroy()` + `material.destroy()` 后同路径重建,20 次无泄漏(post-GC 堆平台)
- `Component.update(dt)` 时钟增量驱动(后台节流恢复正常)

### 本场景未用到/受限(如实)
- **就地改写顶点缓冲:无 API**(docs/manual/custom-buffergeometry.md §2 明示)——CPU 顶点动画只能整 mesh 重建(每帧重建不可行),**动态几何必须走 shader 位移**。这是与 Three.js(BufferAttribute.needsUpdate)最大的通道差异。
- **pal 层吞 DOM 鼠标事件**:canvas mousemove stopPropagation → DOM 监听方案不可行,必须走引擎 input 系统
- 无 EffectAsset chunk/include 系统:每个自定义 shader 必须自带完整 UBO 块声明(CCGlobal/CCCamera/CCLocal),样板冗长
- 后处理(Bloom/tonemap)Code First 路径不可稳定使用 → 太阳核心直接过曝白,无辉光扩散
- 阴影交付不完整 → 船体在海面无投影(本实现以高光带/暗部对比补偿)
- 引擎天空盒(envMap)未采用:自定义天穹 mesh 更直接且可控渐变

## 3. 对 Agent Attainment 的预测性备注

- K0(仅 .d.ts + 模板)Arm 在本场景预期卡点:①DOM 鼠标监听失效(P4 类探针全灭,需 1-2 轮修复);②自定义 shader 样板(UBO 布局/三变体/hash/builtins 统计)凭 .d.ts 很难凭空写对,可能退化为"静态海面+材质色块"(触碰 Forbidden 4/3);③GLTF 生命周期 API(dispose/destroy 配对)需试错。
- K2(含 examples)Arm 应能命中 shader-custom-gradient + custom-buffergeometry + input 三条正典路径,预期与本 Reference 差距主要在视觉调优轮次,而非能力缺失。

## 4. 换算与汇总

- Reference verdict:FEASIBLE(无 ENGINE_LIMITED)
- 客观:S1 15 + S2 30 + S3 10 + S4 5(估)≈ 60;visual 36/40;合计口径按 score.mjs 聚合
- 效率实测量:4 次构建、3 轮 validate(1 FAIL→1 PASS→1 final PASS)、浏览器会话 8、修复动作 2 类(输入通道、构图参数)
