# WORKLOG — PAIR-E05-K0-R02 / arm-a (cocosair, K0)

> 每次构建 / 浏览器验证一行(RUN-CONTRACT §6)。时间戳为本地 +08:00。

```text
2026-10-06T07:45+08:00 | 读取 RUN-CONTRACT/brief/spec/knowledge(README+manifest)/模板(template-verify/manifest/main.js/scripts) | 成功,建立 K0 心智模型
2026-10-06T07:52+08:00 | 引擎 API 逆向(白名单内:本 Arm workspace/dist/vendor/cocosair.module.js 静态提取) | 成功:EffectAsset/Material.initialize({effectAsset})/effect JSON 结构/unlit glsl4 约定/toGlsl3 规则/additive pass 状态/createDynamicMesh(indices16 键)/Mesh.updateSubMesh 签名
2026-10-06T08:17+08:00 | 实现 src/main.js 全场景(自定义 effect×4、星空 600、核球、吸积盘、光子环+光晕、星流 220、滚轮缩放、reset、__bench 状态通道)+ index.html 深空底色 | 完成
2026-10-06T08:17+08:00 | build #1 (npm run build) | 成功(退出码 0)
2026-10-06T08:18+08:00 | serve: PORT=7136 node scripts/serve.mjs | 成功,GET / 200
2026-10-06T08:18+08:00 | 浏览器验证 #1(verify-browser,--shot+全探针 eval) | 失败:动态网格在 createAirApp 前创建(Mesh.initialize 需 gfxDevice)→ "reading 'createBuffer'" 未捕获
2026-10-06T08:19+08:00 | 修复:createStreamMesh() 移入 createAirApp 之后;发现并修复 accretionPhase 键拼写 | 完成
2026-10-06T08:19+08:00 | build #2 | 成功
2026-10-06T08:20+08:00 | 浏览器验证 #2(全探针 eval) | 部分成功:__appReady=true、六探针 state 断言全过(P1-P6)、rotDelta=0.368rad/0.8s;视觉两张图判定两处伪影:①星流索引键错误(indices→indices16)致非索引绘制=跨粒子长线;②光晕/光子环 quad 的 v_local.xz 基底错位=竖直椭圆环伪影
2026-10-06T08:24+08:00 | 修复:indices16 键(填环循环同步改名)、星点尺寸调小 | 完成(填环循环漏改 → 下一次构建失败)
2026-10-06T08:24+08:00 | build #3 | 失败?构建成功但运行时 "Cannot set properties of undefined (setting '0')":填环循环仍引用 g0.indices
2026-10-06T08:24+08:00 | 浏览器验证 #3 | 失败(即上述运行时错误,app 未启动)
2026-10-06T08:25+08:00 | 修复:填环循环改用 g0.indices16 | 完成
2026-10-06T08:25+08:00 | build #4 | 成功
2026-10-06T08:26+08:00 | 浏览器验证 #4(全探针 eval+截图) | 成功:appReady=true、无未捕获、六探针 state 全过(rotDelta 0.3598/0.8s、P4 dist=8、P6 全项);但 console error 367 条(每帧一条)+ 截图仍有光晕伪影(初判 "euler 弧度口径" 为误诊)
2026-10-06T08:26+08:00 | 浏览器验证 #5(稳态 console 捕获) | 诊断:稳态零 error → error 全部发生在启动后逐帧(engine 捕获组件异常并 console.error)
2026-10-06T08:28+08:00 | 复盘:竖直环实为光晕 quad 基底错位伪影(两帧逐字节相同,与盘倾角无关);setRotationFromEuler 为角度口径 → 盘节点回退 TILT_DEG;光晕/光子环改为局部 XZ 平面 quad + 节点 Rx(90°−仰角) 朝向相机;index.html 增加 console 捕获钩子 | 完成
2026-10-06T08:30+08:00 | build #5 | 成功
2026-10-06T08:31+08:00 | 浏览器验证 #6(--shot + 读 __consoleErrors) | 诊断成功:画面正确(黑核锐利+光子环+多普勒右侧增亮+径向辐条+星流短拖尾+星空);console error 文本 = Mesh.updateSubMesh 读 dynamicGeometry.indices16.length 每帧 TypeError(每帧 update 未随 geometry 重传 indices16)。浏览器预算 6/6 用尽,此后不再开浏览器会话
2026-10-06T08:33+08:00 | 终修:每帧 updateSubMesh 传入 indices16(与创建调用同形,引擎源码逐行核对);曝光再平衡(halo 0.55→0.38、ring 0.85→0.62/0.20→0.16、盘 lum 1.30→1.10、alpha 钳 1.4→1.25);reset 星流改全量初始分布 | 完成(桌面核对,无浏览器会话可用)
2026-10-06T08:34+08:00 | build #6(最终) | 成功(退出码 0);bundle 自检:indices16 ✓ / setRotationFromEuler(TILT_DEG) ✓ / accretionPhase ✓
2026-10-06T08:36+08:00 | 写 RESULT.md、清理 serve 进程 | 完成
```

## 预算终值(机器计数)

- buildAttempt:6 / 8(`.budget/build.count` 6 行)
- browserAttempt:6 / 6(`.budget/browser.count` 6 行,**触及上限,此后未再开浏览器会话**)
- toolCall:由 Runner 侧记录

## 关键引擎事实(本 Arm 实测,供 gap-map 汇总)

1. `utils.MeshUtils.createDynamicMesh` 的索引键是 `geometry.indices16 / indices32`(不是 `indices`);传错键 → 无索引缓冲 → TRIANGLE_LIST 非索引绘制 → 跨粒子三角形(长线伪影)。
2. 动态网格 `createDynamicMesh` 内部立即 `Mesh.initialize()`(需 gfxDevice)→ 必须在 `createAirApp()` 之后调用;静态 `createMesh` 无此约束。
3. 带 indexView 的动态网格,每帧 `Mesh.updateSubMesh(idx, geo)` 必须随 geometry 重传 `indices16`,否则每帧 TypeError(引擎按帧 console.error,页面无未捕获)。
4. `setRotationFromEuler` 为**角度**口径(模板 Rotator 同口径)。
5. 自定义 effect 可行路径(K0 无文档,从本 Arm dist 内引擎 bundle 逆向):`new EffectAsset(name)` + shaders(glsl4 + toGlsl3 同规则转换)/techniques + `onLoaded()` → `Material.initialize({ effectAsset })`;uniform 块成员顺序须与 meta blocks 一致;属性名=成员名;FLOAT4 setProperty 必须传 Vec4。
6. 片元输出约定:`layout(location=0) out vec4 cc_FragColor;` + `sqrt(color.rgb)`(unlit 输出 gamma);无 CC_USE_HDR 定义时无 ACES。
7. canvas 鼠标事件被 pal 层吞:wheel 用 `window.addEventListener('wheel', fn, {capture:true})` 可靠接收。
