# RESULT — Arm A of PAIR-E05-K0-R01(three r186 / K0)

> 交付物:`workspace/` 内 E05 黑洞吸积盘实现(全程序化,无外部资产);
> `npm run build` 产物 `dist/`,经 `node scripts/verify-browser.mjs` 完成 6 次浏览器会话验证,
> 最终状态 = build#5 产物(浏览器会话 #6 全量探针自检通过,截图 `selfcheck-shot6.png`)。

## 1. 实现摘要(逐 probe)

**统一契约**:esbuild 打包 `src/main.js` → `dist/app.js`(引擎经 import map 外部解析,离线);页面暴露 `window.__appReady`(首帧渲染完成即置 true)与 `window.__bench = { getState, reset }`;无任何网络请求,无未捕获异常。

- **P1 初始画面非空且吸积盘可见** — 深空层 = 星云着色球(近黑蓝基底+冷色星云,保证四角外围 nonBlack≈100%)+ 780 颗软光斑背景星;中心 = 纯黑事件视界圆盘(直径 89px ≈ 短边 12.3%,落在 brief 8–15%)被白热光子环与盘内缘亮环包围;实测中心 1/3 区域 nonBlack 94.1%(≥5%)。
- **P2 盘旋转运动证据** — 盘面条纹由 uniform `uRot = diskRotation` 驱动(4 臂对数螺旋 + 9 次谐波,时间参数连续旋转,角速度 0.45 rad/s ∈ [0.15,0.6]);实测 0.8s 采样差 dRot = 0.405 rad(≥0.1),条纹/星流位移使盘面两帧差分显著非零。
- **P3 径向颜色梯度(多普勒亮侧有向 R-B 差)** — 着色器径向色带 白(≤2.4u)→黄→橙(平台 3.6u±1.25)→暗红长尾,叠加多普勒束射(+X 亮侧 ×1.70);按 spec 几何(0.06–0.14 / 0.18–0.30 × minD,±6% 高度带)实测亮侧:avgRB(外) 55.58 − avgRB(内) 32.72 = **22.85 ≥ 18**,内环亮度 218.3 = 外环 74.2 的 **2.94×(≥1.5)**,衰减全程 smoothstep 无硬边。
- **P4 相机缩放构图变化** — `wheel` 负 dy ⇒ targetDist×exp(0.00085·dy) 夹在 [5,28],指数平滑(1s 内残差 <0.01%);dy=−600 实测 cameraDistance 14→**8.41**,暗核屏幕半径 44px→73px(**1.66× ≥ 1.25×**),构图随距离单调变化。
- **P5 星流螺旋** — 420 粒子(≥200,恒定)沿 Kepler 式 ω∝r^−1.5 螺旋汇入,径向内旋近视界加速,线段拖尾近视界拉长(0.10→0.70u),r<1.18 即在外圈 4.8–8.4u 重生;星流头部/条纹运动使 mid-ring 两帧差分非零。
- **P6 reset** — `data-ui="reset"`(右上角 DOM 按钮,归一化位置 x≈0.97, y≈0.017)等价 `__bench.reset()`:diskRotation/accretionPhase 立即归零、cameraDistance 瞬时回 14.0、星流全体重生、背景星不动;reset 后 400ms 实测 dist=14、diskRotation=0.188(<0.3)、accretionPhase=0.030(<0.1)、starStreamCount=420。

**加分项**:多普勒不对称(亮侧 lum 74.2 vs 暗侧 44.6);光子环包绕暗核的引力透镜观感;辉光以着色器软晕实现(盘面高斯热区、光子环宽晕、星点软光斑贴图),路径不限合规。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 结果 |
|---|---|---|
| 1 | `npm run build` 于 workspace 根退出码 0 | ✅ 共执行 6 次,全部退出码 0(预算 6/8;.budget/build.count=6) |
| 2 | 页面 10s 内 `window.__appReady === true` | ✅ 每次会话 appReady=true(远小于 10s) |
| 3 | `window.__bench = { getState(): object, reset(): void }` 契约成立 | ✅ benchReady=true;getState 返回真实状态 |
| 4 | 无未捕获异常(console 无 error 级未捕获错误) | ✅ 六次会话 consoleErrors=0、uncaught=[] |
| 5 | 按 spec.json probes 逐条自查(状态断言+视觉断言)全部通过 | ✅ P1–P6 全过(证据:会话 #5/#6 eval 数值 + selfcheck-shot5/6.png;P3 最紧阈值余量 1.27×,其余 ≥1.9×) |

关键实测数据(会话 #6,1280×720):`backgroundStarCount=780 ≥300`、`starStreamCount=420 ≥200`、`cameraDistance=14 ∈[13,15]`、暗核半径 44px(直径 12.3% 短边)、P3 有向差 22.85、P4 后 8.41 且核半径 1.66×、P6 全断言达标。

## 3. 合规声明(逐条对应 RUN-CONTRACT §4)

1. ✅ 未访问另一 Arm(arm-b)的任何目录、代码、日志、dev server、截图或结果。
2. ✅ 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录及既往 trial 结果。
4. ✅ 未读取 `harness/` 源码与合同模板(仅按合同要求调用 workspace 自带 scripts)。
5. ✅ 未访问 `bench/vendor/` 与引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经模板 import map 的 `dist/vendor/` 运行时使用。
6. ✅ 未读取实验计划书与 `bench/docs/` 合同文档目录。
7. ✅ 未访问 `secret/`。
8. ✅ 未发起任何网络请求(无文档/搜索/registry 访问;页面运行时亦零网络依赖)。
9. ✅ 未执行 `npm install`,未安装或改动任何依赖(共享 node_modules 只经构建脚本向上解析)。
10. ✅ 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码与探针结果文件。
11. ✅ 未探测或篡改 harness/validator 行为与期望值(像素自检函数 `window.__debug` 为本 Arm 开发工具,采样几何严格照抄 spec.json 公开参数,不构成特判)。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;构建一律 `npm run build`(自动计数),浏览器会话一律经 `node scripts/verify-browser.mjs`(自动计数),最终 build=5/8、browser=6/6,未绕过任何计数。

**预算终态**(以 `.budget/` 机器计数为准):buildAttempt **6**/8(全部退出码 0,最后一次构建即浏览器会话 #6 所验证的交付产物,此后未再改动代码)· browserAttempt **6**/6(已用满,故不再有验证会话)· toolCall 约 29/120 · 墙钟约 42/90 分钟。
