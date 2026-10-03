#!/usr/bin/env node
// code-review.mjs — S4 规则化静态检查(整改 §6;两引擎一致/可复算/有证据/不读 Reference)
// 用法: node harness/runner/code-review.mjs --arm <arm目录> [--out <路径>]
//   默认写 <arm>/validation/code-review.json
// S4 合同(metric-spec):结构清晰无死代码 3 分 + 无明显反模式 2 分。
// 规则全部确定性、与引擎无关;evidence 逐条落盘;reviewer/protocolHash 记录协议版本。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PROTOCOL = 'code-review-v1(规则:结构=入口存在/模块聚焦/注释密度/构建链完整;反模式=调试残留/超量console.log/TODO密度)';
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };

const arm = path.resolve(arg('arm') || process.exit((console.error('--arm 必填'), 2)));
// 双布局:Pair 臂(workspace/ 子目录)与 Reference(目录即 workspace)
const ws = fs.existsSync(path.join(arm, 'workspace')) ? path.join(arm, 'workspace') : arm;
const outPath = arg('out') || path.join(arm, 'validation', 'code-review.json');

const checks = { structure: [], antiPatterns: [] };
const add = (group, ok, weight, evidence) => checks[group].push({ ok: !!ok, weight, evidence: String(evidence).slice(0, 160) });

// ---- 结构(满分 3)----
const mainSrc = path.join(ws, 'src', 'main.js');
add('structure', fs.existsSync(mainSrc), 0.75, 'src/main.js 单一入口存在');
const mainText = fs.existsSync(mainSrc) ? fs.readFileSync(mainSrc, 'utf8') : '';
const mainLines = mainText ? mainText.split('\n').length : 0;
add('structure', mainLines >= 60, 0.75, `入口实现量 ${mainLines} 行(≥60,非模板残留)`);
const sectionComments = (mainText.match(/\/\/ ={3,}|\/\/ ---+|\/\*\*/g) || []).length;
add('structure', sectionComments >= Math.max(2, Math.floor(mainLines / 120)), 0.75, `分段注释 ${sectionComments} 处(模块化组织)`);
const scriptsOk = ['build.mjs', 'serve.mjs', 'count.mjs', 'verify-browser.mjs'].every(f => fs.existsSync(path.join(ws, 'scripts', f)));
add('structure', scriptsOk, 0.75, 'scripts/ 构建与服务链完整(build/serve/count/verify-browser)');

// ---- 反模式(满分 2)----
const debugArtifacts = fs.readdirSync(ws).filter(f => /\.(out|jpg)$/.test(f) || /^(probe-parse|snap|dbg|debug)/i.test(f));
add('antiPatterns', debugArtifacts.length <= 2, 0.67, `workspace 根调试残留 ${debugArtifacts.length} 个(${debugArtifacts.slice(0, 4).join(',') || '无'};≤2 容忍)`);
const consoleLogs = (mainText.match(/console\.log\s*\(/g) || []).length;
add('antiPatterns', consoleLogs <= 6, 0.67, `入口 console.log ${consoleLogs} 处(≤6;HUD 诊断可容忍)`);
const todos = (mainText.match(/TODO|FIXME|XXX/g) || []).length;
add('antiPatterns', todos <= 3, 0.66, `TODO/FIXME ${todos} 处(≤3)`);

const score = (g) => Math.round(checks[g].filter(c => c.ok).reduce((s, c) => s + c.weight, 0) * 10) / 10;
const structure = Math.min(3, score('structure'));
const antiPatterns = Math.min(2, score('antiPatterns'));
const total = Math.min(5, structure + antiPatterns);

const report = {
  structure: { score: structure, max: 3, evidence: checks.structure.map(c => `${c.ok ? 'PASS' : 'FAIL'}(${c.weight}) ${c.evidence}`) },
  antiPatterns: { score: antiPatterns, max: 2, evidence: checks.antiPatterns.map(c => `${c.ok ? 'PASS' : 'FAIL'}(${c.weight}) ${c.evidence}`) },
  total,
  reviewer: 'rule-based-static-v1(整改 §6;两引擎一致;零 Reference 读取)',
  protocolHash: crypto.createHash('sha256').update(PROTOCOL).digest('hex'),
  reviewedAt: new Date().toISOString(),
  arm: path.basename(path.dirname(arm)),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`[code-review] ${report.arm}: S4=${total}/5 (structure ${structure}/3, anti ${antiPatterns}/2) → ${path.relative(ROOT, outPath)}`);
