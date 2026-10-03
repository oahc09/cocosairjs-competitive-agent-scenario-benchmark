// tools/gen-boat.mjs — zero-dependency generator for assets/boat.glb
// Low-poly sailboat (~2.4 m hull, Y-up, meters):
//   hull skin (11 stations, V-section, tapering bow) + transom, deck with two
//   benches, keel fin + rudder (extruded profiles), mast + boom + forestay +
//   backstay (tapered cylinders), double-sided main sail (roached leech,
//   bulged) and jib. Root node named "Boat". One material per part,
//   pbrMetallicRoughness with metallicFactor 0 / roughnessFactor 0.8.
// Target: 200-800 triangles, < 300 KB.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlbBuilder, MeshBuilder } from './glb-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'assets', 'boat.glb');

const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ hull
const N = 11; // stations, stern -> bow
const HALF_W = [0.34, 0.40, 0.42, 0.43, 0.42, 0.40, 0.36, 0.30, 0.21, 0.13, 0.0];
const Z_STERN = -1.2;
const Z_BOW = 1.2;
const sheer = (t) => 0.15 + 0.06 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.6);

function stationRing(i) {
  const t = i / (N - 1);
  const z = lerp(Z_STERN, Z_BOW, t);
  const w = HALF_W[i];
  const gy = sheer(t);
  const pts = [
    [-w, gy],
    [-0.8 * w, gy - 0.16],
    [-0.5 * w, gy - 0.33],
    [0, gy - 0.4],
    [0.5 * w, gy - 0.33],
    [0.8 * w, gy - 0.16],
    [w, gy],
  ];
  return pts.map(([x, y]) => [x, y, z]);
}
const rings = Array.from({ length: N }, (_, i) => stationRing(i));

const hull = new MeshBuilder();
for (let i = 0; i < N - 1; i++) {
  const zm = (rings[i][0][2] + rings[i + 1][0][2]) / 2;
  const ref = [0, -0.05, zm]; // inside the hull section
  for (let j = 0; j < 6; j++) {
    hull.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j], ref);
  }
}
hull.fan(rings[0], [0, -0.05, Z_STERN + 0.6]); // transom

// ------------------------------------------------------------- deck + benches
const deck = new MeshBuilder();
for (let i = 0; i < N - 1; i++) {
  const zm = (rings[i][0][2] + rings[i + 1][0][2]) / 2;
  deck.quad(rings[i][0], rings[i + 1][0], rings[i + 1][6], rings[i][6], [0, -0.3, zm]);
}
deck.box([0, 0.16, -0.55], 0.52, 0.04, 0.16);
deck.box([0, 0.16, -0.15], 0.58, 0.04, 0.16);

// --------------------------------------------------------- keel fin + rudder
const appendages = new MeshBuilder();
const keelProfile = [
  [0.55, -0.28],
  [0.55, -0.64],
  [0.18, -0.76],
  [-0.15, -0.66],
  [-0.15, -0.28],
];
appendages.extrudeProfileX(keelProfile, 0.025, [0, -0.5, 0.2]);
const rudderProfile = [
  [-1.06, -0.14],
  [-1.32, -0.14],
  [-1.32, -0.46],
  [-1.1, -0.4],
];
appendages.extrudeProfileX(rudderProfile, 0.02, [0, -0.3, -1.2]);

// ------------------------------------------------------------------- rigging
const rig = new MeshBuilder();
rig.cylinder([0, 0.1, 0.25], [0, 2.35, 0.25], 0.036, 0.028, 10, { cap1: true }); // mast
rig.cylinder([0, 0.46, 0.22], [0, 0.46, -1.0], 0.026, 0.026, 8, { cap0: true, cap1: true }); // boom
rig.cylinder([0, 2.3, 0.25], [0, 0.2, 1.18], 0.009, 0.006, 6, { cap0: true, cap1: true }); // forestay
rig.cylinder([0, 2.3, 0.25], [0, 0.2, -1.16], 0.009, 0.006, 6, { cap0: true, cap1: true }); // backstay

// ----------------------------------------------------------------- main sail
const main = new MeshBuilder();
const ROWS = 4;
const luff = [];
const leech = [];
for (let i = 0; i <= ROWS; i++) {
  const s = i / ROWS;
  const y = lerp(0.5, 2.25, s);
  luff.push([0.05, y, 0.25]);
  const z = lerp(0.25, -0.95, s) - 0.1 * Math.sin(Math.PI * s); // roached leech
  const bulge = 0.1 * Math.sin(Math.PI * s);
  leech.push([0.05 + bulge, y, z]);
}
for (let i = 0; i < ROWS; i++) {
  main.quad(luff[i], luff[i + 1], leech[i + 1], leech[i]); // double-sided material
}

