// 本地 PNG 像素分析(仅 Node 内置 zlib,无网络/无依赖):
// 输出:尺寸、非黑亮像素占比(>18 亮度,近似 harness lit 口径)、区域亮度网格、ASCII 亮度图
// 用法: node analyze-shot.mjs <png> [asciiCols]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const cols = Number(process.argv[3] || 96);
const buf = fs.readFileSync(file);

// ---- 最小 PNG 解析(IHDR/IDAT/IEND,8bit RGB/RGBA,filter 0-4) ----
let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
const idat = [];
while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
        w = data.readUInt32BE(0); h = data.readUInt32BE(4);
        bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
    if (type === 'IEND') break;
}
if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    console.error(`unsupported PNG: ${w}x${h} depth=${bitDepth} colorType=${colorType}`);
    process.exit(1);
}
const bpp = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = w * bpp;
const px = Buffer.alloc(w * h * 3);
let prev = Buffer.alloc(stride);
for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) v = (v + a) & 0xff;
        else if (filter === 2) v = (v + b) & 0xff;
        else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
        cur[i] = v;
    }
    for (let x = 0; x < w; x++) {
        const s = x * bpp, d = (y * w + x) * 3;
        px[d] = cur[s]; px[d + 1] = cur[s + 1]; px[d + 2] = cur[s + 2];
    }
    prev = cur;
}

// ---- 统计 ----
const lum = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
let lit = 0, lit10 = 0, sum = 0;
for (let i = 0; i < w * h; i++) {
    const L = lum(i * 3);
    sum += L;
    if (L > 18) lit++;
    if (L > 10) lit10++;
}
const rows = Math.max(8, Math.round((cols * h) / w / 2)); // 字符高约为宽一半
const ramp = ' .:-=+*#%@';
console.log(JSON.stringify({
    file, size: [w, h],
    avgLum: +(sum / (w * h)).toFixed(1),
    litRatio18: +(lit / (w * h)).toFixed(4),
    litRatio10: +(lit10 / (w * h)).toFixed(4),
    ascii: `${cols}x${rows}`,
}));
for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
        let mx = 0;
        const x0 = Math.floor((c * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / cols));
        const y0 = Math.floor((r * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / rows));
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) mx = Math.max(mx, lum((y * w + x) * 3));
        line += ramp[Math.min(ramp.length - 1, Math.round((mx / 255) * (ramp.length - 1)))];
    }
    console.log(line);
}
