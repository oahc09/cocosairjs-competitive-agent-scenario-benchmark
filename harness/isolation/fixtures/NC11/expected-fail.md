# NC11 — AGENT_IDENTITY_MISSING(Arm 身份元数据缺失)

## 造假方式

- fixture 是一个最小 Pair 目录形态(`PAIR-E01-K0-R01/`):
  - `pair.json`:`specSha256` = briefs/E01/spec.json 的真实哈希(`5ed6b649…`),预算 = 冻结值(120/90/8/6)—— **这部分是干净的**;
  - `arm-a/spec.json` = briefs/E01/spec.json 的逐字节拷贝(冻结副本哈希一致 → preflight ② 不会因 drift 误报);
  - `arm-a/RUN-CONTRACT.md`、`arm-b/RUN-CONTRACT.md`:§2 预算表两臂一致且与 pair.json 一致 → preflight ④ 不会误报;
  - **缺陷(唯一)**:`arm-a/RUN-META.json` 身份字段缺失 —— `agentBinaryHash: null`、`modelId: ""`(空串)、`systemPromptHash: null`;
  - `arm-b/RUN-META.json` 全部身份字段非空(健康对照臂)。
- 即:测量仪器(Agent)身份不可追溯 —— 该 Pair 的一切分数无法归因到"同一台恒定仪器",违反 RUN-CONTRACT 身份段与 agents.yaml runner 职责条款。

## 预期被谁抓住(集成阶段口径)

```
node ../../round/run-round.mjs --batch <batch> --stage preflight   #(--round-out 演练重定向可用)
→ 该 Pair preflight = BLOCKED,reasons 含:
   "arm-a: RUN-META.agentBinaryHash 为空"
   "arm-a: RUN-META.modelId 为空"
   "arm-a: RUN-META.systemPromptHash 为空"
   (BLOCKED 的 Pair 不得 validate;validate stage 开头会自动复跑 preflight)
```

- 工具:`harness/round/run-round.mjs` preflight stage(FIX-C;**代码已在库**,但按整改分工本 NC 的 run-nc 接线归集成阶段 → 本轮 `mode: PENDING-INTEGRATION`,不算失败)。

## 本轮(run-nc)状态

- `mode: PENDING-INTEGRATION`(设计如此:身份缺失属 run 编排层(run-round preflight)职责,不在 run-nc 的隔离工具链内)。
- 佐证(auxiliary,只读):run-nc 静态确认 `run-round.mjs` 已实现 preflight 且字段集含 `agentBinaryHash/modelId/systemPromptHash`,并逐字段比对 fixture 两臂 RUN-META,给出 `defectFields` 清单 —— 集成阶段重跑即得 BLOCKED 证据。

## 失败分类映射(failure-taxonomy)

primary: `INVALID_RUN`(§2.20;证据链身份不可追溯,记录保留、不计统计、单列披露)。
