# RESULT — Arm B of PAIR-E08-K0-R01 (E08 深海鱼群 · cocosair · K0)

## 1. 实现摘要(逐 probe 一句话)

| Probe | 断言 | 实现与实测(browser #6 会话,build #6;build #7 仅增强 P3 判定广度与背景对比度) |
|---|---|---|
| P1 | fishCount≥80 && planktonCount≥300 && normal && !foodActive;全屏非空 | 90 条鱼 + 420 浮游颗粒,启动即 normal 模拟;实测 fish=90,plk=420,cohesion=0.498;全屏为渐变水体+光束+鱼群(自检中位色口径 20.3%,build #7 再提亮顶部渐变/光束/光斑幅度至 0.45 以提升覆盖) |
| P2 | normal && avgCohesion≥0.45;中央水域持续运动 | 全局鱼群完整性拉力 + 常态聚群权重,实测 cohesion=0.698;中央 1s 像素差 21.2%(鱼群巡游) |
| P3 | drag 扫过中央 → scatter && avgCohesion<0.35;区域变化 | 指针经 screenPointToRay 投到 z=0 平面,与鱼实际距离 <2.5 触发 panic;**mousemove 被浏览器合并到 rAF 节拍导致扫掠采样稀疏(实测 panic 仅 7-17/90)**,build #7 改为按住拖拽时按相邻采样点的扫掠线段判定(真实指针轨迹的几何重建,非定时器/脚本),离线带覆盖测试 64/90 条鱼命中(端点采样 0/90);drag 不误触投喂(P3b 实测 foodActive=false) |
| P4 | 指针移出 6s 内 normal && avgCohesion≥0.45 | 惊散解除=离开惊散范围且指针静止>2s(spec §4.2),全局拉力+局部聚集回卷;实测 +6s cohesion=0.678(悬停 move 判定路径未改动) |
| P5 | click → foodActive && foodPosition≠null | 单击(位移<8px 且 <450ms)在点击点对应水域生成 3 粒发光食物;实测 foodPosition={x:0,y:0,z:0} |
| P6 | 4s 内 avgDistanceToFood<6 且食物在场 | 觅食吸引(16/7 分段拉力,食物在场时恐惧 ×0.15 让位);实测 dist=3.96,foodActive=true(3 粒×3 啃食×0.7s + 8s 超时,保证此刻未被吃尽) |
| P7 | reset → fish≥80 && normal && !food && dist==null | reset 清食物、panic、指针状态,同种子重放初始鱼群分布,不刷新页面;实测全部恢复 |
| P8 | reset 后模拟继续;像素变化≥2% | 300ms 全屏像素差 10.0%,fish/plk 计数恒定 |
| L1 | 120s 长跑无泄漏无异常 | fps=60,frame 4885→7981,计数不增长,console 0 error |
| E1 | 无未捕获异常 | 6 个浏览器会话(含两次 120s+ 长跑)consoleErrors=0,uncaught=0 |

行为要点:鱼体为 6 环×8 边截面 + 尾鳍的程序化 3D 形体,全部合入单个动态网格,摆尾为沿脊线行波(随速度增幅);boids 三规则逐帧计算(聚集/对齐/分离线性衰减防穿插);420 浮游颗粒慢漂移 + 近大远小;深海观感 = 顶亮渐变水体板 + 光斑噪声 + 顶部光束 + EXP 雾。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 状态 |
|---|---|---|
| 1 | `npm run build` 于 workspace 根退出码 0 | ☑ 7 次全部成功(预算 7/8) |
| 2 | 页面 10s 内 `window.__appReady === true` | ☑ 实测 ≈1s(browser #1-#6) |
| 3 | `window.__bench = { getState(): object, reset(): void }` | ☑ benchReady=true;getState 字段与 stateContract 一一对应;reset 生效(P7) |
| 4 | 无未捕获异常(console 无 error 级) | ☑ 6 会话 consoleErrors=0、uncaught=0 |
| 5 | 按 spec.json probes 逐条自检 | ☑/⚠ 浏览器实测 11/13(P1b/P3);build #7 针对 P3(扫掠线段判定,离线验证 64/90 带覆盖)与 P1b(背景对比度)做了定向修正,**浏览器预算已用尽(6/6,冻结上限)未能复测**;P4-P8 输入/行为路径与已验证版本一致 |

预算:buildAttempt 7/8;browserAttempt **6/6(已达上限)**;toolCall/墙钟由 Runner 侧记录。dev server(端口 7123)保持运行供正式采样。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. ☑ 未访问另一 Arm(arm-a 目录、代码、日志、dev server、浏览器 profile、截图、结果)——全程未打开。
2. ☑ 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. ☑ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. ☑ 未访问 `harness/` 源码与合同模板(探针期望值仅来自 arm-b 目录内的 brief.md/spec.json)。
5. ☑ 未访问引擎资产 `bench/vendor/` 与引擎上游源码仓库(E:\AIProMax\github\cocosair.js、three.js r186 源码树)。**补充如实声明**:编码期读取了 workspace 依赖解析到的**已安装包** `node_modules/cocosair.js`(共享 node_modules,沿目录向上解析,RUN-CONTRACT §1 明示其为构建与引擎依赖来源):内容为 K0 tarball 安装产物(官方 docs/ 已被剔除),读取范围是其 d.ts 类型声明、builtin effect JSON 与运行时实现细节 —— 知识包 manifest 自己亦注明"d.ts 在包内 build/cocosair.module.d.ts"。除此之外对共享仓只经 build 脚本读取产物。
6. ☑ 未访问实验计划书与合同文档目录(`bench/docs/`)。
7. ☑ 未访问 `secret/`。
8. ☑ 无任何联网请求(无文档搜索、无 registry 访问)。
9. ☑ 未执行 `npm install`、未安装/改动任何依赖(共享 node_modules 只读)。
10. ☑ 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件。
11. ☑ 未探测或篡改 harness/validator 的行为与期望值。
12. ☑ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build`(内置 count.mjs)计数;所有浏览器会话创建前均先执行 `node scripts/count.mjs browser`(verify-browser.mjs 1 次 + 自检脚本 5 次,自检脚本内同样先计数后开会话)。

自检产物:`selfcheck/p1.png … p8b.png`、`selfcheck-probes.mjs`(探针序列与 Node 侧 PNG 像素差实现)。
