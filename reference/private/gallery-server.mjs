// Reference 对照画廊服务器 — 双引擎并排对比 20 个 Reference 实现
// 用法: node gallery-server.mjs [--port 7700]
// 路由:
//   /                     → 画廊入口页(index.html)
//   /api/data.json        → 场景×引擎 得分/评语数据(实时从 results/ 聚合)
//   /<engine>/<scene>/... → 对应 reference 工作区静态文件(index.html 做 /dist/ 前缀重写)
// 零依赖;仅供人工浏览(reference/private 对 Agent Run 不可读的隔离规则不变)。
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));           // bench/reference/private
const BENCH = path.resolve(HERE, '..', '..');                        // bench/
const REF = { three: path.join(HERE, 'three'), cocosair: path.join(HERE, 'cocosair') };

const argv = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(x => x.length));
const PORT = Number(argv.port || 7700);

// ---------- 数据聚合(与 harness/aggregate 同口径) ----------
const ceiling = JSON.parse(readFileSync(path.join(BENCH, 'results', 'reference-ceiling.json'), 'utf8'));
// 盲评数据:批次布局 results/B-*/blind/(取第一个含 judge-pass-1 的批次)
function findJudgeFile() {
  const rs = path.join(BENCH, 'results');
  const batches = existsSync(rs) ? readdirSync(rs).filter(d => /^B-\d{8}-R\d+$/.test(d)).sort() : [];
  for (const b of batches) {
    const f = path.join(rs, b, 'blind', 'judge-pass-1.json');
    if (existsSync(f)) return f;
  }
  const legacy = path.join(rs, 'blind', 'judge-pass-1.json');
  return existsSync(legacy) ? legacy : null;
}
const judgeFile = findJudgeFile();
const judge1 = judgeFile ? JSON.parse(readFileSync(judgeFile, 'utf8')) : { referenceItems: [] };
const ENGINE_OF_LETTER = { X: 'three', Y: 'cocosair' };
const judgeBy = {}; // scene:engine → {total, scores, notes, rank}
for (const it of judge1.referenceItems || []) {
  const m = /^REF-(E\d\d)-([XY])-/.exec(it.id || '');
  if (!m) continue;
  judgeBy[`${m[1]}:${ENGINE_OF_LETTER[m[2]]}`] = { total: Number(it.total ?? 0), scores: it.scores || {}, notes: it.notes || '', rank: it.rank };
}
// 引擎注记(精选自各 Reference ceiling-notes.md,证据见 results/reports/latest/EXPERIMENT-REPORT.md §26.2)
const NOTES = {
  three: { E01: '—', E02: '—', E03: '—', E04: '—', E05: 'UnrealBloom+ACES 后处理链(本场景上限优势面)', E06: '—', E07: 'InstancedMesh/Points 单批次;Reflector 湿地面反射', E08: '—', E09: 'MeshPhysicalMaterial transmission+dispersion+PMREM(材质上限优势面)', E10: '—' },
  cocosair: {
    E01: '辉光以 additive 点精灵近似(无 Bloom)',
    E02: '无顶点缓冲就地改写 API;pal 层吞鼠标事件须走 input 系统',
    E03: '无 InstancedMesh(600 小行星共享网格多节点)',
    E04: '无 3D 粒子系统(动态网格单 draw call 替代)',
    E05: '后处理三闸门实证零可用;自定义 Shader 通道 FULL(替代辉光≈bloom 观感 80-85%)',
    E06: '点光阴影不支持;动态点光照明链路完整可用',
    E07: '无 Points/实例化;合并几何路径实测 1536 楼@54.7fps',
    E08: '无 3D 粒子(整群烘焙单动态网格 1 draw call)',
    E09: '内建 transmission 死代码;自定义管线兑现真实屏幕空间折射+RGB 色散',
    E10: 'GLTFAsset.instantiate 实例化一等公民(优于 Three clone 链)',
  },
};
const TITLES = { E01: '深空星系巡航', E02: '落日海面与孤舟', E03: '太阳系仪', E04: '城市烟花夜', E05: '黑洞吸积盘', E06: '荒野篝火营地', E07: '霓虹夜城', E08: '深海鱼群', E09: '珠宝展示台', E10: '动画角色展示空间' };

