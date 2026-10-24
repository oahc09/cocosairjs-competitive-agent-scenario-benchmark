# 多轮执行指南(批次化架构)

> 2026-10-02 起生效。产物按 **触发日期 + 当日轮次** 唯一化,支持单日多轮、多日连续、多知识级并行推进。

## 1. 布局

```text
results/
  batches.json                 ← 批次索引(唯一事实源)
  B-<YYYYMMDD>-R<n>/           ← 批次 = B-<日期>-<当日轮次>,auto 自动递增(单日多轮安全)
    ROUND.json                 ← 状态机(create/preflight/dispatch/collect/validate/qualify/blind/aggregate)
    DISPATCH.md                ← 派发载荷(每臂提示词原文)
    QUALIFICATION.json         ← 证据链鉴定(round qualify 产出;core 分组资格依据)
    PAIR-<scene>-<K>-<rep>/    ← Pair(同一批次内 rep 唯一)
      pair.json  arm-a/  arm-b/   (各臂含 execution.json 时序事实源 + workspace/.budget/ 机器计数)
    blind/                     ← 该批次盲评材料 + judge 结果 + visual-scores.json
  aggregated.json              ← 全量聚合(所有批次,harness/aggregate/aggregate-all.mjs 产出)
  reference-ceiling.json       ← Track A(与批次无关,Reference 固定)
  nc/                ← 负向对照产物(非正式批次)
```

## 2. 一轮标准流程(推荐走 `node run.mjs round …` 状态机;下面给等价的底层命令)

```bash
cd harness
# ① 建 Pair(track 必须 core 才进正式统计;auto-batch:今日已有批次则 R 自动 +1;
#    端口扫描全库避免冲突;workspace 默认不带 node_modules —— 依赖经向上解析到共享仓)
node run.mjs round create --track core --matrix "E03|K1|R01"     # 或 coordinator/create-pair.mjs 直调
# ② 派发前:Runner 填 RUN-META.json(template 复制填写;两个 sha 字段可留空,preflight 真算回填)
node run.mjs round preflight --batch <batch>                      # 全 PASS 才可派发
node run.mjs round dispatch  --batch <batch>                      # 盖章两臂 dispatchAt
# ③ 双臂同批派发(时序闭环:启动前一刻 start 盖章、会话返回后 finish 盖章;execution.json = 唯一事实源)
node runtime/agent-launcher.mjs start  --arm-dir ../../results/<batch>/<pair>/arm-a
# …启动该臂 Agent 会话(DISPATCH.md 该臂提示词原文;完成后)…
node runtime/agent-launcher.mjs finish --arm-dir ../../results/<batch>/<pair>/arm-a
# ③b 每臂结束后、collect 前:toolcall 机器计数(方案A hard;行数=次数,超限如实判 BUDGET_EXHAUSTED)
node runtime/toolcall-recorder.mjs transcript --workspace ../../results/<batch>/<pair>/arm-a/workspace --from <transcript.jsonl>
# ④ collect → validate(独立验证 + 泄漏扫描 + 预算机检;单 GPU 串行 + 20s 冷却)
node run.mjs round collect  --batch <batch>
node run.mjs round validate --batch <batch>
# ⑤ 证据链鉴定 → QUALIFICATION.json(QUALIFIED 家族才进 core 正式分组)
node run.mjs round qualify  --batch <batch>
# ⑥ 盲评材料构建 + Judge(双 Judge,主题锚定)→ 写 blind/visual-scores.json
node run.mjs round blind    --batch <batch>
# ⑦ 全量聚合(重跑即刷新 aggregated.json;qualify 必须在 aggregate 前跑过)
node run.mjs round aggregate --batch <batch>
```

## 3. 依赖与磁盘(exFAT 约束)

- E: 为 exFAT,无链接可用;全局唯一共享仓 `node_modules`
  (esbuild 0.28.2 / playwright-core 1.63.0 / three 0.186.1 / cocosair.js 1.0.0-k0)。
- 所有工作区(reference 20 个、pilot 8 臂、未来 pair)一律**不带自有 node_modules**,
  `scripts/build.mjs`(模板已内建向上查找)自动解析到共享仓。
- 迁移/整体搬移时:bench/ 树整体移动即可;单独拷走某工作区将无法 build(需连带共享仓或 npm install)。
- 安装 tarball(vendor 顶层 `*.tgz`)是 sdkDir 的派生工件、git 不跟踪:缺失或换机恢复时
  `node tools/pack-engine.mjs && node tools/pack-engine.mjs --engine three` 确定性重打(sha 恒定)后再 `npm install`。

## 4. 统计口径

- 分组 = (scene × knowledge):N(≤rep 数)、Δ 中位、IQR、bootstrap CI95(2000)、W/T/L(tie=|Δ|≤3)。
- KnowledgeGain:出现 K1/K2 批次后 aggregate-all 自动输出(非 pilot pair)。
- 视觉分:批次 blind/visual-scores.json;无盲评的新批次 total=null(objectiveOnly 报告),补评后重跑聚合回填。

## 5. 门户

```bash
cd results/reports/latest && node portal-server.mjs --port 7800
```
总览 / 场景对比(Reference 或任一批次 Agent Run 实时并排运行)/ 批次与 Runs(逐臂分数据+截图/视频/report 链接)/ 报告中心(md 渲染)/ 门禁。
