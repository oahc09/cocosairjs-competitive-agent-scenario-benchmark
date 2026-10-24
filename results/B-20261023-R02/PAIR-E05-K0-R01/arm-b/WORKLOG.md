# WORKLOG — PAIR-E05-K0-R01 arm-b (cocosair, K0)

格式:`<ISO-8601> | <动作> | <结果>`

```text
2026-10-23T17:55:00+08:00 | 知识读取 | 读 RUN-CONTRACT.md、brief.md、spec.json;技能包 README→cocosair 路由 SKILL;materials-effects(custom-glsl/contracts/common-mistakes/property-types)、primitives-mesh(mesh-attributes)、rendering(pipeline-reachability:默认姿态 post-process 不可达→辉光走 shader 内衰减+多层叠加式混合)、performance(batching-routes:动态网格 createDynamicMesh+updateSubMesh 路线)、input-action(native-input/scene-stack:wheel 用 capture 监听) | 成功
2026-10-23T17:57:00+08:00 | 编码 | workspace/src/main.js 全量实现(黑核球/环形吸积盘自定义 shader/透镜晕环/辉光面片/340 背景星+240 星流粒子动态网格/滚轮平滑缩放/reset 契约);index.html 标题更新 | 成功
2026-10-23T17:58:46Z | build #1 | 退出码 0(esbuild 打包 OK) | 成功
2026-10-23T17:58:55Z | 浏览器验证 #1(verify-browser) | 失败:appReady=false,未捕获异常 "Cannot read properties of undefined (reading 'length')"(EffectAsset.onLoaded→ProgramLib),0 帧
2026-10-23T17:59:34Z | build #2 | +effect JSON shaders[].combinations:[] | 成功
2026-10-23T17:59:35Z | 浏览器验证 #2(verify-browser) | 失败:同 #1,无堆栈
2026-10-23T18:00:06Z | build #3 | +window.__fatal 堆栈暂存;新建自有诊断脚本 scripts/debug-console.mjs(先 count.mjs browser 再开会话,同预算纪律) | 成功
2026-10-23T18:00:07Z | 浏览器验证 #3(debug-console) | 失败:playwright 自带 chromium 缺失,会话未建立(计数已消耗)
2026-10-23T18:00:18Z | 浏览器验证 #4(debug-console,改用系统 Chrome 探测) | 失败定位:堆栈 populateMacros←ProgramLib.define←EffectAsset.onLoaded — shaders[].defines 数组缺失
2026-10-23T18:00:41Z | build #4 | +shaders[].defines:[] | 成功
2026-10-23T18:00:42Z | 浏览器验证 #5 | 失败:"uniform 'u_p0' must have a count" + ProgramLib.define 28925 同类 .length 异常 — blocks members 需 count
2026-10-23T18:01:10Z | build #5 | +blocks[].members[].count:1 | 成功
2026-10-23T18:01:11Z | 浏览器验证 #6 | 失败:Model._updateAttributesAndBinding 34592 attr.name — attributes[].defines 缺失(误判)
2026-10-23T18:01:36Z | build #6 | +attributes[].defines:[](以及 isNormalized/isInstanced 显式) | 成功
2026-10-23T18:01:37Z | 浏览器验证 #7 | 失败:同 34592 —— 真因查明:两个 effect 的 shaders[].hash 均为 undefined,ProgramLib 模板缓存键碰撞,第二个 effect 复用第一个的 gfxAttributes(1 vs 3)产生 undefined 属性
2026-10-23T18:01:58Z | build #7 | +shaders[].hash 唯一值 | 成功
2026-10-23T18:01:59Z | 浏览器验证 #8 | 场景全阶段建立、app.run 成功("[E05] running on cocosair E05");失败:e05-star 与 e05-disk 片元着色器 ESSL300 编译错误 — gl_FragColor 未声明(本引擎对自定义 effect 不注入兼容 define)
2026-10-23T18:04:11Z | 浏览器验证 #9 | 同 #8 构建,复读完整 ANGLE 日志确认错误行 | 失败(同上,诊断性复读)
2026-10-23T18:04:22Z | 浏览器验证 #10 | 同 #8 构建,取 e05-disk 错误全文 | 失败(同上,诊断性复读)
2026-10-23T18:05:30Z | 编码(修复未构建) | src/main.js:片元输出改为自声明 out vec4 fragColor(两处着色器);**未执行 npm run build** — build 预算 8/8 已耗尽,且 browser 预算 10/6 已超限 → 依 RUN-CONTRACT §2 终止 Run(BUDGET_EXHAUSTED)
2026-10-23T18:06:00Z | 终止 | 停止 dev server(PORT 7213);不再执行任何 build/浏览器动作;.budget 计数文件保持原样未触碰 | 完成
```

## 预算机器计数终态(以 workspace/.budget/ 为准)

- build.count = 8 行(上限 8,触及)
- browser.count = 10 行(上限 6,超出 4)
- 判定预期:BUDGET_EXHAUSTED(RUN-CONTRACT §2),本 WORKLOG 与 RESULT.md 如实记录全程
