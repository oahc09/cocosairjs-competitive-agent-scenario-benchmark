# WORKLOG — E09 珠宝展示台 · Three.js r186 Reference(REF-E09-three)

- 场景:E09 珠宝展示台(Material Ceiling)
- 引擎:three@0.186.1(r186,vendored,esbuild external + importmap)
- 工作区:`bench/reference/private/three/E09/`
- 日期:2026-10-02
- 最终结论:**PASS(8/8 probes,fps 60.2,下载事件 x2 均约 596KB)**

## 0. 开工输入

- 读 MASTER-CONTEXT.md §5/§10/§12(统一契约)、briefs/E09/brief.md + spec.json(冻结版)。
- 侦察 harness:validate.mjs(14 步管线)、probe-executor.mjs(动作词表/ui 选择器/
  视觉断言四类)、browser.mjs(download 事件收集、fps rAF 采样)。
- 关键确认:
  - `click:ui=X` 定位 `[data-ui=X], [data-bench=X]` → 控件同时挂两个属性。
  - P6/P7 独立观测 = playwright `page.on('download')` + 保存文件量测字节数。
  - launch-config:Chrome headless + ANGLE D3D11(RTX 4060)→ transmission/dispersion
    性能无虞。
  - r186 弃用:`THREE.Clock`(r183 起,用 `THREE.Timer` 或 performance.now)、
    `PCFSoftShadowMap`(r186 起,用 `PCFShadowMap`)。实现全部规避,零弃用告警。
  - 共享资产 gem.glb(7112B,78 三角切面,sha256 与 spec 一致)拷入工作区 `assets/`。

## 1. 实现结构(src/main.js,~530 行)

| 模块 | 要点 |
|---|---|
| 渲染器 | WebGLRenderer + ACESFilmic(曝光 1.22)+ PCFShadowMap;EffectComposer:RenderPass → UnrealBloomPass(阈值 1.0,HDR 域只对超亮源溢光)→ OutputPass |
| 环境(自制,计入产物) | `buildStudioEnvScene()`:暗房内 8 组发光平面(MeshBasicMaterial 颜色分量 >1,HDR 峰值 25)→ `PMREMGenerator.fromScene` 半浮点立方环境;另画 LDR equirect 暗色画布作 `scene.background`;宝石正后方 46×23 实体发光幕(折射内容物) |
| 宝石 | GLTFLoader 加载 gem.glb(失败回退 Icosahedron 80 面几何);归一化到宽 1.9;`MeshPhysicalMaterial{transmission:1, ior:2.2, dispersion:0.62, thickness:1.15, attenuationColor/Distance 按色, flatShading, clearcoat 0.5}`;内部 42% 缩放同形金属核心(内部切面光影) |
| 布光 | 三点棚拍:键光暖白 SpotLight(520,投影 2048)+ 辅光冷色 Directional(0.7)+ 轮廓光双 SpotLight(1500/1000,后上方);+ HDR 环境 = 环境项;共 ≤10 光源项 ✓ |
| 舞台 | 暗色微反射地面 + 接触阴影贴片 + 深色圆台(香槟金 Torus 亮边)+ 转台盘(16 金点刻度,肉眼可辨旋转)+ 随主色变化的假焦散光池(Additive) |
| 交互 | 转台 32°/s(rotationAngle 单调累计);色板 5 色(data-bench=swatch-1..5);dblclick → 沿视线真实 dolly 10↔5.2(950ms easeInOutCubic,期间挂起 OrbitControls);OrbitControls 拖拽环绕(观察加分项,不参与探针) |
| 导出 | 同帧 `composer.render()` → `canvas.toBlob` → `<a download>` 真实点击下载;文件名带时间戳+序号;exportCount 仅在 blob 成功后 +1 |
| 状态 | `getState()`:{engine,ready,frame,fps,rotationAngle,selectedColor,cameraDistance,exportCount,resetCount};`reset()` 不刷新页面 |

## 2. 迭代记录(构建+验证循环,全部留档于 validation/)

