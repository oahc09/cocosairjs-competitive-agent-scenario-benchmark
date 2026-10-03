# WORKLOG — E09 珠宝展示台 · Cocos AIR Reference(trusted)

- run-id: `REF-E09-cocosair`
- 日期: 2026-10-02(UTC+8)
- 工作区: `bench/reference/private/cocosair/E09/`
- 引擎: cocosair.js@1.0.0(vendored k0 tarball,`dist/vendor/cocosair.module.js` sha256 `3ccfdde1…`)
- 最终结果: **PASS · 8/8 probes · fps 60.2 · downloads 324,952 B / 265,830 B · console 0 error**(见 `validation/report.json`、`validation/video.webm`)

## 0. 产物结构

| 文件 | 职责 |
|---|---|
| `src/main.js` | 场景/相机/三点布光/环境 cubemap+IBL/展台/转台/色板/双击推近/PNG 导出/reset |
| `src/gem-effect.js` | 自定义 EffectAsset `e09-gem`(glsl4/3/1 三变体):菲涅尔 + 三点镜面 + **两相机 scene-color 折射 + RGB 三通道色散** |
| `src/gem-geometry.js` | 程序化十边形阶梯/明亮式切型宝石:81 切面 / 98 三角(brief 60–200 区间),逐面平直法线 |
| `src/studio-env.js` | 程序化摄影棚 cubemap(6×256² RGBA,暗渐变 + 柔光箱)→ skybox envmap + IBL |
| `scripts/shot.mjs` | 本地取景调试脚本(serve dist → 截图 → ASCII 预览;非构建产物) |

未使用共享资产 `assets/gem.glb`(brief §5 允许程序化替代,程序化可控制切面数与法线质量)。

## 1. 迭代时间线(validate 调用共 23 次,esbuild 构建约 30 次)

| # | 结果 | 根因 / 动作 |
|---|---|---|
| R1 | FAIL RUNTIME(appReady=false) | `new Vec4(...Vec3, 0)`——Vec3 不可迭代;改为分量展开 |
| R2 | FAIL(P1 visual 5.1%) | **全屏纯白**。开始白屏围猎(见 §2) |
| R3–R5 | P1–P4 过,P5 0.0046 | 白屏已修;P5(regionChange 0.5×0.7 区)转台信号被稀释 → 宝石放大/对比增强 |
| (中期) | 探针全绿但发现 ruby 与 diamond 画面逐位相同 | **运行期 uniform 失效围猎**(见 §3),修复后 5 色 RGB 实测分明 |
| S1–S3 | P5 0.0075–0.009(边缘) | 白平衡重构削弱了转台闪烁信号 |
| F1–F3 | P4 0.0043(新) | 宝石放大后近景被暗折射体填满,遮挡了变化的背景 |
| G1–G3 | P4 仍 0.0031 | 近景静止根因:折射采样的是**无对比度的均匀暗墙** |
| H1–H3 | P5 一次 0.0046 | 探针序列里 P5 处于 **ruby** 态——纯吸收会杀死 g/b 通道的折射流动 |
| I1–I4 | **4× PASS** | 折射偏移×1.8 + 色散 0.18 + tint 0.18 保底 + 轮廓光环绕 0.4 rad/s |
| FINAL | **PASS + video** | 清理调试钩子,常量修正(81 切面),复跑一致 |

稳定性验证:修复后连跑 4 次 8/8 PASS(fps 60.0–60.3),再以 `--video` 收官。

## 2. 白屏围猎(约 10 个二分变体,scripts/shot.mjs 快速循环)

现象:任何受光标准材质整屏 255 白;无光变体全黑;hello-cube 等价复刻(parity 变体)正常。
二分路径:min 场景 → nofloor/nowall → keyonly/amb → fk6lights(最小复现:地板+spot=白,lum=0 仍白)→ 定位到 **DirectionalLight/SpotLight 存在即白**。

**根因(引擎事实,非本实现 bug):`Light.color` setter 形参是 `Color`(0–255,读 `.r/.g/.b`);传入 `Vec3` 时 `.r/.g/.b` 为 `undefined`,`undefined/255 = NaN`,NaN 污染全部受光像素 → 纯白。**
修复:三灯全部改传 `Color` 对象。(`src/cocos/3d/lights/light-component.ts` L142–148。)

顺带排掉并记录的候选:IBL/envmap(非)、传输捕获(非)、pbrParams 写法(非)、Color 归一化(非)。

## 3. 运行期 uniform 失效围猎(探针全绿但画面失真)

