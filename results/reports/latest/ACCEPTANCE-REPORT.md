# 验收报告 — CocosAirJS Competitive Agent Scenario Benchmark

> 验收日期:2026-10-02 | 验收依据:计划书 §33 最终 DoD + §28 硬 Gate
> 验收方式:逐项对照实际产物与命令输出,不以计划/汇报代替证据;所有 PASS 项附证据路径,未达成项如实声明。

---

## 一、硬 Gate 总表(§28)

| Gate | 名称 | 状态 | 证据 |
|---|---|---|---|
| G0 | CONTRACT_FREEZE | **PASS** | `gates/G0.json`(六文件 sha256 可复算) |
| G1 | TEMPLATE_EQUIVALENCE | **PASS** | `gates/G1.json` + `gates/artifacts/G1-*`(双模板 4/4 探针,60fps 持平) |
| G2 | ISOLATION | **PASS** | `gates/G2.json`(T1-T5 实测;策略级隔离限制已声明) |
| G3 | REFERENCE_FEASIBILITY | **PASS** | `gates/G3.json`(20/20 全绿,Availability 10/10×2) |
| G4 | HARNESS_TRUST | **PASS** | `gates/G4.json`(NC01-06 全部被检出;classify 修复后复验+回归) |
| G5 | PILOT_VALIDITY | **PASS** | `gates/G5.json`(6 项检查含失败归因与预算纪律) |
| G6 | CORE_MATRIX_COMPLETENESS | **NOT-RUN(已声明)** | `gates/G6.json`(原因+范围+恢复程序;不以 Pilot 冒充) |
| G7 | BLIND_JUDGE_VALIDITY | **BLOCKED(如实)** | `gates/G7.json`(两轮记录;偏好口径不进结论) |
| G8 | EVIDENCE_COMPLETENESS | **PASS** | `gates/G8.json`(8 臂+20 Reference 证据链核验) |

**结论:9 个 Gate 中 7 PASS,2 个非 PASS 项(G6 未运行、G7 受限)均按合同如实声明且未以平均分/其他口径掩盖。**

## 二、§33 DoD 逐项审计

### 实验系统

- [x] **10 个 Frozen Scene Spec 完成** — `briefs/E01..E10/{brief.md,spec.json}`;哈希冻结于 `briefs/index.json`;E10 因 Pilot 发现的断言语义缺陷升版 v1.0.1(修订记录在 spec.amendments,Reference 同步复验,未弱化合同)
- [x] **2 套冻结模板完成** — `templates/{three,cocosair}`:vendored node_modules 离线、整目录拷贝可独立 build+serve(异地拷贝实测)、import map 架构(引擎不入 bundle)、`template-manifest.json` 哈希
- [x] **Pair Coordinator 完成** — `harness/coordinator/create-pair.mjs`(幂等、arm 平衡随机、RUN-CONTRACT 渲染、端口分配;Pilot 实测 4 对)
- [x] **Session/Workspace/Browser 隔离完成** — 双臂独立目录/knowledge/assets/workspace;fresh session ×8;浏览器 per-validation fresh userDataDir
- [x] **串扰测试 PASS** — G2 T1-T5(含牺牲性 marker 与阳性对照)
- [x] **Harness negative controls PASS** — G4 NC01-06(修复 classify 缺陷后复验;scanner 误报修复后 NC 回归 6/6)

### Reference

- [x] **20 个 Reference 完成或有正式 capability verdict** — 20/20 FEASIBLE(其中 AIR 5 项带 ENGINE_LIMITED 注记:后处理/transmission/实例化形态/3D 粒子/点光阴影),全部含 REFERENCE-VERDICT/WORKLOG/ceiling-notes/validation(含 video.webm)
- [x] **Engine Ceiling 完成** — `results/reference-ceiling.json`(客观分可复算+Judge-1 匿名视觉分+实现者自评三口径并列)
- [x] **Capability Availability 完成** — Three 10/10,AIR 10/10(无双口径污染:无 ENGINE_UNAVAILABLE 项)
- [x] **Reference evidence 完整** — G8 核验 20×4 类证据文件存在

### Agent

- [ ] **Core 60 pairs / 120 runs** — **未运行**(G6 声明;Pilot 4 pairs/8 runs 完成)⚠️ 唯一未达成主项
- [x] **所有 planned repetition 保留** — 8/8 臂产物完整保留,含 3 个 FAIL 臂,无删除
- [x] **无挑最好结果** — 评分以 harness 独立验证为唯一事实源,自检口径分歧如实披露(§26.7)
- [x] **K0/K1 revision 冻结** — K0 已执行且冻结(k0 tarball sha 入 pair.json);K1/K2 包冻结未运行(verify PASS)
- [x] **K2 ablation 完成或明确列为未运行** — 明确列为未运行(G6)

### Evaluation(全部可从原始 evidence 独立复算)

