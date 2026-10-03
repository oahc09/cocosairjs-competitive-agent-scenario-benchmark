# E06 — Three.js Reference VERDICT

- runId:`REF-E06-three`(终跑含 `--video`)
- 日期:2026-10-02
- 验证命令:`node bench/harness/runner/validate.mjs --workspace <E06> --spec bench/briefs/E06/spec.json --out <E06>/validation --run-id REF-E06-three --port 7415 --video`

## Verdict:FEASIBLE(PASS)

**Three.js r186 完整实现 E06 全部冻结规格,6/6 探针 PASS,无引擎级缺口。**

| 指标 | 结果 |
|---|---|
| classification | PASS |
| probes | P1 P2 P3 P4 P5 P6 全 PASS(权重 6/6) |
| fps | 60.1(spec minFps=30) |
| ready | 902ms(限 10s) |
| console errors / uncaught | 0 / 0 |
| build | 退出码 0 |
| 网络 | 15 请求全为本地 vendored 文件 |
| 录屏 | validation/video.webm(3.1MB,1280×720) |

## 探针证据摘要

| 探针 | 判定要点 | 实测 |
|---|---|---|
| P1 | 营地可见 + 夜空暗于火区 | worst lit 0.193(阈 0.03);night sky luma ~19 vs 火区暖池 warm 15%;treeCount 18 / fireflyCount 18 / tOD 0 / 环绕角 0.72 |
| P2 | 火光动态(状态差 + 帧差) | flicker 两采样 |Δ|=0.32(阈 0.02),帧差 0.471(阈 0.01);flicker ∈ [0.12,0.95] |
| P3 | 日夜渐变 + 天空变亮 | tOD 0→1(3.2s smootherstep);upper-third luma 19→176(9.3x,阈 1.5x);regionChange 0.682 |
| P4 | 环绕持续 + 构图连续 | 角速度 0.22 rad/s ∈ [0.05,0.4];3000ms 角度差 0.66(阈 0.15);motion 0.647 |
| P5 | 暂停后角度冻结 | orbitEnabled==false;角度只在 enabled 时累加(实现保证冻结) |
| P6 | reset 语义 | tOD=0(即时)、orbit=true、angle=0.224(<0.6)、firefly 18 / tree 18 恢复;天空回落夜景 |

## 规格覆盖(brief.md §2/§3/§7 对照)

- **必需项**:低多边形树环 18 棵(≥12,锥+柱,色相/缩放微随机)✓ / 起伏地形 + 营地圆盘(平直着色)✓ / 石圈 + 交叉柴堆程序化几何 ✓ / 火苗 ≥30(44 粒子 + 3 面片等效)✓ / 火星同屏峰值 ≥40(64 恒定循环,1.2-2.6 u/s,寿命 0.8-2s)✓ / **动态火光真实照明**(PointLight decay2,基准 0.55、波幅 ±0.31、四频 0.7-5.1 Hz;P2 帧差扩散到地面/树干)✓ / 萤火虫 18(≥16,游走+明灭,白天淡出计数不变)✓ / 日夜切换 3.2s 连续渐变(smootherstep 中间态真实存在)✓ / 天空-环境光-雾-星空-月亮联动 ✓ / 环绕相机 0.22 rad/s 可暂停恢复 ✓ / reset 全语义 ✓ / stateChannel 六字段 + engine/frame/ready/resetCount 全真实数据 ✓ / UI 三按钮 data-ui 右上角 + 状态标签 ✓
- **加分项(部分)**:星空 900 点闪烁 + 程序化月亮(Sprite+运行时 CanvasTexture)✓ / UnrealBloom 辉光(火/星/萤火虫)✓ / 地面暖光斑与点光同步闪烁 ✓ / 拖拽微调视角未做(可选项)
- **性能**:60fps(探针全程夜间+环绕常态),draw call ~110,三角 <15k

## 结论

E06 在 Three.js 侧**没有任何 ENGINE_LIMITED 项**。场景核心支撑:物理衰减动态点光(真实照明响应)、ShaderMaterial 全自由(天空/火焰/光斑/点精灵)、Points 自定义 attributes 粒子系统、运行时纹理生成、EffectComposer+Bloom+ACES 后处理、r186 核心 Timer——全部无补丁、无引擎修改。可作为 EngineCeiling 满分基线参与 AgentAttainment 计算。
