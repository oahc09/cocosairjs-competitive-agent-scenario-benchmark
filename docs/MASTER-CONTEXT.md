# MASTER-CONTEXT — CocosAirJS Competitive Agent Scenario Benchmark

> 所有子 Agent 开工前必读。本文件是全仓库唯一事实源(Single Source of Truth)的索引。
> 完整计划书: `E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark\docs/BENCHMARK-PLAN.md`(下称"计划书")

## 1. 项目一句话

同一 AI Agent 配置下,Three.js r186 vs Cocos AIR 双引擎复杂 3D 场景成对对照实验。分离 Engine Ceiling 与 Agent Attainment,产出 CocosAirJS 可执行路线图,不是排行榜。

## 2. 关键绝对路径

| 资源 | 路径 |
|---|---|
| 实验根 | `E:\AIProMax\Y2026M10\cocosairjs-competitive-agent-scenario-benchmark`(下称 `<ROOT>`) |
| Cocos AIR 引擎源码(Reference 实现者可读) | `E:\AIProMax\github\cocosair.js`(build/npm/cocosair.module.js + build/cocosair.module.d.ts + docs/ + examples/) |
| AIR 引擎本地 tarball(离线安装用) | `<ROOT>\vendor\cocosair.js-1.0.0.tgz` |
| three.js r186 源码快照(Reference 实现者可读) | `E:\AIProMax\Y2026M09\cocosairjs-vs-threejs\three.js-r186`(0.186.1) |
| npm three 版本 | `three@0.186.1`(registry 可用,即 r186) |
| 能力差异审计(2026-09-26) | `<ROOT>\reports\inputs\COCOSAIRJS_VS_THREEJS_R186_能力差异与路线图.md` |
| 旧 bench 方案设计 | `<ROOT>\reports\inputs\AGENT_ENGINE_BENCH_方案设计.md` |
| 运行环境 | Windows + Git Bash;Node v24.14.0;npm 11.11.1;Chrome + Playwright chromium 已装 |

## 3. 引擎事实(已验证,勿再重复侦察)

- **Cocos AIR** `cocosair.js@1.0.0`:Code-first,`createAirApp()` → Game/Director/Scene/Node/Component;WebGL2(默认);内建 glTF/GLB、骨骼动画、2D/UI、物理(Box2D/3D builtin);**已知短板**:默认 Code First 路径后处理不可稳定使用(无 Bloom)、无 Three 风格 OrbitControls、无节点材质/TSL、阴影交付不完整。详见能力差异文档。
- **Three.js** `0.186.1`:Scene/Object3D/WebGLRenderer;EffectComposer+30 后处理模块(addons);GLTFLoader;OrbitControls(addons);Points/InstancedMesh;ShaderMaterial 全自由。

## 4. 知识等级(K0/K1/K2)

