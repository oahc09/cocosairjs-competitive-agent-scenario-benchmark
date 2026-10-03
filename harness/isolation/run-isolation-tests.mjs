#!/usr/bin/env node
// isolation/run-isolation-tests.mjs — G2 ISOLATION 串扰/隔离测试(M3)
// T1 workspace 泄漏(marker 互不可见 + 阳性对照)
// T2 浏览器隔离(双 userDataDir localStorage 不串;playwright-core 不可用 → SKIPPED-DEPENDENCY)
// T3 dev server 隔离(独立端口、A 的 404 不影响 B、A 停止后 B 仍服务)
// T4 答案泄漏扫描(leak-scanner:干净 PASS / 注入违规必 FAIL)
// T5 牺牲性 marker(bench/secret/reference-marker.txt;产物含 token 必检出)
// 输出 bench/gates/G2.json。零依赖(除可选的 harness node_modules playwright-core)。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from './leak-scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = path.resolve(__dirname, '..');
const GATES_DIR = path.join(BENCH_ROOT, 'gates');
const SECRET_DIR = path.join(BENCH_ROOT, 'secret');
const MINI_SERVE = path.join(__dirname, 'mini-serve.mjs');

const randHex = (n = 32) => crypto.randomBytes(n).toString('hex');
const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

/** 在 dir 下递归找含 token 的文件(返回 [{file,line}])。 */
function grepToken(dir, token) {
  const hits = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else {
        try {
          const buf = fs.readFileSync(abs);
          if (buf.includes(Buffer.from(token, 'utf8'))) {
            hits.push({ file: path.relative(dir, abs).split(path.sep).join('/') });
          }
        } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return hits;
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function allocFreePorts(count, base) {
  const ports = [];
  let p = base;
  while (ports.length < count) {
    if (await checkPortFree(p)) ports.push(p);
    p += 1;
  }
  return ports;
}

/** 启动 mini-serve 并等 listening 行。 */
function startMiniServe(root, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MINI_SERVE, '--root', root, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`mini-serve port=${port} 5s 内未 listening`)), 5000);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        if (line.includes('"event":"listening"')) {
          clearTimeout(timer);
          resolve(child);
          return;
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mini-serve 提前退出 code=${code}`)); });
  });
}

function killChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } resolve(); }, 1500);
  });
}

async function fetchSafe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, error: String(e.cause?.code || e.code || e.message) };
  }
}

// ---------------------------------------------------------------------------
// T1 workspace 泄漏
// ---------------------------------------------------------------------------
function testT1() {
  const tmp = mkdtemp('bench-g2-t1-');
  const tokenA = `T1-MARKER-A-${randHex(16)}`;
  const tokenB = `T1-MARKER-B-${randHex(16)}`;
  const armA = path.join(tmp, 'arm-a');
  const armB = path.join(tmp, 'arm-b');
  const armDirty = path.join(tmp, 'arm-c-contaminated');

  for (const [dir, token] of [[armA, tokenA], [armB, tokenB]]) {
    fs.mkdirSync(path.join(dir, 'workspace', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, `marker-${token.includes('-A-') ? 'a' : 'b'}-${randHex(4)}.txt`),
      `sacrificial workspace marker\nidentity=${token}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'workspace', 'src', 'app.js'),
      `// benign app code\nexport const version = "1.0.0";\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'workspace', 'WORKLOG.md'),
      `# WORKLOG\n- ${nowIso()} | init | ok\n`, 'utf8');
  }
  // 阳性对照:被污染的"C 侧"故意包含 B 的 token
  fs.mkdirSync(path.join(armDirty, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(armDirty, 'workspace', 'leaked.js'),
    `// stolen from the other arm\nconst other = "${tokenB}";\n`, 'utf8');

  const aSeesB = grepToken(armA, tokenB);
  const bSeesA = grepToken(armB, tokenA);
  const dirtyDetected = grepToken(armDirty, tokenB);

  rmTemp(tmp);
  const pass = aSeesB.length === 0 && bSeesA.length === 0 && dirtyDetected.length > 0;
  return {
    id: 'T1',
    desc: 'workspace 泄漏:双 Arm 各放随机 marker,扫描双方全部产物文件内容不得含对方 token;阳性对照(故意污染目录)必须被检出',
    status: pass ? 'PASS' : 'FAIL',
    evidence: {
      method: '两临时 arm 目录 + 随机 token marker;grepToken 全产物内容扫描(与 run 后产物扫描同机制)',
      armA_sees_tokenB: aSeesB,
      armB_sees_tokenA: bSeesA,
      positiveControl_armC_sees_tokenB: dirtyDetected,
      tokensSha256: { a: sha256(tokenA), b: sha256(tokenB) },
    },
  };
}

