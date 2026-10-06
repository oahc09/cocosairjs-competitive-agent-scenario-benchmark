# 事件报告(撤回):B-20261005-R03 非 rogue batch —— 并行编排会话的正当批次

> **本报告初版(2026-10-05)将 R03 误判为本会话 E02 arm-a 子代理越界自建的幽灵批次,并执行了
> 处置(目录改名 INVALID-rogue-* / batches.json 移除 / R02-E02 连带 DISQUALIFIED)。
> 该归因有误,处置已全部回滚。本文件保留完整审计链。**

## 误判过程
- 聚合核对发现 E01 K0 组 n=2(同一 pairId 双 delta)→ 排查 batches.json 发现 R03 非本会话所建
- 时间线巧合:R03 createdAt(08:02:17Z)落于本会话 E02-a 子代理会话窗口末端(07:32→08:03:52Z)→ 误定为行为者
- 按"违反即 INVALID_RUN"执行了处置

## 反证(回滚依据)
1. R03 内 E02 arm 的 tool_uses=125>120(其 QUALIFICATION 记 BUDGET_EXHAUSTED)——本会话 E02 双臂
   实际为 45/86 次,对不上;R03 四臂产物非本会话任何子代理所出
2. 并行编排会话的工作记忆明确记载:R03 = 其"Core Sanity"批次(E01 全链 QUALIFIED、
   E02 PARTIAL、Owner 裁决 trial 原样保留),且 Owner 已授权其 G5 判据精化
3. 结论:R03 = **另一并行会话对本仓库同时进行编排**(同一 Owner 目标驱动),auto-batch 递增
   (R03 目录存在)使两会话批次未冲突,但 pairId 撞名(R01/R02/R03 均含 PAIR-E01-K0-R01 等)

## 已执行的回滚(全部幂等可复现)
1. `INVALID-rogue-B-20261005-R03` → 改回 `results/B-20261005-R03`(证据原样)
2. batches.json 恢复 R03 条目(附来源注记)
3. R02 QUALIFICATION.json:E02 status 恢复 QUALIFIED(撤销 DISQUALIFIED 后处理,撤回理由写入 note 字段)
4. 重跑 aggregate 刷新分层

## 真正的问题与 Owner 待决
- **单仓库并发编排冲突**:两会话同矩阵同 rep 并行,双倍 Agent 开销且 pairId 撞名
  (统计上 n 会含两会话的同 rep 对,需按 batchId 区分来源)
- 后续建议:Owner 指定单一编排会话,或按批次分段认领切片(如 A 会话 S1-S6 / B 会话 S7-S12)
