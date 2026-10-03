# E02 Reference WORKLOG — Cocos AIR(trusted)

- 场景:E02 落日海面与孤舟(Asset Driven)
- 引擎:cocosair.js 1.0.0(K0 tarball,vendored,import map 加载 `/dist/vendor/cocosair.module.js`)
- 工作区:`bench/reference/private/cocosair/E02/`
- 实现者:Reference(trusted,可读引擎源码与 docs)
- 日期:2026-10-02

## 0. 资产

- `assets/boat.glb` ← `bench/assets/boat.glb`(sha256 ed22ff2f…,29132 字节)。
- 资产实测结构:6 节点(Hull/Deck/KeelAndRudder/Rigging/MainSail/Jib)+ 根节点 Boat;6 个 PBR 纯色材质(木色船身/浅木甲板/红饰条/深色桅杆/主帆布/前帆布,帆 doubleSided);包围盒 x[-0.43,0.43] y[-0.76,2.35] z[-1.32,1.20](最长边 3.11,Y-up,满足契约 1–4 单位)。

## 1. 技术方案(引擎正统路径核对)

| 需求 | 采用路径 | 依据 |
|---|---|---|
| GLB 运行时加载 | `new GLTFLoader().loadAsync(url)` → `asset.instantiate()` → `scene.addChild(instance.root)` | examples/gltf-basic、gltf-viewer |
| 动态海面 | 手写 IGeometry(非均匀 110×110 网格,12321 顶点)→ `utils.createMesh` + **自定义 EffectAsset 顶点位移**(3 波分量正弦叠加,解析法线) | docs/manual/custom-buffergeometry.md:"AIR 未暴露就地改写顶点缓冲 API" → 重建 mesh/帧 不可取,shader 通道为正典;examples/shader-custom-gradient + examples/shared/shader-blocks.js |
| 自定义着色器 | EffectAsset 三变体(glsl4/3/1,glsl3 由 glsl4 正则去 layout 生成)+ Constants UBO(set1 binding0,stageFlags VERTEX\|FRAGMENT=17)+ `setSharedMaterial` 后以 `renderer.material` 读回实例做运行期 `setProperty` | examples/shader-custom-gradient(G4 正式交付路径,"readback 实例化教训") |
| 天空 | `primitives.sphere(420,{segments:48})` 天穹 + 方向渐变/日月光盘(smoothstep 边缘)/光晕着色器,depthWrite=false | 同上 |
| 船体光照 | DirectionalLight(color/illuminance 随 toneMix 插值)+ `scene.globals.ambient.skyColorHDR.set()/skyIllum`(app.run 后,模板已验证路径) | hello-cube、render-composite |
| 相机环绕 | 引擎 `input.on(Input.EventType.TOUCH_*)`(鼠标也路由到 TOUCH_*) | examples/input 拖拽范式 |
| 船体随波 | JS 侧以与 GLSL **完全相同**的波形函数/参数采样 `waveHeight(0,0,t)` 驱动 y + 解析坡度驱动纵摇/横摇 | 相位耦合契约(brief §8) |
| reset 释放并重建 | `instance.dispose()` + `asset.destroy()`;海/天 `node.destroy()` + `mesh.destroy()`(GPU 缓冲)+ `material.destroy()`;随后重建网格/材质并带 `?reset=N` 查询串**强制真实网络重载** | gltf-basic §25 lifecycle、mesh-lifecycle-ops(destroyRenderingMesh) |

## 2. 已知坑(模板提示 + 本轮新发现)

