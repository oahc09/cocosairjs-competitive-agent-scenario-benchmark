// 临时工具:解码 PNG(screenshot)→ 裁剪放大区域 → 重新编码 PNG 输出(用于像素级排查)
// 用法: node scripts/png-crop.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
    let off = 8;
    let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9]; interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error('unsupported png: depth=' + bitDepth + ' color=' + colorType);
    }
    const channels = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * channels;
    const out = Buffer.alloc(w * h * channels);
    // unfilter
    let p = 0;
    for (let y = 0; y < h; y++) {
        const filter = raw[p++];
        const row = y * stride;
        for (let x = 0; x < stride; x++) {
            const cur = raw[p++];
            const left = x >= channels ? out[row + x - channels] : 0;
            const up = y > 0 ? out[row - stride + x] : 0;
            const ul = (y > 0 && x >= channels) ? out[row - stride + x - channels] : 0;
            let v;
            switch (filter) {
                case 0: v = cur; break;
                case 1: v = cur + left; break;
                case 2: v = cur + up; break;
                case 3: v = cur + ((left + up) >> 1); break;
                case 4: {
                    const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
                    const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul);
                    v = cur + pred; break;
                }
                default: throw new Error('filter ' + filter);
            }
            out[row + x] = v & 0xff;
        }
    }
    return { w, h, channels, data: out };
}

function encodePNG(w, h, channels, data) {
    const stride = w * channels;
    const raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(raw, { level: 6 });
    const chunks = [];
    const chunk = (type, data2) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data2.length);
        const t = Buffer.from(type, 'ascii');
        const crcBuf = Buffer.concat([t, data2]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(crcBuf) >>> 0);
        chunks.push(len, t, data2, crc);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    chunk('IHDR', ihdr);
    chunk('IDAT', idat);
    chunk('IEND', Buffer.alloc(0));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

let crcTable = null;
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

const [inP, outP, xs, ys, ws, hs, ss] = process.argv.slice(2);
const img = decodePNG(fs.readFileSync(inP));
if (outP === '--stats') {
    // 亮度统计:lit = 亮度 > 40/255(P1/P6 视觉断言口径;Rec.709 感知亮度)
    let lit = 0;
    const total = img.w * img.h;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l > 40) lit++;
    }
    console.log(JSON.stringify({ w: img.w, h: img.h, litRatioFull: +(lit / total).toFixed(4), litPixels: lit, threshold: 'lum>40/255' }));
    process.exit(0);
}
const x0 = Math.max(0, parseInt(xs)), y0 = Math.max(0, parseInt(ys));
const cw = Math.min(img.w - x0, parseInt(ws)), chh = Math.min(img.h - y0, parseInt(hs));
const scale = ss ? parseInt(ss) : 1;
const outW = cw * scale, outH = chh * scale;
const out = Buffer.alloc(outW * outH * img.channels);
for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
        const sx = x0 + Math.floor(x / scale), sy = y0 + Math.floor(y / scale);
        for (let c = 0; c < img.channels; c++) {
            out[(y * outW + x) * img.channels + c] = img.data[(sy * img.w + sx) * img.channels + c];
        }
    }
}
fs.writeFileSync(outP, encodePNG(outW, outH, img.channels, out));
console.log(`cropped ${cw}x${chh}@(${x0},${y0}) scale ${scale} -> ${outP}`);
