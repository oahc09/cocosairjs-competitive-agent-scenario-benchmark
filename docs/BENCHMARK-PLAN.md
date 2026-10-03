# CocosAirJS Agent 双引擎对照实验 — 完整任务计划书

> 文档定位：实施规格 / Benchmark 设计 / 验收合同  
> 对照对象：Three.js r186 vs Cocos AIR  
> 核心主题：同一 AI Agent 配置下，双引擎复杂 3D 场景的成对对照实验  
> 核心设计：**Paired Dual-Engine Run、Engine Ceiling / Agent Attainment 分离、K0/K1/K2 知识消融、能力不可行项双口径计分、资产型场景补强、独立串扰 Gate、One-shot/Repair 双轨指标**
> 
> 本文是独立的 `Cross-Engine Scenario Benchmark` 计划，不替代 CocosAirJS 既有 Engine Gate / Agent Gate / 100+ Benchmark。

---

## 0. 结论与执行原则

本实验的最终目标不是给 Three.js 与 Cocos AIR 产生一个简单总分，而是回答以下问题：

1. **引擎能力上限**：相同场景由可靠 Reference 实现时，两引擎分别能做到什么程度。
2. **Agent 实际完成能力**：相同 AI Agent 面对两个引擎时，最终能做到什么程度。
3. **Agent 能力利用率**：Agent 能否把引擎已有能力有效发挥出来。
4. **知识建设收益**：Docs / Patterns / Recipes / Examples / Skill 是否明显提升 Cocos AIR 的 Agent 成功率。
5. **Agent DX**：失败后是否容易定位、修复、恢复。
6. **产品能力缺口**：哪些失败来自 Cocos AIR 引擎本身，而不是 Agent。
7. **复杂场景竞争力**：在真实效果级任务中，两引擎最终产物的功能、观感、成本与稳定性差距在哪里。

### 0.1 核心决策

采用：

```text
Cross-Engine Scenario Benchmark
        │
        ├── Track A: Engine Ceiling
        ├── Track B: Paired Agent Scenario
        ├── Track C: Knowledge Ablation
        └── Track D: Blind Preference
```

保留现有：

```text
CocosAirJS Existing Quality System
        │
        ├── Engine Gate
        ├── Agent Gate
        ├── 100+ capability Benchmark
        ├── Recipe Gate
        ├── Example / Gallery Gate
        └── API Coverage Gate
```

两套体系关系：

```text
100+ Benchmark
验证“正确性 / API / 生命周期 / 能力点”

        ↓

Cross-Engine Scenario Benchmark
验证“复杂任务综合竞争力 / Agent 友好度 / 产品能力上限”

        ↓

优秀 Reference / Agent 产物
可转化为 Example / Recipe 候选

        ↓

重新经过 Frozen Spec + Validator + Evidence
才允许晋升 stable
```

### 0.2 不允许的替换关系

以下行为禁止：

- 不得用本实验 10 个复杂场景替代现有 100+ Agent Benchmark。
- 不得用综合平均分替代 Engine Gate / Agent Gate 的硬门禁。
- 不得将 Benchmark Reference 直接计为 stable Example。
- 不得因 AIR 某场景不可实现而从产品能力比较中直接删除。
- 不得让 Three 与 AIR 两侧 Agent 看到对方代码、日志、思路、浏览器状态或结果。
- 不得用同一个 Conversation 同时修改两个引擎工程。

---

# 1. 实验问题

## 1.1 主问题

在：

- 同一个 AI Agent 实现；
- 同一个模型版本；
- 同一个系统提示；
- 同一个工具集合；
- 同一个复杂场景 Brief；
- 同一个预算；
- 相同知识等级；
- 相同资产；
- 相同验证合同；

条件下：

> Three.js 与 Cocos AIR 分别能让 Agent 把复杂效果级 3D 场景做到什么程度？

并进一步回答：

```text
差距来自：
Engine capability？
API ergonomics？
Documentation？
Pattern / Recipe？
Asset workflow？
Shader / Postprocess？
Lifecycle？
Error diagnostics？
Agent hallucination？
Repairability？
```

## 1.2 明确不回答

本实验不用于直接回答：

- 两引擎运行时极限性能排名；
- 人类开发者主观开发体验；
- 编辑器生态；
- 原生平台能力；
- Creator 编辑器能力；
- 底层 GFX / Rendering API 性能；
- 单 API 正确性完整覆盖。

上述内容仍由对应既有 Gate / Benchmark 负责。

---

# 2. 实验测量模型

本实验必须把“引擎能力”与“Agent 利用能力”拆开。

## 2.1 Engine Ceiling

定义：

```text
EngineCeiling(scene, engine)
= 该场景在冻结 Brief 下，由可靠 Reference 实现可达到的标准化结果
```

Reference 的作用：

1. 证明场景是否可解；
2. 证明 Brief 是否足够清晰；
3. 建立视觉 / 行为 / 生命周期锚点；
4. 校准 Validator；
5. 确认 Engine capability gap；
6. 产出 Gallery / Recipe 候选素材。

Reference 不是 Agent 结果。

---

## 2.2 Agent Raw Capability

定义：

```text
AgentRawScore
= Agent 最终生成并通过独立验证的实际得分
```

用于回答：

> 最终用户让 Agent 写这个场景，实际能得到什么。

---

## 2.3 Agent Attainment

定义：

```text
AgentAttainment
= AgentRawScore / EngineCeilingComparableScore
```

只在该场景 Reference 已证明引擎可实现时计算。

