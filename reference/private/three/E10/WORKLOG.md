# E10 Three.js Reference — WORKLOG

- 日期:2026-10-02
- 工作区:`bench/reference/private/three/E10/`
- 引擎:three@0.186.1(vendored,esbuild external,GLTFLoader + SkeletonUtils 走 `three/addons/`)
- 资产:`assets/character.glb`(Khronos Fox,sha256 `d97044e7…771f7` 与 spec 冻结值一致;1 skin / 24 joints / 1 mesh / clips Survey·Walk·Run / 内嵌 PNG 贴图,自包含无外链)

## 前置侦察(实现前)

1. 读 MASTER-CONTEXT.md、briefs/E10/brief.md、spec.json(7 探针 P1–P7、stateContract、visualAssertion 阈值)。
2. 读 harness 三件套(validate.mjs / probe-executor.mjs / browser.mjs),确认:
   - `click:ui=<name>` 经 `[data-ui=…],[data-bench=…]` 定位,元素必须可见且有 bounding box(playwright click);
   - P7 断言 `$.fps >= 30` → getState 必须暴露滚动 fps(brief §6:最近 60 帧平均);
   - 视觉断言阈值:nonBlank≥0.10 / motion≥0.005 / regionChange≥0.01,区域为归一化矩形 A={0.08,0.15,0.34,0.8}、B={0.58,0.15,0.34,0.8};
   - 浏览器为真机 GPU(ANGLE D3D11 / RTX 4060),fps 压力小。
3. 离线解析 GLB 二进制,发现**关键陷阱**:Survey/Walk 剪辑带根位移(b_Hip_01 平移轨道漂移 1.7–2.3 单位)→ 不处理则角色会走出画面/展台。对策:冻结漂移 >0.02 的 position 轨道为首帧值(原地化),旋转轨道全保留。
4. 确认 vendored 引擎 API:`SkeletonUtils.clone` 导出名、`Skeleton.dispose()` 释放 boneTexture(每实例独立)、GLB 图片内嵌(整会话单请求可保证)。

## 实现(src/main.js,单文件 ~560 行)

- **单次加载**:`GLTFLoader().load('assets/character.glb')` 仅调用一次,`assetRequests=1` 永不重复;原型(归一化:身高 1.5、底部贴 0、水平居中、朝向修正)缓存于内存。
- **双实例**:`SkeletonUtils.clone(asset.proto)` ×2(A 屏左 x=-1.35 / B 屏右 x=+1.35,相向微侧 ±0.42rad),几何/材质共享,骨架与骨骼纹理独立。
- **动画隔离**:每实例独立 `AnimationMixer(anchor)`,idle(Survey 原地化)/walk(Walk 原地化)双 clipAction,切换 0.25s fadeIn/fadeOut 交叉淡化;clip 状态即时更新。
- **销毁 A**:scene.remove + mixer.stopAllAction + mixer.uncacheRoot + 遍历 SkinnedMesh→skeleton.dispose()(释放每实例 boneTexture)+ `instances.A=null`(对象图可 GC);`destroyedInstance='A'`,按钮置灰(aria-disabled,点击为受控 no-op)。
- **reset**:destroy A/B → 从缓存原型 clone 重建 → 双实例 idle、`resetCount+1`、`destroyedInstance=null`;**零新网络请求**。
- **场景**:渐变穹顶 + CanvasTexture 同心圆地坪(中心光池)+ 双展台(脉冲发光光圈 + A/B 顶面刻字)+ 雾;灯光 = 半球环境 + 键(唯一投影源,1024 shadow map)+ 补 + 逆,共 4 盏(≤6)。
- **相机**:球坐标绕 (0,0.95,0),基础 polar 1.32(轻俯);±0.3rad/26s 平滑摆动(构图稳定且任意区域持续视差)+ 用户拖拽/滚轮(指数阻尼趋近)。
- **状态**:getState() 全字段(assetLoaded/instanceCount/instances.A·B{clip,time,playing}/destroyedInstance/resetCount/fps(60 帧滚动)/frame/assetRequests/…),ready 门控 = 资产就绪 + 双实例 + 首帧渲染(实测 578ms)。
- **UI**:顶栏工具条(data-ui + data-bench 双属性)、加载遮罩、左上标题、左下等宽 HUD(0.2s 节流)。

## 构建与验证循环

| 轮次 | run-id | 变更 | 结果 |
|---|---|---|---|
| R1 | REF-E10-three-R1 | 首版实现 | **PASS 7/7**,fps 60.3;console 2 warnings(Clock 弃用、PCFSoftShadowMap 已移除) |
| R2 | REF-E10-three-R2 | 清理:自计时替换 THREE.Clock;PCFShadowMap 显式;补光 0.75→0.9 | **PASS 7/7**,fps 60.1,**console 全零** |
| Final | REF-E10-three(--video --port 7407) | 无代码变更,取正式证据 | **PASS 7/7**,fps 60.2,video.webm 4.2MB,31 张截图 |

- 构建:3 次全过(每次单 attempt,~4–5s,含 dist 重建 + 引擎 vendoring 自检)。
- 网络(最终轮):全程 9 个请求,其中 `GET /assets/character.glb → 200` **恰好 1 次**(reset 后无新请求,P6 证据)。
- 探针余量(最终轮):P1 lit [0.29, 0.40]/0.10;P2 motion [0.198, 0.265]/0.005;P4 regionChange 0.178/0.01;P6 lit [0.61, 0.26]/0.10;P7 motion [0.29, 0.37]。
- 像素级复核(独立于 harness):P4 后 A 区狐像素占比 0.000(B 区仍在)、P6 后两区均恢复——销毁/重建与画面一致,非"状态造假"。

## 红线自查

- [x] 单次网络加载派生双实例(SkeletonUtils.clone),无二次加载
- [x] 销毁 = 场景图移除 + mixer 停止/反缓存 + 每实例 GPU 资源释放,非隐藏
- [x] reset 不刷新页面、不重新请求资产(network.json 证据)
- [x] instances.A/B 的 clip/time 每帧由活动 AnimationAction 实时读取,与画面同源
- [x] 骨骼动画由 GLB 剪辑驱动(仅冻结根位移轨道,旋转轨道未动)
- [x] 未改 spec/harness;产物只写工作区
