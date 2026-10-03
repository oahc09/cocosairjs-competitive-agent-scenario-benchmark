# RESULT — PAIR-E10-K0-R01 / Arm B (cocosair)

> 一次性 R0 自主模式。实现位于 `workspace/`(入口 `src/main.js`),静态产物 `workspace/dist/`。
> 工作日志见 `WORKLOG.md`;预算机器计数 `workspace/.budget/{build,browser}.count`。

## 1. 实现摘要(逐 probe 一句话)

总体架构:页面启动 → `createAirApp` → 搭建展示空间(相机/三向光/地面/背景)→ **单次** `GLTFLoader.loadAsync('assets/character.glb')`(Fox:1 skin/24 joints,clips Survey|Walk|Run)→ 由同一 `GLTFAsset` 两次 `instantiate()` 派生双实例(各自独立 `Animation` 组件 + 独立 `AnimationState`,规范名 `idle`←Survey、`walk`←Walk,`WrapMode.Loop`)→ 播放 Idle → 双实例就绪后首个 `EVENT_AFTER_DRAW` 置 `__appReady`。相机 fov45 @ (0,1.35,4.6),实例 A/B 站位于 x=∓1.7。

| Probe | 满足方式 | 自检 |
|---|---|---|
| P1 | `assetLoaded=true`、`instanceCount=2`、双实例 `idle`;对 `assets/character.glb` 恰一次网络请求(200);两实例区域均非空非缺省色(截图 final-idle.png) | PASS |
| P2 | 双实例 `time` 由各自 `AnimationState.current` 推进(实测 1.827→2.643),两区域画面随骨骼动画运动 | PASS |
| P3 | 点击 `anim-a-walk` → 仅 A 切 `walk`(直接切换,≤300ms),B 保持 `idle` 且相位连续(2.643→wrap 0.226→…) | PASS |
| P4 | 点击 `destroy-a` → `scene.removeChild(A.node)` + `GLTFInstance.dispose()`(场景图移除并释放实例资源,非仅不可见);`instanceCount=1`、`destroyedInstance="A"`、`instances.A=null`;A 区域像素大幅变化,区域 B 仍可见 | PASS |
| P5 | 销毁 A 后 B 动画不受影响:`instances.B.clip=idle`、`time` 持续推进(1.044→2.544),fps=58,无未捕获异常 | PASS |
| P6 | 点击 `reset` → 应用内重建:teardown 残余实例后由**缓存的 GLTFAsset** 重新 `instantiate()` 双实例并回到 Idle;`resetCount=1`、`destroyedInstance=null`;**不重新请求 GLB、不刷新页面** | PASS |
| P7 | 恢复后双实例 `time` 推进(1.483→2.5→3.3)、`fps≈60 ≥ 30`,无异常 | PASS |

附加双向隔离验证:点击 `anim-b-walk` 后 `A=idle`、`B=walk`,A 不受影响(PASS)。

关键实现决策:
- **Fox 网格无 NORMAL 属性**(POSITION/TEXCOORD_0/JOINTS_0/WEIGHTS_0),本引擎 gltf 解析器不生成法线,PBR 材质下 N·L=0 渲染全黑;资产 sha256 冻结不可改,故角色改用 **unlit 材质实例 + 已解析 baseColor 贴图**呈现(颜色/分区正确,不依赖法线;蒙皮由管线按 SkinningModel 注入,骨骼动画照常驱动)。三向光/环境光/阴影照常作用于地面与场景。
- **贴图宏**:bundle 内效果 JSON 证实 unlit 的 `mainTexture` 采样挂在 `USE_TEXTURE` 宏、standard 的 `albedoMap` 挂在 `USE_ALBEDO_MAP` 宏,且 `recompileShaders` 仅允许材质实例 → 以 `new Material().copy(tpl,{defines})` 出实例再 `setProperty`(共享 builtin 材质不被改动,无双实例间材质串扰)。
- **UI 六控件**均带 `data-bench` 与 `data-ui` 双属性(`anim-a-idle/anim-a-walk/anim-b-idle/anim-b-walk/destroy-a/reset`),hover/active 反馈,destroy 在 A 销毁后置灰、reset 后恢复。
- `getState()` 严格按 stateContract:`assetLoaded/instanceCount/instances.A/instances.B/destroyedInstance/resetCount` + `fps`(最近 60 帧平均)。
- UI 工具条置于画布顶部(y<0.07 归一化),不侵入两实例视觉断言区域。

## 2. 自检清单(§5 完成合同)

- [x] 1. `npm run build` 于 workspace 根执行,退出码 0(共 3 次 build,全部 0;计数见 `.budget/build.count`)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测每会话 ~1s 内即 true;`verify-browser` 的 appReady=true ×6)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true ×6;reset 与 UI reset 按钮同一实现)
- [x] 4. 无未捕获异常(全部 6 次会话 consoleErrors=0、uncaught=[])
- [x] 5. 探针自检:P1–P7 状态断言 + 视觉断言全部通过(最终会话 browser#6 单会话内逐条走查,记录见 WORKLOG;状态断言按 spec jq 逐条等价实现;视觉断言经 final-idle.png 与运行中运动证据核对:双区域 nonBlank、运动、隔离、销毁像素差、reset 恢复)

## 3. 合规声明(逐条,§4)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。**未访问**。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。**未访问**。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;未访问任何既往 trial 结果。**未访问**。
4. 未访问 `harness/` 源码与本合同模板。**未访问**。
5. 未访问引擎源码仓库 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树。**未访问**(仅读取共享 node_modules 内已安装的 `cocosair.js@1.0.0-k0` npm 包自带 README 与 `build/cocosair.module.d.ts`,该包即本 workspace 的合法依赖,来源为 K0 tarball,docs 已剔除)。
6. 未访问实验计划书与 `bench/docs/`。**未访问**。
7. 未访问 `secret/`。**未访问**。
8. 未发起任何网络请求(无文档/搜索/包 registry;运行期仅本地 dev server 对 `assets/character.glb` 的单次请求)。**未违反**。
9. 未执行 `npm install`,未安装/改动任何依赖;共享 node_modules 仅读取。**未违反**。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。**未修改**(workspace/assets/character.glb 为自建副本,与冻结 sha256 一致)。
11. 未探测或篡改 harness/validator 的行为与期望值。**未违反**(浏览器会话均经 `scripts/verify-browser.mjs`,eval 仅读取自身应用状态与驱动自身 UI 控件)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 `count.mjs`/`verify-browser.mjs` 计数。**未违反**(build ×3、browser ×6 均由脚本自动计数)。

预算终值(机器计数):build 3/8、browser 6/6、toolCall 远低于上限、墙钟 < 90 分钟。