示例：

```text
Three Reference = 95
Three Agent     = 86
Attainment      = 90.5%

AIR Reference   = 72
AIR Agent       = 67
Attainment      = 93.1%
```

此时应得出：

```text
AIR Agent 对已有引擎能力的利用率并不低；
差距主要来自 Engine Ceiling。
```

不得简单归因为 “AIR Agent 能力差”。

---

## 2.4 Product Capability Availability

定义：

```text
CapabilityAvailability
= Reference 已证明可实现的 required 场景数 / 全部 required 场景数
```

如果：

```text
Three = 10/10
AIR   = 8/10
```

AIR 的两个不可实现项：

- 必须计入 Product Capability Gap；
- 不得从产品能力比较中删除；
- 但不得污染 `AgentAttainment`。

---

## 2.5 Knowledge Gain

定义：

```text
KnowledgeGain(engine)
= Score(K1 or K2) - Score(K0)
```

进一步：

```text
KnowledgeGainAdvantage
= AIR_KnowledgeGain - Three_KnowledgeGain
```

用于判断：

> CocosAirJS 的文档、Patterns、Recipes、Examples、Skill 建设是否真正改善 Agent 成功率。

---

## 2.6 Repairability

核心指标：

```text
RecoveryRate
= 首轮失败但在标准反馈预算内最终成功的 trials
  /
  首轮失败 trials
```

同时记录：

```text
FirstCompileRate
FirstFunctionalPassRate
MedianRepairCount
MedianTimeToRecovery
```

用于区分：

```text
不容易犯错
vs
犯错后容易修复
```

---

# 3. Paired Dual-Engine 实验设计

## 3.1 基本统计单元

本实验的基本实验单元不再是单个 Run，而是：

```text
Pair
```

一个 Pair 定义为：

```text
Pair =
同一 Brief
+ 同一 Agent Revision
+ 同一 Model Revision
+ 同一 Knowledge Level
+ 同一 Budget
+ 同一 Asset Set
+ 两个独立 Fresh Session
+ 两个独立 Workspace
+ 两个独立 Browser Profile
+ 近同时启动
+ 独立验证
+ 成对统计
```

例如：

```text
PAIR-E03-K1-R02

Shared:
  brief = E03
  model = pinned
  agent = pinned
  tools = pinned
  budget = pinned
  assets = pinned
  knowledgeLevel = K1

Arm A:
  engine = Three.js
  session = fresh
  workspace = isolated

Arm B:
  engine = Cocos AIR
  session = fresh
  workspace = isolated
```

---

## 3.2 “同一个 Agent”的正式定义

“同一个 Agent”表示：

- 相同 Agent 程序版本；
- 相同模型；
- 相同系统提示；
- 相同 tool policy；
- 相同预算；
- 相同操作能力；
- 相同执行协议。

不表示：

```text
同一个 Conversation
```

禁止：

```text
Conversation
├── /three
└── /cocosair
```

因为第二侧会获得第一侧的：

- 场景拆解；
- Shader 思路；
- 算法选择；
- Bug 经验；
- UI 结构；
- 调试结论。

正确方式：

```text
Pair Coordinator
      │
      ├── Fresh Session A → Three workspace
      │
      └── Fresh Session B → AIR workspace
```

---

## 3.3 启动同步

Pair 两侧应：

```text
startTimeDelta <= 30s
```

优先真正并行启动。

如果平台无法严格同时启动：

- 必须记录实际 start timestamp；
- 超出阈值标记；
- 不得隐瞒顺序差异。

---

## 3.4 Arm 随机化

A/B runner slot 不绑定固定引擎。

采用平衡分配：

```text
R1  A=Three   B=AIR
R2  A=AIR     B=Three
R3  A=Three   B=AIR
R4  A=AIR     B=Three
```

用于降低：

- runner slot bias；
- launch order bias；
- worker bias。

---

## 3.5 开发阶段与验证阶段资源规则

### 开发阶段

允许：

```text
Three Agent
AIR Agent
```

同时运行。

但必须隔离：

- workspace；
- process tree；
- browser profile；
- dev server port；
- temp；
- localStorage；
- IndexedDB；
- Service Worker；
- logs；
- artifact path。

### 正式性能 / 录屏验证

如果共用 GPU / 主机：

```text
禁止同时测
```

必须随机顺序串行：

```text
Pair 1: Three → AIR
Pair 2: AIR → Three
```

原因：

- GPU contention；
- CPU contention；
- video encoding；
- browser scheduling；
- thermal / memory pressure；

会污染 FPS 和录屏结果。

如果使用两台经过校准的等价 worker，则允许并行验证，但必须记录 worker identity 与环境 hash。

---

# 4. 串扰与隔离 Gate

Pilot 前必须先证明实验环境不会串扰。

## 4.1 Workspace Leakage

测试：

```text
Session A 写入 marker-A
Session B 尝试读取 marker-A
```

期望：

```text
不可见
```

反向同理。

---

## 4.2 Browser Leakage

检查：

```text
localStorage
sessionStorage
IndexedDB
CacheStorage
Service Worker
cookies
browser profile
```

两侧不得共享。

---

## 4.3 Dev Server Leakage

必须：

- 独立端口；
- 禁止一侧读取另一侧页面；
- Agent 工具不得枚举另一侧 dev server。

---

## 4.4 Benchmark Answer Leakage

以下内容不得挂载到 Agent 可读目录：

- Reference 实现；
- Reference screenshots；
- Reference videos；
- private validator source；
- expected answer；
- other arm code；
- previous trial results。

