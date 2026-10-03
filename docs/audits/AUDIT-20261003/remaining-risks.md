# Remaining Risks — AUDIT-20261003

## 阻断正式 120-run 矩阵的事项(按 §20 条件评估)

| ID | 事项 | 需要的动作 | 为什么不能在本轮做 |
|---|---|---|---|
| B-1 | **E05 spec v1.0.2 升版**(P3 ring 色彩断言与真实画面不符,F-15) | 冻结修订:方位角扇区化(如"多普勒亮侧扇区 R-B≥25"),重跑 E05 双引擎 Reference 重验,ceiling-freeze 换新量尺 | 红线禁止"修改冻结 Brief 迁就现有实现"式热修;升版决策(断言如何改)属 Benchmark Owner 权限,且需重新冻结走完整流程 |
| B-2 | **E04 spec v1.0.2 升版**(P4 余烬窗口 vs 采样时延,F-16) | 冻结修订:余烬分层寿命窗口加长(或 region 放宽为 full),同上重验 | 同上 |
| B-3 | **Agent Run 侧 code-review 证据机制启用**(F-05 的另一半) | 正式矩阵前为每臂产出 validation/code-review.json(独立评审或规则化静态检查,两引擎一致、不读 Reference) | 属运行期流程,机制已就绪(S4 如实 PENDING 不再虚高),首次正式运行时启用即可;不阻断机制验证 |
| B-4 | **正式矩阵建议 OS 级隔离**(F-14) | 独立 HOME/TEMP/cache、禁 parent 访问、capability sandbox、禁外网 | 宿主暂不具备;G2 已诚实声明 POLICY_LEVEL 且报告措辞已修正;属建议项非硬阻断(§14 允许披露后继续) |

## 已知但可接受的风险

1. **盲评视觉轨(G7)维持 BLOCKED**:两轮 Judge(主题锚定后)偏好判定仍不一致;视觉分已从正式指标隔离为 provisionalVisualScore;Track D 待视觉评判基建重建(视频优先协议已写入 JUDGE-INSTRUCTIONS 模板思路,未实施——见 test-results 注记)。
2. **历史批次 B-20261002-R1 = LEGACY_PROVISIONAL**:objective 可复用(作诊断/回归/Harness 对照),visual 作废(G7)、formal/绝对 Attainment 不可用(身份不完整 + E10 spec 漂移)。这是正确处置而非缺陷。
3. **S4 在历史与当前均为 PENDING**:评审文件机制就绪但尚无评审产物;首次正式矩阵运行时按 §6 补齐。
4. **E04/E05 的 4 个 Reference 在最终统一重验中 FAIL**:非引擎或实现问题,是冻结断言与真实画面/时序的偏差(F-15/F-16);在 spec 升版前,G3 记 CONDITIONAL(16/20)。这两场景若进入矩阵,S2 将系统性偏低——**必须先升版再跑**。
5. **harness/runner/selftest.mjs 的 E01 dry-run 断言**已按新词表更新(hud 等已合法),当前 51/51 PASS。
6. **预算机器计数仅对新 Run 生效**(模板 build/browser 已串联计数);历史 Pilot 臂保持自报口径并已在 QUALIFICATION 标注。

## 后续建议顺序

```text
1. Benchmark Owner 决断 E04/E05 spec 升版文案 → briefs v1.0.2 → brief-freeze
2. 重验 E04/E05 四个 Reference(--revision spec-v1.0.2)→ ceiling-freeze(RULER-R2)
3. Agent Run 派发方按 DISPATCH.md 填 RUN-META.json(身份字段)→ preflight 全绿
4. targeted Pilot(E01/E02/E05/E10,§19)→ 验证新链路端到端
5. §20 全条件满足 → 启动 10×K0/K1×3 核心矩阵
```
