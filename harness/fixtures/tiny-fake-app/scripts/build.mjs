// "build": copy src/app.js -> dist/app.js. Stand-in for a real esbuild pipeline;
// exercises the harness's `npm run build` subprocess path end to end.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'app.js');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(src, path.join(dist, 'app.js'));
console.log('tiny-fake-app build: dist/app.js written');
