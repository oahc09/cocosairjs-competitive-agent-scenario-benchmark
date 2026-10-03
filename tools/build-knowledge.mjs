#!/usr/bin/env node
/**
 * build-knowledge.mjs — 幂等重建 K0/K1/K2 双引擎知识包 + K0 专用 AIR tarball。
 *
 * 用法:  node tools/build-knowledge.mjs          (在 bench/ 下运行;幂等,重跑产出字节一致)
 *
 * 产出:
 *   vendor/cocosair.js-1.0.0-k0.tgz    — 剔除 package/docs/ 后重打包的 AIR tarball(K0 冷启动安装源)
 *   knowledge/K0/{three,cocosair}/     — 仅 README + manifest
 *   knowledge/K1/{three,cocosair}/     — K0 + 官方文档
 *   knowledge/K2/{three,cocosair}/     — K1 + 精选通用示例 + ai 台账
 *
 * 确定性策略:
 *   - 纯 Node 实现 ustar tar 读写 + zlib.gzip(level 9, header mtime=0) → tarball 字节级可复现
 *   - tar 条目顺序: package/package.json 首位, 其余按字节序排序; mtime 固定 2020-01-01T00:00:00Z
 *   - manifest 不含生成时间戳(curatedAt 为固定日期), files 按路径排序
 *   - 目标目录先删后建(完整重建,无增量残留)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const SRC_AIR = 'E:\\AIProMax\\github\\cocosair.js';
const SRC_THREE = 'E:\\AIProMax\\Y2026M09\\cocosairjs-vs-threejs\\three.js-r186';
const AIR_TARBALL = path.join(ROOT, 'vendor', 'cocosair.js-1.0.0.tgz');
const AIR_TARBALL_K0 = path.join(ROOT, 'vendor', 'cocosair.js-1.0.0-k0.tgz');
const KNOW = path.join(ROOT, 'knowledge');
const THREE_VERSION = 'three@0.186.1';
const AIR_VERSION = 'cocosair.js@1.0.0';
const CURATED_AT = '2026-10-02'; // 固定策划日期(不写时间,保证幂等)
const FIXED_MTIME = 1577836800; // 2020-01-01T00:00:00Z, tar 条目统一 mtime

/* ---------------------------------------------------------------- tar 库 */

function octal(n, len) {
  const s = n.toString(8).padStart(len - 1, '0') + '\0';
  if (s.length !== len) throw new Error(`octal overflow: ${n}`);
  return Buffer.from(s, 'ascii');
}

