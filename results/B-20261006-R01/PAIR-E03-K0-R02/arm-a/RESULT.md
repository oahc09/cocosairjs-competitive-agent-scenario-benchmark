# RESULT — PAIR-E03-K0-R02 / arm-a(cocosair, K0)

> 一次性 R0 自主模式交付。实现:`workspace/src/main.js`(esbuild → `dist/app.js`,引擎经 import map 外部加载)。
> 验证:`npm run build` 退出码 0;`node scripts/verify-browser.mjs` 3 次会话,末次含 P1–P9 全链路自检,**9/9 PASS**,console 0 错误、0 未捕获异常,fps≈60(≥30)。

## 1. 实现摘要(逐 probe 一句话)

| Probe | 实现与证据(状态断言 + 独立观测) | 自检 |
|---|---|---|
| P1 初始分层 | 8 行星按 r=6→35.5 升序、周期 240→3453 模拟秒(r^1.5 压缩,单调递增);2s 采样窗内 mercury Δangle=0.0528 > 4×neptune Δangle=0.00367(实测 14.4×);画面非空:恒星+行星+带+轨道线(screenshot shot-01/03 亮像素明显 ≥3%) | PASS |
| P2 点击选中 earth | window 捕获阶段 pointerdown 拾取(pal 层吞 canvas 事件 → 捕获先于 target 阶段),命中判据 = 投影半径 ∨ ≥12px;点击 pickTargets[2](earth)→ `selectedPlanet=="earth"`,行星处出现高亮圈(子节点环面激活) | PASS |
| P3 信息卡 | 点击驱动(初始隐藏,`display:none`);DOM 卡片含名称 earth + 4 数据字段(type / orbital period / orbit radius / moons),`infoCard={visible:true,name:"earth",fieldCount:4}` 与 DOM 镜像一致 | PASS |
| P4 8x 档位 | 五档按钮(0.5x/1x/2x/4x/8x,data-ui=speed-*)真实切换模拟倍率,`timeScale==8`,当前档 `active` 高亮,DOM 五控件齐全 | PASS |
| P5 8x 真加速 | 倍率作用于模拟时钟(dt×timeScale 累积):1.5s 窗 ΔsimulationTime=12.13 ≥ 6,mercury Δangle=0.3176 ≥ 0.05,且为 1x 同窗(≈1.5s/0.052rad)的 ~8 倍,非仅改状态;全画面 motion 证据 = 行星/带实时位移 + fps 60.5 | PASS |
| P6 Reset | 软复位(无 reload/导航):`epoch=1`、`timeScale==1`、selectedPlanet=null、信息卡关闭、渲染连续(EVENT_AFTER_DRAW 持续触发) | PASS |
| P7 复位后状态 | reset 后 ~1.8s 采样:simulationTime=1.8 < 2.5,mercury angle=0.0471 ∈ ±0.08(=k×45° + 采样延迟内自然推进),neptune=5.5011 ∈ [5.43,5.56](315°),无选中、卡关闭,fps 60.5 = 画面仍在运动 | PASS |
| P8 0.5x 档位 | `timeScale==0.5`,五档 DOM 存在,降速后运动持续(0.5× 时间步进) | PASS |
| P9 空白负向 | 点击 (0.08,0.08) 角落(布点设计保证该角无任何 UI/行星):不选中(`selectedPlanet==null`)、信息卡 absent(对齐 NC04:仅命中行星投影半径内才选中,空白即取消) | PASS |

行为项覆盖:恒星发光核心+双层加色光晕(全画面最亮);8 行星按类型着色互辨(岩质灰褐/锈红、气巨米黄、冰巨蓝青);土星半透明倾斜环(initial 斜俯视 38° 可辨);4 颗卫星为行星**子节点**(父子层级,随行星公转且有可见相对运动);小行星带 560 个**独立 Node+MeshRenderer 小天体**(共享 box 网格/材质,带内速度 ×0.7–1.3 分层,位于第 4/5 轨道间环带);8 条细淡轨道参考线;相机斜俯视 ~38°,海王星轨道约占画布宽 78%。