- [x] **Agent Raw** — `results/pilot-aggregate.json`(S1-S4+visual 明细,报告级公式=metric-spec)
- [x] **Attainment** — 同上(>1 现象已解释:锚点非上确界)
- [ ] **Knowledge Gain** — K0-only,增益无法计算(需 K1/K2;已声明)⚠️
- [ ] **Recovery** — R1 轨道未执行,RecoveryRate=N/A(计划书本身定位 R1 为"扩展或抽样",仍如实列为未运行)⚠️
- [x] **Pair Delta** — 4 对成对差值+win/tie/loss(tie=±3 冻结)
- [ ] **Visual Preference** — G7 BLOCKED,偏好口径不输出(第一轮幻觉作废+第二轮判定不一致,全程留痕)⚠️
- [x] **Cost** — `results/cost-metrics.json`(派发侧客观口径:工具 2.39×/墙钟 1.64×/token 3.66×)
- [x] **Failure Taxonomy** — §20 枚举归类+归因决策(E02-AIR=INTERACTION;E05=视觉合同双臂同因;E10=spec 语义缺陷→修复复验)

### CocosAirJS 回灌

- [x] **每个核心差距已归因** — `reports/latest/cocosair-gap-map.md`:22 gaps(每条带证据路径)
- [x] **Engine gap 与 Agent DX gap 分离** — Attainment 与 Ceiling 分离口径+成本不对称归因(DX 层)
- [x] **不可实现项未从产品能力统计删除** — 本轮无 ENGINE_UNAVAILABLE 项;E05/E09 受限项以注记保留在 Availability=10/10 内(双口径合规)
- [x] **Reference 未被直接冒充 stable Example** — Reference 全部隔离于 `reference/private/`(Agent 不可读),无晋升动作;晋升需另走 §22.1 流程
- [x] **输出 roadmap-input** — `reports/latest/roadmap-input.json`(22 gaps/19 engineBugs/6 agentDx/9 knowledgeBackfill)

## 三、验收结论

**通过(附声明)**:

1. **实验系统验收通过**:合同/场景/模板/协调器/隔离/反作弊/验证/评分/聚合全链路建成并被 Pilot 实测闭环;9 Gate 中 7 PASS。
2. **Pilot(M6)验收通过**:G5 PASS;4 对 8 臂真实 K0 冷启动 Run 完成,独立验证+成对统计+成本客观口径齐备;两处 spec/harness 缺陷(E10 P4 语义、scanner/classify 误报)在 Pilot 机制内被发现、修复、复验并全程留痕——这正是 Pilot 阶段的设计目的。
3. **未达成项(4 个,全部已声明、无掩盖)**:G6 核心矩阵(120 runs)、KnowledgeGain(需 K1/K2)、Recovery(需 R1)、Visual Preference(G7 受限于盲评基建)。恢复程序已固化于 `gates/G6.json` 的 resumeProcedure。
4. **实验发现已回灌**:AIR 能力面 10/10 FEASIBLE(推翻静态审计悲观预期)、K0 成本 2.4×/3.66×、自检与冻结合同的系统性分歧、19 条实测引擎缺陷(transmission 死代码/NaN 家族/事件毒化等)——均已结构化为 roadmap-input。

**限制性声明**:文件隔离为策略级+产物扫描级(非 OS 强制,已写入 G2);成本 token/tool 计数为派发侧口径;盲评视觉分为模型评判(双 Judge 平均)且偏好口径被 BLOCK;N=1×4 的全部对比均为观察性结论。

## 四、交付物索引

| 类别 | 路径(bench/ 相对) |
|---|---|
| 合同三件套+配置 | docs/{benchmark-contract,metric-spec,failure-taxonomy}.md, config/*.yaml |
| 场景冻结 | briefs/E01..E10(20 文件+index.json) |
| 模板 | templates/{three,cocosair}(含 manifest+verify) |
| 知识包 | knowledge/K0..K2 × 双引擎(含 manifest+九域矩阵), vendor/*.tgz |
| 资产 | assets/(boat/gem/character.gbl+纹理音频+MANIFEST+VALIDATION) |
| Harness | harness/{runner,coordinator,isolation,judge,aggregate}(validate/score/brief-freeze/ceiling/pilot 聚合) |
| Reference(私有) | reference/private/{three,cocosair}/E01..E10(实现+validation+verdict+notes) |
| Pilot 结果 | results/PAIR-{E01,E02,E05,E10}-K0-R01/(pair.json+双臂+validation+WORKLOG/RESULT) |
| 聚合与成本 | results/{reference-ceiling,pilot-aggregate,cost-metrics}.json |
| 盲评 | results/blind/(材料+双轮 judge+blinding-key) |
| 门禁 | gates/G0..G8.json |
| 报告 | reports/latest/{EXPERIMENT-REPORT,ACCEPTANCE-REPORT,cocosair-gap-map}.md + roadmap-input.json |
