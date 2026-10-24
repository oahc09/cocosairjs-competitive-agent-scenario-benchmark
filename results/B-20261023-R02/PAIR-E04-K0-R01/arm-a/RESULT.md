# RESULT — PAIR-E04-K0-R01 / arm-a (three / K0)

- 引擎:three@0.186.1(r186,vendored,import map 解析,app.js 不含引擎)
- 知识等级:K0(仅包 README + 模板;无 docs/examples 可读)
- 实现:`workspace/src/main.js` 单文件(约 700 行),构建产物 `workspace/dist/`
- 终验:2026-10-23T18:22+08:00,自检脚本 `workspace/scripts/selfcheck.mjs` 全探针模拟 **13/13 PASS**(报告与截图:`arm-a/selfcheck/report.json`、`arm-a/selfcheck/P*.png`)
- 预算使用(机器计数):build 6/8,browser 6/6,墙钟约 65 分钟,均在冻结上限内

---

## 1. 实现摘要(逐 probe)

- **P1 初始夜景**:夜空=全屏着色器渐变(天顶近黑深蓝黑 → 地平线蓝紫亮带,非对称光污染暖带压在天际线上方、楼间天空强压暗);170 颗星点(Points+自定义着色器微闪烁);26-31 栋程序化楼(合并 BufferGeometry 单 draw call,近黑剪影顶点色)+ 300+ 暖色亮窗(>=80 有富余)+ 22 点呼吸窗灯 + 高楼红障碍灯慢闪;实测 bottom-third 暖像素 ~3500-3800、剪影带平均亮度 40.9 vs 天际线亮带 51.1(显著更低)、天顶非纯黑(avgLum 8.0)。
- **P2 点击发射**:canvas `click` 事件(仅画布,UI 为独立 DOM 元素互不吞没;点击命中楼体区域忽略);爆点=点击位置(clamp 至安全带,±5% 画面高内),从点击横坐标对应地面附近微斜升空 0.68-1.02s;尾迹 140/s 暖金粒子(寿命 0.4-0.78s)+ 8-12px 火箭头亮斑;点击即 `fireworkCount+1`;实测点击后 500ms count==1、particlesAlive 70、中竖带两帧差 nz≥1300。
- **P3 爆炸**:每发 160-229 个爆裂粒子(规格 100-240),球面近似均匀方向(88% 壳层+12% 填充),受重力(58-78 px/s²)与指数阻力(1.35-1.65)衰减,寿命 1.3-2.6s,尺寸/透明度随寿命衰减,additive 柔光晕着色器 + 40-56px 中心闪光;实测爆点邻域亮像素 ~1000(>= 3x P2 时刻)。
- **P4 衰减与余烬**:爆裂粒子寿命截止 3.6s 前全部消亡,particlesAlive 单调下降;余烬每发 24-27 个(>=12),寿命分层 35% 长尾 10.5-12s(慢降终端 ~52-66 px/s)/ 40% 中层 5.5-8.5s / 25% 短命 3-5.5s,缓慢下坠+横向摇摆+强闪烁(幅度 0.75-0.88),近底着陆驻留闪烁直至寿命结束,偶发微火花;实测 4.3s 采样 particlesAlive 30(∈[1,40))、~7.5s 采样 20,center-bottom 运动比 0.0067/0.0051(阈值 0.005)。
- **P5 自动表演**:`data-ui="auto-show"` 切换;开启后 0.2-0.4s 首发、后续 0.55-1.15s 随机间隔(在 0.5-1.5s 规格区间内),位置/颜色随机(爆点集中上半屏 20%-55% 高度);实测 4s 内 fireworkCount 5-6(>=4)且上半屏多次亮度脉冲。
- **P6 关闭自动**:再点即关(autoShow=false),发射计时器停;在飞火箭按自然运动完成(不新增发射);实测关闭后两次间隔采样 fireworkCount 差==0,存活粒子自然衰减。
- **P7 暂停冻结**:`data-ui="pause"` 切换 enabled=false → dt=0:火箭/粒子/自动发射/星闪/障碍灯/呼吸窗灯全部冻结(全部动画由同一 simTime/dt 驱动),仍每帧渲染相同状态;实测两帧(间隔 1s)全画面差分**恰好 0**(0/921600 像素);恢复后从冻结处继续。
- **P8 reset**:`data-ui="reset"` ≡ `__bench.reset()`:清空粒子池与火箭、fireworkCount=0、particlesAlive=0、autoShow=false、enabled=true,城市重新随机生成且**楼数不变**(>=24);实测 600ms 后五项状态全零/复位、暖窗仍在(~3700)、上部亮像素回落至星点基线(~588)。

页面契约:`__appReady` 首帧渲染后置 true(实测 0.3-1.2s << 10s);`__bench.getState()` 返回真实计数 {fireworkCount, particlesAlive, autoShow, enabled, buildingCount}(+engine/ready),reset 如上。粒子全部经 WebGL 点精灵渲染(自定义 ShaderMaterial + additive),无 DOM/CSS 粒子、无任何外部资产、无网络请求、运行时零 console 错误。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(共 6 次,含产物自检)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 357-1182ms)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(全部探针状态断言基于它)
- [x] 4. 无未捕获异常(6 轮会话 console error 与 pageerror 均为 0)
- [x] 5. 探针自检:P1-P8 逐条(状态断言+视觉断言)全部通过(终验 13/13,含 UI 位置、reset 后再点击、错误收集三项附加检查)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

本人(Agent)在本次 Run 中**未**访问/执行以下任何一项:

1. 未访问另一 Arm(arm-b)的任何内容(目录/代码/日志/dev server/浏览器 profile/截图/结果);本 Arm dev server 仅用本机 7210 端口。
2. 未访问 `reference/`(实现、截图、视频、私有验证器)。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录,未读任何既往 trial 结果。
4. 未访问 `harness/` 源码(coordinator/runner/isolation/probes)与本合同模板。
5. 未访问 `bench/vendor/` 整目录(tarball 与版本化 SDK 内 docs/examples),未访问 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树;引擎仅以裸名 `import * as THREE from 'three'` 使用共享 node_modules 安装副本(构建脚本自动解析,未人工读取引擎源码/文档)。
6. 未访问 `bench/docs/`(实验计划书与合同文档目录)。
7. 未访问 `secret/`。
8. 无任何联网行为(无文档/搜索/registry 请求;页面运行时亦无网络请求,资产契约为空且未引入任何图片/视频/音频/字体文件)。
9. 未执行 `npm install`,未安装/改动任何依赖,未改动共享仓内容(工作区无自有 node_modules)。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(冻结模板脚本 build.mjs/serve.mjs/count.mjs/verify-browser.mjs 均未改动;新增文件仅 `scripts/selfcheck.mjs`(自用验证)与 `src/main.js`(实现本体)、`index.html` title 一行)。
11. 未探测或篡改 harness/validator 行为与期望值(无自动化环境检测/特判;selfcheck.mjs 为自用黑盒模拟,不影响页面行为)。
12. 未手改/伪造/删除/重置 `workspace/.budget/*.count`;所有构建经 `npm run build`(count 先行串联),所有浏览器会话经 `scripts/selfcheck.mjs` 且创建会话前先执行 `node scripts/count.mjs browser`(终值 build 6、browser 6,均未超上限)。

补充:全程仅读写本 Arm 目录(`arm-a/`)内文件;WORKLOG.md 与 RESULT.md 为合同要求的自建交付物;`selfcheck/` 截图为自验证据产物。
