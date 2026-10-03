# E02 REFERENCE VERDICT — Cocos AIR

- run-id:REF-E02-cocosair(final,--video)
- 时间:2026-10-02
- 引擎:cocosair.js 1.0.0
- 工作区:`bench/reference/private/cocosair/E02/`

## Verdict:FEASIBLE(完全达成,无 ENGINE_LIMITED 项)

- validate.mjs:verdict **PASS**,classification **PASS**
- probes:**7/7 PASS**(P1 加载/画面、P2 海面运动、P3 船体起伏、P4 拖拽环绕、P5 色调切换、P6 reset、P7 连续 reset)
- fps:**60.3**(minFps 30;2s 滚动平均,空闲与交互均满足)
- console:0 error / 0 warning / 0 uncaught(含多次 reset 全程)
- 网络:`assets/boat.glb` 真实请求 ×3(200;reset 用 ?reset=N 查询串强制真实重载)
- 生命周期:连续 reset 20 次后 post-GC JS 堆 34MB 平台,无泄漏征象;重建 <1s(契约 3s)
- S1/S2/S3 scoreInputs 全绿(probePassRate 1.0,lifecycleProbe P6 PASS,fpsMet true)

## 客观分预估(S 系,满分 60 中的客观部分)

- S1 可运行 15/15(build 0 错、ready 1.6s 内、首帧 nonBlank litRatio 0.771、无未捕获异常)
- S2 行为正确性 30/30(10/10 行为项全部有状态+独立观测证据)
- S3 技术合同与生命周期 10/10(reset 释放重建、fps、真实网络消费)
- S4 代码健康:单文件 ~1080 行含完整注释与坑位记录,esbuild 0 警告

## 关键工程事实(供 Agent Arm 对照)

1. 动态顶点动画:**必须走自定义 shader 位移**(引擎无就地改写顶点缓冲 API);EffectAsset JSON + 三变体 GLSL + onLoaded 后 register 是唯一正典路径,一次编译通过(0 console 错误)。
2. 鼠标拖拽:**必须走 `input.on(Input.EventType.TOUCH_*)`**;pal 层对 canvas 鼠标事件 stopPropagation,DOM window 监听全部收不到——这是本场景最大暗坑,K0/K1 知识包若无此条,Agent 大概率在 P4 卡 1-2 轮。
3. GLTF 生命周期:loadAsync→instantiate→(reset)instance.dispose+asset.destroy→再次 loadAsync,稳定;加查询串可强制真实网络重载(assetRequests/NC05 证据最硬)。
4. 顶点数契约(≥2000):非均匀细分网格 12321 顶点,`getState().seaVertices` 自证。

## 产物索引

- `validation/report.json`(唯一判定事实源)、`validation/probe-results.json`、`validation/video.webm`、`validation/screenshots/`(28 张)
- `WORKLOG.md`(方案/坑/迭代)、`ceiling-notes.md`(六维自评与能力清单)
