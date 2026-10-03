#!/usr/bin/env node
// probe-executor.mjs — the single implementation of the probe action word table
// (MASTER-CONTEXT §12.2), the safe stateAssertion evaluator, and the four
// visualAssertion types (nonBlank / motion / pixelDelta / regionChange).
//
// Also runnable headless for spec dry-runs:
//   node runner/probe-executor.mjs --dry-run --spec <spec.json>
//
// Red lines: this module never evaluates spec expressions via `eval`/`Function`;
// the jq subset is executed by a hand-written tokenizer + recursive-descent
// parser, so function calls / member access onto Function are impossible.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { isoNow, parseArgv, sleep } from './util.mjs';

// ============================================================================
// 1. Safe jq-subset evaluator
// ============================================================================

/** Tokenize a jq-subset expression. Throws SyntaxError on unknown input. */
export function jqTokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] || '')) { j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
      }
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // strings ("..." or '...')
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j++;
      }
      if (j >= n) throw new SyntaxError(`unterminated string at ${i}`);
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    // root reference
    if (c === '$') { tokens.push({ type: 'root' }); i++; continue; }
    // identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'true' || word === 'false' || word === 'null') tokens.push({ type: word });
      else tokens.push({ type: 'ident', value: word });
      i = j;
      continue;
    }
    // operators & punctuation (longest first)
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) { tokens.push({ type: two }); i += 2; continue; }
    if (['>', '<', '!', '+', '-', '*', '/', '(', ')', '[', ']', '.', ','].includes(c)) {
      tokens.push({ type: c });
      i++;
      continue;
    }
    throw new SyntaxError(`unexpected character '${c}' at offset ${i}`);
  }
  return tokens;
}

