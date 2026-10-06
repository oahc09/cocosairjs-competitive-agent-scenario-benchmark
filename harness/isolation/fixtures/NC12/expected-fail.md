# NC12 — BUDGET_EXHAUSTION(机器计数超冻结预算;方案 A:toolcall hard)

## 造假方式

- `.budget/*.count` 为**追加日志**(机器计数 = 非空行数,as-built 契约见 budget-check.mjs 头注释)。
- fixture 写入 `toolcall.count` **121 行**(121 次工具调用)>
  `config/agents.yaml`(G0 冻结)`agentRun.budget.maxToolCalls: 120`——方案 A(maxToolCalls=hard)下的关键负向对照;
  `build.count` 刻意保持 **2 行**(2/8 限内),保证**缺陷唯一**落在 toolcall 计数上。
- 行式与生产一致(`harness/runtime/toolcall-recorder.mjs` 写入口):首行 `session=start`、
  末行 `session=end`(参与墙钟跨度判定,30min < 90min 不误报),中间为宿主总数回退占位行
  (`tool=unrecorded note=per-call-timestamps-not-exposed-by-host`)。
- 模拟真实事故:宿主如实上报工具调用总数超限(hard 预算的真实信号,引擎侧难度数据),
  预算闸门必须拒绝并判 `BUDGET_EXHAUSTED`,不得放行。

对应 failure-taxonomy §2.16 BUDGET_EXHAUSTED("触及冻结预算上限而未达终态";典型证据 = 预算计数器达到上限的 harness 记录)。

## 抓捕口径(as-built,budget-check.mjs 已由 FIX-C 建成;toolcall 行式解析 2026-10-05 起)

```
node ../runner/budget-check.mjs --workspace <fixture>
→ [budget-check] build 2/8 … toolcall 121/120 … verdict: BUDGET_EXHAUSTED,退出码 3 即 DETECTED
```

实测:`toolcall 121/120` → `verdict: BUDGET_EXHAUSTED`,exit 3;`status` 字段别名同步输出 `BUDGET_EXHAUSTED`。

## 佐证(auxiliary,只读可复跑)

run-nc 现场解析 `config/agents.yaml` 的 `maxToolCalls` 并与 `.budget/toolcall.count` 行数比对
→ `toolcallCountOverLimit: true`(121 > 120)—— 超限事实的独立机器证明(判定与计数的双口径)。

## 失败分类映射(failure-taxonomy)

primary: `BUDGET_EXHAUSTED`(§2.16);secondary: 计数轨道为 toolCalls(方案A hard 合同),卡点域按实报计数器(secondary: TOOLCALLS)。
