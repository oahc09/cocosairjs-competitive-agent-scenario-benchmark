// probe8: Mesh.updateSubMesh signature + Vec4 export + Mesh.reset/updateGeometry
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');
let k = s.indexOf('updateSubMesh(', 1500000);
while (k >= 0 && k < 1620000) {
    const body = s.slice(k - 200, k + 900);
    if (/updateSubMesh\s*\(/.test(body)) {
        console.log('@', k);
        console.log(body);
        console.log('----');
    }
    k = s.indexOf('updateSubMesh(', k + 5);
}
const v4 = s.indexOf('Vec4 as Vec4');
console.log('Vec4 export:', v4 > 0 ? s.slice(v4 - 40, v4 + 20) : 'check alt');
