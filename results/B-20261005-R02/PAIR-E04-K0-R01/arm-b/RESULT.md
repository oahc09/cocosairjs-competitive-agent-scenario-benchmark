# RESULT — arm-b PAIR-E04-K0-R01(E04 城市烟花夜 / cocosair / K0)

## 1. 实现摘要(逐 probe 一句话)

技术路线:固定透视相机把场景当 2D 平面用;全部视觉经 WebGL 管线绘制(共享 1×1×1 box 网格 + Node/MeshRenderer + 克隆 unlit 材质逐色着色,z 向 scale 压 0.02 避免透视放射条纹);粒子物理在归一化屏幕坐标(y 向上)以真实 dt 步进(clamp 0.05s 防失焦跳变);点击走引擎 `input.on('mouse-down')`(pal 会吞 canvas 原生事件),`getLocationInView`(左上原点)→ `getLocation`(左下原点)双路径换算;发射时一次性把点击的"自上原点"换轴到内部"自下原点"坐标。

| Probe | 实现要点 |
|---|---|
| **P1 初始夜景** | 26 栋程序化楼(高 8%–45%、宽 1.5%–6%,无外部资产)+ 亮窗 ≥96 颗兜底(spec ≥80)+ 124 颗背景星(≥120)+ 26 段夜空垂直渐变条带(顶部近黑 → 地平线蓝紫微亮)+ 4 盏红色航空障碍灯缓闪;自检:warmBottom=1055、星点亮像素 469、剪影亮度 11.8 显著低于地平线带 24.5。 |
| **P2 点击发射** | 引擎 input 收到点击后按点击横坐标从城市地面(nyTop≈0.78)发射,升空 0.62–1.4s(规格 0.6–1.6s),每 0.03s 持续 spawn 寿命 0.3–0.8s 的暖白尾迹;自检:点击 (0.5,0.30) 后 lastClick 精确等于 {0.5,0.30},fireworkCount 恰好 +1、尾迹带两帧运动差分 0.0364、亮带质心 y 0.577→0.478(自下而上)。 |
| **P3 爆炸** | 到达爆点(点击高度 ±3% 画面高,规格 ±5%)后每发生成 108–137 个爆炸粒子(规格 100–240,球面均匀方向 + 重力 g=0.13 + 阻力)+ 短寿命爆闪亮斑;自检:particlesAlive=143≥40,上半屏亮像素 376→5654,爆带质心 y≈0.41 与点击位 0.30 同侧(轴向修复生效)。 |
| **P4 衰减与余烬** | 爆炸粒子寿命 1.2–2.8s 随寿命收缩消亡;每发 16–21 颗余烬(≥12)分层寿命(60% 3–8s、40% 10–12s,符合 amendment 长尾 ≥30% 铺至 10–12s),持续下坠 + 亮度闪烁;自检:存活数 102→39→16→9 单调下降,~7.3s 时 9 颗 ∈[1,40),center-bottom 运动差分 0.00708 ≥ 0.005(与双 Reference 实测 0.0066–0.0107 同量级)。 |
| **P5 自动表演** | `data-ui="auto-show"` 切换 autoShow,开启后立即首发、之后 0.55–0.95s 随机间隔(规格 0.5–1.5s)随机位置/颜色发射;自检:4s 内 fireworkCount 1→6(≥4),常态 fps=57(≥30),上半屏亮像素 14203(多发连续爆发)。 |
| **P6 关闭自动表演** | 再次点击即关,发射停止;自检:autoShow=false,间隔 2.1s 两次采样 fireworkCount 8→8(Δ=0),既有粒子自然衰减。 |
| **P7 暂停** | `data-ui="pause"` 切换 enabled=false,update 直接返回:时间不累计、粒子/自动发射/星闪/障碍灯全部静止;自检:enabled=false,间隔 1000ms 两帧全画面差分 = 0.0(≤0.5% 阈值,完美冻结)。 |
| **P8 reset** | `data-ui="reset"` 与 `__bench.reset()` 同一函数:销毁全部粒子/火箭,fireworkCount=0、particlesAlive=0、autoShow=false、enabled=true,城市与星点重新随机生成(楼数不变);自检:五项状态精确归零、buildingCount=26、上半屏亮像素回落 352 ≈ 基线 376、城市剪影与亮窗完整。 |

