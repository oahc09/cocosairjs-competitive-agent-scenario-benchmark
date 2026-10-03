# CocosAirJS Gap Map — M11 差距归因(实验证据 → 路线图输入)

> 生成:2026-10-02(M11)。证据窗口:静态审计基线 2026-09-26 + Reference/Reference-Verdict 20 份 + Pilot 4 pairs/8 arms + gates/G5。
> 红线遵守:每条差距均关联实际证据文件;引擎上限差距与 Agent 发挥差距以 attainment 数据分离;未在证据中出现的缺陷不收录。

---

## 1. 执行摘要(实验后 AIR 的真实地位 vs 静态审计认知)

1. **引擎上限被实验证实为"10/10 可达"**:10 个冻结场景 AIR Reference 全部 FEASIBLE(行为合同 79/79 探针全绿、fps 全部 60.x、console 0 错误;`results/reference-ceiling.json`),静态审计"基础能力对等"的判断成立,且**比审计更乐观**——大规模程序化/点云/动态网格的规模上限远超场景需求(E07:1,536 楼/84k 窗/70k 雨仍 54.7fps)。
2. **真正的引擎上限只有两条硬线**:管线级后处理(E05 三闸门实证不可达)与 transmission 内置路径死代码(E09);其余全是"可达但工程路径重"。
3. **差距重心从"能力缺口"移到"行为契约缺口"**:实验新实测 13+ 个引擎缺陷/暗坑,多为静默错误(POINT_LIST 被替换、setProperty 数组→NaN 黑屏、getLocation 毒化输入、camera.visibility 黑屏、EffectAsset 早注册静默无效),它们才是 K0 Agent 成本翻倍的直接原因。
4. **K0 Agent 发挥差距真实存在但不大**:Pilot 4 对中 AIR 2 PASS/2 FAIL vs three 3 PASS/1 FAIL;attainment AIR 1.04/0.80/0.61/1.00 vs three 0.96/1.05/0.63/0.99——除 E02(-0.25)外均 TIE 或 AIR 胜。
5. **成本差是系统性信号**:工具调用 AIR≈three 的 2.4×(自报原始值:E01 70 vs 45、E02 74 vs 25、E05 60 vs 25)、token 3.7×、墙钟 1.6×(任务简报 Pilot 成本汇总口径;token 为自报 best-effort,`pilot-aggregate.json costMetricsNote`)。
6. **`.d.ts` 优势没有兑换成低成本**:K0 下 three 无 .d.ts、AIR tarball 有(gates/G5 knownLimitations),AIR 仍更贵——类型声明无法编码行为契约(事件被吞、NaN 强转、反射式 effect JSON、时序约束)。
7. **E05 双臂共同失败揭示"视觉密度自检口径"缺口**:冻结阈值是每角 litRatio≥3%,两臂自检用"四角非黑"口径均自评通过,harness 独立像素复核判 FAIL(G5)——Engine/Agent 之外出现第三类差距:harness 判定语义的知识回灌。
8. **静态审计低估了 AIR 的两个"实测反超点"**:动态点光照明链路 FULL(E06,含逐帧 UBO 动画)与 GLB 资产生命周期(E10 单请求双实例/引用计数/reset 全链)。
9. **静态审计高估了两个面**:①"官方支持 transmission"(实为死代码);②示例/docs 能防 K0 踩坑(实测 8/8 臂全部踩中引擎暗坑,首轮 build+validate 通过仅 6/8)。
10. 净结论:**AIR 不缺"能做什么",缺"把能做什么变成 Agent 可预期"**——错误诊断、Pattern/Recipe 与事件/输入契约是最高杠杆的回灌面。

---

## 2. 九域差距表(计划书 §27)

> 口径:AIR 引擎上限差距 = AIR Reference(可信实现者)实测;Agent K0 达成差距 = Pilot attainment(arm/ceiling);根因归类按 §26.9(补 Engine/Docs/Pattern/Recipe/Example/Skill/Error Diagnostics)。Pilot 仅覆盖 E01/E02/E05/E10,其余域的 Agent 列标注"未测"。