// ---------------------------------------------------------------------------
// T2 浏览器隔离(可选依赖 playwright-core)
// ---------------------------------------------------------------------------
async function testT2() {
  let pw;
  try {
    const require = createRequire(path.join(HARNESS_ROOT, 'package.json'));
    pw = require('playwright-core');
  } catch (e) {
    return {
      id: 'T2',
      desc: '浏览器隔离:双 userDataDir 各写 localStorage 再互读,断言不可见',
      status: 'SKIPPED-DEPENDENCY',
      evidence: {
        reason: 'playwright-core 未安装于 harness node_modules(harness npm 工程由并行 Agent 建设);按协议不自行安装',
        resolution: 'harness `npm install` 完成后重跑 `node isolation/run-isolation-tests.mjs` 补齐 T2',
        resolveError: String(e.message).slice(0, 200),
      },
    };
  }

  const tmp = mkdtemp('bench-g2-t2-');
  const root = path.join(tmp, 'site');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 't2.html'),
    '<!doctype html><html><body>g2-t2</body></html>\n', 'utf8');
  const [port] = await allocFreePorts(1, 7250);
  const server = await startMiniServe(root, port);
  const url = `http://127.0.0.1:${port}/t2.html`;

  const profA = path.join(tmp, 'profile-a');
  const profB = path.join(tmp, 'profile-b');
  const tokenA = `T2-LS-A-${randHex(16)}`;
  const tokenB = `T2-LS-B-${randHex(16)}`;
  const exec = { a: null, b: null };
  try {
    // bundled browser 不可用时降级尝试系统 Chrome channel;profile 目录始终用 profA/profB(隔离变量)
    const launchWithFallback = async (profileDir) => {
      try {
        return await pw.chromium.launchPersistentContext(profileDir, { headless: true });
      } catch (e1) {
        try {
          return await pw.chromium.launchPersistentContext(profileDir, { headless: true, channel: 'chrome' });
        } catch (e2) {
          throw new Error(`launch 失败(bundled: ${String(e1.message).split('\n')[0]}; chrome-channel: ${String(e2.message).split('\n')[0]})`);
        }
      }
    };
    const ctxA = await launchWithFallback(profA);
    const ctxB = await launchWithFallback(profB);
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto(url);
      await pageB.goto(url);
      await pageA.evaluate((t) => localStorage.setItem('g2t2', t), tokenA);
      const bReadsA = await pageB.evaluate(() => localStorage.getItem('g2t2'));
      await pageB.evaluate((t) => localStorage.setItem('g2t2', t), tokenB);
      const aReadsOwn = await pageA.evaluate(() => localStorage.getItem('g2t2'));
      const bReadsOwn = await pageB.evaluate(() => localStorage.getItem('g2t2'));
      exec.bReadsA = bReadsA;         // 期望 null
      exec.aReadsOwn = aReadsOwn;     // 期望 tokenA
      exec.bReadsOwn = bReadsOwn;     // 期望 tokenB
      const pass = bReadsA === null && aReadsOwn === tokenA && bReadsOwn === tokenB;
      return {
        id: 'T2',
        desc: '浏览器隔离:双 userDataDir 各写 localStorage 再互读,断言不可见',
        status: pass ? 'PASS' : 'FAIL',
        evidence: {
          method: `playwright-core chromium × 2 launchPersistentContext(独立 userDataDir)访问同一 URL ${url}`,
          B读取A写入: bReadsA,
          A读回自身: aReadsOwn === tokenA,
          B读回自身: bReadsOwn === tokenB,
          tokensSha256: { a: sha256(tokenA), b: sha256(tokenB) },
        },
      };
    } finally {
      await ctxA.close().catch(() => {});
      await ctxB.close().catch(() => {});
    }
  } catch (e) {
    return {
      id: 'T2',
      desc: '浏览器隔离:双 userDataDir 各写 localStorage 再互读,断言不可见',
      status: 'SKIPPED-DEPENDENCY',
      evidence: {
        reason: 'playwright-core 已安装但 chromium 无法启动(浏览器可执行文件缺失),等同依赖缺失',
        error: String(e.message).slice(0, 300),
        resolution: '安装 playwright chromium(或系统 Chrome channel 可用)后重跑本测试',
      },
    };
  } finally {
    await killChild(server);
    rmTemp(tmp);
  }
}

