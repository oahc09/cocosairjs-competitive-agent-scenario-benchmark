#!/usr/bin/env node
// probe-executor.mjs — the single implementation of the probe action word table
// (MASTER-CONTEXT §12.2), the safe stateAssertion evaluator, and the
// visualAssertion types (nonBlank / motion / pixelDelta / regionChange +
// the 2026-10-02 rectification set: networkRequest / download / domText /
// noNavigation / resourceRequestCount / consoleClean / colorRelation /
// luminanceRelation / regionCoverage / memoryDelta / assetNoReload).
//
// Also runnable headless for spec dry-runs:
//   node runner/probe-executor.mjs --dry-run --spec <spec.json>
//
// Strictness contract (rectification §8: "Frozen Spec 写 A, Validator 不得
// 实际测 B; 绝不允许 unknown→fallback→PASS"):
//   * unknown visualAssertion.type  -> SPEC_INVALID error (never a default PASS);
//   * unknown region name           -> SPEC_INVALID unless ctx.diagnostic===true
//     (diagnostic runs fall back to the full frame with a DIAGNOSTIC-FALLBACK
//     note, so humans can still collect evidence while debugging);
//   * env-dependent assertions whose data source is not wired into ctx
//     (downloads/console/performance.memory) -> UNSUPPORTED_BY_ENV error, never
//     a silent PASS;
//   * probe status enum: PASS / FAIL / ERROR / SKIPPED_BY_DEPENDENCY /
//     NOT_APPLICABLE (probe.enabled === false). Preconditions are three-way:
//     PASS -> run; FAIL with a live page -> run anyway recording
//     ranDespitePredecessor + predecessor; ERROR -> SKIPPED_BY_DEPENDENCY.
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
 * LEGAL_REGION_FORMS — the closed vocabulary of region forms this executor can
 * resolve into pixel rects. This is the contract table backing the strictness
 * rule (rectification §8): a frozen spec that names a region outside this
 * table is SPEC_INVALID in scoring runs; it may only fall back to the full
 * frame when opts.diagnostic === true (fallback then loudly tagged
 * DIAGNOSTIC-FALLBACK, and it can never be used as PASS evidence).
 *
 * Forms (superset of the forms the pre-rectification implementation accepted):
 *   'full' | ''                          whole viewport
 *   'center:N%' / 'lower:N%' / 'upper:N%'  fractional band, N percent (0-100)
 *   'upper-third' / 'lower-third' / 'center-third'
 *   'outer-corners' / 'center-bottom' / 'outer-frame'
 *   'ui#<name>' / 'ui=<name>'            bbox of [data-ui=name]/[data-bench=name]
 *   'state.<path>'                       dynamic pick target from getState()
 *   {x,y,w,h}                            rect (values <= 1.5 are normalized)
 *   {screenX,screenY[,screenRadius]}     pick-target-like object (E03 style)
 *   [ ... ]                              array of any of the above
 *   'A + B'                              multi-region string (' + ' separator)
 *
 * Anything else — descriptive names like 'hud', 'disk(...)', 'upper-half',
 * 'bottom-third', annotated names like 'upper-third(天空)' — is UNKNOWN.
 */
/**
 * Strip a trailing parenthesized annotation from a named region:
 * 'upper-third(天空)' -> 'upper-third'. The annotation is prose for humans;
 * some forms additionally mine machine parameters from it (mid-vertical-band
 * reads an optional `x∈[a,b]` range). Never elsewhere significant.
 */
export const REGION_ANNOTATION_RE = /\([^)]*\)\s*$/;
export function regionBaseName(str) {
  return String(str).trim().replace(REGION_ANNOTATION_RE, '').trim();
}

export const NAMED_REGIONS = new Set([
  'full', 'upper-third', 'lower-third', 'center-third', 'bottom-third', 'upper-half',
  'outer-corners', 'center-bottom', 'outer-frame',
  'mid-vertical-band', 'disk', 'mid-ring', 'hud',
  'disk-inner-azimuth', 'disk-outer-azimuth',
]);
export const PCT_REGION_RE = /^(center|lower|upper):(\d+(?:\.\d+)?)%$/;
export const UI_REGION_RE = /^ui[#=](.+)$/;
export const STATE_REGION_RE = /^state\.(.+)$/;

/**
 * Static (browserless) classification of a region spec against
 * LEGAL_REGION_FORMS. Returns {ok, unknown:[], dynamic, forms:[]}; `unknown`
 * lists every unresolvable name/object so dry-runs and audits can report them
 * precisely. Mirrors the runtime acceptance in resolveRegions — keep both in
 * sync when extending the table (and bump the spec vocabulary note).
 */
export function classifyRegionForm(spec, acc = { unknown: [], dynamic: false, forms: [] }) {
  const finish = () => ({ ok: acc.unknown.length === 0, unknown: [...acc.unknown], dynamic: acc.dynamic, forms: [...acc.forms] });
  if (spec == null) { acc.forms.push('full'); return finish(); }
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    if (typeof spec.x === 'number' && typeof spec.w === 'number') acc.forms.push('{x,y,w,h}');
    else if (typeof spec.screenX === 'number') acc.forms.push('pickTarget');
    else acc.unknown.push(JSON.stringify(spec).slice(0, 60));
    return finish();
  }
  if (Array.isArray(spec)) {
    for (const item of spec) classifyRegionForm(item, acc);
    return finish();
  }
  const str = String(spec).trim();
  const base = regionBaseName(str);

  if (str === 'full' || str === '') acc.forms.push('full');
  else if (str.includes('+')) { for (const part of str.split(/\s*\+\s*/)) if (part) classifyRegionForm(part, acc); }
  else if (PCT_REGION_RE.test(str)) acc.forms.push(`pct:${PCT_REGION_RE.exec(str)[1]}`);
  else if (NAMED_REGIONS.has(base)) { acc.forms.push(base === 'hud' ? 'hud(dom)' : base); if (base === 'hud') acc.dynamic = true; }
  else if (UI_REGION_RE.test(str)) { acc.forms.push('ui'); acc.dynamic = true; }
  else if (STATE_REGION_RE.test(str)) { acc.forms.push('state'); acc.dynamic = true; }
  else acc.unknown.push(str.slice(0, 60));
  return finish();
}

/**
 * Resolve a region spec into pixel rects on the viewport.
 * Supported forms: see LEGAL_REGION_FORMS above. Unknown named regions are
 * reported in `unknown`; they only degrade to a full-frame rect when
 * ctx.diagnostic === true (DIAGNOSTIC-FALLBACK note) — otherwise the caller
 * turns them into a SPEC_INVALID assertion result (never a PASS).
 * Returns {rects, notes, missing, unknown}.
 */
