# E10 动画角色展示空间 — Asset / Lifecycle Frozen Brief

| 元数据 | 值 |
|---|---|
| briefId | E10 |
| briefVersion | 1.0.0 |
| frozen | true |
| frozenAt | 2026-10-02T00:00:00Z |
| briefSha256 | computed-by-harness |
| domains | GLB / Skeleton / Animation / Instance isolation / Material / Scene graph / Lifecycle |

## 1. Goal

在展示空间中运行时(runtime)加载带骨骼与动画的角色资产 `assets/character.glb`,呈现**双实例**且**两实例动画状态完全独立**(一个 Walk 一个 Idle 互不影响),支持 Idle/Walk 切换、正确的材质与灯光、销毁实例 A 后实例 B 继续正常动画,reset 后恢复双实例。本场景测 GLB 加载、骨骼蒙皮动画、实例隔离、材质、场景图与对象生命周期,是与 Code First / Runtime Asset 路线高度相关的核心场景。

## 2. Visual Direction

- 中性展示空间:柔和渐变背景 + 地面(展台/地坪),干净不喧宾夺主。
- 角色居中偏左(实例 A)与偏右(实例 B)并排站立,两实例间留出明确间距,均在取景框内。
- 灯光:键光 + 补光 + 逆光的三点格局,角色明暗层次分明,地面有接触阴影或明暗过渡。
- 材质正确:角色贴图/颜色分区正确(皮肤/服装/毛发等分区颜色合理),无缺省纯色(如品红)、无丢失贴图的白模、无双实例间材质串扰。
- Walk 与 Idle 动作差异明显可辨:Walk 有下肢迈步与手臂摆动,Idle 为原地小幅度呼吸/待机动作。
- 相机:中景平视,轻微俯仰即可,双实例完整入画。

## 3. World Composition

1. 角色实例 A:加载自 assets/character.glb,初始播放 Idle,位于画面左侧站位。
2. 角色实例 B:同一资产派生的第二个实例,初始播放 Idle,位于画面右侧站位。
3. 展示空间:地面 + 背景 + 简单氛围(地坪光斑或渐变),可选展台圆盘。
4. 灯光:三盏有向光 + 环境光,构成三点布光格局。
5. UI 控件组(画布边缘,均带 `data-bench` 属性):
   - 实例 A 动画切换:`anim-a-idle` / `anim-a-walk`(两个按钮或一个切换钮,规范见 §4.1);
   - 实例 B 动画切换:`anim-b-idle` / `anim-b-walk`;
   - 销毁实例 A:`destroy-a`;
   - 重置:`reset`。

## 4. Interaction & Feedback

1. 动画切换:点击 `anim-a-walk` → 仅实例 A 切到 Walk,实例 B 保持原动画;点击 `anim-b-walk` → 仅实例 B 切换。切换为即时响应(<= 300ms 内开始过渡),带淡入淡出或直接切换均可。**两实例动画状态必须隔离:切换 A 不得影响 B 的剪辑与播放时间,反之亦然。**
2. 销毁实例 A:点击 `destroy-a` → 实例 A 从画面移除并释放其实例资源(从场景图移除;仅设为不可见不算销毁),`instanceCount` 变 1,`destroyedInstance="A"`;实例 B 不受任何影响。
3. 重置:点击 `reset` → 双实例恢复(实例 A 重建),两实例回到 Idle 初始状态,`destroyedInstance=null`、`resetCount`+1;reset 必须应用内重建,**不得触发新的 assets/character.glb 网络请求**(资产已加载,实例由缓存数据派生),不得整页刷新。
4. 按钮需有 hover/active 反馈;销毁按钮在实例 A 已销毁时置灰或无效。

## 5. Asset Contract

- 共享资产**必需**:`assets/character.glb`(`required: true`,由共享资产管线提供,sha256 由 harness 计算冻结)。
- 资产期望规格:
  - 人形或类人角色,含**蒙皮骨骼**(多关节骨架,建议 ≥15 个骨骼关节);
  - **至少 2 个动画剪辑**:Idle(原地待机)与 Walk(行走);clip 命名不限,应用需映射为规范名 `idle` / `walk` 暴露在状态中;
  - 内嵌或引用材质与贴图,加载后即正确显示;建议身高 1.5–1.8 单位、面数 ≤ 50k、文件 ≤ 10MB;
  - 标准 GLB,GLTF 2.0,含 skin 与 animations 区块。
