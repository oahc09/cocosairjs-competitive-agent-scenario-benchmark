# Cocos AIR 与 Three.js r186：能力差异与开发路线图

> 审计日期：2026-09-26  
> 比较对象：`E:/AIProMax/github/cocosair.js`（`cocosair.js@1.0.0`）与 `three.js-r186`（`three@0.186.1`）  
> 结论口径：按本地源码、产物、公开入口、文档、示例和测试静态审计；**未运行构建或测试**。Three.js 的 addon 与核心能力已明确分层，避免将生态模块误算为主包能力。

## 1. 结论先行

Cocos AIR 已不是“缺少 3D 基础能力的起步项目”。它已经具备 Web 运行时、Cocos 组件体系、WebGL 渲染、PBR、glTF/GLB、骨骼动画、2D/UI、音视频、2D/3D 物理等较完整的**互动应用运行时**能力，且 TypeScript 声明、Code First 启动和工程门禁是其可差异化的基础。

但它目前还不能定位为 Three.js 的通用平替，核心原因不是 Box、Mesh、PBR 等基础 API，而是以下五个“迁移阻塞面”：

1. **运行模型不兼容**：Cocos AIR 是 `Game/Director/Scene/Node/Component` 运行时；Three.js 是 `Scene/Object3D/WebGLRenderer` 组合。直接迁移既有 Three.js 代码的成本很高。
2. **WebGPU 与节点材质缺口**：Three.js r186 已有官方 `three/webgpu`、`three/tsl` 入口；Cocos AIR 有 WebGPU 源码存量，但未成为可发布、可类型检查、可验证的公开能力。
3. **开放生态缺口**：Three.js 的官方 addon 提供大量格式加载/导出、控制器、后处理、XR 工具；Cocos AIR 当前正式资产主线几乎只聚焦 glTF。
4. **默认可用性缺口**：Cocos AIR 的后处理、部分物理和高级功能虽存在源代码或 feature，但在默认 Code First 路径中不可直接、稳定地使用。
5. **Agent 可操作性尚未产品化**：已有“Agent-first”定位与较强验证工具，但缺少机器可读能力契约、稳定的场景描述语言、可执行诊断协议和 Agent 专用示例/评测闭环。

因此建议采用“双轨而非硬仿”的策略：

- **兼容轨**：优先覆盖高频 Three.js 迁移面，提供可选的 Three 风格 facade / 适配器，而不是试图重写 Three.js。
- **原生轨**：把 Cocos AIR 做成可被 AI Agent 安全生成、验证、调试和迭代的“交互式 3D 运行时”，用组件系统、资源生命周期、2D/UI/音视频与物理整合形成差异化。

近期目标不应是“100% API 平替”，而应是：**在 WebGL2/WebGPU 浏览器场景中，让 80% 的典型 Three.js 产品级用例可以低摩擦迁移或由 Agent 从零生成，并且得到可重复的视觉与行为验证。**

---

## 2. 比较口径与证据

### 2.1 发布形态

| 项目 | Cocos AIR | Three.js r186 | 判断 |
|---|---|---|---|
| 包版本 | `cocosair.js@1.0.0` | `three@0.186.1` | 本地快照 |
| 主入口 | `build/cocosair.module.js` + `.d.ts` | `build/three.module.js` / `build/three.cjs` | AIR 的 TypeScript 消费体验更完整 |
| 子路径导出 | 当前主要只有根入口 | `three`、`three/addons`、`three/webgpu`、`three/tsl` | Three 的产品分层与按需导入更成熟 |
| 运行模型 | `createAirApp()` → `Game/Director/Scene/Node/Component` | `Scene/Object3D` + `WebGLRenderer.render()` | 不能按类名直接视为兼容 |
| 目标平台 | 浏览器 Web；WebGL2 + WebGL1 回退 | 浏览器；WebGL2 主路径，WebGPU 独立入口且可回退 WebGL2 | AIR 应停止将 WebGL1 视为未来核心投入 |
| 公开运行时导出 | 已审计 bundle 有 575 个导出名 | 主入口 444；WebGPU 635；TSL 682 | 数量不等于能力；Three 的多入口可组合面更大 |

**关键证据**：

- AIR：`E:/AIProMax/github/cocosair.js/package.json`、`src/air/bootstrap.ts`、`src/air/app.ts`、`src/exports/air.ts`
- Three：`three.js-r186/package.json`、`src/Three.js`、`src/Three.WebGPU.js`、`src/Three.TSL.js`

### 2.2 审计边界与风险

- Cocos AIR 工作区审计时已有未提交修改，集中于 API 覆盖、示例清单和验证工具；报告不把这些动态证据当作稳定发布结论。
- AIR README 内“58 个主示例”等历史口径，与当前 `examples/files.json` 的 145 条 manifest 存在不一致；需先统一事实源。
- Three.js 本地源码树没有 TypeScript 源码或官方 `.d.ts`；其 API 工程质量体现在 JSDoc、文档、模块边界、测试和生态，而非本仓库自带 TS 声明。
- 未实际运行浏览器矩阵、WebGPU、设备 XR 或性能测试；涉及“可用”的表述均指源码/入口层面的可用性，不是本机运行认证。

---

## 3. 横向能力差异列表

标记：**领先** = 对目标定位更有优势；**对等** = 已具备相近的核心能力；**部分** = 有代码或功能，但默认交付/验证/生态未完整；**缺口** = 无稳定公开入口或明显不足。

