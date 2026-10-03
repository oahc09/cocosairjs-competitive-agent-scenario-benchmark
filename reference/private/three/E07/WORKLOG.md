# E07 — Three.js Reference WORKLOG

- 工作区:`bench/reference/private/three/E07/`(本文档所在目录)
- 角色:Reference 实现者(trusted,可读引擎源码与 harness)
- 日期:2026-10-02
- 产物:`src/main.js`(场景全部实现,单文件 ~870 行)、`index.html`(仅改 title)、
  `scripts/review-frame.mjs`(像素级审图工具)、`scripts/soak-test.mjs`(120s 长稳自检)
- 终跑验证:`validation/report.json`(含 `--video`,`video.webm` 7.3MB)

## 最终结果

| 项 | 值 |
|---|---|
| verdict | **PASS** |
| probes | 8/8 PASS(P1–P8) |
| fps | 60.1(harness 独立 3s rAF 采样;getState 滚动 60 帧均值同为 60) |
| console errors / uncaught | 0 / 0 |
| ready | appReady+benchReady 1.08s(限 10s) |
| 网络 | 18 请求全部本地 vendored 文件(2.1MB),0 外部 |
| build | `npm run build` 退出码 0,dist/app.js 34KB(引擎 external) |
| 长稳 | soak 125s:fps 恒 60,JS 堆 10→13MB 有界,0 未捕获异常(soak-report.json) |

规模(spec 冻结值 → 实测 getState):楼 220(≥200)/ 车 86(≥60)/ 雨 2200(≥1500)/
窗点 4340(≥2000,每楼 ≥8 强制)/ 霓虹元件 150 / 雾初始开启。

最终探针余量(最差指标 vs 阈值):

- P1 nonBlank:0.5035 vs 0.35(1.44x;全屏非模态像素 50%)
- P2 regionChange 街道层:0.8727 vs 0.01(87x;车流)
- P3 pixelDelta 全屏 100ms:0.6563 vs 0.02(33x;雨)
- P4 motion 全屏 1s:0.3807 vs 0.005(76x)
- P5 regionChange 上部(关雾):0.3218 vs 0.01(32x)
- P6 regionChange 上部(开雾):0.3135 vs 0.01(31x)
- P7 nonBlank(reset 后):0.4173 vs 0.35(1.19x)
- P8 motion 街道层(reset 后):0.9078 vs 0.005(182x)

## 实现结构(src/main.js)

1. **夜空穹顶**:BackSide 球面 ShaderMaterial——垂直渐变(雾色地平线→近黑天顶)、
   城市光害带(暖品红辉光,雾量联动)、缓慢漂移薄云(fbm)、方向网格 hash 星点
   (关雾后浮现,`uFogAmt` 联动)
2. **湿地面**:Reflector 平面反射 + 自定义沥青 shader——1024×512 HalfFloat RT、
   oblique 裁剪、水洼掩码(fbm)、双频波纹扰动采样、距离雾衰减(与场景 FogExp2 同式)
3. **楼群**:220 栋 InstancedMesh 暗色体块,9 条纵深走廊 × 6 条横穿街道的街区网格,
   每排(近→远)高度上限递增(26→88m),6% 地标塔(最高 118m),
   mulberry32 确定性生成(reset 同种子重建同一座城)
4. **发光窗阵**:4340 个实例化小面片,正面(+Z)+ 朝主走廊侧面双面生成,
   暖(58%)/冷混合、随机点亮(55%)、每楼 ≥8 强制;
   **窗格尺寸随局部间距缩放(填充率封顶 ~52%)保证矩阵可辨识**;
   HDR instanceColor(0.28–0.72 线性)在 ACES 下呈现 90–190 点光
5. **车流**:86 辆沿 10 条车道(近景横穿 ×2 / 中远景横穿 ×4 / 主走廊纵深 ×2 /
   侧走廊 ×2)连续移动;头灯暖白 / 尾灯红 / 15% 青色出租车(HDR instanceColor),
   加法混合拖尾面片(平躺、纵向渐隐),CPU 每帧仅重写 86×2 实例矩阵
