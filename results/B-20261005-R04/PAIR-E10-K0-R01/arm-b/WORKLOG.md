# WORKLOG — PAIR-E10-K0-R01 / arm-b (cocosair, K0)

格式:`<ISO-8601> | <动作> | <结果(成功/失败+一句话原因)>`

```text
2026-10-05T16:38Z | 读合同/规格 | 成功 — RUN-CONTRACT.md、brief.md、spec.json v1.0.1 全文已读;预算 build≤8/browser≤6/toolCall≤120
2026-10-05T16:40Z | 知识调研 | 成功 — K0:knowledge/README.md + 引擎包内 build/cocosair.module.d.ts(K0 manifest 明示入口);确认 GLTFLoader.loadAsync→GLTFAsset.instantiate→GLTFInstance{root,animations,dispose}、Animation 组件、仅允许 1 盏实时平行光
2026-10-05T16:42Z | 资产解析 | 成功 — node 解析 character.glb:1 skin/24 joints、clips=[Survey,Walk,Run]、身高~79 单位;映射 idle→Survey、walk→Walk,scale 0.02
2026-10-05T16:45Z | 资产就位 | 成功 — ../assets/character.glb(只读)拷贝至 workspace/assets/character.glb,sha256=d97044e7…与 spec 一致;原 assets/ 目录未改动
2026-10-05T16:58Z | 实现 | 成功 — src/main.js 全量实现:三灯+环境光、地面/展台/渐变背景、双实例 instantiate 派生、UI 控件(data-ui+data-bench 双属性)、__bench 契约、fps 滑动窗口
2026-10-05T17:00Z | build #1 | 成功 — npm run build 退出码 0,dist/app.js 9.6kb(引擎 external)
2026-10-05T17:02Z | serve | 成功 — PORT=7127 node scripts/serve.mjs 静态服务启动
2026-10-05T17:03Z | 浏览器验证 #1 | 部分成功 — appReady=true、双实例 idle、time 推进、0 console error;但狐狸渲染为纯黑剪影(截图 .verify/shot-p1.png),fps 窗口 2.7(启动期)
2026-10-05T17:10Z | build #2 | 成功 — 加 window.__e10 诊断钩子与材质日志
2026-10-05T17:12Z | 浏览器验证 #2 | 诊断 — GLTF 加载器自身已在实例根挂 Animation(含全部剪辑状态);此前又加第二个 Animation → 状态时间冻结(同节点双 Animation 与动画管理器冲突)
2026-10-05T17:15Z | 浏览器验证 #3 | 诊断 — 材质 effect=air-gltf-standard、propertyNames 为空;加载器 Animation playOnLoad=false 从未播放
2026-10-05T17:18Z | 浏览器验证 #4 | 诊断 — A 关 receiveShadow 仍黑、B 换地面 standard 材质仍黑(共享实例 define 冲突),排除阴影/材质内容因素 → 锁定蒙皮渲染路径材质与双 Animation 两处问题
2026-10-05T17:25Z | build #3 | 成功 — 改用加载器自带 Animation + 下一帧显式 play;蒙皮渲染器逐个换 builtin-standard 克隆材质
2026-10-05T17:27Z | 浏览器验证 #5 | 大部分成功 — 狐狸正确受光呈棕色、双实例姿态各异(动画独立);但地面/展台被刷成狐狸色:Material.clone 不存在 → 共享 builtin 材质被改色(串扰);fps 窗口 4.1(启动期长帧污染)
2026-10-05T17:32Z | build #4 | 成功 — 材质工厂 new Material()+initialize({effectName:'builtin-standard'})(地面/展台/狐狸各自独立);fps 预热 2s 排除启动长帧
2026-10-05T17:40Z | 浏览器验证 #6(终检,系统 Chrome) | 大部分成功 — 单会话全链 P1→P7:P1/P2/P3/P4/P6/P7 状态断言全过,fps=60,0 console error/0 uncaught;唯 B 在 Survey 播完 3.4167s 后 time 冻结(P5 bTimeDelta=0)→ 根因:glTF 剪辑默认 wrapMode=Normal 单次播完即停(3.418≈Survey 时长,与 destroy 无关)
2026-10-05T17:50Z | build #5 | 成功 — 加载后、首次 instantiate 前对全部 asset.animations 设 wrapMode=Loop(运行时源码确认 AnimationClip.WrapMode.Loop=2,sceneClips 拷贝继承);bundle 校验含修复
2026-10-05T17:52Z | 佐证(服务端日志) | 成功 — 6 个浏览器会话对 /assets/character.glb 恰 6 次 200(每会话 1 次;含 reset 的终检会话亦 1 次 → reset 零新请求);日志 0 条 4xx/5xx
```

预算:build 5/8 · browser 6/6(达上限,未超)· toolCall 约 50/120。
