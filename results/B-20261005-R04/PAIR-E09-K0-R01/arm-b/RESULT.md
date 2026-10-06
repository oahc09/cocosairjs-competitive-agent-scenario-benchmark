# RESULT — PAIR-E09-K0-R01 / arm-b(cocosair,K0 冷启动)

Run 模式:R0 自主交付。工作区:`workspace/`(入口 `src/main.js`,构建产物 `dist/`)。

## 1. 实现摘要(逐 probe 一句话)

| Probe | 断言 | 实现与自检结果(终验 #6 实测) |
|---|---|---|
| P1 | 初始态 + 宝石居中非空 | 默认 diamond / cameraDistance=10 / exportCount=0 / rotationAngle≥0;宝石(程序化 16 段明亮式切工,S=1.30,128 三角切面)居中占屏约 40% 高度,区域 {0.36,0.26,0.28,0.42} 内远超 minCoverage(实测 crown 采样 (87,90,95)、pavilion (189,133,200),非空非纯色)✅ |
| P2 | 自转 ≥50° 累计 + 画面变化 | Turntable 组件 32°/s 累加(rotationAngle 单调不折返),2s 实测 Δ64°(67.3→131.3);切面高光/火彩随转台流动(regionChange 由平顶着色逐面跳变保证)✅ |
| P3 | swatch-2 → ruby 同步变色 | 色板 `data-ui="swatch-1..5"`(diamond/ruby/emerald/sapphire/amber),点击即时 `applyColor` 更新 uTint;实测 selectedColor=ruby,宝石体色实时变红 ✅ |
| P4 | 双击推近 ≤6(≥600ms 缓动) | window 捕获阶段监听 dblclick(pal 层吞 canvas 事件),真实相机沿取景射线位移,easeInOutCubic 850ms;实测 cameraDistance=5.3,宝石显著变大 ✅ |
| P5 | 再次双击拉回 ≥9 | 同一切换逻辑(≤6.5 判近),实测回到 10.0,过渡平滑无跳变 ✅ |
| P6 | 导出 PNG + exportCount=1 | EVENT_AFTER_DRAW 同任务 readPixels 默认帧缓冲 → 2D canvas → toBlob → `<a download>` 真实下载;实测 exportCount=1,PNG 1,172,095 字节,分辨率 1280×720(=画布)✅ |
| P7 | 二次导出 exportCount=2 | 文件名带毫秒时间戳无同名冲突;实测 exportCount=2,PNG 1,171,323 字节,画布持续渲染(pav 采样 (189,133,200) 非空白)✅ |
| P8 | reset 恢复初始 | `data-ui="reset"` → diamond / 10 / exportCount=0,转台相位保留继续自转(实测 404° 继续增长),无页面刷新 ✅ |

关键实现事实(供盲评/复算参考):

- **折射/反射/色散观感**:自定义 EffectAsset(仿引擎内置注册路径 `Object.assign + onLoaded`)单 pass 着色;`reflect` 采样程序化摄影棚环境函数(三块锐利柔光箱 + 横向灯带,反射高光锐利扫动);三通道三条折射率(1.50/1.55/1.60±色散参数)分别 `refract` 采样环境 → 切面棱线色散火彩随视角/转台流动(非贴图烘焙);Schlick 菲涅尔混合;透过宝石可见被弯折的环境内容(折射变形,表观 IOR≥1.5)。
- **三点棚拍**:引擎侧 1 盏 DirectionalLight(主光,场景平行光上限 1 盏)+ 2 盏 SphereLight(辅光/轮廓)实际照射 PBR 金属亮环;宝石 shader 内以同方向主/辅/轮廓三层响应显式叠加,层次肉眼可辨。
- **导出**:读当前画布像素(非预置 PNG),不冻结主循环(readPixels+toBlob 异步);实测两次均触发下载。
- **性能**:终验实测 rAF 帧率 60fps(≥30);场景 1 宝石 + 1 展台 + 1 亮环 + 地面/背景幕,切面 128(60–200 区间内)。
- **K0 适配**:API 全部从安装包 d.ts 与模板反推;踩坑记录:`setScale` 渲染路径不生效(尺寸改烘进几何体)、场景仅允许 1 盏 DirectionalLight、引擎无输出 gamma 转换(着色常数按显示域标定)、FLOAT4 uniform 必须传 Vec4 实例、pal 层吞 canvas 鼠标事件(双击走 window 捕获)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(build 6 次,全部成功,计数 6/8)
- [x] 2. 页面 10s 内 `window.__appReady === true`(终验 appReady=true,首帧即置位)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 严格返回 stateContract 四字段)
- [x] 4. 无未捕获异常(6 次浏览器验证 consoleErrors=0、uncaught=[])
- [x] 5. 探针自检:P1–P8 状态断言 + 视觉断言逐条自查全部通过(终验数据见上表;证据截图 selfcheck-1..6.png 于本 Arm 目录)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. ✅ 未访问另一 Arm(arm-a)的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. ✅ 未访问 `reference/` 及任何 Reference 实现/截图/视频/私有验证器。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. ✅ 未读 `harness/` 源码与合同模板(仅使用 workspace 内预置的 build/serve/count/verify-browser 脚本)。
5. ✅ 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎 API 仅来自 workspace 向上解析的共享 `node_modules/cocosair.js`(K0 安装包,d.ts 与运行时 bundle)。
6. ✅ 未读 `bench/docs/` 实验计划书与合同文档目录。
7. ✅ 未访问 `secret/`。
8. ✅ 无任何联网请求(无文档/搜索/registry 访问;未 `npm install`,未新增或改动依赖)。
9. ✅ 未安装新依赖、未改动共享 node_modules 内容。
10. ✅ 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码与探针结果文件。
11. ✅ 未探测或篡改 harness/validator 的行为与期望值。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件;全部构建经 `npm run build`(内置 count)、全部浏览器会话经 `scripts/verify-browser.mjs`(自动 count),无绕过。

预算终值(系统机器计数):buildAttempt 6/8 · browserAttempt 6/6(封顶未超)· toolCall 由 Runner 侧记录。
