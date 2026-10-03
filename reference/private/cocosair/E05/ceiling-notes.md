# ceiling-notes — E05 黑洞吸积盘 · Cocos AIR 视觉上限探测

> 场景定位:Shader 自由度 / Blend / Postprocess(辉光替代)/ VisualCeiling。
> 本文件记录 AIR 在该场景的天花板证据、后处理受限的具体表现与替代手段效果、与 Three r186 的预期差距。

## 1. Shader 自由度:实测 FULL(超过预期)

- **通道**:用户手写 GLSL 三变体(glsl4 主源,glsl3=去 layout 正则派生;glsl1 WebGL2 下不消费可省)→
  `EffectAsset.onLoaded()` 注册 → `Material.initialize({effectAsset})` → `setSharedMaterial`。
  与内建 effect 同源同权限(docs/manual/custom-shaders.md 状态 FULL,2026-09-26 复核)。
- **本场景用到的能力**(全部编译通过、零 console 错误):
  - 片元极坐标程序化着色(atan/length/smoothstep/pow/exp/discard);
  - UBO 常量块逐帧更新(`setProperty('phase', diskRotation)` → 状态驱动画面);
  - 内建 UBO(CCGlobal cc_time / CCCamera / CCLocal cc_matWorld)自声明混用;
  - 逐顶点色(RGBA32F,亮度>1 的 HDR 顶点色)+ 无 uv/无 normal 的极简顶点布局;
  - 纹理采样路径本场景未用(无资产合同),dissolve 示例已验证 sampler2D 可用。
- **限制**:
  - 无 chunk include,每个 effect 源码自包含(样板重复);
  - `recompileShaders/overridePipelineStates` 为 warn 存根,defines 必须初始化时定死;
  - 运行期无 .effect YAML 编译器,写的是"编译产物 JSON"(心智负担:hash/statistics/attributes 全手填);
  - mediump 陷阱:无限累加的相位 uniform 必须 highp(fp16 量化会令条纹冻结)。

## 2. Blend:实测完整

- pass 级 `blendState.targets[0]`(ONE/ONE 纯加法、SRC_ALPHA 混合、blend:false opaque)均生效;
- 队列语义可用:opaque(blend:false,可写深度)先于 transparent(blend:true)绘制;透明队列内
  pass `priority`(0-255)优先于深度排序 → 光子环以 priority 200 + depthTest off 稳定压轴。
- **结论**:分层加法合成(bloom impostor 的基础)在 AIR 上无障碍。

## 3. Postprocess:确认不可达(本场景核心探测项)

- 证据链:docs/notes/post-process-notes.md(三闸门:聚合出口不 import、`cclegacy.rendering` 被清、
  CUSTOM_PIPELINE_NAME 不设)⇒ 默认 Code First 下 **无任何屏幕空间后处理**,无 Bloom/Tonemap/FXAA;
  引擎 bundle 内后处理代码"可往返、不生效"(diffPixels=0 调查结论,本场景不重复实测,采信文档+源码)。
- **具体表现(若无替代手段)**:亮部无全屏渗出光晕;高对比边缘无柔化;无 HDR tonemap(输出即所见,
  靠手动控制曝光常数);无 FXAA(黑核圆盘边缘有轻度锯齿,cull/mask 后观感可接受)。

## 4. 辉光替代手段与效果评估(本 Reference 采用)

| 手段 | 实现 | 效果 |
|---|---|---|
| shader 内软衰减 | 盘体内外缘 exp/smoothstep 外溢、光子环高斯 σ0.085 + 宽晕 σ0.8 | 亮部→暗部过渡平滑无硬边(探针 P3"辉光观感"判据通过) |
| 多层 additive billboard | 光子环层(depthTest off 压轴)+ 盘层 + 星点 halo | 亮部周围有明确柔光扩散,多层叠加无排序问题(加法交换律) |
| 顶点色 HDR 预缩 | 星流/星点亮度和色温由 CPU 控制 | 近核蓝白增亮、拖尾渐隐自然 |
| 抖动 | 星云 ±0.008 hash 抖动 | 消除 8bit 暗部色带(tonemap 缺失的部分补偿) |

**与 Three(UnrealBloom 级)的观感差距(如实)**:
1. 无全屏辉光渗出——Three 下整盘亮部会向星域/角部弥散,本实现辉光局限于光源本地几倍半径内;
   中远景的"空气感"弱一档。
2. 无 HDR tonemap/自动曝光——曝光为手动常数(exposure=0.92),极端缩放(距离 5)下内缘饱和成片
   的风险靠包络压制,不如 bloom+ACES 的 rolloff 优雅。
3. 无屏幕空间眩光/星芒(lens flare 类)——Three 后处理链可加,本实现完全无。
4. 黑核边缘无 AA(FXAA 缺失),1px 级锯齿在高对比环衬托下偶可察觉。
- **净评**:特写构图(本场景的居中肖像式构图)下替代手段可达观感 ≈ bloom 方案的 80-85%;
  大场景/强曝光对比下差距会拉大。spec 明文"辉光不设实现路径",故不构成扣分,但计入 VisualCeiling 记录。

## 5. 其他引擎缺口(本场景实测)

| 缺口 | 影响 | 规避 |
|---|---|---|
| 无粒子系统(3D) | 星流需自绘 | `createDynamicMesh`+`updateSubMesh` 单 draw call 240 粒子,CPU 每帧 ~36KB 顶点写放,60fps 无压力 |
| 滚轮输入语义反转+5 倍 | 缩放方向/灵敏度易错 | `-getScrollY()/5` 还原 DOM 方向(已写入 WORKLOG 供 Agent 参考) |
| tarball 与仓库导出差异 | `utils.createDynamicMesh` 位置不同 | 双路径兜底 |
| `Node.addChild` 返回 void | 链式写法崩溃 | 分步 |
| primitives.plane 在 XZ | 极坐标/billboard 语义陷阱 | v_p=xz + 子节点 X+90° |
| 无 OrbitControls | 相机交互手写 | 球坐标 + 指数平滑(~40 行) |

## 6. 性能上限

- 6 个 draw call(星云/星空/盘/星流/黑核/光子环),1 次动态 buffer 更新/帧;
  1280×720 headless Chromium: **60.2 fps**(RTX 4060 Laptop / D3D11 ANGLE)。
  瓶颈在片元噪声(fbm)与超采样星点,均有 3-5 倍余量;scale-up(更密星流/更大盘细分)空间充足。

## 7. 六维自评汇总(与 REFERENCE-VERDICT 一致)

构图取景 2.5 / 材质光影 2.5 / 动效流畅 3 / 特效质感 2 / 交互反馈 2.5 / 整体完成度 3
= 15.5/18 → visual 34/40;客观 59.5/60;**总分 93.5/100,verdict FEASIBLE**。
特效质感是唯一因后处理缺失压到 2 的维度——这正是本场景要的实验答案:
**AIR 的 Shader/Blend 通道本身达到 FULL,视觉上限的天花板在管线级后处理的缺席,而非可编程着色能力。**
