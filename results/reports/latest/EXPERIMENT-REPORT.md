# CocosAirJS Competitive Agent Scenario Benchmark — 实验报告(M6 Pilot 口径)

> 报告版本:v1.0(2026-10-02)| 数据源:`results/reference-ceiling.json`、`results/pilot-aggregate.json`、`results/cost-metrics.json`、`gates/*.json`
> **范围声明**:本报告为 M6 Pilot 结果(E01/E02/E05/E10 × K0 × N=1 = 4 pairs = 8 runs)+ Track A 全量(20 References)+ M11 全量归因。Track B 全矩阵(120 runs)、K1/K2、R1 修复轨道按 G6 声明为**未运行**;一切结论按 §19.1 纪律以"观察性发现"表述,N=1 不做确定性推断。

---

## 26.1 Baseline

| 项 | 值 |
|---|---|
| Agent | ZCode Agent 子代理(general-purpose),同一派发提示词模板(仅工作目录不同),fresh session ×8 |
| 模型 | GLM-5.3(account:bigmodel-individual-coding-plan),同会话同版本 |
| 引擎 | three@0.186.1(registry tarball)/ cocosair.js@1.0.0(k0 tarball,sha `ddd5072a…`) |
| 知识 | K0(three:README;AIR:README + tarball 内 .d.ts;无 docs/examples/联网) |
| Brief | v1.0.0(E10 修订至 v1.0.1,见 §26.7) |
| 环境 | Windows / Node 24.14 / RTX 4060 / Chrome headless 1280×720(WebGL2 ANGLE D3D11) |
| N | 4 pairs(arm 随机平衡:E01/E05 A=three,E02/E10 A=AIR;同批派发,启动差 0s) |

## 26.2 Product Capability(Track A:Engine Ceiling 与 Capability Availability)

**Capability Availability:Three 10/10,AIR 10/10。** 无 ENGINE_UNAVAILABLE 项;E05(AIR 后处理)与 E09(AIR transmission)以 FEASIBLE+受限注记保留,按 §2.4 双口径计入。

| 场景 | Three Ceiling(客观60+Judge视觉) | AIR Ceiling | 探针 | fps | AIR 受限注记 |
|---|---:|---:|---|---|---|
| E01 星系 | 89(vis 13/18) | 88(12.5) | 7/7 双绿 | 60/60.2 | 辉光以 additive 近似(无 Bloom) |
| E02 海面孤舟 | 86(11.5) | 87(12) | 7/7 双绿 | 60.1/60.3 | 无顶点缓冲就地改写;pal 吞鼠标事件 |
| E03 太阳系 | 86(11.5) | 86(11.5) | 9/9 双绿 | 60.2/60.1 | 无 InstancedMesh(600 小行星走共享网格) |
| E04 城市烟花 | 84(11) | 86(11.5) | 8/8 双绿 | 60/60.3 | 无 3D 粒子系统(动态网格替代,2600 粒 60fps) |
| E05 黑洞 | 89(13) | 89(13) | 6/6 双绿 | 60.2/60.2 | **后处理三闸门实证零可用**;Shader 通道 FULL |
| E06 篝火营地 | 90(13.5) | 90(13.5) | 6/6 双绿 | 60.1/60.1 | 点光阴影不支持(动态点光照明链路 FULL) |
| E07 霓虹夜城 | 91(14) | 89(13) | 8/8 双绿 | 60.1/60.2 | 无 Points/实例化;规模实测 1536 楼@54.7fps |
| E08 深海鱼群 | 87(12) | 87(12) | 8/8 双绿 | 60.1/60.3 | 无 3D 粒子(整群烘焙单动态网格 1 draw call) |
| E09 珠宝展示 | 88(12.5) | 89(13) | 8/8 双绿 | 60.2/60.2 | **transmission 死代码**;自定义管线兑现真实折射+色散 |
| E10 角色展示 | 83(10.5) | 83(10.5) | 7/7 双绿(v1.0.1) | 60.2/60.1 | GLTFAsset.instantiate 一等公民(优于 Three clone 链) |**两引擎客观上限高度接近(AIR 79 探针全绿、全部 60fps),差距集中在视觉管线(后处理/transmission)与 API 形态,而非可达性。**

