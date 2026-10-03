# Failure Taxonomy — CocosAirJS Competitive Agent Scenario Benchmark

> 文档角色:失败分类与归因规则(M0 Contract Freeze 交付物 3/3)
> 版本:1.0.0 | 冻结日期:2026-10-02 | 状态:FROZEN(G0)
> 口径来源:计划书 §10.1 / §20 / §21;MASTER-CONTEXT §7
> **枚举穷举、封闭**:分类器只能从下列 21 项中选择,不得自创类别。每 Run 判定恰好 1 个 primary category(根因)+ 0..n 个 secondary tag(佐证)。

---

## 1. 枚举总览(21 项,顺序与计划书 §20 完全一致)

```text
# Agent 侧功能/过程失败(16)
API_HALLUCINATION  TYPE_ERROR          LIFECYCLE_MISUSE  ASSET_PIPELINE
ANIMATION          SCENE_GRAPH         SHADER            POSTPROCESS
MATERIAL           INTERACTION         STATE_MANAGEMENT  PERFORMANCE
BUILD              RUNTIME             REPAIR_EXHAUSTED  BUDGET_EXHAUSTED

# 引擎侧(2)
ENGINE_LIMITED     ENGINE_UNAVAILABLE

# 环境/元(3)
INFRA_FAILURE      INVALID_RUN         SPEC_INVALID
```

---

## 2. 逐项定义(定义 / 典型证据 / 判别规则)

### 2.1 API_HALLUCINATION

- **定义**:Agent 调用了引擎中不存在的 API,或使用了与真实签名不符的虚构方法/属性/枚举。
- **典型证据**:build 或 .d.ts 检查报"不存在导出";运行时 `xxx is not a function` 出现在引擎命名空间上;引用了该版本引擎没有的类/参数。
- **判别**:对照 `.d.ts` / package 实际导出可证 API 不存在 → 本类;API 存在但参数类型用错 → TYPE_ERROR;API 存在但引擎明确无法达成该效果(Reference 佐证)→ ENGINE_LIMITED/ENGINE_UNAVAILABLE。

### 2.2 TYPE_ERROR

- **定义**:对**真实存在**的 API 传错类型/形状/数量,或对未初始化对象取属性,导致类型类运行时错误。
- **典型证据**:`TypeError`(undefined/null 读取、参数非法)且涉及的 API 在 .d.ts 中存在;错误随输入而稳定复现。
- **判别**:先核对 API 存在性:存在 → 本类;不存在 → API_HALLUCINATION;由生命周期顺序错误引起(对象已销毁仍使用)→ LIFECYCLE_MISUSE。

### 2.3 LIFECYCLE_MISUSE

- **定义**:创建/启用/销毁/重置顺序错误,资源泄漏,或 reset 合同不成立。
- **典型证据**:销毁后对象/监听器/worker 仍影响场景(NC05);reset 后状态未恢复或场景异常;重复创建导致累积泄漏;`__bench.reset()` 副作用不干净。
- **判别**:强调**时序与资源管理**错误;纯层级/变换摆错 → SCENE_GRAPH;reset 合同属 S3 生命周期子项,证据归本类;帧率因泄漏劣化但功能在 → 仍判本类(secondary: PERFORMANCE)。

### 2.4 ASSET_PIPELINE

- **定义**:资产(GLB/纹理等)加载、解析、路径或消费失败。
- **典型证据**:资产请求 404/解析异常;状态声称 loaded 但模型不可见或资源未真正消费(NC03);材质/贴图在加载后丢失。
- **判别**:失败发生在**资产进入场景之前**;资产正常载入后骨骼/动画问题 → ANIMATION;材质观感错误 → MATERIAL。

### 2.5 ANIMATION

