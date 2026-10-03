# Findings — AUDIT-20261003

> 每条:ID/严重度/合同·门禁/位置/根因/复现/预期/实际/影响历史数据/修复/复验/是否阻断正式矩阵

## F-01 [P0|§1 链路/§2] RULER Brief 指纹恒 null(Brief 改动不触发 STALE)
- 位置:`harness/aggregate/reference-versions.mjs`(改前)/`briefs/index.json`
- 根因:index 结构是 `{generatedAt, entries:[{briefId,version,sha256}]}`,代码用 `briefIdx[scene]` 直接下标 → undefined → `briefSha:null`
- 复现:`node -e "require('./reference/private/REFERENCE-VERSIONS.json').epochs['E01:three'].inputs.briefSha"`(改前)= null
- 预期:Brief sha 变化 → 该 Reference STALE;实际:永不出触发
- 影响历史数据:RULER-R1 冻结的 briefSha 全 null(已回填真实值,null 回填不升版豁免)
- 修复:经 entries 建 briefId→{briefSha,version} 映射;RULER 输入补 specSha/validatorProtocolHash/judgeProtocolHash
- 复验:NC10 DETECTED(--selftest-drift 注入 briefSha/specSha→STALE、validatorHash→NEEDS_REVALIDATION)✓
- 阻断矩阵:已解除

## F-02 [P0|§1/§3] 历史 Pair 用"当前 spec"重验(E10 v1.0.1 会重解释 v1.0.0 的 Run)
- 位置:`harness/round/run-round.mjs` validate stage(改前 `--spec briefs/<scene>/spec.json`)
- 根因:验证 spec 取全局最新,而非 Pair 冻结副本;且无哈希核验
- 复现(实测):以现行 `briefs/E10/spec.json`(v1.0.1)验 B-20261002-R01/PAIR-E10 arm-b + `--pair-meta` → **INPUT_DRIFT(exit 4)** 拦截;两臂 arm spec.json sha(70c862a9)≠ pair.specSha256(df299b68)——历史 E10 验证实际跑在中间版 v1.0.1(63b74e45),三者互不相等
- 影响历史数据:E10 两臂 validation 对现行 spec 无证明力 → QUALIFICATION 判 INPUT_DRIFT(LEGACY_PROVISIONAL)
- 修复:validate 新增 `--pair-meta`(spec sha≠→INPUT_DRIFT exit 4;dependencyHashes≠→ENV_DRIFT exit 5);run-round 改用 arm 内冻结副本 + 传 pair-meta;`--revision` 产生 revisions/<ts>-<label>/,原 report.json 归档 -original
- 复验:NC09 DETECTED(exit 4,秒级前置拦截)✓;历史 E10 实测拦截 ✓
- 阻断矩阵:已解除(新 Pair 强制守卫;历史单列)

## F-03 [P0|§4] RULER 分数动态重取 judge 文件(新增 judge 静默改历史 Ceiling)
- 位置:`harness/aggregate/aggregate-all.mjs` refCeilingVisual()(已删)
- 复现(实测):注入 `judge-pass-9.json`(含极端分数 REF-E01-X total:1 / REF-E01-Y total:18)→ 重跑 aggregate → **所有 objective/visual/provisional 字节级不变(JUDGE-IMMUTABILITY PASS)**
- 修复:Reference 分数只读 RULER 账本冻结值(objectiveBreakdown/objectiveScore/visualRaw18/totalScore/evidenceHash);FIX-B 已冻结全套指标
- 阻断矩阵:已解除

## F-04 [P0|§5] G7=BLOCKED 未传播到正式指标
- 修复:aggregate 读 gates/G7.json,非 PASS → 每对 `formal:{total:null, attainment:null, pairedDelta:null, visualStatus:'INVALID(G7 BLOCKED)'}`;`objective:{total(S1+S2+S3), attainment(对 RULER objective), pairedDelta}` 照常;visual 降为 `provisionalVisualScore`
- 复验:NC13 DETECTED(formal.total===null 且 objective.total 非 null)✓;当前 aggregated.json 4 对 formal 全 null 实证 ✓
- 阻断矩阵:已解除(Track D 视觉轨维持 G7 BLOCKED,不进总分)