## 26.3 Agent Capability(Track B Pilot:K0,N=1×4)

| Pair | Three Raw | AIR Raw | Δ(AIR−Three) | Three Attainment | AIR Attainment | 结果(tie=±3) |
|---|---:|---:|---:|---:|---:|---|
| E01 | 86 | **91** | **+5** | 0.97 | **1.03** | **AIR 胜** |
| E02 | **90** | 65 | **−25** | **1.05** | 0.75 | **Three 胜** |
| E05 | 55 | 54 | −1 | 0.62 | 0.61 | 平 |
| E10 | 82 | 83 | +1 | 0.99 | 1.00 | 平 |

- **First Compile(自报)**:6/8 臂一次 build 通过;E01-AIR 8 次用满 build 预算后以手工同步 dist 收尾(透明披露于其 RESULT.md)。
- **Final Success(harness)**:6/8 臂 verdict PASS(E01 双、E02-three、E10 双,E10 为 spec v1.0.1 后)。
- **Recovery**:R1 修复轨道未执行,RecoveryRate = N/A(已声明)。
- **Attainment>1 的解释**:E01-AIR、E02-three 的 Agent 产出在盲评六维上超过其 Reference 锚点——Reference 是"可信锚"而非"上确界",该现象本身是 Reference 视觉保守度的信号。

## 26.4 Knowledge(K0/K1/K2)

- **K0(已执行)**:如上。K0 知识不对称如实记录:three npm 无 .d.ts,AIR tarball 含 3MB .d.ts。
- **K1(冻结未运行)**:知识包已构建并 verify PASS(`knowledge/K1/*`,含九域覆盖矩阵)。
- **K2(冻结未运行)**:同上,泄漏筛查通过(排除 21 个同主题示例)。
- **KnowledgeGain = N/A**(需 K1/K2 运行,归入 G6 恢复程序)。

## 26.5 Visual(Track D)

- 第一轮盲评**作废**:视觉后端幻觉(Judge 双独立上报:E10 狐狸→"星系/像素岛"、E09 宝石→"水母"),`judge-calibration` 留痕。
- 第二轮(主题锚定+一致性验证,0 unreliable):偏好判定双 Judge 4/4 不一致(保守 tie vs 差异 side1)→ 按 §18 冻结阈值(>20%)**G7 = BLOCKED,Preference/BT 不进入结论**。
- 六维分数口径(双 Judge 平均,分差 ≤5/18)仅用于 Run Score 的 visual 分量,并全程披露。
- **盲评基建本身成为本实验发现的产品缺口之一**:视觉评判需可复现的可靠基建,当前环境的 Read→CDN→vision 链路不稳定。

## 26.6 Cost(派发侧客观统计,`results/cost-metrics.json`)

| 指标 | Three 合计 | AIR 合计 | AIR/Three |
|---|---:|---:|---:|
| toolUses | 229 | 547 | **2.39×** |
| wallTime | 5136s | 8405s | **1.64×** |
| tokens | 15.1M | 55.3M | **3.66×** |

四对全部同向(AIR 每对 +43~+94 工具、+5.2M~+12.2M tokens)。**K0 冷启动下 AIR 的 Agent 成本系统性更高,且贵在"类型无法表达的运行期行为契约"(NaN 家族、事件毒化、双补丁图元等 19 条实测缺陷),而非 API 认知。**

## 26.7 Failure Domains(scene × engine × 分类)

