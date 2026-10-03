# E07 霓虹夜城 — Cocos AIR Reference WORKLOG

- 日期:2026-10-02
- 工作区:`bench/reference/private/cocosair/E07/`
- 实现者:Reference(trusted,可读引擎源码 `E:\AIProMax\github\cocosair.js`)
- 最终:`REF-E07-cocosair-final` PASS 8/8,fps 60.2(3s rAF 采样),video.webm 5.4MB

## 1. 侦察(引擎事实,读源码验证)

| 事实 | 来源 |
|---|---|
| AIR 无 InstancedMesh / Points 一等公民 API;大规模路径 = 合并静态几何 + `utils.MeshUtils.createDynamicMesh` + `updateSubMesh` 单 draw call | 源码全局检索 + E06 Reference 已验证动态网格路径 |
| `builtin-unlit` 支持 `USE_VERTEX_COLOR`(顶点色经 `SRGBToLinear` = 平方后直出)与管线雾 `CC_USE_FOG`(frag 末端 `mix(cc_fogColor, color, factor)`) | `src/air/builtin/builtin-glsl4.ts` 提取 unlit vert/frag 源码逐行核对 |
| 管线**无输出 gamma/色调映射补偿**:顶点色/纹理色显示值 ≈ 存储值²(E10 Reference 同结论);自定义 shader 输出值为直通 | unlit frag `CCFragOutput` + E10 worklog |
| 雾:`scene.globals.fog`(FogInfo)在 `app.run` **前**配置可在首帧生效(无编译颠簸);`enabled` setter → 管线宏 `CC_USE_FOG` 切换(触发全材质重编译,~100ms 级) | `src/cocos/scene-graph/scene-globals.ts` + `render-scene/scene/fog.ts` + `rendering/pipeline-ubo.ts`(fogColor 走 Color 0-255 → 归一 → 平方) |
| MeshRenderer 模型包围盒来自 `mesh.struct.minPosition/maxPosition`(几何必须显式给 minPos/maxPos,否则模型无 bounds 被剔除) | `mesh-renderer.ts:927 createBoundingShape` |
| `primitives.plane`:XZ 平面,+Y 法向;u=0↔x=-半宽,v=0↔局部 z=+半宽;`Texture2D.uploadData(canvas)` 不翻 y | `primitive/plane.ts` + E10 |
| 动态网格:`createDynamicMesh(0, {positions,uvs,colors,minPos,maxPos}, undefined, {maxSubMeshes,maxSubMeshVertices,maxSubMeshIndices})`,每属性独立 stream;`updateSubMesh` 全量覆写 + 可更新 bounds | `3d/misc/create-mesh.ts` + `3d/assets/mesh.ts:573` |

## 2. 设计决策

- **7 个 draw call 承载全部大批量元素**:天空(自定义 shader 大球)/ 楼群合并静态网格(1)/ 窗阵合并静态网格(1)/ 地面(canvas 纹理 1)/ 光斑动态网格(车+街灯+信标,1)/ 胶囊动态网格(雨+霓虹,1)。
- 楼群 240 栋 = 5 z-带 × 8 街区 × 6 楼(确定性 mulberry32 种子,reset 逐位复现);逐面假光照烘进顶点色(前/背/左右/顶 5 档 × 楼体色板)。
- 窗阵:每楼 +Z 面亮窗(≤22)+ 暗窗格(≤56,矩阵可辨识关键),±X 面亮窗(≤22);暖 60%/冷 26%/苍白 8%/霓虹色 6%;临街两层橱窗强制亮化;合计 ~13.6k 亮窗点(≥2000 合同)。
- 车流 80:6 主干道(第一条加密 12 辆为前景)+ 7 条 Z 向街(x=0 主街正对相机,头灯向观众);每车 3 光斑(车身冷白/头灯暖白/尾灯红)。
- 雨 2200:竖直短线 quad(水平朝向相机),落地 y<0 重生顶部;速度感 = 拖尾长度∝落速。
- 霓虹 15 处:竖灯带/横招牌/楼顶灯框 × 5 色板(品红/青/橙/紫/荧绿),呼吸/硬闪/慢脉动/常亮微闪 4 模式。
- 自定义 shader ×3(天空:渐变+星点+月+光污染带,不受雾;光斑:径向衰减 additive;胶囊:横软边+端部渐隐 additive;后两者手写 LINEAR 雾因子,与引擎同式)。
- 亮度全部按「显示值 = 存储值²」反解标定(unlit 路径),自定义 shader 直通。

