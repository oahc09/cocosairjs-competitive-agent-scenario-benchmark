# WORKLOG — E01 深空星系巡航 · Three.js r186 Reference

- 工作区:`bench/reference/private/three/E01/`
- 实现文件:`src/main.js`(单文件应用,引擎经 import map 外部加载)
- 验证命令:harness `validate.mjs --spec briefs/E01/spec.json --port 7401`
- 日期口径:2026-10-02(UTC+8)

---

## Round 1 — 初始实现(2026-10-02 17:20 ~ 17:28)

**改动**
- 以模板 smoke 立方体为起点重写 `src/main.js`,完整实现 E01:
  - 星系生成:核球 9000(扁高斯椭球,暖黄白)+ 盘/旋臂 47000(对数螺旋 θ=ln(r/r₀)/pitch,2 臂 + 22% 无结构盘面星 + 径向/角向散布 + 盘厚度内厚外薄)+ 远景球壳 6000;共 62000 真实渲染星点(3 个 `THREE.Points` 批量提交)。
  - 自定义 `ShaderMaterial`:逐点尺寸衰减(300/z,clamp 1–64px)、双层辉光 falloff(core+halo,伪 bloom)、每星独立相位闪烁;AdditiveBlending、depthWrite=false。
  - 相机:固定仰角 38° 方向 × cameraDistance(指数平滑 τ=350ms,滚轮 Δ=deltaY×0.1,clamp [40,400])+ 指针视差(归一化偏移,指数平滑 τ=200ms,横向平移 6 单位 ≈ 画布 5%),lookAt 恒指星系中心(星系居中、远景反向位移 = 深度视差)。
  - 关键探针对策:**视差目标只由 pointermove 事件驱动,reset() 同步清零 target 与当前值** —— 规避 P7「点击 HUD 按钮(指针落在画面角落)后 parallaxOffset 必须归零」的陷阱;reset 用 450ms easeOutCubic 专用补间恢复距离(不复用滚轮平滑,确保 800ms 时精确回到 120);rotationPhase 以 phaseOrigin 差值暴露,视觉角度永不回跳。
  - HUD:DOM 覆盖层(STARS/FPS/DIST/PHASE + Reset 按钮),全部数值来自真实运行数据,8Hz 刷新;`data-ui` 属性齐全(hud / hud-stars / hud-fps / hud-dist / hud-phase / reset);Reset 按钮 `aria-label="reset"`。
  - fps:2s 滚动平均,后台挂起大间隔帧(>250ms gap)不计入。
  - 星云薄雾层 420 sprite(沿旋臂,深蓝/紫/青,极低亮度)—— 特效 sprite,不计入 starCount。
- index.html title 更新。

**验证**:build exit 0;validate `PASS` — **7/7 探针 PASS,fps=60,litRatio=0.1847**,console 0 error。
视觉检查(截图 + 图像分析):双旋臂可辨、核球明亮、半径色梯度正确、HUD 可读;发现三个问题:① 核心过曝成白色斑块;② 盘面占宽 87.8%(超出 60–75% 构图带,离线投影计算确认);③ 底部提示文字过暗、臂间棉絮感。

## Round 2 — 视觉修正(17:35 ~ 17:42)

**改动**(全部由 Round 1 视觉证据驱动)
- `GALAXY_R` 88 → 76:离线投影重算,盘面占宽 87.8% → 71.2%,落入 60–75% 构图带(近侧旋臂出血至画面底边,增加前景层次)。
- 核球降亮:`bright 0.75+0.75·rand² → 0.40+0.55·rand^2.2`,巨星尺寸 2.4–4.2 → 2.0–3.2(加色叠加不再糊成白块,核心呈暖色梯度)。
- 星云薄雾减淡(k 0.5–1.4 → 0.32–0.87,尺寸 16–46 → 12–34),消棉絮感。
- 底部提示对比度提升(0.55 → 0.80 + text-shadow);vignette 减弱(0.42 → 0.30,起始 55% → 62%)。
- 远景星微增亮。

**验证**:validate `PASS` — **7/7 PASS,fps=60.1,litRatio=0.1638**。
像素级测量(自写 PNG 解码):lit bbox 覆盖全画幅,dense(≥15px/列)宽 79%(含 HUD 列);图像分析确认:核心暖梯度 ✅、双臂 ✅、色梯度 ✅、橙红巨星 ✅、HUD 数值可读 ✅;残留:四角死黑空区(背景星不足)。

## Round 3 — 背景纵深增强(17:48 ~ 17:55)

**改动**
- `SKY_STARS` 6000 → 9000(starCount 62000 → **65000**),16% 暖星加大加亮,四角不再死黑。
- HUD 初始 STARS 值改为运行时填充(消除硬编码数字,数值唯一来源 = STAR_COUNT 常量 = 几何体实际点数)。

**验证**:validate `PASS` — **7/7 PASS,fps=60.1,litRatio=0.1643**。
图像分析评分:arms_clarity 8/10,color_gradient 8/10,core_quality 9/10,depth 7/10,hud_readability 7/10,overall 8/10;四角已填充微弱星点 ✅。

## Round 4 — 最终轮(--video)(18:00 ~ 18:04)

**改动**:无代码改动。

**验证(最终,含录屏 video.webm)**:
- `classification=PASS`,`probes=7 passRate=1`,`fps=60`(独立 rAF 采样 3.016s 181 帧),console 0 error,build 1 次通过。
- 视觉断言余量:P1 lit 0.1626(阈 0.02,8.1×);P2 motion 0.3035(阈 0.005,61×);P3 delta 0.2228(阈 0.003,74×);P4 delta 0.525(阈 0.01,53×);P7 lit 0.1716。
- 状态证据:starCount 恒 65000;rotationPhase 0.053→1.107 单调递增(ω=0.05 rad/s),reset 后 0.040;P4 wheel 后 cameraDistance 120→65.8 平滑;P3 视差 x 0→0.357;P7 reset 后 epoch≥1 / dist=120 / parallax=0 / phase=0.040。

---

## 结果汇总

| 轮次 | 探针 | fps | litRatio | 备注 |
|---|---|---|---|---|
| R1 | 7/7 | 60 | 0.1847 | 初版全绿;视觉三问题 |
| R2 | 7/7 | 60.1 | 0.1638 | 构图带修正 + 核心过曝修正 |
| R3 | 7/7 | 60.1 | 0.1643 | 背景纵深增强(starCount 65000) |
| R4(video) | 7/7 | 60 | 0.1624 | 最终定版 |

全程零探针失败、零构建失败、零 console 错误;未修改 spec/probe/模板构建脚本。
