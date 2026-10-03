# Metric Spec — CocosAirJS Competitive Agent Scenario Benchmark

> 文档角色:指标规格(M0 Contract Freeze 交付物 2/3)
> 版本:1.0.0 | 冻结日期:2026-10-02 | 状态:FROZEN(G0)
> 上位文件:`benchmark-contract.md`;口径来源:计划书 §2/§16/§17/§18/§19
> 所有公式在本文冻结;聚合脚本(`harness/aggregate/`)必须按本文实现,且全部主指标可从原始 evidence 独立复算。

---

## 1. Run Score(单次 Run 总分,0–100)

```text
RunScore = S1 + S2 + S3 + S4 + Visual
```

| 组成 | 满分 | 判定者 |
|---|---:|---|
| S1 可运行 | 15 | harness(自动) |
| S2 行为正确性 | 30 | harness(自动,按场景 probes) |
| S3 场景技术合同与生命周期 | 10 | harness(自动) |
| S4 代码健康 | 5 | 评审(规则化) |
| Visual 六维 | 40(round(sum×40/18)) | 盲评 Judge |

### 1.1 S1 可运行(15)

| 子项 | 分值 | PASS 判据 |
|---|---:|---|
| build 通过 | 7 | `npm run build` 退出码 0 |
| `__appReady` + 无未捕获异常 | 5 | 10s 内 `window.__appReady === true` 且 console 无未捕获异常 |
| 页面非空渲染 | 3 | 首屏截图非空(canvas 有实际像素输出,harness pixel 检查) |

S1 子项独立计分,不强制顺序依赖;但"`__appReady`"子项隐含页面已可启动。

### 1.2 S2 行为正确性(30,按场景 probes 通过率加权)

```text
S2 = round( 30 × Σ(passedProbes 的权重) / Σ(全部 probes 的权重) )
```

- 权重默认每 probe = 1;`spec.json` 的 `probes[].weight` 可显式覆盖(全部场景的权重总和在同一场景内归一);
- `spec.json` 的 `scoring.behaviorItems`(30 分细分)必须与 probe 权重一一对应,两者不一致视为 SPEC 冻结错误;
- 一个 probe 判 PASS 需同时满足:其 `stateAssertion` 通过 **且**(若声明了 `visualAssertion`)视觉断言通过;
- 关键 PASS 遵循 Independent Observable Rule:state 证据 + 至少一个 independent observable(pixel / motion / interaction / download event / DOM / asset request / lifecycle 证据)。`window.__bench` 的返回值不得作为关键事实的唯一证据。

### 1.3 S3 场景技术合同与生命周期(10)

| 子项 | 分值 | PASS 判据 |
|---|---:|---|
| 生命周期 / reset 合同 | 6 | reset 探针通过:reset 后状态恢复且场景继续正常运行(无泄漏、无残留影响);asset-driven 场景另含正确释放/重建 |
| 性能阈值 | 4 | `scaleAndPerformance` 冻结阈值达标(如 minFps 30、星点/鱼数下限),以 harness 采集的 performance sample 为准 |

### 1.4 S4 代码健康(5)

| 子项 | 分值 | PASS 判据 |
|---|---:|---|
| 结构清晰无死代码 | 3 | 模块划分合理、无大段未执行代码/注释掉的替代实现/无用文件 |
| 无明显反模式 | 2 | 无每帧重建几何/材质、无泄漏式监听器累积、无阻塞主线程的长任务等 |

S4 由评审按上述规则化标准打分;分数与理由必须留档(评审记录进 evidence)。

### 1.5 Visual(40,六维)

六维:构图取景 / 材质光影 / 动效流畅 / 特效质感 / 交互反馈 / 整体完成度。每维 0/1/2/3 分(整数)。

```text
Visual = round( (d1 + d2 + d3 + d4 + d5 + d6) × 40 / 18 )
```

- 原始和范围 0–18,映射到 0–40;
- Visual 分由 Track D 盲评体系产出(材料匿名化,engine-A/engine-B);
- 计算示例:六维得 2+2+3+2+2+3 = 14 → `round(14 × 40 / 18) = round(31.11) = 31`。