| 能力域 | Three.js r186 基线 | Cocos AIR 现状 | 差异等级 | 建议优先级 |
|---|---|---|---|---|
| 场景图与基础对象 | `Scene/Object3D/Group/Mesh`、实例化、LOD、Sprite、Points、Line、Raycaster | `Scene/Node/Component`、Camera、MeshRenderer、LOD 等 Cocos 模型 | **模型不同，不兼容** | P0 |
| WebGL 渲染 | WebGL2；WebGL1 自 r163 起不支持 | WebGL2 + WebGL1 回退 | **对等基础，AIR 多旧端兼容** | P2：逐步降级 WebGL1 |
| WebGPU | `three/webgpu` 正式入口，WebGPU 优先、可回退 WebGL2 | 有 `cocos/gfx/webgpu/**` 源码，但未接入默认构建、声明图和公开 API | **关键缺口** | P0 |
| 节点材质/可编程渲染 | `three/tsl`、Nodes、NodeMaterial，适配 WebGPU 路径 | Effect/Material 系统存在，未提供 Agent/开发者可组合的节点图或稳定 shader DSL | **关键缺口** | P0 |
| 几何与网格 | 21+ 核心几何；BufferGeometry 为主 | primitive、Mesh、程序化网格等 | **对等核心** | P1：补迁移 facade |
| PBR/材质/纹理 | Standard/Physical、18 类核心材质、丰富纹理类型 | Material、Texture2D/Cube、RenderTexture；glTF physical 扩展覆盖较广 | **对等至部分领先** | P1：能力清单与验收 |
| 透明传输/体积/色散 | 物理材质支持 | `AirTransmissionCapture` 支持但仅 WebGL2、需显式挂载，且有排序限制 | **部分** | P1：稳定化与降级 |
| 光照与阴影 | 多种灯、影子、CSM addon | 多灯种；阴影在手册中仍有 blocked/未充分交付表述 | **缺口** | P0 |
| 动画/骨骼/Morph | AnimationMixer、tracks、skinning | Animation、SkeletalAnimation；glTF TRS/Morph/Skin 支持 | **对等核心** | P1：导入回归测试 |
| 2D/UI/媒体/TileMap | 非 Three 核心强项，多依赖外围库 | 2D/UI、Graphics、Mask、TiledMap、音频、视频、WebView、DragonBones/Spine 路径 | **AIR 领先** | P1：产品化主卖点 |
| 物理 | 不内建；通过 Ammo/Jolt/Rapier addon 适配 | 2D Box2D；3D builtin + 可选 Cannon，Ammo/PhysX/wasm 未交付 | **AIR 有运行时优势但后端不足** | P1 |
| glTF/GLB | 官方 GLTFLoader addon，扩展丰富 | 内建 Air GLTFLoader、assetManager 路由、PBR/动画/扩展、压缩 decoder 可注入 | **对等核心，AIR 集成更深** | P0：质量/性能基准 |
| 通用资产格式 | 71 个 loader 相关 addon 模块：OBJ/FBX/USD/PLY/STL/EXR/HDR 等 | 正式主线是 glTF；未找到 OBJ/FBX loader | **生态缺口** | P1 |
| 资产导出 | glTF/USDZ/OBJ/STL/PLY/EXR/KTX2 等 addon exporter | 未形成对等导出层 | **缺口** | P2 |
| 后处理 | WebGL `EffectComposer` + 30 个模块；WebGPU `PostProcessing` | post-process API/代码存在，但默认 legacy Code First 管线无法消费，缺像素级交付 | **关键缺口** | P0 |
| 交互与控制 | Raycaster 核心；Orbit/Transform/Drag/PointerLock 等 9 类 controls addon | Cocos 输入体系存在，未形成 Three 风格开箱控制器和 gizmo 工具集 | **缺口** | P0 |
| WebXR | renderer XR 管理；AR/VR button、手、控制器、平面/光照 addon | 未找到 WebXR session、render loop、控制器公开 API | **缺口** | P2 |
| CSS2D/CSS3D/SVG | 官方 addon | 未形成对等公开层 | **选择性缺口** | P3：按客户需求 |
| 地形/3D 粒子 | 生态和示例成熟 | Terrain、默认 3D particle 均不属于当前可发布能力 | **缺口** | P2 |
| TypeScript/API 契约 | JSDoc 文档成熟；本树无 `.d.ts` | 发行包含 `.d.ts`，`strict` 配置但 `noImplicitAny: false` | **AIR 可领先** | P0：收紧与契约测试 |
| 文档、示例、测试 | 608 HTML 示例、829 API 页、254 单测文件、1,368 静态 QUnit case | 145 manifest 示例、32 smoke suites、3 类型测试；文档口径仍有漂移 | **生态/质量缺口** | P0 |

### 3.1 已具备、应立即对外强化的 AIR 能力

这些不需要等待“追平 Three.js”才可作为产品卖点：

1. **完整交互运行时而非纯渲染库**：Cocos 组件、生命周期、资源系统、UI、2D、音视频、WebView 和物理可在同一运行时组合。
2. **Code First + TypeScript 声明**：`createAirApp()`、ESM 包与 `.d.ts` 适合 Agent 生成可维护代码，而不是依赖编辑器资产。
3. **glTF 作为第一类资产路径**：加载、实例化、资源管理、PBR、骨骼和 Morph 不是薄适配层；应把 glTF 明确设为核心资产协议。
4. **物理与互动场景基础**：2D Box2D 和 3D Cannon 可选后端比 Three 的“外部物理适配”更接近完整应用运行时。
5. **可验证工程基础**：已有 build、typecheck、browser matrix、consumer、benchmark、release readiness 等门禁脚本；需要把它们升级为可消费的质量信号。

### 3.2 不建议直接追随的 Three.js 范围

| 方向 | 建议 |
|---|---|
| 全量类/API 复刻 | 不做。维护成本高，且会稀释 Cocos 的运行时优势。仅对高频迁移路径提供 facade。 |
| 把所有 addon 内置进主包 | 不做。采用核心包 + 官方 capability packs + 可选 peer 依赖，保持包体和心智模型可控。 |
| 把物理当作必须内建的竞争点 | 不做。AIR 应提供统一物理接口与首选后端，底层仍可采用可替换 adapter。 |
| 过早支持所有资产格式 | 不做。优先 glTF/GLB、HDR/EXR、KTX2、Draco、Meshopt 和一个业务驱动格式（OBJ 或 FBX），其余由转换链解决。 |
| WebGL1 长期兼容优先级高于 WebGPU | 不做。保留已有回退即可，新增渲染创新应优先 WebGPU/WebGL2。 |

---

## 4. 目标产品定义：从“平替”到“可迁移、可组合、可验证”

### 4.1 目标分层

