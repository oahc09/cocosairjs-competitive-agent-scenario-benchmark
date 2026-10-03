# NC10 — RULER_DRIFT(Reference 量尺漂移自检)

## 被检对象

"量尺账本不得静默沿用旧版本"。`reference-versions.mjs --selftest-drift` 自检模式注入受控漂移
(改 briefSha / specSha / validatorProtocolHash 等),验证账本逻辑对四输入(引擎/文档/Brief/工具链/协议)变化给出
正确判定(STALE 需重实现 / NEEDS_REVALIDATION 需重验),而不是误报 CURRENT。

## 抓捕口径(as-built,--selftest-drift 已由集成阶段建成)

```
node ../aggregate/reference-versions.mjs --selftest-drift
→ 输出含 PASS 即 DETECTED
```

实测(as-built 契约):

```
  ok   改 briefSha               -> STALE                语义=["briefSha"] 协议=[]
  ok   改 specSha                -> STALE                语义=["specSha"] 协议=[]
  ok   改 validatorProtocolHash  -> NEEDS_REVALIDATION   语义=[] 协议=["validatorProtocolHash"]
SELFTEST-DRIFT PASS(改 briefSha/specSha → STALE 需重实现;改 validatorProtocolHash → NEEDS_REVALIDATION 需重验;三者均非 CURRENT)
```

注入的漂移全部被识别(无一项被误判 CURRENT)→ PASS → DETECTED。

## 安全护栏(run-nc 侧,仍然有效)

reference-versions.mjs 默认冻结模式会**写** `reference/private/REFERENCE-VERSIONS.json`(禁改目录)——
run-nc 的就绪探测为静态源码扫描(`'selftest-drift'` 分支存在才运行);`--check` 模式只读,作为 auxiliary 现状观测
(当前账本 ruler 与 CURRENT/STALE 概览,非 NC 判定口径)。

## 失败分类映射(failure-taxonomy)

primary(若漂移被误判 CURRENT,属 harness 缺陷): `INFRA_FAILURE`(§2.19;harness 自身错误);
被正确识别时对受影响 Reference 的处置:STALE → 重实现 + `ceiling-freeze` 升版换新 RULER(量尺版本原则),非失败类。
