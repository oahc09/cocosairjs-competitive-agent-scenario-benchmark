# RESULT — PAIR-E10-K0-R01 Arm B (engine: three, K0)

Run 完成,完成合同 §5 五项全部满足。产物位于本 Arm 目录 `workspace/`(站点根 = workspace,`npm run dev` / serve.mjs 即可复现)。

## 1. 实现摘要(逐 probe)

- **P1(就绪 + 双实例 Idle + 网络)**:启动即以相对路径 `assets/character.glb` 发起唯一一次网络请求(GLTFLoader.loadAsync,整会话一次),解析 Khronos Fox(1 skin / 24 joints / 3 clips / PNG 贴图)后由 `SkeletonUtils.clone` 建立双实例(左 A 右 B,间距 ~3.2 单位),各自独立 `AnimationMixer` 播放 Idle(clip 映射 Survey->`idle`、Walk->`walk`),首帧渲染后置 `__appReady`;两区域 nonBlank 0.277 / 0.342(阈值 0.1)。
- **P2(双实例动画播放)**:两实例 mixer 独立推进,`instances.A/B.time` 为当前剪辑 action.time(循环回绕,spec 允许),双区域运动差异 0.091 / 0.079(蒙皮骨骼驱动,非补间冒充)。
- **P3(实例隔离)**:`anim-a-walk` 点击后 17ms 内状态切到 walk(0.15s 交叉淡化),仅 A 的 mixer/action 变化,B 保持 idle;A 区域 regionChange 0.030。
- **P3b(双向隔离,scoring 补充)**:`anim-b-walk` 仅切 B,A 保持 walk;`anim-b-idle` 仅切回 B——两实例无任何共享动画状态。
- **P4(销毁 A)**:A 的 root 从场景图移除 + `stopAllAction` + `uncacheRoot` 释放实例动画资源(非隐藏;几何/材质为克隆共享,保留给幸存实例 B),`instanceCount=1`、`destroyedInstance="A"`、`instances.A=null`,A 区域变化 0.191,B 区域仍 nonBlank 0.342。
- **P5(B 存活)**:销毁 A 后 B 的 idle 继续播放(time 持续变化 + 区域运动 0.067),无任何对 B 的连带销毁/重置。
- **P6(reset)**:应用内重建双实例(再次由缓存的 gltf 数据 clone 派生,零新网络请求——验证 total=1 不变、无页面刷新),`resetCount=1`、双实例回 Idle、`destroyedInstance=null`,双区域恢复 nonBlank 0.272 / 0.343;`__bench.reset()` 与 UI reset 按钮同一实现。
- **P7(恢复 + 帧率)**:双实例动画均推进,fps=60(最近 60 帧平均,阈值 30),零异常。

其他 scoring 要点:材质经 GLTFLoader 正确加载内嵌 PNG 贴图(像素采样暖橙 155,86,25 / 177,102,28,无品红缺省、无白模、无串扰);键光(castShadow, PCFSoft)+ 补光 + 逆光 + 半球光共 4 盏(≤6),地面径向渐变 + 接触阴影;相机中景轻微俯角(0,1.35,4.9 lookAt (0,0.5,0)),双实例完整入画、构图居中稳定。稳态抽检:35s 连续运行 fps=60 恒定、JS 堆无增长(-3.6%)、销毁 A 后 10s B 动画继续且帧率不降、全程零 console error / pageerror。

页面契约:`window.__bench = { getState, reset }` 全程可用;`getState()` 含 `assetLoaded / instanceCount / instances.A|B{clip,time} / destroyedInstance / resetCount / fps`(另附 engine/frame/ready)。

## 2. 自检清单(完成合同 §5)

- [x] `npm run build` 于 workspace/ 根执行,退出码 0(3 次尝试均成功;产物含 dist/assets 供 dist/index.html 独立 serve)
- [x] 页面 10s 内 `window.__appReady === true`(实测 ~310-385ms,含 GLB 加载)
- [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(探针脚本 P0 断言)
- [x] 无未捕获异常(全部 6 次浏览器验证 console error / pageerror 均为 0;资产加载失败路径为 catch + warn,不抛出)
- [x] 探针自检按 spec.json P1-P7 逐条自查通过:最终 probe-verify 22/22 PASS(P1-P7 状态断言 + 视觉断言 + 网络断言 + P3b 双向隔离补充);另 soak-verify SOAK_OK

预算:工具调用 ~30/120;墙钟 ~35/90 分钟;build 3/8;浏览器验证 6/6(第 2 次为命令误触发整跑,如实计入)。

## 3. 合规声明(§4 红线逐条)

- [x] 未访问另一 Arm 的任何目录/代码/日志/服务器/profile/截图/结果(全程序仅工作于 `arm-b/` 内)。
- [x] 未访问 `bench/reference/`。
- [x] 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录与既往 trial 结果。
- [x] 未访问 `bench/harness/` 源码与合同模板。
- [x] 未访问引擎源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经 workspace 内 vendored npm 包(`node_modules/three@0.186.1` 及其 examples/jsm)与 K0 知识包(README)使用。
- [x] 未访问 `bench/docs/`。
- [x] 未访问 `bench/secret/`。
- [x] 无任何联网行为:未搜索、未查文档、未访问包 registry、未 `npm install`(依赖均 vendored;esbuild/playwright-core 为模板既有)。补充披露:用 Read 工具查看本地截图 p1.png 时,该工具自动将文件上传至其渲染 CDN 并返回链接——这是宿主工具的显示机制,非本 Run 发起的信息获取;未从该 URL 拉取任何内容,后续视觉核验改为完全本地的像素数值分析。
- [x] 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness / validator / 探针代码与探针结果文件(修改仅限 workspace/ 内自有文件:src/main.js、index.html title、scripts/build.mjs 增加 dist/assets 拷贝、新增自有验证脚本;共享资产只读取与原样拷贝,sha256 复核一致)。
- [x] 未探测或篡改 harness/validator 的行为与期望值;探针自检脚本为本人独立按 spec.json 公开内容编写。

附注(环境事实如实声明):RUN-CONTRACT §0 dev server 端口表述自相矛盾(表列 `7101`,括号指示 `PORT=7107`),本 Run 按括号的显式环境变量指示使用 7107,并在验证结束后停止了该服务器。
