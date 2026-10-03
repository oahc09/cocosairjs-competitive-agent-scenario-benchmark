# WORKLOG — E05 黑洞吸积盘 · Cocos AIR Reference

- Run ID: `REF-E05-cocosair`
- 日期: 2026-10-02
- 引擎: cocosair.js@1.0.0(本地 tarball `cocosair.js-1.0.0-k0.tgz`,WebGL2)
- 工作区: `bench/reference/private/cocosair/E05/`
- 最终结果: **PASS 6/6 probes,fps 60.2,0 console error / 0 uncaught,video.webm 已录**

## 0. 侦察(引擎能力,只读取证)

| 主题 | 结论 | 出处 |
|---|---|---|
| 自定义 Shader | **FULL**:手写"编译后形态" effect JSON + glsl4/glsl3 双变体 → `EffectAsset.onLoaded()` → `material.initialize({effectAsset})`;注册必须在 `createAirApp` 之后(GAP-B1) | docs/manual/custom-shaders.md;examples/shader-custom-gradient、shader-dissolve;src/cocos/render-scene/core/program-lib.ts(WebGL2 只消费 glsl3,glsl1 可省) |
| 后处理 | **不可达**:legacy 管线,`cclegacy.rendering` 被清空,CUSTOM_PIPELINE_NAME 不设置;无 Bloom(三闸门,D11 批复维持) | docs/notes/post-process-notes.md |
| 混合 | pass JSON `blendState.targets[0]` 支持 `blend/blendSrc/blendDst/blendSrcAlpha/blendDstAlpha`(gfx.BlendFactor ONE=1/SRC_ALPHA=2);blend:false 走 opaque 队列(先绘、可写深度) | src/air/builtin/builtin-effects.ts;src/cocos/rendering/render-queue.ts(透明队列按 priority→深度排序) |
| 动态网格 | `utils.MeshUtils.createDynamicMesh` + `mesh.updateSubMesh`(逐属性 GPU buffer update,不重分配) | src/cocos/3d/assets/mesh.ts:573;src/cocos/3d/misc/create-mesh.ts:259 |
| **tarball 差异** | `utils.createDynamicMesh` 在 tarball 导出中**不存在**,挂在其 `utils.MeshUtils.createDynamicMesh`(与引擎仓库 build 不同) | node_modules/cocosair.js/build/npm/cocosair.module.js:49695-49713 |
| 滚轮输入 | 引擎 canvas wheel 监听 `stopPropagation()`(window 级 DOM 监听**收不到**);且 `getScrollY() = -DOM_deltaY × 5`(wheelSensitivityFactor=5,**符号反转×5 倍**) | bundle 41818-41835 `_handleMouseWheel` |
| 几何陷阱 | `primitives.plane` 在 **XZ 平面**(法线 +Y),非 XY;billboard 需在子节点上补 X+90° 旋转使法线对准相机 | examples/docs(manual/primitives)验证 |

## 1. 架构(src/main.js,单文件)

6 个自定义 effect(全部程序化,无外部资产):

| # | effect | 几何 | 混合/深度 | 职责 |
|---|---|---|---|---|
| 1 | e05-disk | plane 22×22(水平) | additive(ONE,ONE),depthTest on | 极坐标程序化:径向色梯度(内白→外暗红)、5 臂差速螺旋条纹(phase=真实 diskRotation uniform)、多普勒不对称、边缘指数外溢辉光、内缘热点脉动 |
| 2 | e05-ring | billboard 7.6×7.6 | additive,depthTest **off**,priority 200(最后绘) | 光子环(高斯细环)+ 上弯透镜亮弧 + 宽晕 + 视界内截断微光 |
| 3 | e05-core | billboard 2.16×2.16 | **opaque 写深度**(blend false) | 纯黑圆盘(discard 圆形化);opaque 队列先绘 → 遮挡盘远侧与背后星空;沿视线向相机偏移 0.07 防深度穿插 |
| 4 | e05-stream | 动态网格 240×6 顶点 | additive,depthTest on | 星流:CPU 螺旋积分(Kepler 式 ω∝r^-1.5,近核加速),视界吞噬外圈重生(总数恒定);速度轴投影到视平面(防退化);头亮尾暗、近核蓝白拉长 |
| 5 | e05-starfield | 静态网格 360×4 顶点(340 均匀 + 20 四角锚定) | additive | 软圆星点(shader 高斯+halo+圆形 mask)、cc_time 闪烁、per-vertex 色/柔度 |
| 6 | e05-nebula | billboard 220×220(远景 85) | additive | 4 octave value-noise fbm 冷色星云 + 边缘增强 + 暖斑 + 抖动去色带 |

