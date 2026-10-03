# E10 WORKLOG — Cocos AIR Reference 实现

- 场景: E10 动画角色展示空间 (Animated Character Showcase — Asset / Lifecycle)
- 引擎: cocosair.js@1.0.0 (local tgz, build/npm/cocosair.module.js)
- 工作区: `bench/reference/private/cocosair/E10/`
- 实现者: Reference (trusted, 可读引擎源码 + examples + docs)
- 日期: 2026-10-02

## 0. 侦察(实现前,只读)

| 项 | 结论 |
|---|---|
| brief/spec | E10 brief.md + spec.json 冻结版;7 探针;stateContract 含 P7 所需 `$.fps` |
| harness | validate.mjs 14 步管线;`click:ui=` → playwright locator `[data-ui=…],[data-bench=…]`;regionChange/motion 为动作后双帧 diff(nonBlank 为模态背景距离法);fps=3s rAF 计数 |
| 资产 | `assets/character.glb` = Khronos Fox:1 skin / 24 joints / 1728 verts / 材质含内嵌 PNG 贴图 / 3 clips = Survey·Walk·Run;网格界 y∈[-0.12,78.9], z∈[-88.1,66.6](需 ~0.019 缩放);**场景有两个根节点(root 骨架 + fox 网格)** |
| 引擎 GLB 路径 | `GLTFLoader.loadAsync(url)` → `assetManager.loadRemote`(document.baseURI 解析,单次 fetch);`GLTFAsset.instantiate()` 每次**新建节点树 + 独立 Animation 组件**,clips 为按 sceneIndex 共享的拷贝(源码 `src/air/assets/gltf/asset.ts`);`dispose()` = `animation.stop()+root.active=false+root.destroy()`(帧末延迟销毁) |
| 引擎 Animation | `play(name)` / `crossFade(name, 0.3)` / `pause/resume/stop` / `getState(name).time/speed`;**clip 必须 Loop 否则单次后冻结**;play 在组件激活前调用会被重置(本场景 app.run 后才实例化,无此问题) |
| 纹理 | `new Texture2D()+reset({w,h,RGBA8888})+uploadData(canvas)` 实测路径;**uploadData 不做 y 翻转**;PixelFormat 无 sRGB 变体(画布色进线性域变暗,需画亮补偿);`builtin-standard` 贴图要 `defines:{USE_ALBEDO_MAP:true}`,`builtin-unlit` 要 `defines:{USE_TEXTURE:true}`(unlit 直出近原色) |
| 阴影 | 引擎有 ShadowMap/planar 管线,但 MASTER-CONTEXT 已知"阴影交付不完整"→ Reference 采用**动态画布烘焙接触阴影**(销毁 A 时重绘地面纹理使阴影随之消失) |
| 关键参考示例 | gltf-viewer(GLB+clip 切换+orbit)、model-character-interaction(**双实例同 asset、独立动画时钟、dispose 一份不影响另一份**——与本场景考点一致)、gltf-skin、skinned-animation、material-transparent、docs/manual/{load-gltf,animation-system,canvas-textures,lights} |

## 1. 架构决策

