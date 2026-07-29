#!/usr/bin/env node
/**
 * IRONSIGHT performance profiler — one command, one revision-stamped JSON.
 *
 * Issue #2 recorded a baseline by hand on one workstation. That is not
 * repeatable: the next person re-runs a dozen ad-hoc measurements, formats them
 * differently, and the numbers stop being comparable. This tool turns that
 * hand-sampled baseline into a single machine-readable artifact for a NAMED
 * revision, sampling the exact same five workloads the issue measured:
 *
 *   install  — clean `npm ci` wall time + peak RSS, node_modules footprint
 *   build    — `npm run build` wall time + peak RSS, dist size, modules transformed
 *   bundle   — per-entry raw / gzip / brotli sizes, and the largest artifacts
 *   browser  — game-ready time, Navigation Timing, FCP, peak JS heap,
 *              detected tier / bake profile / workers / shader permutations,
 *              and a frame-time distribution (median / p95 / max)
 *   api      — read-only Function latency (cold vs warm), HTML + main.js TTFB
 *
 * The report is stamped with the git revision, the machine, and the node
 * version, so two reports are only ever compared when they describe the same
 * commit on the same box. It is the input to the CI budget check the issue asks
 * for next; on its own it only MEASURES — it does not gate.
 *
 *     ./tools/profile.sh                       # install+build+bundle+browser(+api if configured)
 *     ./tools/profile.sh --no-install          # skip the isolated npm ci (fast, offline)
 *     ./tools/profile.sh --no-build            # reuse the existing dist/
 *     ./tools/profile.sh --only bundle,browser # run just these sections
 *     ./tools/profile.sh --skip api            # run everything except one
 *     ./tools/profile.sh --rev <sha>           # label the report with a specific sha
 *     ./tools/profile.sh --out tools/perf/x.json
 *     ./tools/profile.sh --json                # also print the full report to stdout
 *
 * The API section is READ-ONLY by construction: it only ever issues GETs (an
 * invalid-id Function read, HTML, and the hashed main bundle). It never POSTs,
 * never writes to a database or blob store, and never touches billing — exactly
 * as issue #2 profiled production. Point it at environments with
 * IRONSIGHT_{LOCAL,STAGING,PRODUCTION}_URL, same variables as tools/netlify-smoke.mjs.
 *
 * Sections are best-effort: a section that cannot run (no network for install,
 * no playwright for browser, no URL for api) is recorded as skipped-with-reason
 * and the rest of the report is still produced. The process exits 0 whenever a
 * report was written; a non-zero exit means the tool itself could not run.
 *
 * REQUIRES node >= 20 (playwright, when the browser section runs). Invoke
 * through tools/profile.sh so node pinning matches every other harness.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const DIST = resolve(ROOT, process.env.IRONSIGHT_DIST || 'dist');
const MiB = 1024 * 1024;

/* ---------------------------------------------------------------- arg parsing */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(
    [
      'tools/profile.sh — revision-stamped performance profiler for IRONSIGHT',
      '',
      '  --rev SHA          label the report with this revision  (default: git HEAD)',
      '  --only LIST        run only these sections (comma list of',
      '                     install,build,bundle,browser,api)',
      '  --skip LIST        run everything EXCEPT these sections',
      '  --no-install       skip the isolated npm ci measurement',
      '  --no-build         reuse the existing dist/ instead of rebuilding',
      '  --frames N         browser frame-time samples to collect  (default 120)',
      '  --api-samples N    warm API samples per endpoint          (default 5)',
      '  --out PATH         report path        (default tools/perf/<shortSha>.json)',
      '  --json             also print the full report to stdout',
      '  --software-gl      force SwiftShader in the browser section',
      '',
      'Exit code is 0 whenever a report was written.',
    ].join('\n'),
  );
  process.exit(0);
}