只读挂载也禁止，因为“只读”仍然可读取答案。

---

## 4.5 牺牲性串扰测试

Pilot 使用专门的 fake marker：

```text
/secret/reference-marker.txt
```

故意检测：

```text
Agent 是否能看到
```

如果任何一侧可读取：

```text
Environment Gate = FAIL
所有 Agent Benchmark 结果暂不可信
```

---

# 5. Immutable Pair Configuration

每个 Pair 必须记录至少：

```text
pairId
sceneId
knowledgeProfile
repetition

agentBinaryHash
modelId
modelRevision
systemPromptHash
toolPolicyHash

briefHash
assetSetHash
budgetConfigHash

threePackageHash
airPackageHash

threeKnowledgeHash
airKnowledgeHash

threeTemplateHash
airTemplateHash

nodeVersion
packageManagerVersion
browserVersion
os
gpu
graphicsBackend

startTimestampA
startTimestampB
workerA
workerB
```

Pair 两侧除以下项目外原则上必须相同：

```text
engine package
engine-specific knowledge package
engine template
```

配置漂移必须使 Pair 失效或单列。

---

# 6. 知识条件设计

## 6.1 K0 — Cold

允许：

```text
package
README
.d.ts
项目模板本身
```

禁止：

```text
额外官方 Docs
Patterns
Recipes
Examples
Skill
联网搜索
```

回答：

> 现实冷启动状态下 Agent 能做到什么。

---

## 6.2 K1 — Official Docs

允许：

```text
K0
+ Official API docs
+ Concept docs
+ Engine-specific basic patterns
```

禁止：

```text
直接对应当前 Benchmark 场景的答案型 Example
Benchmark Reference
私有 validator
针对当前任务写的 Recipe
```

回答：

> 正常官方文档面能否显著提升成功率。

---

## 6.3 K2 — Full Agent Knowledge

允许：

```text
K1
+ Patterns
+ Stable Recipes
+ Stable Examples
+ Agent Skill / Knowledge Package
```

但必须防止：

```text
直接包含当前 Brief 的完成代码
```

K2 用于验证：

> CocosAirJS 后续 Agent Knowledge 体系是否真正成为竞争优势。

---

## 6.4 知识公平原则

不再只使用：

```text
token 数量 ±20%
```

作为公平性唯一依据。

还必须建立：

```text
Domain Coverage Matrix
```

例如：

| Domain | Three K1 | AIR K1 |
|---|---|---|
| Scene setup | yes | yes |
| Camera | yes | yes |
| Material | yes | yes |
| Animation | yes | yes |
| Asset load | yes | yes |
| Input | yes | yes |
| Shader | yes | yes / limitation documented |
| Postprocess | yes | limitation documented |

如果某域 AIR 没有能力，不得通过加入“如何伪造效果”的答案文档来补齐。

---

# 7. 实验 Tracks

## Track A — Engine Ceiling

每个场景：

```text
Human / trusted Reference
├── Three Reference
└── AIR Reference
```

目标：

1. 证明可解；
2. 建立 Ceiling；
3. 发现引擎能力缺口；
4. 校准 validator；
5. 校准 Brief；
6. 形成 Example 候选。

总量：

```text
10 scenes × 2 engines = 20 Reference
```

---

## Track B — Paired Agent Scenario

核心矩阵：

```text
10 scenes
× 2 knowledge levels (K0/K1)
× N=3 pairs
= 60 pairs
= 120 Agent runs
```

这是主实验。

---

## Track C — Knowledge Ablation

选择 4 个代表场景：

```text
E02 Asset
E05 Shader/Postprocess
E08 Simulation
E10 Animation/Asset/Lifecycle
```

执行：

```text
4 scenes
× K2
× N=3 pairs
= 12 pairs
= 24 runs
```

用于确认 Full Agent Knowledge 的价值。

---

## Track D — Blind Preference

对同一：

```text
scene
knowledge profile
```

下的 Three/AIR 输出做盲评。

N=3 时：

```text
3 Three outputs × 3 AIR outputs
= 9 unique cross-engine pairs
```

每个 unique pair：

- A/B 顺序随机；
- 允许 tie；
- 至少 2 次独立 judge pass；
- 抽样人工复核。

不再把重复 pair 强行包装为 “Elo ≥20 对”。

主统计：

```text
Preference Win Rate
Tie Rate
Bradley-Terry coefficient
Confidence Interval
```

---

# 8. 复杂场景集

场景原则：

1. 每场景覆盖 3–6 个子系统；
2. 避免单 API 任务；
3. Brief 使用图形领域语言，不出现引擎 API；
4. 两引擎尽可能有可比解；
5. 同时覆盖 procedural 与 asset-driven；
6. 覆盖 CocosAirJS Code First / Runtime Asset / Animation / Lifecycle 路线；
7. 覆盖 Shader / Postprocess 等 AIR 潜在短板。

---

## E01 深空星系巡航

子系统：

```text
程序化生成
>=50,000 星点
粒子
颜色梯度
相机
HUD
动画
```

验收：

- 星点规模；
- 旋臂结构；
- 动态旋转；
- 鼠标视差；
- 滚轮穿行；
- HUD；
- >=30fps 功能阈值。

---

## E02 落日海面与孤舟 — Asset Driven

共享资产：

```text
assets/boat.glb
```

要求：

- Runtime load；
- 模型正常显示；
- 材质保留；
- 动态海面；
- 船体随波起伏；
- 鼠标环绕；
- 暖色 → 冷色色调变化；
- reset；
- 正确释放。