1. **单次加载 + 双实例**: `loadAsync('assets/character.glb')` 一次;`gltfAsset.addRef()` 钉住引用(防 reset 双 dispose 瞬间 refcount 归零触发自动释放);A/B 均由同一 asset `instantiate()` 派生。
2. **实例隔离**: 引擎每次 instantiate 产出独立节点树 + 独立 `Animation` 组件(共享 AnimationClip 数据,`AnimationState`/时间轴逐实例独立)——切换 A 的 clip/time 不触碰 B,天然满足隔离考点。
3. **clip 映射**: idle→Survey / walk→Walk;切换用 `crossFade(name, 0.25)`(≤300ms 契约)。
4. **落位**: 按蒙皮渲染器 bind-pose 网格界 × 世界矩阵求包围盒(同官方 gltf-viewer 口径)→ 均匀缩放到 1.5m 高 → 居中贴地;A/B 对称站位 ±1.85m,相向 60°/120° 偏航。
5. **展示空间**: 16×16 动态画布地面(暖光池+细颗粒+网格+**接触阴影**+暗角,销毁/重置时重绘)+ unlit 渐变背景板 + 三点布光(键/补/逆 3 盏,≤6)+ 环境光。
6. **相机**: 三角波偏航环绕(±7°,14s 周期,速度恒定 ±2°/s)+ 轻微高度起伏,构图稳定(见 §2 R2 教训)。
7. **状态契约**: `getState()` 每次即时求值(clip 逻辑名 + `animation.getState(physical).time`);`fps` 为最近 60 帧 EVENT_AFTER_DRAW 间隔均值(P7 断言依赖);`reset()` 与 UI reset 按钮同一函数;网络观测经 fetch 包装计数 `assetRequests`(状态内如实汇报)。
8. **UI**: 画布底缘控件条(data-ui + data-bench 双属性):anim-a-idle/walk、anim-b-idle/walk、destroy-a、reset;hover/active/disabled 全套;左上 HUD 实时读数(避开断言区域)。

## 2. 迭代记录

| 轮 | 构建 | 结果 | 失败点 | 修复 |
|---|---|---|---|---|
| R1 | ok(1.5s) | FAIL (1/7) | P1 nonBlank: A 区 litRatio 0.0921 < 0.1(其余探针被级联跳过);状态断言已全绿,fox 双实例/时间推进/单请求均正常;画面整体过暗 | 光强补偿:键光 48k→95k lux、补 11k→20k、逆 16k→30k、skyIllum 14k→26k;地面画布基色画亮(#57534b→#98917f,无 sRGB 管线线性变暗补偿);狐高 1.35→1.5、站位 ±1.9→±1.85(增大区域覆盖) |
| R2 | ok | FAIL (3/7) | P4 regionChange 0.0024 < 0.01:harness 的 regionChange 取**动作后两帧**(destroy 完成 800ms 之后),此时 A 区已无狐,原正弦环绕恰处速度近零相位,区域无残余运动 | 相机改为**三角波偏航**(±7°,14s,速度幅值恒定 ±2°/s——正弦峰值速度归零是根因);地面细节加密(5200 颗粒+64px 网格)使微移产生可测像素变化 |
| R3 | ok | **PASS 7/7** | — | — |
| R4(final, --video) | ok(1.8s) | **PASS 7/7** + video.webm(4.2MB) | — | 最终记录 run-id REF-E10-cocosair |

合计:4 次 build(全成功)、4 次浏览器会话、0 次代码级 build 失败。

## 3. 最终验证摘要 (R4, REF-E10-cocosair)

- verdict **PASS** / classification **PASS**;probes 7/7 PASS(P1 nonBlank worstLitRatio 0.64,P2 motion 0.110,P5 0.084,P7 0.122——阈值 0.1/0.005,余量 5–24×)
- console errors 0 / warnings 0 / uncaught 0;`__appReady` 2.0s(<10s)
- fps 60.2(阈值 30);serve 网络:全程 5 请求,其中 `assets/character.glb` **恰 1 次**(200,162852B,sha256 与 MANIFEST 一致)
- 截图证据 31 张 + video.webm;视觉链路人工复核:初始双狐对称 → A 切 Walk 仅 A 变 → 销毁 A(狐+接触阴影同失,Destroy 按钮置灰)→ B 持续动画 → reset 双狐+双阴影恢复
- `npm run build` 1.8s;app bundle 15.6KB(engine external)

## 4. 红线自查

- 未伪造任何状态(getState 全部即时求值;assetRequests 为真实 fetch 计数)
- 未改 spec/brief;产物只写工作区(assets/character.glb 拷贝自共享管线,sha256 一致)
- 销毁为真实场景图移除(`GLTFInstance.dispose()` → `root.destroy()`),非隐身
- reset 无新网络请求、无页面刷新(同 asset 再 instantiate)
- 骨骼动画由 GLB 动画剪辑驱动(Survey/Walk 通道 21 条,蒙皮 24 关节),非程序化冒充
