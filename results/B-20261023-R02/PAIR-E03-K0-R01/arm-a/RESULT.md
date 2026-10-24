# RESULT — PAIR-E03-K0-R01 arm-a(three / K0)

日期:2026-10-23 · 引擎:three@0.186.1(r186)· 知识等级:K0(仅 npm README + 模板样例,无 docs/examples/技能包)
预算使用:build 1/8 · browser 3/6 · 实际工具调用远低于 120 · 墙钟约 20 分钟

## 1. 实现摘要(逐 probe)

| Probe | 实现路径 | 自检结果 |
|---|---|---|
| P1 初始画面 + 公转分层 | 中心恒星(发光球 + 双层加性光晕)+ 8 颗行星按轨道半径 14–80 分层 + 900 小行星带 + 1100 背景星 + 8 条细淡轨道线;周期 200→3400 模拟秒单调递增 | PASS:counts=[8,3,900,1]、timeScale=1、sel=null;2s 窗 Δangle 内 0.0631 > 4×外 0.0037;fps≈57;截图非空(恒星光晕为最亮元素) |
| P2 点击 earth 选中 | 每帧更新 pickTargets(投影中心 + screenRadius≥8.5px);pointerdown/up 位移 <6px 判定为点击 → Raycaster 对 8 颗行星球体求交,最近命中者选中,否则取消;选中显示始终朝向相机的亮黄描边环 | PASS:点击 (633.9,345.9,r=14) → selectedPlanet="earth";高亮环截图可见 |
| P3 信息卡 | data-ui="info-card" DOM 卡:名称 + Type/Orbital period/Orbit radius/Planet size 四字段,与状态同源数据;镜像 __bench.infoCard | PASS:{visible:true,name:"earth",fieldCount:4};DOM 文本核对一致 |
| P4 切 8x | 五档按钮 data-ui="speed-0.5x…speed-8x"(可见文本 0.5x–8x),当前档高亮(黄底 + aria-pressed) | PASS:timeScale=8;五档按钮与 reset 均在 DOM |
| P5 8x 真实变速 | timeScale 只改模拟时钟速率;角度连续积分(不按时间重算),变速即时无跳变 | PASS:1.5s 窗 Δsim=12.08s(≥6)、Δangle=0.3794rad(≥0.05),为 1x 基线的 8 倍 |
| P6 Reset | 同步恢复:simTime=0、timeScale=1(含 UI 高亮)、取消选中/关卡、角度回 k×45°、小行星带与卫星用确定性种子复位;无页面刷新 | PASS:epoch=1、timeScale=1 |
| P7 reset 后状态 | 同上 | PASS:simT=0.9(<2.5)、sel=null、card=false、a0=0.0283(±0.08)、a7=5.4995([5.43,5.56]);渲染与运动持续 |
| P8 切 0.5x | 同 P4 | PASS:timeScale=0.5 |
| P9 空白负对照 | 射线未命中任何行星 → select(null);点击 canvas 与 UI 按钮分离 | PASS:点 (0.08,0.08) 比例处 → sel=null、卡片 display:none |

分层结构:行星-卫星为真实父子层级(卫星 mesh 挂在行星 Group 下,随行星公转,earth 1 颗 + jupiter 2 颗,周期 20/12/30 模拟秒);小行星带为独立 InstancedMesh(900 个独立小天体,带内周期 700–1250s 内快外慢 + 各自翻滚);土星环 = 双层半透明环面 + 0.44rad 轴倾角(初始俯视角下可辨)。

构图校准:相机 fov55、位姿 (0,85.6,101.9) lookAt(0,0,30) —— 解析计算 + 截图复核:海王星轨道横跨约 66% 画面宽,8 颗行星投影全部在视口内且 screenRadius ≥ 8.5px(最小 mercury 8.8px),四角留空(P9 空白角点距全部 pickTargets ≥ 80px)。

## 2. 自检清单(完成合同 §5)

- [x] 1. `npm run build` 退出码 0(build #1,自检 OK;产物 dist/ 被 index.html 经 import map 引用)
- [x] 2. 页面 10s 内 `window.__appReady === true`(三次会话均立即就绪)
- [x] 3. `window.__bench = { getState, reset }` 契约成立(benchReady=true;字段全覆盖 stateContract)
- [x] 4. 无未捕获异常(三次会话 consoleErrors=0、uncaught=[])
- [x] 5. spec.json probes P1–P9 状态断言逐条复算全 PASS(浏览器验证 #2 allOk=true;视觉断言以截图 check1-final.png / check2-selected.png 与运动学数值佐证:分层公转比、8x 角增量、reset 角度回归)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm(arm-b)的任何内容。2. 未访问 reference/。3. 未访问 bench/results/ 下其他目录或既往 trial。4. 未读 harness/ 源码与本合同模板。5. 未读 bench/vendor/ 及引擎上游源码仓库(three.js r186 源码树、cocosair.js 仓库);引擎知识仅来自 knowledge/ 内 README 与模板样例 src/main.js(原样保留的起点)。6. 未读 bench/docs/。7. 未读 secret/。8. 全程无网络请求(dev server 仅本机 127.0.0.1:7208;浏览器无外部资源加载,纹理/星点全部程序化生成)。9. 未执行 npm install、未改动共享 node_modules。10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码与探针结果文件。11. 未探测或篡改 harness/validator 行为与期望值。12. 未手改/伪造/删除/重置 workspace/.budget/ 计数文件;build 仅经 `npm run build`(自动计数),浏览器会话仅经 scripts/verify-browser.mjs(先计后开);仅创建 workspace/.shots/ 存放自证截图。

附加声明:K0 知识面严格限于 arm-a/knowledge/(README)+ 模板代码;实现中的 API 用法来自模型先验与模板样例,未查阅任何引擎文档/示例源码。
