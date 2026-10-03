# Benchmark Contract — CocosAirJS Competitive Agent Scenario Benchmark

> 文档角色:实验合同(M0 Contract Freeze 交付物 1/3)
> 版本:1.0.0 | 冻结日期:2026-10-02 | 状态:FROZEN(G0)
> 上位文件:`bench/docs/MASTER-CONTEXT.md`、计划书 `CocosAirJS-Agent-双引擎对照实验-完整任务计划书.md`
> 姊妹文档:`metric-spec.md`(指标规格)、`failure-taxonomy.md`(失败分类与归因)
> 本文件哈希已录入 `bench/gates/G0.json`;修改任一冻结条款必须重新走 G0。

---

## 0. 实验正式名称与定位

### 0.1 正式名称

```text
CocosAirJS Competitive Agent Scenario Benchmark
副标题:Paired Three.js vs Cocos AIR Complex-Scene Evaluation
```

### 0.2 定位

在同一 AI Agent 配置下,对 Three.js r186 与 Cocos AIR(cocosair.js 1.0.0)做复杂 3D 场景**成对对照实验**,分离:

1. **Engine Ceiling** — 引擎能力上限(Reference 可达);
2. **Agent Attainment** — Agent 对引擎能力的实际利用率;
3. **Knowledge Gain** — Docs/Patterns/Recipes/Examples/Skill 建设收益;
4. **Repairability** — 失败后定位、修复、恢复的难易;
5. **Product Capability Gap** — 来自引擎本身而非 Agent 的差距。

最终产出是 **CocosAirJS 可执行的产品与技术路线图输入**,不是引擎排行榜。任何"谁总分高谁更好"式结论均不在本实验交付范围。

### 0.3 与既有体系的关系(保留,不替换)

本实验是独立的 `Cross-Engine Scenario Benchmark`,与 CocosAirJS 既有质量体系并存:

```text
CocosAirJS Existing Quality System(全部保留,本实验不改动其合同)
        ├── Engine Gate
        ├── Agent Gate
        ├── 100+ capability Benchmark
        ├── Recipe Gate
        ├── Example / Gallery Gate
        └── API Coverage Gate
```

既有体系验证"正确性 / API / 生命周期 / 能力点";本实验验证"复杂任务综合竞争力 / Agent 友好度 / 产品能力上限"。优秀 Reference / Agent 产物只作为 Example / Recipe **候选**,必须重新经过独立 Frozen Spec + Validator + Evidence 才允许晋升 stable。

### 0.4 禁止的替换关系(逐条冻结,违反任一条即实验无效)

1. **不得**用本实验 10 个复杂场景替代现有 100+ Agent Benchmark。
2. **不得**用综合平均分替代 Engine Gate / Agent Gate 的硬门禁。
3. **不得**将 Benchmark Reference 直接计为 stable Example。
4. **不得**因 AIR 某场景不可实现(ENGINE_UNAVAILABLE)而从产品能力比较中删除该场景。
5. **不得**让 Three 与 AIR 两侧 Agent 看到对方代码、日志、思路、浏览器状态或结果。
6. **不得**用同一个 Conversation 同时修改两个引擎工程。

### 0.5 本实验不回答的问题

运行时极限性能排名、人类开发者主观体验、编辑器生态、原生平台能力、Creator 编辑器能力、底层 GFX/Rendering API 性能、单 API 正确性完整覆盖 — 上述仍由对应既有 Gate / Benchmark 负责。

---

## 1. 实验 Tracks 与规模矩阵

### Track A — Engine Ceiling

| 项 | 值 |
|---|---|
| 执行者 | Human / trusted Reference Implementer(可读引擎源码与 docs) |
| 矩阵 | 10 scenes × 2 engines = **20 References** |
| 产物 | 可解性证明、Ceiling 分、引擎能力缺口记录、validator 校准、Brief 校准、Example 候选 |
| 存放 | `bench/reference/private/{three,cocosair}/E*/`(永不被 Agent Run 读到) |

