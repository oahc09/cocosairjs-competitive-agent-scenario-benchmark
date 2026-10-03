# CocosAirJS Competitive Agent Scenario Benchmark

> **Paired Three.js r186 vs Cocos AIR Complex-Scene Evaluation**
> 同一 AI Agent 配置下,双引擎复杂 3D 场景的成对对照实验——分离**引擎能力上限**与 **Agent 实际发挥**,把差距归因为可执行的引擎/文档/知识路线图。

## 实验结论速览(2026-10-02 · Pilot 口径,K0 冷启动,4 pairs / 8 runs)

| 维度 | 结果 |
|---|---|
| 引擎可达性(Track A,20 个 Reference) | **双引擎 10/10 场景全 FEASIBLE**,79 探针全绿、全部 60fps;AIR 差距集中在后处理(实证不可用)与 transmission(死代码,自定义管线可兑现) |
| Agent 成对结果(Track B Pilot) | E01 **AIR 胜**(+5,超其 Reference 锚点)· E02 **Three 胜**(−25,拖拽交互校准)· E05/E10 平 |
| K0 成本不对称(派发侧客观口径) | AIR = Three 的 **2.39× 工具调用 / 3.66× token / 1.64× 墙钟**(四对全部同向;根因:小众引擎需反查 + 静默失败二分) |
| 知识增益(Track C) | K1/K2 未运行(G6 已声明,一条命令可补跑) |
| 门禁 | G0-G5/G8 PASS;G6(核心矩阵)NOT-RUN、G7(盲评偏好)BLOCKED,均如实声明未掩盖 |

完整数据:[results/reports/latest/EXPERIMENT-REPORT.md](results/reports/latest/EXPERIMENT-REPORT.md) · 验收:[ACCEPTANCE-REPORT.md](results/reports/latest/ACCEPTANCE-REPORT.md) · 差距归因:[cocosair-gap-map.md](results/reports/latest/cocosair-gap-map.md)

## 快速开始

```bash
node run.mjs guide                                    # 多轮执行指南
node run.mjs gates                                    # G0-G8 门禁状态
node run.mjs regression                               # 引擎缺陷回归套件(2 BUG 基线)
node run.mjs round create --matrix "E01,E03|K1|R01"   # 开一轮实验(auto-batch)
node run.mjs portal --port 7800                       # 报告门户(可运行产物对比)
```

## 一轮实验的闭环

```text
round create ──▶ DISPATCH.md 派发 Agent Run(外部 agent 运行时)
    ──▶ round collect ──▶ round validate(独立验证+泄漏扫描)
    ──▶ round blind ──▶ round aggregate ──▶ aggregated.json ──▶ 门户

引擎改进闭环:实验发现缺陷 → 引擎修复 → 新 tarball → regression 全绿 → 下一轮对比
```

## 目录结构

```text
run.mjs              单入口 CLI(全部操作的唯一入口)
AGENTS.md            AI Agent 上手须知(60 秒理解项目 + 红线)
docs/                计划书(BENCHMARK-PLAN)/ 合同三件套 / ARCHITECTURE / MULTI-RUN-GUIDE / MASTER-CONTEXT
config/              冻结配置(benchmark / agents / environments.yaml)
briefs/E01..E10/     冻结场景规格(brief.md + spec.json)
templates/           双引擎冻结模板(three / cocosair)
knowledge/K0-K2/     知识包(双引擎 × 三级)
vendor/              引擎 tarball + engine-versions.json(版本注册表)
assets/              共享资产(character/boat/gem.glb + 纹理音频)
harness/             round 状态机 / coordinator / validate / isolation / judge / aggregate
regression/          引擎缺陷回归套件(7 用例)
reference/private/   20 个 Reference(⚠️ Agent Run 禁读)+ 对照画廊
results/             B-<日期>-R<轮次>/ 批次产物 + batches.json + aggregated.json + reports/
secret/              牺牲性串扰 marker      tools/ 构建与迁移工具
node_modules/        全局共享依赖仓(exFAT 无链接,工作区向上解析)
```

## 关键入口

- **报告门户** http://127.0.0.1:7800 — 总览 / 场景实时对比(Reference 或任一批次 Agent Run)/ 批次数据 / 报告 / 门禁
- **Reference 对照画廊** http://127.0.0.1:7700 — 20 个上限实现双引擎并排运行
- 文档索引:`docs/ARCHITECTURE.md`(结构与触发逻辑)· `docs/MULTI-RUN-GUIDE.md`(多轮执行)· `docs/MASTER-CONTEXT.md`(全局事实源)

## 证据与版本管理策略

- git 跟踪**最小必要集**(系统 + 不可再生的 Pilot 证据:8 段录屏 + 每臂三帧,共约 56MB);
- 可再生媒体(Reference 截图/录屏、盲评材料副本、NC 产物等 ~580MB)**磁盘全保留、不入库**,再生命令见 `.gitignore` 注释与 README 克隆恢复段;
- 失败 trial 永不删除;证据链以 `runner/validate.mjs` 的 report.json 为唯一判定事实源。

## 克隆恢复

```bash
npm install                 # 恢复全局共享依赖仓(three 来自 registry,cocosair.js 来自 vendor 内置 tarball,离线可装)
cd harness && npm install   # harness 自身依赖(已含则跳过)
# 运行某工作区:在其目录 npm run build 重建 dist(幂等)
# 证据媒体按需再生:Reference 截图/录屏=重跑 validate(--video);盲评材料=build-blind;NC=run-nc
```
