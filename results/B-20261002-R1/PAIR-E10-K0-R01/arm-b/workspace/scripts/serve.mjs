#!/usr/bin/env node
// ============================================================================
// serve.mjs — 模板静态开发服务器(MASTER-CONTEXT §12.1)
// ----------------------------------------------------------------------------
// - 纯 node:http,零依赖;serve 根 = 模板根(本脚本位于 scripts/,根取上一级)。
// - 端口:process.env.PORT,默认 5173;主机:process.env.HOST,默认 127.0.0.1。
// - MIME 覆盖 benchmark 资产类型:html/js/glbin/png/wav/json(另含常用扩展)。
// - 每个请求打印一行访问日志(harness 网络观测复用): [ISO] "GET /path" 200 <bytes>
// - Cache-Control: no-store,保证每次取到最新构建产物。
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.glbin': 'application/octet-stream', // benchmark 引擎二进制资产
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
};

function logLine(req, status, bytes) {
  console.log(`[${new Date().toISOString()}] "${req.method} ${req.url}" ${status} ${bytes}`);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    logLine(req, 400, 0);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('400 Bad Request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html'; // "/" -> "/index.html"

  const filePath = path.normalize(path.join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    logLine(req, 403, 0); // 防目录穿越
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      logLine(req, 404, 0);
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' };
    logLine(req, 200, st.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[serve] root = ${root}`);
  console.log(`[serve] listening on http://${HOST}:${PORT}`);
});