## F-05 [P0|§6] S4 恒满分 5
- 修复:S4 读 `<workspace>/validation/code-review.json`({structure/antiPatterns/total/reviewer/protocolHash});缺失 → `s4:null, s4Pending:true`
- 复验:当前所有臂 s4=null + s4Pending(诚实);Pilot 历史臂 objective 因此为 S1+S2+S3 口径
- 阻断矩阵:已解除(评审文件补齐前 S4 如实 PENDING,不再虚高)

## F-06 [P0|§7] Agent 身份全 null(同一 Agent 前提不可验证)
- 修复:create-pair 写 `RUN-META.template.json`(7 身份字段);run-round `preflight` stage:RUN-META 非空 + 两臂 modelId/modelRevision/systemPromptHash/toolPolicyHash/agentRuntime/budget 一致 + arm spec sha==pair.specSha256;不过 → Pair BLOCKED,不得 validate
- 复验:NC11 DETECTED(真实 preflight 执行,BLOCKED + 身份缺失 reasons ×5)✓
- 阻断矩阵:已解除(新 Pair 强制;历史批次由 QUALIFICATION 标注身份不完整)

## F-07 [P0|§8/§9] Spec 高级语义超出执行器词表 & 未知 region 静默退化 full-frame
- 修复:(a) LEGAL_REGION_FORMS 封闭词表 + `classifyRegionForm`;未知 region/type/params → SPEC_INVALID(仅 diagnostic 模式允许 DIAGNOSTIC-FALLBACK 且不得 PASS);(b) 新增 11 种独立断言类型(networkRequest/download/domText/noNavigation/resourceRequestCount/consoleClean/colorRelation/luminanceRelation/regionCoverage/memoryDelta/assetNoReload);(c) 参数化 region 几何(bottom-third/upper-half/mid-vertical-band[x∈a,b]/disk/mid-ring/hud-DOM/注记剥离/多region分隔);(d) spec-audit.mjs 全量能力审计
- 复验:NC07(NC08)DETECTED(spec-audit exit 3 / classifyRegionForm ok:false)✓;spec-audit:74 探针 **UNSUPPORTED=0**
- 影响历史数据:无(历史 report 为当时口径,QUALIFICATION 注明 validator 版本)
- 阻断矩阵:已解除

## F-08 [P0|§10] 失败分类靠探针名猜 + STATE_MANAGEMENT 兜底
- 修复:validate 分类读 `harness/runner/probe-meta/<SCENE>.json` failureDomains(FIX-D 10 场景全覆盖,21 项封闭枚举零 UNRESOLVED);不可靠 → **UNRESOLVED**,删除兜底;逐探针 classificationEvidence
- 复验:selftest:故意 FAIL 探针分类为域/UNRESOLVED 而非默认 STATE_MANAGEMENT ✓
- 阻断矩阵:已解除

## F-09 [P0|§11] precondition 硬链级联放大(P1 局部失败 → S2=0)
- 修复:三分语义:前置 PASS→跑;**前置 FAIL 但页面存活→继续跑**(记 ranDespitePredecessor);前置 ERROR→SKIPPED_BY_DEPENDENCY;probe-meta fullPassDeps 声明硬状态依赖(如 E10 P5←P4 销毁须真发生)
- 复验:selftest:P5 故意 FAIL → P6 继续执行 PASS(passRate 6/7)✓
- 阻断矩阵:已解除

## F-10 [P1|§12] S3 生命周期只认第一个 reset 探针
- 修复:aggregate S3 = probe-meta lifecycleProbeIds **全集合 PASS**(E02=[P6,P7] 双 reset;E10=[P4,P5,P6,P7]);sidecar 缺失回退单探针口径并标 lifecycleMode
- 复验:aggregated.json E01 three lifecycleMode='full-set(probe-meta)' ✓
- 阻断矩阵:已解除

