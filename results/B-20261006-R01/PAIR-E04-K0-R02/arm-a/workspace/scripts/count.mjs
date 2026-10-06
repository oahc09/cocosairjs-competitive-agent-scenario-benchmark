#!/usr/bin/env node
// ============================================================================
// count.mjs — Agent Run 预算机器计数(系统侧计数器,Agent 只能调用、不能手改)
// ----------------------------------------------------------------------------
// 用法: node scripts/count.mjs build|browser
//
// 行为: 在 <workspace>/.budget/<kind>.count 原子追加一行 ISO-8601 时间戳。
//   * build   — 已串联进 `npm run build`(package.json: count 在 build.mjs 之前,
//               先计后执行);每次构建必被计数,不可绕过。
//   * browser — 由 scripts/verify-browser.mjs 在创建浏览器会话前自动调用;
//               若以任何其他方式打开浏览器,必须先手动执行本命令再开会话
//               (RUN-CONTRACT §2 计数口径)。
//
// 原子性: exFAT 无锁原语,这里用「open('a') 追加模式 + 单次 writeSync 单行小缓冲」,
//         并发调用不会产生交错行;判定侧(budget-check.mjs)按行数计数。
//
// 红线: .budget/*.count 是系统机器计数文件 —— 手改/伪造/删除/重置 = INVALID_RUN
//       (RUN-CONTRACT §4);判定由系统侧 budget-check 读取并比对上限,自报数字仅诊断。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..'); // 本脚本位于 workspace/scripts/ 内
const KINDS = new Set(['build', 'browser']);

const kind = process.argv[2];
if (!KINDS.has(kind || '')) {
  console.error('usage: node scripts/count.mjs build|browser');
  process.exit(2);
}

const budgetDir = path.join(WORKSPACE, '.budget');
fs.mkdirSync(budgetDir, { recursive: true });
const file = path.join(budgetDir, `${kind}.count`);
const line = `${new Date().toISOString()}\n`;

const fd = fs.openSync(file, 'a'); // 追加模式:并发下各自追加,不覆盖彼此
try {
  fs.writeSync(fd, line); // 单行一次性写入,避免半行交错
} finally {
  fs.closeSync(fd);
}

const n = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
console.log(`[count] ${kind} #${n} -> ${path.relative(WORKSPACE, file).replaceAll('\\', '/')}`);
