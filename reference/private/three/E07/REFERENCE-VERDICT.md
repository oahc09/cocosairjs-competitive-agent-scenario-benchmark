# E07 — Three.js Reference VERDICT

- runId:`REF-E07-three`(终跑含 `--video`,清洁证据集)
- 日期:2026-10-02
- 验证命令:`node bench/harness/runner/validate.mjs --workspace <E07> --spec bench/briefs/E07/spec.json --out <E07>/validation --run-id REF-E07-three --port 7417 --video`

## Verdict:FEASIBLE(PASS)

**Three.js r186 完整实现 E07 全部冻结规格,8/8 探针 PASS,120s 长稳,无引擎级缺口。**

| 指标 | 结果 |
|---|---|
| classification | PASS |
| probes | P1–P8 全 PASS(权重 8/8) |
| fps | 60.1(spec minFps=30) |
| ready | 1.08s(限 10s) |
| console errors / uncaught | 0 / 0 |
| build | 退出码 0(app.js 34KB,引擎 external) |
| 网络 | 18 请求全为本地 vendored 文件(0 外部) |
| 录屏 | validation/video.webm(7.3MB,1280×720) |
| 长稳 | 125s soak:fps 恒 60、堆有界、0 异常(soak-report.json) |

## 规模对照(spec 冻结值 → 实测)

| 项 | spec | 实测 getState | 备注 |
|---|---|---|---|
| 楼群 | ≥200(建议 220–260) | **220** | InstancedMesh 单 draw call |
| 发光窗点 | ≥2000 | **4340** | 每楼 ≥8 强制;实例化面片,矩阵可辨识 |
| 车流 | ≥60(建议 64–96) | **86** | 10 车道连续移动,头/尾灯分色 + 拖尾 |
| 雨粒子 | ≥1500(建议 1800–2500) | **2200** | GPU 循环下落,落地重生顶部 |
| 雾 | fogEnabled 初始 true | **true** | FogExp2 距离雾,密度动画开关 |
| 霓虹元件 | ≥3 处 | **150**(6 色相) | 招牌/灯带/广告牌/街灯,闪烁+呼吸 |

## 探针证据摘要

| 探针 | 判定要点 | 实测 |
|---|---|---|
| P1 | 计数达标 + 全屏非空 | lit 0.5035(阈 0.35);BLD 220 / CAR 86 / RAIN 2200 / FOG true |
| P2 | 街道层 600ms 像素变化(车流) | diff 0.8727(阈 0.01,87x) |
| P3 | 100ms 全屏细密像素差(雨) | diff 0.6563(阈 0.02,33x);RAIN 恒 2200 |
| P4 | 8s 后 fps≥30 且持续运动 | fps 60;motion 0.3807(阈 0.005) |
| P5 | 关雾:fogEnabled=false + 上部变化 | 翻转成功;diff 0.3218(阈 0.01) |
| P6 | 开雾:fogEnabled=true + 上部变化 | 翻转成功;diff 0.3135(阈 0.01) |
| P7 | reset 恢复初始 | 计数全复原(220/86/2200/true)、resetCount=1、lit 0.4173 |
| P8 | reset 后动画/帧率正常 | fps 60;街道层 motion 0.9078(阈 0.005) |

独立像素证据(审图工具,非探针):

- 雾纵深:远景条带(y0.30–0.50)开雾 57.0 vs 关雾 71.8,蓝色偏调 1%→10%——远处楼群对比/亮度衰减可辨
- 构图:地平线约在 67% 画面高度(下 1/3 街道层、上 2/3 楼群夜空),符合取景方向
- 窗格:近景立面剖面呈离散点阵(填充率 ≤52%),暖(58%)/冷混合
- 全帧 avgLum ~60(夜色基调),霓虹色相分布:品红/青/橙/金/红可见

## 规格覆盖(brief.md §3/§4 对照)

- 楼群程序化高度/footprint/网格街区 ✓ / 窗阵矩阵排布+随机点亮 ✓ /
  车流 ≥2 条横穿主干道 + 纵深走廊,同向/对向,头/尾灯分色 ✓ /
  雨持续循环重生 ✓ / 距离雾肉眼可辨衰减 ✓ / 霓虹 ≥3 处高饱和 + 闪烁呼吸 ✓ /
  近黑夜空 + 星点 + 薄云 ✓ / 湿地面反射与色彩(Reflector 平面镜) ✓
- 交互:雾开关(`data-bench="toggle-fog"`)状态与画面即时同步 ✓ /
  重置(`data-bench="reset"`)不刷新页面 ✓ / hover/active 反馈、画布边缘固定 ✓
- 生命周期:启动即全量运行 ✓ / __appReady 1.08s ✓ / reset 恢复计数+开关+动画相位 ✓ /
  120s 长稳无泄漏无衰减 ✓
- 禁止项:无预渲染媒体 ✓ / 无 DOM 伪 3D ✓ / 窗阵有矩阵结构 ✓ /
  fps 真实测量 ✓ / 状态与画面一致 ✓ / 无探针模式 ✓ / reset 无刷新 ✓

## 结论

E07 在 Three.js 侧**没有任何 ENGINE_LIMITED 项**。核心支撑:InstancedMesh
(5 组实例化批次 + 自定义实例属性)、Points 自由 shader(GPU 粒子雨)、
Reflector 平面反射(湿地面)、FogExp2 + 自定义 shader 雾复刻、
EffectComposer(UnrealBloom/OutputPass/FXAA)后处理链,全部为标准 API 无补丁。
可作为 EngineCeiling 满分基线参与 AgentAttainment 计算。
