// 追加 B-20261016-R01 编排侧留痕到 ROUND.json.notes(不动既有字段;写盘前断言非空)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = path.join(BENCH, 'results', 'B-20261016-R01', 'ROUND.json');
const round = JSON.parse(fs.readFileSync(f, 'utf8'));
if (!Array.isArray(round.notes)) throw new Error('notes 不是数组,拒绝改写');
const before = round.notes.length;

round.notes.push(
  '[编排留痕·仪器变更] 本批次(K0×R03)执行仪器由既往 CLI Agent 换为 Qoder Desktop 子代理(general-purpose,每臂全新会话)。' +
  'RUN-META.agentRuntime/modelId 如实登记(qoder-desktop-agent;宿主模型 id 不披露)。跨仪器比较时 R03 与 R01/R02 不同仪器,' +
  '引擎对比结论只在同仪器重复轮内成立,仪器换版须单独分层报告。',

  '[编排留痕·E01 重派] E01/arm-a 首两次派发因编排侧失误(单臂独占一波,双臂未同批启动)判废,' +
  '两次尝试整体归档至本批次 _attempt1-archive/PAIR-E01-K0-R03/(证据未删除);' +
  'arm-a 工作区按 create-pair 同款跳过规则从 templates/three 重置,两臂时序章用 agent-launcher start --force 重盖' +
  '(先例 B-20261006-R02:按真实派发时刻重盖并留痕)。最终五对 executionTiming 全 PASS(startDeltaSec=0)。',

  '[ENV 缺陷·首验全废] 首次 round validate 9/9 臂 FAIL/RUNTIME,根因非引擎非臂:宿主 ms-playwright 缓存里 playwright-core@1.63.0' +
  ' 钉定的 ffmpeg-1011 被 2026-10-14 的 playwright 升级替换为 ffmpeg-1013,浏览器启动即失败(appReady=false)。' +
  '处置:node node_modules/playwright-core/cli.js install ffmpeg 从官方 CDN 补回 v1011(+winldd v1007),仓库零改动;' +
  '首验产物整体复制到 _validation-attempt1-ENVFAIL/(含 ROUND.attempt1.json),两次结果都留档后 validate --force 复验。',

  '[ENV 缺陷·浏览器换版] 系统 Chrome 由 154.0.8037.97 自动升级到 155.0.8059.40,而量尺 RULER-20261005-R02 在 154 下冻结。' +
  'aggregate 按 toolchainMatch 判 MISMATCH,本批次全部 R03 对被排除出 core 正式分组(groups.n 未增加),objective attainment=null;' +
  'formal attainment 未被同一门禁拦住(口径不一致,见 harness 缺陷条)。R03 数据是否入正式主张需 Owner 决断' +
  '(选项:同 Chrome 版本重验 20 Reference 并 ceiling-freeze 换新量尺 / 接受为跨 toolchain 单列 / 固定浏览器版本再跑下一轮)。',

  '[harness 缺陷·复验污染] budget-check 的 walltime = .budget/*.count 全部 ISO 行首尾跨度,而 validate.mjs 自身会跑一次' +
  ' npm run build(经模板 scripts/count.mjs 追加带当前时间戳的行)。第二次验证的 span 上界因此变成首验时刻,' +
  '机械造出 5 臂 walltime 151/130/105>90 的假 BUDGET_EXHAUSTED(真实臂墙钟 6-35min)。' +
  'run-round 的 spawn 前快照只隔离"次数"不隔离"时间戳"⇒ 任何复验都会污染 walltime。' +
  '干净窗口判定保留在 _validation-attempt1-ENVFAIL/ROUND.attempt1.json(9/9 budget=OK)。未做任何计数改写或漏记。' +
  'qualification 不消费 walltime(查 toolcall 行数 + execution.json 时序),四个 QUALIFIED 不受该假象影响。',

  '[harness 缺陷·锁与 force 语义] (1) run-round.mjs 定义 releaseLock() 但全文从未调用 → 每次 validate 遗留 harness/.validation-lock,' +
  '下一次须等 10 分钟陈旧窗口才接管;锁 mtime 只在 acquire 时写、运行中不刷新,单次验证 >10min 时并发第二会话会误判陈旧并强行并行,' +
  '破坏 R3-7"单 GPU 串行"保证。(2) --force 只重验 state=completed 的臂,已 validated 的臂会被静默跳过(本轮靠回退状态才复验成功)。',

  '[判据口径·P4 双采样窗] 冻结 spec 的 E01/E02 P4 意图是"滚轮穿行/拖拽环绕后相机变化 ≥5 单位 / 方位角 >20°",' +
  '但 probe-executor 在 sampleWindowMs>0 时把 $.before/$.after 绑成动作之后相隔 300ms 的两次采样' +
  '(harness/runner/probe-executor.mjs:1950-1953),测的是动画尾段是否仍在推进,不是动作效果。' +
  'R03 双臂状态实际都变了(three 120→84.2、cocosair 120→48.5;E02 three cameraAzimuth 35→124.5)仍判 FAIL,' +
  '并连带 P6/P7 SKIPPED_BY_DEPENDENCY(passRate 0.714/0.571)。同一 validator 协议哈希 0c9659aa… 下' +
  ' E01 P4 历史 6 臂全 PASS、E02 P4 历史 three 3/3 PASS 而 cocosair 0/3 PASS ⇒ R03 出现 three 也 FAIL 属判据盲区命中,' +
  '非引擎能力差异、非判据代码变更。判据与 spec 均为冻结面,未改。',

  '[方案A hard 如实] E03/arm-b(cocosair)被宿主子代理硬上限 maxTurns=150 截断,无 RESULT.md,机器计数 150>120 →' +
  ' collect 判未完成、qualify 降 LEGACY_PROVISIONAL(toolcall 超限 + 该臂缺 report)。该对只进诊断区,E03×K0 的 core 数据由 R01/R02 供给;' +
  '计数未改写、trial 未删除。另:K0 白名单可达性缺口延续 —— 臂可用已安装引擎包与自身 dist 里的 bundle/d.ts 做 API 自省。',

  '[S4 补齐] run.mjs 无 code-review 路由,既往批次逐臂手调 harness/runner/code-review.mjs。本批次 9 个已验证臂补跑该确定性静态检查' +
  '(写各臂 validation/code-review.json),S4=5 后 formal 总分与 pairedDelta 才有定义。',
);

round.updatedAt = new Date().toISOString();
const text = JSON.stringify(round, null, 2) + '\n';
if (text.length < 1000) throw new Error('序列化结果异常,放弃写盘');
fs.writeFileSync(f, text);
console.log(`notes ${before} -> ${round.notes.length}`);
