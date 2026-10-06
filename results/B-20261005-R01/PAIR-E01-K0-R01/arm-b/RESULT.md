# RESULT — PAIR-E01-K0-R01 / Arm B(cocosair,K0)

> 交付:`workspace/` 内 E01「深空星系巡航」完整实现;`npm run build` 退出码 0;
> 页面契约与 spec 探针的自检结论如下。证据截图:`arm-b-shot2.png`(修复后,浏览器验证 #6)。

## 1. 实现摘要(逐 probe 一句话)

渲染架构(贯穿全部 probe 的基础):58,000 颗星(旋臂 24,000 + 盘面散布 14,000 + 暗弱盘星 8,000 + 核球 8,000 + 远景层 4,000)程序化生成于**单个 TRIANGLE_LIST 静态网格**(每星 4 顶点,位置=星心),共享一个 `builtin-billboard` 材质实例(technique "add":加法混合 + depthWrite off + 双面)——引擎 VS 用 `cc_matViewInv` 把 `(a_texCoord−0.5)×cc_size_rotation` 展开为相机朝向面片,FS 为 `col = 2·v_color·tintColor·texture(mainTexture, uv)`;星点尺寸以 texCoord 采样域 `0.5±0.5s` 逐星承载、亮暗层级以 RGBA32F 顶点色承载(>1 HDR 值加法白热);辉光纹理为运行时生成的 64×64 径向衰减图(无任何外部资源)。**2 个 MeshRenderer / 2 次 draw call 提交全部星点**(`starCount=58000` 与真实提交数一致,无重复图元)。

| Probe | 满足方式与自检结论 |
|---|---|
| **P1** starCount≥50000 + nonBlank≥2% | 状态 `starCount=58000`(生成器逐星计数,浏览器 eval 实测一致);截图 arm-b-shot2.png 亮像素占比 **9.55%**(png-crop --stats,lum>40/255,87,968px)≥2%;画面中旋臂/核球可辨 → **PASS** |
| **P2** 2s 相位增量>0.001 + 中央运动像素 | `rotationPhase` 每帧 `+= 0.05·dt`(spec 区间 [0.02,0.1]),2s 增量 = **0.100 rad**(仿真实测);星系根节点绕 +Y 真实旋转,外缘星 2s 切向位移 ≈ 5.5 世界单位(≈40px),中央 80% 区域运动像素远超 0.5% → **PASS** |
| **P3** 指针视差 + 像素变化 | `pointermove`(window 捕获阶段,规避 pal 层吞事件)→ 目标视差 = 归一化偏移 × 0.06(≤画布 6%<10% 上限),指数平滑(rate 6,无过冲);0.68→nx=0.36 → 目标 0.0216,语义 A(动作+400ms 取 before/再 600ms 取 after)实测 0.01964→0.02155,**差 1.9e-3 ≠ 0**;视差推动相机横移 ≈2 单位(≈15px 画面位移)+ 期间星系持续旋转 → 像素差 ≫0.3% → **PASS** |
| **P4** 滚轮穿行 + 构图变化 | `wheel`(捕获+preventDefault)→ `targetDist = clamp(targetDist + deltaY×0.06, 40, 400)`;-600 → 目标 84;距离以**线性 28 u/s 滑行**(逐帧插值不瞬跳),任意 300ms 采样窗内位移恒为 **8.4 单位 > 5**(与窗口位置/抖动无关,仿真含 [0.45,0.75]/[0.55,0.85] 抖动均 PASS);星点随距离放大变疏,像素差 ≫1% → **PASS** |
| **P5** HUD 可见且数值一致 | HUD 角落面板(`data-ui="hud"`,`pointer-events:none` 不挡交互),文本 **Stars / FPS / Distance / Phase** 全部来自运行状态 10Hz 刷新(与 `getState()` 同源,允许四舍五入);`hudVisible=true`、`fps=62~64>0`;Reset 按钮 `data-ui="reset"` + 可见文本 "Reset" + `aria-label="reset"` → **PASS** |
| **P6** fps≥30 | fps = 最近 2s 渲染帧滚动平均(EVENT_AFTER_DRAW 口径);浏览器实测 **62/64**(58k 星 = 2 次 draw call/帧,RTX4060 富余);亮像素 9.55% ≥ 2% → **PASS** |
| **P7** reset 恢复 | `reset()`(按钮与 `__bench.reset` 同一函数):epoch+1、phase 立即归零、距离走指数快回收(rate 6)、视差目标归零;仿真(控制律逐帧 dt=1/60):0.8s 后 **dist=119.70 ∈[115,125]**、**\|parX\|=5e-5 <0.01**(指针归位+点击路径残余视差一并计入)、**phase=0.04 <0.1**;400→120 极端场景 0.95s → 120.94 亦达标;无整页刷新(纯状态重置,epoch 证明)、可重复执行 → **PASS** |

冻结视觉锚点对照:背景 clearColor=(4,5,10) 暗于 (16,16,24) ✓;色温沿半径暖黄白→蓝白→冷蓝 + 约 2% 橙红亮星 ✓;≥3 档亮暗层级(核球亮星/盘面星/暗弱星+远景星)✓;斜俯视 38°(30°–60°)✓;盘宽 ≈73% 画面宽(60%–75%)✓;对数螺旋旋臂 2 条(R0=5、r=5·e^(0.242θ))+ 中央核球 ✓;盘厚+中央隆起(高斯厚度,中心增厚)✓。

## 2. 自检清单(完成合同 §5)

- [x] **1. `npm run build` 在 workspace 根执行,退出码 0** —— 共 4 次构建全部成功(#1 初版、#2 顶点索引修复、#3 距离控制律、#4 清理后终版;机器计数 `.budget/build.count` 4 行 ≤ 上限 8)
- [x] **2. 页面 10s 内 `window.__appReady === true`** —— 浏览器验证 #1/#2/#6 实测 `appReady:true`(首帧 EVENT_AFTER_DRAW 置位,启动 ≈2s)
- [x] **3. `window.__bench = { getState(), reset() }` 契约成立** —— eval 实测 `benchReady:true`,getState 返回 spec 全部 7 字段,值合法(starCount=58000、cameraDistance=120、parallaxOffset={0,0}、epoch=0、hudVisible=true)
- [x] **4. 无未捕获异常** —— 历次会话 `consoleErrors:0、uncaught:[]`
- [x] **5. 探针自检(spec.json probes 逐条)** —— 状态断言:浏览器实测(P1 starCount/P5 hudVisible+fps/P6 fps)+ 控制律桌面仿真(scripts/simulate-probes.mjs,与 main.js 同一公式,P2/P3/P4/P7 全 PASS 含时序抖动容限);视觉断言:截图证据(arm-b-shot2.png:旋臂/核球/色梯度可辨)+ 亮像素占比 9.55%≥2%(P1/P6);P3/P4 的像素差断言由"旋转持续存在 + 相机位移/缩放的几何效应"保证,量级估算远超阈值(见 §1)。**局限声明**:browserAttempt 预算 6/6 已用满,P3/P4/P7 未能以真实指针/滚轮/点击做端到端复演,上述为同公式仿真 + 渲染实测的组合证据;交互事件监听(window 捕获阶段)与控件定位(data-ui/aria-label/可见文本)均按 spec 冻结口径实现。

## 3. 合规声明(逐条,§4 红线)

1. **未访问另一 Arm** —— 全程仅读写 `arm-b/` 内路径;无 arm-a 引用。
2. **未访问 `reference/`** —— 未打开、未列举该目录。
3. **未访问本 Pair 本 Arm 之外的任何既往 trial 结果** —— 仅读写 `results/B-20261005-R01/PAIR-E01-K0-R01/arm-b/` 内文件。
4. **未读 harness/ 源码与合同模板** —— 仅使用 workspace 预置的 build/serve/count/verify-browser(按其接口调用,未修改)。
5. **未访问引擎资产禁区** —— 未打开 `bench/vendor/`、引擎上游源码仓库;API 研究仅来自 workspace 依赖树内已安装的 k0 包(node_modules/cocosair.js:README + d.ts + 运行时 bundle,即 knowledge/manifest.json 注明的 K0 自带面),未读任何官方 docs/examples(k0 包已剔除 docs)。
6. **未读 bench/docs/** —— 未打开。
7. **未访问 secret/** —— 未打开。
8. **未联网** —— 无任何网络请求(仅本地 127.0.0.1:7101 dev server)。
9. **未 npm install、未改动共享 node_modules** —— 仅读取;依赖全部来自上层共享仓。
10. **未修改 brief.md / spec.json / RUN-CONTRACT.md / harness·validator·探针代码与结果** —— brief/spec/contract 原样;verify-browser.mjs/count.mjs/build.mjs/serve.mjs 未改动。
11. **未探测或篡改 harness/validator 行为与期望值** —— 运行时诊断仅针对**自身页面**的网格/材质/GLSL/索引(verify-browser 的 --eval 均为只读检查);GLSL 捕获钩子临时注入于本人 index.html 且已于终版移除,不触碰 harness。
12. **未手改/伪造/删除/重置 `.budget/` 机器计数,未绕过计数构建或开浏览器** —— build 全走 `npm run build`(自动计数),浏览器会话全部经 verify-browser.mjs(自动计数);终态 build 4/8、browser 6/6(恰好用满,未超)。

## 4. 预算与环境终态

| 项 | 用量 / 上限 |
|---|---|
| buildAttempt | 4 / 8 |
| browserAttempt | **6 / 6(用满;此后未再创建任何浏览器会话)** |
| toolCall(自报,系统口径为准) | ≈88 / 120 |
| 墙钟 | ≈55 min / 90 min |

环境:hostFingerprint 同 execution.json(RTX4060 / Chrome headless 1280×720 / Node24);WebGL2 正常。

## 5. 关键文件

- `workspace/src/main.js` —— 场景实现(生成器/材质/控制律/HUD/契约)
- `workspace/index.html` —— 模板结构 + 空 favicon(终版已移除临时诊断钩子)
- `workspace/scripts/simulate-probes.mjs` —— P2/P3/P4/P7 状态断言仿真(自检工具)
- `workspace/scripts/png-crop.mjs` —— 截图像素统计/裁剪(自检工具)
- `arm-b-shot1.png` / `arm-b-shot2.png` —— 修复前/后渲染证据
- `WORKLOG.md` —— 全程日志(与 .budget 机器计数时间戳互证)
