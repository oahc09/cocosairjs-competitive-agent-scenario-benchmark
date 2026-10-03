# NC01 — empty-renderer(空渲染器)

## 造假方式

- `__bench.getState()` 返回**全正确**的 E01 状态:`starCount: 50000`、`rotationPhase` 按真实时钟以 0.05 rad/s 递增、`cameraDistance` 随滚轮变化、`parallaxOffset` 随指针变化、`fps: 60`、`hudVisible: true`、`reset()` 正确归零并 `epoch+1`。
- HUD 文本显示与状态一致的数字。
- **canvas 全黑**:初始化涂黑后再也不渲染任何东西(状态级交互合法、像素级零输出)。

对应 E01 forbiddenShortcuts 第 3 条:"不得以 __bench 状态声称代替真实渲染(状态正确但画面为空必须 FAIL,对齐 NC01)"。

## 预期被谁抓住

| 探针 | 结果 | 原因 |
|---|---|---|
| **P1(首杀)** | **FAIL** | stateAssertion `$.starCount >= 50000` 通过,但 visualAssertion `nonBlank`(亮像素占比 ≥ 2%)失败 —— 全黑画面 + 小 HUD 远低于 2% |
| P2-P7 | SKIPPED/FAIL | P1 失败后前置条件链断裂;即使执行,P2 motion / P3/P4 pixelDelta 也全无像素证据 |

## 预期 validate 判定

FAIL,挂在 **P1 visualAssertion(nonBlank)**。

## 失败分类映射(failure-taxonomy)

primary: `RUNTIME`(空渲染/画面不可用);secondary: 视觉合同违规证据(nonBlank)。
