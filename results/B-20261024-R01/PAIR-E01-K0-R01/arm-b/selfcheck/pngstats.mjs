// Self-check helper (agent-owned, not part of the deliverable): decode a PNG screenshot
// and report lit-pixel ratios / image diff ratios used by the E01 visual assertions.
import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
    const buf = fs.readFileSync(file);
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth);
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (!channels) throw new Error('color type ' + colorType);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(width * height * channels);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = Buffer.from(line);
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev[x];
            const c = x >= channels ? prev[x - channels] : 0;
            let v = cur[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            cur[x] = v & 0xff;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { width, height, channels, data: out };
}

function stats(img, x0, y0, x1, y1, thr) {
    let lit = 0;
    let total = 0;
    let sum = 0;
    for (let y = Math.floor(y0); y < Math.floor(y1); y++) {
        for (let x = Math.floor(x0); x < Math.floor(x1); x++) {
            const i = (y * img.width + x) * img.channels;
            const l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
            if (l > thr) lit++;
            sum += l;
            total++;
        }
    }
    return { litRatio: lit / total, meanLum: sum / total, total };
}

function diff(a, b, thr) {
    let changed = 0;
    const n = a.width * a.height;
    for (let p = 0; p < n; p++) {
        const i = p * a.channels;
        const j = p * b.channels;
        const d = Math.max(
            Math.abs(a.data[i] - b.data[j]),
            Math.abs(a.data[i + 1] - b.data[j + 1]),
            Math.abs(a.data[i + 2] - b.data[j + 2]),
        );
        if (d > thr) changed++;
    }
    return changed / n;
}

const [fileA, fileB, thrArg] = process.argv.slice(2);
const thr = Number(thrArg || 40);
const a = decode(fileA);
const out = {
    file: fileA,
    size: [a.width, a.height],
    full: stats(a, 0, 0, a.width, a.height, thr),
    center80: stats(a, a.width * 0.1, a.height * 0.1, a.width * 0.9, a.height * 0.9, thr),
    hud: stats(a, 18, 540, 250, 706, thr),
};
if (fileB) {
    const b = decode(fileB);
    out.diffVs = fileB;
    out.diffRatio = diff(a, b, 12);
}
console.log(JSON.stringify(out, null, 2));
