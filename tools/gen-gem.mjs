// tools/gen-gem.mjs — zero-dependency generator for assets/gem.glb
// Octagonal step/brilliant-cut gem: 8-sided table (platform), two crown steps
// (antiprism bands for kite facets), girdle band, pavilion step and culet
// point. Flat per-facet normals. Node named "Gem".
// Material stays neutral: baseColorFactor diamond white, metallicFactor 0.1,
// roughnessFactor 0.05 (high polish look is up to engine-side material
// upgrades; the asset itself is plain opaque PBR).
// Target: 60-200 triangles, < 300 KB.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlbBuilder, MeshBuilder } from './glb-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'assets', 'gem.glb');

const SEG = 8; // octagonal cut
const CENTER = [0, 0.05, 0]; // inward reference for facet orientation

function ring(radius, y, rotSteps = 0) {
  const pts = [];
  for (let i = 0; i < SEG; i++) {
    const th = ((i + rotSteps) / SEG) * Math.PI * 2;
    pts.push([Math.cos(th) * radius, y, Math.sin(th) * radius]);
  }
  return pts;
}

const gem = new MeshBuilder();
const table = ring(0.32, 0.34);
const crownMid = ring(0.44, 0.18, 0.5); // rotated half a step
const girdleTop = ring(0.52, 0.02);
const girdleBot = ring(0.52, -0.02);
const pavilionRing = ring(0.24, -0.36, 0.5);
const CULET = [0, -0.64, 0];

gem.fan(table, [0, -0.5, 0]); // table platform, normal up
gem.antiPrism(table, crownMid, CENTER); // upper crown facets
gem.antiPrism(crownMid, girdleTop, CENTER); // lower crown facets
for (let i = 0; i < SEG; i++) {
  const j = (i + 1) % SEG;
  gem.quad(girdleTop[i], girdleTop[j], girdleBot[j], girdleBot[i], CENTER); // girdle band
}
gem.antiPrism(girdleBot, pavilionRing, CENTER); // pavilion step
for (let i = 0; i < SEG; i++) {
  const j = (i + 1) % SEG;
  gem.tri(pavilionRing[i], pavilionRing[j], CULET, CENTER); // pavilion tip to culet
}

const glb = new GlbBuilder('tools/gen-gem.mjs');
const mat = glb.addMaterial({
  name: 'GemFacets',
  baseColor: [0.92, 0.95, 1.0, 1],
  metallic: 0.1,
  roughness: 0.05,
});
const node = glb.addNode('Gem', glb.addMesh('GemMesh', [glb.addPrimitive(gem.build(), mat)]));
glb.addSceneRoot(node);

mkdirSync(dirname(OUT), { recursive: true });
const out = glb.finalize();
writeFileSync(OUT, out);

console.log(`[gen-gem] wrote ${OUT}`);
console.log(`[gen-gem] triangles=${gem.triangles} bytes=${out.length} (${(out.length / 1024).toFixed(1)} KB)`);
if (gem.triangles < 60 || gem.triangles > 200) {
  console.error(`[gen-gem] FAIL: triangle budget is 60-200, got ${gem.triangles}`);
  process.exit(1);
}
if (out.length >= 300 * 1024) {
  console.error(`[gen-gem] FAIL: file must stay under 300 KB, got ${out.length}`);
  process.exit(1);
}
