# AGENTS.md — AI Agent 上手须知

> 目标读者:即将在本仓库工作的 AI Agent。60 秒建立正确心智模型,避免破坏冻结合同与证据链。
> 人类读者请从 [README.md](README.md) 进入。

## 这个项目是什么(30 秒)

**CocosAirJS Competitive Agent Scenario Benchmark**:在同一 Agent 配置(同模型/同提示词/同预算/同 Brief)下,对 **Three.js r186** 与 **Cocos AIR 1.0.0** 做**成对(Paired)**复杂 3D 场景对照实验。核心不是排名,而是把差距拆成三层并归因:

- **Engine Ceiling**(Track A):20 个可信 Reference 实现证明引擎上限(10 场景 × 2 引擎,全 FEASIBLE);
- **Agent Attainment**(Track B):Agent 实际得分 / 引擎上限;
- **Knowledge Gain**(Track C):K0 冷启动 → K1 文档 → K2 完整知识的增益。

进度(2026-10-03):基础设施全部就绪,G0-G5/G8 PASS;已完成批次 `results/B-20261002-R1`(Pilot:4 pairs × K0);**K1/K2 与核心矩阵未运行**(G6 声明),补跑只需一条命令。

## 60 秒路径图

| 你要做的事 | 命令 / 位置 |
|---|---|
| 了解全貌与约定 | `docs/MASTER-CONTEXT.md`(全局事实源)→ `docs/ARCHITECTURE.md`(结构) |
| 查实验计划 | `docs/BENCHMARK-PLAN.md`(冻结计划书) |
| 执行一轮实验 | `node run.mjs round create --matrix "E01|K1|R01"` → 按 `results/<batch>/DISPATCH.md` 派发 → `collect/validate/blind/aggregate` |
| 单独验证某工作区 | `node harness/runner/validate.mjs --workspace <dir> --spec briefs/<E>/spec.json --out <dir>` |
| 引擎改版验收 | `node run.mjs regression`(BUG 归零才可开新一轮) |
| 看结果/报告 | 门户 `node run.mjs portal`(7800)· 数据 `results/aggregated.json` · 报告 `results/reports/latest/` |
| 查门禁状态 | `node run.mjs gates` |

## 硬约束(违反即 INVALID_RUN 或破坏可复现性)

1. **`reference/private/` 对 Agent Run 永不可读**(RUN-CONTRACT §4);Reference 实现者除外。
2. **Agent Run 期间禁止**:读另一 Arm / 读 harness 源码 / 联网 / `npm install` / 修改 brief/spec/harness;预算以 RUN-CONTRACT.md 为准(自报+产物扫描双口径)。
3. **冻结文件不可改**:briefs 的 spec.json(改动必须升版本号并写 amendments,先例 E10 v1.0.1)、G0 哈希过的合同三件套、已归档批次的任何产物。
4. **失败 trial 永不删除**;判定唯一事实源 = `validate.mjs` 的 report.json,Agent 自检口径不算数。
5. **环境**:E: 盘是 **exFAT**——不支持任何链接(junction/symlink 均报"函数不正确");依赖共享 = 根 `node_modules` + 各工作区 build.mjs 向上解析,**不要在工作区放 node_modules**;浏览器 = 系统 Chrome headless 1280×720(WebGL2 正常,无需 swiftshader)。
6. **引擎外部资产**:Cocos AIR 源码在 `E:\AIProMax\github\cocosair.js`(Reference 实现者可读),three r186 源码快照在 `E:\AIProMax\Y2026M09\cocosairjs-vs-threejs\three.js-r186`。

## 已知引擎实测坑(AIR,来自 20 个 Reference + 8 个 Pilot Run)

canvas 鼠标事件被 pal 层吞(须走引擎 `input.on`,wheel 用 capture 监听)· `setProperty` FLOAT4 必须传 Vec4/Color 实例(普通数组→NaN 黑屏)· `Light.color` 传普通对象→NaN 白屏 · `Camera.visibility` 必须显式设 `Layers.Enum.DEFAULT` · POINT_LIST 需 mesh+pass 双补丁 · 无后处理/Bloom(shader 内衰减近似)· 无 InstancedMesh/Points(动态网格 `utils.MeshUtils.createDynamicMesh+updateSubMesh` 替代)· `primitives.plane` 在 XZ 平面 · 自定义材质:`new Material()` + `initialize({effectAsset})`(effectName/effectAsset 属性只读)· gltf 加载:`GLTFLoader.loadAsync → asset.instantiate()`。完整清单:各 `reference/private/cocosair/E*/ceiling-notes.md` 与 `results/reports/latest/cocosair-gap-map.md`。

## Reference 量尺版本原则(多轮引擎迭代时必读)

Reference 天花板 = **当前引擎 + 当前文档正典用法 + 当前 Brief** 的最优实现。三输入任一变化(引擎 tarball、K1 文档包、spec 升版)→ 受影响 Reference 需**重实现**(不是仅重跑:API 优化后旧绕行写法会低估上限),然后 `node run.mjs ceiling-freeze` 升版冻结并换新量尺 RULER-<日期>-R<轮次>(与批次 B-* 同构;同一版量尺下所有批次共用同一量尺,不随批次轮数变动);每轮 aggregate 自动校验批次引擎哈希与量尺量尺版本,不匹配标 `engine-differs`(Attainment 跨版本,单列)。漂移检测:`node run.mjs ceiling-check`(STALE 列表=下轮前必须重做的清单)。

## 约定速记

- 批次 = `results/B-<YYYYMMDD>-R<当日轮次>/`(auto 递增,单日多轮安全);端口由 coordinator 扫描全库分配(7100 起)。
- 评分 = 客观 60(S1 7+5+3 / S2 30×探针通过率 / S3 6+4 / S4 5)+ 视觉 40(六维 0-3 ×40/18);tie = |Δ|≤3;效率指标独立报告不入总分。
- 工作区页面契约:`__appReady` + `__bench={getState,reset}` + `data-ui` 控件;探针动作词表与安全 jq 见 `harness/runner/probe-executor.mjs` 头注释。
- 证据媒体可再生(磁盘保留、git 不跟踪):Reference 媒体重跑 validate、盲评材料 `build-blind --batch`、NC `run-nc`。

## 修改本仓库的礼仪

- 新脚本**自定位路径**(`path.resolve(dirname(fileURLToPath(import.meta.url)), …)`),禁止硬编码绝对路径(迁移教训);
- 一次提交一个意图;涉及冻结合同的变更先看 `gates/G0.json` 哈希是否受影响;
- 中文文档为主,代码注释解释"为什么"而非"是什么"。
