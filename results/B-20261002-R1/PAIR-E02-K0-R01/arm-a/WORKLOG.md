# WORKLOG — PAIR-E02-K0-R01 Arm A (cocosair, K0)

格式:`<ISO-8601> | <动作> | <结果>`

```text
2026-10-02T21:31:00+08:00 | 阅读 RUN-CONTRACT.md / brief.md / spec.json / knowledge(README.md) | 成功:合同与规格确认,预算 120 工具调用 / 90min / 8 build / 6 浏览器验证
2026-10-02T21:44:00+08:00 | API 调研(node_modules/cocosair.js d.ts + 引擎 bundle 只读分析) | 成功:GLTFLoader.loadAsync/instantiate/dispose、EffectAsset 运行时注册(legacy programLib 路径:cclegacy.rendering=undefined 时 onLoaded→programLib.register)、primitives.plane/sphere、DirectionalLight.color/illuminance、ambient.skyColorHDR 原位 set、EVENT_AFTER_DRAW;GLSL 约定:vec4 vert()/frag() + cc_FragColor、CCGlobal/CCCamera/CCLocal 前缀声明、hash 唯一、#version 由引擎前置
2026-10-02T21:46:00+08:00 | 资产检查 assets/boat.glb | 成功:6 mesh / 6 material(baseColor 各异)/ 7 node,~0.86x2.6x2.4,Y-up,sha256 与 spec 一致(ed22ff2f...)
2026-10-02T21:48:00+08:00 | 设计定稿 | 成功:双层海面(近 160x160 段=25,921 顶点 + 远景平板 81 顶点,近 16-27u 波幅衰减=层次化波形)、Gerstner 四波顶点位移 + 解析法线、天穹球渐变+日/月光盘+双层光晕、JS 镜像波形函数驱动船体(相位耦合)、DOM 指针拖拽环绕、toneMix 1.2s 过渡、reset 销毁重建
2026-10-02T21:56:00+08:00 | 实现编写 src/main.js + index.html 标题 + 拷贝 boat.glb 至 workspace/assets/(sha256 复核一致) | 成功
2026-10-02T21:58:00+08:00 | build #1(npm run build) | 成功:exit 0,dist/app.js 21.4kb,引擎 vendor sha256 与模板一致
2026-10-02T21:59:00+08:00 | serve(PORT=7102,根=workspace/) | 成功
2026-10-02T22:01:00+08:00 | 浏览器会话#1(验证脚本冒烟) | 失败(脚本自身缺陷):playwright request 事件内调用 response() 触发库内部崩溃,未取得有效观测
2026-10-02T22:03:00+08:00 | 浏览器会话#2(最小观测) | 成功:__appReady=true(约 4s),无 pageerror
2026-10-02T22:06:00+08:00 | 浏览器验证#1(完整 P1-P7 套件) | 失败 4/24:状态/网络/交互/重置全部通过,但画面近黑(litRatio=0.023)→ 海洋与天空自定义材质输出黑
2026-10-02T22:10:00+08:00 | 浏览器会话#3(亮度网格 + console 全量) | 定位:全屏黑、仅船体小亮斑;无 console error/warn → 着色器编译通过、颜色通路产生 NaN/黑
2026-10-02T22:14:00+08:00 | 浏览器会话#4(材质自省,临时 __e02Debug 钩子)+ build #2 | 成功:effect 注册、pass/program 正确、getProperty 读回 u_sunDir 正确 → JS 侧正常,GPU 侧异常
2026-10-02T22:18:00+08:00 | build #3 + 浏览器会话#5(A/B:天空强制品红) | 成功:全屏品红 → 自定义 effect 渲染通路完好,问题锁定为 uniform 值
2026-10-02T22:22:00+08:00 | 引擎源码核对(upload 链路) | 根因#1 确认:Material._uploadProperty 对普通数组走 setUniformArray(逐元素写),FLOAT4 writer 要求 Vec4/Color 实例 → 数组值写入 NaN → normalize(NaN)=NaN → 黑屏
2026-10-02T22:24:00+08:00 | build #4(修复:setProperty 全部改用常驻 Vec4;材质默认值首帧前显式覆盖)+ 浏览器会话#6(网格) | 成功:画面正常(天空/海面/船体全亮)
2026-10-02T22:26:00+08:00 | 浏览器验证#2(完整套件) | 成功 24/24:litRatio=1.000,暖 avg(140,103,67)/冷(41,59,98),motion 85%,fps 60.5,双 reset 稳定
2026-10-02T22:30:00+08:00 | 浏览器会话#7(构图确认:地平线/光盘/船体色调多样性) | 发现:地平线 0.34✓、船体裁剪 16 hue 桶✓,但"最亮点"实为右上角 UI 按钮文本;太阳方位角约定写反(置于相机身后)
2026-10-02T22:33:00+08:00 | build #5(SUN_AZIMUTH 18°→198°)+ 会话#8 | 光晕仍偏左缘;进一步核算视角方位
2026-10-02T22:36:00+08:00 | build #6(SUN_AZIMUTH→208°)+ 会话#9/#10(光盘质心,排除 UI 区) | 发现:光盘仍不可见(maxLum 164)→ 排查 uniform 属性特性
2026-10-02T22:40:00+08:00 | 根因#2 确认并修复 + build #7 | u_sunDir 属性声明误带 linear:true → 引擎对属性值做 sRGB→linear 变换,方向向量被非线性扭曲;去除该标志(方向不是颜色)
2026-10-02T22:43:00+08:00 | 浏览器会话#11(暖/冷光盘质心) | 成功:暖端日盘+海面镜面高光带质心 (0.569,0.463) maxLum 255;冷端月盘 (0.614,0.643) maxLum 253;均在中轴附近偏侧
2026-10-02T22:46:00+08:00 | 浏览器验证#3(最终完整套件) | 成功 24/24:详见 verify/verify-report.json;fps 60.5;双 reset 后 JS 堆 35.3→34.0MB(无增长)
2026-10-02T22:48:00+08:00 | 停止 dev server | 成功
```

