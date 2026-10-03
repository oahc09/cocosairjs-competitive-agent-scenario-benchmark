# E10 ceiling-notes — Cocos AIR 引擎能力天花板笔记

> 场景:E10 动画角色展示空间(Runtime GLB / 骨骼动画 / 实例隔离 / 生命周期)
> 实现基准:Reference FEASIBLE,7/7 探针,fps 60.2。
> 本笔记供 Ceiling 评分与路线图使用:重点记录 Runtime Asset / 骨骼动画 / 实例隔离 / 生命周期 API 的**真实表现**(源码核实 + 运行验证),以及引擎缺口。

## 1. 六维自评(0–3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 双实例对称站位相向 60°/120°、中景平视微俯(~8°)、恒速 ±7° 环绕保持构图稳定、UI 居底缘/HUD 居左上避开主体;未达 3:展示空间元素相对朴素(无展台圆盘/氛围道具的层次堆叠) |
| 材质光影 | 2.5 | 三点布光(键 95k/补 20k/逆 30k lux)+ 环境光 26k 成立,狐毛贴图分区清晰,地面暖光池/暗角/接触阴影可辨;未达 3:无真实投影(接触阴影为画布烘焙),无 sRGB 管线导致程序化贴图需手工提亮 |
| 动效流畅 | 3 | 双蒙皮实例 60fps;Survey/Walk 骨骼驱动;crossFade 0.25s 平滑切换;相机恒速环绕无跳变 |
| 特效质感 | 1.5 | 仅有程序化光池/渐变背景/软接触阴影/颗粒地面;引擎 Code First 路径无可用后处理(无 Bloom,已知短板),透明混合材质需绕 glTF BLEND 或自行 overridePipelineStates |
| 交互反馈 | 3 | 6 控件即时响应(≤300ms 过渡)、hover/active/disabled 全套、销毁即置灰、reset 无闪烁不重载、HUD 实时同步 clip/time/fps |
| 整体完成度 | 3 | 加载→双实例→独立动画→隔离切换→销毁→存活→reset 全生命周期链零异常,合同项全达成,证据链完整(31 截图+录屏+网络日志) |
| **合计** | **15.5/18** | visual = round(15.5 × 40 / 18) = **34/40** |

## 2. 能力清单(E10 覆盖域 × Cocos AIR 真实表现)

### 2.1 Runtime Asset(GLB 运行时加载)
- **`GLTFLoader.loadAsync(url)`**:✓ 一等公民。相对 URL 按 `document.baseURI` 解析(loader.ts `absoluteURL`);内部 `assetManager.loadRemote` + downloader 注册的 fetch 路径,带**缓存与 in-flight 去重**(工厂层)——同 URL 二次 loadAsync 不再发网络请求。
- **单请求双实例**:✓ 标准姿势。asset/instance 两层分离:解析一次 `GLTFAsset`,多次 `instantiate()`,共享 mesh/material/texture/skeleton GPU 资产——正是 brief §5 要求的"单次加载数据派生"。
- **`parseAsync(text|ArrayBuffer, baseUrl?)`**:✓ 内存路(GLB ArrayBuffer 直解),适合已持有数据的场景。
- **解码器**:Draco 解码 wasm 本环境不可用(引擎 docs 自证);Fox 无压缩,零依赖安全区。KTX2/meshopt 通路存在未取证。
- **引用计数**:`asset.addRef()/decRef()` 存在;`instantiate()` 内部自 addRef,`dispose()` 对应 decRef;`asset.destroy()` 延迟到 instances==0 才真正释放 GPU 资源(asset.ts releaseResources)。**实践要点:跨 reset 复用的 asset 应显式 addRef 钉住,防止"双实例同时销毁→refcount 瞬时归零"的自动释放窗口**。

### 2.2 骨骼动画(Skinned Animation)
- **蒙皮渲染**:✓ instantiate 自动为 skin 节点挂 `SkinnedMeshRenderer`(`setUseBakedAnimation(false)` 实时蒙皮,`skinningRoot`=实例根)。Fox 24 关节/1728 顶点双实例 60fps 无压力。
- **Animation 组件(clip 路线)**:✓ 每实例一个,挂在实例根上。`play(name)`/`crossFade(name, 0.3s)`/`pause()`/`resume()`/`stop()`/`getState(name)` 全可用;`AnimationState.time` 可读(播放秒数)、`speed` 可写(官方示例用它做独立时钟自证)。
- **Loop 必须**:⚠️ `AnimationClip.wrapMode` 默认非 Loop——不设置则剪辑播完**冻结在末帧**(不会崩溃,但 motion 断言静默失败)。glTF 导入的 clip 在首次 instantiate 时拷贝(拷贝继承 source.wrapMode),**须在首次 instantiate 前设置源 clip 或对每实例 `inst.animations` 逐一设置**。
- **激活时序坑**:⚠️ `play()` 在组件激活前调用会被激活流程重置(docs/manual/animation-system 实测)——本场景 app.run 后才 instantiate/play,天然规避;若先建场景后 run,应在组件 `start()` 里播放。
- **SkeletalAnimation 组件**:另一条程序化骨骼路(`buildSkeletonTree`/`restoreBindPose`/sockets),本场景无需;GLB 路线走 Animation 组件。