覆盖：

```text
Asset loading
Scene graph
Material
Animation
Shader
Lifecycle
Camera
```

---

## E03 太阳系仪

要求：

- 太阳；
- 8 行星；
- >=2 卫星；
- 土星环；
- 小行星带；
- 公转速度分层；
- 点击信息卡；
- 0.5x–8x 时间倍率；
- reset。

覆盖：

```text
Hierarchy
Animation
Picking
UI
State
```

---

## E04 城市烟花夜

要求：

- 城市剪影；
- 点击发射；
- 尾迹；
- 爆炸；
- 重力下坠；
- 衰减；
- 余烬；
- 自动表演模式。

覆盖：

```text
Procedural geometry
Particles
Timeline
Input
State
```

---

## E05 黑洞吸积盘

要求：

- 黑洞核心；
- 发光吸积盘；
- 内白外橙红；
- 旋转条纹；
- 星流螺旋；
- 辉光；
- 背景星空；
- 相机缩放。

此场景用于探测：

```text
Shader freedom
Blend
Postprocess
Glow / Bloom substitute
Visual ceiling
```

不得因 AIR Reference 不可达到同等观感而删除该场景。

---

## E06 荒野篝火营地

要求：

- 低多边形树环；
- 篝火；
- 火苗；
- 火星；
- 萤火虫；
- 动态光；
- 日夜切换；
- 环绕。

覆盖：

```text
Procedural
Particles
Dynamic light
State
Camera
```

---

## E07 霓虹夜城

要求：

- 实例化楼群；
- 发光窗阵；
- 车流；
- 雨；
- 雾；
- 霓虹氛围；
- >=30fps。

覆盖：

```text
Instancing
Emission
Animation
Atmosphere
Scale
```

---

## E08 深海鱼群

要求：

- >=80 鱼；
- boids；
- aggregation；
- alignment；
- separation；
- 鼠标惊散；
- 重聚；
- 点击投喂；
- 向食物点聚集；
- 悬浮颗粒。

覆盖：

```text
Simulation
Interaction
Procedural body
Particles
State
```

---

## E09 珠宝展示台

共享资产可选：

```text
assets/gem.glb
```

要求：

- 高折射/反射/色散观感；
- 三点棚拍；
- 转台；
- 色板；
- 双击推近；
- PNG 导出。

此场景用于测：

```text
Material ceiling
Reflection / Refraction look
Lighting
Camera transition
Screenshot export
```

若 AIR Ceiling 低，作为 Product Capability Gap 计入。

---

## E10 动画角色展示空间 — Asset/Lifecycle

共享资产：

```text
assets/character.glb
```

要求：

- Runtime load；
- Skeleton；
- 至少 2 个 animation clip；
- Idle / Walk 切换；
- 双实例；
- 两实例独立 animation state；
- 材质正确；
- 灯光；
- 相机；
- 销毁一个实例；
- 另一实例继续正常运行；
- reset 后恢复。

覆盖：

```text
GLB
Skeleton
Animation
Instance isolation
Material
Scene graph
Lifecycle
```

这是与 CocosAirJS 当前 Code First / Runtime Asset 路线高度相关的核心场景。

---

# 9. Frozen Brief Spec

每个场景必须生成独立冻结规格。

格式：

```text
briefId
briefVersion

1. Goal
2. Visual Direction
3. World Composition
4. Interaction & Feedback
5. Asset Contract
6. Scale & Performance
7. Runtime / Lifecycle
8. Technical Constraints
9. Completion Contract
10. Forbidden Shortcuts
```

---

## 9.1 Completion Contract

所有场景统一要求：

```text
npm run build PASS
页面可启动
无未捕获异常
window.__appReady = true
window.__bench = { getState, reset }
```

场景级再增加：

```text
behavior validators
visual validators
interaction validators
asset validators
lifecycle validators
```

---

## 9.2 API 中立

Brief 允许：

```text
粒子
辉光
骨骼动画
实例
折射
层级
碰撞
```

禁止：

```text
THREE.Scene
Mesh
OrbitControls
Component
Node
Material API 名称
具体 Cocos 类名
```

---

# 10. Reference 实现规范

每个：

```text
scene × engine
```

完成一个独立 Reference。

Reference 验收：

1. Brief 每项可实现；
2. 无需猜测未定义要求；
3. 行为正确；
4. 视觉达到定义锚点；
5. 生命周期正确；
6. 资产路径正确；
7. 可 fresh build；
8. 可 fresh page；
9. 可自动验证；
10. 生成截图 / 视频。

---

## 10.1 Reference 分类

### FEASIBLE

引擎可以实现。

### ENGINE_LIMITED

可实现，但存在明确能力天花板。

例如：

```text
无法真实 Bloom，只能近似视觉手段
```

仍可保留，但 Ceiling 分会真实反映。

### ENGINE_UNAVAILABLE

Reference 证明该 required 结果在冻结能力边界内不可实现。

处理：

```text
Product Capability → 计缺口
Agent Attainment → 不计算该项
```

### SPEC_INVALID

两侧 Reference 都无法可靠实现，原因来自：

- Brief 歧义；
- 资产错误；
- 验收不可操作；
- 环境缺陷。

必须修改 Brief 后重新冻结。

---

# 11. Agent 执行协议

## 11.1 通用规则

每个 Arm：

