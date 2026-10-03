/**
 * bench-template-cocosair — build script
 *
 * 契约(MASTER-CONTEXT §12.1):
 *   - 应用代码用 esbuild 打包 src/main.js → dist/app.js,引擎("cocosair.js")标记 external,
 *     绝不把引擎打进 bundle。
 *   - 引擎 ESM 文件复制到 dist/vendor/:node_modules/cocosair.js/build/npm/cocosair.module.js
 *     → dist/vendor/cocosair.module.js;node_modules/cocosair.js/build/gltf-decoders/ 整目录
 *     → dist/vendor/gltf-decoders/(保持 node_modules 内的相对目录结构:basis/draco/meshopt)。
 *   - 幂等:每次构建先清空 dist/ 重建,输出逐字节一致。
 *
 * 引擎坑位记录(已核实,见 template-verify.txt):
 *   - 引擎 bundle 内 0 处 import.meta、0 处 "gltf-decoders" 字符串引用 —— decoder 由应用
 *     显式注入 provider(createMeshoptDecoder 等),引擎对 decoder 部署路径零假设,
 *     dist/vendor/gltf-decoders/ 布局与 node_modules 保持一致即可,无运行时相对路径解析。
 */
import { build } from 'esbuild';
import { cp, mkdir, access, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createReadStream } from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const enginePkg = path.join(root, 'node_modules', 'cocosair.js');

const engineModuleSrc = path.join(enginePkg, 'build', 'npm', 'cocosair.module.js');
const decodersSrc = path.join(enginePkg, 'build', 'gltf-decoders');

async function sha256(file) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
        createReadStream(file)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', resolve)
            .on('error', reject);
    });
    return hash.digest('hex');
}

async function assertFile(file, label) {
    try {
        const s = await stat(file);
        if (!s.isFile()) throw new Error('not a regular file');
    } catch {
        console.error(`[build] SELF-CHECK FAILED: missing ${label}: ${file}`);
        process.exit(1);
    }
}

async function main() {
    // 幂等:从零重建 dist
    await rm(dist, { recursive: true, force: true });
    await mkdir(path.join(dist, 'vendor'), { recursive: true });

    // 1) 应用代码打包(引擎 external,走 index.html import map → /dist/vendor/cocosair.module.js)
    await build({
        entryPoints: [path.join(root, 'src', 'main.js')],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022', // src/main.js 使用顶层 await(createAirApp 异步启动)
        external: ['cocosair.js'],
        outfile: path.join(dist, 'app.js'),
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'info',
    });

    // 2) 引擎 ESM 模块(不打包,原样复制)
    await cp(engineModuleSrc, path.join(dist, 'vendor', 'cocosair.module.js'));

    // 3) gltf-decoders 整目录(相对结构与 node_modules 一致:basis/draco/meshopt)
    await cp(decodersSrc, path.join(dist, 'vendor', 'gltf-decoders'), { recursive: true });

    // 4) 自检存在性
    await assertFile(path.join(dist, 'app.js'), 'bundle output');
    await assertFile(path.join(dist, 'vendor', 'cocosair.module.js'), 'vendored engine module');
    for (const f of [
        'MANIFEST.md',
        'package.json',
        'basis/basis_transcoder.js',
        'basis/basis_transcoder.wasm',
        'draco/draco3d.js',
        'draco/draco_decoder.wasm',
        'meshopt/meshopt_decoder.mjs',
        'meshopt/meshopt_decoder.cjs',
    ]) {
        await access(path.join(dist, 'vendor', 'gltf-decoders', f));
    }

    const moduleSha = await sha256(path.join(dist, 'vendor', 'cocosair.module.js'));
    console.log(`[build] OK — dist/app.js (engine external) + dist/vendor/cocosair.module.js`);
    console.log(`[build] dist/vendor/cocosair.module.js sha256=${moduleSha}`);
}

main().catch((err) => {
    console.error('[build] FAILED:', err);
    process.exit(1);
});
