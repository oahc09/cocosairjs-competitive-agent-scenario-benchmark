# E06 — 荒野篝火营地(Wilderness Campfire)

```yaml
briefId: E06
briefVersion: 1.0.0
frozen: true
frozenAt: 2026-10-02T16:30:00+08:00
briefSha256: computed-by-harness
domains: [Procedural, Particles, DynamicLight, State, Camera]
assets: []
```

> 本 Brief 为冻结规格。brief.md(人读)与 spec.json(机读)必须保持一致;两者冲突时以 spec.json 为准并回炉重新冻结。

---

## 1. Goal

构建一个荒野夜间营地场景:低多边形树环绕中央空地,空地中央是篝火——跳动的火苗、上升消散的火星,以及一盏真实的动态火光,照亮营地地面与周围树干(亮度随火焰闪烁);夜空星点与 >=16 只游走明灭的萤火虫点缀画面。支持日夜切换(2.5–4 s 连续渐变)与可暂停的自动环绕相机。

覆盖子系统:Procedural(低多边形树与地形)/ Particles(火苗、火星)/ Dynamic light(火光闪烁照明)/ State(日夜、开关)/ Camera(环绕)。

## 2. Visual Direction

- **夜(初始态,`timeOfDay ≈ 0`)**:深蓝夜空 + 星点;整体冷调低亮度;营地中央一盏暖橙火光成为视觉焦点,地面与近处树干被暖光染色,形成强明暗对比与冷暖对比。
- **日(`timeOfDay ≈ 1`)**:天空亮蓝至地平线暖白;环境光充足、场景整体明显变亮;篝火仍在燃烧但火光在视觉上相对减弱(仍可见火苗)。
- **树**:低多边形(Low-poly)风格,平直着色感的锥形/多层锥体树冠 + 柱状树干,`>=12` 棵,环形或散布围绕营地,树受火光/月光影响有明暗面。
- **地面**:低多边形起伏地形或营地圆盘,草地色;火光下地面有暖色光斑,随火焰闪烁。
- **篝火**:石圈与交叉木柴堆(简单程序化几何);火苗为粒子或等效火焰面片,橙黄→红渐变、向上摆动;火星为小亮点粒子持续上升并消散。
- **萤火虫**:`>=16` 个黄绿色小亮点,缓慢游走 + 明灭(亮度周期变化)。
- **构图**:篝火位于画面中心附近;相机带俯角环视营地;树环构成前中景轮廓。

## 3. World Composition

1. **地面/地形**:营地空地 + 起伏地形的低多边形表面。
2. **树环**:`treeCount >= 12` 棵低多边形树,围绕营地分布(建议 14–24 棵,位置/大小/旋转随机但避开场心)。
3. **篝火组**:石圈 + 木柴堆几何;火苗(同屏 >=30 粒子或等效面片);火星(同屏峰值 >=40,上升速度 1–3 单位/s,寿命 0.8–2 s)。
4. **动态火光**:一盏位于篝火处的点状光源,`fireLightIntensity ∈ [0,1]`(基准约 0.55,闪烁幅度 >= 0.08,多频混合 0.5–6 Hz);必须真实照明地面与树(受光面亮度随之变化),不要求投影阴影。
5. **萤火虫**:`fireflyCount >= 16`,夜间可见(白天可淡出,计数不变)。
6. **天空**:背景色/天穹随 `timeOfDay` 插值(夜:深蓝+星空;日:亮蓝),星空在夜间可见。
7. **UI 覆盖层**(DOM):日夜切换、环绕暂停/恢复、重置三个按钮,详见 §4。

## 4. Interaction & Feedback

- **日夜切换**:`data-ui="day-night"` 按钮切换;`timeOfDay` 在 0(夜)与 1(日)两端点间以 **2.5–4 s 连续渐变**过渡(必须存在可采样的中间态,不得瞬时跳变);天空、环境光、整体亮度随之连续变化;再次点击反向切换。
- **环绕相机**:默认自动环绕,`cameraOrbitAngle` 以 0.05–0.4 rad/s 持续增长(俯角环视营地);`data-ui="orbit-toggle"` 按钮暂停/恢复(暂停后角度冻结);拖拽微调视角为可选加分。
- **reset**:`data-ui="reset"` 按钮(等价于 `__bench.reset()`):`timeOfDay` 立即(<=300 ms)回到 0(夜)、`orbitEnabled=true`、`cameraOrbitAngle=0`,火光/火苗/火星/萤火虫恢复初始默认状态。
- **UI 契约(自动化必需)**:所有控件为 DOM 元素,固定携带 `data-ui` 属性(取值:`day-night` / `orbit-toggle` / `reset`),置于页面右上角区域(归一化 x>0.8, y<0.25),不得渲染在画布内部。控件旁显示当前状态(夜/昼、环绕:开/关)为建议项。
- **坐标记法**:探针 click 坐标为归一化视口坐标 `{x,y}∈[0,1]`(左上为原点);`click:ui=<data-ui值>` 表示点击 `document.querySelector('[data-ui="<值>"]')` 的中心。

