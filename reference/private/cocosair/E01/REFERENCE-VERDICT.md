# REFERENCE-VERDICT — E01 深空星系巡航 · Cocos AIR

- runId:REF-E01-cocosair-final(2026-10-02T09:58:02Z,含 --video)
- 工作区:`bench/reference/private/cocosair/E01/`
- spec:`bench/briefs/E01/spec.json`(v1.0.0, frozen)

## Verdict

**FEASIBLE**(非 ENGINE_LIMITED:所有 spec 硬指标在原生引擎路径上全量达成,无需降级)

| 合同项 | 要求 | 实测 |
|---|---|---|
| build | exit 0 | ✓(16/16 次构建全成功) |
| __appReady | 10s 内 | ✓ 383ms |
| starCount | ≥ 50,000 且真实 | ✓ **74,500**(2 个 POINT_LIST mesh 顶点合计,2 draw call) |
| fps | ≥ 30(2s 滚动) | ✓ **60.2**(harness rAF 独立采样;状态侧同源 2s 滚动平均 ≈60) |
| noUncaughtErrors | 全程 | ✓ console 错误 0 |
| reset | 非刷新、1s 内、可重复 | ✓ epoch 累加,连测 2 次一致 |

## Probes

**probesPass: 7 / 7(100%)**

| probeId | 状态 | 关键证据 |
|---|---|---|
| P1 starCount+nonBlank | PASS | starCount=74,500;lit 19.7%(阈值 2%) |
| P2 旋转+motion | PASS | 2s 相位增量 ≈0.1 rad;中央 80% 运动像素达标 |
| P3 视差+pixelDelta | PASS | parallaxOffset.x 0.168→0.18;全帧像素差达标 |
| P4 滚轮穿行+pixelDelta | PASS | 距离 76.2→64.3(Δ11.8 > 5);构图变化达标 |
| P5 HUD | PASS | hudVisible=true;fps≈60;文本含星点数/帧率/距离 |
| P6 fps | PASS | 60.2 ≥ 30(181 帧 / 3005ms) |
| P7 reset | PASS | epoch=1;dist 119.4 ∈[115,125];parallax=(0,0);phase 0.042<0.1;无导航 |

## FPS

- **60.2**(headless Chromium 1280×720,RTX 4060 Laptop / ANGLE D3D11;74,500 点 + additive 辉光,2 draw call,顶点阶段零动态 uniform,CPU 每帧仅节点旋转 + 相机位姿)

## Engine Limitations(如实记录;均未触发降级)

```json
{
  "engineLimitations": [
    {
      "id": "NO_POSTPROCESS_BLOOM",
      "severity": "workaround-applied",
      "detail": "引擎无 EffectComposer/Bloom 等后处理可用路径(Code First 默认管线)。星系辉光以 additive(ONE,ONE)混合的高斯软核点精灵近似——spec 允许的等价手段;核球亮度层次由 9,000 星点 additive 累积实现,非真实泛光。",
      "impactOnScore": "视觉特效质感维度按近似效果评分(见 ceiling-notes 六维)"
    },
    {
      "id": "CREATE_MESH_POINT_LIST_FALSY_BUG",
      "severity": "workaround-applied",
      "detail": "utils.createMesh 对 IGeometry.primitiveMode 用 `||` 判空,POINT_LIST(=0)被静默替换为 TRIANGLE_LIST。绕行:createMesh 后补写 mesh.struct.primitives[*].primitiveMode。",
      "repro": "utils.createMesh({positions:[0,0,0], primitiveMode: gfx.PrimitiveMode.POINT_LIST}) → mesh.struct.primitives[0].primitiveMode === 7 (TRIANGLE_LIST)"
    },
    {
      "id": "DRAW_PRIMITIVE_FROM_PASS_NOT_MESH",
      "severity": "workaround-applied",
      "detail": "实际 draw 图元模式取自 Pass._primitive(effect JSON pass 的 primitive 字段,默认 TRIANGLE_LIST);mesh 侧 primitiveMode 对实际绘制无影响。该字段无文档,由 pass.ts initialize 反推。绕行:pass JSON 显式 primitive: 0。",
      "repro": "同上一条修复 mesh.struct 后仍按三角形绘制;effect pass 增加 primitive: POINT_LIST 后才按点绘制"
    },
    {
      "id": "VERTEX_STAGE_UBO_READ_DRIFT",
      "severity": "workaround-applied",
      "detail": "自定义材质 Constants 块(set1/binding0,stageFlags=VERTEX|FRAGMENT)与 CCGlobal 在顶点着色器中读取到随顶点漂移的非常量值(经 varying 输出成像验证);CCCamera/CCLocal 顶点阶段正常(位置/变换始终正确)。规避:点尺寸路径零 uniform(a_star.x 构建期烘焙 pxScale,视距用 gl_Position.w)。",
      "repro": "顶点着色器 `v_dbg = vec2(pxScale/1000, cc_screenSize.y/1000)` 输出:同一 uniform 在不同星点呈 27~232 离散簇(应恒定)"
    },
    {
      "id": "CANVAS_WHEEL_EVENT_SWALLOWED",
      "severity": "workaround-applied",
      "detail": "引擎在 canvas 层对 wheel 事件 preventDefault+stopPropagation,window 冒泡监听收不到。绕行:捕获阶段监听 {capture:true}。",
      "repro": "window.addEventListener('wheel', h, {passive:true}) 不触发;同一 handler 加 capture:true 触发(canvas-bubble 观察 defaultPrevented=true 且 window-bubble 不达)"
    },
    {
      "id": "NO_FIRST_CLASS_POINTS_API",
      "severity": "info",
      "detail": "无 Three.js 风格 Points/PointsMaterial 一等公民 API(仅 ParticleSystem2D);大规模点云需自定义 EffectAsset+GLSL 三变体+customAttributes 手工搭建,门槛高于 THREE.Points(new BufferGeometry, setAttribute) 一步到位。"
    }
  ]
}
```

## 结论

E01 在 Cocos AIR 上 **FEASIBLE**:74,500 真实星点、60fps、7/7 探针全绿、reset 生命周期正确。达成过程中绕过 5 个引擎坑位(2 个为渲染正确性级别的静默错误),全部有可复现证据与公开 API 绕行,已沉淀至 ceiling-notes.md 的引擎缺口清单。
