# Remaining Risks — AUDIT-20261003

## 阻断正式 120-run 矩阵的事项(按 §20 条件评估)

| ID | 事项 | 需要的动作 | 为什么不能在本轮做 |
|---|---|---|---|
| ~~B-1~~(已解决 2026-10-03) | **E05 spec v1.0.2 升版**(P3 ring 色彩断言与真实画面不符,F-15) | 冻结修订:方位角扇区化(如"多普勒亮侧扇区 R-B≥25"),重跑 E05 双引擎 Reference 重验,ceiling-freeze 换新量尺 | 红线禁止"修改冻结 Brief 迁就现有实现"式热修;升版决策(断言如何改)属 Benchmark Owner 权限,且需重新冻结走完整流程 |
| ~~B-2~~(已解决 2026-10-03) | **E04 spec v1.0.2 升版**(P4 余烬窗口 vs 采样时延,F-16) | 冻结修订:余烬分层寿命窗口加长(或 region 放宽为 full),同上重验 | 同上 |
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

## 处置后记(2026-10-03 v1.0.2 轮)

B-1/B-2 已按 spec 升版流程解决:E04 v1.0.2 / E05 v1.0.2(修订记录在 spec.json amendments);双引擎 Reference 重验 PASS(20/20);RULER-R02 冻结;G3 恢复 PASS。B-3(code-review 证据)与 B-4(OS 级隔离)保持为正式矩阵前建议项。注:brief-freeze 触发的全员 briefSha 漂移(行尾/回填)经 20 项统一重验消化,进入 R02 新纪元。

## Targeted Pilot(B-20261003-R05)新发现(2026-10-03)

| ID | 发现 | 归因 | 处置 |
|---|---|---|---|
| F-18 | E01 双臂 P7 reset 后 parallaxOffset 残留(指针停在 reset 按钮上,目标未清零) | Agent 实现模式(参考实现已证明可解:reset 清零视差目标) | Agent 侧;spec 无需改(断言合理) |
| F-19 | E01-b(AIR)P4 滚轮完全失效(wheel 挂 window 冒泡,引擎 canvas stopPropagation 吞事件)——**独立验证抓到自检假阳性**(Agent 代码走查推演通过) | AIR K0 已知坑 G5 + Agent 未按坑表用捕获监听 | Agent 侧;K1/K2 坑表已收录,验证 KnowledgeGain 的直接素材 |
| F-20 | E05 双臂 P1 四角背景星密度 <3%(0.004-0.013/0.015-0.035),与首轮同因重复 | Agent 无验证器反馈下的视觉密度校准(双引擎对称) | Agent 侧;spec 偏严与否留 Owner 判(不改阈值迁就) |
| F-21 | 执行器 mid-ring 几何以视口中心为圆心且带越界(y=-158) | Harness 缺陷(本轮发现并修复:暗核中心自适应+viewport clamp+annulus max 聚合) | 已修复并复验 |
| F-22 | qualify/validate 集成三 bug(--revision 顶层 report 丢失、budget 路径、sidecar 双 schema) | Harness 缺陷 | 已修复并复验(新批 qualification=QUALIFIED_OBJECTIVE ×4) |

## F-23 引擎健壮性缺陷(用户实测报错,2026-10-03)

**现象**:``cocosair.module.js:800 Uncaught Error: _updateAdaptResult Invalid size.``(栈:mediaQueryResolution.once → ScreenAdapter.emit → View._updateAdaptResult:45838 assert)

**根因**(引擎源码已核):`View._updateAdaptResult(width,height)` 仅在 width>0&&height>0 时适配,否则 assert(false) 抛未捕获异常;触发链 = matchMedia(resolution) DPR 变化事件(DPI 显示器切换/缩放)→ window-resize 携带当前 windowSize —— 若页面此刻 display:none(0×0,如门户隐藏页签内的 iframe)即为 0×0。

**触发场景**:门户对比页 iframe 在页面加载时即被赋 src,compare 页签 display:none → cocosair 引擎隐藏态完成初始化,首个 DPR 事件崩溃。

**页面层修复(已落地)**:门户 fillCompare 懒加载——compare 页签未激活时 iframe 不赋 src(记录 pending),激活时才加载;已验证逻辑。
**引擎侧建议(cocosair.js)**:_updateAdaptResult 对非法尺寸不应 assert 抛异常,应跳过本次适配并保留上次有效尺寸,待下次有效 resize 再适配(良性瞬态 ≠ 致命错误)。建议补回归用例:display:none iframe 内启动引擎 + DPR 变化 → 无异常。
**实验影响**:无——验证流水线从不隐藏页面;历史证据不受影响。属门户/浏览体验层缺陷 + 引擎健壮性缺陷。
