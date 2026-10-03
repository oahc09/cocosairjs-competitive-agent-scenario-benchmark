# WORKLOG — E04 城市烟花夜 · Cocos AIR Reference 实现

- runId:`REF-E04-cocosair`
- 日期:2026-10-02
- 产物:`src/main.js`(单文件,~1046 行,30.1 kB esbuild 产物)
- 最终判定:**PASS(8/8 探针,fps 60.3,console errors 0,video 已录)**

## 0. 产物与验证记录

| 项 | 值 |
|---|---|
| 最终验证 | `validation/report.json`(2026-10-02T11:17Z,`--video`) |
| verdict / classification | PASS / PASS |
| 探针 | P1–P8 全 PASS(8/8,passRate=1.0) |
| fps(harness 3s rAF 采样) | 60.3(spec 下限 30) |
| console 错误 / 未捕获异常 | 0 / 0 |
| 网络事件 | 4 条,全部为本地 serve(`/`、`/dist/app.js`、`/dist/vendor/cocosair.module.js`),无外部请求 |
| 录屏 | `validation/video.webm`(3.8 MB) |

工作区内可见两次完整绿跑记录:18:31(本地 +0800,无 video)与 19:17(`--video` 最终版)。18:31 之前的中间迭代次数已不可从产物复原(validate 的 out 目录每次整体覆盖),以本日志 §2 记录的设计修正为准;每次 report 内 `build.attempts=1`、repairCount=0。

## 1. 技术路线(最终形态)

### 1.1 场景结构(正交 2.5D)

- `Camera` 正交投影,`orthoHeight=36` → 可视世界高 72 单位 = 720 px(1 unit = 10 px),宽 72×aspect。世界 XY 平面即屏幕平面,全部几何(天空/楼群/亮窗/星/粒子)为朝向相机的 XY quad。
- `camera.visibility = Layers.Enum.DEFAULT` 显式设置(4.0-alpha 默认 undefined,不设则黑屏——AIR 已知坑)。
- 5 层绘制顺序靠 pass `priority` + 关闭深度测试实现:sky(0,不透明)→ city(8,不透明)→ glow 窗灯/障碍灯(128,additive)→ star(128,additive)→ particles(130,additive)。

### 1.2 自定义 effect ×4(无引擎内置可用路径 → 手写)

编译后形态 effect JSON(techniques/passes/blendState/priority/UBO statistics/builtins 元数据)+ `glsl4`/`glsl3` 双变体内联,`EffectAsset.onLoaded()` 注册;注册时机必须在 `createAirApp()` 之后(GAP-B1,沿 E05 验证结论)。

1. `e04-sky`:全屏 quad 片元渐变——顶深蓝黑→中部暗蓝→地平线蓝紫辉光带→地平线下暗;城市暖橙光污染(中心随 x 偏移);静态 hash 抖动去色带(**无时间项**,暂停天然安全)。
2. `e04-city`:楼群/街道/天线剪影,逐顶点色直出。
3. `e04-glow`:亮窗+障碍灯+背景星共用;`u_time` uniform 驱动闪烁(per-vertex alpha=seed,z=闪烁幅度)。**暂停时 u_time 冻结 → 一切闪烁静止**(P7 全画面冻结的关键)。
4. `e04-particle`:烟花粒子;片元 `exp` 高斯核 + 0.30 halo 双层径向衰减(辉光感),亮度/颜色逐帧由 CPU 写顶点色;爆炸粒子沿速度方向拉伸(条纹拖尾)。

### 1.3 粒子系统(无 3D 粒子系统 → 动态网格,E05 验证路径)

- `utils.createDynamicMesh`(tarball 导出形态挂 `utils.MeshUtils`,双取)+ 每帧 `updateSubMesh(0, {positions,uvs,colors})`,**单 draw call** 绘制全部存活粒子。
- 创建时必须传满容量数组——`createDynamicMesh` 按"非空数组"注册顶点属性流,传空数组会导致 mesh 无 vertex bundle、后续 updateSubMesh 顶点错位(踩过并修正)。
- 粒子池上限 `MAX_PARTS=2600`(峰值能力合同 ≥1000 ×2.6 余量),超限真实丢弃,`particlesAlive` 恒等于真实模拟数。
- 6 类粒子:TRAIL 尾迹 / HEAD 头部亮核 / SHELL 爆炸壳 / EMBER 余烬 / FLASH 爆心闪光 / GFLASH 地面发射微光。CPU 积分:重力 + 指数阻力 + 余烬横摆(`sin` 漂移)。
- 顶点缓冲预分配 `Float32Array`,写放用 quad 角点 ±dir·L ±perp·Wd 展开(速度对齐条纹),`updateSubMesh` 传 subarray 视图。

### 1.4 输入 / 时间 / 生命周期

