# RESULT — PAIR-E01-K0-R01 / arm-a (engine: three)

Run: 2026-10-03 · 场景 E01「深空星系巡航」· K0 · 一次性 R0 自主模式
实现入口:`workspace/src/main.js`(three.js r186,经 import map 解析本地 vendored 引擎,无网络依赖)

---

## 1. 实现摘要(逐 probe)

**总体实现**:单一源文件 `src/main.js`,三个 `THREE.Points` 批量层(双对数螺旋旋臂盘面 41,000 + 核球 9,000 + 远景背景星壳 10,000,合计 60,000 = `starCount` 状态值,每帧全量单次提交,`frustumCulled=false`);自定义 `ShaderMaterial` 逐星点位置/颜色/尺寸属性,加色混合软辉光圆点;全部程序化生成(确定性种子 RNG mulberry32 + Box-Muller 高斯),零外部资产。星系绕盘面法线(+Y)以 0.04 rad/s(合同区间 0.02–0.1)慢旋;相机固定仰角 45° 斜俯视(法线与视线夹角 45° ∈ [30°,60°]),滚轮改变目标距离并指数平滑([40,400],初始 120),指针视差经平滑后作为保持朝向的相机平移(近层星系位移大、远景背景位移小,真实视差,幅度 ≤ 画布 6%);HUD 为 DOM 覆盖层,数值逐帧取自运行状态;Reset 为纯状态恢复(epoch+1、相位/视差归零、距离 0.45s easeOutCubic 回 120),无页面刷新。

- **P1(starCount + 非空)**:60,000 个真实提交渲染星点(状态值 = 三层几何顶点总数),自检实测全画面亮像素占比 7.9%(截图独立分析 8.44%),阈值 ≥ 2%,旋臂盘面与核球在截图中可辨。PASS
- **P2(旋转 + 运动像素)**:2s 采样窗内 `rotationPhase` 增量 0.0864 rad(> 0.001;0.04 rad/s × 2s),时间步进基于时钟增量;中央 80% 区域运动像素占比 17.5%(阈值 ≥ 0.5%),星点沿切向整体流动。PASS
- **P3(指针视差)**:指针 (0.50,0.50)→(0.68,0.50) 后 `parallaxOffset.x` 由 0.0114 平滑过渡至 0.0184(指数平滑 τ=0.6s,无过冲),全画面像素差 12.8%(阈值 ≥ 0.3%),星系与远景背景层产生相对位移。PASS
- **P4(滚轮穿行)**:`wheel deltaY=-600` 后 `cameraDistance` 在采样窗内由 72.67 降至 63.39(Δ9.28 > 5),指数平滑逐帧插值无瞬跳,画面构图显著变化(星点放大变疏,像素差 30.1% ≥ 1%)。PASS
- **P5(HUD)**:`hudVisible=true`,HUD 文本含星点总数 60000、实时帧率、相机距离、相位(50ms 刷新),数值与 `__bench.getState()` 一致(四舍五入,实测四项偏差全部在容差内),Reset 按钮位于 HUD 区域内(text "Reset" + `aria-label="reset"` + `data-ui="reset"`)。PASS
- **P6(帧率)**:滚动 2s 平均帧率实测 59.99(自检会话内按 P6 前置条件复测),独立 rAF 计数 61 帧/1015ms ≈ 60fps;初始 120 / 缩进 60 / reset 后三个稳态均 60fps ≥ 30。PASS
- **P7(Reset)**:指针归位中心后点击 Reset,800ms 后 `epoch=1`、`cameraDistance=120` ∈ [115,125]、`parallaxOffset={0,0}`、`rotationPhase=0.032 < 0.1`,画面非空(亮像素 7.9%),无页面导航;连续两次 reset 行为一致(epoch 1→2,dist 120,视差归零)。PASS

