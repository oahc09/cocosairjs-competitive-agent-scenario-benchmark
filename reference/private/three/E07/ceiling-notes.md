# E07 — Three.js 引擎能力上限笔记(ceiling-notes)

> 场景定位:Instancing / Emission / Animation / Atmosphere / Scale 探测。
> 本文记录 Reference 实现实际用到的引擎能力、六维自评,以及即便在 Three 上
> 也存在的实现层缺口——供双引擎对照与路线图使用。

## 1. 用到的引擎能力清单

### 实例化(本场景正片,五组 InstancedMesh 单批次提交)

| 批次 | 数量 | 能力点 |
|---|---|---|
| 楼群 | 220 | 单位盒 + 逐实例 matrix(position/scale);`setColorAt` 楼体明度差 |
| 发光窗阵 | 4340 | 逐实例 matrix(含**按局部间距的尺寸缩放**)+ HDR instanceColor(0.28–0.72 线性暖/冷) |
| 霓虹元件 | 150 | instanceColor + **自定义 InstancedBufferAttribute**(aPhase/aSpeed/aMode)驱动每实例呼吸/断续闪烁 |
| 车流 | 86 | DynamicDrawUsage,每帧重写矩阵(10 车道连续移动 + 往返 wrap) |
| 车流拖尾 | 86 | 加法混合 ShaderMaterial × 实例化(纵向渐隐面片) |

要点:ShaderMaterial 在 InstancedMesh 上可直接用 `#ifdef USE_INSTANCING` /
`USE_INSTANCING_COLOR`(r186 前缀自动注入),即"自定义逐实例 GLSL"完全可行;
instanceColor 分量可 >1(HDR 自发光),配合 bloom 阈值做选择性辉光。
全部实例组 `frustumCulled=false`(包围球按几何而非实例计算)。

### 大气 / 反射 / 粒子

- **FogExp2 距离雾**:`1-exp(-(d·ρ)²)`,密度 uniform 动画实现开关(0 重编译);
  四个自定义 shader(neon/trail/rain/ground)手工复刻同式,衰减一致。
- **Reflector 平面反射**(addons/objects/Reflector.js):1024×512 HalfFloat RT、
  oblique 近平面裁剪、每帧镜像相机渲染整场景;自定义 shader 接口
  (tDiffuse/textureMatrix + 自定义 uniforms)在其上实现湿沥青
  (fbm 水洼掩码 + 双频波纹扰动 + 距离雾)。
- **Points GPU 粒子雨**:2200 粒下落完全在 vertex shader(mod 相位 + 风致漂移),
  `gl_PointCoord` 内画自斜细线,CPU 零成本、无生命周期泄漏;
  顶部淡入/近地淡出/贴脸淡出三段 alpha 管理。
- **程序化夜空**:BackSide 穹顶 shader(渐变 + 光害带 + fbm 薄云 + 方向网格
  hash 星点),星点能见度随 `uFogAmt` 联动(关雾浮现)。

### 后处理链(氛围支柱)

| Pass | 参数 | 用途 |
|---|---|---|
| RenderPass | — | 场景 → HalfFloat HDR buffer |
| UnrealBloomPass | 0.45 / 0.40 / 0.85 | 只让霓虹(≥1.18)与车灯(≥1.3)越阈辉光;窗点(≤0.72)保持锐利 |
| OutputPass | ACES + sRGB(exposure 1.0) | 线性 HDR → 显示域 |
| FXAAPass | — | RT 管线无 MSAA 的近似抗锯齿(修霓虹细线/雨丝锯齿) |

### 确定性与测量

- mulberry32 种子化城市生成 → reset 同种子原位重填实例缓冲(矩阵/颜色/实例属性
  复用同一 GPU buffer,不换 attribute)→ 计数恒定、画面复位、零分配。
- fps = rAF 时间戳滚动 60 帧均值(钳制 0.25s 离群),非常数;
  相机缓慢漂浮(±0.9m 视差)提供非探针期真实运动。

## 2. 六维自评(0–3)

| 维度 | 分 | 依据 |
|---|---|---|
| 构图取景 | 3 | 低角度仰视(仰角 10.5°),地平线 67% 高度(下 1/3 街道、上 2/3 楼群夜空);主走廊消失点纵深;近/中/远三排楼高递增 26→88m;HUD/按钮贴边不遮天际线 |
| 材质光影 | 3 | 全程序化;窗阵暖(58%)/冷点阵可辨识(填充率 ≤52% 封顶);湿地面真实平面反射(水洼掩码+波纹);夜景亮度预算在线性空间规划(full avgLum ~60) |
| 动效流畅 | 3 | 60fps;车流 10 车道连续 wrap;雨 GPU 循环下落;霓虹呼吸+断续闪烁;相机慢漂移;无卡顿(120s soak fps 恒 60) |
| 特效质感 | 3 | 选择性 bloom(阈值 0.85)+ 霓虹六色相 + 雾纵深(远带 71.8→57.0、蓝调 1%→10%)+ 斜向雨丝 + 湿街倒影,氛围成立且无过曝/光斑 |
| 交互反馈 | 2 | 雾开关即时状态+画面同步、reset 即时重建;按钮 hover/active 反馈;本场景交互即最小集,无更多 affordance(无缩放/拖拽,brief 定位氛围与规模) |
| 整体完成度 | 3 | 8/8 探针、契约全项、120s 长稳、录屏、文档、0 console 错误、18 请求全本地 |
| **合计** | **17/18** | visual = round(17×40/18) = **38/40** |

