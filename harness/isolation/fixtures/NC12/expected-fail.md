# NC12 — BUDGET_EXHAUSTION(机器计数超冻结预算)

## 造假方式

- `.budget/build.count` 为**追加日志**(每次 `npm run build` 追加一行 ISO 时间戳;机器计数 = 非空行数,as-built 契约见 budget-check.mjs 头注释)。
- fixture 写入 **9 行**(9 次 build 尝试)> `config/agents.yaml`(G0 冻结)`agentRun.budget.maxBuildAttempts: 8`。
- 模拟真实事故:harness 机器计数器如实累计到上限之外(Agent 继续要求重试 / 计数滞后补记),预算闸门必须拒绝并判 `BUDGET_EXHAUSTED`,不得放行第 9 次 build。
- 时间戳跨度刻意压在 6 分钟内(< 90 分钟),保证**缺陷唯一**落在 build 计数上,不引入 walltime 误报;其余计数器不放置。

对应 failure-taxonomy §2.16 BUDGET_EXHAUSTED("触及冻结预算上限而未达终态";典型证据 = 预算计数器达到上限的 harness 记录)。

## 抓捕口径(as-built,budget-check.mjs 已由 FIX-C 建成)

```
node ../runner/budget-check.mjs --workspace <fixture>
→ [budget-check] build 9/8 … verdict: BUDGET_EXHAUSTED,退出码 3 即 DETECTED
```

实测:`build 9/8` → `verdict: BUDGET_EXHAUSTED`,exit 3。

## 佐证(auxiliary,只读可复跑)

run-nc 现场解析 `config/agents.yaml` 的 `maxBuildAttempts` 并与 `.budget/build.count` 行数比对
→ `countOverLimit: true`(9 > 8)—— 超限事实的独立机器证明(判定与计数的双口径)。

## 失败分类映射(failure-taxonomy)

primary: `BUDGET_EXHAUSTED`(§2.16);secondary: 卡点域(BUILD 轨道的计数,secondary: BUILD)。
