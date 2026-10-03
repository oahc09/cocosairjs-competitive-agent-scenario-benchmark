# WORKLOG — E06 荒野篝火营地 · Cocos AIR Reference

- 最终结果:**PASS 6/6 probes,fps 60.1,0 console error / 0 uncaught,video.webm 已录**
- runId:REF-E06-cocosair;spec briefs/E06/spec.json(冻结版,未改动)
- 日期:2026-10-02

## 0. 侦察(引擎能力,只读取证)

| 能力 | 结论 | 证据 |
|---|---|---|
| PointLight 动态点光 | **可用且逐帧可动画**:组件 setter 写穿到 render-scene 光源(激活后 `_light` 存在);forward 管线经 `RenderAdditiveLightQueue` 多 pass 逐模型绑 `cc_lightPos/cc_lightColor` UBO | src/cocos/3d/lights/point-light-component.ts;src/cocos/rendering/render-additive-light-queue.ts(LIGHT_TYPE.POINT 分支);examples/light-point(luminance 24000 / range 8 实证) |
| 点光阴影 | **不支持**(引擎明示"目前还不支持生成阴影") | src/cocos/render-scene/scene/point-light.ts 类注释 |
| 光颜色传递 | 组件 `color` 赋值即克隆并下推;激活时 `_createLight` 会同步一次 `this.color = this._color` → run 前赋值有效 | src/cocos/3d/lights/light-component.ts |
| 环境光插值 | `scene.globals.ambient.skyColorHDR` 原位 `.set()` + `skyIllum` setter(E05 已验证路径)逐帧可变 | src/cocos/render-scene/scene/ambient.ts |
| clearColor 逐帧 | 必须**赋值**(`camera.clearColor = c`),getter 返回内引用但只有 setter 会下推渲染相机;原地改不生效 | src/cocos/misc/camera-component.ts |
| Quaternion | 模块导出名是 **`Quat`**(静态方法风格:`Quat.fromAxisAngle(out, axis, rad)`);`Quaternion` 是物理(cannon)内部类,`quat()` 工厂返回的对象没有实例方法(本轮踩坑 ×2) | tarball export 列表;bundle 10203/10311 行 |
| 非索引几何 | `utils.createMesh` 无 indices 亦可(triangle list 顶点直出)→ 低多边形 flat shading 用逐面法线非索引三角形 | src/cocos/3d/misc/create-mesh.ts |
| primitives | box/cone/cylinder/plane/quad(XY 朝 +Z)/sphere/torus/circle(XY!TRIANGLE_FAN)齐备;cone=cylinder(0,r,h) | src/cocos/primitive/* |

## 1. 架构(src/main.js,单文件 ~1030 行)

- **地形**:径向环 + 非索引三角形逐面法线(flat shading);高度函数 `terrainHeight(r,a)` 与树摆放共用(树落地)。营地平坦、外围起伏、远缘抬升成碗形谷地。
- **树环**:16 棵 = 7 棱柱树干 + 双层 7 棱锥树冠,环形散布(半径 6.4–9.6,与相机轨道 12.8 保持距离避免近景巨树挡画面);builtin-standard 受光材质(5 种冠色 + 2 种干色)。
- **篝火**:9 石圈 + 5 根轴角四元数斜倚柴 + 2 坐柴 + 焦土盘;火苗 = 双层相机 billboard(域扭曲 fbm 火焰 shader)+ 光晕 billboard(additive 径向衰减)。
- **粒子**:火苗 lick(32)+ 火星(60)+ 萤火虫(20)+ 烟(12)→ 单 `createDynamicMesh` + 每帧 `updateSubMesh`(pos+uv+color),1 draw call,additive,片元软圆衰减。
- **动态火光**:真实 PointLight(range 13,暖橙),`luminance = fireLightIntensity × 30000` 逐帧驱动(0.43/1.9/4.6 Hz 多频混合,基准 0.55,幅度 ~0.14),位置微抖;**画面与 getState 同源**。
- **日夜**:`timeOfDay` 线性 3.2 s 渐变,视觉 smoothstep 映射:天穹 shader(渐变+八面体星点+银河带+月/日+晨昏暖带,`dayF` uniform)、环境光(skyIllum 3800→23000)、主光(1900→50000 lux,月色→日色)、clearColor、星空/萤火虫可见度联动。
- **相机**:自动环绕 0.24 rad/s,俯角 0.365 rad,暂停/恢复;拖拽微调(水平并入 orbitAngle、垂直俯仰偏移,状态真实)。
- **UI**:右上角 data-ui=day-night / orbit-toggle / reset + 状态文本(夜/昼 · 环绕:开/关)。

## 2. 迭代记录(build→validate,共 5 轮 validate)

| 轮 | 结果 | 修复 |
|---|---|---|
| 1 | FAIL RUNTIME(appReady=false) | `import { Quaternion }` 不存在 → 改 `Quat` |
| 2 | FAIL RUNTIME | `quat()` 工厂实例无 `setFromAxisAngle` → `Quat.fromAxisAngle(out,axis,rad)` 静态用法 |
| 3 | **PASS 6/6**(fps 60.1) | — |
| 4 | PASS 6/6(视觉调优) | 夜景过暗:ambient 1500→3800、月光 850→1900;火池过曝:fireLumMax 46000→30000、光位 y 0.85→1.05、range 12→13;巨树挡画面:树环上限 10.8→9.6;萤火虫增亮(size×1.3、亮度曲线 pow 3.2→2.6) |
| 5 | **最终 --video:PASS 6/6,fps 60.1** | 光晕微降(0.45+0.5·fi);video.webm 归档 |

## 3. 探针最终余量(阈值 vs 实测)

| 探针 | 判据 | 阈值 | 实测 |
|---|---|---|---|
| P1 nonBlank | full / center-bottom litRatio | ≥0.03 | 0.168 / 0.059 |
| P2 pixelDelta | 全帧两帧差(600ms) | ≥0.01 | 0.369 |
| P3 regionChange | 全帧差(500ms,日间) | ≥0.01 | 0.408;timeOfDay 0→1.000 |
| P4 motion | 全帧差(500ms,环绕) | ≥0.005 | 0.597;角速度实测 0.24 rad/s |
| P5 pixelDelta | 冻结前后帧差 | ≥0.01 | 0.419;orbitEnabled=false 后角度冻结 |
| P6 regionChange | 夜间回归帧差 | ≥0.01 | 0.253;reset 后 t=0、angle 0.24(<0.6) |

状态证据(P1→P6 采样):fireLightIntensity 波动样本 0.442/0.510/0.501/0.439/0.482/0.656/0.530/0.633/0.644/0.643/0.607(两采样差远超 0.02);emberAlive 恒 60(≥40 峰值合同);fireflyCount 20;treeCount 16。

## 4. 遗留(已知、可接受)

- 点光无阴影(引擎不支持,spec 明示不要求;阴影为可选加分项未达成,如实记录于 ceiling-notes)。
- 火焰辉光为本地 billboard 近似,无全屏 bloom(Code First 管线无后处理,E05 已定论)。
- 低多边形树锥/柱为引擎 primitives(7 棱),未做逐面法线重排(侧面平滑法线)——低多边形观感成立,极端近景侧面微显平滑。