- fresh conversation；
- fresh workspace；
- fresh browser profile；
- frozen template；
- frozen lockfile；
- 禁联网；
- 禁安装新依赖；
- 禁访问另一 Arm；
- 禁修改 benchmark harness；
- 禁修改 Brief；
- 禁读 Reference；
- 禁读 private validator。

---

## 11.2 预算

冻结：

```text
maxToolCalls
maxTokens
maxWallTime
maxBuildAttempts
maxBrowserAttempts
```

两引擎一致。

如果某一引擎 build 本身较慢：

- 记录真实 wall time；
- 不临时给额外预算；
- 但最终报告分开解释生成时间与工具链时间。

---

## 11.3 R0 — Autonomous

Agent 可以自行：

```text
edit
build
run
browser inspect
console inspect
screenshot
fix
```

但不会收到 private validator oracle。

这是主实验模式。

---

## 11.4 R1 — Standardized Repair

作为扩展或抽样实验。

当 R0 最终失败时，Harness 只返回标准化反馈：

```text
build failure
runtime error
behavior assertion failure
visual contract failure category
```

禁止返回：

- Reference code；
- 具体答案；
- engine-specific修复提示。

最多：

```text
3 repair rounds
```

记录：

```text
RecoveryRate
RepairCount
TimeToRecovery
```

---

# 12. Validator 与反作弊设计

## 12.1 `window.__bench`

只允许作为：

```text
辅助状态通道
```

不得作为关键事实的唯一证据。

例如：

```js
getState() {
  return { starCount: 50000 }
}
```

不能证明真的渲染了 50000 星点。

---

## 12.2 Independent Observable Rule

每个关键 PASS 至少需要：

```text
state evidence
+
至少一个 independent observable
```

可选 independent observable：

```text
pixel evidence
motion evidence
interaction evidence
download event
DOM evidence
asset request evidence
lifecycle evidence
```

---

## 12.3 Negative Controls

Harness 必须先证明自己能抓住假实现。

至少包含：

### NC01 Empty Renderer

```text
__bench 返回全部正确
画面为空
```

必须 FAIL。

### NC02 Frozen Animation

停止动画，但状态声称 playing。

必须 FAIL。

### NC03 Fake Asset Loaded

状态返回 loaded，但模型不可见/资源未真正消费。

必须 FAIL。

### NC04 Broken Interaction

状态可人工写入，但点击无实际行为。

必须 FAIL。

### NC05 Lifecycle Leak

销毁后对象/事件/worker 仍持续影响场景。

必须 FAIL。

### NC06 Validator Tampering

Agent 修改 harness / validator。

必须：

```text
INVALID_RUN
```

---

# 13. 自动验证流程

每个 Run：

```text
1. verify candidate hash
2. npm run build
3. start isolated server
4. fresh browser profile
5. wait __appReady
6. collect console
7. execute scene probe
8. capture screenshots
9. capture video
10. collect state
11. execute lifecycle/reset
12. collect performance sample
13. archive artifacts
14. classify result
```

---

# 14. 场景探针

每场景必须定义：

```text
probeId
precondition
action
wait
state assertion
visual assertion
interaction assertion
threshold
evidence
```

例如 E03：

```text
P1 初始太阳系可见
P2 点击目标行星
P3 信息卡出现且字段正确
P4 速度滑杆拖到 8x
P5 轨道角速度明显提高
P6 reset
P7 状态恢复
```

不能只测：

```text
DOM 存在
```

---

# 15. 录屏与截图

每 Run：

```text
关键截图 >= 5
录屏 20–30s
```

视频必须覆盖：

- 初始；
- 至少 2 个交互；
- 动态变化；
- reset 或生命周期动作（适用时）。

匿名化：

```text
engine-A
engine-B
```

盲评材料不得出现：

- engine name；
- package name；
- path；
- source code；
- console；
- logo。

---

# 16. 评分体系

## 16.1 Run Score

保持 100 分，但效率不再混入总分。

### Objective — 60

| 维度 | 分值 |
|---|---:|
| S1 可运行 | 15 |
| S2 行为正确性 | 30 |
| S3 场景技术合同 / 生命周期 | 10 |
| S4 代码健康 | 5 |

### Visual — 40

六维：

```text
构图取景
材质光影
动效流畅
特效质感
交互反馈
整体完成度
```

每维：

```text
0 / 1 / 2 / 3
```

映射到 40。

---

## 16.2 效率独立报告

不再作为 5 分混入总分。

独立记录：

```text
tokens
toolCalls
wallTime
buildAttempts
browserAttempts
repairCount
timeToFirstCompile
timeToFinalPass
```

原因：

```text
token ≠ wall time ≠ build cost
```

压成一个分数会掩盖真实 Agent DX。

---

# 17. Pair Metrics

主报告优先输出成对差值。

例如：

```text
PairedRawDelta
= AIR_RawScore - Three_RawScore

PairedAttainmentDelta
= AIR_Attainment - Three_Attainment

PairedTokenDelta
= AIR_Tokens - Three_Tokens

PairedToolCallDelta
= AIR_ToolCalls - Three_ToolCalls

PairedRepairDelta
= AIR_RepairCount - Three_RepairCount
```

此外：

```text
pair win
pair tie
pair loss
```

必须明确定义 tie threshold。

---

# 18. 视觉偏好统计

不再用模糊的“≥20 对 Elo”。

采用：

```text
unique cross-engine comparisons
+ randomized A/B
+ tie
+ Bradley-Terry
```

N=3：

```text
9 unique comparisons / scene / knowledge
```

每个 comparison：

```text
2 independent judge passes
```