- 运行时加载:应用必须以相对路径 `assets/character.glb` 发起网络请求加载(harness 观测该请求与 200 响应);整个会话(含 reset)对该文件的请求**只允许发生一次**。
- 双实例必须由同一次加载的资产数据派生(实例化/克隆),两实例动画状态独立;禁止通过二次网络加载同一 GLB 制造"双实例"。

## 6. Scale & Performance

- 场景规模:2 个蒙皮角色实例 + 地面/背景 + ≤6 盏灯。
- `fps`(最近 60 帧平均)≥30,双实例同时骨骼动画时亦须达标。
- 销毁实例 A 后帧率不得下降、内存不得继续增长;120s 连续运行无泄漏、无异常。

## 7. Runtime / Lifecycle

- 启动流程:页面就绪 → 请求并加载 GLB → 建立双实例 → 两实例开始播放 Idle → `window.__appReady = true`(10s 内);`assetLoaded` 在 GLB 解析完成且实例就绪后为 true。
- `window.__bench.getState()/reset()` 随契约可用。
- 生命周期事件链:创建 A/B → 独立动画 → 销毁 A(B 存活且动画继续)→ reset 重建 A/B。每一步状态字段语义准确(见 §8)。
- `__bench.reset()` 与 UI `reset` 按钮行为一致:`resetCount`+1、恢复双实例 Idle、不重新请求资产、不刷新页面。

## 8. Technical Constraints

- API 中立:实现自选模板给定引擎,Brief 只描述资产、骨骼动画、实例与生命周期需求。
- `getState()` 字段名严格遵守 stateContract(见 spec.json):
  - `assetLoaded`:boolean,GLB 加载完成且实例就绪;
  - `instanceCount`:integer,存活实例数(0–2);
  - `instances.A` / `instances.B`:对象 `{ clip: "idle"|"walk", time: number }`,time 为当前剪辑播放时间(秒,随播放推进,循环剪辑回绕允许);实例被销毁后该字段为 `null`;
  - `destroyedInstance`:`null` | `"A"`;
  - `resetCount`:integer,reset 执行次数。
- 骨骼动画必须播放 GLB 内的动画剪辑驱动蒙皮(禁止把动作烘焙成形态键序列或位置补间冒充)。
- 画布视口 1280×720(探针坐标系);探针动作仅 wait/click/pointermove/wheel/key/dblclick/drag 或 UI 控件(`data-bench`)。
- 视觉断言区域(归一化矩形):实例 A 区 instanceA={0.08,0.15,0.34,0.8};实例 B 区 instanceB={0.58,0.15,0.34,0.8}。
- harness 独立观测:加载探针检查对 `assets/character.glb` 的网络请求;reset 探针检查无重复请求。

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

- asset validators:对 assets/character.glb 的网络请求可观测(200),整会话仅一次;assetLoaded 与像素证据一致。
- behavior validators:双实例动画播放中(time 推进 + 视觉运动);A 切 Walk 而 B 保持 Idle 的隔离证据;销毁 A 后 B 动画继续。
- lifecycle validators:销毁 A → instanceCount=1、画面移除;reset → 双实例恢复、resetCount 递增、无新资产请求。
- visual validators:材质正确(无缺省色/无串扰)、三点灯光、双实例完整入画。
- state validators:所有字段随事件即时更新,无与画面脱钩。

## 10. Forbidden Shortcuts

1. 禁止用形态键/顶点序列/位置补间冒充骨骼蒙皮动画(必须由 GLB 动画剪辑驱动骨骼)。
2. 禁止二次网络加载同一 GLB 制造双实例(实例必须由单次加载数据派生,动画状态独立)。
3. 禁止"销毁"仅设为不可见(必须从场景图移除并释放实例资源,instanceCount 与画面一致)。
4. 禁止 reset 通过 location 刷新或重新请求资产实现。
5. 禁止 instances.A/B 的 clip/time 与画面脱钩(状态说 Walk 画面在 Idle 即违规)。
6. 禁止用简单几何假人 + 程序化摆动冒充 GLB 角色(必须渲染 GLB 网格与材质)。
7. 禁止在销毁实例 A 时静默销毁/重置实例 B(实例隔离是本场景核心观测点)。
