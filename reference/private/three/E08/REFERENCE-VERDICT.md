# REFERENCE-VERDICT — E08 深海鱼群(Three.js r186)

- runId:`REF-E08-three`(final,--video)
- 日期:2026-10-02
- spec:`bench/briefs/E08/spec.json`(v1.0.0,冻结)

## Verdict: **FEASIBLE**(engine ceiling 可测)

Three.js r186 下 E08 全部冻结探针通过,无引擎能力缺口,无性能压力(60fps vs 阈值 30)。
AgentAttainment 分母可按本 Reference 的可比分计算。

## 证据摘要(validation/report.json)

| 项 | 结果 |
|---|---|
| build | PASS(exit 0,4698ms) |
| __appReady / __bench | true / true |
| probes | **8/8 PASS**(P1–P8,passRate 1.0) |
| fps | 60.1(spec ≥30) |
| console errors / uncaught | 0 / 0 |
| 首帧 litRatio | 0.44(S1 nonBlank ✓) |
| lifecycle(P7 reset) | PASS(resetCount=1,foodActive=false,boidMode=normal,计数恢复) |
| video | validation/video.webm(6.7MB,完整探针序列) |

## 逐探针终值

| Probe | 断言 | 实测(采样值) |
|---|---|---|
| P1 | fish≥80, plankton≥300, normal, foodActive=false | 110 / 520 / normal / false;litRatio 0.44 |
| P2 | normal && cohesion≥0.45 | cohesion 0.606 |
| P3 | scatter && cohesion<0.35 | scatter / 0.177 |
| P4 | normal && cohesion≥0.45 | normal / 0.541 |
| P5 | foodActive && foodPosition≠null | true / (0,0,0) |
| P6 | avgDistanceToFood≠null && <6 | 2.077 |
| P7 | reset 恢复 | 全部满足,resetCount=1 |
| P8 | 计数保持 + pixelDelta | 满足(diff 0.02+) |

## 红线自查

- avgCohesion/avgDistanceToFood/foodActive 全部由每帧模拟实算,无硬编码;
- 惊散由指针-鱼真实 3D 距离触发(逐帧判定,无定时器/脚本触发);
- foodPosition 记录投喂世界坐标,食物被啃食缩小、吃尽或超时(16s ≥ brief 的 8s)消失;
- reset 非页面刷新(种子化重生,resetCount 递增);
- 禁止项(预烘焙轨迹/广告牌冒充/探针期临时提规模)均未触碰。

## 可复现

```
cd bench/reference/private/three/E08 && npm run build
node bench/harness/runner/validate.mjs --workspace <abs-workspace> \
  --spec bench/briefs/E08/spec.json --out <ws>/validation \
  --run-id REF-E08-three --port 7419 [--video]
```
