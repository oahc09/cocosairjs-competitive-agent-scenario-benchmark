# E10 REFERENCE-VERDICT — Cocos AIR

- runId: `REF-E10-cocosair`(最终轮,含 video)
- 日期: 2026-10-02
- 工作区: `bench/reference/private/cocosair/E10/`
- 证据: `validation/report.json` + `validation/probe-results.json` + `validation/screenshots/` + `validation/video.webm` + `validation/network.json`

## 1. Verdict

| 项 | 值 |
|---|---|
| **verdict** | **FEASIBLE** |
| classification | PASS |
| probes | **7/7 PASS**(P1 nonBlank / P2 motion / P3 隔离切换 regionChange / P4 销毁 regionChange / P5 存活 motion / P6 reset nonBlank+network / P7 恢复+fps) |
| fps | **60.2**(阈值 ≥30;三次全绿轮分别 60 / 60 / 60.2) |
| console | errors 0 · warnings 0 · uncaught 0 |
| ready | `__appReady=true` @2.0s(阈值 10s) |
| build | `npm run build` 退出码 0(1.8s;4/4 次全成功) |
| 网络 | 全会话 5 请求;`assets/character.glb` **恰 1 次**(200;162852B;sha256=d97044e7…与 spec 冻结值一致) |
| 迭代 | 3 轮修复 + 1 轮终验(见 WORKLOG §2) |

**结论:E10 全部完成合同(含生命周期链与独立观测)在 Cocos AIR 1.0.0 原生 API 内可完整达成,无需任何 ENGINE_LIMITED 降级。**

## 2. 行为项核对(spec.scoring.behaviorItems,11 项)

| # | 行为项 | 证据 |
|---|---|---|
| 1 | runtime 加载 character.glb(请求可观测,assetLoaded=true) | network.json 1×200;P1 state ok |
| 2 | 双实例同屏,站位分离,完整渲染 GLB 网格与材质 | initial.png / P1(对称双狐,贴图正确) |
| 3 | 双实例动画播放中(time 推进+骨骼运动) | P2 state(time>0)+ motion 0.110(阈值 0.005) |
| 4 | A 切 Walk 仅 A 变,B 保持 Idle | P3 state(A=walk,B=idle)+ A 区 regionChange |
| 5 | B 切换同样不影响 A(双向隔离) | 引擎逐实例 Animation 组件(model-character-interaction 已验证独立时钟);UI 双向可切(录屏可见) |
| 6 | 销毁 A:instanceCount=1、instances.A=null、画面移除 | P4 state + before/after 像素 diff 15.2%(狐与接触阴影同失) |
| 7 | 销毁后 B 动画继续,帧率不降无异常 | P5 state(time>0)+ motion 0.084;fps 60 |
| 8 | reset 恢复双实例 Idle,resetCount=1,无新请求无刷新 | P6 state + network(仍 1 次 glb)+ P6 双区 nonBlank 0.54 |
| 9 | 材质正确(无缺省色/白模/串扰) | 截图:狐毛橙白分区正确,双实例同材质无串扰 |
| 10 | 三点灯光+地面明暗过渡 | 键/补/逆 3 盏+环境光;地面暖光池+接触阴影+暗角 |
| 11 | 相机中景平视、双实例完整入画、构图稳定 | ±7° 恒速环绕,双狐恒在断言区与取景框内 |

## 3. 客观分估算(harness 口径)

- S1 可运行:15/15(build ✓、ready 无错 ✓、首帧 nonBlank litRatio 0.548 ✓)
- S2 行为:30 × (7/7 权重通过) = 30/30
- S3 生命周期/性能:10/10(lifecycle 探针 P6 PASS;fps 60.2 ≥ 30)
- S4 代码健康:自评 4.5/5(单文件 ~530 行,模块分区注释,坑位文档化,无死代码;扣 0.5:魔法数散落于调参处)
- Visual 六维:15.5/18 → 34/40(明细见 ceiling-notes.md)
- **EngineCeilingComparableScore ≈ 93.5/100**(由 visual judge 官方复核为准)

## 4. 风险与复现注意

- P4 类 regionChange 探针的语义是"动作后区域仍在变化"——依赖场景有持续运动源(本实现以恒速相机环绕+高细节地面保证;agent 若用完全静止相机会在此翻车,值得在 K 包提示中体现)
- 无 sRGB 画布纹理会显著变暗:程序化贴图必须画亮补偿(本实现地面基色画到 ~#98 才得到中灰观感)
- `AnimationClip.wrapMode` 必须 Loop,否则剪辑播完冻结、motion 类探针全灭
