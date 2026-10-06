# 交给其他 AI Agent 的任务描述(复制以下全文即可)

```text
你在 CocosAirJS 双引擎对照实验仓库工作(仓库根 = 当前工作目录,先 cd 过去)。
先读两份文件建立上下文:AGENTS.md(60 秒须知,含红线)与 docs/MULTI-RUN-GUIDE.md(多轮执行)。

【任务】执行 CORE 全量矩阵战役的"下一个未完成切片"(总盘子:10 场景 × K0/K1 × R01..R03
= 60 pairs = 120 Agent Run,分 12 个切片轮次推进;全部完成 = G6 达成):

0. 选切片(断点续跑:对照 results/ 下已有 PAIR-<场景>-<K>-<rep> 目录,取下表中第一个
   尚有缺失 pair 的切片;若该切片曾开工——某批次目录里已有它的部分 pair——用 --batch 指回
   原批次续建,否则用 auto):
   **目录已存在的 pair 一律视为已完成,包括 QUALIFIED_OBJECTIVE_PARTIAL 的对**
   (先例:E02×K0×R01 在 B-20261005-R03 因 cocosair 臂 toolcalls 125>120 判 BUDGET_EXHAUSTED
   降级 PARTIAL——hard 预算的真实引擎难度信号,trial 原样保留,该场景的 core 数据由同切片内
   其余重复轮(R02/R03)供给;仅 Owner 明确指示时才重跑该 pair):
   S1  K0×R01×E01..E05    S2  K0×R01×E06..E10
   S3  K0×R02×E01..E05    S4  K0×R02×E06..E10
   S5  K0×R03×E01..E05    S6  K0×R03×E06..E10
   S7  K1×R01×E01..E05    S8  K1×R01×E06..E10
   S9  K1×R02×E01..E05    S10 K1×R02×E06..E10
   S11 K1×R03×E01..E05    S12 K1×R03×E06..E10
   先广后深:K0-R01 全场景(n=1)优先,再补 R02/R03 与 K1。

1. 创建轮次(--track 必须 core——正式统计唯一入口;无 --track 会报错,这是设计):
   node run.mjs round create --track core --matrix "<场景列表>|<K>|<rep>"
   例:S1 → --matrix "E01,E02,E03,E04,E05|K0|R01"
   → 产出 results/B-<日期>-R<轮次>/:ROUND.json(状态机)+ DISPATCH.md(派发清单)

2. 派发前 Runner 职责(编排会话做,不进 Arm 会话):
   - 填各臂 RUN-META.json(复制 RUN-META.template.json 填身份字段;systemPromptSha256 与
     toolPolicySha256 可留空 —— preflight 会真算回填并核验);
   - node run.mjs round preflight --batch <批次> → 必须全 PASS 才派发;
   - node run.mjs round dispatch --batch <批次> 盖章两臂 dispatchAt。

3. 执行 Agent Run(唯一需要"真 Agent"的环节;时序与预算都是机器闭环):
   - 每个 Arm 用一个全新会话执行 DISPATCH.md 里对应臂的提示词原文(同轮同文,仅工作目录不同);
   - **时序闭环**:该臂会话真正派发前一刻 `node harness/runtime/agent-launcher.mjs start --arm-dir <臂目录>`,
     会话返回后立刻 `… finish --arm-dir <臂目录>` —— execution.json 是时序唯一事实源
     (agentStartedAt 首写生效,拒改;双臂时差 >30s = PAIR_TIMING_DRIFT,如实进诊断区);
   - **一波 = 一个 Pair 的双臂,同一条消息并行启动**(实测宿主子代理并发上限 3,多于 2 臂会撞
     "user concurrency limit exceeded");
   - **toolcall 机器计数(方案A hard)**:每臂会话结束后、collect 之前,
     `node harness/runtime/toolcall-recorder.mjs transcript --workspace <臂>/workspace --from <宿主转录.jsonl>`
     (宿主只报总数时用 `bulk --count N --start <ISO> --end <ISO>`)——
     机器口径,Agent 自报不算数;N>120 → validate 判 BUDGET_EXHAUSTED(这是 hard 预算的真实信号,
     引擎侧难度数据;不得为保 PASS 改写或漏写计数);
   - 每个 Arm 的冻结合同是其目录里的 RUN-CONTRACT.md:预算 build≤8 / browser≤6 /
     toolCalls≤120(hard,方案A)/ 墙钟≤90min,触限即停;禁读 reference/、禁联网、
     禁 npm install、禁改 brief/spec/harness;
   - 该臂完成标志 = 它的目录里出现 RESULT.md。

4. 全部臂完成后,按序推进状态机(全部幂等,可断点重跑):
   node run.mjs round collect   --batch <批次ID>   # 检查完成标记 + 自动算双臂时差(execution.json 直读)
   node run.mjs round validate  --batch <批次ID>   # 独立验证+泄漏扫描+预算机检(唯一判定事实源)
   node run.mjs round qualify   --batch <批次ID>   # 证据链鉴定 → QUALIFICATION.json(资格分层)
   node run.mjs round blind     --batch <批次ID>   # 生成盲评材料
   # 若本会话具备图像判别能力:按 blind/JUDGE-INSTRUCTIONS.md 派两个独立 Judge 会话回填
   # blind/visual-scores.json 后重跑 aggregate(可解视觉口径,formal 总分才有定义);不具备则如实挂起
   # 已知 §8.4 违规(处置见 results/reports/blind-anonymization-findings.json):REF-E10 双侧 HUD 印引擎名、
   # REF-E02-Y 印 boat.glb —— Judge 派发提示词须照旧"严禁读 blinding-key/不猜引擎",发现身份字样时
   # 如实记录但不改评分;Reference 去商标已列入下次 Reference 重验周期,完成前勿中途改冻结 Reference。
   node run.mjs round aggregate --batch <批次ID>   # 全量聚合 → results/aggregated.json

5. 资格判读(不再人工回填 pair.json —— qualification 直读各臂 execution.json 与 RUN-META.json):
   目标状态:每对 QUALIFIED / QUALIFIED_OBJECTIVE(toolcall 计数 hard 满足 + 时序 PASS)。
   只有 QUALIFIED / QUALIFIED_OBJECTIVE 进 core 正式分组;PARTIAL / PARTIAL_TIMING /
   LEGACY_PROVISIONAL 只进诊断区,等于白跑——qualify 后必查 ROUND.json 与
   QUALIFICATION.json 的 status/failedChecks,失败原因如实记录。

6. node run.mjs round status --batch <批次ID> 与 node run.mjs gates 输出仪表盘,向我汇报:
   各臂 verdict/失败探针/timingDrift/qualification、本切片在战役中的位置(已完成 x/12)、
   以及 results/aggregated.json 里 core 分组(有 n>0 的组)的 medianΔ / W-T-L。

【硬性红线】任何 Agent Run 会话:不得读 reference/、另一 Arm、results 其他目录、harness 源码、
引擎源码仓库;不得联网、npm install、修改 brief/spec/harness。违反 = INVALID_RUN。
编排会话(你)不受 Arm 级隔离限制,但同样不得修改冻结输入与历史 trial。

【已知风险(如实记录,不阻塞)】
- 时序敏感探针(E09 P5/P7、E05 P1 类负载敏感判别)在 GPU 有并行负载时可能贴阈值抖动:
  validate 已机制化"单 GPU 串行 + 20s 冷却"(R3-7);首验失败且 state 断言通过的臂,
  冷却后 `--force` 复验一次并把两次结果都留档,不得只留好的一次。
- 平台并发上限 3:严格一波一双臂;确需补派时接受 PAIR_TIMING_DRIFT 并如实记录
  (该对降级 PARTIAL_TIMING,进诊断区,不计入正式主张)。
```

