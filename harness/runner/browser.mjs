#!/usr/bin/env node
// browser.mjs — playwright-core wrapper: launch config detection, persistent
// context with a fresh temp userDataDir, 1280x720 viewport, console collection,
// __appReady wait, rAF-based FPS sampling, download events, clean teardown.
//
//   node runner/browser.mjs --detect [--force]   # write/update launch-config.json
//
// launch-config.json (next to this file's parent, i.e. harness/):
//   { executablePath, headless, viewport, args, webgl2:{ok,version,renderer}, swiftshaderFallback, detectedAt }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { isoNow, parseArgv, writeJson, sleep } from './util.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCH_CONFIG_PATH = path.join(HARNESS_DIR, 'launch-config.json');
export const VIEWPORT = { width: 1280, height: 720 };
const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** Ordered list of candidate browser executables (Chrome first, then playwright chromium). */
export function browserCandidates() {
  const cands = [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) {
    const pwDir = path.join(local, 'ms-playwright');
    // chromium-* full builds first (headless shell lacks some media paths)
    try {
      const subs = fs
        .readdirSync(pwDir)
        .filter((n) => /^chromium(-\d+)?$/.test(n))
        .sort()
        .reverse();
      for (const s of subs) cands.push(path.join(pwDir, s, 'chrome-win64', 'chrome.exe'));
      for (const s of subs) cands.push(path.join(pwDir, s, 'chrome-win', 'chrome.exe'));
      const shells = fs
        .readdirSync(pwDir)
        .filter((n) => /^chromium_headless_shell(-\d+)?$/.test(n))
        .sort()
        .reverse();
      for (const s of shells) {
        cands.push(path.join(pwDir, s, 'chrome-win64', 'headless_shell.exe'));
        cands.push(path.join(pwDir, s, 'chrome-win', 'headless_shell.exe'));
      }
    } catch {
      /* ms-playwright dir may not exist */
    }
  }
  return cands.filter(Boolean);
}

async function tryLaunch(executablePath, args) {
  const ctx = await chromium.launchPersistentContext(await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-profile-')), {
    executablePath,
    headless: true,
    viewport: VIEWPORT,
    args,
    timeout: 30000,
  });
  return ctx;
}

async function probeWebgl2(ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        version: String(gl.getParameter(gl.VERSION)),
        renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Detect a working browser + args combination and write launch-config.json.
 * Order: default args first; if WebGL2 is unavailable, retry with swiftshader flags.
 */
export async function detectLaunchConfig({ force = false } = {}) {
  if (!force && fs.existsSync(LAUNCH_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(LAUNCH_CONFIG_PATH, 'utf8'));
      if (cfg && cfg.executablePath && fs.existsSync(cfg.executablePath)) return cfg;
    } catch {
      /* fall through to re-detect */
    }
  }
  const attempts = [];
  for (const exe of browserCandidates()) {
    if (!fs.existsSync(exe)) continue;
    for (const [label, args] of [['default', []], ['swiftshader', SWIFTSHADER_ARGS]]) {
      let ctx = null;
      try {
        ctx = await tryLaunch(exe, args);
        const webgl2 = await probeWebgl2(ctx);
        if (webgl2.ok) {
          const cfg = {
            executablePath: exe,
            headless: true,
            viewport: VIEWPORT,
            args,
            argProfile: label,
            webgl2,
            swiftshaderFallback: label === 'swiftshader',
            detectedAt: isoNow(),
            notes:
              label === 'swiftshader'
                ? 'WebGL2 unavailable with default ANGLE; using --use-angle=swiftshader --enable-unsafe-swiftshader'
                : 'Chrome with default ANGLE backend; WebGL2 OK',
          };
          writeJson(LAUNCH_CONFIG_PATH, cfg);
          return cfg;
        }
        attempts.push({ exe, args: label, webgl2 });
      } catch (err) {
        attempts.push({ exe, args: label, error: err.message });
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }
    }
  }
  const err = new Error('No usable browser found (tried: ' + JSON.stringify(attempts) + ')');
  err.attempts = attempts;
  throw err;
}

export async function ensureLaunchConfig() {
  return detectLaunchConfig({ force: false });
}

/**
 * Harness browser session. One persistent context per launch, fresh temp
 * userDataDir, 1280x720. All resources cleaned in close().
 */
export class HarnessBrowser {
  constructor() {
    this.cfg = null;
    this.context = null;
    this.userDataDir = null;
    this.launchOptionsUsed = null;
  }

