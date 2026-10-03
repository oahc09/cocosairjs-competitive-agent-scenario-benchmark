# CocosAirJS Competitive Agent Scenario Benchmark

> **Paired Three.js r186 vs Cocos AIR Complex-Scene Evaluation**
> **同一个 AI Agent 模型**(同提示词/同预算/同规格/同资产)作为恒定测量仪器,对比**两个引擎**在复杂 3D 场景上的综合能力差异——所有得分差异都归因于引擎侧:能力上限、API 易用性、文档与知识、调试体验、成本。

## 这个项目测什么(一句话)

**引擎对比实验**:唯一变量是引擎。要回答的是"换一个引擎,同一个 Agent 能做到什么程度、付出什么代价",而不是衡量 Agent 本身——Agent 是仪器,引擎是被测对象;多轮重复只是控制仪器噪声,让引擎结论更可信。

三层指标全部是引擎对比口径:

| 指标 | 白话含义 |
|---|---|
| **量尺(Reference / Engine Ceiling)** | 每个场景的"满分线":可信实现者在各引擎上能达到的上限——引擎能力的标定 |
| **达成率(Attainment)** | 该引擎的满分线,能被这台标准仪器(Agent)发挥出几成——引擎"易用性/可发挥性"的对比 |
| **知识增益(Knowledge Gain)** | 给某引擎补文档/示例后,差距能追回多少——引擎**生态建设**的对比 |

历史实验数据与结论归档:[results/reports/latest/](results/reports/latest/)(实验报告/验收报告/差距归因)。

---

## 🤖 AI Agent:零交互执行一轮(本节即完整操作书)

> **读前须知**:下面是从前置自检到终止报告的**完整状态机**,每一步都有机械化的默认动作与分支规则——
> 全程不需要问用户任何问题。仅有的两种提前退出(第 0 步前置检查失败、第 3 步无任何可用 Agent 运行时)
> 也都是"产出报告后结束",不是停下来等人指示。所有命令在**仓库根**执行,唯一入口 `node run.mjs`。
> 预算/红线/判定的权威是 RUN-CONTRACT.md 与 validate.mjs;本节与其冲突时以合同为准。
>
> 流程总览:
> `regression + ceiling-check → create → 填 RUN-META → preflight → 派发(逐 Pair,两臂并行) → collect(等待/重派) → validate → blind → Judge×2 → aggregate → 终止报告`

### 你的角色:编排者(Runner),不是 Run Agent

你负责建批次、派发、收尾与报告;**不得亲自实现任何 Arm 的场景代码**——你已读过仓库全貌,
会破坏"全新会话 + 只在 Arm 目录内工作"的仪器纯度前提。每个 Arm 必须派生一个**全新子代理**
(或独立进程)执行,那个子代理的全部世界 = 它的 Arm 目录。

### 第 0 步 前置自检(不过则带报告终止)

```bash
node run.mjs regression      # 引擎缺陷回归
node run.mjs ceiling-check   # 满分线时效性(输出 CURRENT/STALE 清单)
```

- regression 结果 **BUG≠0 → 终止**:报告 BUG 清单(引擎须先修复,否则本轮数据与历史批次不可比);
- ceiling-check 存在 **STALE → 终止**:报告 STALE 清单(须由 Reference 实现者按新正典 API 重实现并
  `node run.mjs ceiling-freeze` 换新量尺;这两件事不属于"执行一轮"的范围,不得越权自行处理);
- 两者皆过 → 进入第 1 步。

### 第 1 步 创建批次

```bash
node run.mjs round create --matrix "E01,E02,E05,E10|K0|R01"
#            场景(1-10 个) |知识级|重复号   (三段笛卡尔积 = Pair 数)
```

- **默认矩阵**(用户未指定跑什么时)即上例:4 Pair × 2 臂,与 Pilot 及历史批次同构,结果直接可比;
  用户/计划书另有指定则以其为准。核心矩阵全量 = 10 场景 × K0/K1 × 3 重复,靠多轮不同 `--matrix` 拼齐。
