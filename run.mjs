#!/usr/bin/env node
// bench/run.mjs — 全实验单入口 CLI(外部 AI Agent / 人只需要记住这一条命令)
// 用法: node run.mjs <命令> [参数]
//   round create  --plan "<file|--matrix E01,E02|K0,K1|R01>"   一轮:建 Pair + 生成 DISPATCH.md
//   round <stage> --batch <B-YYYYMMDD-Rnn>   collect/validate/blind/aggregate/status
//   validate --workspace <dir> --spec <spec> [--out <dir>] [--video]   单臂验证
//   blind --batch <id> [--refs]              盲评材料构建
//   aggregate                                全量聚合(aggregated.json)
//   ceiling                                  Reference Ceiling 复算
//   regression [--force]                     引擎缺陷回归套件(版本注册表)
//   portal [--port 7800]                     报告门户
//   gates                                    打印 G0-G8 状态
//   guide                                    打印多轮执行指南
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const pass = (arr) => arr; // 透传
const CMD = {
  round: (rest) => { const stage = rest[0] || 'status'; rest = rest.slice(1);
    if (['create', 'collect', 'validate', 'blind', 'aggregate', 'status'].includes(stage))
      return ['node', path.join(BENCH, 'harness/round/run-round.mjs'), '--stage', stage, ...pass(rest)];
    return null; },
  validate: (rest) => ['node', path.join(BENCH, 'harness/runner/validate.mjs'), ...pass(rest)],
  blind: (rest) => ['node', path.join(BENCH, 'harness/judge/build-blind.mjs'), ...pass(rest)],
  aggregate: () => ['node', path.join(BENCH, 'harness/aggregate/aggregate-all.mjs')],
  ceiling: () => ['node', path.join(BENCH, 'harness/aggregate/reference-ceiling.mjs')],
  'ceiling-check': (rest) => ['node', path.join(BENCH, 'harness/aggregate/reference-versions.mjs'), '--check'],
  'ceiling-freeze': () => ['node', path.join(BENCH, 'harness/aggregate/reference-versions.mjs')],
  regression: (rest) => ['node', path.join(BENCH, 'regression/run-regression.mjs'), ...pass(rest)],
  portal: (rest) => ['node', path.join(BENCH, 'results/reports/latest/portal-server.mjs'), ...pass(rest)],
  gates: () => {
    const dir = path.join(BENCH, 'gates');
    for (const f of fs.readdirSync(dir).filter(f => /^G\d\.json$/.test(f)).sort()) {
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`${f.replace('.json', '')}  ${String(g.status).padEnd(8)} ${g.gate || ''}`);
    }
    return null; },
  guide: () => { console.log(fs.readFileSync(path.join(BENCH, 'docs/MULTI-RUN-GUIDE.md'), 'utf8')); return null; },
};

const [name, ...rest] = process.argv.slice(2);
const help = () => console.log(`用法: node run.mjs <round|validate|blind|aggregate|ceiling|regression|portal|gates|guide> [参数]
一轮闭环最短路径:
  node run.mjs round create --plan --matrix "E01,E03|K1|R01"
  → 按 results/<batch>/DISPATCH.md 派发各 Arm(外部 Agent 运行时执行)
  node run.mjs round collect   --batch <id>
  node run.mjs round validate  --batch <id>
  node run.mjs round blind     --batch <id>   (Judge 按 blind/JUDGE-INSTRUCTIONS.md 评分)
  node run.mjs round aggregate --batch <id>
引擎改版验收: node run.mjs regression`);
if (!name || !CMD[name]) { help(); process.exit(name ? 2 : 0); }
const cmd = CMD[name](rest);
if (!cmd) process.exit(0);
const p = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd: BENCH });
process.exit(p.status ?? 0);
