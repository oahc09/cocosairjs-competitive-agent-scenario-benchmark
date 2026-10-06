# RESULT — PAIR-E06-K0-R01 / arm-a(three r186 / K0 冷启动)

## 1. 实现摘要(逐 probe 一句话)

实现入口:`workspace/src/main.js`(esbuild 打包为 `dist/app.js`,引擎经 import map 本地解析,零网络依赖)。
场景构成:低多边形起伏地形(44×44 段、flat shading、顶点色)+ 18 棵三层锥体低多边形树环(radius 9.5–16,避开场心)+ 中央篝火组(9 块石圈 + 5 根交叉柴堆 + 自发光炭床)+ 火苗 48 粒子(橙黄→红渐变、上升摆动)+ 火星 72 粒子(上升 1.2–2.8 单位/s、寿命 0.8–2.0 s、随风漂移消散)+ 萤火虫 20 只(黄绿、游走+脉冲明灭、白天淡出计数不变)+ 星空 380 点 + 一盏真实 PointLight 火光(基准 0.55、多频 0.6/1.1/2.9/5.3 Hz 叠加、幅度 ±0.27、decay 1.8 真实照明地面与树干)。

- **P1 营地可见**:初始夜景(timeOfDay=0)下树环 18 棵剪影可辨、地面/泥地圆盘被暖橙火光照亮,自检截图 `selfcheck/night-p1.png` 中下区暖色像素 536 个,上部为深蓝夜空(upper-third 亮度 23.6)与星点——state(tod=0/tree 18/firefly 20/orbit 开/角>0)+ 像素双证据 PASS。
- **P2 火光动态**:600ms 两次采样 |ΔfireLightIntensity|=0.077≥0.02,同窗中下区帧差 meanDiff=13.4、变化像素 22986/57600(40%,照明波动扩散到地面/树而非仅火苗)——PASS。
- **P3 日夜切换**:点击 day-night 后 timeOfDay 线性渐变 3.0s(2.5–4s 区间内),0.5s 步进采样捕获中间态 0.339/0.506/0.672/0.844,终值 1.0≥0.9;upper-third 亮度夜 23.6 → 日 184.0(7.8×≥1.5×),1s 中间态亮度 81.2 证明连续渐变而非瞬切——PASS。
- **P4 环绕相机**:orbitEnabled=true 下 cameraOrbitAngle 以 0.25 rad/s(spec 区间 0.05–0.4)持续累计,3s 采样差 0.75 rad≥0.15,环绕构图连续变化——PASS。
- **P5 环绕暂停**:点击 orbit-toggle 后 orbitEnabled=false,1.6s 内角度漂移 0<0.01(角度冻结),火光/萤火虫局部动态不受影响——PASS。
- **P6 reset**:点击 reset 后即时 state timeOfDay=0(≤300ms)、orbitEnabled=true、cameraOrbitAngle=0,1s 后角 0.254<0.6(环绕恢复累计),upper-third 亮度较白天回落 87.5%(≥40%)、星空重现、萤火虫恢复初始播种——PASS。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 0(2 次尝试,#1 全量实现、#2 微调,均 OK)
- [x] 2. 页面 10s 内 `window.__appReady === true`(两次浏览器会话均 appReady=true,首帧即置位)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 timeOfDay/fireLightIntensity/fireflyCount/cameraOrbitAngle/orbitEnabled/treeCount 全部真实数据)
- [x] 4. 无未捕获异常(两次会话 consoleErrors=0、uncaught=[])
- [x] 5. 探针自检:spec.json P1–P6 逐条自查,状态断言+像素/运动独立证据全部通过(证据:night-p1.png、会话 eval JSON 见 WORKLOG 2026-10-05 条目)

预算消耗:build 2/8 · browser 3/6(其中 1 次为自检 eval 语法笔误,页面无错)· toolCall 远低于 120 · 墙钟约 8 分钟/90 分钟。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、server、截图或结果。
2. 未访问 `reference/` 任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. 未读 `harness/` 源码与合同模板(仅使用 workspace 内预置脚本 count/serve/build/verify-browser)。
5. 未访问 `bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树;引擎仅经共享 node_modules 的 `three` 裸名导入使用。
6. 未读 `bench/docs/`(实验计划书与合同文档)。
7. 未访问 `secret/`。
8. 全程零网络请求(无文档/搜索/registry 访问;页面运行时亦无任何外部资源)。
9. 未执行 `npm install`,未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码与探针结果文件。
11. 未探测或篡改 harness/validator 行为与期望值(实现仅针对 spec 的公开探针口径设计)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;全部构建经 `npm run build`(内置 count.mjs)、全部浏览器会话经 `scripts/verify-browser.mjs` 创建,无任何绕过。

附加:assets/ 只读未改;knowledge/ 仅含 K0 README(已读);场景无任何外部图片/视频/音频资产,粒子贴图为运行时 canvas 生成;火苗/火星/萤火虫均经 WebGL Points 渲染管线绘制。
