// glb-lib.mjs — zero-dependency GLB (glTF 2.0 binary) authoring + parsing helpers.
// Conventions: Y-up, meters, right-handed coordinate system, CCW front faces.
// Intended for low-poly assets with vertex normals and per-part solid-color
// pbrMetallicRoughness materials (no textures, no external dependencies).
//
// Shared by tools/gen-boat.mjs and tools/gen-gem.mjs; the parser is also used
// by tools/fetch-character.mjs and tools/validate-assets.mjs.

export const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

// ---------------------------------------------------------------- vec helpers
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const lerp3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

// ---------------------------------------------------------------- MeshBuilder
// Accumulates flat-shaded triangles (per-face normals). Every helper that
// accepts `inwardRef` automatically flips winding so the face normal points
// AWAY from that reference point — this keeps normals sane regardless of the
// order the caller lists vertices in.
export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.triangles = 0;
  }

  tri(a, b, c, inwardRef = null) {
    let n = normalize(cross(sub(b, a), sub(c, a)));
    if (inwardRef) {
      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      if (dot(n, sub(centroid, inwardRef)) < 0) {
        const t = b; b = c; c = t;
        n = [-n[0], -n[1], -n[2]];
      }
    }
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
    }
    this.triangles++;
  }

  quad(a, b, c, d, inwardRef = null) {
    this.tri(a, b, c, inwardRef);
    this.tri(a, c, d, inwardRef);
  }

  // Fan-triangulate a closed polygon from its first vertex.
  fan(pts, inwardRef = null) {
    const p0 = pts[0];
    for (let i = 1; i < pts.length - 1; i++) this.tri(p0, pts[i], pts[i + 1], inwardRef);
  }

  // Tapered cylinder along p0->p1 with optional end caps.
  cylinder(p0, p1, r0, r1, segments, { cap0 = false, cap1 = false } = {}) {
    const axis = normalize(sub(p1, p0));
    const helper = Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
    const s1 = normalize(cross(axis, helper));
    const s2 = cross(axis, s1);
    const ring = (p, r) => {
      const pts = [];
      for (let i = 0; i < segments; i++) {
        const th = (i / segments) * Math.PI * 2;
        pts.push(addv(p, addv(scale(s1, Math.cos(th) * r), scale(s2, Math.sin(th) * r))));
      }
      return pts;
    };
    const mid = lerp3(p0, p1, 0.5);
    const rA = ring(p0, r0);
    const rB = ring(p1, r1);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(rA[i], rA[j], rB[j], rB[i], mid);
    }
    if (cap0) this.fan(rA, p1); // ref beyond the far end => normal along -axis
    if (cap1) this.fan(rB, p0); // ref beyond the far end => normal along +axis
  }

  // Axis-aligned box centered at c with full sizes sx/sy/sz.
  box(c, sx, sy, sz) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const v = (x, y, z) => [c[0] + x * hx, c[1] + y * hy, c[2] + z * hz];
    this.quad(v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1), c); // top
    this.quad(v(-1, -1, 1), v(1, -1, 1), v(1, -1, -1), v(-1, -1, -1), c); // bottom
    this.quad(v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), c); // -x
    this.quad(v(1, 1, 1), v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), c); // +x
    this.quad(v(-1, 1, 1), v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), c); // +z
    this.quad(v(1, 1, -1), v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), c); // -z
  }

  // Extrude a closed 2D profile of [z, y] points along the X axis by +-xHalf.
  extrudeProfileX(profile, xHalf, ref) {
    const pSide = profile.map(([z, y]) => [xHalf, y, z]);
    const nSide = profile.map(([z, y]) => [-xHalf, y, z]);
    this.fan(pSide, [ref[0] - xHalf - 1, ref[1], ref[2]]);
    this.fan(nSide, [ref[0] + xHalf + 1, ref[1], ref[2]]);
    for (let i = 0; i < profile.length; i++) {
      const j = (i + 1) % profile.length;
      this.quad(pSide[i], nSide[i], nSide[j], pSide[j], ref);
    }
  }

  // Antiprism band between two rings (ringB typically rotated half a step).
  antiPrism(ringA, ringB, inwardRef) {
    for (let i = 0; i < ringA.length; i++) {
      const j = (i + 1) % ringA.length;
      this.tri(ringA[i], ringA[j], ringB[j], inwardRef);
      this.tri(ringA[i], ringB[j], ringB[i], inwardRef);
    }
  }

  build() {
    const count = this.positions.length / 3;
    const indices = new Uint16Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices,
    };
  }
}

