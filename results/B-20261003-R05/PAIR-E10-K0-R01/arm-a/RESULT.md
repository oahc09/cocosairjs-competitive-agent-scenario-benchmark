# RESULT — PAIR-E10-K0-R01 / arm-a(three, K0)

> 场景 E10 动画角色展示空间。实现位于 `workspace/`(入口 `src/main.js`,构建产物 `dist/`)。
> 状态:完成 —— build 退出码 0,P1–P7 探针自检全 PASS,无未捕获异常。

## 1. 实现摘要(逐 probe)

技术路线:`GLTFLoader` 以相对路径 `assets/character.glb` **单次**加载(运行时观测到该请求恰 1 次、200);`three/addons/utils/SkeletonUtils.js` 的 `clone` 由同一份已解析 `gltf.scene` 派生双实例(禁二次网络加载);每实例独立 `AnimationMixer` + 独立材质克隆 → 动画与材质完全隔离。GLB 内剪辑映射规范名:**idle → `Survey`(3.42s 原地待机)、walk → `Walk`(0.71s 行走循环)**(资产无名为 Idle 的剪辑,spec 允许应用层映射)。骨骼蒙皮动画全部由 GLB 内动画剪辑驱动 `AnimationMixer`,无任何形态键/顶点补间冒充。

| Probe | 动作 | 满足方式 | 自检结果(状态 + 视觉) |
|---|---|---|---|
| P1 | wait 1500 | 加载完成后 `buildPair()` 建双实例,初始均 `actions.idle.play()`;`assetLoaded=true` | PASS:assetLoaded=true、instanceCount=2、A/B.clip=idle;两区域 nonBlank≈0.60/0.59(≥0.1),GLB 请求 200 |
| P2 | wait 1000 | 独立 mixer 每帧 `update(dt)`,`getState().instances.*.time` 读当前 action.time(随播放推进、循环回绕) | PASS:A.time/B.time>0;两区域 800ms 帧间变化 0.155/0.126(运动中) |
| P3 | click anim-a-walk | `setClip(A,'walk')`:`reset().fadeIn(0.12)`+旧剪辑 `fadeOut(0.12)`(≤300ms 过渡);仅操作 A 的 mixer,B 不受影响 | PASS:A.clip=walk、B.clip=idle;A 区 500ms 变化 0.083(Walk 运动幅度显著),B 区保持 Idle 画面 |
| P4 | click destroy-a | `scene.remove(holder)` + `mixer.stopAllAction()`/`uncacheRoot` + 本实例材质克隆 `dispose()`(共享几何/贴图不动,B 完好);**非仅不可见** | PASS:instanceCount=1、destroyedInstance="A"、instances.A=null;A 区动作前后 pixelDelta=0.215(≥0.02,角色移除),B 区仍 nonBlank=0.598 |
| P5 | wait 1500 | B 的 mixer 从未被动过,持续播放 Survey | PASS:instanceCount=1、B.clip=idle、B.time 推进;B 区持续运动(0.110),A 区静止(0) |
| P6 | click reset | `resetAll()`:旧实例销毁后由**缓存** gltf 数据重建 A/B,均回 Idle;`resetCount+1`;零新增网络请求、不刷新页面(window 标记存活验证) | PASS:resetCount=1、instanceCount=2、destroyedInstance=null、A/B.clip=idle;两区域 nonBlank≈0.60/0.59;GLB 请求仍仅 1 次 |
| P7 | wait 1000 | 双实例 mixer 继续推进;fps 为就绪后最近 60 帧平均 | PASS:A/B.time>0;两区域运动 0.170/0.130;fps=60(≥30) |

补充实现点:

