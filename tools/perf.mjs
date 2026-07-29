#!/usr/bin/env node
/**
 * IRONSIGHT web-performance harness.
 *
 * The third sibling of `tools/capture.mjs` (screenshots) and `tools/soak.mjs`
 * (behaviour): same build, same static server, same headless Chromium, same
 * `ready` gate — but instead of a PNG or a sim report it emits a machine-readable
 * performance profile for a NAMED REVISION and writes it to `tools/perf/`.
 *
 * WHAT IT MEASURES, AND WHERE EACH NUMBER COMES FROM
 * --------------------------------------------------
 *   /learn/ and /forge/  — Navigation Timing, First Contentful Paint, Largest
 *                          Contentful Paint, Cumulative Layout Shift, long tasks
 *                          and JS heap. All standard browser APIs; the page needs
 *                          no cooperation. These are the routes the perf ticket's
 *                          FCP budget is written against.
 *   the game (/)         — the same web-vitals block, PLUS game-ready wall time,
 *                          peak JS heap, and the renderer's own counters read
 *                          through `window.__PERF__` (see src/engine/perf.ts):
 *                          draw calls, triangles, shader programs, render
 *                          resolution, and a directional CPU/GPU frame-time
 *                          distribution over a fixed number of stepped frames.
 *
 * HONESTY ABOUT THE NUMBERS. Wall-clock figures (ready time, frame time, TTFB)
 * are single-sample, single-location, single-machine — directional, not p75/p95
 * SLOs. The frame-time distribution under headless SwiftShader is offscreen and
 * is NOT a visible-user FPS claim; that caveat is carried in the report. What IS
 * reproducible is the frame COUNT and the structural counters (draw calls,
 * triangles, programs, resolution), which do not vary with the host.
 *
 *     ./tools/perf.sh                       # build, profile game + learn + forge
 *     ./tools/perf.sh --no-build            # reuse the existing dist/
 *     ./tools/perf.sh --routes learn,forge  # a subset
 *     ./tools/perf.sh --frames 240          # longer frame-time sample
 *     ./tools/perf.sh --out tools/perf/rev.json
 *     ./tools/perf.sh --json                # also print the full report
 *     ./tools/perf.sh --strict              # non-zero exit on a budget breach
 *     ./tools/perf.sh --software-gl         # force SwiftShader
 *
 * Exit code is non-zero if the build fails, a route never becomes ready, the
 * page logged an uncaught/console error, or (with --strict) a budget was
 * breached. REQUIRES node >= 20 (playwright) — always invoke through perf.sh.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
// Mirrors vite.config.ts and the other harnesses: parallel lane agents isolate
// their build output via IRONSIGHT_DIST so concurrent runs cannot clobber.
const DIST = resolve(ROOT, process.env.IRONSIGHT_DIST || 'dist');

/* ------------------------------------------------------------- arg parsing */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(
    [
      'tools/perf.sh — headless web-performance profile of IRONSIGHT',
      '',
      '  --routes LIST      comma list of game|learn|forge   (default all three)',
      '  --frames N         frames in the game frame-time sample (default 120)',
      '  --pose SHOT        game shot to pose before sampling  (default hud_combat)',
      '                     — "none" measures the idle post-boot hold instead',
      '  --settle MS        wait after ready for CWV to settle (default 2500)',
      '  --out PATH         JSON report path        (default tools/perf/perf.json)',
      '  --json             print the full report to stdout as well',
      '  --strict           non-zero exit if any budget is breached',
      '  --no-build         reuse the existing dist/',
      '  --software-gl      force SwiftShader (or IRONSIGHT_SOFTWARE_GL=1)',
      '',
      'Exit code is 0 on success; non-zero on build/ready/console failure, or a',
      'budget breach under --strict.',
    ].join('\n'),
  );
  process.exit(0);
}

