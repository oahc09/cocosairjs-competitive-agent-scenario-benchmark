# RESULT — Arm A(PAIR-E09-K0-R01,three r186 / K0)

## 1. 实现摘要(逐 probe)

实现路径:程序化凸包宝石(`ConvexGeometry`,49 控制点 → 94 三角面 ≈ 60+ 视觉切面)+ `MeshPhysicalMaterial` 真折射管线(`transmission:1 / ior:1.70 / dispersion:2.4 / thickness:1.3`,r167+ 折射+色散着色路径,火彩随视角/转台实时流动,非烘焙贴图)+ 程序化 PMREM 摄影棚 HDR 环境(渐变穹顶 + 发光柔光箱面板,驱动切面锐利镜面高光)+ 三盏有向光(key/fill/rim)+ 背幕背光面板与两条锐利光带(为折射提供可见参照结构,透过宝石可见光带弯折/错位)+ Reflector 镜面地板(暗色压低=轻反射)+ 转盘焦散光斑 + 接触阴影。全部资源程序化生成,零网络依赖,未使用 assets/gem.glb(brief 允许程序化替代)。

| Probe | 满足方式 | 自检结果 |
|---|---|---|
| P1 | 启动即完整场景:默认 diamond / cameraDistance=10 / exportCount=0 / rotationAngle≥0;宝石居中,宝石区 nonBlank 覆盖率 0.578(阈值 0.08) | PASS |
| P2 | 转台 36°/s(`rotationAngle` 按时钟增量累计,单调不折返);~3.5s 时 113.9°(≥50),实测 37.8°/s(≥25);宝石区帧间差 9.81(高光/火彩流动) | PASS |
| P3 | `data-ui`/`data-bench="swatch-2"` 点击 → `selectedColor="ruby"`,材质 color/attenuationColor/attenuationDistance 立即切换,画面帧间差 12.6(色调可见变化) | PASS |
| P4 | 画布 `dblclick` → 相机沿视线真实位移推近(850ms easeInOutCubic),4.6 ≤ 6;宽区帧间差 20.4(宝石显著变大) | PASS |
| P5 | 再次双击拉回 10 ≥ 9,同缓动无跳变 | PASS |
| P6 | `data-ui="export-png"` → 同步重绘当前帧 + `canvas.toBlob('image/png')` + `a[download]` 真实浏览器下载;exportCount=1,实测 PNG 677,681 字节 > 10,240,分辨率=画布 1280×720 | PASS |
| P7 | 连续二次导出:exportCount=2,677,497 字节,文件名带时间戳+序号无同名冲突;导出后画布 nonBlank 覆盖率 0.580(渲染正常) | PASS |
| P8 | `reset`:色彩回 diamond、相机缓动回 10、exportCount 清零;不刷新页面,转台相位连续(帧间差 8.93 仍在自转) | PASS |

状态契约:`getState()` 返回且仅返回 `rotationAngle / selectedColor / cameraDistance / exportCount` 四字段,`reset()` 无页面刷新。UI 控件同时携带 `data-ui` 与 `data-bench` 两组属性。

## 2. 自检清单(RUN-CONTRACT §5)

1. [x] `npm run build` 在 workspace 根执行,退出码 0(共 6 次构建,全部成功)
2. [x] 页面 10s 内 `window.__appReady === true`(每次会话实测 ready=true,首帧即置位)
3. [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(verify-browser benchReady=true)
4. [x] 无未捕获异常(全部 6 次会话 consoleErrors=0、uncaught=[])
5. [x] 探针自检:按 spec.json probes P1-P8 逐条自查(状态断言 + 视觉断言),全部通过(`selfcheck.mjs` 两轮全量复检,第 6 会话为最终版 8/8 pass + rotationMonotonic=true)

证据媒体:`workspace/shots/self-01..06*.png`(6 次会话截图,最终版 self-06-final.png)。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果 —— 声明属实。
2. 未访问 `reference/` 下任何内容 —— 声明属实。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;未访问任何既往 trial 结果 —— 声明属实。
4. 未读取 `harness/` 源码与合同模板(探针词表仅依据 RUN-CONTRACT/spec.json/template 注释中的公开约定)—— 声明属实。
5. 未访问 `bench/vendor/` 引擎资产目录及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经共享 node_modules 中已安装的 three 包使用(knowledge/manifest.json 明确允许读安装后的包内容)—— 声明属实。
6. 未访问实验计划书与 `bench/docs/` 合同文档目录 —— 声明属实。
7. 未访问 `secret/` —— 声明属实。
8. 未发起任何网络请求(无文档/搜索/包 registry 访问;场景零外部资源,纹理全部程序化)—— 声明属实。
9. 未执行 `npm install`,未安装/改动任何依赖,未改动共享 node_modules —— 声明属实。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件 —— 声明属实。
11. 未探测或篡改 harness/validator 的行为与期望值 —— 声明属实。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件;全部构建经 `npm run build`(内置 count.mjs)、全部浏览器会话经 `scripts/verify-browser.mjs`(自动计数),无任何绕行 —— 声明属实。

预算终态:build 6/8,browser 6/6(触及上限后未再开会话),toolCall / 墙钟均在 120 次 / 90 分钟内。