- **状态契约** `window.__bench = { getState, reset }`:getState 返回 `assetLoaded / instanceCount / instances.A|B {clip,time}|null / destroyedInstance / resetCount / fps`,字段语义与 stateContract 一致;UI `reset` 按钮与 `__bench.reset()` 为同一函数。
- **UI 控件组**:顶栏 6 钮 `anim-a-idle / anim-a-walk / anim-b-idle / anim-b-walk / destroy-a / reset`,均同时带 `data-bench` 与 `data-ui` 属性;CSS hover/active 反馈;实例 A 销毁后 `destroy-a` 置灰(`disabled`),reset 后恢复。
- **三点布光**:暖色键光(投影,1024 shadow map)+ 冷色补光 + 白色逆光 + 半球环境光;地面 + 双展台圆盘 `receiveShadow`,角色 `castShadow` → 接触阴影可辨;渐变背景,中性展示空间。
- **构图**:相机 fov42、(0,1.5,4.6) 平视微俯;实例 A/B 位于 x=∓1.55,各自投影落在探针区域 A/B 中心;每实例 yaw ±0.45 面向相机 3/4 侧身,双实例完整入画(截图目检确认,首轮发现背面朝向+尾部出画已修复)。
- **资产本地可达**:dev server 根为 `workspace/`,而共享资产在 Arm 目录 `assets/`(只读),故将 `character.glb` **字节级复制**至 `workspace/assets/character.glb`(sha256 `d97044e701822bac…971f7` 与 spec 冻结值一致);原始 `assets/` 目录未被修改。整会话对该资产的网络请求恰 1 次(reset 不重发)。
- 视觉证据截图存于 `workspace/.selfcheck/`(p1…p7b、final.png)。

## 2. 自检清单(完成合同 §5)

- [x] **1. `npm run build` 退出码 0** —— 共 3 次构建(#1 初版、#2 朝向修复、#3 fps 口径修正),均退出码 0;最终产物 dist/ 由第 3 次构建生成。
- [x] **2. 页面 10s 内 `window.__appReady === true`** —— verify-browser 实测就绪(appReady=true,轮询上限 10s;本地 GLB 160KB,实际 <1s)。
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立** —— benchReady=true;getState 返回 stateContract 全部字段。
- [x] **4. 无未捕获异常** —— 最终 verify-browser:consoleErrors=0、uncaught=[];probe-check 全程 console error 与 pageerror 均为 0。
- [x] **5. 探针自检(spec.json probes 逐条)** —— 自建 `scripts/probe-check.mjs`(会话前先执行 `count.mjs browser`)按 P1–P7 顺序执行动作 + 状态断言 + 区域像素断言:**7/7 PASS**,另验证 GLB 请求恰 1 次 200、reset 无页面刷新、双向实例隔离 UI 可用。

预算实耗(诊断口径;判定以 harness budget-check 读取 `workspace/.budget/` 机器计数为准):build 3/8;browser 5/6(全部经 `count.mjs browser` 先计后会话)。

## 3. 合规声明(逐条,§4 禁止访问/行为)

1. **未访问另一 Arm 的一切**(目录、代码、日志、dev server、浏览器 profile、截图、结果)。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)。
3. **未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未访问既往 trial 结果**。
4. **未访问 `harness/` 源码与本合同模板**(仅读取发给本 Arm 的 RUN-CONTRACT.md 本体)。
5. **未访问引擎源码仓库**(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经模板给定路径使用(`three@0.186.1` 包与 vendored dist)。
6. **未访问实验计划书与 `bench/docs/`**(brief.md 提到的 MASTER-CONTEXT 仅见于模板注释,未读取该文档)。
7. **未访问 `secret/`**。
8. **未联网**:无任何网络请求(无文档、搜索、包 registry;页面本身仅请求本 dev server 的本地资源)。
9. **未执行 `npm install`,未安装/改动任何依赖**,未改动共享 node_modules 内容(构建与 playwright-core 均沿目录向上解析既有共享仓)。
10. **未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件**(assets/ 亦只读;`workspace/assets/character.glb` 为新增字节级副本,原文件未动)。
11. **未探测或篡改 harness/validator 的行为与期望值**(probe-check.mjs 为本 Arm 自建自检脚本,仅读取 arm 目录内 spec.json,不触及 harness)。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 机器计数文件,未绕过计数**:全部构建经 `npm run build`(内建 count),全部浏览器会话创建前先执行 `node scripts/count.mjs browser`(probe-check.mjs 脚本内第一步即调用,verify-browser.mjs 内建)。

以上声明属实。
