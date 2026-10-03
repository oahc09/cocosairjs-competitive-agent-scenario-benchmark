// tools/gen-textures.mjs — zero-dependency PNG writers (node:zlib only).
//   assets/textures/ramp-warm-cool.png : 256x256 horizontal warm->cool gradient
//   assets/textures/starfield.png       : 256x256 black sky, ~400 seeded stars
// Hand-written PNG: signature + IHDR + IDAT(deflate, filter 0) + IEND, with a
// table-driven CRC32. 8-bit RGB (color type 2), no interlace.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEXTURE_DIR = join(ROOT, 'assets', 'textures');

// ------------------------------------------------------------------- PNG core
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePNG(file, width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log(`[gen-textures] wrote ${file} ${width}x${height} bytes=${png.length}`);
}

// Deterministic PRNG (mulberry32) so starfield.png is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 256;
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// ------------------------------------------------- ramp-warm-cool.png
const WARM = [255, 138, 42];
const COOL = [42, 138, 255];
writePNG(join(TEXTURE_DIR, 'ramp-warm-cool.png'), SIZE, SIZE, (x, y) => {
  const t = x / (SIZE - 1);
  return [
    clamp255(WARM[0] + (COOL[0] - WARM[0]) * t),
    clamp255(WARM[1] + (COOL[1] - WARM[1]) * t),
    clamp255(WARM[2] + (COOL[2] - WARM[2]) * t),
  ];
});

// ------------------------------------------------------- starfield.png
const rand = mulberry32(0x20261002);
const stars = new Uint8Array(SIZE * SIZE * 3);
const BG = [4, 5, 10];
for (let i = 0; i < SIZE * SIZE; i++) {
  stars[i * 3] = BG[0];
  stars[i * 3 + 1] = BG[1];
  stars[i * 3 + 2] = BG[2];
}
const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const o = (y * SIZE + x) * 3;
  stars[o] = clamp255(r);
  stars[o + 1] = clamp255(g);
  stars[o + 2] = clamp255(b);
};
const STAR_COUNT = 400;
for (let s = 0; s < STAR_COUNT; s++) {
  const x = Math.floor(rand() * SIZE);
  const y = Math.floor(rand() * SIZE);
  const b = 50 + 205 * Math.pow(rand(), 1.6); // random brightness, biased dim
  const kind = rand();
  let r, g, bl;
  if (kind < 0.6) {
    r = b; g = b; bl = Math.min(255, b * 1.03); // white
  } else if (kind < 0.85) {
    r = b * 0.85; g = b * 0.92; bl = Math.min(255, b * 1.1); // cool blue
  } else {
    r = Math.min(255, b * 1.12); g = b * 0.95; bl = b * 0.78; // warm
  }
  put(x, y, r, g, bl);
  if (rand() > 0.85) {
    // brighter star: add a faint plus-shaped glow
    put(x + 1, y, r * 0.55, g * 0.55, bl * 0.55);
    put(x - 1, y, r * 0.55, g * 0.55, bl * 0.55);
    put(x, y + 1, r * 0.55, g * 0.55, bl * 0.55);
    put(x, y - 1, r * 0.55, g * 0.55, bl * 0.55);
  }
}
writePNG(join(TEXTURE_DIR, 'starfield.png'), SIZE, SIZE, (x, y) => {
  const o = (y * SIZE + x) * 3;
  return [stars[o], stars[o + 1], stars[o + 2]];
});