- **K0 Cold**:仅 package + README + .d.ts + 模板本身。禁 docs/patterns/recipes/examples/联网。
- **K1 Official Docs**:K0 + 官方 API/概念文档 + 基础 pattern。禁当前场景答案型 Example/Benchmark Reference/私有 validator。
- **K2 Full**:K1 + Patterns + Stable Recipes + Stable Examples + Skill。禁直接包含当前 Brief 完成代码。
- AIR tarball 的 `files` 字段包含 `docs/` — K0 版 tarball 必须**剔除 docs/**(重打包),K1 版含 docs。详见 `knowledge/*/manifest.json`。

## 5. spec.json Schema v1(场景冻结规格,briefs/E*/spec.json)

```jsonc
{
  "briefId": "E03", "briefVersion": "1.0.0", "frozen": true, "frozenAt": "ISO-8601",
  "title": "…", "goal": "…",
  "domains": ["Hierarchy","Animation","Picking","UI","State"],   // 取自计划书第8节每场景"覆盖"清单
  "assets": [{ "path": "assets/boat.glb", "required": true, "sha256": "…" }],  // 无则空数组
  "scaleAndPerformance": { "minFps": 30, "notes": "…" },
  "completionContract": {
    "build": "npm run build 必须退出码 0",
    "ready": "window.__appReady === true(10s 内)",
    "state": "window.__bench = { getState(): object, reset(): void }",
    "noUncaughtErrors": true
  },
  "forbiddenShortcuts": ["…"],
  "probes": [{
    "probeId": "P1", "precondition": "__appReady",
    "action": "wait:2000 | click:{x,y} | wheel:… | pointer:… | key:… | drag:… | dblclick:… | setSpeed:8x(经UI控件)",
    "waitMs": 1000,
    "stateAssertion": { "jq": "$.planetCount == 8" },   // jq 风格伪表达式,$ = getState()
    "visualAssertion": { "type": "nonBlank|motion|pixelDelta|regionChange", "params": {} },
    "threshold": "…", "evidence": ["screenshot", "stateSample"]
  }],
  "scoring": { "behaviorItems": ["每项一句话,对应S2的30分细分"] }
}
```

`stateAssertion.jq` 由 harness 用安全求值器执行(仅比较/算术/逻辑,禁函数调用)。`brief.md` 为人读版(计划书第9节 10 段结构),spec.json 为机读版,两者必须一致。

## 6. 评分(计划书 §16,总分 100)

- **Objective 60**:S1 可运行 15 / S2 行为正确性 30(按 scene probes 通过率折算)/ S3 场景技术合同与生命周期 10 / S4 代码健康 5。
- **Visual 40**:六维(构图取景/材质光影/动效流畅/特效质感/交互反馈/整体完成度)各 0–3 分,`visual = round(sum × 40 / 18)`。
- **效率独立报告**:tokens/toolCalls/wallTime/buildAttempts/browserAttempts/repairCount/timeToFirstCompile/timeToFinalPass,不入总分。
- **AgentAttainment** = AgentRawScore / EngineCeilingComparableScore(仅 Reference=FEASIBLE/ENGINE_LIMITED 时计算)。

## 7. 失败分类枚举(§20,穷举,不得自创)

`API_HALLUCINATION TYPE_ERROR LIFECYCLE_MISUSE ASSET_PIPELINE ANIMATION SCENE_GRAPH SHADER POSTPROCESS MATERIAL INTERACTION STATE_MANAGEMENT PERFORMANCE BUILD RUNTIME REPAIR_EXHAUSTED BUDGET_EXHAUSTED ENGINE_LIMITED ENGINE_UNAVAILABLE INFRA_FAILURE INVALID_RUN SPEC_INVALID`

## 8. Gate 清单(§28)

`G0 CONTRACT_FREEZE / G1 TEMPLATE_EQUIVALENCE / G2 ISOLATION / G3 REFERENCE_FEASIBILITY / G4 HARNESS_TRUST / G5 PILOT_VALIDITY / G6 CORE_MATRIX_COMPLETENESS / G7 BLIND_JUDGE_VALIDITY / G8 EVIDENCE_COMPLETENESS`
每个 Gate 的判定脚本/证据写入 `<ROOT>\gates\<G#>.json`。

## 9. 隔离与红线(§0.2/§4/§11)

- **Agent Run(pilot 等)**:只能读自己的 workspace + 挂载的 K 包 + 共享 assets(只读)。禁读:`reference/private/`、另一 Arm workspace、harness validator 源、`results/`、引擎源码仓库(`E:\AIProMax\github\cocosair.js`、three.js-r186 源码树)、计划书本身。
- **Reference 实现者**:可读引擎源码与 docs,产物进 `reference/private/{three,cocosair}/E*/`,该目录永不被 Agent Run 读到。
- Brief 必须 API 中立(§9.2):禁止出现 THREE.*、OrbitControls、Node、Component 等引擎类名;允许图形领域语言。
- 禁止删除失败 trial;Invalid Run 保留记录。
- 本环境文件隔离为**策略级**(prompt 约束 + 产物扫描验证),非 OS 强制 — 隔离报告中必须如实降级声明。

## 10. 统一契约(所有产物工程)

- 模板/产物:`npm run build` 出 `dist/`,`index.html` 引 `dist/app.js`;页面暴露 `window.__appReady`、`window.__bench={getState,reset}`。
- 时间戳 ISO-8601;hash 一律 SHA-256;JSON 缩进 2 空格。
- 日期口径:今天是 2026-10-02。

## 11. 当前执行阶段

M0-M1 已完成(2026-10-02):合同/指标/失败分类三件套 + 3 配置 + G0.json;E01-E10 brief.md+spec.json 全部冻结;assets(boat/gem/character/textures/audio)+MANIFEST 校验 54/54 PASS;K0/K1/K2 知识包 + cocosair k0 tarball 构建 verify PASS。

## 12. Wave 2 接口契约(模板/Harness/协调器必须共同遵守)

### 12.1 模板架构(双引擎统一)

- 构建方式:**应用代码用 esbuild 打包,引擎本体不打进 bundle**——`npm run build` = `node scripts/build.mjs`:esbuild 打包 `src/main.js` → `dist/app.js`(引擎标记 external),并把引擎 ESM 文件复制到 `dist/vendor/`:`three` → `node_modules/three/build/three.module.js` + `examples/jsm/` 整目录(three addons 路径 `three/addons/`);`cocosair.js` → tarball 解包的 `build/npm/cocosair.module.js` + `build/gltf-decoders/` 整目录。
- `index.html` 用 `<script type="importmap">` 把裸名 `three`/`three/addons/`/`cocosair.js` 映射到 `/dist/vendor/...`,再 `<script type="module" src="/dist/app.js">`。
- dev:`npm run dev` = `node scripts/serve.mjs`(node:http 静态服务,端口取 `process.env.PORT` 默认 5173,serve 根为模板根)。
- 页面契约:`window.__appReady=false` 初始,首帧渲染后 true;`window.__bench={getState:()=>object, reset:()=>void}`。
- Smoke 场景:旋转立方体,`getState()` 返回 `{engine:"three"|"cocosair", frame:<累计帧数>, ready:true}`,`reset()` 清零 frame 并重置立方体角度。两引擎 smoke 行为等价(G1 用)。
- 模板含 vendored node_modules(esbuild + 引擎),Agent Run 拷贝即离线可用;禁止 Agent Run 执行 npm install。
- 每模板根写 `template-manifest.json`:{engine, engineVersion, nodeVersion, buildScript, lockfileSha256, engineFileSha256}。