/** Parse tokens into an AST. */
export function jqParse(src) {
  const tokens = jqTokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    const tok = tokens[pos];
    if (!tok || tok.type !== t) {
      throw new SyntaxError(`expected ${t} but found ${tok ? JSON.stringify(tok.type) : 'end of input'} at token ${pos}`);
    }
    pos++;
    return tok;
  };
  const is = (t) => peek() && peek().type === t;

  function parseExpr() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    while (is('||')) { eat('||'); left = { op: '||', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseEq();
    while (is('&&')) { eat('&&'); left = { op: '&&', left, right: parseEq() }; }
    return left;
  }
  function parseEq() {
    let left = parseRel();
    while (is('==') || is('!=')) { const op = eat(peek().type).type; left = { op, left, right: parseRel() }; }
    return left;
  }
  function parseRel() {
    let left = parseAdd();
    while (['>', '<', '>=', '<='].includes(peek()?.type)) {
      const op = eat(peek().type).type;
      left = { op, left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (is('+') || is('-')) { const op = eat(peek().type).type; left = { op, left, right: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (is('*') || is('/')) { const op = eat(peek().type).type; left = { op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (is('!')) { eat('!'); return { op: '!', operand: parseUnary() }; }
    if (is('-')) { eat('-'); return { op: 'neg', operand: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new SyntaxError('unexpected end of expression');
    if (tok.type === 'number') { eat('number'); return { kind: 'lit', value: tok.value }; }
    if (tok.type === 'string') { eat('string'); return { kind: 'lit', value: tok.value }; }
    if (tok.type === 'true') { eat('true'); return { kind: 'lit', value: true }; }
    if (tok.type === 'false') { eat('false'); return { kind: 'lit', value: false }; }
    if (tok.type === 'null') { eat('null'); return { kind: 'lit', value: null }; }
    if (tok.type === 'root') { eat('root'); return parsePath({ kind: 'root' }); }
    if (tok.type === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    throw new SyntaxError(`unexpected token '${tok.type}' (function calls are forbidden in stateAssertion)`);
  }
  function parsePath(node) {
    // only `$` supports trailing paths: $.a.b[0].c / $[0] / $["key"]
    for (;;) {
      if (is('.')) {
        eat('.');
        const ident = eat('ident').value;
        node = { kind: 'member', object: node, property: ident };
      } else if (is('[')) {
        eat('[');
        let idx;
        if (is('number')) { idx = eat('number').value; }
        else if (is('string')) { idx = eat('string').value; }
        else throw new SyntaxError('array subscript must be a number or string literal');
        eat(']');
        node = { kind: 'index', object: node, index: idx };
      } else break;
    }
    return node;
  }

  const ast = parseExpr();
  if (pos !== tokens.length) throw new SyntaxError(`trailing tokens starting at token ${pos}`);
  return ast;
}

const isNullish = (v) => v === null || v === undefined;
const toNum = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : NaN);

/** JS-like loose equality for JSON-able values. */
export function jqLooseEq(a, b) {
  if (isNullish(a) && isNullish(b)) return true;
  if (isNullish(a) || isNullish(b)) return false;
  if (typeof a === typeof b) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return jqLooseEq(typeof a === 'boolean' ? Number(a) : a, typeof b === 'boolean' ? Number(b) : b);
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  return false;
}

function jqCompareRel(op, a, b) {
  let x = a;
  let y = b;
  if (typeof x === 'boolean') x = Number(x);
  if (typeof y === 'boolean') y = Number(y);
  if (typeof x === 'number' && typeof y === 'number') {
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    switch (op) {
      case '>': return x > y;
      case '<': return x < y;
      case '>=': return x >= y;
      case '<=': return x <= y;
    }
  }
  if (typeof x === 'string' && typeof y === 'string') {
    switch (op) {
      case '>': return x > y;
      case '<': return x < y;
      case '>=': return x >= y;
      case '<=': return x <= y;
    }
  }
  return false; // null/undefined/object in relational context -> false
}

function jqEvalNode(node, root) {
  switch (node.kind) {
    case 'lit': return node.value;
    case 'root': return root;
    case 'member': {
      const obj = jqEvalNode(node.object, root);
      if (obj === null || obj === undefined) return undefined;
      if (Array.isArray(obj) || typeof obj !== 'object') return undefined;
      return obj[node.property];
    }
    case 'index': {
      const obj = jqEvalNode(node.object, root);
      if (obj === null || obj === undefined) return undefined;
      if (typeof node.index === 'number') return Array.isArray(obj) ? obj[node.index] : undefined;
      return obj != null && typeof obj === 'object' ? obj[node.index] : undefined;
    }
    case undefined:
      // operator nodes carry `op` instead of `kind`
      break;
    default:
      throw new Error(`unknown AST node ${node.kind}`);
  }
  switch (node.op) {
    case '!': return !jqEvalNode(node.operand, root);
    case 'neg': return -toNum(jqEvalNode(node.operand, root));
    case '&&': return Boolean(jqEvalNode(node.left, root)) && Boolean(jqEvalNode(node.right, root));
    case '||': return Boolean(jqEvalNode(node.left, root)) || Boolean(jqEvalNode(node.right, root));
    case '==': return jqLooseEq(jqEvalNode(node.left, root), jqEvalNode(node.right, root));
    case '!=': return !jqLooseEq(jqEvalNode(node.left, root), jqEvalNode(node.right, root));
    case '>': case '<': case '>=': case '<=':
      return jqCompareRel(node.op, jqEvalNode(node.left, root), jqEvalNode(node.right, root));
    case '+': case '-': case '*': case '/': {
      const a = toNum(jqEvalNode(node.left, root));
      const b = toNum(jqEvalNode(node.right, root));
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? NaN : a / b;
      }
      return NaN;
    }
    default:
      throw new Error(`unknown AST operator ${node.op}`);
  }
}

/**
 * Evaluate a jq-subset expression against `root` ($). Safe: no eval, no
 * function calls, property paths only. Returns {ok, value, error}.
 */
export function evalJq(expr, root) {
  try {
    const ast = jqParse(expr);
    const value = jqEvalNode(ast, root);
    return { ok: true, value: typeof value === 'number' && !Number.isFinite(value) ? String(value) : value };
  } catch (e) {
    return { ok: false, value: null, error: e.message };
  }
}

/** Parse-only check (dry run). */
export function checkJq(expr) {
  try {
    jqParse(expr);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Resolve a path string like `pickTargets[2]` or `a.b[0].c` against an object. */
export function resolvePathStr(root, pathStr) {
  // normalize to jq path by prefixing '$' and evaluating via the safe parser
  const r = evalJq(`$.${pathStr.trim()}`, root ?? {});
  return r.ok ? r.value : undefined;
}

// ============================================================================
// 2. Action word table
// ============================================================================

const VERBS = ['wait', 'dblclick', 'click', 'wheel', 'pointermove', 'drag', 'key'];
const VERB_RE = new RegExp(`^(${VERBS.join('|')}):`);

/**
 * Split a compound action on '+' while tolerating '+' inside arguments
 * (e.g. key:Control+A). Segments not starting with a known verb are merged
 * back into the previous segment.
 */
export function splitAction(raw) {
  const parts = String(raw).split('+');
  const out = [];
  for (const p of parts) {
    if (out.length === 0 || VERB_RE.test(p)) out.push(p);
    else out[out.length - 1] += '+' + p; // '+' belonged to the previous argument
  }
  return out;
}

/** Lenient object literal parser: {x:0.5,y:0.30} -> {x:0.5,y:0.3} (JSON with bare keys). */
function parseLooseObject(s) {
  const quoted = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  const v = JSON.parse(quoted);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('expected object literal');
  return v;
}

function parseTuple(s) {
  const m = /^\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)$/.exec(s);
  if (!m) throw new SyntaxError(`bad tuple coordinate: ${s}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function parseCoord(s) {
  s = s.trim();
  if (s.startsWith('(')) return parseTuple(s);
  if (s.startsWith('{')) return parseLooseObject(s);
  throw new SyntaxError(`bad coordinate: ${s}`);
}

/** Parse a single `verb:arg` string into a normalized step descriptor. */
export function parseActionStep(stepStr) {
  const m = VERB_RE.exec(stepStr);
  if (!m) throw new SyntaxError(`action step does not start with a known verb: ${stepStr}`);
  const verb = m[1];
  const argRaw = stepStr.slice(m[0].length).trim();

  switch (verb) {
    case 'wait': {
      const ms = Number(argRaw);
      if (!Number.isFinite(ms) || ms < 0) throw new SyntaxError(`wait needs non-negative ms, got: ${argRaw}`);
      return { verb, arg: { ms }, raw: stepStr };
    }
    case 'key': {
      if (!argRaw) throw new SyntaxError('key requires a key name');
      return { verb, arg: { key: argRaw }, raw: stepStr };
    }
    case 'wheel': {
      let dy;
      const kv = /^deltaY\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(argRaw);
      if (kv) dy = Number(kv[1]);
      else if (argRaw.startsWith('{')) {
        const o = parseLooseObject(argRaw);
        dy = Number(o.dy ?? o.deltaY ?? o.deltaY ?? o.dY);
      }
      if (dy === undefined || !Number.isFinite(dy)) throw new SyntaxError(`wheel needs deltaY=-N or {dy:-N}, got: ${argRaw}`);
      return { verb, arg: { dy }, raw: stepStr };
    }
    case 'pointermove': {
      const arrow = /^(.+?)->(.+)$/.exec(argRaw);
      if (arrow) {
        const from = parseCoord(arrow[1]);
        const to = parseCoord(arrow[2]);
        return { verb, arg: { from, to }, raw: stepStr };
      }
      return { verb, arg: { to: parseCoord(argRaw) }, raw: stepStr };
    }
    case 'drag': {
      const arrow = /^(.+?)->(.+)$/.exec(argRaw);
      if (arrow) {
        return { verb, arg: { from: parseCoord(arrow[1]), to: parseCoord(arrow[2]) }, raw: stepStr };
      }
      if (argRaw.startsWith('{')) {
        const o = parseLooseObject(argRaw);
        if (!o.from || !o.to) throw new SyntaxError('drag object needs from and to');
        return { verb, arg: { from: parseCoord(JSON.stringify(o.from)), to: parseCoord(JSON.stringify(o.to)) }, raw: stepStr };
      }
      throw new SyntaxError(`bad drag: ${argRaw}`);
    }
    case 'click':
    case 'dblclick': {
      const ui = /^ui[#=](.+)$/.exec(argRaw);
      if (ui) return { verb, arg: { kind: 'ui', name: ui[1].trim() }, raw: stepStr };
      const st = /^state\.(.+)$/.exec(argRaw);
      if (st) return { verb, arg: { kind: 'state', path: st[1].trim() }, raw: stepStr };
      return { verb, arg: { kind: 'xy', ...parseCoord(argRaw) }, raw: stepStr };
    }
    default:
      throw new SyntaxError(`unknown verb ${verb}`);
  }
}

/** Parse a full (possibly `+`-chained) action string into steps. */
export function parseAction(raw) {
  const steps = splitAction(raw).map((s) => parseActionStep(s));
  return { raw: String(raw), steps };
}

/** Coordinate rule from MASTER-CONTEXT §12.2: numeric <= 1.5 is normalized, else absolute px. */
export function toPixels(v, axis, viewport) {
  const num = Number(v);
  if (!Number.isFinite(num)) throw new SyntaxError(`non-numeric coordinate: ${v}`);
  const full = axis === 'x' ? viewport.width : viewport.height;
  return Math.round(num <= 1.5 ? num * full : num);
}

function coordToPx(c, viewport) {
  return { x: toPixels(c.x, 'x', viewport), y: toPixels(c.y, 'y', viewport) };
}

/**
 * Execute one parsed action step against the page.
 * getState: async () => state object (for click:state.* coords).
 * Throws Error on harness-level failures; returns {performed, detail}.
 */
export async function executeActionStep(page, step, ctx) {
  const { viewport, getState } = ctx;
  const a = step.arg;
  switch (step.verb) {
    case 'wait':
      await sleep(a.ms);
      return { performed: `waited ${a.ms}ms` };
    case 'key':
      await page.keyboard.press(a.key);
      return { performed: `pressed ${a.key}` };
    case 'wheel':
      await page.mouse.wheel(0, a.dy);
      return { performed: `wheel dy=${a.dy}` };
    case 'pointermove': {
      if (a.from) {
        const f = coordToPx(a.from, viewport);
        await page.mouse.move(f.x, f.y, { steps: 4 });
        await sleep(120);
      }
      const t = coordToPx(a.to, viewport);
      await page.mouse.move(t.x, t.y, { steps: 6 });
      return { performed: `pointermove -> (${t.x},${t.y})` };
    }
    case 'drag': {
      const f = coordToPx(a.from, viewport);
      const t = coordToPx(a.to, viewport);
      await page.mouse.move(f.x, f.y, { steps: 4 });
      await sleep(60);
      await page.mouse.down();
      await page.mouse.move(t.x, t.y, { steps: 12 });
      await sleep(60);
      await page.mouse.up();
      return { performed: `drag (${f.x},${f.y})->(${t.x},${t.y})` };
    }
    case 'click':
    case 'dblclick': {
      const clicks = step.verb === 'dblclick' ? 2 : 1;
      // FIX 2026-10-02 (Reference E04): `target` was never initialized on the
      // non-ui branches (click:{x,y} / click:(x,y) / click:state.*), so
      // `target.px = ...` threw "Cannot set properties of undefined" and the
      // click never dispatched (seen as REF-E03/REF-E04 P2 ACTION_ERROR).
      // Initializing to {} restores the intended dispatch for all branches.
      // No behavior change for ui clicks. G4 NC cases never exercised this
      // path; re-affirm G4 after adopting this fix.
      let target = {};
      if (a.kind === 'ui') {
        target = { ui: a.name };
        const loc = page.locator(`[data-ui="${a.name}"], [data-bench="${a.name}"]`).first();
        const count = await loc.count();
        if (count === 0) {
          const err = new Error(`ui control not found in DOM: [data-ui="${a.name}"] / [data-bench="${a.name}"]`);
          err.code = 'UI_CONTROL_MISSING';
          throw err;
        }
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) {
          const err = new Error(`ui control present but not visible: ${a.name}`);
          err.code = 'UI_CONTROL_HIDDEN';
          throw err;
        }
        const box = await loc.boundingBox();
        if (!box) {
          const err = new Error(`ui control has no bounding box: ${a.name}`);
          err.code = 'UI_CONTROL_MISSING';
          throw err;
        }
        target.px = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      } else if (a.kind === 'state') {
        const state = await getState();
        const v = resolvePathStr(state, a.path);
        if (v == null || typeof v !== 'object') {
          const err = new Error(`click:state.${a.path} resolved to ${JSON.stringify(v)}`);
          err.code = 'STATE_TARGET_MISSING';
          throw err;
        }
        const sx = v.screenX ?? v.x;
        const sy = v.screenY ?? v.y;
        if (!Number.isFinite(Number(sx)) || !Number.isFinite(Number(sy))) {
          const err = new Error(`click:state.${a.path} has no usable screenX/screenY`);
          err.code = 'STATE_TARGET_MISSING';
          throw err;
        }
        target.px = coordToPx({ x: Number(sx), y: Number(sy) }, viewport);
        target.state = a.path;
      } else {
        target.px = coordToPx(a, viewport);
      }
      if (target.ui) {
        // click through playwright for full actionability on the control
        if (clicks === 2) await page.locator(`[data-ui="${a.name}"], [data-bench="${a.name}"]`).first().dblclick();
        else await page.locator(`[data-ui="${a.name}"], [data-bench="${a.name}"]`).first().click();
      } else if (clicks === 2) {
        await page.mouse.dblclick(target.px.x, target.px.y);
      } else {
        await page.mouse.click(target.px.x, target.px.y);
      }
      return { performed: `${step.verb} @ (${target.px.x},${target.px.y})${target.ui ? ` ui=${target.ui}` : ''}${target.state ? ` state=${target.state}` : ''}` };
    }
    default:
      throw new Error(`unhandled verb ${step.verb}`);
  }
}

// ============================================================================
// 3. Region resolution
// ============================================================================

/**
 * Resolve a region spec into pixel rects on the viewport.
 * Supported: "full", "center:N%", "lower:N%", "upper:N%", "upper-third",
 * "center-third", "lower-third", "outer-corners", "center-bottom",
 * "outer-frame", "hud", "ui#x"/"ui=x" (element bbox), "state.<path>"
 * (dynamic pick target), {x,y,w,h} objects, arrays of the above, and
 * "A + B" multi-region strings. Unknown named regions fall back to the full
 * frame with a note (harness must never crash on descriptive region text).
 */
export async function resolveRegions(spec, ctx) {
  const { viewport, page, getState } = ctx;
  const W = viewport.width;
  const H = viewport.height;
  const rects = [];
  const notes = [];

  async function resolveOne(s) {
    if (s == null) { rects.push({ x: 0, y: 0, w: W, h: H }); return; }
    if (typeof s === 'object' && !Array.isArray(s)) {
      if (typeof s.x === 'number' && typeof s.w === 'number') {
        const norm = (v, full) => (v <= 1.5 ? v * full : v);
        const x = Math.max(0, Math.round(norm(s.x, W)));
        const y = Math.max(0, Math.round(norm(s.y ?? 0, H)));
        const w = Math.min(W - x, Math.round(norm(s.w, W)));
        const h = Math.min(H - y, Math.round(norm(s.h ?? 1, H)));
        rects.push({ x, y, w: Math.max(1, w), h: Math.max(1, h) });
        return;
      }
      // E03 P2 style: region is a pick-target-like object already
      if (typeof s.screenX === 'number') {
        rects.push(pickTargetRect(s, W, H));
        return;
      }
      notes.push(`region object unrecognized, using full frame: ${JSON.stringify(s).slice(0, 80)}`);
      rects.push({ x: 0, y: 0, w: W, h: H });
      return;
    }
    if (Array.isArray(s)) {
      for (const item of s) await resolveOne(item);
      return;
    }
    const str = String(s).trim();

    if (str === 'full' || str === '') { rects.push({ x: 0, y: 0, w: W, h: H }); return; }

    // multi region "A + B"
    if (str.includes(' + ')) {
      for (const part of str.split(' + ')) await resolveOne(part);
      return;
    }

    const pct = /^(center|lower|upper):(\d+(?:\.\d+)?)%$/.exec(str);
    if (pct) {
      const p = Number(pct[2]) / 100;
      if (pct[1] === 'center') {
        const w = Math.round(W * p);
        const h = Math.round(H * p);
        rects.push({ x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h });
      } else if (pct[1] === 'lower') {
        rects.push({ x: 0, y: Math.round(H * (1 - p)), w: W, h: Math.round(H * p) });
      } else {
        rects.push({ x: 0, y: 0, w: W, h: Math.round(H * p) });
      }
      return;
    }

    if (str === 'upper-third' || str === 'lower-third') {
      const h = Math.round(H / 3);
      rects.push(str === 'upper-third' ? { x: 0, y: 0, w: W, h } : { x: 0, y: H - h, w: W, h });
      return;
    }
    if (str === 'center-third') {
      rects.push({ x: Math.round(W / 3), y: Math.round(H * 0.25), w: Math.round(W / 3), h: Math.round(H * 0.5) });
      return;
    }
    if (str === 'outer-corners') {
      const w = Math.round(W * 0.28);
      const h = Math.round(H * 0.28);
      rects.push({ x: 0, y: 0, w, h }, { x: W - w, y: 0, w, h }, { x: 0, y: H - h, w, h }, { x: W - w, y: H - h, w, h });
      return;
    }
    if (str === 'center-bottom') {
      rects.push({ x: Math.round(W * 0.2), y: Math.round(H * 0.55), w: Math.round(W * 0.6), h: Math.round(H * 0.45) });
      return;
    }
    if (str === 'outer-frame') {
      const t = Math.round(H * 0.16);
      const l = Math.round(W * 0.14);
      rects.push(
        { x: 0, y: 0, w: W, h: t },
        { x: 0, y: H - t, w: W, h: t },
        { x: 0, y: 0, w: l, h: H },
        { x: W - l, y: 0, w: l, h: H }
      );
      return;
    }

    const ui = /^ui[#=](.+)$/.exec(str);
    if (ui) {
      const name = ui[1].trim();
      const loc = page.locator(`[data-ui="${name}"], [data-bench="${name}"]`).first();
      const box = (await loc.count()) > 0 ? await loc.boundingBox().catch(() => null) : null;
      if (!box) return { elementNotFound: name };
      const pad = 24;
      rects.push({
        x: Math.max(0, Math.round(box.x - pad)),
        y: Math.max(0, Math.round(box.y - pad)),
        w: Math.min(W, Math.round(box.width + pad * 2)),
        h: Math.min(H, Math.round(box.height + pad * 2)),
      });
      return;
    }

    const st = /^state\.(.+)$/.exec(str);
    if (st) {
      const state = await getState();
      const v = resolvePathStr(state, st[1].trim());
      if (v && typeof v === 'object' && Number.isFinite(Number(v.screenX ?? v.x))) {
        rects.push(pickTargetRect(v, W, H));
        return;
      }
      return { elementNotFound: `state.${st[1]}` };
    }

    // Descriptive named regions from frozen specs (disk, mid-ring, hud, ...)
    notes.push(`named region "${str.slice(0, 40)}" not geometric; fell back to full frame`);
    rects.push({ x: 0, y: 0, w: W, h: H });
  }

  function pickTargetRect(v, w, h) {
    const cx = Number(v.screenX ?? v.x);
    const cy = Number(v.screenY ?? v.y);
    const r = Number.isFinite(Number(v.screenRadius)) ? Number(v.screenRadius) : 24;
    const size = Math.min(360, Math.max(64, Math.round(r * 4)));
    return {
      x: Math.max(0, Math.min(w - size, Math.round(cx - size / 2))),
      y: Math.max(0, Math.min(h - size, Math.round(cy - size / 2))),
      w: size,
      h: size,
    };
  }

  const missing = [];
  const out = await (async () => {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const item of list) {
      const r = await resolveOne(item);
      if (r && r.elementNotFound) missing.push(r.elementNotFound);
    }
    return null;
  })();

  return {
    rects: rects.length ? rects : [{ x: 0, y: 0, w: W, h: H }],
    notes,
    missing,
  };
}

// ============================================================================
// 4. Pixel math (pngjs)
// ============================================================================

export function decodePng(buf) {
  const img = PNG.sync.read(buf);
  return { width: img.width, height: img.height, data: img.data };
}

function clampRect(rect, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, Math.round(rect.w))),
    h: Math.max(1, Math.min(height - y, Math.round(rect.h))),
  };
}

/** Modal (background) color of a region via 4-bit/channel quantization. */
export function modeColor(img, rect) {
  const r = clampRect(rect, img.width, img.height);
  const buckets = new Map();
  for (let y = r.y; y < r.y + r.h; y += 2) {
    for (let x = r.x; x < r.x + r.w; x += 2) {
      const i = (y * img.width + x) * 4;
      const key = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
      let b = buckets.get(key);
      if (!b) { b = [0, 0, 0, 0]; buckets.set(key, b); }
      b[0]++;
      b[1] += img.data[i];
      b[2] += img.data[i + 1];
      b[3] += img.data[i + 2];
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b[0] > best[0]) best = b;
  if (!best) return { r: 0, g: 0, b: 0, coverage: 0 };
  return { r: best[1] / best[0], g: best[2] / best[0], b: best[3] / best[0], coverage: best[0] };
}

/** Fraction of pixels whose RGB distance from the region's modal color exceeds `dist`. */
export function litRatio(img, rect, dist = 30) {
  const r = clampRect(rect, img.width, img.height);
  const bg = modeColor(img, r);
  let total = 0;
  let lit = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      const dr = img.data[i] - bg.r;
      const dg = img.data[i + 1] - bg.g;
      const db = img.data[i + 2] - bg.b;
      if (Math.sqrt(dr * dr + dg * dg + db * db) > dist) lit++;
      total++;
    }
  }
  return { ratio: total ? lit / total : 0, background: [bg.r, bg.g, bg.b].map((v) => Math.round(v)), lit: total ? lit / total : 0 };
}

/** Fraction of differing pixels between two same-size frames within a rect. */
export function diffRatio(imgA, imgB, rect, pixThreshold = 12) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error(`frame size mismatch: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`);
  }
  const r = clampRect(rect, imgA.width, imgA.height);
  let total = 0;
  let changed = 0;
  let shiftSum = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * imgA.width + x) * 4;
      const d =
        Math.abs(imgA.data[i] - imgB.data[i]) +
        Math.abs(imgA.data[i + 1] - imgB.data[i + 1]) +
        Math.abs(imgA.data[i + 2] - imgB.data[i + 2]);
      if (d > pixThreshold) changed++;
      shiftSum += d / 3;
      total++;
    }
  }
  return {
    ratio: total ? changed / total : 0,
    avgColorShift: total ? shiftSum / total : 0,
  };
}

// ============================================================================
// 5. Visual assertions
// ============================================================================

const DEFAULTS = {
  nonBlankRatio: 0.03,
  motionRatio: 0.005,
  pixelDeltaRatio: 0.01,
  regionChangeRatio: 0.01,
  litDistance: 30,
  pixThreshold: 12,
  frameGapMs: 500,
};

function pickNumber(params, keys, fallback) {
  for (const k of keys) {
    const v = params?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

async function shoot(page) {
  return decodePng(await page.screenshot({ type: 'png' }));
}

/**
 * Run one visualAssertion. ctx additionally provides shotDir / probeId for
 * saving evidence frames, plus shotBefore (pre-action frame) for pixelDelta.
 * Returns {ok, type, metrics, error?, notes[]}.
 */
export async function runVisualAssertion(page, va, ctx, shotBefore = null) {
  const notes = [];
  const params = va?.params || {};
  const meta = { type: va?.type, params, notes, expect: params.expect || null };
  if (!va || !va.type) return { ok: true, ...meta, metrics: { skipped: true }, notes: ['no visualAssertion declared'] };
  try {
    switch (va.type) {
      case 'nonBlank': {
        const minRatio = pickNumber(params, ['minLitPixelRatio', 'minCoverage', 'ratio', 'threshold'], DEFAULTS.nonBlankRatio);
        const litDistance = pickNumber(params, ['litDistance', 'bgDistance'], DEFAULTS.litDistance);
        const regionSpec = params.regions ?? params.region ?? 'full';
        const rr = await resolveRegions(regionSpec, ctx);
        notes.push(...rr.notes);
        const frame = await shoot(page);
        await ctx.saveShot(frame, 'vis');
        const perRegion = [];
        for (const rect of rr.rects) {
          const m = litRatio(frame, rect, litDistance);
          perRegion.push({ rect, litRatio: Math.round(m.ratio * 10000) / 10000, background: m.background });
        }
        const min = Math.min(...perRegion.map((p) => p.litRatio));
        return { ok: min >= minRatio, ...meta, metrics: { minRatio, perRegion, worstLitRatio: min } };
      }
      case 'motion': {
        const minRatio = pickNumber(params, ['minMotionPixelRatio', 'minChangedRatio', 'ratio', 'threshold'], DEFAULTS.motionRatio);
        const spanMs = pickNumber(params, ['spanMs', 'frameGapMs', 'intervalMs'], DEFAULTS.frameGapMs);
        const pixThreshold = pickNumber(params, ['pixThreshold'], DEFAULTS.pixThreshold);
        const regionSpec = params.regions ?? params.region ?? 'full';
        const rr = await resolveRegions(regionSpec, ctx);
        notes.push(...rr.notes);
        const f1 = await shoot(page);
        await ctx.saveShot(f1, 'motion-a');
        await sleep(spanMs);
        const f2 = await shoot(page);
        await ctx.saveShot(f2, 'motion-b');
        const perRegion = [];
        for (const rect of rr.rects) {
          const d = diffRatio(f1, f2, rect, pixThreshold);
          perRegion.push({ rect, diffRatio: Math.round(d.ratio * 10000) / 10000 });
        }
        const min = Math.min(...perRegion.map((p) => p.diffRatio));
        return { ok: min >= minRatio, ...meta, metrics: { minRatio, spanMs, perRegion, worstDiffRatio: min } };
      }
      case 'pixelDelta': {
        const metric = params.metric || 'diffRatio';
        if (metric === 'avgColorShift') {
          const minShift = pickNumber(params, ['minShift'], 8);
          const regionSpec = params.regions ?? params.region ?? 'full';
          const rr = await resolveRegions(regionSpec, ctx);
          notes.push(...rr.notes);
          const before = shotBefore ?? (await shoot(page));
          const after = await shoot(page);
          await ctx.saveShot(after, 'delta');
          const perRegion = [];
          for (const rect of rr.rects) {
            const d = diffRatio(shotBefore ?? before, after, rect);
            perRegion.push({ rect, avgColorShift: Math.round(d.avgColorShift * 100) / 100 });
          }
          const max = Math.max(...perRegion.map((p) => p.avgColorShift));
          return { ok: max >= minShift, ...meta, metrics: { metric, minShift, perRegion, bestShift: max } };
        }
        const minRatio = pickNumber(params, ['minDiffPixelRatio', 'minChangedRatio', 'ratio', 'threshold'], DEFAULTS.pixelDeltaRatio);
        const pixThreshold = pickNumber(params, ['pixThreshold'], DEFAULTS.pixThreshold);
        const regionSpec = params.regions ?? params.region ?? 'full';
        const rr = await resolveRegions(regionSpec, ctx);
        notes.push(...rr.notes);
        const gapMs = pickNumber(params, ['frameGapMs', 'spanMs'], null);
        let before;
        let after;
        if (gapMs != null) {
          before = await shoot(page);
          await ctx.saveShot(before, 'delta-a');
          await sleep(gapMs);
          after = await shoot(page);
          await ctx.saveShot(after, 'delta-b');
        } else {
          if (!shotBefore) {
            notes.push('pixelDelta without pre-action frame: comparing two post-action frames 500ms apart');
            before = await shoot(page);
            await sleep(DEFAULTS.frameGapMs);
          } else {
            before = shotBefore;
          }
          after = await shoot(page);
          await ctx.saveShot(after, 'delta');
        }
        const perRegion = [];
        for (const rect of rr.rects) {
          const d = diffRatio(before, after, rect, pixThreshold);
          perRegion.push({ rect, diffRatio: Math.round(d.ratio * 10000) / 10000 });
        }
        const max = Math.max(...perRegion.map((p) => p.diffRatio));
        return { ok: max >= minRatio, ...meta, metrics: { minRatio, mode: gapMs != null ? 'post-gap' : 'before-after', perRegion, bestDiffRatio: max } };
      }
      case 'regionChange': {
        const expect = params.expect;
        const regionSpec = params.region ?? params.regions;
        // DOM-presence expectations resolved purely in the DOM
        if (expect === 'absent' || expect === 'visible-text') {
          const m = typeof regionSpec === 'string' ? /^ui[#=](.+)$/.exec(regionSpec.trim()) : null;
          if (!m) {
            notes.push(`expect=${expect} needs a ui region; got ${JSON.stringify(regionSpec)} — checking full-frame text instead`);
          }
          if (expect === 'absent') {
            if (m) {
              const loc = page.locator(`[data-ui="${m[1].trim()}"], [data-bench="${m[1].trim()}"]`).first();
              const found = (await loc.count()) > 0;
              const visible = found ? await loc.isVisible().catch(() => false) : false;
              return { ok: !visible, ...meta, metrics: { domCheck: 'absent', locator: m[1], found, visible } };
            }
            return { ok: true, ...meta, metrics: { domCheck: 'absent', fallback: 'no-ui-region', note: 'treated as pass without a ui region (no positive claim made)' } };
          }
          if (m) {
            const loc = page.locator(`[data-ui="${m[1].trim()}"], [data-bench="${m[1].trim()}"]`).first();
            const found = (await loc.count()) > 0;
            const visible = found ? await loc.isVisible().catch(() => false) : false;
            const text = visible ? ((await loc.innerText().catch(() => '')) || '').trim() : '';
            return { ok: visible && text.length > 0, ...meta, metrics: { domCheck: 'visible-text', locator: m[1], found, visible, textLength: text.length, textPreview: text.slice(0, 60) } };
          }
          const bodyText = (await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '')) || '';
          return { ok: bodyText.length > 0, ...meta, metrics: { domCheck: 'visible-text-fallback', textLength: bodyText.length } };
        }
        // pixel-based region change
        const minRatio = pickNumber(params, ['minDiffPixelRatio', 'minChangedRatio', 'ratio', 'threshold'], DEFAULTS.regionChangeRatio);
        const gapMs = pickNumber(params, ['frameGapMs', 'spanMs'], DEFAULTS.frameGapMs);
        const pixThreshold = pickNumber(params, ['pixThreshold'], DEFAULTS.pixThreshold);
        const rr = await resolveRegions(regionSpec ?? 'full', ctx);
        notes.push(...rr.notes);
        if (rr.missing.length && !expect) {
          return { ok: false, ...meta, error: `region not found: ${rr.missing.join(', ')}`, metrics: { missing: rr.missing } };
        }
        if (rr.missing.length) notes.push(`missing regions treated as unchanged: ${rr.missing.join(', ')}`);
        const f1 = await shoot(page);
        await ctx.saveShot(f1, 'region-a');
        await sleep(gapMs);
        const f2 = await shoot(page);
        await ctx.saveShot(f2, 'region-b');
        const perRegion = [];
        for (const rect of rr.rects) {
          const d = diffRatio(f1, f2, rect, pixThreshold);
          perRegion.push({ rect, diffRatio: Math.round(d.ratio * 10000) / 10000 });
        }
        const max = Math.max(0, ...perRegion.map((p) => p.diffRatio));
        return { ok: max >= minRatio && rr.rects.length > 0, ...meta, metrics: { minRatio, gapMs, perRegion, bestDiffRatio: max, missing: rr.missing } };
      }
      default:
        return { ok: false, ...meta, error: `unknown visualAssertion type: ${va.type}` };
    }
  } catch (e) {
    return { ok: false, ...meta, error: e.message, metrics: {} };
  }
}

// ============================================================================
// 6. Probe loop
// ============================================================================

async function sampleState(page) {
  try {
    const v = await page.evaluate(() => (window.__bench && typeof window.__bench.getState === 'function' ? window.__bench.getState() : null));
    return { ok: v != null, value: v };
  } catch (e) {
    return { ok: false, value: null, error: e.message };
  }
}

async function callReset(page) {
  try {
    await page.evaluate(() => window.__bench?.reset?.());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Evaluate a probe precondition like "__appReady", "P1 passed",
 * "P4 passed && $.timeScale == 8", "__appReady && P1 passed".
 */
export async function checkPrecondition(pre, ctx, priorById) {
  const parts = String(pre).split('&&').map((s) => s.trim()).filter(Boolean);
  const details = [];
  let met = true;
  for (const part of parts) {
    if (part === '__appReady') {
      const v = ctx.appReady === true;
      details.push({ part, met: v, source: 'session' });
      met = met && v;
      continue;
    }
    const prior = /^P(\d+)(?:\s+passed)?$/.exec(part);
    if (prior) {
      const pid = `P${prior[1]}`;
      const v = priorById.get(pid)?.status === 'PASS';
      details.push({ part, met: v, source: `probe ${pid}` });
      met = met && v;
      continue;
    }
    if (part.startsWith('$.') || part === '$') {
      const s = await sampleState(ctx.page);
      const r = s.ok ? evalJq(part, s.value ?? {}) : { ok: false, error: s.error };
      details.push({ part, met: r.ok === true && r.value === true, source: 'state', error: r.error });
      met = met && r.ok === true && r.value === true;
      continue;
    }
    if (part === 'true') { details.push({ part, met: true, source: 'literal' }); continue; }
    details.push({ part, met: false, source: 'unknown' });
    met = false;
  }
  return { met, details };
}

/**
 * Execute all probes of a spec sequentially.
 * ctx = {page, viewport, appReady, networkSince(tsIso), outShot(name, frame), shotDir, probeIdPrefix}
 * Returns {results, byId, passed, passedWeight, totalWeight}.
 */
export async function runProbes(spec, ctx) {
  const results = [];
  const byId = new Map();
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const getState = () => sampleState(ctx.page).then((s) => s.value ?? {});

  for (const probe of probes) {
    const probeId = probe.probeId || `P${results.length + 1}`;
    const weight = typeof probe.weight === 'number' && probe.weight > 0 ? probe.weight : 1;
    const startedTs = isoNow();
    const t0 = Date.now();
    const shots = [];

    const saveShot = (frame, tag) => {
      const name = `${probeId}-${tag}.png`;
      try {
        const buf = PNG.sync.write({ width: frame.width, height: frame.height, data: Buffer.from(frame.data) });
        fs.mkdirSync(ctx.shotDir, { recursive: true });
        fs.writeFileSync(path.join(ctx.shotDir, name), buf);
        shots.push(name);
      } catch (e) {
        shots.push(`${name} (write-failed: ${e.message})`);
      }
    };

    const result = {
      probeId,
      weight,
      status: 'ERROR',
      precondition: null,
      action: { raw: probe.action ?? null, steps: [], durationMs: 0 },
      stateAssertion: null,
      visualAssertion: null,
      evidence: { stateBefore: null, stateAfter: null, shots, networkSince: [] },
      timings: {},
    };

    try {
      // -- precondition
      if (probe.precondition) {
        const pre = await checkPrecondition(probe.precondition, { ...ctx, getState }, byId);
        result.precondition = { expr: probe.precondition, met: pre.met, details: pre.details };
        if (!pre.met) {
          result.status = 'SKIPPED';
          result.timings.totalMs = Date.now() - t0;
          results.push(result);
          byId.set(probeId, result);
          continue;
        }
      }

      const vctx = { page: ctx.page, viewport: ctx.viewport, getState };

      // -- pre-action frame + state
      const shotBefore = await shoot(ctx.page);
      saveShot(shotBefore, 'before');
      const stateBefore = await sampleState(ctx.page);
      result.evidence.stateBefore = stateBefore.ok ? stateBefore.value : { __error: stateBefore.error };

      // -- action (+-chained steps)
      let actionError = null;
      if (probe.action) {
        const tA = Date.now();
        try {
          const parsed = parseAction(probe.action);
          result.action.steps = parsed.steps.map((s) => ({ verb: s.verb, arg: s.arg, raw: s.raw }));
          for (const step of parsed.steps) {
            const perf = await executeActionStep(ctx.page, step, { ...vctx, getState });
            result.action.steps.find((s) => s.raw === step.raw).performed = perf.performed;
          }
        } catch (e) {
          actionError = { code: e.code || 'ACTION_ERROR', message: e.message };
        }
        result.action.durationMs = Date.now() - tA;
      }

      // -- settle wait
      if (Number.isFinite(Number(probe.waitMs)) && probe.waitMs > 0) await sleep(probe.waitMs);

      // -- state sampling (single or double sample window)
      let dollarRoot;
      if (Number.isFinite(Number(probe.sampleWindowMs)) && probe.sampleWindowMs > 0) {
        const before = await sampleState(ctx.page);
        await sleep(probe.sampleWindowMs);
        const after = await sampleState(ctx.page);
        dollarRoot = { before: before.value ?? null, after: after.value ?? null };
        result.evidence.stateAfter = after.value ?? { __error: after.error };
        result.evidence.sampleWindowMs = probe.sampleWindowMs;
      } else {
        const s = await sampleState(ctx.page);
        dollarRoot = s.value ?? null;
        result.evidence.stateAfter = s.ok ? s.value : { __error: s.error };
      }

      // -- stateAssertion
      if (probe.stateAssertion?.jq) {
        const r = evalJq(probe.stateAssertion.jq, dollarRoot);
        result.stateAssertion = { expr: probe.stateAssertion.jq, ok: r.ok && r.value === true, value: r.value, error: r.error || null };
      }

      // -- visualAssertion (only if the action itself did not hard-fail on missing UI)
      if (!actionError || actionError.code === 'STATE_TARGET_MISSING') {
        if (probe.visualAssertion) {
          const vis = await runVisualAssertion(ctx.page, probe.visualAssertion, { ...vctx, saveShot }, shotBefore);
          result.visualAssertion = vis;
        }
      } else {
        result.visualAssertion = { ok: false, type: probe.visualAssertion?.type || null, error: `skipped: action failed (${actionError.code})`, metrics: {} };
      }

      // -- post shot
      const shotAfter = await shoot(ctx.page);
      saveShot(shotAfter, 'after');

      result.evidence.networkSince = (ctx.networkSince?.(startedTs) ?? []).slice(-50);

      // -- verdict
      if (actionError) {
        result.status = 'FAIL';
        result.action.error = actionError;
      } else if (result.stateAssertion && !result.stateAssertion.ok) {
        result.status = 'FAIL';
      } else if (result.visualAssertion && result.visualAssertion.ok === false) {
        result.status = 'FAIL';
      } else {
        result.status = 'PASS';
      }
      if (result.stateAssertion?.error) {
        // jq could not be evaluated at runtime (spec syntax or state shape) -> ERROR
        result.status = 'ERROR';
      }
    } catch (e) {
      result.status = 'ERROR';
      result.error = e.message;
    }

    result.timings.totalMs = Date.now() - t0;
    results.push(result);
    byId.set(probeId, result);
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const passedWeight = results.filter((r) => r.status === 'PASS').reduce((a, r) => a + r.weight, 0);
  const totalWeight = results.reduce((a, r) => a + r.weight, 0);
  return { results, byId, passed, passedWeight, totalWeight };
}

/** Reset the app via the contract (used for lifecycle checks outside probes). */
export { callReset };

// ============================================================================
// 7. Spec dry-run (no browser): parse every action / assertion / visual params
// ============================================================================

export async function dryRunSpec(spec) {
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const out = {
    briefId: spec?.briefId ?? null,
    probeCount: probes.length,
    allOk: true,
    probes: [],
  };
  for (const probe of probes) {
    const entry = { probeId: probe.probeId, action: { ok: false }, stateAssertion: null, visualAssertion: null, ok: true };
    try {
      const parsed = parseAction(probe.action ?? 'wait:0');
      entry.action = {
        ok: true,
        raw: probe.action ?? null,
        verbs: parsed.steps.map((s) => s.verb),
        steps: parsed.steps.map((s) => ({ verb: s.verb, arg: s.arg })),
      };
    } catch (e) {
      entry.action = { ok: false, raw: probe.action ?? null, error: e.message };
      entry.ok = false;
    }
    if (probe.stateAssertion?.jq) {
      const c = checkJq(probe.stateAssertion.jq);
      entry.stateAssertion = { expr: probe.stateAssertion.jq, ok: c.ok, error: c.error || null };
      if (!c.ok) entry.ok = false;
    }
    if (probe.visualAssertion) {
      const va = probe.visualAssertion;
      const knownTypes = ['nonBlank', 'motion', 'pixelDelta', 'regionChange'];
      const typeOk = knownTypes.includes(va.type);
      const params = va.params || {};
      const regionStr = typeof (params.region ?? params.regions) === 'string' ? String(params.region ?? params.regions) : JSON.stringify(params.region ?? params.regions ?? 'full');
      entry.visualAssertion = {
        type: va.type,
        ok: typeOk,
        error: typeOk ? null : `unknown type ${va.type}`,
        region: regionStr,
        dynamicRegion: /state\.|ui[#=]/.test(regionStr),
        thresholds: {
          minLitPixelRatio: params.minLitPixelRatio ?? params.minCoverage ?? null,
          minMotionPixelRatio: params.minMotionPixelRatio ?? null,
          minDiffPixelRatio: params.minDiffPixelRatio ?? params.minChangedRatio ?? null,
          spanMs: params.spanMs ?? params.frameGapMs ?? null,
        },
      };
      if (!typeOk) entry.ok = false;
    }
    if (!entry.ok) out.allOk = false;
    out.probes.push(entry);
  }
  return out;
}

// --- CLI ---
const argv = parseArgv(process.argv.slice(2));
if (argv['dry-run'] || argv.dryRun) {
  if (!argv.spec) {
    process.stderr.write('usage: node runner/probe-executor.mjs --dry-run --spec <spec.json>\n');
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(argv.spec, 'utf8'));
  const r = await dryRunSpec(spec);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.allOk ? 0 : 1);
}
