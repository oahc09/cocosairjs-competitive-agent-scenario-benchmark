# RESULT — PAIR-E04-K0-R02 / Arm A(cocosair · K0)

## 1. 实现摘要(逐 probe 一句话)

技术路线:正交相机 2.5D 场景,全部视觉程序化生成;夜空/楼群/星点为静态顶点色网格(builtin-unlit + USE_VERTEX_COLOR),烟花粒子为单张动态网格(`utils.MeshUtils.createDynamicMesh` + 每帧 `updateSubMesh`,每粒子一四边形)+ 离屏 canvas 径向渐变贴图 + 加色混合近似辉光(引擎无后处理 Bloom);输入走引擎 `input.on(MOUSE_DOWN)`;时间线由 `FireworksTimeline` Component 以真实 dt 步进(clamp 0.05s),暂停即时间增量置 0。

| Probe | 实现要点(状态 + 独立可观证据) |
|---|---|
| **P1 初始夜景** | 30 栋程序化楼(固定数量、随机形状)+ ~200+ 扇暖黄/暖白亮窗 + 150 颗静态星点 + 顶点色垂直渐变夜空(顶近黑→地平线蓝紫)+ 地平线加色辉光条 + 少数楼顶红色障碍灯;自检 readPixels:下部 1/3 暖色像素 6952(≥80)、上部夜空非纯黑,状态 `buildingCount=30, fireworkCount=0, autoShow=false, enabled=true` |
| **P2 点击发射** | 合成 mousedown 经真实 DOM→pal→引擎 `input.on` 链路触发;点击横坐标映射为发射点、点击高度为爆点(kinematic ease-out 上升 0.6-1.6s);500ms 时 `fireworkCount==1, particlesAlive=102`,尾迹带(x∈[0.4,0.6])两帧差分 0.0230(≫0.005 冻结阈值),爆点高度自检:最亮行 fromBottom **0.700** = 点击高度 0.70(映射精确) |
| **P3 爆炸** | 爆点生成 140-220 个球面均匀方向粒子(速度衰减+重力 210)+4 个大尺寸中心闪光;+1.2s 后 `particlesAlive=226(≥40)`,爆点邻域(上半屏 y∈[0.5,0.9])亮像素较 P2 时刻 **4.07x(≥3x)** |
| **P4 衰减与余烬** | 爆炸粒子寿命 1.2-2.8s 平方淡出;每发 30 个余烬分层寿命 3-6.5s / 7-9.5s / 10-12s(长尾 ~30%),缓降+强闪烁;P4 时刻 `particlesAlive=28 ∈ [1,40)` 单调下降,center-bottom 两帧差分 **0.0080(≥0.005)** |
| **P5 自动表演** | `data-ui="auto-show"` 切换;开启后以 rand(0.5,0.95)s 随机间隔自动发射(随机位置/颜色);4s 内 fireworkCount 1→7(Δ6≥3),`autoShow==true`,峰值 particlesAlive 834(单帧 ~2300 四边形,能力余量充足) |
| **P6 关闭自动表演** | 再点即关(取消待发定时);`autoShow==false`,间隔 2.1s 两次采样 fireworkCount 7==7 冻结,存活粒子 278→117 自然衰减趋零 |
| **P7 暂停冻结** | `data-ui="pause"` → `enabled=false`,update 直接返回(时间增量 0:粒子/火箭/自动发射/障碍灯闪烁全部静止);`enabled==false`,间隔 1000ms 全画面差分 **0.000000(<0.5%)** |
| **P8 reset** | `data-ui="reset"`(等价 `__bench.reset()`):清空火箭/粒子、`fireworkCount=0, particlesAlive=0, autoShow=false, enabled=true`,城市以同楼数(30)重新随机生成,城市窗光像素仍在(bottomWarm 5412),上部回落至星空基线 |

## 2. 自检清单(§5 完成合同)

- [x] **1. `npm run build` 退出码 0** — workspace 根执行,最终 build #5 成功(esbuild 产物 dist/app.js + dist/vendor/cocosair.module.js,机器计数 5/8)
- [x] **2. 10s 内 `window.__appReady === true`** — 首帧 EVENT_AFTER_DRAW 后置 true,verify-browser 实测 `appReady:true`(远小于 10s)
- [x] **3. `window.__bench = { getState(), reset() }` 契约成立** — `benchReady:true`,getState 返回 `{fireworkCount, particlesAlive, autoShow, enabled, buildingCount}` 全为真实数据
- [x] **4. 无未捕获异常** — 最终轮 `consoleErrors:0, uncaught:[]`(全程各轮均无 error 级输出;页面 favicon 用空 data URI 避免 404)
- [x] **5. 探针自检 P1-P8 全部通过** — 见 §1 表格;证据 = 每步 getState JSON + readPixels 像素统计 + 帧差分(自检脚本 `selfcheck/probe-script.js`,结果摘要见 WORKLOG;截图 `selfcheck/shot*.png`)

预算:build **5/8**、browser **6/6**(触顶即停)、工具调用与墙钟见 Runner 侧记录(远低于 120 次/90 分钟上限内运行)。

## 3. 合规声明(逐条声明未访问 §4 禁止路径)

1. **未访问另一 Arm 的一切**(目录、代码、日志、dev server、浏览器 profile、截图、结果)。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录与既往 trial 结果**。
4. **未读 `harness/` 源码与合同模板**(仅读本 Arm 目录内模板自带的 workspace/scripts/*,属于白名单内)。
5. **未访问引擎资产 `bench/vendor/` 与引擎上游源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);API 信息仅来自:①本 Arm `knowledge/` README;②上层共享 node_modules 内已安装依赖的 `cocosair.module.d.ts` 与运行时 bundle(K0 tarball 已剔除 docs/,属合同 §1"依赖由共享 node_modules 提供"的既装依赖,非 vendor 目录)。
6. **未访问实验计划书与 `bench/docs/`**。
7. **未访问 `secret/`**。
8. **未联网**(无任何网络请求;页面无外部资源引用)。
9. **未 `npm install` / 未安装或改动任何依赖**(共享 node_modules 只读使用)。
10. **未修改 brief.md / spec.json / RUN-CONTRACT.md / harness/validator/探针代码或探针结果文件**。
11. **未探测或篡改 harness/validator 行为与期望值**(自检脚本为本 Arm 自建文件,只调用页面公开契约 `__bench`/canvas readPixels,不针对 harness 特判)。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件,未绕过 count.mjs / verify-browser.mjs**(所有构建经 `npm run build` 串联计数、所有浏览器会话均经 `scripts/verify-browser.mjs`,计数文件仅追加由脚本完成)。

其他:共享资产 `assets/` 仅只读(E04 assets 契约为空,实现未使用任何外部资产);`knowledge/` 只读;引擎坑位规避(引擎 input.on、Camera.visibility 显式设置、动态网格替代 Points/InstancedMesh、Material initialize({effectAsset})、程序化贴图)均来自 K0 模板与 README/d.ts 合法信息源。

— Arm A(cocosair · K0)· 2026-10-06