const ALL_SECTIONS = ['install', 'build', 'bundle', 'browser', 'api'];
const onlyList = (opt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const skipList = (opt('--skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const s of [...onlyList, ...skipList]) {
  if (!ALL_SECTIONS.includes(s)) {
    console.error(`[profile] unknown section "${s}" — valid: ${ALL_SECTIONS.join(', ')}`);
    process.exit(2);
  }
}
const wants = (section) => {
  if (section === 'install' && flag('--no-install')) return false;
  if (section === 'build' && flag('--no-build')) return false;
  if (onlyList.length) return onlyList.includes(section);
  if (skipList.includes(section)) return false;
  return true;
};

const FRAMES = Number(opt('--frames', 120));
const API_SAMPLES = Number(opt('--api-samples', 5));
const SOFTWARE_GL = process.env.IRONSIGHT_SOFTWARE_GL === '1' || flag('--software-gl');
const PRINT_JSON = flag('--json');

const log = (...a) => console.log('[profile]', ...a);
const notes = [];

/* ---------------------------------------------------------------- primitives */

/** Round to `d` decimals and return a Number (so it survives JSON.stringify). */
const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const bytesToMiB = (b) => (typeof b === 'number' ? round(b / MiB, 2) : null);

/** Run a command, capture stdout+stderr, resolve with the result (never rejects). */
function run(cmd, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolvePromise({ code: -1, stdout, stderr: stderr + String(e), wallMs: performance.now() - started }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr, wallMs: performance.now() - started }));
  });
}

// `/usr/bin/time` reports peak resident set differently per platform: BSD/macOS
// prints "<bytes>  maximum resident set size"; GNU/Linux prints "Maximum
// resident set size (kbytes): N". We wrap the command in it to get a peak RSS
// figure comparable to what issue #2 sampled, and parse whichever format shows.
const HAS_TIME = existsSync('/usr/bin/time');
function parsePeakRssBytes(text) {
  let m = text.match(/(\d+)\s+maximum resident set size/i); // BSD: bytes
  if (m) return Number(m[1]);
  m = text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i); // GNU: kbytes
  if (m) return Number(m[1]) * 1024;
  return null;
}

/** Run a command under /usr/bin/time and return wall time + peak RSS in bytes. */
async function runTimed(cmd, args, opts = {}) {
  if (!HAS_TIME) {
    const r = await run(cmd, args, opts);
    return { ...r, peakRssBytes: null };
  }
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v';
  const r = await run('/usr/bin/time', [timeFlag, cmd, ...args], opts);
  return { ...r, peakRssBytes: parsePeakRssBytes(r.stderr) };
}

/** Recursively total the byte size and file count under a directory. */
async function dirStats(path) {
  let bytes = 0;
  let files = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          bytes += (await stat(p)).size;
          files += 1;
        } catch {
          /* vanished mid-walk; ignore */
        }
      }
    }
  }
  await walk(path);
  return { bytes, files };
}

/** Collect every regular file under a directory as repo-relative paths. */
async function listFiles(path) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(path);
  return out;
}

/* -------------------------------------------------------------------- meta */

async function gitMeta(revOverride) {
  const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const status = (await run('git', ['status', '--porcelain'])).stdout.trim();
  const sha = (revOverride || head).trim();
  return {
    sha,
    shortSha: sha.slice(0, 12),
    branch,
    dirty: status.length > 0,
    labelledRevision: Boolean(revOverride) && revOverride !== head,
  };
}

function machineMeta() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    logicalCpus: cpus.length,
    cpuModel: cpus[0]?.model ?? 'unknown',
    totalMemMiB: round(os.totalmem() / MiB, 0),
    node: process.version,
  };
}

/* ------------------------------------------------------------- install section
 * Measured in an ISOLATED temp dir so it never disturbs the working tree's
 * node_modules (which would wipe playwright, break a concurrent build, and take
 * minutes to restore). Copying only the manifest + lockfile and running
 * `npm ci` there is the faithful "fresh clone" cost issue #2 recorded. */