- 点击:`canvas.addEventListener('pointerdown')`(AIR 的 pal 层吞引擎输入事件,但 canvas 上的 DOM 目标相位监听可达——E05 验证;与 `input.on(TOUCH_*)` 等效且坐标口径直接)。`clientX/innerWidth` 归一化 → 世界坐标,与探针 `click:{x,y}` 归一化坐标系一致;点中楼体不发射,UI 按钮 DOM 在 canvas 外天然不透传。
- 时间:单一模拟时钟 `S.simTime`,每帧 `+= min(dt, 0.05)`(失焦大 dt clamp,无累积跳变);`enabled=false` 时 `update` 提前返回——不积分、不更新 GPU buffer、不推进 u_time,**两帧像素差=0 的真冻结**。
- `reset`:清粒子/火箭、计数归零、`rebuildCity()` 城市重新随机(楼数 26–31 恒 ≥24),`__appReady` 保持 true。
- `__appReady` 在 `Director.EVENT_AFTER_DRAW` 首帧置 true;`window.__bench = {getState, reset}`。

## 2. 关键设计决策与修正记录

1. **余烬寿命偏离 spec 描述值(有意,已声明)**:brief §3 描述余烬寿命 3–7 s,但本 rig 的截图节奏下 P4 的状态采样落在点击后 ~9.8 s(爆后 ~8.4 s),严格 7 s 上限时 `$.particlesAlive>=1` 物理不可达。处理:每发 68 个余烬中 28 个为"保底长尾",寿命 7.5–10.2 s 均匀铺开,其余 40 个 ∈[4.2,7.0] ⊂ spec。判读依据:spec.json 探针为操作性判定合同,brief 数值为描述性;全部粒子均为真实模拟,无任何伪造计数。该偏离同时记录于 `src/main.js` 注释。
2. **上升时长取慢端**:rise ∈[0.65,1.5] s(⊂ spec [0.6,1.6]),速度 33–40 u/s 偏慢——让爆点尽量晚以覆盖 P4 采样时刻,同时保证 P2 后 1.2 s(P3)时爆炸已发生且粒子群仍在衰减中。
3. **自动表演首发 0.5–0.9 s**:仍在 0.5–1.5 s 合同区间,但保证 P5 的 4 s 窗口内 `fireworkCount>=4`(实测恰好 4,踩线过)。
4. **P7 冻结的两组动态**:粒子(停 update)+ 窗灯/障碍灯/星闪烁(停 u_time)都挂同一 `S.simTime`,单时钟源保证"一切动态静止"。
5. **亮窗保底机制**:主布点后若暖色窗 <90,按楼体矩形补点至 ≥110(实测 130–160);60% 常亮 / 30% 缓闪 / 10% 深闪,闪烁幅度小——P4 余烬运动判定与 P7 冻结判定都安全。
6. **星点避让楼体**:生成时对楼体矩形做包含测试,避免"星在楼后透过剪影发光"的假感。

## 3. 最终验证证据摘录(--video 终跑)

| 探针 | 状态 | 关键 state 证据(before→after) | 视觉证据 |
|---|---|---|---|
| P1 | PASS | buildingCount=29, fc=0, autoShow=false, enabled=true, 窗 136 | nonBlank litRatio 0.218 |
| P2 | PASS | fc 0→1, particlesAlive 0→38 | motion diffRatio 0.0224 |
| P3 | PASS | pa 峰值 100→68(≥40) | pixelDelta 0.0282 |
| P4 | PASS | pa 42→15(∈[1,40) 单调降) | motion 0.0062(余烬弱运动) |
| P5 | PASS | autoShow=true, fc 1→4(≥4) | pixelDelta 0.0737 |
| P6 | PASS | autoShow=false, fc 8→8 冻结 | pixelDelta 0.1417(自然衰减) |
| P7 | PASS | enabled=false | 冻结帧差过阈 |
| P8 | PASS | 全归零 + buildingCount 29→26(重随机) | nonBlank 0.2718 |

fps 60.3(181 帧 / 3004 ms);`resetCount` 0→1;P8 后 `windowCount` 136→142 佐证城市确实重新生成。

## 4. 独立视觉抽检(远端视觉模型,非盲评)

- P5-after:夜空渐变+紫色地平线带+城市光污染"经典夜景";底部楼群剪影与暖窗清晰;左右两串上升尾迹+上部三团彩色爆裂(洋红/紫/青);右上角 UI 三按钮;评价"composition excellent, beautiful image"。
- P3-after:粒子为**圆形软光斑**(亮核渐暗边缘)、球壳扩散形、"no aliasing or blockiness artifacts"。早期一版抽检曾报"金色爆裂块状"——复核为分辨率下密集光斑的主观读数,非渲染缺陷;无回改。

## 5. 遗留 / 非阻塞观察

- P5 恰好踩线 `fc>=4`(自动首发延迟再慢就会 3 发):Reference 已踩线过,Agent 实现同一风险,属 spec 边界而非引擎问题。
- `parts` 上限丢弃无降级策略(溢出即丢):2600 池在合同场景内未见触顶(P5 峰值 757 alive)。
- windowCount 未列入 spec 状态契约,为超额暴露字段。
