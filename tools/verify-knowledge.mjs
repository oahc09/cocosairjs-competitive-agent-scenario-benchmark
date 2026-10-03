#!/usr/bin/env node
/**
 * verify-knowledge.mjs — 知识包完整性与红线自检。
 *
 * 用法:  node tools/verify-knowledge.mjs     (在 bench/ 下运行)
 *
 * 检查项:
 *   V1 六个 manifest 与实际文件一致(sha256/bytes/无缺失/无多余)
 *   V2 manifest 必备字段齐全(engine/level/files/totalBytes/domainCoverage 九域/curationRule)
 *   V3 K0 真冷: K0 目录仅 README.md + manifest.json
 *   V4 k0 tarball: 无 package/docs/; 条目集合 = 原 tarball 减 docs; 与 K0 manifest 登记一致
 *   V5 泄漏扫描: K1/K2 文件路径不含与 benchmark 十场景同主题的示例名(黑名单)
 *   V6 K1/three 总量 ≤ 15MB
 *   V7 域矩阵证据文件真实存在
 *   V8 K2 ⊇ K1(同路径文件 sha256 一致, K2 是 K1 的超集)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tarRead, ROOT } from './build-knowledge.mjs';
import zlib from 'node:zlib';

const KNOW = path.join(ROOT, 'knowledge');
const PACKAGES = [
  ['K0', 'three'], ['K0', 'cocosair'],
  ['K1', 'three'], ['K1', 'cocosair'],
  ['K2', 'three'], ['K2', 'cocosair'],
];
const DOMAINS = ['Scene setup', 'Camera', 'Material', 'Animation', 'Asset load', 'Input', 'Shader', 'Postprocess', 'Particles'];
const VALID_STATUS = new Set(['yes', 'limitation documented', 'absent']);

/** benchmark 十场景主题 → 禁止出现在 K1/K2 文件路径中的示例名黑名单(词干匹配) */
const LEAK_BLACKLIST = [
  /(^|\/)webgpu_tsl_galaxy\.html$/,
  /(^|\/)webgl_shaders_ocean\.html$/,
  /(^|\/)webgpu_ocean\.html$/,
  /(^|\/)webgpu_water\.html$/,
  /(^|\/)webgl_gpgpu_water\.html$/,
  /(^|\/)webgpu_compute_water\.html$/,
  /(^|\/)webgpu_backdrop_water\.html$/,
  /(^|\/)webgpu_tsl_earth\.html$/,
  /(^|\/)webgpu_generator_city\.html$/,
  /(^|\/)webgpu_volume_fire\.html$/,
  /(^|\/)webgl_gpgpu_birds(_gltf)?\.html$/,
  /(^|\/)webgpu_compute_birds\.html$/,
  /(^|\/)webgl_(materials_envmaps.*|loader_gltf_(transmission|iridescence|dispersion|sheen))\.html$/,
  /(^|\/)model-character-interaction\//,
  /(^|\/)product-viewer\//,
  /(^|\/)gltf-viewer\//,
];

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`);
  else { failures += 1; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

console.log('== V1/V2: manifest 与文件系统一致性 + 字段完整性 ==');
const manifests = {};
for (const [level, engine] of PACKAGES) {
  const dir = path.join(KNOW, level, engine);
  const mfPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mfPath)) { check(`${level}/${engine} manifest.json 存在`, false); failures++; continue; }
  const m = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  manifests[`${level}/${engine}`] = { m, dir };

  check(`${level}/${engine} engine/level`, m.engine === engine && m.level === level);
  check(`${level}/${engine} curationRule`, m.curationRule === '不含当前 benchmark 场景答案型内容');

  const domKeys = Object.keys(m.domainCoverage || {});
  check(`${level}/${engine} 九域齐全`, domKeys.length === 9 && DOMAINS.every((d) => domKeys.includes(d)), domKeys.join(','));
  check(
    `${level}/${engine} 域状态合法`,
    DOMAINS.every((d) => m.domainCoverage[d] && VALID_STATUS.has(m.domainCoverage[d].status)),
  );

  const actual = walk(dir).filter((p) => p !== 'manifest.json');
  const listed = m.files.map((f) => f.path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const missing = listed.filter((p) => !actual.includes(p));
  const extra = actual.filter((p) => !listed.includes(p));
  check(`${level}/${engine} 无缺失文件`, missing.length === 0, missing.slice(0, 3).join(','));
  check(`${level}/${engine} 无未登记文件`, extra.length === 0, extra.slice(0, 3).join(','));

  let hashOk = true; let byteOk = true; let sumOk = true; let sum = 0;
  for (const f of m.files) {
    const buf = fs.readFileSync(path.join(dir, f.path));
    if (sha256(buf) !== f.sha256) hashOk = false;
    if (buf.length !== f.bytes) byteOk = false;
    sum += f.bytes;
  }
  check(`${level}/${engine} sha256 全部一致 (${m.files.length} 文件)`, hashOk);
  check(`${level}/${engine} bytes 全部一致`, byteOk);
  check(`${level}/${engine} totalBytes 正确`, sum === m.totalBytes, `${m.totalBytes} bytes`);
  check(`${level}/${engine} totalFiles 正确`, m.files.length === m.totalFiles);
}

console.log('== V3: K0 真冷(仅 README + manifest) ==');
for (const engine of ['three', 'cocosair']) {
  const files = walk(path.join(KNOW, 'K0', engine));
  check(`K0/${engine} 只含 README.md+manifest.json`,
    files.length === 2 && files.includes('README.md') && files.includes('manifest.json'),
    files.join(','));
}

console.log('== V4: k0 tarball 无 docs 且与原包同构 ==');
{
  const k0Path = path.join(ROOT, 'vendor', 'cocosair.js-1.0.0-k0.tgz');
  const origPath = path.join(ROOT, 'vendor', 'cocosair.js-1.0.0.tgz');
  check('k0 tarball 存在', fs.existsSync(k0Path));
  const k0 = tarRead(zlib.gunzipSync(fs.readFileSync(k0Path)));
  const orig = tarRead(zlib.gunzipSync(fs.readFileSync(origPath)));
  check('k0 无 package/docs/ 条目', k0.every((e) => !e.name.startsWith('package/docs/')));
  check('k0 含 package/package.json', k0.some((e) => e.name === 'package/package.json'));
  check('k0 根前缀为 package/', k0.every((e) => e.name.startsWith('package/')));
  const expect = new Set(orig.filter((e) => !e.name.startsWith('package/docs/')).map((e) => e.name));
  const got = new Set(k0.map((e) => e.name));
  check('k0 条目集合 = 原 tarball − docs',
    expect.size === got.size && [...expect].every((n) => got.has(n)),
    `${orig.length} → ${k0.length}`);
  const contentSame = orig.filter((e) => !e.name.startsWith('package/docs/'))
    .every((e) => { const hit = k0.find((x) => x.name === e.name); return hit && hit.data.equals(e.data); });
  check('k0 保留文件内容与原包一致', contentSame);
  const buf = fs.readFileSync(k0Path);
  const reg = manifests['K0/cocosair'].m.k0Tarball;
  check('k0 sha256 与 K0 manifest 登记一致', sha256(buf) === reg.sha256 && buf.length === reg.bytes);
}

console.log('== V5: 泄漏黑名单扫描(K1/K2 文件路径) ==');
{
  let hits = [];
  for (const [level, engine] of PACKAGES.filter(([l]) => l !== 'K0')) {
    for (const f of manifests[`${level}/${engine}`].m.files) {
      for (const re of LEAK_BLACKLIST) if (re.test(`/${f.path}`)) hits.push(`${level}/${engine}: ${f.path}`);
    }
  }
  check('无黑名单示例混入', hits.length === 0, hits.slice(0, 5).join(' | '));
  // 同时确认泄漏名单里的文件确实不在源内被引用为知识
  for (const key of ['K2/three', 'K2/cocosair']) {
    const m = manifests[key].m;
    check(`${key} manifest 含 excludedForLeakage`, Array.isArray(m.excludedForLeakage) && m.excludedForLeakage.length >= 3,
      `${(m.excludedForLeakage || []).length} 项`);
  }
}

console.log('== V6: K1/three 体积红线 ==');
{
  const m = manifests['K1/three'].m;
  check(`K1/three ≤ 15MB`, m.totalBytes <= 15 * 1024 * 1024, `${(m.totalBytes / 1048576).toFixed(2)}MB`);
}

console.log('== V7: 域矩阵证据文件存在 ==');
{
  for (const [level, engine] of PACKAGES) {
    const { m, dir } = manifests[`${level}/${engine}`];
    let bad = [];
    const have = new Set(walk(dir));
    for (const [dom, { evidence }] of Object.entries(m.domainCoverage)) {
      for (const ev of evidence) {
        const ok = ev.endsWith('/') ? [...have].some((p) => p.startsWith(ev)) : have.has(ev);
        if (!ok) bad.push(`${dom}:${ev}`);
      }
    }
    check(`${level}/${engine} 证据齐全`, bad.length === 0, bad.slice(0, 3).join(','));
  }
}

console.log('== V8: K2 ⊇ K1(超集且同文件同哈希) ==');
{
  for (const engine of ['three', 'cocosair']) {
    const k1 = manifests[`K1/${engine}`].m;
    const k2 = manifests[`K2/${engine}`].m;
    const k2map = new Map(k2.files.map((f) => [f.path, f.sha256]));
    const bad = k1.files.filter((f) => k2map.get(f.path) !== f.sha256);
    check(`K2/${engine} ⊇ K1/${engine}`, bad.length === 0, bad.slice(0, 3).map((f) => f.path).join(','));
  }
}

console.log('');
if (failures === 0) {
  console.log('PASS — 全部知识包校验通过');
  process.exit(0);
} else {
  console.error(`FAIL — ${failures} 项未通过`);
  process.exit(1);
}
