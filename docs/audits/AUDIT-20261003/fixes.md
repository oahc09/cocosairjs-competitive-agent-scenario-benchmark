# Fixes — AUDIT-20261003

> 与 findings.md 的 F-01~F-17 一一对应;全部已在本轮落地并复验。

| F | 修复 | 文件 | 复验证据 |
|---|---|---|---|
| F-01 | briefSha 经 entries 映射;RULER 输入补 specSha/validatorProtocolHash/judgeProtocolHash | harness/aggregate/reference-versions.mjs | NC10 DETECTED;账本 briefSha 全真实值 |
| F-02 | validate `--pair-meta`(INPUT_DRIFT exit4 / ENV_DRIFT exit5)+ `--revision`(原证据归档 revisions/-original);run-round 用 arm 冻结 spec + 传 pair-meta;preflight 拒绝漂移 Pair | harness/runner/validate.mjs, harness/round/run-round.mjs | NC09 DETECTED;历史 E10 以现行 spec 验证实测被拦截 |
| F-03 | Reference 分数只读 RULER 账本(删除 refCeilingVisual 动态扫描);冻结完整指标(objectiveBreakdown/objectiveScore/visualRaw18/totalScore/evidenceHash) | harness/aggregate/aggregate-all.mjs, reference-versions.mjs | JUDGE-IMMUTABILITY PASS(注入极端 judge 文件,聚合不变) |
| F-04 | G7 非 PASS → formal{total/attainment/pairedDelta}=null + visualStatus=INVALID;objective 口径照常;visual 降 provisionalVisualScore | aggregate-all.mjs | NC13 DETECTED;aggregated.json 4 对 formal 全 null |
| F-05 | S4 读 validation/code-review.json;缺失 → null + s4Pending | aggregate-all.mjs | 全部臂 s4=null(诚实) |
| F-06 | RUN-META.template.json(7 身份字段);preflight stage(两臂身份一致性+spec sha);BLOCKED 不得 validate | harness/coordinator/create-pair.mjs, harness/round/run-round.mjs | NC11 DETECTED(真实 preflight BLOCKED ×5 reasons) |
| F-07 | LEGAL_REGION_FORMS 封闭表;未知 type/region/params → SPEC_INVALID(diagnostic 才可回退且不得 PASS);+11 独立断言类型;参数化 region 几何(disk/mid-ring/upper-half/bottom-third/mid-vertical-band[x∈a,b]/hud-DOM);spec-audit.mjs 能力审计 | harness/runner/probe-executor.mjs(重写+764 行), harness/runner/spec-audit.mjs(新) | NC07/NC08 DETECTED;74 探针 UNSUPPORTED=0 |
| F-08 | 分类读 probe-meta/<SCENE>.json failureDomains(FIX-D 10 场景,21 枚举零 UNRESOLVED);不可靠→UNRESOLVED;删 STATE_MANAGEMENT 兜底 | validate.mjs + harness/runner/probe-meta/E01..E10.json(新) | selftest 故意 FAIL 分类=域/UNRESOLVED |
| F-09 | 前置三分:PASS→跑 / FAIL但页面存活→继续(ranDespitePredecessor) / ERROR→SKIPPED_BY_DEPENDENCY;fullPassDeps 硬依赖 | probe-executor.mjs + probe-meta | selftest:P5 FAIL→P6 继续执行 PASS(6/7) |
| F-10 | S3 = lifecycleProbeIds 全集 PASS(E02=[P6,P7] E10=[P4..P7] 等);lifecycleMode 标注 | aggregate-all.mjs + probe-meta | E01 lifecycleMode='full-set(probe-meta)' |
| F-11 | build 串联 count.mjs;verify-browser.mjs 先计数;RUN-CONTRACT 冻结计数定义+红线12;budget-check.mjs 强制判定(BUDGET_EXHAUSTED) | templates/*/scripts/count.mjs(新), verify-browser.mjs(新), package.json, run-contract-template.md, harness/runner/budget-check.mjs(新), run-round.mjs | NC12 DETECTED(build 9/8) |
| F-12 | pair.dependencyHashes{three,cocosair,esbuild};validate 校验≠→ENV_DRIFT exit5 | create-pair.mjs, validate.mjs | FIX-B 冒烟(diff 定位 three 键) |
| F-13 | attainment>1.03 → ceilingBreach + rulerStatus.needsRecalibration;不 clamp;文档注明 Reference Baseline 语义 | aggregate-all.mjs | FIX-B 自测 |
| F-14 | G2 声明保留;报告措辞改"未观察到违规读取证据";正式矩阵建议 OS 级沙箱 | 本审计 remaining-risks.md | — |
| F-15/16 | **不修 spec 不调阈值**(红线);如实记录为 spec 升版待办(E05 v1.0.2 方位角扇区断言;E04 v1.0.2 余烬窗口);严格执行器保留真实测量 | findings.md | 统一重验:E04/E05×2 引擎 FAIL(P4/P3),其余 16 项 PASS |
| F-17 | 记录;spec 改动升版纪律已由 E10 先例固化 | findings.md | QUALIFICATION reasons |

## 附带整改(执行指令未点名、过程中发现)

- run-round validate 的 spec 来源改为 arm 冻结副本(原为 briefs 全局)——F-02 的调度侧。
- NC08 夹具升级:disk(...) 被合法词表收编后,夹具改用真正未知的 region 名(升级测试而非降低测试)。
- selftest.mjs 断言更新到新语义(P6 继续执行/passRate 6/7/分类非 PASS)。
- leak-scanner:纯注释行不算泄漏证据(路径提及类误报源)。
- run-round saveRound mkdir(round-out 目录不存在时崩溃)。