人工：

```text
至少 10% 抽样复核
```

如果 Judge 与人工 disagreement 高于冻结阈值：

```text
Visual Judge Gate = BLOCKED
```

必须重新校准 Judge。

---

# 19. 统计与解释规则

## 19.1 N=3 的正确表述

禁止：

```text
0/3 vs 3/3 = 确定性差距
```

改为：

```text
observed strong separation
```

N=3 主要用于：

- 发现方向；
- 观察失败模式；
- 比较 pair delta；
- 判断是否值得加密。

---

## 19.2 头条场景加密

若：

- 差异大；
- 方差大；
- 产品决策依赖该结果；

则增加：

```text
N=5
```

不能只选择对 AIR 有利的场景加密。

加密场景选择规则必须在查看最终结果前冻结，或由方差阈值自动触发。

---

## 19.3 推荐统计

至少报告：

```text
median
IQR
paired delta
bootstrap CI
win/tie/loss
failure distribution
```

可选：

```text
paired permutation
Wilcoxon signed-rank
```

不要用单一 p-value 替代工程解释。

---

# 20. 失败分类

统一枚举：

```text
API_HALLUCINATION
TYPE_ERROR
LIFECYCLE_MISUSE
ASSET_PIPELINE
ANIMATION
SCENE_GRAPH
SHADER
POSTPROCESS
MATERIAL
INTERACTION
STATE_MANAGEMENT
PERFORMANCE
BUILD
RUNTIME
REPAIR_EXHAUSTED
BUDGET_EXHAUSTED

ENGINE_LIMITED
ENGINE_UNAVAILABLE

INFRA_FAILURE
INVALID_RUN
SPEC_INVALID
```

---

# 21. Failure Attribution

## 21.1 Engine Failure

Reference 在有效环境中出现真实回归：

```text
Engine Failure
Agent NOT_EVALUATED
```

不得算 Agent 失败。

---

## 21.2 Agent Failure

Reference PASS，但 Agent：

- 编译失败；
- 功能失败；
- 预算耗尽；
- 错误终态；

计：

```text
Agent FAIL
```

---

## 21.3 Infra Failure

仅限：

- Browser 无法可信启动；
- fixture hash 损坏；
- worker 故障；
- harness 自身错误；
- 主机异常。

不得把引擎实现 bug 包装成 INFRA。

---

## 21.4 Invalid Run

例如：

- 读取 Reference；
- 读取另一 Arm；
- 修改 validator；
- 突破文件隔离；
- 跨 trial 污染。

必须保留原记录。

不得通过删除失败 trial 提高成功率。

---

# 22. 与 CocosAirJS 既有 Gate 的关系

本实验不改变以下项目合同：

```text
Engine Gate:
冻结 Reference，验证引擎正确性

Agent Gate:
真实 Agent 生成源码，fresh build / fresh page

Benchmark:
至少 100 独立能力点

Recipe:
RC / 1.0 至少 30 stable

Example / Gallery:
必须独立 Frozen Spec + Validator + Evidence

API Coverage:
Core / Important / Advanced 继续按冻结合同验证
```

---

## 22.1 Benchmark Reference → Gallery 的正确流程

```text
Cross-Engine Reference
        ↓
Gallery Candidate
        ↓
建立独立 Frozen Example Spec
        ↓
API inventory mapping
        ↓
Validator
        ↓
Visual / Interaction / Lifecycle evidence
        ↓
stable
```

禁止：

```text
Reference 跑通
=
stable Example
```

---

# 23. 工程目录建议

```text
bench/
  config/
    benchmark.yaml
    agents.yaml
    environments.yaml

  briefs/
    E01/
      brief.md
      spec.json
    ...
    E10/

  templates/
    three/
    cocosair/

  assets/
    boat.glb
    gem.glb
    character.glb
    textures/
    audio/

  knowledge/
    K0/
      three/
      cocosair/
    K1/
      three/
      cocosair/
    K2/
      three/
      cocosair/

  reference/
    private/
      three/
      cocosair/

  harness/
    coordinator/
    runner/
    isolation/
    probes/
    visual/
    lifecycle/
    capture/
    judge/
    aggregate/

  results/
    <pair-id>/
      pair.json
      arm-a/
      arm-b/
      validation/
      blind/

  reports/
    latest/
```

注意：

```text
reference/private
```

不能挂载进 Agent 可读 workspace。

---

# 24. Pair 结果格式

示例：

```json
{
  "pairId": "PAIR-E03-K1-R02",
  "sceneId": "E03",
  "knowledge": "K1",
  "agentRevision": "...",
  "modelRevision": "...",
  "briefHash": "...",
  "arms": {
    "A": {
      "engine": "three",
      "status": "PASS",
      "rawScore": 84,
      "attainment": 0.91
    },
    "B": {
      "engine": "cocosair",
      "status": "PASS",
      "rawScore": 79,
      "attainment": 0.94
    }
  },
  "paired": {
    "rawDeltaAirMinusThree": -5,
    "attainmentDeltaAirMinusThree": 0.03
  }
}
```

---

# 25. 实施阶段

## M0 — Contract Freeze

任务：

- 固定实验定位；
- 固定不替代现有 Gate；
- 固定指标；
- 固定知识等级；
- 固定场景；
- 固定 Pair 定义；
- 固定失败分类；
- 固定统计方法。

交付：

```text
benchmark-contract.md
metric-spec.md
failure-taxonomy.md
```

DoD：

