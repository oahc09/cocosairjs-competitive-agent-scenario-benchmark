# REFERENCE-VERDICT — E06 荒野篝火营地 · Cocos AIR

```yaml
briefId: E06
engine: cocosair.js@1.0.0 (WebGL2, Code First, legacy pipeline)
runId: REF-E06-cocosair
date: 2026-10-02
verdict: FEASIBLE
probes: 6/6 PASS (P1 P2 P3 P4 P5 P6)
fps: 60.1 (minFps 合同 30)
buildAttempts: 5 (validate 迭代;前 2 轮为 Quaternion 导出名/用法踩坑,后 3 轮全绿)
consoleErrors: 0
uncaughtErrors: 0
video: validation/video.webm
```

## 结论

E06 在 Cocos AIR 上**完全可行(FEASIBLE)**:6/6 探针全绿、60fps、零错误。
核心探测项——**动态点光真实照明——成立**:真实 PointLight 的 luminance
随多频闪烁逐帧驱动,forward additive 多 pass 路径把火光真实打在低多边形
地面与树干上(P2 帧差 0.369,环境受光随闪烁波动,非仅火苗自发光)。
缺口仅两处且均不阻塞合同:点光无阴影(引擎明示不支持)、无全屏 bloom
(Code First 默认管线无后处理;以 additive 光晕面片近似,见 ceiling-notes)。

## 客观分(自评,口径 §16)

| 项 | 得分 | 依据 |
|---|---|---|
| S1 可运行 | 15/15 | build exit 0;10s 内 ready(实测 <2s);__bench 可用;0 console error;首帧非空(litRatio 0.202) |
| S2 行为正确性 | 30/30 | 6/6 probes PASS;11 条 scoring.behaviorItems 全部满足(树环 16/萤火虫 20/火星同屏 60/火苗面片+粒子/动态点光真实受光/日夜 3.2s 连续渐变含中间态/白天端点 t≥0.9/环绕 0.24rad/s+冻结/reset 全复位) |
| S3 技术合同与生命周期 | 10/10 | fps 60.1 ≥ 30;真实时间步进(dt clamp 0.1 防失焦跳变);reset 后持续运行(P6 PASS);无多余网络请求(仅模板 4 个) |
| S4 代码健康 | 4.5/5 | 单文件 ~1030 行,注释含引擎坑位记录(Quat 导出名/clearColor 赋值语义/点光无阴影);扣 0.5:粒子重生 RNG 用年龄量化种子,可读性一般 |
| **Objective 小计** | **59.5/60** | |

## 视觉六维自评(0-3)

| 维度 | 分 | 说明 |
|---|---|---|
| 构图取景 | 2.5 | 篝火居中、俯角环视、树环+前景剪影构成层次;环绕运镜持续变化;个别角度近树局部遮挡 |
| 材质光影 | 3 | 真实动态点光(暖橙闪烁照亮地面/树干形成冷暖对比)+ 日夜全链插值(天穹/环境光/主光/clearColor);低多边形 flat shading 地形;无阴影但不扣本维度核心 |
| 动效流畅 | 3 | 60fps 恒定;域扭曲火焰摆动、火星上升消散、萤火虫游走明灭、烟羽扩散、环绕+拖拽平滑 |
| 特效质感 | 2.5 | 双层程序化火焰(橙黄→红渐变、焰心亮核)+ 光晕面片 + 软圆粒子;无全屏 bloom,辉光局限于火区本地(与 Three bloom 方案的可感知差距) |
| 交互反馈 | 2.5 | 日夜 3.2s 连续渐变可见、环绕暂停即冻结、reset 瞬时复位、拖拽微调(加分项);状态文本提示 |
| 整体完成度 | 3 | 全合同达成、零错误、日夜两端+中间态观感稳定,夜景/日景均为完整画面 |
| **合计** | **16.5/18** | `visual = round(16.5×40/18) = 37/40` |

**总分(参考)= 59.5 + 37 = 96.5 / 100**

## AgentAttainment 基准

本 verdict = FEASIBLE ⇒ 可作为 E06-cocosair 臂的 EngineCeilingComparableScore 分母。

## 风险与注意(Agent 侧复现要点)

1. 点光逐帧动画:直接 `pointLight.luminance = v`(HDR);`color` 赋值即克隆下推,run 前赋值亦有效(激活时同步)。
2. `camera.clearColor` 与 `light.color` 都必须**赋值**而非原地改(仅 setter 下推渲染侧)。
3. 四元数导出名是 `Quat`(静态方法 `Quat.fromAxisAngle(out, axis, rad)`),没有 `Quaternion` 导出,`quat()` 工厂实例无实例方法。
4. 夜景亮度平衡是视觉成败关键:ambient skyIllum 夜间 ~3800 + 月光 ~1900 lux(初版 1500/850 过暗,近黑不可辨)。
5. 树环半径与相机轨道半径错开(树 ≤9.6 vs 轨道 12.8),避免近景巨树遮挡画面。
6. 无 3D 粒子系统:火苗/火星/萤火虫/烟 = `createDynamicMesh`+`updateSubMesh` 单网格单 draw call(tarball 上挂 `utils.MeshUtils`)。
7. 自定义 effect 注册必须晚于 `createAirApp`;WebGL2 只消费 glsl3;使用 cc_time 的片元须自声明 CCGlobal UBO。