// ----------------------------------------------------------------------- jib
const jib = new MeshBuilder();
const HEAD = [0.04, 2.0, 0.27];
const TACK = [0.03, 0.18, 1.16];
const CLEW = [0.04, 0.32, 0.3];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
for (let i = 0; i < ROWS; i++) {
  const s0 = i / ROWS;
  const s1 = (i + 1) / ROWS;
  const bulge = 0.08 * Math.sin(Math.PI * ((i + 0.5) / ROWS));
  const A0 = mix(HEAD, TACK, s0);
  const A1 = mix(HEAD, TACK, s1);
  const B0 = mix(HEAD, CLEW, s0);
  const B1 = mix(HEAD, CLEW, s1);
  const bump = (p) => [p[0] + bulge, p[1], p[2]];
  jib.quad(A0, A1, bump(B1), bump(B0)); // double-sided material
}

// -------------------------------------------------------------- assemble GLB
const glb = new GlbBuilder('tools/gen-boat.mjs');
const mHull = glb.addMaterial({ name: 'HullWood', baseColor: [0.45, 0.28, 0.16, 1], metallic: 0, roughness: 0.8 });
const mDeck = glb.addMaterial({ name: 'DeckWood', baseColor: [0.72, 0.55, 0.35, 1], metallic: 0, roughness: 0.8 });
const mTrim = glb.addMaterial({ name: 'TrimRed', baseColor: [0.48, 0.13, 0.11, 1], metallic: 0, roughness: 0.8 });
const mSpar = glb.addMaterial({ name: 'SparDark', baseColor: [0.16, 0.13, 0.1, 1], metallic: 0, roughness: 0.8 });
const mSail = glb.addMaterial({ name: 'SailCloth', baseColor: [0.94, 0.94, 0.9, 1], metallic: 0, roughness: 0.8, doubleSided: true });
const mJib = glb.addMaterial({ name: 'JibCloth', baseColor: [0.88, 0.9, 0.95, 1], metallic: 0, roughness: 0.8, doubleSided: true });

const nHull = glb.addNode('Hull', glb.addMesh('HullMesh', [glb.addPrimitive(hull.build(), mHull)]));
const nDeck = glb.addNode('Deck', glb.addMesh('DeckMesh', [glb.addPrimitive(deck.build(), mDeck)]));
const nKeel = glb.addNode('KeelAndRudder', glb.addMesh('KeelMesh', [glb.addPrimitive(appendages.build(), mTrim)]));
const nRig = glb.addNode('Rigging', glb.addMesh('RigMesh', [glb.addPrimitive(rig.build(), mSpar)]));
const nMain = glb.addNode('MainSail', glb.addMesh('MainSailMesh', [glb.addPrimitive(main.build(), mSail)]));
const nJib = glb.addNode('Jib', glb.addMesh('JibMesh', [glb.addPrimitive(jib.build(), mJib)]));
const boat = glb.addNode('Boat', null, [nHull, nDeck, nKeel, nRig, nMain, nJib]);
glb.addSceneRoot(boat);

mkdirSync(dirname(OUT), { recursive: true });
const out = glb.finalize();
writeFileSync(OUT, out);

const totalTris =
  hull.triangles + deck.triangles + appendages.triangles + rig.triangles + main.triangles + jib.triangles;
console.log(`[gen-boat] wrote ${OUT}`);
console.log(`[gen-boat] triangles=${totalTris} (hull=${hull.triangles} deck=${deck.triangles} keel/rudder=${appendages.triangles} rig=${rig.triangles} main=${main.triangles} jib=${jib.triangles})`);
console.log(`[gen-boat] bytes=${out.length} (${(out.length / 1024).toFixed(1)} KB)`);
if (totalTris < 200 || totalTris > 800) {
  console.error(`[gen-boat] FAIL: triangle budget is 200-800, got ${totalTris}`);
  process.exit(1);
}
if (out.length >= 300 * 1024) {
  console.error(`[gen-boat] FAIL: file must stay under 300 KB, got ${out.length}`);
  process.exit(1);
}
