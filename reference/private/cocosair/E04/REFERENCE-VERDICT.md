# REFERENCE-VERDICT — E04 城市烟花夜 · Cocos AIR

- runId:`REF-E04-cocosair`
- 日期:2026-10-02
- 判定:**FEASIBLE**(引擎完整可达,无 ENGINE_LIMITED 项)

## 1. 结论

E04 在 Cocos AIR 1.0.0 上**完整可行**。8/8 探针 PASS、fps 60.3(2× 于 30 下限)、0 console 错误、真暂停冻结、真 reset 重生成。核心挑战"无 3D 粒子系统"由动态网格路径(createDynamicMesh + updateSubMesh,单 draw call,池 2600)完全替代,性能余量充足。

该场景可作为 Agent Attainment 分母(Reference=FEASIBLE,per 计划书 §16)。

## 2. 判定依据(全部来自 validation/report.json,--video 终跑)

| 项 | 结果 |
|---|---|
| build | exit 0,1 次尝试,1.7 s |
| ready | `__appReady` 293 ms(限 10 s) |
| 探针 P1–P8 | 8/8 PASS(passRate 1.0) |
| fps | 60.3(自动表演开启态,harness 独立 3 s 采样) |
| console | errors 0 / uncaught 0 |
| 网络 | 仅 4 条本地 serve,无外部请求 |
| 生命周期 | reset 后 `__appReady` 保持 true、buildingCount 26 重生成、可继续交互 |
| 录屏 | video.webm 3.8 MB 已归档 |

状态通道真实性:`particlesAlive` 恒等于粒子池真实存活数(逐帧积分计数),`fireworkCount` 每次 `launchFirework()` 实增,reset 实清——无任何报数伪造(禁项 4)。

## 3. 六维自评(Visual 40,0–3/维;自评非权威,盲评另行)

| 维度 | 自评分 | 依据 |
|---|---|---|
| 构图取景 | 3.0 | 地平线位于下 1/3(城市带 -36..-10 世界单位 ≈ 下 25–38%);爆点锁定上部 25–75%;零交互即完整夜景;P5 多发同屏构图饱满(远端视觉模型:"composition excellent") |
| 材质光影 | 2.5 | 夜空三段渐变+蓝紫过渡带+暖橙城市光污染(hash 抖动去色带);楼群剪影与天空可区分;additive 辉光双层衰减。扣分:无 Bloom/后处理,峰值亮度和辉光扩散上限低于 Three 参照的可达水平 |
| 动效流畅 | 3.0 | 60.3 fps 恒定;尾迹串、速度向拉伸条纹、余烬横摆+闪烁均为连续时间函数;失焦 clamp 无跳变 |
| 特效质感 | 2.5 | 高斯核+halo 软光斑(远端视觉抽检:"round glowing dots, soft falloff, no blockiness");爆心闪光+球壳扩散形正确。扣分:无 HDR/拖尾残影/Bloom,爆炸瞬间"照亮全场"的溢光感缺失 |
| 交互反馈 | 2.5 | 点击即发射+地面微光反馈;三按钮状态文字(自动:开/关、暂停/恢复);点击位置真实决定爆点。扣分:无音效(spec 可选项,未做);hover/按压无视觉态 |
| 整体完成度 | 3.0 | 合同全项满足+超额状态字段(windowCount/starCount/resetCount);reset 城市重随机;暂停真冻结;探针零失败 |
| **合计** | **16.5 / 18** | visual = round(16.5 × 40 / 18) = **37 / 40**(自评折算,供盲评对照) |

## 4. Objective 自估(S1–S4)

- S1 可运行:build 0 错、293 ms ready、首帧非空(litRatio 0.218)→ 满分 15。
- S2 行为正确性:8/8 探针 → 满分 30。
- S3 技术合同与生命周期:P8 通过、fps 达标 → 满分 10。
- S4 代码健康:单文件分层清晰、常量集中、关键坑位注释完整(GAP-B1/dynamicMesh 空数组/pal 输入),无死代码;自评 4.5/5(扣分:main.js 单文件 1046 行,未按子系统拆模块)。

## 5. 已声明的规格偏离(1 项)

**余烬寿命长尾**:28/68 个余烬寿命 7.5–10.2 s,超出 brief §3 描述的 3–7 s 上限。原因:P4 状态采样落在点击后 ~9.8 s,严格 7 s 上限下 `$.particlesAlive >= 1` 物理不可达(探针节奏与描述值互相矛盾)。依据"spec.json 探针为操作性合同、brief 数值为描述性"处理,全部为真实模拟粒子。**建议 harness 侧知悉**:该矛盾同样会打到 Agent 实现,若 Agent 严格按 3–7 s 实现,P4 将 FAIL——属 spec 内在张力,非引擎差异,不计入 Agent 失败分类。

## 6. 风险与复现注意(给后续 Agent run 的中性事实,不含答案)

- `camera.visibility` 不显式设置 → 全黑屏(引擎默认 undefined)。
- EffectAsset 注册必须在 `createAirApp()` 之后,否则 onLoaded 内部依赖缺失。
- `createDynamicMesh` 初次调用必须传非空满容量数组(空数组 → 无 vertex bundle → updateSubMesh 错位)。
- pal 层吞引擎输入:`input.on(TOUCH_*)` 与 canvas DOM `pointerdown` 两条路均可到达(E05/E04 分别验证)。
