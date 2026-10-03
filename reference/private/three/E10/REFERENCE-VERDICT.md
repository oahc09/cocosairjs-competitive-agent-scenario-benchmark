# E10 Three.js Reference — VERDICT

- run-id:`REF-E10-three`(final,--video,--port 7407)
- 日期:2026-10-02 | 引擎:three@0.186.1(vendored / esbuild external)
- 报告:`validation/report.json`(事实源)| 录屏:`validation/video.webm` | 截图 31 张

## 结论:**FEASIBLE — PASS**

| 指标 | 值 |
|---|---|
| verdict / classification | **PASS / PASS** |
| 探针 | **7/7 PASS**(P1 加载+双实例非空、P2 双实例动画运动、P3 A→walk 隔离、P4 销毁 A、P5 B 存活续动、P6 reset 无新请求、P7 恢复+帧率) |
| passRate(权重) | 1.0 |
| fps(harness rAF 3s) | **60.2**(spec ≥30;滚动 60 帧均值同源暴露在 getState().fps) |
| ready | appReady=true,bench 契约可用,578ms(≤10s) |
| console | errors 0 / warnings 0 / uncaught 0 |
| 网络 | `GET /assets/character.glb → 200` **恰好 1 次**(整会话含 reset) |
| build | 退出码 0,单 attempt,~4s,自检通过(引擎未打进 bundle) |

## 探针证据摘录(final 轮)

| 探针 | state 断言 | visual 度量(阈值) |
|---|---|---|
| P1 | assetLoaded∧instanceCount=2∧A/B=idle | lit A 0.29 / B 0.40(≥0.10) |
| P2 | A.time>0 ∧ B.time>0 | motion A 0.198 / B 0.265(≥0.005) |
| P3 | A.clip=walk ∧ B.clip=idle | A 区 regionChange 0.245(≥0.01) |
| P4 | instanceCount=1 ∧ destroyedInstance="A" ∧ A=null | A 区 regionChange 0.178 |
| P5 | B=idle ∧ B.time>0 | B 区 motion 0.120 |
| P6 | resetCount=1 ∧ 双实例 idle ∧ destroyed=null | lit A 0.61 / B 0.26;**无新 GLB 请求** |
| P7 | A/B.time>0 ∧ fps≥30 | motion A 0.29 / B 0.37 |

独立复核(不依赖 harness):P4 后 A 区狐毛色像素占比 0.000、B 区仍>0;P6 后两区均恢复——销毁/重建与像素事实一致。

## 迭代成本

- 验证 3 轮(R1 首版全绿 → R2 去 2 条引擎警告 → Final 录屏);build attempts 3/3 成功;browser attempts 3;repairCount 0(R2 属净化非修复)。
- 首版即全绿的关键前置:离线解析 GLB 发现 Survey/Walk 根位移轨道并做原地化;预读 harness 确认 fps 字段与 ui 定位语义。

## 六维自评(0–3,Reference 自评口径,正式分以盲评 visualScores 为准)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 双实例分列屏左/右完整入画(位于断言区中央带),中景轻俯,缓慢摆动环绕构图稳定;展台光圈+地坪光池层次清晰 |
| 材质光影 | 2.5 | GLB 贴图分区正确(橙毛/白胸/黑腿耳),三点布光+半球环境,接触阴影(PCF 1024),ACES tonemap,渐变穹顶+雾;受 r186 移除 PCFSoft 限制 |
| 动效流畅 | 3.0 | 60fps,0.25s 交叉淡化,就地 Survey/Walk 差异明显可辨,相机阻尼平滑 |
| 特效质感 | 2.0 | 展台脉冲光圈、顶面 A/B 刻字、光池地坪、雾;无后处理链(本场景非必需) |
| 交互反馈 | 2.5 | 按钮 hover/active/置灰全反馈,点击即时切换,HUD 5Hz 实时,画布拖拽/缩放可用 |
| 整体完成度 | 3.0 | 全探针+契约+生命周期闭环,console 全零,录屏证据完整 |
| **合计** | **15.5/18** | visual ≈ round(15.5×40/18)= **34/40** |

## Objective 自评

S1 可运行 15/15(build ✓、ready 无错 578ms、首帧 lit 0.157≥0.02);S2 行为 30/30(7/7 探针);S3 生命周期+性能 10/10(P6 过、fpsMet);S4 代码健康 5/5(单文件模块化、注释完备、零警告、build 自检)。
**自评总分 ≈ 60 + 34 = 94/100**(EngineCeilingComparableScore 口径)。

## 备注

- 视觉核验方式:harness lit/diff 像素度量 + 独立 pngjs 像素复核 + 远程视觉模型抽检(P1/final);本会话内联图片通道不可用,以上三路证据交叉一致。
- 诚实声明:getState 一切字段实时取自渲染循环活动对象,无任何预置/伪造路径;fps 为真实 rAF 间隔滚动均值。
