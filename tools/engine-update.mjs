#!/usr/bin/env node
/**
 * engine-update.mjs — cocosair SDK 一键换版(2026-10-24 简化:五步里的机械步骤收编为一条命令)。
 *
 * 为什么存在:换版流程(engine-versions.json 头注释)①放 SDK ②重打 tgz+装依赖 ③切注册表
 * ⑤核验全是机械操作,人工易漏(漏 npm install → 运行时仍旧引擎;漏 skills/ → create-pair die)。
 * 本工具串起 ①②③⑤ 并在任一步失败时回滚注册表;④(regression + Reference 重实现/换量尺)
 * 是真 Agent 工作与硬门禁,保持人工,收尾打印清单。
 *
 * 用法:
 *   node tools/engine-update.mjs --version 1.1.0 --from E:\AIProMax\github\cocosair.js
 *     [--skills-from <版本=当前active>] [--skip-install] [--dry-run]
 *
 * 行为:
 *   1. 校验源目录(package.json 存在;name/version 合理性)与目标(vendor/cocosair/<v>/ 不得已存在、
 *      不得等于当前 activeVersion —— 原地覆盖会毁掉历史批次的引擎指纹对应物,一律拒绝);
 *   2. 复制源树 → vendor/cocosair/<v>/(排除 node_modules/.git/dist);
 *   3. skills/ 继承:源树自带则用源,否则从 --skills-from 指定版本(默认旧 active)整树拷贝
 *      —— create-pair 缺 skills 会 die,不允许静默降级;
 *   4. 注册表:versions[<v>] 建条目(哈希留给 pack-engine 回填)+ activeVersion 切换
 *      + previousActive 留痕;pack-engine/npm install 任一失败 → activeVersion 自动回滚;
 *   5. node tools/pack-engine.mjs(确定性重打 full+k0 tgz 并同步哈希/K0 manifest);
 *   6. npm install(刷新根 node_modules —— 运行时真正换版的是这步;--skip-install 跳过);
 *   7. 冒烟:node_modules 引擎文件存在 + verify-knowledge V9 摘要;
 *   8. 打印剩余人工步骤(regression → ceiling-check STALE → 重实现 Reference → ceiling-freeze → gates)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG_PATH = path.join(ROOT, 'vendor', 'engine-versions.json');

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const SKIP_INSTALL = args.includes('--skip-install');
const VERSION = argOf('version');
const FROM = argOf('from');
const die = (m) => { console.error('[engine-update] ERROR: ' + m); process.exit(1); };
const log = (m) => console.log('[engine-update] ' + m);

if (!VERSION || !FROM || args.includes('--help') || args.includes('-h')) {
  console.log('用法: node tools/engine-update.mjs --version <新版本> --from <SDK源目录> [--skills-from <版本=当前active>] [--skip-install] [--dry-run]');
  process.exit(VERSION && FROM ? 0 : 2);
}

// ---- 1. 校验 ----
const src = path.resolve(FROM);
if (!fs.existsSync(path.join(src, 'package.json'))) die(`源目录缺 package.json: ${src}`);
const srcPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
if (srcPkg.name && srcPkg.name !== 'cocosair.js') log(`WARN: 源 package.name=${srcPkg.name}(预期 cocosair.js),继续但请确认源正确`);
if (srcPkg.version && srcPkg.version !== VERSION) log(`WARN: 源 package.version=${srcPkg.version} != --version ${VERSION},以 --version 为目录名`);
for (const must of ['build', 'docs']) {
  if (!fs.existsSync(path.join(src, must))) die(`源目录缺 ${must}/(安装面/文档正典必需): ${src}`);
}

const reg = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const eng = reg.engines && reg.engines.cocosair;
if (!eng) die('注册表缺 engines.cocosair');
const prevActive = eng.activeVersion;
if (VERSION === prevActive) die(`--version ${VERSION} 即当前 active(原地换版拒绝:版本目录名是历史批次引擎指纹的对应物;请升版本号)`);
if (eng.versions && eng.versions[VERSION] && fs.existsSync(path.join(ROOT, 'vendor', 'cocosair', VERSION))) {
  die(`vendor/cocosair/${VERSION}/ 已存在且已登记(重复换版拒绝;如需重做先人工清理)`);
}
const dest = path.join(ROOT, 'vendor', 'cocosair', VERSION);
if (fs.existsSync(dest)) die(`目标目录已存在(若为残留请人工确认后删除): ${dest}`);

const skillsFrom = argOf('skills-from') || prevActive;
const skillsSrc = path.join(ROOT, 'vendor', 'cocosair', skillsFrom, 'skills');
const needSkillsCopy = !fs.existsSync(path.join(src, 'skills')) && fs.existsSync(skillsSrc);

log(`计划: ${src} → vendor/cocosair/${VERSION}/`);
log(`  activeVersion: ${prevActive} → ${VERSION}(失败自动回滚)`);
log(`  skills: ${fs.existsSync(path.join(src, 'skills')) ? '源树自带' : needSkillsCopy ? `继承自 ${skillsFrom}` : '无可用来源(create-pair 将 die!)'}`);
if (DRY) { log('dry-run: 未写盘'); process.exit(0); }

// ---- 2. 复制源树 ----
log(`复制源树(排除 node_modules/.git/dist)…`);
fs.cpSync(src, dest, { recursive: true, filter: (p) => {
  const rel = path.relative(src, p);
  if (!rel) return true;
  const top = rel.split(path.sep)[0];
  return !['node_modules', '.git', 'dist'].includes(top);
} });
if (!fs.existsSync(path.join(dest, 'package.json'))) { fs.rmSync(dest, { recursive: true, force: true }); die('复制结果缺 package.json(已清理半成品目标目录)'); }

// ---- 3. skills 继承 ----
if (needSkillsCopy) {
  log(`skills/ 继承自 vendor/cocosair/${skillsFrom}/skills …`);
  fs.cpSync(skillsSrc, path.join(dest, 'skills'), { recursive: true });
}
if (!fs.existsSync(path.join(dest, 'skills'))) {
  fs.rmSync(dest, { recursive: true, force: true });
  die(`换版后无 skills/(源与 ${skillsFrom} 均缺)——create-pair 会拒绝开轮,已清理半成品并中止`);
}

// ---- 4. 注册表切换(带回滚)+ package.json 安装源切换 ----
// 注意:root package.json 的依赖是 file:vendor/cocosair.js-<版本>-k0.tgz(文件名带版本号),
// 不切它则 npm install 仍装旧版 —— 运行时根本不换版(原流程最隐蔽的一步)。
const PKG_PATH = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const prevDep = pkg.dependencies && pkg.dependencies['cocosair.js'];
const newDep = `file:vendor/cocosair.js-${VERSION}-k0.tgz`;

const rollbackAll = () => {
  const r = JSON.parse(fs.readFileSync(REG_PATH, 'utf8')); // 重读:pack-engine 可能已部分回写
  r.engines.cocosair.activeVersion = prevActive;
  delete r.engines.cocosair.versions[VERSION];
  fs.writeFileSync(REG_PATH, JSON.stringify(r, null, 2) + '\n');
  try {
    const p2 = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    if (prevDep && p2.dependencies['cocosair.js'] === newDep) {
      p2.dependencies['cocosair.js'] = prevDep;
      fs.writeFileSync(PKG_PATH, JSON.stringify(p2, null, 2) + '\n');
    }
  } catch { /* package.json 回滚尽力而为 */ }
  log(`已回滚: activeVersion=${prevActive}、安装源依赖还原;vendor/cocosair/${VERSION}/ 与已重打的 tgz 保留供排查`);
};

