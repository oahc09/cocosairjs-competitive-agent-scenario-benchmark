# RESULT — PAIR-E05-K0-R01 / arm-a(three r186,K0)

> Run 完成。终版证据:`shot-6-final.png`(1280×720 实拍)、`workspace/.budget/*.count`(机器计数:build 6 / browser 6)、自检数据见下。

## 1. 实现摘要(逐 probe)

全部视觉程序化生成(assets=[]):背景为 BackSide 大球极暗星云着色 + 3000 颗静态星点(自定义点着色器,大小/亮度/色温差异);事件视界为纯黑球体(写深度、锐利边缘、正确遮挡盘远侧);吸积盘为 RingGeometry[1.8, 6.5] + 自定义 ShaderMaterial(径向白→橙→暗红梯度、随 `uRot=diskRotation` 连续旋转的双频螺旋条纹、切向多普勒增亮);辉光以三层加色 billboard 替代后处理(宽域柔光 + 紧凑暖光 + 光子环,中心留孔保持暗核纯黑);另加相机朝向透镜光环(上强下弱弧形包绕,加分项);星流 260 粒子开普勒角速度 ω∝r^-1.5 螺旋坠入、拖尾按速度回溯拉长、r<1.24 吞噬并于外圈重生(总数恒定);相机滚轮指数缩放(平滑插值,[5,28] 钳制)+ 拖拽微调(加分项);`__bench` 状态全部来自真实运行时变量。

- **P1 初始画面非空**:中心 1/3 非黑像素 84.2%(阈值 ≥5%,含盘内缘亮环/星流);四角外围非黑 100%(阈值 ≥1%,背景星+星云);中心为连续纯黑暗核(实测中心 24×24 平均亮度 0/255),被光子环亮环包围。state:backgroundStarCount=3000(≥300)、starStreamCount=260(≥200)、cameraDistance=14.0(13–15)、diskRotation 单调递增 >0。
- **P2 盘旋转运动证据**:间隔 800ms diskRotation 采样差 0.312 rad(阈值 ≥0.1;角速度 0.35 rad/s ∈ [0.15,0.6]);盘区两帧差分非零像素 13822(>冻结阈值),条纹/星流真实推进,画面与 uRot 着色器联动非伪造。
- **P3 径向颜色梯度(多普勒亮侧扇区有向 R-B 差)**:镜像 validator 几何(内带 0.06–0.14×minD、外带 0.18–0.30×minD、±6% 高度带、逐侧取更橙侧=右侧)实测:外环带 R-B 53.4 − 内环带 R-B 4.5 = **48.9 ≥ 18**(内白/外橙成立);内环带平均亮度 131.7 / 外环带 76.7 = **1.72 ≥ 1.5×**;内环向外亮度单调衰减无硬边(光子环→盘内缘→外缘连续渐变);accretionPhase=0.206 ∈ [0,1)。
- **P4 相机缩放后构图变化**:wheel{dy:-600} → target=14×e^(-0.69)=7.03,cameraDistance=7.03(<10 且 ≥5);插值 λ=5.5,1s 内残差 <0.3%(<10% 目标值);暗核屏幕半径 75px→149px(**1.99× ≥ 1.25×**),全程钳制 [5,28]。
- **P5 星流螺旋**:盘周区域 700ms 两帧差分 18430 非零像素(运动证据);starStreamCount=260 恒定(吞噬重生);拖尾随速度增长,近视界明显拉长后消失并于外圈重生。
- **P6 reset**:点击 data-ui="reset" 后 cameraDistance=14.0(13.5–14.5)、diskRotation=0.146(<0.3,含 400ms 重累计)、accretionPhase=0.023(<0.1)、starStreamCount=260;全画面非黑 98.2%,黑洞+盘+星空完整,暗核回到初始占屏比。

## 2. 自检清单(合同 §5)

- [x] 1. `npm run build` 在 workspace/ 根执行,退出码 0(build #6 终版,共 6 次,≤8)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 <1s,首帧即置 true)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 engine/frame/ready/diskRotation/accretionPhase/cameraDistance/starStreamCount/backgroundStarCount,均为真实变量)
- [x] 4. 无未捕获异常(6 次浏览器会话 consoleErrors=0、uncaught=[] consistently)
- [x] 5. 探针自检:P1–P6 状态断言 + 像素/运动独立证据全部通过(数据见上,自检脚本 `workspace/selfcheck-eval.js`,经 `scripts/verify-browser.mjs` 计数执行)

辅助:常态 fps ≈ 60(≥30);动画以 performance.now 真实时间步进,dt 钳制 0.1s(失焦保护)。

## 3. 合规声明(逐条,合同 §4)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问本 Pair 本 Arm 之外的任何 `results/` 目录及既往 trial 结果(仅读写本 arm-a 目录与 `results/B-20261005-R01/PAIR-E05-K0-R01/arm-a/`)。
4. 未读取 `harness/` 源码或合同模板(仅使用 workspace 模板自带 scripts)。
5. 未访问 `bench/vendor/` 引擎资产目录及引擎上游源码仓库(K0 冷启动隔离;知识仅 `knowledge/` 内 npm README)。
6. 未读取实验计划书与 `bench/docs/` 合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无联网检索、无包 registry 访问;页面运行时零外部请求,import map 本地解析)。
9. 未执行 `npm install`,未改动共享 node_modules(依赖沿目录向上解析)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(workspace 内仅新增/修改 src/main.js、index.html 标题、selfcheck-eval.js 自检脚本)。
11. 未探测或篡改 harness/validator 的行为与期望值(P3 自检几何仅依据 spec.json amendments 中公开的扇区常数镜像,未触碰 validator)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;全部 6 次构建经 `npm run build`(内置 count.mjs)、全部 6 次浏览器会话经 `scripts/verify-browser.mjs` 计数执行,无绕过。

禁止捷径(spec §10)声明:无预渲染视频/帧序列/贴图序列;盘旋转为时间参数驱动着色器动态;getState 无伪造;无外部图片/视频资产;无自动化环境特判。
