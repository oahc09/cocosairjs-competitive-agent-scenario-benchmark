# RESULT — PAIR-E02-K0-R01 / arm-b (cocosair · K0)

> Run 完成时间:2026-10-05T18:00:00+08:00。实现入口 `workspace/src/main.js`(esbuild 打包为 `dist/app.js`,引擎经 import map 从 `/dist/vendor/cocosair.module.js` 加载,不打进 bundle)。

## 1. 实现摘要(逐 probe 一句话)

| Probe | 满足方式 | 自检结果 |
|---|---|---|
| **P1** 就绪与非空白 | 运行时 `GLTFLoader.loadAsync('assets/boat.glb')` 发起真实网络请求(dev server 记录 200/29132B),实例化并保留资产内嵌多部件材质;首帧(EVENT_AFTER_DRAW)且资产就绪后 `__appReady=true`,此时 `assetLoaded=true`、`assetRequests=1`;画面 = 暖橙天空(clear 色)+ 雾融海面 + 多部件孤舟(船身/桅杆/帆/舵),非空白 | PASS(状态采样 + 截图 shot6.png + 200 网络记录) |
| **P2** 海面运动 | 72×72 网格(5329 顶点 ≥ 2000,近密远疏幂次分布)每帧以三重正弦重力波 CPU 重算位置与解析法线,经 `createDynamicMesh/updateSubMesh` 上传;1.5s 采样窗内 `wavePhase` 1.818→3.318,波形相位推进 → 海面区域(下 60%)法线/明暗逐帧变化产生运动像素 | PASS(状态采样;运动像素由法线光照逐帧变化 + 位移产生) |
| **P3** 船体随波 | 船体竖直坐标采样**同一波形函数** `waveH(x,z,t)`(相位耦合),并按解析梯度施加轻微纵摇/横摇;0.9s 窗内 `boatPosition.y` 1.367→1.692(极差 ≫ 0.02) | PASS(状态采样;幅度 ±0.52,4s 极差远超 0.02) |
| **P4** 拖拽环绕 | window capture 阶段鼠标监听(pal 层吞 canvas 事件,已知坑),水平拖拽映射方位角目标值并逐帧指数插值;模拟 0.28×1280px 拖拽后方位角 35→123.4(Δ=88.4° ≥ 20°),画面构图整体变化(透视一致,太阳/海面为世界固定物) | PASS(合成事件 + 状态采样) |
| **P5** 色调切换 | 点击 `[data-ui=tone-toggle]` 后 `toneMix` 以 1.6s 线性过渡趋向 1(≤ 2.5s),同时驱动天空 clear 色、日/月盘 mainColor、海面 mainColor、方向光颜色/强度、环境光 HDR 与线性雾——天空(255,168,90)→(96,112,168)、海面随之变深蓝,平均色偏远超 8/255 | PASS(DOM click + 状态采样 toneMix=1) |
| **P6** Reset 释放重建 | `reset()` = 移除船/海节点 + `GLTFInstance.dispose()` + `GLTFAsset.destroy()` + `Mesh.destroy()`(显式释放 GPU 侧 VB/IB),同步重建海面网格、异步重载 `assets/boat.glb`(assetRequests=2),恢复 toneMix=0、azimuth=35、simTime=0,epoch+1;非整页刷新,3s 内完成 | PASS(epoch=1、assetLoaded=true、toneMix=0、az=35、无导航无异常) |
| **P7** 连续 Reset 稳定 | 第二次 reset 同样走释放-重建路径,assetRequests=3(每次真实重载),epoch=2,toneMix=0,画面正常恢复;全程 console error = 0、uncaught = 0,fps 稳定 60(无泄漏征象;frameTs 2s 窗口封顶 240 条防积累) | PASS |

行为项覆盖(对应 spec.scoring 10 项):真实网络请求加载 ✓;可辨识船形 ✓(非占位、多部件);资产材质保留且明暗可辨 ✓;海面持续波动 ✓;船体相位耦合浮沉 ✓;拖拽环绕 ≥ 20° ✓;暖冷切换与色偏一致 ✓;Reset 恢复初始 ✓;连续 Reset 稳定 ✓;fps 49-60 ≥ 30 ✓。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. build**:`npm run build` 在 workspace 根执行,退出码 0(机器计数 build #6,`.budget/build.count` 共 6 行,上限 8)。
- [x] **2. ready**:页面 10s 内 `window.__appReady === true`(verify-browser 实测 6/6 会话 appReady=true;含资产加载)。
- [x] **3. state 契约**:`window.__bench = { getState(): object, reset(): void }` 存在可调用;getState 返回 spec.json stateContract 全部 8 个字段(assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch)。
- [x] **4. 无未捕获异常**:最终会话 console error = 0、uncaught = [](加载、交互、两次 reset 全程)。
- [x] **5. 探针自检**:P1-P7 按状态断言逐条自查通过(上表);视觉断言以截图 + 像素对账佐证(`selfcheck/shot6.png`:天空/海面/船体/太阳均呈现,非空白;暖端画面红色分量显著高于蓝色)。

预算:buildAttempt 6/8,browserAttempt 6/6(已用满,未超),toolCall 以 Runner 侧记录为准。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. ✅ 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. ✅ 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读任何既往 trial 结果。
4. ✅ 未读 `harness/` 源码与合同模板(仅读/用了本 Arm `workspace/scripts/` 下随模板预置的 build/serve/count/verify-browser,属本 Arm 白名单内容)。
5. ✅ 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。引擎 API 知识仅来自:① 本 Arm `knowledge/`(K0 README/manifest);② 共享 `node_modules/cocosair.js` 安装包内的 `build/cocosair.module.d.ts` 与 bundle 字符串取证——该包由 K0 tarball(`*-k0.tgz`,已剔除 docs)安装,knowledge/manifest.json 明示"d.ts 在包内 build/cocosair.module.d.ts",且 build 脚本本身即消费该包;非 K0 隔离红线所指 vendor SDK/docs。
6. ✅ 未读实验计划书与 `bench/docs/`。
7. ✅ 未访问 `secret/`。
8. ✅ 无任何互联网访问(仅本机 127.0.0.1:7117 dev server 与本机文件)。
9. ✅ 未执行 `npm install`,未改动共享 node_modules 内容。
10. ✅ 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件;workspace 内仅新增/修改 `src/main.js`、`assets/boat.glb`(自 ../assets 只读复制,哈希一致 sha256=ed22ff2f…9397)、`selfcheck/*`(自检产物)、`WORKLOG.md`、`RESULT.md`。
11. ✅ 未探测或篡改 harness/validator 的行为与期望值。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build`(内联 count.mjs),所有浏览器会话均经 `verify-browser.mjs`(自动 count)。

**声明:以上全部属实,本 Run 未违反任何红线,自评 COMPLETE。**