const ALL_ROUTES = ['game', 'learn', 'forge'];
const ROUTES = String(opt('--routes', ALL_ROUTES.join(',')))
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
for (const r of ROUTES) {
  if (!ALL_ROUTES.includes(r)) {
    console.error(`[perf] FAIL: unknown route "${r}" — expected ${ALL_ROUTES.join('|')}`);
    process.exit(2);
  }
}
const FRAMES = Number(opt('--frames', 120));
// The renderer's draw-call and triangle counts are only meaningful over a
// POPULATED frame. Straight after boot the world sits in the harness hold with
// nothing deployed (1 draw, 1 triangle), so by default we pose a real combat
// shot through `__HARNESS__.capture` first — the same seam tools/capture.mjs
// uses — and sample the frame time from there. `--pose none` measures the
// idle post-boot hold instead.
const POSE = String(opt('--pose', 'hud_combat'));
const SETTLE_MS = Number(opt('--settle', 2500));
const OUT = resolve(ROOT, opt('--out', 'tools/perf/perf.json'));
const PRINT_JSON = flag('--json');
const NO_BUILD = flag('--no-build');
const STRICT = flag('--strict');
const SOFTWARE_GL = process.env.IRONSIGHT_SOFTWARE_GL === '1' || flag('--software-gl');

const log = (...a) => console.log('[perf]', ...a);
let failed = false;
const fail = (msg) => {
  console.error('[perf] FAIL:', msg);
  failed = true;
};

/* -------------------------------------------------------------------- build */
if (!NO_BUILD) {
  log('building…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[perf] FAIL: vite build failed');
    process.exit(1);
  }
}
for (const need of ['index.html', join('learn', 'index.html'), join('forge', 'index.html')]) {
  if (!existsSync(join(DIST, need))) {
    console.error(`[perf] FAIL: ${need} missing in ${relative(ROOT, DIST) || '.'}/ — run without --no-build`);
    process.exit(1);
  }
}

