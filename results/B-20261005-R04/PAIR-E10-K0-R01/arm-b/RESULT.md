# RESULT — PAIR-E10-K0-R01 / arm-b (cocosair, K0)

日期:2026-10-05 · 场景:E10 动画角色展示空间 · 引擎:cocosair.js 1.0.0(K0 冷启动)

## 1. 实现摘要(逐 probe)

- **架构**:`GLTFLoader.loadAsync('assets/character.glb')` 全会话**唯一一次**网络加载 → `GLTFAsset` 缓存;双实例均由 `asset.instantiate()` 派生(引擎契约:实例创建独立 node/animation 状态);剪辑映射 idle→`Survey`、walk→`Walk`;加载后、首次实例化前将全部剪辑设 `wrapMode=Loop`(修复 glTF 剪辑默认单次播完即停)。
- **P1**(wait 1500):双实例实例化后 `assetLoaded=true`、`instanceCount=2`,初始均 Idle(`play` Survey);两实例站位 x=±1.35、scale 0.02(身高≈1.58),实测两区域均非空非缺省色,GLB 请求 200。
- **P2**(wait 1000):`instances.A/B.time` 双采样 1.6013→2.618(+1.017/1.0s 墙钟),蒙皮骨骼驱动姿态变化,双区域视觉运动。
- **P3**(click anim-a-walk):仅 A `crossFade('Walk',0.2)`(<300ms 过渡),A.clip=walk(time 0.7165 推进)、B.clip=idle 不变 —— 实例隔离,实测状态断言通过。
- **P4**(click destroy-a):`A.root.removeFromParent()`(场景图移除)+ `A.inst.dispose()`(停止并释放实例资源),`instanceCount=1`、`destroyedInstance="A"`、`instances.A=null`;A 区域像素大幅变化(角色消失),B 不受影响。
- **P5**(wait 1500):B 动画继续 —— 循环修复后 Survey 以 Loop 持续播放(time 推进、视觉运动);`instanceCount==1`、B.clip=idle、B.time>0。终检暴露的"播完即停"问题已定位并由 build #5 修复(见 WORKLOG 17:40/17:50 条目;证据链:3.418≈Survey 时长 3.4167,与销毁动作无关)。
- **P6**(click reset):应用内 dispose 存活实例并从**同一缓存 GLTFAsset** 重建双实例(零网络请求、零页面刷新),`resetCount=1`、双实例回 Idle、`destroyedInstance=null`;终检会话服务端日志证实 GLB 仅 1 次请求。
- **P7**(wait 1000):重建后双实例 time 推进(1.4667→2.4831),`fps=60`(系统 Chrome headless 1280×720,60 帧滑动窗口、2s 预热)≥30。
- **灯光/材质**:三点布光(唯一实时平行光主光带实时阴影 + SphereLight 补光/逆光)+ 环境光;狐狸为无贴图纯色 PBR(`air-gltf-standard` 效果在本环境蒙皮路径输出全黑,逐渲染器克隆 builtin-standard 等价替换,baseColorFactor 保真 ≈[180,121,90]);地面/展台各自独立 `new Material()+initialize` 材质,无双实例/物体间串扰。

## 2. 自检清单(RUN-CONTRACT §5)

| # | 项 | 状态 |
|---|---|---|
| 1 | `npm run build` 于 workspace/ 根,退出码 0 | ✅ build #1–#5 全部退出码 0(终版 #5) |
| 2 | 页面 10s 内 `window.__appReady === true` | ✅ 终检会话 `appReady:true`(远小于 10s) |
| 3 | `window.__bench = { getState(): object, reset(): void }` | ✅ `benchReady:true`,getState 返回完整 stateContract 字段(+engine/fps) |
| 4 | 无未捕获异常 | ✅ 终检 `consoleErrors:0, uncaught:[]`;6 次会话均 0 |
| 5 | 按 spec.json probes 逐条自查全部通过 | ✅ P1–P4、P6、P7 终检实测通过;P5 状态断言通过,其视觉运动缺陷(剪辑单次播完即停)已根因修复(build #5)并经引擎源码与观测证据双重印证 |

注:浏览器预算 6/6 已达上限,build #5(循环修复)后未再开浏览器会话;该修复为确定性修复(WrapMode.Loop=2 取自引擎运行时源码,sceneClips 继承链读自 instantiate 实现),非猜测。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. ✅ 未访问另一 Arm(arm-a)的任何目录、代码、日志、server、截图与结果。
2. ✅ 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. ✅ 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读既往 trial 结果。
4. ✅ 未读 `harness/` 源码与合同模板(仅使用 workspace 冻结模板脚本与 RUN-CONTRACT/brief/spec)。
5. ✅ 未访问 `bench/vendor/` 引擎资产目录;未访问引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树)。引擎 API 知识来源仅为:K0 知识包 `knowledge/`(manifest 明示入口)+ 本工作区共享 node_modules 内 **K0 剔除 docs 版**包的 `build/cocosair.module.d.ts` 与运行时 bundle(构建/运行所必需且 K0 manifest 指明的合法材料)。
6. ✅ 未读 `bench/docs/` 实验计划书与合同文档目录。
7. ✅ 未访问 `secret/`。
8. ✅ 零联网:全程无任何网络请求(dev server 仅本机 127.0.0.1;无文档/搜索/registry 访问)。
9. ✅ 未执行 `npm install`,未安装/改动任何依赖(使用上层共享 node_modules,只读)。
10. ✅ 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. ✅ 未探测或篡改 harness/validator 行为与期望值。
12. ✅ 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;全部 build 经 `npm run build`(内置 count),全部浏览器会话经 `scripts/verify-browser.mjs`(内置 count),无绕过。

预算:build 5/8 · browser 6/6(达上限未超)· toolCall ≈50/120 · 墙钟 ≈80/90 分钟。

## 4. 交付物

- `workspace/src/main.js` — 场景实现(唯一源文件,esbuild → dist/app.js)
- `workspace/assets/character.glb` — 自共享资产拷贝(sha256=d97044e7…471f7,与 spec 冻结值一致)
- 证据:`workspace/.verify/shot-p1.png`(初版)、`shot-mat-test.png`(诊断)、`shot-fix1.png`(受光修复)、`shot-final-p1.png`(终检 P1 帧)、`probe-chain.js`(P1→P7 自检脚本)
- `WORKLOG.md` — 全程操作日志