**视觉锚点**:背景纯黑(0x000000,暗于 RGB 16,16,24);颜色沿半径梯度(核区暖黄白 → 中段蓝白 → 外缘冷蓝)+ 约 2.5% 橙红亮星散布;三档亮暗层级(亮巨星 7% / 普通盘星 61% / 暗弱星 32%);双条对数螺旋旋臂(r = 8·e^(0.268θ),展角 8.6 rad ≈ 1.37 圈)+ 高斯散布;核球 9,000 星点中央明亮聚集并带垂向厚度隆起;盘面厚度随半径衰减;星系盘投影宽度约占画面 62–67%;远景 10,000 静态星点壳增强纵深。

## 2. 自检清单(完成合同 §5)

- [x] **1. `npm run build` 在 workspace 根执行,退出码 0** — 2 次构建均成功(计数文件 `.budget/build.count` 自动记录 #1、#2);产物 `dist/` 由 `index.html` 经 import map 引用,构建自检(产物存在、引擎未打进 bundle)通过。
- [x] **2. 页面 10s 内 `window.__appReady === true`** — 3 次浏览器会话中 verify-browser 均在数秒内确认 `appReady:true`(首帧渲染后即置位;星点生成 < 100ms)。
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立** — 3 次会话 `benchReady:true`;`getState()` 返回冻结契约的 7 个字段(starCount / rotationPhase / cameraDistance / parallaxOffset{x,y} / fps / hudVisible / epoch),`reset()` 可重复调用且行为一致。
- [x] **4. 无未捕获异常** — 3 次浏览器会话 `consoleErrors: 0`、`uncaught: []`(加载、视差、滚轮、reset 全程)。
- [x] **5. 探针自检全部通过** — 会话 #1 页内按 spec.json probes P1–P7 口径(状态断言 + 像素级视觉断言)自检 7/7 通过;另以截图 PNG 独立分析(亮像素占比、HUD 区域非空)与截图人工视觉核验(旋臂/核球/色梯度可辨)作为独立观测证据。

预算使用(自报,判定以机器计数为准):build 2/8,浏览器验证 3/6,工具调用远低于 120,墙钟约 8 分钟 / 90 分钟。

## 3. 合规声明(逐条,§4 红线)

1. **未访问另一 Arm 的一切**(目录、代码、日志、dev server、浏览器 profile、截图、结果)— 声明属实。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)— 声明属实。
3. **未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;未访问一切既往 trial 结果** — 声明属实。
4. **未访问 `harness/` 源码与本合同模板** — 声明属实。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)— 声明属实;仅使用 workspace 上层共享 node_modules 中的 three 0.186.1 运行库(合同 §1 授权路径)。
6. **未访问实验计划书与 `bench/docs/`** — 声明属实。
7. **未访问 `secret/`** — 声明属实。
8. **未联网**(无任何网络请求;引擎由本地 vendored import map 解析,未访问任何文档/搜索/registry)— 声明属实。
9. **未执行 `npm install`,未安装新依赖,未改动共享 node_modules** — 声明属实。
10. **未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件** — 声明属实(仅改动 workspace 内自有实现文件与自建自检脚本)。
11. **未探测或篡改 harness/validator 的行为与期望值** — 声明属实(自检脚本仅按 spec.json 冻结文本自行复算断言)。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件;未绕过 `count.mjs` / `verify-browser.mjs` 计数** — 声明属实(构建经 `npm run build` 自动计数,浏览器会话一律经 `scripts/verify-browser.mjs` 自动计数)。

**Forbidden Shortcuts(brief §10 / spec.json)逐条声明未触犯**:无背景贴图/天空盒/预渲染全景(全部程序化点渲染);无 2D 位图/CSS 动画/DOM 位移冒充 3D 星系(WebGL 实时 3D 渲染);状态与真实渲染一致(亮像素与运动像素双证据);无画面冻结;星点 60,000 ≥ 50,000 且为真实单几何提交(无纹理平铺/重复图元虚报);无预渲染视频/序列帧;HUD 数值全部来自真实运行数据;无隐藏画布/缩视口骗像素;reset 为纯状态恢复,无 `location.reload`/整页刷新;未探测/篡改 harness。
