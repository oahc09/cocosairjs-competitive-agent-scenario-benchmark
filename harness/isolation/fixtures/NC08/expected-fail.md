# NC08 — UNKNOWN_REGION(spec 含未知 region 形式)

## 造假方式

- fixture `spec.json` 的 P1 `visualAssertion.params.region = "accretion-torus(inner)(词表外区域;disk(...) 已在整改中被合法收编,夹具随之升级)"` —— 描述性命名(带括号注记),**不在** probe-executor.mjs `LEGAL_REGION_FORMS` 封闭表内(合法形:`full` / `center:N%|lower:N%|upper:N%` / `upper-third|lower-third|center-third` / `outer-corners|center-bottom|outer-frame` / `ui#name|ui=name` / `state.<path>` / `{x,y,w,h}` / pickTarget / 数组 / `A + B`)。
- 断言类型本身(`motion`)合法 —— 缺陷被精确隔离在"region 形式"一处。
- 该形式正是 E05 类场景最容易写出的漂移(盘面区域被起了人读名字而没有归一化)。

对应 failure-taxonomy §2.21 SPEC_INVALID;严格性合同(整改 §8):unknown region 在打分 run 中判 SPEC_INVALID,**绝不**静默 fallback 到全画面(仅 diagnostic 模式允许 DIAGNOSTIC-FALLBACK,且永不作为 PASS 证据)。

## 抓捕口径(as-built,spec-audit.mjs 已由 FIX-A 建成)

```
node ../runner/spec-audit.mjs --spec <fixture>/spec.json
→ DETECTED ⇔ 退出码 3(UNSUPPORTED)
   或(本 fixture 的实际命中形态)退出码 0 + 输出含 [PARTIAL] 且命中 region 串与 LEGAL_REGION_FORMS
```

as-built 严重度契约(spec-audit.mjs 头注释):

| 漂移种类 | 审计判定 | 退出码 | 打分 run 语义 |
|---|---|---|---|
| 未知 visualAssertion.type | **UNSUPPORTED** | **3** | SPEC_INVALID |
| 未知 region 形式 | **PARTIAL**(diagnostic 全画面兜底存在) | 0 | 审计明示 "strict scoring run => SPEC_INVALID";运行时 `resolveRegions` 严格模式以 `SPEC_INVALID: unknown region` 拒绝 |

本 fixture 为纯 region 漂移 → 命中 PARTIAL 行(exit 0):
`[PARTIAL] P1 visualAssertion.region: outside LEGAL_REGION_FORMS ("accretion-torus(inner)(词表外区域;disk(...) 已在整改中被合法收编,夹具随之升级)"): diagnostic-mode full-frame fallback only (DIAGNOSTIC-FALLBACK); strict scoring run => SPEC_INVALID`
即:漂移被静态审计**抓捕并申报**,不是静默放行 —— 判 DETECTED,退出码差异如实记录。

## 佐证(auxiliary,只读可复跑)

直接调 `probe-executor.mjs` 导出的 `classifyRegionForm('accretion-torus(inner)(词表外区域;disk(...) 已在整改中被合法收编,夹具随之升级)')` → `{ok:false, unknown:['accretion-torus(inner)(词表外区域;disk(...) 已在整改中被合法收编,夹具随之升级)']}` —— 封闭表合同的机器判定。
(spec-audit 的 B 系自检亦覆盖:'hud' 严格模式 → `SPEC_INVALID: unknown region`;diagnostic:true → DIAGNOSTIC-FALLBACK 且不作 PASS 证据。)

## 失败分类映射(failure-taxonomy)

primary: `SPEC_INVALID`(§2.21;region 不可解析 → 探针不可执行)。
