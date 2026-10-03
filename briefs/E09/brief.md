# E09 珠宝展示台 — Frozen Brief

| 元数据 | 值 |
|---|---|
| briefId | E09 |
| briefVersion | 1.0.0 |
| frozen | true |
| frozenAt | 2026-10-02T00:00:00Z |
| briefSha256 | computed-by-harness |
| domains | Material ceiling / Reflection-Refraction look / Lighting / Camera transition / Screenshot export |

## 1. Goal

在暗色摄影棚中展示一颗多切面宝石:高折射/反射/色散(火彩)观感的材质上限,三点棚拍布光,展台转台自转,至少 5 色可切换色板,双击推近的相机过渡动画,以及一键 PNG 导出(真实浏览器下载,文件 >10KB)。本场景测引擎材质上限、折射/反射观感、布光、相机过渡与画布截图导出;若某引擎在此观感上受限,计入 Product Capability Gap。

## 2. Visual Direction

- 暗色摄影棚氛围:深灰渐变背景 + 柔和地面反射/投影,宝石为画面绝对主体,居中构图。
- 宝石切面上有锐利的镜面高光随转台转动扫动;透过宝石可见背景的折射变形(玻璃/晶体感,表观折射率观感 ≥1.5);切面棱线边缘出现色散彩虹(火彩)。
- 三点棚拍布光:主光(键光)塑造主体,辅光(填充)降低死黑,轮廓光(逆光/边光)勾出宝石边缘亮线;三层光效肉眼可辨。
- 转台缓慢自转(≥25°/s),宝石高光与火彩随之流动。
- 色板切换宝石色调立即变化,饱和不脏;色板 UI 精致克制,不抢主体。
- 整体是"珠宝广告级"的干净画面,无调试线框、无缺失材质的纯色块。

## 3. World Composition

