# RESULT — PAIR-E02-K0-R01 / arm-a (three.js r186)

场景:E02 落日海面与孤舟(Asset Driven)。实现位置:`workspace/src/main.js` + `workspace/index.html`
(页面契约与构建/服务脚本沿用模板;`scripts/build.mjs` 仅新增 assets 原样镜像到 `dist/assets`)。

## 1. 实现摘要(逐 probe)

| Probe | 实现方式(一句话) |
|---|---|
| **P1 资产加载** | `GLTFLoader.load('assets/boat.glb')` 在运行时发起真实网络请求(serve 日志:`GET /assets/boat.glb 200 29132`),加载成功实例化后才置 `__appReady=true`;`assetLoaded=true`、`assetRequests=1`;画面同时有渐变天穹、Gerstner 海面与多部件船体(船身/甲板/龙骨舵/桅杆索具/主帆/前帆),非空白像素占比 1.0。 |
| **P2 海面波动** | 海面为极坐标网格(150 环 × 224 段 = 33,824 顶点,近密远疏)+ 顶点着色器 4 组 Gerstner 波,波相位由全局 `uTime`(`wavePhase`)逐帧推进;实测 1.4s 内 wavePhase 变化 1.45rad,画面下 60% 运动像素占比 0.769。 |
| **P3 船体随波** | JS 端用**同一组波形参数**采样船位水面高度与坡度,驱动枢轴 y 与水面法线姿态(纵摇/横摇,slerp 平滑);实测 950ms 内 `boatPosition.y` 变化 0.223,4s `stateSeries` 极差 0.349(≥0.02 要求)。 |
| **P4 拖拽环绕** | canvas 上 pointer 拖拽(兼容合成 MouseEvent)以 0.20°/px 改变目标方位角,`updateCamera` 按 dt 指数插值环绕孤舟;实测左右拖 0.28 视口宽后 `cameraAzimuth` 35°→323°(|Δ|=288°>20°),全屏像素差 0.649。 |
| **P5 色调切换** | `tone-toggle` 按钮在暖(落日)/冷(暮蓝)目标间切换,`toneMix` 以 1.3s 线性推近(≤2.5s);天空渐变、海面反射/水体、主光色温/强度、半球光、补光同源插值;实测 2.5s 后 `toneMix=1`,画面平均色偏 88.9/255(暖 [175,124,70] → 冷 [18,39,79])。 |
| **P6 Reset 重建** | Reset 显式释放(geometry/material/texture + `renderer.renderLists.dispose()`)后整世界重建并**重新加载** GLB,恢复 toneMix=0、方位角 35°、模拟时间归零、epoch+1,非整页刷新;实测 3s 内 epoch=1、assetLoaded=true、assetRequests=2、toneMix=0、azimuth=35、非空白 1.0。 |
| **P7 连续 Reset** | 第二次 Reset 走同一释放/重建路径,并以世界代次 token 丢弃“重建途中才返回”的旧加载回调;实测 epoch=2、assetRequests=3、画面非空白 1.0、无 console error / uncaught。 |

附加说明:
- `getState()` 额外返回 `seaVertices=33824`、`ready`、`toneTarget`、`resetting` 等诊断字段(不影响合同字段)。
- 帧率:加载稳定后 2s 滚动平均 **60.5fps**(headless Chrome 1280×720,GPU=RTX 5060/D3D11),远高于 30fps 下限。
- `wavePhase` 单调递增(按合同“持续递增/须单调”),reset 不清零;reset 归零的是模拟时间 `simTime`(装饰摇摆)与船体位姿。

## 2. 自检清单(§5 完成合同)

- [x] **1. 构建**:`npm run build` 在 `workspace/` 根执行退出码 0(6 次构建全部 exit 0;末次产物 `dist/app.js` 25,043 字节,自检 OK,`dist/index.html` 引用 `./app.js`)。
- [x] **2. 就绪**:页面加载后 10s 内 `window.__appReady === true`(实测 ~1s 级;资产加载计入前置,ready 时 `assetLoaded=true`)。
- [x] **3. 状态契约**:`window.__bench = { getState(): object, reset(): void }` 存在且可调用;字段 `assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch` 齐备。
- [x] **4. 无未捕获异常**:最终验证会话 `consoleErrors=0`、`uncaught=[]`;连续两次 reset 后仍为 0。
- [x] **5. 探针自检**:按 `spec.json` 的 P1–P7 逐条自查(状态断言 + 像素/运动/网络/DOM 独立证据),全部通过:
  - P1:`assetLoaded=true && assetRequests>=1` + 非空白 1.0 + `GET /assets/boat.glb` 200;
  - P2:`wavePhase` 变化 1.45 + 下 60% 运动像素 0.769;
  - P3:`boatPosition.y` 变化 0.223 + 4s 极差 0.349;
  - P4:`|ΔcameraAzimuth|=288°` + 全屏像素差 0.649;
  - P5:`toneMix=1` + 平均色偏 88.9;
  - P6:`epoch=1 && assetLoaded && toneMix=0 && 35∈[32,38]` + 非空白 1.0;
  - P7:`epoch=2 && assetRequests=3 && assetLoaded && toneMix=0` + 非空白 1.0。

## 3. 合规声明

逐条对照 RUN-CONTRACT §4(红线),本 Run:

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录,未读取任何既往 trial 结果。
4. 未读取 `harness/` 源码与合同模板;唯一执行的是本 Arm `workspace/scripts/` 内的模板脚本与 `scripts/verify-browser.mjs`。
5. 未访问引擎资产 `bench/vendor/`(tarball / SDK 目录 / 官方 docs、examples),未访问 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树;three.js 知识面仅限本 Arm `knowledge/`(README + manifest)。
6. 未访问 `bench/docs/`(实验计划书与合同文档目录)。
7. 未访问 `secret/`。
8. 未联网:全部资源来自本 Arm 目录内的本地 dev server(127.0.0.1:7102),无任何外部网络请求。
9. 未执行 `npm install`,未安装任何新依赖,未改动共享仓内容。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改、伪造、删除或重置 `workspace/.budget/` 机器计数文件,也未绕过 `count.mjs` / `verify-browser.mjs` 计数:所有构建经 `npm run build`(先计后建),所有浏览器会话经 `scripts/verify-browser.mjs`(先计后开会话)。计数:build 6/8、browser 6/6,未超限。

其他需披露的改动(均在允许范围内):
- `workspace/assets/boat.glb`:从本 Arm 的 `assets/boat.glb` **原样拷贝**(sha256 `ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397`,与 spec 一致),只读使用,未修改源资产。
- `workspace/scripts/build.mjs`:仅在 vendored 引擎复制之后新增 `assets -> dist/assets` 原样镜像,保证以 `dist/` 为站点根时页面仍通过真实网络请求加载 GLB(不转译、不内联);模板原有自检项与幂等性未改变。
- `workspace/shots/*.png`:自检截图证据(本地保留,不参与构建)。
