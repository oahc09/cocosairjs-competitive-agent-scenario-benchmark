# RESULT — PAIR-E07-K0-R01 / arm-a(three,K0)

## 1. 实现摘要(逐 probe 一句话)

实现方式总述:`workspace/src/main.js` 单文件 three.js r186 场景。楼群 = 单个 `InstancedMesh`(238 栋,种子化街区网格,高度 9–82、footprint 6.5–12 变化);窗阵 = 单个 `THREE.Points`(四立面矩阵窗格、暖/冷色随机点亮,总点数约 2.5 万);车流 = 单个 `THREE.Points`(4 条街道、84 辆、双向车道、头灯暖白/尾灯红、4 点渐暗拖尾);雨 = 单个 `THREE.LineSegments`(2200 条细线粒子循环下落,落地回顶部);雾 = `THREE.Fog`(45/205,开关以 near/far 大幅改写实现、无重编译立即生效);霓虹 = 4 块 CanvasTexture 文字招牌(品红/青/橙黄/绿)+ 3 座高塔四角呼吸灯带 + 楼顶航空闪灯;`reset()` = 种子化 RNG 内存内全量重建(布局/计数/相位完全复现,非页面刷新);`fps` = 最近 60 帧真实帧间隔滚动平均。

| Probe | 满足方式与自检证据(浏览器会话 #5,final-v3.png) |
|---|---|
| P1 | 启动即自动建城,`getState()` 返回 buildingCount=238(≥200)/carCount=84(≥60)/rainParticleCount=2200(≥1500)/fogEnabled=true;全屏非空(内容覆盖率远超 35%),低角度天际线轮廓可辨 |
| P2 | 84 较车沿 2 条横穿主干道 + 2 条网格街道持续移动,街道层(下 38%)600ms 像素变化率 6.59% |
| P3 | 2200 雨线粒子全屏循环下落,相隔 100ms 两帧全屏像素变化率 3.07%(≥2%),计数稳定 |
| P4 | 运行 8s 后 `fps=60`(≥30,真实 60 帧滚动测量),画面持续运动(车/雨/霓虹呼吸) |
| P5 | 点击 `data-bench="toggle-fog"` 后 `fogEnabled=false`,上部天际线区域像素变化 4.10%(远处雾墙消失、楼群变暗、窗点变亮) |
| P6 | 再次点击后 `fogEnabled=true`,上部区域变化 4.15%(雾衰减恢复) |
| P7 | 点击 `data-bench="reset"` 后内存内全量重建,238/84/2200/fogEnabled=true 全部恢复初始,画面完整(种子化 RNG 保证与初始逐字节同布局) |
| P8 | reset 后车流/雨动画继续,fps=60,无未捕获异常 |

规模与红线对照:楼 238(建议 220–260 ✓)/ 车 84(建议 64–96 ✓)/ 雨 2200(建议 1800–2500 ✓)/ 窗点约 2.5 万(≥2000 ✓,矩阵窗格结构可辨,非色块);楼/窗/车/雨均为单对象批量绘制(全场景 draw call ≈ 30);无预渲染素材、无 DOM 伪 3D、fps 真实测量、getState 与画面联动、reset 非刷新。

## 2. 自检清单(RUN-CONTRACT §5,逐条)

1. [x] `npm run build` 于 `workspace/` 根执行,退出码 0(真实构建 3 次,最终产物含全部改进;.budget/build.count 4 行,其中 1 行为误触发的纯计数,已在 WORKLOG 披露)
2. [x] 页面 10s 内 `window.__appReady === true`(verify-browser 实测 appReady=true,首帧渲染即置位)
3. [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回纯 JSON 五字段:buildingCount/carCount/rainParticleCount/fogEnabled/fps)
4. [x] 无未捕获异常(三次自检会话 consoleErrors=0、uncaught=[])
5. [x] 探针自检:P1–P8 状态断言与视觉断言逐条自查全部通过(自检 eval 含像素级区域变化测量,数值见 WORKLOG 与上文;证据截图 `workspace/selfcheck-shots/{final,final-v2,final-v3,fog-off}.png`)

## 3. 合规声明(逐条对照 RUN-CONTRACT §4)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录或既往 trial 结果(仅在自身 `results/B-20261005-R04/PAIR-E07-K0-R01/arm-a/` 内工作)。
4. 未读取 `harness/` 源码或本合同模板源(仅使用预置于 workspace 的脚本执行构建/服务/验证)。
5. 未访问引擎资产:未读取 `bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树;K0 隔离下仅使用模板、npm 安装后的 `node_modules/three` 运行时与本 Arm `knowledge/` README。
6. 未读取实验计划书与 `bench/docs/` 合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档/搜索/包 registry 访问;页面自身仅加载本地 dist 与本地引擎)。
9. 未执行 `npm install` 或以任何方式安装/改动依赖(仅使用上层共享 node_modules)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(自检 eval 仅读取自家画布像素与自家 `__bench` 状态)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件,未绕过 `count.mjs`/`verify-browser.mjs` 计数;一次多余的 `count.mjs build` 调用造成多计 1 行(多计而非少计,不规避判定),已在 WORKLOG 如实披露。

## 4. 预算与产物

- build:4/8 次机器计数(真实构建 3 次,全部退出码 0)
- browser:5/6 次机器计数(全部经 verify-browser.mjs,无绕过)
- 工具调用:约 27/120;墙钟:约 25/90 分钟
- 证据:`workspace/selfcheck-shots/`(4 张截图)、WORKLOG.md(全程时序)、本文件
