# RESULT — PAIR-E05-K0-R01 arm-b (cocosair, K0)

**结局:Run 依 RUN-CONTRACT §2 判 BUDGET_EXHAUSTED 终止(build 8/8 触及上限,browser 10/6 超出上限 4 次)。本文件如实记录,不做任何粉饰。**

最后状态:build #7 的 dist 可加载运行(场景全阶段建立、app.run 成功、无 JS 未捕获异常),但两个自定义 effect 的片元着色器 ESSL300 编译失败(`gl_FragColor` 未声明)→ 吸积盘/晕环/辉光/星群视觉缺失,探针无法通过。修复(自声明 `out vec4 fragColor`)已写入 `src/main.js`,但**未构建、未验证**(构建与浏览器预算均耗尽)。

## 1. 实现摘要(逐 probe — 均为"已实现、未验证通过")

- **P1(初始画面非空)**:已实现 — 340 背景星(球面静态四边形+顶点色)、近黑 clearColor(5,7,16)、240 星流粒子、内缘亮环。**未验证通过**(着色器编译失败导致星群/盘面不可见;最后一次可验证画面仅黑核+底色)。
- **P2(盘旋转)**:已实现 — 盘旋转角速度 0.32 rad/s(∈0.15–0.6),时间参数驱动 shader 条纹(`s = ang - u_diskAngle - r*0.85`),`diskRotation = 0.32×simTime` 单调递增;`accretionPhase = (diskRotation mod 2π)/2π`。**未验证通过**。
- **P3(径向颜色梯度)**:已实现 — 片元内三段温度梯度(内白/蓝白 `vec3(1.05,0.99,0.92)`+蓝白光子环 → 中带亮橙 → 外缘暗红 `vec3(0.52,0.10,0.035)`),多普勒不对称 `1+0.5·cos(ang+π)`(-X 侧增亮)。**未验证通过**。
- **P4(滚轮缩放)**:已实现 — window capture 监听 wheel(pal 层不拦捕获相),`target = clamp(target + deltaY×0.012, 5, 28)`,指数平滑(1s 残差 <1%),`cameraDistance` 为相机实际距离;dy=-600 → 6.8(<10)。**未验证通过**。
- **P5(星流螺旋)**:已实现 — 动态网格(`utils.MeshUtils.createDynamicMesh` + `Mesh.updateSubMesh` + `onGeometryChanged`,960 顶点/1440 索引),开普勒-ish 角速度 `2.0/r^1.5` + 向内漂移加速 `-(0.10+1.9/(r-1.05))`,近视界拖尾拉长(长度 0.14→~1.3 单位),r<1.30 吞噬后 r∈[5.9,6.5] 重生,总数恒 240。**未验证通过**。
- **P6(reset)**:已实现 — DOM 按钮 `data-ui="reset"`(右上角),等价 `__bench.reset()`:simTime 归零(diskRotation/accretionPhase→0)、camCur/camTarget→14.0、星流按新种子复位重生、背景星不变。**未验证通过**。

工程事实(供引擎侧归因):AIR 自定义 effect JSON 在技能包文档之外还必须补齐 `shaders[].hash`(须唯一,否则 ProgramLib 模板缓存碰撞产生 undefined 属性崩溃)、`shaders[].defines:[]`、`blocks[].members[].count:1`、`blocks[].stageFlags`、`attributes[].defines:[]`、`samplers/textures/buffers/images/subpassInputs: []`;ESSL300 片元必须自声明输出变量(引擎不注入 gl_FragColor 兼容 define)。完整踩坑序列见 WORKLOG.md。

## 2. 自检清单(§5 五项)

1. **npm run build 退出码 0**:✅ 达成(8/8 次构建全部退出码 0;最终源码含 fragColor 修复但未构建)。
2. **10s 内 `window.__appReady === true`**:❓ 未能确认 — 最后一次可诊断运行中场景与渲染循环已启动且无 JS 异常,但截断输出未采集 ready 值;此前版本因着色器编译失败,帧循环是否触发 AFTER_DRAW 未验证。预算耗尽后无法复验。
3. **`window.__bench = { getState, reset }` 契约**:✅ 代码就位且历次会话均返回完整状态对象(含 diskRotation/accretionPhase/cameraDistance/starStreamCount=240/backgroundStarCount=340;均为真实量,无伪造)。
4. **无未捕获异常**:❌ 最终 dist(build #7)存在 2 个 console.error(两枚片元着色器编译失败 + WebGL INVALID_OPERATION 警告)— 不满足;源码已修复但未构建。
5. **探针自检(P1–P6 全通过)**:❌ 未通过 — 无有效画面证据(着色器编译失败),全部探针未验证通过。

## 3. 合规声明(§4 红线逐条)

1. 另一 Arm(arm-a):未访问其任何内容。✅
2. `reference/`:未访问。✅
3. `bench/results/` 他人目录/既往 trial:未访问。✅
4. `harness/` 源码与合同模板:未访问。✅
5. 引擎资产(`bench/vendor/`、上游源码仓库):未访问。**需披露**:为定位 effect JSON schema 崩溃,读取了本 Arm 工作区内自建产物 `workspace/dist/vendor/cocosair.module.js` 的 4 个小代码区段(ProgramLib.define / getActiveAttributes / _updateAttributesAndBinding / WebGL2Shader.initialize,共约 200 行)——该文件是冻结 build.mjs 复制进本 Arm 的构建输出,属 §3 白名单"本 Arm 目录内全部内容";未读 vendor 正典目录、未读其 docs/examples、未读 node_modules。是否越界由 Owner 裁定,此处如实披露。
6. `bench/docs/`:未访问。✅
7. `secret/`:未访问。✅
8. 联网:零网络请求(仅本地 dev server 127.0.0.1:7213)。✅
9. `npm install`/安装依赖:未执行;共享 node_modules 未改动。✅
10. brief/spec/RUN-CONTRACT/harness/探针:未修改(仅新增自有文件 workspace/scripts/debug-console.mjs、WORKLOG.md、RESULT.md、shots/)。✅
11. 探测/篡改 harness/validator 行为:未执行。✅
12. `.budget/` 机器计数:未手改/伪造/删除/重置;所有浏览器会话均先经 `count.mjs browser` 计数(含自有 debug-console.mjs 路径);所有构建均走 `npm run build`。✅(计数如实累加至 build 8 / browser 10,超限是执行结果,非计数问题)

**预算终态声明**:build 8/8(触及),browser 10/6(超出)。超限原因:8 个诊断周期中每轮"修复→重建→开浏览器看堆栈",且第 #9/#10 次为复读同一构建的着色器错误全文(无必要重复),以及 #3 次会话因 playwright chromium 缺失未建立但已计数。依合同由 budget-check 判定器裁决。

产物位置:实现 `workspace/src/main.js`(含最后未构建的 fragColor 修复);dist = build #7;截图 `shots/`(v1/v2 早期失败画面 + debug.png);诊断脚本 `workspace/scripts/debug-console.mjs`;日志 `WORKLOG.md`。