- 从 stdout 捕获批次号(create 输出 `[create] batch=...`;即 `results/` 下新建的
  `B-<日期>-R<当日轮次>`),下文记为 `$B`。
- 产物:`results/$B/ROUND.json`(状态机,每步自动更新)+ `results/$B/DISPATCH.md`(派发载荷)。

### 第 2 步 填写 RUN-META.json(派发前必做;缺失 → preflight BLOCKED,该 Pair 不得 validate)

对**每个 arm 目录**(`results/$B/PAIR-*/arm-a/` 与 `arm-b/`):把 `RUN-META.template.json`
复制为同目录 `RUN-META.json`,将 7 个 null 字段全部填为**非空字符串**;同一 Pair 两臂必须
**同值**——这是"同一台仪器"的机器校验点:

| 字段 | 机械填法 |
|---|---|
| `agentRuntime` | 派发运行时标识,如 `zcode-agent(subagent general-purpose)` |
| `agentBinaryHash` | 真实二进制哈希;取不到时如实写 `unavailable(原因)` |
| `modelId` | **将被派发的 Run Agent** 的模型标识(供应商+模型名,非你编排者自己的) |
| `modelRevision` | 模型修订/快照标识;不可知时如实写(如 `session-pinned`) |
| `systemPromptHash` | Run Agent 提示词版本标识(同轮同文,如 `DISPATCH-v2`) |
| `toolPolicyHash` | 工具策略标识,如 `default-tools(read/write/bash/browser)` |
| `runnerVersion` | 编排器/harness 版本,如 `run-round@<git 短哈希>` |

(可另补 `pairId` / `arm` 字段便于追溯。)

花 Agent 预算之前先做一次机检:

```bash
node run.mjs round preflight --batch $B   # 全 PASS → 第 3 步;BLOCKED → 按 reasons 修正 RUN-META 后重跑本命令
```

### 第 3 步 派发 Agent Run(唯一需要真 Agent 的环节)

- **逐 Pair 进行;同一 Pair 的两臂在同一条消息/同一时刻并行启动(时差 ≤30s)**:
  有子代理能力就并行派生两个全新子代理;没有就用任意外部 Agent CLI,同样的提示词与隔离规则;
  两者皆不可用 → **带报告终止**(说明环境缺少 Agent 运行时,已建批次保留待续)。
- 提示词 = `DISPATCH.md` 中该 Arm 代码块的**原文,一个字不改**(两臂同文、仅工作目录不同——
  这就是"同提示词"的仪器保证)。
- 每个 Run 的完成标志 = 其 Arm 目录出现 `RESULT.md`(只能由 Run Agent 自己写)。
- 单个 Run 可能耗时数十分钟(墙钟预算见各 Arm 的 RUN-CONTRACT.md)。用轮询推进:

  ```bash
  node run.mjs round collect --batch $B    # 幂等;报 completed x/总数 与 pending 清单
  ```

  - pending 的臂子代理还在跑 → 等待后重跑 collect;
  - pending 的臂子代理已死/超时 → **用同一提示词原样重派**(全新会话);禁止删改臂目录、禁止代写任何产物。
- collect 报全部就绪 → 第 4 步。

### 第 4~7 步 收尾四连(全部幂等,失败修复原因后重跑同一条命令即可续推)

```bash
node run.mjs round validate  --batch $B   # 14 步验证流水线 + 泄漏扫描 + 预算机检(唯一判定事实源;--force 强制重验)
node run.mjs round blind     --batch $B   # 生成盲评材料 + blind/JUDGE-INSTRUCTIONS.md
node run.mjs round aggregate --batch $B   # 全量聚合 → results/aggregated.json
```

