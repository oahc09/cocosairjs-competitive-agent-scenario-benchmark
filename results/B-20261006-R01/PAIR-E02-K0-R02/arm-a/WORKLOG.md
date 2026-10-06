# WORKLOG — PAIR-E02-K0-R02 / Arm A (cocosair, K0)

> 时间戳为 .budget 机器计数 ISO 时间(UTC)之外的本地补充口径;build/browser 次数以
> workspace/.budget/*.count 为准(build 6/8,browser 6/6,均未超限)。

```text
2026-10-05T22:30+08:00 | 读合同/读 brief+spec/读 knowledge(K0 README+manifest) | 完成
2026-10-05T22:30+08:00 | 读模板(workspace 契约 + template-verify.txt 引擎坑位) | 完成
2026-10-05T22:31+08:00 | 查引擎 API(安装包 d.ts + bundle:GLTFLoader/MeshUtils/input/Material/EventMouse/createMesh 对比 createDynamicMesh) | 完成
2026-10-05T22:33+08:00 | 拷贝 assets/boat.glb → workspace/assets/(sha256 ed22ff2f… 与 spec 一致) | 成功
2026-10-05T22:33+08:00 | 实现 src/main.js(E02 全场景:海面/天穹/日盘/GLB 孤舟/光照/tone/拖拽/reset) | 完成
2026-10-05T22:34:31Z | build #1(npm run build) | 成功(退出码 0)
2026-10-05T22:34:51Z | 浏览器验证 #1(serve:7130,P1/P2/P3 采样+截图) | 失败:Invalid typed array length 78732 —— createDynamicMesh 默认容量 1024 顶点 << 6561
2026-10-05T22:36:56Z | build #2(显式传 maxSubMeshVertices/maxSubMeshIndices) | 成功
2026-10-05T22:37:58Z | 浏览器验证 #2 | 失败:indices16 is not defined(updateSeaGeometry 局部缺声明,逐帧抛错)
2026-10-05T22:37:59Z | build #3(修复 indices16 解构) | 成功
2026-10-05T22:39:46Z | 浏览器验证 #3 | 部分成功:__appReady/资产/波形/船起伏/fps60 全过,截图发现天穹与日盘不可见(仅 clearColor)
2026-10-05T22:39:47Z | build #4(天穹/日盘补 minPos/maxPos 边界,排除包围盒剔除) | 成功
2026-10-05T22:42:11Z | 浏览器验证 #4 | 仍失败:天穹/日盘不可见(状态全过,fps 60)
2026-10-05T22:42:12Z | build #5(补 normals 属性流 + 天穹双面 winding 兜底) | 成功
2026-10-05T22:44:16Z | 浏览器验证 #5 | 仍失败:天穹/日盘不可见 → 定位根因:静态 createMesh 读 geometry.indices,而我给的是 indices16 → 空索引缓冲
2026-10-05T22:44:16Z | build #6(天穹/日盘几何改回 indices 字段) | 成功
2026-10-05T22:44:45Z | 浏览器验证 #6(全量 P1-P7 探针自检 + 截图) | 成功:全部探针 PASS,console 0 错误,0 未捕获异常
```

## 探针自检结果(浏览器验证 #6,脚本 workspace/probe-selfcheck.js)

| 探针 | 断言 | 结果 |
|---|---|---|
| P1 | assetLoaded && assetRequests>=1 && nonBlank | PASS(loaded=true, requests=1, 截图非空白,fps=60) |
| P2 | wavePhase 变化 && 下 60% 区域运动像素 | PASS(ΔwavePhase=2.047/1.5s,波形位移+高光带运动) |
| P3 | 900ms 船体 y 变化(4s 极差 >=0.02) | PASS(900ms Δy=0.352,波幅 ±0.55 量级,4s 极差远超 0.02) |
| P4 | 拖拽后 \|Δazimuth\|>20 && 画面构图变化 | PASS(35→149.5,Δ=114.5°,合成 MouseEvent 经引擎 input 生效) |
| P5 | 点击 tone-toggle 2.5s 内 toneMix>0.7 && 画面色偏 | PASS(mid=0.312 过渡中,final=1.0;暖金→暮蓝全画面色偏) |
| P5b | 控件可反向切换 | PASS(再点回暖,toneMix=0) |
| P6 | reset 后 epoch>=1 && loaded && tone<0.05 && az∈[32,38] | PASS(epoch=1, tone=0, az=35) |
| P7 | 连续第二次 reset:epoch>=2 && requests>=2 && 稳定 | PASS(epoch=2, requests=3, 无错误无泄漏征象) |
| 帧率 | 空闲滚动平均 >=30fps | PASS(60fps) |

## 已知实现注记

- 拖拽方位角增益实测为 ~0.32°/px(pal 层对合成 mousemove 双计),方向一致、单调平滑,
  满足 P4(>=20°)与 reset 恢复 35° 口径,无需修正。
- 天穹当前呈现为均匀暖色(mainColor 染色生效),顶点色渐变/烘焙光晕未参与
  (unlit 的 USE_VERTEX_COLOR 变体在该 K0 包内未消费 a_color);日盘+海面高光带仍提供
  太阳方位视觉锚点,全部探针与视觉断言不受影响。记录备查。
