# DISPATCH — 批次 B-20261004-R01 的 Agent Run 任务清单

> 执行者:任意 AI Agent 运行时(或人)。规则:同一 Pair 的两臂**同批启动**(时差 ≤30s,记录实际时间);
> 每个 Arm 用**全新会话**执行下列提示词(仅工作目录不同);执行期间禁止读取 bench/ 其余目录;
> 派发前:Runner 把各 Arm 目录的 RUN-META.template.json 复制为 RUN-META.json 并填写全部身份字段
> (两臂同值,engine/knowledge 除外)—— run-round 的 preflight stage 会校验,缺失/BLOCKED 的 Pair 不得 validate;
> 全部臂完成后运行 `node harness/round/run-round.mjs --batch ${round.batchId} --stage collect`。

## PAIR-E01-K0-R01
### arm-a(`results\B-20261004-R01\PAIR-E01-K0-R01\arm-a`)
```
你是双引擎对照实验中的一个 Agent Run。你的唯一任务指令:严格执行工作目录中的 RUN-CONTRACT.md。

工作目录:E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark\results\B-20261004-R01\PAIR-E01-K0-R01\arm-a

流程:先读 RUN-CONTRACT.md 全文(身份/预算/白名单/红线/完成合同/日志/交付),再读同目录 brief.md 与 spec.json,
然后在 workspace/ 内实现场景、自检、写 WORKLOG.md 与 RESULT.md。预算与红线以合同为准。
这是一次性 R0 自主模式:尽力交付满足完成合同的完整实现。
```

### arm-b(`results\B-20261004-R01\PAIR-E01-K0-R01\arm-b`)
```
你是双引擎对照实验中的一个 Agent Run。你的唯一任务指令:严格执行工作目录中的 RUN-CONTRACT.md。

工作目录:E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark\results\B-20261004-R01\PAIR-E01-K0-R01\arm-b

流程:先读 RUN-CONTRACT.md 全文(身份/预算/白名单/红线/完成合同/日志/交付),再读同目录 brief.md 与 spec.json,
然后在 workspace/ 内实现场景、自检、写 WORKLOG.md 与 RESULT.md。预算与红线以合同为准。
这是一次性 R0 自主模式:尽力交付满足完成合同的完整实现。
```

## PAIR-E05-K0-R01
### arm-a(`results\B-20261004-R01\PAIR-E05-K0-R01\arm-a`)
```
你是双引擎对照实验中的一个 Agent Run。你的唯一任务指令:严格执行工作目录中的 RUN-CONTRACT.md。

工作目录:E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark\results\B-20261004-R01\PAIR-E05-K0-R01\arm-a

流程:先读 RUN-CONTRACT.md 全文(身份/预算/白名单/红线/完成合同/日志/交付),再读同目录 brief.md 与 spec.json,
然后在 workspace/ 内实现场景、自检、写 WORKLOG.md 与 RESULT.md。预算与红线以合同为准。
这是一次性 R0 自主模式:尽力交付满足完成合同的完整实现。
```

### arm-b(`results\B-20261004-R01\PAIR-E05-K0-R01\arm-b`)
```
你是双引擎对照实验中的一个 Agent Run。你的唯一任务指令:严格执行工作目录中的 RUN-CONTRACT.md。

工作目录:E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark\results\B-20261004-R01\PAIR-E05-K0-R01\arm-b

流程:先读 RUN-CONTRACT.md 全文(身份/预算/白名单/红线/完成合同/日志/交付),再读同目录 brief.md 与 spec.json,
然后在 workspace/ 内实现场景、自检、写 WORKLOG.md 与 RESULT.md。预算与红线以合同为准。
这是一次性 R0 自主模式:尽力交付满足完成合同的完整实现。
```