| Pair/臂 | 分类 | 归因(证据) |
|---|---|---|
| E02-AIR | INTERACTION(P4) | 拖拽环绕角速度未达冻结窗口 ±20°(自检 24/24 vs harness 3/7 —— 自检口径分歧的典型样本) |
| E05-three | 视觉合同(P1) | 角区星密度 TL 0.03%/BL 1.4% < 3%(独立像素复核确认,非 harness 缺陷) |
| E05-AIR | 视觉合同(P1) | 同上(TR 0.7%/BR 2.5%),双臂同因 → 共同根因是"无验证器反馈下的视觉密度校准",非引擎 |
| E10 双臂 | SPEC_INVALID→修复 | P4 regionChange 语义(动作后两帧)与阈值文本(动作前后)不符;v1.0.1 改 pixelDelta 后双臂+双 Reference 复验全绿(修订未弱化合同) |

**系统性发现:8/8 臂自检全绿,3/8 臂 harness 判 FAIL——Agent 自检口径与冻结合同的分歧是 K0 最大的隐藏失败面**(探针采样语义、视觉密度阈值、双采样时序)。

## 26.8 Case Studies(证据路径均为 bench/ 下相对路径)

1. **AIR best — PAIR-E01 arm-b**(`results/PAIR-E01-K0-R01/arm-b/`):K0 冷启动从 vendored bundle 反查出 EffectAsset 注册路径,74,500 星点单 draw call,raw 91 超 Reference 锚点(88);4 个引擎深坑(attribute defines/UBO set/Vec4 NaN/wheel capture)全部自行攻克。成本:171 工具/18M tokens(为 three 臂 2.2×/2.6×)。
2. **AIR worst — PAIR-E02 arm-a**:海面着色器与资产链全对,败于 P4 拖拽环绕的角速度窗口校准(自检用更长窗口)。
3. **Three best — PAIR-E02 arm-b**:43 工具/15.7 分钟/2.4M tokens 全绿,是"生态知识红利"的最纯样本。
4. **Three worst — PAIR-E05 arm-a**:后处理链与视界保黑通道工程质量高,但四角星密度未达 3% 阈值——证明该失败与引擎无关。

## 26.9 CocosAirJS Roadmap Mapping

完整归因见 `reports/latest/cocosair-gap-map.md`(22 gaps + 19 engineBugs + 6 agentDx + 9 knowledgeBackfill,每条带证据路径)与 `roadmap-input.json`。P0 六条:后处理三闸门(补 Engine)、transmission 死代码(一行级修复)、NaN 家族类型校验(补 Error Diagnostics)、事件分发器毒化(补 Engine)、air-gltf-standard 纯黑(tarball 差异定位)、POINT_LIST 双补丁(补 Engine)。最大认知变化:**能力面比静态审计乐观(10/10 FEASIBLE),差距重心在静默行为契约与 Agent DX,而非功能缺失。**

---

## 看板(§27)

| Domain | Three Ceiling | AIR Ceiling | Three Attainment(K0) | AIR Attainment(K0) | AIR Gap Root Cause |
|---|---:|---:|---:|---:|---|
| Procedural(E01) | 89 | 88 | 0.97 | 1.03 | 无(Bloom 缺失仅影响视觉分) |
| Asset(E02) | 86 | 87 | 1.05 | 0.75 | Agent DX:输入交互路径+自检口径 |
| Shader/Post(E05) | 89 | 89 | 0.62 | 0.61 | 双臂共同:视觉密度校准(知识/DX) |
| Animation/Lifecycle(E10) | 83 | 83 | 0.99 | 1.00 | 无 |
| 其余六域 | 见 §26.2 | 见 §26.2 | 未运行(G6) | 未运行(G6) | 见 gap-map |

| Metric | Three | AIR | Pair Δ(AIR−Three) |
|---|---:|---:|---:|
| Final Success | 3/4 | 3/4* | 0 |
| Agent Raw(中位) | 84 | 74 | −10 |
| Attainment(中位) | 0.98 | 0.875 | −0.105 |
| Tokens | 15.1M | 55.3M | +40.2M |
| Tool Calls | 229 | 547 | +318 |
| Wall Time | 5136s | 8405s | +3269s |
| Visual Preference | N/A(G7 BLOCKED) | N/A | — |

\* E10 双臂在 spec v1.0.1 下 PASS;E05 双臂 FAIL(共同非引擎根因)。