每个 Reference 必须给出正式 verdict:`FEASIBLE` / `ENGINE_LIMITED` / `ENGINE_UNAVAILABLE` / `SPEC_INVALID`(定义见 failure-taxonomy.md §3)。

### Track B — Paired Agent Scenario(主实验)

```text
10 scenes × 2 knowledge levels (K0/K1) × N=3 pairs
= 60 pairs = 120 Agent runs
```

运行顺序:interleaved / randomized / balanced。禁止先跑完全部 Three 再跑 AIR。

### Track C — Knowledge Ablation

```text
4 scenes(E02, E05, E08, E10) × K2 × N=3 pairs
= 12 pairs = 24 runs
```

用于确认 Full Agent Knowledge(Patterns + Recipes + Examples + Skill)的价值。

### Track D — Blind Preference

对同一 `scene × knowledge profile` 下的 Three/AIR 输出做盲评:

- 每 slice:3 个 Three 输出 × 3 个 AIR 输出 = **9 unique cross-engine comparisons**;
- 每个 comparison:A/B 顺序随机、允许 tie、**至少 2 次独立 judge pass**;
- 人工抽检:至少 **10%** 抽样复核;
- 主统计:Preference Win Rate、Tie Rate、Bradley-Terry coefficient、Confidence Interval;
- Judge 与人工 disagreement > **20%**(冻结阈值)→ `G7 BLIND_JUDGE_VALIDITY = BLOCKED`,必须重新校准 Judge;
- 盲评材料匿名化:只出现 `engine-A` / `engine-B`,不得出现 engine name、package name、path、source code、console、logo。

### Pilot(M6 前置,不计入 Track B 统计)

```text
E01 / E02 / E05 / E10 × K0 × 1 pair = 4 pairs = 8 runs
```

Pilot 验证:Pair 启动、串扰、Brief 清晰度、Agent 预算、validator、视频、blind pipeline、failure attribution。Pilot 后允许修 harness / 实验协议 / 未冻结错误,然后正式 freeze benchmark contract。

### 总量汇总

| Track | Pairs | Runs |
|---|---:|---:|
| Pilot | 4 | 8 |
| B | 60 | 120 |
| C | 12 | 24 |
| A(Reference) | — | 20 |
| D(盲评 comparisons/slice) | 9/slice | — |

---

## 2. Pair — 基本统计单元

### 2.1 正式定义(12 项要素,全部同时满足)

```text
Pair =
  1. 同一 Brief(同一 briefId + briefVersion + briefHash)
  2. 同一 Agent Revision(agentBinaryHash 相同)
  3. 同一 Model Revision(modelId + modelRevision 相同)
  4. 同一 Knowledge Level(同一 knowledgeProfile)
  5. 同一 Budget(budgetConfigHash 相同)
  6. 同一 Asset Set(assetSetHash 相同)
  7. 两个独立 Fresh Session(各 Arm 独立会话)
  8. 两个独立 Workspace(目录隔离)
  9. 两个独立 Browser Profile(存储隔离)
 10. 近同时启动(startTimeDelta ≤ 30s,超出必须记录并标记)
 11. 独立验证(各 Arm 由 harness 独立验证,互不共享证据)
 12. 成对统计(主报告以 paired delta 为先,见 metric-spec.md)
```

命名示例:`PAIR-E03-K1-R02` = 场景 E03、知识等级 K1、第 2 次重复。

Arm 与引擎的映射按 §2.3 随机化,不绑定 runner slot。

### 2.2 "同一个 Agent"的正式定义

"同一个 Agent"表示两侧均满足:

```text
相同 Agent 程序版本
相同模型
相同系统提示
相同 tool policy
相同预算
相同操作能力
相同执行协议
```

**不表示**同一个 Conversation。禁止 `Conversation ├── /three └── /cocosair` 结构 — 第二侧会获得第一侧的场景拆解、Shader 思路、算法选择、Bug 经验、UI 结构、调试结论。正确方式:

```text
Pair Coordinator
      ├── Fresh Session A → Three workspace
      └── Fresh Session B → AIR workspace
```

