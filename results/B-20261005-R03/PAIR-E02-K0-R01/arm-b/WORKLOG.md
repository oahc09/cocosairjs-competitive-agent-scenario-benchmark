# WORKLOG — PAIR-E02-K0-R01 / arm-b

```text
2026-10-05T16:40:00+08:00 | 读 RUN-CONTRACT/brief/spec + workspace 模板 + knowledge(K0 README/manifest) | 成功
2026-10-05T16:44:00+08:00 | 引擎 d.ts(共享 node_modules/cocosair.js/build/cocosair.module.d.ts,K0 包内,knowledge/manifest.json 指明路径)API 研读:GLTFLoader/GLTFAsset.instantiate/dispose、MeshUtils.createDynamicMesh/updateSubMesh、Material.initialize、scene.globals.fog、builtin 材质名 | 成功
2026-10-05T16:46:00+08:00 | 拷贝 ../assets/boat.glb → workspace/assets/boat.glb(只读复制,sha256=ed22ff2f…9397 与 spec 一致) | 成功
2026-10-05T16:52:00+08:00 | 编写 src/main.js(E02 全量实现:动态波海面/穹顶/日盘/GLB 孤舟/色调系统/环绕相机/reset 释放重建) | 成功
2026-10-05T16:55:00+08:00 | 自查修复:tone/reset 点击处理器、fillDomeColors 作用域、appendChild→addChild、frameTs 截断、loadBoat 竞态守卫、材质工厂 effectAsset 校验 | 成功
2026-10-05T16:57:30+08:00 | build #1 | 成功(退出码 0,dist/app.js 22.4kb)
2026-10-05T16:58:00+08:00 | serve(PORT=7117) | 成功(index 200,assets/boat.glb 200/29132B)
2026-10-05T17:00:00+08:00 | 浏览器验证 #1(加载+P1-P3 采样) | 失败:未捕获 "Invalid typed array length: 63948" — createDynamicMesh 默认容量 1024 顶点 < 海面 5329
2026-10-05T17:03:00+08:00 | 修复:createDynamicMesh 显式传 {maxSubMeshVertices, maxSubMeshIndices}(dynOpts) | 成功
2026-10-05T17:04:00+08:00 | build #2 | 成功
2026-10-05T17:05:00+08:00 | 浏览器验证 #2 | 失败:未捕获 "Assertion failed: Too many vertices." — IDynamicGeometry 索引字段应为 indices16(Uint16Array),且 disc 用了普通数组(无 byteLength)
2026-10-05T17:10:00+08:00 | 修复:三处几何改 indices16/Float32Array + minPos/maxPos | 成功
2026-10-05T17:11:00+08:00 | build #3 | 成功
2026-10-05T17:12:00+08:00 | 浏览器验证 #3(P1-P3 采样+截图) | 部分成功:appReady/资产/波浪相位/船浮沉/fps 48.5 全通过,无异常;但天空锯齿伪影、日盘不可见(自研 Material 渲染异常)
2026-10-05T17:20:00+08:00 | 修复尝试 A:材质改 initialize({effectAsset})(builtin unlit 的 effectAsset) | 成功
2026-10-05T17:21:00+08:00 | build #4 | 成功
2026-10-05T17:22:00+08:00 | 浏览器验证 #4 | 失败(视觉):锯齿与日盘缺失与 #3 逐像素相同 → 伪影非材质参数路径所致
2026-10-05T17:26:00+08:00 | 像素对账(解码 shot5.png):背景=clearColor(255,150,84),锯齿为两个未知色三角带;结合 bundle 取证(registerBuiltinAirAssets 用 effectName 'builtin-unlit') | 成功
2026-10-05T17:30:00+08:00 | 修复尝试 B:材质按引擎原生配方 initialize({effectName:'builtin-unlit',defines}) | 成功
2026-10-05T17:31:00+08:00 | build #5 | 成功
2026-10-05T17:32:00+08:00 | 浏览器验证 #5 | 失败(视觉):伪影依旧 → 结论:本构建下一切 new Material() 实例均不可用,与初始化路径无关
2026-10-05T17:40:00+08:00 | 战略收缩:移除自研 Material/穹顶/顶点色,只用具单例材质(海面=builtin-standard 已证可用;日盘=builtin-unlit 单例;天空=clearColor+线性雾);删除 buildDome/fillDomeColors/makeUnlit* | 成功
2026-10-05T17:52:00+08:00 | build #6 | 成功
2026-10-05T17:53:00+08:00 | 浏览器验证 #6(终检:P1-P7 全探针模拟+截图) | 成功:appReady=true;P1 assetLoaded/requests=1;P2 wavePhase 1.818→3.318;P3 boatY 1.367→1.692;P4 方位角 35→123.4(Δ88.4°);P5 toneMix=1(2.6s 内);P6 epoch=1/toneMix=0/az=35/requests=2;P7 epoch=2/requests=3;fps 49-60;consoleErrors=0;uncaught=[];截图锯齿消失、太阳可见、构图达标
2026-10-05T17:58:00+08:00 | 停止自检 dev server(释放 7117 端口给 harness) | 成功
```

## 预算消耗(系统机器计数口径)

| 项 | 用量 | 上限 |
|---|---|---|
| buildAttempt | 6 | 8 |
| browserAttempt | 6 | 6 |
| toolCall | 由 Runner 侧记录 | 120 |

## 关键实测发现(引擎侧,K0 冷启动下自行踩坑)

1. `utils.MeshUtils.createDynamicMesh` 默认容量仅 1024 顶点/索引,必须显式传
   `{ maxSubMeshes, maxSubMeshVertices, maxSubMeshIndices }`,否则上传时
   "Invalid typed array length"/"Too many vertices" 崩溃。
2. `IDynamicGeometry` 索引字段是 `indices16: Uint16Array` / `indices32: Uint32Array`
   (没有 `indices` 字段);positions/normals/colors 必须是 TypedArray(依赖
   byteLength)。
3. **`new Material()`(+ initialize,无论 effectName/effectAsset 哪种路径)在本构建下
   渲染异常**:同场景 builtin 单例材质正常、自研实例不可见或产生逐帧稳定的伪影。
   全部收缩到 `builtinResMgr.get('builtin-*-material')` 单例后一切正常。
4. 引擎注册的 builtin effect 名是 `builtin-standard` / `builtin-unlit`(不是 'unlit')。
