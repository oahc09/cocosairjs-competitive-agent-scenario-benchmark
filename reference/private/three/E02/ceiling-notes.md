# ceiling-notes — E02 引擎能力上界与缺口(three r186 Reference)

> 用途:为 AgentAttainment 分母(Engine Ceiling)与引擎能力清单提供 Reference 侧事实。
> 六维自评口径与 Visual 40 分制一致:每维 0–3,`visual = round(sum × 40 / 18)`。

## 六维自评(0–3 + 理由)

| 维度 | 分 | 理由 |
|---|---|---|
| 构图取景 | **3** | 海平线稳定在画面上 ~30%(锚点"上 1/3");暖端太阳+镜面高光带位于中轴偏左;孤舟中央偏下、完整可见(船身/甲板/桅杆/双帆);冷端月升+星点同构;环绕后透视一致无滑步(截图+录像核验)。 |
| 材质光影 | **2.5** | 船体 6 内嵌 GLB 材质全保留(木色船身/浅甲板/红色饰条/深桅杆/米白主帆/浅蓝前帆),受光/背光对比清晰(逆光暖边+相机侧补光);海面有 Fresnel 反射、深度双色、白沫与 glitter。扣 0.5:无阴影贴图(桅杆/帆不投影到甲板)、无环境贴图反射。 |
| 动效流畅 | **3** | 恒定 60fps(headless + RTX 4060);相机为临界阻尼弹簧(无过冲无跳变);6 波叠加连续行进、相位单调;船体起伏一阶滞后平滑;Timer(r183+)感知页面可见性,后台节流恢复不跳变。 |
| 特效质感 | **2.5** | Gerstner 锐化波峰、解析法线、逐像素细波扰动、高指数太阳 glitter 带、波峰白沫闪烁、双色温雾、ACES 色调映射、冷端星空。扣 0.5:无 bloom/屏幕空间反射/次表面散射等后处理层(本 brief 不要求,加了会更贵)。 |
| 交互反馈 | **2.5** | 拖拽环绕(平滑追近+方向一致)、滚轮缩距、色调按钮即时切换且文案随状态翻转、Reset 一键重建;探针 P4/P5 交互均有像素+状态双证据。扣 0.5:无悬停/按下的微交互,无触屏手势。 |
| 整体完成度 | **3** | spec.stateContract 全字段 + resetCount;加载中提示与失败可见错误;生命周期释放-重建-重载闭环(3 次真实网络请求);console 全 0;7/7 探针、两条红线证据链(网络+像素)完整。 |
| **合计** | **16 / 18** | `visual = round(16 × 40 / 18) = 36 / 40` |

## 引擎能力清单(E02 场景实测,r186 / 0.186.1)

- **资产管线**:`GLTFLoader`(addons)运行时加载 GLB、内嵌 PBR 材质/双面/顶点法线全保留;`Box3` 归一化便捷。
- **着色自由度**:`ShaderMaterial` 全权 vertex/fragment;顶点位移 + 解析法线 + Gerstner 水平锐化;自定义 shader 可 `#include <fog_*>` / `<tonemapping_fragment>` / `<colorspace_fragment>` 复用内建管线(`UniformsLib.fog` merge + `fog:true` 即接入场景雾)。
- **时间步进**:`Timer`(r183+ 取代 Clock)内建 Page Visibility 处理,天然满足"后台节流不算失败"。
- **色彩管线**:ColorManagement(sRGB→linear 工作空间)+ ACESFilmic + SRGB 输出,对标准材质与自定义 shader 一致。
- **光照**:Directional/Hemisphere/填充光即时改色改强度;toneMix 单参数可同时驱动 20+ uniform。
- **生命周期**:`geometry/material/texture.dispose()` 显式释放;重载资产即产生新网络请求(spec 认可的释放证据)。
- **交互**:Pointer Events + pointer capture 足以实现探针级拖拽;**OrbitControls 未用**——其默认阻尼曲线不保证 P4 的"动作后 500–700ms 窗口内仍在平滑位移 >20°"语义,自写弹簧更可控(这是本 Reference 唯一绕开 addons 交互件的决定)。
- **性能**:50,625 顶点海 + 全屏 shader 在 headless 环境 60fps,fps 余量 2×。

## 引擎缺口 / 注意项(面向对照与路线图)

1. **无内建水体/天空解决方案**:海面波形、天空渐变、日/月光盘全部手写 GLSL。引擎给的是"原语自由",不是"开箱效果"——Agent 必须具备图形学知识(色散关系、解析法线、Fresnel、雾 chunk 顺序)才能达到本 Reference 画质。
2. **自定义 shader 与内建管线的接缝知识密集**:fog/tonemapping/colorspace 需手动按正确顺序 include(内建顺序:opaque → tonemapping → colorspace → fog),漏一处即色彩空间错乱。
3. **浮力耦合无内建**:船体随波起伏需 CPU/GPU 共享同一波形参数(本实现单一 `WAVE_DEFS` 数组喂两侧),引擎不提供采样接口。
4. **API 演进摩擦**:Clock r183 弃用→Timer;Agent 若按旧教程写会吃到 console warning(不影响判定但留痕)。
5. **资源释放纯手工**:dispose 需 traverse 且逐类处理(geometry/material/texture),无作用域化 RAII;漏释放不报错,只能靠红线探针(连续 reset 内存样本)兜底。
6. **探针时序语义**:P4 类"动作后采样窗仍需位移"的断言要求交互实现带可控惯性——引擎默认控件(OrbitControls damping)不直接满足,需自调动力学。此为 brief 设计意图(平滑连续),非引擎缺陷,但 Agent 容易踩坑。

## 可比性说明

- 本 Reference 未使用任何 spec 未要求的高级特性(后处理、PMREM 环境、阴影贴图),全部依赖 r186 核心 + GLTFLoader 单一 addon;对照 Arm 若为 Cocos AIR,能力差异焦点将落在:自定义 shader 海面、GLB 材质保真、Timer 级时间步进、dispose 生命周期四处。
