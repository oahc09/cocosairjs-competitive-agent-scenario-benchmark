# NC04 — broken-interaction(交互失效)

## 造假方式

- 动画真实(旋转星系,P1/P2 通过);`window.__bench.state` 是**可直接写入的活引用**(可写状态陷阱)。
- 但全部输入事件是 no-op:`pointermove` 永不改变 `parallaxOffset`,`wheel` 永不改变 `cameraDistance`,canvas 点击无任何状态/视觉变化。
- E01 的 P3(视差)与 P4(穿行)因此挂掉。

## 预期被谁抓住

| 探针 | 结果 | 原因 |
|---|---|---|
| P1/P2 | PASS | 渲染与动画真实 |
| **P3(首杀)** | **FAIL** | stateAssertion `$.after.parallaxOffset.x != $.before.parallaxOffset.x || ...` 失败(指针移动前后状态零变化)。注意:pixelDelta **可能通过**(星系持续旋转导致前后帧有差)—— 这正是为什么 stateAssertion 双采样是必要独立观测 |
| **P4** | **FAIL** | stateAssertion `$.after.cameraDistance < $.before.cameraDistance - 5` 失败 |
| P7 | SKIPPED | 前置条件 "P4 passed && P3 passed" 不成立 |

## 预期 validate 判定

FAIL,挂在 **P3/P4 stateAssertion**(交互无状态变化)。

## 失败分类映射

primary: `INTERACTION`(点击/滚轮/指针无响应)。
