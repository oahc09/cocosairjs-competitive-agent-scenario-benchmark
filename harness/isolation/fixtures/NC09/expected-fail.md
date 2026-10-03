# NC09 — SPEC_DRIFT(pair.json specSha256 与 spec 文件不符)

## 造假方式

- 工作区本身是**能通过验证的最小真实场景**(真像素、真状态、真 build,dry-run 干净的最小 spec)—— 缺陷不在 app。
- 缺陷在输入元数据:`pair.json.specSha256 = 448b817b…` 是 decoy 哈希,与本目录 `spec.json` 的真实哈希 `7598f756…` 不符。
  模拟两种真实事故:① 冻结 spec 被事后改动(pair-meta 未同步);② 派发时 spec 副本与 pair 登记错配。
- 对应 run-round 设计口径:"validate 报 INPUT_DRIFT/ENV_DRIFT → 该臂标 INVALID_EVIDENCE";run-round preflight ② 亦校验 `arm spec.json sha == pair.specSha256`(同一漂移的第二道网)。

## 抓捕口径(as-built,validate.mjs --pair-meta 已由集成阶段建成)

```
node ../runner/validate.mjs --workspace <fixture> --spec <fixture>/spec.json --pair-meta <fixture>/pair.json
→ 退出码 4 / guarded: INPUT_DRIFT,发生在 build/serve/浏览器之前(秒级,零浏览器成本)
```

实测:`guarded: INPUT_DRIFT -> results/nc/NC09-drift/report.json`,exit 4 —— 输入漂移前置闸门生效,不进入浏览器流水线。

## 佐证(auxiliary,只读可复跑)

run-nc 现场计算 `sha256(spec.json)` 与 `pair.json.specSha256` 对比
→ `driftConfirmed: true`(real=7598f756…≠pair=448b817b…)—— 漂移事实的独立机器证明。

## 失败分类映射(failure-taxonomy)

primary: `INVALID_RUN` 证据链口径(INPUT_DRIFT → INVALID_EVIDENCE,run 记录保留不计分);
若判定走"规格被改动"叙事则为 `SPEC_INVALID`(§2.21)—— 二者都以"不得用错配规格打分"为落点。
