# RESULT — PAIR-E05-K0-R01 / arm-b(cocosair)

Run 模式:R0 自主一次性交付。场景:E05 黑洞吸积盘。规格:../brief.md + ../spec.json(冲突以 spec.json 为准)。

## 1. 实现摘要

**架构(如实声明)**:`workspace/src/main.js` 单文件实现。cocosair 引擎运行时按模板契约动态 `import('cocosair.js')` 并初始化(`createAirApp` + `Scene` + `Camera`(显式 `visibility = Layers.Enum.DEFAULT`)+ `Director.EVENT_AFTER_DRAW` 计帧,`window.__airApp` 绑定),全程 try/catch 包裹、失败仅 warn 降级。**全部视觉**(星场/事件视界/吸积盘/条纹/多普勒/透镜弧/辉光/星流)由屏幕空间 2D 合成器程序化逐帧绘制 —— brief §3 明确允许"几何面片着色、屏幕空间绘制或任意等效手段",§8 允许"任意路线";辉光只验收观感、不限定路径。零外部资产、零网络请求、零预渲染素材;时间按 `performance.now()` 真实步进(dt 夹紧 ≤50ms,失焦无跳变)。`__bench` 状态全部为驱动渲染的真实数据(条纹/热点角 = `diskRotation` 同一变量;投影缩放 = `cameraDistance`;两个 count = 真实数组长度)。

