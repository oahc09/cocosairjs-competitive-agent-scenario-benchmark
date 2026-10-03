# ARCHITECTURE — 优化后的框架结构与触发逻辑

> v2(2026-10-03)。面向两类使用者:**外部 AI Agent**(执行多轮测试)与**引擎开发者**(持续改进 CocosAirJS)。
> 单入口:`node run.mjs <命令>`;目录物理布局保持 v1 兼容(脚本按相对路径解析,不做搬迁)。

## 1. 目录结构(优化后)

```text
<仓库根>/
  run.mjs                     ← ★ 单入口 CLI(round/validate/blind/aggregate/ceiling/regression/portal/gates/guide)
  node_modules/               ← 全局共享依赖仓(exFAT 约束;一切工作区向上解析)
  docs/                       合同与指南(MASTER-CONTEXT / benchmark-contract / metric-spec / failure-taxonomy / MULTI-RUN-GUIDE / 本文件)
  config/                     冻结配置(benchmark/agents/environments.yaml)
  briefs/E01..E10/            冻结场景规格(brief.md + spec.json,哈希在 index.json)
  templates/{three,cocosair}/ 双引擎冻结模板(canonical node_modules;coordinator 默认不拷依赖)
  knowledge/K0|K1|K2/         知识包(双引擎 × 三级,manifest+九域矩阵)
  vendor/                     引擎资产:<engine>/<版本>/ SDK 正典目录(含源码/docs)+ 安装用 tarball + engine-versions.json(双引擎版本注册表)
  assets/                     共享资产(GLB/纹理/音频 + MANIFEST)
  harness/
    round/run-round.mjs       ← ★ 轮次状态机(create→dispatch→collect→validate→blind→aggregate→status,幂等)
    coordinator/create-pair.mjs   建 Pair(auto-batch / 端口扫描注册表 / 共享依赖)
    runner/validate.mjs           独立验证(唯一判定事实源)+ score/brief-freeze
    isolation/                    串扰测试 + NC01-06 + leak-scanner
    judge/build-blind.mjs         盲评材料构建(通用批次版)
    aggregate/aggregate-all.mjs   全量聚合(aggregated.json)+ reference-ceiling
  regression/                 ← ★ 引擎缺陷回归套件(cases/ + run-regression.mjs + README)
  reference/private/          20 个 Reference(Agent 永不可读)+ 画廊 + DEDUP-NOTE
  results/
    batches.json              批次索引
    B-<YYYYMMDD>-R<nn>/       批次产物(ROUND.json 状态机 + PAIR-*/ + blind/ + DISPATCH.md)
    aggregated.json           全量聚合结果
  results/reports/latest/             门户(portal-server.mjs + index.html)+ 报告(md/json)
```

## 2. 触发逻辑(外部 AI Agent 执行多轮)

**核心设计:一轮 = 一个批次目录 + 一个 ROUND.json 状态文件;所有阶段幂等、可断点续推;唯一外部依赖 = 按 DISPATCH.md 执行 Agent Run(需要 agent runtime)。**

```text
外部 Agent(或人)                    bench 机械化部分
─────────────────                   ───────────────────────────────────────────
node run.mjs round create      ───▶ coordinator 建 Pair(auto-batch:当日 R 自动+1;
  --matrix "E01,E02|K1|R01"         端口扫描防冲突;workspace 无 node_modules)
                                    ⮕ results/B-<date>-R<n>/{ROUND.json, DISPATCH.md}

按 DISPATCH.md 逐 Pair 派发    ◀─── DISPATCH.md:每臂一条标准化提示词(同轮同文,
(两臂同批启动,时差≤30s;               仅工作目录不同 = "同一个 Agent"保证)
 新会话执行)

node run.mjs round collect     ───▶ 扫描各臂 RESULT.md 完成标记 → 汇报 pending
  --batch <id>
node run.mjs round validate    ───▶ 对完成未验臂串行 validate(--video)+ leak-scan,
  --batch <id>                       结果写回 ROUND.json(verdict/leakScan)
node run.mjs round blind       ───▶ build-blind 生成匿名材料 + JUDGE-INSTRUCTIONS.md
  --batch <id>                       (Judge 评分后落 visual-scores.json)
node run.mjs round aggregate   ───▶ aggregate-all → results/aggregated.json
  --batch <id>                       (分组统计/成对指标/KnowledgeGain;视觉缺失如实标 pending)
node run.mjs round status      ───▶ 仪表盘(各臂状态+各阶段时间线)
```

- **幂等**:任何阶段可重复执行;已完成臂自动跳过(--force 强制重验);迁移/手工批次被 `--stage status` 自动"收编"合成 ROUND.json。
- **单日多轮**:批次 ID = `B-<触发日期>-R<当日轮次>`,auto 递增,产物天然唯一化。
- **失败可追溯**:ROUND.json 记录每臂 verdict/leakScan/时间戳;失败 trial 保留不删。

## 3. 持续优化 CocosAirJS 的闭环

```text
        ┌──────────────────────────────────────────────────────────────┐
        │  ① 实验(round create→…→aggregate)                          │
        │      ↓ aggregated.json / gap-map(22 gaps + 19 engineBugs)   │
        │  ② 引擎侧修复(E:\AIProMax\github\cocosair.js)               │
        │      ↓ npm pack → 新 tarball → vendor/                 │
        │      ↓ 同步:替换 node_modules/cocosair.js + templates/cocosair│
        │  ③ 回归验收:node run.mjs regression                         │
        │      ↓ BUG→0(版本注册表 vendor/engine-versions.json 留痕)   │
        │  ④ 下一轮实验(pair.json 记录 airPackageHash,版本可比)      │
        │      ↓ 版本演进看板:门户"批次与 Runs"按引擎版本对比         │
        └──────────────────────────────────────────────────────────────┘
```

- **Reference 量尺版本账本**(`reference/private/REFERENCE-VERSIONS.json`):引擎/文档/Brief 三输入指纹;`ceiling-check` 报 STALE 清单(需重实现的 Reference),`ceiling-freeze` 升版冻结并换新量尺 RULER-<日期>-R<轮次>;"批次↔量尺"经 epochId 对应;aggregate 按批次引擎哈希匹配量尺版本,跨版本 Attainment 单列。
- **回归套件**:7 个用例对应实验实测 P0 缺陷(基线:2 BUG + 5 FIXED + 1 用例待调,见 regression/README.md);新引擎版本先过回归再进实验。
- **版本可比性**:pair.json 的 airPackageHash + ROUND.json 的 engine 字段 + engine-versions.json 三处留痕,历史批次按引擎版本分组对比即"引擎改进收益曲线"。
- **知识迭代**:K1/K2 包按 manifest 哈希进 pair.json(knowledgeHash),知识升级 → KnowledgeGain 变化可归因到知识版本。

## 4. 环境 invariant(勿破坏)

- E: 为 exFAT:无链接;依赖共享 = `bench/node_modules` + build.mjs 向上解析(勿在工作区放 node_modules)。
- `reference/private/` 对 Agent Run 永不可读(RUN-CONTRACT §4);briefs 冻结后改动必须升版本并留 amendments(先例:E10 v1.0.1)。
- 验证唯一事实源 = `runner/validate.mjs` 的 report.json;自检口径不作为判定。