## 2. 自检清单(完成合同 §5)

- [x] 1. `npm run build` 于 `workspace/` 根执行,退出码 0(2 次,#1/#2,产物 dist/ 由 index.html 引用)
- [x] 2. 页面 10s 内 `window.__appReady === true`(实测 ~1s,verify-browser 三次会话均 true)
- [x] 3. `window.__bench = { getState(): object, reset(): void }` 契约成立(benchReady=true;getState 返回 spec stateContract 全部字段)
- [x] 4. 无未捕获异常(三次会话 consoleErrors=0、uncaught=[],覆盖加载/交互/变速/reset 全程)
- [x] 5. 探针自检:P1–P9 逐条(状态断言 + 截图/DOM/运动独立观测)全部通过(allPass=true)

## 3. 合规声明(逐条,Run 期间未访问/未执行)

- [x] §4.1 未访问另一 Arm(arm-b)的任何目录、代码、日志、server、profile、截图、结果
- [x] §4.2 未访问 `reference/`
- [x] §4.3 未访问本 Pair 本 Arm 之外的任何 `bench/results/` 目录与既往 trial
- [x] §4.4 未访问 `harness/` 源码与合同模板
- [x] §4.5 未访问 `bench/vendor/`、引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 树);唯一引擎读取面为**本 Arm workspace/dist/vendor/ 内**页面实际加载的引擎 bundle(白名单目录内,无 docs/examples)
- [x] §4.6 未访问 `bench/docs/` 实验计划与合同文档目录
- [x] §4.7 未访问 `secret/`
- [x] §4.8 无任何联网请求(无文档/搜索/registry 访问)
- [x] §4.9 未执行 `npm install`、未安装/改动任何依赖(含上层共享 node_modules,只读解析)
- [x] §4.10 未修改 brief.md / spec.json / RUN-CONTRACT.md / harness/validator/探针代码与结果文件
- [x] §4.11 未探测或篡改 harness/validator 行为与期望值
- [x] §4.12 未手改/伪造/删除/重置 `workspace/.budget/*.count`,所有构建与浏览器会话均经 count.mjs / verify-browser.mjs 计数
- [x] 冻结资产只读:assets/ 未修改(本场景 Asset Contract 为全程序化生成,未使用任何外部模型/贴图)
- [x] 无 Forbidden Shortcuts(spec §10 十条):非贴图冒充、非 DOM 位移冒充天体运动、状态与真实渲染/运动互证、非刚体同速旋转(14.4× 实测分层)、8x 真实加速(8× 实测)、小行星带 560 独立天体、信息卡点击驱动、空白点击不选中、reset 非刷新、未遮挡/缩放画布

## 4. 预算与环境事实(自报,诊断口径;判定以 .budget 机器计数为准)

| 项 | 用量 | 上限 |
|---|---|---|
| buildAttempt | 2 | 8 |
| browserAttempt | 3 | 6 |
| toolCall | ~48 | 120 |
| 墙钟 | ~26 min | 90 min |

- 引擎:cocosair.js@1.0.0-k0(import map → dist/vendor/cocosair.module.js,sha256=3ccfdde1…ced6,与共享 node_modules 逐字节一致)
- dev server:PORT=7132(node scripts/serve.mjs);验证视口 1280×720 headless Chrome
- 关键引擎坑位对策记录:Camera.visibility 显式 DEFAULT;ambient 于 app.run 后原位 set;材质 FLOAT4 一律 Color 实例;透明/加色混合经 Material.initialize `states`(blendState/depthStencilState/rasterizerState)实现(本 bundle builtin-unlit 仅单一 opaque technique);拾取监听挂 window 捕获阶段规避 pal 层吞事件;worldToScreen 为底左原点,上报前翻转为左上 CSS 比例