/** 解析 tar(ustar + GNU LongLink + 目录条目), 返回 [{name, size, data, type}] */
export function tarRead(buf) {
  const entries = [];
  let off = 0;
  let pendingLongName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const magic = header.subarray(257, 263).toString('ascii');
    let prefix = '';
    if (magic.startsWith('ustar')) {
      prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    }
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === 'L') { pendingLongName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (typeflag === '5') continue; // 目录条目: 重建时由文件条目推导
    const name = (pendingLongName || (prefix ? prefix + '/' + nameRaw : nameRaw)).replace(/^\.\//, '');
    pendingLongName = null;
    if (name) entries.push({ name, size, data: Buffer.from(data), type: typeflag });
  }
  return entries;
}

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  // ustar 支持 name<=100, 超长则拆 prefix(<=155)+name(<=100), 拆分点须落在 '/'
  let n = name;
  let prefix = '';
  if (Buffer.byteLength(n) > 100) {
    const parts = n.split('/');
    while (parts.length > 1 && Buffer.byteLength(parts.join('/')) > 100) {
      prefix = prefix ? parts.shift() + '/' + prefix : parts.shift();
    }
    n = parts.join('/');
    if (!n || Buffer.byteLength(n) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`tar name too long: ${name}`);
    }
  }
  h.write(n, 0, 100, 'utf8');
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.write('        ', 148); // checksum 占位(空格)
  h.write('0', 156); // typeflag: 普通文件
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  // checksum 字段格式: 6 位八进制 + NUL + 空格
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** 写 tar(package.json 首位 + 字节序排序, 统一 mtime/mode, ustar) */
export function tarWrite(files, { mtime = FIXED_MTIME } = {}) {
  const sorted = [...files].sort((a, b) => {
    const pj = (x) => (x.name === 'package/package.json' ? 0 : 1);
    if (pj(a) !== pj(b)) return pj(a) - pj(b);
    return Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'));
  });
  const chunks = [];
  for (const f of sorted) {
    chunks.push(tarHeader(f.name, f.data.length, mtime));
    chunks.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // 两个结束块
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------ 通用工具 */

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function wipe(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/** 递归收集目录下全部文件(相对路径, 字节序排序) */
function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** 生成目录清单(files[] + totalBytes)并写 manifest */
function writeManifest(dir, extra) {
  const files = walk(dir)
    .filter((p) => p !== 'manifest.json')
    .map((p) => {
      const buf = fs.readFileSync(path.join(dir, p));
      return { path: p, sha256: sha256(buf), bytes: buf.length };
    });
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const manifest = { ...extra, files, totalFiles: files.length, totalBytes };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/* ------------------------------------------------- 域覆盖矩阵(证据驱动) */

function matrix(pairs) {
  const m = {};
  for (const [domain, status, evidence] of pairs) m[domain] = { status, evidence };
  return m;
}

const THREE_K0_MATRIX = matrix([
  ['Scene setup', 'yes', ['README.md']],
  ['Camera', 'yes', ['README.md']],
  ['Material', 'yes', ['README.md']],
  ['Animation', 'yes', ['README.md']],
  ['Asset load', 'absent', []],
  ['Input', 'absent', []],
  ['Shader', 'absent', []],
  ['Postprocess', 'absent', []],
  ['Particles', 'absent', []],
]);

const THREE_K1_MATRIX = matrix([
  ['Scene setup', 'yes', ['docs/pages/Scene.html.md', 'manual/pages/scenegraph.html']],
  ['Camera', 'yes', ['docs/pages/PerspectiveCamera.html.md', 'docs/pages/OrbitControls.html.md', 'manual/pages/cameras.html']],
  ['Material', 'yes', ['docs/pages/MeshStandardMaterial.html.md', 'manual/pages/materials.html']],
  ['Animation', 'yes', ['docs/pages/AnimationMixer.html.md', 'manual/pages/animation-system.html']],
  ['Asset load', 'yes', ['docs/pages/GLTFLoader.html.md', 'manual/pages/loading-3d-models.html']],
  ['Input', 'yes', ['docs/pages/OrbitControls.html.md', 'docs/pages/Raycaster.html.md', 'manual/pages/animation-system.html']],
  ['Shader', 'yes', ['docs/pages/ShaderMaterial.html.md']],
  ['Postprocess', 'yes', ['docs/pages/EffectComposer.html.md', 'manual/pages/how-to-use-post-processing.html']],
  ['Particles', 'yes', ['docs/pages/Points.html.md', 'docs/pages/PointsMaterial.html.md']],
]);

const THREE_K2_MATRIX = matrix([
  ['Scene setup', 'yes', ['docs/pages/Scene.html.md', 'examples/webgl_shadowmap.html']],
  ['Camera', 'yes', ['docs/pages/OrbitControls.html.md', 'examples/misc_controls_orbit.html', 'examples/webgl_camera_array.html']],
  ['Material', 'yes', ['manual/pages/materials.html', 'examples/webgl_materials_blending.html', 'examples/webgl_materials_normalmap.html', 'examples/webgl_lights_spotlight.html']],
  ['Animation', 'yes', ['manual/pages/animation-system.html', 'examples/webgl_animation_keyframes.html', 'examples/webgl_animation_skinning_morph.html']],
  ['Asset load', 'yes', ['docs/pages/GLTFLoader.html.md', 'examples/webgl_loader_gltf.html']],
  ['Input', 'yes', ['examples/webgl_interactive_buffergeometry.html', 'examples/misc_controls_transform.html', 'examples/misc_controls_orbit.html']],
  ['Shader', 'yes', ['docs/pages/ShaderMaterial.html.md', 'examples/webgl_buffergeometry_custom_attributes_particles.html']],
  ['Postprocess', 'yes', ['examples/webgl_postprocessing.html', 'examples/webgl_postprocessing_unreal_bloom.html', 'examples/webgl_points_dynamic.html']],
  ['Particles', 'yes', ['docs/pages/Points.html.md', 'examples/webgl_points_dynamic.html', 'examples/webgl_sprites.html']],
]);

const AIR_K0_MATRIX = matrix([
  ['Scene setup', 'yes', ['README.md']],
  ['Camera', 'absent', []],
  ['Material', 'absent', []],
  ['Animation', 'absent', []],
  ['Asset load', 'absent', []],
  ['Input', 'absent', []],
  ['Shader', 'absent', []],
  ['Postprocess', 'absent', []],
  ['Particles', 'absent', []],
]);

const AIR_K1_MATRIX = matrix([
  ['Scene setup', 'yes', ['docs/manual/creating-a-scene.md', 'docs/manual/scenegraph.md']],
  ['Camera', 'yes', ['docs/manual/cameras.md']],
  ['Material', 'yes', ['docs/manual/materials.md', 'docs/manual/material-table.md']],
  ['Animation', 'yes', ['docs/manual/animation-system.md', 'docs/guides/skinned-model.md']],
  ['Asset load', 'yes', ['docs/manual/load-gltf.md', 'docs/manual/asset-loading-and-lifetime.md', 'docs/guides/asset-loading.md', 'docs/gltf/gltf-runtime.md']],
  ['Input', 'yes', ['docs/manual/input-and-events.md']],
  ['Shader', 'yes', ['docs/manual/custom-shaders.md', 'docs/manual/uniform-types.md']],
  ['Postprocess', 'limitation documented', ['docs/manual/post-processing.md', 'docs/manual/how-to-use-post-processing.md', 'docs/notes/post-process-notes.md']],
  ['Particles', 'limitation documented', ['docs/notes/particle-2d-notes.md']],
]);

const AIR_K2_MATRIX = matrix([
  ['Scene setup', 'yes', ['docs/manual/creating-a-scene.md', 'examples/hello-cube/', 'examples/node-hierarchy/']],
  ['Camera', 'yes', ['docs/manual/cameras.md', 'examples/camera/', 'examples/camera-lookat/', 'examples/camera-multi/']],
  ['Material', 'yes', ['docs/manual/materials.md', 'examples/material-basic/', 'examples/material-transparent/', 'examples/texture-basic/']],
  ['Animation', 'yes', ['docs/manual/animation-system.md', 'examples/anim-position/', 'examples/tween-basic/', 'examples/skinned-animation/']],
  ['Asset load', 'yes', ['docs/manual/load-gltf.md', 'examples/gltf-basic/', 'examples/gltf-skin/', 'examples/gltf-morph/']],
  ['Input', 'yes', ['docs/manual/input-and-events.md', 'examples/input/', 'examples/interaction-click/']],
  ['Shader', 'yes', ['docs/manual/custom-shaders.md', 'examples/shader-custom-gradient/', 'examples/shader-dissolve/']],
  ['Postprocess', 'limitation documented', ['docs/manual/post-processing.md', 'docs/notes/post-process-notes.md']],
  ['Particles', 'limitation documented', ['docs/notes/particle-2d-notes.md', 'examples/particle-2d-basic/']],
]);

/* ------------------------------------------------------- K2 精选清单 */

/** three K2 示例(html 内联 module 代码, 单文件即完整模式) */
const THREE_K2_EXAMPLES = [
  'css2d_label', // UI 标签锚定(CSS2DRenderer)
  'misc_controls_orbit', // OrbitControls 相机控制
  'misc_controls_transform', // TransformControls 拖拽 gizmo
  'webgl_animation_keyframes', // AnimationMixer 关键帧播放
  'webgl_animation_skinning_morph', // 蒙皮 + morph 基础 API 演示(非场景答案)
  'webgl_buffergeometry', // BufferGeometry 构建与属性
  'webgl_buffergeometry_custom_attributes_particles', // 自定义顶点属性 + ShaderMaterial 粒子
  'webgl_camera_array', // 多相机分屏
  'webgl_interactive_buffergeometry', // 射线拾取/交互
  'webgl_instancing_dynamic', // InstancedMesh 动态矩阵更新
  'webgl_lights_spotlight', // 聚光灯与材质响应
  'webgl_loader_gltf', // GLTFLoader 基础加载
  'webgl_materials_blending', // 透明混合模式
  'webgl_materials_normalmap', // 法线贴图
  'webgl_points_dynamic', // 动态 Points(帧循环更新缓冲)
  'webgl_postprocessing', // EffectComposer 基础链
  'webgl_postprocessing_unreal_bloom', // Bloom 后处理
  'webgl_shadowmap', // 阴影
  'webgl_sprites', // Sprite 公告板
];

/** 与 benchmark 场景同主题 → 排除(防答案泄漏) */
const THREE_EXCLUDED_FOR_LEAKAGE = [
  { name: 'webgpu_tsl_galaxy', reason: 'E01 深空星系:同名星系示例即答案级实现' },
  { name: 'webgl_shaders_ocean', reason: 'E02 落日海面:海面着色器为答案级实现' },
  { name: 'webgpu_ocean', reason: 'E02 落日海面:海洋示例' },
  { name: 'webgpu_water', reason: 'E02 落日海面:水面示例' },
  { name: 'webgl_gpgpu_water', reason: 'E02 落日海面:GPGPU 水面模拟' },
  { name: 'webgpu_compute_water', reason: 'E02 落日海面:compute 水面' },
  { name: 'webgpu_backdrop_water', reason: 'E02 落日海面:水面背景' },
  { name: 'webgpu_tsl_earth', reason: 'E03 太阳系仪:行星体同类主题' },
  { name: 'webgpu_generator_city', reason: 'E07 霓虹夜城:程序化城市生成即答案级实现' },
  { name: 'webgpu_volume_fire', reason: 'E06 荒野篝火:体积火焰为答案级实现' },
  { name: 'webgl_gpgpu_birds', reason: 'E08 深海鱼群:群体行为模拟同构(boids)' },
  { name: 'webgl_gpgpu_birds_gltf', reason: 'E08 深海鱼群:GPGPU 群体 + glTF' },
  { name: 'webgpu_compute_birds', reason: 'E08 深海鱼群:compute 群体行为' },
  { name: 'webgl_materials_envmaps', reason: 'E09 珠宝展示:环境反射材质为该场景核心视觉手段' },
  { name: 'webgl_loader_gltf_transmission', reason: 'E09 珠宝展示:透射材质同主题' },
  { name: 'webgl_loader_gltf_iridescence', reason: 'E09 珠宝展示:虹彩材质同主题' },
  { name: 'webgl_loader_gltf_dispersion', reason: 'E09 珠宝展示:色散材质同主题' },
  { name: 'webgl_loader_gltf_sheen', reason: 'E09 珠宝展示:光泽材质同主题' },
];

const THREE_EXCLUDED_FOR_SCOPE = [
  { name: 'manual/resources/, manual/examples/', reason: 'manual 配套纹理/模型与可运行 demo(56MB+152MB), 非文档正文, 超出知识包体积边界' },
  { name: 'docs/pages/*.html', reason: '与 .html.md 内容重复, 仅保留机器可读 markdown' },
  { name: 'docs/llms-full.txt', reason: 'docs/pages markdown 的拼接重复' },
  { name: 'docs/search.json', reason: '文档站搜索索引, 非知识内容' },
  { name: 'webgpu_*/tsl 系示例', reason: '实验只跑 WebGL2 路径, WebGPU/TSL 不在对照面内(其中主题同名者另入泄漏清单)' },
];

/** AIR K2 示例(整目录: example.json + index.html + src|main.js, 不含 assets/) */
const AIR_K2_EXAMPLES = [
  'hello-cube', // 场景搭建入门: 相机+灯+旋转立方体
  'node-hierarchy', // 节点层级
  'camera', // 相机基础
  'camera-lookat', // lookAt 取景
  'camera-ortho', // 正交相机
  'camera-multi', // 多相机
  'material-basic', // 标准材质
  'material-transparent', // 透明材质
  'texture-basic', // 纹理
  'anim-position', // 位移动画
  'tween-basic', // 补间
  'skinned-animation', // 蒙皮骨骼动画
  'gltf-basic', // glTF 加载
  'gltf-skin', // glTF 蒙皮
  'gltf-morph', // glTF morph
  'input', // 输入事件
  'interaction-click', // 点击交互
  'shader-custom-gradient', // 自定义着色器: 渐变
  'shader-dissolve', // 自定义着色器: 溶解
  'particle-2d-basic', // 2D 粒子(引擎当前唯一粒子面)
];

const AIR_EXCLUDED_FOR_LEAKAGE = [
  { name: 'model-character-interaction', reason: 'E10 动画角色展示空间:角色交互展示同主题' },
  { name: 'product-viewer', reason: 'E09 珠宝展示台:产品展示台同主题' },
  { name: 'gltf-viewer', reason: 'E09/E10:转台式 glTF 查看器为展示型场景的直接底座' },
];

const AIR_EXCLUDED_FOR_SCOPE = [
  { name: 'tank-battle / tetris-classic / match3-classic / collector-dodge / contra-action', reason: '完整小游戏, 属应用而非引擎通用模式' },
  { name: 'math-* / node-* / mesh-* / texture2d-* 等单元式 API 演示', reason: 'API 微演示, 覆盖面已由 K1 文档承担' },
  { name: 'examples/files.json / gallery.html / index.html / shared/', reason: '示例库运行时基础设施, 非知识内容' },
  { name: 'examples/*/assets/', reason: '示例私有 GLB/纹理等运行资产不随知识包分发(体积与许可), benchmark 资产由 harness 单独下发' },
  { name: 'docs/manual/examples/', reason: 'manual 可运行 demo(44 个 html), 官方手册正文(markdown)已收录; html demo 按策划边界排除' },
  { name: 'docs/evidence/ 与 docs 根部 *.json(extraction/test/inventory 类)', reason: '引擎抽取 QA 台账(约 8MB), 面向引擎维护者而非应用 Agent' },
  { name: 'ai/plans/ ai/prompts/ ai/README.md', reason: '引擎仓库内部流程文档; 仅收录两份对应用 Agent 有直接价值的执行台账' },
];

/* ------------------------------------------------------------- 构建 */

function log(msg) { console.log('[build-knowledge]', msg); }

/** 从 npm registry pack three 并读取包内 README.md */
function threeReadmeFromRegistry() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbuild-three-'));
  try {
    execSync('npm pack three@0.186.1 --silent', { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack 未产出 tgz');
    const entries = tarRead(zlib.gunzipSync(fs.readFileSync(path.join(tmp, tgz))));
    const readme = entries.find((e) => e.name === 'package/README.md');
    if (!readme) throw new Error('three npm 包中无 README.md');
    return readme.data;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function buildK0Tarball() {
  const orig = zlib.gunzipSync(fs.readFileSync(AIR_TARBALL));
  const entries = tarRead(orig);
  const kept = entries.filter((e) => !e.name.startsWith('package/docs/'));
  const dropped = entries.length - kept.length;
  if (dropped === 0) throw new Error('原始 tarball 中未发现 package/docs/, 请检查输入');
  const tarBuf = tarWrite(kept.map((e) => ({ name: e.name, data: e.data })));
  const out = zlib.gzipSync(tarBuf, { level: 9 });
  fs.writeFileSync(AIR_TARBALL_K0, out);
  log(`k0 tarball: ${kept.length} 文件(剔除 docs ${dropped} 个), ${out.length} bytes, sha256=${sha256(out).slice(0, 12)}…`);
  return { bytes: out.length, sha256: sha256(out), keptCount: kept.length, droppedCount: dropped };
}

function buildK0Three(readmeBuf) {
  const dir = path.join(KNOW, 'K0', 'three');
  wipe(dir); ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), readmeBuf);
  const m = writeManifest(dir, {
    engine: 'three',
    level: 'K0',
    version: THREE_VERSION,
    curatedAt: CURATED_AT,
    sources: ['npm registry: three@0.186.1 (README.md from package tarball)'],
    domainCoverage: THREE_K0_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    notes: 'three npm 包不带 .d.ts,K0 即包+README+模板。Agent 只能读 npm install 后的包内容(无类型声明)与本 README。',
  });
  log(`K0/three: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
}

function buildK0Cocosair(readmeBuf, k0info) {
  const dir = path.join(KNOW, 'K0', 'cocosair');
  wipe(dir); ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), readmeBuf);
  const m = writeManifest(dir, {
    engine: 'cocosair',
    level: 'K0',
    version: AIR_VERSION,
    curatedAt: CURATED_AT,
    sources: ['vendor/cocosair.js-1.0.0.tgz (package/README.md)'],
    domainCoverage: AIR_K0_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    k0Tarball: { path: 'vendor/cocosair.js-1.0.0-k0.tgz', sha256: k0info.sha256, bytes: k0info.bytes },
    notes: 'K0 使用 k0 tarball(vendor/cocosair.js-1.0.0-k0.tgz, 已剔除 package/docs/)作为模板安装源, 保证冷启动读不到官方 docs。d.ts 在包内 build/cocosair.module.d.ts。',
  });
  log(`K0/cocosair: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
}

function buildK1Three(readmeBuf) {
  const dir = path.join(KNOW, 'K1', 'three');
  wipe(dir); ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), readmeBuf);
  // manual: 章节索引 + 60 页官方手册(r186 手册为 HTML 正文, Agent 可直读)
  copyFile(path.join(SRC_THREE, 'manual', 'list.json'), path.join(dir, 'manual', 'list.json'));
  for (const f of fs.readdirSync(path.join(SRC_THREE, 'manual', 'pages'))) {
    if (f.endsWith('.html')) {
      copyFile(path.join(SRC_THREE, 'manual', 'pages', f), path.join(dir, 'manual', 'pages', f));
    }
  }
  // docs: 机器可读部分 — 全部 API 页 markdown + llms.txt 索引
  copyFile(path.join(SRC_THREE, 'docs', 'llms.txt'), path.join(dir, 'docs', 'llms.txt'));
  for (const f of fs.readdirSync(path.join(SRC_THREE, 'docs', 'pages'))) {
    if (f.endsWith('.html.md')) {
      copyFile(path.join(SRC_THREE, 'docs', 'pages', f), path.join(dir, 'docs', 'pages', f));
    }
  }
  const m = writeManifest(dir, {
    engine: 'three',
    level: 'K1',
    version: THREE_VERSION,
    curatedAt: CURATED_AT,
    sources: [
      'npm registry: three@0.186.1 (README.md)',
      `源码快照 ${SRC_THREE}: manual/list.json + manual/pages/*.html(官方手册全文) + docs/pages/*.html.md(官方 API 参考机器可读 markdown, 829 页) + docs/llms.txt`,
    ],
    domainCoverage: THREE_K1_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    excludedForScope: THREE_EXCLUDED_FOR_SCOPE,
    notes: '官方 manual 在 r186 以 HTML 发布(非 markdown), 收录正文页与章节索引, HTML 为 Agent 可读格式; API 参考取 docs/pages 的 .html.md 机器可读版本。docs HTML 版/llms-full 拼接件/search 索引因重复或非知识内容排除。总体积控制在 15MB 内。泄漏抽查披露: scenegraph.html 官方手册原文以"solar system, sun, earth, moon"一句作层级概念比喻(无代码, 图片资源未收录); AIR 手册对应章节无此比喻 — 属官方概念文档原文, 非场景答案, 保留并在此披露供隔离审计。',
  });
  log(`K1/three: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
  return m;
}

function copyAirDocs(dir) {
  const docsSrc = path.join(SRC_AIR, 'docs');
  const skipRoot = new Set(['README.md', 'webgl2-only.md', 'THIRD_PARTY_LICENSES.md', 'UPSTREAM.md']);
  const sub = (subDir) =>
    fs.readdirSync(path.join(docsSrc, subDir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${subDir}/${e.name}`);
  const relFiles = [
    'README.md',
    'webgl2-only.md',
    ...fs.readdirSync(docsSrc, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !skipRoot.has(e.name))
      .map((e) => e.name),
    ...sub('manual'), // 顶层 manual markdown(不含 manual/examples/ 可运行 demo)
    ...sub('guides'),
    ...sub('reference'),
    ...sub('notes'),
    ...sub('gltf'),
  ];
  for (const rel of relFiles) copyFile(path.join(docsSrc, rel), path.join(dir, 'docs', rel));
  return relFiles.length;
}

function buildK1Cocosair(readmeBuf) {
  const dir = path.join(KNOW, 'K1', 'cocosair');
  wipe(dir); ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), readmeBuf);
  const n = copyAirDocs(dir);
  const m = writeManifest(dir, {
    engine: 'cocosair',
    level: 'K1',
    version: AIR_VERSION,
    curatedAt: CURATED_AT,
    sources: [
      'vendor/cocosair.js-1.0.0.tgz (package/README.md)',
      `引擎仓库 ${SRC_AIR}/docs: README、webgl2-only.md、manual/*.md(60 篇)、guides/(6)、reference/(10)、notes/(11)、gltf/(4) — markdown 全量`,
    ],
    domainCoverage: AIR_K1_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    excludedForScope: AIR_EXCLUDED_FOR_SCOPE.filter((x) => !x.name.includes('ai/plans')),
    notes: `K1 Agent Run 使用完整 tarball(vendor/cocosair.js-1.0.0.tgz, 含 docs)安装; 知识包收录 docs markdown 全量共 ${n} 文件。Postprocess/3D Particles 按引擎现状记为 limitation documented(2D 粒子 only, 代码级后处理不可稳定使用)。`,
  });
  log(`K1/cocosair: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
  return m;
}

function buildK2Three() {
  const k1 = path.join(KNOW, 'K1', 'three');
  const dir = path.join(KNOW, 'K2', 'three');
  wipe(dir); ensureDir(dir);
  // K2 = K1 全量复制
  for (const rel of walk(k1)) copyFile(path.join(k1, rel), path.join(dir, rel));
  // + 精选通用模式示例(r186 示例代码内联于 html 的 module script, 单文件即完整)
  const exDir = path.join(SRC_THREE, 'examples');
  for (const name of THREE_K2_EXAMPLES) {
    const src = path.join(exDir, `${name}.html`);
    if (!fs.existsSync(src)) throw new Error(`three 示例缺失: ${name}.html`);
    copyFile(src, path.join(dir, 'examples', `${name}.html`));
  }
  const m = writeManifest(dir, {
    engine: 'three',
    level: 'K2',
    version: THREE_VERSION,
    curatedAt: CURATED_AT,
    sources: [
      `K1 包(README + manual + docs markdown) + 源码快照 ${SRC_THREE}/examples: ${THREE_K2_EXAMPLES.length} 个通用模式示例(代码内联于 html module script)`,
    ],
    domainCoverage: THREE_K2_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    excludedForLeakage: THREE_EXCLUDED_FOR_LEAKAGE,
    excludedForScope: THREE_EXCLUDED_FOR_SCOPE,
    notes: '示例为官方通用模式(instancing/points/gltf/controls/postprocessing 等), 全部经主题筛查: 与 E01-E10 同名或同构的主题示例(星系/海面/水面/行星/城市/火焰/鸟群/珠宝反射材质系)已排除, 见 excludedForLeakage。示例引用的模型/纹理资产不在包内, Agent 以模式阅读为主。',
  });
  log(`K2/three: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
  return m;
}

function buildK2Cocosair() {
  const k1 = path.join(KNOW, 'K1', 'cocosair');
  const dir = path.join(KNOW, 'K2', 'cocosair');
  wipe(dir); ensureDir(dir);
  for (const rel of walk(k1)) copyFile(path.join(k1, rel), path.join(dir, rel));
  // + 精选通用示例(example.json + index.html + src/**|main.js, 剔除 assets/)
  const exRoot = path.join(SRC_AIR, 'examples');
  let exFiles = 0;
  for (const name of AIR_K2_EXAMPLES) {
    const srcDir = path.join(exRoot, name);
    if (!fs.existsSync(srcDir)) throw new Error(`AIR 示例缺失: ${name}`);
    for (const rel of walk(srcDir)) {
      const segs = rel.split('/');
      if (segs[0] === 'assets' || segs.includes('node_modules')) continue;
      if (!/\.(json|html|js|ts)$/.test(rel)) continue;
      copyFile(path.join(srcDir, rel), path.join(dir, 'examples', name, rel));
      exFiles += 1;
    }
  }
  // + ai 执行台账(2 份: code-first web 可靠性 / API 场景与 shader 集成教训)
  for (const f of ['code-first-web-reliability.md', 'api-scenarios-shaders.md']) {
    copyFile(path.join(SRC_AIR, 'ai', 'ledgers', f), path.join(dir, 'ai', 'ledgers', f));
  }
  const m = writeManifest(dir, {
    engine: 'cocosair',
    level: 'K2',
    version: AIR_VERSION,
    curatedAt: CURATED_AT,
    sources: [
      `K1 包(docs markdown 全量) + 引擎仓库 ${SRC_AIR}/examples: ${AIR_K2_EXAMPLES.length} 个通用模式示例(源码, 不含 assets) + ai/ledgers 2 份执行台账`,
    ],
    domainCoverage: AIR_K2_MATRIX,
    curationRule: '不含当前 benchmark 场景答案型内容',
    excludedForLeakage: AIR_EXCLUDED_FOR_LEAKAGE,
    excludedForScope: AIR_EXCLUDED_FOR_SCOPE,
    notes: `示例覆盖九域中引擎可演示的全部通用模式(${exFiles} 个源文件); 后处理与 3D 粒子引擎无稳定示例, 维持 limitation documented。ai/ledgers 为引擎侧实测教训(资产释放/材质实例化/生命周期销毁等), 属稳定 recipe 级知识, 非场景答案。`,
  });
  log(`K2/cocosair: ${m.totalFiles} 文件, ${m.totalBytes} bytes`);
  return m;
}

/* --------------------------------------------------------------- main */

function assertEvidence(dir, matrixObj, label) {
  const have = new Set(walk(dir));
  for (const [domain, { evidence }] of Object.entries(matrixObj)) {
    for (const ev of evidence) {
      const ok = ev.endsWith('/')
        ? [...have].some((p) => p.startsWith(ev))
        : have.has(ev);
      if (!ok) throw new Error(`${label}: 域「${domain}」证据文件缺失 ${ev}`);
    }
  }
}

export function buildAll() {
  const t0 = Date.now();
  log('读取源与 tarball…');
  const k0info = buildK0Tarball();
  const airEntries = tarRead(zlib.gunzipSync(fs.readFileSync(AIR_TARBALL)));
  const airReadme = airEntries.find((e) => e.name === 'package/README.md');
  if (!airReadme) throw new Error('AIR tarball 无 README');
  const threeReadme = threeReadmeFromRegistry();

  buildK0Three(threeReadme);
  buildK0Cocosair(airReadme.data, k0info);
  buildK1Three(threeReadme);
  buildK1Cocosair(airReadme.data);
  buildK2Three();
  buildK2Cocosair();

  // 证据自检(域矩阵引用的文件必须真实存在于包内)
  assertEvidence(path.join(KNOW, 'K0', 'three'), THREE_K0_MATRIX, 'K0/three');
  assertEvidence(path.join(KNOW, 'K0', 'cocosair'), AIR_K0_MATRIX, 'K0/cocosair');
  assertEvidence(path.join(KNOW, 'K1', 'three'), THREE_K1_MATRIX, 'K1/three');
  assertEvidence(path.join(KNOW, 'K1', 'cocosair'), AIR_K1_MATRIX, 'K1/cocosair');
  assertEvidence(path.join(KNOW, 'K2', 'three'), THREE_K2_MATRIX, 'K2/three');
  assertEvidence(path.join(KNOW, 'K2', 'cocosair'), AIR_K2_MATRIX, 'K2/cocosair');

  // K1/three 体积红线(15MB)
  const k1t = JSON.parse(fs.readFileSync(path.join(KNOW, 'K1', 'three', 'manifest.json'), 'utf8'));
  if (k1t.totalBytes > 15 * 1024 * 1024) throw new Error(`K1/three 超过 15MB: ${k1t.totalBytes}`);

  log(`完成, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 作为脚本直接运行时执行; 被 import 时(verify 脚本复用 tarRead 等)不执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  buildAll();
}