| 层级 | 对用户的承诺 | 成功判据 |
|---|---|---|
| L1：Three Friendly | 常见 Three.js 示例可在低改动下迁移到 AIR | 30 个高频用例有迁移指南、代码样例和视觉回归 |
| L2：Interactive Runtime | 3D 产品可原生接入 UI、输入、动画、音视频、物理和资源生命周期 | 5 个典型应用模板可独立完成，不依赖 Creator |
| L3：Agent-Native Runtime | Agent 能查询能力、生成项目、执行验证、定位失败并安全修复 | 标准任务集首轮成功率、自动验证率、修复闭环率持续可测 |

### 4.2 AI Agent 时代的差异化原则

1. **机器可读胜过只给人读的文档**：每个公开能力必须有 JSON schema、版本、依赖、平台/后端限制、最小示例、验证命令和已知限制。
2. **意图 API 胜过引擎内部 API**：提供 `createModelViewer`、`createProductConfigurator`、`createPhysicsSandbox`、`attachOrbitControls` 等组合式入口，底层仍可使用 Cocos 原生对象。
3. **可验证胜过“看起来能跑”**：代码生成后应自动执行类型检查、场景静态检查、截图/像素断言、性能预算和能力兼容性检查。
4. **安全修复胜过自由修改**：Agent 操作应有 dry-run、diff、受控资产白名单、版本锁定与回滚点，避免直接破坏用户项目。
5. **把限制变成契约**：例如 transmission 仅 WebGL2、后处理仅特定 pipeline、Cannon 需要显式开启，都应由 API 和诊断在运行前报告，而不是运行后才暴露。

---

## 5. 下一步开发计划（详版）

> **编号与口径约定**：工作流编号 `W<阶段>.<序号>`，与 §8 Backlog 的 AIR-xxx 对应（见各表"Backlog"列）；`【状态】` 为 2026-09-26 快照；周数自 v1.0.1 启动日起算；估算按"1 名全职工程师 + Agent 工具链辅助"，单位人日，均为含验证的净工作量区间。
>
> **现状锚点（2026-09-26，证据链已刷新）**：引擎包 `1.0.0`（版本线重置后的基线，见 §6 版本线说明）；V1.1 正式证据 121/140 PASS（`completed=true`）；覆盖率真实基线 Core 244/963（25.3%）、Important 42/272（15.4%）、Advanced 137/3,130（4.4%），发布门禁 100%/90%/80% 维持 FAIL（按设计，属后续波次目标）；剩余 19 个失败全部为 `math-*` 示例的 `api-executed`（声明了从未执行的单元）；`spec-compliance-audit` 0 fail / 1 warn；glTF 扩展矩阵 `examples/gltf-catalog/capabilities.json` 已存在（21 个扩展、browser-evidence/smoke/cataloged 三级验证标注），是引擎级能力目录的模式样板。

### 5.0 滚动例行动作（每个双周波次固定执行，不分阶段）

任何特性波次结束时执行同一条验证链，产出即当期事实源；该链全部脚本已存在于仓库，缺的只是固定化与并发互斥约定：

| # | 动作 | 命令/脚本 | 产出 | 备注 |
|---|---|---|---|---|
| 1 | 重新生成 API 清单 | `npm run gallery:api` | `docs/example-api-inventory.json`（AST 生成，指纹幂等） | 拒绝覆盖含缺失声明的内容 |
| 2 | 规格结构门禁 | `node tools/examples/spec-validate.cjs` | `v11-spec-validate.json` | 须 145/145 frozen |
| 3 | 浏览器全量验证 | `NODE_PATH=<playwright> node tools/verify/v11-examples-verify.cjs` | `v11-examples-verified.json` + 截图 + 晋级/降级回写 | chromium 整批口径，~20 分钟；子集跑必须 `--out=`；**同一仓库同时只允许一个实例**（并发写会互毁证据文件） |
| 4 | 覆盖率报告 | `npm run verify:api-coverage` | `docs/api-coverage-report.json` | 指纹须与当期 bundle/清单一致 |
| 5 | 规格符合性审计 | `node tools/examples/spec-compliance-audit.cjs` | `v11-spec-compliance.json` | 0 fail 才算过 |
| 6 | 工作笔记更新 | `docs/release-coverage-work.md` | 新基线 + 本波 added/removed/stale | 多会话写前先读（共享工作树约定） |
| 7 | 发布面审计（视需要） | `npm run verify:release` | 全链 verdict | 里程碑出口前必跑 |

### 5.1 阶段 0：冻结事实与建立决策面 → v1.0.1（第 1–3 周，P0）

**目标**：让"现在能做什么"成为稳定、机器可读、可验证的真相；证据链全绿（140/140），能力面收敛为唯一口径。

**出口条件（= v1.0.1 门禁）**：① V1.1 证据 140/140 PASS；② 引擎级 `capabilities.json` + 一致性校验进 CI；③ 文档/manifest/README 零口径漂移；④ exports 子路径策略落地且 consumer 验证绿；⑤ 高风险 public API 类型契约测试就位；⑥ 30 个核心示例三引擎基线建立。注意：覆盖率 100%/90%/80% 门禁**不作为** v1.0.1 出口条件（否则阶段 0 无法按期关闭）——v1.0.1 的承诺是"知道自己稳定支持什么"，不是"全部覆盖"。

