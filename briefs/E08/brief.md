# E08 深海鱼群 — Frozen Brief

| 元数据 | 值 |
|---|---|
| briefId | E08 |
| briefVersion | 1.1.0 |
| frozen | true |
| frozenAt | 2026-10-02T00:00:00Z |
| briefSha256 | computed-by-harness |
| domains | Simulation / Interaction / Procedural body / Particles / State |

> v1.1.0 (2026-10-24): 澄清性升版——§4 增补交互时序契约(惊散持续/重聚时限/投喂采样点/食物消耗节奏)并新增 §11 交付前时序自检;探针判据零改动。详见 spec.json amendments。

## 1. Goal

呈现深海中的鱼群仿真:≥80 条程序化生成的鱼按 boids 三规则(聚集 aggregation、对齐 alignment、分离 separation)游动;鼠标接近时惊散,离开后重聚;点击水面投喂,鱼群向食物点聚集;背景有持续漂浮的悬浮颗粒。本场景测实时群体模拟、指针交互、程序化形体、粒子与状态管理。

## 2. Visual Direction

- 深海暗蓝绿色调,光线自上而下衰减(深度渐变),营造水下体积感。
- 鱼群为暖银/青灰色的个体群,常态下聚成一团或多团,整体朝向趋同,边缘个体不穿插。
- 鼠标惊散瞬间鱼群炸开,个体向四周逃逸,有急转与加速感;重聚过程可见回漩。
- 食物为发光的小颗粒(数粒),下落或悬浮,鱼群围绕食物点形成密集球。
- 悬浮颗粒(浮游生物/尘埃)细小、缓慢漂移,近大远小,增强纵深。
- 相机:水下中景,视野覆盖整个活动水域,鱼群始终在取景框内。

## 3. World Composition

1. 水域:一个有边界的可见水体(隐式或弱化边界均可),鱼群活动被约束在相机可见体积内,不得游出画面外消失。
2. 鱼群:≥80 条鱼,个体为程序化形体(分节身体 + 尾鳍,随速度摆尾形变或等价表现),禁止用无体积的纯色平面片充当。
3. boids 模拟:逐帧计算聚集/对齐/分离三规则;邻域搜索可用朴素两两比较(80 条规模)或空间划分,帧率须达标。
4. 悬浮颗粒:≥300 个缓漂粒子,长时间存在并有轻微漂浮运动。
5. 深海光效:顶部光束/体积光衰减观感(允许渐变+雾),配合水下色调。
6. (可选)远景剪影鱼群或海床轮廓,不参与模拟。

## 4. Interaction & Feedback

1. 鼠标惊散:指针进入画布且与任一鱼距离小于惊散半径(建议 2.5 世界单位,状态可见 `boidMode` 变为 `scatter`)时,受影响个体沿远离指针方向加速逃逸;惊散期间 `avgCohesion` 显著下降。
2. 重聚:指针离开惊散范围或静止超过 2s 后,`boidMode` 回到 `normal`,鱼群在 5s 内重新聚集(`avgCohesion` 回升到常态阈值)。
3. 点击投喂:在画布上单击,于该点对应的水域位置生成食物颗粒(1–5 粒),`foodActive=true`、`foodPosition` 记录世界坐标;鱼群受食物吸引向其聚集,`avgDistanceToFood` 随时间下降;食物被吃尽(或 ≥8s 超时)后消失,`foodActive=false`。
4. 重置按钮(UI 控件 `data-bench="reset"`):清除食物、恢复 normal 模式与初始鱼群分布;不得整页刷新。
5. 光标在水域内时应有涟漪/微光等指针反馈(可选加分,不强制)。

**交互时序契约(由 spec.json 探针的采样点语义决定,必须满足)**
- E08 探针为单采样制(像素坐标系,1280×720),采样点链:P1 约 5s、P3 拖拽后 1.2s、P4 指针移到角落 (20,20) 后 6s、P5 点击投喂后 800ms、P6 投喂后约 4.8s、P7 reset 后 2s。
- 惊散:P3 在拖拽结束后 1.2s 采样要求 boidMode == "scatter" 且 avgCohesion < 0.35——**惊散状态须在指针停止移动后维持 ≥2s** 才允许回 normal(§4.2 语义),不得指针一停就重聚。
- 重聚:P4 在指针移出后 6s 采样要求 normal 且 avgCohesion ≥ 0.45——重聚须在 ~5s 内完成(建议 3–4s,留采样余量)。
- 投喂:P5 在点击后 800ms 采样要求 foodActive == true(食物即时出现);P6 在投喂后约 4.8s 采样要求 `avgDistanceToFood` **非 null 且 < 6**——鱼群吸引须在 ~4s 内把平均距离压进 6 单位,且**食物不得在该采样点前被吃尽**(渐进消耗,或以 §4.3 的 8s 超时兜底),否则 avgDistanceToFood 变 null 必 FAIL。
- reset:P7 在 reset 后 2s 采样,要求食物清除、normal 模式、计数恢复——瞬时恢复即可,reset 后模拟立即继续(P8 有运动断言)。

