# ceiling-notes — E09 Material Ceiling 探测结论 · Cocos AIR 1.0.0

> 本场景的实验答案:**折射/反射/色散在 AIR 上"路径可达但引擎内置路径断裂"——需要自定义 EffectAsset 才能兑现引擎两相机 scene-color 管线的能力;观感上限为单次折射(single refraction,单厚度标量)+ 三次纹理采样的 RGB 色散,无二次折射/体积多次弹射/光谱渲染。**

## 1. 折射 / 反射 / 色散路径真实可达性(核心结论)

### 1.1 引擎内置 KHR transmission 路径:**死代码,BLOCKED**

- 证据:`src/air/assets/gltf/material/physical-effect.ts`(repo 与 vendored tarball 逐字一致):
  - L170:`#if USE_AIR_TRANSMISSION\nfloat airTrFactorTex = 0.0;\nfloat airThickTex = 0.0;\n#endif`(声明)
  - modulate 注入块(clearcoat/aniso/iridescence/bump 均有 `uniform → 局部变量` 赋值)**唯独没有 transmission 的两条赋值**;
  - L348:`float trF = clamp(airTrFactorTex, 0.0, 1.0);` + `if (trF > 0.0) {…}` → 恒假。
- 后果:材质侧 `airTransmission` uniform 被正确写入(官方浏览器验证脚本读回过非零值),但 `mix(finalColor, trColor, trF×…)` 的 trF 恒 0——**含 KHR_materials_transmission/volume/dispersion 的 GLB 渲染为普通不透明 PBR**,Beer-Lambert 与色散同为死代码。git 历史核实:自 T6 首次提交(09b624c)起即缺失,非回归。
- 能力面:`AirTransmissionCapture`(两相机 scene-color、按 define 认领 renderer、按属性名绑定 RT)**工作正常**——断裂只在 shader 注入层。

### 1.2 本 Reference 的兑现路径:**FEASIBLE(custom EffectAsset)**

自定义 effect 声明 `USE_AIR_TRANSMISSION` define + `cc_sceneColorTex` sampler + `airSceneColorInfo` uniform → 被 capture 自动认领 → 片元内:
- 屏幕空间折射:世界坐标投影 UV + `refract(-V,N,1/ior)` 视空间偏移 × 厚度(与引擎原式同构);
- RGB 色散:R/G/B 三个 IOR(ior∓disp)三次采样 → 真实火彩,随转台/视角流动;
- 菲涅尔三通道分立 F0 → 切面棱线彩虹缘;
- Beer-Lambert 体色在 JS 预混合后注入(规避 §3.2 的 Vec4 缺陷)。
- 实测:宝石透面可见倒置/扭曲的柔光箱与地面积光;五色切换体色分明;折射采样的是**实时渲染的离屏场景**(forbiddenShortcuts 1/2 不触发)。

### 1.3 观感上限(与"真宝石渲染"的差距,如实)

| 能力 | AIR 可达性 | 说明 |
|---|---|---|
| 单次屏幕空间折射 | ✅(本实现) | 单厚度标量、单次纹理采样;非逐厚度场 |
| RGB 色散(3 采样) | ✅(本实现) | 无光谱积分;Abbe 仅由 ior±disp 模拟 |
| 二次折射(入射+出射双面) | ❌ | 引擎 shader 无背面厚度积分;本实现亦单次 |
| 镜面反射 | ✅ | Blinn-Phong(自定义)/ GGX(builtin);环境反射走 cubemap IBL |
| 环境反射(IBL) | ✅(LDR cubemap) | `skybox.envmap + useIBL`,程序化 6 面即可;无 HDR/RGBE 卷积,粗糙度 LOD 近似 |
| 平面反射(地面镜面) | ❌ | 无 planar reflection;地面用中粗糙金属 + IBL 的"微反射"观感替代 |
| 后处理(Bloom/Glare) | ❌ | 默认 Code First 路径无可用后处理(能力审计已知);火彩亮度只能靠曝光/色调曲线内联于 shader |
| 阴影 | ❌(未启用) | 交付不完整(审计已知);本场景以接触暗部+轮廓光替代 |
| 多相机传输排序 | ⚠️ | 单 capture/场景;材质实例单 RT 绑定(引擎注释明示) |