- 无关键口径歧义；
- 所有主指标公式明确；
- 明确哪些指标是 Gate，哪些是诊断。

---

## M1 — Scene Frozen Spec

任务：

- E01–E10 全部写成 Frozen Spec；
- 补充 E02 / E10 asset-driven；
- 明确资产；
- 明确生命周期；
- 明确视觉锚点；
- 明确探针；
- 明确禁止捷径。

交付：

```text
10 × brief.md
10 × spec.json
```

DoD：

每个场景都有：

```text
Goal
Effect
Asset
Interaction
Ready
Validator
Threshold
Visual
Lifecycle
Forbidden shortcut
```

---

## M2 — Dual-Engine Templates

任务：

- Three template；
- AIR template；
- package pin；
- lockfile；
- build；
- dev server；
- browser；
- common assets。

DoD：

- 两模板 fresh install / build；
- 无联网依赖；
- 无隐藏源码路径；
- 相同基础 DOM / canvas 契约。

---

## M3 — Isolation & Pair Coordinator

实现：

```text
Pair Coordinator
Fresh Session Launcher
Workspace Isolation
Browser Profile Isolation
Port Allocator
Artifact Collector
```

执行串扰测试。

Gate：

```text
ISOLATION_GATE
```

未 PASS 不进入 Agent 实验。

---

## M4 — Reference Implementations

完成：

```text
10 × Three Reference
10 × AIR Reference
```

同时建立：

```text
Engine Ceiling
Capability Availability
Reference video
Reference screenshots
```

若发现 Brief 不清晰：

```text
回 M1
修改
重新冻结版本
```

Reference 完成后不得边跑 Agent 边修改 Brief。

---

## M5 — Harness & Negative Controls

实现：

```text
build
ready
console
interaction
state
visual
motion
asset
animation
lifecycle
capture
```

执行 NC01–NC06。

Gate：

```text
HARNESS_TRUST_GATE
```

如果假实现无法被检出：

```text
BLOCKED
```

不能进入正式 Benchmark。

---

## M6 — Pilot

场景：

```text
E01
E02
E05
E10
```

知识：

```text
K0
```

执行：

```text
4 pairs
= 8 runs
```

Pilot 重点：

- Pair 启动；
- 串扰；
- Brief 清晰度；
- Agent 预算；
- validator；
- 视频；
- blind pipeline；
- failure attribution。

Pilot 后允许：

- 修 harness；
- 修实验协议；
- 修未冻结错误。

然后：

```text
freeze benchmark contract
```

---

## M7 — Core Matrix

执行：

```text
10 scenes
× K0/K1
× N=3
= 60 pairs
= 120 runs
```

运行顺序：

```text
interleaved
randomized
balanced
```

禁止：

```text
先全部 Three
再全部 AIR
```

---

## M8 — K2 Ablation

执行：

```text
4 scenes
× K2
× N=3
= 12 pairs
= 24 runs
```

重点判断：

```text
Docs
Patterns
Recipes
Examples
Skill
```

的增益。

---

## M9 — Blind Preference

执行：

- 匿名录屏；
- 匿名截图；
- unique cross comparisons；
- tie；
- Judge；
- 人工复核。

输出：

```text
visual-preference.json
judge-calibration.json
```

---

## M10 — Aggregation

计算：

```text
Engine Ceiling
Capability Availability
Agent Raw Score
Agent Attainment
Knowledge Gain
Recovery Rate
First Compile
Pair Delta
Cost Metrics
Preference
Failure Taxonomy
```

不得只输出单总分。

---

## M11 — CocosAirJS Gap Mapping

把失败映射到：

```text
Engine
API ergonomics
Docs
Pattern
Recipe
Example
Skill
Error diagnostics
Asset workflow
Shader
Postprocess
Material
Animation
Lifecycle
```

产出：

```text
cocosair-gap-map.md
roadmap-input.json
```

每个 Gap 必须关联实际 Pair / Evidence。

---

# 26. 报告结构

正式报告至少包含：

## 26.1 Baseline

```text
model
agent
engine versions
knowledge revisions
environment
brief revision
N
```

## 26.2 Product Capability

```text
Capability Availability
Engine Ceiling
```

## 26.3 Agent Capability

```text
Raw Score
Attainment
First Compile
Final Success
Recovery
```

## 26.4 Knowledge

```text
K0
K1
K2
Knowledge Gain
```

## 26.5 Visual

```text
Blind preference
BT coefficient
tie rate
```

## 26.6 Cost

```text
tokens
tools
time
build attempts
repair
```

## 26.7 Failure Domains

矩阵：

```text
scene × engine × failure
```

## 26.8 Case Studies

至少：

```text
AIR best 2
AIR worst 2
Three best 2
Three worst 2
```

必须包含：

```text
Brief
Agent trajectory
Final result
Video
Failure point
Root cause
```

## 26.9 CocosAirJS Roadmap Mapping

明确：

```text
补 Engine
补 Docs
补 Pattern
补 Recipe
补 Example
补 Skill
补 Error Diagnostics
```

而不是笼统写“优化 Agent 体验”。

---

# 27. 最终核心看板

最终至少形成以下表格。

| Domain | Three Ceiling | AIR Ceiling | Three Attainment | AIR Attainment | AIR Gap Root Cause |
|---|---:|---:|---:|---:|---|
| Procedural | | | | | |
| Asset | | | | | |
| Animation | | | | | |
| Material | | | | | |
| Shader | | | | | |
| Postprocess | | | | | |
| Interaction | | | | | |
| Lifecycle | | | | | |
| Simulation | | | | | |

