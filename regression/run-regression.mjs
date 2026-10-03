// regression/ — Cocos AIR 引擎缺陷回归套件(持续测试 → 引擎改进闭环)
// ---------------------------------------------------------------------------
// 每个用例 = 一个最小复现页面 + window.__reg 判定数据。runner 用无头浏览器加载并分类:
//   FIXED  —— 当前引擎已修复/行为正确(通过检查)
//   BUG    —— 仍复现实验中发现的缺陷(基线状态,修复后翻绿)
//   ERROR  —— 页面自身异常(不计入引擎判定)
// 用例全部来自 2026-10-02 双引擎实验的实测发现(roadmap-input.json engineBugs),
// 修复验收口径:新引擎 tarball 打入 bench/node_modules 与模板 → 跑本套件 → 全 FIXED。
import http from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));          // bench/regression
const BENCH = path.resolve(HERE, '..');
const HARN = path.join(BENCH, 'harness');
const VENDOR_REG = path.join(BENCH, 'vendor', 'engine-versions.json');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
const force = process.argv.includes('--force');

// ---------- 静态服务器(root=bench/,让用例页以 /node_modules/... 取引擎) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const p = path.normalize(path.join(BENCH, rel));
  if (!p.startsWith(BENCH) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(p));
});

// ---- 注册表读取:schema 2(engines.<engine>.versions.<版本>);v1 {versions:[...]} 原地迁移 ----
function loadRegistry() {
  let raw = null;
  if (existsSync(VENDOR_REG)) { try { raw = JSON.parse(readFileSync(VENDOR_REG, 'utf8')); } catch { /* 重建 */ } }
  if (raw && raw.schema === 2 && raw.engines) return raw;
  const airVersions = {};
  for (const v of (raw && raw.versions) || []) {
    const e = (airVersions[v.version] ||= {});
    if (v.tarballSha256) e.k0TarballSha256 = v.tarballSha256;
    if (v.report) e.regression = { report: v.report, summary: v.summary, ranAt: v.ranAt };
  }
  return { schema: 2, engines: { cocosair: { activeVersion: Object.keys(airVersions)[0] || null, versions: airVersions } } };
}

async function main() {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const cases = readdirSync(path.join(HERE, 'cases')).filter(f => f.endsWith('.html')).sort();
  const results = [];
  const { chromium } = await import(pathToFileURL(path.join(HARN, 'node_modules', 'playwright-core', 'index.mjs')).href);  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 120)));
    try {
      await page.goto(`http://127.0.0.1:${port}/regression/cases/${c}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__reg && window.__reg.done === true', null, { timeout: 15000 });
      const reg = await page.evaluate('window.__reg');
      const status = reg.outcome || (reg.expect === 'fixed' ? (reg.fixed === true ? 'FIXED' : 'BUG') : (reg.bug === true ? 'BUG' : 'FIXED'));
      results.push({ case: c.replace('.html', ''), status, detail: reg.detail || '', errors: errors.length });
      console.log(`  ${status.padEnd(5)} ${c.padEnd(26)} ${reg.detail || ''}`);
    } catch (e) {
      results.push({ case: c.replace('.html', ''), status: 'ERROR', detail: e.message.slice(0, 100), errors: errors.length });
      console.log(`  ERROR ${c} — ${e.message.slice(0, 90)}`);
    }
    await page.close();
  }
  await browser.close(); srv.close();

  // 引擎版本注册表(schema 2:engines.<engine>.versions.<版本> 映射;v1 数组格式读入时迁移)
  const enginePkg = JSON.parse(readFileSync(path.join(BENCH, 'node_modules', 'cocosair.js', 'package.json')));
  const moduleSha = createHash('sha256').update(readFileSync(path.join(BENCH, 'node_modules', 'cocosair.js', 'build', 'npm', 'cocosair.module.js'))).digest('hex');
  const reg = loadRegistry();
  const airReg = (reg.engines.cocosair ||= { activeVersion: enginePkg.version, versions: {} });
  const entry = (airReg.versions[enginePkg.version] ||= { sdkDir: `vendor/cocosair/${enginePkg.version}`, moduleSha256: moduleSha });
  entry.moduleSha256 ||= moduleSha;
  // K0 tarball 路径优先取注册表登记(更换引擎时只改注册表),兜底历史文件名
  const k0Rel = entry.k0Tarball || 'vendor/cocosair.js-1.0.0-k0.tgz';
  const tarball = path.join(BENCH, k0Rel);
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  entry.k0Tarball = k0Rel;
  entry.k0TarballSha256 = sha;
  airReg.activeVersion = enginePkg.version;
  const report = {
    ranAt: new Date().toISOString(), engineVersion: enginePkg.version, tarballSha256: sha,
    summary: { total: results.length, fixed: results.filter(r => r.status === 'FIXED').length, bug: results.filter(r => r.status === 'BUG').length, error: results.filter(r => r.status === 'ERROR').length },
    cases: results,
  };
  const out = path.join(HERE, `report-v${enginePkg.version}-${sha.slice(0, 8)}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  entry.regression = { report: path.relative(BENCH, out), summary: report.summary, ranAt: report.ranAt };
  reg.updatedAt = new Date().toISOString();
  writeFileSync(VENDOR_REG, JSON.stringify(reg, null, 2) + '\n');
  console.log(`\nregression: FIXED=${report.summary.fixed} BUG=${report.summary.bug} ERROR=${report.summary.error} → ${path.relative(BENCH, out)}`);
  console.log('修复验收口径:BUG 数随引擎版本归零;历史对比见 vendor/engine-versions.json');
  process.exit(report.summary.error > 0 && force ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