## 5. Asset Contract

- 无外部资产:`assets = []`。
- 树、地形、石圈、柴堆几何与火苗/火星/萤火虫视觉全部程序化生成;如需粒子贴图须运行时代码生成,不得引入任何图片/视频文件。

## 6. Scale & Performance

- 树 >=12(建议 14–24);萤火虫 >=16;火星同屏峰值 >=40;火苗 >=30 粒子或等效面片。
- 常态(夜间 + 环绕运行)下 `minFps >= 30`(1920×1080 级别窗口,harness 独立采样)。
- 日夜渐变与火光闪烁按真实时间步进;页面失焦再聚焦不崩溃、无时间跳变导致的瞬变。

## 7. Runtime / Lifecycle

- 统一契约:`npm run build` 产出 `dist/`,`index.html` 引 `dist/app.js`;页面暴露 `window.__appReady === true`(10 s 内)与 `window.__bench = { getState(): object, reset(): void }`;全程无未捕获异常。
- **状态通道 `getState()` 必须暴露**(均为真实数据,禁止伪造):
  - `timeOfDay: number` — 归一化时间,0=深夜、1=正午;初始 0(<=0.05);切换经 2.5–4 s 渐变到达另一端点(>=0.9 / <=0.1)。
  - `fireLightIntensity: number` — 当前火光强度 [0,1],随时间波动。
  - `fireflyCount: number` — 萤火虫数量(>=16,恒定)。
  - `cameraOrbitAngle: number` — 环绕方位角累计弧度(自上次 reset 起)。
  - `orbitEnabled: boolean` — 自动环绕开关(初始 true)。
  - `treeCount: number` — 树数量(>=12,恒定)。
- **reset 语义**:见 §4;reset 后 `__appReady` 保持 true,场景继续运行。

## 8. Technical Constraints

- **API 中立**:Brief 全文不出现任何引擎类名/API;实现者自行选择技术路线。
- **动态光必须真实照明**:火光须实际影响地面与树的受光亮度(两帧像素随闪烁变化);仅火苗自身发光而环境无明暗响应视为未达成动态光。不要求投影阴影(阴影为可选加分)。
- 火焰/火星必须经 WebGL 渲染管线绘制(见 §10 禁项)。
- 除模板自带构建产物外,运行时不得发起任何网络请求。

## 9. Completion Contract

统一部分(所有探针的 precondition 均为 `__appReady`):

```text
npm run build 退出码 0
10s 内 window.__appReady === true
window.__bench = { getState, reset } 可用
无未捕获异常(console.error 级别)
```

场景级验收(spec.json probes,共 6 个):

```text
P1 营地可见:夜景下树环(>=12)+地面+篝火暖光像素可见
P2 火光动态:fireLightIntensity 两采样差 >= 0.02 且画面中下区域两帧像素差(闪烁照明)
P3 日夜切换:timeOfDay 渐变至 >= 0.9,天空区域亮度显著上升(含中间态采样)
P4 环绕相机:cameraOrbitAngle 持续增长,构图连续变化
P5 环绕暂停:orbitEnabled==false 后角度冻结(差 < 0.01)
P6 reset:timeOfDay≈0、orbitEnabled=true、角度归零、萤火虫恢复
```

每项关键判定均要求 **state 证据 + 至少一个独立可观证据**(像素/运动),`__bench` 状态单独不构成 PASS。

## 10. Forbidden Shortcuts

1. 不得用预渲染视频、帧序列、GIF 或任何逐帧回放素材冒充火焰/萤火虫/日夜变化。
2. 火苗、火星必须经 WebGL 渲染管线绘制;不得用 DOM 元素/CSS 动画冒充。
3. 不得用两张(昼/夜)静态场景图瞬时切换冒充日夜切换——必须有连续渐变中间态。
4. 不得让火光只照亮火苗自身(火苗亮而地面/树干无明暗变化视为未达成动态光)。
5. 不得在 `__bench.getState()` 中伪造状态(如 `timeOfDay` 只报数而不真正渐变、`fireLightIntensity` 只做数值抖动而画面静止,视为作弊,NC 级失败)。
6. 不得引入外部图片/视频/音频资产(assets 契约为空)。
7. 不得对 harness/validator 做针对性特判(如检测自动化环境时改变行为)。
