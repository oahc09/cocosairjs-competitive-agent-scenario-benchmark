# NC13 — GATE_PROPAGATION(门禁状态向聚合层传播)

## 被检对象

"聚合器不得把未完成的门禁伪装成完成"。断言口径(整改 §17):

```
node ../aggregate/aggregate-all.mjs        # 真实只读聚合(批次数据只读,重算其自身产物 results/aggregated.json)
→ 解析 results/aggregated.json:
   formal.total === null 且 objective.total 非 null → DETECTED
```

## as-built 实测形态(FIX-B 聚合器)

results/aggregated.json(现行 schema)逐 pair/逐 arm 输出显式 `formal` / `objective` 段:

- `rulerStatus.g7.status = "BLOCKED"`(G7 BLIND_JUDGE_VALIDITY 未过)且 `formalImpact: "INVALID — formal total/attainment/pairedDelta 全 null,视觉分仅 provisional"`;
- 每个 arm:`formal: { total: null, attainment: null }` 而 `objective: { total: <S1+S2+S3>, attainment: … }` 非空;
- groups 标注 `basis: "objective(S1+S2+S3;G7 未过,formal 不可用)"`。

即:门禁状态(G7 BLOCKED)如实传播为 formal=null + objective 照常,不以 provisional 视觉分冒充正式总分 → **DETECTED**。

## 判定实现(run-nc 实测逻辑)

1. 备份式观测:记录执行前 `results/aggregated.json` 概要(该文件是聚合器自身的可再生产物;批次原始数据只读);
2. spawn `node ../aggregate/aggregate-all.mjs`(超时保护 120s,退出码非 0 → NOT-DETECTED 并记录);
3. 解析聚合产物(schema 自适应,三种形态按序匹配):
   - ① per-pair/per-arm `formal|objective` 段(FIX-B as-built,当前命中);
   - ② 顶层显式 `formal` 段(§17 最终形态变体);
   - ③ 旧 schema(total/objectiveOnly + pilot 标志)→ formal = 非 pilot pairs(G6 正式矩阵未跑 → null),objective = pilot 客观分非空;
4. DETECTED ⇔ formalTotal === null && objectiveTotal !== null。

## 失败分类映射(failure-taxonomy)

若传播被破坏(门禁未过却算出 formal 总分):属 harness 聚合层缺陷 → `INFRA_FAILURE`(§2.19;harness 自身错误);
传播正确时:formal=null 是 G7/G6 状态的如实申报,非失败类。
