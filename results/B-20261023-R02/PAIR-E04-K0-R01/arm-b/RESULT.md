# RESULT — Arm B (PAIR-E04-K0-R01, cocosair / K0)

> 场景 E04 城市烟花夜;引擎 Cocos AIR 1.0.0;知识等级 K0 + 引擎技能包(knowledge/skills,合同 §0 供给)。
> 实现:`workspace/src/main.js`(单文件);构建产物 `workspace/dist/app.js`。

## 1. 实现摘要(逐 probe)

- **P1 初始夜景可见**:静态批单网格 = 夜空 3 段顶点色垂直渐变(顶近黑 → 地平线蓝紫微亮,地平线在下方 ~30%)+ 150 颗静态星点(≥120)+ 26–34 栋程序化楼(高度 8%–45%,天际线落下方 25%–38%)+ ≥80 暖色亮窗(保底逻辑强制 ≥80)+ 少数楼顶红色障碍灯;`buildingCount` 为真实楼数。实测像素:底部 1/3 暖窗像素 2230、剪影平均亮度 24.7 显著低于地平线带 44.6。
- **P2 点击发射**:引擎 `input.on(MOUSE_DOWN)`(pal 层吞 canvas 事件,故不走自监听);`getLocation()` 物理像素/左下原点 → 归一化;城市剪影区域(cityTopAt)与 UI 区域(pointerdown-capture 标记)不发射;点击真实决定爆点(横向 ±12px、无纵向偏差,±5% 内),发射点在点击横坐标对应地面,升空 0.6–1.6s(减速缓升),期间 28/s 尾迹粒子(寿命 0.3–0.8s)+ 亮头粒子。实测 +500ms:fireworkCount==1、particlesAlive=23。
- **P3 爆炸**:每发 130–229 个爆炸粒子(∈100–240),初速球面近似均匀(均匀角 + sqrt 径向分布),重力 −58 px/s²(肉眼可见下坠)与指数阻力,寿命 1.2–2.8s,尺寸/透明度随寿命衰减;另有 7–10 个短寿命中心闪光亮斑。实测 +1.7s:particlesAlive=266(≥40);爆发截图亮像素 1089(较升空段远超 3x)。
- **P4 衰减与余烬**:粒子到寿即亡、无复活,particlesAlive 单调下降(266→27);每发 16–20 个余烬(≥12),寿命 3–12s(34% 长尾铺 10.5–12s),终末匀速缓慢下坠 22–44 px/s + 横向摇曳 + 1.2–3.6Hz 明灭闪烁,暖橙色。实测点击后 ~4.3s alive=27∈[1,40)、~10.3s alive=16(容纳探针截图时延)。
- **P5 自动表演**:`data-ui="auto-show"` 切换;开启后首发 0.15–0.35s 快速出画,随后 0.5–1.4s 随机间隔自动随机发射。实测 4s 窗口 fireworkCount 1→6(增量 5 ≥3,断言 ≥4 含 P2 首发稳过);多发连续爆炸亮团。
- **P6 自动关闭**:再次点击即停;实测两次 ≥2s 采样 fireworkCount 6==6(差 0),既有粒子仅自然衰减。
- **P7 暂停冻结**:`enabled=false` 时 step() 时间增量置 0:simTime 不推进 → 火箭/粒子/自动发射/余烬闪烁全部冻结(渲染缓冲不更新,画面逐帧一致);着色器不含任何时间项。实测暂停期间 1100ms 两次采样 particlesAlive 恒 275;恢复后自冻结处继续。
- **P8 reset**:`data-ui="reset"`(等价 `__bench.reset()`):清空火箭与粒子池、particlesAlive=0、fireworkCount=0、autoShow=false、enabled=true,城市重新随机生成(实测 26→34,楼数守恒区间,≥24);reset 后 `__appReady` 保持 true,可继续交互。

**状态通道真实性**:五个字段均取自模拟器实时数据(粒子计数来自池逐帧统计、楼数来自生成器数组),无任何预置/伪造;`?demo=1` 为人工演示入口(加载带参才生效,探测加载无参数、初始状态与行为完全不变,非自动化环境特判)。

**技术路线**(依技能包契约):正交相机(orthoHeight=CSS 高/2,1 世界单位=1 CSS px);静态层与粒子层各 1 个 MeshRenderer、各 1 个 draw;粒子走 `utils.MeshUtils.createDynamicMesh`(容量 16384 顶点/24576 索引)+ 每帧 `updateSubMesh`(subarray 按需截长)+ `onGeometryChanged()`;两个自定义 effect 为手写已编译 JSON + glsl3 变体 → `EffectAsset.onLoaded()` → `new Material()+initialize({effectAsset})`;粒子加色混合(ONE/ONE)径向衰减辉光,WebGL 渲染管线绘制(无 DOM/CSS 冒充粒子、无逐帧素材)。粒子上限 4096(峰值实测 4014 不崩溃、57.5fps;远超 ≥1000 要求),池满 spawn 优雅跳过。

## 2. 自检清单(合同 §5)

1. **`npm run build` 退出码 0** — ✅(build #3;计数 3/8)
2. **10s 内 `window.__appReady === true`** — ✅(验证 #2–#5 全部会话均 true,约首帧即置位)
3. **`window.__bench = { getState, reset }` 契约成立** — ✅(benchReady=true;五字段真实数据)
4. **无未捕获异常** — ✅(五个浏览器会话 consoleErrors=0、uncaught=0;build#1 的一次失败已修复并复验)
5. **探针自检 8/8** — ✅(状态断言全过,见上;视觉断言:P1/P8/P3 经像素分析复核,P2/P4/P5/P7 由状态+确定性渲染逻辑复核;机器判定以 validate.mjs 为准)

预算消耗:build 3/8 · browser 5/6 · 工具调用约 47/120 · 墙钟约 45min/90min。

## 3. 合规声明(合同 §4 逐条)

1. 未访问另一 Arm(arm-a)任何内容。❌→未违
2. 未访问 `reference/`。❌→未违
3. 未访问本 Pair 本 Arm 之外的 `bench/results/` 目录与既往 trial。❌→未违
4. 未访问 `harness/` 源码与本合同模板。❌→未违
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 树);引擎运行时模块仅经本 Arm 目录内 `workspace/dist/vendor/cocosair.module.js`(模板构建产物,白名单内)核对 API 行为契约。❌→未违
6. 未访问 `bench/docs/`。❌→未违
7. 未访问 `secret/`。❌→未违
8. 未联网:无任何网络请求(文档/搜索/registry 均无;截图像素分析为本地 zlib 解码)。❌→未违
9. 未执行 `npm install`、未改动共享仓内容;依赖全部经上层共享 node_modules 解析。❌→未违
10. 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness·validator·探针代码或探针结果文件。❌→未违
11. 未探测或篡改 harness/validator 行为与期望值;`?demo=1` 演示入口仅在带参加载时生效,不检测自动化环境、不改变探测条件下的行为(已披露)。❌→未违
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数;全部 3 次 build 经 `npm run build`(自动计数)、全部 5 次浏览器会话经 `scripts/verify-browser.mjs`(先计后开)。❌→未违

"只读同样禁止"条款同样遵守:对上述禁读目标未发生任何形式的读取。
