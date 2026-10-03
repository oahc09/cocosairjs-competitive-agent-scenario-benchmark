# Ceiling Notes — E01 深空星系巡航 · Three.js r186 Reference

> Engine Ceiling 锚点自评。评分口径:六维各 0–3(允许 0.5 步进),总分 18。
> 证据:validation/screenshots/(P1-vis / P4-after / final 等 27 张)+ video.webm + 图像分析两轮 + 离线投影计算。

## 一、视觉六维自评

### 1. 构图取景 — 2.5 / 3
- 初始画面经投影公式离线验证:核球投影 NDC(0,0) 精确居中;盘面占屏宽 71.2%(brief 构图带 60–75%);仰角 38° → 视线-盘法线夹角 52°(带内 30–60°)斜俯视。
- 纵深三层:核球/盘面(近)→ 9000 颗远景球壳星(700–1600 单位)→ CSS vignette 收边;近侧旋臂出血至画面底边形成前景层。
- 扣分:视觉元素单一(单星系 + 背景星),无第二焦点(如伴星系/亮星耀斑),属"一主体"构图。

### 2. 材质光影 — 2.5 / 3
- 全程序化无贴图:点精灵双层 falloff(紧致亮核 e^{-7d²} + 宽散辉光 0.32·e^{-2d²})在加色混合下产生伪 bloom;核心暖黄白→中段蓝白→外缘冷蓝四段半径梯度 + 2.2% 橙红巨星;核球/盘面/远景三档以上亮暗层级。
- 核心经 Round 2 降亮修正后为暖色梯度而非死白;背景 RGB(5,8,16) 接近纯黑无色带。
- 扣分:无后处理链(色调映射/bloom),光比动态范围受直写帧缓冲限制,缺少真实照片级"亮部滚降"。

### 3. 动效流畅 — 3 / 3
- 星系 ω=0.05 rad/s 持续旋转(切向流动)+ 远景层 0.008 rad/s 反向漂移(视差参照)+ 65k 星独立相位/频率微闪烁;运动像素占比实测 0.3035(阈值 0.005 的 61 倍)。
- 相机交互全部指数平滑(视差 τ=200ms、距离 τ=350ms),无瞬跳、无过冲;60fps 满帧无抖动。reset 450ms easeOutCubic 补间,视觉角度连续不回跳。

### 4. 特效质感 — 2 / 3
- 伪 bloom 点精灵辉光、420 团沿臂星云薄雾(深蓝/紫/青)、巨星大尺寸光斑、暖星点缀;整体"望远镜长曝光"氛围成立(图像分析 overall 8/10)。
- 扣分:特效均为静态分布的加色 sprite,无动态高级特效(尘埃带遮蔽、电离氢红区、流星/超新星瞬态、拖尾);无 GPU 粒子模拟。

### 5. 交互反馈 — 2.5 / 3
- 指针视差即时平滑跟随;滚轮穿行近大远小构图明显变化(pixelDelta 0.525,阈值 53 倍余量);HUD 四项数据 8Hz 实时刷新(数值即 __bench 状态,距离随穿行逐帧滚动);Reset 按钮 hover/active 态 + 450ms 平滑复位,epoch 计数可查。
- 扣分:交互维度少(仅视差+穿行+复位),无点击拾取/目标聚焦类反馈。

### 6. 整体完成度 — 3 / 3
- 冻结合同全项达成:7/7 探针(状态+视觉双证据)、fps 60(2× 下限)、starCount 65000 且与几何体逐点一致、reset 可重复、零未捕获异常、构建一次通过;工程整洁(单文件 460 行,常量集中,注释完整)。

**六维合计:15.5 / 18 → visual = round(15.5 × 40 / 18) = 34 / 40**

## 二、用到的引擎能力清单

| 能力 | 用法 |
|---|---|
| BufferGeometry + 自定义顶点属性 | position/aColor/aSize/aSeed,65k+ 星点单次填充 |
| THREE.Points 批量渲染 | 星系 3 层 + 星云 1 层共 4 个 draw call 提交 65,420 点 |
| ShaderMaterial(自定义 GLSL) | 逐点尺寸衰减(300/z + clamp)、每星闪烁、双层辉光 falloff |
| 混合状态 | AdditiveBlending + transparent + depthWrite=false(发光体标准配置) |
| 场景图 | Group 层级(星系组/远景组独立角速度) |
| 透视相机手动 rig | position/lookAt 每帧解算,视差平移在观察正交基上 |
| 时钟增量步进 | dt 钳制 [0,0.1]s,后台节流恢复后相位正确推进 |
| WebGLRenderer | setPixelRatio/setSize、headless 下一次上下文创建成功 |
| DOM 覆盖层(引擎外,浏览器原生) | HUD/backdrop-filter/vignette,与 WebGL 画布叠加 |

未用到但值得记录的近路:addons(OrbitControls/EffectComposer)未使用 —— 本场景规格(视差+穿行而非环绕)更适合手动相机 rig;bloom 为保证 headless 环境 fps 余量主动放弃(能力存在,属选型决策非缺口)。

## 三、发现的引擎缺口

**无。** 本场景(E01 粒子星系)全部需求在 three@0.186.1 核心(无 addons)内闭环达成,未遇到任何 API 缺失、行为不符或性能墙:
- 65k 点 @60fps 无压力(headless chromium,软件/混合光栅化下同样满帧);
- ShaderMaterial/BufferGeometry/加色混合行为与文档一致,无版本迁移坑(r186 的 three.core.js 拆分由模板构建脚本正确处理);
- 唯一近似缺口是主观选择:真正的泛光后处理(EffectComposer+UnrealBloomPass)在 headless 采样环境下有 fps 回归风险,故以着色器内伪 bloom 替代 —— 引擎能力本身可用,不计入 engineLimitations。