---

## 补充说明(给人类 Owner,不需交给 Agent)

- **单臂提示词不用手写**:`round create` 会把每臂提示词自动渲染进 `DISPATCH.md`;
- **为何分 12 个切片**:120 个 Run 单会话吞不下(实测吞吐 ≈2-3 对/轮:一波一双臂 + 串行验证
  + 冷却);切片让每个批次当日可闭合(collect→aggregate),批次化架构天然支持单日多轮(R 自动递增);
- **toolcall.count 口径**:budget-check 以行数=次数(行首 ISO token 参与墙钟跨度判定);
  写入口 = `harness/runtime/toolcall-recorder.mjs`(transcript 逐调用提取 / bulk 宿主总数 / call 流式);
  qualify 在 toolCallsMode=hard(默认,方案A)下要求两臂 toolcall.count 存在且 ≤120,
  否则该对降级 QUALIFIED_OBJECTIVE_PARTIAL(只进诊断区)——这是方案A下 core 数据成立的
  唯一机器路径(另一条路是 Owner 显式在 agents.yaml 写 `toolCallsMode: diagnostic` 并 G0 重冻结);
- **方案A当日先例(B-20261005-R01,targeted-pilot,旧 handoff 口径执行)**:E01/E05×K0 得
  QUALIFIED_OBJECTIVE_PARTIAL(_TIMING),按设计只进诊断区;其 E01 arm-b 运行时机器计数
  142>120,若当时已写计数文件将判 BUDGET_EXHAUSTED——该批保持原样不改,作为 hard 预算的
  先例参照(E05 对还因当日 spec v1.0.3 升版而 specExact 失配降 LEGACY:历史对现行 spec 无证明力,如实);
- **验收**:G6 由 NOT_RUN → 全切片完成、每批 QUALIFICATION.json(目标 QUALIFIED_OBJECTIVE)、
  `results/aggregated.json` core 分组 n>0、`node run.mjs gates` 门禁表;
- **环境**:换机器先 `npm install`(cocosair 从 vendor 内置 tarball 离线可装),详见 README 克隆恢复段。
