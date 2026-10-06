// probe6: MeshUtils class body, primitives keys, Material.setProperty + technique
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');

console.log('=== MeshUtils class ===');
const mu = s.indexOf('class MeshUtils');
console.log(s.slice(mu, mu + 900));

console.log('\n=== primitives ===');
let pr = s.indexOf('var primitives');
console.log(s.slice(pr, pr + 420));

console.log('\n=== Material prototype methods ===');
let mp = s.indexOf('class Material extends Asset');
const seg = s.slice(mp, mp + 9000);
for (const name of ['setProperty', 'get technique', 'recompile', 'initialize(info']) {
    const k = seg.indexOf(name);
    console.log(name, '@', k, ':', k >= 0 ? seg.slice(k - 60, k + 260).replace(/\n/g, ' ') : 'NOT FOUND');
}