| Domain | AIR 引擎上限差距(Reference 实测) | Agent K0 达成差距(Pilot) | 根因归类 | 关键证据 |
|---|---|---|---|---|
| **Procedural** | 无硬墙但路径重:无 Points/InstancedMesh 一等公民(E01 G6:74.5k 点需 EffectAsset JSON+三变体 GLSL+customAttributes+POINT_LIST 双补丁,vs `THREE.Points` 两步);无 3D 粒子系统(E04 §2.1:CPU 全量积分+池管理 ~120 行基础设施为唯一路径)。替代路径全部实证:合并静态网格恒 1 draw call(E07:240 楼+13.6k 窗)、动态网格单 draw call(E07:100k quad/帧为 60fps 预算锚点;S7 组合 6.4× 楼+45× 雨=54.7fps;E04 2600 粒;E08 110 鱼+340 颗粒) | E01 AIR attainment 1.04 **胜** three 0.96(rawDelta +5,AIR_WIN);首臂即踩 NaN 家族+wheel 吞事件,8/8 build 预算耗尽后以 dist 热补丁收尾 | 补 Pattern(动态网格/合并网格批处理 Recipe)、补 Example、补 Engine(InstancedMesh/Points, P2)、补 Error Diagnostics(POINT_LIST 静默替换) | E01 ceiling-notes G1/G2/G6;E03 §2.6(600 节点 60fps);E04 §2.1;E07 ceiling-notes §1–§3;PAIR-E01 pair.json/WORKLOG |
| **Asset** | GLB 运行时链路一等公民:loadAsync/parseAsync、单请求多实例、引用计数、缓存去重全可用(E10 §2.1 FEASIBLE;E02 GLB 直载零配置)。缺口:**K0 tarball 上 air-gltf-standard 把 Fox 渲染为纯黑**(Reference 工作区同资产正常→疑似 tarball/构建路径缺陷); Draco wasm 本环境不可用(E10 §2.1);通用格式(OBJ/FBX)维持静态审计缺口(本实验未测) | E10 AIR 1.00 PASS(raw 77 vs 76,TIE);代价:5 build + 6 轮诊断定位黑材质,fixup 替换为 builtin-standard+diffuseMap;E02 资产面无失分(P1/P6/P7 探针含真实网络/双 reset) | 补 Engine(黑渲染根因+回归测试, P0)、补 Docs(refcount/addRef 钉住语义、Draco 边界) | E10 ceiling-notes §2.1/§2.4;PAIR-E10-K0-R01/arm-a WORKLOG(22:15–22:52)与 RESULT 决策#2;E02 REFERENCE-VERDICT §2 |
| **Animation** | 骨骼/clip 全链可用:SkinnedMeshRenderer 自动装配、play/crossFade/pause/逐实例独立时钟、双实例 60fps(E10 §2.2 FEASIBLE)。坑:①`AnimationClip.wrapMode` 默认非 Loop→播完冻结末帧且 motion 断言静默失败;②clip 级属性(wrapMode/duration)跨实例共享(sceneClips 缓存),逐实例变体须手工拷贝;③`play()` 在组件激活前调用会被激活流程重置 | E10 AIR 1.00 PASS;首轮 15/19 即因 wrapMode 冻结(1 轮修复,WORKLOG 22:07–22:10);静态审计"动画对等"获实验支持 | 补 Docs、补 Error Diagnostics(wrapMode 冻结应可诊断)、补 Recipe(GLB→Loop 化标准姿势) | E10 ceiling-notes §2.2/§3.5;PAIR-E10 arm-a WORKLOG #1;PAIR-E10 arm-b(对照无此坑) |
| **Material** | PBR/程序纹理/顶点色/blend/priority/IBL(LDR)可用(E08/E09)。**实测缺陷群**:①KHR transmission 内置路径死代码(§3 引擎清单#2);②`Material.setProperty` 对 FLOAT4 传普通数组→静默 NaN 黑屏(E02-a 根因#1、E01-b u_spin NaN 同族);③运行期 `setProperty(Vec4)` 丢 `.w`(初始正常,更新后 shader 读 0);④`Light.color` 传 Vec3→NaN 白屏扩散;⑤无 sRGB 纹理格式(程序化纹理线性变暗,需手工提亮);⑥亮度口径分裂(LDR 8–14 vs HDR 50,000 lux;SpotLight ×10000 换算);⑦双面材质需 USE_TWOSIDE+cullMode 双开关 | E02 AIR 0.80 FAIL(-0.25,唯一 THREE_WIN):7 build 中 4 次耗于 NaN 黑屏根因(数组 setProperty、linear:true 扭曲方向向量);E10-a 3 轮耗于黑材质;E05 AIR 0.61 与 three 0.63 TIE(失败在密度非材质) | 补 Engine(类型校验+错误码, P0)、补 Docs(setProperty 类型契约/亮度换算表)、补 Error Diagnostics(NaN 溯源) | E09 ceiling-notes §3.1;E02-a WORKLOG 根因#1/#2;E01-b WORKLOG 22:08;E10 ceiling-notes §3.1;PAIR-E02/E10 pair.json |
| **Shader** | **通道 FULL,超过静态审计预期**(E05 §7 结论):自定义 GLSL 三变体+编译期同构 JSON 注册,与内建同权限;blend/队列/priority 全可控。代价高:须手写"编译产物 JSON"(UBO statistics/builtins/attributes format 码表/hash 全手填),无 EffectCompiler/DSL、无 chunk include、defines 初始化定死、mediump fp16 相位冻结;E01 G3 顶点阶段 UBO 读取漂移(根因未定位) | E05 AIR 0.61 vs three 0.63 TIE(shader 非败因);E02-a effect 一次编译通过但 2 轮 uniform 修复;E01-b 6 轮定位 NaN(E04 §2.3 预判"K0 在此 API_HALLUCINATION 概率高"成立) | 补 Pattern(effect JSON 模板/生成器 Recipe)、补 Example(E01–E09 各 Reference 即活例)、补 Engine(G3 调查, P1) | E05 ceiling-notes §1;E04 §2.3;E01 G3;PAIR-E01 arm-b WORKLOG;PAIR-E02 arm-a WORKLOG |
| **Postprocess** | **确认零可用**(E05 §3 三闸门:聚合出口不 import、`cclegacy.rendering` 被清、CUSTOM_PIPELINE_NAME 不设;引擎 bundle 内后处理代码"可往返、不生效")。对照:three E05 Reference 以 EffectComposer+UnrealBloom+OutputPass+FXAA 5 标准件零补丁 60fps("决定性优势",three/E05 ceiling-notes §1)。视觉上限实测:替代手段(bloom impostor)= bloom 方案 80–85%(特写构图),密集区过曝平白、无全屏渗出 | Pilot 无直接 attainment 差(E05 双臂败于密度);视觉六维被压顶:E05 特效质感 2/3、E10 1.5/3、E04 材质/特效各扣 0.5——静态审计 P0 判断被实验完全证实 | **补 Engine(P0,对应 roadmap AIR-004)**;补 Recipe(bloom impostor 应急 Pattern) | E05 ceiling-notes §3/§4;E01 G4;E04 §2.2;E10 §3.2;three/E05 ceiling-notes §1;reference-ceiling.json(三 FEASIBLE_LIMITED 同因) |
| **Interaction** | 输入链路可用但契约暗:①canvas/pal 层吞 wheel(stopPropagation)与 DOM 鼠标事件(E01 G5;E02 notes §2);②`getLocation(out)` 传普通对象→异常**毒化事件分发器,整页输入永久失灵**(E08 坑位3);③`getScrollY()=-DOM deltaY×5` 语义反转×5(E05);④鼠标事件双发 TOUCH 需去重(E03/E08);⑤无 OrbitControls(各 Reference 手写 30–40 行球坐标);⑥`screenPointToRay` 组件/渲染相机参数序不同、`getComponent('MeshRenderer')` 字符串查不到(E08) | **E02 AIR 0.80 是 Pilot 唯一显著 attainment 落差**,根因=harness 状态断言在动作后 200ms 窗采样(`probe-executor.mjs` L1100–1107),Agent 的 k=10/s 指数平滑在 409ms 拖拽内已收敛→窗内 Δaz≈0 判 FAIL(实环绕 89.5°,探针原始数据 stateBefore 35→stateAfter 124.488);G5 归因 agent 侧"环绕幅度不足";自检 24/24 与 harness 3/7 分歧 | 补 Docs(事件层契约+捕获阶段绕行)、补 Pattern(OrbitControls 等价 Recipe)、补 Engine( getLocation 防御, P0)、补 Skill(探针断言语义:动作后需保留残差运动) | E01 G5;E02 ceiling-notes §2;E08 坑位3/6;PAIR-E02 arm-a validation/probe-results.json P4;harness/runner/probe-executor.mjs;gates/G5 |
| **Lifecycle** | 全链可用且实测硬:E02 连续 20 次 reset post-GC 堆平台无泄漏;E10 dispose 真销毁、销毁不影响兄弟、reset 零网络重建;E04 reset 真重生成。坑:①跨 reset 复用 asset 须显式 addRef 钉住(refcount 瞬时归零自动释放窗口,E10 §2.1);②`utils.createDynamicMesh` 仓库/tarball 挂载位置不同(E05);③无通用节点克隆(SkeletonUtils.clone 等价物未见,E10 §2.3) | E02-a 资产生命周期自检全过(harness P6/P7 因 P4 级联 SKIPPED);E10 AIR 1.00 PASS(网络计数 1、reset 复用缓存)——静态审计"资源生命周期是 AIR 强项"获实验支持 | 补 Docs(refcount/addRef 语义)、补 Example;引擎无大缺口 | E02 REFERENCE-VERDICT(20 次 reset);E10 ceiling-notes §2.4;E04 §1.2;PAIR-E10 arm-a RESULT P4–P6 |
| **Simulation** | 10 场景内 CPU 模拟无障碍:E08 O(n²) boids 110 鱼单帧 JS<2ms + 全群网格重写 60fps;E03 开普勒分层、E06 多频闪烁、E05 解析星流均 60fps。**真物理(刚体/碰撞)不在本实验覆盖**——静态审计结论(2D Box2D+3D builtin/Cannon,后端待强)维持,待 M7 | 未测(E08 未进 Pilot) | 无新证据不归类;维持静态审计 P1 | E08 ceiling-notes §8(单帧<2ms);E03/E06 REFERENCE-VERDICT;COCOSAIRJS_VS_THREEJS_R186 §3(物理行) |

**Pilot 侧指标补充(§27 下表已得列)**:Final Success AIR 2/4 vs three 3/4;First Compile(build+首轮验证一次通过)6/8,失败 2 例均为 AIR 臂(E02-a NaN 黑屏、E10-a wrapMode 冻结);Visual Preference:G7 BLOCKED(双 Judge 4/4 不一致,六维取两 Judge 均值;round1 因视觉后端幻觉作废)——`pilot-aggregate.json` blindNotes。

---

## 3. 引擎 bug/缺陷清单(实验新实测;现象/复现/影响/建议/出处)

> 编号 EB-01…EB-19。severity:P0=正确性静默错误或能力声明失真;P1=显著工程税/可诊断性缺失;P2=API 一致性。

| # | 现象 | 复现位置 | 影响 | 建议处理 | 出处 |
|---|---|---|---|---|---|
| EB-01 | **air-gltf-standard 纯黑渲染(K0 tarball)**:Khronos Fox GLB 经 glTF 材质路径渲染为黑色剪影;GPU 纹理 FBO 读回正常橙色、几何/蒙皮/光照经 builtin-standard 对照正常、与 ShadowMap 无关 | `vendor/cocosair.js-1.0.0-k0.tgz` + `assets/character.glb`(PAIR-E10 arm-a WORKLOG 22:15–22:45 诊断序列 diag3–diag8);Reference 工作区同资产正常(E10 ceiling-notes §2.5)→ 疑 tarball 构建/路径差异 | K0 Agent 3 轮诊断 + 材质整体替换(builtin-standard+USE_DIFFUSEMAP)绕行;若普遍则所有带贴图 GLB 场景在 K0 交付物上不可信 | P0:定位 tarball 与 Reference 工作区产物差异;air-gltf-standard×带贴图 GLB 进回归集;修复前在 K0 知识包标注 | PAIR-E10-K0-R01/arm-a WORKLOG、RESULT 决策#2 |
| EB-02 | **KHR transmission 内置路径死代码**:`airTrFactorTex/airThickTex` 声明后无 uniform→局部变量赋值(modulate 注入块缺 transmission 两条),`trF=clamp(airTrFactorTex,0,1)` 恒 0,`if(trF>0)` 恒假;Beer-Lambert 与色散同为死代码;git 历史核实自 T6 首次提交即缺失,非回归 | `src/air/assets/gltf/material/physical-effect.ts` L170(声明)/L348(消费);repo 与 vendored tarball 逐字一致(E09 ceiling-notes §1.1) | 含 KHR_materials_transmission/volume/dispersion 的 GLB 渲染为普通不透明 PBR;**"官方支持 transmission"的能力声明与实渲染不符**;两相机 scene-color 捕获管线(AirTransmissionCapture)本身正常,断裂只在 shader 注入层 | P0:一行级修复(补 `airTrFactorTex=TRANSMISSION_CONSTANT.x;` 与 thickness 赋值)复活 KHR 路径;修复前能力目录标注 BLOCKED | E09 ceiling-notes §1.1/§3.1-1、REFERENCE-VERDICT §3-1 |
| EB-03 | **`Material.setProperty` FLOAT4 类型不校验 → 静默 NaN**:传普通数组走 `setUniformArray` 逐元素写,FLOAT4 writer 读 `.x` 得 undefined→NaN,毒化 uniform(E02-a 全屏黑;E01-b u_spin NaN 全点不可见) | `Material._uploadProperty`(E02-a WORKLOG 22:22 引擎源码核对);E01-b WORKLOG 22:08 pass._rootBlock 读出 NaN | K0 最高频黑屏根因(两个独立臂、两个场景复现);完全静默(着色器编译通过、0 console 错误) | P0:入参类型断言+结构化错误码(NaN 溯源到属性名);d.ts 标注 Vec4/Color 联合类型 | PAIR-E02 arm-a WORKLOG 根因#1;PAIR-E01 arm-b WORKLOG 22:08;E09 §3.1-3 同族 |
| EB-04 | **`Light.color` 传 Vec3 → NaN 全白**:setter 读 `.r/.g/.b` 不校验类型,NaN 静默扩散到整屏受光像素 | E09 WORKLOG §2 最小复现(E09 REFERENCE-VERDICT §4 附带记录) | 灯光颜色一次误用即整屏废;与 EB-03 同为"NaN 家族" | P0:类型断言或 d.ts 强标注 `Color`;并入 NaN 诊断族 | E09 ceiling-notes §3.1-2 |
| EB-05 | **运行期 `setProperty(name, Vec4)` 丢第 4 分量**:初始上传正常,更新后 shader 读到 0;staged `pass.getUniform` 读回正常→疑 staged→GPU 上传路径缺陷,未深挖 | E09 ceiling-notes §3.1-3(实测:初始 OK,更新后 `.w`=0) | 一切依赖 `.w` 的运行期材质动画断裂;E09 以 JS 预混合规避 | P0/P1:上传路径单测(Vec4 xyzw 全分量往返);修复前 docs 明示"只用 xyz" | E09 ceiling-notes §3.1-3、§4-2 |
| EB-06 | **`getLocation(out)` 普通对象毒化事件分发器**:out 非真 Vec2 实例→`out.set is not a function`,`input._emitEvent` catch→`_clearEvents`+`onThrowException`+rethrow,**此后整页输入永久失灵** | E08 ceiling-notes 坑位3(源码路径 `input._emitEvent`) | 一次回调抛错=输入系统全灭,且 Agent 难以归因(现象是"后来所有交互都不响应") | P0:分发器隔离(单回调异常不清空队列)+ 类型防御;文档明示输入回调须 try/catch | E08 ceiling-notes 坑位3 |
| EB-07 | **POINT_LIST 双补丁**:①`createMesh` 对 `IGeometry.primitiveMode` 用 `||` 判空,POINT_LIST(=0)被静默替换为 TRIANGLE_LIST(返回 7);②实际 draw 图元取自 Pass._primitive(effect JSON pass `primitive` 字段,默认 TRIANGLE_LIST)而非 mesh——两条路径割裂且均无文档 | `src/cocos/3d/misc/create-mesh.ts`(IGeometry 分支);`src/cocos/render-scene/core/pass.ts` `_primitive`;`src/cocos/rendering/pipeline-state-manager.ts:55(E01 G1/G2) | 点云意图被静默画成垃圾三角形(additive 下全屏过曝);E01 Reference 首轮 P2 即此症状;Agent 症状与根因距离极远 | P0:`primitiveMode ?? TRIANGLE_LIST` 修复 falsy-zero;pass/mesh 图元来源统一或文档化;补 POINT/LINE 正典示例 | E01 ceiling-notes G1/G2、REFERENCE-VERDICT engineLimitations;E03 §3-2 |
| EB-08 | **canvas/pal 层吞事件**:wheel 在 canvas 目标阶段 preventDefault+stopPropagation,window 冒泡监听收不到;pal 层对 DOM 鼠标事件 stopPropagation | E01 G5(window wheel 不触发;capture:true 触发);E02 ceiling-notes §2(canvas mousemove) | 交互类场景滚轮/拖拽全灭,易被误判为"事件词表不符";E01-b 耗 3 轮定位 | P1:文档化事件层契约+官方 Recipe(捕获阶段/引擎 input 双通道);长期评估不再 stopPropagation | E01 ceiling-notes G5;E02 ceiling-notes §2;PAIR-E01 arm-b WORKLOG 22:14–22:16 |
| EB-09 | **顶点阶段 UBO 读取漂移**:自定义 Constants 块与 CCGlobal 在顶点着色器读到随顶点变化的"uniform"值;CCCamera/CCLocal 正常;根因未定位 | E01 G3:顶点着色器 `v_dbg=vec2(pxScale/1000, cc_screenSize.y/1000)` 成像,不同星点呈 27~232 离散值簇(恒定 uniform 应全场一致) | 顶点阶段 uniform 不可靠,逼迫架构改形(构建期烘焙/重建 mesh);Agent 增加试错轮次但不封顶 | P1:引擎侧定位(WebGL2/ANGLE uniform 路径);文档标注"顶点阶段自定义 UBO 现状" | E01 ceiling-notes G3、REFERENCE-VERDICT VERTEX_STAGE_UBO_READ_DRIFT |
| EB-10 | **无后处理(Code First)**:三闸门(聚合出口不 import、cclegacy.rendering 被清、CUSTOM_PIPELINE_NAME 不设)⇒ 无 Bloom/Tonemap/FXAA;bundle 内后处理代码"可往返、不生效" | docs/notes/post-process-notes.md 三闸门(E05 §3 采信并交叉核对源码);E01/E04/E05/E06/E07/E09/E10 全部以此为受限面 | 特效质感维度全场景压顶(E05 fx 2/3、E10 1.5/3、E04 双维各扣 0.5);替代手段≈bloom 的 80–85%(特写构图),大场景/强曝光对比差距拉大 | P0(=roadmap AIR-004/W1.5):默认管线挂载点+tonemap→AA→bloom 首批 pass;同时把"bloom impostor"Recipe 收进 K2 | E05 ceiling-notes §3;reference-ceiling.json note;three/E05 ceiling-notes §1 对照 |
| EB-11 | **点光阴影不支持**:`point-light.ts` 类注释明示 "It doesn't support shadow generation currently." | `src/cocos/render-scene/scene/point-light.ts`(E06 §2 引) | 动态点光场景(篝火/火把)无投影层次,只能 blob shadow/焦土盘近似;方向光 ShadowMap 有路径但质量待考且 E10 pilot 实测"会使材质黑化"再被绕行 | P1:支持矩阵文档化(灯型×阴影×后端);点光阴影排期或明确 NOT-PLANNED;能力目录登记 | E06 ceiling-notes §2;PAIR-E10 arm-a WORKLOG(ShadowMap 黑化实验) |
| EB-12 | **fog 开关=全材质变体重编译**:管线宏级开关,运行时切换触发 ~100ms 单帧颠簸;builtin-unlit 下雾为逐顶点因子(超大三角形插值误差) | E07 ceiling-notes §4-3(app.run 前配置规避;运行时切换接受颠簸) | "开关即时生效"类交互合同要么颠簸要么提前配置;大三角形 unlit 雾有插值瑕疵 | P1:uniform 级雾参数开关;unlit 逐像素雾变体 | E07 ceiling-notes §4-3/§6-4;REFERENCE-VERDICT §5 |
| EB-13 | **`camera.visibility` 默认 undefined → 静默黑屏**:必须显式赋值否则不渲染 | E04 §2.4;E03 §4(RUNTIME 坑位) | "画面全黑但零错误"的最短路径;Agent 高频翻车点 | P1:默认值修复(合理默认=全部可见)或启动期 warn | E04 ceiling-notes §2.4、REFERENCE-VERDICT §6-1;E03 ceiling-notes §4 |
| EB-14 | **EffectAsset 注册时机约束无报错**:必须在 `createAirApp()` 后 `onLoaded()` 注册,早注册=静默无效 | E04 §2.3(GAP-B1);E05 §1(同约束) | 自定义 shader 不生效且无任何错误输出,排障成本高 | P1:早注册抛结构化错误;docs 前置时序图 | E04 ceiling-notes §2.3;E05 ceiling-notes §1 |
| EB-15 | **无 sRGB 纹理格式**:程序化画布纹理线性域显著变暗;非 POT 仅 CLAMP_TO_EDGE;不翻转 y | E10 §2.5/§3.1(地面基色画到 ~#98 才得中灰观感) | Agent "调不出参考观感"的隐性根因;quad uv v=1 在画面上方(图像末行=视觉顶部)叠加认知税 | P1:sRGB 纹理格式支持;docs 程序化纹理亮度补偿 Recipe | E10 ceiling-notes §2.5/§3.1;E08 坑位4 |
| EB-16 | **`AnimationClip.wrapMode` 默认非 Loop**:播完冻结末帧(不崩溃);clip 级属性跨实例共享,逐实例变体须手工拷贝 | E10 §2.2;PAIR-E10 arm-a WORKLOG 22:07(首轮 15/19) | motion 断言静默失败;需要变体时的隔离语义边界不清 | P1:GLB 导入默认 Loop(或可配置);docs 写明共享层边界 | E10 ceiling-notes §2.2/§3-5;PAIR-E10 arm-a WORKLOG |
| EB-17 | **无就地顶点缓冲改写 API**:docs/manual/custom-buffergeometry.md §2 明示;CPU 顶点动画只能整 mesh 重建(每帧不可行)→必须 shader 位移或动态网格 | E02 ceiling-notes §2(与 `BufferAttribute.needsUpdate` 的最大通道差异) | 动态几何工程税:顶点动画全部上移到 shader/动态网格路径 | P1:评估 `updateSubMesh` 之外的就地写 API;Recipe:动态几何三路线决策树(shader 位移/动态网格/重建) | E02 ceiling-notes §2;E04 §1.1;E08 能力1 |
| EB-18 | **无 InstancedMesh/Points/3D 粒子一等公民**:500+ 实例须合并静态网格(静态)或 CPU 动态网格(动态);无 GPU 侧生命周期/发射器语义;无 point-sprite(每粒子 4 顶点 6 索引,带宽 4×) | E01 G6;E03 §3-3;E04 §2.1;E07 §6-1(规模天花板量化) | 规模上限本身不差(E07:≥1,536 楼/70k 雨 vsync 内;E01 74.5k 点 60fps),是易用性/文档缺口;但逐实例动画=CPU 重写顶点,失去 GPU 剔除 | P2:评估 InstancedBuffer/Points 暴露;近期先官方封装 DynamicQuadBatch 组件(E04 §2.1-4 建议) | E01 G6;E03 §3-3;E07 §6-1/§3;E04 §2.1 |
| EB-19 | **API 一致性长尾(实测各 Reference/Run 汇总)**:①`primitives.quad` 忽略 width/height(恒 ±0.5 硬编码),plane/sphere/box 正常(E08 坑1);②`primitives.plane` 生成 XZ 水平面,再 -90° 旋转会背对相机被 cull(E08 坑2);③导出名 `Quat` 无 `Quaternion`,且无实例方法(E06 坑1,初版崩溃 ×2 轮);④`camera.clearColor`/`light.color` 必须赋值不能原地改(E06 坑2);⑤`getScrollY()=-deltaY×5`(E05);⑥`screenPointToRay(x,y,out)` 与渲染相机 `(out,x,y)` 参数序不同;`getComponent('MeshRenderer')` 字符串查不到(E08 坑6);⑦`Node.addChild` 返回 void 不可链式(E05);⑧`fog.enabled` 必须先于 `fog.type`(E08 坑9);⑨自建几何不传 minPos/maxPos→静默剔除(E07 §4-5);⑩`createDynamicMesh` 仓库(`utils`)vs tarball(`utils.MeshUtils`)挂载不同(E05);⑪双面材质需 USE_TWOSIDE+cullMode 双开(E09 §3.1-4);⑫亮度口径分裂:material-table 8–14(LDR)vs examples 50,000 lux(HDR+exposure),SpotLight 再叠 ×10000(E09 §3.1-5) | 各条出处见"出处"列 | 单条皆小,合计构成 K0 的主要试错税(E06 Reference 自身为此 2 轮崩溃;E02-a 太阳方位 2 build) | P2 逐条修;P1 的只有⑫(统一换算表)与⑩(tarball 一致性);全部进 K1/K2 知识包 | E05/E06/E08/E09 ceiling-notes;E07 §4 |

---

## 4. Agent DX 差距(K0 冷启动视角)

### 4.1 双臂成本差(Pilot 4 对,自报口径)

| 维度 | three 臂 | AIR 臂 | 倍率 |
|---|---|---|---|
| 工具调用(自报) | E01 ~45 / E02 ~25 / E05 ~25 / E10 ~30(均值 ≈31) | E01 ~70 / E02 ~74 / E05 ~60 / E10 未精确自报(均值 ≈73–75) | **≈2.4×**(任务简报 Pilot 成本汇总口径;按可复核的 3 对原始值算 2.2–3.0×) |
| token | 未落盘(自报 best-effort,`pilot-aggregate.json costMetricsNote`) | 同左 | **3.7×**(任务简报口径) |
| 墙钟 | 40/25/45/35 min(均值 ≈36) | 55/80/55/96 min(均值 ≈71) | **≈1.6–2.0×**(简报 1.6×;按 WORKLOG 时间戳逐对为 1.4×/3.2×/1.2×/2.7×) |
| build 用量 | 6/1/6/3 | 8(耗尽)/7/4/5 | AIR 首轮即耗满预算 1 例(E01-b 8/8,尾修复靠 dist 热补丁,合规披露) |
| 首轮通过 | 4/4(build 一次通过) | 2/4(E02-a、E10-a 各 1 次失败重试——NaN 黑屏 / wrapMode 冻结) | 合计 build 一次通过 6/8(`pilot-aggregate.json recovery`);另 E01-b 首轮完整验证 11/12(P4 wheel 吞事件,3 轮后修复) |

出处:各臂 WORKLOG/RESULT 预算申报段;`pilot-aggregate.json recovery`。**结论:多出的成本几乎全部花在"引擎行为与常识偏差"的排障上,而非功能实现。**

### 4.2 E02 拖拽环绕失败根因(Pilot 唯一显著 attainment 落差,-0.25)

- 现象:harness 判 P4 FAIL → P5/P6/P7 级联 SKIPPED → S2 13/30,总 65 vs three 84;Agent 自检 24/24 PASS。
- 原始数据(probe-results.json):evidence.stateBefore.cameraAzimuth=35 → stateAfter=124.488(**实际环绕 89.5°,远超 >20° 阈值**),visualAssertion pixelDelta 0.7438 也过,唯 stateAssertion ok=false。
- 根因:harness 的 `$.before/$.after` 在**动作完成后**采样、间隔 `sampleWindowMs=200`(`harness/runner/probe-executor.mjs` L1100–1107);Agent 的 k=10/s 指数平滑在 409ms 拖拽过程中已收敛到目标,采样窗内 Δaz≈0 → 断言假。Reference 以"相机速度受限逐帧追踪"通过同一断言(拖拽后仍在追赶)。G5 归因:agent 侧(P4 相机环绕幅度不足),独立像素复核确认。
- DX 含义:这不是引擎缺陷,而是**"平滑参数 × 断言采样窗"的契约知识缺口**——K1/K2 必须包含"交互动作后 sampleWindow 内保留可观测量(残差运动/迟滞)"的 Pattern;引擎侧对应的 Recipe 是"惯性/阻尼控制器默认值应对断言友好"。

### 4.3 E05 双臂共同失败:视觉密度自检口径 vs 冻结阈值

- 冻结断言:P1 nonBlank 五区域(中心 1/3 + 四角各一),**每区域 litRatio≥0.03**。
- 实测(E05 arm-a probe-results):四角 litRatio 0.0003 / 0.0922 / 0.014 / 0.0496——两角低于 3%;arm-b 同型失败。两臂自检均自评"四角 100%/90.4% 非黑"通过(用了"有无亮点"而非"亮像素占比"口径)。
- G5 归因:agent 侧视觉密度,独立像素复核确认。**两引擎同败 → 与引擎无关,是"视觉密度标定"Pattern 缺口**:K1/K2 需要"像素断言前的密度预算 Recipe(星点数×直径→每角 litRatio 估算)"。

### 4.4 K0 知识不对称(three 无 .d.ts / AIR 有)及其反直觉结果

- gates/G5 knownLimitations:"K0 知识不对称如实记录:three npm 无 .d.ts,AIR tarball 含 .d.ts"。
- 结果:AIR 在类型信息占优的情况下成本仍 2.4×/3.7×——因为 K0 的失败面全部位于 `.d.ts` 无法表达的层:运行期行为(EB-03/05/06)、事件层契约(EB-08)、时序约束(EB-14)、反射式 effect JSON(E04 §2.3)、量纲口径(EB-19⑫)。three 的知识优势来自训练先验(API 已在模型权重内),不来自包内文件。
- 对路线图的含义:**"补 .d.ts"不能收这块差距;要补的是行为契约文档+结构化错误(让错误信息自己解释绕行法)**。

### 4.5 自检与 harness 判定的系统性分歧(Pilot 全量)

| 臂 | 自检 | harness | 分歧点 |
|---|---|---|---|
| E02-AIR | 24/24 PASS | 3/7(FAIL,STATE_MANAGEMENT) | P4 断言采样语义(§4.2);级联 SKIPPED 放大扣分 |
| E05-three | 6/6 全过(E05_ALL_PASS) | 0/6(P1 FAIL 级联) | 每角 litRatio≥3% vs "四角非黑"口径(§4.3) |
| E05-AIR | 6/6 全过(t4 全绿) | 0/6 | 同上 |
| E10 双臂 | 19/19、22/22 | 双 PASS(spec v1.0.1 复验后) | 初版 spec P4 断言语义缺陷(regionChange 测动作后两帧 vs 阈值文本意图),M6 升版修复(G5) |

- 共性:Agent 自检几乎全部"全绿"而 harness 判 FAIL/有限通过——**自检脚本复刻的是 Agent 对断言的理解,不是 harness 的采样语义**。E10 的 spec 缺陷(已修)证明分歧也可能在 harness/spec 侧;错误归因需 G5 式独立复核闭环。
- DX 回灌:①把"探针语义文档"(sampleWindowMs 后置采样、regionChange 需持续运动源、nonBlank 分区密度)纳入 K1/K2;②引擎/模板侧提供 `__bench` 自检辅助(分区 litRatio 读数),让 Agent 自检与 harness 口径对齐。

---

## 5. 知识/文档回灌点(K1/K2 应补什么才能收回差距)

> 按"补什么 → 收回哪块差距"组织;类型按 §26.9。优先级依据:Pilot 成本差与失败面分布。

| 域 | 回灌点(K1=官方文档级,K2=全量知识级) | 类型 | 收回的差距(证据) |
|---|---|---|---|
| 输入/事件 | pal/canvas 层事件吞没契约图(wheel stopPropagation、mousemove);捕获阶段绕行与 `input.on(TOUCH_*)` 双正典;鼠标/TOUCH 双发去重;`getLocation` 需真 Vec2+try/catch 防毒化;`getScrollY=-deltaY×5` | Docs + Pattern + Error Diagnostics | E01-b 3 轮 wheel 排障;E02 Reference 预测的 K0 卡点①;EB-06/08 |
| 材质/setProperty | 类型契约表:FLOAT4 必须 Vec4/Color 实例(数组→NaN);运行期 Vec4 只用 xyz;`mainColor` 需引擎 Color;方向类属性禁 `linear:true`;NaN 症状→根因速查(黑屏/白屏/值漂移) | Docs + Error Diagnostics | E02-a 4 build 黑屏;E01-b 6 轮 NaN;EB-03/04/05 |
| 自定义 Effect | "编译产物 JSON"完整模板(UBO statistics/builtins/attributes format 码表)+ 生成器脚本;glsl4→glsl3 派生规则(glsl1 WebGL2 不消费);注册必须在 createAirApp 后;defines 初始化定死;blendState+priority 绘制次序;pass `primitive` 字段;mediump→highp 相位陷阱 | Pattern + Recipe + Example | E04 §2.3"K0 在此 API_HALLUCINATION 概率高";E05/E06 Reference 均手写完整样板 |
| 几何/批处理 | 批处理三路线决策树(共享网格×N 节点 / 合并静态网格 / 动态网格 updateSubMesh)+ 规模预算表(60fps ≤5 万 quad 保守、10 万锚点);createMesh primitiveMode falsy-zero 补丁;primitives 尺寸语义表(quad 恒 1×1、plane XZ);自建几何必须 minPos/maxPos;createDynamicMesh 非空初值+容量断言 | Recipe + Example | E07 §4 可执行建议;E04 §2.1;EB-07/18/19 |
| 光照/色彩 | HDR 量纲换算统一表(illuminance/ambient/spot ×10000);夜景基准值(skyIllum ~3800+月光 ~1900);clearColor/light.color 赋值语义;camera.visibility 必设;亮度显示值=存储值²(无输出 gamma);无 sRGB 的程序纹理提亮系数 | Docs + Recipe | E06 §6(Reference 自身 2 轮崩溃+夜景近黑);E10 §3.1;EB-19⑫ |
| GLB/生命周期 | GLTFAsset addRef/decRef 钉住语义(reset 复用防自动释放窗口);wrapMode=Loop 标准姿势(首次 instantiate 前设源 clip);clip 级属性跨实例共享边界;play() 激活时序;dispose/destroy 配对清单;K0 tarball air-gltf-standard 黑渲染规避(builtin-standard+diffuseMap) | Docs + Recipe + Example | E10 §2;PAIR-E10 arm-a 6 轮;EB-01/16 |
| 后处理 | "无后处理"事实声明+替代 Pattern 库:bloom impostor(多层 additive billboard+shader 内衰减+抖动去色带)、blob shadow、接触阴影烘焙——每个 Reference 已是活例,可直接收编 Example | Recipe + Example | E05 §4 替代手段表;E04/E06/E10 同型绕行;EB-10 |
| 交互控制器 | OrbitControls 等价 Recipe(球坐标+指数平滑 ~30–40 行,三场景同型)+ "断言友好"平滑参数指引(动作后保留残差运动) | Pattern + Skill | E03/E05/E06 各手写一遍;E02 P4 失败(§4.2) |
| 探针/断言语义 | harness 判定语义说明:状态断言在动作后 sampleWindowMs 采样;nonBlank 分区 litRatio 阈值口径;regionChange 需持续运动源(静止相机+已销毁区域会误判);视觉密度预算公式(星点数×直径→每角占比) | Skill(bench 侧)+ Docs | §4.2/4.3/4.5 三处分歧;E10 ceiling-notes §3-6 |
| 诊断闭环 | 结构化错误码族:NaN 家族(材料/灯光)、静默黑屏鉴别表(visibility/注册时机/图元替换/NAN)、事件失灵(getLocation 毒化)——每码绑定"症状→根因→绕行" | Error Diagnostics | §3 全表;§4.1 成本差的主体 |

---

## 6. 差距→处置类型总标注(§26.9 口径汇总)

| 差距组 | 处置类型 | 优先级 |
|---|---|---|
| 后处理缺失(EB-10) | **补 Engine** | P0 |
| transmission 死代码(EB-02) | **补 Engine**(一行级) | P0 |
| NaN 家族:setProperty/Light.color 类型校验+错误码(EB-03/04) | **补 Engine + 补 Error Diagnostics** | P0 |
| getLocation 毒化(EB-06) | **补 Engine + 补 Error Diagnostics** | P0 |
| air-gltf-standard K0 tarball 黑渲染(EB-01) | **补 Engine**(回归测试) | P0 |
| POINT_LIST 双补丁(EB-07) | **补 Engine + 补 Docs** | P0 |
| Vec4 `.w` 丢失(EB-05)、顶点 UBO 漂移(EB-09)、visibility/注册时机无报错(EB-13/14)、点光阴影(EB-11)、fog 重编译(EB-12)、sRGB(EB-15)、wrapMode(EB-16)、就地顶点写(EB-17) | **补 Engine(+Docs)** | P1 |
| 事件层契约、亮度换算、GLB refcount、API 长尾(EB-08/19) | **补 Docs** | P1/P2 |
| effect JSON 模板/生成器、批处理三路线、bloom impostor、OrbitControls 等价、夜景标定、密度预算 | **补 Pattern + 补 Recipe** | P1 |
| 各 Reference 场景直接收编为官方示例(E01 点云/E04 烟花/E05 吸积盘/E06 篝火/E07 夜城/E08 鱼群/E09 折射) | **补 Example** | P1 |
| 探针断言语义、自检口径对齐、NaN 症状速查 | **补 Skill + 补 Error Diagnostics** | P1 |
| InstancedMesh/Points/3D 粒子(EB-18) | **补 Engine**(评估)或封装 DynamicQuadBatch | P2 |

---

### 附:Pilot attainment 数据总览(`results/pilot-aggregate.json`)

| Pair | three raw/attainment | AIR raw/attainment | paired outcome |
|---|---|---|---|
| E01 | 80 / 0.96 | 85 / 1.04 | AIR_WIN(+0.08) |
| E02 | 84 / 1.05 | 65 / 0.80 | THREE_WIN(-0.25) |
| E05 | 52 / 0.63(FAIL) | 51 / 0.61(FAIL) | TIE(-0.02) |
| E10 | 76 / 0.99 | 77 / 1.00 | TIE(+0.01) |

Reference ceiling(`results/reference-ceiling.json`):双引擎 10/10 可用,79/79 探针全绿,fps 全部 60.0–60.3;AIR 5 场景 FEASIBLE_LIMITED(E01/E02/E04/E08/E10,后处理/传输受限面如实标注),three 4 场景 FEASIBLE_LIMITED(E05/E06/E07/E09,各自如实标注)。
