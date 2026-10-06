/**
 * geometry-test.mjs — 从 workspace/src/main.js 提取真实几何构建函数在 Node 中做纯数学验证。
 * 目的:最后一次浏览器验证前,以零浏览器成本确认即将上屏的几何代码无 NaN、范围与索引正确。
 * (只读 main.js 与写本目录报告,不触任何禁读路径。)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'workspace', 'src', 'main.js'), 'utf8');

// —— 平衡括号提取器:按标记后的第一个开括号类型(®或[)配对 ——
function extractBlock(startMarker) {
    const i = src.indexOf(startMarker);
    if (i < 0) throw new Error('marker not found: ' + startMarker);
    let open = -1;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{' || c === '[') { open = j; break; }
    }
    const openCh = src[open];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, inStr = null;
    for (let j = open; j < src.length; j++) {
        const c = src[j];
        const prev = src[j - 1];
        if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
        if (c === '/' && src[j + 1] === '*') { j += 2; while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++; continue; }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error('unbalanced for ' + startMarker);
}

const parts = [];
parts.push('const TAU = Math.PI * 2;');
parts.push(extractBlock('const CFG = {'));
parts.push(extractBlock('function mulberry32('));
parts.push(extractBlock('function clamp('));
parts.push(extractBlock('function orientTriangles('));
parts.push(extractBlock('function makeGeometry('));
parts.push(extractBlock('const DISK_STOPS = ['));
parts.push(extractBlock('function diskBaseColor('));
parts.push(extractBlock('function dopplerFactor('));
parts.push(extractBlock('function buildStarGeometry('));
parts.push(extractBlock('const STREAK_TINTS = ['));
parts.push(extractBlock('function buildStreakGeometry('));
const mod = parts.join('\n\n');

const api = new Function(mod + `
    return { mulberry32, buildStarGeometry, buildStreakGeometry, diskBaseColor, dopplerFactor, CFG, STREAK_TINTS, DISK_STOPS };
`)();

let fails = 0;
function check(name, ok, detail) {
    if (!ok) fails++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// —— 星空几何 ——
const rng = api.mulberry32(20261005);
const star = api.buildStarGeometry(rng);
const P = star.positions, C = star.colors, I = star.indices;
let nan = 0;
for (const v of P) if (!Number.isFinite(v)) nan++;
for (const v of C) if (!Number.isFinite(v)) nan++;
check('star: no NaN in positions/colors', nan === 0, 'nan=' + nan);
check('star: groups = starCount+3', P.length / 39 === api.CFG.starCount + 3, 'groups=' + P.length / 39 + ' (13 verts each)');
let badStarExtent = 0, badNebulaExtent = 0, badCenter = 0, maxStarOff = 0;
for (let g = 0; g * 39 < P.length; g++) {
    const cx = P[g * 39], cy = P[g * 39 + 1], cz = P[g * 39 + 2];
    const cr = Math.hypot(cx, cy, cz);
    if (cr < 54 || cr > 86) badCenter++;
    const isNebula = g >= api.CFG.starCount;
    const limit = isNebula ? 14.5 : 2.35;
    for (let v = 0; v < 13; v++) {
        const off = Math.hypot(P[g * 39 + v * 3] - cx, P[g * 39 + v * 3 + 1] - cy, P[g * 39 + v * 3 + 2] - cz);
        if (off > maxStarOff && !isNebula) maxStarOff = off;
        if (off > limit) { if (isNebula) badNebulaExtent++; else badStarExtent++; }
    }
}
check('star: group centers on shell 55-85', badCenter === 0, 'bad=' + badCenter);
check('star: star verts within 2.35u of center', badStarExtent === 0, 'maxOff=' + maxStarOff.toFixed(3));
check('star: nebula verts within 14.5u', badNebulaExtent === 0, 'bad=' + badNebulaExtent);
let badIdx = 0;
for (const idx of I) if (idx < 0 || idx >= P.length / 3) badIdx++;
check('star: indices in range', badIdx === 0, 'tris=' + I.length / 3);
let dark = 0;
for (let i = 0; i < C.length; i += 4) { if (C[i] <= 0 && C[i + 1] <= 0 && C[i + 2] <= 0) dark++; }
check('star: no fully black vertices', dark === 0, 'black=' + dark);

// —— 星流网格 ——
const streak = api.buildStreakGeometry(api.STREAK_TINTS[0]);
let sNan = 0;
for (const v of streak.positions) if (!Number.isFinite(v)) sNan++;
check('streak: 6 verts, no NaN', streak.positions.length === 18 && sNan === 0);
let sExtent = 0;
for (let v = 0; v < 6; v++) {
    const off = Math.hypot(streak.positions[v * 3], streak.positions[v * 3 + 2]);
    if (off > 0.51) sExtent++;
}
check('streak: local extent <= 0.5', sExtent === 0);

// —— 盘色标:亮度沿半径单调衰减(P3 亮度比前提) ——
let mono = true, prev = Infinity;
for (let r = 1.8; r <= 6.5001; r += 0.1) {
    const c = api.diskBaseColor(r);
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (lum > prev + 1e-6) { mono = false; break; }
    prev = lum;
}
check('disk: base luminance monotonically decays 1.8→6.5', mono);
const inner = api.diskBaseColor(2.0), outer = api.diskBaseColor(4.5);
const li = 0.2126 * inner[0] + 0.7152 * inner[1] + 0.0722 * inner[2];
const lo = 0.2126 * outer[0] + 0.7152 * outer[1] + 0.0722 * outer[2];
check('disk: inner/outer luminance ratio >= 1.8 (linear)', li / lo >= 1.8, (li / lo).toFixed(2));
const oc = api.diskBaseColor(4.5);
check('disk: outer R-B positive & large', oc[0] - oc[2] >= 0.15, 'R-B=' + (oc[0] - oc[2]).toFixed(3));

const report = { at: new Date().toISOString(), fails, checks: fails === 0 ? 'ALL PASS' : 'SEE LOG' };
writeFileSync(path.join(here, 'geometry-test.json'), JSON.stringify(report, null, 2));
console.log(fails === 0 ? '[geometry-test] ALL PASS' : '[geometry-test] FAILURES: ' + fails);
process.exit(fails === 0 ? 0 : 1);