### 1.6 Run Score 计算示例

```text
某 AIR Run:S1 = 7+5+3 = 15;probes 11/13 通过 → S2 = round(30×11/13) = 25;
S3 = 6+0 = 6;S4 = 3+1 = 4;六维和 14 → Visual = 31。
RunScore = 15 + 25 + 6 + 4 + 31 = 81
```

---

## 2. 核心指标(Track A / 产品能力)

### 2.1 EngineCeiling

```text
EngineCeiling(scene, engine)
= 该场景在冻结 Brief 下,由可靠 Reference 实现所得的标准化 RunScore
```

- Reference verdict 为 `FEASIBLE` 或 `ENGINE_LIMITED` 时,其 RunScore 即 Ceiling;
- verdict 为 `ENGINE_UNAVAILABLE` 时 Ceiling 不适用(记为 UNAVAILABLE,不记 0 分);
- verdict 为 `SPEC_INVALID` 时该场景作废,回 M1 重冻结。

### 2.2 AgentRawScore

```text
AgentRawScore(run) = Agent 最终生成物通过独立验证后的 RunScore
```

- 取 Run 终态(预算耗尽或 Agent 自行停止时的最后通过验证的产物);
- INFRA_FAILURE / INVALID_RUN 的 run 不进入 RawScore 聚合(分别重跑 / 保留单列)。

### 2.3 AgentAttainment(含计算示例)

```text
AgentAttainment(scene, engine)
= AgentRawScore 中位数 / EngineCeilingComparableScore × 100%
```

- **仅当**该 scene×engine 的 Reference verdict ∈ {FEASIBLE, ENGINE_LIMITED} 时计算;ENGINE_UNAVAILABLE / SPEC_INVALID / Reference 自身失败时**不计算该项**(Agent 记 NOT_EVALUATED);
- `EngineCeilingComparableScore` = Reference 的 RunScore;若 Reference 得分为 0,Attainment 无定义,不计算;
- Attainment > 100%(Agent 超过 Reference)如实报告并加注,不做截断;
- 计算示例(计划书 §2.3 原例):

```text
Three Reference = 95, Three Agent = 86 → Attainment = 86/95 = 90.5%
AIR   Reference = 72, AIR   Agent = 67 → Attainment = 67/72 = 93.1%
解读:AIR Agent 对已有引擎能力的利用率并不低;差距主要来自 Engine Ceiling。
不得简单归因为 "AIR Agent 能力差"。
```

### 2.4 CapabilityAvailability

```text
CapabilityAvailability(engine)
= Reference 已证明可实现(FEASIBLE 或 ENGINE_LIMITED)的 required 场景数
  / 全部 required 场景数(=10)
```

- 示例:Three = 10/10 = 100%;AIR = 8/10 = 80%;
- AIR 的不可实现项(ENGINE_UNAVAILABLE):**必须计入 Product Capability Gap;不得从产品能力比较中删除;但不得污染 AgentAttainment**(见 failure-taxonomy.md §4 双口径规则)。

---

## 3. 知识指标(Track C / K0-K1-K2)

### 3.1 KnowledgeGain

```text
KnowledgeGain(engine, level)          # level ∈ {K1, K2}
= Score(engine, level) - Score(engine, K0)
```

- `Score(engine, level)` = 该 engine×level 下全部场景 RunScore 的中位数(先按场景取 N=3 中位数,再跨场景取中位数,两层均为 median);
- 场景级也可单列:`KnowledgeGain(engine, level, scene) = median_score(level, scene) - median_score(K0, scene)`;
- K1 增益覆盖 Track B 的 10 场景;K2 增益只在 Track C 的 4 场景(E02/E05/E08/E10)上计算,跨等级比较时只使用这 4 个场景的并集子集。

### 3.2 KnowledgeGainAdvantage

```text
KnowledgeGainAdvantage(level)
= AIR_KnowledgeGain(level) - Three_KnowledgeGain(level)
```

用于判断 CocosAirJS 的 Docs / Patterns / Recipes / Examples / Skill 建设是否真正改善 Agent 成功率。

---

## 4. 修复能力指标(R0/R1)

### 4.1 RecoveryRate

