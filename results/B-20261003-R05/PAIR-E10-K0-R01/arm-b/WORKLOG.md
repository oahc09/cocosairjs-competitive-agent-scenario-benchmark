# WORKLOG — PAIR-E10-K0-R01 / arm-b (cocosair)

```text
2026-10-03T00:20:00Z | 研读 | RUN-CONTRACT.md / brief.md / spec.json / knowledge(K0 README+manifest) / workspace 模板(main.js/build.mjs/serve.mjs/verify-browser.mjs/count.mjs) 通读完成
2026-10-03T00:35:00Z | 研读 | 共享 node_modules 内 cocosair.js@1.0.0-k0 包 build/cocosair.module.d.ts:GLTFLoader/GLTFAsset.instantiate/dispose、Animation/addClip/play/getState、AnimationState.current、WrapMode.Loop=2、DirectionalLight/SpotLight shadow API、primitives、Material.copy/recompileShaders(defines)、setProperty
2026-10-03T00:40:00Z | 资产 | 解析 assets/character.glb(只读):Fox,1 skin/24 joints,clips=Survey|Walk|Run,无 extensionsRequired,网格属性无 NORMAL;拷贝至 workspace/assets/character.glb(sha256 与冻结值一致:d97044e7…)
2026-10-03T00:50:00Z | 实现 | 重写 workspace/src/main.js:E10 双实例展示空间(单次 GLTFLoader.loadAsync → GLTFAsset.instantiate×2;规范名 idle=Survey/walk=Walk;三向光+环境光;地面/背景;data-bench+data-ui 六控件;__bench 契约)
2026-10-03T00:52:00Z | build | 成功(build#1,退出码 0,dist/app.js 12.2kb)
2026-10-03T00:55:00Z | serve | dev server 启动成功(PORT=7125,后台)
2026-10-03T00:56:00Z | 浏览器验证 | 成功(browser#1):appReady=true,bench 契约成立,0 console error/0 uncaught;state:assetLoaded=true,instanceCount=2,双 idle,time 推进;截图 shots/check1.png:双狐同屏、站位正确,但渲染近黑
2026-10-03T01:00:00Z | 诊断 | browser#2:场景图/蒙皮绑定诊断 — 双实例 SMR skeleton.joints 均为相对各自 skinningRoot 的路径(n=24),绑定正确
2026-10-03T01:05:00Z | 诊断 | browser#3:动画状态诊断 — 双实例 idle 状态均 playing=1、time 推进、wrap=2(Loop 生效);状态完全隔离且同步;state.fps=0(环样本未满,采样过早,非缺陷)
2026-10-03T01:08:00Z | 归因 | 本地解析 GLB:网格无 NORMAL 属性 → PBR(standard)光照 N·L=0 全黑;bundle 内确认引擎 gltf 解析器不生成法线(computeNormals 命中均为 Cannon 物理)
2026-10-03T01:12:00Z | 诊断 | browser#4:双实例 b_Hip_01 世界位姿完全一致(动画同步驱动)、共享 mesh/skeleton、tex=OK — 黑狐根因锁定为缺 NORMAL,非实例隔离缺陷
2026-10-03T01:15:00Z | 修复 | 狐狸改用 builtin-unlit 材质(不依赖法线)+ gltf 已解析贴图;重建(build#2 成功)
2026-10-03T01:17:00Z | 浏览器验证 | 部分成功(browser#5):fps=56.7 达标、状态正常、0 错误;截图 shots/check2.png:狐狸变白 → unlit 的 mainTexture 采样挂在 USE_TEXTURE 宏下,setProperty 不启用宏
2026-10-03T01:20:00Z | 归因 | bundle 内 unlit/standard 效果 JSON:unlit.mainTexture sampler defines=[USE_TEXTURE],standard.albedoMap defines=[USE_ALBEDO_MAP];且 recompileShaders 仅允许材质实例 → 必须 new Material()+copy(tpl,{defines}) 出实例再 setProperty
2026-10-03T01:22:00Z | 修复 | 新增 texturedUnlit(材质实例 + USE_TEXTURE + 贴图)用于狐狸与背景板;地面改 standard 实例 + USE_ALBEDO_MAP + 地坪光斑贴图
2026-10-03T01:25:00Z | build | 成功(build#3,退出码 0)
2026-10-03T01:28:00Z | 浏览器验证 | 成功(browser#6,最终综合会话):截图 shots/final-idle.png(双狐贴图正确/站位分离/完整入画/地面光斑过渡/UI 在探针区域外);单会话内按 spec 逐条走查 — P1✓ P2✓(双实例 time 推进)P3✓(A=walk/B=idle 隔离)P4✓(instanceCount=1,destroyedInstance=A,instances.A=null,B 不受影响)P5✓(销毁后 B time 持续推进,fps=58)P6✓(resetCount=1,双实例恢复 idle,无新资产请求/无刷新)P7✓(fps≈60,双实例 time 推进);附加 ISO-b✓(B 切 walk 不影响 A);0 console error,0 uncaught,appReady=true
2026-10-03T01:30:00Z | 收尾 | 停止 dev server;写 RESULT.md(实现摘要/自检清单/合规声明)
```

预算实际消耗(诊断性自报,判定以 .budget 机器计数为准):build ×3(上限 8)、browser ×6(上限 6,全部用于实现验证与归因,最终会话含全部探针走查)、工具调用远低于 120。