6. **雨**:2200 粒 GPU 循环下落(vertex shader 内 mod 相位重生于顶部 + 风致漂移),
   gl_PointCoord 内画斜向光丝(与风向一致的自斜线、头部更亮),
   顶部淡入/近地淡出/贴脸淡出,加法混合 + 距离雾衰减;CPU 零成本
7. **霓虹**:150 个实例化发光元件——竖招牌(断续闪烁:时间片 hash 掉电)、
   广告横带(呼吸)、高楼描边灯带(2–4 根竖亮线)、走廊两排街灯、
   主走廊入口两块大广告牌(构图锚点);6 色高饱和调色板
   (品红/青/橙黄/酸绿/金/紫),自定义 aPhase/aSpeed/aMode 实例属性驱动闪烁
8. **雾**:FogExp2(0x1c2a4c, 0.0115),**开关走密度动画(0.0115↔0,纯 uniform 更新,
   无 shader 重编译)**;neon/trail/rain/ground 四个自定义 shader 手工复刻同式雾
9. **后处理**:RenderPass → UnrealBloomPass(0.45/0.40/0.85,只让霓虹与车灯越阈)
   → OutputPass(ACES+sRGB)→ FXAAPass
10. **相机**:低角度仰视(y=3.6m,仰角 10.5°,fov 62),极缓慢漂浮取景(±0.9m 视差)
11. **UI**:右下角 `FOG` / `RESET` 按钮(data-ui + data-bench 双属性,hover/active 反馈),
    左下角轻量 HUD(fps/计数/雾态,250ms 刷新)
12. **状态通道**:`getState()` 返回 stateContract 五字段
    (buildingCount/carCount/rainParticleCount/fogEnabled/fps)+ 附加字段
    (windowCount/neonCount/frame/resetCount/engine/ready);
    fps = rAF 时间戳滚动 60 帧真实均值;`reset()` 归零动画相位、恢复雾开、
    同种子重建城市(计数不变、画面复位),不刷新页面

## 迭代史(8 次 validate + 1 次 soak,全部保留于会话记录)

| # | 变更 | 结果 |
|---|---|---|
| 1 | 初版 | FAIL(RUNTIME):街区 z 区间方向反了(`areaD` 为负)→ 全部块被跳过 → 0 栋楼,`buildCity` 读 undefined 抛 TypeError |
| 2 | 修 z 区间(近边>远边) | **8/8 PASS 首绿**(fps 60.1);但审图发现全画面过曝:full avgLum 155、天空 129、中性灰白,窗/霓虹全糊 |
| 3 | 校准暗部:窗光 0.85–1.8→0.26–0.68、霓虹 2.6→1.35、车灯 2.6→1.55、雨 ×1.15、天空/楼体/环境光调暗、bloom 0.72/0.48/0.58→0.55/0.55/0.68 | 8/8;avgLum 48.8、天空 22.9、霓虹色相显现;但远景雾衰减弱(开/关雾远带 57 vs 72 差异小)、窗阵过稀(0.44 点亮) |
| 4 | 雾密度 0.0102→0.0115、雾色提亮偏蓝(0x16203a→0x1c2a4c)、窗密度/亮度回调(0.55 点亮,0.30–0.76)、间距收紧 | 8/8;远带 71.8→57.0、blueCast 1%→10%(雾纵深成立);但发现近景楼面上 ~100px 平滑光斑 |
| 5 | 像素定位光斑 = 低阈 bloom 把霓虹源糊成大团;bloom 收紧 0.55/0.55/0.68→**0.45/0.40/0.85**、霓虹 1.35→1.18 | 8/8;光斑消除;但近景窄楼窗对几乎相接(填充 65%),窗格矩阵局部不可辨 |
| 6 | **窗格尺寸随局部间距缩放**(填充率封顶 ~52%),窗几何 1.12×1.45 基准 + 实例缩放;亮度微调 0.28–0.72 | 8/8;窗阵呈离散点阵,矩阵可辨识;P3 余量 0.22(雨稍暗但 11x 余量) |
| 7 | soak 125s(`scripts/soak-test.mjs`,复用 harness HarnessBrowser) | fps 恒 60、帧计数线性 837→7144、堆 10→13MB 有界、0 uncaught → **长稳 OK** |
| 8 | 终跑 `--video` | 8/8 PASS,fps 60.1,video.webm 7.47MB |
| 9 | 清理审图残留后**清洁终跑 `--video`**(证据集纯净) | 8/8 PASS,fps 60.1,video.webm 7.3MB,35 张截图,18 本地请求 |

