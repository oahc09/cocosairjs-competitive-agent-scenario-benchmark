# ceiling-notes — E03 · Cocos AIR 引擎上限笔记

> 依据最终 RUN(--video,9/9 PASS,fps 60.1)与截图/视频证据。
> 用途:Engine Ceiling 维度自评 + 与 Three.js r186 Reference 的对照基础。

## 1. 六维视觉自评(0–3 分,从严)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | **3** | 33° 斜俯视,8 条同心轨道分层展开占画面 ~70% 宽;尺寸-半径层级对比明确;小行星带连续环带位于第 4/5 轨道之间;土星环倾斜可辨;背景星衬托深空 |
| 材质光影 | **2** | 程序化 Lambert(太阳在原点)+ 纬度条纹 + 极冠 + 风暴斑 + 半透明环(卡西尼缝),类型配色可辨;但无真实纹理(brief 禁外部资产)、无 fbm 噪声表面、光照为单点硬编码而非场景灯管线;暗面仅环境光项 |
| 动效流畅 | **3** | 全天体由模拟时钟确定性驱动,60fps 含 8x 档;变速即时无跳变;带内开普勒速度分层;标记/高亮呼吸脉冲 |
| 特效质感 | **2** | 太阳双层加色公告板模拟 Bloom,视觉成立但非真辉光;无后处理链(Bloom/lens flare/star burst 均不可用);选中高亮圈+脉冲反馈干净 |
| 交互反馈 | **3** | 点击选中(屏距拾取)+ 高亮圈 + 脉冲标记 + 信息卡(5 字段,点击驱动);五档倍率按钮高亮态;Reset;拖拽环绕 + 滚轮缩放 + r/Esc 快捷键 |
| 整体完成度 | **3** | 9/9 探针、12/12 行为项、契约全字段、0 console 错误、视频证据完整 |
| **合计** | **16/18** | `visual = round(16 × 40 / 18) = 36`(参考折算) |

## 2. 本场景验证的 AIR 能力清单(可直接抄进 recipes)

1. **自定义材质全链路**:EffectAsset 编译期同构 JSON(builtins statistics/globals/locals
   blocks + attributes + Constants UBO members)→ `glsl4/glsl3/glsl1` 三变体(glsl3 由
   glsl4 strip `layout()` 生成)→ `EffectAsset.onLoaded()` 注册 → `Material.initialize` +
   `setProperty`。FLOAT4 属性:`Color` 走 1/255 缩放(颜色),`Vec4` 原值(参数向量)。
2. **混合/透明排序**:`blendState`(加色 blendSrc=1/blendDst=1;alpha blendSrc=2/blendDst=4)
   + `priority`(245/250)实现公告板光晕与半透明环带的稳定绘制顺序;`depthWrite:false`
   配合无深度冲突。
3. **程序化几何**:`utils.createMesh(primitives.*)` 之外,自定义 IGeometry(positions/
   normals/uvs/indices/minPos/maxPos/boundingRadius)直接建网格——环带(annulus)、
   420 星合并单网格(单 draw call 星空)均此路径。
3b. **公告板**:`primitives.quad`(XY 平面)+ 每帧 `setRotation(cameraNode.worldRotation)`。
4. **层级与确定性动画**:Node 父子(卫星随行星)+ 每帧 Component.update 布置;
   `worldToScreen`(EVENT_AFTER_DRAW 后取相机终值)做屏幕投影契约。
5. **输入**:引擎 `input.on(MOUSE_*/TOUCH_*)` 绕过 pal 层 stopPropagation;
   `getScrollY() = -deltaY×5`;mouse 与模拟 touch 双发需去重。
6. **规模上限参考**:600 MeshRenderer 节点(共享网格/材质)+ 若干大网格,WebGL2 headless
   60fps;AIR 无 InstancedMesh 等价物时,"共享网格 + 多节点"是 ≥500 实例的可行路线。

## 3. 缺口(Engine Limit / 与 Three.js r186 的真实差距)

1. **无后处理管线**(Code First 路径):Bloom/Glow/Tonemap 不可稳定使用——太阳光晕只能
   用加色公告板伪造;镜头光斑、泛光溢出、暗角等特效维度被硬性封顶(特效质感 ≤2 的主因)。
2. **无 POINT/LINE 图元路径**:primitiveMode 被 `||` 判空静默替换 + 实际图元取自 effect
   JSON pass 的 `primitive` 字段,两点都要补丁;本实现直接绕开(轨道线=细环带三角面),
   代价是多边形数偏高与线宽不可控。
3. **无 InstancedMesh/Points 等价 API**:500+ 小天体只能多节点(600 节点仍 60fps,但
   draw call 与 JS 逐节点 setPosition 成本随规模线性涨;Three 可单 draw call 实例化)。
4. **无节点材质/TSL**:shader 自由度退化为手写 GLSL + 手拼 effect JSON;fbm 噪声表面、
   屏幕空间效果等高级着色可做但工程成本高(本实现条纹/极冠/风暴斑即手写片元的上限)。
5. **光照管线割裂**:自写 effect 不消费场景灯;本场景把"太阳在原点"硬编码进片元
   (对恒定中心光源成立,但多光源/动态光源场景需回退内建材质或手写 UBO 传灯)。
6. **无 OrbitControls**:自写环绕可用但无阻尼/惯性/触摸手势细节。
7. **阴影交付不完整**(本场景未用;背景知识,与审计文档一致)。

## 4. 对 Agent Attainment 的含义

- 行为分(S1–S3 + S2 探针)在 AIR 上 **无结构性障碍**:本 Reference 9/9 PASS 证明
  E03 的 Hierarchy/Animation/Picking/UI/State 五域均可达成。
- 视觉分上限:主要被 §3.1/3.2/3.4 压制,估计 Three 侧同场景可达 17–18/18,
  AIR 侧 16/18 为当前实现的真实水平(其中 1 分差距在 Bloom 与表面细节)。
- 高风险坑位(预期 Agent 常见失败):canvas 事件被 pal 层吃掉(INTERACTION)、
  LINE/POINT 图元静默替换(SHADER/MATERIAL)、effect JSON 缺 builtins 统计段导致
  注册失败(SHADER)、`camera.visibility` 未设置导致黑屏(RUNTIME)、
  P7 的采样时序适配(STATE_MANAGEMENT——本 Reference 也先在此失败一轮)。
