# E07 霓虹夜城 — Cocos AIR Reference VERDICT

- runId:`REF-E07-cocosair-final`(2026-10-02,端口 7418,--video)
- **verdict:FEASIBLE**(无需降规模;spec 冻结规模全量达成且 fps 60.2 ≫ 30)

## 1. 完成合同核验

| 合同项 | 结果 |
|---|---|
| `npm run build` 退出码 0 | PASS(esbuild,产物 dist/app.js 41.7KB,引擎 external) |
| `window.__appReady === true` ≤10s | PASS(首帧后置 true,实测 <3s) |
| `window.__bench = {getState, reset}` | PASS |
| 无未捕获异常 | PASS(console 0 error,125s soak 亦 0) |
| 探针 P1–P8 | **8/8 PASS** |

## 2. 规模与性能(真实状态,getState 与画面同源)

| 通道 | spec 要求 | 实际 | 提交方式 |
|---|---|---|---|
| buildingCount | ≥200(建议 220-260) | **240** | 合并静态网格 ×1 draw call |
| 窗点总数 | ≥2000 | **~13,600 亮窗**(+ 暗窗格矩阵) | 合并静态网格 ×1 draw call |
| carCount | ≥60(建议 64-96) | **80** | 动态网格 ×1 draw call |
| rainParticleCount | ≥1500(建议 1800-2500) | **2200** | 动态网格 ×1 draw call |
| fogEnabled | 初始 true,开关即时生效 | true / UI 切换 | 引擎 FogInfo(LINEAR)→ 管线宏 |
| fps(真实测量,最近 60 帧滚动平均) | ≥30 | **60.2**(harness 3s rAF 采样 60.2;vsync 上限) | EVENT_AFTER_DRAW 时间戳 |

全场景合计 **7 个 draw call**(天空/楼群/窗阵/地面/光斑/胶囊动态网格/…),楼、窗、车、雨全部批量提交,无逐个体独立绘制。

## 3. 探针关键指标(final run)

- P1 nonBlank:litRatio **0.699**(阈值 0.35;背景色 = 雾色 69,84,124)
- P2 街道层 regionChange:**0.143**(阈值 0.01,600ms)
- P3 雨全屏 pixelDelta:**0.088**(阈值 0.02,100ms)
- P4 fps≥30 + 全屏 motion:**0.165**
- P5 关雾上部 regionChange:**0.026**(阈值 0.01)/ P6 开雾:**0.094**
- P7 reset 重建:litRatio 0.698(城市完整恢复)
- P8 reset 后街道 motion:**0.198** + fps 达标

## 4. 六维视觉自评(0-3)

| 维度 | 分 | 理由 |
|---|---|---|
| 构图取景 | 2.5 | 低角度仰视天际线,下 1/3 街道层/上 2/3 楼群夜空三层分明;x=0 主街透视引线;缺标志性前景锚点 |
| 材质光影 | 2.3 | 逐面假光照顶点色 + 窗阵矩阵 + 雾色协调;但材质族单一(无纹理楼体/无真实光照/无湿面反射) |
| 动效流畅 | 3.0 | 实测 60fps;车流/雨/霓虹闪烁/信标/相机微漂移持续不断 |
| 特效质感 | 2.5 | additive 光晕体系统一(车灯/街灯/霓虹/信标),雨丝速度感,光污染地平带;无 Bloom(AIR 无后处理) |
| 交互反馈 | 2.0 | 本场景交互为最小集(雾开关/重置);按钮 hover/active 有反馈,雾开关画面即时可辨 |
| 整体完成度 | 2.7 | 六要素(楼/窗/车/雨/雾/霓虹)全部达标可辨,120s soak 无衰减,reset 真重建 |
| **合计** | **15.2/18** | visual ≈ round(15.2×40/18) = **34/40**(估算,最终以盲评为准) |

## 5. 能力清单(本场景验证的 AIR 能力)

- [x] 大规模静态几何合并(240 楼 + 13.6k 窗点 → 各 1 draw call,静态网格生成 ~50ms)
- [x] 动态网格单 draw call 粒子系统(`createDynamicMesh`/`updateSubMesh` 每帧 CPU 顶点写放,2200 雨 + 80 车 ×3 光斑 + 96 街灯 + 12 信标 + 15 霓虹 → 2 个动态网格)
- [x] 引擎管线雾(4 类型;LINEAR 验证;`scene.globals.fog` 运行时开关,管线宏级生效)
- [x] 自定义 EffectAsset 全自由 shader(glsl4/glsl3 双变体注册;手写雾因子复用 CCCamera UBO 的 cc_fogBase)
- [x] builtin-unlit 顶点色 + USE_TEXTURE(canvas 程序纹理 2048²)
- [x] 确定性程序化城市(mulberry32 同种子 reset 逐位复现;reset 真实重建网格非重置计数)
- [x] fps 真实测量(渲染帧事件时间戳滚动窗口)

## 6. 缺口(如实)

1. **无 InstancedMesh/Points**:大规模实例必须走合并几何(静态)或 CPU 动态网格(动态),失去逐实例 GPU 剔除与 GPU 端动画;实例变换变化 = CPU 重写顶点。规模天花板量化见 ceiling-notes.md。
2. **无后处理**:无 Bloom/辉光(AIR Code First 路径不可稳定使用),霓虹感靠 additive 光斑叠加模拟;无运动模糊/景深。
3. **雾为管线宏级开关**:切换触发全材质变体重编译(~100ms 单帧颠簸),非 uniform 级即时切换。
4. **雾在 builtin-unlit 为逐顶点因子**:超大三角形会有插值误差(本场景网格密度足够,无可见瑕疵)。
5. **无每实例颜色/属性 API**:窗色/楼色在生成期烘进顶点色,运行时改色需重建静态网格。

## 7. 结论

spec 冻结规模(240 楼 / 13.6k 窗 / 80 车 / 2200 雨 + 雾 + 霓虹)在 Cocos AIR 上以 7 draw call、60fps 稳定交付;规模余量巨大(6.4× 楼 + 45× 雨仍 ≥54fps)。**AgentAttainment 可据此 pair 计算(EngineCeiling 路径 = FEASIBLE)。**
