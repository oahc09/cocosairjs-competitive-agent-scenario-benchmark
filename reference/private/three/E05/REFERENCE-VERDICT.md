# E05 — Three.js Reference VERDICT

- runId:`REF-E05-three`(终跑含 `--video`)
- 日期:2026-10-02
- 验证命令:`node bench/harness/runner/validate.mjs --workspace <E05> --spec bench/briefs/E05/spec.json --out <E05>/validation --run-id REF-E05-three --port 7405 --video`

## Verdict:FEASIBLE(PASS)

**Three.js r186 完整实现 E05 全部冻结规格,6/6 探针 PASS,无引擎级缺口。**

| 指标 | 结果 |
|---|---|
| classification | PASS |
| probes | P1 P2 P3 P4 P5 P6 全 PASS(权重 6/6) |
| fps | 60.2(spec minFps=30) |
| ready | 1.14s(限 10s) |
| console errors / uncaught | 0 / 0 |
| build | 退出码 0 |
| 网络 | 17 请求全为本地 vendored 文件 |
| 录屏 | validation/video.webm(3.1MB, 1280×720) |

## 探针证据摘要

| 探针 | 判定要点 | 实测 |
|---|---|---|
| P1 | 中心1/3 + 四角非黑;星/流数量;初始距离 | worst lit 0.085(阈 0.03);bgStar 1900 / stream 320 / dist 14.0 / rot>0 |
| P2 | 盘旋转(两帧差 + diskRotation) | diff 0.075(阈 0.005);ω=0.38 rad/s ∈ [0.15,0.6] |
| P3 | 径向梯度存在(区域内变化) | diff 0.068(阈 0.01);像素直测 R-B:内 3 → 中 68 → 外 1(蓝白→橙→暗红) |
| P4 | wheel -600 后距离 <10 且构图变化 | dist 14→6.80(τ=0.12s 平滑);diff 0.389(阈 0.01) |
| P5 | 星流持续运动 | diff 0.389(阈 0.005);count 恒 320 |
| P6 | reset 语义 | dist=14.0, rot=0.158(<0.3), phase=0.025(<0.1), resetCount=1,画面完整 |

## 规格覆盖(brief.md §2/§7 对照)

- 必需项:径向颜色梯度 ✓ / 旋转条纹(0.38 rad/s,时间驱动)✓ / 星流≥200(320,恒定循环重生,加速+拖尾)✓ / 背景星≥300(1900)✓ / 辉光观感(UnrealBloom)✓ / 滚轮平滑缩放 [5,28] ✓ / stateContract 五字段真实数据 ✓ / UI reset(data-ui,右上角)✓
- 加分项:多普勒不对称(一侧 ×1.46 增亮偏蓝、另一侧 ×0.54 减暗)✓ / 引力透镜观感(盘后缘上弯光弧包绕核心)✓ / 拖拽微调视角 ✓ / 冷色星云 ✓
- 尺寸:事件视界 r=1.2 / 盘 1.8–6.5 / 初始距离 14 / 暗核初始直径约 104px ≈ 画面短边 14.5%(规格 8–15%)✓

## 结论

E05 在 Three.js 侧 **没有任何 ENGINE_LIMITED 项**。后处理链(EffectComposer/UnrealBloom/OutputPass/FXAA/自定义 ShaderPass)与 ShaderMaterial 全自由度是该场景的核心支撑,均在无补丁、无引擎修改的标准 API 下完成。可作为 EngineCeiling 满分基线参与 AgentAttainment 计算。
