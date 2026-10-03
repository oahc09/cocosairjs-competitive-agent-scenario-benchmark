# RUN-CONTRACT — Arm B of PAIR-E01-K0-R01(NC11 fixture,精简版)

> fixture 用冻结契约片段:仅保留 preflight ④ 所解析的 §2 预算表,数值与 pair.json 冻结预算一致(120/90/8/6)。

## 2. 预算(冻结,两引擎一致,不临时追加)

| 项 | 上限 |
|---|---|
| 工具调用次数 | 120 |
| 墙钟时间 | 90 分钟 |
| build 尝试次数 | 8 |
| 浏览器验证尝试次数 | 6 |

触及任一上限即终止 Run,判 `BUDGET_EXHAUSTED`。
