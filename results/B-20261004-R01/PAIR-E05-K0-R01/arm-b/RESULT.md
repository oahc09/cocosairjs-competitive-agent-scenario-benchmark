# RESULT — PAIR-E05-K0-R01 / Arm B(cocosair K0)

> 场景:E05 黑洞吸积盘。实现于 `workspace/src/main.js`(esbuild → `dist/app.js`,引擎经 import map 加载)。
> 全部视觉程序化生成(自定义 EffectAsset 着色器 + 程序化网格),零外部资产,零纹理文件,零网络请求。

## 1. 实现摘要(逐探针)

- **实现路线**:运行时程序化注册两套自定义 EffectAsset(与引擎 builtin 同一注册路径 `onLoaded()` → `programLib.addEffect`,WebGL2 取 glsl3 源,转换与引擎 `toGlsl3` 逐字等价):
  - `bh-disk`:吸积盘环面着色器——径向三段色温(白亮 → 亮橙 → 暗红)+ 明暗相间旋转条纹(随盘节点旋转,时间参数驱动)+ 螺旋缠绕 + 细丝扰动 + 多普勒不对称(逆时针切向朝向相机一侧增亮,由 `cc_cameraPos` 与世界坐标实时计算)+ 内外软边(无硬边);加色混合。
  - `bh-billboard`:世界空间面片(per-vertex 模式)——星点(亮核+柔光晕)、星流拖尾(运动方向拉伸)、光子环(高斯细环,顶部略亮的透镜观感)、冷色星云(四角柔和抬亮)、以及一枚不透明技术绘制锐利黑体视界圆盘(写深度,遮挡其后一切,保持暗核纯黑)。
  - 辉光替代方案:加色混合多层柔光(内缘热辉光 + 光子环 + 星点晕 + 盘面软边),无后处理。
- **星流**:220 粒子动态网格(`utils.MeshUtils.createDynamicMesh` + 每帧 `updateSubMesh`),类开普勒角速度(内快外慢)螺旋内落,近视界加速、拖尾按速度拉长,越过视界即于外圈重生,总数恒定 220。
- **相机**:初始距离 14.0、俯仰 62°、fov 65(暗核直径约占短边 13%);`wheel` capture 监听(pal 层吞 canvas 事件),目标距离夹取 [5,28],指数平滑插值(k=8,1s 内残差 <0.1%)。
- **P1 初始画面**:`backgroundStarCount=460≥300`、`starStreamCount=220≥200`、`cameraDistance=14∈[13,15]`、`diskRotation>0`;像素:中心 1/3 亮环比重大(内带亮度 128),暗核 14.2% 短边被光子环与亮环包围,四角非黑 4.4–45.9%(≥1%)。
- **P2 旋转运动**:800ms 采样 ΔdiskRotation=0.28 rad(≥0.1,对应角速度 0.357 rad/s ∈[0.15,0.6]);盘面条纹/亮臂位置随时间连续移动(截帧差分可见),运动为节点旋转+时间参数驱动,非回放。
- **P3 径向色温**:多普勒亮侧扇区有向 R-B 差(外−内)= 49.7(≥18),内环带亮度/外环带 = 1.66(≥1.5);内白-中橙-外暗红梯度经环形采样验证;亮部经多层加色柔光向外平滑衰减。
- **P4 滚轮缩放**:wheel dy=-600 → cameraDistance 14→8.600∈[5,10),平滑到位(后续采样残差 <0.001%);缩放后暗核/盘外缘占屏比按投影计算同比放大约 1.63×(≥1.25×/1.2×)。
- **P5 星流螺旋**:粒子数恒定 220,拖尾四边形逐帧沿螺旋轨迹推进(动态网格重建),近视界白热拉长、外圈橙暗;中环区域两帧差分含星流推进与条纹旋转双重运动证据。
- **P6 reset**:`data-ui="reset"` 按钮(右上角,x>0.8,y<0.25)与 `__bench.reset()` 等价;复位后 cameraDistance 13.78∈[14±0.5]、diskRotation 0.14<0.3、accretionPhase 0.022<0.1、星流复位重生、背景星不变、`__appReady` 保持 true、画面完整。

## 2. 自检清单(§5 完成合同)

- [x] `npm run build` 于 workspace 根执行,退出码 0(共 6 次构建,机器计数 6/8)
- [x] 页面 10s 内 `window.__appReady === true`(实测 <1s,EVENT_AFTER_DRAW 首帧置位)
- [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(getState 返回真实运行数据,不伪造)
- [x] 无未捕获异常(终检 consoleErrors=0、uncaught=[],自捕获 `window.__errs` 为空)
- [x] 探针自检:按 spec.json P1–P6 逐条自查(状态断言 + 截图像素/运动证据),全部通过(浏览器 #6 终检;预算 6/6 触顶后以像素分析器复核截图证据)

## 3. 合规声明(§4 红线逐条)

1. 未访问另一 Arm(arm-a)的任何目录、代码、日志、server、截图或结果。
2. 未访问 `reference/` 及任何 Reference 实现/截图/验证器。
3. 未访问 `bench/results/` 下本 Pair 本 Arm 之外的任何目录;未读取既往 trial 结果。
4. 未读取 `harness/` 源码与合同模板(仅使用 workspace 内预置的 scripts/*)。
5. 未访问 `bench/vendor/` 与引擎上游源码仓库;仅读取共享 node_modules 内已安装的 `cocosair.js` K0 包(README + d.ts + 运行时 bundle,属依赖解析的正常读取)。
6. 未访问 `bench/docs/` 实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何网络请求(无文档/搜索/registry 访问;页面运行时亦无网络请求)。
9. 未执行 `npm install`,未安装或改动任何依赖,未改动共享 node_modules 内容。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(探针自检仅通过公开页面契约 `__bench`/`data-ui` 与合成 DOM 事件进行)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build`(count.mjs 串联),所有浏览器会话均经 `scripts/verify-browser.mjs`(计数 6/6)。

## 4. 环境事实备注

- dev server 于 PORT=7111 启动(后台运行中,会话结束由 coordinator 处置)。
- 帧率:帧计数推算常态约 55–60fps(1280×720,≥30 达标);绘制调用约 5 次,无 GC 压力热点。
- 引擎坑位实录(K0 实测,供 gap-map 参考):Mat4 为 m00..m32 标量域(无 `.m` 数组);Vec3 仅 `.x/.y/.z`(下标访问得 undefined→NaN 面片消失,且无任何告警);自定义 EffectAsset 的 shaders[].`descriptors`(按 UpdateFrequency 分组)为导入路径注册必需;canvas wheel 须 window capture 监听。

— Arm B Agent Run,2026-10-04