- **定义**:动画剪辑不播放、混合/过渡错误、时间倍率错误、蒙皮错误。
- **典型证据**:motion 探针失败(画面静止但状态称 playing,NC02);clip 切换无效;8x 倍率后角速度未变;蒙皮撕裂。
- **判别**:前置条件是资产已正确加载(否则 ASSET_PIPELINE);动画系统正常但状态机切换逻辑错 → STATE_MANAGEMENT;由销毁/重建时序引发 → LIFECYCLE_MISUSE。

### 2.6 SCENE_GRAPH

- **定义**:层级、父子关系、变换或坐标系错误。
- **典型证据**:对象位置/缩放/朝向系统性错误;父子绑定后变换不联动;local/world 坐标混用导致漂移。
- **判别**:结构/变换问题;拾取命中错误目标是**交互映射**问题 → INTERACTION;节点时序性增删引发 → LIFECYCLE_MISUSE。

### 2.7 SHADER

- **定义**:自定义 shader 编译/链接失败,或 shader 数学错误导致渲染错误。
- **典型证据**:console 出现 shader compile/link 错误;画面纯黑/花屏且可溯源到自定义 shader;uniform 未绑定。
- **判别**:失败定位在**自定义 shader 代码内**;引擎内置材质参数错误 → MATERIAL;后处理链路问题 → POSTPROCESS;引擎根本没有所需 shader 能力(Reference 佐证)→ ENGINE_LIMITED。

### 2.8 POSTPROCESS

- **定义**:后处理链配置/使用错误,或以错误方式模拟缺失的后处理效果。
- **典型证据**:辉光/Bloom 要求未达成且链路报错;composer 顺序错误导致画面异常;用不透明贴片"伪造"辉光被视觉锚点判 FAIL。
- **判别**:问题在**渲染后链路**;shader 本身编译失败 → SHADER;引擎在冻结能力边界内无法提供该后处理(Reference 同样做不到)→ ENGINE_LIMITED/ENGINE_UNAVAILABLE。

### 2.9 MATERIAL

- **定义**:材质参数、贴图、光照响应(PBR 等)配置错误(使用引擎内置材质能力)。
- **典型证据**:应为金属/折射观感实为纯色漫反射;法线/粗糙度贴图未生效;双引擎同 Brief 下观感显著低于视觉锚点且非 shader/后处理问题。
- **判别**:使用**内置材质**却配错 → 本类;自定义 shader 写错 → SHADER;资产内材质丢失 → ASSET_PIPELINE。

### 2.10 INTERACTION

- **定义**:拾取、点击、拖拽、滚轮、按键无响应或映射错误。
- **典型证据**:点击探针无 state 变化且无像素变化(NC04);拾取命中错误对象;双击/拖拽语义与 Brief 相反。
- **判别**:输入链路问题;交互后**状态值**错误但视觉响应正确 → STATE_MANAGEMENT;交互目标层级摆错 → SCENE_GRAPH。

### 2.11 STATE_MANAGEMENT

- **定义**:应用状态机/业务状态维护错误(模式切换、速度倍率、日夜状态等)。
- **典型证据**:stateAssertion 失败而渲染/交互链路本身正常;速度档位切换后状态字段与实际行为不一致;模式互相踩踏。
- **判别**:状态**逻辑**错误;状态是由错误交互写入 → INTERACTION;reset 无法恢复状态 → LIFECYCLE_MISUSE。

### 2.12 PERFORMANCE

- **定义**:功能实现但低于冻结性能/规模阈值。
- **典型证据**:performance sample 低于 minFps(如 30fps);星点/鱼群数量低于规模下限;帧时间抖动超阈值。
- **判别**:**能用但不够快/不够大**;页面崩溃/白屏 → RUNTIME;因每帧重建等反模式导致 → 本类(primary)+ S4 扣分佐证。

### 2.13 BUILD

- **定义**:在 build 预算内从未获得一次成功构建。
- **典型证据**:全部 build 尝试退出码非 0;语法/模块解析错误从未解决。
- **判别**:终态卡在构建阶段;build 成功但页面崩 → RUNTIME;因预算耗尽而停止 → BUDGET_EXHAUSTED(primary)+ BUILD(secondary)。