### 2.3 启动同步与 Arm 随机化

- `startTimeDelta ≤ 30s`,优先真正并行;无法同时启动时必须记录实际时间戳,超出阈值标记,不得隐瞒顺序差异。
- A/B runner slot 不绑定固定引擎,采用平衡分配(R1 A=Three B=AIR;R2 A=AIR B=Three;交替),降低 runner slot bias / launch order bias / worker bias。

### 2.4 资源规则(单机 worker)

- 开发阶段:两 Arm 可同时运行,但必须隔离 workspace、process tree、browser profile、dev server port、temp、localStorage、IndexedDB、Service Worker、logs、artifact path。
- 正式性能采样 / 录屏验证:共用 GPU/主机时**禁止同时测**,必须随机顺序串行(Pair 1: Three→AIR;Pair 2: AIR→Three)。原因:GPU/CPU contention、video encoding、browser scheduling、thermal/memory pressure 会污染 FPS 与录屏。若未来使用两台经过校准的等价 worker,允许并行验证,但必须记录 worker identity 与环境 hash。

### 2.5 本环境隔离声明(如实降级)

本环境的文件隔离为**策略级**:依靠 prompt 约束(禁读清单写入 Agent 系统提示)+ 事后产物扫描(日志与产物中检索违规访问痕迹)实施,**不是 OS 强制隔离**(无沙箱/容器/ACL 级强制)。隔离报告中必须如实按此降级声明,不得声称 OS 级强制。配套的牺牲性串扰测试(§5 G2)用于实证策略级隔离的实际效果。

---

## 3. Immutable Pair Configuration

每个 Pair 必须记录以下**全部**字段(缺一即 Pair 无效);写入 `results/<pair-id>/pair.json`:

```text
# 标识
pairId
sceneId
knowledgeProfile          # K0 | K1 | K2
repetition                # R01, R02, ...

# Agent / 模型(两侧必须相同)
agentBinaryHash
modelId
modelRevision
systemPromptHash
toolPolicyHash

# 输入(两侧必须相同)
briefHash
assetSetHash
budgetConfigHash

# 引擎侧(两侧仅这三组允许不同)
threePackageHash
airPackageHash
threeKnowledgeHash
airKnowledgeHash
threeTemplateHash
airTemplateHash

# 环境
nodeVersion
packageManagerVersion
browserVersion
os
gpu
graphicsBackend

# 执行
startTimestampA
startTimestampB
workerA
workerB
```

规则:

- Pair 两侧除 `engine package`、`engine-specific knowledge package`、`engine template` 三组外原则上必须相同;
- **配置漂移必须使 Pair 失效或单列**(不得静默纳入统计);
- 所有 hash 一律 SHA-256;时间戳 ISO-8601;JSON 2 空格缩进。

---

## 4. 知识等级(K0/K1/K2)

### 4.1 K0 — Cold

| 允许 | 禁止 |
|---|---|
| package | 额外官方 Docs |
| README | Patterns |
| `.d.ts` | Recipes |
| 项目模板本身 | Examples |
| — | Skill |
| — | 联网搜索 |

回答的问题:现实冷启动状态下 Agent 能做到什么。

### 4.2 K1 — Official Docs

| 允许 | 禁止 |
|---|---|
| K0 全部 | 直接对应当前 Benchmark 场景的答案型 Example |
| Official API docs | Benchmark Reference |
| Concept docs | 私有 validator |
| Engine-specific basic patterns | 针对当前任务写的 Recipe |

回答的问题:正常官方文档面能否显著提升成功率。

### 4.3 K2 — Full Agent Knowledge

| 允许 | 防止 |
|---|---|
| K1 全部 | 直接包含当前 Brief 的完成代码 |
| Patterns | — |
| Stable Recipes | — |
| Stable Examples | — |
| Agent Skill / Knowledge Package | — |

回答的问题:CocosAirJS 后续 Agent Knowledge 体系是否真正成为竞争优势。

### 4.4 知识包工程事实