统一契约:`__appReady` 在首帧(EVENT_AFTER_DRAW)置 true;`__bench={getState,reset}` 全部为真实数据(粒子数组长度、真实计数);reset 后 `__appReady` 保持 true;失焦回焦以 clamp(dt,0,0.05) 防累积跳变;update 全函数 try/catch 防单帧异常升级为未捕获错误。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. build 退出码 0**:`npm run build`(build #2,2026-10-05T10:05:24Z)退出码 0。
- [x] **2. 10s 内 `__appReady === true`**:verify-browser 实测 appReady=true(轮询判定,远小于 10s)。
- [x] **3. `__bench={getState,reset}` 契约成立**:benchReady=true,getState 返回五个真实字段,reset 可用。
- [x] **4. 无未捕获异常**:consoleErrors=0,uncaught=[](整轮 P1→P8 全流程含自动表演高负载段)。
- [x] **5. 探针自检全通过**:按 spec.json 8 个 probe 逐条自查(state 断言 + 像素/运动独立证据),8/8 PASS(证据:shot-s2.png + selfcheck.eval.js 输出,详见 WORKLOG 10:07:43Z 条目)。

预算终态(机器计数):build 2/8 · browser 2/6 · toolCall 未超 120 · 墙钟约 20 分钟(未超 90)。

## 3. 合规声明(逐条对 RUN-CONTRACT §4)

1. **未访问另一 Arm 的任何内容**(目录/代码/日志/dev server/浏览器 profile/截图/结果)。
2. **未访问 `reference/`** 任何内容。
3. **未访问本 Pair 本 Arm 之外的任何 bench/results/ 目录与既往 trial 结果**。
4. **未访问 `harness/` 源码与合同模板**(仅使用 workspace 内冻结模板自带的 scripts)。
5. **未访问引擎资产**:`bench/vendor/`、引擎上游源码仓库均未读取;仅按 knowledge/manifest.json 指明与安装依赖本身的编译需要,使用共享 node_modules 内 `cocosair.js` 的 `build/cocosair.module.d.ts` 类型声明与 dist 产物(构建链路必需,非 docs/examples)。
6. **未访问实验计划书与合同文档目录(`bench/docs/`)**。
7. **未访问 `secret/`**。
8. **未联网**:无任何网络请求(浏览器会话仅访问本 Arm dev server 127.0.0.1:7111)。
9. **未执行 `npm install`、未安装/改动任何依赖**(共享 node_modules 只读使用)。
10. **未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件**(改动仅限 workspace/src/main.js 与本文 WORKLOG/RESULT)。
11. **未探测或篡改 harness/validator 的行为与期望值**(selfcheck.eval.js 为针对 spec 公开探针条款的独立自检,不含对 harness 的针对性特判;实现中亦无任何自动化环境检测分支)。
12. **未手改/伪造/删除/重置 `.budget/` 计数文件,未绕过 count.mjs/verify-browser.mjs**(构建全部走 `npm run build`,浏览器全部走 verify-browser.mjs;继承的 2 条早期计数为系统侧合法记录,已如实披露)。

补充声明:入口 7111 端口上存在首次派发遗留的本 Arm serve 进程(serve 根即本 Arm workspace,Cache-Control: no-store,逐请求读盘,实测其服务的 dist/app.js sha256 与最终构建逐字节一致 4e736503…548a);本次构建后未再新起服务进程(重起因 EADDRINUSE 失败退出,未产生端口冲突风险),所有浏览器验证均针对该唯一服务实例完成。

备注(继承产物透明化):`shot-s1.png`、`selfcheck.eval.js` 为首次派发中断尝试所留,按"失败产物不删除"原则原样保留;本次证据为 `shot-s2.png` 与 WORKLOG 10:07:43Z 条目中的完整自检数据。
