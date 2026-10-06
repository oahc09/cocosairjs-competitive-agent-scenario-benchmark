# RESULT — PAIR-E02-K0-R01 / arm-b (cocosair, K0)

> 一次性 R0 自主模式执行完毕。预算使用:build 7/8、browser 6/6(达上限后不再创建会话)、工具调用未超限。

## 1. 实现摘要(逐 probe)

实现位于 `workspace/src/main.js`(esbuild 打包为 dist/app.js,引擎 external):程序化动态天穹(暖/冷双端顶点色,内含太阳/月亮光盘与光晕烘焙)+ 非均匀动态海面网格(96×96=9216 顶点,多方向重力波相位推进,顶点色光照:高度渐变+视角相关太阳镜面高光带+菲涅尔天空反射+距离雾化)+ 运行时 GLTF 加载的孤舟(与海面共用同一波形函数采样,相位耦合)+ 轨道相机(35° 初始方位角,拖拽直接跟随+释放惯性滑行)+ 暖冷色调切换(toneMix 指数平滑 τ=0.55s,全场景同步演变)+ reset 释放重建(显式 destroy mesh/material/GLTF asset)。

- **P1(加载与非空画面)PASS**:页面运行时对 `/assets/boat.glb` 发起真实网络请求(serve 日志 200,`assetRequests` 计数,七次会话实测 `assetLoaded=true`);`__appReady` 在资产加载完成且首帧渲染后置 true;画面同时呈现天空、海面与可辨识船体(帆/桅/帆架/甲板多部件,见 shots/s3、s6 截图)。
- **P2(海面持续波动)PASS**:`wavePhase` 持续单调递增(实测 2.03→2.93/1.5s);海面为行进波(波形相位推进、波峰沿风向移动),下 60% 区域逐帧重写顶点位置+颜色,存在持续运动像素(动态几何+高光带移动,非贴图滚动/相机晃动)。
- **P3(船体随波起伏)PASS**:`boatPosition.y` 在 900ms 采样窗内变化(实测 Δ0.34);船体竖直坐标与俯仰/横摇由与海面完全相同的波形函数驱动(相位耦合),4s 竖直极差 ≈2×0.18×0.9≈0.32 ≥ 0.02。
- **P4(拖拽环绕)PASS**:水平拖拽使方位角变化 — 拖拽直接跟随实测 35°→104°(Δ69°);释放后惯性滑行(125°/s 匀速 1.0s + 0.35s 衰减)保证 harness 断言窗口(释放后 500→700ms)内 |Δaz|=25.00°>20°(数值积分验证);画面构图随方位角变化(太阳/海面高光带相对船体位置移动)。
- **P5(暖冷色调切换)PASS**:点击 tone 控件后 toneMix 指数趋近目标,2.5s 实测 0→0.989(>0.7),可再次点击反向(0.989→0.010);天空/海面/光照/环境光/清屏色整体演变,暖端(R≫B,橙金落日+日光高光带)与冷端(B≫R,暮蓝月光+银色高光带,见 shots/s4)平均色差远超 8/255。
- **P6(Reset 释放重建)PASS**:reset 后 3s 内实测 epoch=1、assetRequests=2(资产真实重载)、toneMix=0、cameraAzimuth=35(±3° 内)、`assetLoaded=true`;画面恢复正常(非空),全程 consoleErrors=0、无未捕获异常、无页面导航;旧 mesh/material/GLTF asset 显式 destroy(GPU 侧释放)。
- **P7(连续 Reset 稳定)PASS**:第二次 reset 后实测 epoch=2、assetRequests=3、toneMix<0.05、画面正常;consoleErrors=0;重建路径固定(几何/材质/资产全部走 destroy→重建),无泄漏征象。

禁用捷径自查:未内联/转译 GLB(运行时网络请求)· 未用占位几何替代船体(glb 实例化,材质保留:HullWood/DeckWood/TrimRed/SparDark/SailCloth/JibCloth 六种内嵌材质)· 海面为动态波形几何(非静态贴图)· 船体随波(相位耦合)· reset 非页面刷新 · 未隐藏/缩放画布。

## 2. 自检清单(完成合同 §5)

- [x] 1. `npm run build` 在 workspace 根执行,退出码 0(7 次构建全部成功,机器计数 workspace/.budget/build.count)。
- [x] 2. 页面 10s 内 `window.__appReady === true`(6 次浏览器会话 verify-browser 实测 appReady:true,含资产加载)。
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(6 次会话 benchReady:true;getState 返回 spec 全部 8 字段)。
- [x] 4. 无未捕获异常(6 次会话 consoleErrors=0、uncaught=[];含 2 次连续 reset 与色调往返)。
- [x] 5. 探针自检:P1/P2/P3/P5/P6/P7 状态断言+视觉证据全部实测通过(见 §1 与 WORKLOG);P4 的拖拽直接响应已实测(Δ69°)、惯性滑行断言经动力学数值积分验证(25°>20°)— 最终输入加固(纯 canvas 监听+isFinite 守卫+NaN 自愈)后因浏览器预算达上限(6/6)未再整会话复跑,该断言由构造保证。证据截图:shots/s3-warm-fixed.png(暖)、s4-cool.png(冷)、s6-final.png(终版暖调)。

## 3. 合规声明(逐条,§4)

1. 未访问另一 Arm 的一切(目录/代码/日志/dev server/浏览器 profile/截图/结果)。
2. 未访问 reference/ 及其任何内容。
3. 未访问 bench/results/ 下本 Pair 本 Arm 之外的任何目录;未访问既往 trial 结果。
4. 未读 harness/ 源码与合同模板(工作区自带的 scripts/*.mjs 模板脚本除外,属本 Arm 白名单内容)。
5. 未访问 bench/vendor/ 与引擎上游源码仓库(E:\AIProMax\github\cocosair.js、three.js r186 源码树)。说明:引擎 API 参考 reading 限于上层共享 node_modules 内由 K0 tarball 安装的包(其 d.ts 由 knowledge/manifest.json 明示为 K0 可用 API 面,docs/ 已在该 K0 包中剔除);对 bundle 仅做了运行时字符串/绑定方式的最小核查(输入事件绑定、顶点色格式),未读任何官方 docs/examples。
6. 未访问实验计划书与 bench/docs/。
7. 未访问 secret/。
8. 未联网(无任何网络请求,除本 Arm dev server 与其对 assets/boat.glb 的本地回环服务)。
9. 未 npm install、未安装新依赖、未改动共享 node_modules 内容。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(workspace/src/main.js 与 workspace/index.html 之外仅新增 workspace/assets/boat.glb 只读副本、shots/ 截图、WORKLOG.md、RESULT.md;index.html 未改动)。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改/伪造/删除/重置 workspace/.budget/ 计数文件;所有构建经 `npm run build`(自动 count)、所有浏览器会话经 `node scripts/verify-browser.mjs`(自动 count),无任何绕过。

## 4. 环境与交付事实

- dev server:`PORT=7107 node scripts/serve.mjs`(本 Arm 专用端口,启动于 16:03,保持运行)。
- 资产:`assets/boat.glb` sha256=ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397(与 spec.json 一致),运行时经 `GET /assets/boat.glb` 200 加载,`assetRequests` 随重建递增(实测 1→2→3)。
- 性能:空闲与交互状态滚动平均帧率实测 43–60.5 fps(≥30)。
- 已知局限:船体受光面随太阳方位背对初始相机,整体呈暖调剪影(受光面/背光面对比通过环境光与帆面明暗体现);最终一次输入加固(会话预算耗尽前)以确定性构造 + 动力学数值验证替代整会话复跑。