1. `camera.visibility = Layers.Enum.DEFAULT` 显式设置(引擎默认 undefined)——照做。
2. 环境光 app.run 后经 `scene.globals.ambient.skyColorHDR.set()`(原位 Vec4)+ `skyIllum`(HDR 量级)——照做,每帧插值更新无问题。
3. **新发现(关键):引擎 pal 层吞掉 canvas 鼠标事件**——`src/pal/input/web/mouse-input.js` 的 `_createCallback` 对 mousedown/mousemove/mouseup 调用 `mouseEvent.stopPropagation()`。DOM 层 `window.addEventListener('mousemove')` 收不到拖拽事件,必须走引擎 `input.on(Input.EventType.TOUCH_*)`。首轮 P4 失败根因。
4. **EffectAsset.onLoaded()/register 必须在 createAirApp 之后**(GAP-B1,shader-custom-gradient 注记)——顺序:createAirApp → registerEffect → Material.initialize。
5. 运行期 uniform 一律走 `renderer.material` 读回实例(直接改 initialize 时传入的 Material 可能不生效,正典教训)。
6. `boat.glb` 为普通 glTF-Binary 无压缩——无需 decoder,loadAsync 直接可用(已验证)。
7. 方位角几何:相机立于 az 35° → 视线 az 215°;太阳要出现在画面右侧需 az **小于**视线 az(215-203=12° 偏右),首版 az 222 实测落在左侧(像素扫描定位太阳 (528,98) 证实),已修正。

## 3. 迭代记录

| 轮 | 变更 | validate 结果 |
|---|---|---|
| R1 | 初版实现(自定义双 effect、非均匀海面网格、GLB 加载、DOM 鼠标拖拽、toneMix、reset) | build OK;P1/P2/P3 PASS,P4 FAIL(拖拽无效:cameraAzimuth 恒 35),P5-P7 级联 SKIPPED;console 0 错;fps 60.2 |
| 诊断 | playwright 探针 + 引擎源码定位:pal 层 stopPropagation 吞事件;另发现端口冲突(5174/7405 被其它会话占用),换 7533 | — |
| R2 | 相机输入改引擎 `input.on(TOUCH_*)`;太阳方位 222→203(右移);海平线上移(lookY 1.0→0.85, el 9→10.5);glow 加宽(disc 光晕 pow 70→55, str 0.7→0.85);主光仰角 -24→-30;环境光 16k→20k | **PASS 7/7**,fps 60.1 |
| 加测 | 压力:连续 4 次快速 reset(epoch4/assetRequests5 无错);过渡中途反向切换 toneMix 正确;12+8 次 reset 后 post-GC JS 堆 31→34MB 平台(**无泄漏**) | — |
| R3(final) | 太阳仰角 6.5°→4°(贴近海平线、拉长高光带);冷色板整体提亮约 +25%(防暮蓝过暗) | **PASS 7/7 + video**,fps 60.3 |

构建次数 4(实现 1 + 修复 1 + 调优 2);validate 全流程 3 轮(2 FAIL→PASS 中断 1 轮 + final);浏览器会话:validate 3 + 调试探针 5。

## 4. 最终验证证据(run-id REF-E02-cocosair,--video)

- verdict **PASS** / classification **PASS**;probes **7/7**(passRate 1.0)
- fps **60.3**(spec min 30;空闲+交互全程 2s 滚动平均)
- console:errors 0 / warnings 0 / uncaught 0
- 网络:`/assets/boat.glb`(200) + `/assets/boat.glb?reset=1`(200) + `?reset=2`(200)——首载纯净 URL,重建真实重请求
- 产物:28 张截图 + video.webm(4.1MB)+ report/probe-results/console/network/perf JSON
- 像素质检:暖端全帧均值 RGB≈(141,85,59) R≫B;冷端≈(24,42,87) B≫R;reset 后 final.png 与 initial.png 太阳位置逐像素一致(824,116);P2 海面运动像素比率 0.95;P3 船体区域运动 0.74;P1 nonBlank litRatio 0.85

## 5. 残留事项 / 诚实声明

- 海面为风格化着色(自定义 unlit 通道:Fresnel/高光带/雾化),未走 PBR 光照管线——自定义 effect 无 chunk 系统,引擎内建光照不可注入自定义 shader;视觉达成但非物理渲染。
- EffectAsset(program 注册)在 reset 时保留复用(destroy 后重复注册未验证),"释放并重建"覆盖 mesh/material/instance/asset 等 GPU 与场景资源,program 属进程级代码资源。
- glsl1 变体按 examples 范式书写但本环境(WebGL2→glsl3)未实际编译执行过。
- 环境 GPU 为本机 RTX 4060(launch-config ANGLE D3D11),headless Chrome 真硬件加速;SwiftShader 环境下的 fps 未测。
