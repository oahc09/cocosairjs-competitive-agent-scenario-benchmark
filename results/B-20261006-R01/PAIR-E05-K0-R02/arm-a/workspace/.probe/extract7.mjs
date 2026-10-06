// probe7: unlit frag (find via colorScaleAndCutoff in glsl4 region), sphere options, onLoaded body
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');
const gs = s.indexOf('const glsl4');
const gEnd = s.indexOf('\nconst SET_GLOBAL', gs);
const region = s.slice(gs, gEnd);

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
    const vKey = region.indexOf('"vert"', from);
    const vOpen = region.indexOf('"', region.indexOf(':', vKey) + 1) + 1;
    const vClose = scanStr(region, vOpen);
    const vert = JSON.parse('"' + region.slice(vOpen, vClose) + '"');
    const fKey = region.indexOf('"frag"', vClose);
    const fOpen = region.indexOf('"', region.indexOf(':', fKey) + 1) + 1;
    const fClose = scanStr(region, fOpen);
    const frag = JSON.parse('"' + region.slice(fOpen, fClose) + '"');
    return { vert, frag };
}
// find every '"frag": "' and check preceding 6000 chars for colorScaleAndCutoff proximity:
// simpler: locate 'colorScaleAndCutoff' occurrences inside region; unlit frag is the shader whose frag text contains it
let ci = region.indexOf('colorScaleAndCutoff');
console.log('first colorScaleAndCutoff in glsl4 region @', ci);
if (ci > 0) {
    // the frag string containing it: find the last '"frag": "' before ci
    const fKey = region.lastIndexOf('"frag"', ci);
    const fOpen = region.indexOf('"', region.indexOf(':', fKey) + 1) + 1;
    const fClose = scanStr(region, fOpen);
    const frag = JSON.parse('"' + region.slice(fOpen, fClose) + '"');
    console.log('=== FRAG containing colorScaleAndCutoff ===');
    console.log(frag);
    fs.writeFileSync('.probe/unlit-frag.glsl', frag);
    // find its vert: last '"vert"' before that frag key whose entry bounds contain it: take last '"vert"' before fKey
    const vKey = region.lastIndexOf('"vert"', fKey);
    const vOpen = region.indexOf('"', region.indexOf(':', vKey) + 1) + 1;
    const vClose = scanStr(region, vOpen);
    const vert = JSON.parse('"' + region.slice(vOpen, vClose) + '"');
    fs.writeFileSync('.probe/unlit-vert.glsl', vert);
    console.log('=== VERT (tail 1800) ===');
    console.log(vert.slice(-1800));
}
console.log('\n=== sphere options ===');
const sp = s.indexOf('function sphere$1');
console.log(s.slice(sp, sp + 700));
console.log('\n=== EffectAsset onLoaded ===');
const ol = s.indexOf('onLoaded() {', 970000);
console.log(s.slice(ol - 100, ol + 900));