| 轮 | run-id | 探针 | fps | 视觉评估与改动 |
|---|---|---|---|---|
| R1 | REF-E09-three-R1 | 8/8 PASS | 60.2 | 首版即全绿(行为链一次到位)。但宝石呈暗色剪影:LDR 柔和径向渐变环境 → 切面高光弱、无折射内容物 |
| R2 | REF-E09-three-R2 | 8/8 PASS | 60.3 | 环境改高对比柔光箱 + 宝石正后方加实体发光幕(折射内容)+ 提升 key/rim 强度 + attenuationDistance 1.05→2.4。宝石出切面但仍「奶白/月长石」感 |
| R3 | REF-E09-three-R3 | 8/8 PASS | 60.1 | 柔光箱改硬边矩形(canvas 溢光)+ 发光幕对比度收紧 + 内核缩至 46%。切面黑白对比出现,冠部仍灰 |
| R4 | REF-E09-three-R4 | 8/8 PASS | 60 | 点光源增加至 9、幕更小更暗、内核 42%。AI 视觉评审:仍 waxy,要求 HDR 闪点/勾边/减吸收 |
| R5 | REF-E09-three-R5 | 8/8 PASS | 60.2 | **材质链大改**:canvas LDR 环境 → 真实小场景(HDR 发光平面,峰值 25)PMREM;双轮廓光;假焦散光池;UnrealBloom(阈值 1.0);thickness 1.15;att 按色分参(diamond 8) |
| R6 | REF-E09-three-R6 | 8/8 PASS | 60.2 | 环境房底色 0.055 + 发光幕增亮(远景宝石呈暗剪影问题)。远景恢复「亮晶体」观感,红宝石色态确认 |
| R7 | REF-E09-three-R7 | 8/8 PASS | 60.2 | dispersion 0.5→0.62(折射亮边彩虹条纹增强)。定稿 |
| 终 | REF-E09-three(--video)| 8/8 PASS | 60.2 | 最终留档:video.webm 4.8MB,35 张截图,downloads 596157/596865 字节 |

合计:9 次 validate(含最终 --video),8 个实现版本,0 次构建失败。

## 3. 探针证据摘要(最终轮)

| 探针 | 断言要点 | 结果 |
|---|---|---|
| P1 | 初始态 diamond/10/0 | PASS,nonBlank lit 0.883(阈 0.08) |
| P2 | 2s 内 rotationAngle≥50(实测 309.85°) | PASS,regionChange diff 0.324(阈 0.01) |
| P3 | swatch-2 → ruby | PASS,diff 0.129 |
| P4 | dblclick → cameraDistance≤6(实测 5.2) | PASS,diff 0.201 |
| P5 | 再 dblclick → ≥9(实测 10) | PASS,diff 0.042 |
| P6 | export-png → exportCount==1 + download 596157B | PASS,lit 0.778 |
| P7 | 再导出 → ==2 + download 596865B + 转台仍运转 | PASS,motion diff 0.125 |
| P8 | reset → diamond/10/0,resetCount 1 | PASS,diff 0.325(高光仍流动) |

- console:0 error / 0 uncaught / 1 warning(D3D 着色器 info-log X4122,驱动级精度提示,非应用问题)。
- ready:appReady=true,benchReady=true(4261ms,含 GLB 加载)。
- S1:buildPass / readyNoError / firstShotNonBlank(litRatio 0.84)全真;S2 8/8;S3 生命周期 + fps 达标。

## 4. 红线自查

- 未伪造状态:rotationAngle/cameraDistance/exportCount 全部来自真实渲染循环与真实下载回调。
- 导出为真实下载事件(harness downloads 数组两条约 596KB 文件为独立观测)。
- 双击推近为相机位置沿视线 dolly(非视口缩放/DOM 变换),cameraDistance 每帧取真实距离。
- reset 为原地状态恢复,无 location 刷新。
- spec/harness 未改动;产物只写工作区(reference/private/three/E09/)。
