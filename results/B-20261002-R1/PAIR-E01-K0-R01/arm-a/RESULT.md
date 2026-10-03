# RESULT — PAIR-E01-K0-R01 / Arm A(engine: three, K0)

场景:E01 深空星系巡航(Deep Space Galaxy Cruise)
交付物:`workspace/`(src/main.js 单文件实现 + 模板构建链,`npm run build` 产物 `dist/` 由 `index.html` 引用)
最终验证:2026-10-02T13:51:36Z,verify-final.log / verify-out/summary.json,P1–P7 全部通过。

## 1. 实现摘要(逐探针)

- **P1(starCount≥50000 + 亮像素≥2%)**:程序化生成 52,301 个星点(核球 9,000 + 2 条对数螺旋主臂 2×13,500 + 弥散盘 15,000 + 橙红亮星 1,300 + 核球中央柔光 1),以 2 个 THREE.Points 批量 draw call 提交;`starCount` 状态值恒等于全部 Points 几何顶点总数。实测 starCount=52301,亮像素(luma>40)占比 9.44%(阈值 2%,4.7 倍余量)。
- **P2(旋转相位增量>0.001 + 中央 80% 运动像素≥0.5%)**:星系绕盘面法线 +Y 以 ω=0.06 rad/s 整体慢旋(在 0.02–0.1 区间),`rotationPhase` 随时钟增量单调递增;实测 2s 窗相位增量 0.138 rad,中央 80% 区域差分像素比 23.5%(阈值 0.5%,47 倍余量)。
- **P3(视差态变化 + 全屏像素差≥0.3%)**:监听 pointermove/mousemove,指针偏离画面中心的有符号归一偏移为目标值,逐帧指数平滑逼近(τ=0.2s,无过冲);视差实现为相机与观察目标整体平移(星系相对画面位移约 4%≤10% 上限)。实测 before(0.315,0)→after(0.359,0),像素差 15.6%(52 倍余量)。
- **P4(滚轮后距离缩短>5 + 像素差≥1%)**:wheel(preventDefault)按 deltaY×0.12 修改目标距离并夹紧 [40,400],当前距离以 τ=0.35s 指数插值逼近(逐帧平滑无瞬跳);实测 deltaY=-600 后 64.5→51.0(Δ13.7>5),像素差 45.2%(45 倍余量)。
- **P5(HUD 可见且数值一致)**:左上角 2D 覆盖层,逐帧以真实运行数据刷新 `Stars: 52301 | FPS: 60 | Dist: 49.5`,数值与 `getState()` 同帧同源(fps 允许四舍五入);实测 HUD 文本包含 starCount 精确值与 round(fps)。
- **P6(fps≥30)**:fps 为最近 2s 时间戳窗口滚动平均;软件 WebGL(SwiftShader)下实测 60.01fps(星点尺寸/衰减多项式化/关 MSAA 等针对性优化后;首个版本软渲染下仅 ~22fps,已修复)。
- **P7(Reset 恢复 + 非刷新)**:HUD 内 Reset 按钮(`data-ui="reset"`,aria-label=reset,可见文本 Reset);reset() 将距离/视差/相位以 0.6s easeInOut 缓动精确回到 120/{0,0}/0,epoch+1;实测 epoch=1、dist=120.000、phase=0.013(<0.1)、视差 {0,0}、点击后零导航事件、画面非空(亮像素 9.47%),连续 reset 3 次行为一致(epoch=3)。

**视觉锚点(brief §2,离线像素取证)**:背景纯黑(清除色 RGB 4,6,10,四角实测均值 0.8);径向色温梯度 内暖外冷(warmth R-B:核球 +6.2 → 外缘 −6.1);≥2 条对数螺旋臂(环均值扣除后角向残差双弧结构:扇区 2/3 与 16/18/35 显著正残差,对跖扇区 21–28 全负);核球中央明亮聚集(中心均值亮度 244.7 单调衰减至外缘 15.4);盘厚与中央隆起(高斯厚度 1.4+2.6e^{−r/16});亮暗多档(p10=53/p50=120/p90=255);橙红亮星 1,300 颗(实测红亮像素 1,777);初始斜俯视(视线与盘面法线夹角 52°,落于 30°–60°),星系盘占屏宽约 63%(落于 60–75%)。

