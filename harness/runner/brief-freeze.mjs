#!/usr/bin/env node
// brief-freeze.mjs — brief & asset hash freeze (MASTER-CONTEXT §12.2):
//   1. compute sha256 of every bench/briefs/E*/brief.md -> briefs/index.json
//      entries {briefId, version, sha256, frozenAt};
//   2. backfill asset sha256 from bench/assets/MANIFEST.json into the
//      spec.json assets[] of E02 / E09 / E10 (placeholders
//      "pending-asset-freeze" and "computed-by-harness");
//   3. also fill the top-level spec "briefSha256" placeholder
//      ("computed-by-harness") with the brief.md hash where present.
//
// Idempotent: rewrites a file only when content actually changes.
//   node runner/brief-freeze.mjs [--check]   # --check reports drift, writes nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, isoNow, parseArgv, readJson, writeJson } from './util.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_ROOT = path.resolve(HARNESS_DIR, '..');
const BRIEFS_DIR = path.join(BENCH_ROOT, 'briefs');
const MANIFEST_PATH = path.join(BENCH_ROOT, 'assets', 'MANIFEST.json');

const argv = parseArgv(process.argv.slice(2));
const checkOnly = !!argv.check;

const PLACEHOLDER_SHA = new Set(['pending-asset-freeze', 'computed-by-harness', 'computed-by-harness-pending', '']);
const ASSET_BACKFILL_BRIEFS = ['E02', 'E09', 'E10'];

const changes = [];
const notes = [];

// --- 1. brief.md hashes -> briefs/index.json -------------------------------
const briefDirs = fs
  .readdirSync(BRIEFS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^E\d{2}$/.test(d.name))
  .map((d) => d.name)
  .sort();

if (briefDirs.length !== 10) {
  notes.push(`expected 10 brief dirs, found ${briefDirs.length}: ${briefDirs.join(',')}`);
}

const entries = [];
for (const id of briefDirs) {
  const briefMd = path.join(BRIEFS_DIR, id, 'brief.md');
  if (!fs.existsSync(briefMd)) {
    notes.push(`${id}: brief.md MISSING`);
    continue;
  }
  const sha = sha256(fs.readFileSync(briefMd));
  let spec = null;
  try {
    spec = readJson(path.join(BRIEFS_DIR, id, 'spec.json'));
  } catch {
    notes.push(`${id}: spec.json unreadable`);
  }
  entries.push({
    briefId: id,
    version: spec?.briefVersion ?? null,
    sha256: sha,
    frozenAt: spec?.frozenAt ?? isoNow(),
  });
}

const indexPath = path.join(BRIEFS_DIR, 'index.json');
let indexChanged = true;
if (fs.existsSync(indexPath)) {
  try {
    const existing = readJson(indexPath);
    // compare ignoring generatedAt (re-runs stay idempotent)
    indexChanged = JSON.stringify(existing.entries ?? null) !== JSON.stringify(entries);
  } catch {
    indexChanged = true;
  }
}
if (indexChanged) {
  changes.push({ file: path.relative(BENCH_ROOT, indexPath), what: `${entries.length} brief.md sha256 entries` });
  if (!checkOnly) writeJson(indexPath, { generatedAt: isoNow(), entries });
} else {
  notes.push('briefs/index.json already up to date');
}

// --- 2. asset sha backfill into spec.json ----------------------------------
const manifest = readJson(MANIFEST_PATH);
const shaByAssetPath = new Map(manifest.assets.map((a) => [a.path, a.sha256]));

for (const id of ASSET_BACKFILL_BRIEFS) {
  const specPath = path.join(BRIEFS_DIR, id, 'spec.json');
  if (!fs.existsSync(specPath)) {
    notes.push(`${id}: spec.json missing, skipped`);
    continue;
  }
  const spec = readJson(specPath);
  const touched = [];
  for (const asset of spec.assets ?? []) {
    const real = shaByAssetPath.get(asset.path);
    if (!real) {
      notes.push(`${id}: asset ${asset.path} not in MANIFEST.json — left as-is`);
      continue;
    }
    if (asset.sha256 !== real) {
      if (!PLACEHOLDER_SHA.has(String(asset.sha256))) {
        notes.push(`${id}: asset ${asset.path} sha256 mismatch vs MANIFEST (spec has ${asset.sha256?.slice(0, 12)}..., manifest ${real.slice(0, 12)}...) — MANIFEST wins, recorded`);
      }
      asset.sha256 = real;
      touched.push(asset.path);
    }
  }
  // top-level briefSha256 placeholder -> brief.md hash
  if (String(spec.briefSha256 ?? '') === 'computed-by-harness') {
    const briefMd = path.join(BRIEFS_DIR, id, 'brief.md');
    if (fs.existsSync(briefMd)) {
      spec.briefSha256 = sha256(fs.readFileSync(briefMd));
      touched.push('briefSha256(top-level)');
    }
  }
  if (touched.length) {
    changes.push({ file: path.relative(BENCH_ROOT, specPath), what: `backfilled ${touched.join(', ')}` });
    if (!checkOnly) writeJson(specPath, spec);
  } else {
    notes.push(`${id}: spec.json already frozen (assets match MANIFEST)`);
  }
}

// --- summary ----------------------------------------------------------------
const summary = {
  ok: true,
  checkOnly,
  briefCount: entries.length,
  assetBackfillBriefs: ASSET_BACKFILL_BRIEFS,
  changes,
  wouldChange: changes.map((c) => c.file),
  notes,
};
if (checkOnly && changes.length) summary.ok = false; // drift detected in check mode
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(summary.ok ? 0 : 1);