async function profileInstall() {
  const lock = join(ROOT, 'package-lock.json');
  if (!existsSync(lock)) {
    return { ok: false, skipped: true, reason: 'package-lock.json missing; npm ci cannot run reproducibly' };
  }
  const work = await mkdtemp(join(tmpdir(), 'ironsight-install-'));
  try {
    await cp(join(ROOT, 'package.json'), join(work, 'package.json'));
    await cp(lock, join(work, 'package-lock.json'));
    log('install: npm ci in an isolated temp dir (network required)…');
    const r = await runTimed('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work });
    if (r.code !== 0) {
      return {
        ok: false,
        reason: 'npm ci failed (offline? use --no-install to skip)',
        exitCode: r.code,
        stderrTail: r.stderr.split('\n').slice(-6).join('\n'),
      };
    }
    const addedMatch = r.stdout.match(/added (\d+) package/i) || r.stderr.match(/added (\d+) package/i);
    const nm = await dirStats(join(work, 'node_modules'));
    return {
      ok: true,
      wallSeconds: round(r.wallMs / 1000, 2),
      peakRssMiB: bytesToMiB(r.peakRssBytes),
      packagesAdded: addedMatch ? Number(addedMatch[1]) : null,
      nodeModulesMiB: bytesToMiB(nm.bytes),
      nodeModulesFiles: nm.files,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- build section
 * `npm run build` routes through tools/with-node.sh, which is exactly the build
 * a contributor and CI run. We time the whole tree and parse Vite's own
 * "N modules transformed" line so the module count is the bundler's truth, not
 * a re-derivation. */
async function profileBuild() {
  log('build: npm run build…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = await runTimed(npm, ['run', 'build']);
  const built = existsSync(join(DIST, 'index.html'));
  if (r.code !== 0 || !built) {
    return {
      ok: false,
      reason: 'vite build failed',
      exitCode: r.code,
      stderrTail: r.stderr.split('\n').slice(-8).join('\n'),
    };
  }
  const combined = `${r.stdout}\n${r.stderr}`;
  const modulesMatch = combined.match(/(\d+)\s+modules transformed/i);
  const dist = await dirStats(DIST);
  return {
    ok: true,
    wallSeconds: round(r.wallMs / 1000, 2),
    peakRssMiB: bytesToMiB(r.peakRssBytes),
    modulesTransformed: modulesMatch ? Number(modulesMatch[1]) : null,
    distMiB: bytesToMiB(dist.bytes),
    distFiles: dist.files,
  };
}

/* -------------------------------------------------------------- bundle section
 * Walk the built dist/. For every JS/CSS asset record raw, gzip and brotli
 * sizes. Vite fingerprints entries as `<stem>-<hash>.js`; we roll those up by
 * stem so `main`, `three`, `learn`, `forge` are directly comparable across
 * revisions even though the hash changes every build. */
function stemOf(name) {
  // Strip the extension, then a trailing "-<hash>" content fingerprint. Vite's
  // default hash is 8 base64url chars, which can itself contain a hyphen
  // (e.g. "rng-DYysN-8U.js" → hash "DYysN-8U"), so we peel exactly the trailing
  // 8-char group rather than "from the last hyphen", which would leave the hash
  // attached whenever it happened to contain one.
  const base = name.replace(/\.[^.]+$/, '');
  return base.replace(/-[A-Za-z0-9_-]{8}$/, '');
}

async function profileBundle() {
  if (!existsSync(join(DIST, 'index.html'))) {
    return { ok: false, reason: 'dist/ missing — run without --no-build first' };
  }
  const files = await listFiles(DIST);
  const assets = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!['.js', '.mjs', '.css'].includes(ext)) continue;
    const buf = await readFile(f);
    const gzip = gzipSync(buf, { level: 9 });
    const brotli = brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    });
    assets.push({
      file: relative(DIST, f),
      stem: stemOf(f.split('/').pop()),
      ext: ext.slice(1),
      rawBytes: buf.length,
      gzipBytes: gzip.length,
      brotliBytes: brotli.length,
      rawKiB: round(buf.length / 1024, 1),
      gzipKiB: round(gzip.length / 1024, 1),
      brotliKiB: round(brotli.length / 1024, 1),
    });
  }
  assets.sort((a, b) => b.rawBytes - a.rawBytes);

  // Per-entry rollup keyed by stem (main / three / learn / forge / …).
  const byStem = new Map();
  for (const a of assets) {
    const cur = byStem.get(a.stem) ?? { stem: a.stem, ext: a.ext, rawBytes: 0, gzipBytes: 0, brotliBytes: 0, chunks: 0 };
    cur.rawBytes += a.rawBytes;
    cur.gzipBytes += a.gzipBytes;
    cur.brotliBytes += a.brotliBytes;
    cur.chunks += 1;
    byStem.set(a.stem, cur);
  }
  const entries = [...byStem.values()]
    .map((e) => ({
      ...e,
      rawKiB: round(e.rawBytes / 1024, 1),
      gzipKiB: round(e.gzipBytes / 1024, 1),
      brotliKiB: round(e.brotliBytes / 1024, 1),
    }))
    .sort((a, b) => b.rawBytes - a.rawBytes);

  const dist = await dirStats(DIST);
  const jsRaw = assets.filter((a) => a.ext !== 'css').reduce((n, a) => n + a.rawBytes, 0);
  const jsGzip = assets.filter((a) => a.ext !== 'css').reduce((n, a) => n + a.gzipBytes, 0);
  return {
    ok: true,
    distMiB: bytesToMiB(dist.bytes),
    distFiles: dist.files,
    totalJsRawMiB: bytesToMiB(jsRaw),
    totalJsGzipMiB: bytesToMiB(jsGzip),
    entries,
    assets,
    largest: assets.slice(0, 8),
  };
}

/* ------------------------------------------------------------- browser section
 * The same recipe as tools/capture.mjs and tools/soak.mjs: build (already
 * done), serve dist/ over loopback, drive headless Chromium, and wait on the
 * one `__HARNESS__.ready` flag the whole repo agrees on. We measure the wall
 * time to ready, read Navigation Timing / paint / JS heap, parse the [boot]
 * lines for the detected tier / bake profile / worker count / shader
 * permutations, then sample frame times over `FRAMES` requestAnimationFrame
 * callbacks. Playwright is an optional devDependency; if it is not installed we
 * record the section as skipped rather than failing the whole profile. */
async function profileBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { ok: false, skipped: true, reason: 'playwright not installed (npm i -D playwright)' };
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    return { ok: false, reason: 'dist/ missing — run without --no-build first' };
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bin': 'application/octet-stream',
    '.svg': 'image/svg+xml',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/' || path.endsWith('/')) path += 'index.html';
      const filePath = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      if (!filePath.startsWith(DIST)) return void res.writeHead(403).end('forbidden');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        // COOP/COEP so the bake's worker pool + SAB path matches production.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({
    args: [
      ...(SOFTWARE_GL
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--use-angle=metal', '--enable-gpu']),
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--js-flags=--max-old-space-size=8192 --expose-gc',
      '--disable-dev-shm-usage',
      '--force-color-profile=srgb',
      '--force-device-scale-factor=1',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  const consoleErrors = [];
  const bootLines = [];
  const failedResponses = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') consoleErrors.push(text);
    if (text.startsWith('[boot]')) bootLines.push(text);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedResponses.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on('crash', () => pageErrors.push('PAGE CRASHED'));

  const section = { ok: false };
  try {
    const wall0 = performance.now();
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // Cold procedural bake dominates ready time; SwiftShader can take ~90 s, so
    // give the same 300 s leash tools/capture.mjs uses.
    await page.waitForFunction(() => globalThis.__HARNESS__?.ready === true, null, {
      timeout: 300_000,
      polling: 100,
    });
    section.readySeconds = round((performance.now() - wall0) / 1000, 2);

    // Navigation Timing, paint, and JS heap, read from the page itself.
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = {};
      for (const p of performance.getEntriesByType('paint')) paints[p.name] = p.startTime;
      const mem = performance.memory;
      return {
        navigation: nav
          ? {
              domContentLoadedMs: nav.domContentLoadedEventEnd,
              loadEventMs: nav.loadEventEnd,
              responseEndMs: nav.responseEnd,
              transferSizeBytes: nav.transferSize ?? null,
              decodedBodySizeBytes: nav.decodedBodySize ?? null,
            }
          : null,
        firstPaintMs: paints['first-paint'] ?? null,
        firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
        jsHeapUsedBytes: mem?.usedJSHeapSize ?? null,
        jsHeapTotalBytes: mem?.totalJSHeapSize ?? null,
        resourceCount: performance.getEntriesByType('resource').length,
      };
    });
    section.navigation = timing.navigation;
    section.firstPaintMs = round(timing.firstPaintMs, 1);
    section.firstContentfulPaintMs = round(timing.firstContentfulPaintMs, 1);
    section.jsHeapUsedMiB = bytesToMiB(timing.jsHeapUsedBytes);
    section.jsHeapTotalMiB = bytesToMiB(timing.jsHeapTotalBytes);
    section.resourceCount = timing.resourceCount;

    // Frame-time distribution: sample the live rAF loop. Directional only under
    // software rasterisation (offscreen SwiftShader is not a visible-FPS claim),
    // which is exactly the caveat issue #2 attached to the same measurement.
    const frame = await page.evaluate(async (n) => {
      const samples = await new Promise((res) => {
        const out = [];
        let last = performance.now();
        let count = 0;
        const tick = (t) => {
          out.push(t - last);
          last = t;
          if (++count >= n) return res(out);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame((t) => {
          last = t;
          requestAnimationFrame(tick);
        });
      });
      const sorted = samples.slice().sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      return {
        count: samples.length,
        medianMs: q(0.5),
        p95Ms: q(0.95),
        maxMs: sorted[sorted.length - 1],
        minMs: sorted[0],
      };
    }, FRAMES);
    section.frame = {
      samples: frame.count,
      medianMs: round(frame.medianMs, 2),
      p95Ms: round(frame.p95Ms, 2),
      maxMs: round(frame.maxMs, 2),
      minMs: round(frame.minMs, 2),
    };

    // Parse the [boot] lines for the runtime contract issue #2 records by hand.
    section.boot = parseBootLog(bootLines);
    section.bootLog = bootLines;
    section.consoleErrors = consoleErrors;
    section.pageErrors = pageErrors;
    section.failedResponses = failedResponses;
    section.softwareGl = SOFTWARE_GL;
    section.ok = pageErrors.length === 0 && consoleErrors.length === 0;
    if (!section.ok) section.reason = 'console or page errors during boot (see consoleErrors/pageErrors)';
  } catch (e) {
    section.ok = false;
    section.reason = `browser run failed: ${e?.message ?? e}`;
    section.consoleErrors = consoleErrors;
    section.pageErrors = pageErrors;
    section.bootLog = bootLines;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  return section;
}

/** Extract tier / bake profile / worker count / shader permutations from boot. */
function parseBootLog(lines) {
  const text = lines.join('\n');
  const out = {
    vendor: null,
    renderer: null,
    tier: null,
    software: /software rasteriser/i.test(text),
    bakeProfile: null,
    workers: null,
    shaderPermutationsAllocated: null,
    shaderPermutationCap: null,
    shotModules: null,
    nullServices: null,
  };
  const gpu = text.match(/\[boot\]\s+(.+?)\s*\/\s*(.+)/);
  if (gpu) {
    out.vendor = gpu[1].trim();
    out.renderer = gpu[2].trim();
  }
  const tier = text.match(/\[boot\]\s+tier\s+(\w+)/i);
  if (tier) out.tier = tier[1];
  const bake = text.match(/bake profile\s+(\w+)/i);
  if (bake) out.bakeProfile = bake[1];
  const workers = text.match(/(\d+)\s+worker\(s\)/i);
  if (workers) out.workers = Number(workers[1]);
  const perm = text.match(/shader permutations\D+(\d+)\s*\/\s*(\d+)/i);
  if (perm) {
    out.shaderPermutationsAllocated = Number(perm[1]);
    out.shaderPermutationCap = Number(perm[2]);
  }
  const shots = text.match(/ready\D+(\d+)\s+shot module/i);
  if (shots) out.shotModules = Number(shots[1]);
  const nulls = text.match(/(\d+)\s+service\(s\) still null/i);
  if (nulls) out.nullServices = Number(nulls[1]);
  return out;
}

/* ---------------------------------------------------------------- api section
 * READ-ONLY. Latency for each configured environment: an invalid-id Function
 * read (cold sample then warm samples), plus HTML and hashed main.js TTFB. It
 * never writes — no POST, no DB, no blob export, no billing — so it is safe to
 * run against production, matching issue #2's "invalid-ID Function" method. */
async function timedGet(url, { method = 'GET' } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { method, redirect: 'manual' });
    // Drain the body so the timing includes full transfer, not just headers.
    const buf = method === 'HEAD' ? new ArrayBuffer(0) : await res.arrayBuffer();
    return {
      status: res.status,
      ms: round(performance.now() - started, 1),
      bytes: buf.byteLength,
      cacheControl: res.headers.get('cache-control'),
      contentType: res.headers.get('content-type'),
    };
  } catch (e) {
    return { status: 0, ms: round(performance.now() - started, 1), error: String(e?.message ?? e) };
  }
}

