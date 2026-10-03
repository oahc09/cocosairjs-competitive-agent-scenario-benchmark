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

---

## 🤖 AI Agent:快速执行一轮测试(端到端)

> 全程只有一个入口 `node run.mjs`(在仓库根执行)。唯一需要"真 Agent"的环节是第 ② 步;其余全部机械化、幂等、可断点续推。
> 一轮的产物按 **`results/B-<触发日期>-R<当日轮次>/`** 唯一归档(单日多轮安全)。

### ① 创建一轮(建 Pair + 生成派发清单)

```bash
node run.mjs round create --matrix "E01,E03|K1|R01"
#            场景(1-10 个) |知识级|重复号
```

产出:`results/B-20261003-R1/` 下自动创建 Pair(端口扫描防冲突、workspace 不带 node_modules——共享依赖向上解析),以及两份关键文件:
- **`ROUND.json`** — 本轮状态机(下面每步都会更新它);
- **`DISPATCH.md`** — 每个 Arm 一条**标准化派发提示词**(同轮同文,仅工作目录不同)。

矩阵语法:`"E01,E02,E05|K0,K1|R01,R02,R03"` = 场景 × 知识级 × 重复(即计划书核心矩阵的一角)。

### ② 执行 Agent Run(唯一的人工/AI 环节)

打开 `results/<batch>/DISPATCH.md`,按其中规则把每个 Arm 的提示词交给**全新会话**执行:同一 Pair 的两臂**同批启动(时差 ≤30s)**,Agent 只能在自己 Arm 目录内工作(RUN-CONTRACT.md 是它的冻结合同:预算 120 工具调用/90 分钟、禁读 reference、禁联网、禁装依赖)。完成标志 = Arm 目录出现 `RESULT.md`。
参考耗时/成本(Pilot 实测):每臂 15~40 分钟、2M~18M tokens。

### ③~⑥ 收尾四连(全部幂等,可反复重跑)

```bash
B=<批次ID>   # 例如 B-20261003-R1
node run.mjs round collect   --batch $B   # ③ 检查完成标记,报未完成清单
node run.mjs round validate  --batch $B   # ④ 独立验证(唯一判定事实源)+泄漏扫描,串行
node run.mjs round blind     --batch $B   # ⑤ 生成盲评材料+Judge 说明书(见 ⑤b)
node run.mjs round aggregate --batch $B   # ⑥ 全量聚合 → results/aggregated.json
```

- ④ 会为每个已完成且未验证的臂跑 14 步验证流水线(构建/探针/截图/录屏/fps),`--force` 可强制重验;
- **⑤b(可裁剪)**:若本轮不需要视觉分,跳过 Judge 直接 ⑥——聚合会把该批标 `visualPending`,客观分照算;需要视觉分时,派两个独立 Judge 按 `results/<batch>/blind/JUDGE-INSTRUCTIONS.md` 评分,把结果写入 `blind/visual-scores.json` 后重跑 ⑥;
- 任意时刻 `node run.mjs round status --batch $B` 查看仪表盘。

### ⑦ 查看结果

```bash
node run.mjs portal --port 7800    # 门户:批次与 Runs / 场景实时对比 / 报告 / 门禁
```

### 前置检查(引擎或文档变过时必做)

```bash
node run.mjs regression            # 引擎缺陷回归:BUG≠0 先修引擎
node run.mjs ceiling-check         # 量尺漂移:STALE 清单=需按新正典 API 重实现的 Reference
                                   # (重实现+验证后 node run.mjs ceiling-freeze 开新纪元)
```

---

## 目录结构

```text
run.mjs              单入口 CLI(全部操作的唯一入口)
AGENTS.md            AI Agent 上手须知(60 秒理解 + 红线 + 引擎坑速查)
docs/                BENCHMARK-PLAN(计划书)/ 合同三件套 / ARCHITECTURE / MULTI-RUN-GUIDE / MASTER-CONTEXT
config/ briefs/ templates/ knowledge/ vendor/ assets/   冻结配置与输入(规格/模板/知识包/tarball/资产)
harness/             round 状态机 / coordinator / validate / isolation / judge / aggregate
regression/          引擎缺陷回归套件(7 用例 + 版本注册表)
reference/private/   20 个 Reference(⚠️ Agent Run 禁读的答案区)+ 纪元账本 REFERENCE-VERSIONS.json + 对照画廊
results/             B-<日期>-R<轮次>/ 批次产物 + batches.json + aggregated.json + reports/(门户与报告)
secret/  tools/  node_modules/   串扰 marker / 构建工具 / 全局共享依赖仓(exFAT 无链接,向上解析)
```

## 关键概念(三句话)

- **批次 B-日期-轮次**:第几次测 Agent;**纪元 EP-日期-轮次**:第几版量尺(引擎/文档/Brief/工具链四输入任一变化即升纪元,同纪元所有批次共用同一 Reference 分母)。
- **判定唯一事实源** = `validate.mjs` 的 report.json;Agent 自检不作数;失败 trial 永不删除。
- **git 只跟踪最小必要集**(~56MB:系统 + 不可再生的 Pilot 证据 + 资产 + tarball);~580MB 可再生媒体磁盘保留(gitignore 分层)。

## 克隆恢复

```bash
npm install                 # 恢复全局共享依赖仓(three 来自 registry,cocosair.js 来自 vendor 内置 tarball,离线可装)
cd harness && npm install   # harness 自身依赖(已含则跳过)
# 运行某工作区:在其目录 npm run build 重建 dist(幂等)
# 证据媒体按需再生:Reference 媒体重跑 validate(--video);盲评材料 build-blind;NC 产物 run-nc
```
