// gates/G6.json:仅追加本会话战役进度到 executed 叙述(状态保持 NOT_RUN,不删历史文字)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = path.join(BENCH, 'gates', 'G6.json');
const g = JSON.parse(fs.readFileSync(f, 'utf8'));
if (g.gate !== 'G6 CORE_MATRIX_COMPLETENESS' || g.status !== 'NOT_RUN') throw new Error('G6 记录不符合预期,拒绝改写');
if (g.executed.includes('B-20261016-R01')) throw new Error('本批次已登记,拒绝重复追加');

g.executed += ' | 2026-10-17(S5=K0×R03×E01-E05,B-20261016-R01,编排会话=Qoder Desktop 子代理仪器;战役位置 5/12 切片、磁盘 core pair 25/60 对):'
  + '五对全链跑完,collect 9/10(E03/arm-b 被宿主 maxTurns=150 截断且 toolcall 150>120 → LEGACY_PROVISIONAL 进诊断区,计数未改写);'
  + 'E01/E02/E04/E05 = QUALIFIED;盲评双 pass + E01 分歧决定性 pass-3,G7 PASS 下 formal 有定义'
  + '(E01 68/69、E02 64/65、E04 77/66、E05 91/71;Δformal = +1/+1/−11/−20)。'
  + '**G6 仍 NOT_RUN 且本批次未进 core 正式分组**:系统 Chrome 154.0.8037.97→155.0.8059.40 自动升级,'
  + 'aggregate 判 toolchainMatch=MISMATCH(量尺 RULER-20261005-R02 在 154 冻结),groups.n 未因 R03 增加、objective attainment=null;'
  + '同批次还记录两处 harness 缺陷(validate 不释放锁且 --force 跳过 validated 臂;复验机械污染 walltime)+ E01/E02 P4 判据双采样盲区,'
  + '全部留痕于 results/B-20261016-R01/ROUND.json.notes 与 _validation-attempt1-ENVFAIL/。'
  + 'R03 是否入正式主张、以及 12 切片战役在 Chrome 换版后的推进方式,需 Owner 决断。';
g.updatedAt = new Date().toISOString();

const text = JSON.stringify(g, null, 2) + '\n';
if (text.length < 1000) throw new Error('序列化异常,放弃写盘');
fs.writeFileSync(f, text);
console.log('G6.status=' + g.status + ' executed 追加完成(长度 ' + g.executed.length + ')');
