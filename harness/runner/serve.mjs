#!/usr/bin/env node
// serve.mjs — static file server for a workspace under test.
//
//   node runner/serve.mjs --root <dir> --port <n> [--log <serve-log.json>]
//
// - Records every request in memory as {ts, method, url, status, bytes}.
// - GET  /__log       -> returns the request log as JSON (not itself logged).
// - POST /__shutdown  -> writes the log file (if --log) and exits cleanly.
// - The log file is also (re)written after every request when --log is given,
//   so the log survives even a hard kill on Windows.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv, isoNow } from './util.mjs';

const argv = parseArgv(process.argv.slice(2));
const root = path.resolve(argv.root || '.');
const port = Number(argv.port || 0);
const logFile = argv.log ? path.resolve(argv.log) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** @type {Array<{ts:string,method:string,url:string,status:number,bytes:number}>} */
const log = [];

function writeLogFile() {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, JSON.stringify({ generatedAt: isoNow(), root, port: server.address()?.port ?? port, requests: log }, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[serve] log write failed: ${err.message}\n`);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (u.pathname === '/__log' && req.method === 'GET') {
    const body = Buffer.from(JSON.stringify({ generatedAt: isoNow(), requests: log }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (u.pathname === '/__shutdown' && req.method === 'POST') {
    const body = Buffer.from(JSON.stringify({ ok: true, requests: log.length }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body, () => {
      writeLogFile();
      // give the response a moment to flush, then exit
      setTimeout(() => process.exit(0), 50);
    });
    return;
  }

  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(root, '.' + rel.replace(/\\/g, '/'));
  const inside = abs === root || abs.startsWith(root + path.sep);

  const record = (status, bytes) => {
    log.push({ ts: isoNow(), method: req.method, url: req.url, status, bytes });
    writeLogFile(); // survive hard kills
  };

  if (!inside) {
    const b = Buffer.from('forbidden\n');
    res.writeHead(403, { 'content-type': 'text/plain', 'content-length': b.length });
    res.end(b);
    record(403, b.length);
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      const b = Buffer.from(`not found: ${u.pathname}\n`);
      res.writeHead(404, { 'content-type': 'text/plain', 'content-length': b.length });
      res.end(b);
      record(404, b.length);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
    stream.on('end', () => record(200, st.size));
  });
});

server.on('error', (err) => {
  process.stderr.write(`[serve] server error: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const bound = server.address().port;
  process.stdout.write(
    JSON.stringify({ ok: true, root, port: bound, log: logFile || null, pid: process.pid, startedAt: isoNow() }) + '\n'
  );
  // Windows: best-effort graceful write on CTRL-C / process exit.
  process.on('SIGINT', () => { writeLogFile(); process.exit(0); });
  process.on('SIGTERM', () => { writeLogFile(); process.exit(0); });
  process.on('exit', () => writeLogFile());
});

export { server };
