// Fake build: copies src/app.js -> dist/app.js. Real exit code 0, no engine, no deps.
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('src/app.js', 'dist/app.js');
fs.writeFileSync('dist/built.json', JSON.stringify({ fixture: 'NC03', builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log('[NC03 build] dist/app.js written');