- AIR 本地 tarball(`<ROOT>/vendor/cocosair.js-1.0.0.tgz`)的 `files` 字段包含 `docs/`:
  - **K0 版 tarball 必须剔除 `docs/` 后重打包**;
  - **K1 版含 docs**;
  - 以 `knowledge/*/manifest.json` 为准。

### 4.5 知识公平原则与 Domain Coverage Matrix

公平性不再仅以 `token 数量 ±20%` 为唯一依据。必须为每个知识等级建立 **Domain Coverage Matrix**,逐域对照两引擎知识包覆盖情况:

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

规则:

- 某域 AIR 没有能力时,**不得**通过加入"如何伪造效果"的答案文档来补齐;
- limitation documented 是合法状态(如实记录引擎边界),answer-type document 是非法状态;
- Matrix 随知识包一起冻结,哈希进入 `airKnowledgeHash` / `threeKnowledgeHash`。

---

## 5. 硬 Gate(G0–G8)

正式发布实验结论前必须全部 PASS。任何关键 Gate FAIL/BLOCKED **不得通过平均分掩盖**。每个 Gate 的判定脚本/证据写入 `<ROOT>/gates/<G#>.json`。

| Gate | 名称 | PASS 判据(可执行、可取证) | 证据 |
|---|---|---|---|
| **G0** | CONTRACT_FREEZE | 六个合同/配置文件(`docs/benchmark-contract.md`、`docs/metric-spec.md`、`docs/failure-taxonomy.md`、`config/benchmark.yaml`、`config/agents.yaml`、`config/environments.yaml`)存在,SHA-256 已录入 `gates/G0.json`,且重算一致 | `gates/G0.json` + 重算命令输出 |
| **G1** | TEMPLATE_EQUIVALENCE | 两模板(three/cocosair)在离线环境 fresh install + `npm run build` 退出码 0;lockfile pin;`index.html` 满足统一 DOM/canvas 契约(引 `dist/app.js`、暴露 `__appReady`/`__bench`);产物扫描无隐藏引擎源码路径 | build 日志 + 契约探针输出 |
| **G2** | ISOLATION | 双向 workspace 泄漏测试(marker 互不可见);浏览器存储(localStorage/sessionStorage/IndexedDB/CacheStorage/Service Worker/cookies/profile)不共享;dev server 独立端口且不互访;牺牲性 marker `/secret/reference-marker.txt` 任一侧可读即 FAIL | 隔离测试 JSON;**必须包含策略级(非 OS 强制)降级声明** |
| **G3** | REFERENCE_FEASIBILITY | 20 个 Reference 全部完成或有正式 verdict;无未解决 SPEC_INVALID;Brief 与资产冻结(hash 记录);Reference 完成后 Brief 未再修改 | Reference verdict 表 + hashes |
| **G4** | HARNESS_TRUST | NC01 Empty Renderer / NC02 Frozen Animation / NC03 Fake Asset Loaded / NC04 Broken Interaction / NC05 Lifecycle Leak 全部按预期 FAIL;NC06 Validator Tampering 被检出并判 INVALID_RUN | 负控制运行日志 |
| **G5** | PILOT_VALIDITY | 4 个 Pilot pair 完成;每个 pair 的 startTimeDelta 已记录(≤30s 或已标记);failure attribution 已应用;harness/协议修复后合同已重新冻结 | Pilot pair 记录 + 修订后 G0 |
| **G6** | CORE_MATRIX_COMPLETENESS | Track B 60 pairs / 120 runs 与 Track C 12 pairs / 24 runs 全部存在且 `pair.json` 字段完整;repetition 无缺失;Arm 分配平衡;运行顺序 interleaved 有据;失败/INVALID trial 全部保留(无删除) | results 索引扫描脚本输出 |
| **G7** | BLIND_JUDGE_VALIDITY | 盲评材料匿名化检查通过(无 engine name/package/path/code/console/logo);每个 unique comparison ≥2 次独立 judge pass;≥10% 人工抽样;judge 与人工 disagreement ≤ 20%(超过即 BLOCKED) | `visual-preference.json` + `judge-calibration.json` |
| **G8** | EVIDENCE_COMPLETENESS | 每个 Run 归档齐全(source snapshot、agent log、commands、build log、console、screenshots、video、probe results、state samples、performance samples、hashes、validation json);每个 Pair 归档齐全(pair metadata、arm mapping、start timestamps、config hashes、paired metrics、blind mapping);全部主指标可从原始 evidence 独立复算 | evidence 审计脚本报告 |

