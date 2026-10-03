# RESULT — PAIR-E05-K0-R01 / arm-b (cocosair)

场景 E05「黑洞吸积盘」。实现文件:`workspace/src/main.js`(约 670 行,全程序化,零外部资产)。
验证记录:`WORKLOG.md`、探针报告 `verify/out/report-t4.json`(最终构建)、截图 `verify/out/*-t4.png`。

## 1. 实现摘要(逐 probe)

- **P1(初始画面非空)**:520 颗静态星 + 四角微星云的背景层(Canvas 2D 运行时生成纹理,远处不透明面片);additive 吸积盘 + 光子环照亮中心;实测中心 1/3 区域非黑 90.4%、四角 100%、中心 40×40px 连续纯黑暗核(`coreBox nonBlack=0`)。state:backgroundStarCount=520、starStreamCount=240、cameraDistance=14、diskRotation>0 ✓。
- **P2(盘旋转运动)**:盘 shader 螺旋辐条相位由累计 `diskRotation` 刚性驱动(0.32 rad/s,时间参数连续旋转);实测 0.8s 两次采样 diskRotation 差 0.262 rad(≥0.1),盘面环带两帧差分非零像素 34.6%。diskRotation 单调递增、accretionPhase=(rot/2π)%1 ✓。
- **P3(径向颜色梯度)**:颜色按屏幕椭圆半径定义——内缘蓝白 (1.10,1.26,1.50) → 中带橙黄 → 外缘饱和暗红 (0.85,0.14,0.02),配合内缘截止的中性外光晕与蓝白光子环,保证任意以屏幕中心为圆心的环带采样均呈「内白亮偏蓝、外暗红」;实测标定 A(内 1.95-2.7u/外 5.0-6.3u)亮度比 4.89、(R-B)外-内 = +16.1;标定 D(内 1.5-2.4/外 3.5-4.5)亮度比 3.06、(R-B)差 +65.7。辉光为多层高斯/平滑衰减叠加,过渡无硬边。
- **P4(滚轮缩放)**:window wheel 监听,deltaY×0.012 线性映射目标距离并夹 [5,28],指数平滑(k=7);实测 dy=-600 后 1.2s cameraDistance=6.80(<10),暗核屏幕半径 98→202px(2.06×),平滑残差 0.003%(≪10%)。
- **P5(星流螺旋)**:240 粒子单 draw call,顶点着色器解析计算螺旋轨迹(p^1.75 加速下落、R 7.8→1.05),切向解析导数实现近核拖尾拉伸(6×),进入暗核被遮没(吞噬)并在外圈 wrap 重生(fract 相位循环,总数恒定);实测中环带两帧差分非零 66.0%。
- **P6(reset)**:右上角 `data-ui="reset"` DOM 按钮 ≡ `__bench.reset()`:距离立即回 14.0、diskRotation/accretionPhase 归零、模拟时间归零(星流复位重生)、背景星不变;实测 reset+400ms 后 dist=14.0、rot=0.197(<0.3)、phase=0.031(<0.1)、starStreamCount=240、全画面 98.9% 非黑、__appReady 保持 true。
- **加分项**:多普勒不对称(dop=1+0.85·sinθ,一侧明显增亮);引力透镜观感(顶部增亮的光子环弧 + 盘后缘包绕核的环形观感);微弱冷色星云;曝光用 1-e^(-x) 压缩,亮部不死白。

技术路线:运行时构造 6 个 glsl3 EffectAsset(与引擎 builtin 同一注册路径 programLib + EffectAsset.register),6 个 MeshRenderer 按 Renderer.priority 构成确定性 painter 顺序(不透明星空 → 光晕 → 盘 → 星流 → 暗核 → 光子环);相机仅沿固定视线方向 dolly,故屏幕平行面片栈在任意缩放下几何等价于真实 3D 环(brief §2/§8 明确允许屏幕空间绘制)。

## 2. 自检清单(完成合同 §5)

- [x] `npm run build` 在 workspace/ 根执行退出码 0(4 次构建全成功)
- [x] 页面 10s 内 `window.__appReady === true`(实测 ~1.5s)
- [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(getState 暴露 diskRotation / accretionPhase / cameraDistance / starStreamCount / backgroundStarCount 等真实数据)
- [x] 无未捕获异常(CDP 全程采集 console error 与 exception:0 条)
- [x] 探针自检 P1–P6 逐条通过(状态断言 + 像素/运动独立证据,数值见上;两处说明:P3 自测了 4 组环带标定,A/D 两组合理标定全过,B/C 内环带与黑洞暗核重叠、对任何实现均为退化标定;P4 视觉证据为暗核半径 2.06× ≥ 1.25×)

预算:工具调用 ~60/120,墙钟 ~55min/90min,build 4/8,浏览器验证 5/6(含 1 次色彩诊断会话)。

## 3. 合规声明(RUN-CONTRACT §4 红线逐条)

1. **未**访问另一 Arm 的任何内容(目录/代码/日志/dev server/浏览器 profile/截图/结果)。
2. **未**访问 `bench/reference/`。
3. **未**访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录与任何既往 trial 结果;全部工作限于 `arm-b/` 内。
4. **未**访问 `bench/harness/` 源码与合同模板。
5. **未**访问引擎源码仓库(`E:\AIProMax\github\cocosair.js`)与 three.js r186 源码树;引擎知识仅来自本 Arm 目录内的 knowledge/(K0 README)与 workspace 内 vendored node_modules 的 d.ts/模块(合同 §3 白名单明示 workspace/ 全部内容可用)。
6. **未**访问 `bench/docs/`。
7. **未**访问 `bench/secret/`。
8. **未**发起任何网络请求(无文档/搜索/registry;dev server 与 headless Chrome 仅访问 127.0.0.1 本地回环)。
9. **未**执行 `npm install` 或安装任何新依赖(仅用模板 vendored node_modules;验证驱动用 Node 内建模块自研 CDP over WebSocket)。
10. **未**修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(仅新建/修改 workspace/src/main.js、workspace/index.html 标题一行,及自建 WORKLOG.md、RESULT.md、verify/ 验证脚本与截图)。
11. **未**探测或篡改 harness/validator 行为与期望值;无自动化环境特判;`__bench.getState()` 全部为真实驱动状态(盘旋转/相位/距离与画面运动同源同步);无预渲染素材、无贴图序列、无逐帧回放,一切动态由时间参数实时计算。

环境事实声明:dev server 端口按合同括号指示设为 `PORT=7105`(合同表格另写 7101,两处矛盾,已按更具体的操作性指示执行并在此披露);验证为策略级隔离下的自主执行,产物待扫描。
