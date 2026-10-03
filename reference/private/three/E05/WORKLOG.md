# E05 — Three.js Reference WORKLOG

- 工作区:`bench/reference/private/three/E05/`(本文档所在目录)
- 角色:Reference 实现者(trusted,可读引擎源码与 harness)
- 日期:2026-10-02
- 产物:`src/main.js`(场景全部实现,单文件 ~730 行)、`index.html`(仅改 title)
- 验证产物:`validation/report.json`(终跑含 `--video`,`video.webm` 3.1MB)

## 最终结果

| 项 | 值 |
|---|---|
| verdict | **PASS** |
| probes | 6/6 PASS(P1–P6) |
| fps | 60.2(minFps 30,harness 独立 3s rAF 采样) |
| console errors / uncaught | 0 / 0 |
| ready | appReady+benchReady 1.14s |
| 网络 | 17 请求全部本地 vendored 文件,0 外部 |
| build | `npm run build` 退出码 0,dist/app.js 21KB(引擎 external) |

最终探针余量(最差区域比值 vs 阈值):

- P1 nonBlank:worst 0.085 vs 0.03(2.8x;四角 + 中央)
- P2 motion:0.075 vs 0.005(15x)
- P3 regionChange:0.068 vs 0.01(6.8x)
- P4 regionChange:0.389 vs 0.01(39x)
- P5 motion:0.389 vs 0.005(78x)
- P6 nonBlank:0.401 vs 0.03(13x)

## 实现结构(src/main.js)

1. 深空背景:BackSide 球面 ShaderMaterial,三层 fbm 星云(阈值按噪声实测分布百分位选取)
2. 背景星空:1900 Points 自定义 shader;70% 集中于初始视向前向壳层(±75°方位/±55°仰角),30% 全球均匀;大小/亮度/色温差异 + 微弱闪烁
3. 事件视界:纯黑不透明球(r=1.2,写深度,遮挡背后一切发光体)
4. 吸积盘:RingGeometry(1.8→6.5, 288×56)+ ShaderMaterial——径向梯度(蓝白→橙→暗红)、对数螺旋条纹(随 uRot=0.38 rad/s 真实时间旋转)、fbm 湍流、多普勒不对称(cos(theta) ×0.54–1.46 + 色移)
5. 引力透镜光弧:公告板半环(1.55→4.25, 24°–156°),与主盘同源条纹,两端平滑淡出
6. 光子环:公告板高斯薄环(r=1.46, σ=0.062)
7. 星流:320 粒子 CPU 解析轨迹(螺旋 + ease² 加速 + 视界吞噬外圈重生),LineSegments 拖尾 + Points 发光头部,近视界增亮增大
8. 后处理链(正片):RenderPass → UnrealBloomPass(0.65/0.38/0.72)→ OutputPass(ACES + sRGB)→ FXAAPass → 自定义 FinishPass(暗角 + 径向色差 + **事件视界暗核遮罩**)
9. 交互:wheel → cameraDistance 平滑(τ=0.12s,范围 [5,28]);拖拽微调视角(可选加分,方位钳 ±60°);`data-ui="reset"` 右上角按钮
10. 状态通道:`getState()` 暴露 diskRotation / accretionPhase / cameraDistance / starStreamCount / backgroundStarCount(+engine/frame/ready/resetCount),全部真实数据;`reset()` 归零旋转相位、距离回 14、星流复位重生

## 迭代史(14 次 validate,全部保留于会话记录)

| # | 变更 | 结果 |
|---|---|---|
| 1 | 初版 | 1/6:P1 过但**全画面过曝**(辉光淹没暗核,中央 modal 252 白),P2 motion 0.0022 失败 |
| 2 | 降曝光/盘/环/弧亮度 + bloom 0.85/0.45/0.6 | 6/6 PASS(首绿) |
| 3 | 修光弧几何 bug:弧面含视线轴 → 投影成**竖亮条**;改为公告板;bloom 收紧 | P1 四角 0.003 FAIL(星云收太狠) |
| 4 | 星云回调 + 星数 1600→1900 | P1 0.015 FAIL |
| 5 | 发现星点全球均匀分布 → 仅 ~10% 入屏;70% 改前向壳层 + 方位钳 ±60° | P1 0.022 FAIL |
| 6 | 星云分层 | P1 0.020 FAIL |
| 7 | 星云锐化 | P1 0.012 FAIL(阈值盲调失败) |
| — | **离线实测 fbm 分布**(JS 复刻噪声统计:median 0.49, p90 0.61),按百分位定阈值 | — |
| 8 | 按实测分布定星云参数;首跑 INFRA(端口 7405 僵尸进程,serve 启动超时),清端口重跑 | 6/6 PASS,四角 0.13 |
| 9 | 盘去灰白(降 rim/body)、星流加发光头部 + 提亮、星云回收 | 6/6;像素证据:径向 R-B 梯度 3→29→68→25→1 ✓;但**中心 luma 185,暗核被辉光淹没**(后处理无视深度) |
| 10 | **暗核遮罩**:FinishPass 内按视界球投影轮廓(uCore/aspect 每帧更新)把核心压回近黑 | 6/6;中心 luma 22 ✓,clip 0.34% |
| 11 | FXAAPass(修光子环锯齿)+ 多普勒 0.46 | 6/6 |
| 12 | 光子环细化(σ0.085→0.062)+ 光弧提亮 | 6/6 |
| 13 | 外缘收紧 + 星流拖尾提亮;**终跑 `--video`** | **6/6 PASS, fps 60.2, video.webm** |

## 关键技术发现(写给后续对照实现)

1. **辉光 vs 暗核的结构性矛盾**:UnrealBloom 是屏幕空间叠加,104px 的暗核会被周围 360° 亮环的 bloom 完全淹没(实测中心 luma 185)。解法:合成末端按视界球投影轮廓做 core matte(压至 12%,0.82–1.02R 平滑带)。这是后处理管线的通用问题,任何引擎用屏幕空间辉光都会遇到。
2. **公告板平面 vs 含视轴平面**:透镜光弧若放在含视线的平面内,投影退化为一条竖线(平面投影成直线);必须公告板朝向相机才呈弓形。
3. **fbm 阈值要用实测分布**:value-noise fbm 的分布远比直觉集中(p90≈0.61),smoothstep 阈值按"想要的覆盖率百分位"反推,而不是凭感觉设 0.8/0.9。
4. **harness nonBlank 是对区域 modal 色的距离(>30)**:背景要"双峰"分布(大片纯黑 + 成片明显偏色的云),平滑渐变会把像素堆在 modal 附近而不计 lit。
5. **星点密度要按视锥立体角算**:全球均匀分布的 Points 只有 ~10% 入屏;按初始视向前向壳层加密(+拖拽方位钳制)可确定性保证四角覆盖。
6. **视觉审查工具会缓存同路径旧图**:同一文件路径反复上传会读到首版图,审图前必须复制为新文件名(本次多次误判源于此,最终以像素测量为准)。

## 红线自查

- 未伪造状态:diskRotation = 0.38×simTime(单调),accretionPhase = fract(rot/2π),cameraDistance 为真实插值值,starStreamCount/backgroundStarCount 为真实常量;画面运动与状态一致(P2/P5 motion 探针即独立像素证据)。
- 未改 spec/harness;产物只写工作区;无外部资产;无网络请求(全 vendored);无自动化环境特判。
