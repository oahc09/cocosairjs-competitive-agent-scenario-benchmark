#!/usr/bin/env node
// score.mjs — compose S1..S4 + Visual into run scores, then pair metrics.
//
//   node runner/score.mjs --reports <glob> --visual <visualScores.json | inline JSON>
//                        [--ceiling <json|inline>] [--out <dir>]
//
// --visual maps runId -> six dimensions (each 0-3):
//   { "<runId>": { "构图":3, "材质光影":2, "动效流畅":3, "特效质感":2, "交互反馈":2, "整体完成度":3 } }
//   Missing dimensions mean "not judged": visual is recorded as null.
//   Optional per-run override: { "<runId>": { ..., "s4": { "structure":3, "antiPattern":2 } } }
// --ceiling (optional): { "air": 95, "three": 90 } or { "<pairId>": { "air": n, "three": n } }
//   enables attainment + attainmentDelta (only defined for FEASIBLE/ENGINE_LIMITED
//   reference verdicts per metric-spec.md §2.3).
//
// Outputs (2-space JSON): runs.json and, when pairable runs exist, pairs.json.
//   win/tie/loss: tie threshold frozen at |rawDelta| <= 3 (metric-spec §6.1).
//   bootstrap: 2000 paired resamples (seeded, reproducible), median delta
//   percentile CI 2.5/97.5 (metric-spec §7.1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv, expandGlob, readJson, writeJson, isoNow, median, percentile, mulberry32, round2 } from './util.mjs';

const argv = parseArgv(process.argv.slice(2));
if (!argv.reports || !argv.visual) {
  process.stderr.write("usage: node runner/score.mjs --reports '<glob>' --visual <visualScores.json|inline-json> [--ceiling json] [--out dir]\n");
  process.exit(2);
}

const VISUAL_DIMS = [
  ['构图', 'composition'],
  ['材质光影', 'material'],
  ['动效流畅', 'motion'],
  ['特效质感', 'effects'],
  ['交互反馈', 'interaction'],
  ['整体完成度', 'completeness'],
];

function loadJsonArg(val, label) {
  const trimmed = String(val).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return readJson(path.resolve(trimmed));
}

function scoreRun(rep, visualInput) {
  const si = rep.scoreInputs || {};
  const s1Items = {
    buildPass: !!(si.s1?.buildPass ?? rep.build?.ok),
    readyNoError: !!(si.s1?.readyNoError ?? (rep.ready?.appReady && (rep.console?.uncaughtErrors ?? 0) === 0)),
    firstShotNonBlank: !!(si.s1?.firstShotNonBlank),
  };
  const s1 = (s1Items.buildPass ? 7 : 0) + (s1Items.readyNoError ? 5 : 0) + (s1Items.firstShotNonBlank ? 3 : 0);

  const passedWeight = si.s2?.passedWeight ?? rep.probes?.filter((p) => p.status === 'PASS').length ?? 0;
  const totalWeight = si.s2?.totalWeight ?? rep.probes?.length ?? 0;
  const passRate = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const s2 = Math.round(30 * passRate);

  const fpsMet = !!(si.s3?.fpsMet ?? (rep.perf?.fpsMet ?? (rep.fps != null && rep.fps >= (si.s3?.minFps ?? 30))));
  const s3 = (si.s3?.lifecycleProbePassed ? 6 : 0) + (fpsMet ? 4 : 0);

  const s4Override = visualInput?.s4 && typeof visualInput.s4 === 'object' ? visualInput.s4 : null;
  const s4Items = {
    structure: s4Override ? Number(s4Override.structure ?? 3) : 3,
    antiPattern: s4Override ? Number(s4Override.antiPattern ?? 2) : 2,
    source: s4Override ? 'judge-override' : 'default-placeholder (rule-based review pending)',
  };
  const s4 = Math.max(0, Math.min(5, s4Items.structure + s4Items.antiPattern));

  const dims = {};
  let dimsPresent = 0;
  let dimsSum = 0;
  for (const [zh] of VISUAL_DIMS) {
    const raw = visualInput ? visualInput[zh] : undefined;
    const v = Number(raw);
    if (Number.isInteger(v) && v >= 0 && v <= 3) {
      dims[zh] = v;
      dimsPresent++;
      dimsSum += v;
    } else {
      dims[zh] = null;
    }
  }
  const visualComplete = dimsPresent === 6;
  const visual = visualComplete ? Math.round((dimsSum * 40) / 18) : null;

  const objective = s1 + s2 + s3 + s4;
  const total = visual === null ? null : objective + visual;

  return {
    runId: rep.runId,
    reportFile: null, // filled by caller
    briefId: rep.spec?.briefId ?? null,
    pairId: rep.pairId ?? null,
    engine: rep.engine ?? null,
    classification: rep.classification ?? null,
    verdict: rep.verdict ?? null,
    probePassRate: rep.probePassRate ?? passRate,
    fps: rep.fps ?? null,
    s1: { score: s1, items: { ...s1Items, build: 7 * s1Items.buildPass, readyNoError: 5 * s1Items.readyNoError, nonBlank: 3 * s1Items.firstShotNonBlank } },
    s2: { score: s2, passedWeight, totalWeight, passRate: round2(passRate, 4), behaviorItemsCount: si.s2?.behaviorItemsCount ?? null },
    s3: { score: s3, items: { lifecycle: si.s3?.lifecycleProbePassed ? 6 : 0, fps: fpsMet ? 4 : 0 }, minFps: si.s3?.minFps ?? 30, lifecycleProbeId: si.s3?.lifecycleProbeId ?? null },
    s4: { score: s4, items: s4Items },
    visual: { score: visual, dims, dimsSum: visualComplete ? dimsSum : null, note: visualComplete ? 'round(sum x 40 / 18)' : 'not judged (missing dims) -> null' },
    objective,
    total,
  };
}