### 2.14 RUNTIME

- **定义**:build 通过,但页面运行时崩溃、未捕获异常或无法就绪。
- **典型证据**:console 未捕获异常;`__appReady` 10s 内未置真;页面白屏/空渲染。
- **判别**:build=通过 是前置;异常可归因到更具体功能域时,该域为 primary(如 shader 编译异常 → SHADER),本类用于无法细分的运行时失败。

### 2.15 REPAIR_EXHAUSTED

- **定义**:R0 终态失败,且 R1 的 3 轮标准化修复全部耗尽仍未通过。
- **典型证据**:R1 round1–3 反馈-修复日志齐全,终态验证仍 FAIL。
- **判别**:是**修复轨道的终态分类**;根因功能域记为 secondary(如 REPAIR_EXHAUSTED + SHADER);未进入 R1 即失败 → 按功能域直接分类。

### 2.16 BUDGET_EXHAUSTED

- **定义**:触及冻结预算上限(maxToolCalls / maxWallTime / maxBuildAttempts / maxBrowserAttempts)而未达终态。
- **典型证据**:预算计数器达到上限的 harness 记录;wall time 超时截断日志。
- **判别**:因**资源耗尽**停止;修复轮耗尽 → REPAIR_EXHAUSTED;预算耗尽时的卡点域记 secondary。

### 2.17 ENGINE_LIMITED

- **定义**:Reference 证明场景可实现,但存在明确引擎能力天花板(如 AIR 无法真实 Bloom,只能近似视觉手段)。Reference verdict。
- **典型证据**:Reference verdict = ENGINE_LIMITED,附文档化 limitation;Ceiling 分真实反映差距;场景保留在统计中。
- **判别**:由 **Reference**(非 Agent run)判定;Agent 侧同类失败在 Reference 可行的前提下不得判本类;引擎完全做不到 → ENGINE_UNAVAILABLE。

### 2.18 ENGINE_UNAVAILABLE

- **定义**:Reference 证明该 required 结果在冻结能力边界内不可实现。Reference verdict。
- **典型证据**:Reference verdict = ENGINE_UNAVAILABLE + 可复现调查记录(缺失 API/管线,且无合法近似路径)。
- **判别**:必须以 Reference 证据为准,不得凭 Agent 失败推测;双口径处理见 §4;两侧 Reference 都做不出且原因在 Brief/资产/验收 → SPEC_INVALID。

### 2.19 INFRA_FAILURE

- **定义**:实验环境自身故障。**仅限五种情形**(计划书 §21.3):浏览器无法可信启动;fixture hash 损坏;worker 故障;harness 自身错误;主机异常。
- **典型证据**:Playwright 启动失败日志;fixture sha256 校验不一致;worker 进程死亡;harness 代码栈错误;断电/重启记录。
- **判别**:**不得把引擎实现 bug 包装成 INFRA**;引擎 bug 属 Engine Failure 路径;判 INFRA 后允许重跑,原记录保留。

### 2.20 INVALID_RUN

- **定义**:违反实验协议的 run。例:读取 Reference、读取另一 Arm、修改 validator、突破文件隔离、跨 trial 污染(NC06)。
- **典型证据**:日志中出现对禁读路径的访问;validator/harness 文件 hash 变化;跨 workspace 文件引用;产物扫描命中违规模式。
- **判别**:**保留原记录,不得删除**;不得通过删除失败 trial 提高成功率;INVALID_RUN 不计入任何引擎成败统计,单列披露。

### 2.21 SPEC_INVALID

- **定义**:两侧 Reference 都无法可靠实现,且原因来自 Brief 歧义、资产错误、验收不可操作或环境缺陷。
- **典型证据**:两位 Reference Implementer 独立记录同一不可操作点;资产校验失败;探针无法执行。
- **判别**:归因于**规格本身**而非引擎;必须修改 Brief 后重新冻结版本,该场景已跑的 Agent runs 作废重排。

