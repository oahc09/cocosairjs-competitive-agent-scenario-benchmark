# REFERENCE VERDICT — E09 珠宝展示台 · Three.js r186

| 项 | 值 |
|---|---|
| runId | REF-E09-three(--video 终轮) |
| verdict | **PASS** |
| classification | PASS |
| 探针 | **8/8 PASS**(passRate 1.0,权重 8/8) |
| fps | **60.2**(minFps 30;采样 3s rAF,181 帧) |
| ready | appReady=true / benchReady=true(4261ms) |
| console | 0 error / 0 uncaught / 1 harmless warning(D3D info-log X4122) |
| 导出独立观测 | download x2:`gem-stage-…-1.png` 596157B、`gem-stage-…-2.png` 596865B(>10240 ✓,1280×720 与画布一致) |
| 生命周期 | P8 reset 恢复 diamond/10/0 且转台继续(1.5s 后 rotationAngle 48.53°) |
| 工程健康 | build 4.1s 一次通过 ×9 轮;dist/app.js 14.9KB(引擎 external);产物自检 OK |
| 结论分类 | **FEASIBLE**(引擎上限内完全可达成,无 ENGINE_LIMITED 项) |

## 证据索引(均在 validation/)

- `report.json` — 唯一判定事实源(scoreInputs S1/S2/S3 全绿)
- `probe-results.json` — 8 探针逐步 stateBefore/After + 视觉断言指标
- `screenshots/`(35 帧)— P1 初始 / P3 ruby / P4 推近特写 / P5 拉回 / P8 reset
- `downloads/` — 真实导出的两张 PNG
- `video.webm`(4.8MB)— 全程录屏(含色板切换、双击往返、两次导出、reset)
- `console.json` / `network.json`(gem.glb 加载留痕)/ `perf.json` / `build.log`

## 与 spec.stateContract 对齐(终轮实测)

| 字段 | 合同 | 实测轨迹 |
|---|---|---|
| rotationAngle | 度,单调增,≥25°/s | 133.3 → 309.9 → 420.3 → 533.9 → 658.6 → 790.9 → 888.5(32°/s);reset 归零后续转 |
| selectedColor | 色名 | diamond → ruby(P3) → diamond(P8) |
| cameraDistance | 初始 10;≤6 / ≥9 | 10 → 5.2(P4,950ms 缓动) → 10(P5) → 10(P8) |
| exportCount | 真实下载计数 | 0 → 1(P6) → 2(P7) → 0(P8) |
| resetCount | — | 0 → 1(P8) |

## 给 Agent Run 的可达性说明

本场景 Three.js 侧无引擎天花板阻塞:transmission/dispersion/PMREM/EffectComposer 均为
开箱即用(addons 一行 import)。难点不在 API 可用性,而在**观感调校**(见
ceiling-notes.md):LDR 环境做不出珠宝闪感,HDR 环境场景 + 阈值化 bloom + 双层宝石
(透射壳 + 内金属核)是本 Reference 达到广告级的三个关键决策。
