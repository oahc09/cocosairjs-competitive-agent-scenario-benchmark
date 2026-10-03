# RESULT — PAIR-E10-K0-R01 Arm A (cocosair)

- 产物:`arm-a/workspace/`(src/main.js 实现,index.html 沿用模板契约,dist/ 为构建产物)
- 最终验证:19/19 自检项 PASS(完整探针走查 ×2 确认,含 P1–P7 全部状态断言与视觉断言、网络观测、console 检查)
- 工具调用 / 墙钟 / build / 浏览器验证均在预算内(build 5 次、完整浏览器验证 4 次诊断若干,见 WORKLOG)

## 1. 实现摘要(逐 probe)

- **P1(就绪 + 双实例 Idle + 区域非空 + 单次资产请求)**:启动即以相对路径 `assets/character.glb` 经 `GLTFLoader.loadAsync` 发起唯一一次网络请求(200);`GLTFAsset.instantiate()` 派生 A/B 双实例(同一加载缓存数据,禁止二次加载),映射 Survey→idle、Walk→walk 并立即播放;350ms 后按骨骼关节世界包围盒归一化(身高 1.34、落台、按断言区带 NDC 中心左右分立、B 镜像构图),随后 `assetLoaded=true`,下一渲染帧 `__appReady=true`(实测 ~1s)。两区域 nonBlank 方差 1682/1476(>阈值)。
- **P2(双实例动画播放)**:双实例各自 Animation 组件独立驱动蒙皮(WrapMode.Loop,修复 GLTF 原生 Normal 播一次即冻结的问题);`instances.A/B.time` 取自各自 AnimationState.time,实测 3.0084 且持续推抽;两区域 800ms 像素差 4.56/6.76(运动可观测)。
- **P3(实例隔离)**:`anim-a-walk` 仅调用 A 实例的 `crossFade('Walk', 0.18)`(≤300ms 开始过渡);B 的剪辑与时间不受影响(state: A=walk,B=idle);A 区域 500ms 帧差 6.66(walk 步幅明显大于 idle)。反向按钮 `anim-b-walk` 同理(评分项"双向隔离"亦实现)。
- **P4(销毁 A)**:`destroy-a` → `GLTFInstance.dispose()`(内部 root.destroy():动画停止、节点从场景图移除、资源引用释放)+ 实例组节点(含展台盘)销毁;`instanceCount=1`、`destroyedInstance="A"`、`instances.A=null`;按钮置灰。A 区域回到背景/空台。
- **P5(B 存活续动)**:销毁 A 后 B 的 Animation 组件与蒙皮完全不受影响:time 20.84→21.46 持续推进,B 区域 800ms 像素差 6.95,无未捕获异常。
- **P6(reset 恢复)**:`reset` 由缓存的 GLTFAsset 重建 A/B(应用内重建,不重新请求 GLB — 网络计数保持 1,不刷新页面);`resetCount=1`、双实例回 Idle、`destroyedInstance=null`;`__bench.reset()` 与按钮走同一 `doReset()`。两区域 nonBlank 恢复(方差 1727/1541)。
- **P7(恢复后动画 + 帧率)**:双实例 time>0 且推进,fps(最近 60 帧均值)实测 60(≥30 达标);两区域运动 3.25/5.46;无异常。

附加(scoring.behaviorItems):材质正确(builtin-standard + GLB baseColor 贴图,橙白毛发纹理、无缺省品红/白模/串扰,双实例共享同一贴图与材质对象无串扰);三点布光(主光暖 DirectionalLight + 冷色补光 SpotLight + 逆光 SpotLight + 环境光;引擎仅一盏方向光参与着色,补/逆光用聚光灯实现同等三点格局)+ Planar 平面接触阴影 + 展台圆盘;相机中景平视轻俯,双实例完整入画构图稳定(归一化按视口宽高比计算区带中心)。

### 关键工程决策记录

1. **循环播放**:GLTF 原生剪辑 wrapMode=Normal(播一次冻结);加载后将缓存资产全部剪辑设为 `AnimationClip.WrapMode.Loop`,instantiate 的 sceneClips 缓存因此继承 Loop。
2. **材质接线修正**:该引擎构建的 `air-gltf-standard` 效果在本场景把网格渲染为纯黑(GPU 纹理经 FBO 读回为正常橙色、几何/蒙皮/光照经 builtin-standard 对照实验全部正常,air-gltf 效果的受光+采样路径异常,与 ShadowMap 无关)。修正:`fixupFoxMaterials()` 以 `builtin-standard + USE_DIFFUSEMAP` 承载 GLB 的 baseColor 贴图(roughness 0.58/metallic 0 对应 GLB 因子),并原位替换 `GLTFAsset.meshMaterials` 槽位 → 双实例与 reset 重建自动生效。仍渲染 GLB 网格 + GLB 贴图(非程序化假人、非纯色)。
3. **阴影**:ShadowMap 在该构建下会使材质黑化(实验复现),改用 ShadowType.Planar 平面接触阴影(planeHeight=展台上表面),满足"接触阴影"视觉要求。
4. **UI 控件**:六按钮(anim-a-idle/walk、anim-b-idle/walk、destroy-a、reset)同时携带 `data-bench` 与 `data-ui` 属性(兼容 brief §3.5 与模板探针约定),hover/active 反馈、当前剪辑高亮、destroy 后置灰。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 于 workspace/ 根执行,退出码 0(5 次构建均 0)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 ~0.9–2.9s,含 350ms 归一化等待)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(页面加载即绑定,先于引擎初始化可用)
- [x] 4. 无未捕获异常(全部验证会话 console error 计数 0)
- [x] 5. 探针自检:P1–P7 状态断言 + 视觉断言 19/19 PASS(状态字段随事件即时更新;视觉断言含 nonBlank/motion/regionChange 与网络观测;截图存 workspace/verify-shots/,报告 verify-report.json)

## 3. 合规声明(RUN-CONTRACT §4 逐条)

1. 未访问另一 Arm(arm-b)的任何目录、代码、日志、服务器、profile、截图或结果。
2. 未访问 `bench/reference/`。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm(`PAIR-E10-K0-R01/arm-a/`)之外的任何目录;未读取任何既往 trial 结果。
4. 未访问 `bench/harness/` 源码与合同模板。
5. 未访问引擎源码仓库(`E:\AIProMax\github\cocosair.js`)与 three.js r186 源码树;引擎知识仅来自本 Arm 目录内 vendored 包(node_modules/cocosair.js 的 d.ts 与 bundle)及 knowledge/(K0 README)。
6. 未访问 `bench/docs/`。
7. 未访问 `bench/secret/`。
8. 无任何联网行为:浏览器仅访问本机 dev server(127.0.0.1:7106);未发起文档/搜索/registry 请求;未安装新依赖。
9. 未执行 `npm install`(依赖全部使用模板 vendored)。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件(三者 sha256 未动,本 Run 仅创建/修改 workspace/、WORKLOG.md、RESULT.md 及自建诊断脚本)。
11. 未探测或篡改 harness/validator 行为与期望值;所有验证为本方自写探针(playwright-core + 本地 chromium)对照 spec.json 冻结断言执行。

补充声明:共享资产 `assets/character.glb` 只读使用(复制到 workspace/assets/ 供 dev server 以页面相对路径提供,sha256 与冻结值一致);dev server 端口按合同括号指令使用 `PORT=7106`。