| 工作流 | Backlog | 任务分解 | 交付物 | 依赖 | 验收 | 估算 | 状态 |
|---|---|---|---|---|---|---|---|
| W0.0 覆盖波次 Wave-1：math 族清零 | AIR-002 延伸 | 逐例核对 19 个 `math-*` 示例的 `api-executed` 失败单元（如 `math.Vec2.add2f`/`divide2f`/`multiply2f`/`negative`）：a) 声明与实际调用不符 → 按 AST 清单修正 apiClaims；b) 声明正确但代码未执行 → 补示例行为；c) 单元本身不该由该例覆盖 → 迁移到归属示例。跑 §5.0 全链 | `v11-examples-verified.json` 达 140/140；`api-coverage-report.json` 刷新 | 无（清单/规格已对齐） | 全量验证 PASS=140，无降级 | 3–5 人日 | **未开始**（前置项已全部就绪） |
| W0.1 引擎级能力目录 | AIR-001 | ① 定义 schema（沿用 glTF 扩展矩阵字段并推广）：`id/name/tier(core·addon·experimental·blocked)/maturity/backend(webgl2·webgpu)/platform/limits/minExample/verifyCommand/evidence/knownLimits/errorCode`；② 数据源接入：AST 清单（tier 分母）、`examples/files.json`、`d.ts` 导出面、bundle export 子句、glTF 扩展矩阵、feature flags；③ 生成器 `tools/capabilities/generate.cjs` + 校验器 `check-consistency.cjs`；④ 挂入 `verify:release` | `docs/capabilities.json`（引擎级，唯一）+ 生成/校验脚本 | W0.0（分母稳定） | 四方（文档/声明/bundle/示例）交叉校验绿；每个公开能力可定位到最小示例与验证命令 | 5–8 人日 | 未开始（glTF 矩阵为样板） |
| W0.2 文档/统计口径收敛 | AIR-002 | ① README 清理"58/57"等历史硬编码，改为引用 manifest；② 排查 docs 内 stale 示例数/验证数引用（`v11-progress` 等）改链接不复制；③ 扩展 `verify:doc-refs` 覆盖新增文档 | 文档零漂移 + doc-refs 门禁扩容 | W0.1（引用能力 ID） | `verify:doc-refs` 绿；全文搜索无裸数字口径 | 2–3 人日 | **进行中**（manifest 145 已立为事实源） |
| W0.3 发布面收敛 | AIR-003 | ① `package.json` exports 增 `./addons`、`./experimental` 子路径；② 每个导出标注稳定性级别（与 W0.1 tier 同源）；③ 深层 import 扫描（无未声明路径）；④ tree-shake 验证（复用 `verify:consumer`/`verify:tarball-consumer`） | 新 exports 面 + 稳定性标注 + 消费端验证 | W0.1 | 每个导出属于唯一级别；consumer/tarball 验证绿 | 3–4 人日 | 未开始 |
| W0.4 类型契约强化 | AIR-001 延伸 | ① 盘点公共 API 的 `noImplicitAny` 风险面，收紧到显式白名单文件；② 为 core tier public API 补编译型契约测试（tsd 风格）；③ bundle export 子句 + `d.ts` diff 门禁（breaking change 检测） | 白名单 + 契约测试 + diff 门禁 | W0.3（导出面先定） | core tier 高风险 API 100% 有类型测试；人为删一个导出可让门禁变红 | 4–6 人日 | **部分完成**（AST 清单/静态·实例拆分已落地） |
| W0.5 核心示例三引擎基线 | — | ① 按能力域选 30 例（覆盖场景图/材质/光照/动画/glTF/UI/物理/输入各≥2）；② chromium 基线已有（121/140 全量链），补 firefox/webkit 基线（复用 v12 browser-matrix，非 chromium 必须显式 `--out=`）；③ 每例绑定性能预算采集（`verify:perf-lifecycle`）；④ 失败可定位到 W0.1 能力 ID | 30 例 × 3 引擎基线 + 预算文件 | W0.1 | 30 例三引擎 PASS；预算超标可报能力 ID | 4–6 人日 | **部分完成**（工具链齐备，基线未固化） |
| W0.6 v1.0.1 发布动作 | — | ① `package.json` 版本 `1.0.0 → 1.0.1`（重置后首个里程碑递增）；② 发布注记（能力面快照 + 已知限制）；③ `verify:release` 全绿复核 | v1.0.1 tag + 发布注记 | 全部 | §5.0 全链绿；门禁无 stale evidence | 1 人日 | 未开始 |

**优先修复项**（并行穿插）：文档/manifest 漂移（W0.2）、coverage stale evidence（W0.0 已消除）、默认 feature 与 `air.ts` 静态导出间的不可见差异（并入 W0.1 校验器）。

### 5.2 阶段 1：完成高频 Three.js 迁移面 → v1.0.2（第 4–11 周，P0）

**目标**：产品展示、模型浏览、交互场景、数据可视化原型可低摩擦迁移或由 Agent 从零生成。

**组织方式：双轨并行**——"facade 轨"（W1.1→W1.2→W1.3→W1.8）与"渲染能力轨"（W1.4/W1.5/W1.6/W1.7）互不阻塞，各自接入 §5.0 验证链；单人串行执行时整体顺延约 4 周。

