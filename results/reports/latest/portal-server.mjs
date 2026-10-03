// 报告门户服务器 — 单 HTML 入口,可运行产物 + 对比 + 报告导航 + 批次数据 + 门禁
// 用法: node portal-server.mjs [--port 7800]
// 路由:
//   /                                → index.html(门户)
//   /api/overview.json               → 汇总(批次/评分/门禁/报告清单/headline)
//   /reports/<file>                  → reports/latest 下 md 渲染为 HTML / json 美化
//   /data/<file>                     → results/*.json 美化(aggregated/cost-metrics/reference-ceiling/pilot-aggregate)
//   /gates/<Gn>                      → gates/G*.json 美化
//   /ref/<engine>/<scene>/...        → Reference 工作区(index.html 做 /dist/ 前缀重写)
//   /run/<batch>/<pairId>/<arm>/...  → 批次 Arm 工作区(同上重写;workspace 根)
//   /run-art/<batch>/<pairId>/<arm>/<f> → 该 Arm validation 产物(截图/视频/报告原样)
// 零依赖;仅供人工浏览。
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // bench/reports/latest
const BENCH = path.resolve(HERE, '..', '..', '..');            // 仓库根(portal 位于 results/reports/latest)
const RESULTS = path.join(BENCH, 'results');
const GATES = path.join(BENCH, 'gates');
const REF = path.join(BENCH, 'reference', 'private');

const argv = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(x => x.length));
const PORT = Number(argv.port || 7800);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.css': 'text/css', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

const j = (p) => JSON.parse(readFileSync(p, 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 极简 Markdown 渲染(标题/表格/代码块/列表/粗斜体/行内码/链接/引用/分割线) ----------
function renderMd(md) {
  const lines = md.split(/\r?\n/);
  let out = [], inCode = false, listType = null, tableBuf = [];
  const closeList = () => { if (listType) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null; } };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim()));
    out.push('<table><thead><tr>' + cells(rows[0]).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
    for (const r of rows.slice(1)) out.push('<tr>' + cells(r).map(c => `<td>${c}</td>`).join('') + '</tr>');
    out.push('</tbody></table>'); tableBuf = [];
  };
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) { flushTable(); closeList(); out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line)); continue; }
    if (/^\s*\|/.test(line)) { closeList(); tableBuf.push(line); continue; }
    flushTable();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^\s*>\s?/.test(line)) { closeList(); out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const t = ul ? 'ul' : 'ol';
      if (listType !== t) { closeList(); out.push(t === 'ol' ? '<ol>' : '<ul>'); listType = t; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>'); continue;
    }
    if (/^\s*(- \[|x\])/.test(line)) { closeList(); out.push('<div class="chk">' + inline(line) + '</div>'); continue; }
    closeList();
    if (!line.trim()) { out.push(''); continue; }
    out.push('<p>' + inline(line) + '</p>');
  }
  flushTable(); closeList(); if (inCode) out.push('</pre>');
  return out.join('\n');
}

