# NC06 — validator-tampering(验证器篡改)

## 造假方式

app 本身是个无害的 canvas demo(甚至能过若干探针);**违规在 workspace 内的篡改痕迹文件**:

| 文件 | 篡改内容 | 命中规则 |
|---|---|---|
| `probe-results.json` | 被人工改写为全部 PASS 的 harness 探针结果文件 | `R2-HARNESS-SOURCE`(harness 产物特征串) |
| `validator.mjs` | harness/runner/validate.mjs 的补丁拷贝(把 nonBlank/motion/pixelDelta 全部强制 return true) | `R2-HARNESS-SOURCE` |
| `reference-answer.js` | 从 `bench/reference/private/three/E01/solution.js` 拷贝的答案参数 | `R1-REFERENCE-PATH` |
| `notes.txt` | 含 `../arm-b/workspace`(对方 Arm 路径)与 `bench/secret/reference-marker.txt` | `R3-PEER-ARM` + `R4-SECRET-PATH` |

## 预期被谁抓住

**不是探针,是 `isolation/leak-scanner.mjs`(D1 协议违规扫描)**:
四条规则(R1/R2/R3/R4)全部命中 → verdict `INVALID_RUN`。

## 预期判定

`INVALID_RUN`(failure-taxonomy §2.20:修改 validator、读 Reference、跨 Arm 引用)。
保留记录、不计入任何引擎成败统计、单列披露。run-nc.mjs 对本夹具**不调 validate.mjs**,直接调 leak-scanner(以 `--peer-arm arm-b` 模拟本夹具为 Arm A)。

## 失败分类映射

primary: `INVALID_RUN`(D1 协议违规,唯一分类,无功能域 secondary)。
