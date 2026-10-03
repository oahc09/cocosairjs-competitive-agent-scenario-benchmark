#!/usr/bin/env node
// ============================================================================
// build.mjs — 统一构建脚本(双引擎模板同构,见 MASTER-CONTEXT §12.1)
// ----------------------------------------------------------------------------
// 1) esbuild 打包应用代码 src/main.js -> dist/app.js
//    - three / three/addons/* 标记 external:引擎不打进 bundle(红线),
//      产物保留裸名 import,由 index.html 的 import map 解析到 /dist/vendor/。
// 2) 复制引擎本体到 dist/vendor/(本地 vendored,离线可用,无网络依赖):
//    - node_modules/three/build/three.module.js  -> dist/vendor/three.module.js
//      (并沿相对 import 自动带上其内部依赖,如 r168+ 拆分出的 three.core.js)
//    - node_modules/three/examples/jsm/ 整目录  -> dist/vendor/addons/
// 3) 由模板根 index.html 生成相对路径版 dist/index.html,使 dist/ 可独立 serve。
// 4) 产物自检(缺任一即退出码 1):dist/app.js、dist/vendor/three.module.js、
//    dist/vendor/addons/controls/OrbitControls.js。
//
// 幂等:每次全量重建 dist,内容确定性,连跑两次产物内容 hash 不变。
// ============================================================================

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const vendor = path.join(dist, 'vendor');

// exFAT 去重布局:工作区可不带自有 node_modules,沿目录向上查找
// (引擎容器层 答案区(禁读目录)/<engine>/node_modules 或模板自身)
function findNodeModulesDir() {
  let dir = root;
  for (;;) {
    const cand = path.join(dir, 'node_modules');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) fail('未找到 node_modules(已向上搜至盘根;请先 npm install)');
    dir = parent;
  }
}
const nmDir = findNodeModulesDir();
const threeBuildDir = path.join(nmDir, 'three', 'build');
const threeJsmDir = path.join(nmDir, 'three', 'examples', 'jsm');

function fail(msg) {
  console.error(`[build] FAIL: ${msg}`);
  process.exit(1);
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

// --- 0. 前置检查 ---------------------------------------------------------------
if (!fs.existsSync(threeBuildDir)) fail(`缺少 ${path.relative(root, threeBuildDir)}(请先 npm install)`);
if (!fs.existsSync(threeJsmDir)) fail(`缺少 ${path.relative(root, threeJsmDir)}(请先 npm install)`);

// --- 1. 全量清理并重建 dist ------------------------------------------------------
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

// --- 2. esbuild:应用代码 -> dist/app.js(引擎 external)-------------------------
await build({
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(dist, 'app.js'),
  bundle: true,
  format: 'esm',          // 产物为 ES module,保留裸名 import 交给 import map
  platform: 'browser',
  target: 'es2022',
  external: ['three', 'three/addons/*'], // 引擎不打进 bundle(红线)
  legalComments: 'none',
  logLevel: 'info',
});
console.log('[build] esbuild: src/main.js -> dist/app.js (external: three, three/addons/*)');

// --- 3.1 复制 three.module.js 及其在 build/ 内的相对依赖 -------------------------
// r168 起 three.module.js 通过 `from "./three.core.js"` 引入核心模块,必须一并复制;
// 用 BFS 扫描相对 import,自动覆盖未来新增的内部拆分文件。
{
  const copied = new Set();
  const queue = ['three.module.js'];
  while (queue.length > 0) {
    const name = queue.pop();
    if (copied.has(name)) continue;
    const src = path.join(threeBuildDir, name);
    if (!fs.existsSync(src)) fail(`three build 文件缺失: ${name}`);
    fs.copyFileSync(src, path.join(vendor, name));
    copied.add(name);
    const text = fs.readFileSync(src, 'utf8');
    for (const m of text.matchAll(/from\s*(['"])\.\/([^'"]+)\1/g)) {
      queue.push(m[2]);
    }
  }
  for (const name of copied) {
    const size = fs.statSync(path.join(vendor, name)).size;
    console.log(`[build] vendor: ${name} (${size} bytes)`);
  }
}

// --- 3.2 复制 addons 整目录 -------------------------------------------------------
const addonsDst = path.join(vendor, 'addons');
fs.cpSync(threeJsmDir, addonsDst, { recursive: true });
console.log(`[build] vendor: examples/jsm -> dist/vendor/addons (${countFiles(addonsDst)} files)`);

// --- 4. 生成 dist/index.html(相对路径版,dist 可独立 serve)----------------------
// 模板根 index.html 用绝对路径(/dist/...),供 `npm run dev` 以模板根为站点使用;
// dist/index.html 把这些前缀改写为相对路径,使 dist/ 单独作为站点根也能跑。
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const distHtml = html
    .replaceAll('"/dist/vendor/three.module.js"', '"./vendor/three.module.js"')
    .replaceAll('"/dist/vendor/addons/"', '"./vendor/addons/"')
    .replaceAll('"/dist/app.js"', '"./app.js"');
  // 断言:带引号的资源引用(src / import map 值)已全部改写为相对路径
  // (注释里的说明文字允许出现 /dist/ 字样,不影响独立 serve)
  if (distHtml === html || distHtml.includes('"/dist/')) {
    fail('index.html 路径改写未生效(模板 index.html 被改动?请同步更新 build.mjs 的改写规则)');
  }
  fs.writeFileSync(path.join(dist, 'index.html'), distHtml);
  console.log('[build] wrote dist/index.html (relative-path variant)');
}

// --- 5. 产物自检 -----------------------------------------------------------------
const mustExist = [
  'dist/app.js',
  'dist/vendor/three.module.js',
  'dist/vendor/addons/controls/OrbitControls.js',
  'dist/index.html',
];
for (const rel of mustExist) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) fail(`自检失败: ${rel} 不存在或为空`);
}
// 红线复核:引擎不得被打进 app.js(引擎本体 >1MB,app bundle 应远小于此)
const appJs = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
if (!appJs.includes('from "three"')) fail('自检失败: dist/app.js 中未发现裸名 import "three"(external 配置失效?)');
if (fs.statSync(path.join(dist, 'app.js')).size > 256 * 1024) fail('自检失败: dist/app.js > 256KB,疑似把引擎打进了 bundle');

console.log('[build] self-check OK:', mustExist.join(', '));
console.log('[build] OK');
