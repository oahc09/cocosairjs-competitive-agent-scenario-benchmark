#!/usr/bin/env node
// spec-audit.mjs — spec capability audit (rectification §8/§9/§11, FIX-A).
//
// For every probe of a (frozen) spec, judge whether the CURRENT executor in
// harness/runner/probe-executor.mjs can actually honor what the spec wrote:
//
//   SUPPORTED   — the executor implements exactly this action / jq / assertion
//                 type / params key / region form;
//   PARTIAL     — the executor runs something related but not literally what
//                 the spec wrote: unknown region names (usable only as a
//                 diagnostic full-frame fallback, DIAGNOSTIC-FALLBACK),
//                 descriptive `expect` values that are not machine-checked,
//                 unknown probe-level keys that are silently ignored;
//   UNSUPPORTED — the executor cannot evaluate it at all: unknown
//                 visualAssertion.type, unknown params keys, invalid values
//                 for enumerated params, missing required params, unparsable
//                 action/jq. In a scoring run these become SPEC_INVALID.
//
//   node harness/runner/spec-audit.mjs [--spec <file>] [--json <out>]
//   node harness/runner/spec-audit.mjs --selftest     # writes spec-audit-selftest.txt
//
// Default (no --spec): audit all briefs E01..E10 from briefs/index.json.
// Default --json output: results/spec-capability-audit.json.
// Exit codes: 0 = no UNSUPPORTED on required probes; 3 = at least one
// UNSUPPORTED required assertion; 2 = usage / IO error; 1 = selftest failure.
//
// Zero new dependencies (node builtins + pngjs already used by the executor).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { isoNow, parseArgv, sha256File } from './util.mjs';
import {
  parseAction,
  checkJq,
  dryRunSpec,
  classifyVisualAssertion,
  classifyRegionForm,
  checkPreconditionSyntax,
  runVisualAssertion,
  runProbes,
  VISUAL_ASSERTION_TYPES,
  VISUAL_PARAM_KEYS,
  KNOWN_PROBE_KEYS,
} from './probe-executor.mjs';

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(RUNNER_DIR, '..', '..');
const BRIEFS_DIR = path.join(BENCH_ROOT, 'briefs');
const DEFAULT_JSON_OUT = path.join(BENCH_ROOT, 'results', 'spec-capability-audit.json');
const SELFTEST_TXT = path.join(RUNNER_DIR, 'spec-audit-selftest.txt');

// Machine-checked expect values (regionChange DOM paths). Anything else under
// params.expect is descriptive text the executor does not verify -> PARTIAL.
const MACHINE_CHECKED_EXPECT = new Set(['absent', 'visible-text']);

const SEVERITY_ORDER = { SUPPORTED: 0, NONE: 0, PARTIAL: 1, UNSUPPORTED: 2 };
const worst = (a, b) => (SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b);

// ============================================================================
// 1. Audit core (no browser; purely static against the executor vocabulary)
// ============================================================================

function auditVisualAssertion(va) {
  const findings = [];
  const cls = classifyVisualAssertion(va);
  const params = va?.params && typeof va.params === 'object' && !Array.isArray(va.params) ? va.params : {};

  // type
  if (!va?.type) {
    findings.push({ severity: 'UNSUPPORTED', field: 'visualAssertion.type', reason: 'type missing' });
  } else if (!VISUAL_ASSERTION_TYPES.includes(va.type)) {
    findings.push({ severity: 'UNSUPPORTED', field: 'visualAssertion.type', reason: `unknown assertion type "${va.type}" (known: ${VISUAL_ASSERTION_TYPES.join(', ')})` });
  }

  // params (unknown keys / enum values / required) — classifyVisualAssertion
  // problems are all SPEC_INVALID-class. Unknown *regions* are the exception:
  // the executor still has a diagnostic-mode fallback for them (PARTIAL), so
  // they are reported under visualAssertion.region instead of here.
  for (const p of cls.problems) {
    if (p.startsWith('SPEC_INVALID: unknown region')) continue; // handled below as PARTIAL
    const m = /unknown params key "(.+?)"/.exec(p) || /\.([a-zA-Z]+)/.exec(p);
    findings.push({ severity: 'UNSUPPORTED', field: `visualAssertion.params${m ? '.' + m[1] : ''}`, reason: p.replace('SPEC_INVALID: ', '') });
  }

  // expect: machine-checked only for regionChange absent/visible-text
  if (params.expect != null && va?.type === 'regionChange' && MACHINE_CHECKED_EXPECT.has(params.expect)) {
    findings.push({ severity: 'SUPPORTED', field: 'visualAssertion.params.expect', reason: `expect=${params.expect} is DOM-machine-checked` });
  } else if (params.expect != null) {
    findings.push({
      severity: 'PARTIAL',
      field: 'visualAssertion.params.expect',
      reason: `expect=${JSON.stringify(String(params.expect).slice(0, 40))} is descriptive only — executor does not machine-check this semantic (regionChange falls back to a pixel-diff proxy; other types ignore it)`,
    });
  }

  // region
  let region = { status: 'NONE' };
  if (cls.regionClass) {
    if (cls.regionClass.unknown.length) {
      region = {
        status: 'PARTIAL',
        value: params.regions ?? params.region ?? (params.regionA != null ? [params.regionA, params.regionB] : null),
        unknown: cls.regionClass.unknown,
        reason: `outside LEGAL_REGION_FORMS (${cls.regionClass.unknown.map((u) => JSON.stringify(u)).join(', ')}): diagnostic-mode full-frame fallback only (DIAGNOSTIC-FALLBACK); strict scoring run => SPEC_INVALID`,
      };
      findings.push({ severity: 'PARTIAL', field: 'visualAssertion.region', reason: region.reason });
    } else {
      region = {
        status: 'SUPPORTED',
        value: params.regions ?? params.region ?? (params.regionA != null ? [params.regionA, params.regionB] : null),
        dynamic: cls.regionClass.dynamic,
        forms: cls.regionClass.forms,
      };
    }
  }

  const status = findings.reduce((acc, f) => worst(acc, f.severity), 'SUPPORTED');
  return {
    type: va?.type ?? null,
    status,
    region,
    unknownParamKeys: cls.unknownParamKeys,
    findings: findings.filter((f) => f.severity !== 'SUPPORTED'),
  };
}

