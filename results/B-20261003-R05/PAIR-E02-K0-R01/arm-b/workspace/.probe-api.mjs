// temp API probe helper (deleted before delivery)
import fs from 'node:fs';
const s = fs.readFileSync('dist/vendor/cocosair.module.js', 'utf8');
const i = s.indexOf('"name": "builtin-unlit"');
const seg = s.slice(i, i + 250000);
const re = /"(vert|frag)": "((?:[^"\\]|\\.)*)"/g;
let m;
let n = 0;
while ((m = re.exec(seg)) !== null && n < 4) {
  const body = JSON.parse('"' + m[2] + '"');
  n++;
  console.log('===== ' + m[1] + ' #' + n + ' (' + body.length + ' chars) =====');
  if (m[1] === 'vert') {
    const lines = body.split('\n');
    lines.forEach((l) => {
      if (/a_texCoord|uv\s*=|out vec2|USE_COLOR|#if|#endif|#else|a_color/.test(l)) {
        console.log('  ' + l.trim().slice(0, 130));
      }
    });
  } else {
    const fi = body.indexOf('vec4 frag ()');
    console.log(body.slice(fi >= 0 ? fi : 0, (fi >= 0 ? fi : 0) + 600));
  }
}