---

## 6. 里程碑(M0–M11)与推荐顺序

| 里程碑 | 内容 | 出口 Gate |
|---|---|---|
| M0 | Contract Freeze:定位、指标、知识等级、场景、Pair 定义、失败分类、统计方法全部固定 | G0 |
| M1 | Scene Frozen Spec:E01–E10 `brief.md` + `spec.json`,asset-driven 补充(E02/E10),探针与禁止捷径 | — |
| M2 | Dual-Engine Templates:模板、package pin、lockfile、build、dev server、browser、共享资产 | G1 |
| M3 | Isolation & Pair Coordinator:Coordinator、Fresh Session Launcher、Workspace/Browser Profile 隔离、Port Allocator、Artifact Collector + 串扰测试 | G2 |
| M4 | Reference Implementations:10×Three + 10×AIR;建立 Engine Ceiling / Capability Availability / 视觉锚点;发现 Brief 不清晰则回 M1 重冻结 | G3 |
| M5 | Harness & Negative Controls:build/ready/console/interaction/state/visual/motion/asset/animation/lifecycle/capture + NC01–NC06 | G4 |
| M6 | Pilot:E01/E02/E05/E10 × K0 = 4 pairs;修 harness/协议/未冻结错误后 freeze benchmark contract | G5 |
| M7 | Core Matrix:10 × K0/K1 × N=3 = 60 pairs / 120 runs(interleaved、randomized、balanced) | G6 |
| M8 | K2 Ablation:4 scenes × K2 × N=3 = 12 pairs / 24 runs | G6 |
| M9 | Blind Preference:匿名录屏/截图、unique comparisons、tie、Judge、人工复核 | G7 |
| M10 | Aggregation:全部指标计算,不得只输出单总分 | G8 |
| M11 | CocosAirJS Gap Mapping:失败映射到 Engine/API ergonomics/Docs/Pattern/Recipe/Example/Skill/Error diagnostics/Asset workflow/Shader/Postprocess/Material/Animation/Lifecycle,产出 `cocosair-gap-map.md` + `roadmap-input.json`,每个 Gap 关联实际 Pair/Evidence | G8 |

推荐执行顺序(计划书 §32):

```text
M0 → M1 → M2 → M3 → M4 → M5 → M6 → Freeze → M7 → {M8 ∥ M9} → M10 → M11
```

约束:

- Reference 完成后不得边跑 Agent 边修改 Brief(修改必须回 M1 重新冻结并重跑受影响 Reference);
- 禁止删除失败 trial;Invalid Run 保留记录;
- 不得只选择对 AIR 有利的场景做 N=5 加密(加密规则见 metric-spec.md §8.3)。

---

## 7. 角色

| 角色 | 职责 | 红线 |
|---|---|---|
| Benchmark Owner | 合同、范围、版本、最终 Gate | — |
| Reference Implementer | Reference、Ceiling、可行性 | 不得单独批准自己的视觉验收 |
| Harness Engineer | probes、capture、negative controls、isolation | — |
| Agent Runner | 只启动 Agent、收集 artifact | **不得调整评分**、不得给提示、不得扩预算 |
| Independent Reviewer | evidence、盲评抽检、failure attribution、final audit | — |

---

## 8. 变更控制

- 本合同自 G0 起冻结。Pilot(M6)后允许的修订仅限 harness 缺陷、实验协议缺陷、未冻结错误,修订后必须重新执行 G0 并更新版本号。
- 任何指标公式、tie 阈值、N=5 触发条件、disagreement 阈值的修改,都必须在查看正式结果之前完成;事后修改一律无效并须在报告中披露。