async function profileApiEnvironment(name, baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  // A syntactically-valid but non-existent world id: the Function runs and
  // returns 404 without reading or writing any real record.
  const invalidId = '00000000-0000-4000-8000-000000000000';
  const functionUrl = `${base}/api/worlds/${invalidId}`;

  const cold = await timedGet(functionUrl);
  const warm = [];
  for (let i = 0; i < API_SAMPLES; i++) warm.push((await timedGet(functionUrl)).ms);
  const warmSorted = warm.slice().sort((a, b) => a - b);

  const html = await timedGet(`${base}/`);
  // Discover the hashed main bundle from the HTML and time it too.
  let mainJs = null;
  try {
    const home = await (await fetch(`${base}/`)).text();
    const assetPath = home.match(/(?:src|href)="([^"]*(?:main|index)[^"]*\.js)"/)?.[1] || home.match(/(?:src|href)="([^"]*assets\/[^"]+\.js)"/)?.[1];
    if (assetPath) mainJs = await timedGet(new URL(assetPath, `${base}/`).href);
  } catch {
    /* asset discovery is best-effort */
  }

  return {
    ok: cold.status > 0,
    baseUrl: base,
    function: {
      coldMs: cold.ms,
      coldStatus: cold.status,
      warmSamplesMs: warm,
      warmMedianMs: warmSorted[Math.floor(warmSorted.length / 2)] ?? null,
      warmP95Ms: warmSorted[Math.min(warmSorted.length - 1, Math.floor(0.95 * warmSorted.length))] ?? null,
      cacheControl: cold.cacheControl,
    },
    html: { ttfbMs: html.ms, status: html.status, bytes: html.bytes, cacheControl: html.cacheControl },
    mainJs: mainJs
      ? { totalMs: mainJs.ms, status: mainJs.status, bytes: mainJs.bytes, cacheControl: mainJs.cacheControl }
      : null,
  };
}