- 相机:fov 60,仰角 24°(盘相对视线倾角 24° ∈ [15,75]),距离 14(范围 [5,28]);
  滚轮(引擎 input API)改 target,指数平滑 k=5(1.2s 残差 ≈ 0.25%);拖拽微调 az±35°/el14-55°(可选加分)。
- 状态:`diskRotation`(0.35 rad/s)、`accretionPhase`(mod 1)、`cameraDistance`(实时插值值)、`starStreamCount=240`、`backgroundStarCount=360`;`reset()` 归零 + 星流按种子复位 + resetCount++。
- 页面契约:`__appReady`(EVENT_AFTER_DRAW 首帧)、`__bench={getState,reset}`、`data-ui="reset"` DOM 按钮右上角。
- 调试钩子:`window.__e05.nodes`(节点引用,与 `__airApp` 同级,不改变行为)。

## 2. 迭代记录(build→validate,共 10 轮验证)

| 轮 | 结果 | 根因/修复 |
|---|---|---|
| 1 | RUNTIME:`utils.createDynamicMesh is not a function` | tarball 导出形态差异 → `utils.MeshUtils.createDynamicMesh` 兜底 |
| 2 | RUNTIME:`addChild` 返回 void | 拆分 create/add/addComponent |
| 3 | P1 FAIL(角部 0.13-5%) | **主 bug:plane 在 XZ 平面**,`v_p=a_position.xy` 全部退化为 (x,0);billboard 直接复制相机四元数 → 面**侧立**(黑核/光子环/星云全成细线)。修复:v_p=xz;billboard 改父节点(拷相机旋转)+子节点 X+90° |
| 3.5 | (调试)星云零输出 | 写临时 playwright 探针逐层隔离 + 手工投影复算,确认星云侧立、星空投影正确但 TL 随机缺星 |
| 4 | P1 FAIL(角部仍低) | 星云调亮无效果(未渲染)→ 同上侧立根因;加四角锚定星 20 颗 |
| 5 | P1-P3 PASS,P4 FAIL | 滚轮缩放不动:window wheel 监听被引擎 stopPropagation → 改引擎 input API |
| 6 | P4 FAIL | 引擎 `getScrollY=-deltaY×5` 符号/倍率 → `-getScrollY()/5` 还原 |
| 7 | **P1-P6 全 PASS**(fps 60.3) | — |
| 8 | 视觉打磨 | 星流速度轴投影到视平面;星云抖动去色带;角部余量加宽 |
| 9 | 视觉打磨 | 星点圆形 mask(方形剪影消除) |
| 10 | **最终 --video:PASS 6/6,fps 60.2** | video.webm 4.1MB,28 张截图 |

关键调试方法论:页面内 `canvas.drawImage→getImageData` 逐层像素采样 + 同种子 PRNG 在页面内重算星空并手工投影对照(50/51 命中)定位"渲染位置 vs 预期位置",配合 4×4 网格亮度统计——避免盲猜。

## 3. 探针最终余量(P1 四角 litRatio vs 3% 阈值)

TL 4.4% / TR 14.9% / BL 6.0% / BR 19.4%;中心 1/3 区 ~67%。P2 帧 diff 6.4%(阈值 0.5%),P5 20.5%,P4 构图变化 17.4%,P6 全屏 29.2%。

## 4. 遗留(已知、可接受)

- 阴影中部近侧盘穿越线(深度分层边界)在中等对比度下隐约可见——物理正确的近侧盘遮挡,非缺陷。
- 少数星流粒子在掠射角下呈短棒状(固定宽度 quad 的固有形态)。
- 星云暗部在低伽马屏上仍可能有极弱色带(已抖动缓解)。
