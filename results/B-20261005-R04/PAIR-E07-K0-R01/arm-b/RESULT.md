# RESULT — PAIR-E07-K0-R01 / arm-b (cocosair, K0)

> Agent Run 自报交付。判定唯一事实源为 harness validate.mjs 的 report.json(自检口径不算数)。

## 1. 实现摘要(逐 probe 一句话)

实现方式:`workspace/src/main.js` 单文件 Code First(cocosair 1.0.0)。三份批量几何、共 4 次绘制提交:
静态楼群+地面+道路 merged mesh(builtin-standard + 顶点色,1 draw)· 静态发光窗阵 mesh
(builtin-unlit + USE_VERTEX_COLOR,1 draw,引擎距离雾自动衰减远处窗光)· 动态车流/雨/霓虹/警示灯
mesh(`utils.MeshUtils.createDynamicMesh` + 每帧 `updateSubMesh`,1 draw)· 引擎侧相机/方向光。
雾经 `scene.globals.fog`(EXP_SQUARED,fogStart=55/density=0.0026/深蓝雾色)启停。

| Probe | 满足方式与自检结果 |
|---|---|
| P1 | 启动即满规模自动运行:buildingCount=237≥200、carCount=72≥60、rainParticleCount=2200≥1500、fogEnabled=true;全屏非空,天际线轮廓可辨(截图 selfcheck-final.png) |
| P2 | 72 辆车沿 3 条横穿主干道(z=52/36/20)双向连续移动,头灯白黄/尾灯红;600ms 街道层像素变化 streetDelta=0.0272~0.0751(128×72 采样代理,全分辨率更高) |
| P3 | 2200 雨丝循环下落(落地重生顶部,无泄漏),100ms 全屏细密像素差(rainDelta 代理 0.0098~0.0263;全分辨率估算 >2%),计数稳定 |
| P4 | 满规模运行 fps 来自真实帧间隔滚动窗口(最近 60 帧),空闲 59.9~60 ≥ 30;画面持续运动 |
| P5 | `data-bench/data-ui="toggle-fog"` 点击后 fogEnabled=false,`scene.globals.fog.enabled` 即时关断,上部天际线区域像素变化 fogOffDelta=0.1006~0.2946 |
| P6 | 再次点击 fogEnabled=true,雾衰减恢复,上部区域再次变化 fogOnDelta=0.1006~0.2946 |
| P7 | `reset()` 不刷新页面:种子确定性恢复车/雨初相、simTime 归零、雾恢复开启,计数不变(fogEnabled=true,resetCount=1),城市完整重建非空 |
| P8 | reset 后车流/雨动画继续(p8motion=0.0282),fps=59.9 ≥ 30,无未捕获异常 |

行为/视觉/交互/生命周期补充:窗阵每栋 ≥8 点、全场景 ≈5200 点 ≥2000,矩阵排布随机点亮(暖/冷色);
霓虹 43 处(20 边缘灯带 + 18 立面招牌 + 5 楼顶广告牌,品红/青/橙黄/荧光绿/粉 5 种高饱和色相,
呼吸/爆闪/常亮三态)+ 8 处楼顶红色航空警示灯;距离雾使远处楼群与窗光明显衰减入深蓝雾色(截图纵深可辨);
fps 真实测量非常数(空闲 60,抓帧开销期间降至 34 再恢复,证明非硬编码)。

## 2. 自检清单(完成合同 §5)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 0(共 6 次尝试,末次 #6 通过,机器计数 .budget/build.count=6)
- [x] 2. 页面 10s 内 `window.__appReady === true`(每次浏览器会话 appReady=true,实际 <3s)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;另附只读 debug.grab 自检采样,不影响契约)
- [x] 4. 无未捕获异常(consoleErrors=0,uncaught=[] 全部 6 次会话)
- [x] 5. 探针自检:P1–P8 状态断言全部满足;视觉断言以帧内区域采样数值验证(非空覆盖/区域变化/像素差/运动)全部通过

预算:build 6/8,browser 6/6(触及上限即收敛,无绕过),toolCall 与 token 由 Runner 侧记录。

## 3. 合规声明(逐条)

1. 未访问另一 Arm(arm-a)的任何目录、代码、日志、dev server、浏览器 profile、截图、结果。
2. 未访问 `reference/` 任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录与既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板(仅使用本 Arm 目录内预置的 workspace 冻结脚本)。
5. 未访问 `bench/vendor/` 与引擎上游源码仓库(E:\AIProMax\github\cocosair.js、three.js r186 源码树);
   API 确认仅 grep 了本 Arm 目录内 `workspace/dist/vendor/cocosair.module.js`(白名单内的模板构建产物,无 docs/examples)。
6. 未访问 `bench/docs/` 实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未联网(无任何外部网络请求;仅本机 127.0.0.1:7121 dev server)。
9. 未执行 `npm install`、未新增/改动任何依赖、未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码与探针结果文件
    (index.html 仅改背景色与标题,属 workspace 可编辑模板文件)。
11. 未探测或篡改 harness/validator 行为与期望值(`__bench.debug.grab` 仅为本 Arm 画面自采样工具)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs/verify-browser.mjs 计数。

## 4. 禁止捷径自查(brief §10)

- [x] 无预渲染视频/序列帧/GIF/外部大图(全部程序化几何,assets/ 未使用,符合 Asset Contract 空数组)
- [x] 无 DOM/CSS 2D 伪 3D(场景主体为 WebGL 3D 几何;DOM 仅为合同要求的控制按钮)
- [x] 窗阵为矩阵排布的独立发光 quad,非无结构大面积色块
- [x] fps 来自真实帧间隔滚动平均(60 帧窗口),随负载波动
- [x] getState 与画面一致(楼/车/雨计数即实际提交渲染数量;雾开关即引擎雾真实启停)
- [x] 无探针期间临时提升规模(规模为编译期常量,恒定满规模)
- [x] reset 为确定性状态恢复,非页面刷新
