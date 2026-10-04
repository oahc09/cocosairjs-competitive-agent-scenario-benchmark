# 交给其他 AI Agent 的任务描述(复制以下全文即可)

```text
你在 CocosAirJS 双引擎对照实验仓库工作(仓库根 = 当前工作目录,先 cd 过去)。
先读两份文件建立上下文:AGENTS.md(60 秒须知,含红线)与 docs/MULTI-RUN-GUIDE.md(多轮执行)。

【任务】完整执行一轮 targeted-pilot 双引擎对照测试:

1. 创建轮次(生成 Pair 与派发清单;无 --track 会报错,这是设计):
   node run.mjs round create --track targeted-pilot --matrix "E01,E05|K0|R01"
   --matrix 四段 = 场景|知识级|重复号|track(第 4 段可省略,已由 --track 给出)
   → 产出 results/B-<日期>-R<轮次>/:ROUND.json(状态机)+ DISPATCH.md(派发清单)

2. 按 DISPATCH.md 执行 Agent Run(这是唯一需要"真 Agent"的环节):
   - 每个 Arm 用一个全新会话执行 DISPATCH.md 里对应的提示词(同轮同文,仅工作目录不同);
   - 同一 Pair 的两臂必须同批启动(时差 ≤30 秒),启动后把实际开始时间记入该臂 execution.json;
   - 每个 Arm 的冻结合同是它目录里的 RUN-CONTRACT.md:预算 build≤8/browser≤6(自动计数,
     触限即停)、禁读 reference/、禁联网、禁 npm install、禁改 brief/spec/harness;
   - 该臂完成标志 = 它的目录里出现 RESULT.md。

3. 全部臂完成后,按序推进状态机(全部幂等,可断点重跑):
   node run.mjs round collect   --batch <批次ID>   # 检查完成标记
   node run.mjs round validate  --batch <批次ID>   # 独立验证+泄漏扫描(唯一判定事实源)
   node run.mjs round blind     --batch <批次ID>   # 生成盲评材料(视觉 Judge 另行安排,G7 未过不影响客观分)
   node run.mjs round aggregate --batch <批次ID>   # 全量聚合 → results/aggregated.json

4. node run.mjs round status --batch <批次ID> 输出仪表盘,向我汇报:
   各臂 verdict/失败探针/timingDrift/qualification 状态,以及 results/aggregated.json 里
   本批次的 objective 成对 delta。

【硬性红线】任何 Agent Run 会话:不得读 reference/、另一 Arm、results 其他目录、harness 源码、
引擎源码仓库;不得联网、npm install、修改 brief/spec/harness。违反 = INVALID_RUN。
编排会话(你)不受 Arm 级隔离限制,但同样不得修改冻结输入与历史 trial。

【数据层级说明】当前运行时无法机器采集 toolcall 计数 → 新数据 qualification 为
QUALIFIED_OBJECTIVE_PARTIAL(客观分 S1/S2/S3 可信,进诊断区;不入 core 正式统计)。
若要产出 core 正式数据,需先由仓库 Owner 决断 toolCalls 方案(见 gates/G6.json startPrerequisites)。
```

---

## 补充说明(给人类 Owner,不需交给 Agent)

- **单臂提示词不用手写**:`round create` 会把上面第 2 步的每臂提示词自动渲染进 `DISPATCH.md`;
- **正式 core 数据**:把 `--track targeted-pilot` 换成 `--track core`,并先解决 gates/G6.json
  `startPrerequisites` 里的三项(并行派发 ≤30s / toolCalls 证据方案 / E09 P7 校准决策);
- **验收**:批次目录出现 `QUALIFICATION.json`(逐 pair 鉴定状态)+ `results/aggregated.json`
  更新 + `node run.mjs gates` 门禁表,即为完成;
- **环境**:换机器先 `npm install`(cocosair 从 vendor 内置 tarball 离线可装),详见 README 克隆恢复段。
