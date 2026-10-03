/**
 * bench-template-cocosair — dev/static server
 *
 * 规格(与 three 模板一致,MASTER-CONTEXT §12.1):
 *   - node:http 静态服务,serve 根 = 模板根。
 *   - 端口取 process.env.PORT,默认 5174。
 *   - MIME 覆盖引擎静态资产需求(docs/gltf/gltf-decoder-deployment.md §3):
 *       .js/.mjs/.cjs → text/javascript(ESM 动态 import 强校验)
 *       .wasm         → application/wasm(WebAssembly.instantiateStreaming 前置)
 *       .glb/.gltf    → model/gltf-binary / model/gltf+json
 *   - Cache-Control: no-store(dev 语义:改代码即见)。
 *   - 每请求输出一行访问日志(harness networkEvents 观测口径)。
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ktx2': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.d.ts': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
    const started = Date.now();
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));

    // 路径穿越防护:必须落在模板根内
    if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Forbidden');
        log(req, res, urlPath, 403, started);
        return;
    }

    let size;
    try {
        size = statSync(filePath).size;
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        log(req, res, urlPath, 404, started);
        return;
    }

    res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-store',
    });
    createReadStream(filePath)
        .on('error', () => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        })
        .pipe(res);
    res.on('finish', () => log(req, res, urlPath, 200, started));
});

function log(req, res, urlPath, status, started) {
    console.log(
        `[serve] ${new Date().toISOString()} ${req.method} ${urlPath} ${status} ${Date.now() - started}ms`,
    );
}

server.listen(PORT, HOST, () => {
    console.log(`[serve] bench-template-cocosair static server`);
    console.log(`[serve] root: ${root}`);
    console.log(`[serve] http://${HOST}:${PORT}/  (PORT env, default 5174)`);
});
