#!/usr/bin/env node
// isolation/leak-scanner.mjs — workspace 答案泄漏 / 协议违规扫描器
// 用途:G2-T4(答案泄漏扫描)、G4-NC06(validator tampering → INVALID_RUN)、Run 结束后产物扫描。
// 规则(命中任一即违规):
//   R1-REFERENCE-PATH  出现 bench/reference(Reference 实现/私有验证器)路径
//   R2-HARNESS-SOURCE  出现 harness/runner 等源码路径或特征串(含 probe-results.json 等产物文件名)
//   R3-PEER-ARM        出现 Pair 另一 Arm 目录名(跨 Arm 串扰;仅在给定 --peer-arm 时启用)
//   R4-SECRET-PATH     出现 secret/ 牺牲性 marker 路径
// 用法: node isolation/leak-scanner.mjs --workspace <dir> [--peer-arm arm-b] [--json] [--out <file>]
// 退出码:0=CLEAN,1=VIOLATIONS,2=用法错误。零依赖。

import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.jsonc', '.md', '.mdx', '.txt',
  '.html', '.htm', '.css', '.scss', '.less', '.yaml', '.yml', '.xml', '.svg', '.glsl',
  '.vert', '.frag', '.vs', '.fs', '.log', '.csv', '.tsv', '.map', '.ini', '.cfg', '.conf',
  '.env', '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.gitignore', '.npmignore',
  '.editorconfig', '.lock', '.toml', '.properties',
]);
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 单文件超限跳过内容扫描(记录)
const SKIP_DIRS = new Set(['.git']);
// 合规声明行:声明"未访问/未读取/未探测"某禁止目标的行(RUN-CONTRACT §7 要求 Agent 写)
const DECLARATION_RE = /未访问|未读取|未探测|未进入|没有访问|并未访问|not\s+accessed|did\s+not\s+(access|read|visit)|禁.*仅.*声明|^\s*[-*]?\s*\[[ xX]\]\s*(未|not)/i;

