// tools/gen-manifest.mjs — build assets/MANIFEST.json.
// Every entry: { path, bytes, sha256, generator, description }.
// Paths are relative to the bench root (same convention as briefs/E*/spec.json
// "assets" entries). sha256 via node:crypto, timestamps ISO-8601, 2-space JSON.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'assets', 'MANIFEST.json');

const ENTRIES = [
  {
    path: 'assets/boat.glb',
    generator: 'tools/gen-boat.mjs',
    description:
      'Low-poly sailboat (~2.4 m hull): station-lofted hull + transom, deck with benches, keel fin + rudder, mast/boom/stays, double-sided main sail + jib. Root node "Boat". Flat-shaded, pbrMetallicRoughness solid colors, metallic 0 / roughness 0.8.',
  },
  {
    path: 'assets/gem.glb',
    generator: 'tools/gen-gem.mjs',
    description:
      'Octagonal step-cut gem: table platform, two crown facet bands, girdle, pavilion and culet point. Node "Gem". Diamond-white baseColorFactor, metallic 0.1 / roughness 0.05 (neutral asset; engine side may upgrade the look).',
  },
  {
    path: 'assets/character.glb',
    generator: 'download:Fox',
    description:
      'Khronos glTF-Sample-Assets Fox (GLTF-Binary): skinned mesh (1 skin) with 3 animation clips — Survey / Walk / Run. Serves as the shared skeletal-animation character for both engines.',
  },
  {
    path: 'assets/textures/ramp-warm-cool.png',
    generator: 'tools/gen-textures.mjs',
    description: '256x256 8-bit RGB horizontal warm-to-cool color gradient ramp (no alpha).',
  },
  {
    path: 'assets/textures/starfield.png',
    generator: 'tools/gen-textures.mjs',
    description:
      '256x256 8-bit RGB black starfield with ~400 seeded deterministic stars of random brightness/tint.',
  },
  {
    path: 'assets/audio/chime.wav',
    generator: 'tools/gen-chime.mjs',
    description:
      '0.5 s, 44100 Hz, 16-bit mono PCM: 880 Hz sine with exponential decay and 4 ms attack.',
  },
];

const assets = ENTRIES.map((e) => {
  const buf = readFileSync(join(ROOT, e.path));
  return {
    path: e.path,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    generator: e.generator,
    description: e.description,
  };
});

const manifest = {
  generatedAt: new Date().toISOString(),
  generator: 'tools/gen-manifest.mjs',
  pathsRelativeTo: 'bench root',
  assets,
};

writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[gen-manifest] wrote ${OUT} entries=${assets.length}`);
for (const a of assets) {
  console.log(`[gen-manifest] ${a.path} bytes=${a.bytes} sha256=${a.sha256.slice(0, 16)}...`);
}
