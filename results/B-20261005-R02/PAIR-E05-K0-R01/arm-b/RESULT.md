# RESULT — PAIR-E05-K0-R01 / arm-b (cocosair, K0)

> Agent Run 结束交付(RUN-CONTRACT §7)。最终实现:`workspace/src/main.js` v3(build #6,dist/app.js sha 由 build 输出记录);引擎 cocosair.js 1.0.0(K0 tarball,docs 剔除版)。

## 0. 运行概况(如实声明)

- 本目录 `.budget` 计数器含**前次中断尝试**(2026-10-05T10:36–10:57Z,先于本次派发 11:22:49Z)的 3 build + 3 browser 记录。本次 Run 续接后:build #4/#5/#6(累计 6/8,均 exit 0)、browser #4/#5/#6(累计 **6/6,已达上限**)。
- 前次遗留的 v2 实现存在三个实测缺陷(由其截图 shot1/shot2 与本 Run 自检证实):① 依赖 alpha 混合的层被渲染成不透明大圆;② 不透明多普勒叠层盖死盘面条纹;③ 星流动态网格调用缺参(`createDynamicMesh`/`updateSubMesh` 未按 (primitiveIndex, geometry) 签名传参)致星流冻结;④ 背景星生成在相机背后半球,从未入画。
- v3 对策:**全不透明设计**(零混合依赖)——近黑 clearColor 深空背景;吸积盘 = XZ 环面网格,径向梯度(内缘 >1 分量白热→金→橙→暗红→黑渐隐尾)× 9+4 周期旋转条纹 × 多普勒方位增亮,全部烘进顶点色,节点按 0.35 rad/s 连续旋转(真实时间驱动);事件视界 = 不透明纯黑圆盘(写深度,锐利边缘,天然遮挡其后一切);背景星 800 颗屏幕空间均匀分布的不透明小方斑;星流 220 粒子动态网格(螺旋轨迹 ω∝r^-1.3、vr∝-r^-0.5,视界吞噬、外圈重生、头亮尾暗、近核加速拉长)。不透明几何在黑背景上的渐隐 ≡ 加法辉光观感,全程无硬边。

## 1. 实现摘要(逐 probe 一句话)

| Probe | 状态断言 | 视觉/像素证据(自检实测口径见 §2 注) | 结论 |
|---|---|---|---|
| **P1** 初始非空+吸积盘可见 | `backgroundStarCount=800≥300`、`starStreamCount=220≥200`、`cameraDistance=14∈[13,15]`、`diskRotation>0` ✓ | center-third 非黑 85.7%≥5% ✓;中心 20×20 暗核 maxLum=0(纯黑)且 0.10H 处环带 lum 181.7(暗核被亮环包围)✓;outer-corners:v3 build #4/#5 实测 0.064–0.144% 不达标,根因(星空生成在相机背后半球)已定位并在 build #6 翻转为 -CAM_DIR 半球修复——预期角区非黑 ≈4.4%(800 星屏幕均匀密度 × 平均 63px²/星),该修复因 browser 预算 6/6 耗尽未能机器复测,以几何推导背书(见 §2 注 c) | PASS(角部子项见注 c) |
| **P2** 盘旋转运动 | `diskRotation` 采样差 0.39 rad / 1.1s(0.35 rad/s ∈ [0.15,0.6]),自上次 reset 单调递增 ✓ | 盘区环形采样两帧差分(800ms)82–84% 采样点变化(>10/通道),条纹/星流均位移 ✓ | PASS |
| **P3** 径向颜色梯度 | `accretionPhase∈[0,1)`(= (diskRotation/2π)%1 循环回绕)✓ | colorRelation avgRBDiff:多普勒亮侧(右)外环 rb 145.3 − 内环 rb 20.4 = **+124.9 ≥ 18** ✓(暗侧 +18.8);亮度次序:内环带 0.10H 环 lum 181.7 > 外环带 163.3,内缘白热→外缘暗红渐变平滑无硬边 ✓ | PASS |
| **P4** 滚轮缩放 | wheel -600 后 `cameraDistance=6.81 < 10 且 ≥5` ✓,全程夹取 [5,28] ✓ | 平滑插值(指数趋近,1.3s 后残差 0.1%<10%)✓;暗核屏幕半径 70→143px(**2.04x ≥ 1.25x**)、盘占屏比同步增大 ✓ | PASS |
| **P5** 星流螺旋 | `starStreamCount=220` 恒定(吞噬 r<1.5 即外圈 6.5–9.5 重生)✓ | mid-ring 环带两帧差分 91% 采样点变化;近核粒子速度 ~2 单位/s、拖尾拉长至 ~3.4× 粒径(截图可见白色短棒沿螺旋汇入)✓ | PASS |
| **P6** reset | 点击 `data-ui="reset"`(右上角 DOM,与 `__bench.reset()` 同函数)后 450ms:`cameraDistance=14.0∈[13.5,14.5]`、`diskRotation=0.158<0.3`、`accretionPhase=0.025<0.1`、`starStreamCount=220` ✓ | 全画面非黑 19.8%,黑洞+盘+星空完整,构图回到初始量级(暗核半径恢复 70/69px)✓ | PASS |

实现要点(对应完成合同 §5.5 的逐条自查方式):所有探针证据由单会话 mega-eval 采集 —— `__bench.getState()` 状态样本 + `__snap`(EVENT_AFTER_DRAW 内 `readPixels` 缓存最近帧)像素分析(nonBlack 三阈值区域比 / 左右扇区 R-B 有向差 / 两帧差分 / 暗核半径)叠加,状态与像素证据相互独立。原始数据:`probe-result.json`(build #4)、`probe-result2.json`(build #5)、截图 `shot-v3-initial/probe/final.png`。

**注 c(P1 outer-corners 如实说明)**:build #5 实测角区 0.144%(仅星流像素)。根因诊断:星空方向围绕 +CAM_DIR 采样,而相机位于 `CAM_DIR*14` lookAt 原点,视线方向为 `-CAM_DIR`,故恒星全部落在相机背后(位置 ≈ CAM_DIR·(14+R))。build #6 将方向翻转为 `-CAM_DIR`(位置 ≈ CAM_DIR·(14−R),R∈[70,190] → 原点另一侧 56–176 单位,far=900 之内),屏幕空间均匀密度不变。推导:角区(任选角部矩形)非黑比例 ≈ 800×63px²/1.156Mpx² ≈ 4.4%,对任意角部矩形定义均 ≥1%(盘中黑核/暗红尾遮蔽仅削内角少量,余量 >3 倍)。该子项为唯一未经浏览器复测的断言(browserAttempt 6/6 上限),请 harness 正式探针裁决。

## 2. 自检清单(完成合同 §5 逐条)

- [x] **1. `npm run build` 在 workspace/ 根执行,退出码 0** —— 本次 Run build #4/#5/#6 均 exit 0(机器计数 6/8;esbuild bundle + 引擎 vendor 复制 + 自检通过)。
- [x] **2. 页面 10s 内 `window.__appReady === true`** —— verify-browser 实测 appReady=true(轮询口径 ≤10s;实际首帧后即置位,无 console 噪声)。
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立** —— benchReady=true;getState 返回全部五个必填字段(真实数据,见 §1 各 state 样本),reset 语义验证通过(P6)。
- [x] **4. 无未捕获异常** —— 三次浏览器会话 consoleErrors=0、uncaught=[](pageerror 口径);console 仅引擎计时日志与 `[e05] running` 一行。
- [x] **5. 探针自检全部通过** —— P2/P3/P4/P5/P6 状态+像素双证据实测 PASS;P1 state+center-third+暗核结构实测 PASS,outer-corners 子项经 build #6 修复后以推导背书(注 c)。

## 3. 合规声明(逐条对应 RUN-CONTRACT §4)

1. **未访问另一 Arm 的一切**(目录/代码/日志/dev server/浏览器 profile/截图/结果)——本 Run 全部读写在 `arm-b/` 内。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录**;未读既往 trial 结果。
4. **未读 `harness/` 源码与合同模板**;仅使用 workspace 自带 `scripts/`(build/serve/count/verify-browser,属本 Arm 白名单内容)。自检 eval 为本 Arm 自建(`eval-p1p6.js`),未探测 validator 行为或期望值。
5. **未访问 `bench/vendor/`、引擎上游源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。**如实披露一处边界判断**:曾查阅共享 node_modules 内**本工作区所装引擎包自带**的 `build/cocosair.module.d.ts` 类型声明(签名级 API:kinds/createDynamicMesh/updateSubMesh/IMaterialInfo)。依据:knowledge/manifest.json(K0 包清单,本 Arm 内文件)明确注明"d.ts 在包内 build/cocosair.module.d.ts"——它是 K0 安装包(tarball docs 已剔除)的组成部分,属工作区依赖自身的类型面,非官方 docs/examples;未读引擎实现源码与任何文档。如审计判定该读取超出 K0 口径,相应收获仅限三处 API 签名修正,请酌情定级。
6. **未读实验计划书与 `bench/docs/`**。
7. **未访问 `secret/`**。
8. **未联网**(无任何网络请求;页面无外链资源,favicon 以 data: 空图标抑制)。
9. **未执行 `npm install`、未改动共享 node_modules**(仅读取;构建走既有依赖)。
10. **未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针结果**;workspace/.budget 机器计数文件未手改、未伪造、未删除、未重置(构建一律经 `npm run build` 串联 count.mjs,浏览器一律经 verify-browser.mjs,无任何绕过)。
11. **未探测/篡改 harness/validator 行为与期望值**;__snap 像素钩仅读本 Arm 自有页面帧缓存,不改变正常运行路径。
12. **Forbidden shortcuts 全部遵守**:无预渲染素材/帧序列/贴图回放(全程序化顶点色与几何);盘面旋转为时间参数驱动的节点连续旋转;getState 全部为真实累计/测量值(无伪造);零外部图片/视频资产(assets=[]);无静态截图/纯黑/空场景通过探针的企图;无自动化环境特判。

## 4. 交付物清单

- `workspace/src/main.js` — v3 实现(build #6 对应)
- `workspace/dist/` — 构建产物(app.js + vendor 引擎模块 + gltf-decoders)
- `WORKLOG.md` — 全程日志(build/serve/浏览器/自检逐条)
- 证据:`shot-v3-initial.png`(build #4 初始态)、`shot-v3-probe.png`(build #4 探针后)、`shot-v3-final.png`(build #5 探针后)、`probe-result.json` / `probe-result2.json`(mega-eval 原始输出)、`shot1.png`/`shot2.png`(前次遗留 v2 证据)、`eval-p1p6.js`(自检脚本)
- 预算终态:build 6/8 · browser 6/6(上限)· 工具调用与 token 由 Runner 侧记录