const STATIC_RULES = [
  {
    id: 'R1-REFERENCE-PATH',
    desc: '出现 bench/reference(Reference 实现/私有验证器)路径',
    patterns: [/reference[\/\\]private/i, /bench[\/\\]reference/i],
  },
  {
    id: 'R2-HARNESS-SOURCE',
    desc: '出现 harness/runner 等源码路径或特征串',
    patterns: [
      /harness[\/\\](runner|coordinator|isolation|probes|judge|aggregate|visual|lifecycle|capture)/i,
      /runner[\/\\]validate\.mjs/i,
      /leak-scanner/i,
      /run-isolation-tests/i,
      /run-nc\.mjs/i,
      /create-pair\.mjs/i,
      /run-contract-template/i,
      /probe-results\.json/i,
    ],
  },
  {
    id: 'R4-SECRET-PATH',
    desc: '出现 secret/ 牺牲性 marker 路径',
    patterns: [/(^|[\/\\])secret[\/\\]/i, /secret[\/\\]reference-marker/i],
  },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** peer arm 目录名匹配:仅在路径语境(引号/斜杠包围)下视为串扰证据。
 *  避免"ARM_B = 0.231"这类普通标识符(如星系旋臂参数)误报。 */
function peerArmPatterns(peerArm) {
  const loose = escapeRegExp(peerArm).replace(/\\?-|\\?_/g, '[-_]');
  return [new RegExp(`(?:^|[\\\\/"'\`])${loose}(?=$|[\\\\/"'\`\\s\\)])`, 'i')];
}

function walkFiles(root) {
  const out = [];
  const rec = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      if (ent.name === '.' || ent.name === '..') continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        rec(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  rec(root);
  return out;
}

/**
 * 扫描目录。opts: { peerArm?: 'arm-b', extraPatterns?: [{id,desc,patterns}] }
 * 返回 { status: 'CLEAN'|'VIOLATIONS', violations: [{rule,file,line,match}], stats }
 */
export function scanWorkspace(root, opts = {}) {
  const rules = [...STATIC_RULES, ...(opts.extraPatterns || [])];
  if (opts.peerArm) {
    rules.push({
      id: 'R3-PEER-ARM',
      desc: `出现 Pair 另一 Arm 目录名 "${opts.peerArm}"(跨 Arm 串扰)`,
      patterns: peerArmPatterns(opts.peerArm),
    });
  }

  const violations = [];
  const stats = { files: 0, scannedFiles: 0, skippedBinary: 0, skippedLarge: 0, readErrors: 0, scannedBytes: 0 };
  if (!fs.existsSync(root)) {
    return { status: 'VIOLATIONS', violations: [{ rule: 'SCAN-TARGET-MISSING', file: root, line: 0, match: 'workspace 不存在' }], stats };
  }

  for (const file of walkFiles(root)) {
    stats.files += 1;
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file).toLowerCase();
    if (!TEXT_EXT.has(ext) && !TEXT_EXT.has(base)) {
      stats.skippedBinary += 1;
      continue;
    }
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      stats.readErrors += 1;
      continue;
    }
    if (st.size > MAX_SCAN_BYTES) {
      stats.skippedLarge += 1;
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      stats.readErrors += 1;
      continue;
    }
    stats.scannedFiles += 1;
    stats.scannedBytes += Buffer.byteLength(text, 'utf8');
    const rel = path.relative(root, file).split(path.sep).join('/');
    // 协调器生成的冻结合同本身包含红线清单,不是 Agent 产物,跳过
    if (rel === 'RUN-CONTRACT.md') continue;
    // harness 验证产物(运行结束后由验证管道写入),不是 Agent 产物,跳过
    if (rel.startsWith('validation/') || rel.startsWith('validation-amended/')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 合规声明行(RUN-CONTRACT §7 强制要求的"未访问 X"声明)不算泄漏证据;
      // 先剥离 markdown 强调符,避免 "**未**访问" 这类被切碎的声明词漏判
      if (DECLARATION_RE.test(line.replace(/[*_`~]/g, ''))) continue;
      // 纯注释行不算泄漏证据(路径提及类误报源;NC06 篡改夹具为代码/数据非注释,回归安全)
      if (/^\s*(\/\/|#|--)/.test(line)) continue;
      for (const rule of rules) {
        for (const pat of rule.patterns) {
          if (pat.test(line)) {
            violations.push({
              rule: rule.id,
              desc: rule.desc,
              file: rel,
              line: i + 1,
              match: line.trim().slice(0, 160),
            });
          }
        }
      }
    }
  }
  violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { status: violations.length ? 'VIOLATIONS' : 'CLEAN', violations, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function usage() {
  console.log(`用法: node isolation/leak-scanner.mjs --workspace <dir> [--peer-arm arm-b] [--json] [--out <file>]`);
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  return Boolean(argv1) && argv1.replace(/\\/g, '/').toLowerCase().endsWith('leak-scanner.mjs');
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const workspace = get('--workspace') || get('-w');
  const peerArm = get('--peer-arm');
  const asJson = args.includes('--json');
  const out = get('--out');
  if (!workspace) {
    usage();
    process.exit(2);
  }
  const result = scanWorkspace(path.resolve(workspace), peerArm ? { peerArm } : {});
  const report = {
    scanner: 'isolation/leak-scanner.mjs',
    workspace,
    peerArm: peerArm || null,
    status: result.status,
    verdict: result.status === 'CLEAN' ? 'CLEAN' : 'INVALID_RUN',
    violations: result.violations,
    stats: result.stats,
    scannedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  }
  if (asJson) process.stdout.write(text);
  else {
    console.log(`[leak-scanner] ${workspace} → ${result.status}(files=${result.stats.files} scanned=${result.stats.scannedFiles} violations=${result.violations.length})`);
    for (const v of result.violations.slice(0, 50)) {
      console.log(`  ${v.rule}  ${v.file}:${v.line}  "${v.match.slice(0, 80)}"`);
    }
    if (result.violations.length > 50) console.log(`  …共 ${result.violations.length} 条`);
  }
  process.exit(result.status === 'CLEAN' ? 0 : 1);
}
