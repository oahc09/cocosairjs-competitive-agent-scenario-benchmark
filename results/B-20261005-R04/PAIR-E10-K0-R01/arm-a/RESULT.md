# RESULT — PAIR-E10-K0-R01 / Arm A (engine: three r186, 知识等级 K0)

## 1. 实现摘要(逐 probe)

实现:`workspace/src/main.js`。`GLTFLoader` 以相对路径 `assets/character.glb` **单次**加载(Khronos Fox,剪辑 Survey/Walk/Run 映射为规范名 `idle`=Survey、`walk`=Walk),母本归一化(身高 1.8、脚底贴地、水平居中)后经 `SkeletonUtils.clone` 派生双实例(A 左 `-0.85`、B 右 `+0.85`),**各自独立 `AnimationMixer`** 保证剪辑与播放时间完全隔离;三点布光(暖键光投影 + 冷补光 + 逆光)+ 半球光,地面/展台圆盘接收 `PCFSoftShadowMap` 接触阴影,渐变背景;UI 六控件(`anim-a-idle/anim-a-walk/anim-b-idle/anim-b-walk/destroy-a/reset`)同时携带 `data-ui` 与 `data-bench`,hover/active 样式,A 销毁后 `destroy-a` 置灰。

- **P1**(就绪与非空):GLB 加载完成、双实例建立并播放 Idle 后置 `__appReady=true`;`assetLoaded=true`、`instanceCount=2`、双实例 `clip:"idle"`;两角色区域均为贴图网格非空非缺省色。网络观测:`GET /assets/character.glb 200`(整会话仅 1 次)。
- **P2**(双实例动画播放):`instances.A.time / B.time` 随 mixer 推进(自检 1.755→2.772),两区域均有骨骼驱动视觉运动(idle=Survey 原地环顾)。
- **P3**(实例隔离):点击 `anim-a-walk` 仅 A 的 mixer 切换 Walk(`A.clip="walk", B.clip="idle"`),crossfade 0.18s;A 区域步态运动幅度增大,B 状态与画面无变化。
- **P4**(销毁 A):点击 `destroy-a` → A 从场景图移除并 `mixer.uncacheRoot` 释放实例绑定(非仅隐藏),`instanceCount=1`、`destroyedInstance="A"`、`instances.A=null`;A 区域回到背景(角色消失,pixelDelta 充分),B 区仍非空。
- **P5**(B 存活续播):销毁后 B 的 mixer 未受任何影响,`B.clip="idle"` 且 time 持续推进(1.656→3.172,循环回绕正常),B 区域持续视觉运动,无未捕获异常。
- **P6**(reset):点击 `reset` → 由缓存母本应用内重建 A、B 归位 Idle(时间归零),`resetCount=1`、`instanceCount=2`、`destroyedInstance=null`、双实例 `clip:"idle"`;serve 日志证实**零新 GLB 请求**、无页面刷新。
- **P7**(恢复后播放与帧率):双实例 time>0(2.517)且 `fps=60 ≥ 30`(getState 内 60 帧滚动平均),双区域视觉运动,无异常。

Forbidden Shortcuts 逐条规避:骨骼动画全部由 GLB 剪辑驱动蒙皮(无形态键/补间);双实例由单次加载克隆派生(无二次网络加载);销毁为真实场景图移除+资源释放;reset 为应用内重建(无刷新/无重请求);状态字段与画面同步(截图+网络日志佐证);渲染 GLB 网格与材质(非程序化假人);销毁 A 未触碰 B。

## 2. 自检清单(完成合同 §5)

- [x] `npm run build` 在 workspace 根执行,退出码 0(build #1,产物自检 OK)
- [x] 页面 10s 内 `window.__appReady === true`(verify-browser 实测 `appReady:true`)
- [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(实测 `benchReady:true`)
- [x] 无未捕获异常(`consoleErrors:0`,`uncaught:[]`)
- [x] 探针自检 P1–P7 按 spec.json 逐条(状态断言+视觉断言)全部通过(浏览器会话 #1 实测 JSON 与截图 `shot-1-idle.png`)

## 3. 合规声明(§4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果;
2. 未访问 `reference/` 任何内容;
3. 未读取本 Pair 本 Arm 之外的 `bench/results/` 目录及一切既往 trial 结果;
4. 未读取 `harness/` 源码与合同模板(仅使用 workspace 内预置脚本按其接口调用);
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);引擎仅经共享 node_modules 的已安装产物使用;
6. 未读取实验计划书与 `bench/docs/`;
7. 未访问 `secret/`;
8. 未发起任何网络请求(无文档/搜索/registry;页面资源全部本地 vendored);
9. 未执行 `npm install`,未改动共享 node_modules;
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件(workspace 模板脚本 `count.mjs`/`verify-browser.mjs`/`build.mjs`/`serve.mjs` 均未改动);
11. 未探测或篡改 harness/validator 的行为与期望值;
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,所有构建与浏览器会话均经 `count.mjs`/`verify-browser.mjs` 计数(build #1、browser #1)。

备注:`arm-a/assets/` 只读未动;`workspace/assets/character.glb` 为自 `arm-a/assets/` 的只读复制(满足 dev server 相对路径 200 观测)。dev server(PORT=7126)在后台保持运行,日志含完整网络观测记录。
