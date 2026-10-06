// probe2: extract the builtin-unlit entry (contains colorScaleAndCutoff) from glsl4 region
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');
const gs = s.indexOf('const glsl4');
const region = s.slice(gs, gs + 420000);
function scanStr(text, from) {
    let q = from;
    for (;;) {
        q = text.indexOf('"', q + 1);
        let bs = 0, r = q - 1;
        while (text[r] === '\\') { bs++; r--; }
        if (bs % 2 === 0) return q;
    }
}
function extractEntry(from) {
    // from = index of '{   "vert": "'
    const vKey = text_region.indexOf('"vert"', from);
    return vKey; // placeholder
}
const text_region = region;
// collect all entry starts
const starts = [];
let p = 0;
for (;;) {
    const i = region.indexOf('{   "vert": "', p);
    if (i === -1) break;
    starts.push(i);
    p = i + 5;
}
console.log('entry starts count:', starts.length);
const ci = region.indexOf('colorScaleAndCutoff');
// find which entry contains it
let target = -1;
for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : region.length;
    if (ci >= starts[k] && ci < end) { target = k; break; }
}
console.log('unlit entry index:', target);
function getEntry(start) {
    const vKey = region.indexOf('"vert"', start);
    const vOpen = region.indexOf('"', region.indexOf(':', vKey) + 1) + 1;
    const vClose = scanStr(region, vOpen);
    const vertSrc = JSON.parse('"' + region.slice(vOpen, vClose) + '"');
    const fKey = region.indexOf('"frag"', vClose);
    const fOpen = region.indexOf('"', region.indexOf(':', fKey) + 1) + 1;
    const fClose = scanStr(region, fOpen);
    const fragSrc = JSON.parse('"' + region.slice(fOpen, fClose) + '"');
    return { vert: vertSrc, frag: fragSrc };
}
const unlit = getEntry(starts[target]);
fs.writeFileSync('.probe/unlit-vert.glsl', unlit.vert);
fs.writeFileSync('.probe/unlit-frag.glsl', unlit.frag);
console.log('=== UNLIT VERT ===');
console.log(unlit.vert);
console.log('=== UNLIT FRAG ===');
console.log(unlit.frag);