| 工作流 | Backlog | 周次 | 任务分解 | 交付物 | 验收 | 估算 | 状态 |
|---|---|---|---|---|---|---|---|
| W1.1 facade 骨架 | AIR-009 | 4–5 | ① 新增 `cocosair/three-friendly` 子路径（独立包备选 `@cocosair/three-friendly`）；② `SceneAdapter`（隐藏 Node/Component 生命周期，最小 Scene API 面）；③ `RendererAdapter`（canvas/尺寸/像素比/动画循环/截图/渲染诊断统一入口）；④ `Object3DAdapter`（position/rotation/scale、父子树、visible、layers、name、userData） | facade 包骨架 + 3 个 adapter + 每模块"支持范围/差异"说明 | 每个 adapter ≥5 个迁移示例对（three 代码 ↔ AIR facade 代码）过类型检查与运行验证 | 8–10 人日 | 未开始 |
| W1.2 几何/材质/纹理助手 | AIR-009 | 5–7 | ① 高频对象映射表：Box/Sphere/Plane/Cylinder + MeshStandard/Physical ↔ AIR primitive/Material/PBR 参数逐字段对照；② Texture/envMap 创建与色彩空间语义；③ 差异点显式文档化（色彩管理、UV 约定、单位制） | 迁移助手 + 映射表文档 | 80% 高使用率对象组合可在 facade 下等价表达；差异均有文档条目 | 6–8 人日 | 未开始 |
| W1.3 Controls/Raycast 合同 | AIR-006 | 8–10 | ① Orbit/Map/PointerLock 三控制器（输入、焦点、销毁生命周期统一 API）；② Transform gizmo 最小集；③ Raycast 合同：坐标系、layer/filter、命中排序、事件派发；④ 全部走真实指针事件验证（复用 v11 interaction 通道） | `@cocosair/controls` 雏形（后续阶段 4 转正式包） | 三控制器 + gizmo + 拾取各 ≥3 例进 v11 证据链；销毁后无泄漏（lifecycle validator） | 10–12 人日 | 未开始 |
| W1.4 阴影正式化 | AIR-005 | 6–8 | ① 建立支持矩阵：shadow map 类型 × 灯型（方向/点/聚光）× 后端 × 性能模式；② 手册中 blocked/未交付表述逐条清除或落实；③ 提供默认配置（单方向光 + PCF 起步）；④ 阴影相关能力 ID 入 W0.1 目录 | 支持矩阵文档 + 默认配置 + 能力 ID | 10 个光照/阴影样例有跨浏览器像素基线；无 blocked 残留表述 | 6–8 人日 | 未开始 |
| W1.5 后处理 MVP | AIR-004 | 9–11 | ① 让默认 Code First pipeline 可挂 post-process（当前 legacy 管线不可消费是关键缺口）；② 交付顺序：tone mapping → AA（FXAA/SMAA）→ bloom → outline → SSAO；③ 每 pass 定义可组合 API、降级策略（后端/性能）、资源释放 | 后处理挂载点 + 首批 pass | 每 pass：可组合 API + 截图基线 + 释放测试；pipeline 默认路径可消费 | 8–12 人日 | 未开始 |
| W1.6 glTF 生产路径强化 | AIR-010 | 5–7 | ① Draco/Meshopt/KTX2 decoder 部署工具化（`build/gltf-decoders` 部署已有，补 CLI 与文档）；② 加载进度/取消/错误码/缓存策略固化（错误码已有 5 个：`GLTF_EXTENSION_UNSUPPORTED` 等，扩到加载生命周期）；③ Khronos 关键模型集回归纳入 §5.0 链 | decoder 部署 CLI + 错误码全集 + Khronos 回归 | Khronos 集通过率、加载/显存基线可追踪；decoder 缺失时错误码可诊断 | 5–7 人日 | **部分就绪**（扩展矩阵/decoder 部署已存在） |
| W1.7 HDR/环境光链路 | AIR-011 前置 | 10–11 | ① HDR/EXR loader + PMREM/IBL 可部署链路；② PBR 展示模板（阶段 4 的①号模板前置）开箱环境光 | HDR/EXR loader + IBL 链路 | PBR 展示模板无手工布光即可用；进入能力目录 | 4–6 人日 | 未开始 |
| W1.8 30 迁移案例与指南收口 | AIR-009 | 10–11 | ① 选定 30 个高频 Three.js 用例（对照官方示例使用频率）；② 每例产出：迁移前代码、迁移后代码、差异说明、自动验证样例（v11 通道）；③ 指南按 P0 API 覆盖度盘点 | 迁移指南 + 30 案例库 | >85% 案例自动视觉通过；P0 API 全覆盖 | 6–8 人日 | 未开始 |

**阶段验收（= v1.0.2 门禁）**：30 迁移案例 >85% 自动视觉通过；facade 各模块有支持范围说明与契约测试；阴影/后处理进入能力目录且证据链全绿；覆盖率波次按 §5.0 持续推进（不设硬数字，但 Core 档 verified 不得回退）。

### 5.3 阶段 2：WebGPU 与可编程渲染正式化 → v1.0.3（第 12–23 周，P0）

**目标**：把"源码存在"变成可发布、可回退、可诊断、可测试的 WebGPU 产品能力。`src/cocos/gfx/webgpu/**` 存量源码是起点而非完成态；本阶段交付以"入口 + 类型 + 后端协商 + 双后端测试 + 诊断"整体为准，不能只打开 feature。

| 工作流 | Backlog | 周次 | 任务分解 | 交付物 | 验收 | 估算 | 状态 |
|---|---|---|---|---|---|---|---|
| W2.1 RendererBackend 接口 RFC | AIR-007 | 12–13 | ① 定义能力接口：纹理/buffer/pipeline/compute/timestamp/XR/postprocessing；② WebGL2 后端从渲染核心中按接口抽取（行为等价重构，靠既有 140 例证据链兜底）；③ 差异进 capability negotiation，替换散落的 feature flag | RFC 文档 + 接口 + WebGL2 backend | 重构后 140 例全量验证零回退；接口有类型契约测试 | 8–10 人日 | 未开始 |
| W2.2 WebGPU 垂直切片 | AIR-007 | 14–16 | ① 接入既有 `gfx/webgpu` 存量，跑通 clear/triangle/常量缓冲/纹理采样；② adapter/feature/limit 探测与白名单；③ 与 W2.1 接口对接 | WebGPU backend 最小实现 | 最小切片在 Chromium/Edge 真机 PASS；不支持的 feature 有结构化原因 | 10–14 人日 | 未开始 |
| W2.3 后端选择与回退诊断 | AIR-007 | 17 | ① `backend: 'auto' \| 'webgpu' \| 'webgl2'` 公开配置；② `auto` 确定性回退规则（探测失败/白名单外/驱动黑名单）；③ 回退原因结构化输出（扩展错误码族：`RENDERER_BACKEND_*`，沿用 glTF 错误码模式） | 后端协商 + 诊断输出 | 回退原因可被 `doctor`/运行时读取；单测覆盖每条回退路径 | 4–5 人日 | 未开始 |
| W2.4 发布与类型闭环 | AIR-007 | 17–18 | ① `cocosair/webgpu` 稳定入口（或主包可选导入）；② 独立 typecheck/smoke/E2E；③ 发布产物审计扩展到 WebGPU 子图（杜绝 d.ts 有符号而 bundle 缺符号） | WebGPU 入口 + 审计规则 | 入口三件套（bundle/d.ts/示例）一致；产物审计绿 | 4–6 人日 | 未开始 |
| W2.5 Material Graph IR | AIR-007 延伸 | 18–21 | ① 定义 JSON 可序列化 IR + TypeScript builder（不复制 TSL 语法）；② 第一批节点：float/vector/color、纹理采样、normal、UV、time、数学、PBR 输入、简单后处理（承接 W1.5 的 pass 语义）；③ 同一 graph 编译到 GLSL 与 WGSL 双后端；④ 不支持节点在构建时报 capability ID + 降级路径 | Material Graph IR v1 + 双后端编译器 | 10 个材质图/后处理图样例双后端 PASS；含编译失败诊断与降级测试 | 14–18 人日 | 未开始 |
| W2.6 双后端基线与采集 | — | 21–23 | ① 选 20 个同场景建 WebGL2/WebGPU 双基线（视觉容差需显式定义，含 diff 工具）；② 自动采集 GPU adapter、feature、shader 编译结果、帧时间、资源泄漏；③ 全部进入能力目录（W0.1 schema 已预留 backend 字段） | 20 场景双基线 + 采集器 | 双基线成立且容差文档化；采集数据入 `verify:benchmark` 通道 | 8–10 人日 | 未开始 |