## 2. 六维自评(0–3,给盲评对照的诚实基线)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 宝石居中主体、暗幕环绕、三点光分层;地面积光与柔光箱构成前中后景;近景(6)略满,远景(10)节奏好 |
| 材质光影 | 2.5 | 真实屏幕空间折射 + RGB 色散 + 三点镜面 + IBL;缺 HDR 环境/二次折射/Bloom,金属地板反射为近似 |
| 动效流畅 | 3 | 42°/s 转台 + 900ms easeInOutCubic 双击往返 + 轮廓光 0.4 rad/s 环绕 + 柔光箱呼吸,全程 60fps 无跳变 |
| 特效质感 | 2 | 火彩/高光扫动成立,但无 Bloom 加持的"辉光感",色散强度受阈值约束保守(0.18) |
| 交互反馈 | 3 | 色板即时变色(五色 RGB 实测分明)+ 选中态放大描边 + 双击推近/拉回 + 真实下载 + reset 全恢复 |
| 整体完成度 | 2.5 | 8/8 探针、0 控制台错误、稳定 4×复跑;UI 精致克制;debug 脚本仅存 shot.mjs |

自评合计 15.5/18(`visual = round(15.5×40/18) ≈ 34/40` — 仅作参考,以盲评为准)。

## 3. 缺口清单(Product Capability Gap 候选)

### 3.1 引擎缺陷(建议回传上游 / 纳入能力文档)

1. **`air-gltf-physical` transmission 注入死代码**(§1.1):一行级修复(补 `airTrFactorTex = TRANSMISSION_CONSTANT.x;` 与 thickness 赋值)即可让 KHR 路径复活;当前"官方支持 transmission"的能力声明与实渲染不符。
2. **`Light.color` 传 `Vec3` → NaN 全白**:`setter` 读 `.r/.g/.b` 且不做类型校验,NaN 静默扩散到整屏受光像素。建议:类型断言或 d.ts 标注 `Color`。
3. **运行期 `Material.setProperty(name, Vec4)` 丢第 4 分量**(实测:初始上传正常,更新后 shader 读到 0;staged `pass.getUniform` 读回正常):影响一切依赖 `.w` 的运行期材质动画;本实现以 JS 预混合规避。根因疑在 staged→GPU 上传路径,未深挖。
4. 双面材质需同时 `USE_TWOSIDE` + `rasterizerState.cullMode`(文档已知但易踩,建议 API 化)。
5. 亮度口径分裂:material-table"illuminance 8–14"(LDR 语义)与 examples 50,000 lux(HDR+exposure 语义)并存,且 SpotLight 又叠加 `size/光效面积/×10000` 换算——建议一份统一换算表。

### 3.2 本实现自身缺口(如实)

- 折射为单次屏幕空间近似,厚度是标量(非按切面厚度场);色散为 3 采样(非光谱)。
- 地面"轻微反射"为 IBL+宽镜面近似,无真实 planar reflection。
- 无阴影/无后处理(引擎限制,见 §1.3)。
- 环境 cubemap 为 256² LDR 程序化贴图,粗糙度反射的 LOD 卷积由驱动 mipmap 近似。
- 色散强度、白菲涅尔底、体色保底(0.18)等参数为暗棚观感手工标定,非物理标定。

## 4. 对 Agent Run 的可迁移结论(K2 视角)

1. 想要真实折射/色散:**不要走 glTF transmission 扩展**(当前版本死代码);走自定义 EffectAsset + AirTransmissionCapture,声明 `USE_AIR_TRANSMISSION` + `cc_sceneColorTex` + `airSceneColorInfo` 同名槽位即可被管线认领。
2. 运行期改材质:写 `renderer.material` 返回的实例;**只用 Vec4 的 xyz**,`.w` 会在更新时丢。
3. 灯光颜色一律 `new Color(r,g,b,255)`;强度用 HDR 量级 + `camera.iso` 控曝光。
4. 大面积低粗糙金属面会引爆 GGX 镜面瓣;地面 roughness ≥0.4。
5. 视觉断言型探针(regionChange)在暗背景下对"均匀折射体"不敏感:需要(宽容对比度的)折射偏移量、环绕光扫动或背景闪烁来制造持续像素变化——本实现三者并用后 P4/P5 diff 达阈值的 2.5–6 倍。