### 2.3 实例隔离(本场景核心考点)
- **节点树/组件**:✓ 完全隔离。每次 `instantiate()` 新建整棵节点树 + 新 `Animation` 组件 + 独立 `AnimationState`(逐实例时间轴)。切换 A 的 clip/crossFade/time 不影响 B(model-character-interaction 示例以 speed 1 vs 2 实证独立时钟;本实现 P3 状态断言+画面证据)。
- **共享层**:AnimationClip 数据对象按 sceneIndex 缓存共享(sceneClips Map)——**wrapMode 等剪辑级属性是跨实例共享的**(运行态不共享)。若需逐实例剪辑变体(如不同速度曲线),须自行再拷贝 clip。
- **材质**:实例间共享 asset 材质对象;逐实例换材质官方姿势是 `renderer.setSharedMaterial(mat, slot)` 或 material instance(官方示例用它做选择高亮,引用逐渲染器核对不串扰)。
- **克隆 API**:无独立 `instantiate(node)` 泛型克隆——GLTF 语境的实例化收敛在 `GLTFAsset.instantiate()`;通用节点克隆(SkeletonUtils.clone 等价物)在 Code First 公开面上未见。

### 2.4 生命周期(销毁/重建)
- **`GLTFInstance.dispose()`**:✓ 真实销毁:`animation.stop()` → `root.active=false` → `root.destroy()`(Cocos 帧末延迟销毁;`isValid(root)` 在 settle 后为 false)。从场景图移除、不渲染,非"隐身"。
- **销毁不影响兄弟实例**:✓ P4/P5 实证(A 销毁后 B time 持续推进、画面持续运动、零异常)。
- **重建(reset)**:✓ 同一 asset 再次 `instantiate()` 即得全新实例,**零网络请求、零页面刷新**;P6 断言 + 网络日志(整会话 glb 请求恒为 1)。
- **资源释放语义**:dispose 只回收实例层;asset 层(网格/贴图/骨架)由引用计数管理,destroy 且 instances==0 才释放 GPU——"销毁实例 A 后内存不得继续增长"在实例层面成立(帧率 60 不降)。
- **Animation 组件生命周期**:onLoad/onEnable/onDisable/onDestroy 齐备(官方示例有全钩子探针);tween 与节点生命周期联动(失活自动 pause、销毁自动清理)。

### 2.5 材质/纹理/光照(展示空间支撑)
- 画布纹理 `Texture2D.reset()+uploadData(canvas)`:✓(动态重传亦 ✓,销毁 A 时重绘地面即用);**坑:不翻转 y、无 sRGB(线性变暗)、非 POT 纹理只允许 CLAMP_TO_EDGE**。
- `builtin-standard` 贴图需 `defines:{USE_ALBEDO_MAP:true}`;`builtin-unlit` 需 `{USE_TEXTURE:true}`(unlit 直出近原色,适合背景板)。
- glTF 材质(含内嵌 PNG 贴图)开箱即正确;alphaMode BLEND 透明经 glTF 路径可用(引擎示例实证),原生 Material 透明需 `overridePipelineStates`(winding.ts 有官方用例)。
- 三点布光:`DirectionalLight.illuminance`(HDR lux,30000–65000 量级;LDR 值不可见)×3 + `scene.globals.ambient`(app.run 后 `skyColorHDR.set()` + `skyIllum`)。**多平行光 ✓**。
- 阴影:**未采用**。引擎有 ShadowMap/planar 管线但 Code First 路径交付不完整(能力审计结论);本实现以动态画布烘焙接触阴影替代,销毁联动(阴影随实例消失)反而成为 P4 的视觉加分项。

## 3. 引擎缺口(影响天花板的事目)

1. **无 sRGB 纹理格式**:程序化画布纹理在线性域显著变暗,程序化视觉需手工亮度补偿——Agent 常见"调不出参考观感"的隐性根因之一。
2. **Code First 后处理缺失(无 Bloom 等)**:特效质感维度被直接压顶(本场景 1.5/3 的主因)。
3. **阴影交付不完整**:接触阴影只能烘焙或冒险走 ShadowMap;"地面接触阴影"类 brief 要求需要应用层技巧。
4. **透明材质原生路径别扭**:Code First 下开透明要么手搓 glTF BLEND 资产、要么 overridePipelineStates(有官方用例但非文档化一等公民)。
5. **剪辑级属性跨实例共享**(wrapMode/duration):需要逐实例剪辑变体时须手工拷贝 clip,隔离语义在"剪辑数据"这一层是共享的(运行态隔离无碍,但边界应知)。
6. **区域运动类断言的引擎无关陷阱**(非引擎缺口,记给 K 包/评分侧):harness regionChange 取动作后双帧,纯静态相机+已销毁区域会误判"无变化"——场景必须自带持续运动源(本 Reference 用恒速环绕;正弦环绕在峰值相位速度归零亦会翻车,R2 实录)。

## 4. 与 Three.js 对照预期(供 pair 分析)

- Three 侧 GLTFLoader + SkeletonUtils.clone 是双实例标准姿势,clip 可选共享/克隆;AIR 的 asset.instantiate 等价能力完整,无明显差距。
- Three 有 OrbitControls、sRGB 纹理、后处理、阴影——展示空间类场景的材质光影/特效质感两维预计 Three 占优;骨骼动画/实例隔离/生命周期功能面双引擎等价达成,差异主要在 API 人体工学(GLB 实例化 AIR 更顺手;纹理色彩管理 Three 更省心)。