function auditProbe(probe) {
  const findings = [];
  const required = probe?.enabled !== false;

  // action
  let action = { status: 'NONE' };
  if (probe?.action != null) {
    try {
      const parsed = parseAction(probe.action);
      action = { status: 'SUPPORTED', verbs: parsed.steps.map((s) => s.verb), raw: probe.action };
    } catch (e) {
      action = { status: 'UNSUPPORTED', raw: probe.action, reason: e.message };
      findings.push({ severity: 'UNSUPPORTED', field: 'probe.action', reason: e.message });
    }
  }

  // stateAssertion
  let stateAssertion = { status: 'NONE' };
  if (probe?.stateAssertion?.jq) {
    const c = checkJq(probe.stateAssertion.jq);
    if (c.ok) stateAssertion = { status: 'SUPPORTED', expr: probe.stateAssertion.jq };
    else {
      stateAssertion = { status: 'UNSUPPORTED', expr: probe.stateAssertion.jq, reason: c.error };
      findings.push({ severity: 'UNSUPPORTED', field: 'probe.stateAssertion.jq', reason: c.error });
    }
  }

  // visualAssertion
  let visualAssertion = { status: 'NONE' };
  if (probe?.visualAssertion) {
    visualAssertion = auditVisualAssertion(probe.visualAssertion);
    for (const f of visualAssertion.findings) findings.push(f);
  }

  // precondition syntax
  let precondition = { status: 'NONE' };
  if (probe?.precondition != null) {
    const problems = checkPreconditionSyntax(probe.precondition);
    if (!problems.length) precondition = { status: 'SUPPORTED', expr: probe.precondition };
    else {
      precondition = { status: 'PARTIAL', expr: probe.precondition, problems };
      for (const p of problems) findings.push({ severity: 'PARTIAL', field: 'probe.precondition', reason: p });
    }
  }

  // unknown probe-level keys (silently ignored by the executor)
  for (const k of Object.keys(probe ?? {})) {
    if (!KNOWN_PROBE_KEYS.includes(k)) {
      findings.push({ severity: 'PARTIAL', field: `probe.${k}`, reason: `unknown probe key "${k}" — executor ignores it` });
    }
  }

  const overall = findings.reduce((acc, f) => worst(acc, f.severity), 'SUPPORTED');
  return { probeId: probe?.probeId ?? '(?)', required, overall, action, stateAssertion, visualAssertion, precondition, findings };
}

function auditSpec(spec, specPath) {
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const audited = probes.map(auditProbe);
  return {
    briefId: spec?.briefId ?? null,
    briefVersion: spec?.briefVersion ?? null,
    specPath: specPath ? path.relative(BENCH_ROOT, specPath).replaceAll('\\', '/') : null,
    sha256: specPath ? sha256File(specPath) : null,
    probeCount: probes.length,
    probes: audited,
  };
}

