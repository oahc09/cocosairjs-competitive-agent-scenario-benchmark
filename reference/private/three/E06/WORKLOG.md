# E06 — Three.js Reference WORKLOG

- 工作区:`bench/reference/private/three/E06/`(本文档所在目录)
- 角色:Reference 实现者(trusted,可读引擎源码与 harness)
- 日期:2026-10-02
- 产物:`src/` 8 个模块(main/sky/terrain/forest/campfire/fireflies/glow-points/rng,共 ~870 行)、`index.html`(仅改 title)
- 验证产物:`validation/report.json` + `video.webm`(3.1MB,1280×720)+ 26 张截图

## 最终结果(终跑含 `--video`)

| 项 | 值 |
|---|---|
| verdict | **PASS(FEASIBLE)** |
| probes | 6/6 PASS(P1–P6,passRate 1.0) |
| fps | 60.1(spec minFps 30,harness 独立 3s rAF 采样) |
| console errors / warnings / uncaught | 0 / 0 / 0 |
| ready | appReady+benchReady 902ms(限 10s) |
| 网络 | 15 请求全部本地 vendored 文件,0 外部 |
| build | `npm run build` 退出码 0,dist/app.js 33.7KB(引擎 external) |
| 首帧非空 | firstShotLitRatio 0.377(阈 0.02) |

最终探针余量(最差/最优区域比值 vs 阈值):

- P1 nonBlank:worst 0.193 vs 0.03(6.4x;full 0.28 / center-bottom 0.19)
- P2 pixelDelta:0.471 vs 0.01(47x);fireLightIntensity 两采样 0.478→0.801,|Δ|=0.32(阈 0.02)
- P3 regionChange:0.682 vs 0.01(68x);timeOfDay 0→1,upper-third 亮度 夜 19 → 日 176(9.3x,阈 1.5x)
- P4 motion:0.647 vs 0.005(129x);环绕 0.22 rad/s,3000ms 内角度采样差 0.66(阈 0.15)
- P5 pixelDelta:0.531 vs 0.01;orbitEnabled=false 后角度冻结
- P6 regionChange:0.554 vs 0.01;reset 后 timeOfDay=0、angle=0.224(<0.6)、萤火虫/树数恢复

## 实现结构(src/)

1. `rng.js` — mulberry32 确定性随机;全部程序化布局可复现,reset 同种子重放
2. `terrain.js` — 共享高度场 terrainHeight(唯一事实源,中心 r<4 压平)+ 46×46 平直着色地形(顶点色微随机 + 高处干草色)+ 泥地圆盘 + 散石
3. `forest.js` — 18 棵低多边形树环(6 面柱干 + 2-3 层 7 面锥冠,HSL 色相/缩放/朝向随机,落点贴高度场)
4. `campfire.js` — 石圈(9)+ 交叉柴堆(5,四元数定向)+ 火苗 shader 面片(2 大 1 小,顶点摆动 + fbm 片元梯度 白黄→橙→红)+ 44 火苗粒子 + 64 火星(1.2-2.6 u/s,0.8-2s 寿命)+ 地面暖光斑 + **动态 PointLight**(强度 (36+170·flicker)·日间衰减,decay 2,真实照亮地面与树干)
5. `fireflies.js` — 18 只萤火虫,利萨茹游走 + pow(sin,5) 深脉冲明灭,白天 alpha 淡出(计数不变)
6. `sky.js` — 天穹渐变 shader(指数地平线带:贴地平线暖白,向上快速到顶色)+ 900 星点(闪烁,uNight 淡出)+ 运行时 CanvasTexture 月亮 Sprite + Hemisphere/Directional 双端调色板 + 雾色=地平线色联动
7. `glow-points.js` — 世界尺寸点精灵 shader(火星/火苗/萤火虫共用,uScale=缓冲高/(2·tan(fov/2)))
8. `main.js` — 渲染器/EffectComposer(Render→UnrealBloom→Output ACES)/日夜状态机(3.2s smootherstep,0↔1)/环绕相机(0.22 rad/s,俯角 ~21°)/DOM UI(data-ui 三按钮,右上角)/`__bench` 状态通道/Timer 主循环(dt 钳制 0.1s)

关键状态语义:`fireLightIntensity` 由纯解析多频函数 fireFlicker(t) 产生(0.7/2.3/3.1/5.1 Hz ∈ 0.5-6,基准 0.55,波幅 ±0.31 ≥ 0.08,钳 [0.12,0.95]),同一数值驱动点光强度、火苗面片、火星透明度与地面光斑——状态与画面同源,不存在"只报数不动画面"的路径。

## 迭代史(4 次 validate,全部保留于会话记录)

| # | 变更 | 结果 |
|---|---|---|
| 1 | 初版 8 模块完整实现 | 6/6 探针 PASS、fps 60.1,但 **RUNTIME**:3 个 uncaught `labelOf is not a function`(UI refreshLabels 迭代混入了 uiRefs.refresh 函数项) |
| 2 | 修 UI bug;视觉打磨:夜环境光/月光微提(剪影可读)、火光 130→(36+170·f)、加程序化月亮 Sprite、日天空顶色加饱和 | **PASS**(首绿),console 全 0 |
| 3 | 发现日天空"灰白":俯角相机下可见天空全在地平线 ±7° 内,原 pow 渐变顶色到不了画面 → 改指数地平线带 exp(-h·12),日顶色 #2f7ed6 | PASS;日天空顶部 (171,187,213) B>R 蓝调恢复 |
| 4 | 地平线带收窄 exp(-h·16);**终跑 `--video`** | **6/6 PASS,fps 60.1,video.webm 3.1MB** |

## 关键发现

1. **E06 的日天空陷阱**:环绕相机带俯角(brief 要求"俯角环视"),画面内天空只占视线上方 ~7°,任何"顶色在上、地平线色在下"的常规天空渐变都会让日间天空整体呈地平线暖白色。必须用**指数地平线带**(exp(-h·k))让顶色在数度内接管,否则 P3 的"亮蓝"视觉读不出来(自动断言仍过,但 visual 维度会失分)。
2. **litRatio 的 full+center-bottom 双区**:夜景全屏 modal 色是深天空色,树剪影/地面/火光与其色差 >30 的占比 0.28;center-bottom 的 modal 是暗地色,火光暖池占 0.19——两个区域都需与 modal 色拉开差距,夜间深蓝天(高 B)与绿树/暖地(高 G/R)的通道分离是关键。
3. **Timer 已并入 r186 核心**:`import { Timer } from 'three'`(addons/jsm/misc 下已无 Timer.js);`timer.connect(document)` 启用 Page Visibility 大 delta 防护,叠加手动 dt 钳制 0.1s,满足"失焦再聚焦无跳变"。
4. **P5 的像素断言实际度量的是"点击前后"差分**(pre-action 帧 vs post-action 帧):暂停环绕前相机仍在动,帧差必然显著通过;角度冻结本身由状态断言(orbitEnabled==false)+ 实现保证(角度只在 enabled 时累加)。
