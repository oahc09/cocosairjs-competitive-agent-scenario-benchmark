# CocosAirJS Competitive Agent Scenario Benchmark

> **Paired Three.js r186 vs Cocos AIR Complex-Scene Evaluation**
> **同一个 AI Agent 模型**(同提示词/同预算/同规格/同资产)作为恒定测量仪器,对比**两个引擎**在复杂 3D 场景上的综合能力差异——所有得分差异都归因于引擎侧:能力上限、API 易用性、文档与知识、调试体验、成本。

## 这个项目测什么(一句话)

**引擎对比实验**:唯一变量是引擎。要回答的是"换一个引擎,同一个 Agent 能做到什么程度、付出什么代价",而不是衡量 Agent 本身——Agent 是仪器,引擎是被测对象;多轮重复只是控制仪器噪声,让引擎结论更可信。

三层指标全部是引擎对比口径:

| 指标 | 白话含义 |
|---|---|
| **量尺(Reference / Engine Ceiling)** | 每个场景的"满分线":可信实现者在各引擎上能达到的上限——引擎能力的标定 |
| **达成率(Attainment)** | 该引擎的满分线,能被这台标准仪器(Agent)发挥出几成——引擎"易用性/可发挥性"的对比 |
| **知识增益(Knowledge Gain)** | 给某引擎补文档/示例后,差距能追回多少——引擎**生态建设**的对比 |

历史实验数据与结论归档:[results/reports/latest/](results/reports/latest/)(实验报告/验收报告/差距归因)。

---

## 🤖 AI Agent:快速执行一轮测试(端到端)

> 全程只有一个入口 `node run.mjs`(在仓库根执行)。唯一需要"真 Agent"的环节是第 ② 步;其余全部机械化、幂等、可断点续推。
> 一轮的产物按 **`results/B-<触发日期>-R<当日轮次>/`** 唯一归档(单日多轮安全)。

### ① 创建一轮(建 Pair + 生成派发清单)

```bash
node run.mjs round create --matrix "E01,E03|K1|R01"
#            场景(1-10 个) |知识级|重复号
```

产出:`results/<batch>/` 下自动创建 Pair(端口扫描防冲突、workspace 不带 node_modules——共享依赖向上解析),以及两份关键文件:
- **`ROUND.json`** — 本轮状态机(下面每步都会更新它);
- **`DISPATCH.md`** — 每个 Arm 一条**标准化派发提示词**(同轮同文,仅工作目录不同——这就是"同一台仪器"的保证)。

矩阵语法:`"E01,E02,E05|K0,K1|R01,R02,R03"` = 场景 × 知识级 × 重复(重复用于控制仪器噪声)。

### ② 执行 Agent Run(唯一的人工/AI 环节)

打开 `results/<batch>/DISPATCH.md`,按其中规则把每个 Arm 的提示词交给**全新会话**执行:同一 Pair 的两臂**同批启动(时差 ≤30s)**,Agent 只能在自己 Arm 目录内工作(RUN-CONTRACT.md 是它的冻结合同:预算、禁读满分线、禁联网、禁装依赖)。完成标志 = Arm 目录出现 `RESULT.md`。

### ③~⑥ 收尾四连(全部幂等,可反复重跑)

```bash
B=<批次ID>
node run.mjs round collect   --batch $B   # ③ 检查完成标记,报未完成清单
node run.mjs round validate  --batch $B   # ④ 独立验证(唯一判定事实源)+泄漏扫描,串行
node run.mjs round blind     --batch $B   # ⑤ 生成盲评材料+Judge 说明书(见 ⑤b)
node run.mjs round aggregate --batch $B   # ⑥ 全量聚合 → results/aggregated.json
```

- ④ 会为每个已完成且未验证的臂跑 14 步验证流水线(构建/探针/截图/录屏/fps),`--force` 可强制重验;
- **⑤b(可裁剪)**:若本轮不需要视觉分,跳过 Judge 直接 ⑥——聚合会把该批标 `visualPending`,客观分照算;需要视觉分时,派两个独立 Judge 按 `results/<batch>/blind/JUDGE-INSTRUCTIONS.md` 评分,结果写入 `blind/visual-scores.json` 后重跑 ⑥;
- 任意时刻 `node run.mjs round status --batch $B` 查看仪表盘。

### ⑦ 查看结果

```bash
node run.mjs portal --port 7800    # 门户:批次与 Runs / 场景实时对比 / 报告 / 门禁
```

### 前置检查(引擎或文档变过时必做)

```bash
node run.mjs regression            # 引擎缺陷回归:BUG≠0 先修引擎
node run.mjs ceiling-check         # 满分线是否过期:STALE 清单=需按新正典 API 重实现的 Reference
                                   # (重实现+验证后 node run.mjs ceiling-freeze 换新量尺)
```

---

## 目录结构

```text
run.mjs              单入口 CLI(全部操作的唯一入口)
AGENTS.md            AI Agent 上手须知(60 秒理解 + 红线 + 引擎坑速查)
docs/                BENCHMARK-PLAN(计划书)/ 合同三件套 / ARCHITECTURE / MULTI-RUN-GUIDE / MASTER-CONTEXT
config/ briefs/ templates/ knowledge/ vendor/ assets/   冻结配置与输入(规格/模板/知识包/tarball/资产)
harness/             round 状态机 / coordinator / validate / isolation / judge / aggregate
regression/          引擎缺陷回归套件(用例 + 版本注册表)
reference/private/   Reference 满分线(⚠️ Agent Run 禁读的答案区)+ 量尺版本账本 REFERENCE-VERSIONS.json + 对照画廊
results/             B-<日期>-R<轮次>/ 批次产物 + batches.json + aggregated.json + reports/(门户与报告)
secret/  tools/  node_modules/   串扰 marker / 构建工具 / 全局共享依赖仓(exFAT 无链接,向上解析)
```

## 关键概念(三句话)

- **批次 B-日期-轮次**:第几场考试;**量尺版本 RULER-日期-轮次**:第几版满分线(引擎/文档/规格/工具链任一变化即换新尺;同一版量尺下的所有批次分数直接可比)。
- **判定唯一事实源** = `validate.mjs` 的 report.json;Agent 自检不作数;失败 trial 永不删除。
- **git 只跟踪最小必要集**(系统 + 不可再生的运行证据 + 资产 + tarball);可再生媒体磁盘保留(gitignore 分层)。

## 克隆恢复

```bash
npm install                 # 恢复全局共享依赖仓(three 来自 registry,cocosair.js 来自 vendor 内置 tarball,离线可装)
cd harness && npm install   # harness 自身依赖(已含则跳过)
# 运行某工作区:在其目录 npm run build 重建 dist(幂等)
# 证据媒体按需再生:Reference 媒体重跑 validate(--video);盲评材料 build-blind;NC 产物 run-nc
```
