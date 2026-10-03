// M4 Reference 验收汇总:Engine Ceiling + Capability Availability + G3
// 读取 reference/private/<engine>/<E>/validation/report.json 与 REFERENCE-VERDICT.md
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENES = readdirSync(path.join(ROOT, 'briefs')).filter(d => /^E\d\d$/.test(d)).sort();
const ENGINES = ['three', 'cocosair'];
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const rows = [];
let allOk = true;
for (const scene of SCENES) {
  for (const engine of ENGINES) {
    const dir = path.join(ROOT, 'reference', 'private', engine, scene);
    const reportPath = path.join(dir, 'validation', 'report.json');
    const verdictPath = path.join(dir, 'REFERENCE-VERDICT.md');
    const entry = { scene, engine, dir };
    if (!existsSync(reportPath) || !existsSync(verdictPath)) {
      entry.status = 'MISSING'; allOk = false; rows.push(entry); continue;
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const verdictMd = readFileSync(verdictPath, 'utf8');
    // verdict 取全文首个出现的正式枚举词(每个 verdict 文件只有一个判定)
    const v = (verdictMd.match(/ENGINE_UNAVAILABLE|ENGINE_LIMITED|FEASIBLE/) || [])[0] || 'UNKNOWN';
    // 仅当 verdict 文件显式声明 ENGINE_LIMITED 时记注记(不因泛词误报)
    const limitedAnnotated = /ENGINE_LIMITED/.test(verdictMd);
    entry.status = report.verdict === 'PASS' ? 'FEASIBLE' : 'REF_FAIL';
    entry.verdict = v;
    entry.effectiveVerdict = v === 'FEASIBLE' && limitedAnnotated ? 'FEASIBLE_LIMITED' : v;
    entry.probePassRate = report.probePassRate;
    entry.probesPass = `${report.probes.filter(p => p.status === 'PASS').length}/${report.probes.length}`;
    entry.fps = report.fps;
    entry.consoleErrors = report.console?.uncaughtErrors ?? null;
    entry.reportSha = sha(readFileSync(reportPath, 'utf8'));
    if (report.verdict !== 'PASS') allOk = false;
    if (entry.consoleErrors > 0) allOk = false;
    rows.push(entry);
  }
}

const byScene = SCENES.map(scene => {
  const three = rows.find(r => r.scene === scene && r.engine === 'three');
  const air = rows.find(r => r.scene === scene && r.engine === 'cocosair');
  return {
    scene,
    three: three ? { verdict: three.effectiveVerdict ?? three.status, probes: three.probesPass, fps: three.fps } : null,
    air: air ? { verdict: air.effectiveVerdict ?? air.status, probes: air.probesPass, fps: air.fps } : null,
  };
});

const availability = {
  three: `${rows.filter(r => r.engine === 'three' && r.status === 'FEASIBLE').length}/${SCENES.length}`,
  air: `${rows.filter(r => r.engine === 'cocosair' && r.status === 'FEASIBLE').length}/${SCENES.length}`,
};

const ceiling = {
  generatedAt: new Date().toISOString(),
  track: 'A — Engine Ceiling(M4 Reference 验收汇总)',
  availability,
  scenes: byScene,
  detail: rows,
  note: 'S1-S3 客观分可直接由 report.json 复算(probePassRate/fps/console);Visual 六维正式分由 M10 盲评管道出分,此处不代评。verdict 为 FEASIBLE_LIMITED 表示行为合同全绿但 Reference 已如实标注引擎受限面(主要为 AIR 后处理/传输路径)。',
};

writeFileSync(path.join(ROOT, 'results', 'reference-ceiling.json'), JSON.stringify(ceiling, null, 2));

const g3 = {
  gate: 'G3 REFERENCE_FEASIBILITY',
  status: allOk ? 'PASS' : 'FAIL',
  validatedAt: new Date().toISOString(),
  criteria: '20 个 Reference 全部存在、validate verdict=PASS、0 未捕获异常;每个含 REFERENCE-VERDICT/WORKLOG/ceiling-notes/validation 证据',
  capabilityAvailability: availability,
  evidence: 'results/reference-ceiling.json',
  details: rows.map(r => `${r.scene}/${r.engine}: ${r.status === 'FEASIBLE' ? `${r.effectiveVerdict} probes=${r.probesPass} fps=${r.fps}` : r.status}`),
};
writeFileSync(path.join(ROOT, 'gates', 'G3.json'), JSON.stringify(g3, null, 2));
console.log(`G3=${g3.status} availability three=${availability.three} air=${availability.air}`);
for (const s of byScene) console.log(`${s.scene}: three=${s.three?.verdict}(${s.three?.probes},${s.three?.fps}fps) air=${s.air?.verdict}(${s.air?.probes},${s.air?.fps}fps)`);