## F-11 [P1|§13] 预算自报可事后解释
- 修复:模板 build 串联 count.mjs(npm run build 先计数后执行);verify-browser.mjs(先 count browser 再启动);RUN-CONTRACT 冻结计数定义 + 红线 12(绕过计数=INVALID_RUN);budget-check.mjs(读 .budget/*.count vs agents.yaml 上限);run-round validate 逐臂强制判定,超限 classification=BUDGET_EXHAUSTED
- 复验:NC12 DETECTED(build 9/8 → BUDGET_EXHAUSTED,exit 3)✓
- 影响历史数据:Pilot 臂无机器计数 → QUALIFICATION budget 项=自报口径(LEGACY_PROVISIONAL)
- 阻断矩阵:已解除(新 Run 强制)

## F-12 [P1|§15] 共享 node_modules 可变无守卫
- 修复:create-pair 记 dependencyHashes{three,cocosair,esbuild}(package.json+主入口合并 sha);validate --pair-meta 校验,≠→ENV_DRIFT exit 5
- 复验:FIX-B 自测 ENV_DRIFT 冒烟(diff 定位 three 键)✓
- 阻断矩阵:已解除

## F-13 [P1|§16] Attainment>100% 未标记
- 修复:>1.03 → `ceilingBreach:true` + 顶部 `rulerStatus.needsRecalibration[scene:engine]`;不 clamp
- 复验:FIX-B 自测;术语已在文档层注明 Reference Baseline 语义(冻结参考实现量尺,非数学上限)
- 阻断矩阵:已解除

## F-14 [P1|§14] 隔离为策略级但表述需精确
- 现状:G2 保持 POLICY_LEVEL 真实声明不删除;报告措辞=「未观察到违规读取证据」而非「无法读取」;正式 120-run 矩阵建议升级 OS 级沙箱(独立 HOME/TEMP、禁 parent、capability sandbox)
- 阻断矩阵:不阻断(诚实披露);正式矩阵建议项

## F-15 [P0 新发现|§8] E05 P3 冻结断言与真实画面不符(ring 色彩关系)
- 现象:严格执行器实现"内环 vs 外环采样"后,双引擎 Reference 均 FAIL(inner lum 比通过,但 outer 环带亮部平均 R-B 为负)
- 根因:冻结 Brief P3 写"外环带偏橙红(R-B 差显著)",但真实画面中外环均值被 (a)多普勒不对称(同 Brief 列为加分项:一侧蓝弱一侧橙强)(b)蓝白光子环/透镜弧(c)蓝星云亮像素 三者稀释;橙红仅存在于特定方位角扇区
- 复现:`P3 metrics: {mode:'ringRelation', three:{innerRB:20.08,outerRB:-37.95}, air:{innerRB:40.17,outerRB:-9.46}}`;径向剖面(暗核中心)证实 ±X 方位 RB 从内 +5~+35 升至外 +36~+73,但全环带均值不成立
- 处置:按红线**不调阈值不缩采样迁就**;如实记录。E05 需 spec 升版(v1.0.2:方位角扇区化断言,如"多普勒亮侧扇区 R-B≥25")后 Reference 重验
- 影响历史数据:历史 E05 validation 的 P3"PASS"为 full-frame 像素差代理所测(未测 ring 语义)→ QUALIFICATION 注明
- **阻断矩阵:是(阻断项 B-1)**

## F-16 [P1 新发现|§8] E04 P4 余烬窗口 vs 采样时延
- 现象:严格执行 upper-half region 后,P4 余烬运动 diffRatio=0.0004 < 0.005(旧 full-frame 回退把下半城景活动计入而"通过")
- 根因:harness 探针间截图开销(每探针 ~0.8-1.1s)+ P3 爆炸采样滞后(实际 ~5s)把 P4 采样推到 ~10.9s,多数余烬已熄
- 处置:不降低阈值;E04 需 spec 升版(余烬寿命窗口加长)或 Reference 余烬分层寿命调整后重验
- **阻断矩阵:是(阻断项 B-2)**

## F-17 [P2 新发现|§2] E01/E02/E05 spec 同版本号不同内容
- 现象:QUALIFICATION 发现三场景 spec v1.0.0 的 sha 在 briefs/index 与 arm 冻结副本间不一致(冻结流程后又有回填改动未升版)
- 处置:已列入 historical-batch-qualification reasons;后续 spec 任何改动必须升版本号(流程已在 E10 树立先例)
- 阻断矩阵:与 B-1/B-2 合并处置(升版时一并固化)
