import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pngPath = path.join(here, 'probe-shots', 'p1.png');

function decodePNG(buf) {
    let off = 8, w = 0, h = 0, colorType = 0, idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = colorType === 6 ? 4 : 3;
    const stride = w * bpp;
    const out = new Uint8Array(w * h * 4);
    let prevStart = -1;
    for (let y = 0; y < h; y++) {
        const f0 = y * (stride + 1);
        const filter = raw[f0];
        const line = raw.subarray(f0 + 1, f0 + 1 + stride);
        const cur = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0;
            const b = prevStart >= 0 ? raw[prevStart + 1 + i] : 0;
            const c = (prevStart >= 0 && i >= bpp) ? raw[prevStart + 1 + i - bpp] : 0;
            let val = line[i];
            if (filter === 1) val = (val + a) & 255;
            else if (filter === 2) val = (val + b) & 255;
            else if (filter === 3) val = (val + ((a + b) >> 1)) & 255;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                val = (val + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
            }
            cur[i] = val;
        }
        prevStart = f0;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, s = x * bpp;
            out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255;
        }
    }
    return { w, h, data: out };
}

const img = decodePNG(fs.readFileSync(pngPath));
const cx = img.w >> 1, cy = img.h >> 1;
const L = (x, y) => {
    const o = (y * img.w + x) * 4;
    return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
};
// ASCII 亮度图:x 每 8px,y 每 6px,范围 cx±100 / cy±70
const CH = ' .:-=+*#%@';
let out = '';
for (let y = cy - 70; y <= cy + 70; y += 6) {
    let row = '';
    for (let x = cx - 100; x <= cx + 100; x += 8) {
        const l = L(x, y);
        row += CH[Math.max(0, Math.min(9, (l / 25.6) | 0))];
    }
    out += row + '\n';
}
console.log('center map (cx=' + cx + ', cy=' + cy + '), chars= lum/25.6:');
console.log(out);
const line = [];
for (let x = cx; x < cx + 120; x += 4) line.push(((L(x, cy) / 25.6) | 0));
console.log('horizontal profile from center (step4):', line.join(''));
