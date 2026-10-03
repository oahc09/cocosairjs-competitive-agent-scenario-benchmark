// util.mjs — shared helpers for the harness runner.
// Harness-internal only. Never imports or requires anything from the workspace under test.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

/** Current time as ISO-8601 (UTC, ms precision). */
export function isoNow() {
  return new Date().toISOString();
}

/** SHA-256 hex of a Buffer/Uint8Array/string. */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 hex of a file; null if missing. */
export function sha256File(p) {
  try {
    return sha256(fs.readFileSync(p));
  } catch {
    return null;
  }
}

/** Write JSON with 2-space indent + trailing newline (repo-wide convention). */
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Stable JSON stringify (sorted keys) — used for hashing structured data. */
export function stableStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Deep-structural equality on JSON-able data. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  return stableStringify(a) === stableStringify(b);
}

/** Recursively walk a directory. Returns absolute file paths. skipDirs: basenames to prune. */
export async function walkFiles(root, { skipDirs = [] } = {}) {
  const out = [];
  const skip = new Set(skipDirs);
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await rec(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

/** Ask the OS for a free TCP port on 127.0.0.1 (listen on :0, read port, close). */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll an async predicate until it returns truthy or timeout. */
export async function poll(fn, { intervalMs = 200, timeoutMs = 10000, label = 'poll' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${label}: timeout after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal glob expansion for `--reports <glob>` style args.
 * Supports `*` (within one segment), `**` (across segments) and `?`.
 * Backslashes are normalized to `/`. Returns matched file paths.
 */
export async function expandGlob(pattern) {
  const norm = String(pattern).replaceAll('\\', '/');
  const hasMagic = /[*?]/.test(norm);
  if (!hasMagic) return fs.existsSync(norm) ? [norm] : [];

  const abs = path.isAbsolute(norm) ? norm : path.resolve(process.cwd(), norm);
  const segments = abs.split(/\/+/).filter(Boolean).slice(1); // drop drive letter
  const drive = abs.split(/\/+/)[0]; // e.g. "E:"
  let dirs = [`${drive}/`];
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const seg = segments[i];
    const next = [];
    if (seg === '**') {
      // match zero or more directories: recurse everything below
      const expand = async (d) => {
        next.push(d);
        let entries = [];
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) if (e.isDirectory()) await expand(path.join(d, e.name));
      };
      for (const d of dirs) await expand(d);
    } else {
      const re = new RegExp('^' + seg.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '.') + '$');
      for (const d of dirs) {
        let entries = [];
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!re.test(e.name)) continue;
          if (isLast ? e.isFile() || e.isSymbolicLink() : e.isDirectory()) next.push(path.join(d, e.name));
        }
      }
    }
    dirs = next;
  }
  return dirs.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Deterministic PRNG (mulberry32) — reproducible bootstrap resampling. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile of a numeric array (nearest-rank on sorted copy). */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Parse `--key value` / `--flag` argv into a map. */
export function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Round to `digits` decimals (default 2); keeps null/undefined as-is. */
export function round2(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
