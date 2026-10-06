// probe3: unlit meta blocks + particle add pass + dynamic mesh + primitives surface
import fs from 'node:fs';
const effects = JSON.parse(fs.readFileSync('.effect-probe-effects.json', 'utf8'));
const unlit = effects.find(e => e.name === 'builtin-unlit');
const sh = unlit.shaders[0];
console.log('=== UNLIT shaders[0].blocks ===');
console.log(JSON.stringify(sh.blocks, null, 1));
console.log('=== UNLIT shaders[0].samplerTextures ===');
console.log(JSON.stringify(sh.samplerTextures, null, 1));
console.log('=== UNLIT shaders[0].attributes ===');
console.log(JSON.stringify(sh.attributes, null, 1));
console.log('=== UNLIT pass full JSON (technique opaque pass 0) ===');
console.log(JSON.stringify(unlit.techniques[0].passes[0], null, 1));
const part = effects.find(e => e.name === 'builtin-particle');
console.log('=== PARTICLE techniques ===', part.techniques.map(t => t.name).join(','));
for (const t of part.techniques) {
    for (const p of t.passes) {
        console.log(`--- pass (technique ${t.name}) ---`);
        console.log(JSON.stringify({ program: p.program, rasterizerState: p.rasterizerState, blendState: p.blendState, depthStencilState: p.depthStencilState }, null, 1));
    }
}
const bb = effects.find(e => e.name === 'builtin-billboard');
console.log('=== BILLBOARD add pass states ===');
const bbp = bb.techniques[0].passes[0];
console.log(JSON.stringify({ rasterizerState: bbp.rasterizerState, blendState: bbp.blendState, depthStencilState: bbp.depthStencilState }, null, 1));