## 3. 实现层缺口(即便在 Three 上也要工程手段补)

1. **InstancedMesh 的逐实例表现力上限是"颜色+自定义属性"**:窗阵只能靠
   位置/尺寸/颜色差形成"房间亮灯"观感,无法逐实例换纹理(窗帘/桌灯/电视闪烁
   需 texture atlas + uv 偏移,或分批多个 InstancedMesh)。本实现以尺寸/亮度/
   色温三层随机近似,距"每扇窗一个故事"仍有距离。
2. **UnrealBloom 阈值只认线性亮度,无分区控制**:想让"霓虹强辉光、车灯中辉光、
   窗完全不辉光"只能全局阈值一刀切(0.85),想要分区得分层渲染多次合成。
   实测中这是窗阵可辨识度的生命线(0.68 时窗点被 mip 扩散连成 100px 光斑)。
3. **ACES 对高亮度强烈去饱和**:霓虹 HDR 推到 2+ 时色相变白,保色需把强度压在
   ~1.2 线性——"辉光强度"与"色相饱和"存在结构性矛盾,任何用 filmic tonemap 的
   引擎都会遇到。
4. **Reflector 每帧全场景多渲染一次,无内置选择层**:不能只反射发光体
   (楼体贡献的反射几乎不可见却占渲染量);也没有基于粗糙度的模糊层级,
   湿面模糊只能靠半分辨率 + 采样扰动近似。本实现 1024×512 RT 在 RTX 4060 上
   无感,但这是分辨率换来的。
5. **Points 粒子无法各向异性拉长(世界空间)**:雨丝斜率在 sprite 空间伪造,
   与全局风向一致即可;若要每滴速度方向不同(湍流雨),需改 LineSegments 或
   实例化面片朝向速度方向。WebGL 线宽恒 1px(E05 同发现),粗雨丝需面片化。
6. **无体积雾/高度雾/光轴**:FogExp2 是纯距离衰减;地面积雾、霓虹光轴、
   雨中光柱需自定义 raymarch pass,本实现未做(视觉上限仍有空间)。
7. **后处理链无原生 MSAA**(RT 管线,同 E05):FXAA 是近似;雨丝/灯带细线
   在运动中仍有轻微闪烁感。
8. **夜景 HDR 亮度预算必须整体规划**(工程教训):数千自发光实例的总亮度是
   乘性的;初版窗光 0.85–1.8 线性直接把全屏糊成 155 avgLum 的光墙,
   修正到 0.25–0.75 后靠数量与色温成阵——"暗夜靠点阵,不靠单点亮"。

## 4. 对 Cocos AIR 侧的对照预期(基于 MASTER-CONTEXT §3 已知事实)

- **实例化是本场景第一道门槛**:楼/窗/车/霓虹/拖尾全部依赖逐实例矩阵+颜色+
  自定义属性;AIR 若 InstancedMesh 等价物缺少自定义实例属性或 HDR 实例色,
  霓虹闪烁与窗阵暖冷混合就得拆批次或烘焙,规模 220/4340/86 的单批次提交
  是 60fps 的前提。
- **后处理(无稳定 Bloom)是第二道**:AIR code-first 无 Bloom 的已知短板,
  霓虹辉光只能靠贴片光晕/多层加法面片近似;"选择性 bloom(只让霓虹辉光)"
  的观感差异会直接体现在特效质感维度。
- **平面反射(湿地面)**:需要 RT + 镜像相机 + 自定义采样;若 AIR 暴露
  render target 与自定义 shader,可迁移,成本一道全场景渲染。
- **GPU 粒子雨**:需要 Points/gl_PointSize 等价 + 顶点 shader 相位循环;
  若 AIR 粒子只能 CPU 更新,2200 粒仍可行但每帧写 buffer 的 API 路径是关键。
- 本笔记不预设 AIR 结论,以 AIR Reference 实测为准。

## 5. 产出索引

- 实现:`src/main.js`(+`index.html` title)
- 工具:`scripts/review-frame.mjs`(ASCII 亮度/色相审图)、
  `scripts/soak-test.mjs`(120s 长稳,复用 harness 浏览器封装)
- 终跑验证:`validation/report.json`、`validation/probe-results.json`、
  `validation/video.webm`(7.3MB)、`validation/screenshots/`(35 张)
- 长稳证据:`soak-report.json`
- 过程记录:`WORKLOG.md`(8 次 validate + 1 次 soak 迭代史与关键发现)
