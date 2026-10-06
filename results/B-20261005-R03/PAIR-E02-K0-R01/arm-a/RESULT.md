# RESULT — PAIR-E02-K0-R01 / arm-a (three r186, K0)

## 1. 实现摘要(逐 probe)

实现入口:`workspace/src/main.js`(esbuild → `dist/app.js`,three 经 import map 外部解析)。海面为 220×140 段幂次曲线网格(31,155 顶点 ≥ 2000),4 组正弦重力波在顶点着色器中位移、解析法线着色;波形参数表为 CPU/GPU 单一事实源,船体每帧采样同一函数实现同相起伏。天空为渐变天穹 + 太阳/月亮光盘与双层光晕;暖/冷两套调色板按 toneMix 逐项插值到天空、海面、方向光与半球光。船体经 GLTFLoader 对 `assets/boat.glb` 发起真实网络请求(dev server 日志 200/29132 bytes),保留资产内嵌 PBR 材质。UI 控件带 `data-ui="tone-toggle"` / `data-ui="reset"`(兼 aria-label 同名)。

| Probe | 状态断言 | 视觉断言 | 满足方式一句话 |
|---|---|---|---|
| P1 | assetLoaded=true, assetRequests=1 | 全帧 lit 比 1.0(≥0.05) | 资产加载完成后才置 `__appReady`;画面同时呈现渐变天穹、波浪海面与船体;server 记录 GET /assets/boat.glb 200 |
| P2 | wavePhase 2.267→3.800(1.5s) | 下 60% 运动像素比 0.835(≥0.01) | uTime 持续推进驱动顶点位移与解析法线,波峰沿风向行进、镜面高光带实时闪烁 |
| P3 | boatPosition.y 0.604→0.558(0.9s) | 中 40% 运动像素比 0.508(≥0.002) | 船体 y = baseY + 0.85·waveHeight(0,0,t) 与海面同相,并伴纵摇/横摇;4s 极差远超 0.02 |
| P4 | 拖拽后方位角 Δ=30.8°(>20) | 全帧像素差比 0.877(≥0.02) | pointer 拖拽改变目标方位角(0.75°/px,指数平滑无跳变),太阳/海平线与船体相对构图随视角正确变化 |
| P5 | 点击 tone-toggle 后 toneMix=1(>0.7,2.5s 内) | 平均色偏 78.2/255(≥8) | 暖(落日:天穹/海面/光照橙金,均值 R≫B)↔ 冷(暮蓝月光,均值 B≫R)1.5s smoothstep 过渡,天空海面光照船体同步演变 |
| P6 | epoch=1, assetLoaded=true, toneMix=0(<0.05), 方位角=35(32–38) | 全帧 lit 比 1.0 | reset 显式 dispose 船体与海面 GPU 资源后重建并重新网络加载(非刷新),色调/方位角/模拟时间瞬时恢复初始 |
| P7 | epoch=2, assetLoaded=true, assetRequests=3(≥2), toneMix=0 | 全帧 lit 比 1.0 | 连续第二次 reset 稳定完成,assetRequests 递增,console 0 错误、fps 保持 60、无泄漏征象(逐对象 geometry/material/texture dispose) |

## 2. 自检清单(RUN-CONTRACT §5)

1. `npm run build` 退出码 0 —— ✅(2 次构建均成功,机器计数 build.count=2/8)
2. 页面 10s 内 `window.__appReady === true` —— ✅(verify-browser 三次会话均 appReady=true,含资产加载)
3. `window.__bench = { getState(): object, reset(): void }` —— ✅(benchReady=true;getState 返回 spec 全部 8 个字段)
4. 无未捕获异常 —— ✅(4 个浏览器会话 consoleErrors=0、uncaught=[])
5. 探针自检全部通过 —— ✅(会话 #3 按 spec probes 逐条状态断言 + 像素/运动断言,见上表;会话 #4 佐证冷端视觉;证据:warm3.png / cool.png / server 日志 / selfcheck.eval.js 可复现)

预算:build 2/8 · browser 4/6 · tool ≈38/120 · 墙钟 ≈20/90 min。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、profile、截图或结果。✅
2. 未访问 `reference/` 及其任何内容。✅
3. 未读取 `bench/results/` 下本 Pair 本 Arm 之外的任何目录或既往 trial 结果。✅
4. 未读取 `harness/` 源码或本合同模板。✅
5. 未访问 `bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树;引擎仅经工作区共享 node_modules 的构建产物使用。✅
6. 未读取实验计划书与 `bench/docs/`。✅
7. 未访问 `secret/`。✅
8. 未发起任何网络请求(无文档/搜索/registry;所有页面资源为本地 dev server 提供)。✅
9. 未执行 `npm install`,未改动共享 node_modules。✅
10. 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness·validator·探针代码或探针结果文件(workspace 内仅新增/修改 src/main.js 与自有脚本、快照)。✅
11. 未探测或篡改 harness/validator 行为与期望值。✅
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs / verify-browser.mjs(构建 2 次、浏览器会话 4 次均经机器计数)。✅

备注:共享资产 `arm-a/assets/` 只读未动;boat.glb 以 `cp` 复制进 `workspace/assets/` 供 dev server 以 `/assets/boat.glb` 提供真实网络响应(sha256 与 spec.json 一致:ed22ff2f…),构建产物未内联/转译该文件。