// ---------------------------------------------------------------------------
// T3 dev server 隔离
// ---------------------------------------------------------------------------
async function testT3() {
  const tmp = mkdtemp('bench-g2-t3-');
  const rootA = path.join(tmp, 'a');
  const rootB = path.join(tmp, 'b');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  const markerA = `T3-A-${randHex(8)}`;
  const markerB = `T3-B-${randHex(8)}`;
  fs.writeFileSync(path.join(rootA, 'index.html'), `<html>a:${markerA}</html>\n`, 'utf8');
  fs.writeFileSync(path.join(rootA, 'only-in-a.txt'), `content ${markerA}\n`, 'utf8');
  fs.writeFileSync(path.join(rootB, 'index.html'), `<html>b:${markerB}</html>\n`, 'utf8');
  fs.writeFileSync(path.join(rootB, 'only-in-b.txt'), `content ${markerB}\n`, 'utf8');

  const [pA, pB] = await allocFreePorts(2, 7200);
  let serverA, serverB;
  const steps = [];
  try {
    serverA = await startMiniServe(rootA, pA);
    serverB = await startMiniServe(rootB, pB);

    const r1 = await fetchSafe(`http://127.0.0.1:${pA}/only-in-a.txt`); // A 服务自身文件
    steps.push({ step: 'A 端口取 A 文件', expect: '200', got: r1.ok ? r1.status : r1.error, pass: r1.ok && r1.status === 200 });
    const r2 = await fetchSafe(`http://127.0.0.1:${pB}/only-in-a.txt`); // B 端口取 A 独有文件 → 404
    steps.push({ step: 'B 端口取 A 独有文件', expect: '404', got: r2.ok ? r2.status : r2.error, pass: r2.ok && r2.status === 404 });
    const r3 = await fetchSafe(`http://127.0.0.1:${pA}/only-in-b.txt`); // A 端口取 B 独有文件 → 404
    steps.push({ step: 'A 端口取 B 独有文件', expect: '404', got: r3.ok ? r3.status : r3.error, pass: r3.ok && r3.status === 404 });
    const r4 = await fetchSafe(`http://127.0.0.1:${pB}/only-in-b.txt`);
    steps.push({ step: 'B 端口取 B 文件', expect: '200', got: r4.ok ? r4.status : r4.error, pass: r4.ok && r4.status === 200 });

    // 杀掉 A:B 不受影响;再访问 A 端口 → 连接拒绝
    await killChild(serverA);
    serverA = null;
    await new Promise((r) => setTimeout(r, 300));
    const r5 = await fetchSafe(`http://127.0.0.1:${pA}/only-in-a.txt`);
    const refused = !r5.ok && /ECONNREFUSED|ECONNRESET|aborted|fetch failed/i.test(String(r5.error));
    steps.push({ step: 'A 停止后访问 A 端口', expect: 'ECONNREFUSED', got: r5.ok ? r5.status : r5.error, pass: refused });
    const r6 = await fetchSafe(`http://127.0.0.1:${pB}/only-in-b.txt`);
    steps.push({ step: 'A 停止后 B 端口取 B 文件', expect: '200', got: r6.ok ? r6.status : r6.error, pass: r6.ok && r6.status === 200 });

    const pass = steps.every((s) => s.pass);
    return {
      id: 'T3',
      desc: 'dev server 隔离:双 serve 独立端口,A 的文件在 B 端口 404、B 的文件在 A 端口 404;A 停止后 A 端口连接拒绝且 B 不受影响',
      status: pass ? 'PASS' : 'FAIL',
      evidence: { ports: { A: pA, B: pB }, server: 'isolation/mini-serve.mjs', steps },
    };
  } catch (e) {
    return {
      id: 'T3',
      desc: 'dev server 隔离:双 serve 独立端口互不可见、单侧停止不影响另一侧',
      status: 'FAIL',
      evidence: { error: String(e.message || e).slice(0, 300), steps },
    };
  } finally {
    if (serverA) await killChild(serverA);
    if (serverB) await killChild(serverB);
    rmTemp(tmp);
  }
}