function buildData() {
  const scenes = [];
  for (let i = 1; i <= 10; i++) {
    const scene = 'E' + String(i).padStart(2, '0');
    const entry = { scene, title: TITLES[scene] || scene, engines: {} };
    let specDomains = [];
    try { specDomains = JSON.parse(readFileSync(path.join(BENCH, 'briefs', scene, 'spec.json'), 'utf8')).domains || []; } catch { /* optional */ }
    entry.domains = specDomains;
    for (const engine of ['three', 'cocosair']) {
      const row = ceiling.detail.find(d => d.scene === scene && d.engine === engine);
      const j = judgeBy[`${scene}:${engine}`] || { total: null };
      const visual = j.total != null ? Math.round(j.total * 40 / 18) : null;
      const pass = row && row.status === 'FEASIBLE';
      const objective = pass ? 60 : null; // S1 15 + S2 30 + S3 10 + S4 5(全部 PASS+fps 达标,见 reference-ceiling)
      entry.engines[engine] = {
        path: `/${engine}/${scene}/index.html`,
        verdict: row?.effectiveVerdict || row?.status || 'N/A',
        probes: row?.probesPass || 'N/A',
        fps: row?.fps ?? null,
        visualJudge18: j.total ?? null,
        visual40: visual,
        total: objective != null && visual != null ? objective + visual : null,
        judgeScores: j.scores || null,
        judgeNotes: j.notes || '',
        judgeRank: j.rank ?? null,
        engineNote: NOTES[engine][scene] || '—',
        report: `reference/private/${engine}/${scene}/validation/report.json`,
      };
    }
    entry.deltaAirMinusThree = (entry.engines.three.total != null && entry.engines.cocosair.total != null)
      ? entry.engines.cocosair.total - entry.engines.three.total : null;
    scenes.push(entry);
  }
  return { generatedAt: new Date().toISOString(), source: 'results/reference-ceiling.json + results/blind/judge-pass-1.json(匿名视觉评分) + 各 Reference ceiling-notes 精选注记', scenes };
}

// ---------- 静态服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root) ? p : null;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const send = (code, type, body, extra) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(extra || {}) }); res.end(body); };
  try {
    if (url === '/' || url === '/index.html') {
      return send(200, MIME['.html'], readFileSync(path.join(HERE, 'index.html')));
    }
    if (url === '/api/data.json') {
      return send(200, MIME['.json'], JSON.stringify(buildData()));
    }
    const m = /^\/(three|cocosair)\/(E\d\d)(\/.*)?$/.exec(url);
    if (m) {
      const engine = m[1], scene = m[2], rel = (m[3] || '/').replace(/^\/+/, '');
      const root = REF[engine] && path.join(REF[engine], scene);
      if (!existsSync(root)) return send(404, 'text/plain', 'scene not found');
      const file = rel === '' ? 'index.html' : rel;
      const full = safeJoin(root, file);
      if (!full || !existsSync(full) || !statSync(full).isFile()) return send(404, 'text/plain', 'not found: ' + file);
      if (file === 'index.html' || file.endsWith('/index.html')) {
        // 根绝对路径重写:/dist/... → /<engine>/<scene>/dist/...(import map + module src 均为引号包裹)
        const prefix = `/${engine}/${scene}`;
        let html = readFileSync(full, 'utf8');
        html = html.replace(/(["'])\/dist\//g, `$1${prefix}/dist/`).replace(/(["'])\/assets\//g, `$1${prefix}/assets/`);
        return send(200, MIME['.html'], html);
      }
      return send(200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', readFileSync(full));
    }
    return send(404, 'text/plain', 'no route: ' + url);
  } catch (err) {
    return send(500, 'text/plain', String(err && err.message || err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[gallery] http://127.0.0.1:${PORT}/  (scenes: 10 × engines: 2)`);
});