1. 宝石:多切面晶体(≥20 个切面的等价几何),坐于展台之上,自转轴为竖直方向。可加载共享资产 assets/gem.glb,亦可程序化生成切面宝石(凸多面体逐面切角),二选一。
2. 展台/底座:低反射深色圆台或方台,承接宝石,边缘可有细金属亮边。
3. 布光:三盏有向光(主/辅/轮廓)+ 环境光照(环境贴图或等价环境光),位置与强度构成三点棚拍格局。
4. 背景:暗色摄影棚背景幕(渐变或弧幕),地面有轻微反射。
5. 色板 UI:≥5 个色样(建议命名:diamond #E8EEF2 / ruby #D6323F / emerald #23A96E / sapphire #2E5FD8 / amber #E8A33D),当前选中色有描边/放大反馈。
6. 操作按钮:导出 PNG(UI 控件 `data-bench="export-png"`)、重置(UI 控件 `data-bench="reset"`)。

## 4. Interaction & Feedback

1. 转台:宝石持续自转,角速度 ≥25°/s(建议 30°/s),`rotationAngle` 累计增长(度,不折返)。
2. 色板:点击任一色样(UI 控件 `data-bench="swatch-{i}"`,i 从 1 起)→ `selectedColor` 更新为该色名,宝石色调立即变化;再次点击其他色样继续切换。
3. 双击推近:双击宝石(画布中央)→ 相机向宝石平滑推近(缓动过渡,时长 ≥600ms),`cameraDistance` 从默认 10 降至 ≤6;再次双击 → 平滑拉回 ≥9。过渡期间帧率不塌陷、无跳变。
4. PNG 导出:点击导出按钮 → 从当前画布像素导出 PNG 并触发浏览器下载(文件 >10KB),`exportCount` +1;导出分辨率与画布一致。
5. 重置:`selectedColor` 回默认色(diamond)、`cameraDistance` 回 10、`exportCount` 清零;转台继续运转;不得整页刷新。

## 5. Asset Contract

- 共享资产**可选**:`assets/gem.glb`(`required: false`)。若使用,资产应为单颗多切面宝石,内置材质参数可被运行时覆盖(色调)。
- **允许程序化替代**:若不使用 GLB,必须程序化生成 ≥20 切面的宝石几何。
- 无论资产还是程序化,以下观感为硬性要求:高折射观感(透过宝石可见倒置/扭曲背景)、锐利镜面反射高光、切面棱线色散(火彩)。观感不达成即失败,与实现路径无关。
- 允许使用实现者自制的环境贴图(程序化生成或自备),计入产物工程。

## 6. Scale & Performance

- 场景规模小而精:1 颗宝石 + 1 个展台 + ≤10 个光源/环境项;宝石几何 60–200 切面。
- `fps`(最近 60 帧平均)≥30,相机过渡与导出期间不得明显掉帧。
- 导出必须读取当前画布像素,导出动作不得冻结主循环超过 200ms。

## 7. Runtime / Lifecycle

- 启动即呈现完整展示台并开始自转,默认色 diamond、`cameraDistance=10`、`exportCount=0`。
- `window.__appReady` 10s 内置 true;`window.__bench.getState()/reset()` 可用。
- `__bench.reset()`:色彩/相机/导出计数恢复初始(见 §4.5),转台相位可归零后继续运转;禁止页面刷新实现。
- 连续导出多次(≥2)功能稳定,无异常、无重复下载同名冲突(文件名可带序号或时间戳)。

## 8. Technical Constraints

- API 中立:实现自选模板给定引擎;本 Brief 只描述观感与行为,不指定材质实现路径(实时折射/环境贴图采样/屏幕空间技法均可,以观感达成论)。
- `getState()` 字段名严格遵守 stateContract(见 spec.json):`rotationAngle`(number,累计度数,单调增)/`selectedColor`(色名 string)/`cameraDistance`(number,默认 10)/`exportCount`(integer ≥0)。
- 双击推近必须是取景相机的真实位置移动(相机-宝石距离变化),禁止用视口缩放或 DOM 变换冒充。
- 导出必须为真实浏览器下载事件(harness 以 download 事件与文件大小为独立观测),禁止弹窗或仅内存生成不触发下载。
- 画布视口 1280×720(探针坐标系);探针动作仅 wait/click/pointermove/wheel/key/dblclick/drag 或 UI 控件(`data-bench`)。
- 视觉断言区域(归一化矩形):全屏 full={0,0,1,1};宝石中心区 gem={0.36,0.26,0.28,0.42}。

## 9. Completion Contract

统一契约(所有产物工程):

```
npm run build PASS(退出码 0)
页面可启动
无未捕获异常
window.__appReady === true(10s 内)
window.__bench = { getState(): object, reset(): void }
```

场景级增加:

- behavior validators:转台角速度 ≥25°/s 且 rotationAngle 单调增;色板切换状态与画面同步;双击往返 cameraDistance 阈值正确。
- visual validators:折射/反射/色散观感、三点布光层次、构图居中(截图 + 盲评,此场景为视觉权重最高场景之一)。
- interaction validators:色样点击、双击推近/拉回、导出按钮点击均触发对应状态与画面变化。
- asset/export validators:PNG 下载事件可观测,文件 >10240 字节,与画布分辨率一致。
- lifecycle validators:reset 恢复初始;连续两次导出 exportCount 正确递增。

## 10. Forbidden Shortcuts

1. 禁止用未加工的漫反射材质 + 平面贴图冒充折射/反射(必须有实时折射/反射观感:环境采样、折射变形或等价技法)。
2. 禁止色散靠在贴图里烘焙固定彩虹条纹冒充(火彩须随转台/视角变化流动)。
3. 禁止导出内嵌预置 PNG(base64 静态文件)冒充截图;导出像素必须来自当前画布。
4. 禁止双击推近用视口/样式缩放冒充相机移动。
5. 禁止 rotationAngle 返回与画面转台不一致的值(含返回常数)。
6. 禁止 exportCount 无真实下载而递增。
7. 禁止 reset 通过 location 刷新实现。
