# RESULT.md — Arm A of PAIR-E05-K0-R01(three.js r186,K0)

> Run 模式:R0 自主一次性交付。场景:E05 黑洞吸积盘。实现位于 `arm-a/workspace/`(源码 `src/main.js`,构建产物 `dist/`)。

## 1. 实现摘要(逐 probe)

- **总体路线**:全程序化生成(assets=[],零外部资产、零网络请求)。黑洞核心为纯黑不透明球体(锐利剪影,天然保证"连续暗核");吸积盘为 `RingGeometry`(1.75–6.55,256 段,曲率平滑)+ 自定义 ShaderMaterial(径向四段色 ramp:蓝白→白→橙黄→橙→暗红;`sin(6(θ−uRotation+2.4ln r))`+二次谐波生成随时间连续旋转的螺旋条纹;多普勒束射按 `cosθ` 固定亮侧且内强外弱,保住内白外橙的色序);辉光采用**多层叠加式替代方案**(路径不限):光子环 sprite + 内区白蓝辉光 sprite + 外围暖色微光 sprite + 盘面内缘指数衰减 rim,叠加混合、无硬边;引力透镜观感以贴视界上半环蓝白弧 sprite 呈现;星流为 240 个粒子(LineSegments 拖尾 + Points 头部),开普勒式角速度内快外慢、径向坠落随半径加速、近视界拖尾拉长、吞噬后外圈重生总数恒定;背景星 6000 颗(两层 Points,大小/亮度/色温有差异);滚轮缩放指数映射目标距离 + 指数平滑插值,拖拽可微调俯仰(加分项);`getState()` 全部返回真实运行时数据。

- **P1 初始画面非空**:中心 1/3 非黑像素占比 78.3%(阈值 ≥5%),四角外围 1.09%–1.29%(阈值 ≥1%),中心暗核区平均亮度 0(纯黑连续暗核)且被亮环包围;state:`cameraDistance=14∈[13,15]`、`diskRotation=1.225>0`、`starStreamCount=240≥200`、`backgroundStarCount=6000≥300`。
- **P2 盘旋转运动证据**:0.8s 间隔两次采样 `diskRotation` 差 0.371 rad(≥0.1,对应角速度 0.42 rad/s ∈[0.15,0.6],单调递增);盘区两帧像素差分非零(变化超阈值像素 19825,自检口径),条纹/亮带位置随时间推进。
- **P3 径向颜色梯度(amendment F-15 扇区断言)**:按 0.06–0.14 / 0.18–0.30 × minD、±6% 高度带逐侧采样,多普勒亮侧(right)有向 R-B 差 `avgRBDiff = 104.7 ≥ 18`;内环带平均亮度/外环带 = 1.56 ≥ 1.5×;内缘向外亮度指数衰减、无硬边;`accretionPhase∈[0,1)` 随周回绕。
- **P4 相机缩放构图变化**:`wheel:{dy:-600}` 后 `cameraDistance = 7.24 ∈ [5,10)`(指数平滑,1s 内残差 <0.3%);暗核屏幕半径 53px→104px(1.96× ≥1.25×),盘外缘半径 345px→527px(1.53× ≥1.2×),占屏比随距离单调增大。
- **P5 星流螺旋**:mid-ring 区域两帧差分变化像素 16195(自检口径),星点沿螺旋轨迹持续流向中心且近界拖尾拉长;`starStreamCount=240` 恒定(吞噬即外圈重生)。
- **P6 reset**:点击 `data-ui="reset"` 后 400ms:`cameraDistance=14∈[13.5,14.5]`(直接回位)、`diskRotation=0.196<0.3`、`accretionPhase=0.031<0.1`、`starStreamCount=240`,画面非空(整幅非黑占比 14%)且构图回到初始距离量级;星流复位到确定性初始布局,背景星不变。

## 2. 自检清单(RUN-CONTRACT §5,全部满足)

- [x] **1. build**:`npm run build` 于 `workspace/` 根执行,退出码 0(本轮共 4 次构建,均成功,机器计数 4/8)。
- [x] **2. ready**:`window.__appReady === true`(verify-browser 实测 `appReady:true`,首帧即置位,远小于 10s)。
- [x] **3. bench 契约**:`window.__bench = { getState(): object, reset(): void }` 成立(`benchReady:true`,getState 返回 engine/frame/diskRotation/accretionPhase/cameraDistance/starStreamCount/backgroundStarCount 真实数据)。
- [x] **4. 无未捕获异常**:5 次浏览器会话 `consoleErrors:0`、`uncaught:[]`(exit code 0)。
- [x] **5. 探针自检**:按 spec.json probes P1–P6 逐条状态断言 + 像素/运动断言自查,全部通过(终验会话 #5 数据见上;自检工具 `workspace/probe-full.js` + `verify-browser.mjs`,原始输出存于 `workspace/sess*.out`,截图 `shot-initial.png` / `shot-final.png`)。

**预算使用**:build 4/8;browserAttempt 5/6;toolCall 远低于 120;墙钟约 12 分钟(< 90 分钟)。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 及其下任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未访问任何既往 trial 结果。
4. 未访问 `harness/` 源码与本合同模板。
5. 未访问引擎源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经共享 node_modules 的 `three@0.186.1` 运行时使用。
6. 未访问实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(构建/运行全程离线;未访问文档站点、搜索、包 registry)。
9. 未执行 `npm install`,未安装或改动任何依赖;仅沿目录向上解析使用共享 node_modules,未改动共享仓内容。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(`workspace/scripts/` 下模板脚本原样未动)。
11. 未探测或篡改 harness/validator 的行为与期望值;自检探针仅读取自身页面像素与自身暴露的 `__bench` 状态。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;全部构建经 `npm run build`(自动计数)、全部浏览器会话经 `scripts/verify-browser.mjs`(自动计数),无任何绕过。

**Forbidden Shortcuts 声明**:未使用任何预渲染视频/帧序列/贴图序列;盘面旋转为时间参数驱动的着色器连续动态;`getState()` 无伪造(状态与画面一致,由像素差分交叉验证);未引入外部图片/视频资产;无静态截图/纯黑/空场景过关;无针对 harness/validator 的特判。

---

*时间戳 ISO-8601(UTC)。自检原始数据:`workspace/sess1.out` … `workspace/sess5.out`。*