```text
RecoveryRate(engine)
= 首轮失败但在标准反馈预算(R1 ≤ 3 轮)内最终成功的 trials
  / 首轮失败 trials
```

- "首轮失败" = R0 终态未通过验证;
- 分母为 0 时(无首轮失败)该指标记 N/A,不得记 100%。

### 4.2 FirstCompileRate

```text
FirstCompileRate(engine)
= 首次 build 即退出码 0 的 runs / 全部有效 runs
```

### 4.3 FirstFunctionalPassRate

```text
FirstFunctionalPassRate(engine)
= 首次验证即通过全部行为 probes(S2 满分口径)的 runs / 全部有效 runs
```

- "首次验证" = 该 run 第一次 harness 验证执行(此前无任何 repair round)。

### 4.4 MedianRepairCount

```text
MedianRepairCount(engine) = median(各 run 消耗的 repair 轮数)
```

- R0 内 Agent 自我修复不计入 repairCount(那是 autonomous 行为);repairCount 只统计 R1 标准化修复轮数;R0 内的自我修复次数另行记录为 `selfFixCount`(诊断用)。

### 4.5 MedianTimeToRecovery

```text
MedianTimeToRecovery(engine) = median(首次失败检出时间戳 → 最终通过验证时间戳)
```

- 仅对"最终成功恢复"的 trials 计算;单位分钟,保留 1 位小数。

### 4.6 用途

区分两类 Agent DX:`不容易犯错`(FirstCompile/FirstFunctionalPass 高)vs `犯错后容易修复`(RecoveryRate 高、MedianRepairCount 低)。

---

## 5. 效率指标(独立报告,不入总分)

以下 8 项独立记录与报告,**不参与 RunScore**:

```text
tokens                # 模型 token 消耗
toolCalls             # 工具调用次数
wallTime              # 总耗时(分钟)
buildAttempts         # build 尝试次数
browserAttempts       # 浏览器验证尝试次数
repairCount           # R1 修复轮数
timeToFirstCompile    # 启动 → 首次 build 成功
timeToFinalPass       # 启动 → 最终通过验证
```

原因:`token ≠ wall time ≠ build cost`,压成一个分数会掩盖真实 Agent DX。若某引擎工具链本身较慢:记录真实 wall time,不临时加预算,最终报告分开解释生成时间与工具链时间。

---

## 6. Pair Metrics(主报告优先输出)

对每个 Pair(`AIR` 臂减 `Three` 臂):

```text
PairedRawDelta          = AIR_RawScore          - Three_RawScore
PairedAttainmentDelta   = AIR_Attainment        - Three_Attainment      # 百分点
PairedTokenDelta        = AIR_Tokens            - Three_Tokens
PairedToolCallDelta     = AIR_ToolCalls         - Three_ToolCalls
PairedRepairDelta       = AIR_RepairCount       - Three_RepairCount
```

- 任一侧 NOT_EVALUATED(如 AIR ENGINE_UNAVAILABLE)时,该 Pair 的 PairedAttainmentDelta 记 N/A 并单列,PairedRawDelta 仍可报告(附双口径标注);
- delta 一律 AIR − Three(负值 = Three 领先)。

### 6.1 win / tie / loss(冻结)

以 `PairedRawDelta` 为判定量,**tie threshold 冻结为 |rawDelta| ≤ 3 分**:

```text
AIR_win   : PairedRawDelta >  +3
TIE       : |PairedRawDelta| ≤ 3
Three_win : PairedRawDelta <  -3
```

- 阈值 3 分 ≈ Visual 半维(40/18≈2.2)+ 舍入余量,低于该差值的分离不具解释价值;
- 报告同时给出 win/tie/loss 计数与占比。

---

## 7. 统计规则

### 7.1 必报统计量

```text
median                # 各 engine×scene×knowledge 切片中位数
IQR                   # 四分位距(Q3 - Q1)
paired delta          # §6 全部成对差值(按 Pair)
bootstrap CI          # 95% 置信区间,2000 次重抽,percentile 法
win-tie-loss          # §6.1
failure distribution  # scene × engine × failure 矩阵
```

