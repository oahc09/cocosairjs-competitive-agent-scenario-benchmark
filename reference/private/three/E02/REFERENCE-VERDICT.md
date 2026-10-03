# REFERENCE-VERDICT — E02 落日海面与孤舟(three r186)

- Run ID:`REF-E02-three`(最终轮含 `--video`)
- 报告:`validation/report.json`(single source of truth)
- **Verdict:PASS(classification = PASS)**
- 可行性结论:**FEASIBLE** —— E02 全部冻结探针在 Three.js r186 上以充足余量通过,无引擎级阻碍。

## 探针结果(7/7 PASS,passRate = 1.000)

| Probe | 断言要点 | 状态 | 实测余量 |
|---|---|---|---|
| P1 | assetLoaded && assetRequests≥1;nonBlank≥0.05;真实网络请求 | PASS | litRatio 0.785(阈 0.05);`GET /assets/boat.glb` 200 ×1 |
| P2 | wavePhase 采样窗内变化;下 60% 运动≥0.01 | PASS | diffRatio 0.889(阈 0.01) |
| P3 | boatPosition.y 变化;中央 40% 运动≥0.002 | PASS | diffRatio 0.841;4s y 极差 0.295(阈 0.02) |
| P4 | 拖拽后 200ms 采样窗 Δazimuth>20;pixelDelta≥0.02 | PASS | 窗口 Δ=28.32°;diffRatio 0.85 |
| P5 | toneMix>0.7(2.5s 内);avgColorShift≥8 | PASS | toneMix 0.99;shift 80.2/255 |
| P6 | reset 后 epoch≥1、assetLoaded、toneMix<0.05、az∈[32,38];nonBlank | PASS | epoch=1,toneMix=0,az=35.00 精确;lit 0.79 |
| P7 | 二次 reset:epoch≥2、assetRequests≥2;nonBlank | PASS | epoch=2,assetRequests=3(共 3 次 200 请求) |

## 完成合同核验

- `npm run build` 退出码 0(esbuild,app.js 21.5KB,引擎 external 由 importmap 解析)✓
- `window.__appReady === true` 于 504ms(预算 10s,含资产加载)✓
- `window.__bench = { getState, reset }` 存在且可调用 ✓
- console:**0 error / 0 warning / 0 uncaught**(全程:加载、交互、两次 reset)✓
- fps:60.1(2s rAF 采样;阈值 30)✓
- 红线:GLB 运行时真实请求(网络日志 3×200,无内联);6 材质保留;海面 GPU 顶点位移+逐像素细节;船体起伏与波形同参数耦合;reset 无整页刷新且显式 dispose;无画布遮挡 ✓

## 评分输入(harness 口径)

- S1:buildPass ✓ / readyNoError ✓ / firstShotNonBlank ✓(lit 0.813)
- S2:probePassRate = 1.000(7/7,10 条行为项全覆盖)
- S3:lifecycleProbe(P6)PASS ✓ / fpsMet ✓
- Visual(自评换算见 ceiling-notes.md 六维):16/18 → visual ≈ 36/40
