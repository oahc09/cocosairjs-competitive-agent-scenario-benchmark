# RESULT — PAIR-E02-K0-R01 / arm-a(three, K0)

Run 模式:R0 自主交付。场景:E02 落日海面与孤舟(Asset Driven)。实现位于 `workspace/src/main.js`(esbuild 构建为 `dist/app.js`,引擎经 import map 外部解析)。

## 1. 实现摘要(逐探针)

- **P1(资产加载 + 非空白)**:GLTFLoader 运行时对 `assets/boat.glb` 发起真实 fetch(serve 日志与 harness 网络观测均为 200,sha256 与 spec 冻结值一致),加载完成后 `assetLoaded=true`、`assetRequests=1`,首帧渲染后置 `__appReady=true`;画面为暖金落日天穹 + 镜面高光带海面 + 多部件孤舟,自检 litRatio=0.999(阈值 0.05)。
- **P2(海面持续波动)**:海面为 257×257(66,049 顶点 ≥ 2000)ShaderMaterial 重力波曲面,4 层方向正弦波相位随 `simTime` 推进、波峰沿风向行进、细节波随距离衰减(近密远疏);自检 1.5s 采样窗内 `wavePhase` 2.295→4.045,下 60% 区域运动像素比 0.131(阈值 0.01)。
- **P3(船体随波起伏)**:船体每帧采样与海面顶点位移**同一组波形常量/同一波形函数**(JS 与 GLSL 单一参数源生成),竖直坐标周期变化并伴纵摇/横摇;自检 900ms 窗内 boatPosition.y 变化 0.178(4s 极差远超 0.02),中心 40% 区域运动像素比 0.246(阈值 0.002)。
- **P4(水平拖拽环绕)**:拖拽经临界阻尼弹簧逐帧插值驱动相机绕舟环绕(灵敏度 0.5°/px,松手带惯性外推),方位角无跳变;自检拖拽 (0.50,0.50)→(0.78,0.50) 后方位角 35→240.9(严格采样窗内 Δ=47.0、全程 Δ=205.9,均 >20°),全画面像素差 0.450(阈值 0.02),太阳/海平线与船体相对位置透视一致变化。
- **P5(色调切换)**:`data-ui="tone-toggle"`(aria-label 同名、可见文本含 "Tone")控件驱动 toneMix 目标 0↔1 指数过渡(τ≈0.6s,<2.5s),天空渐变/日月光盘、海面配色、主光与半球光、船体受光同步演变;自检 2.5s 后 toneMix=0.9822(阈值 >0.7),全画面平均 RGB 色偏 62.2/255(阈值 ≥8)。
- **P6(Reset 释放并重建)**:`data-ui="reset"` 触发进程内释放(遍历 dispose 船体几何/材质/纹理、海面与天穹 geometry/material,GPU 侧资源显式释放)并重建:重载 boat.glb、toneMix/方位角/模拟时间归零、epoch+1,无页面导航;自检 3s 内 epoch=1、assetLoaded=true、toneMix=0、cameraAzimuth=35、lit=0.999、URL 未变、未捕获异常 0。
- **P7(连续第二次 Reset 稳定)**:第二次 reset 后 assetRequests=3(会话内初始+两次重建各 +1)、epoch=2、画面正常恢复(lit=0.999),JS 堆 16MB→16MB 无持续增长征象,console 干净。
- **附加自检**:色调可任意时刻反向往返切换(0.9822→0.0175);UI 控件可见文本与 aria-label 均可定位且可见;稳态 fps=60(2s 滚动平均,≥30);资产加载失败路径有可见 role=alert 错误提示且不产生未捕获异常。

关键实现文件:`workspace/src/main.js`(场景/波形/着色器/交互/生命周期)、`workspace/index.html`(页面契约)、`workspace/assets/boat.glb` 与 `workspace/dist/assets/boat.glb`(运行时网络加载的资产副本,sha256=ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397)、`workspace/scripts/selfcheck.mjs`(探针自检工具,含内置 PNG 解码像素断言)。

## 2. 自检清单(RUN-CONTRACT §5,逐条)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run build` 在 workspace/ 根执行,退出码 0 | [x] 满足 | build #1、#2 均退出码 0(`.budget/build.count` 机器计数 2 次;产物自检 dist/app.js、dist/vendor/*、dist/index.html 全通过;app.js 15.7KB,引擎未打入 bundle) |
| 2 | 页面 10s 内 `window.__appReady === true` | [x] 满足 | verify-browser 正式验证 appReady=true(实测 ~0.6s);含资产真实网络加载 |
| 3 | `window.__bench = { getState(): object, reset(): void }` 契约成立 | [x] 满足 | verify-browser benchReady=true;getState 返回 assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch 全字段 |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | [x] 满足 | 三次浏览器会话 consoleErrors=0、uncaught=0(加载、拖拽、色调切换、两次 reset 全程) |
| 5 | 按 spec.json probes 逐条自查(状态断言 + 视觉断言)全部通过 | [x] 满足 | selfcheck 13/13 PASS(P1–P7 全部状态+像素双断言,另含往返色调/UI/fps/console/network;截图与数据见 `workspace/selfcheck/`) |

## 3. 合规声明(RUN-CONTRACT §4,逐条)

1. 未访问另一 Arm 的一切(目录、代码、日志、dev server、浏览器 profile、截图、结果)—— 声明属实。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)—— 声明属实。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录,未访问一切既往 trial 结果 —— 声明属实。
4. 未访问 `harness/` 源码与本合同模板 —— 声明属实。
5. 未访问引擎源码仓库 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树 —— 声明属实(仅使用共享 node_modules 内的 three@0.186.1 发布包与本 Arm knowledge/)。
6. 未访问实验计划书与 `bench/docs/` —— 声明属实。
7. 未访问 `secret/` —— 声明属实。
8. 未发起任何联网请求(无文档/搜索/包 registry 访问;页面内仅有对本 Arm dev server 的本地请求)—— 声明属实。
9. 未执行 `npm install`,未安装/改动任何依赖,未改动共享 node_modules 内容 —— 声明属实。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件 —— 声明属实(仅改写 workspace/ 内自有实现与模板 index.html 标题;build.mjs/serve.mjs/verify-browser.mjs/count.mjs 未改动)。
11. 未探测或篡改 harness/validator 的行为与期望值 —— 声明属实。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs / verify-browser.mjs 计数构建或创建浏览器会话 —— 声明属实(4 次浏览器会话前均经自动/手动 `count.mjs browser` 计数;读侧只读查看计数内容用于 WORKLOG 对时,未写入)。

预算:build 2/8、browser 4/6、toolCall 与墙钟由 Runner 侧系统记录,均未触限。
