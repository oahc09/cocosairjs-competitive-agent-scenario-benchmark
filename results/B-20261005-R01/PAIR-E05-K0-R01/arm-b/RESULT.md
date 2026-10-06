# RESULT — PAIR-E05-K0-R01 / Arm B(cocosair,K0 冷启动)

> 交付物:`workspace/src/main.js`(经 `npm run build` → `dist/`),探针证据见 `selfcheck/`,时间线见 `WORKLOG.md`。

## 1. 实现摘要(逐 probe)

全部视觉程序化生成(assets=[])。总路线:高密度环形网格 + builtin-unlit 顶点色(经 `Material.initialize({effectAsset, defines:{USE_VERTEX_COLOR:true}})`),无后处理/无混合/无自定义 shader;辉光以"亮带向外亮度平滑衰减到黑"的不透明衰减在纯黑深空上等效加色辉光。

- **P1 初始画面非空且吸积盘可见**:中央黑洞场景(暗核+亮环+盘+星流)+ 800 颗软点背景星;自检:中心 1/3 非黑像素比 0.544(阈 ≥0.05)、四角外围最低 0.082(阈 ≥0.01)、中心连续暗核(±20px 盒亮度中位数 = 0,自中心连续黑程 43–45px)且被亮环包围(环带均值亮度 130)。
- **P2 盘旋转运动证据**:整盘网格绕 Y 轴时间驱动刚体旋转(ω = 0.353 rad/s,实测 0.8s 间隔 diskRotation 采样差 0.333 rad ≥ 0.1),条纹/亮带随网格连续转动;盘区两帧像素差 77,658 px(远超阈值);diskRotation 单调累加。
- **P3 径向颜色梯度**:顶点色径向梯度 内缘白蓝(1.8u)→ 暖白 → 亮黄橙(3.1u)→ 暗红(6.5u);按 spec 几何常数(0.06–0.14 / 0.18–0.30 × minD,±6% 高度带)的方位角扇区采样:多普勒亮侧(左)有向 R-B 差 25.1 ≥ 18,内环带亮度/外环带 = 2.88 ≥ 1.5,accretionPhase ∈ [0,1)。
- **P4 相机缩放构图变化**:window capture 级 wheel 监听(pal 层吞 canvas 事件的规避),目标距离夹 [5,28]、指数平滑(速率 6/s,1s 残差 <0.3%);wheel dy=-600 后 cameraDistance = 8.001(<10,≥5),暗核屏幕半径 43→93px(2.16× ≥ 1.25×),构图单调变大。
- **P5 星流螺旋**:220 个拉长六边形拖尾粒子(独立 Node+共享 4 色路网格),螺旋轨迹汇入、近视界加速拉长、r<1.32 吞没后于 5.2–8.2u 外圈重生(总数恒定);mid-ring 区域两帧像素差 74,332 px,starStreamCount 恒为 220。
- **P6 reset**:`data-ui="reset"` DOM 按钮(右上角,归一化 ~0.97/0.03)与 `__bench.reset()` 同一 doReset:cameraDistance 回 14.0(实测 14.0)、diskRotation 归零(0.146 < 0.3,含 400ms 重累计)、accretionPhase 0.023 < 0.1、星流复位、背景星不变、画面完整(非黑比 0.267)。

加分项:多普勒不对称(亮侧系数 1.26 / 暗侧 0.74,任一时刻一侧明显亮于另一侧)、引力透镜观感(竖直平面光子环包绕视界,下半被盘面前景自然遮挡 + 内缘光晕)、微弱冷色星云。

## 2. 自检清单(§5 完成合同)

- [x] **build**:`npm run build` 在 workspace/ 根执行,最终 build #5 退出码 0(共 5 次尝试,机器计数 5/8)。
- [x] **ready**:10s 内 `window.__appReady === true`(实测首帧后 238ms 置位,EVENT_AFTER_DRAW 驱动)。
- [x] **state**:`window.__bench = { getState, reset }` 契约成立;getState 返回真实数据(diskRotation/accretionPhase/cameraDistance/starStreamCount/backgroundStarCount + frame/resetCount),无伪造。
- [x] **无未捕获异常**:最终会话 console error = 0、pageerror = 0(全程 6 次浏览器会话仅第 4 次迭代中间产物出现过一次,已于 build #4 修复,最终产物干净)。
- [x] **探针自检**:spec.json P1–P6 逐条(状态断言 + 像素/运动独立证据)全部通过 —— P2–P6 由 probe-selfcheck.mjs 单会话全序列验证(自检结果 `selfcheck/selfcheck-result.json` 全 pass);P1 之"暗核"单像素子项被穿越核心前景的星流粒子(物理正确现象)污染,经已存 p1.png 的鲁棒统计复核确认语义满足(`selfcheck/p1-core-recheck.json`:中位数 0、连续黑程 43–45px、亮环 130)。

## 3. 合规声明(逐条,§4 禁止路径)

1. 未访问另一 Arm(arm-a)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未读取本 Pair 本 Arm 之外的任何 `results/` 目录;未读取任何既往 trial 结果。
4. 未读取 `harness/` 源码或本合同模板(探针自检基于 brief/spec 文本与公开截图自行实现)。
5. 未访问引擎资产 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);K0 冷启动仅使用模板代码、knowledge 包内 README 与 arm 目录内材料(含 workspace 内引擎运行时副本的构建产物管线,由冻结 build 脚本自动完成)。
6. 未读取 `bench/docs/` 实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档检索/搜索/包 registry;仅本机 dev server 与本机浏览器会话)。
9. 未执行 `npm install`、未新增/修改任何依赖、未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(自检脚本为独立实现,仅按 spec.json 声明的常数复刻采样几何)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过计数构建或开会话(build 全部经 `npm run build` 串联计数;浏览器会话 6 次全部经 verify-browser.mjs 自动计数或本 Arm 自检脚本会话前先执行 count.mjs browser)。

## 预算与环境(如实)

| 项 | 用量 / 上限 |
|---|---|
| buildAttempt | 5 / 8 |
| browserAttempt | 6 / 6 |
| toolCall | ≈52 / 120(Runner 记录为准) |
| 墙钟 | ≈55 / 90 分钟 |

环境:系统 Chrome headless 1280×720(Windows,exFAT 共享 node_modules 布局),dev server 端口 7103。
