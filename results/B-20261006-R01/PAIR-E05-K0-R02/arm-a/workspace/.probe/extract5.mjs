// probe5: _defAttrs, MeshUtils, updateSubMesh, primitives keys, Material.setProperty/technique
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');

console.log('=== _defAttrs ===');
let i = s.indexOf('_defAttrs = [');
if (i < 0) i = s.indexOf('_defAttrs=');
console.log(s.slice(i, i + 600));

console.log('\n=== MeshUtils ===');
let m = s.indexOf('MeshUtils');
while (m >= 0 && m < s.length) {
    const ctx = s.slice(m - 60, m + 80).replace(/\n/g, ' ');
    if (/createDynamicMesh|updateSubMesh|MeshUtils\s*=|MeshUtils\s*\{/i.test(ctx)) {
        console.log('@', m, ':', ctx);
        break;
    }
    m = s.indexOf('MeshUtils', m + 1);
}
const mu = s.indexOf('var MeshUtils');
if (mu < 0) mu = s.indexOf('const MeshUtils');
if (mu < 0) mu = s.indexOf('MeshUtils = {');
console.log('MeshUtils decl @', mu, ':', mu >= 0 ? s.slice(mu, mu + 300) : 'N/A');

console.log('\n=== updateSubMesh (mesh class method) ===');
let us = s.indexOf('updateSubMesh(subMesh');
if (us < 0) us = s.indexOf('updateSubMesh(');
console.log(s.slice(us - 150, us + 700));

console.log('\n=== primitives object ===');
let pr = s.indexOf('primitives = {');
if (pr < 0) pr = s.indexOf('const primitives');
console.log(s.slice(pr, pr + 500));

console.log('\n=== Material setProperty / technique ===');
let sp = s.indexOf('setProperty(name, value');
if (sp < 0) sp = s.indexOf('setProperty(');
console.log('first setProperty @', sp, ':', s.slice(sp - 80, sp + 500).replace(/\n/g, ' '));
let tq = s.indexOf('get technique');
console.log('technique getter:', s.slice(tq - 100, tq + 300).replace(/\n/g, ' '));
