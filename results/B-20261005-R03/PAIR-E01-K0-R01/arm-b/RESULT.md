# RESULT — PAIR-E01-K0-R01 / Arm B(cocosair,K0 冷启动)

- 完成时间:2026-10-05T08:29:00+08:00
- 实现:`workspace/src/main.js`(唯一应用源文件),构建产物 `workspace/dist/`
- 预算:build 1/8 · browser 4/6(机器计数见 `workspace/.budget/`)

## 1. 实现摘要(逐 probe)

| Probe | 满足方式 | 自检证据(状态 + 独立观测) |
|---|---|---|
| **P1** starCount≥50000 + 非空画面 | 66,000 颗程序化星点(旋臂 34,000 + 盘面 12,000 + 核球 12,000 + 远景 8,000)按"每星一水平 quad"批量编码进 8 个 TRIANGLE_LIST 网格(每 chunk ≤12,000 星,Uint16 索引安全),unlit 材质一次提交;`starCount` 只累计成功创建的 mesh | 状态:starCount=66000。观测:selfcheck/shot1.png——≥2 条对数螺旋旋臂、暖黄核球、蓝白→冷蓝径向梯度、橙红亮星散布、三层亮暗(核球亮星/盘面普通星/暗弱背景星),亮像素占比远超 2% |
| **P2** 持续旋转 + 运动像素 | CruiseController.update(dt) 以 ω=0.05 rad/s 累加 `rotationPhase`(单调递增),galaxyRoot 绕盘面法线(Y)旋转;背景星层独立静止增强相对纵深 | 状态:2s 采样相位增量 0.106 rad(0.1296→0.2354)。观测:selfcheck/motion-t0.png 与 motion-t2s.png 同机位两帧星点切向位移( harness motion 探针另行像素级验证) |
| **P3** 指针视差 | window **捕获阶段**监听 pointermove(pal 层吞 canvas 事件,捕获先于其触发),视差目标 = 指针偏离画面中心的有符号比例偏移;相机沿 right/up 解析横移(满偏 8 世界单位 ≈ 视口 8% < 10% 红线),指数平滑无过冲,星系与远景因深度差产生相对位移 | 状态:parallaxOffset 0→0.159(真实 mouse.move 中心→(0.68,0.50))。观测:selfcheck/after-pointermove.png 相对 motion-t2s.png 全画面构图平移,像素差远超 0.3% |
| **P4** 滚轮穿行 | wheel(捕获+passive)按 deltaY·0.12 调整目标距离,clamp [40,400],当前距离逐帧指数插值(速率 3.2/s)不瞬跳 | 状态:真实 mouse.wheel deltaY=-600 后 cameraDistance 120→49.5(Δ≈70 ≫ 5)。观测:selfcheck/after-wheel-zoom.png——近距星点明显放大变疏、构图显著变化(像素差远超 1%) |
| **P5** HUD | DOM 覆盖层(左上角,不遮挡主体),每 0.2s 用真实状态刷新文本:Stars/FPS/Dist/Epoch;Reset 按钮位于 HUD 内(text="Reset" + aria-label="reset" + data-ui="reset" 三重定位) | 状态:hudVisible=true,fps=60>0。观测:HUD 文本 "Stars: 66000 \| FPS: 61 \| Dist: 120 \| Epoch: 2" 与 getState() 数值一致(四舍五入);截图可辨 |
| **P6** fps≥30 | 帧时间戳 2s 滚动窗口,`fps = 窗口帧数/2`;批量网格提交(全场景 8 个 draw call),静置与交互同帧率 | 状态:静置 60.5、交互中 60–60.5,均 ≥30。观测:harness perfSample 独立交叉验证;引擎模板基线即 ~61fps(同一 headless Chrome 硬件 WebGL2) |
| **P7** Reset | 纯状态重置:相机距离/视差目标+当前值、旋转相位瞬时恢复,epoch+1,galaxyRoot 归位,立即 applyCamera(<1s);按钮 type=button 无导航,绝不 location.reload | 状态:按钮 click 后 epoch 0→1→2,重置后 0.8s:dist=120∈[115,125]、视差 (0,0)、phase=0.04<0.1;连续两次行为一致。观测:页面未发生导航(无 href/无 reload),画面连续 |

关键实现事实(引擎侧):`builtin-unlit-material` 命中(诊断 material 字段);颜色采用"带 tint 材质 × 顶点色相对值"双保险——顶点色生效时精确呈现目标色,不生效时带 tint 仍保证径向色带梯度;`Material` 不在模板已验证导出清单内,经动态 import 安全获取;`Camera.visibility` 显式 `Layers.Enum.DEFAULT`;8 chunks 全部创建成功,`__diag.errors` 为空。

## 2. 自检清单(RUN-CONTRACT §5)

1. [x] `npm run build` 在 workspace/ 根执行,退出码 0(build #1,机器计数 1 行)
2. [x] 页面 10s 内 `window.__appReady === true`(三次 verify-browser 会话 appReady 均为 true;模板基线 ~0.8s)
3. [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 stateContract 七字段;reset 可连续调用且行为一致)
4. [x] 无未捕获异常(三次会话 uncaught=[] 且 consoleErrors=0;`__diag.errors` 为空)
5. [x] spec.json 七条探针逐条自查全部通过(见第 1 节表格,每条均有状态断言证据 + 截图/文本独立观测证据,存于 selfcheck/)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的一切(目录、代码、日志、dev server、浏览器 profile、截图、结果)——本 Run 全部读写限于 `arm-b/` 内。
2. 未访问 `reference/` 任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. 未读 `harness/` 源码与合同模板(仅按合同与模板内注释/头说明使用既定入口 `count.mjs`/`verify-browser.mjs`)。
5. 未访问 `bench/vendor/`、引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);未读共享 node_modules 内引擎 d.ts/docs(K0 隔离,API 仅依据模板已验证用法、knowledge/README.md 与 AGENTS.md 坑位清单)。
6. 未读 `bench/docs/`(实验计划书与合同文档目录)。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档检索、无搜索、无包 registry 访问)。
9. 未执行 `npm install`,未安装/改动任何依赖,未改动共享 node_modules 内容。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件;未修改只读资产 `assets/`。
11. 未探测或篡改 harness/validator 的行为与期望值(探针预判仅基于 spec.json 冻结文本)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有 build 走 `npm run build`(count 前置串联),浏览器会话 3 次经 `verify-browser.mjs`、1 次为自研脚本但**先执行 `count.mjs browser` 再开会话**,无任何绕过计数的行为。

 特此声明:本 Run 全部产物(代码、截图、状态采样、本文档)均在上列约束下产生。