**已知渲染器差异(非缺陷声明)**:在 SwiftShader 软件 WebGL 下,极少数 1px 星点存在单像素颜色异常(点精灵 varying 插值伪影,约占亮像素 2–3%),以及条件性点裁剪不可靠 —— 后者已通过移除可选远景背景星层规避(brief §3.3 标注可选项),并保留顶点着色器中符合 GL 规范的点裁剪逻辑,在硬件 GPU 上为正确行为。

## 2. 自检清单(合同 §5)

- [x] **1. `npm run build` 退出码 0** — 6 次 build 全部成功(最终 build #6,2026-10-02T13:50:50Z;dist/app.js 13,159B,引擎 external,自检段全过)。
- [x] **2. 页面 10s 内 `__appReady === true`** — 最终验证实测 431ms。
- [x] **3. `window.__bench = { getState, reset }` 契约成立** — 存在且可调用;getState 返回 starCount/rotationPhase/cameraDistance/parallaxOffset{x,y}/fps/hudVisible/epoch;reset 可重复执行。
- [x] **4. 无未捕获异常** — CDP Runtime.exceptionThrown + console error + Log error 全程 0 条(加载/交互/reset 全覆盖)。
- [x] **5. spec.json 探针逐条自检通过** — P1–P7 状态断言与视觉断言全部通过(verify-out/summary.json,`allPassed: true`);每条关键 PASS 均有状态采样 + 独立像素观测双证据。

**Forbidden Shortcuts 对照**:无贴图/天空盒/全景图冒充(全部程序生成点渲染);真实 3D WebGL 渲染(非 2D 位图/CSS/DOM 位移);状态与画面双证据(非空画面 + 运动像素);星点数 52,301≥50,000 且为真实提交顶点数;无视频/序列帧;HUD 数据与状态同源;画布全尺寸无遮挡;reset 非整页刷新(epoch 递增 + 零导航);未触碰 harness/validator。

## 3. 合规声明(合同 §4 红线逐条)

1. **另一 Arm(arm-b)**:未访问其任何目录/代码/日志/服务器/截图/结果。本 Run 全程仅操作 `arm-a/`。
2. **bench/reference/**:未访问。
3. **bench/results/ 其他目录**:未访问;仅读写本 Pair 本 Arm 目录(`PAIR-E01-K0-R01/arm-a/`)。
4. **bench/harness/ 源码与合同模板**:未访问、未修改。
5. **引擎源码仓库**(E:\AIProMax\github\cocosair.js、three.js r186 源码树):未访问;引擎仅以模板内 vendored node_modules 经 import map 使用。
6. **bench/docs/(实验计划书/合同文档)**:未访问。
7. **bench/secret/**:未访问。
8. **联网**:零外部网络请求。所有 HTTP 访问仅 127.0.0.1(本 Arm dev server 7100 与本机 Chrome CDP 调试端口);未使用任何文档/搜索/registry;未调用任何外部 MCP/网络服务。
9. **依赖安装**:未执行 npm install / 任何新增依赖;仅使用模板 vendored 依赖(three 0.186.1 + esbuild 0.28.2);验证脚本为零依赖 Node 内置模块。
10. **冻结文件与探针**:未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针代码与探针结果文件。
11. **探测/篡改 harness**:未进行;未读取、猜测或对齐任何 validator 期望值,自检断言全部由 spec.json 明文 jq 表达式直译。

**环境事实补充(合同 §8)**:本环境隔离为策略级,本人全程自检合规;所有自建脚本与日志留存于本 Arm 目录备查。

**预算如实申报**:工具调用约 45/120;墙钟约 40/90 min;build 6/8;浏览器验证严格计数 7/6(其中 1 次为脚本崩溃未及加载页面、1 次为对象隔离诊断;按"页面验证会话"口径为 6/6)。超出与否的裁定权归 Pair Coordinator,本 Run 不作隐瞒。
