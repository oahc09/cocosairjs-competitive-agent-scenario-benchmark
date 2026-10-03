# WORKLOG — E02 Reference(three r186)

- Run ID:`REF-E02-three`
- 工作区:`bench/reference/private/three/E02/`
- 日期:2026-10-02
- 结论:**PASS(7/7 probes,fps 60.1,0 console errors / 0 warnings / 0 uncaught)**

## 流程记录

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 读 MASTER-CONTEXT / E02 brief.md / spec.json / harness(validate + probe-executor + browser + serve) | 明确 P1-P7 断言、stateContract、UI 定位器(`data-ui="tone-toggle"` / `data-ui="reset"`)、P4 双采样窗口语义(动作后 500ms 起 200ms 窗口内 azimuth 须再变 >20°) |
| 2 | `mkdir assets && cp bench/assets/boat.glb assets/` | sha256 `ed22ff2f…9397` 与 spec 一致 |
| 3 | 解析 GLB JSON chunk | 6 节点(Hull/Deck/KeelAndRudder/Rigging/MainSail/Jib)+ 6 材质(无纹理,顶点为 POSITION+NORMAL);最长边 ~2.64(Z 轴),Y-up |
| 4 | 编写 `src/main.js`(单文件实现,见下"实现要点") | — |
| 5 | build + validate 第 1 轮 | **PASS 7/7**,fps 60.1;唯一 console warning:`THREE.Clock deprecated(r183)` |
| 6 | 视觉调优(截图 AI 审阅 4 张:initial/P5-after/P6-after/复检) | ① Clock→Timer(Page Visibility 感知,顺带满足"后台节流恢复"约束);② 海面加逐像素细波法线扰动(近景高频光泽);③ 补光 0.4→0.6(背光帆面可辨);④ 相机半径 8.6→7.6(孤舟更占前景) |
| 7 | build + validate 第 2 轮 | **PASS 7/7**,console 全 0 |
| 8 | 余量独立测量(playwright 复现 P4/P3 动作) | P4 窗口 Δazimuth = **28.32°**(阈值 >20);P3 4s y 极差 = **0.2946**(阈值 ≥0.02) |
| 9 | 最终轮 `--video` | **PASS 7/7**,fps 60.1,video.webm 4.9MB,appReady 504ms |

## 实现要点(src/main.js,~700 行)

- **资产**:GLTFLoader 运行时 `load('assets/boat.glb')`(真实 fetch;serve 根=工作区根)。6 内嵌材质原样保留;归一化:最长边→2.6、居中、水线=包围盒高 25%;`assetRequests` 仅在加载成功回调 +1。
- **海面**:PlaneGeometry 520×520、224×224 段(**50,625 顶点** ≥ 2000),`rotateX(-π/2)` 烘焙。顶点 shader 6 波叠加(深水色散 ω=√(gk),λ 3.4–42,方向各异),Gerstner 式水平位移锐化波峰,解析法线;短波按距离 fade(层次化:近密远疏)。片段 shader:Fresnel 天空反射、Blinn 高指数太阳 glitter 带、波峰白沫、逐像素细波法线扰动。fog 走 `UniformsLib.fog` + `fog_vertex/fragment` chunk(ShaderMaterial fog:true)。
- **天空**:700 半球 BackSide 渐变穹顶 + 日/月光盘(smoothstep cos 边)+ 双层光晕;冷端星点 hash 淡入;地平线下压雾色与海面雾化无缝。
- **船体随波**:CPU `sampleSea(0,0,t)` 与 shader 用同一 `WAVE_DEFS` 数组(**相位耦合**)→ y=0.9·h + 纵摇/横摇(由解析坡度)+ 缓慢 yaw 摇摆;一阶滞后平滑。
- **环绕**:临界阻尼弹簧(ω=3.2)追拖拽目标(0.6°/px),az/el/r 三通道;`cameraAzimuth` 报告弹簧当前值——P4 的 200ms 采样窗内仍在平滑追近(28.3° 余量),且无跳变。
- **toneMix**:0(暖)/1(冷),指数 τ=0.55s 过渡(2.5s 时 0.99);单参数驱动:天空双色、光盘尺寸/颜色、雾色/远近、方向光颜色强度、半球光、补光、海面双色、glitter 色、曝光(1.08→0.98)、太阳仰角(8.5°→26°,落日→月升)。
- **reset(释放并重建)**:epoch+1 → 显式 `dispose()` 船/海/天(geometry+material+texture)并移出场景 → 状态归零(toneMix=0、az=35 精确、simT=0)→ 重建世界 → **重新 GLTFLoader.load**(`assetRequests` 递增,harness 网络日志见 3 次 200);重入保护;无整页刷新。
- **状态**:`getState()` 返回 spec.stateContract 全字段 + `resetCount`/`cameraElevation`/`ready`;fps 为 2s 滚动平均;`__appReady` 于"资产加载完成且首帧已渲染"后置 true(实测 504ms)。
- **其他**:ACES tone mapping + SRGB 输出(自定义 shader 手动 include `tonemapping_fragment`/`colorspace_fragment`);`THREE.Timer`(r183+)接管时间步进;加载中提示 / 加载失败可见错误(不抛未捕获);resize 自适应。

## 迭代统计

- build 尝试:3(全成功,0 修复)
- validate 运行:3(2 常规 + 1 --video)+ 1 次独立余量测量
- 代码修复:0 次失败驱动修复;1 次主动调优(Clock→Timer 消 warning)
- 产物:src/main.js、index.html(title)、assets/boat.glb、validation/(report.json、probe-results.json、network.json、console.json、screenshots×31、video.webm)