export async function resolveRegions(spec, ctx) {
  const { viewport, page, getState } = ctx || {};
  const diagnostic = ctx?.diagnostic === true;
  const W = viewport?.width ?? 1280;
  const H = viewport?.height ?? 720;
  const rects = [];
  const notes = [];
  const unknown = [];

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
      unknown.push(`unrecognized region object: ${JSON.stringify(s).slice(0, 80)}`);
      if (diagnostic) notes.push(`DIAGNOSTIC-FALLBACK: unrecognized region object, measuring full frame: ${JSON.stringify(s).slice(0, 80)}`);
      rects.push({ x: 0, y: 0, w: W, h: H });
      return;
    }
    if (Array.isArray(s)) {
      for (const item of s) await resolveOne(item);
      return;
    }
    const str = String(s).trim();
    const base = regionBaseName(str);

    if (str === 'full' || str === '') { rects.push({ x: 0, y: 0, w: W, h: H }); return; }

    // multi region "A + B"(容忍 "+"/" + "/"+ " 变体分隔)
    if (str.includes('+')) {
      for (const part of str.split(/\s*\+\s*/)) if (part) await resolveOne(part);
      return;
    }

    const pct = PCT_REGION_RE.exec(str);
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

    if (base === 'upper-third' || base === 'lower-third') {
      const h = Math.round(H / 3);
      rects.push(base === 'upper-third' ? { x: 0, y: 0, w: W, h } : { x: 0, y: H - h, w: W, h });
      return;
    }
    if (base === 'bottom-third') {
      rects.push({ x: 0, y: Math.round(H * 2 / 3), w: W, h: Math.round(H / 3) });
      return;
    }
    if (base === 'upper-half') {
      rects.push({ x: 0, y: 0, w: W, h: Math.round(H / 2) });
      return;
    }
    if (base === 'mid-vertical-band') {
      // annotation may carry a machine range: x∈[0.4,0.6] (normalized); default middle third
      let fx0 = 1 / 3, fx1 = 2 / 3;
      const rm = /x\s*[∈=]\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/.exec(str);
      if (rm) { const a = Number(rm[1]), b = Number(rm[2]); if (a < b && b <= 1.5) { fx0 = a <= 1 ? a : a / W; fx1 = b <= 1 ? b : b / W; } }
      const x0 = Math.round(W * fx0), x1 = Math.round(W * fx1);
      rects.push({ x: x0, y: 0, w: Math.max(1, x1 - x0), h: H });
      return;
    }
    if (base === 'disk' || base === 'mid-ring' || base === 'disk-inner-azimuth' || base === 'disk-outer-azimuth') {
      // 吸积盘类区域:圆心 = 暗核中心(中心 30% 区域内最暗点,自适应构图偏移);
      // 无 page(dry-run)时回退视口中心。引擎中立(不读 __bench 内部)。
      const minD = Math.min(W, H);
      let cx = Math.round(W / 2), cy = Math.round(H / 2);
      if (page) {
        try {
          const frameC = shotBefore ?? (await shoot(page));
          let bl = Infinity;
          for (let y = Math.round(H * 0.3); y < H * 0.7; y += 3) for (let x = Math.round(W * 0.3); x < W * 0.7; x += 3) {
            const i = (y * frameC.width + x) * 4;
            const l = frameC.data[i] + frameC.data[i + 1] + frameC.data[i + 2];
            if (l < bl) { bl = l; cx = x; cy = y; }
          }
        } catch { /* 回退视口中心 */ }
      }
      if (base === 'disk') {
        const half = Math.round(minD * 0.35);
        rects.push({ x: cx - half, y: cy - half, w: half * 2, h: half * 2 });
        return;
      }
      if (base === 'mid-ring') {
        const o = Math.min(Math.round(minD * 0.72), Math.round(H / 2));
        const i = Math.round(minD * 0.38);
        rects.annulusGroup = true; // 聚合语义:环带有运动即成立(motion/regionChange 读此标记)
        rects.push(
          { x: cx - o, y: Math.max(0, cy - o), w: o * 2, h: Math.max(1, o - i) },
          { x: cx - o, y: cy + i, w: o * 2, h: Math.max(1, Math.min(o, H - cy - i)) },
          { x: cx - o, y: Math.max(0, cy - i), w: Math.max(1, o - i), h: Math.max(1, Math.min(i * 2, H - Math.max(0, cy - i))) },
          { x: cx + i, y: Math.max(0, cy - i), w: Math.max(1, Math.min(o - i, W - cx - i)), h: Math.max(1, Math.min(i * 2, H - Math.max(0, cy - i))) }
        );
        return;
      }
      // 方位角扇区(水平主轴两侧 ±6% 高度带;AUDIT F-15/E05 v1.0.2):
      // inner r[0.04,0.11]×minD(白/蓝白);outer r[0.18,0.30]×minD(橙红降带)
      const [r0, r1] = base === 'disk-inner-azimuth' ? [0.04, 0.11] : [0.18, 0.30];
      const i = Math.round(minD * r0), o = Math.round(minD * r1);
      const hh = Math.max(2, Math.round(minD * 0.06));
      rects.push({ x: cx - o, y: cy - hh, w: Math.max(1, o - i), h: hh * 2 }); // 左
      rects.push({ x: cx + i, y: cy - hh, w: Math.max(1, o - i), h: hh * 2 }); // 右
      return;
    }
    if (base === 'hud') {
      // HUD overlay bbox via DOM (accepts params.locator as a descriptive hint)
      if (!page) { unknown.push('hud(无 page,dry-run 不可解析)'); return; }
      const sel = '[data-ui*="hud"], [data-bench*="hud"], .hud, #hud, [class*="hud" i]';
      const box = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, sel).catch(() => null);
      if (!box || box.width < 2) return { elementNotFound: 'hud' };
      const pad = 16;
      rects.push({
        x: Math.max(0, Math.round(box.x - pad)),
        y: Math.max(0, Math.round(box.y - pad)),
        w: Math.min(W, Math.round(box.width + pad * 2)),
        h: Math.min(H, Math.round(box.height + pad * 2)),
      });
      return;
    }
    if (base === 'center-third') {
      rects.push({ x: Math.round(W / 3), y: Math.round(H * 0.25), w: Math.round(W / 3), h: Math.round(H * 0.5) });
      return;
    }
    if (base === 'outer-corners') {
      const w = Math.round(W * 0.28);
      const h = Math.round(H * 0.28);
      rects.push({ x: 0, y: 0, w, h }, { x: W - w, y: 0, w, h }, { x: 0, y: H - h, w, h }, { x: W - w, y: H - h, w, h });
      return;
    }
    if (base === 'center-bottom') {
      rects.push({ x: Math.round(W * 0.2), y: Math.round(H * 0.55), w: Math.round(W * 0.6), h: Math.round(H * 0.45) });
      return;
    }
    if (base === 'outer-frame') {
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

    const ui = UI_REGION_RE.exec(str);
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

    const st = STATE_REGION_RE.exec(str);
    if (st) {
      const state = await getState();
      const v = resolvePathStr(state, st[1].trim());
      if (v && typeof v === 'object' && Number.isFinite(Number(v.screenX ?? v.x))) {
        rects.push(pickTargetRect(v, W, H));
        return;
      }
      return { elementNotFound: `state.${st[1]}` };
    }

    // Descriptive named region outside LEGAL_REGION_FORMS — the old behavior
    // (silent full-frame fallback) is exactly what rectification §8 forbids.
    unknown.push(str.slice(0, 40));
    if (diagnostic) notes.push(`DIAGNOSTIC-FALLBACK: named region "${str.slice(0, 40)}" not in LEGAL_REGION_FORMS; measuring full frame`);
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
  await (async () => {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const item of list) {
      const r = await resolveOne(item);
      if (r && r.elementNotFound) missing.push(r.elementNotFound);
    }
  })();

  // fallbackFull marks the "nothing resolved at all -> full frame" degradation
  // (all dynamic ui#/state. regions missing). Callers must not score a PASS
  // off that rect when the spec named a concrete region.
  const fallbackFull = rects.length === 0;
  return {
    rects: rects.length ? rects : [{ x: 0, y: 0, w: W, h: H }],
    notes,
    missing,
    unknown,
    fallbackFull,
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

/**
 * Pixel-count-weighted average color statistics over a set of rects — backs
 * colorRelation / luminanceRelation. Returns {pixels, r, g, b, luminance,
 * avgRB} where luminance uses Rec.601-style weights on the 0-255 scale and
 * avgRB is mean(R - B) (red-vs-blue bias used by the E05 ring-color checks).
 */
export function regionColorStats(img, rects) {
  let pixels = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (const rect of rects) {
    const rc = clampRect(rect, img.width, img.height);
    for (let y = rc.y; y < rc.y + rc.h; y++) {
      for (let x = rc.x; x < rc.x + rc.w; x++) {
        const i = (y * img.width + x) * 4;
        sr += img.data[i];
        sg += img.data[i + 1];
        sb += img.data[i + 2];
        pixels++;
      }
    }
  }
  if (!pixels) return { pixels: 0, r: 0, g: 0, b: 0, luminance: 0, avgRB: 0 };
  const r = sr / pixels;
  const g = sg / pixels;
  const b = sb / pixels;
  return {
    pixels,
    r: Math.round(r * 100) / 100,
    g: Math.round(g * 100) / 100,
    b: Math.round(b * 100) / 100,
    luminance: Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 100) / 100,
    avgRB: Math.round((r - b) * 100) / 100,
  };
}