// ---------- load reports ----------
const files = await expandGlob(argv.reports);
if (!files.length) {
  process.stderr.write(`no reports matched: ${argv.reports}\n`);
  process.exit(2);
}
const visualAll = loadJsonArg(argv.visual, 'visual');
const ceilingAll = argv.ceiling ? loadJsonArg(argv.ceiling, 'ceiling') : null;
const outDir = path.resolve(argv.out || '.');

const runs = [];
for (const f of files) {
  let rep;
  try {
    rep = readJson(f);
  } catch (e) {
    runs.push({ reportFile: f, error: `unreadable report: ${e.message}` });
    continue;
  }
  const vi = visualAll[rep.runId] ?? visualAll[path.basename(f, '.json')] ?? null;
  const scored = scoreRun(rep, vi);
  scored.reportFile = f;
  runs.push(scored);
}
writeJson(path.join(outDir, 'runs.json'), { generatedAt: isoNow(), inputs: { reports: argv.reports, visual: argv.visual }, runCount: runs.length, runs });

// ---------- pairs ----------
const pairable = runs.filter((r) => r.pairId && r.engine && typeof r.total === 'number');
const groups = new Map();
for (const r of pairable) {
  if (!groups.has(r.pairId)) groups.set(r.pairId, []);
  groups.get(r.pairId).push(r);
}

function attainment(run, ceil) {
  if (typeof ceil !== 'number' || ceil <= 0 || typeof run.total !== 'number') return null;
  return round2((run.total / ceil) * 100, 1);
}

const pairs = [];
for (const [pid, members] of groups) {
  const air = members.find((m) => String(m.engine).toLowerCase().includes('air'));
  const three = members.find((m) => String(m.engine).toLowerCase().includes('three'));
  if (!air || !three) continue;
  const ceil = ceilingAll?.[pid] ?? ceilingAll ?? null;
  const rawDelta = air.total - three.total; // AIR - Three (metric-spec §6)
  const attAir = ceil ? attainment(air, Number(ceil.air)) : null;
  const attThree = ceil ? attainment(three, Number(ceil.three)) : null;
  const attainmentDelta = attAir !== null && attThree !== null ? round2(attAir - attThree, 1) : null;
  const outcome = rawDelta > 3 ? 'AIR_win' : rawDelta < -3 ? 'Three_win' : 'TIE';
  pairs.push({
    pairId: pid,
    air: { runId: air.runId, total: air.total },
    three: { runId: three.runId, total: three.total },
    rawDelta,
    outcome,
    attainmentDelta,
    attainment: { air: attAir, three: attThree, ceiling: ceil ?? null },
  });
}

let pairSummary = null;
if (pairs.length) {
  const deltas = pairs.map((p) => p.rawDelta);
  const counts = {
    AIR_win: pairs.filter((p) => p.outcome === 'AIR_win').length,
    TIE: pairs.filter((p) => p.outcome === 'TIE').length,
    Three_win: pairs.filter((p) => p.outcome === 'Three_win').length,
  };
  // bootstrap over pairs (paired resampling, seeded for reproducibility)
  const B = 2000;
  const rnd = mulberry32(42);
  const medians = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < pairs.length; i++) sample.push(deltas[Math.floor(rnd() * deltas.length)]);
    medians.push(median(sample));
  }
  pairSummary = {
    pairCount: pairs.length,
    medianRawDelta: round2(median(deltas), 2),
    winTieLoss: { ...counts, tieThreshold: 3 },
    bootstrap: {
      resamples: B,
      seed: 42,
      method: 'paired resampling, percentile CI on median delta',
      ci95: [round2(percentile(medians, 2.5), 2), round2(percentile(medians, 97.5), 2)],
    },
  };
  writeJson(path.join(outDir, 'pairs.json'), { generatedAt: isoNow(), summary: pairSummary, pairs });
}

// ---------- stdout summary ----------
process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      runsWritten: path.join(outDir, 'runs.json'),
      pairsWritten: pairs.length ? path.join(outDir, 'pairs.json') : null,
      runCount: runs.length,
      pairCount: pairs.length,
      pairSummary,
    },
    null,
    2
  ) + '\n'
);