---

## 3. 归因决策树(按顺序判定,先命中先停)

```text
D0. fixture / harness 自检
    fixture hash 损坏、harness 自身错误、浏览器无法启动、worker 故障、主机异常?
    ├─ 是 → INFRA_FAILURE(允许重跑;原记录保留)
    └─ 否 ↓

D1. 协议违规扫描(日志 + 产物扫描)
    读 Reference / 读另一 Arm / 改 validator / 破隔离 / 跨 trial 污染?
    ├─ 是 → INVALID_RUN(保留记录;不计入统计;单列披露)
    └─ 否 ↓

D2. Reference verdict(该 scene × engine)
    ├─ SPEC_INVALID        → 场景作废,回 M1 重冻结 Brief;相关 Agent runs 作废重排
    ├─ ENGINE_UNAVAILABLE  → Product Capability Gap 计缺口;
    │                        Agent 记 NOT_EVALUATED(不计算 Attainment,不判 Agent FAIL)
    └─ Reference 复验失败  → Engine Failure(引擎真实回归);
      (有效环境中)          Agent 记 NOT_EVALUATED,不得算 Agent 失败

D3. Reference PASS(FEASIBLE / ENGINE_LIMITED)→ 判 Agent 结果
    ├─ 触及预算上限而未达终态        → BUDGET_EXHAUSTED
    ├─ 从未成功 build               → BUILD
    ├─ build 过但运行时崩溃/未就绪    → RUNTIME(可细分则细分)
    ├─ 进入 R1 且 3 轮耗尽仍失败     → REPAIR_EXHAUSTED(+根因 secondary)
    ├─ 功能域失败(按 D4 选 primary) → API_HALLUCINATION / TYPE_ERROR /
    │                                 LIFECYCLE_MISUSE / ASSET_PIPELINE / ANIMATION /
    │                                 SCENE_GRAPH / SHADER / POSTPROCESS / MATERIAL /
    │                                 INTERACTION / STATE_MANAGEMENT / PERFORMANCE
    └─ 全部通过                      → PASS(无失败类别)
```

D4 功能域 primary 选择:取**最终未通过验证中最早出现且未被他因解释**的根因;同时存在多域失败时,选阻断 S2/S3 权重最大者的根因,其余记 secondary tag。

---

## 4. 双口径规则(ENGINE_UNAVAILABLE)

```text
Product Capability 口径:
  ENGINE_UNAVAILABLE 场景 → 计入 Product Capability Gap
  (CapabilityAvailability 分母保持 = 全部 10 个 required 场景,不得删除)

Agent Attainment 口径:
  ENGINE_UNAVAILABLE 场景 → Agent 记 NOT_EVALUATED
  不计算 AgentAttainment(不以 0 分填充后混入均值/中位数)
  不判 Agent FAIL(引擎给不出能力时,不能归责 Agent)
```

同理适用于 D2 的 Reference 复验失败(Engine Failure):Agent 记 NOT_EVALUATED,不污染 AgentAttainment 与 Agent 成功率;但与 ENGINE_UNAVAILABLE 不同,Engine Failure 需先修复/确认引擎版本后重跑 Reference 与受影响 Pairs。

---

## 5. 分类器实现要求

- 分类判定必须基于归档 evidence(console、build log、probe results、state samples、hash 校验、产物扫描),不得凭印象;
- 每次 FAIL 判定输出:`{ runId, primary, secondary[], evidenceRefs[], decidedBy, decidedAt }`;
- 分类规则如有修订,必须在查看正式结果前冻结;事后修订须全量重分类并披露;
- failure distribution 报告:`scene × engine × failure` 矩阵(计划书 §26.7),INVALID_RUN 与 INFRA_FAILURE 单列,不与 Agent 功能失败混排。
