#!/usr/bin/env node
// isolation/mini-serve.mjs — 零依赖迷你静态文件服务
// 用途:G2-T3 dev server 隔离测试;NC fixtures 的 `npm run dev`。
// 用法: node mini-serve.mjs --root <dir> [--port N](端口缺省取 process.env.PORT,再缺省 7300)
// stdout 输出 JSON 行事件:{"event":"listening",...} / {"event":"request",...},父进程可解析等待就绪。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const get = (k, dflt) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const rootArg = get('--root', get('-r', '.'));
const portArg = Number(get('--port', process.env.PORT || 7300));

const ROOT = path.resolve(process.cwd(), rootArg);
const PORT = Number.isFinite(portArg) ? portArg : 7300;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  // 防路径穿越:归一化后必须仍在 ROOT 内
  const abs = path.normalize(path.join(ROOT, pathname));
  let status = 200;
  if (!abs.startsWith(ROOT)) {
    status = 403;
    sendJson(res, 403, { error: 'forbidden' });
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    status = 405;
    sendJson(res, 405, { error: 'method-not-allowed' });
  } else {
    try {
      const data = fs.readFileSync(abs); // 小文件场景足够;NC fixture 与 T3 测试用
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      status = 404;
      sendJson(res, 404, { error: 'not-found', path: pathname });
    }
  }
  process.stdout.write(JSON.stringify({ event: 'request', method: req.method, url: req.url, status }) + '\n');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ event: 'listening', port: PORT, root: ROOT, pid: process.pid }) + '\n');
});

server.on('error', (e) => {
  process.stdout.write(JSON.stringify({ event: 'error', code: e.code, message: e.message }) + '\n');
  process.exit(1);
});

// Windows 下父进程 kill 后确保退出
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
