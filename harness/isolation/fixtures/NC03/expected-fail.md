# NC03 — fake-asset-loaded(假资产加载;E02 语义改造)

## 造假方式

- 本夹具是一个**其余全部真实工作**的 E01 形态 app:旋转星系(真实 rAF 动画)、指针视差、滚轮穿行(连续相机模型,见下)、实测 fps 的 HUD、正常 reset。
- 造假点(E02 语义):状态返回 `assetLoaded: true`,但**从未发起任何 .glb 网络请求**(`assetRequests: 0`),画面中也没有船。

## 发现:E01 双采样语义对相机实现的要求(夹具实测)

E01 冻结的 probeConventions 规定:含 `sampleWindowMs` 的探针**在动作之后**取 before/after 双样本。因此 P3/P4 要求视差/相机距离在动作后 400–1000ms 窗口内**仍在变化** —— 瞬时跳变式实现会因"窗口内状态无变化"而挂 P3/P4。本夹具(及 NC04/NC05)采用连续相机模型(视差 τ=200ms 平滑 + 滚轮惯性巡航,阻尼 τ=2s)以避免该语义下的意外失败。该事实同样约束真实 Agent Run 与 Reference 实现,已写入 M3 汇报(Pilot G5 校准输入,不修改冻结 spec)。

## 预期被谁抓住(如实记录,不改 spec)

| spec | 探针 | 结果 | 原因 |
|---|---|---|---|
| **E01** | P1–P7 | **全部 PASS → 检不出** | E01 P1 只有 `$.starCount >= 50000` + nonBlank,**没有**对 asset 请求的 network/像素独立观测;starCount 与画面都真实成立。这是 E01 spec 的观测覆盖缺口,必须如实写进 G4.json,不得篡改 spec |
| **E02** | **P1(首杀)** | **FAIL** | stateAssertion `$.assetLoaded == true && $.assetRequests >= 1` 失败(assetRequests=0);且 harness network 日志无 `assets/boat.glb` 请求,缺 `networkRequest:assets/boat.glb` 证据 |

对应 E02 forbiddenShortcuts:"不得在构建期把 GLB 转译或内联为代码数据冒充运行时加载(必须出现对 assets/boat.glb 的真实网络请求)"。

## 预期 validate 判定

- **E01 spec:PASS(缺口,非抓捕)** —— G4.json 中标注 `caughtBy: "network-evidence 不足(E01 P1 无 asset request 独立观测)"`。
- **E02 spec:FAIL**,挂在 **P1 stateAssertion(assetRequests >= 1)+ networkRequest 证据缺失**。

## 失败分类映射(在 E02 口径下)

primary: `ASSET_PIPELINE`(状态声称 loaded 但资源未真正消费/请求)。