## 3. 迭代记录(validate 全程端口 7418/74xx)

| 轮 | 结果 | 问题与修复 |
|---|---|---|
| r1 | PASS 8/8 fps60.2 | **视觉验收不合格**:城市不可见(视觉模型确认无天际线)。console 无错误 |
| r2 | PASS 8/8 | 亮度重标定(雾色/楼体/地面)后仍不可见 → 判定为渲染缺失而非亮度问题;写 playwright 调试探针 |
| 调试 | — | **根因**:`rebuildStaticCity()` 首次调用时旧 mesh 为 null,新 mesh 赋值写在 `if (oldMesh)` 分支内 → City/Windows 的 MeshRenderer.mesh 一直为 null,模型无 bounds。同时确认 City/Windows 模型 `worldBounds: none` |
| r3 | PASS 8/8 | 修复赋值顺序;窗阵加密暗格;视觉确认:楼群/窗阵矩阵/雾纵深/霓虹/雨/路面标线全部可辨 |
| r4 | PASS 8/8 | 街道层加密(车 80、街灯加大加亮、x=0 主街车流)、楼体侧立面/天空光污染带提亮 |
| soak | 125s | fps 恒 60,内存 35→37MB 稳定(reset 瞬时 74MB 回落),reset + 4 次雾开关,0 console error |
| stress S1-S8 | 8 档 | 规模天花板探测(见 ceiling-notes.md) |
| final | PASS 8/8 fps60.2 | `--video` 留档 |

## 4. 踩坑清单(AIR 实测)

1. **首帧 mesh 赋值路径**:自建几何必须确保 `renderer.mesh = mesh` 无条件执行;mesh 需带 `minPos/maxPos`(否则模型无包围盒直接不渲染,且无任何警告)。
2. **线性管线双重变暗**:顶点色与 canvas 纹理都会被平方后直出、无输出 gamma;雾色同理(Color→归一→平方入 UBO)。夜景配色必须按 `存储 = sqrt(目标显示)` 标定。
3. **雾开关代价**:`FogInfo.enabled` 切换管线宏 `CC_USE_FOG` → 全材质 shader 变体重编译,单次 ~100ms(探针 waitMs 800ms 足以覆盖);建议 app.run 前配置初始雾,避免启动期二次编译。
4. **无 Points/InstancedMesh**:雨/车/霓虹走动态网格 CPU 每帧顶点写放(预算见 ceiling-notes),楼/窗走合并静态几何。
5. `Texture2D.reset + uploadData(canvas)` 不翻 y;地面画布坐标需按 plane 的 v 轴(局部 +z)与画布顶行对应关系推导。
6. `node.getComponent('MeshRenderer')` 字符串查找在 code-first 场景不可靠(调试脚本改用 `components.find(c=>c.constructor.name==='MeshRenderer')`)——引擎 API 级怪癖,非本场景 bug。

## 5. 效率数据(如实)

- validate 运行:r1/r2/r3/r4/final 共 5 次全流程 + 8 次压力 + 2 次 soak 调试。
- build 全绿一次通过(esbuild,~2s);全部验证轮 build 均 exit 0。
- 主要返工:mesh 赋值 bug(1 轮)+ 亮度标定(1 轮)+ 视觉打磨(2 轮)。

## 6. 产物

- `src/main.js`(~1100 行,全程序化,无外部资产)
- `validation/`(final:report.json + 8 探针截图×2~3 + video.webm + console/network/perf/source-sha)
- `.debug/stress-reports/S1..S8.json`(天花板探测原始 report)
- `.debug/e07dbg*.mjs / e07soak.mjs / mkstress.mjs`(探测脚本,可复跑)
