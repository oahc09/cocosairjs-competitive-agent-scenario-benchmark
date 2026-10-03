// tools/validate-assets.mjs — structural validation of the shared asset pack.
// Checks (each PASS/FAIL, written to assets/VALIDATION.txt):
//   - GLB structure: boat/gem have meshes + materials + named node + triangle
//     budget + POSITION accessor min/max + primitive materials + < 300 KB;
//     character (Fox) has skins >= 1, animations >= 2, meshes >= 1.
//   - PNG: signature, IHDR dimensions 256x256, 8-bit RGB, IDAT present,
//     chunk walk terminates exactly at IEND.
//   - WAV: RIFF/WAVE, PCM mono 44100 Hz 16-bit, 0.5 s data chunk.
//   - MANIFEST.json: sha256 + byte size of every listed asset match on disk.
// Exit code 0 only when every check passes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTriangles, nodeNames, parseGlb } from './glb-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const A = (p) => join(ROOT, p);
const OUT = A('assets/VALIDATION.txt');

let failed = 0;
const rows = [];
function check(id, pass, detail = '') {
  if (!pass) failed++;
  rows.push(`${pass ? '[PASS]' : '[FAIL]'} ${id}${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------------- GLB
function checkGeneratedGlb(rel, { nodeName, triRange }) {
  let buf;
  try {
    buf = readFileSync(A(rel));
  } catch (e) {
    check(`${rel}: file exists`, false, e.message);
    return;
  }
  let json;
  try {
    ({ json } = parseGlb(buf));
    check(`${rel}: GLB magic 0x46546C67 + glTF 2.0 + length header`, json.asset?.version === '2.0');
  } catch (e) {
    check(`${rel}: GLB parse`, false, e.message);
    return;
  }
  const meshes = json.meshes?.length ?? 0;
  const materials = json.materials?.length ?? 0;
  check(`${rel}: meshes >= 1`, meshes >= 1, `meshes=${meshes}`);
  check(`${rel}: materials >= 1`, materials >= 1, `materials=${materials}`);
  const names = nodeNames(json);
  check(`${rel}: named node "${nodeName}"`, names.includes(nodeName), `nodes=[${names.join(', ')}]`);

  const tris = countTriangles(json);
  check(
    `${rel}: triangle budget [${triRange[0]}, ${triRange[1]}]`,
    tris >= triRange[0] && tris <= triRange[1],
    `triangles=${tris}`
  );
  check(`${rel}: size < 300 KB`, buf.length < 300 * 1024, `${(buf.length / 1024).toFixed(1)} KB`);

  let posOk = true;
  let posCount = 0;
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      const acc = json.accessors[p.attributes?.POSITION];
      posCount++;
      if (!acc || !Array.isArray(acc.min) || acc.min.length !== 3 || !Array.isArray(acc.max) || acc.max.length !== 3) {
        posOk = false;
      }
      if (p.material === undefined || p.material === null) posOk = false;
    }
  }
  check(`${rel}: POSITION accessors have min/max + primitives have material`, posOk, `${posCount} primitives`);
}

checkGeneratedGlb('assets/boat.glb', { nodeName: 'Boat', triRange: [200, 800] });
checkGeneratedGlb('assets/gem.glb', { nodeName: 'Gem', triRange: [60, 200] });

// ------------------------------------------------------------- character.glb
{
  const rel = 'assets/character.glb';
  try {
    const buf = readFileSync(A(rel));
    const { json } = parseGlb(buf);
    check(`${rel}: GLB magic 0x46546C67 + glTF 2.0`, json.asset?.version === '2.0');
    const skins = json.skins?.length ?? 0;
    const anims = json.animations ?? [];
    const meshes = json.meshes?.length ?? 0;
    check(`${rel}: skins >= 1`, skins >= 1, `skins=${skins}`);
    check(`${rel}: animations >= 2`, anims.length >= 2, `animations=${anims.length}`);
    check(`${rel}: meshes >= 1`, meshes >= 1, `meshes=${meshes}`);
    check(
      `${rel}: animation clips recorded`,
      anims.length > 0,
      `clips=[${anims.map((a) => a.name ?? '(unnamed)').join(', ')}]`
    );
  } catch (e) {
    check(`${rel}: parse`, false, e.message);
  }
}

// ------------------------------------------------------------------- PNG
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function checkPng(rel, w, h) {
  let buf;
  try {
    buf = readFileSync(A(rel));
  } catch (e) {
    check(`${rel}: file exists`, false, e.message);
    return;
  }
  check(`${rel}: PNG signature`, buf.subarray(0, 8).equals(PNG_SIG));
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.toString('ascii', 12, 16);
  check(`${rel}: IHDR first chunk`, ihdrLen === 13 && ihdrType === 'IHDR');
  const pw = buf.readUInt32BE(16);
  const ph = buf.readUInt32BE(20);
  check(`${rel}: dimensions ${w}x${h}`, pw === w && ph === h, `got ${pw}x${ph}`);
  check(
    `${rel}: 8-bit RGB, no interlace`,
    buf[24] === 8 && buf[25] === 2 && buf[26] === 0 && buf[27] === 0 && buf[28] === 0,
    `bitDepth=${buf[24]} colorType=${buf[25]} interlace=${buf[28]}`
  );
  let off = 8;
  let lastType = '';
  let idatBytes = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    lastType = buf.toString('ascii', off + 4, off + 8);
    if (lastType === 'IDAT') idatBytes += len;
    off += 12 + len;
  }
  check(`${rel}: chunk walk ends exactly at IEND`, lastType === 'IEND' && off === buf.length);
  check(`${rel}: IDAT non-empty`, idatBytes > 0, `idatBytes=${idatBytes}`);
}
checkPng('assets/textures/ramp-warm-cool.png', 256, 256);
checkPng('assets/textures/starfield.png', 256, 256);

// ------------------------------------------------------------------- WAV
{
  const rel = 'assets/audio/chime.wav';
  try {
    const buf = readFileSync(A(rel));
    check(
      `${rel}: RIFF/WAVE container`,
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
    );
    let off = 12;
    let fmt = null;
    let dataLen = -1;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ')
        fmt = {
          audioFormat: buf.readUInt16LE(off + 8),
          channels: buf.readUInt16LE(off + 10),
          sampleRate: buf.readUInt32LE(off + 12),
          bitsPerSample: buf.readUInt16LE(off + 22),
        };
      if (id === 'data') dataLen = len;
      off += 8 + len + (len % 2);
    }
    check(
      `${rel}: PCM mono 44100 Hz 16-bit`,
      fmt?.audioFormat === 1 && fmt?.channels === 1 && fmt?.sampleRate === 44100 && fmt?.bitsPerSample === 16,
      fmt ? `format=${fmt.audioFormat} ch=${fmt.channels} sr=${fmt.sampleRate} bits=${fmt.bitsPerSample}` : 'no fmt chunk'
    );
    check(`${rel}: 0.5 s of samples`, dataLen === 22050 * 2, `dataBytes=${dataLen}`);
  } catch (e) {
    check(`${rel}: read`, false, e.message);
  }
}

// --------------------------------------------------------------- MANIFEST
const REQUIRED = [
  'assets/boat.glb',
  'assets/gem.glb',
  'assets/character.glb',
  'assets/textures/ramp-warm-cool.png',
  'assets/textures/starfield.png',
  'assets/audio/chime.wav',
];
try {
  const man = JSON.parse(readFileSync(A('assets/MANIFEST.json'), 'utf8'));
  check('MANIFEST.json: parses', true);
  const paths = (man.assets ?? []).map((a) => a.path);
  check(
    'MANIFEST.json: covers all required assets',
    REQUIRED.every((p) => paths.includes(p)),
    `entries=${paths.length}`
  );
  for (const entry of man.assets ?? []) {
    const ok = existsSync(A(entry.path));
    check(`${entry.path}: exists (per manifest)`, ok);
    if (!ok) continue;
    const buf = readFileSync(A(entry.path));
    check(
      `${entry.path}: bytes match manifest`,
      buf.length === entry.bytes,
      `disk=${buf.length} manifest=${entry.bytes}`
    );
    const sha = createHash('sha256').update(buf).digest('hex');
    check(`${entry.path}: sha256 matches manifest`, sha === entry.sha256, sha.slice(0, 16) + '...');
  }
} catch (e) {
  check('MANIFEST.json: read/parse', false, e.message);
}

// ------------------------------------------------------------------ report
const total = rows.length;
const summary = [`TOTAL: ${total} checks, ${total - failed} PASS, ${failed} FAIL`, `RESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`];
const text = [
  `ASSETS VALIDATION — ${new Date().toISOString()}`,
  'Target engines: Three.js r186 GLTFLoader + Cocos AIR built-in glTF',
  '',
  ...rows,
  '',
  ...summary,
].join('\n');
writeFileSync(OUT, text + '\n', 'utf8');
console.log(text);
console.log(`\nwritten: ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
