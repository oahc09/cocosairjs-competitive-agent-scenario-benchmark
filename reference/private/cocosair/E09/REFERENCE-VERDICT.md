# REFERENCE-VERDICT — E09 珠宝展示台 · Cocos AIR(trusted reference)

| 项 | 值 |
|---|---|
| runId | `REF-E09-cocosair` |
| verdict | **FEASIBLE(with documented engine-limited material path — 见下)** |
| classification | PASS |
| probes | **8/8 PASS**(P1 就绪构图 / P2 转台 / P3 色板 / P4 双击推近 / P5 双击拉回 / P6 导出 / P7 连续导出 / P8 reset) |
| fps | 60.2(阈值 30;相机过渡与导出期间无明显掉帧) |
| downloads | 2 次,324,952 B 与 265,830 B(均 >10,240 B,PNG,1280×720 与画布一致) |
| console | 0 errors / 0 uncaught |
| build | `npm run build` exit 0(esbuild,引擎 external) |
| 生命周期 | `__appReady` 首帧后 true;`__bench.getState()/reset()` 契约字段齐备 |
| 稳定性 | 修复后连跑 4×8/8 PASS + 最终 `--video` PASS |
| 证据 | `validation/report.json`、`validation/probe-results.json`、`validation/screenshots/`(每探针 before/after/vis)、`validation/video.webm`、`validation/downloads/` |

## 材质路径结论(本场景实验答案,详见 ceiling-notes.md)

1. **引擎自带 KHR_materials_transmission 路径(air-gltf-physical)在 v1.0.0 不可用**:片元局部变量 `airTrFactorTex/airThickTex` 恒 0,折射/色散瓣为死代码;加载含 transmission 扩展的 GLB 只会得到普通不透明 PBR 外观。
2. **两相机 scene-color 捕获管线(AirTransmissionCapture)本身可用**,且按 `pass.defines.USE_AIR_TRANSMISSION` + 属性名(`cc_sceneColorTex`/`airSceneColorInfo`)与材质解耦——自定义 EffectAsset 声明同名槽位即可被自动认领。
3. 本 Reference 据此实现**真实屏幕空间折射**(采样实时离屏场景色,折射角×厚度偏移)+ **RGB 三通道色散**(三 IOR 三采样)+ 菲涅尔 + 三点 Blinn-Phong 镜面:宝石透面可见倒置/扭曲的棚拍背景,火彩随转台/环绕轮廓光流动,**非贴图烘焙、非漫反射冒充**(forbiddenShortcuts 1/2 不触发)。
4. 附带两个独立于本场景的引擎缺陷记录(White-Screen NaN、运行期 Vec4 丢第 4 分量),已在 WORKLOG §2/§3 给出最小复现与规避。

## 行为正确性对照(scoring.behaviorItems)

| 项 | 状态 |
|---|---|
| 高折射观感(透过宝石见扭曲背景,表观 IOR 观感 ≥1.5) | 达成(离屏场景色真实折射,ior 2.4 口径) |
| 切面锐利镜面高光随转台扫动 | 达成(三点 Blinn-Phong 硬高光 + 42°/s) |
| 切面棱线色散火彩随转台/视角流动 | 达成(RGB 三 IOR 三采样 + 三通道菲涅尔彩虹缘) |
| 三点棚拍层次 | 达成(键光 DirectionalLight / 辅光宽柔 Spot / 轮廓光环绕 Spot,肉眼可辨三层) |
| 转台 ≥25°/s 且单调累计 | 达成(42°/s,P2 断言过) |
| 色板 ≥5 色同步 | 达成(5 色,五色 RGB 实测分明,见 WORKLOG §3 表) |
| 双击推近 10→≤6,≥600ms 缓动 | 达成(→6,900ms,P4) |
| 再双击拉回 ≥9 平滑 | 达成(→10,P5) |
| PNG 真实下载 >10KB 同分辨率 | 达成(P6/P7 download 事件独立观测) |
| 连续导出递增不冻结 | 达成(exportCount 1→2,P7 motion 同时验证转台仍运转) |
| reset 恢复初始且转台继续 | 达成(P8) |

## 红线自查

- 未伪造任何状态(rotationAngle 每帧真实累计;exportCount 仅在下载触发后递增)。
- 导出像素来自当前画布(引擎 swapchain preserveDrawingBuffer:true,非预置 PNG)。
- 双击为取景相机真实位移(非视口/DOM 缩放)。
- 未改动 spec/brief;产物只写本工作区。
- 失败 trial 全部保留于 WORKLOG 时间线(中间 validate 输出目录已清理,时间线如实记录 23 次调用)。
