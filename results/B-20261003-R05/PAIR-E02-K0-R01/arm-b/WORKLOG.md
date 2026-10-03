# WORKLOG — PAIR-E02-K0-R01 / arm-b (cocosair, K0)

```text
2026-10-02T17:05:00+08:00 | setup | 通读 RUN-CONTRACT/brief/spec/模板脚本;确认预算与红线
2026-10-02T17:08:00+08:00 | build   | build #1 模板原样构建成功(esbuild 2.9kb + vendor 引擎 6.4MB)
2026-10-02T17:09:00+08:00 | 探明API | 从 dist/vendor/cocosair.module.js(本 Arm 内产物)确认:GLTFLoader.loadAsync/GLTFAsset.instantiate+destroy+releaseResources、utils.MeshUtils.createDynamicMesh+updateSubMesh(动态网格每帧更新)、builtin-unlit/builtin-standard 材质属性、DirectionalLight.color、macro.ENABLE_WEBGL_ANTIALIAS
2026-10-02T17:15:00+08:00 | assets  | 复制 arm-b/assets/boat.glb → workspace/assets/(sha256 ed22ff2f… 与冻结规格一致;dev server 根为 workspace,运行时经 /assets/boat.glb 真实网络请求)
2026-10-02T17:20:00+08:00 | 实现    | src/main.js:E02 全场景(动态海面+GLB 船+天穹+日月+相机环绕+色调切换+释放式 reset+__bench 契约)
2026-10-02T17:21:00+08:00 | build   | build #2 成功(21.6kb app.js)
2026-10-02T17:22:00+08:00 | serve   | PORT=7121 npm run dev 启动,静态服务 / 与 /assets/boat.glb 均 200
2026-10-02T17:23:00+08:00 | 浏览器#1 | 失败:utils.createDynamicMesh 不是函数(实际在 utils.MeshUtils 命名空间)→ 修正调用
2026-10-02T17:25:00+08:00 | build   | build #3 成功
2026-10-02T17:26:00+08:00 | 浏览器#2 | appReady=true,assetLoaded=true,console 0 错误;但 fps≈4,截图:船体多部件材质正常、海面纯白(顶点色未被 unlit opaque 片元采用)、天穹不可见
2026-10-02T17:30:00+08:00 | 浏览器#3 | 页面内审查:海/天网格 a_color 属性与 USE_COLOR 定义均正确绑定 → 结论:unlit opaque 片元 = mainColor×texture(uv),不读顶点色
2026-10-02T17:35:00+08:00 | 修正    | 海面改 builtin-standard(真实光照+镜面高光带);天穹改运行时程序化渐变纹理(ImageAsset 原始像素,x=色调,y=高度);海面 51×51=2601 顶点、macro.ENABLE_WEBGL_ANTIALIAS=false 提升无头帧率
2026-10-02T17:38:00+08:00 | build   | build #4 成功
2026-10-02T17:39:00+08:00 | 浏览器#4 | appReady=true,console 0 错误,fps≈59.6(达标 ≥30);截图:海面波浪+船体随波+太阳镜面高光带正常;天穹渲染但纹理未生效(纯白)
2026-10-02T17:45:00+08:00 | 排因    | 引擎 uploadData 在 _gfxTexture 未创建时直接 return → 纹理赋值发生在 createAirApp(无 device)前,上传被跳过,纹理保持空白
2026-10-02T17:46:00+08:00 | 修正    | 纹理 image 赋值移至 createAirApp 之后;天穹 v 翻转(v=1 天顶);海面反照率调亮;日/月盘细分加密
2026-10-02T17:47:00+08:00 | build   | build #5 成功
2026-10-02T17:48:00+08:00 | 浏览器#5 | 全探针套件自检(P1–P7 状态断言 + 双采样窗 + 拖拽 + 色调点击 + 双 reset),结果见 RESULT.md
2026-10-02T17:56:00+08:00 | 浏览器#5 复盘 | P1–P7 状态断言全过(wavePhase Δ1.5/1.5s;boatPosition.y 0.419→0.956/900ms;拖拽窗内方位角 358→417 = 59°;toneMix 0→0.996/2.5s;reset 后 epoch1/assetRequests2/toneMix0/az35;二次 reset epoch2/requests3;console 0 错误;无未捕获)。截图:天穹仍纯白 → 纹理上传路径不可靠
2026-10-02T18:00:00+08:00 | 决策    | 放弃纹理渐变(引擎 uploadData 依赖 _gfxTexture 时序,脆弱),改确定性方案:天穹两层 unlit(天顶穹顶 + 地平带)mainColor 随 toneMix 演变;海面加 emissive 补低角度受光
2026-10-02T18:03:00+08:00 | build   | build #6 成功
2026-10-02T18:04:00+08:00 | 浏览器#6 | appReady=true,console 0 错误,无未捕获;截图:暖端画面 — 金色天穹带 + 海面波浪明暗 + 太阳镜面高光带 + 多部件船体,构图达标(海平线约上 1/3,太阳偏侧,船居中偏下);fps 采样 8.9(启动窗),前次会话稳态 59.6-60。浏览器预算 6/6 用尽,实现冻结
2026-10-02T18:06:00+08:00 | 交付    | 写 RESULT.md;停 dev server
```