/* ------------------------------------------ revision stamp (best effort) */
function gitStamp() {
  const run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  const sha = run(['rev-parse', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = run(['status', '--porcelain']).length > 0;
  return { sha: sha || null, branch: branch || null, dirty };
}

/* ------------------------------------------------------------ static server */
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
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    const filePath = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
log(`serving ${relative(ROOT, DIST) || '.'}/ at ${BASE}`);

/* ------------------------------------------------------------------ browser */
// Same GPU selection and reasoning as tools/capture.mjs: headless-new on macOS
// reaches ANGLE's Metal backend, and forcing SwiftShader costs ~40×. The extra
// flag here is --enable-precise-memory-info, so performance.memory reports the
// real used-heap figure rather than the 100 KB-bucketed default.
const browser = await chromium.launch({
  args: [
    ...(SOFTWARE_GL
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=metal', '--enable-gpu']),
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--js-flags=--max-old-space-size=8192',
    '--enable-precise-memory-info',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

/**
 * Installed BEFORE any page script runs, so the observers catch the very first
 * paint and layout shift. Buffers into window.__perfmetrics__, which the
 * collector reads after the page has settled. Each observer is guarded: a
 * headless build without `longtask` support must not throw and lose LCP/CLS.
 */
const OBSERVER_INIT = `
(() => {
  const m = { lcp: 0, cls: 0, longTasks: [] };
  window.__perfmetrics__ = m;
  const obs = (type, cb) => {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) cb(e); })
        .observe({ type, buffered: true });
    } catch (_) { /* unsupported entry type — skip, keep the rest */ }
  };
  obs('largest-contentful-paint', (e) => { m.lcp = e.startTime; });
  obs('layout-shift', (e) => { if (!e.hadRecentInput) m.cls += e.value; });
  obs('longtask', (e) => { m.longTasks.push({ start: e.startTime, duration: e.duration }); });
})();
`;

/**
 * Runs in the page after settle. Pure standard-API reads — Navigation Timing,
 * paint entries, resource entries, the buffered observer metrics and heap.
 */
function collectWebVitals() {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const fcp = paint.find((p) => p.name === 'first-contentful-paint');
  const fp = paint.find((p) => p.name === 'first-paint');
  const res = performance.getEntriesByType('resource');
  const m = window.__perfmetrics__ ?? { lcp: 0, cls: 0, longTasks: [] };
  const mem = performance.memory ?? null;
  const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

  // Total Blocking Time proxy: the portion of each long task beyond 50 ms.
  const longOver = m.longTasks.reduce((a, t) => a + Math.max(0, t.duration - 50), 0);

  return {
    navigation: nav
      ? {
          ttfbMs: round(nav.responseStart),
          domInteractiveMs: round(nav.domInteractive),
          domContentLoadedMs: round(nav.domContentLoadedEventEnd),
          loadEventMs: round(nav.loadEventEnd),
          transferBytes: nav.transferSize ?? 0,
          encodedBytes: nav.encodedBodySize ?? 0,
          decodedBytes: nav.decodedBodySize ?? 0,
        }
      : null,
    paint: {
      firstPaintMs: fp ? round(fp.startTime) : null,
      firstContentfulPaintMs: fcp ? round(fcp.startTime) : null,
    },
    webVitals: {
      lcpMs: round(m.lcp),
      cls: round(m.cls),
    },
    longTasks: {
      count: m.longTasks.length,
      totalMs: round(m.longTasks.reduce((a, t) => a + t.duration, 0)),
      blockingMs: round(longOver),
      longestMs: round(m.longTasks.reduce((a, t) => Math.max(a, t.duration), 0)),
    },
    resources: {
      count: res.length,
      transferBytes: res.reduce((a, r) => a + (r.transferSize ?? 0), 0),
      decodedBytes: res.reduce((a, r) => a + (r.decodedBodySize ?? 0), 0),
    },
    heap: mem
      ? {
          usedBytes: mem.usedJSHeapSize,
          totalBytes: mem.totalJSHeapSize,
          limitBytes: mem.jsHeapSizeLimit,
        }
      : null,
  };
}

/* ------------------------------------------------------------------- routes */
const ROUTE_DEFS = {
  game: { id: 'game', path: '', readyExpr: 'globalThis.__HARNESS__?.ready === true', runtime: true },
  learn: { id: 'learn', path: 'learn/', readyExpr: 'window.__LEARN__?.ready === true', runtime: false },
  forge: { id: 'forge', path: 'forge/', readyExpr: 'window.__FORGE__?.ready === true', runtime: false },
};

const report = {
  tool: 'tools/perf.mjs',
  generatedAt: new Date().toISOString(),
  revision: gitStamp(),
  dist: relative(ROOT, DIST) || '.',
  softwareGl: SOFTWARE_GL,
  frameSampleFrames: FRAMES,
  pose: POSE,
  settleMs: SETTLE_MS,
  routes: {},
  budgets: [],
};

for (const routeName of ROUTES) {
  const def = ROUTE_DEFS[routeName];
  const url = BASE + def.path;
  log(`profiling ${routeName} → ${url}`);

  const context = await browser.newContext({
    viewport: def.runtime ? { width: 1920, height: 1080 } : { width: 1280, height: 1600 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await context.addInitScript(OBSERVER_INIT);
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (process.env.PERF_VERBOSE) log(`[${routeName}] console.${msg.type()}:`, msg.text());
  });
  page.on('crash', () => pageErrors.push('PAGE CRASHED'));

  const routeReport = { url, ok: false };
  try {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(def.readyExpr, null, { timeout: 300_000, polling: 100 });
    routeReport.readyMs = Date.now() - t0;

    // Let LCP finalise and any post-ready layout shift land before reading.
    await page.waitForTimeout(SETTLE_MS);

    routeReport.vitals = await page.evaluate(collectWebVitals);
    let peakHeap = routeReport.vitals.heap?.usedBytes ?? null;

    if (def.runtime) {
      const hasPerf = await page.evaluate(() => Boolean(globalThis.__PERF__?.available));
      if (!hasPerf) {
        fail(`${routeName}: window.__PERF__ missing — src/main.ts did not call installPerf().`);
      } else {
        // Pose a representative populated frame first, so the snapshot's draw
        // calls and triangles are a combat scene, not the empty post-boot hold.
        if (POSE && POSE !== 'none') {
          const shots = await page.evaluate(() => globalThis.__HARNESS__?.shots?.() ?? []);
          if (shots.includes(POSE)) {
            await page.evaluate((n) => globalThis.__HARNESS__.capture(n), POSE, { timeout: 240_000 });
            routeReport.posedShot = POSE;
          } else {
            routeReport.posedShot = null;
            routeReport.poseWarning = `shot "${POSE}" not registered; sampled the post-boot hold instead`;
            log(`${routeName}: ${routeReport.poseWarning}`);
          }
        } else {
          routeReport.posedShot = null;
        }
        routeReport.runtime = await page.evaluate((frames) => {
          const snap = globalThis.__PERF__.snapshot();
          const frameSample = globalThis.__PERF__.sampleFrames(frames);
          return { snapshot: snap, frameSample };
        }, FRAMES);
        // Heap can grow while the frame sample runs; report the peak of the two.
        const afterSample = await page.evaluate(() =>
          performance.memory ? performance.memory.usedJSHeapSize : null,
        );
        if (afterSample !== null) peakHeap = Math.max(peakHeap ?? 0, afterSample);
      }
    }
    routeReport.peakHeapBytes = peakHeap;
    routeReport.ok = pageErrors.length === 0 && consoleErrors.length === 0;
  } catch (e) {
    fail(`${routeName}: ${e?.message ?? e}`);
    const status = await page
      .evaluate(() => globalThis.__HARNESS__?.status ?? null)
      .catch(() => null);
    if (status) routeReport.harnessStatus = status;
  }

  if (pageErrors.length) fail(`${routeName}: ${pageErrors.length} uncaught error(s)`);
  if (consoleErrors.length) fail(`${routeName}: ${consoleErrors.length} console error(s)`);
  routeReport.pageErrors = pageErrors;
  routeReport.consoleErrors = consoleErrors;
  report.routes[routeName] = routeReport;

  for (const e of [...pageErrors, ...consoleErrors].slice(0, 10)) console.error('   ', e);
  await context.close();
}

await browser.close();
server.close();

/* ------------------------------------------------------------------ budgets */
// Starting guardrails, NOT validated SLOs, and mirrored from the perf ticket's
// "proposed budgets". Single-sample, so a breach is a WARN by default and only
// fails the run under --strict. Each verdict quotes the number it fired on.
const MIB = 1024 * 1024;
function addBudget(id, level, message) {
  report.budgets.push({ id, level, message });
}
for (const name of ['learn', 'forge']) {
  const r = report.routes[name];
  const fcp = r?.vitals?.paint?.firstContentfulPaintMs;
  if (typeof fcp === 'number') {
    addBudget(
      `${name}.fcp`,
      fcp <= 1500 ? 'ok' : 'warn',
      `${name} FCP ${fcp.toFixed(0)} ms vs 1500 ms target (single sample, not p75).`,
    );
  }
}
const game = report.routes.game;
if (game?.readyMs != null) {
  const budget = SOFTWARE_GL ? 120_000 : 25_000;
  addBudget(
    'game.ready',
    game.readyMs <= budget ? 'ok' : 'warn',
    `game ready ${(game.readyMs / 1000).toFixed(1)} s vs ${(budget / 1000).toFixed(0)} s ` +
      `${SOFTWARE_GL ? 'software' : 'hardware'} target.`,
  );
}
for (const name of ROUTES) {
  const peak = report.routes[name]?.peakHeapBytes;
  if (typeof peak === 'number') {
    addBudget(
      `${name}.heap`,
      peak <= 512 * MIB ? 'ok' : 'warn',
      `${name} peak JS heap ${(peak / MIB).toFixed(0)} MiB vs 512 MiB ceiling.`,
    );
  }
}

/* -------------------------------------------------------------------- write */
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

printSummary(report);
if (PRINT_JSON) console.log(JSON.stringify(report, null, 2));
log(`wrote ${relative(ROOT, OUT)}`);

const breaches = report.budgets.filter((b) => b.level !== 'ok');
if (STRICT && breaches.length > 0) fail(`${breaches.length} budget breach(es) under --strict`);
process.exit(failed ? 1 : 0);

/* ------------------------------------------------------------------ printing */
function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= MIB) return `${(b / MIB).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${b} B`;
}
function printSummary(r) {
  const line = (s = '') => console.log(s);
  line();
  line('═════════════════════════════ PERF ═════════════════════════════');
  line(
    `  ${r.revision.sha ? r.revision.sha.slice(0, 12) : 'nogit'}` +
      `${r.revision.dirty ? '+dirty' : ''} · ${r.revision.branch ?? '—'} · ` +
      `${r.softwareGl ? 'SwiftShader' : 'hardware GL'} · dist ${r.dist}`,
  );
  for (const name of ROUTES) {
    const rr = r.routes[name];
    if (!rr) continue;
    line();
    line(`  ${name.toUpperCase()}  ${rr.ok ? '' : '[errors present]'}`);
    if (rr.readyMs != null) line(`    ready            ${(rr.readyMs / 1000).toFixed(2)} s`);
    const v = rr.vitals ?? {};
    if (v.paint) {
      line(
        `    FCP / FP         ${fmtMs(v.paint.firstContentfulPaintMs)} / ${fmtMs(v.paint.firstPaintMs)}`,
      );
    }
    if (v.webVitals) line(`    LCP / CLS        ${fmtMs(v.webVitals.lcpMs)} / ${v.webVitals.cls}`);
    if (v.navigation) {
      line(
        `    TTFB / DCL       ${fmtMs(v.navigation.ttfbMs)} / ${fmtMs(v.navigation.domContentLoadedMs)}` +
          `   transfer ${fmtBytes(v.navigation.transferBytes)}`,
      );
    }
    if (v.longTasks) {
      line(
        `    long tasks       ${v.longTasks.count} · ${v.longTasks.totalMs.toFixed(0)} ms total · ` +
          `${v.longTasks.blockingMs.toFixed(0)} ms blocking`,
      );
    }
    if (v.resources) {
      line(`    resources        ${v.resources.count} · ${fmtBytes(v.resources.transferBytes)} transfer`);
    }
    line(`    peak JS heap     ${fmtBytes(rr.peakHeapBytes)}`);
    if (rr.runtime) {
      const s = rr.runtime.snapshot;
      const fs = rr.runtime.frameSample;
      line(`    posed shot       ${rr.posedShot ?? '(none — post-boot hold)'}`);
      line(
        `    render           tier ${s.tier} · ${s.renderWidth}×${s.renderHeight} ` +
          `(scale ${s.renderScale}) · ${s.programs} programs`,
      );
      line(`    draw / tris      ${s.drawCalls} draws · ${s.triangles.toLocaleString('en-US')} triangles`);
      line(
        `    CPU frame ms     median ${fs.cpuMs.median} · p95 ${fs.cpuMs.p95} · max ${fs.cpuMs.max}` +
          `  (${fs.frames} frames, directional)`,
      );
      if (fs.gpuMs) {
        line(`    GPU frame ms     median ${fs.gpuMs.median} · p95 ${fs.gpuMs.p95} · max ${fs.gpuMs.max}`);
      } else {
        line('    GPU frame ms     — (no timer-query extension)');
      }
    }
  }
  line();
  line('  BUDGETS (starting guardrails, not SLOs)');
  for (const b of r.budgets) line(`    [${b.level === 'ok' ? ' ok ' : 'warn'}] ${b.id}: ${b.message}`);
  line('═════════════════════════════════════════════════════════════════');
  line();
}
function fmtMs(v) {
  return v == null ? '—' : `${Number(v).toFixed(0)} ms`;
}