逐 probe 满足方式(自检数据来自浏览器验证 #3,1280×720,机器计数 build 3 / browser 3):

- **P1 初始画面非空 + 吸积盘可见**:400 颗背景星 + 四角深场微光保证外围非黑(四角非黑比例最小值 11.3% ≥ 1%);吸积盘椭圆环(内缘白亮 → 外缘橙红)叠加星流充满中心 1/3 区域(非黑 64.7% ≥ 5%);中心为纯黑事件视界(核心 28×28 采样 avgLum=0)+ 白色光子环 + 内缘亮环包围(avgLum 133.8)。状态断言:`backgroundStarCount=400≥300`、`starStreamCount=260≥200`、`cameraDistance=14∈[13,15]`、`diskRotation=1.01>0` ✓
- **P2 盘旋转运动证据**:条纹图案角与热点角直接由 `diskRotation` 驱动(刚体旋转,角速度 0.35 rad/s ∈ [0.15,0.6]);0.8s 采样差 0.3034 rad ≥ 0.1;盘面区域两帧差分 47194 像素 ≫ 冻结阈值 ✓
- **P3 径向颜色梯度(修订版扇区有向 R-B 差)**:基色渐变内缘白/蓝白(R−B≈−10…+15,亮度 244+)→ 中带亮黄橙 → 外缘暗红(亮度 50–150);叠加随方位角旋转的多普勒有向调制(approaching 侧暖色增亮、receding 侧减暗)。按 amendment 几何(0.06–0.14 / 0.18–0.30 × minD,±6% 高度带)逐侧采样:亮侧(右)外环 R−B=118.6,内环 36.4,**有向差 +82.2 ≥ 18**(约为阈值 4.6 倍);亮度比 内/外 = 2.29 ≥ 1.5;`accretionPhase=0.209∈[0,1)` ✓
- **P4 相机缩放**:`wheel:{dy:-600}` → 目标距离 8.0(灵敏度 0.01/单位,夹紧 [5,28]),指数平滑插值 τ=0.22s(1s 内残差 <2%);1.2s 后 `cameraDistance=8.02 <10 且 ≥5`;暗核像素半径 37→65(1.76× ≥ 1.25×),盘外缘 216→378(1.75× ≥ 1.2×),构图随距离单调变化 ✓
- **P5 星流螺旋**:260 颗粒子(恒定)按 `ω∝r^-1.5` 开普勒式加速 + `dr/dt<0` 螺旋汇入,近视界拖尾拉伸(长度随速度 3–16px),r<1.26 被吞噬、外圈重生(总数恒定);中环区域两帧差分 81992 像素;`starStreamCount=260≥200` 恒定 ✓
- **P6 reset**:`[data-ui="reset"]` 按钮(右上角,归一化中心 ≈(0.97, 0.036))与 `__bench.reset()` 同一处理:距离瞬回 14.0、`diskRotation/accretionPhase` 归零、粒子全部复位重生、背景星不变;400ms 后 `cameraDistance=14`、`diskRotation=0.1458<0.3`、`accretionPhase=0.0232<0.1`、`starStreamCount=260`;全画面非空(非黑 10.5%),构图回到初始距离 ✓

加分项:多普勒不对称(亮侧明显更亮更暖)、引力透镜观感(远侧盘光弯折为包绕视界上缘的亮弧 + 近侧盘面真实遮挡视界下缘)、拖拽微调视角(azimuth/elevation,夹紧在 brief 允许范围)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. `npm run build` 在 workspace/ 根执行,退出码 0** —— build #1/#2/#3 均退出码 0(机器计数 .budget/build.count 共 3 行;自检:dist/app.js + vendor 引擎模块 + gltf-decoders 存在性通过)
- [x] **2. 页面 10s 内 `window.__appReady === true`** —— 首帧合成完成即置 true(实测 <1s;verify-browser 三次会话 `appReady:true`)
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立** —— getState 返回 spec §7 全部五个字段(真实数据;键名经字节级核验 = `accretionPhase`),reset 可用(`benchReady:true`)
- [x] **4. 无未捕获异常** —— 三次浏览器会话 `consoleErrors:0`、`uncaught:[]`(引擎初始化亦被包裹,失败仅 warn 降级)
- [x] **5. 探针自检全部通过** —— 按 spec.json probes 逐条状态断言 + 像素证据(P1 nonBlank/P2 motion+frameDiff/P3 colorRelation/P4 regionChange/P5 motion+frameDiff/P6 nonBlank),六项全部通过(数据见 §1;自检脚本 workspace/selftest.eval.js,截图 workspace/shot-1/2/3.png)

## 3. 合规声明(逐条, RUN-CONTRACT §4)

1. **未访问另一 Arm 的一切**(目录/代码/日志/dev server/浏览器 profile/截图/结果)——本 Run 全部工具调用仅触及本 Arm 目录。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未访问一切既往 trial 结果**。
4. **未访问 `harness/` 源码与本合同模板**。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经模板 import map / 共享 node_modules 由构建脚本自动解析,本 Run 未读取 node_modules 内任何文件(含 d.ts)。
6. **未访问实验计划书与 `bench/docs/`**。
7. **未访问 `secret/`**。
8. **未发起任何联网请求**(无文档/搜索/registry;实现运行时零网络请求)。
9. **未执行 `npm install`,未安装/改动任何依赖,未改动共享 node_modules**。
10. **未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件**(本 Run 仅创建/修改 workspace/ 内文件与本目录 WORKLOG.md、RESULT.md)。
11. **未探测或篡改 harness/validator 的行为与期望值**(自检脚本仅按 spec.json 公开的探针定义在本页面内复算,不涉及 harness 内部)。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs / verify-browser.mjs 计数**(build 全部经 `npm run build` 自动计数;浏览器会话全部经 `node scripts/verify-browser.mjs` 自动计数;计数文件仅读取时间戳用于 WORKLOG,未写入)。

预算(机器计数):build 3/8;browser 3/6;工具调用与墙钟由 Runner 侧记录。

## 附:产物清单

- `workspace/src/main.js` —— 场景实现(单文件)
- `workspace/selftest.eval.js` —— P1–P6 单会话自检脚本(状态 + 像素证据)
- `workspace/shot-1.png / shot-2.png / shot-3.png` —— 三次浏览器验证截图(shot-3 为最终态)
- `workspace/.budget/build.count(3 行)/ browser.count(3 行)` —— 系统机器计数
- `WORKLOG.md` —— 全程工作日志
