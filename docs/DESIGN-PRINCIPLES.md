# 设计原理:量尺、被测与差异来源

> 回答一个常见疑问:"每次跑测试,如果场景实现代码都一样,那引擎更新了也没用吧?"

## 一句话

**Agent 每轮从零写新代码(被测行为的载体),引擎负责执行(被测对象本身),Reference 是冻结的满分线(分母)——三者角色不同,缺一不可。**

## 三层角色

| 层 | 位置 | 谁写 | 每轮 | 引擎升级后 | 实验角色 |
|---|---|---|---|---|---|
| **量尺(Reference)** | `reference/private/*/src/` | 可信实现者 | **冻结**(同纪元) | **重实现**(用新正典 API) | 满分线 / 分母 |
| **Agent Run 代码** | `results/B-*/arm-*/workspace/src/` | 被测 Agent(全新会话) | **每轮全新**(从零推理写) | Agent 自然适配新 API | 信号产生器 |
| **引擎(cocosair.module.js)** | `node_modules/cocosair.js/` | 引擎团队 | **可升级**(tarball 替换) | 渲染/行为/bug 真实变化 | **被测对象** |

## 为什么量尺跨轮冻结

```text
Round 1:
  Agent → 写 code_A1 (three) + code_B1 (cocosair)
  score_A1 / Reference_Three = Three Attainment
  score_B1 / Reference_AIR   = AIR Attainment
  Δ₁ = AIR − Three           ← 第一个引擎差值

Round 2:
  Agent(新会话)→ 写出不同的 code_A2 + code_B2
  score_A2 / 同一个 Reference = ...
  Δ₂ = AIR − Three           ← 第二个引擎差值

多轮 Δ₁ Δ₂ Δ₃ ... → 引擎差异是否稳定?置信区间?
```

**如果量尺每轮也变,Δ 就没有参照物**——你不知道差异来自引擎还是来自量尺本身的变化。

## 引擎更新的效果从哪来

**不依赖 Agent 写出不同的代码**——同一份(或相似逻辑的)Agent 代码,跑在不同引擎上:

```text
  Agent 写 code → three.js r186 渲染 → 效果 X (3 个 bug, 60fps, 无 bloom)
  Agent 写 code → cocosair 1.0.1 渲染 → 效果 Y (2 个 bug, 45fps, 有 bloom)
  
  X vs Y 的差异 = 引擎差异(渲染行为、性能、bug 数)
```

引擎升级改变的是**执行器的行为**:
- 新 API → Agent 能调用更多能力(或旧 API 被移除导致 Agent 要换写法)
- bug 修复 → 同样的代码跑出更好的效果
- 性能优化 → 同样的代码跑出更高 fps
- 渲染改进 → 同样的场景观感提升

Agent 不需要"为引擎升级写不同代码"——Agent 读引擎当前版本的文档/API,自然适配。**引擎升级的真正效果体现在:同级别的 Agent 代码在新引擎上跑出更好的结果。**

## Reference 什么时候需要重实现

不是"每次测试都重写",而是**四输入(RULER)任一变化时才触发**:

| 输入变化 | Reference 动作 | 原因 |
|---|---|---|
| 引擎 tarball 升级 | **重实现**(新正典 API) | 新引擎可能有新 API/新推荐用法,旧写法低估上限 |
| Brief/Spec 升版 | **重实现** | 验收合同变了 |
| 知识/文档包变更 | **重实现** | 新正典用法可能不同于旧绕行写法 |
| 工具链变更(Chrome 升级) | **仅重验证** | 环境变了但代码语义没变 |

检测命令:`node run.mjs ceiling-check`(STALE = 需重实现;NEEDS_REVALIDATION = 仅重跑)。

## Reference 与 Agent Run 的关系

```text
Reference = "在引擎当前版本上,一个可靠实现者能做到的上限"
Agent Run = "一个标准 Agent 在同一引擎上实际能做到的"

Attainment = Agent 实际分 / Reference 满分线
           = "引擎的能力被标准仪器(Agent)发挥出了几成"
```

Attainment 低 ≠ Agent 差——可能是引擎的 API/文档/调试体验让 Agent 发挥不出来。
这正是本实验要量化的:同样的 Agent,在哪个引擎上发挥得更好。
