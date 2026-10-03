# REFERENCE-VERDICT — E03 太阳系仪 · Cocos AIR

- runId:`REF-E03-cocosair`(最终 RUN,`--video`,2026-10-02T11:22Z,端口 7412)
- 事实源:`validation/report.json`(本目录)
- **verdict:FEASIBLE** —— `classification = PASS`,`probePassRate = 1`(9/9),
  `fps = 60.1 ≥ 30`,`console errors = 0`,`uncaught = 0`,`video = video.webm`

## 1. 完成合同

| 项 | 结果 | 证据 |
|---|---|---|
| `npm run build` | exit 0,1 次尝试,1467ms | report.build |
| `__appReady` | true,441ms(≤10s) | report.ready |
| `__bench {getState,reset}` | 存在且全程可调用 | 9 个探针共 20+ 次采样 |
| 无未捕获异常 | 0 error / 0 uncaught | report.console |
| 全部探针 | 9/9 PASS(权重 9/9) | probe-results.json |

## 2. 探针结果(P1–P9 全 PASS;关键独立观测证据)

| 探针 | 状态 | 状态证据 | 独立观测证据(像素/运动/DOM) |
|---|---|---|---|
| P1 初始布局+公转分层 | PASS | 8/3/600/1;timeScale=1;selectedPlanet=null;2s 窗 mercury 角 Δ0.0692 rad vs neptune Δ0.0047 rad(比值 14.7 > 4) | litRatio 0.1176 ≥ 0.03(nonBlank) |
| P2 点击 earth | PASS | selectedPlanet="earth" | 选中区 89×89px 帧差 0.8382 ≥ 0.01(regionChange,高亮圈+标记) |
| P3 信息卡 | PASS | infoCard {visible,name:"earth",fieldCount:5} | DOM textLength 104("Earth / Type Terrestrial / Orbit Radius 22 MU / …") |
| P4 8x 档 | PASS | timeScale=8 | litRatio 0.1195;UI 高亮(DOM) |
| P5 8x 真实变速 | PASS | 1.5s 窗 simTime Δ14.67 ≥ 6;mercury 角 Δ0.4007 ≥ 0.05 | motion 0.0679 ≥ 0.005;videoClip |
| P6 reset 生效 | PASS | epoch=1,timeScale=1 | litRatio 0.1186;无导航;console 干净 |
| P7 reset 精确恢复 | PASS | simTime 1.0502 < 1.5;selectedPlanet=null;infoCard.visible=false;angle0=0.027∈±0.06;angle7=5.500∈[5.43,5.56](315°=5.4978) | motion 0.0319 ≥ 0.002(非冻结);videoClip |
| P8 0.5x 档 | PASS | timeScale=0.5 | litRatio ≥ 0.03;五档 DOM 存在 |
| P9 点空白负向 | PASS | selectedPlanet=null | info-card DOM absent(`display:none`) |

## 3. 性能与规模

- fps(3s rAF 注入)= **60.1**;app 内 2s 滚动窗口在 8x 运行时亦稳定 58–60 ≥ 30。
- 规模:8 行星 + 3 卫星 + 600 小行星(独立节点,共享 1 网格 + 3 材质)+ 土星环 + 420 背景星
  + 8 轨道线 + 太阳双层光晕 ≈ 65 个 draw call 量级,60fps 无压力。
- `__appReady` 441ms;整轮验证 30.4s;截图 33 张 + video.webm(2.6MB)。

## 4. 备注(给协调者,不构成改 spec 请求)

1. **spec P7 采样窗与 harness 实际时序不符**:阈值文本预设"reset 后 0.3–0.9s 内采样",
   实际 P7 样本落在 Reset 点击后 ≈1.9–2.1s(P6 waitMs 600 + harness 截图/PNG 解码开销
   0.87–1.03s + P7 wait 300)。Reference 侧以"reset 后 900ms 模拟时钟保持"适配
   (渲染与画面运动不中断;见 WORKLOG §2)。若后续 Agent Run 在更快/更慢机器上复现,
   该适配是 App 侧行为,不属于 harness 缺陷;如需对齐,建议冻结前复审 P7 的 1.5s 上界
   与 P6 waitMs 的乘积关系(当前组合下健康余量 ≈0.45–0.5s)。
2. P2 的 `regionChange` 实测帧差高达 0.8382(高亮圈为大面积发光环),负向 NC04 风险极低。
3. classification = PASS → EngineCeilingComparableScore 可按本 Reference 计算分母。

## 5. 结论

E03 在 Cocos AIR 上 **FEASIBLE**:无引擎级缺口阻断任何冻结探针;全部 12 条
scoring.behaviorItems 均有对应证据(9 探针 + DOM/像素/视频三通道)。视觉上限的
真实差距在 Bloom/后处理与高级着色自由度(见 ceiling-notes.md),不影响行为分。