### 12.2 Harness CLI(bench/harness/,独立 npm 工程,依赖 playwright-core)

- `node runner/validate.mjs --workspace <dir> --spec <spec.json路径> --out <输出目录> [--run-id X] [--video] [--port N]`
- 流程(计划书 §13 14 步):workspace hash → npm run build → serve(workspace 根)→ chromium(headless,1280×720,fresh userDataDir)→ 等 __appReady(10s)→ console 收集 → 逐 probe 执行 → 关键截图≥5 → 录屏(可选)→ reset/生命周期 → fps 采样(注入 rAF 计数 3s)→ 归档(source/console/screenshots/probe结果/state样本/perf)→ report.json。
- **探针动作词表**(执行器唯一实现):`wait:<ms>` / `click:{x,y}`(数值≤1.5 视为归一化×1280×720,否则绝对像素)/ `click:ui=<data-ui或data-bench选择器值>` / `dblclick:{x,y}` / `wheel:{dy}` / `pointermove:{x,y}` / `drag:{from:[x,y],to:[x,y]}` / `key:<key>`。动作可用 `+` 串接(如 `click:ui=speed-8x+wait:1000`)。
- stateAssertion 求值:安全 jq 子集(`$` 路径、比较、算术、&&/||/!,双采样 `$.before/$.after` 由执行器在动作前后各取一次 getState 包成 {before,after} 再求值)。
- visualAssertion 类型:`nonBlank`(非背景像素占比>阈值)/`motion`(两帧差)/`pixelDelta`(动作前后帧差>阈值)/`regionChange`(指定矩形区域变化)。基于 playwright screenshot 的 PNG 解码(harness 内可用零依赖 PNG 解码或 npm 依赖 pngjs)。
- 独立观测:network 日志(serve.mjs 记录请求→report.networkEvents)、download 事件(page.waitForEvent('download'))、console 错误分类。
- 求值结果 report.json:{runId, build:{ok,log}, ready, consoleErrors[], probes:[{probeId, status:PASS|FAIL|ERROR, evidence}], fps, artifacts[], classification, scoreInputs:{s1...}}。
- `node runner/score.mjs --reports <glob> --visual <visualScores.json>` → S1-S4+visual 合成、pair 指标、bootstrap CI(2000)、win/tie/loss(tie=|delta|≤3)。
- `node runner/brief-freeze.mjs` → 对 10 个 brief 计算 briefSha256 回填 briefs/index.json,并把 assets/MANIFEST.json 的 sha256 回填 E02/E09/E10 spec.json 的 assets 字段(消除 pending-asset-freeze)。

### 12.3 Pair 协调器(bench/harness/coordinator/)

- `node coordinator/create-pair.mjs --scene E03 --knowledge K0 --rep R01 [--pilot]` → 建 `results/PAIR-<scene>-<knowledge>-<rep>/`:{pair.json(§24 格式+全部 hash), arm-a/workspace, arm-b/workspace(从对应模板整体拷贝含 node_modules), 两 arm 各自 knowledge/ 拷贝、assets/ 拷贝、brief.md+spec.json 拷贝、RUN-CONTRACT.md(该 arm 的执行协议:预算/允许路径/禁止路径/完成合同/自检步骤)}。Arm 引擎按 rep 平衡随机:R01 A=three/B=cocosair,R02 反转,R03 同 R01。
- 隔离测试(`node isolation/run-isolation-tests.mjs` → gates/G2.json):T1 workspace 泄漏扫描 / T2 浏览器 profile 隔离(双 userDataDir localStorage 不串)/ T3 dev server 端口与路径隔离 / T4 答案泄漏扫描(workspace 内出现 reference/private 哈希、validator 源名、另一 arm 路径即 FAIL)/ T5 牺牲性 marker(根下 secret/reference-marker.txt;扫描 run 产物无其内容)。
- 负向对照(`node isolation/run-nc.mjs` → gates/G4.json):fixtures NC01-NC06 为独立假 app(无需引擎),经 validate.mjs 用 E01 spec 验证,断言:NC01-05 必须 FAIL(被检出),NC06 为工作区扫描器直接判 INVALID_RUN。
- 环境如实声明:隔离为策略级+产物扫描级,非 OS 强制(G2.json 里写明)。
