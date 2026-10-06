// one-off probe: extract builtin-unlit glsl4 vert/frag source from engine bundle
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');
const gs = s.indexOf('const glsl4');
const region = s.slice(gs, gs + 420000);
const idx = region.indexOf('mainTiling_Offset');
const start = region.lastIndexOf('{   "vert": "', idx);
const vKey = region.indexOf('"vert"', start);
const vOpen = region.indexOf('"', region.indexOf(':', vKey) + 1) + 1;
// scan for closing unescaped quote
function scanStr(from) {
    let q = from;
    for (;;) {
        q = region.indexOf('"', q + 1);
        let bs = 0, r = q - 1;
        while (region[r] === '\\') { bs++; r--; }
        if (bs % 2 === 0) return q;
    }
}
const vClose = scanStr(vOpen);
const vertSrc = JSON.parse('"' + region.slice(vOpen, vClose) + '"');
const fKey = region.indexOf('"frag"', vClose);
const fOpen = region.indexOf('"', region.indexOf(':', fKey) + 1) + 1;
const fClose = scanStr(fOpen);
const fragSrc = JSON.parse('"' + region.slice(fOpen, fClose) + '"');
fs.writeFileSync('.probe/unlit-vert.glsl', vertSrc);
fs.writeFileSync('.probe/unlit-frag.glsl', fragSrc);
console.log('vert', vertSrc.length, 'frag', fragSrc.length);
console.log('=== VERT ===');
console.log(vertSrc);
console.log('=== FRAG ===');
console.log(fragSrc);
