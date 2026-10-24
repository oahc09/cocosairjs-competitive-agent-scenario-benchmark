#!/usr/bin/env node
/**
 * pack-engine.mjs — 从 vendor/<engine>/<版本>/ sdkDir 确定性重打 AIR 安装工件。
 *
 * 背景(2026-10-24 Owner 裁决):git 内的 tgz 是旧构建的快照,sdkDir 才是引擎正典;
 * 供给链(create-pair 安装源哈希 / preflight 指纹 / 量尺指纹 / 根 node_modules file: 安装)
 * 一律以"从 sdkDir 现打的确定性 tarball"为准,不再依赖 git 里会过时的 tgz。
 *
 * 用法:
 *   node tools/pack-engine.mjs             # if-stale:预期内容与盘上/登记不一致才重写
 *   node tools/pack-engine.mjs --check     # 只算不写;STALE 时退出码 2,UP-TO-DATE 退出 0
 *   node tools/pack-engine.mjs --force     # 无条件重写
 *   node tools/pack-engine.mjs --dry-run   # 只算不写,打印预期 sha/尺寸/条目数(冒烟用)
 *
 * 安装面口径(与历史 npm pack tgz 同构;verify-knowledge V4 要求 k0 = full − docs):
 *   full = README.md, LICENSE, package.json, build/**, licenses/**, docs/**(剔 docs/evidence/**)
 *   k0   = full − docs/**(K0 冷启动隔离:Agent 装到的包里读不到官方文档)
 *   排除面: skills/**(Agent 技能供给由 create-pair 从 sdkDir 单独拷贝,非 npm 安装面)、
 *           docs/evidence/**(1.4GB 浏览器矩阵证据媒体,非安装面)
 *   顶层出现白名单外的目录/文件 → 打 WARN(可见性)但不打断。
 *
 * 确定性:tarWrite 统一 mtime/mode/package.json 首位 + 字节序;gzip level 9 + mtime 0。
 * 同一 sdkDir 任意次重打 sha256 相同 → 登记哈希稳定、跨批指纹可比。
 * 重写时同步更新:vendor/engine-versions.json(tarballSha256/k0TarballSha256/source/updatedAt)
 * 与 knowledge/K0/cocosair/manifest.json 的 k0Tarball{sha256,bytes}(verify-knowledge V4 口径)。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tarWrite, sha256, ROOT } from './build-knowledge.mjs';

const REG_PATH = path.join(ROOT, 'vendor', 'engine-versions.json');
const K0_MANIFEST = path.join(ROOT, 'knowledge', 'K0', 'cocosair', 'manifest.json');

// 安装面白名单(顶层);skills 与 docs/evidence 为政策性排除(WARN 静默),其余白名单外条目 WARN
export const TOP_INCLUDE = new Set(['README.md', 'LICENSE', 'package.json', 'build', 'docs', 'licenses']);
const TOP_QUIET_EXCLUDE = new Set(['skills']);
const DOCS_EXCLUDE_PREFIX = 'docs/evidence/';

/** sdkDir 相对路径 → 是否属于 npm 安装面(verify-knowledge V9 的 cocosair 比对同律) */
export function isInstallSurface(rel) {
  const top = rel.split('/')[0];
  if (!TOP_INCLUDE.has(top)) return false;
  return !rel.startsWith(DOCS_EXCLUDE_PREFIX);
}

const arg = (k) => process.argv.includes('--' + k);
const MODE = arg('check') ? 'check' : arg('dry-run') ? 'dry-run' : arg('force') ? 'force' : 'if-stale';

function die(m) { console.error('[pack-engine] ERROR: ' + m); process.exit(1); }

function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, base, out);
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), abs: full });
  }
  return out;
}

/** 读取注册表并解析 cocosair activeVersion 条目 */
function loadEntry() {
  if (!fs.existsSync(REG_PATH)) die('注册表不存在: vendor/engine-versions.json');
  const reg = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
  const e = reg.engines && reg.engines.cocosair;
  const v = e && e.versions && e.versions[e.activeVersion];
  if (!v) die('注册表缺 cocosair activeVersion 条目');
  if (!v.sdkDir || !v.tarball || !v.k0Tarball) die('activeVersion 条目缺 sdkDir/tarball/k0Tarball 字段');
  return { reg, e, v, sdkAbs: path.join(ROOT, ...v.sdkDir.split('/')), tarAbs: path.join(ROOT, ...v.tarball.split('/')), k0Abs: path.join(ROOT, ...v.k0Tarball.split('/')) };
}