  /** Launch with the detected config (or overrides). opts: {args, videoDir} */
  async launch(opts = {}) {
    this.cfg = await ensureLaunchConfig();
    this.userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-profile-'));
    const launchOpts = {
      executablePath: opts.executablePath || this.cfg.executablePath,
      headless: opts.headless ?? true,
      viewport: VIEWPORT,
      args: opts.args ?? this.cfg.args ?? [],
      timeout: 30000,
    };
    if (opts.videoDir) launchOpts.recordVideo = { dir: opts.videoDir, size: VIEWPORT };
    this.launchOptionsUsed = { ...launchOpts, recordVideo: !!opts.videoDir };
    this.context = await chromium.launchPersistentContext(this.userDataDir, launchOpts);
    return this;
  }

  /** New page at the frozen viewport. */
  async newPage() {
    if (!this.context) throw new Error('browser not launched');
    const page = this.context.pages()[0] || (await this.context.newPage());
    await page.setViewportSize(VIEWPORT).catch(() => {});
    page.setDefaultTimeout(15000);
    return page;
  }

  /**
   * Attach console + pageerror collectors. Returns a live collector handle.
   * entry = {ts, type:'error'|'warning'|'log'|'info'|'debug', text, url, line}
   * uncaught = {ts, message, stack}
   */
  collectConsole(page) {
    const collector = {
      entries: [],
      uncaught: [],
      requests: [],
      downloads: [],
      downloadWaiters: [],
    };
    page.on('console', (msg) => {
      const type = msg.type();
      let loc = {};
      try {
        loc = msg.location() || {};
      } catch { /* ignore */ }
      collector.entries.push({
        ts: isoNow(),
        type: ['error', 'warning'].includes(type) ? type : type === 'warn' ? 'warning' : type,
        text: msg.text(),
        url: loc.url || null,
        line: loc.lineNumber ?? null,
      });
    });
    page.on('pageerror', (err) => {
      collector.uncaught.push({ ts: isoNow(), message: err?.message || String(err), stack: err?.stack || null });
    });
    page.on('request', (req) => {
      collector.requests.push({ ts: isoNow(), method: req.method(), url: req.url() });
    });
    page.on('download', (dl) => {
      const rec = { ts: isoNow(), filename: dl.suggestedFilename(), savedTo: null, bytes: null };
      collector.downloads.push(rec);
      collector.downloadWaiters.push(
        (async () => {
          try {
            const dir = path.join(HARNESS_DIR, '.downloads-tmp');
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, `${Date.now()}-${rec.filename}`);
            await dl.saveAs(target);
            rec.savedTo = target;
            rec.bytes = fs.statSync(target).size;
          } catch (e) {
            rec.error = e.message;
          }
        })()
      );
    });
    return collector;
  }

  /** Wait for window.__appReady === true (10s default) and check __bench contract. */
  async waitForAppReady(page, timeoutMs = 10000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 <= timeoutMs) {
      try {
        last = await page.evaluate(() => ({
          ready: window.__appReady === true,
          bench: !!(
            window.__bench &&
            typeof window.__bench.getState === 'function' &&
            typeof window.__bench.reset === 'function'
          ),
        }));
        if (last.ready) return { appReady: true, benchReady: last.bench, durationMs: Date.now() - t0 };
      } catch {
        /* page not ready for evaluation yet */
      }
      await sleep(200);
    }
    return { appReady: false, benchReady: last?.bench ?? false, durationMs: Date.now() - t0 };
  }

  /** Sample FPS by counting requestAnimationFrame ticks for `ms` (default 3000). */
  async sampleFps(page, ms = 3000) {
    const r = await page.evaluate(
      (windowMs) =>
        new Promise((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            frames++;
            if (performance.now() - start < windowMs) requestAnimationFrame(tick);
            else resolve({ frames, ms: performance.now() - start, rafSupported: true });
          };
          requestAnimationFrame(tick);
        }),
      ms
    );
    const fps = r.ms > 0 ? (r.frames * 1000) / r.ms : 0;
    return { fps: Math.round(fps * 10) / 10, frames: r.frames, sampleMs: Math.round(r.ms), sampledAt: isoNow() };
  }

  /** Close context + remove temp userDataDir. Always safe to call twice. */
  async close() {
    const errors = [];
    if (this.context) {
      try {
        await this.context.close();
      } catch (e) {
        errors.push(e.message);
      }
      this.context = null;
    }
    if (this.userDataDir) {
      try {
        await fsp.rm(this.userDataDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(e.message);
      }
      this.userDataDir = null;
    }
    if (errors.length) process.stderr.write('[browser] close warnings: ' + errors.join('; ') + '\n');
  }
}

// --- CLI ---
const argv = parseArgv(process.argv.slice(2));
if (argv.detect) {
  try {
    const cfg = await detectLaunchConfig({ force: !!argv.force });
    process.stdout.write(JSON.stringify({ ok: true, configPath: LAUNCH_CONFIG_PATH, config: cfg }, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`detection failed: ${e.message}\n`);
    process.exit(1);
  }
}
