# RESULT — PAIR-E05-K0-R01 Arm A(three.js r186 / K0)

> 场景 E05「黑洞吸积盘」。实现位于 `workspace/src/main.js`(全程序化,零外部资产),
> 产物 `workspace/dist/`。自检脚本 `workspace/scripts/e05-verify.mjs`,截图证据 `workspace/.tmp/e05-*.png`。
> 过程与全部 build/验证记录见 `WORKLOG.md`。

## 1. 实现摘要(逐 probe)

**统一架构**:three.js 场景图 —— fBm 冷色星云天空球 + 460 颗静态星点(Points,加色混合,像素尺寸无衰减)/ 面向相机的纯黑事件视界圆盘(半径 1.15,先写深度 → 遮挡盘后缘与被吞噬粒子)/ 吸积盘 RingGeometry(r=1.8~6.5,256 段,置于水平面,相机仰角 55° 俯视)/ 透镜光环 billboard(光子环+上弧增亮)/ 宽域暖辉光层 / 224 粒星流(面向速度方向拉伸的软边四边形)/ EffectComposer(UnrealBloom 0.38 + OutputPass,ACES tone mapping,HalfFloat+4xMSAA)/ composer 之后"事件视界保黑盖章"通道(按解析投影半径把暗核压回纯黑,免疫 bloom 弥散)。相机固定方向环视原点,滚轮指数缩放 [5,28],指数平滑插值(1s 残差<1%)。UI:DOM 按钮 `data-ui="reset"` 右上角 + 缩放提示文字。

- **P1(初始画面非空、盘可见、暗核存在)**:中心 1/3 非黑 92.32%(≥5%),四角外围非黑 83.99%(≥1%,星点+微星云),中心连续暗核半径 48px(初始视距下约占画面高 13%,8–15% 契合),暗核外亮环平均亮度 225(纯黑盖章保证暗核不被 bloom 弥散洗白)。
- **P2(盘旋转运动)**:条纹图案为刚体螺旋纹(5 臂 + log r 缠绕 + 随转 fBm 颗粒),由 `uRot`(=diskRotation)时间参数连续驱动,0.42 rad/s(0.15–0.6 内);0.8s 采样差 0.399 rad(≥0.1),盘面环形屏幕区两帧差分 34876 px(采样步长 2,≥阈值)。
- **P3(径向颜色梯度)**:盘 Shader 径向温度带 内白蓝 (0.85,0.93,1.10) → 琥珀 (1.0,0.62,0.25) → 暗红 (0.68,0.075,0.018);实测内环带(55–130px)平均亮度 212.5 vs 外环带(230–320px)57.1(比 3.72 ≥1.5),内环带 R-B=-2.7(≈白蓝)vs 外环带 +18.4(Δ=21.1);径向亮度自内向外 8 环带单调衰减(224→21,无硬边);辉光观感由 UnrealBloom + 多层加色径向衰减(内外缘 smoothstep 淡入淡出、宽域暖晕、光子环高斯)共同实现,路径为叠加式混合+后处理组合(brief §2 允许任意路径)。
- **P4(滚轮缩放构图变化)**:`wheel` 事件指数映射 `target *= exp(dy·0.0012)`,夹紧 [5,28];wheel dy=-600 → 距离 14→6.832(<10,≥5);暗核屏幕半径 48px→102px(2.13x ≥1.25),平滑插值 1s 内基本到位(残差<1%);距离全程处于 [5,28]。
- **P5(星流螺旋)**:224 粒子(≥200,恒定)沿 Kepler 式螺旋内落(ω=2.6/r^1.5,内落 0.28+2.3/r²),近视界加速、沿速度方向拉长拖尾(软边四边形,长度∝速度),r<视界即在外圈(6.8–9.2)重生;中环带两帧差分 66308 px(运动证据);越入暗核背面的粒子被视界深度遮挡(吞噬观感)。
- **P6(reset)**:DOM 按钮 `click` → diskRotation=0、accretionPhase=0、cameraDistance 立即回 14.0、星流按确定性种子复位、背景星不变、`__appReady` 保持 true;实测 400ms 后 dist=14.0(±0.5 内)、rot=0.168(<0.3)、phase=0.027(<0.1)、stream=224,画面完整(非黑 91.29%,暗核 48px 回到初始占屏比)。

**加分项**:多普勒不对称(approaching 侧 1.75x 增亮 + 蓝移,receding 侧减暗)与引力透镜观感(光子环 + 上弧增亮光环 + 盘后缘被视界遮挡的包绕感)均已实现。

**禁止项对照**:无预渲染素材/贴图序列/逐帧回放(全程序化 Shader 与几何);旋转为时间参数驱动的真实连续动态(uRot=diskRotation 直接驱动画面);`getState()` 全部为真实状态(diskRotation 即 Shader 驱动角、cameraDistance 即相机实际距离、粒子数即实例数);assets=[] 契约遵守(无任何图片/视频/网络资源);无自动化环境特判。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run build` 退出码 0(workspace/ 根) | ☑ PASS | build#6,app.js 20.4KB < 256KB,自检 OK |
| 2 | 10s 内 `window.__appReady === true` | ☑ PASS | 实测 389ms |
| 3 | `window.__bench = { getState, reset }` 契约成立 | ☑ PASS | 5 个状态字段全暴露、真实数据;reset 语义实测通过(P6) |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | ☑ PASS | 6 次浏览器验证全程 0 console error / 0 pageerror |
| 5 | 探针自检:spec.json 6 探针逐条(state + 视觉/运动) | ☑ PASS | `E05_ALL_PASS`(末次运行全项,见 WORKLOG 终版记录) |

预算结算:build 6/8 · 浏览器验证 6/6 · 工具调用 ~25/120 · 墙钟 ~50min/90min。

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. ☑ 未访问另一 Arm 的任何内容(目录/代码/日志/服务器/截图/结果)。
2. ☑ 未访问 `bench/reference/`。
3. ☑ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录与一切既往 trial 结果(本 Run 的全部读写均在 `.../PAIR-E05-K0-R01/arm-a/` 内)。
4. ☑ 未访问 `bench/harness/` 源码与合同模板。
5. ☑ 未访问引擎源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。
6. ☑ 未访问 `bench/docs/`。
7. ☑ 未访问 `bench/secret/`。
8. ☑ 无任何联网行为(无文档/搜索/registry 请求;页面运行时零网络请求,引擎与依赖全部 vendored)。
9. ☑ 未执行 `npm install` 或任何依赖安装(仅使用模板内 vendored 的 three/esbuild/playwright-core;playwright-core 仅驱动本地 Chrome 做自检,不产生网络请求)。
10. ☑ 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针代码与探针结果文件(仅新增 workspace/src/main.js 实现、workspace/scripts/e05-verify.mjs 自检脚本与本 Arm 的 WORKLOG.md / RESULT.md)。
11. ☑ 未探测、未篡改 harness/validator 行为与期望值(自检脚本为 Arm 自有像素/状态分析,阈值保守自制,未针对任何未知冻结阈值做特判或拟合)。

—— 本 Run 为一次性 R0 自主模式执行,完成合同 §5 全部五项。