- bootstrap 对 **Pair** 重抽(保持成对结构),每次重抽后重算 delta,取 2.5/97.5 百分位;
- 可选补充:paired permutation、Wilcoxon signed-rank;
- **不要用单一 p-value 替代工程解释**。

### 7.2 N=3 表述纪律(冻结)

- 禁止出现"`0/3 vs 3/3 = 确定性差距`"式表述;
- N=3 的分离只能表述为 **"observed strong separation"**;
- N=3 的定位:发现方向、观察失败模式、比较 pair delta、判断是否值得加密;
- 报告中的任何结论必须附 N 与 IQR,不得隐匿样本量。

### 7.3 头条场景加密(N=5)规则(触发条件在看结果前冻结)

对某场景将 N=3 加密为 N=5,当且仅当(**AND** 关系):

```text
(|median PairedRawDelta| > 30 分 或 该场景内任一引擎的 IQR > 15 分)
AND 该场景结果被产品决策依赖
```

- 候选头条场景清单与上述阈值在查看正式结果**之前**冻结备案(写入本文件与 `config/benchmark.yaml`);
- **不能只选择对 AIR 有利的场景加密**;Three 侧同等触发的场景必须一并加密;
- 加密只增补 R04/R05 两个 pair,不改动既有 R01–R03。

---

## 8. 盲评统计(Track D)

### 8.1 比较结构

- 对每个 `scene × knowledge profile` slice:3 个 Three 输出 × 3 个 AIR 输出 = **9 unique cross-engine comparisons**(不重复配对);
- 每个 comparison:A/B 播放顺序随机;允许 tie;**至少 2 次独立 judge pass**;
- 两次 pass 结论不一致时:记录 disagreement,追加第 3 次决定性 pass,以 2/3 多数为该 comparison 结论(前两次仍全部留档)。

### 8.2 主统计量

```text
Preference Win Rate   # engine 视角:win / (win + loss + tie),tie 单列
Tie Rate              # tie / total comparisons
Bradley-Terry coefficient
95% CI                # bootstrap 2000 次重抽
```

- Bradley-Terry 拟合于全部 unique comparisons;tie 采用 Davidson 扩展处理;若实现不可用,退化为 tie 各计 0.5 胜(退化方式必须在报告中声明);
- BT 系数报告 log-strength 尺度及其指数化后的偏好胜率,并附 bootstrap CI。

### 8.3 人工抽检与 disagreement 冻结阈值

- 人工复核抽样量 ≥ 全部 judge 判定的 **10%**;
- **disagreement 阈值冻结为 > 20%**:人工复核与 Judge 结论(judge 双 pass 多数结论)不一致的比例超过 20% 时,`G7 BLIND_JUDGE_VALIDITY = BLOCKED`,必须重新校准 Judge 后重评,不得带病出数。

### 8.4 匿名化硬约束

盲评材料(录屏/截图)中不得出现:engine name、package name、path、source code、console、logo;只允许 `engine-A` / `engine-B` 标识。

---

## 9. Gate 指标 vs 诊断指标

| 类别 | 指标 |
|---|---|
| **Gate 硬门禁**(直接判定实验有效性) | G0–G8 判据本身(合同哈希、模板等价、隔离、Reference 可行性、负控制、Pilot 有效性、矩阵完整度、盲评有效性、证据完整度) |
| **主指标**(报告必列) | EngineCeiling、AgentRawScore、AgentAttainment、CapabilityAvailability、KnowledgeGain(Advantage)、RecoveryRate、FirstCompileRate、FirstFunctionalPassRate、PairedRawDelta(+win/tie/loss)、Preference Win Rate、Tie Rate、BT coefficient、failure distribution |
| **诊断指标**(单列解释,不做排名) | 效率 8 项(§5)、MedianRepairCount、MedianTimeToRecovery、selfFixCount、PairedTokenDelta、PairedToolCallDelta、PairedRepairDelta |

---

## 10. 聚合纪律

- 不得只输出单总分;最终看板必须含计划书 §27 的 Domain 表与 Metric 表;
- 所有主指标可从原始 evidence 独立复算(G8);
- NOT_EVALUATED / N/A 项单列说明原因,不得以 0 分填充后混入均值。
