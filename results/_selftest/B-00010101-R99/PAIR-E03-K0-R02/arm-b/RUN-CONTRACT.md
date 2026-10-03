# RUN-CONTRACT — Arm B of PAIR-E03-K0-R02

> 本文件是该 Arm Agent Run 的执行协议,由 Pair Coordinator 生成并冻结。**不得修改**。
> 违反本合同任意禁令 → 该 Run 判 `INVALID_RUN`(failure-taxonomy §2.20):记录保留、不计入任何引擎成败统计、单列披露。

## 0. 身份

| 项 | 值 |
|---|---|
| Pair | `PAIR-E03-K0-R02` |
| Arm | `B`(本目录即 `arm-b/`) |
| 场景 | `E03` — `brief.md`(人读)与 `spec.json`(机读冻结规格)已拷贝至本 Arm 目录,冲突以 `spec.json` 为准 |
| 引擎 | `three` |
| 知识等级 | `K0`(知识包已拷贝至本 Arm 目录 `knowledge/`) |
| dev server 端口 | `7109`(启动 dev server 前设置环境变量 `PORT=7109`) |

## 1. 任务

在本 Arm 目录的 `workspace/` 内,按 `../brief.md` 与 `../spec.json` 实现场景。

`workspace/` 是对应引擎模板的拷贝(不含自有 node_modules——构建与引擎依赖由目录上层**共享 node_modules** 沿目录向上解析提供,exFAT 去重布局,见 bench/node_modules 与 DEDUP-NOTE),开箱即可 `npm run build`。共享资产已拷贝至本 Arm 目录 `assets/`(只读使用,不得修改)。**一切所需材料以本 Arm 目录内为准。**

## 2. 预算(冻结,两引擎一致,不临时追加)

| 项 | 上限 |
|---|---|
| 工具调用次数 | 120 |
| 墙钟时间 | 90 分钟 |
| build 尝试次数 | 8 |
| 浏览器验证尝试次数 | 6 |

触及任一上限即终止 Run,判 `BUDGET_EXHAUSTED`。token 消耗全程记录、独立报告,不设硬截断。

## 3. 允许访问(白名单,穷举)

- 本 Arm 目录(`arm-b/`)内全部内容:`workspace/`、`knowledge/`、`assets/`、`brief.md`、`spec.json`、`RUN-CONTRACT.md`,以及你自己创建的 `WORKLOG.md`、`RESULT.md`。
- **共享只读挂载:无。** 知识包与资产均已各自拷贝进本 Arm 目录,不存在任何本目录之外的合法读取目标。

## 4. 禁止访问 / 禁止行为(红线,逐条冻结)

1. 另一 Arm 的一切:目录、代码、日志、dev server、浏览器 profile、截图、结果。
2. `bench/reference/`(Reference 实现、截图、视频、私有验证器)。
3. `bench/results/` 下除本 Pair 本 Arm 之外的任何目录;一切既往 trial 结果。
4. `bench/harness/` 源码(coordinator / runner / isolation / probes 等)与本合同模板。
5. 引擎源码仓库:`E:\AIProMax\github\cocosair.js`、three.js r186 源码树(`E:\AIProMax\Y2026M09\cocosairjs-vs-threejs\three.js-r186`)。
6. 实验计划书与本实验的合同文档目录(`bench/docs/`)。
7. `bench/secret/`(牺牲性串扰 marker)。
8. 联网:任何网络请求(文档、搜索、包 registry)。
9. `npm install` 或以任何方式安装新依赖 —— 依赖已由上层共享 node_modules 提供,同样不得改动共享仓内容。
10. 修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 探测或篡改 harness/validator 的行为与期望值(检出即 `INVALID_RUN`)。

**只读同样禁止**:"只读"仍然读到了答案。

## 5. 完成合同(全部满足才算完成)

1. `npm run build` 在 `workspace/` 根执行,退出码 0。
2. 页面 10s 内 `window.__appReady === true`。
3. `window.__bench = { getState(): object, reset(): void }` 契约成立。
4. 无未捕获异常(console 无 error 级未捕获错误)。
5. 探针自检:按 `spec.json` 的 probes 逐条自查(状态断言 + 视觉断言),全部通过。

## 6. 工作日志(强制)

在本 Arm 目录维护 `WORKLOG.md`:每次 build、每次浏览器验证,追加一行:

```text
<ISO-8601 时间戳> | <动作(build/serve/浏览器验证/探针自检/…)> | <结果(成功/失败+一句话原因)>
```

## 7. 结束交付(强制)

结束时在本 Arm 目录写 `RESULT.md`,包含三部分:

1. **实现摘要**:如何满足 spec 的每一条探针(逐 probe 一句话);
2. **自检清单**:§5 五项逐条勾选;
3. **合规声明**:逐条声明未访问 §4 的任何禁止路径。

## 8. 环境事实(如实声明)

- 本环境隔离为**策略级**(本合同 prompt 约束 + Run 结束后产物扫描),非 OS 强制;但产物与日志会扫描违规访问痕迹与答案泄漏特征串,勿存侥幸。
- 时间戳 ISO-8601;hash 一律 SHA-256;JSON 2 空格缩进。
- 正式性能采样/录屏验证阶段,两 Arm 串行执行(单机 worker 规则),开发阶段可并行但保持全维度隔离。