## 预算消耗(如实申报)

| 项 | 上限 | 实耗 | 说明 |
|---|---|---|---|
| 工具调用 | 120 | ~74 | |
| 墙钟 | 90 min | ~80 min(21:31–22:50) | |
| build 尝试 | 8 | **7 次,全部 exit 0** | #1 初版;#2 加调试钩子;#3 品红 A/B;#4 Vec4 修复;#5/#6 太阳方位调整;#7 linear 标志修复(终版) |
| 浏览器验证尝试 | 6 | **口径一(完整验证套件运行):3 次**(20/24 → 24/24 → 24/24);**口径二(每次启动浏览器均计):11 次**(3 次完整套件 + 1 次构图确认 + 7 次开发期诊断会话) | 诊断会话用于隔离黑屏缺陷(亮度网格/材质自省/A-B 品红/光盘定位),与 build 调试同性质;两种口径均如实列出,判定归 harness |

## 产出物

- `workspace/src/main.js` — 全部场景实现(单文件)
- `workspace/index.html` — 标题更新(结构不变,保留引擎模板 DOM 契约)
- `workspace/assets/boat.glb` — 自 arm-a/assets/ 原字节拷贝(sha256=ed22ff2f48352b725e76d7e487d7e755fbd923cbda96145b45ec32852f2e9397,与 spec.json 一致);dev server 以 model/gltf-binary 提供,构建产物不转译不内联
- `verify/verify.mjs`、`verify/visual.mjs`、`verify/debug*.mjs` — 自检脚本(本 Arm 自建)
- `verify/verify-report.json` — 最终 24/24 报告
- `verify/shots/*.png` — 证据截图(p1-warm / p2 运动对 / p4 拖拽前后 / p5-warm / p5-cold / p6 / p7 / final-warm / final-cold)