**视觉分(默认要做,无需问人)**:blind 之后派 **2 个独立 Judge 子代理**(全新会话、互不可见),
输入 = `results/$B/blind/JUDGE-INSTRUCTIONS.md`(评分协议见 `docs/metric-spec.md` §18)+ 该目录下
`CMP-*/` 盲评材料。把两个 Judge 的六维总分(各 /18)**取平均**写入
`results/$B/blind/visual-scores.json`:

```json
{ "generatedAt": "<ISO 时间>", "source": "双 Judge 六维总分平均,口径 /18",
  "pairs": { "<pairId>": { "three": <数>, "cocosair": <数> } } }
```

写完**重跑一次 `round aggregate`** 即得含视觉分的最终聚合。
若运行时确实无法执行 Judge:跳过此分支直接 aggregate——该批如实标 `visualPending`,
**这不是失败**,客观分照算,日后补 Judge 再重跑 aggregate 即可。

### 第 8 步 终止报告(无论走到哪一步、正常或提前结束,都必须产出)

```bash
node run.mjs round status --batch $B      # 仪表盘:各臂状态 + 各阶段时间线
```

最终报告至少包含:批次 ID 与矩阵、preflight 结果、每臂 state 与 classification(取自
`results/$B/PAIR-*/arm-*/validate/report.json`——Agent 自检口径不算数)、两引擎客观/视觉总分对照、
异常与 pending 清单;若在第 0 步提前终止,说明终止步骤与原因。可视化入口:
`node run.mjs portal --port 7800`。

### 全程硬约束速查(全文见 AGENTS.md / 各 Arm 的 RUN-CONTRACT.md)

- 失败 trial 永不删除;判定唯一事实源 = validate.mjs 的 report.json;
- 冻结文件不可改(briefs 的 spec.json / G0 哈希合同三件套 / 已归档批次产物);不读 `reference/private/`;
- 不得为任何 Arm 代写/修补产物,不得放宽预算口径;幂等重跑 ≠ 重试造假。

---

## 目录结构

```text
run.mjs              单入口 CLI(全部操作的唯一入口)
AGENTS.md            AI Agent 上手须知(60 秒理解 + 红线 + 引擎坑速查)
docs/                BENCHMARK-PLAN(计划书)/ 合同三件套 / ARCHITECTURE / MULTI-RUN-GUIDE / MASTER-CONTEXT
config/ briefs/ templates/ knowledge/ vendor/ assets/   冻结配置与输入(规格/模板/知识包/引擎 SDK 与 tarball/资产)
harness/             round 状态机 / coordinator / validate / isolation / judge / aggregate
regression/          引擎缺陷回归套件(用例 + 版本注册表)
reference/private/   Reference 满分线(⚠️ Agent Run 禁读的答案区)+ 量尺版本账本 REFERENCE-VERSIONS.json + 对照画廊
results/             B-<日期>-R<轮次>/ 批次产物 + batches.json + aggregated.json + reports/(门户与报告)
secret/  tools/  node_modules/   串扰 marker / 构建工具 / 全局共享依赖仓(exFAT 无链接,向上解析)
```

## 关键概念(三句话)

- **批次 B-日期-轮次**:第几场考试;**量尺版本 RULER-日期-轮次**:第几版满分线(引擎/文档/规格/工具链任一变化即换新尺;同一版量尺下的所有批次分数直接可比)。
- **判定唯一事实源** = `validate.mjs` 的 report.json;Agent 自检不作数;失败 trial 永不删除。
- **git 只跟踪最小必要集**(系统 + 不可再生的运行证据 + 资产 + tarball);可再生媒体磁盘保留(gitignore 分层)。

## 克隆恢复

```bash
npm install                 # 恢复全局共享依赖仓(双引擎均来自 vendor 内置 tarball,全程离线可装)
cd harness && npm install   # harness 自身依赖(已含则跳过)
# 运行某工作区:在其目录 npm run build 重建 dist(幂等)
# 证据媒体按需再生:Reference 媒体重跑 validate(--video);盲评材料 build-blind;NC 产物 run-nc
```
