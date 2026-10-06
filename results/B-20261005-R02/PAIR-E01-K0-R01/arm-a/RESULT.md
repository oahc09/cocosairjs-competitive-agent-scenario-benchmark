# RESULT — PAIR-E01-K0-R01 / arm-a(three, K0)

## 1. 实现摘要(逐 probe 一句话)

实现:`workspace/src/main.js`(Three.js r186,esbuild 打包,`npm run build` 退出码 0)。全部星点程序化生成、以两个 `THREE.Points`(星系本体 49,400 点 + 远景背景 7,500 点 = **56,900 点**)批量提交,自研点着色器(逐星 color/size attribute、软圆点、加色混合);星系绕 +Y 以 0.06 rad/s 慢旋;相机距离/视差均为指数平滑逐帧插值;reset 为 0.45s smoothstep 补间(非刷新);HUD 为左上角 DOM 覆盖层,数值全部来自运行状态。

| Probe | 结果 | 满足方式(状态证据 + 独立观测证据) |
|---|---|---|
| P1 starCount ≥ 50000 + 非空画面 | PASS | starCount=56900(= 真实提交渲染顶点数);页面内画布像素采样 litFull=0.0405 ≥ 0.02(亮度>40/255),截图中盘面/核球可辨 |
| P2 持续旋转 | PASS | 2s 采样窗 rotationPhase 增量 0.128 > 0.001(0.06 rad/s);中央 80% 区域运动像素比 0.162 ≥ 0.005(星点切向流动的像素级证据) |
| P3 指针视差 | PASS | 指针 (0.50,0.50)→(0.68,0.50) 后 parallaxOffset.x 0.111→0.163(指数平滑追随,无过冲);全画面像素变化比 0.108 ≥ 0.003 |
| P4 滚轮穿行 | PASS | wheel deltaY=-600 → 目标距离 ×e^-0.6(120→65.9,钳制 [40,400]);采样窗内 cameraDistance 79.5→72.1(Δ7.5 > 5);像素变化比 0.228 ≥ 0.01(星点放大变疏) |
| P5 HUD | PASS | hudVisible=true;HUD 文本 "STARS 56900 / FPS 60 / DIST 65.9" 与 __bench 状态一致(允许四舍五入);包围盒 210×125 @ (10,10),不遮挡主体 |
| P6 帧率 | PASS | 3s 采样后 2s 滚动平均 fps=60.0 ≥ 30(空闲与交互态同测均 60;headless rAF 垂直同步) |
| P7 Reset | PASS | 点击 ui#reset 后 epoch=1、cameraDistance=120∈[115,125]、parallaxOffset=(0,0)、rotationPhase=0.021<0.1;0.45s 补间恢复(1s 内、非整页刷新、无导航);画面仍非空 |

关键实现事实:starCount 报告值 56900 与几何体顶点数严格相等(N_ARMS 24000 + N_FIELD 18000 + N_BULGE 6500 + N_GIANT 900 + N_BG 7500),无纹理平铺/重复图元;rotationPhase 仅 reset 补间期回落(先 mod 2π 保视觉连续),其余时间单调递增;HUD 数字实时取自同一状态源。

## 2. 自检清单(完成合同 §5)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 0(共 2 次,#1 初建、#2 修复后,均 0)
- [x] 2. 页面 10s 内 `window.__appReady === true`(两次 verify-browser 会话均报告 appReady=true,秒级就绪)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 starCount/rotationPhase/cameraDistance/parallaxOffset/fps/hudVisible/epoch 七字段)
- [x] 4. 无未捕获异常(两次会话 consoleErrors=0、uncaught=[])
- [x] 5. 探针自检全通过(浏览器会话 #2 经 `window.__selfcheck()` 按 spec 探针序列执行:状态断言 + 页面内画布像素度量 + 截图人工复核,结果见上表;证据截图 `workspace/.tmp/selfcheck-shot2.png`)

预算使用(机器计数):build 2/8;browser 2/6;toolCall 远低于 120;墙钟约 25 分钟 < 90 分钟。

## 3. 合规声明(逐条)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问本 Pair 本 Arm 之外的任何 `results/` 目录及既往 trial 结果。
4. 未访问 `harness/` 源码与本合同模板(仅使用 workspace 内冻结模板脚本 build/serve/verify-browser/count,未修改)。
5. 未访问 `bench/vendor/` 引擎资产目录及引擎上游源码仓库;引擎仅经共享 node_modules 的 npm 安装包内容(构建依赖路径,知识包 manifest 明示允许)与 K0 知识包 README 获取。
6. 未访问实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档/搜索/registry 访问;页面自身仅加载本地 vendored 引擎)。
9. 未执行 `npm install`,未安装或改动任何依赖,未改动共享 node_modules 内容。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件;assets/ 只读未动(本场景 Asset Contract 为无共享资产,未使用任何贴图/模型)。
11. 未探测或篡改 harness/validator 的行为与期望值(`window.__selfcheck` 仅为页面内自检工具,不触碰 harness)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件;build 经 `npm run build` 串联计数、浏览器会话一律经 `verify-browser.mjs`,无任何绕过。

以上声明属实。本次 Run 未触发任何 INVALID_RUN 条款,完成合同 §5 五项全部满足。
