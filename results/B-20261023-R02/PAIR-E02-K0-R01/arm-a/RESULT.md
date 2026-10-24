# RESULT — Arm A / PAIR-E02-K0-R01 (engine: three 0.186.1 / K0)

实现位置:`arm-a/workspace/`(源码 `src/main.js`,构建产物 `dist/`,资产副本 `assets/boat.glb`)。
自检证据截图:`arm-a/verify-shots/`;交互自检脚本:`arm-a/selftest-eval.js`;过程:`arm-a/WORKLOG.md`。

## 1. 实现摘要(逐 probe)

- **P1(加载与非空白)**:`GLTFLoader` 在运行时对相对路径 `assets/boat.glb` 发起真实网络请求(构建不转译不内联,dev server 日志 200,`assetRequests=1`),加载完成后归一化缩放并实例化;首帧渲染 + 资产就绪后置 `__appReady=true`。画面同时呈现渐变天穹、程序化海面与多部件船体(截图 p1-warm.png:海平线约 31% 高度、太阳在中轴偏侧、水面镜面高光带、船体受光/背光对比)。
- **P2(海面波动)**:海面为 4 组深水重力波色散关系驱动的行进波(波峰沿风向推进,非静止起伏/贴图滚动),`wavePhase = simTime` 单调递增,1.5s 采样窗 0.39→1.89;下 60% 画面持续存在运动像素(顶点位移逐帧变化)。
- **P3(船体随波起伏)**:船体竖直坐标直接采样与顶点着色器**完全同参**的海面高度函数(单一事实源 `WAVES` 数组,JS 与 GLSL 常数由同一数组生成)——相位耦合;纵摇/横摇由同函数在船首尾/两舷的采样差驱动并平滑。900ms 窗内 y 由 -0.012 变至 0.177(4s 极差 ≈0.19 ≥ 0.02),中心 40% 区域存在运动像素。
- **P4(拖拽环绕)**:水平拖拽改写方位角目标,相机以恒速 slew(125°/s)逐帧平滑追随(无跳变、拖后仍持续平滑运动);合成拖拽 (0.50,0.50)→(0.78,0.50) 后 500→700ms 窗口方位角变化 27.1°(>20),全画面构图随透视正确变化。俯角可随拖拽微调(6°–38° 夹紧)。
- **P5(色调切换)**:点击 `tone-toggle` 后 toneMix 以指数趋近(速率 2.5/s)在 2.5s 内达 0.9982(>0.7);天空渐变/太阳↔月亮光盘/海面基色与高光/方向光与半球光**同一 toneMix 同时演变**;全画面平均色由暖端 (R101,G41,B27) 转为冷端 (R6,G17,B52),平均分量偏移 47.9/255(≥8)。
- **P6(reset 释放重建)**:reset 显式 dispose 船与海的几何/材质(GPU 侧释放),重建海面并**重新发起** `assets/boat.glb` 网络请求,恢复 toneMix=0、方位角=35°、俯角与模拟时间归零,epoch+1;3s 内完成、无整页刷新;自检 epoch=1、assetLoaded=true、toneMix=0、cameraAzimuth=35、画面正常、控制台无错误。
- **P7(连续 reset 稳定)**:第二次 reset 同样完成释放与重建(重入保护:进行中重复点击排队串行);自检 epoch=2、assetRequests=3(≥2)、toneMix=0、画面正常、无新增控制台错误。

补充:fps 滚动 2s 平均全程 ≈58–60(≥30);海面几何 171×171 = 29241 顶点(≥2000);资产失败路径给出可见错误横幅且不产生未捕获异常;后台标签页由 dt 上限(0.05s)兜底,恢复前台后继续正确推进。

## 2. 自检清单(§5 完成合同)

- [x] 1. `npm run build` 在 workspace/ 根执行退出码 0(build #1、#2 均成功,产物 dist/ 被 index.html 引用,app.js 16.7KB 引擎 external)
- [x] 2. 页面 10s 内 `window.__appReady === true`(浏览器验证中均在 ~2s 内就绪,含 boat.glb 加载)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(verify-browser benchReady=true)
- [x] 4. 无未捕获异常(4 次浏览器会话 consoleErrors=0、uncaught=[];含交互与两次 reset 全程)
- [x] 5. 探针自检:spec.json P1–P7 逐条状态断言 + 独立观测证据(像素均色采样/运动状态采样/网络请求日志/截图)全部通过,详见上节与 WORKLOG

预算用量:build 2/8、browser 4/6(`workspace/.budget/*.count` 机器计数)。

## 3. 合规声明(§4 红线逐条)

本人声明本次 Run 未发生以下任何行为:

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、服务器、profile、截图或结果。
2. 未访问 `reference/`。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录或既往 trial 结果。
4. 未访问 `harness/` 源码与本合同模板。
5. 未访问 `bench/vendor/` 引擎资产目录及两个引擎上游源码仓库(three.js 仅经工作区共享 node_modules 与模板 dist/vendor 运行时解析使用,未读其 docs/examples 源文件)。
6. 未访问 `bench/docs/`。
7. 未访问 `secret/`。
8. 无任何联网行为(全部资源为本地文件/本地 dev server)。
9. 未执行 `npm install`,未改动共享仓内容。
10. 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针代码与探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build`、所有浏览器会话经 `scripts/verify-browser.mjs`。

知识面说明:本 Arm 为 K0,仅使用 `knowledge/`(three@0.186.1 包 README)提供的知识与模板自带骨架(index.html/build 脚本/smoke 示例),未引入任何外部文档。
