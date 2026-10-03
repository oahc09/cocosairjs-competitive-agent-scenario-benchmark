# 多轮执行指南(批次化架构)

> 2026-10-02 起生效。产物按 **触发日期 + 当日轮次** 唯一化,支持单日多轮、多日连续、多知识级并行推进。

## 1. 布局

```text
results/
  batches.json                 ← 批次索引(唯一事实源)
  B-20261002-R1/               ← 批次 = B-<YYYYMMDD>-R<当日轮次,auto 自动递增
    PAIR-<scene>-<K>-<rep>/    ← Pair(同一批次内 rep 唯一)
      pair.json  arm-a/  arm-b/
    blind/                     ← 该批次盲评材料 + judge 结果 + visual-scores.json
  aggregated.json              ← 全量聚合(所有批次,harness/aggregate/aggregate-all.mjs 产出)
  reference-ceiling.json       ← Track A(与批次无关,Reference 固定)
  _selftest/  nc/              ← 自测与负向对照(非正式批次)
```

## 2. 一轮标准流程(顺序执行,零人工干预点在验证与评分)

```bash
cd harness
# ① 建 Pair(auto-batch:今日已有批次则 R 自动 +1;端口扫描全库避免冲突;
#    workspace 默认不带 node_modules —— 依赖经 node_modules 向上解析)
node coordinator/create-pair.mjs --scene E03 --knowledge K1 --rep R01
# ② 双臂同批派发 Agent Run(编排者以同一派发提示词,仅工作目录不同;
#    提示词模板见 results/<batch>/<pair>/arm-*/RUN-CONTRACT.md)
# ③ 独立验证(串行;--video 可选)
node runner/validate.mjs --workspace ../../results/<batch>/<pair>/arm-a/workspace \
  --spec ../../briefs/<scene>/spec.json --out ../../results/<batch>/<pair>/arm-a/validation --run-id <id>
# ④ 泄漏终扫
node isolation/leak-scanner.mjs --workspace ../../results/<batch>/<pair>/arm-a --peer-arm arm-b
# ⑤ 盲评材料构建 + Judge(两轮,主题锚定)→ 写 visual-scores.json
node judge/build-blind.mjs --batch <batch> --refs
# ⑥ 全量聚合(重跑即刷新 aggregated.json;视觉分缺失的 run 标 visualPending)
node aggregate/aggregate-all.mjs
```

## 3. 依赖与磁盘(exFAT 约束)

- E: 为 exFAT,无链接可用;全局唯一共享仓 `node_modules`
  (esbuild 0.28.2 / playwright-core 1.63.0 / three 0.186.1 / cocosair.js 1.0.0-k0)。
- 所有工作区(reference 20 个、pilot 8 臂、未来 pair)一律**不带自有 node_modules**,
  `scripts/build.mjs`(模板已内建向上查找)自动解析到共享仓。
- 迁移/整体搬移时:bench/ 树整体移动即可;单独拷走某工作区将无法 build(需连带共享仓或 npm install)。

## 4. 统计口径

- 分组 = (scene × knowledge):N(≤rep 数)、Δ 中位、IQR、bootstrap CI95(2000)、W/T/L(tie=|Δ|≤3)。
- KnowledgeGain:出现 K1/K2 批次后 aggregate-all 自动输出(非 pilot pair)。
- 视觉分:批次 blind/visual-scores.json;无盲评的新批次 total=null(objectiveOnly 报告),补评后重跑聚合回填。

## 5. 门户

```bash
cd results/reports/latest && node portal-server.mjs --port 7800
```
总览 / 场景对比(Reference 或任一批次 Agent Run 实时并排运行)/ 批次与 Runs(逐臂分数据+截图/视频/report 链接)/ 报告中心(md 渲染)/ 门禁。
