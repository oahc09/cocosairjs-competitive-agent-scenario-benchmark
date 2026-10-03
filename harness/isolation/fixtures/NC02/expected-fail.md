# NC02 — frozen-animation(冻结动画)

## 造假方式

- 初始化用 2D canvas **画一帧**真实星空(50000 点,P1 nonBlank 以 ~5% 亮像素通过)。
- **没有任何动画循环**(无 requestAnimationFrame):画面永久静止。
- 状态撒谎:`rotationPhase` 由 setInterval 持续按 0.05 rad/s 累加,`fps` 恒报 60。
- 指针/滚轮**确实**触发一次性重绘(带视差偏移/缩放),所以 P3/P4 的 pixelDelta 能通过 —— 唯一 broken 的合同是"持续运动"。

对应 E01 forbiddenShortcuts 第 4 条:"不得冻结画面而状态仍报告旋转与帧率(对齐 NC02)"。

## 预期被谁抓住

| 探针 | 结果 | 原因 |
|---|---|---|
| P1 | PASS | 静态帧亮像素 ~5% ≥ 2% |
| **P2(首杀)** | **FAIL** | stateAssertion `$.after.rotationPhase - $.before.rotationPhase > 0.001` **通过(谎报)**,但 visualAssertion `motion`(中央 80% 区域 2s 采样窗运动像素比 ≥ 0.5%)失败 —— 两帧完全相同 |
| P3–P7 | SKIPPED | 前置条件链以 "P2 passed" 为界,首杀后全部跳过(其 pixelDelta 行为见上:输入触发的同步重绘本身有真实像素变化) |
| 佐证 | — | harness 独立 perfSample(rAF 计数)另记 ~0fps,与状态谎报的 60fps 矛盾 |

**关键点:P2 的抓捕依赖 visualAssertion(motion)与 stateAssertion 的分离** —— 状态谎报能骗过 jq 断言,骗不过像素差。

## 预期 validate 判定

FAIL,挂在 **P2 visualAssertion(motion)**(+ 独立 perfSample 佐证)。

## 失败分类映射

primary: `ANIMATION`(画面静止但状态称 playing);secondary: `STATE_MANAGEMENT`(状态谎报)。
