# E08 — Cocos AIR Reference ceiling-notes

六维自评(0–3,Reference 实现者口径;供盲评对照与 Engine Ceiling 分析)。

## 六维自评

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 2.5 | 相机(0,2.2,24)/fov55 覆盖整个活动水域,鱼群由弱洋流回中力始终居中;前景颗粒-中景鱼群-远景光柱/渐变/海床三层纵深。扣分:下部海床区在无鱼时略显空 |
| 材质光影 | 2.5 | 标准 PBR 鱼(金属度 0.6/粗糙 0.38)+ 顶点色反荫蔽 + 微自发光提剪影;顶光 62000 + 环境光;EXP2 雾做深度衰减。扣分:无阴影交付、无 HDRI(引擎短板),鱼在高背光角仍偏暗 |
| 动效流畅 | 3.0 | 60fps 实测(110 鱼 + 340 颗粒逐帧重写顶点);摆尾正弦弯曲(位置+法线)、转弯侧倾、速度调制摆频、光柱缓摆、光晕呼吸全部平滑 |
| 特效质感 | 2.5 | 加法混合光柱(程序化渐变贴图+顶端软收边)、柔光颗粒、食物光晕;点击涟漪。扣分:无后处理链(无 Bloom/GodRay pass),体积光是面片近似而非真体积 |
| 交互反馈 | 3.0 | 拖拽扫过即炸开(急转+加速可辨)、滞回重聚可见回漩、单击投喂闭环、HUD 实时状态、涟漪微光;全部即时且与状态字段同步 |
| 整体完成度 | 3.0 | 完成合同全绿:build/ready/state/无异常/8 探针/60fps/reset/固定种子复现;120s 长跑无计数增长(定长数组+节点池) |
| **合计** | **16.5/18** | visual ≈ round(16.5×40/18) = **37/40** |

## 已验证能力清单(E08 范围内,AIR 实测)

1. **动态网格每帧顶点重写**:`utils.MeshUtils.createDynamicMesh(primitiveIndex, IDynamicGeometry, undefined, {maxSubMeshes,maxSubMeshVertices,maxSubMeshIndices})` + `mesh.updateSubMesh(i, geom)`;110 鱼(4950 顶点,positions+normals+colors)+ 340 billboard(1360 顶点,+uvs)同帧重写 @60fps,单 submesh 单 draw call;`minPos/maxPos` 每帧随传可更新包围盒
2. **无 InstancedMesh 的群体渲染替代路径**:整群 CPU 烘焙进一个 dynamic mesh(胜过多节点共享网格:零场景图开销)
3. **顶点色作逐实体着色通道**:builtin-standard 与 builtin-unlit 均支持 `defines: { USE_VERTEX_COLOR: true }`(a_color RGBA32F)
4. **程序化贴图**:`new ImageAsset({width,height,_data: Uint8Array RGBA8888,_compressed:false,format})` → `new Texture2D(); tex.image = image` → `setProperty('mainTexture', tex)`
5. **材质管线状态**:`Material.initialize({effectName, defines, states})` 里 `states.blendState.targets=[gfx.BlendTarget(...)]`(加法/alpha)、`depthStencilState`(noDepthWrite)、`rasterizerState`(cullNone)经 `Pass.fillPipelineInfo` 正确落地(WebGL2 实测)
6. **画布输入**:`input.on(Input.EventType.MOUSE_MOVE/MOUSE_DOWN/MOUSE_UP/MOUSE_LEAVE/TOUCH_*)`;鼠标输入同时合成 TOUCH 事件(需自去重);`event.getLocation(out)` 返回**左下原点**坐标
7. **屏幕拾取**:`Camera`(组件)`.screenPointToRay(x, y, out)` → 指针射线;与 getLocation 坐标系直接兼容
8. **全局面**:`scene.globals.ambient.skyColorHDR.set(...)`/`skyIllum`;`scene.globals.fog`(enabled 必须先于 type,EXP2=2,fogColor/fogDensity),对 standard/unlit 均生效
9. **仿真规模**:O(n²) boids(110)+ 全群网格重建在浏览器主线程 60fps 余量充足(单帧 JS 侧 <2ms 量级)

## 引擎坑位与缺口(Agent 需要的知识)

1. **`primitives.quad()` 忽略 width/height 选项**(恒 1×1,源码硬编码 ±0.5)——必须 `node.setScale` 放大;plane/sphere/box 正常接受尺寸参数
2. **`primitives.plane()` 生成的就是水平面**(XZ 平面,法线 +y)——再 `setRotationFromEuler(-90,…)` 会变成背对相机的竖直面(默认 cull BACK 下直接消失)
3. **`getLocation(out)` 的 out 必须是真 `Vec2` 实例**——普通对象触发 `out.set is not a function`,且该异常会**毒化引擎事件分发器,此后整页输入永久失灵**(input._emitEvent → catch → _clearEvents + onThrowException + rethrow)。输入回调必须自带 try/catch
4. **quad uv 方向**:uv v=1 在顶点 +y(画面上方),采样图像**末行**——写垂直渐变贴图时"图像末行=视觉顶部"
5. `Material.setProperty('mainColor', …)` 需要**引擎 Color 实例**(普通对象触发 FLOAT4 断言);`roughness/metallic/emissive` 为标量/颜色属性可直接设
6. Camera 组件 `screenPointToRay(x, y, out?)` 与 render-scene 相机 `(out, x, y)` **参数序不同**;`Node.getComponent('MeshRenderer')` 字符串查不到(传类)
7. **无后处理/无 Bloom/无真体积光**:体积光感只能用加法混合面片 + 雾近似(本场景已验证可行且好看)
8. **无 InstancedMesh**:大规模同形体优先考虑"单动态网格整群烘焙"路径
9. 雾 `fog.enabled=true` 必须在 `fog.type=` 之前(否则 type 被写成 NONE)

## 对 Agent Attainment 的建议基线

- 本 Reference 无引擎级不可逾越障碍;预期 K0/K1 Agent 主要翻车点:坑位 1/2/3(静态面片不显示、输入毒化)、`createDynamicMesh` 的 options 容量断言(顶点数超 maxSubMeshVertices 直接 assert)、以及双源真状态字段(建议 getState 直接读模拟单源)
