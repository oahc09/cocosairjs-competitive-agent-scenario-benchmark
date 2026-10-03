# E07 霓虹夜城 — Frozen Brief

| 元数据 | 值 |
|---|---|
| briefId | E07 |
| briefVersion | 1.0.0 |
| frozen | true |
| frozenAt | 2026-10-02T00:00:00Z |
| briefSha256 | computed-by-harness |
| domains | Instancing / Emission / Animation / Atmosphere / Scale |

## 1. Goal

在单个页面应用中呈现一座夜间的霓虹城市:大规模实例化楼群、楼体发光窗阵、沿街道移动的车流光点、下落雨粒子与距离雾,整体保持霓虹夜景氛围且帧率不低于 30fps。本场景测大规模实例化、发光(自发光)表现、持续动画、氛围(雾/雨)与规模性能。

## 2. Visual Direction

- 低角度仰视城市天际线的取景,画面下 1/3 为街道层,上 2/3 为楼群与夜空。
- 夜色基调(深蓝黑),霓虹招牌与楼体边缘光使用至少 3 种高饱和色相(如品红/青/橙黄)。
- 楼体窗户为暖色/冷色混合的点阵光,窗格结构可辨识(矩阵排布),非大面积无结构光板。
- 车流为街道上移动的发光点/短拖尾,成流成线;雨为细密的短线或点粒子,整体有速度感。
- 距离雾使远处楼群亮度与对比明显衰减,近处楼体清晰,形成纵深。
- 画面不得出现裸露的默认背景色大面积空白、破面、闪烁撕裂。

## 3. World Composition

1. 楼群:≥200 栋程序化生成的楼体,高度、 footprint、位置有变化,网格化街区布局,允许少量高塔与矮楼;楼体本身为暗色体块。
2. 发光窗阵:每栋楼至少 8 个发光窗点,全场景窗点总数 ≥2000;窗户呈矩阵排布,点亮分布有随机性。
3. 车流:≥60 辆车沿街道(至少 2 条横穿画面的主干道或网格)连续同向/对向移动,车身以发光点或亮块表现,头灯/尾灯色可区分。
4. 雨:≥1500 个下落粒子,持续循环下落,粒子在落到地面高度后重生于顶部。
5. 雾:启用距离雾,雾色与夜空协调;雾浓度对远处楼群产生肉眼可辨的衰减。
6. 霓虹氛围:至少 3 处霓虹元素(招牌/楼体描边灯带/广告牌),高饱和色,可闪烁或呼吸。
7. 天空:近黑的夜空,允许少量星点或薄云,不得喧宾夺主。

## 4. Interaction & Feedback

本场景以氛围与规模为主,交互为最小集,但必须存在且可用:

1. 雾开关(UI 控件 `data-bench="toggle-fog"`):点击切换雾的启用/停用,状态 `fogEnabled` 与画面立即同步(远处楼群对比度变化)。
2. 重置按钮(UI 控件 `data-bench="reset"`):调用应用内重置,恢复初始计数与开关,不得整页刷新。
3. 控件需有 hover/active 视觉反馈,位于画布边缘固定位置,不遮挡天际线主体。

## 5. Asset Contract

- 无共享资产要求(assets 数组为空);楼群、车流、雨、霓虹全部程序化生成。
- 允许使用实现者自制的程序纹理(如窗阵发光贴图),但窗格矩阵结构必须可辨识。

## 6. Scale & Performance

- 楼 ≥200(建议 220–260);车 ≥60(建议 64–96);雨粒子 ≥1500(建议 1800–2500);窗点总数 ≥2000。
- 大批量元素(楼、窗、车、雨)必须以实例化/批量绘制方式提交,禁止逐个体发起大量独立绘制。
- `fps`(最近 60 帧平均)在满规模运行时 ≥30;`npm run build` 后的产物即评测规模,不得为跑分缩小规模。

## 7. Runtime / Lifecycle

- 启动后自动构建城市并开始车流/雨/霓虹动画,无需用户操作即进入完整运行状态。
- `window.__appReady` 在页面加载后 10s 内置 true;此后 `window.__bench.getState()` 可用。
- `__bench.reset()`:重建/恢复初始场景(计数、雾开关、动画相位),reset 不允许通过页面刷新实现。
- 长时间运行(≥120s)不得出现粒子泄漏、帧率持续衰减或未捕获异常。

## 8. Technical Constraints

- API 中立:实现自选模板给定引擎,本 Brief 只描述图形领域需求。
- `getState()` 返回纯 JSON 可序列化对象,字段名严格遵守 stateContract(见 spec.json):`buildingCount`/`carCount`/`rainParticleCount`/`fogEnabled`/`fps`。
- `fps` 必须来自真实帧间隔测量(滚动窗口平均),禁止返回常数。
- 画布视口 1280×720(探针坐标系);探针动作仅 wait/click/pointermove/wheel/key/dblclick/drag 或 UI 控件(`data-bench`)。
- 视觉断言区域(归一化矩形):全屏 full={0,0,1,1};街道层 lower={0,0.62,1,0.38};天际线上部 upper={0,0,1,0.45}。

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

- behavior validators:楼/车/雨计数达标且与画面一致;雾开关状态与画面一致。
- visual validators:楼群、窗阵、车流、雨、雾、霓虹六要素均可辨识(截图 + 盲评)。
- interaction validators:雾开关点击后 `fogEnabled` 翻转且上部区域像素变化。
- lifecycle validators:reset 后 `buildingCount/carCount/rainParticleCount/fogEnabled` 恢复初始值;运行 120s 无异常。

## 10. Forbidden Shortcuts

1. 禁止用预渲染视频、序列帧、GIF 或外部大图充当场景。
2. 禁止用 DOM/CSS 2D 伪 3D 充当场景主体。
3. 禁止把全部窗光做成无窗格结构的大面积自发光色块(允许发光贴图,但必须呈现窗格矩阵形状)。
4. 禁止 fps 造假:getState 的 fps 必须来自真实测量,不得返回常数或与实际帧率无关的值。
5. 禁止 getState 与画面脱钩(例如画面无车而 carCount ≥60)。
6. 禁止为通过探针临时提升规模,探针结束后回落("探针模式")。
7. 禁止 reset 通过 location 刷新实现。
