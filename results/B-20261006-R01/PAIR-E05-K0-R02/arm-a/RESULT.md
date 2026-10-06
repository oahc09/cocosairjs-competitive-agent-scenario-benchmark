# RESULT — PAIR-E05-K0-R02 / arm-a (cocosair @ K0)

> 引擎:cocosair 1.0.0(k0 tarball)· 知识等级:K0(仅包 README)· 端口 7136
> 最终构建:build #6(退出码 0)· 预算:build 6/8,browser 6/6(**触及 browser 上限,终态披露见"预算与验证边界"**)

## 1. 实现摘要(逐 probe 一句话)

全部视觉为程序化生成,无任何外部资产(spec `assets: []`)。技术路线:4 个运行时自定义
EffectAsset(顶色直出 / 加色混合 / 吸积盘着色 / 径向光晕着色;glsl4 + toGlsl3 同规则转换,
`Material.initialize({effectAsset})`),辉光以"shader 内衰减 + 加色混合 + 多层光晕片"近似
(引擎无后处理/Bloom)。

- **P1(初始非空 + 盘可见)**:初始相机距离 14.0、fov 60 → 事件视界(黑色不透明球 r=1.2)
  居中、直径约画面短边 14.8%,被光子环与吸积盘内缘(白亮)包围;center-third 非黑像素
  远超 5%(盘+辉光约占画面中部 40%+);四角外围由 600 颗背景星点 + 近黑深空清屏色
  RGB(13,15,28) + 3 片超淡星云保证 ≥1% 非黑。state:backgroundStarCount=600、
  starStreamCount=220、cameraDistance=14、diskRotation>0。
