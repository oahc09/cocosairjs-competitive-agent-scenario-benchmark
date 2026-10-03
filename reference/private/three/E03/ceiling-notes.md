# ceiling-notes — E03 太阳系仪 · Three.js r186 引擎天花板自评

> 依据:最终轮 `validation/`(9/9 PASS,fps 60.2,video.webm)+ 截图目检(initial.png 经视觉模型分析、P3-after.png 经像素级校验)。
> 视觉六维各 0–3;`visual = round(sum × 40 / 18)`。

## 一、视觉六维自评

| 维度 | 分 | 理由 |
|---|---|---|
| 构图取景 | **3** | 斜俯视 ≈33°(spec 30–60°),8 条同心椭圆轨道分层展开约占画面 70% 宽;太阳居中为全画面最亮元素;尺寸-半径层级对比明确(非等距);小行星带在第 4/5 轨道间呈连续碎石环带;星空含银河带聚拢。视觉模型分析确认构图平衡、深度感强。小瑕:neptune 初始帧略贴右缘。 |
| 材质光影 | **2.5** | 全程序化 canvas 纹理:岩质(纬度带+陨坑斑)、类地(海陆云+极冠)、气巨(正弦扰动条带+涡斑)、冰巨(纬向渐变)、太阳(米粒组织);恒星点光源 + 环境光 + 冷色补光,行星明暗面方向感正确;ACES tonemap。扣分:未启用阴影(行星不投影到环/卫星),土星环用 unlit 材质不受光照 —— 主动取舍非引擎限制(three 支持阴影与受光透明环)。 |
| 动效流畅 | **3** | 60.2fps 稳态(harness 3s rAF 实测,含 8x 档),1600 实例小行星逐帧矩阵更新 + 750 星着色器闪烁零掉帧;公转分层(内:外 ≈14.7:1)肉眼可辨;变速即时平滑(角度由 simTime 解析驱动,无跳变);reset 为 0.85s easeInOut 回卷过渡,全程渲染不中断;OrbitControls 阻尼平滑。 |
| 特效质感 | **2.5** | 双层加色 Sprite 光晕(呼吸脉动)、逐星相位闪烁、半透明环带卡西尼缝 + 径向亮度轮廓、选中圈 billboard 脉冲。扣分:未走 EffectComposer/Bloom 后处理(引擎具备,为鲁棒性与性能余量主动省略),光晕为 sprite 近似而非体积光。 |
| 交互反馈 | **3** | 点击选中:青色脉冲高亮圈(像素校验 213 cyan px)+ 右侧信息卡(名称+5 字段,数据与状态同源);点空白取消、拖拽不误选(位移阈值);五档倍率按钮 active 高亮 + hover;Reset 独立按钮;SIM/fps 读数实时;可选增强:环绕+缩放相机。 |
| 整体完成度 | **3** | spec 全部必需行为 + 多项可选增强(轨道线/星空/相机/读数)齐备;9/9 探针含负向对照;零 console 错误;`__appReady`/`__bench` 契约完整;reset 生命周期(无刷新、epoch、恢复期)健壮。 |
| **合计** | **17 / 18** | **visual = round(17 × 40 / 18) = 38 / 40** |

## 二、引擎能力清单(E03 域内,r186 实测)

| 能力 | 状态 | 用法/备注 |
|---|---|---|
| 场景图层级(行星-卫星父子) | ✓ 原生 | Group 嵌套,卫星随行星公转 + 轨道面微倾 |
| InstancedMesh 大规模实例 | ✓ 原生 | 1600×动态矩阵每帧更新 @60fps(DynamicDrawUsage);instanceColor 逐实例着色 |
| 自定义 ShaderMaterial | ✓ 原生 | 星空点精灵逐星闪烁(attribute 相位/尺寸/颜色,size attenuation) |
| 程序纹理 | ✓ 原生 | CanvasTexture×9 种(行星/太阳/环/光晕),零外部资产 |
| 加色混合发光(太阳光晕) | ✓ 原生 | Sprite + AdditiveBlending 双层 |
| 半透明双面环面 | ✓ 原生 | RingGeometry + DoubleSide + 透明贴图,倾斜可辨 |
| 相机控制 | ✓ addons | OrbitControls(阻尼/极角限制/缩放边界) |
| 拾取 | ✓ 双路径 | 本实现用屏幕投影距离(与 pickTargets 同源);Raycaster 亦可用 |
| 灯光体系 | ✓ 原生 | PointLight(衰减调参)+ Ambient + Directional;ACES tonemap |
| 阴影 | ○ 未用 | PCFShadowMap 可用(r186 已移除 PCFSoftShadowMap);场景取舍未开 |
| 后处理(Bloom 等) | ○ 未用 | EffectComposer + 30 模块在 addons 可用;本实现为鲁棒性省略 |
| TSL/节点材质 | ○ 未用 | r186 具备;本场景 GLSL 直写已足 |
| 弃用项规避 | ✓ | 未用弃用 THREE.Clock(自管 performance.now 增量,MAX_DT=50ms 抗节流) |

## 三、缺口(诚实清单)

1. **真实缺口:无。** E03 全部冻结需求(含 ≥500 小行星、分层公转、拾取、信息卡、五档倍率、reset 生命周期)均一次成型,无任何被引擎能力挡住的行为。
2. **主动取舍(非引擎缺口,Agent 可超越处)**:
   - 阴影未开(行星投影到环/卫星的暗面缺失)— 引擎支持,若开需控好性能与 acne;
   - 无 Bloom 后处理 — 太阳光晕靠 sprite 近似,辉光质量可再上一档;
   - 行星纹理 256×128,可升分辨率/加法线凹凸;
   - 小行星为 icosahedron 低模实例,无 LOD/密度渐变。
3. **对本 bench 的结构性观察(给协调者,非引擎问题)**:P7 的 `simulationTime < 1.5` 断言隐含「reset→采样 ≤1.5s」假设,而 harness 两探针间截图开销实测 ≈0.8–0.9s(三轮稳定),导致标称 0.9s 等待实际 ≈1.8s。严格 1:1 时钟的实现必然 FAIL;合法解法是利用 spec 明文「恢复在 1s 内完成」做 ≤1s 恢复期(本 Reference 用 0.85s 回卷过渡)。Agent Run 的双臂都会撞到同一堵墙,属 spec 语义与 harness 时序的固有张力,建议双臂同等对待。

## 四、结论

E03 在 three r186 下 **Engine Ceiling = FEASIBLE,无引擎级限制**。视觉自评 17/18(38/40);探针 9/9;fps 60.2(2× 下限)。可作 AgentAttainment 分母。