## 关键技术发现(写给后续对照实现)

1. **夜景 HDR 亮度预算必须在线性空间规划**:全场景 ~5700 个自发光实例
   (窗 0.3–0.76 + 霓虹 1.2–1.9 + 车灯 1.3–1.6 线性)在 ACES 下映射到 sRGB 90–230;
   初版窗光 0.85–1.8 直接把城市糊成 155 avgLum 的"光墙"。暗夜场景的窗光应落在
   0.25–0.75 线性,靠数量与色温差异成阵,而不是靠单点亮度。
2. **bloom 阈值是窗阵可辨识度的生命线**:threshold 0.68 时中等亮度窗也越阈,
   UnrealBloom 的 mip 扩散把相邻窗点连成 100px 光斑;提到 0.85 后只有霓虹/车灯
   辉光,窗点保持锐利。另一个通用结论:**ACES 对高亮度强烈去饱和**——想保住
   霓虹色相,强度就不能推太高(1.2 线性附近是甜点)。
3. **窗格矩阵 = 间距填充率控制**:实例化窗面片固定尺寸时,窄楼 (span 5m) 的
   pitch 被压缩到 1.7m,窗宽 1.1m → 填充 65%,视觉上连片。解法:窗片尺寸随
   局部 pitch 缩放,填充率封顶 ~52%,任何楼面上都能看到暗格。
4. **雾开关用密度动画而非对象增删**:`scene.fog = null` 触发全材质重编译
   (画面卡顿一帧);FogExp2.density→0 是纯 uniform 更新,开关丝滑。
   自定义 shader(neon/rain/trail/ground)需手工复刻同式雾
   (`1-exp(-(d·ρ)²)`)保持一致衰减。
5. **Reflector 必须旋转 mesh 而非几何**:Reflector 依 mesh 变换求镜面法线
   (局部 (0,0,1));`geometry.rotateX(-π/2)` 会让镜面竖立。每帧整场景多渲染一次
   (1024×512 HalfFloat + oblique 裁剪),在 RTX 4060 上无感(仍 60fps)。
6. **InstancedMesh 必须关 frustumCulled**:实例遍布全城,包围球剔除会整组误剔除。
7. **雨用 Points + gl_PointCoord 自斜线**:点精灵内画 `|d.x + 0.35·d.y|` 细线,
   斜率与风速漂移方向一致,即得带速度感的斜向雨丝,单 draw call 2200 粒,
   下落完全在 vertex shader 内 mod 循环,CPU 零成本、永不泄漏。
8. **像素审图优于肉眼**:`scripts/review-frame.mjs`(ASCII 亮度/色相图 + 分区统计
   + 周期自相关)定位了过曝、光斑、窗格连片三类问题,全部有数值证据。
   E05 的教训(视觉工具缓存同路径旧图)再次适用——本工具直接读 PNG 无此问题。

## 红线自查

- 未伪造状态:buildingCount/carCount/rainParticleCount/windowCount/neonCount 为
  真实实例计数(与画面一致);fps 来自 rAF 时间戳滚动 60 帧真实均值(非常数);
  fogEnabled 与画面即时同步(P5/P6 双向往返探针即证据)。
- 未改 spec/harness;产物只写工作区;无外部资产;无网络请求(18 请求全 vendored);
  无自动化环境特判;reset 不经页面刷新(P7 探针 + resetCount 状态即证据);
  无探针期间临时提规模(规模由冻结常数决定,与探针无耦合)。