**阶段验收（= v1.0.3 门禁）**：20 个双后端场景基线成立；WebGPU 入口 typecheck/E2E 绿；任意不支持组合在**运行前**给出能力 ID 与回退原因（结构化），而不是运行后报错。

### 5.4 阶段 3：Agent-Native SDK 与工具链 → v1.0.4（第 4 周起与阶段 1/2 并行，持续，P0）

**目标**：让 Agent 对 AIR 的操作是"有协议、有边界、可复现"的工程行为。**排期方式**：不设整块周期，按每周 2–3 人日嵌入阶段 1/2 的波次；v1.0.4 收口在阶段 2 结束后 +4 周（约第 27 周），以 25 项 benchmark 达标为门禁。

| 工作流 | Backlog | 起始周 | 任务分解 | 交付物 | 验收 | 估算 | 状态 |
|---|---|---|---|---|---|---|---|
| W3.1 能力查询 | AIR-008 | 4 | ① `cocosair doctor --json`（CLI 骨架与退出码契约）；② 运行时 `getCapabilities()`；③ 三者与 W0.1 `capabilities.json` 同 schema 同源，杜绝口径分叉 | doctor CLI + getCapabilities | Agent 生成代码前可判定后端/格式/XR/后处理可用性；三处输出一致可校验 | 4–5 人日 | 未开始（依赖 W0.1 schema） |
| W3.2 AirSceneSpec | AIR-008 | 6 | ① JSON Schema + TS 类型双表示：节点/组件/资源/材质/交互/验证条件；② spec → 项目脚手架生成器；③ 运行时 → 诊断快照导出（与 DevToolsSession 既有 inspect 能力对接） | AirSceneSpec v1 + 双向工具 | 从 spec 生成可运行项目；运行时快照可回读为 spec 子集 | 8–10 人日 | 未开始 |
| W3.3 Agent CLI 命令集 | AIR-008 | 9 | `init`、`add-model`、`add-control`、`validate`、`capture`、`benchmark`、`migrate-three`；统一契约：每个命令 `--dry-run`、`--json`、稳定 exit code（0 成功/2 用法错/3 校验失败/4 能力不支持） | 七命令 CLI | 契约测试覆盖每命令；dry-run 不产生副作用（用例验证） | 10–12 人日 | 未开始（validate/capture 复用 W3.5） |
| W3.4 结构化诊断 | AIR-008 | 12 | ① 错误码总表：资源/渲染后端/材质/物理/生命周期/能力不支持六族（glTF 五码并入资源族）；② 每码绑定"原因 + 受影响能力 ID + 修复命令/文档链接"；③ 运行时与 CLI 共用一套错误对象 | 错误码注册表 + 诊断输出 | 常见失败（decoder 缺失、后端回退、材质编译失败）均有结构化诊断 | 6–8 人日 | 未开始（glTF 五码为样板） |
| W3.5 视觉验证服务化 | AIR-012 | 10 | ① 把 v11 验证器的截图/区域断言/交互脚本/性能预算能力抽为可编程服务（CLI/CI 可调）；② 输出结构化判定（含失败 validator 与能力 ID）；③ 保留现有整批口径，服务层只做单例/子集 | 验证服务 API | Agent 修改示例后可自动判定通过/失败；与整批证据互不破坏 | 8–10 人日 | 未开始（能力已在 v11 链内） |
| W3.6 知识包 | AIR-012 | 16 | ① 由 `capabilities.json` + AST 清单 + 示例库生成 LLM-friendly 文档：每 API 最小可运行示例、反例、限制、迁移关系；② 版本化发布（随包 `docs/*.json` 已在 files 清单内） | 生成器 + 知识包 | 选定任务集无需检索源码即可正确调用主路径（用 benchmark 对照组验证） | 6–8 人日 | 未开始 |
| W3.7 Agent Benchmark | AIR-012 | 20 | ① 25 任务集，分布：基础创建 5（旋转立方体/层级/克隆销毁）、资产 5（glTF 加载/Draco/KTX2/进度/错误处理）、交互控制 5（Orbit/拾取/触屏/键盘/焦点）、视觉后处理 4（材质切换/tone mapping/bloom/降级）、物理 3（刚体/碰撞/调参）、诊断跨端 3（性能诊断/WebGPU 回退/跨浏览器修复）；② 指标：首轮成功率、类型通过率、视觉通过率、人工修复行数、总耗时；③ 结果仪表板（静态 JSON → 页面） | 25 任务 + 计量 + 仪表板 | 首轮可运行率 >75%、自动验证率 >70% 收口 v1.0.4 | 8–10 人日 | 未开始 |

**阶段验收（= v1.0.4 门禁）**：25 项 benchmark 首轮可运行率 >75%、自动验证率 >70%；每个 CLI 命令契约测试绿；`doctor`/`getCapabilities`/`capabilities.json` 三源一致。

### 5.5 阶段 4：生态包与差异化模板 → v1.0.5（第 24–39 周，P1）

**目标**：从"3D library + 工具"升级为"互动应用运行时"的完整证据：模板、capability packs、性能/SLO、迁移与运维文档闭环。**包的启动顺序由模板缺口反推**，不按 Three.js addon 数量定优先级。

