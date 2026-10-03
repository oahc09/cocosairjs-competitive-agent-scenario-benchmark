// probe-parse.mjs — 解析 verify-browser 输出,导出自检快照 jpeg 并打印紧凑指标
import fs from 'node:fs';
const raw = fs.readFileSync(process.argv[2], 'utf8');
const line = raw.split(/\r?\n/).find((l) => l.startsWith('[verify-browser] '));
if (!line) { console.error('no verify-browser line found'); process.exit(1); }
const j = JSON.parse(line.slice('[verify-browser] '.length));
const e = j.evalResult || {};
for (const k of ['snapA', 'snapB', 'snapC']) {
  if (e[k]) fs.writeFileSync(new URL('./' + k + '.jpg', import.meta.url), Buffer.from(e[k].split(',')[1], 'base64'));
}
const { snapA, snapB, snapC, ...rest } = e;
console.log(JSON.stringify({
  exit: 'see-stdout', appReady: j.appReady, benchReady: j.benchReady,
  consoleErrors: j.consoleErrors, uncaught: j.uncaught, shot: j.shot, metrics: rest,
}, null, 1));