// ---------------------------------------------------------------------------
// T4 答案泄漏扫描
// ---------------------------------------------------------------------------
function testT4() {
  const tmp = mkdtemp('bench-g2-t4-');
  const clean = path.join(tmp, 'workspace-clean');
  fs.mkdirSync(path.join(clean, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clean, 'index.html'), '<!doctype html><html><body><canvas id="scene"></canvas></body></html>\n', 'utf8');
  fs.writeFileSync(path.join(clean, 'src', 'app.js'), '// benign app\nconst canvas = document.getElementById("scene");\n', 'utf8');
  fs.writeFileSync(path.join(clean, 'package.json'), '{"name":"t4-clean","version":"1.0.0","private":true}\n', 'utf8');

  const cleanResult = scanWorkspace(clean, { peerArm: 'arm-b' });

  // 注入违规:假 reference 内容 + validator.mjs + 另一 arm 路径 + secret 路径
  const dirty = path.join(tmp, 'workspace-dirty');
  fs.mkdirSync(path.join(dirty, 'src'), { recursive: true });
  fs.cpSync(clean, dirty, { recursive: true });
  fs.writeFileSync(path.join(dirty, 'src', 'reference-answer.js'),
    '// copied from bench/reference/private/three/E01/solution.js (cheating)\nexport const answer = "spiral-galaxy-params";\n', 'utf8');
  fs.writeFileSync(path.join(dirty, 'validator.mjs'),
    '// harness/runner/validate.mjs patched copy — force probes PASS\nexport const probe-results.json = true;\n', 'utf8');
  fs.writeFileSync(path.join(dirty, 'NOTES.md'),
    '# notes\npeer workspace at ../arm-b/workspace has a working solution\nsecret marker at bench/secret/reference-marker.txt\n', 'utf8');

  const dirtyResult = scanWorkspace(dirty, { peerArm: 'arm-b' });
  const ruleIds = new Set(dirtyResult.violations.map((v) => v.rule));
  const expectedRules = ['R1-REFERENCE-PATH', 'R2-HARNESS-SOURCE', 'R3-PEER-ARM', 'R4-SECRET-PATH'];
  const allRulesHit = expectedRules.every((r) => ruleIds.has(r));

  rmTemp(tmp);
  const pass = cleanResult.status === 'CLEAN' && dirtyResult.status === 'VIOLATIONS' && allRulesHit;
  return {
    id: 'T4',
    desc: '答案泄漏扫描:干净 workspace 报 CLEAN;注入 reference 假内容 + validator.mjs + 对方 arm 路径 + secret 路径后,leak-scanner 必须报 VIOLATIONS 且四条规则全部命中',
    status: pass ? 'PASS' : 'FAIL',
    evidence: {
      scanner: 'isolation/leak-scanner.mjs',
      clean: { status: cleanResult.status, files: cleanResult.stats.files, scanned: cleanResult.stats.scannedFiles },
      dirty: {
        status: dirtyResult.status,
        hitRules: [...ruleIds],
        violations: dirtyResult.violations.map((v) => `${v.rule} @ ${v.file}:${v.line}`),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// T5 牺牲性 marker
// ---------------------------------------------------------------------------
function testT5() {
  fs.mkdirSync(SECRET_DIR, { recursive: true });
  const markerPath = path.join(SECRET_DIR, 'reference-marker.txt');
  const token = `SACRIFICIAL-REFERENCE-MARKER-${randHex(24)}`;
  const content = `${token}\n` +
    `(sacrificial crosstalk marker, rotated by G2 isolation test at ${nowIso()})\n` +
    `Any Agent-run artifact/log containing the token above = INVALID_RUN (failure-taxonomy §2.20).\n`;
  fs.writeFileSync(markerPath, content, 'utf8');

  // 模拟 run 产物:干净产物不得命中;被污染产物必须命中
  const tmp = mkdtemp('bench-g2-t5-');
  const cleanArt = path.join(tmp, 'artifacts-clean');
  const dirtyArt = path.join(tmp, 'artifacts-dirty');
  fs.mkdirSync(cleanArt, { recursive: true });
  fs.mkdirSync(dirtyArt, { recursive: true });
  fs.writeFileSync(path.join(cleanArt, 'console.log'), '[info] app ready\n[info] 60fps\n', 'utf8');
  fs.writeFileSync(path.join(cleanArt, 'WORKLOG.md'), '- build ok\n- browser ok\n', 'utf8');
  fs.writeFileSync(path.join(dirtyArt, 'build.log'),
    `[agent] read reference marker: ${token}\n[agent] build ok\n`, 'utf8');

  const cleanHits = grepToken(cleanArt, token);
  const dirtyHits = grepToken(dirtyArt, token);
  const markerExists = fs.existsSync(markerPath);

  rmTemp(tmp);
  const pass = markerExists && cleanHits.length === 0 && dirtyHits.length > 0;
  return {
    id: 'T5',
    desc: '牺牲性 marker:bench/secret/reference-marker.txt 存在(每次 G2 轮换随机 token);产物扫描能检出含 token 的违规产物,干净产物零误报',
    status: pass ? 'PASS' : 'FAIL',
    evidence: {
      markerPath: 'bench/secret/reference-marker.txt',
      markerExists,
      tokenSha256: sha256(token), // 不回填 token 明文,防止 marker 从本报告泄漏
      cleanArtifactsHits: cleanHits,
      dirtyArtifactsHits: dirtyHits,
      note: 'Agent Run 结束后的正式产物扫描应 grep 本 token;命中即 INVALID_RUN',
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[G2] isolation tests start at ${nowIso()}`);
  const tests = [];
  tests.push(testT1());
  tests.push(await testT2());
  tests.push(await testT3());
  tests.push(testT4());
  tests.push(testT5());

  const anyFail = tests.some((t) => t.status === 'FAIL');
  const anySkipped = tests.some((t) => t.status === 'SKIPPED-DEPENDENCY');
  const status = anyFail ? 'FAIL' : anySkipped ? 'PASS-WITH-NOTES' : 'PASS';

  const g2 = {
    gate: 'G2 ISOLATION',
    status,
    generatedAt: nowIso(),
    declaredLimitation: '策略级隔离+产物扫描,非OS强制',
    declaration: [
      '本环境文件隔离为策略级(prompt 约束 + 事后产物扫描),非 OS/沙箱/ACL 强制隔离(benchmark-contract §2.5,agents.yaml isolation.level=policy)。',
      'T1/T4/T5 验证的是"扫描机制"的检出能力与零误报;T2/T3 验证运行时资源(userDataDir/端口)隔离。',
      'G2 PASS 不等于隔离不可突破;只证明:按协议运行的 Run,其违规访问痕迹会被产物扫描检出。',
    ],
    tests,
    environment: {
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.release()}`,
      playwrightCoreAvailable: tests.find((t) => t.id === 'T2').status !== 'SKIPPED-DEPENDENCY',
    },
  };

  fs.mkdirSync(GATES_DIR, { recursive: true });
  const outPath = path.join(GATES_DIR, 'G2.json');
  fs.writeFileSync(outPath, JSON.stringify(g2, null, 2) + '\n', 'utf8');
  console.log(`[G2] ${tests.map((t) => `${t.id}:${t.status}`).join('  ')}  → overall ${status}`);
  console.log(`[G2] written ${path.relative(BENCH_ROOT, outPath)}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error('[G2] FATAL', e);
  process.exit(1);
});
