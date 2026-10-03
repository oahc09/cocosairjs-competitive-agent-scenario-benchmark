# NC05 — lifecycle-leak(生命周期泄漏)

## 造假方式

- app 其余功能全部真实(动画/连续相机模型视差/滚轮惯性巡航/HUD/reset 按钮;相机模型同 NC03,见其 expected-fail.md 中关于 E01 双采样语义的说明 —— 平滑/惯性是让 P3/P4 按语义通过的必要条件)。
- 泄漏点 1:`reset()` 启动**新的**动画循环却不清除旧循环 → reset 后两个循环同时推进 `rotationPhase`(0.08 × 2 = 0.16 rad/s)。
- 泄漏点 2:初始化创建的 logging interval **永不清除**:每 250ms `console.log("[leak] interval survived reset: leakedTicks=N)")`,`leakedTicks` 状态持续增长。

## 预期被谁抓住

| 探针 | 结果 | 原因 |
|---|---|---|
| P1–P4 | PASS | 单循环阶段行为正常(0.08 rad/s ∈ [0.02,0.1]) |
| P5/P6 | PASS | HUD/fps 正常 |
| **P7(首杀)** | **FAIL** | stateAssertion 中 `$.rotationPhase < 0.1` 失败:reset 后 0.8s,双循环累计相位 ≈ 0.16 rad/s × 0.8s = 0.128 > 0.1(epoch/camera/parallax 部分全部正常,精确暴露"reset 副作用不干净")|
| 佐证 | — | console 持续输出 `[leak] ...`(harness console 收集捕获);`leakedTicks` 在 reset 后仍单调增长 |

## 预期 validate 判定

FAIL,挂在 **P7 stateAssertion(reset 合同)** + console 持续泄漏输出佐证。

## 失败分类映射

primary: `LIFECYCLE_MISUSE`(reset 副作用不干净、泄漏 interval 存活);secondary: console 证据。