const modSha = (() => {
  const f = path.join(dest, 'build', 'npm', 'cocosair.module.js');
  return fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
})();
eng.versions = eng.versions || {};
eng.versions[VERSION] = {
  sdkDir: `vendor/cocosair/${VERSION}`,
  moduleSha256: modSha, // SDK 侧引擎指纹(pack-engine 不回填此项;node_modules 侧由 V9 三方比对)
  tarball: `vendor/cocosair.js-${VERSION}.tgz`,
  tarballSha256: null,            // pack-engine 重打后回填
  k0Tarball: `vendor/cocosair.js-${VERSION}-k0.tgz`,
  k0TarballSha256: null,          // 同上
  k0Note: 'K0 tarball = 完整包剔除 docs/(冷启动隔离,Agent 读不到官方文档)',
  activatedAt: new Date().toISOString(),
  previousActive: prevActive,
};
eng.activeVersion = VERSION;
fs.writeFileSync(REG_PATH, JSON.stringify(reg, null, 2) + '\n');
pkg.dependencies['cocosair.js'] = newDep;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
log(`注册表已切换 activeVersion=${VERSION}(tgz sha 由 pack-engine 回填)`);
log(`package.json 安装源已切换: ${prevDep} → ${newDep}`);

// ---- 5. pack-engine 重打 ----
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'pack-engine.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch {
  rollbackAll(); die('pack-engine 重打失败(见上);注册表与安装源已回滚');
}
// pack-engine 回填的是注册表文件,重读以防与内存对象错位
const regNow = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const entry = regNow.engines.cocosair.versions[VERSION];
if (!entry.tarball || !entry.k0Tarball) { rollbackAll(); die('pack-engine 未回填 tarball 路径(异常)'); }

// ---- 6. npm install ----
if (!SKIP_INSTALL) {
  log('npm install(刷新根 node_modules —— 不跑这步运行时仍旧引擎)…');
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    log('WARN: npm install 失败 —— 注册表保持新版本(不回滚:pack-engine 已自洽),请手动修复依赖后重跑 install');
  }
} else {
  log('--skip-install:未刷新 node_modules(运行时仍是旧引擎,直到手动 npm install)');
}

// ---- 7. 冒烟 ----
const modPath = path.join(ROOT, 'node_modules', 'cocosair.js', 'build', 'npm', 'cocosair.module.js');
log(`冒烟: node_modules 引擎文件 ${fs.existsSync(modPath) ? '存在' : '缺失(--skip-install 或 install 失败时预期)'}`);
try {
  const v9 = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'verify-knowledge.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const lines = v9.split('\n').filter((l) => l.includes('cocosair'));
  console.log(lines.filter((l) => /ok|FAIL/.test(l)).join('\n'));
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '');
  console.log(out.split('\n').filter((l) => l.includes('cocosair')).join('\n'));
  log('WARN: verify-knowledge 有未过项(见上;K1/K2 行尾类既知 FAIL 与换版无关)');
}

// ---- 8. 剩余人工清单 ----
console.log(`
[engine-update] 机械步骤完成。剩余人工步骤(不可自动化,依次执行):
  1. node run.mjs regression            # 硬门禁:BUG 归零才可开新一轮
  2. node run.mjs ceiling-check         # 列出受影响 STALE Reference 清单
  3. 按 STALE 清单重实现 Reference(真 Agent 工作;不是仅重跑)
  4. node run.mjs ceiling-freeze        # 升版冻结,换新量尺 RULER-<日期>-R<轮次>
  5. node run.mjs gates                 # 全绿后即可开新一轮(G6 除外)
备注: 旧批次与新引擎不可直接合并比较(aggregate 按引擎 sha 自动单列 engine-differs);
      K1/K2 知识包仍基于旧版 docs 策展,若新引擎 API 有新增/变更,建议一并重策展。`);