| 工作流 | Backlog | 周次 | 任务分解 | 交付物 | 验收 | 估算 | 状态 |
|---|---|---|---|---|---|---|---|
| W4.1a `@cocosair/loaders` | AIR-011 | 24–26 | ① HDR/EXR、KTX2、Draco、Meshopt 从 W1.6/W1.7 产物转正式包；② OBJ 先行（业务驱动），FBX 仅在确认客户需求后评估；③ 每格式：错误码、进度、取消、缓存 | loaders 包 v1 | 每格式 ≥3 例进证据链；包体与 tree-shake 审计绿 | 8–10 人日 | 未开始 |
| W4.1b `@cocosair/postprocessing` / `controls` | AIR-011 | 26–28 | ① W1.5 pass 集、W2.5 材质图、W1.3 控制器分别转正式包；② pass/控制器的降级与兼容策略随包发布 | 两个正式包 | 主包不膨胀（体积预算门禁）；包内能力全部进能力目录 | 6–8 人日 | 未开始 |
| W4.1c `@cocosair/physics` | AIR-011 | 28–30 | ① 统一物理接口（2D Box2D + 3D Cannon 适配已存在）；② Rapier/Jolt 走 adapter 评估（不承诺）；③ UI 调参面板组件化 | physics 包 + 接口文档 | 统一接口下双后端可切换；接口有契约测试 | 8–10 人日 | 未开始 |
| W4.1d `@cocosair/exporters` | — | 30–31 | ① GLB 导出优先；② OBJ/STL/USDZ 按目标平台需求排后 | exporters 包 v0 | GLB 导出往返一致（导出→重载对比） | 5–7 人日 | 未开始 |
| W4.2 五个差异化模板 | — | 24–38 | 交付顺序与依赖：① 电商 3D 产品配置器（glTF+PBR+UI+热点拾取+材质变体+截图分享，24–27 周）；② 互动数据故事（3D+2D UI+时间线+音视频+响应式，27–30 周）；③ 物理互动沙箱（W4.1c+UI 调参+性能面板+可复现录制，30–33 周）；④ AI 生成场景编辑器（AirSceneSpec+即时预览+结构化 diff+一键验证，33–36 周）；⑤ 数字孪生查看器（模型加载/层级标签/选取/剖切/动画/告警 UI，35–38 周） | 五个模板 | 每模板：从空项目到部署的 Agent 脚本、视觉基线、性能预算三件齐备，不是可浏览 demo | 5 × 6–8 人日 | 未开始 |
| W4.3 性能/SLO 体系 | — | 28–31 | ① 定义 SLO 指标族：TTFR、资源加载、首帧、稳定帧时间、显存/资源释放；② `verify:benchmark` 回归通道扩到模板与双后端；③ 预算超标在 §5.0 链中红灯 | SLO 定义 + 预算门禁 | 五模板 + 20 双后端场景的预算全部可追踪 | 6–8 人日 | 未开始 |
| W4.4 运维与迁移文档闭环 | — | 36–39 | ① 迁移指南（W1.8）更新至 v1.0.5 能力面；② 部署/升级/回滚文档；③ 能力目录、知识包、benchmark 仪表板一并刷新 | 文档闭环 | 新会话 Agent 仅凭文档+知识包可完成任一模板的从零生成 | 4–6 人日 | 未开始 |

**阶段验收（= v1.0.5 门禁）**：至少 3 个 pack + 3 个模板达到三件套标准（Agent 脚本/视觉基线/性能预算）；SLO 门禁进 §5.0 例行链；文档闭环验收绿。

### 5.6 阶段 5：XR、地形、3D 粒子与长尾能力（v1.0.5 后按决策门进入，P2/P3）

每个能力设**启动决策门**：满足启动条件才立项，立项即走"RFC → 最小切片 → 能力目录登记 → 证据链接入"四步，不允许绕过验证链加能力。

| 能力 | 启动条件（决策门） | 建议路径 |
|---|---|---|
| WebXR | 阶段 2 后端、输入和帧循环稳定；有明确客户/模板需求 | 先 VR session、控制器、交互射线；后续 AR hit test、plane、light estimation |
| 地形 | 数字孪生/开放世界业务有明确需求 | 高度图、材质混合、碰撞和 LOD 作为独立 package |
| 3D 粒子 | 有可量化特效需求 | GPU instancing/compute 路径优先，不回到复杂 editor 资产依赖 |
| CSS2D/CSS3D/SVG | 有 DOM 叠加/信息可视化需求 | 作为 Web overlay package，不混入 renderer 内核 |
| 多格式导出 | 模型处理或 UGC 产品需要 | 优先 GLB，再按目标平台选择 USDZ/STL/OBJ |

### 5.7 依赖关系与关键路径

- **关键路径**：W0.0（math 清零）→ v1.0.1 → W1.1/W1.4 双轨 → v1.0.2 → W2.1 → W2.2 → v1.0.3（→ 阶段 3 收口）→ v1.0.4 → W4.x → v1.0.5。阶段 3 全程并行嵌入，不占关键路径，但其 W3.1 依赖 W0.1 schema、W3.3 依赖 W3.5。
- **跨阶段硬依赖**：W0.1 能力目录是 W0.5（失败定位）、W2.3（后端 capability）、W3.1（同源查询）、W4.x（pack 登记）的共同前置；W1.5 后处理挂载点是 W2.5 材质图 post 节点的前置；W1.6 decoder 部署是 W4.1a 的前身。
- **验证链约束**：所有工作流完成定义均含"接入 §5.0 验证链"；任何绕过证据链的交付不算完成。

### 5.8 风险登记与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 双后端视觉一致性难以定义容差 | W2.6 基线不可判 | 容差与 diff 工具作为 W2.6 第一项交付；先用数值通道（readback/中心采样）后像素比对 |
| 证据链维护成本随示例数增长 | 波次变慢、绿灯失真 | 保持"声明即须证明"语义不放松；并发写互斥协议化；验证服务化（W3.5）摊薄成本 |
| facade 语义漂移（静默偏离 Three.js 行为） | 迁移案例伪通过 | 每模块差异说明强制随包；30 案例自动视觉验证作为回归门禁 |
| WebGPU 环境/驱动碎片化 | 用户侧不可用 | adapter/feature 白名单 + 确定性回退（W2.3）+ 真机矩阵抽样 |
| 单人带宽 + 多会话并行协作 | 互相覆盖、重复劳动 | 共享工作树约定（写前读、不杀他方进程、证据文件单写者）；工作笔记为唯一协调面 |
| 覆盖率门禁长期不绿造成承诺漂移 | 对外信任受损 | v1.0.1 明示"覆盖率不作为出口条件"；每波次公开 added/removed/stale 与真实数字，不做数字游戏 |