/** 安装面筛选 + 打包为 Buffer(不落盘) */
function pack(sdkAbs) {
  if (!fs.existsSync(sdkAbs)) die(`sdkDir 不存在: ${sdkAbs}`);
  const included = [];
  const seenTops = new Set();
  for (const f of walkFiles(sdkAbs)) {
    seenTops.add(f.rel.split('/')[0]);
    if (!isInstallSurface(f.rel)) continue;
    included.push(f);
  }
  for (const top of seenTops) {
    if (!TOP_INCLUDE.has(top) && !TOP_QUIET_EXCLUDE.has(top)) {
      console.warn(`[pack-engine] WARN: 顶层白名单外条目未入包: ${top}/`);
    }
  }
  const entries = included.map((f) => ({ name: 'package/' + f.rel, data: fs.readFileSync(f.abs) }));
  const k0Entries = entries.filter((en) => !en.name.startsWith('package/docs/'));
  if (!k0Entries.some((en) => en.name === 'package/package.json')) die('安装面不含 package/package.json');
  if (entries.length === k0Entries.length) die('k0 与 full 条目数相同 — docs 剔除未生效?');
  const mk = (list) => zlib.gzipSync(tarWrite(list), { level: 9, mtime: 0 });
  return { full: mk(entries), k0: mk(k0Entries), nFull: entries.length, nK0: k0Entries.length };
}

function main() {
  const { reg, v, sdkAbs, tarAbs, k0Abs } = loadEntry();
  console.log(`[pack-engine] sdkDir=${v.sdkDir} full=${v.tarball} k0=${v.k0Tarball} mode=${MODE}`);
  const t0 = Date.now();
  const { full, k0, nFull, nK0 } = pack(sdkAbs);
  const fullSha = sha256(full);
  const k0Sha = sha256(k0);
  console.log(`[pack-engine] full: ${nFull} 条目 ${(full.length / 1048576).toFixed(1)}MB sha=${fullSha.slice(0, 16)}…`);
  console.log(`[pack-engine] k0:   ${nK0} 条目 ${(k0.length / 1048576).toFixed(1)}MB sha=${k0Sha.slice(0, 16)}…  (${Date.now() - t0}ms)`);

  if (MODE === 'check' || MODE === 'dry-run') {
    const cur = (p) => (fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null);
    const staleFull = cur(tarAbs) !== fullSha;
    const staleK0 = cur(k0Abs) !== k0Sha;
    if (MODE === 'dry-run') {
      console.log(`[pack-engine] dry-run: 盘上 full=${staleFull ? '漂移' : '一致'} k0=${staleK0 ? '漂移' : '一致'}(未写盘)`);
      process.exit(0);
    }
    console.log(staleFull || staleK0 ? '[pack-engine] STALE — 需要重打' : '[pack-engine] UP-TO-DATE');
    process.exit(staleFull || staleK0 ? 2 : 0);
  }

  // force / if-stale:逐工件按需重写,再同步登记
  const changed = [];
  const ensureArtifact = (abs, buf, label) => {
    if (!buf.length) die(`${label} 打包结果为空,拒绝写盘`);
    const curSha = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
    if (MODE === 'force' || curSha !== sha256(buf)) {
      console.log(`[pack-engine] ${label}: ${curSha ? curSha.slice(0, 12) + '… → ' : '缺失 → '}${sha256(buf).slice(0, 12)}… (${curSha ? '重写' : '新写'})`);
      fs.writeFileSync(abs, buf);
      changed.push(label);
    }
  };
  ensureArtifact(tarAbs, full, 'full tgz');
  ensureArtifact(k0Abs, k0, 'k0 tgz');

  let regTouched = false;
  if (v.tarballSha256 !== fullSha) { v.tarballSha256 = fullSha; regTouched = true; }
  if (v.k0TarballSha256 !== k0Sha) { v.k0TarballSha256 = k0Sha; regTouched = true; }

  // K0 manifest 的 k0Tarball 登记是 verify-knowledge V4 的校验点,随 k0 内容同步
  const mf = JSON.parse(fs.readFileSync(K0_MANIFEST, 'utf8'));
  if (!mf.k0Tarball) die('K0 manifest 缺 k0Tarball 字段');
  if (mf.k0Tarball.sha256 !== k0Sha || mf.k0Tarball.bytes !== k0.length) {
    mf.k0Tarball.sha256 = k0Sha;
    mf.k0Tarball.bytes = k0.length;
    const out = JSON.stringify(mf, null, 2) + '\n';
    if (out.length < 100) die('K0 manifest 回写内容异常,拒绝写盘');
    fs.writeFileSync(K0_MANIFEST, out);
    console.log('[pack-engine] knowledge/K0/cocosair/manifest.json k0Tarball 登记已同步');
  }

  if (regTouched || changed.length) {
    v.source = `${v.sdkDir} 经 tools/pack-engine.mjs 从 sdkDir 确定性重打(安装面:剔 skills/ 与 docs/evidence/)`;
    reg.updatedAt = new Date().toISOString();
    const out = JSON.stringify(reg, null, 2) + '\n';
    if (out.length < 200) die('engine-versions.json 回写内容异常,拒绝写盘');
    fs.writeFileSync(REG_PATH, out);
    console.log(`[pack-engine] 完成: ${changed.length ? changed.join(' + ') + ' 重写' : '仅登记哈希校正'},注册表已同步`);
  } else {
    console.log('[pack-engine] UP-TO-DATE — 盘上工件与 sdkDir 现打内容一致,未写盘');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
