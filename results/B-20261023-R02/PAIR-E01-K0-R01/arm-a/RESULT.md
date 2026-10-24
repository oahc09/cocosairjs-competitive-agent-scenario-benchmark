# RESULT — Arm A (three / K0) · PAIR-E01-K0-R01 · E01 深空星系巡航

## 1. 实现摘要(逐 probe)

- **P1(starCount ≥ 50000 + 亮像素 ≥2%)**:两个 `THREE.Points` 对象共 58,000 星点(星系 55,000 = 核球 8,000 + 双对数螺旋臂 2×16,000 + 盘面散布 15,000;远景背景星 3,000),`starCount` 状态即真实提交渲染总数;加色混合辉光实测亮像素占比 7.08%。
- **P2(旋转相位增量 >0.001 rad + 运动像素)**:盘面绕 +Y 法线以 0.06 rad/s(spec 允许 0.02–0.1)时钟增量步进,`rotationPhase` 单调递增,2s 实测增量 0.121 rad;星点切向流动产生全画面 15.6% 运动像素(中央 80% 区域要求 0.5%)。
- **P3(指针视差)**:`pointermove`/`mousemove` 归一化为偏离画面中心的有符号偏移(±1),一阶指数平滑无过冲,相机沿视口右/上轴平移(近景位移大于远景 = 真视差);实测偏移 0.233→0.331、像素差 15.0%(阈值 0.3%),幅值约 5% 画幅(<10% 上限)。
- **P4(滚轮穿行)**:滚轮 exp 响应修改目标距离(δ<0 靠近),帧间指数平滑不瞬跳,范围 [40,400];δY=-600 实测 500ms→800ms 窗口内距离 75.34→66.40(Δ=-8.94 < -5)、像素差 29.5%(阈值 1%)。
- **P5(HUD 可见且数值一致)**:左上角 HUD(不遮挡星系)实时显示星点总数 58000、2s 滚动平均帧率(取整)、相机距离(1 位小数),全部来自真实运行数据,实测文本与 `__bench` 状态一致。
- **P6(fps ≥30)**:58k 星点仅 2 个 draw call(每对象一次批量提交),实测滚动平均 fps ≈ 59.99。
- **P7(reset)**:HUD 内 Reset 按钮(可见文本 + `aria-label="reset"` + `data-ui="reset"`)调用 `reset()`:距离瞬时恢复 120、视差与相位归零、epoch+1、不整页刷新;800ms 后实测 epoch=1、距离 120、视差 {0,0}、相位 0.049(<0.1)、画面仍非空(亮像素 7.13%)、无导航发生;连续多次 reset 行为一致。

## 2. 自检清单(RUN-CONTRACT §5)

1. [x] `npm run build` 在 workspace/ 根执行退出码 0(build #1/#2 均通过,产物自检 OK,`index.html` 引用 `/dist/app.js`)
2. [x] 页面 10s 内 `window.__appReady === true`(两次浏览器验证均 true)
3. [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 starCount/rotationPhase/cameraDistance/parallaxOffset/fps/hudVisible/epoch 全字段)
4. [x] 无未捕获异常(两次会话 consoleErrors=0、uncaught=[])
5. [x] 探针自检:P1–P7 逐条状态断言 + 页内 readPixels 像素证据全过(数值见 WORKLOG 2026-10-23T15:53:55Z 行),另有截图视觉证据(shots/check1.png:双旋臂、核球、径向色梯度、斜俯视构图)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、server、profile、截图或结果。
2. 未访问 `reference/`。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录与任何既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板。
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、`E:\AIProMax\Y2026M09\cocosairjs-vs-threejs\three.js-r186`)。
6. 未访问 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(唯一网络操作为本地 dev server 127.0.0.1:7204 与 verify-browser 本地会话)。
9. 未执行 `npm install`,未安装/改动任何依赖(构建走共享 node_modules,引擎保持 external 由 import map 指向本地 vendored 副本)。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(仅创建/修改:workspace/src/main.js、WORKLOG.md、RESULT.md、shots/ 截图)。
11. 未探测或篡改 harness/validator 行为与期望值(自检均在页面自身状态与画布 readPixels 上进行,未触碰 harness)。
12. 未手改/伪造/删除/重置 `.budget/*.count`,未绕过 `count.mjs`/`verify-browser.mjs` 计数(构建 2 次均经 `npm run build` 自动计数,浏览器会话 2 次均经 `verify-browser.mjs`;预算用量 build 2/8、browser 2/6)。

## 附:交付物位置

- 实现:`arm-a/workspace/src/main.js`(单文件,58,000 星点程序化生成)
- 构建产物:`arm-a/workspace/dist/`(app.js + vendor 引擎 + 相对路径 index.html)
- 自检截图:`arm-a/shots/check1.png`、`arm-a/shots/check2.png`
- 预算机器计数:`arm-a/workspace/.budget/build.count`(2 行)、`browser.count`(2 行)