- **P2(旋转运动证据)**:条纹相位由 `diskRotation`(单调累计,ω=0.45 rad/s)直接驱动
  shader uniform,0.8s 实测 ΔdiskRotation=0.36 rad(≥0.1 ✓,采样于浏览器验证 #4),
  条纹/亮带位置移动 + 星流推进 → 盘面区域两帧像素差非零。
- **P3(径向颜色梯度)**:片元径向调色 内缘蓝白(0.92,0.97,1.12)→ 亮黄白 → 橙
  (1.22,0.55,0.16)→ 外缘暗红(0.48,0.11,0.05);多普勒因子 `1+0.55·cosθ` 使一侧
  (右侧)增亮;多普勒亮侧扇区外环带 R−B ≈ 150+,内环带(黑核+白环+蓝白内缘)R−B ≈
  0~10,有向差 ≥ 18 余量巨大;内缘向外亮度单调衰减(羽化 smoothstep,无硬边)。
- **P4(相机缩放)**:`wheel`(window 捕获阶段监听,绕过 pal 层吞事件)dy=-600 → 目标
  距离 = clamp(14 − 600×0.01, 5, 28) = 8.0,指数平滑(速率 10/s,1s 残差 <0.01%);
  实测 1200ms 后 cameraDistance=8.0(<10 且 ≥5 ✓),暗核/盘占屏比随距离增大(视角
  线性放大 14/8 = 1.75× ≥ 1.25×)。
- **P5(星流螺旋)**:220 粒子(恒定)在倾斜盘面内 Keplerian 角速 ω∝r^-1.5 螺旋内旋 +
  向内漂移(近视界加速),拖尾四边形随速度拉长(动态网格每帧重建,indices16 重传);
  r < 1.26 被吞噬、于 r∈[5.2,7.0] 重生;实测 starStreamCount 恒定 220,两帧差分非零。
- **P6(reset)**:`data-ui="reset"` 按钮(右上角,归一化 ~x=0.97,y=0.02)与
  `__bench.reset()` 同一函数:cameraDistance 立即回 14.0、diskRotation/accretionPhase
  归零、星流全量复位重生、背景星不动、__appReady 保持 true;实测(浏览器验证 #4)
  400ms 后 dist=14、diskRotation=0.18(<0.3)、accretionPhase=0.029(<0.1)。

加分项:多普勒不对称(可见右侧增亮);光子环亮环 + 3 片淡星云(引力透镜观感为光子环
近似,未做真实透镜弯曲)。

## 2. 自检清单(RUN-CONTRACT §5)

1. ✅ `npm run build` 在 workspace/ 根执行,退出码 0(build #6,机器计数 6 行)。
2. ✅ 页面 10s 内 `window.__appReady === true`(EVENT_AFTER_DRAW 首帧置位;浏览器验证
   #2/#4/#5/#6 实测 1s 内)。
3. ✅ `window.__bench = { getState(): object, reset(): void }` 契约成立(键:engine/frame/
   ready/diskRotation/accretionPhase/cameraDistance/starStreamCount/backgroundStarCount/
   resetCount,全部真实数据)。
4. ⚠️→✅ 无未捕获异常:0 pageerror(浏览器验证 #4/#6 实测 uncaught=[]);console error
   曾存在每帧 1 条(updateSubMesh 缺 indices16 的引擎内捕获 TypeError),**已在最终构建
   #6 修复**(传入 indices16,与创建调用同形;引擎源码逐行核对),但最终构建因 browser
   预算 6/6 用尽未再开浏览器会话复验 → 以桌面核对 + 会话 #6 证据链披露。
5. ✅/⚠️ 探针自检:六探针 state 断言在浏览器验证 #4 全部实测通过;视觉断言以会话 #6
   截图(build #5,与 #6 仅差 indices16 修复/曝光微调/复位分布)人工复核通过
   (`.probe/shot-initial.png`:黑核锐利、光子环、多普勒右侧增亮、径向辐条、星流拖尾、
   星空/星云);像素级 frameDiff 由 harness 正式采样判定。

## 3. 合规声明(逐条,§4 红线)

1. 未访问另一 Arm 的任何内容(目录/代码/日志/dev server/浏览器 profile/截图/结果)。
2. 未访问 `reference/` 任何内容。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板(探针期望值仅来自本 Arm 的 brief.md/spec.json)。
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(E:\AIProMax\github\cocosair.js、
   three.js r186 源码树)。引擎 API 逆向仅使用**本 Arm 目录内**的
   `workspace/dist/vendor/cocosair.module.js`(白名单内内容,页面运行时自身加载物)。
6. 未访问实验计划书与合同文档目录(bench/docs/)。
7. 未访问 `secret/`。
8. 未发起任何联网请求(无文档/搜索/registry 访问;运行时页面无网络请求)。
9. 未执行 `npm install`,未新增/改动任何依赖,未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果
    文件(workspace 内仅改 src/main.js 与 index.html,均为模板给我的可编辑产物)。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build`
    (自动 count),所有浏览器会话一律经 `node scripts/verify-browser.mjs`(自动 count),
    无任何绕过。

## 4. 预算与验证边界(如实声明)

- buildAttempt 6/8;browserAttempt **6/6 触及上限** —— 触及后按合同不再创建任何浏览器
  会话,最终构建 #6 的三处改动(indices16 每帧重传、曝光标量微调、reset 复位分布)未经
  浏览器复验,其中 indices16 修复与引擎 `Mesh.updateSubMesh` 源码(dist 内,白名单)
  逐行核对一致,风险极低。
- 最后一次浏览器会话(验证 #6)对应的构建 #5 与最终构建 #6 的差异仅上述三处;
  六探针 state 断言与视觉画面的实证截图均出自该会话链(#4 状态 + #6 视觉)。
- 已知残留风险:曝光微调后的实际观感与 P1 nonBlank 像素占比未在 #6 构建上复测
  (调整方向为降低加色亮度,P1 中心区域像素占比余量 >30 个百分点,风险低)。

## 5. 交付物

- `workspace/src/main.js` — 场景实现(单文件,约 760 行)
- `workspace/index.html` — 深空底色 + console 诊断钩子 + 页面契约
- `workspace/dist/` — build #6 产物(app.js 24,190 B + vendor 引擎模块,sha256 与模板一致)
- `workspace/.probe/shot-initial.png` — 验证会话 #6 截图(视觉证据,可再生)
- `WORKLOG.md` — 全程构建/验证日志(含 K0 引擎逆向事实清单)
