// probe4: createMesh colors channel, dynamic mesh API, primitives surface, utils export shape
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');

console.log('=== createMesh colors section ===');
let i = s.indexOf('function createMesh');
console.log(s.slice(i + 700, i + 3200));

console.log('\n=== createDynamicMesh context ===');
const d = s.indexOf('createDynamicMesh', 1590000);
console.log(s.slice(d - 400, d + 1500));

console.log('\n=== updateSubMesh context ===');
const u = s.indexOf('updateSubMesh(', 1560000);
console.log(s.slice(u - 600, u + 400));

console.log('\n=== primitives export object ===');
const p = s.indexOf('var primitives', 1806392);
console.log(s.slice(p, p + 300));

console.log('\n=== utils object ===');
const ut = s.indexOf('utils = {');
if (ut > 0) console.log(s.slice(ut, ut + 400));
else {
    const ut2 = s.lastIndexOf('utils');
    console.log('utils last at', ut2, s.slice(ut2 - 100, ut2 + 200));
}
// find export of utils
const ux = s.indexOf('utils as utils');
console.log('export utils:', s.slice(ux - 200, ux + 60));
