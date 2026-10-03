// tools/fetch-character.mjs — download the Khronos Fox (GLTF-Binary) into
// assets/character.glb and structurally validate it before accepting:
//   GLB magic 0x46546C67, glTF 2.0, skins >= 1, animations >= 2, meshes >= 1.
// If every source fails the script exits 1 WITHOUT writing any file — no
// fabricated fallback assets.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlb } from './glb-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'assets', 'character.glb');

const SOURCES = [
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb',
  'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Fox/glTF-Binary/Fox.glb',
];

function inspect(buf) {
  const { json } = parseGlb(buf); // throws on bad magic / version / length
  const skins = json.skins?.length ?? 0;
  const clips = (json.animations ?? []).map((a) => a.name ?? '(unnamed)');
  const meshes = json.meshes?.length ?? 0;
  return {
    skins,
    clips,
    meshes,
    ok: skins >= 1 && clips.length >= 2 && meshes >= 1,
  };
}

const url = process.argv[2]; // allow overriding the source for re-runs
const list = url ? [url] : SOURCES;

for (const src of list) {
  try {
    const res = await fetch(src, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100_000) throw new Error(`suspiciously small file (${buf.length} bytes)`);
    const info = inspect(buf);
    if (!info.ok) {
      throw new Error(
        `structural validation failed: skins=${info.skins} animations=${info.clips.length} meshes=${info.meshes}`
      );
    }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, buf);
    console.log(`[fetch-character] downloaded ${src}`);
    console.log(
      `[fetch-character] wrote ${OUT} bytes=${buf.length} skins=${info.skins} meshes=${info.meshes} animations=${info.clips.length}`
    );
    console.log(`[fetch-character] clips: ${info.clips.join(', ')}`);
    process.exit(0);
  } catch (err) {
    console.error(`[fetch-character] source failed: ${src} — ${err.message}`);
  }
}

console.error(
  '[fetch-character] ALL SOURCES FAILED — assets/character.glb was NOT written. ' +
    'Do not fabricate a replacement; report the failure instead.'
);
process.exit(1);