以及：

| Metric | Three | AIR | Pair Delta |
|---|---:|---:|---:|
| Final Success | | | |
| First Compile | | | |
| Agent Raw | | | |
| Attainment | | | |
| Recovery | | | |
| Tokens | | | |
| Tool Calls | | | |
| Wall Time | | | |
| Visual Preference | | | |

---

# 28. 硬 Gate

正式发布实验结论前必须满足：

```text
G0 CONTRACT_FREEZE
G1 TEMPLATE_EQUIVALENCE
G2 ISOLATION
G3 REFERENCE_FEASIBILITY
G4 HARNESS_TRUST
G5 PILOT_VALIDITY
G6 CORE_MATRIX_COMPLETENESS
G7 BLIND_JUDGE_VALIDITY
G8 EVIDENCE_COMPLETENESS
```

任何关键 Gate：

```text
FAIL / BLOCKED
```

不得通过平均分掩盖。

---

# 29. Evidence

每个 Run 必须归档：

```text
source snapshot
agent log
commands
build log
console
screenshots
video
probe results
state samples
performance samples
hashes
validation json
```

每个 Pair：

```text
pair metadata
arm mapping
start timestamps
config hashes
paired metrics
blind mapping
```

禁止只保留 summary。

---

# 30. 可复现要求

必须能够：

```text
指定 pairId
→ 恢复 exact template
→ 恢复 exact package
→ 恢复 knowledge revision
→ 恢复 brief
→ 重跑 validation
→ 得到一致的判定逻辑
```

视觉像素允许存在冻结阈值内差异。

---

# 31. 执行角色建议

## Benchmark Owner

负责：

- 合同；
- 范围；
- 版本；
- 最终 Gate。

## Reference Implementer

负责：

- Reference；
- Ceiling；
- 可行性。

不得单独批准自己的视觉验收。

## Harness Engineer

负责：

- probes；
- capture；
- negative controls；
- isolation。

## Agent Runner

只负责：

- 启动 Agent；
- 收集 artifact。

不得调整评分。

## Independent Reviewer

负责：

- evidence；
- blind judge 抽检；
- failure attribution；
- final audit。

---

# 32. 推荐实施顺序

```text
M0 Contract
 ↓
M1 Frozen Scene Spec
 ↓
M2 Templates
 ↓
M3 Isolation
 ↓
M4 Reference
 ↓
M5 Harness + Negative Controls
 ↓
M6 Pilot
 ↓
Freeze Benchmark Contract
 ↓
M7 120 Core Runs
 ├──────────────┐
 ↓              ↓
M8 K2          M9 Blind Preference
 └──────┬───────┘
        ↓
M10 Aggregate
        ↓
M11 CocosAirJS Gap Mapping
```

---

# 33. 最终 DoD

本任务完成必须同时满足：

### 实验系统

- [ ] 10 个 Frozen Scene Spec 完成
- [ ] 2 套冻结模板完成
- [ ] Pair Coordinator 完成
- [ ] Session / Workspace / Browser 隔离完成
- [ ] 串扰测试 PASS
- [ ] Harness negative controls PASS

### Reference

- [ ] 20 个 Reference 完成或有正式 capability verdict
- [ ] Engine Ceiling 完成
- [ ] Capability Availability 完成
- [ ] Reference evidence 完整

### Agent

- [ ] Core 60 pairs / 120 runs 完成
- [ ] 所有 planned repetition 保留
- [ ] 无挑最好结果
- [ ] K0/K1 revision 冻结
- [ ] K2 ablation 完成或明确列为未运行

### Evaluation

- [ ] Agent Raw
- [ ] Attainment
- [ ] Knowledge Gain
- [ ] Recovery
- [ ] Pair Delta
- [ ] Visual Preference
- [ ] Cost
- [ ] Failure Taxonomy

全部可从原始 evidence 独立复算。

### CocosAirJS 回灌

- [ ] 每个核心差距已归因
- [ ] Engine gap 与 Agent DX gap 分离
- [ ] 不可实现项未被从产品能力统计中删除
- [ ] Reference 未被直接冒充 stable Example
- [ ] 输出 roadmap-input

---

# 34. 不纳入主实验但预留的扩展

## R1 — Shared Neutral Plan

同一中立规划：

```text
Neutral Plan
├── Three Executor
└── AIR Executor
```

用于测试：

```text
当设计能力被控制后，
两个引擎的实现难度差异。
```

不能混入主实验。

---

## R2 — Cross-Port

测试：

```text
Three implementation → AIR migration
AIR implementation → Three migration
```

重点关注：

> Three.js 大量现有 AI 知识能否低成本迁移到 Cocos AIR。

这是 CocosAirJS 后续非常有价值的独立 Benchmark，但不进入核心实验结论。

---

# 35. 最终项目定位

本实验正式名称建议：

```text
CocosAirJS Competitive Agent Scenario Benchmark
```

副标题：

```text
Paired Three.js vs Cocos AIR Complex-Scene Evaluation
```

其定位不是：

```text
谁的总分高谁就更好
```

而是系统回答：

```text
引擎能力上限在哪里？
Agent 实际能发挥多少？
知识建设能追回多少？
失败后是否容易恢复？
哪些差距应该补引擎？
哪些差距应该补 Agent DX？
哪些差距应该补文档 / Pattern / Recipe / Example / Skill？
```

最终要求是把实验结果转化为 CocosAirJS 可执行的产品与技术路线图，而不是仅生成一份排行榜。
