# RESULT — arm-a / PAIR-E01-K0-R01(E01 深空星系巡航 · three r186 · K0)

## 1. 实现摘要(逐 probe 一句话)

实现方式:`workspace/src/main.js`(esbuild 打包,three 经 import map 外部解析)。66,000 颗星
合并为两个 `THREE.Points` 批量提交(星系 62,000 = 核心亮星 2,500 + 核球 5,500 + 2 条对数旋臂
44,000 + 盘面散星 10,000;远景背景星 4,000),自定义 `aSize/aColor` attribute + ShaderMaterial
软辉光点精灵 + AdditiveBlending;相机 45° 仰角轨道(盘面法线与视线夹角 45°),距离 120、
范围 [40,400]、滚轮改目标值指数平滑逐帧插值;视差映射为小幅 yaw/pitch 偏移,远景层反向微转;
HUD 为 DOM 覆盖层,数字与 `__bench` 状态同源;reset 原地快平滑恢复,epoch+1,无页面刷新。

| Probe | 结果 | 摘要 |
|---|---|---|
| P1 | PASS | `starCount = 66000 ≥ 50000`(等于两份 BufferGeometry 真实顶点数之和,构建期硬校验),初始截图非空,星系盘面与亮核可辨(证据:`selfcheck-final2.png`)。 |
| P2 | PASS | 2s 采样窗内 `rotationPhase` 增量 0.1008 rad(ω=0.05 rad/s 单调递增),中央区域星点刚体旋转产生运动像素。 |
| P3 | PASS | 指针 (0.50,0.50)→(0.68,0.50) 后 `parallaxOffset.x` 0 → +0.0177(≤画面 5% < 10% 红线),画面产生可测像素变化。 |
| P4 | PASS | 滚轮 deltaY=-600 后 `cameraDistance` 120 → 92.86(500ms) → 84.31(800ms),满足 after < before-5 且逐帧插值无瞬跳,近距星点放大变疏。 |
| P5 | PASS | `hudVisible = true` 且 `fps = 60 > 0`,HUD 文本 `STARS 66000 / FPS 60.0 / DIST …` 与 `__bench.getState()` 数值一致(允许四舍五入)。 |
| P6 | PASS | 连续采样窗内滚动平均 `fps = 60 ≥ 30`(2s 滚动平均,空闲态)。 |
| P7 | PASS | 点击 `ui#reset` 后 800ms:`cameraDistance = 119.94 ∈ [115,125]`、视差 (0,0)、`rotationPhase = 0.04 < 0.1`、`epoch = 1`,画面非空,无页面导航;二次 reset 行为一致(epoch=2,相位再次归零)。 |

## 2. 自检清单(RUN-CONTRACT §5 五项)

- [x] 1. `npm run build` 在 `workspace/` 根执行,退出码 0(共 3 次构建,均 exit 0;机器计数 `.budget/build.count` 3 行)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(verify-browser 实测 `appReady: true`,首帧渲染后立即置位)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(`benchReady: true`,全部探针经其取态/驱动)。
- [x] 4. 无未捕获异常(`consoleErrors: 0`,`uncaught: []`,加载/交互/reset 全程)。
- [x] 5. 探针自检 7/7 通过(状态断言 + 截图/运动/像素/DOM 独立观测证据,见上表;证据文件:`selfcheck-initial.png`、`selfcheck-final.png`、`selfcheck-final2.png`)。

预算使用(自报,机器计数为准):build 3/8 · browser 3/6 · toolCall ≈ 25/120 · 墙钟 ≈ 12 min/90 min。

## 3. 合规声明

本 Run 期间未访问 §4 任何禁止路径,逐条声明如下:

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 目录。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录及一切既往 trial 结果(仅读写本 Arm 目录与 `workspace/`、`knowledge/`、`assets/`)。
4. 未读取 `harness/` 源码与合同模板(仅使用 workspace 内预置脚本 build/serve/count/verify-browser)。
5. 未访问引擎资产 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);K0 冷启动隔离保持完好。
6. 未访问实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无联网文档/搜索/包 registry;仅本机 dev server 127.0.0.1:7114)。
9. 未执行 `npm install`,未安装或改动任何依赖(引擎经上层共享 node_modules 解析)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(探针自检脚本仅通过公开的 `__bench` 契约与 DOM 事件驱动页面)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 `count.mjs`/`verify-browser.mjs` 计数(build 全部经 `npm run build`,browser 会话全部经 `verify-browser.mjs`)。

额外声明:未使用任何共享图片/纹理资产(E01 资产契约为"无共享资产",全部星点程序化生成);
未以 2D 位图/CSS/DOM 位移冒充 3D 渲染;`starCount` 与真实提交渲染顶点数严格一致;
HUD 全部数字来自运行态真实数据;reset 未使用 `location.reload` 或整页刷新。