## 5. Asset Contract

- 无共享资产要求(assets 数组为空);鱼体、食物、颗粒全部程序化生成。
- 鱼形体可由简单几何分段组合 + 蒙皮式弯曲或顶点形变实现,关键是有体积与摆动感。

## 6. Scale & Performance

- 鱼 ≥80(建议 80–120);悬浮颗粒 ≥300(建议 300–600);食物颗粒每次投喂 1–5 粒。
- boids 为逐帧实时模拟,禁止预烘焙轨迹或固定路径巡游。
- `fps`(最近 60 帧平均)≥30;个体数与状态 `fishCount` 一致。

## 7. Runtime / Lifecycle

- 启动即生成鱼群并进入 normal 模拟,无需用户操作。
- `window.__appReady` 10s 内置 true;`window.__bench.getState()/reset()` 可用。
- `__bench.reset()`:清除食物、boidMode 回 normal、鱼群回初始分布、恢复初始计数;禁止页面刷新实现。
- 长时间运行(≥120s)无内存/实体泄漏(计数不增长、帧率不衰减)、无未捕获异常。

## 8. Technical Constraints

- API 中立:实现自选模板给定引擎,Brief 只用图形领域语言。
- `getState()` 字段名严格遵守 stateContract(见 spec.json):`fishCount`/`planktonCount`/`boidMode`("normal"|"scatter")/`foodActive`/`foodPosition`({x,y,z}|null)/`avgCohesion`(0–1)/`avgDistanceToFood`(number|null)。
- `avgCohesion` 定义:1 − min(1, 鱼群个体到鱼群质心平均距离 / 10);常态聚群典型 ≥0.45,惊散典型 <0.35(供探针阈值参考)。
- 惊散必须基于指针与鱼的实际距离判定,不得用定时器或固定脚本触发。
- 画布视口 1280×720(探针坐标系);探针动作仅 wait/click/pointermove/wheel/key/dblclick/drag 或 UI 控件(`data-bench`)。
- 视觉断言区域(归一化矩形):全屏 full={0,0,1,1};中央水域 center={0.3,0.25,0.4,0.5}。

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

- behavior validators:三规则同时生效(常态内聚达标、朝向趋同、无穿插);惊散/重聚模式切换正确;投喂-聚集闭环成立。
- visual validators:鱼群形体有体积与摆尾;惊散炸开与重聚回漩可辨识;食物颗粒可见。
- interaction validators:指针接近触发 scatter;单击产生 foodActive=true 且鱼群靠近食物。
- lifecycle validators:reset 后 boidMode=normal、foodActive=false、fishCount 恢复;120s 无泄漏无异常。

## 10. Forbidden Shortcuts

1. 禁止鱼群沿预定义路径/预烘焙动画巡游(必须是逐帧 boids 模拟)。
2. 禁止用广告牌贴图数量或纯 DOM 元素冒充 3D 鱼体(fishCount 必须与画面个体一致)。
3. 禁止用定时器或脚本化触发器代替基于指针距离的惊散判定。
4. 禁止 avgCohesion/boidMode 与画面脱钩(状态说 scatter 而鱼群纹丝不动即违规)。
5. 禁止把食物做成无法被吃掉的永久装饰(foodActive 语义必须真实)。
6. 禁止 getState 返回与模拟无关的硬编码值。
7. 禁止 reset 通过 location 刷新实现。

## 11. 交付前时序自检(探针采样点)

任何一条不满足即视为未完成;判据细节以 spec.json 为准。

1. P1(加载后约 5s):鱼 ≥ 80、颗粒 ≥ 300、normal 模式、无食物;水下场景非空。
2. P2(2s 窗):avgCohesion ≥ 0.45(常态聚群),中央水域持续游动。
3. P3(拖拽后 1.2s):boidMode == "scatter" 且 avgCohesion < 0.35——惊散在指针停止后维持 ≥2s。
4. P4(指针移出后 6s):normal 且 avgCohesion ≥ 0.45(重聚 ≤5s 完成)。
5. P5(投喂后 800ms):foodActive == true、foodPosition 非 null,食物出现在点击水域附近。
6. P6(投喂后约 4.8s):avgDistanceToFood 非 null 且 < 6——食物未被提前耗尽。
7. P7(reset 后 2s):食物清除、normal、鱼群完整计数恢复。
8. P8(reset 后 1.5s):模拟继续(鱼群 + 颗粒运动像素 ≥ 2%),无未捕获异常。