// ---------------------------------------------------------------- GlbBuilder
export class GlbBuilder {
  constructor(generator) {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ name: 'Scene', nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      bufferViews: [],
      accessors: [],
      buffers: [],
    };
    this.binParts = [];
    this.binLength = 0;
  }

  #pad4() {
    const p = (4 - (this.binLength % 4)) % 4;
    if (p) {
      this.binParts.push(Buffer.alloc(p));
      this.binLength += p;
    }
  }

  #addView(buf, target) {
    this.#pad4();
    const byteOffset = this.binLength;
    this.binParts.push(buf);
    this.binLength += buf.length;
    const idx = this.json.bufferViews.length;
    this.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    return idx;
  }

  addMaterial({ name, baseColor = [1, 1, 1, 1], metallic = 0, roughness = 1, doubleSided = false }) {
    this.json.materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: baseColor,
        metallicFactor: metallic,
        roughnessFactor: roughness,
      },
      doubleSided,
    });
    return this.json.materials.length - 1;
  }

  addPrimitive(prim, materialIndex) {
    const taBuf = (ta) =>
      Buffer.from(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength));
    const viewPos = this.#addView(taBuf(prim.positions), 34962); // ARRAY_BUFFER
    const viewNrm = this.#addView(taBuf(prim.normals), 34962);
    const viewIdx = this.#addView(taBuf(prim.indices), 34963); // ELEMENT_ARRAY_BUFFER
    const count = prim.positions.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = prim.positions[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const accPos = this.json.accessors.length;
    this.json.accessors.push({
      bufferView: viewPos, componentType: 5126, count, type: 'VEC3', min, max,
    });
    const accNrm = this.json.accessors.length;
    this.json.accessors.push({
      bufferView: viewNrm, componentType: 5126, count, type: 'VEC3',
    });
    const accIdx = this.json.accessors.length;
    this.json.accessors.push({
      bufferView: viewIdx, componentType: 5123, count: prim.indices.length, type: 'SCALAR',
    });
    return {
      attributes: { POSITION: accPos, NORMAL: accNrm },
      indices: accIdx,
      material: materialIndex,
      mode: 4,
    };
  }

  addMesh(name, primitives) {
    this.json.meshes.push({ name, primitives });
    return this.json.meshes.length - 1;
  }

  addNode(name, meshIndex = null, children = null) {
    const node = { name };
    if (meshIndex !== null) node.mesh = meshIndex;
    if (children !== null) node.children = children;
    this.json.nodes.push(node);
    return this.json.nodes.length - 1;
  }

  addSceneRoot(nodeIndex) {
    this.json.scenes[0].nodes.push(nodeIndex);
  }

  finalize() {
    this.#pad4();
    this.json.buffers = [{ byteLength: this.binLength }];
    let jsonBuf = Buffer.from(JSON.stringify(this.json), 'utf8');
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
    const binBuf = Buffer.concat(this.binParts);
    const hasBin = binBuf.length > 0;
    const total = 12 + 8 + jsonBuf.length + (hasBin ? 8 + binBuf.length : 0);
    const out = Buffer.alloc(total);
    out.writeUInt32LE(GLB_MAGIC, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(total, 8);
    out.writeUInt32LE(jsonBuf.length, 12);
    out.writeUInt32LE(CHUNK_JSON, 16);
    jsonBuf.copy(out, 20);
    let off = 20 + jsonBuf.length;
    if (hasBin) {
      out.writeUInt32LE(binBuf.length, off);
      out.writeUInt32LE(CHUNK_BIN, off + 4);
      binBuf.copy(out, off + 8);
    }
    return out;
  }
}

// ---------------------------------------------------------------- GLB parsing
export function parseGlb(buf) {
  if (buf.length < 20) throw new Error('GLB too small');
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const length = buf.readUInt32LE(8);
  if (magic !== GLB_MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  if (version !== 2) throw new Error(`unsupported glTF version ${version}`);
  if (length !== buf.length) throw new Error(`length mismatch header=${length} file=${buf.length}`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const clen = buf.readUInt32LE(off);
    const ctype = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (ctype === CHUNK_BIN) bin = data;
    off += 8 + clen;
  }
  if (!json) throw new Error('missing JSON chunk');
  return { json, bin };
}

export function countTriangles(json) {
  let t = 0;
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      if (p.indices !== undefined) t += Math.floor((json.accessors[p.indices].count ?? 0) / 3);
      else if (p.attributes?.POSITION !== undefined)
        t += Math.floor((json.accessors[p.attributes.POSITION].count ?? 0) / 3);
    }
  }
  return t;
}

export function nodeNames(json) {
  return (json.nodes ?? []).map((n) => n.name ?? '');
}