async function profileApi() {
  const envs = {
    local: process.env.IRONSIGHT_LOCAL_URL,
    staging: process.env.IRONSIGHT_STAGING_URL,
    production: process.env.IRONSIGHT_PRODUCTION_URL,
  };
  const configured = Object.entries(envs).filter(([, url]) => url && url.trim());
  if (configured.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: 'no IRONSIGHT_{LOCAL,STAGING,PRODUCTION}_URL set — nothing to sample',
    };
  }
  const environments = {};
  for (const [name, url] of configured) {
    log(`api: sampling ${name} (${url}) — read-only…`);
    environments[name] = await profileApiEnvironment(name, url.trim());
  }
  return { ok: true, readOnly: true, environments };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const revision = await gitMeta(opt('--rev', null));
  const machine = machineMeta();
  if (revision.dirty) {
    notes.push('working tree is dirty — measurements may not match a clean checkout of this revision');
  }
  log(`revision ${revision.shortSha}${revision.dirty ? ' (dirty)' : ''} on ${machine.platform}/${machine.arch}, node ${machine.node}`);

  const sections = {};

  if (wants('install')) sections.install = await profileInstall();
  else sections.install = { ok: false, skipped: true, reason: 'not selected' };

  if (wants('build')) sections.build = await profileBuild();
  else sections.build = { ok: false, skipped: true, reason: flag('--no-build') ? 'reusing existing dist/' : 'not selected' };

  if (wants('bundle')) sections.bundle = await profileBundle();
  else sections.bundle = { ok: false, skipped: true, reason: 'not selected' };

  if (wants('browser')) sections.browser = await profileBrowser();
  else sections.browser = { ok: false, skipped: true, reason: 'not selected' };

  if (wants('api')) sections.api = await profileApi();
  else sections.api = { ok: false, skipped: true, reason: 'not selected' };

  const report = {
    tool: 'tools/profile.mjs',
    schema: 1,
    startedAt,
    durationSeconds: round((performance.now() - t0) / 1000, 1),
    revision,
    machine,
    sections,
    notes,
  };

  const out = resolve(ROOT, opt('--out', `tools/perf/${revision.shortSha}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);

  printSummary(report);
  if (PRINT_JSON) console.log(JSON.stringify(report, null, 2));
  log(`wrote ${relative(ROOT, out)}`);
  return 0;
}

/* ------------------------------------------------------------------ printing */
function printSummary(r) {
  const line = (s = '') => console.log(s);
  const s = r.sections;
  line();
  line('════════════════════════════ PROFILE ════════════════════════════');
  line(`  revision ${r.revision.shortSha}${r.revision.dirty ? ' (dirty)' : ''}  ·  ${r.revision.branch}`);
  line(`  ${r.machine.cpuModel} · ${r.machine.logicalCpus} vCPU · ${r.machine.totalMemMiB} MiB · node ${r.machine.node}`);
  line();

  const skip = (sec) => (sec?.skipped ? `skipped (${sec.reason})` : sec?.ok ? null : `FAILED (${sec.reason ?? 'unknown'})`);

  const iSkip = skip(s.install);
  line('  INSTALL');
  if (iSkip) line(`    ${iSkip}`);
  else line(`    ${s.install.wallSeconds}s · peak ${s.install.peakRssMiB ?? '—'} MiB · ${s.install.packagesAdded ?? '—'} packages · node_modules ${s.install.nodeModulesMiB ?? '—'} MiB / ${s.install.nodeModulesFiles ?? '—'} files`);

  const bSkip = skip(s.build);
  line('  BUILD');
  if (bSkip) line(`    ${bSkip}`);
  else line(`    ${s.build.wallSeconds}s · peak ${s.build.peakRssMiB ?? '—'} MiB · ${s.build.modulesTransformed ?? '—'} modules · dist ${s.build.distMiB} MiB / ${s.build.distFiles} files`);

  const buSkip = skip(s.bundle);
  line('  BUNDLE');
  if (buSkip) line(`    ${buSkip}`);
  else {
    line(`    dist ${s.bundle.distMiB} MiB · JS ${s.bundle.totalJsRawMiB} MiB raw / ${s.bundle.totalJsGzipMiB} MiB gzip`);
    line('    entry         raw KiB   gzip KiB  brotli KiB  chunks');
    for (const e of s.bundle.entries.slice(0, 8)) {
      line(`    ${String(e.stem).padEnd(12)} ${String(e.rawKiB).padStart(9)} ${String(e.gzipKiB).padStart(10)} ${String(e.brotliKiB).padStart(11)} ${String(e.chunks).padStart(7)}`);
    }
  }

  const brSkip = skip(s.browser);
  line('  BROWSER');
  if (brSkip) line(`    ${brSkip}`);
  else {
    const b = s.browser;
    line(`    ready ${b.readySeconds}s · tier ${b.boot?.tier ?? '—'} · bake ${b.boot?.bakeProfile ?? '—'} · ${b.boot?.workers ?? '—'} worker(s)${b.softwareGl ? ' · SwiftShader' : ''}`);
    line(`    FCP ${b.firstContentfulPaintMs ?? '—'} ms · JS heap ${b.jsHeapUsedMiB ?? '—'} MiB · shaders ${b.boot?.shaderPermutationsAllocated ?? '—'}/${b.boot?.shaderPermutationCap ?? '—'}`);
    if (b.frame) line(`    frame-time  median ${b.frame.medianMs} ms · p95 ${b.frame.p95Ms} ms · max ${b.frame.maxMs} ms (${b.frame.samples} samples)`);
    if ((b.consoleErrors?.length ?? 0) || (b.pageErrors?.length ?? 0)) line(`    ⚠ ${b.consoleErrors?.length ?? 0} console / ${b.pageErrors?.length ?? 0} page error(s)`);
  }

  const aSkip = skip(s.api);
  line('  API (read-only)');
  if (aSkip) line(`    ${aSkip}`);
  else {
    for (const [name, e] of Object.entries(s.api.environments)) {
      line(`    ${name.padEnd(11)} fn cold ${e.function.coldMs} ms · warm median ${e.function.warmMedianMs} ms / p95 ${e.function.warmP95Ms} ms · HTML TTFB ${e.html.ttfbMs} ms`);
    }
  }

  if (r.notes.length) {
    line();
    line('  NOTES');
    for (const n of r.notes) line(`    · ${n}`);
  }
  line('══════════════════════════════════════════════════════════════════');
  line();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('[profile] fatal:', e?.stack ?? e);
    process.exit(1);
  },
);