/** 亮部加权色彩统计:只统计亮度≥litThreshold 的像素(排除背景暗像素稀释)。
 * 用于 ringRelation 等对色相关系敏感的度量;返回形状与 regionColorStats 一致。 */
function litColorStats(img, rects, litThreshold = 40) {
  let pixels = 0, sr = 0, sg = 0, sb = 0, sl = 0, lit = 0, lr = 0, lb = 0;
  for (const rect of rects) {
    const rc = clampRect(rect, img.width, img.height);
    for (let y = rc.y; y < rc.y + rc.h; y++) {
      for (let x = rc.x; x < rc.x + rc.w; x++) {
        const i = (y * img.width + x) * 4;
        const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        pixels++;
        if (L >= litThreshold) { lit++; sr += R; sg += G; sb += B; sl += L; lr += R; lb += B; }
      }
    }
  }
  if (!lit) return { pixels, litPixels: 0, r: 0, g: 0, b: 0, luminance: 0, avgRB: 0 };
  return {
    pixels, litPixels: lit,
    r: Math.round((sr / lit) * 100) / 100,
    g: Math.round((sg / lit) * 100) / 100,
    b: Math.round((sb / lit) * 100) / 100,
    luminance: Math.round((sl / lit) * 100) / 100,
    avgRB: Math.round(((lr - lb) / lit) * 100) / 100,
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

// ============================================================================
// 5a. Visual assertion vocabulary (frozen whitelist backing dryRunSpec + audit)
// ============================================================================

/** Every visualAssertion.type this executor can evaluate. Anything else is SPEC_INVALID. */
export const VISUAL_ASSERTION_TYPES = [
  'nonBlank', 'motion', 'pixelDelta', 'regionChange',
  'networkRequest', 'download', 'domText', 'noNavigation', 'resourceRequestCount',
  'consoleClean', 'colorRelation', 'luminanceRelation', 'regionCoverage',
  'memoryDelta', 'assetNoReload',
];

/**
 * Known params keys per assertion type — the closed whitelist dryRunSpec audits
 * against ("Spec 写 A, Validator 不得实际测 B": a knob the executor never
 * reads must fail the dry-run instead of being silently ignored). Keys were
 * collected from the pre-rectification implementation plus the new types.
 * `expect` on the four base types is accepted but advisory/descriptive only
 * (machine-checked only for regionChange expect ∈ {absent, visible-text}) —
 * spec-audit.mjs reports those as PARTIAL, never as silently-checked.
 */
export const VISUAL_PARAM_KEYS = {
  nonBlank: ['region', 'regions', 'minLitPixelRatio', 'minCoverage', 'ratio', 'threshold', 'litDistance', 'bgDistance', 'locator', 'expect'],
  motion: ['region', 'regions', 'minMotionPixelRatio', 'minChangedRatio', 'ratio', 'threshold', 'spanMs', 'frameGapMs', 'intervalMs', 'pixThreshold', 'expect'],
  pixelDelta: ['region', 'regions', 'metric', 'minShift', 'minDiffPixelRatio', 'minChangedRatio', 'ratio', 'threshold', 'pixThreshold', 'frameGapMs', 'spanMs', 'expect'],
  regionChange: ['region', 'regions', 'expect', 'ring', 'metric', 'minDiffPixelRatio', 'minChangedRatio', 'ratio', 'threshold', 'frameGapMs', 'spanMs', 'pixThreshold'],
  networkRequest: ['path', 'minCount', 'status'],
  download: ['minBytes', 'count'],
  domText: ['selector', 'textContains'],
  noNavigation: ['sinceMs'],
  resourceRequestCount: ['path', 'exactly', 'min', 'max'],
  consoleClean: ['level'],
  colorRelation: ['regionA', 'regionB', 'metric', 'min', 'max', 'pickSide', 'expect'],
  luminanceRelation: ['regionA', 'regionB', 'metric', 'min', 'max'],
  regionCoverage: ['region', 'minRatio', 'litDistance'],
  memoryDelta: ['maxGrowthMB', 'sampleMs'],
  assetNoReload: ['path', 'sinceActionIndex'],
};

/** Params keys that must be present (SPEC_INVALID when missing). */
export const VISUAL_REQUIRED_PARAMS = {
  networkRequest: ['path'],
  download: [], // minBytes/count both optional (count defaults to >=1)
  domText: ['selector', 'textContains'],
  noNavigation: ['sinceMs'],
  resourceRequestCount: [], // exactly|min|max checked as a group in classifyVisualAssertion
  consoleClean: [],
  colorRelation: ['regionA', 'regionB'],
  luminanceRelation: ['regionA', 'regionB'],
  regionCoverage: ['region', 'minRatio'],
  memoryDelta: ['maxGrowthMB'],
  assetNoReload: ['path', 'sinceActionIndex'],
};

/** Closed value enums for enumerated params. */
export const VISUAL_PARAM_ENUMS = {
  pixelDelta: { metric: ['diffRatio', 'avgColorShift'] },
  regionChange: { metric: ['radiusScale'] },
  colorRelation: { metric: ['luminanceRatio', 'avgRBDiff'] },
  luminanceRelation: { metric: ['luminanceRatio'] },
  consoleClean: { level: ['error', 'warning'] },
};

/**
 * Static classification of one visualAssertion (no browser). Returns
 * {type, problems, unknownParamKeys, unknownRegions, regionClass} — used by
 * dryRunSpec (spec validity) and spec-audit.mjs (capability audit).
 */
export function classifyVisualAssertion(va) {
  const problems = [];
  const type = va?.type ?? null;
  if (!type || typeof type !== 'string') {
    return { type, problems: ['SPEC_INVALID: visualAssertion.type is missing'], unknownParamKeys: [], unknownRegions: [], regionClass: null };
  }
  if (!VISUAL_ASSERTION_TYPES.includes(type)) {
    problems.push(`SPEC_INVALID: unknown assertion type ${type}`);
  }
  const params = va.params && typeof va.params === 'object' && !Array.isArray(va.params) ? va.params : {};
  const known = VISUAL_PARAM_KEYS[type] ?? [];
  const unknownParamKeys = Object.keys(params).filter((k) => !known.includes(k));
  for (const k of unknownParamKeys) problems.push(`SPEC_INVALID: unknown params key "${k}" for ${type}`);

  for (const [t, enums] of Object.entries(VISUAL_PARAM_ENUMS)) {
    if (t !== type) continue;
    for (const [key, allowed] of Object.entries(enums)) {
      if (params[key] == null || allowed.includes(params[key])) continue;
      // regionChange.metric 接受语义化半径描述(规范化为 radiusScale,运行期真测)
      if (t === 'regionChange' && key === 'metric' && /半径|radius/i.test(String(params[key]))) continue;
      problems.push(`SPEC_INVALID: ${type}.${key} must be one of ${allowed.join('|')} (got ${JSON.stringify(params[key]).slice(0, 60)})`);
    }
  }
  for (const k of VISUAL_REQUIRED_PARAMS[type] ?? []) {
    if (params[k] == null) problems.push(`SPEC_INVALID: ${type} requires params.${k}`);
  }
  if (type === 'resourceRequestCount' && params.exactly == null && params.min == null && params.max == null) {
    problems.push('SPEC_INVALID: resourceRequestCount requires at least one of exactly|min|max');
  }

  let regionClass = null;
  const unknownRegions = [];
  if (type === 'colorRelation' || type === 'luminanceRelation') {
    const a = classifyRegionForm(params.regionA);
    const b = classifyRegionForm(params.regionB);
    regionClass = { ok: a.ok && b.ok, unknown: [...a.unknown, ...b.unknown], dynamic: a.dynamic || b.dynamic, forms: [...a.forms, ...b.forms] };
  } else if (known.includes('region') || known.includes('regions')) {
    regionClass = classifyRegionForm(params.regions ?? params.region ?? 'full');
  }
  if (regionClass) unknownRegions.push(...regionClass.unknown);
  for (const u of unknownRegions) problems.push(`SPEC_INVALID: unknown region ${JSON.stringify(u)}`);
  return { type, problems, unknownParamKeys, unknownRegions, regionClass };
}

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
 * Strict-region guard: after resolveRegions, an `unknown` region list turns the
 * whole assertion into SPEC_INVALID unless ctx.diagnostic === true (in which
 * case resolveRegions already recorded the DIAGNOSTIC-FALLBACK note and the
 * degraded full-frame measurement proceeds — diagnostic output only, never
 * usable as PASS evidence for the region the spec actually named).
 */
function guardUnknownRegions(rr, ctx, meta) {
  if (rr?.unknown?.length && ctx?.diagnostic !== true) {
    return { ok: false, ...meta, error: `SPEC_INVALID: unknown region ${rr.unknown.join(', ')}`, metrics: { unknownRegions: [...rr.unknown] } };
  }
  return null;
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
        const bad = guardUnknownRegions(rr, ctx, meta);
        if (bad) return bad;
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
        const bad = guardUnknownRegions(rr, ctx, meta);
        if (bad) return bad;
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
        const vals = perRegion.map((p) => p.diffRatio);
        // annulus 组(rects.annulusGroup):环带被暗核中心/视口裁剪后,部分带可能落盘外;
        // "星流沿环带运动"语义 = 任一带有运动即成立 → 聚合取 max(非 annulus 保持 worst=min)
        const agg = rr.rects.annulusGroup ? Math.max(...vals) : Math.min(...vals);
        return { ok: agg >= minRatio, ...meta, metrics: { minRatio, spanMs, perRegion, [rr.rects.annulusGroup ? 'bestDiffRatio(annulus)' : 'worstDiffRatio']: agg } };
      }
      case 'pixelDelta': {
        const metric = params.metric || 'diffRatio';
        // Rectification §8: an unrecognized metric value used to silently fall
        // through to the diffRatio branch (spec wrote a semantic, validator
        // measured something else). Now it is SPEC_INVALID.
        if (!VISUAL_PARAM_ENUMS.pixelDelta.metric.includes(metric)) {
          return { ok: false, ...meta, error: `SPEC_INVALID: pixelDelta.metric must be one of ${VISUAL_PARAM_ENUMS.pixelDelta.metric.join('|')} (got ${JSON.stringify(params.metric).slice(0, 60)})`, metrics: {} };
        }
        if (metric === 'avgColorShift') {
          const minShift = pickNumber(params, ['minShift'], 8);
          const regionSpec = params.regions ?? params.region ?? 'full';
          const rr = await resolveRegions(regionSpec, ctx);
          notes.push(...rr.notes);
          const bad = guardUnknownRegions(rr, ctx, meta);
          if (bad) return bad;
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
        const bad = guardUnknownRegions(rr, ctx, meta);
        if (bad) return bad;
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
        // --- 语义扩展分支(整改 §8:E05 冻结 spec 的 ring/metric 参数必须被真测,不得降级) ---
        // ring:内环 vs 外环的颜色关系(内更亮偏白 / 外偏橙红)——单帧双区域采样
        if (params.ring != null) {
          const frame = shotBefore ?? (await shoot(page));
          const W_ = ctx?.viewport?.width ?? frame.width ?? 1280;
          const H_ = ctx?.viewport?.height ?? frame.height ?? 720;
          // 校准环带:沿盘面主轴(水平)的左右横向切片,避开上下方向背景星空
          // 内环带 r∈[0.15,0.32](白/蓝白);外环带 r∈[0.42,0.58](橙红);切片高 0.12×min(W,H)
          const annulusBands = (r0, r1) => {
            const o = Math.round(Math.min(W_, H_) * r1), i = Math.round(Math.min(W_, H_) * r0);
            const cc = darkCoreOf(frame);
            const cx = cc[0], cy = cc[1];
            const hh = Math.max(2, Math.round(Math.min(W_, H_) * 0.06));
            return [
              { x: cx - o, y: cy - hh, w: Math.max(1, o - i), h: hh * 2 },
              { x: cx + i, y: cy - hh, w: Math.max(1, o - i), h: hh * 2 },
            ];
          };
          const innerStats = litColorStats(frame, annulusBands(0.15, 0.32));
          const outerStats = litColorStats(frame, annulusBands(0.42, 0.58));
          const innerLum = innerStats.luminance, outerLum = outerStats.luminance;
          const innerRB = innerStats.avgRB, outerRB = outerStats.avgRB;
          const ok = innerLum >= outerLum * 1.1 && (outerRB - innerRB) >= 8;
          return { ok, ...meta, metrics: { mode: 'ringRelation', innerLum, outerLum, lumRatio: Math.round((innerLum / Math.max(1, outerLum)) * 100) / 100, innerRB, outerRB } };
        }
        // metric=半径/radius:缩放前后"暗核半径"变化(中心连续暗弧的屏幕半径)
        if (params.metric != null && /半径|radius/i.test(String(params.metric))) {
          const before = shotBefore ?? (await shoot(page));
          await sleep(pickNumber(params, ['spanMs', 'frameGapMs'], DEFAULTS.frameGapMs));
          const after = await shoot(page);
          // 暗核半径:从中线中心向两侧扫描,直到亮度超过暗阈值(<35)或离开中心 45% 区域
          const darkRadius = (img) => {
            const cy = Math.round(img.height / 2), cx = Math.round(img.width / 2);
            const maxR = Math.round(Math.min(img.width, img.height) * 0.45);
            const darkAt = (x, y) => { const i = (y * img.width + x) * 4; return img.data[i] < 35 && img.data[i + 1] < 35 && img.data[i + 2] < 35; };
            if (!darkAt(cx, cy)) return 0; // 中心不暗:暗核不可测
            let rl = 0, rr = 0;
            for (let d = 1; d < maxR; d++) { if (!darkAt(cx - d, cy)) { rl = d; break; } rl = d; }
            for (let d = 1; d < maxR; d++) { if (!darkAt(cx + d, cy)) { rr = d; break; } rr = d; }
            return Math.round((rl + rr) / 2);
          };
          const b = darkRadius(before), a = darkRadius(after);
          if (!b || !a) return { ok: false, ...meta, error: 'radiusScale: dark core not measurable at center (is this a black-hole scene?)', metrics: { mode: 'radiusScale', beforeR: b, afterR: a } };
          const ratio = a / b;
          return { ok: ratio >= 1.2, ...meta, metrics: { mode: 'radiusScale', beforeR: b, afterR: a, scaleRatio: Math.round(ratio * 100) / 100 } };
        }
        // DOM-presence expectations resolved purely in the DOM. expect=absent /
        if (expect === 'absent' || expect === 'visible-text') {
          const m = typeof regionSpec === 'string' ? UI_REGION_RE.exec(regionSpec.trim()) : null;
          if (!m) {
            return { ok: false, ...meta, error: `SPEC_INVALID: expect=${expect} requires a ui#<name> / ui=<name> region (got ${JSON.stringify(regionSpec)})`, metrics: {} };
          }
          const loc = page.locator(`[data-ui="${m[1].trim()}"], [data-bench="${m[1].trim()}"]`).first();
          const found = (await loc.count()) > 0;
          const visible = found ? await loc.isVisible().catch(() => false) : false;
          if (expect === 'absent') {
            return { ok: !visible, ...meta, metrics: { domCheck: 'absent', locator: m[1], found, visible } };
          }
          const text = visible ? ((await loc.innerText().catch(() => '')) || '').trim() : '';
          return { ok: visible && text.length > 0, ...meta, metrics: { domCheck: 'visible-text', locator: m[1], found, visible, textLength: text.length, textPreview: text.slice(0, 60) } };
        }
        // pixel-based region change
        const minRatio = pickNumber(params, ['minDiffPixelRatio', 'minChangedRatio', 'ratio', 'threshold'], DEFAULTS.regionChangeRatio);
        const gapMs = pickNumber(params, ['frameGapMs', 'spanMs'], DEFAULTS.frameGapMs);
        const pixThreshold = pickNumber(params, ['pixThreshold'], DEFAULTS.pixThreshold);
        const rr = await resolveRegions(regionSpec ?? 'full', ctx);
        notes.push(...rr.notes);
        const bad = guardUnknownRegions(rr, ctx, meta);
        if (bad) return bad;
        if (rr.missing.length && (!expect || rr.fallbackFull)) {
          // Nothing resolved at all: with the old code an `expect` could still
          // PASS off the full-frame fallback rect while the spec named a
          // concrete (dynamic) region — unknown→fallback→PASS, now closed.
          return { ok: false, ...meta, error: `region not found: ${rr.missing.join(', ')}`, metrics: { missing: rr.missing, expect: expect ?? null } };
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
        return { ok: max >= minRatio && rr.rects.length > 0, ...meta, metrics: { minRatio, gapMs, perRegion, bestDiffRatio: max, missing: rr.missing, expect: expect ?? null } };
      }
      // ------------------------------------------------------------------
      // Evidence-source assertions (rectification §9). Data sources, in order:
      //   ctx.networkSince(tsIso)  — serve-log requests {ts,method,url,status,bytes}
      //                              (wired by validate.mjs since the pilots);
      //   ctx.downloads()|array    — browser download collector (must be wired
      //                              by the caller; else UNSUPPORTED_BY_ENV);
      //   ctx.consoleSince(tsIso)|ctx.consoleEntries — console collector;
      //   page.evaluate            — performance.memory / location.href;
      //   ctx.urlLog               — [{ts,url}] samples maintained by runProbes;
      //   ctx.byId                 — prior probe results (startedTs per probe).
      // A missing data source is UNSUPPORTED_BY_ENV (error), never a PASS.
      // ------------------------------------------------------------------
      case 'networkRequest': {
        if (typeof params.path !== 'string' || !params.path) return { ok: false, ...meta, error: 'SPEC_INVALID: networkRequest requires params.path', metrics: {} };
        const minCount = pickNumber(params, ['minCount'], 1);
        const status = params.status;
        if (status != null && !Number.isFinite(Number(status))) return { ok: false, ...meta, error: 'SPEC_INVALID: networkRequest.status must be a number', metrics: {} };
        if (typeof ctx.networkSince !== 'function') return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: ctx.networkSince not wired (serve request log unavailable)', metrics: {} };
        const events = ctx.networkSince(ctx.startedTs ?? '') ?? [];
        const matched = events.filter((e) =>
          String(e.url ?? e.path ?? '').includes(params.path) && (status == null || Number(e.status) === Number(status)));
        return {
          ok: matched.length >= minCount,
          ...meta,
          metrics: { path: params.path, minCount, status: status ?? null, count: matched.length, matched: matched.slice(-20) },
        };
      }
      case 'download': {
        const count = pickNumber(params, ['count'], 1);
        const minBytes = params.minBytes;
        if (minBytes != null && !Number.isFinite(Number(minBytes))) return { ok: false, ...meta, error: 'SPEC_INVALID: download.minBytes must be a number', metrics: {} };
        const list = typeof ctx.downloads === 'function' ? ctx.downloads() : Array.isArray(ctx.downloads) ? ctx.downloads : null;
        if (!list) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: ctx.downloads not wired (browser download collector unavailable)', metrics: {} };
        const totalBytes = list.reduce((a, d) => a + (Number(d?.bytes) || 0), 0);
        const ok = list.length >= count && (minBytes == null || totalBytes >= Number(minBytes));
        return {
          ok,
          ...meta,
          metrics: { count: list.length, minCount: count, totalBytes, minBytes: minBytes ?? null, downloads: list.map((d) => ({ filename: d.filename, bytes: d.bytes, error: d.error || null })) },
        };
      }
      case 'domText': {
        if (typeof params.selector !== 'string' || !params.selector) return { ok: false, ...meta, error: 'SPEC_INVALID: domText requires params.selector', metrics: {} };
        if (typeof params.textContains !== 'string' || !params.textContains) return { ok: false, ...meta, error: 'SPEC_INVALID: domText requires params.textContains', metrics: {} };
        const loc = page.locator(params.selector);
        const found = (await loc.count().catch(() => 0)) > 0;
        if (!found) return { ok: false, ...meta, metrics: { selector: params.selector, found: false, contains: params.textContains } };
        const text = ((await loc.first().innerText().catch(() => '')) || '').trim();
        return {
          ok: text.includes(params.textContains),
          ...meta,
          metrics: { selector: params.selector, found: true, textLength: text.length, textPreview: text.slice(0, 80), contains: params.textContains },
        };
      }
      case 'noNavigation': {
        const sinceMs = pickNumber(params, ['sinceMs'], null);
        if (sinceMs == null || sinceMs < 0) return { ok: false, ...meta, error: 'SPEC_INVALID: noNavigation requires params.sinceMs (non-negative ms)', metrics: {} };
        let urlNow = null;
        if (typeof page.url === 'function') {
          const u = page.url();
          urlNow = typeof u?.then === 'function' ? await u : u;
        } else if (typeof ctx.currentUrl === 'function') {
          urlNow = await ctx.currentUrl();
        }
        if (urlNow == null) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: cannot read the current page URL', metrics: {} };
        const log = Array.isArray(ctx.urlLog) ? ctx.urlLog : [];
        const cutoff = Date.now() - sinceMs;
        let ref = null;
        for (const e of log) {
          if (Date.parse(e.ts) <= cutoff) ref = e;
          else break;
        }
        if (ref == null) ref = log[0] ?? null;
        if (ref == null) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: no URL history sampled for the requested window', metrics: {} };
        log.push({ ts: isoNow(), url: urlNow }); // extend history for later probes
        return {
          ok: urlNow === ref.url,
          ...meta,
          metrics: { sinceMs, urlNow, urlAt: ref.url, urlAtTs: ref.ts, navigated: urlNow !== ref.url },
        };
      }
      case 'resourceRequestCount': {
        if (typeof params.path !== 'string' || !params.path) return { ok: false, ...meta, error: 'SPEC_INVALID: resourceRequestCount requires params.path', metrics: {} };
        const hasExactly = params.exactly != null;
        const hasMin = params.min != null;
        const hasMax = params.max != null;
        if (!hasExactly && !hasMin && !hasMax) return { ok: false, ...meta, error: 'SPEC_INVALID: resourceRequestCount requires at least one of exactly|min|max', metrics: {} };
        if (hasExactly && (hasMin || hasMax)) return { ok: false, ...meta, error: 'SPEC_INVALID: resourceRequestCount.exactly is mutually exclusive with min|max', metrics: {} };
        for (const [k, v] of [['exactly', params.exactly], ['min', params.min], ['max', params.max]]) {
          if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) return { ok: false, ...meta, error: `SPEC_INVALID: resourceRequestCount.${k} must be a non-negative number`, metrics: {} };
        }
        if (typeof ctx.networkSince !== 'function') return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: ctx.networkSince not wired (serve request log unavailable)', metrics: {} };
        const events = ctx.networkSince(ctx.sessionStartTs ?? ctx.startedTs ?? '') ?? [];
        const matched = events.filter((e) => String(e.url ?? e.path ?? '').includes(params.path));
        let ok;
        if (hasExactly) ok = matched.length === Number(params.exactly);
        else {
          ok = true;
          if (hasMin) ok = ok && matched.length >= Number(params.min);
          if (hasMax) ok = ok && matched.length <= Number(params.max);
        }
        return {
          ok,
          ...meta,
          metrics: { path: params.path, count: matched.length, exactly: hasExactly ? Number(params.exactly) : null, min: hasMin ? Number(params.min) : null, max: hasMax ? Number(params.max) : null, matched: matched.slice(-20) },
        };
      }
      case 'consoleClean': {
        const level = params.level ?? 'error';
        if (!VISUAL_PARAM_ENUMS.consoleClean.level.includes(level)) {
          return { ok: false, ...meta, error: `SPEC_INVALID: consoleClean.level must be one of ${VISUAL_PARAM_ENUMS.consoleClean.level.join('|')}`, metrics: {} };
        }
        const entries = typeof ctx.consoleSince === 'function'
          ? (ctx.consoleSince(ctx.startedTs ?? '') ?? [])
          : Array.isArray(ctx.consoleEntries) ? ctx.consoleEntries : null;
        if (!entries) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: ctx.consoleSince/consoleEntries not wired (console collector unavailable)', metrics: {} };
        const bad = entries.filter((e) => String(e?.type ?? '').toLowerCase() === String(level).toLowerCase());
        return {
          ok: bad.length === 0,
          ...meta,
          metrics: { level, count: bad.length, sample: bad.slice(-10).map((e) => String(e?.text ?? '').slice(0, 120)) },
        };
      }
      case 'colorRelation':
      case 'luminanceRelation': {
        const shorthand = va.type === 'luminanceRelation';
        const metric = params.metric ?? 'luminanceRatio';
        const allowed = shorthand ? VISUAL_PARAM_ENUMS.luminanceRelation.metric : VISUAL_PARAM_ENUMS.colorRelation.metric;
        if (!allowed.includes(metric)) {
          return { ok: false, ...meta, error: `SPEC_INVALID: ${va.type}.metric must be one of ${allowed.join('|')} (got ${JSON.stringify(params.metric).slice(0, 60)})`, metrics: {} };
        }
        if (params.regionA == null || params.regionB == null) return { ok: false, ...meta, error: `SPEC_INVALID: ${va.type} requires params.regionA and params.regionB`, metrics: {} };
        if (params.min == null && params.max == null) return { ok: false, ...meta, error: `SPEC_INVALID: ${va.type} requires params.min and/or params.max`, metrics: {} };
        const rrA = await resolveRegions(params.regionA, ctx);
        notes.push(...rrA.notes);
        const badA = guardUnknownRegions(rrA, ctx, meta);
        if (badA) return badA;
        const rrB = await resolveRegions(params.regionB, ctx);
        notes.push(...rrB.notes);
        const badB = guardUnknownRegions(rrB, ctx, meta);
        if (badB) return badB;
        const frame = await shoot(page);
        await ctx.saveShot(frame, 'color');
        // pickSide:'bright-orange' — 方位角扇区断言(AUDIT F-15/E05 spec v1.0.2):
        // A/B 均须解析为恰好 2 个扇区 rect([0]=左,[1]=右);逐侧采样,取 B 侧
        // avgRB 较大的一侧(多普勒亮侧)参与度量;两侧指标都入 metrics(不静默)。
        if (params.pickSide === 'bright-orange') {
          if (!shorthand && rrA.rects.length === 2 && rrB.rects.length === 2) {
            const side = (i) => ({ sA: regionColorStats(frame, [rrA.rects[i]]), sB: regionColorStats(frame, [rrB.rects[i]]) });
            const L = side(0), R = side(1);
            const chosen = (R.sB.avgRB >= L.sB.avgRB) ? R : L;
            const which = (R.sB.avgRB >= L.sB.avgRB) ? 'right' : 'left';
            const value = metric === 'luminanceRatio'
              ? (chosen.sB.luminance >= 1 ? chosen.sA.luminance / chosen.sB.luminance : chosen.sA.luminance >= 1 ? Infinity : 1)
              : chosen.sB.avgRB - chosen.sA.avgRB; // 有向差:外橙 − 内白(内白外橙语义)
            const ok = (params.min == null || value >= Number(params.min)) && (params.max == null || value <= Number(params.max));
            return {
              ok, ...meta,
              metrics: { metric, pickSide: which, value: Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value), min: params.min ?? null, max: params.max ?? null,
                left: { A: { lum: L.sA.luminance, rb: L.sA.avgRB }, B: { lum: L.sB.luminance, rb: L.sB.avgRB } },
                right: { A: { lum: R.sA.luminance, rb: R.sA.avgRB }, B: { lum: R.sB.luminance, rb: R.sB.avgRB } } },
            };
          }
          return { ok: false, ...meta, error: "SPEC_INVALID: pickSide='bright-orange' 要求 regionA/regionB 均解析为恰 2 个方位角扇区 rect(左,右)", metrics: {} };
        }
        const sA = regionColorStats(frame, rrA.rects);
        const sB = regionColorStats(frame, rrB.rects);
        let value;
        if (metric === 'luminanceRatio') {
          // Guard near-black denominators: a ratio against darkness is either
          // unbounded (A lit, B black) or vacuous (both black -> 1).
          value = sB.luminance >= 1 ? sA.luminance / sB.luminance : sA.luminance >= 1 ? Infinity : 1;
        } else {
          value = Math.abs(sA.avgRB - sB.avgRB);
        }
        const ok = (params.min == null || value >= Number(params.min)) && (params.max == null || value <= Number(params.max));
        return {
          ok,
          ...meta,
          metrics: {
            metric, value: Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value),
            min: params.min ?? null, max: params.max ?? null,
            regionA: { ...sA, rects: rrA.rects.length }, regionB: { ...sB, rects: rrB.rects.length },
          },
        };
      }
      case 'regionCoverage': {
        if (typeof params.minRatio !== 'number' || !Number.isFinite(params.minRatio)) return { ok: false, ...meta, error: 'SPEC_INVALID: regionCoverage requires params.minRatio (number)', metrics: {} };
        if (params.region == null) return { ok: false, ...meta, error: 'SPEC_INVALID: regionCoverage requires params.region', metrics: {} };
        const litDistance = pickNumber(params, ['litDistance'], DEFAULTS.litDistance);
        const rr = await resolveRegions(params.region, ctx);
        notes.push(...rr.notes);
        const bad = guardUnknownRegions(rr, ctx, meta);
        if (bad) return bad;
        const frame = await shoot(page);
        await ctx.saveShot(frame, 'coverage');
        const perRegion = rr.rects.map((rect) => {
          const m = litRatio(frame, rect, litDistance);
          return { rect, coverage: Math.round(m.ratio * 10000) / 10000 };
        });
        const min = Math.min(...perRegion.map((p) => p.coverage));
        return { ok: min >= params.minRatio, ...meta, metrics: { minRatio: params.minRatio, litDistance, perRegion, worstCoverage: min } };
      }
      case 'memoryDelta': {
        if (typeof params.maxGrowthMB !== 'number' || !Number.isFinite(params.maxGrowthMB) || params.maxGrowthMB < 0) {
          return { ok: false, ...meta, error: 'SPEC_INVALID: memoryDelta requires params.maxGrowthMB (non-negative number)', metrics: {} };
        }
        const sampleMs = pickNumber(params, ['sampleMs'], 1000);
        const sample = () => page.evaluate(() =>
          performance.memory && typeof performance.memory.usedJSHeapSize === 'number'
            ? { usedJSHeapSize: performance.memory.usedJSHeapSize }
            : null);
        const a = await sample().catch(() => null);
        if (!a) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: performance.memory unavailable in this environment', metrics: {} };
        if (sampleMs > 0) await sleep(sampleMs);
        const b = await sample().catch(() => null);
        if (!b) return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: performance.memory unavailable in this environment', metrics: {} };
        const growthMB = (b.usedJSHeapSize - a.usedJSHeapSize) / 1048576;
        return {
          ok: growthMB <= params.maxGrowthMB,
          ...meta,
          metrics: {
            usedBeforeMB: Math.round((a.usedJSHeapSize / 1048576) * 100) / 100,
            usedAfterMB: Math.round((b.usedJSHeapSize / 1048576) * 100) / 100,
            growthMB: Math.round(growthMB * 1000) / 1000,
            maxGrowthMB: params.maxGrowthMB, sampleMs,
          },
        };
      }
      case 'assetNoReload': {
        if (typeof params.path !== 'string' || !params.path) return { ok: false, ...meta, error: 'SPEC_INVALID: assetNoReload requires params.path', metrics: {} };
        if (params.sinceActionIndex == null) return { ok: false, ...meta, error: 'SPEC_INVALID: assetNoReload requires params.sinceActionIndex', metrics: {} };
        const raw = params.sinceActionIndex;
        const ref = typeof raw === 'number' && Number.isInteger(raw) ? `P${raw}`
          : typeof raw === 'string' && /^P\d+$/i.test(raw.trim()) ? raw.trim().toUpperCase()
          : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? `P${raw.trim()}`
          : null;
        if (!ref) return { ok: false, ...meta, error: `SPEC_INVALID: cannot resolve sinceActionIndex ${JSON.stringify(raw).slice(0, 40)} (use a probe number or "P<n>")`, metrics: {} };
        const prior = typeof ctx.byId?.get === 'function' ? ctx.byId.get(ref) : null;
        const sinceTs = prior?.startedTs;
        if (!sinceTs) return { ok: false, ...meta, error: `SPEC_INVALID: sinceActionIndex references unknown probe ${ref}`, metrics: {} };
        if (typeof ctx.networkSince !== 'function') return { ok: false, ...meta, error: 'UNSUPPORTED_BY_ENV: ctx.networkSince not wired (serve request log unavailable)', metrics: {} };
        const events = ctx.networkSince(sinceTs) ?? [];
        const matched = events.filter((e) => String(e.url ?? e.path ?? '').includes(params.path));
        return {
          ok: matched.length === 0,
          ...meta,
          metrics: { path: params.path, sinceProbe: ref, sinceTs, requests: matched.length, matched: matched.slice(-10) },
        };
      }
      default:
        // Rectification §8a: unknown types used to fall into this branch with
        // a bare error string; now uniformly SPEC_INVALID-prefixed so callers
        // (and validate.mjs classification) can distinguish spec problems.
        return { ok: false, ...meta, error: `SPEC_INVALID: unknown assertion type: ${va.type}`, metrics: {} };
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
 * Probe status enum (rectification §11): PASS / FAIL / ERROR /
 * SKIPPED_BY_DEPENDENCY / NOT_APPLICABLE (probe.enabled === false).
 * Downstream consumers (validate.mjs classify, score.mjs, aggregate) only
 * branch on PASS / FAIL / ERROR, so the two new non-final statuses inherit the
 * old SKIPPED treatment (counted in the S2 denominator, never a PASS).
 */
export const PROBE_STATUSES = ['PASS', 'FAIL', 'ERROR', 'SKIPPED_BY_DEPENDENCY', 'NOT_APPLICABLE'];

/**
 * Evaluate a probe precondition like "__appReady", "P1 passed",
 * "P4 passed && $.timeScale == 8", "__appReady && P1 passed".
 *
 * Three-way outcome (rectification §11):
 *   PASS  — every part held;
 *   FAIL  — at least one part is cleanly false, none errored;
 *   ERROR — some part could not be evaluated (state sampling failed, jq parse
 *           error, reference to a probe that does not exist, unknown syntax).
 * The caller runs the probe on PASS and on FAIL-with-live-page; ERROR skips
 * the probe as SKIPPED_BY_DEPENDENCY.
 * Returns {met, outcome, details, failedProbeParts, errorPart}.
 */
export async function checkPrecondition(pre, ctx, priorById) {
  const parts = String(pre).split('&&').map((s) => s.trim()).filter(Boolean);
  const details = [];
  const failedProbeParts = [];
  let met = true;
  let errorPart = null;
  const fail = (part, source, extra) => {
    details.push({ part, met: false, source, ...extra });
    met = false;
  };
  for (const part of parts) {
    if (part === '__appReady') {
      const v = ctx.appReady === true;
      details.push({ part, met: v, source: 'session' });
      met = met && v;
      continue;
    }
    const prior = /^P(\d+)(?:\s+passed)?$/i.exec(part);
    if (prior) {
      const pid = `P${prior[1]}`;
      const pr = priorById?.get?.(pid);
      if (!pr) {
        // references a probe that does not exist (or has not run) -> spec error
        fail(part, `probe ${pid}`, { error: `referenced probe ${pid} does not exist` });
        errorPart = errorPart || part;
        continue;
      }
      const v = pr.status === 'PASS';
      if (!v) failedProbeParts.push(pid);
      details.push({ part, met: v, source: `probe ${pid}`, status: pr.status });
      met = met && v;
      continue;
    }
    if (part.startsWith('$.') || part === '$') {
      const s = await sampleState(ctx.page);
      if (!s.ok) {
        fail(part, 'state', { error: s.error });
        errorPart = errorPart || part;
        continue;
      }
      const r = evalJq(part, s.value ?? {});
      if (!r.ok) {
        fail(part, 'state', { error: r.error });
        errorPart = errorPart || part;
        continue;
      }
      const v = r.value === true;
      details.push({ part, met: v, source: 'state', value: r.value });
      met = met && v;
      continue;
    }
    if (part === 'true') { details.push({ part, met: true, source: 'literal' }); continue; }
    fail(part, 'unknown', { error: 'unrecognized precondition syntax' });
    errorPart = errorPart || part;
  }
  const outcome = errorPart ? 'ERROR' : met ? 'PASS' : 'FAIL';
  return { met, outcome, details, failedProbeParts, errorPart };
}

/** Best-effort current page URL (playwright page.url() is sync; fakes may be async). */
async function currentPageUrl(page) {
  try {
    if (typeof page?.url === 'function') {
      const u = page.url();
      return typeof u?.then === 'function' ? await u : u;
    }
  } catch { /* fall through */ }
  try {
    if (typeof page?.evaluate === 'function') {
      return await Promise.race([page.evaluate(() => location.href), sleep(1500).then(() => null)]);
    }
  } catch { /* fall through */ }
  return null;
}

/** Liveness probe for the cascade rule: FAIL-precondition probes still run when the page survives. */
async function pageAlive(page) {
  try {
    if (typeof page?.evaluate !== 'function') return true; // cannot probe -> assume alive, let the probe body surface the error
    const v = await Promise.race([page.evaluate(() => true), sleep(2500).then(() => 'timeout')]);
    return v === true;
  } catch {
    return false;
  }
}

/**
 * Execute all probes of a spec sequentially.
 * ctx = {page, viewport, appReady, networkSince(tsIso), outShot(name, frame),
 *        shotDir, probeIdPrefix,
 *        diagnostic?,                  // true: unknown regions degrade (never for scoring)
 *        probeMeta?,                   // {fullPassDeps: {probeId: [depProbeIds]}} hard state deps
 *        downloads?,                   // array or () -> array of {filename,bytes,error}
 *        consoleSince?(tsIso),         // () -> console entries since ts
 *        consoleEntries?}              // flat array fallback
 * Returns {results, byId, passed, passedWeight, totalWeight}.
 */
export async function runProbes(spec, ctx) {
  const results = [];
  const byId = new Map();
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const getState = () => sampleState(ctx.page).then((s) => s.value ?? {});
  const sessionStartTs = isoNow();
  const firstUrl = await currentPageUrl(ctx.page);
  const urlLog = firstUrl != null ? [{ ts: sessionStartTs, url: firstUrl }] : [];
  const fullPassDeps = ctx?.probeMeta?.fullPassDeps ?? {};

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
      startedTs,
      precondition: null,
      action: { raw: probe.action ?? null, steps: [], durationMs: 0 },
      stateAssertion: null,
      visualAssertion: null,
      evidence: { stateBefore: null, stateAfter: null, shots, networkSince: [] },
      timings: {},
    };

    // NOT_APPLICABLE: the spec itself disabled this probe (excluded from S2
    // weights; recorded so evidence chains stay complete).
    if (probe.enabled === false) {
      result.status = 'NOT_APPLICABLE';
      result.note = 'probe.enabled === false';
      result.timings.totalMs = Date.now() - t0;
      results.push(result);
      byId.set(probeId, result);
      continue;
    }

    // Hard state dependencies (opts.probeMeta.fullPassDeps[probeId]): any
    // listed predecessor not PASS -> SKIPPED_BY_DEPENDENCY.
    const hardDeps = Array.isArray(fullPassDeps[probeId]) ? fullPassDeps[probeId].map(String) : [];
    if (hardDeps.length) {
      const notPassed = hardDeps.filter((d) => byId.get(d)?.status !== 'PASS');
      if (notPassed.length) {
        result.status = 'SKIPPED_BY_DEPENDENCY';
        result.skippedBy = { kind: 'fullPassDeps', notPassed };
        result.timings.totalMs = Date.now() - t0;
        results.push(result);
        byId.set(probeId, result);
        continue;
      }
    }

    try {
      // -- precondition (three-way cascade)
      if (probe.precondition) {
        const pre = await checkPrecondition(probe.precondition, { ...ctx, getState }, byId);
        result.precondition = { expr: probe.precondition, met: pre.met, outcome: pre.outcome, details: pre.details };
        if (pre.outcome === 'ERROR') {
          result.status = 'SKIPPED_BY_DEPENDENCY';
          result.skippedBy = { kind: 'precondition-error', part: pre.errorPart };
          result.timings.totalMs = Date.now() - t0;
          results.push(result);
          byId.set(probeId, result);
          continue;
        }
        if (!pre.met) {
          const alive = await pageAlive(ctx.page);
          if (!alive) {
            result.status = 'SKIPPED_BY_DEPENDENCY';
            result.skippedBy = { kind: 'precondition-fail-page-dead' };
            result.timings.totalMs = Date.now() - t0;
            results.push(result);
            byId.set(probeId, result);
            continue;
          }
          // FAIL but page alive: run anyway, keeping the evidence chain alive
          // and marking that the predecessor did not hold.
          result.ranDespitePredecessor = true;
          result.predecessor = pre.failedProbeParts[0] ?? (pre.details.find((d) => !d.met)?.part ?? null);
          result.failedPreconditionParts = pre.details.filter((d) => !d.met).map((d) => d.part);
        }
      }

      const nowUrl = await currentPageUrl(ctx.page);
      if (nowUrl != null) urlLog.push({ ts: isoNow(), url: nowUrl });

      const vctx = {
        page: ctx.page,
        viewport: ctx.viewport,
        getState,
        diagnostic: ctx.diagnostic === true,
        networkSince: typeof ctx.networkSince === 'function' ? ctx.networkSince : null,
        downloads: ctx.downloads ?? null,
        consoleSince: typeof ctx.consoleSince === 'function' ? ctx.consoleSince : null,
        consoleEntries: Array.isArray(ctx.consoleEntries) ? ctx.consoleEntries : null,
        urlLog,
        byId,
        startedTs,
        sessionStartTs,
        probeMeta: ctx.probeMeta ?? null,
      };

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
        const verr = String(result.visualAssertion.error || '');
        // SPEC_INVALID / UNSUPPORTED_BY_ENV are harness/spec/environment
        // problems, not implementation failures of the run under test.
        if (verr.startsWith('SPEC_INVALID') || verr.startsWith('UNSUPPORTED_BY_ENV')) result.status = 'ERROR';
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

  // NOT_APPLICABLE probes are excluded from the S2 weight denominator (the
  // spec author disabled them); everything else — including
  // SKIPPED_BY_DEPENDENCY — keeps the pre-rectification denominator behavior.
  const scored = results.filter((r) => r.status !== 'NOT_APPLICABLE');
  const passed = scored.filter((r) => r.status === 'PASS').length;
  const passedWeight = scored.filter((r) => r.status === 'PASS').reduce((a, r) => a + r.weight, 0);
  const totalWeight = scored.reduce((a, r) => a + r.weight, 0);
  return { results, byId, passed, passedWeight, totalWeight };
}

/** Reset the app via the contract (used for lifecycle checks outside probes). */
export { callReset };

// ============================================================================
// 7. Spec dry-run (no browser): parse every action / assertion / visual params
// ============================================================================

/** Probe-level keys the executor understands; anything else is flagged (audit: PARTIAL). */
export const KNOWN_PROBE_KEYS = [
  'probeId', 'precondition', 'action', 'waitMs', 'sampleWindowMs',
  'stateAssertion', 'visualAssertion', 'weight', 'threshold', 'evidence', 'enabled',
];

/** Static grammar check of a precondition expression (subset of checkPrecondition). */
export function checkPreconditionSyntax(pre) {
  const problems = [];
  for (const part of String(pre).split('&&').map((s) => s.trim()).filter(Boolean)) {
    if (part === '__appReady' || part === 'true') continue;
    if (/^P\d+(?:\s+passed)?$/i.test(part)) continue;
    if (part.startsWith('$.') || part === '$') {
      const c = checkJq(part);
      if (!c.ok) problems.push(`precondition part unparsable: "${part}" (${c.error})`);
      continue;
    }
    problems.push(`unrecognized precondition part: "${part}"`);
  }
  return problems;
}

/**
 * Browserless dry-run of a spec against the executor vocabulary.
 * Flags (as {ok:false, problems:[...]} entries):
 *   * action strings that do not parse against the verb table;
 *   * stateAssertion jq that does not parse;
 *   * unknown visualAssertion.type;
 *   * unknown params keys per type (VISUAL_PARAM_KEYS whitelist);
 *   * invalid values for enumerated params (metric / level);
 *   * missing required params (VISUAL_REQUIRED_PARAMS);
 *   * unknown region forms (LEGAL_REGION_FORMS via classifyRegionForm);
 *   * unknown probe-level keys and precondition syntax.
 * Keeps the legacy {briefId, probeCount, allOk, probes[]} shape (validate.mjs
 * reads allOk + probes[].ok; selftest prints action/stateAssertion/visual
 * sub-entries) and adds per-probe `problems` plus a flattened top-level list.
 */
export async function dryRunSpec(spec) {
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const out = {
    briefId: spec?.briefId ?? null,
    briefVersion: spec?.briefVersion ?? null,
    probeCount: probes.length,
    allOk: true,
    problems: [],
    probes: [],
  };
  for (const probe of probes) {
    const problems = [];
    for (const k of Object.keys(probe ?? {})) {
      if (!KNOWN_PROBE_KEYS.includes(k)) problems.push(`unknown probe key "${k}"`);
    }
    const entry = { probeId: probe.probeId, action: { ok: false }, stateAssertion: null, visualAssertion: null, problems, ok: true };
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
      problems.push(`action unparsable: ${e.message}`);
    }
    if (probe.precondition != null) {
      problems.push(...checkPreconditionSyntax(probe.precondition));
    }
    if (probe.stateAssertion?.jq) {
      const c = checkJq(probe.stateAssertion.jq);
      entry.stateAssertion = { expr: probe.stateAssertion.jq, ok: c.ok, error: c.error || null };
      if (!c.ok) problems.push(`stateAssertion unparsable: ${c.error}`);
    }
    if (probe.visualAssertion) {
      const va = probe.visualAssertion;
      const cls = classifyVisualAssertion(va);
      problems.push(...cls.problems);
      const params = va.params && typeof va.params === 'object' && !Array.isArray(va.params) ? va.params : {};
      const regionStr = typeof (params.region ?? params.regions) === 'string' ? String(params.region ?? params.regions) : JSON.stringify(params.region ?? params.regions ?? 'full');
      entry.visualAssertion = {
        type: va.type,
        ok: cls.problems.length === 0,
        error: cls.problems.length ? cls.problems.join('; ') : null,
        region: regionStr,
        dynamicRegion: /state\.|ui[#=]/.test(regionStr) || !!cls.regionClass?.dynamic,
        unknownParamKeys: cls.unknownParamKeys,
        unknownRegions: cls.unknownRegions,
        thresholds: {
          minLitPixelRatio: params.minLitPixelRatio ?? params.minCoverage ?? null,
          minMotionPixelRatio: params.minMotionPixelRatio ?? null,
          minDiffPixelRatio: params.minDiffPixelRatio ?? params.minChangedRatio ?? null,
          spanMs: params.spanMs ?? params.frameGapMs ?? null,
        },
      };
    }
    entry.problems = problems;
    entry.ok = problems.length === 0 && entry.action.ok && (entry.stateAssertion ? entry.stateAssertion.ok : true);
    if (!entry.ok) {
      out.allOk = false;
      for (const p of problems) out.problems.push(`${probe.probeId ?? '?'}: ${p}`);
    }
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