现象:点击色板后 `selectedColor` 正确、实例 `_props` 与 `pass.getUniform` 读回均为新值,但渲染逐位不变。
复现与二分(临时 probe 页,已删):
- 最小自定义 effect + 实例化 + 捕获 + 旋转 + skybox:live setProperty **正常**;
- 换成真实 `gem-effect.js`:失效;
- trivial 片元(直出 gemTint.rgb):正常;只输出 `.a`:初始默认值 0.15 正确,**更新后恒 0**;
- 采样器直测:`cc_sceneColorTex` 采样 = 离屏清屏灰 51/255,**捕获绑定链路正常**。

**结论(引擎事实):运行期 `Material.setProperty(name, Vec4)` 只有 xyz 到达 shader,第 4 分量更新后恒 0(初始默认值上传正常)。** 疑似 staged buffer → GPU 上传路径的分量/步长缺陷;未再深挖驱动层。
**规避(本实现):** Beer-Lambert 吸收与 mix 在 JS 预混合,只以 xyz 通道传"预混合体色";shader 内菲涅尔幂常数化;每帧写只依赖 xyz(emissive 呼吸、lightCDir 环绕)。修复后五色实测(宝石中心 7 点采样均值):

| 色 | RGB |
|---|---|
| diamond | (145,149,159) |
| ruby | (145,85,96) |
| emerald | (81,100,96) |
| sapphire | (82,85,159) |
| amber | (145,93,102) |

## 4. 其余引擎实测坑(全部已核实并规避)

1. **KHR transmission 引擎路径死代码**:`air-gltf-physical` 片元里 `airTrFactorTex/airThickTex` 声明 0.0 后无任何赋值(`src/air/assets/gltf/material/physical-effect.ts` L170/L348,vendored tarball 一致)→ `trF=0`,折射/色散瓣永不生效。详见 ceiling-notes。
2. `renderer.material = m` 会实例化 MaterialInstance;运行期 setProperty 必须写实例(与引擎示例"正典"一致)。
3. 亮度口径(HDR 管线):DirectionalLight.illuminance 用 lux 量级(≈5×10⁴);SpotLight 为 `luminance × exposure × 10000` 且 `size` 是物理光源面积(大柔光箱 size 大);暗棚用 `camera.iso = ISO800` 提曝光,不要缩物理灯值。material-table 的"illuminance 8–14"是另一套(LDR)口径,不可混用。
4. 低粗糙金属地面 + GGX 镜面瓣会把主光放大成整屏白:地板 roughness 0.46。
5. `USE_TWOSIDE` 只翻法线不改 cullMode:双面几何必须同时给 `rasterizerState.cullMode = NONE`(states 走 glTF 同款)。
6. `primitives.plane` 是 XZ 水平面:竖立柔光箱用薄 `box`。
7. `primitives.torus` 在 XZ 平面(不要额外立旋)。
8. WebGL2 swapchain 以 `preserveDrawingBuffer:true` 建上下文(`webgl2-swapchain.ts` L147):DOM 回调里 `canvas.toBlob` 直接有效。
9. skybox 需 `camera.clearFlags=SKYBOX` 才作为可见背景;本实现背景由几何暗幕承担,envmap 仅供 IBL。
10. 圆柱幕从内侧看是背面:必须双面(见 5),否则整圈墙不可见。

## 5. 行为契约实现要点

- 转台:`rotationAngle` 42°/s 单调累计(≥25),相位驱动节点 Y 旋转,reset 不清零(保持单调语义)。
- 双击:`#GameCanvas` DOM dblclick → 相机沿固定机位方向真实位移 10 ⇄ 6(900ms easeInOutCubic,>600ms),`cameraDistance` 为实时值。
- 导出:`canvas.toBlob('image/png')` → `a[download=gem-E09-NNN.png]` 真实点击下载;下载触发后才 `exportCount+1`;文件名序号独立于 reset(无同名冲突)。实测 324,952 / 265,830 字节(>10,240 ✓),分辨率 1280×720 与画布一致。
- reset:色板回 diamond、相机缓动回 10、exportCount 清零、转台继续;无页面刷新。
- 状态:`window.__bench.getState()` 返回 `rotationAngle/selectedColor/cameraDistance/exportCount`(+engine/resetCount/ready),无伪造。

## 6. 效率口径(如实)

- validate 调用 23 次;esbuild 构建 ≈30 次;本地 shot.mjs 取景 ≈25 次;浏览器进程启动 ≈55 次。
- 大头消耗在两个"探针全绿但画面错"的引擎缺陷围猎(白屏 NaN、Vec4 丢 w),各约 8–10 个二分变体。
