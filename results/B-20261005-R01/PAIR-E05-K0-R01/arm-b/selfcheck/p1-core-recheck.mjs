/**
 * p1-core-recheck.mjs(v2)— 对已保存的 probe-shots/p1.png 以鲁棒统计复核"中心存在连续暗核区域"。
 * 背景:±20px 盒均值会被恰好从核心前景穿过的星流粒子(物理正确)抬高,单像素采样同样脆弱。
 * 鲁棒指标:
 *   A. 从中心向 ±x / ±y 的连续暗程(lum<40 的最大连续像素数)
 *   B. ±20px 盒内亮度中位数(对少量粒子像素鲁棒)
 *   C. 暗核外亮环:椭圆环带(水平 70–80px × 垂直 0.55)平均亮度
 * 纯图像分析,不创建浏览器会话。
 */
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
    x = Math.max(0, Math.min(img.w - 1, x | 0));
    y = Math.max(0, Math.min(img.h - 1, y | 0));
    const o = (y * img.w + x) * 4;
    return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
};

function darkRun(dx, dy) {
    let run = 0, best = 0;
    for (let s = 0; s <= 120; s++) {
        if (L(cx + dx * s, cy + dy * s) < 40) { run++; best = Math.max(best, run); }
        else run = 0;
    }
    return best;
}

const boxVals = [];
for (let y = cy - 20; y <= cy + 20; y++) for (let x = cx - 20; x <= cx + 20; x++) boxVals.push(L(x, y));
boxVals.sort((a, b) => a - b);
const medianCore = boxVals[boxVals.length >> 1];
const p10Core = boxVals[(boxVals.length * 0.1) | 0];

let ring = 0, rn = 0;
for (let a = 0; a < 360; a += 2) {
    const t = (a * Math.PI) / 180;
    ring += L(cx + 75 * Math.cos(t), cy + 75 * Math.sin(t) * 0.55); rn++;
}
ring /= rn;

const verdict = {
    at: new Date().toISOString(),
    darkRunRight: darkRun(1, 0),
    darkRunLeft: darkRun(-1, 0),
    darkRunUp: darkRun(0, -1),
    darkRunDown: darkRun(0, 1),
    medianCoreBox20: medianCore,
    p10CoreBox20: p10Core,
    ringLum75: ring,
    pass: darkRun(1, 0) >= 40 && darkRun(-1, 0) >= 40 && medianCore < 40 && ring > 90,
};
fs.writeFileSync(path.join(here, 'p1-core-recheck.json'), JSON.stringify(verdict, null, 2));
console.log('[p1-recheck-v2] ' + JSON.stringify(verdict));
process.exit(verdict.pass ? 0 : 1);
