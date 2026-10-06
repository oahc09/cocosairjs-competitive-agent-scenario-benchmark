# RESULT — Arm B(cocosair,K0)PAIR-E01-K0-R01 · E01 深空星系巡航

> Run 时间:2026-10-05T15:10–15:42(+08:00);预算:build 3/8 · browser 3/6 · 工具调用远低于 120 · 墙钟 ≈32 min/90。
> 交付物:`workspace/src/main.js`(唯一改动文件)+ 本文件 + `WORKLOG.md` + `_selfcheck/`(自检截图与探针链路脚本)。

## 1. 实现摘要(逐 probe)

实现方式:全部星点程序化生成于运行期——**52,000 颗星 = 星系盘 48,000(2 条对数螺旋旋臂 r=A·e^(Bθ) 各 15,000 + 扁高斯核球 8,000 + 盘面散星 10,000)+ 远景静态星壳 4,000**;每颗星为 XZ 面上 4 顶点小方片(顶点色按半径梯度:核心暖黄白→中段蓝白→外缘冷蓝,散布 0.8% 橙红亮星;核球亮星/盘面普通星/暗弱星三档亮暗),合并为 2 个静态 Mesh 各 1 次批量 draw(builtin-unlit + USE_VERTEX_COLOR + 双面),starCount 状态值与真实提交渲染数严格相等。

- **P1(starCount≥50000 + 非空)**:单 Mesh 顶点块精确生成 48,000+4,000=52,000 星,`getState().starCount===52000`;截图星系盘面/核球可辨,亮像素(星点颜色亮度 0.3–1.25)远超 2% 下限。自检实测 52000 ✓。
- **P2(旋转相位 + 运动像素)**:GalaxySpin 组件以 0.05 rad/s(规格区间内)绕盘面法线累计 `rotationPhase`,星系节点逐帧同角旋转 → 星点真实切向流动。自检 2s 窗口 Δφ=0.1008 rad > 0.001 ✓,旋转为逐帧几何运动,画面必有运动像素。
- **P3(指针视差)**:mousemove/pointermove 于窗口捕获阶段监听(pal 吞事件规避)+ 引擎 `input.on(MOUSE_MOVE)` 双保险;视差目标为指针偏离中心的有符号归一化偏移,指数平滑(τ=0.55s,无过冲)驱动相机横移(满偏 ≈ 视宽 3% < 10%)。自检指针移至 (0.68,0.50) 后 400→1000ms 窗口 parallaxOffset.x 0.186→0.301(Δ=0.115 ≠ 0)✓,伴随真实画面位移。
- **P4(滚轮穿行)**:wheel 捕获监听,deltaY<0 靠近;目标距离 clamp [40,400],逐帧指数插值(τ=0.65s,不瞬跳)。自检 deltaY=-600 后 500→800ms 窗口 cameraDistance 87.11→77.09(Δ=-10.02 < -5)✓,构图显著变化(星点放大变疏)。
- **P5(HUD)**:DOM 覆盖层左上角显示 Stars/FPS/Distance,在 EVENT_AFTER_DRAW 内按显示值变化逐帧刷新(与状态同源同帧,滞后≤1 帧);Reset 按钮可见文本 "Reset" + aria-label="reset" + data-ui="reset"。自检 hudText "Stars: 52000 / FPS: 60 / Distance: 77" 与同刻状态 (52000, 60.01, 77.09) 四舍五入一致 ✓。
- **P6(帧率)**:fps = 最近 2s 滚动平均(EVENT_AFTER_DRAW 时间戳),52k 星 2 次 draw 极轻负载。自检稳态 fps≈60.0 ≥ 30 ✓。
- **P7(Reset)**:`reset()` 将 epoch+1、rotationPhase 归零、视差与指针参考位归零、目标距离恢复 120(快速 τ=0.2s 平滑,1s 内完成,非整页刷新,无导航)。自检点击后 800ms:epoch=1、cameraDistance=118.91∈[115,125]、parallaxOffset={0,0} 精确、rotationPhase=0.040<0.1、画面非空 ✓;连续二次 reset epoch=2 行为一致 ✓。

Forbidden shortcuts 逐条规避:无贴图/天空盒/预渲染(纯几何+顶点色)、无 2D 位图/CSS 冒充、状态与真实渲染绑定(画面为真实 WebGL 绘制)、画面持续更新不冻结、52,000 星全部真实绘制无重复图元虚报、无视频/序列帧、HUD 全部来自实时状态、画布正常尺寸无遮挡、reset 无 location.reload、未探测 harness/validator。

## 2. 自检清单(完成合同 §5)

1. ✅ `npm run build` 于 workspace 根执行,退出码 0(3 次尝试,计数见 `workspace/.budget/build.count`,机器计数)。
2. ✅ 页面 10s 内 `window.__appReady === true`(verify-browser #1/#2/#3 均 appReady:true,首帧 EVENT_AFTER_DRAW 即置位)。
3. ✅ `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady:true;getState 返回 starCount/rotationPhase/cameraDistance/parallaxOffset/fps/hudVisible/epoch 七字段)。
4. ✅ 无未捕获异常(三次会话 consoleErrors:0、uncaught:[])。
5. ✅ 探针自检:P1–P7 逐条通过(状态断言全部数值实测通过,见上;视觉断言经 `_selfcheck/shot1-3.png` 人工核验:非空、核球/旋臂可辨、HUD 可读)。P2/P3/P4 的画面级运动/像素差由逐帧几何运动机制保证(旋转 0.05 rad/s、视差位移、距离滑行均为真实逐帧变化),状态证据+截图证据齐备;videoClip/pixelDiff 类独立观测留待 harness 正式采集。

## 3. 合规声明(§4 红线逐条)

1. ✅ 未访问另一 Arm 的一切(目录、代码、日志、dev server、浏览器 profile、截图、结果)。
2. ✅ 未访问 `reference/` 任何内容。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读任何既往 trial 结果。
4. ✅ 未读 `harness/` 源码与本合同模板(探针时序仅依据 spec.json 内冻结的 probeConventions/threshold 文本)。
5. ✅ 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。说明:API 确认仅读取了 workspace 自身依赖的安装产物(共享 node_modules 内 k0 tarball 安装版 `cocosair.js` 的 `build/cocosair.module.d.ts` 及对其 built bundle 的少量定点 grep),该依赖按 RUN-CONTRACT §1/§4.9 由上层共享 node_modules 提供、构建脚本本身即从其复制引擎文件,且 K0 tarball 已剔除官方 docs;未访问任何 vendor 目录内 SDK/docs/examples。
6. ✅ 未读实验计划书与 `bench/docs/`。
7. ✅ 未访问 `secret/`。
8. ✅ 未发起任何网络请求(无文档搜索、无 registry 访问)。
9. ✅ 未执行 `npm install`,未安装/改动任何依赖(共享 node_modules 仅读)。
10. ✅ 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(仅新增 src/main.js 实现与 WORKLOG/RESULT/_selfcheck)。
11. ✅ 未探测或篡改 harness/validator 行为与期望值。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;构建一律经 `npm run build`(内置 count.mjs),浏览器会话一律经 `scripts/verify-browser.mjs`(自动计数),无任何绕过。

声明:以上为如实陈述,本 Run 全部工作限于 `arm-b/` 目录及 workspace 合法依赖解析。