function mdPage(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
body{font:14.5px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#0b0e14;color:#e6ebf2;max-width:1000px;margin:0 auto;padding:28px 34px}
h1,h2,h3,h4{color:#fff;border-bottom:1px solid #232d3f;padding-bottom:6px;margin-top:1.6em}
h1{font-size:22px}h2{font-size:18px}h3{font-size:15.5px}
a{color:#6fa8ff}code{background:#151b26;border:1px solid #232d3f;border-radius:4px;padding:1px 5px;font:12.5px Consolas,monospace;color:#ffd166}
pre{background:#10141d;border:1px solid #232d3f;border-radius:8px;padding:12px 14px;overflow-x:auto;font:12.5px Consolas,monospace;color:#c9d4e3}
pre code{border:none;background:none;color:inherit}
table{border-collapse:collapse;margin:12px 0;width:100%}th,td{border:1px solid #232d3f;padding:6px 10px;text-align:left}
th{background:#151b26}blockquote{border-left:3px solid #33415c;margin:10px 0;padding:2px 14px;color:#9fb0c8;background:#10141d}
hr{border:none;border-top:1px solid #232d3f;margin:20px 0}.chk{color:#9fb0c8;margin:2px 0}
</style></head><body>${body}<p style="margin-top:40px;color:#5a6474;font-size:12px"><a href="/">← 返回门户</a></p></body></html>`;
}

function jsonPage(title, obj) {
  return mdPage(title, `<h1>${esc(title)}</h1><pre>${esc(JSON.stringify(obj, null, 2))}</pre>`);
}

// ---------- overview 聚合 ----------
function overview() {
  const aggregated = existsSync(path.join(RESULTS, 'aggregated.json')) ? j(path.join(RESULTS, 'aggregated.json')) : null;
  const ceiling = existsSync(path.join(RESULTS, 'reference-ceiling.json')) ? j(path.join(RESULTS, 'reference-ceiling.json')) : null;
  const cost = existsSync(path.join(RESULTS, 'cost-metrics.json')) ? j(path.join(RESULTS, 'cost-metrics.json')) : null;
  const gates = existsSync(GATES) ? readdirSync(GATES).filter(f => /^G\d\.json$/.test(f)).sort().map(f => {
    const g = j(path.join(GATES, f)); return { id: f.replace('.json', ''), gate: g.gate, status: g.status, file: '/gates/' + f.replace('.json', '') };
  }) : [];
  const reports = existsSync(HERE) ? readdirSync(HERE).filter(f => /\.(md|json)$/.test(f) && f !== 'index.html' && !/portal-server/.test(f)) : [];
  const sceneTitles = {};
  for (let i = 1; i <= 10; i++) {
    const scene = 'E' + String(i).padStart(2, '0');
    try {
      const spec = j(path.join(BENCH, 'briefs', scene, 'spec.json'));
      sceneTitles[scene] = String(spec.title || scene)
        .replace(/^E\d+\s*/, '')
        .replace(/\s*\([^)]*\)[\s\S]*$/, '')
        .trim() || scene;
    } catch { sceneTitles[scene] = scene; }
  }
  const batchesIdx = existsSync(path.join(RESULTS, 'batches.json')) ? j(path.join(RESULTS, 'batches.json')) : { batches: [] };
  return {
    generatedAt: new Date().toISOString(),
    headline: {
      capabilityAvailability: ceiling ? ceiling.availability : null,
      references: ceiling ? { total: ceiling.detail.filter(d => d.status === 'FEASIBLE').length + '/20', note: '探针全绿+60fps' } : null,
      batches: batchesIdx.batches.length, pairs: aggregated ? aggregated.batches.reduce((s, b) => s + b.pairs.length, 0) : 0,
      groups: aggregated ? aggregated.groups : [],
      costRatios: cost ? cost.pairedDeltasAirMinusThree.aggregate : null,
    },
    sceneTitles,
    gates,
    batches: aggregated ? aggregated.batches : [],
    knowledgeGain: aggregated ? aggregated.knowledgeGain : [],
    referenceCeiling: aggregated ? aggregated.referenceCeiling : null,
    reports,
    dataFiles: ['aggregated.json', 'cost-metrics.json', 'reference-ceiling.json', 'pilot-aggregate.json'].filter(f => existsSync(path.join(RESULTS, f))),
  };
}

// ---------- 静态服务 ----------
function safeJoin(root, rel) { const p = path.normalize(path.join(root, rel)); return p.startsWith(root) ? p : null; }
function serveWorkspaceHtml(full, prefix) {
  let html = readFileSync(full, 'utf8');
  html = html.replace(/(["'])\/dist\//g, `$1${prefix}/dist/`).replace(/(["'])\/assets\//g, `$1${prefix}/assets/`);
  return html;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (url === '/' || url === '/index.html') return send(200, MIME['.html'], readFileSync(path.join(HERE, 'index.html')));
    if (url === '/api/overview.json') return send(200, MIME['.json'], JSON.stringify(overview()));

    let m = /^\/reports\/([\w.\-]+)$/.exec(url);
    if (m) {
      const f = safeJoin(HERE, m[1]);
      if (!f || !existsSync(f)) return send(404, 'text/plain', 'not found');
      if (f.endsWith('.md')) return send(200, MIME['.html'], mdPage(m[1], renderMd(readFileSync(f, 'utf8'))));
      return send(200, MIME['.html'], jsonPage(m[1], j(f)));
    }
    m = /^\/data\/([\w.\-]+)$/.exec(url);
    if (m) { const f = safeJoin(RESULTS, m[1]); if (!f || !existsSync(f)) return send(404, 'text/plain', 'not found'); return send(200, MIME['.html'], jsonPage(m[1], j(f))); }
    m = /^\/gates\/(G\d)$/.exec(url);
    if (m) { const f = path.join(GATES, m[1] + '.json'); if (!existsSync(f)) return send(404, 'text/plain', 'not found'); return send(200, MIME['.html'], jsonPage(m[1], j(f))); }

    m = /^\/ref\/(three|cocosair)\/(E\d\d)(\/.*)?$/.exec(url);
    if (m) {
      const root = path.join(REF, m[1], m[2]); const rel = (m[3] || '/').replace(/^\/+/, '');
      const file = rel === '' ? 'index.html' : rel;
      const full = safeJoin(root, file);
      if (!full || !existsSync(full) || !statSync(full).isFile()) return send(404, 'text/plain', 'not found: ' + file);
      if (/index\.html$/.test(file)) return send(200, MIME['.html'], serveWorkspaceHtml(full, `/ref/${m[1]}/${m[2]}`));
      return send(200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', readFileSync(full));
    }
    m = /^\/run\/(B-\d{8}-R\d+)\/(PAIR-[\w-]+)\/(arm-[ab])\/(.*)$/.exec(url);
    if (m) {
      const root = path.join(RESULTS, m[1], m[2], m[3], 'workspace'); const file = m[4];
      const full = safeJoin(root, file);
      if (!full || !existsSync(full) || !statSync(full).isFile()) return send(404, 'text/plain', 'not found: ' + file);
      if (/index\.html$/.test(file)) return send(200, MIME['.html'], serveWorkspaceHtml(full, `/run/${m[1]}/${m[2]}/${m[3]}`));
      return send(200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', readFileSync(full));
    }
    m = /^\/run-art\/(B-\d{8}-R\d+)\/(PAIR-[\w-]+)\/(arm-[ab])\/(.+)$/.exec(url);
    if (m) {
      const root = path.join(RESULTS, m[1], m[2], m[3], 'validation'); const file = m[4];
      const full = safeJoin(root, file);
      if (!full || !existsSync(full) || !statSync(full).isFile()) return send(404, 'text/plain', 'not found: ' + file);
      return send(200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', readFileSync(full));
    }
    return send(404, 'text/plain', 'no route: ' + url);
  } catch (err) { return send(500, 'text/plain', String(err && err.message || err)); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[portal] http://127.0.0.1:${PORT}/`));
