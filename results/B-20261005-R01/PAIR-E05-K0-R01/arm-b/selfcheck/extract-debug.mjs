import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../workspace/src/main.js', import.meta.url), 'utf8');
function extractBlock(startMarker) {
    const i = src.indexOf(startMarker);
    if (i < 0) throw new Error('marker not found: ' + startMarker);
    const open = src.indexOf('{', i);
    let depth = 0, inStr = null;
    for (let j = open; j < src.length; j++) {
        const c = src[j];
        const prev = src[j - 1];
        if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error('unbalanced for ' + startMarker);
}
for (const m of ['const CFG = {', 'function mulberry32(', 'function clamp(', 'function orientTriangles(', 'function makeGeometry(', 'function buildStarGeometry(', 'const STREAK_TINTS = [', 'function buildStreakGeometry(', 'const DISK_STOPS = [', 'function diskBaseColor(', 'function dopplerFactor(']) {
    const b = extractBlock(m);
    console.log('---', m, '| len', b.length, '| head:', JSON.stringify(b.slice(0, 60)));
}
