# REFERENCE-VERDICT — E05 黑洞吸积盘 · Cocos AIR

```yaml
briefId: E05
engine: cocosair.js@1.0.0 (WebGL2, Code First, legacy pipeline)
runId: REF-E05-cocosair
date: 2026-10-02
verdict: FEASIBLE
probes: 6/6 PASS (P1 P2 P3 P4 P5 P6)
fps: 60.2 (minFps 合同 30)
buildAttempts: 10 (validate 迭代)
consoleErrors: 0
uncaughtErrors: 0
video: validation/video.webm
```

## 结论

E05 在 Cocos AIR 上**完全可行(FEASIBLE)**:6/6 探针全绿、60fps、零错误、
全部必需观感达成,加分项(多普勒不对称、引力透镜观感近似、拖拽视角)亦达成。
后处理(Bloom)在默认 Code First 管线下**确认不可用**;辉光以多层 additive
billboard + shader 内衰减的"bloom impostor"替代实现,满足 spec"实现路径不限"
的辉光观感合同(详见 ceiling-notes.md 的差距描述)。

## 客观分(自评,口径 §16)

| 项 | 得分 | 依据 |
|---|---|---|
| S1 可运行 | 15/15 | build exit 0;10s 内 ready(实测 <2s);__bench 可用;0 console error;首帧非空(litRatio 0.67) |
| S2 行为正确性 | 30/30 | 6/6 probes PASS;11 条 scoring.behaviorItems 全部满足(星空 360/星流 240 循环重生/暗核/径向梯度/条纹旋转 0.35rad/s/辉光观感/缩放/reset) |
| S3 技术合同与生命周期 | 10/10 | fps 60.2 ≥ 30;动画真实时间步进(dt clamp 0.1 防失焦跳变);reset 后持续运行;无网络请求(除模板产物) |
| S4 代码健康 | 4.5/5 | 单文件 ~700 行结构清晰、注释含引擎坑位记录;扣 0.5:星场构建函数内有一次编辑残留痕迹(无害但欠整洁) |
| **Objective 小计** | **59.5/60** | |

## 视觉六维自评(0-3)

| 维度 | 分 | 说明 |
|---|---|---|
| 构图取景 | 2.5 | 黑洞居中、fov 60 下盘占屏 ~66%、倾角 24° 俯视感、暗核直径约短边 14%;扣分:构图静态无运镜(合同未要求) |
| 材质光影 | 2.5 | 全程序化 shader:径向四段色梯度、多普勒、内缘脉动;无光照系统参与(全发光体,场景本性);边缘辉光衰减平滑 |
| 动效流畅 | 3 | 60fps 恒定;条纹差速旋转+慢速调制、星流螺旋加速吞噬、缩放指数平滑、星空闪烁 |
| 特效质感 | 2 | 光子环+透镜上弯弧+多层辉光近似观感成立;但无全屏 bloom 渗出,与 Three UnrealBloom 级辉光存在可感知差距(见 ceiling-notes) |
| 交互反馈 | 2.5 | 滚轮平滑缩放(1.2s 残差<1%)+拖拽视角(加分项)+reset 即时复位;无 HUD 数据反馈(未要求) |
| 整体完成度 | 3 | 全合同达成、零错误、视觉稳定无闪烁/撕裂,审查评语"视觉冲击力强、细节丰富" |
| **合计** | **15.5/18** | `visual = round(15.5×40/18) = 34/40` |

**总分(参考)= 59.5 + 34 = 93.5 / 100**

## AgentAttainment 基准

本 verdict = FEASIBLE ⇒ 可作为 E05-cocosair 臂的 EngineCeilingComparableScore 分母。

## 风险与注意(Agent 侧复现要点)

1. `utils.createDynamicMesh` 在发行 tarball 上挂在 `utils.MeshUtils` 下(仓库 build 不同)。
2. 滚轮必须走 `input.on(Input.EventType.MOUSE_WHEEL)`,且 `getScrollY() = -DOM deltaY × 5`。
3. `primitives.plane` 在 XZ 平面;billboard 需父子两节点(相机四元数 + 子 X+90°)。
4. 自定义 effect 注册必须晚于 `createAirApp`;WebGL2 只消费 glsl3(glsl1 可省)。
5. 阴影遮挡依赖"opaque 黑盘先绘写深度 + additive 层后绘测深度"的队列次序,不可全部走透明队列。
