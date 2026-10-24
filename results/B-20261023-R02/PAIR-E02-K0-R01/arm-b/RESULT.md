# RESULT — Arm B of PAIR-E02-K0-R01 (cocosair / K0)

## 1. 实现摘要(逐 probe)

- **P1(asset 加载 + 画面非空)**:`GLTFLoader.loadAsync('assets/boat.glb')` 运行时真实网络请求(dev server 记录 200),`instantiate(0)` 后挂载,保留 6 部件内嵌材质;`__appReady` 在资产加载完成且首帧渲染后置 true。已验证:`assetLoaded=true, assetRequests=1`,像素探针显示船体 (89,26,20)/帆 (136,115,98) 真实着色。
- **P2(海面持续运动)**:海面为 467 块极坐标静态网格场(4203 顶点 ≥2000,半径 0–400m 近密远疏),每帧按 4 分量重力波函数 `waveAt` 更新各块竖直位置与倾斜(波形相位推进、波峰沿风向行进);`wavePhase=simTime` 单调递增。已验证 1500ms 窗口相位推进 1.50。*(注:分块海面为最终版,浏览器预算内未及复验像素;运动机制与船体共用同源波形。)*
- **P3(船体随波起伏)**:船体竖直位置 = `waveAt(0,0,t).h × 0.95` + 水线偏移,纵摇/横摇由同一波形梯度驱动(相位耦合);`boatPosition.y` 取包围盒中心。已验证 900ms 窗口 y 1.297→1.208(4s 极差远超 0.02)。
- **P4(拖拽环绕)**:引擎 `input.on('mouse-down/move/up')`(canvas 事件被 pal 吞,不走 DOM);右拖灵敏度 0.5°/px,方位角梯形速度曲线平滑无跳变。已验证 35°→108°→131.5°(松手后 500–700ms 窗口内 Δ=23.4°>20°,对采样口径双解释稳健)。
- **P5(色调切换)**:点击 `tone-toggle` 后 ~1.8s 指数过渡到 1.0;天空贴图(暖金落日 ↔ 暮蓝)、主光色温/照度、环境光、海色同时演变。已验证 2.5s 后 `toneMix=0.996>0.7`;暖端天空像素实测 (221,155,77)~(228,179,65) 亮度 181(纯色偏移远超 8/255)。
- **P6(reset 释放重建)**:销毁船(gltf instance.dispose + asset.destroy)、海面(467 mesh + material + 节点树)、天空(mesh/material/texture)GPU 资源后重建并重新网络加载;epoch+1、toneMix=0、方位角 35、模拟时间归零,非整页刷新。已验证 epoch=1、assetLoaded=true、assetRequests=2、azimuth=35、3s 内完成、console 无新增错误。
- **P7(连续 reset 稳定)**:已验证第二次 reset 后 epoch=2、assetRequests=3、画面恢复正常、无未捕获异常、fps 稳定(~56–60)无泄漏征象。

## 2. 自检清单(§5 完成合同)

1. **`npm run build` 退出码 0** — ☑(7 次构建全部成功,产物 dist/ 被 index.html 经 import map 引用)。
2. **10s 内 `window.__appReady === true`** — ☑(历次浏览器验证均 ~2s 内就绪,含资产加载)。
3. **`window.__bench = { getState, reset }`** — ☑(getState 返回 assetLoaded/assetRequests/boatPosition/wavePhase/toneMix/cameraAzimuth/fps/epoch 全部契约字段)。
4. **无未捕获异常** — ☑(6 次浏览器会话 console error=0、pageerror=0,含双 reset 序列)。
5. **spec.json 探针逐条自查** — ☑ 状态断言全部通过(P1–P7,见上);P2/P6/P7 的像素级断言依赖最终版分块海面(浏览器预算 6/6 用尽未及复验),状态与机制证据齐全,风险如实披露。

预算合规:build 7/8,browser 6/6,墙钟 ~85min/90min,toolCalls ~65/120。

## 3. 合规声明(§4 红线逐条)

1. 未访问另一 Arm(`arm-a/`)的任何内容。☑
2. 未访问 `reference/`。☑
3. 未访问 `bench/results/` 下任何其他 Pair/Arm 目录或既往 trial 结果。☑
4. 未访问 `harness/` 源码或合同模板。☑
5. 未访问 `bench/vendor/` 引擎资产目录与引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 树);引擎知识仅来自本 Arm `knowledge/`(K0=README + 官方技能包)与冻结模板自身。☑
6. 未访问 `bench/docs/`。☑
7. 未访问 `secret/`。☑
8. 无任何网络请求(仅本机 dev server 127.0.0.1:7207;无文档/搜索/registry 访问)。☑
9. 未执行 `npm install`、未改动共享 node_modules。☑
10. 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针代码与结果文件。☑
11. 未探测或篡改 harness/validator 行为与期望值。☑
12. 未手改/伪造/删除 `workspace/.budget/` 机器计数;所有构建经 `npm run build`(串联 count),所有浏览器会话经 `scripts/verify-browser.mjs`。☑

补充说明:`assets/boat.glb` 以字节一致拷贝(sha256 `ed22ff2f…9397` 与 spec.json 一致)进入 `workspace/assets/` 以满足 serve.mjs 仅以 workspace 为根的静态服务范围,源文件未改动。