function summarizeResults(specResults) {
  const unsupported = [];
  const partial = [];
  let probeCount = 0;
  for (const s of specResults) {
    for (const p of s.probes) {
      probeCount++;
      for (const f of p.findings) {
        const item = { briefId: s.briefId, probeId: p.probeId, field: f.field, reason: f.reason, required: p.required };
        if (f.severity === 'UNSUPPORTED') unsupported.push(item);
        else if (f.severity === 'PARTIAL') partial.push(item);
      }
    }
  }
  const exitCode = unsupported.some((u) => u.required) ? 3 : 0;
  return {
    specCount: specResults.length,
    probeCount,
    unsupportedCount: unsupported.length,
    partialCount: partial.length,
    unsupported,
    partial,
    exitCode,
    exitReason: exitCode === 3
      ? 'UNSUPPORTED required assertion(s) present — scoring runs will classify SPEC_INVALID; fix spec (amendment) or extend executor'
      : 'no UNSUPPORTED required assertions',
  };
}

function readSpecList(specArg) {
  if (specArg) return [{ path: path.resolve(specArg) }];
  const idxPath = path.join(BRIEFS_DIR, 'index.json');
  const entries = fs.existsSync(idxPath) ? (JSON.parse(fs.readFileSync(idxPath, 'utf8')).entries ?? []) : [];
  const ids = entries.length ? entries.map((e) => e.briefId) : fs.readdirSync(BRIEFS_DIR).filter((d) => /^E\d\d$/.test(d)).sort();
  return ids.map((id) => ({ path: path.join(BRIEFS_DIR, id, 'spec.json') }));
}

// ============================================================================
// 2. CLI audit mode
// ============================================================================

async function runAudit(argv) {
  const specList = readSpecList(argv.spec);
  const specResults = [];
  for (const { path: p } of specList) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`[spec-audit] spec not found: ${p}\n`);
      process.exit(2);
    }
    const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
    specResults.push(auditSpec(spec, p));
  }
  const summary = summarizeResults(specResults);
  const report = {
    generatedAt: isoNow(),
    mode: argv.spec ? 'single' : 'briefs',
    executor: 'harness/runner/probe-executor.mjs',
    legalRegionFormsNote: 'see LEGAL_REGION_FORMS in probe-executor.mjs (full / center|lower|upper:N% / upper|lower|center-third / outer-corners / center-bottom / outer-frame / ui#id / ui=id / state.path / {x,y,w,h} / pickTarget objects / arrays / "A + B")',
    visualAssertionTypes: VISUAL_ASSERTION_TYPES,
    specs: specResults,
    summary,
  };
  const singleSpecMode = Boolean(argv.spec);
  // 一致性5:单 spec 审计(NC 夹具)不得覆写全量生产证据 results/spec-capability-audit.json
  const out = path.resolve(argv.json || (singleSpecMode ? path.join(path.dirname(path.resolve(argv.spec)), 'spec-capability-audit.json') : DEFAULT_JSON_OUT));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');

  for (const s of specResults) {
    const counts = { UNSUPPORTED: 0, PARTIAL: 0, SUPPORTED: 0 };
    for (const p of s.probes) {
      if (counts[p.overall] != null) counts[p.overall]++;
    }
    console.log(`${s.briefId} (${s.briefVersion ?? '-'}): ${s.probeCount} probes — UNSUPPORTED=${counts.UNSUPPORTED} PARTIAL=${counts.PARTIAL} SUPPORTED=${counts.SUPPORTED}`);
    for (const p of s.probes) {
      for (const f of p.findings) {
        console.log(`  [${f.severity}] ${p.probeId}${p.required ? '' : ' (disabled)'} ${f.field}: ${f.reason}`);
      }
    }
  }
  console.log(`---`);
  console.log(`probes audited: ${summary.probeCount} | UNSUPPORTED findings: ${summary.unsupportedCount} | PARTIAL findings: ${summary.partialCount}`);
  console.log(`exit code ${summary.exitCode} — ${summary.exitReason}`);
  console.log(`report: ${out}`);
  return summary.exitCode;
}

// ============================================================================
// 3. Selftest (--selftest): in-memory fake ctx, no real browser
// ============================================================================

/** Synthesize a PNG buffer (painter receives normalized u,v, returns [r,g,b]). */
function synthPng(w, h, painter) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = painter(x / w, y / h);
      const i = (y * w + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Fake page whose screenshot() returns a fixed synthesized frame. */
function fakePixelPage(buf) {
  return {
    screenshot: async () => buf,
    url: () => 'http://127.0.0.1:7100/',
    evaluate: async () => null,
    locator: () => { throw new Error('locator not expected in this test'); },
  };
}

/** Fake page for runProbes: routes evaluate() by inspecting the fn source. */
function fakeStatePage(state, opts = {}) {
  const memorySamples = opts.memorySamples ?? null;
  let memCalls = 0;
  return {
    screenshot: async () => synthPng(64, 64, () => [24, 24, 32]),
    url: opts.url ?? (() => 'http://127.0.0.1:7100/'),
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('__bench')) {
        if (opts.stateError) throw new Error(opts.stateError);
        return state;
      }
      if (src.includes('performance.memory')) {
        if (!memorySamples) return null;
        const v = memorySamples[Math.min(memCalls++, memorySamples.length - 1)];
        return v == null ? null : { usedJSHeapSize: v };
      }
      if (opts.evaluateThrows) throw new Error('evaluate failed (fake dead page)');
      return true;
    },
    locator: () => ({ count: async () => 0, first: () => ({ innerText: async () => '' }) }),
  };
}

