# NC07 — SPEC_UNSUPPORTED_ASSERTION(spec 含未知断言类型)

## 造假方式

- fixture `spec.json` 的 P1 `visualAssertion.type = "motionBlur"` —— 形似合法(易被当作 `motion` 的变体),但**不在封闭词表**(probe-executor.mjs `VISUAL_ASSERTION_TYPES`;整改 §8:"unknown 绝不允许 fallback→PASS")。
- 其余字段合法:action/stateAssertion 均可解析 —— 缺陷被精确隔离在"断言类型"一处。

对应 failure-taxonomy §2.21 SPEC_INVALID("探针无法执行/验收不可操作"),归因于**规格本身**而非引擎;判定路径在 D2 之前(规格不可执行 → 该 run 不得进入打分)。

## 抓捕口径(as-built,spec-audit.mjs 已由 FIX-A 建成)

```
node ../runner/spec-audit.mjs --spec <fixture>/spec.json
→ 退出码 3(UNSUPPORTED required assertion)即 DETECTED
```

实测(as-built 契约):未知 type 判 **UNSUPPORTED** → `exit code 3 — UNSUPPORTED required assertion(s) present — scoring runs will classify SPEC_INVALID`
(同一 type 漂移连带使其 params 键失去意义,审计对 `minLitPixelRatio` 给出 unknown params key 判定,均为同根缺陷)。

## 佐证(auxiliary,只读可复跑)

`node ../runner/probe-executor.mjs --dry-run --spec <fixture>/spec.json`
→ 退出码 1,报告含 `unknown type motionBlur` —— 运行时严格性合同**同样**拒绝该断言(绝不 fallback→PASS)。

## 失败分类映射(failure-taxonomy)

primary: `SPEC_INVALID`(§2.21;探针断言不可执行)。
