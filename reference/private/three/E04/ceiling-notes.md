# ceiling-notes — E04 城市烟花夜 · three.js r186 引擎上限笔记

> 用途:G3 Reference Feasibility 证据 + 双引擎对照的 Three 臂能力侧写。
> 结论:FEASIBLE(8/8 探针 PASS,fps 60)。

## 1. 六维视觉自评(0-3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 城市地平线稳定在下 1/3;远景蓝灰+近景近黑双层天际线;月亮+光环占位左上;星空散布上 2/3;烟花爆点集中上部 25-75%。未做镜头语言(推拉/视差),静态正交构图。 |
| 材质光影 | 2.5 | 全屏渐变夜空 shader(顶深蓝黑→地平线蓝紫+城市光晕带,带抖动去色带);全部辉光走"程序化径向衰减贴图 + AdditiveBlending";窗灯为规范要求的小方块;无后处理 Bloom(刻意,换取满帧与简约管线)。 |
| 动效流畅 | 3 | 全程 60fps 锁定(rAF 计数实测,自动表演 ~1100 同屏粒子仍满帧);全部动态按真实 dt 步进,暂停即 dt=0 硬冻结;失焦回焦 dt 钳制 50ms 无跳变。 |
| 特效质感 | 2.5 | 四种弹型(牡丹/环形/垂柳/爆裂)+ 双色芯;尾迹串、爆闪、重力下坠、阻力衰减、末期暖红冷却;crackle 谱系(余烬裂变火花+暗火微点爆花)提供 10s 级余韵;单发粒子数百、point sprite 光晕柔和。缺:真正的体积烟尘、冲击波环、镜面反射水面。 |
| 交互反馈 | 2.5 | 点击→即刻发射+地面微光;三按钮(data-ui 契约)带状态文字;左下 HUD 实时计数(仅文本变化时写 DOM,保证冻结帧逐字节稳定);点击城市/UI 不误发。缺:悬停/框选连发等进阶交互(spec 未要求)。 |
| 整体完成度 | 3 | spec 全部合同项落地:8/8 探针、构建/ready/state/无异常、reset 再生城市、自动表演、暂停冻结;全部资产程序化(assets=[])。 |
| **合计** | **15.5/18** | visual = round(15.5×40/18) ≈ 34/40(自评口径,以盲评为准) |

## 2. 能力清单(本场景实证的 three r186 能力)

- **自定义 ShaderMaterial Points 粒子系统**:逐粒 size/rgba 属性、additive、`gl_PointSize×uPR`、片元径向贴图采样与 discard;单池 6000、swap-kill O(1)、drawRange 裁剪。
- **CPU 粒子物理**:阻力(exp 衰减)/重力/分层寿命/闪烁函数(相位×频率×幅度)/色温冷却/谱系裂变,全部真实 dt 驱动。
- **程序化几何**:合并 BufferGeometry 楼群(两层次,带天线)、天际线高度查表(点击命中判定)、运行时 Canvas 生成 glow 纹理。
- **全屏 shader 天空**:渐变+高斯光带+dither,`depthTest:false` + renderOrder 严格分层(天空<星<月<远景<近景<窗<灯<烟花)。
- **时间线治理**:单一 simTime 时钟驱动粒子+星闪+窗闪+障碍灯;`enabled=false → dt≡0` 全场景硬冻结(两帧逐字节一致);resize 全量重建。
- **DOM/Canvas 输入分区**:canvas 点击发射、按钮 DOM 冒泡隔离、HUD pointer-events:none。
- **诚实状态通道**:getState 全字段真实数据(含 particlesAlive 池计数、resetCount),reset 清池+重生成城市。

## 3. 缺口与引擎侧注记

1. **无后处理 Bloom 依赖**:柔光靠 additive+径向贴图达成(本场景足够);若要电影级辉光可加 EffectComposer+UnrealBloomPass(addons 自带),代价 ~10-20% 帧预算——Cocos AIR 默认管线无 Bloom,此为双臂潜在差异点(见能力差异审计)。
2. **gl_PointSize 上限**:超大片(爆闪 145px)在部分 GPU 受 `ALIASED_POINT_SIZE_RANGE` 上限(常见 255-1024)约束;更稳妥做法是 instanced quad,本场景未触及。
3. **CPU 模拟天花板**:6000 池/60fps 余量充足(实测 ~1100 同屏);十万级需 GPGPU(FBO ping-pong)——TSL/计算着色器方向,r186 具备而本场景未需要。
4. **Point sprite 恒面向屏幕**:烟花球是 2.5D 效果;真 3D 体积爆裂需 mesh 粒子或 raymarch,属增强项。
5. **spec 时序张力(双臂同体,非引擎差异)**:harness 探针的截图/落盘开销使 P3/P4 实际采样点比名义晚 ~3.3s/~6.6s;brief 字面生命周期(≤1.6s 升空+≤7s 余烬)的粒子最晚死于点击后 8.6s < P4 采样 ~10.9s。Reference 以真实 crackle 谱系(暗火微点 7-12.5s + 裂变火花)合规延尾解决。**建议**:spec 复审时或在 runner 加入"采样时刻记录",让探针断言与名义时间的偏差显性化;Agent 臂将面临同一问题,属于可通过观测发现的工程约束。
6. **Cocos AIR 对照预期**:粒子系统(AIR 需自建或用内置 particle)与程序化楼群在 AIR 侧同样可行(WebGL2 自定义 shader);差异主要在 additive Points 管线易用性与调试可视化工具链,而非能力不可达。

## 4. 复现

```bash
cd bench/reference/private/three/E04
npm run build
node bench/harness/runner/validate.mjs --workspace <工作区> \
  --spec bench/briefs/E04/spec.json --out <工作区>/validation \
  --run-id REF-E04-three --video --port 7413
```

最终轮:REF-E04-three-R8V,PASS,8/8,fps 60,video.webm 已归档。