async function runSelftest() {
  const lines = [];
  let failed = 0;
  let passed = 0;
  const say = (msg) => { lines.push(String(msg)); process.stdout.write(String(msg) + '\n'); };
  const check = (name, ok, detail = '') => {
    ok ? passed++ : failed++;
    say(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };
  const section = (name) => say('\n' + '='.repeat(72) + '\n== ' + name + '\n' + '='.repeat(72));

  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-audit-selftest-'));
  const baseCtx = (extra = {}) => ({
    page: null,
    viewport: { width: 128, height: 128 },
    getState: async () => ({}),
    saveShot: () => {},
    diagnostic: false,
    startedTs: '2026-10-02T00:00:00.000Z',
    sessionStartTs: '2026-10-02T00:00:00.000Z',
    ...extra,
  });
  const T0 = '2026-10-02T00:00:00.000Z';
  const netLog = [
    { ts: T0, method: 'GET', url: '/index.html', status: 200, bytes: 512 },
    { ts: '2026-10-02T00:00:00.100Z', method: 'GET', url: '/assets/sky.png', status: 200, bytes: 4096 },
    { ts: '2026-10-02T00:00:00.200Z', method: 'GET', url: '/assets/sky.png', status: 200, bytes: 4096 },
    { ts: '2026-10-02T00:00:00.300Z', method: 'GET', url: '/api/error', status: 404, bytes: 0 },
  ];
  const networkSince = (ts) => netLog.filter((e) => e.ts >= ts);

  // ---------------------------------------------------------------- A
  section('A. new assertion types against in-memory fake ctx (no browser)');

  // A1 networkRequest
  {
    const ctx = baseCtx({ networkSince });
    const r1 = await runVisualAssertion(null, { type: 'networkRequest', params: { path: '/assets/sky.png' } }, ctx);
    check('A1 networkRequest minCount=1 (2 hits)', r1.ok === true, `count=${r1.metrics?.count}`);
    const r2 = await runVisualAssertion(null, { type: 'networkRequest', params: { path: '/assets/sky.png', minCount: 3 } }, ctx);
    check('A1 networkRequest minCount=3 fails', r2.ok === false);
    const r3 = await runVisualAssertion(null, { type: 'networkRequest', params: { path: '/api/error', status: 500 } }, ctx);
    check('A1 networkRequest status filter (404 != 500)', r3.ok === false && r3.metrics?.count === 0);
    const r4 = await runVisualAssertion(null, { type: 'networkRequest', params: {} }, baseCtx({ networkSince }));
    check('A1 networkRequest without path -> SPEC_INVALID', r4.ok === false && r4.error?.startsWith('SPEC_INVALID:'));
  }

  // A2 download
  {
    const dl = [{ filename: 'export.csv', bytes: 2048 }];
    const r1 = await runVisualAssertion(null, { type: 'download', params: { minBytes: 1024, count: 1 } }, baseCtx({ downloads: dl }));
    check('A2 download minBytes=1024 count=1', r1.ok === true, JSON.stringify(r1.metrics));
    const r2 = await runVisualAssertion(null, { type: 'download', params: { count: 2 } }, baseCtx({ downloads: dl }));
    check('A2 download count=2 fails (1 event)', r2.ok === false);
    const r3 = await runVisualAssertion(null, { type: 'download', params: { count: 1 } }, baseCtx({}));
    check('A2 download without ctx.downloads -> UNSUPPORTED_BY_ENV', r3.ok === false && r3.error?.startsWith('UNSUPPORTED_BY_ENV:'));
  }

  // A3 domText
  {
    const page = {
      url: () => 'http://x/',
      screenshot: async () => synthPng(8, 8, () => [0, 0, 0]),
      locator: (sel) => ({
        count: async () => (sel === '#out' ? 1 : 0),
        first: () => ({ innerText: async () => 'Exported 42 stars' }),
      }),
    };
    const ctx = baseCtx({ page });
    const r1 = await runVisualAssertion(page, { type: 'domText', params: { selector: '#out', textContains: '42 stars' } }, ctx);
    check('A3 domText contains', r1.ok === true, JSON.stringify(r1.metrics));
    const r2 = await runVisualAssertion(page, { type: 'domText', params: { selector: '#out', textContains: 'NOPE' } }, ctx);
    check('A3 domText missing text fails', r2.ok === false);
    const r3 = await runVisualAssertion(page, { type: 'domText', params: { selector: '.missing', textContains: 'x' } }, ctx);
    check('A3 domText missing element fails', r3.ok === false && r3.metrics?.found === false);
  }

  // A4 noNavigation
  {
    const urlLog = [
      { ts: new Date(Date.now() - 5000).toISOString(), url: 'http://127.0.0.1:7100/' },
      { ts: new Date(Date.now() - 1000).toISOString(), url: 'http://127.0.0.1:7100/' },
    ];
    const stable = fakePixelPage(synthPng(8, 8, () => [0, 0, 0]));
    const r1 = await runVisualAssertion(stable, { type: 'noNavigation', params: { sinceMs: 3000 } }, baseCtx({ urlLog, page: stable }));
    check('A4 noNavigation stable URL', r1.ok === true, JSON.stringify(r1.metrics));
    const moved = { ...stable, url: () => 'http://127.0.0.1:7100/?page=2' };
    const r2 = await runVisualAssertion(moved, { type: 'noNavigation', params: { sinceMs: 3000 } }, baseCtx({ urlLog, page: moved }));
    check('A4 noNavigation URL change fails', r2.ok === false && r2.metrics?.navigated === true);
    const r3 = await runVisualAssertion(stable, { type: 'noNavigation', params: {} }, baseCtx({ urlLog, page: stable }));
    check('A4 noNavigation without sinceMs -> SPEC_INVALID', r3.ok === false && r3.error?.startsWith('SPEC_INVALID:'));
  }

  // A5 resourceRequestCount
  {
    const ctx = baseCtx({ networkSince });
    const r1 = await runVisualAssertion(null, { type: 'resourceRequestCount', params: { path: '/assets/sky.png', exactly: 2 } }, ctx);
    check('A5 resourceRequestCount exactly=2', r1.ok === true);
    const r2 = await runVisualAssertion(null, { type: 'resourceRequestCount', params: { path: '/assets/sky.png', exactly: 3 } }, ctx);
    check('A5 resourceRequestCount exactly=3 fails', r2.ok === false);
    const r3 = await runVisualAssertion(null, { type: 'resourceRequestCount', params: { path: '/assets/sky.png', min: 1, max: 3 } }, ctx);
    check('A5 resourceRequestCount min/max window', r3.ok === true);
    const r4 = await runVisualAssertion(null, { type: 'resourceRequestCount', params: { path: '/assets/sky.png' } }, ctx);
    check('A5 resourceRequestCount without bounds -> SPEC_INVALID', r4.ok === false && r4.error?.startsWith('SPEC_INVALID:'));
  }

  // A6 consoleClean
  {
    const clean = baseCtx({ consoleSince: () => [{ type: 'log', text: 'hello' }] });
    const r1 = await runVisualAssertion(null, { type: 'consoleClean', params: {} }, clean);
    check('A6 consoleClean no errors', r1.ok === true);
    const dirty = baseCtx({ consoleSince: () => [{ type: 'error', text: 'boom' }] });
    const r2 = await runVisualAssertion(null, { type: 'consoleClean', params: {} }, dirty);
    check('A6 consoleClean with error fails', r2.ok === false && r2.metrics?.count === 1);
    const warn = baseCtx({ consoleSince: () => [{ type: 'warning', text: 'careful' }] });
    const r3 = await runVisualAssertion(null, { type: 'consoleClean', params: { level: 'warning' } }, warn);
    check('A6 consoleClean level=warning', r3.ok === false);
    const r4 = await runVisualAssertion(null, { type: 'consoleClean', params: {} }, baseCtx({}));
    check('A6 consoleClean without collector -> UNSUPPORTED_BY_ENV', r4.ok === false && r4.error?.startsWith('UNSUPPORTED_BY_ENV:'));
    const r5 = await runVisualAssertion(null, { type: 'consoleClean', params: { level: 'fatal' } }, clean);
    check('A6 consoleClean bad level -> SPEC_INVALID', r5.ok === false && r5.error?.startsWith('SPEC_INVALID:'));
  }

  // A7/A8 colorRelation + luminanceRelation
  {
    const graySplit = synthPng(128, 128, (u) => (u < 0.5 ? [200, 200, 200] : [40, 40, 60]));
    const page = fakePixelPage(graySplit);
    const ctx = baseCtx({ page });
    const A = { x: 0, y: 0, w: 0.5, h: 1 };
    const B = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const r1 = await runVisualAssertion(page, { type: 'colorRelation', params: { regionA: A, regionB: B, metric: 'luminanceRatio', min: 2 } }, ctx);
    check('A7 colorRelation luminanceRatio min=2', r1.ok === true, `value=${r1.metrics?.value}`);
    const r2 = await runVisualAssertion(page, { type: 'colorRelation', params: { regionA: A, regionB: B, metric: 'luminanceRatio', max: 2 } }, ctx);
    check('A7 colorRelation luminanceRatio max=2 fails', r2.ok === false);
    const warmCool = synthPng(128, 128, (u) => (u < 0.5 ? [220, 128, 128] : [128, 128, 220]));
    const page2 = fakePixelPage(warmCool);
    const ctx2 = baseCtx({ page: page2 });
    const r3 = await runVisualAssertion(page2, { type: 'colorRelation', params: { regionA: A, regionB: B, metric: 'avgRBDiff', min: 50 } }, ctx2);
    check('A7 colorRelation avgRBDiff min=50', r3.ok === true, `value=${r3.metrics?.value}`);
    const r4 = await runVisualAssertion(page, { type: 'colorRelation', params: { regionA: A, regionB: B, metric: 'chroma' } }, ctx);
    check('A7 colorRelation bad metric -> SPEC_INVALID', r4.ok === false && r4.error?.startsWith('SPEC_INVALID:'));
    const r5 = await runVisualAssertion(page, { type: 'luminanceRelation', params: { regionA: A, regionB: B, min: 2 } }, ctx);
    check('A8 luminanceRelation shorthand (no metric key)', r5.ok === true && r5.metrics?.metric === 'luminanceRatio', `value=${r5.metrics?.value}`);
  }

  // A9 regionCoverage
  {
    const halfLit = synthPng(128, 128, (u) => (u < 0.5 ? [0, 0, 0] : [255, 255, 255]));
    const page = fakePixelPage(halfLit);
    const ctx = baseCtx({ page });
    const r1 = await runVisualAssertion(page, { type: 'regionCoverage', params: { region: 'full', minRatio: 0.3 } }, ctx);
    check('A9 regionCoverage full-frame ~0.5 >= 0.3', r1.ok === true, `worst=${r1.metrics?.worstCoverage}`);
    const r2 = await runVisualAssertion(page, { type: 'regionCoverage', params: { region: 'full', minRatio: 0.9 } }, ctx);
    check('A9 regionCoverage ~0.5 < 0.9 fails', r2.ok === false);
    const r3 = await runVisualAssertion(page, { type: 'regionCoverage', params: { region: 'full' } }, ctx);
    check('A9 regionCoverage without minRatio -> SPEC_INVALID', r3.ok === false && r3.error?.startsWith('SPEC_INVALID:'));
  }

  // A10 memoryDelta
  {
    const MB = 1048576;
    const page = fakeStatePage(null, { memorySamples: [100 * MB, 102 * MB] });
    const ctx = baseCtx({ page });
    const r1 = await runVisualAssertion(page, { type: 'memoryDelta', params: { maxGrowthMB: 5, sampleMs: 10 } }, ctx);
    check('A10 memoryDelta +2MB <= 5MB', r1.ok === true, `growth=${r1.metrics?.growthMB}MB`);
    const pageB = fakeStatePage(null, { memorySamples: [100 * MB, 108 * MB] });
    const r2 = await runVisualAssertion(pageB, { type: 'memoryDelta', params: { maxGrowthMB: 5, sampleMs: 10 } }, baseCtx({ page: pageB }));
    check('A10 memoryDelta +8MB > 5MB fails', r2.ok === false);
    const pageC = fakeStatePage(null, { memorySamples: null });
    const r3 = await runVisualAssertion(pageC, { type: 'memoryDelta', params: { maxGrowthMB: 5, sampleMs: 10 } }, baseCtx({ page: pageC }));
    check('A10 memoryDelta without performance.memory -> UNSUPPORTED_BY_ENV', r3.ok === false && r3.error?.startsWith('UNSUPPORTED_BY_ENV:'));
  }

  // A11 assetNoReload
  {
    const byId = new Map([['P1', { probeId: 'P1', startedTs: '2026-10-02T00:00:00.150Z', status: 'PASS' }]]);
    const r1 = await runVisualAssertion(null, { type: 'assetNoReload', params: { path: '/models/ship.glb', sinceActionIndex: 'P1' } }, baseCtx({ networkSince, byId }));
    check('A11 assetNoReload no reload since P1', r1.ok === true, `requests=${r1.metrics?.requests}`);
    const r2 = await runVisualAssertion(null, { type: 'assetNoReload', params: { path: '/assets/sky.png', sinceActionIndex: 1 } }, baseCtx({ networkSince, byId }));
    check('A11 assetNoReload reload detected (numeric index form)', r2.ok === false && r2.metrics?.requests === 1, `requests=${r2.metrics?.requests}`);
    const r3 = await runVisualAssertion(null, { type: 'assetNoReload', params: { path: '/x', sinceActionIndex: 'P9' } }, baseCtx({ networkSince, byId }));
    check('A11 assetNoReload unknown ref -> SPEC_INVALID', r3.ok === false && r3.error?.startsWith('SPEC_INVALID:'));
  }

  // ---------------------------------------------------------------- B
  section('B. SPEC_INVALID discipline (unknown type / region / param)');

  {
    const page = fakePixelPage(synthPng(128, 128, () => [128, 128, 128]));
    const ctx = baseCtx({ page });
    const r1 = await runVisualAssertion(page, { type: 'warpDrive', params: { factor: 9 } }, ctx);
    check('B12 unknown assertion type -> SPEC_INVALID prefix', r1.ok === false && r1.error === 'SPEC_INVALID: unknown assertion type: warpDrive', r1.error);

    const hudVa = { type: 'nonBlank', params: { region: 'hud', minLitPixelRatio: 0.02 } };
    const halfLit = synthPng(128, 128, (u) => (u < 0.5 ? [0, 0, 0] : [255, 255, 255]));
    const pageHud = fakePixelPage(halfLit);
    const r2 = await runVisualAssertion(pageHud, hudVa, baseCtx({ page: pageHud }));
    check('B13 unknown region "hud" strict -> SPEC_INVALID', r2.ok === false && r2.error === 'SPEC_INVALID: unknown region hud', r2.error);

    const r3 = await runVisualAssertion(pageHud, hudVa, baseCtx({ page: pageHud, diagnostic: true }));
    check('B14 diagnostic:true -> DIAGNOSTIC-FALLBACK note + evaluation', r3.ok === true && r3.notes?.some((n) => n.startsWith('DIAGNOSTIC-FALLBACK')), JSON.stringify(r3.notes));

    const dry = await dryRunSpec({
      briefId: 'SELFTEST-INVALID',
      probes: [
        { probeId: 'PX', action: 'wait:10', visualAssertion: { type: 'motion', params: { region: 'full', warpSpeed: 5 } } },
        { probeId: 'PY', action: 'wait:10', visualAssertion: { type: 'nonBlank', params: { region: 'warp-zone' } } },
        { probeId: 'PZ', action: 'wait:10', visualAssertion: { type: 'regionCoverage', params: { region: 'full', minRatio: 0.1 } } },
      ],
    });
    check('B15 dryRunSpec flags unknown param key', dry.allOk === false && dry.problems.some((p) => p.includes('unknown params key "warpSpeed"')), JSON.stringify(dry.problems));
    check('B15 dryRunSpec flags unknown region', dry.problems.some((p) => p.includes('unknown region') && p.includes('warp-zone')));
    const good = await dryRunSpec({ briefId: 'SELFTEST-OK', probes: [{ probeId: 'P1', precondition: '__appReady && $.ready == true', action: 'click:ui=reset+wait:100', stateAssertion: { jq: '$.x >= 1' }, visualAssertion: { type: 'regionCoverage', params: { region: 'center:40%', minRatio: 0.1 } } }] });
    check('B15 dryRunSpec clean mini-spec passes', good.allOk === true, JSON.stringify(good.problems));
  }

  // ---------------------------------------------------------------- C
  section('C. precondition cascade (three-way semantics, fake probe sequence)');

  {
    const state = { x: 1 };
    const page = fakeStatePage(state);
    const spec = {
      briefId: 'SELFTEST-CASCADE',
      probes: [
        { probeId: 'P1', precondition: '__appReady', action: 'wait:10', stateAssertion: { jq: '$.x == 1' } },
        { probeId: 'P2', precondition: 'P1 passed', action: 'wait:10', stateAssertion: { jq: '$.x == 99' } },
        { probeId: 'P3', precondition: 'P2 passed', action: 'wait:10', stateAssertion: { jq: '$.x == 1' } },
        { probeId: 'P4', precondition: 'P9 passed', action: 'wait:10', stateAssertion: { jq: '$.x == 1' } },
        { probeId: 'P5', enabled: false, action: 'wait:10', stateAssertion: { jq: '$.x == 1' } },
        { probeId: 'P6', precondition: 'P1 passed', action: 'wait:10', stateAssertion: { jq: '$.x == 1' } },
      ],
    };
    const run = await runProbes(spec, {
      page,
      viewport: { width: 128, height: 128 },
      appReady: true,
      shotDir,
      probeMeta: { fullPassDeps: { P6: ['P2'] } },
    });
    const by = Object.fromEntries(run.results.map((r) => [r.probeId, r]));
    check('C16 P1 PASS', by.P1.status === 'PASS', by.P1.status);
    check('C16 P2 stateAssertion false -> FAIL', by.P2.status === 'FAIL', by.P2.status);
    check('C16 P3 runs despite P2 FAIL', by.P3.status === 'PASS' && by.P3.ranDespitePredecessor === true && by.P3.predecessor === 'P2', `${by.P3.status} pred=${by.P3.predecessor}`);
    check('C16 P4 unknown predecessor ref -> SKIPPED_BY_DEPENDENCY', by.P4.status === 'SKIPPED_BY_DEPENDENCY' && by.P4.skippedBy?.kind === 'precondition-error', by.P4.status);
    check('C16 P5 enabled:false -> NOT_APPLICABLE', by.P5.status === 'NOT_APPLICABLE', by.P5.status);
    check('C16 P6 fullPassDeps [P2] not PASS -> SKIPPED_BY_DEPENDENCY', by.P6.status === 'SKIPPED_BY_DEPENDENCY' && by.P6.skippedBy?.kind === 'fullPassDeps', JSON.stringify(by.P6.skippedBy));
    check('C16 NOT_APPLICABLE excluded from weight totals', run.totalWeight === 5, `totalWeight=${run.totalWeight}`);

    const deadPage = fakeStatePage(state, { stateError: 'page crashed' });
    const run2 = await runProbes({ probes: [{ probeId: 'P1', precondition: '$.x == 1', action: 'wait:10', stateAssertion: { jq: '$.x == 1' } }] }, {
      page: deadPage, viewport: { width: 128, height: 128 }, appReady: true, shotDir,
    });
    check('C16 state sample error -> precondition ERROR -> SKIPPED_BY_DEPENDENCY', run2.results[0].status === 'SKIPPED_BY_DEPENDENCY', run2.results[0].status);
  }

  // ---------------------------------------------------------------- D
  section('D. audit verdict + exit code rule');

  {
    const spec = {
      briefId: 'SELFTEST-AUDIT',
      probes: [
        { probeId: 'P1', action: 'wait:10', visualAssertion: { type: 'teleport', params: {} } },
        { probeId: 'P2', action: 'wait:10', visualAssertion: { type: 'nonBlank', params: { region: 'hud' } } },
        { probeId: 'P3', enabled: false, action: 'wait:10', visualAssertion: { type: 'teleport', params: {} } },
      ],
    };
    const audited = auditSpec(spec, null);
    const summary = summarizeResults([audited]);
    const by = Object.fromEntries(audited.probes.map((p) => [p.probeId, p]));
    check('D17 unknown type on required probe -> UNSUPPORTED', by.P1.overall === 'UNSUPPORTED', by.P1.overall);
    check('D17 unknown region -> PARTIAL (diagnostic fallback only)', by.P2.overall === 'PARTIAL', by.P2.overall);
    const onlyDisabled = summarizeResults([auditSpec({ probes: [{ probeId: 'P3', enabled: false, action: 'wait:10', visualAssertion: { type: 'teleport', params: {} } }] }, null)]);
    check('D17 UNSUPPORTED on a disabled probe alone -> exit 0', onlyDisabled.exitCode === 0, `exit=${onlyDisabled.exitCode}`);
    check('D17 required UNSUPPORTED present -> exit 3', summary.exitCode === 3, `exit=${summary.exitCode}`);
    const clean = summarizeResults([auditSpec({ probes: [{ probeId: 'P1', action: 'wait:10', visualAssertion: { type: 'regionCoverage', params: { region: 'full', minRatio: 0.1 } } }] }, null)]);
    check('D17 clean spec -> exit 0', clean.exitCode === 0);
  }

  // ---------------------------------------------------------------- summary
  section('SUMMARY');
  say(`checks: ${passed}/${passed + failed} passed`);
  say(`result: ${failed === 0 ? 'SPEC-AUDIT SELFTEST PASS' : 'SPEC-AUDIT SELFTEST FAIL'}`);
  try { fs.rmSync(shotDir, { recursive: true, force: true }); } catch { /* best effort */ }
  lines.push('', `generatedAt: ${isoNow()}`);
  fs.writeFileSync(SELFTEST_TXT, lines.join('\n') + '\n', 'utf8');
  say(`written: ${SELFTEST_TXT}`);
  return failed === 0 ? 0 : 1;
}

// ============================================================================
// 4. CLI dispatch
// ============================================================================

const argv = parseArgv(process.argv.slice(2));
if (argv.selftest) {
  process.exit(await runSelftest());
}
if (argv.help || argv.h) {
  process.stdout.write('usage: node harness/runner/spec-audit.mjs [--spec <file>] [--json <out>] [--selftest]\n');
  process.exit(0);
}
process.exit(await runAudit(argv));