---

## 6. 版本里程碑与度量

| 里程碑 | 推荐范围 | 对外承诺 | 必须量化的结果 |
|---|---|---|---|
| v1.0.1：可信能力面 | 阶段 0 | “知道自己稳定支持什么” | 文档/包/类型/示例一致率 100%；30 个核心样例跨浏览器基线 |
| v1.0.2：Three Friendly | 阶段 1 | “高频 Three.js 场景低摩擦迁移” | 30 个迁移案例；>85% 自动视觉通过；迁移指南覆盖 P0 API |
| v1.0.3：WebGPU Preview | 阶段 2 | “可选择、可回退、可诊断的 WebGPU” | 20 个双后端场景；WebGPU typecheck/E2E；回退原因结构化输出 |
| v1.0.4：Agent SDK Preview | 阶段 3 | “Agent 可生成、验证和修复 AIR 应用” | 25 项 Agent benchmark；首轮可运行率 >75%，自动验证率 >70% |
| v1.0.5：Production Runtime | 阶段 4 | “互动应用运行时，不只是 3D library” | 模板、capability packs、性能/SLO、迁移与运维文档形成闭环 |

> 版本线说明：里程碑编号即未来的发包版本线。引擎版本线重置：当前快照即 `cocosair.js@1.0.0`，v1.0.1（阶段 0）是其后的第一个里程碑版本，此后按 1.0.1 → 1.0.2 → 1.0.3 递增。

**建议核心指标**：

- 迁移成功率：指定 Three.js 用例在 AIR 中达到相同交互/视觉目标的比例。
- Agent 首轮成功率：无人工改动即可通过 typecheck + 场景验证的比例。
- 视觉回归通过率：跨 Chromium/Firefox/WebKit 的截图/关键区域断言通过比例。
- API 契约覆盖率：公开稳定 API 有类型、示例、限制说明、自动验证的比例。
- 资产兼容率：目标 glTF 模型集成功加载、渲染、动画和扩展的比例。
- 性能预算达标率：TTFR、资源加载、首帧、稳定帧时间、显存/资源释放的达标比例。

---

## 7. 建议的近期执行顺序

1. **先完成阶段 0**：不稳定能力清单、文档/示例数字漂移和默认构建/导出差异，会让 Agent 和开发者都无法可靠判断可用面。
2. **并行推进阶段 1 的 controls、阴影、后处理和 glTF 生产路径**：这是普通 Three.js 用户迁移时最直接感知的阻塞项。
3. **独立专项推进阶段 2 WebGPU**：必须按“入口 + 类型 + 后端协商 + 双后端测试 + 诊断”整体交付，不能只打开 feature。
4. **从第一天把阶段 3 的 capability/diagnostics/visual test 植入每个特性**：不要等功能堆积后再补 Agent 支持。
5. **以模板反推生态包优先级**：用 3D 配置器、数字孪生查看器、AI 场景编辑器的真实缺口决定 OBJ/FBX/XR/地形等投入，避免追求 Three.js addon 数量。

---

## 8. 首批 Backlog（建议直接立项）

| ID | 事项 | 优先级 | 依赖 | 完成定义 |
|---|---|---|---|---|
| AIR-001 | 生成机器可读能力目录与一致性校验 | P0 | 无 | 发布面、文档、示例、类型、feature 自动互证 |
| AIR-002 | 清理示例/验证证据漂移 | P0 | AIR-001 | manifest 成唯一真相；release gate 无 stale evidence |
| AIR-003 | 标准化 `cocosair/addons` 与 experimental 导出 | P0 | AIR-001 | 包导出、稳定性等级、tree-shake 与文档齐全 |
| AIR-004 | 默认 Code First 后处理 MVP | P0 | AIR-003 | tone mapping + AA + bloom + 视觉/性能基线 |
| AIR-005 | 阴影正式化 | P0 | AIR-001 | 支持矩阵、示例、跨浏览器视觉测试与性能策略 |
| AIR-006 | Controls/Raycast/Gizmo 包 | P0 | AIR-003 | Orbit/Transform/PointerLock、拾取、销毁/输入合同 |
| AIR-007 | WebGPU 产品化 RFC 与最小双后端垂直切片 | P0 | AIR-001 | `auto/webgpu/webgl2`、回退诊断、类型测试、10 个场景 |
| AIR-008 | Agent CLI / doctor / JSON diagnostics | P0 | AIR-001 | init/validate/capture/benchmark/migrate-three 支持 JSON/dry-run |
| AIR-009 | Three Friendly facade 试点 | P1 | AIR-006 | 10 个典型 Three 示例迁移；每例有差异说明 |
| AIR-010 | glTF 生产验证集与 decoder 部署工具 | P1 | AIR-001 | Khronos 模型集、性能/错误码/缓存/取消回归 |
| AIR-011 | Loaders capability pack | P1 | AIR-003 | HDR/EXR/KTX2/Draco/Meshopt，OBJ 或 FBX 由需求决定 |
| AIR-012 | Agent Benchmark 与模板 | P1 | AIR-008 | 25 任务集、结果仪表板、3 个可部署模板 |

---

## 9. 最终定位建议

不要把 Cocos AIR 宣传为“另一个 Three.js”，也不要用“支持了多少个上游模块”定义成功。更有竞争力的定位是：

> **Cocos AIR 是面向 AI Agent 的 Code First Web 互动运行时：以 glTF、组件、UI、物理和可验证工具链为核心，支持从 3D 展示到互动应用的一体化构建；同时提供面向高频 Three.js 用例的渐进迁移路径。**

这一定义既承认 Three.js 在通用 3D 库生态、WebGPU/TSL、XR、格式工具和社区样例上的领先，也把 AIR 的投入集中在可交付的互动运行时与 Agent 可操作性上。先把稳定能力面、可验证性、控制/后处理、WebGPU 与 Agent SDK 做深，才能在 AI Agent 时代建立不是“API 数量”而是“任务成功率”的护城河。
