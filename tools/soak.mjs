#!/usr/bin/env node
/**
 * IRONSIGHT headless SIM SOAK.
 *
 * The behavioural twin of `tools/capture.mjs`. Same build, same static server,
 * same headless Chromium, same `__HARNESS__.ready` gate — but instead of posing
 * a camera and grabbing a PNG, it steps the FIXED-TIMESTEP simulation forward
 * for N seconds with rendering minimised and dumps a JSON report of what
 * actually moved.
 *
 * WHY: a human played the game and reported three bugs that twelve rounds of
 * screenshot critics never saw, because none of them are visual:
 *
 *   1. "going uphill my character can't move forward, I have to jump"
 *   2. "my teammates aren't moving towards the enemies"
 *   3. "enemies aren't moving towards me or my teammates"
 *
 * None of those were measurable before this tool existed. Now they are:
 * per-bot distance travelled, stalled-tick counts against terrain slope, nav
 * path success rate, and whether anything is registered — and CALLED — at
 * TickPhase.Intent / Ai / Movement.
 *
 *     ./tools/soak.sh                          # 60 s, default probe
 *     ./tools/soak.sh --seconds 30
 *     ./tools/soak.sh --walk sweep             # walk while yawing, all headings
 *     ./tools/soak.sh --render-every 1         # render every tick (slow; a control)
 *     ./tools/soak.sh --no-build               # reuse the existing dist
 *     ./tools/soak.sh --out tools/soak/after.json
 *     ./tools/soak.sh --json                   # full report to stdout too
 *     ./tools/soak.sh --compare tools/soak/before.json
 *
 * EXIT CODE IS THE VERDICT: 0 when no `fail`-level verdict fired, 1 otherwise —
 * so a lane agent can run it before a fix, run it after, and have the shell tell
 * it whether the fix landed. `--compare` prints a before/after delta table.
 *
 * REQUIRES node >= 20 (playwright). Always invoke through `tools/soak.sh`.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
// Mirrors vite.config.ts and tools/capture.mjs: parallel lane agents isolate
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
      'tools/soak.sh — headless behavioural soak of the IRONSIGHT simulation',
      '',
      'BEHAVIOURAL MODE (default) — "does anything move":',
      '  --seconds N        simulated seconds to run          (default 60)',
      '  --render-every N   render 1 frame per N ticks, 0=none(default 30)',
      '  --walk MODE        uphill | sweep | forward | none   (default uphill)',
      '  --sprint           hold sprint as well as forward',
      '  --seed N           reset seed                        (default 4613)',
      '  --timeline-hz N    objective timeline resolution     (default 1)',
      '',
      'PROFILE MODE (--profile) — "does anything LEAK", a 10–30 min soak:',
      '  --profile          run the memory/GC/frame-time leak soak instead',
      '  --minutes N        simulated minutes to run, 1..30    (default 15)',
      '  --render-every N   render 1 frame per N ticks         (default 4)',
      '  --sample-every N   heap/resource sample cadence, sec  (default 5)',
      '  --gc-every N       forced-GC retained-heap cadence,s  (default 30)',
      '  --walk MODE        player drive for the whole run     (default sweep)',
      '',
      'COMMON:',
      '  --out PATH         JSON report path  (default tools/soak/{soak,profile}.json)',
      '  --compare PATH     print a delta against an earlier report of the same mode',
      '  --json             print the full report to stdout as well',
      '  --no-build         reuse the existing dist/',
      '  --software-gl      force SwiftShader (or IRONSIGHT_SOFTWARE_GL=1)',
      '',
      'Exit code is 0 when no fail-level verdict fired, 1 otherwise.',
    ].join('\n'),
  );
  process.exit(0);
}

const PROFILE = flag('--profile');
const SECONDS = Number(opt('--seconds', 60));
// Profile mode renders far more (leaks hide in renderer allocations), so its
// render cadence default is tighter than the behavioural soak's.
const RENDER_EVERY = Number(opt('--render-every', PROFILE ? 4 : 30));
const WALK = String(opt('--walk', PROFILE ? 'sweep' : 'uphill'));
const SPRINT = flag('--sprint');
const SEED = Number(opt('--seed', 0x1205));
const TIMELINE_HZ = Number(opt('--timeline-hz', 1));
const MINUTES = Number(opt('--minutes', 15));
const SAMPLE_EVERY = Number(opt('--sample-every', 5));
const GC_EVERY = Number(opt('--gc-every', 30));
const OUT = resolve(ROOT, opt('--out', PROFILE ? 'tools/soak/profile.json' : 'tools/soak/soak.json'));
const COMPARE = opt('--compare', null);
const PRINT_JSON = flag('--json');
const NO_BUILD = flag('--no-build');
// A soak is CPU-bound simulation, not rasterisation, and it runs 3600 ticks
// rather than 32 frames — so the page needs a far longer leash than a shot.
// Profile mode renders a large fraction of its ticks over 10–30 sim minutes, so
// its wall budget is sized off minutes (~4 wall-minutes per sim-minute ceiling),
// not seconds.
const RUN_TIMEOUT = Number(
  opt('--timeout', PROFILE ? Math.max(900_000, MINUTES * 240_000) : Math.max(300_000, SECONDS * 8000)),
);

if (!['uphill', 'sweep', 'forward', 'none'].includes(WALK)) {
  console.error(`[soak] --walk must be uphill|sweep|forward|none, got "${WALK}"`);
  process.exit(2);
}

const log = (...a) => console.log('[soak]', ...a);
let failed = false;
const fail = (msg) => {
  console.error('[soak] FAIL:', msg);
  failed = true;
};

/* -------------------------------------------------------------------- build */
if (!NO_BUILD) {
  log('building…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[soak] FAIL: vite build failed');
    process.exit(1);
  }
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[soak] FAIL: dist/index.html missing — run without --no-build');
  process.exit(1);
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
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
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
// Same GPU selection as tools/capture.mjs, and the same reasoning: headless-new
// on macOS reaches ANGLE's Metal backend, and forcing SwiftShader costs ~40×.
// A soak still bakes the whole world before it can simulate anything, so the
// backend matters here even though almost nothing is rendered afterwards.
const SOFTWARE_GL = process.env.IRONSIGHT_SOFTWARE_GL === '1' || flag('--software-gl');
const browser = await chromium.launch({
  args: [
    ...(SOFTWARE_GL
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=metal', '--enable-gpu']),
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    // Profile mode needs a forceable collector (`globalThis.gc`) for clean
    // post-GC retained-heap samples, and un-quantised `performance.memory` — the
    // default 100 KB buckets are coarse enough to hide a slow leak.
    ...(PROFILE
      ? ['--js-flags=--max-old-space-size=8192 --expose-gc', '--enable-precise-memory-info']
      : ['--js-flags=--max-old-space-size=8192']),
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

const pageErrors = [];
const consoleErrors = [];
const bootLines = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)));
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error') consoleErrors.push(text);
  // The boot log prints the tick schedule by phase, which is the single most
  // useful line in the whole run for "bots do not move" — keep it.
  if (text.startsWith('[boot]')) bootLines.push(text);
  if (process.env.SOAK_VERBOSE) log(`console.${t}:`, text);
});
page.on('crash', () => pageErrors.push('PAGE CRASHED'));

log('loading…');
const wall0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

try {
  await page.waitForFunction(() => globalThis.__HARNESS__?.ready === true, null, {
    timeout: 300_000,
    polling: 250,
  });
} catch {
  const diag = await page
    .evaluate(() => ({ harness: typeof globalThis.__HARNESS__, status: globalThis.__HARNESS__?.status ?? null }))
    .catch(() => ({}));
  console.error(`[soak] FAIL: harness never became ready. diag=${JSON.stringify(diag)}`);
  for (const e of [...pageErrors, ...consoleErrors].slice(0, 20)) console.error('  ', e);
  await browser.close();
  server.close();
  process.exit(1);
}
const bootSecs = ((Date.now() - wall0) / 1000).toFixed(1);
log(`harness ready in ${bootSecs}s`);
for (const line of bootLines) console.log('  ', line);

const soakShape = await page.evaluate(() => ({
  available: Boolean(globalThis.__SOAK__?.available),
  hasProfile: typeof globalThis.__SOAK__?.profile === 'function',
}));
if (!soakShape.available) {
  console.error('[soak] FAIL: window.__SOAK__ missing — src/main.ts did not call installSoak().');
  await browser.close();
  server.close();
  process.exit(1);
}
if (PROFILE && !soakShape.hasProfile) {
  console.error('[soak] FAIL: __SOAK__.profile missing — this build predates the leak-soak mode. Rebuild without --no-build.');
  await browser.close();
  server.close();
  process.exit(1);
}

/* ---------------------------------------------------------------------- run */
if (PROFILE) {
  log(
    `PROFILE: ${MINUTES} min (${Math.round(MINUTES * 60 * 60)} ticks) · walk=${WALK}${SPRINT ? '+sprint' : ''} · ` +
      `renderEvery=${RENDER_EVERY} · sampleEvery=${SAMPLE_EVERY}s · gcEvery=${GC_EVERY}s · seed=${SEED}`,
  );
} else {
  log(
    `running ${SECONDS}s (${Math.round(SECONDS * 60)} ticks) · walk=${WALK}${SPRINT ? '+sprint' : ''} · ` +
      `renderEvery=${RENDER_EVERY} · seed=${SEED}`,
  );
}
const t0 = Date.now();
let report;
try {
  report = await page.evaluate(
    async ([mode, options, timeout]) => {
      const done = mode === 'profile' ? globalThis.__SOAK__.profile(options) : globalThis.__SOAK__.run(options);
      const guard = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('soak timed out in-page')), timeout - 10_000),
      );
      return await Promise.race([done, guard]);
    },
    [
      PROFILE ? 'profile' : 'run',
      PROFILE
        ? {
            minutes: MINUTES,
            renderEvery: RENDER_EVERY,
            walk: WALK,
            sprint: SPRINT,
            seed: SEED,
            sampleEverySec: SAMPLE_EVERY,
            gcEverySec: GC_EVERY,
          }
        : {
            seconds: SECONDS,
            renderEvery: RENDER_EVERY,
            walk: WALK,
            sprint: SPRINT,
            seed: SEED,
            timelineHz: TIMELINE_HZ,
          },
      RUN_TIMEOUT,
    ],
    { timeout: RUN_TIMEOUT },
  );
} catch (e) {
  console.error(`[soak] FAIL: ${e?.message ?? e}`);
  for (const err of [...pageErrors, ...consoleErrors].slice(0, 20)) console.error('  ', err);
  await browser.close();
  server.close();
  process.exit(1);
}
const wallSecs = Number(((Date.now() - t0) / 1000).toFixed(1));

await browser.close();
server.close();

report.meta = {
  wallSeconds: wallSecs,
  bootSeconds: Number(bootSecs),
  softwareGl: SOFTWARE_GL,
  dist: relative(ROOT, DIST) || '.',
  pageErrors,
  consoleErrors,
  bootLog: bootLines,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

/* ------------------------------------------------------------ human summary */
if (PROFILE) printProfileSummary(report);
else printSummary(report);

if (COMPARE) {
  try {
    const before = JSON.parse(await readFile(resolve(ROOT, COMPARE), 'utf8'));
    if (PROFILE) printProfileCompare(before, report);
    else printCompare(before, report);
  } catch (e) {
    log(`--compare: could not read ${COMPARE}: ${e?.message ?? e}`);
  }
}

log(
  PROFILE
    ? `wrote ${relative(ROOT, OUT)} (${wallSecs}s wall for ${MINUTES} min simulated)`
    : `wrote ${relative(ROOT, OUT)} (${wallSecs}s wall for ${SECONDS}s simulated)`,
);
if (PRINT_JSON) console.log(JSON.stringify(report, null, 2));

if (pageErrors.length || consoleErrors.length) {
  fail(`${pageErrors.length} uncaught error(s), ${consoleErrors.length} console error(s)`);
  for (const e of [...pageErrors, ...consoleErrors].slice(0, 10)) console.error('  ', e);
}
if (!report.ok) fail('the soak itself threw — see report.errors');
if ((report.verdicts ?? []).some((v) => v.level === 'fail')) failed = true;
process.exit(failed ? 1 : 0);

/* ------------------------------------------------------------------ printing */

function bar(level) {
  return level === 'fail' ? 'FAIL' : level === 'warn' ? 'warn' : ' ok ';
}

function printSummary(r) {
  const line = (s = '') => console.log(s);
  line();
  line('══════════════════════════════ SOAK ══════════════════════════════');
  line(
    `  ${r.config.seconds}s simulated · ${r.engine.ticksRun} ticks · ` +
      `${r.config.framesRendered} frame(s) rendered · seed ${r.config.seed}`,
  );
  const nulls = r.engine.nullServices ?? [];
  line(
    `  physics ${r.engine.physicsReady ? 'ready' : 'NOT READY'} · ` +
      `terrain ${r.engine.terrainReady ? 'ready' : 'NOT READY'} · ` +
      `nav ${r.engine.navReady ? 'ready' : 'NOT READY'}` +
      (nulls.length ? ` · ${nulls.length} null service(s): ${nulls.join(',')}` : ''),
  );

  line();
  line('  TICK PHASES (registered → called)');
  for (const p of r.schedule.gameplayPhases ?? []) {
    const detail = (p.detail ?? []).map((d) => `${d.name}×${d.calls}`).join(' ') || '—';
    line(`    ${String(p.phase).padEnd(9)} ${String(p.systems).padStart(2)} system(s)  ${detail}`);
  }

  line();
  line('  BOTS');
  const b = r.bots ?? {};
  line(
    `    seen ${b.distinctEntitiesSeen}  alive-at-end ${b.aliveAtEnd} ` +
      `(C ${b.aliveByTeam?.Coalition ?? 0} / I ${b.aliveByTeam?.Insurgent ?? 0})  ` +
      `attached ${b.attached}/${b.distinctEntitiesSeen}  peak-controlled ${b.controlledPeak}`,
  );
  line(
    `    distance  median ${b.medianDistance} m   max ${b.maxDistance} m   ` +
      `total ${b.totalDistance} m   under-1m ${b.movedUnder1m}/${b.distinctEntitiesSeen}`,
  );
  line(
    `    frozen    ${((b.frozenTickFraction ?? 0) * 100).toFixed(1)}% of observed ticks   ` +
      `longest unbroken freeze ${b.longestFreezeSeconds}s   ever-targeted ${b.everAcquiredTarget}`,
  );
  const bh = (b.slopeHistogram ?? []).filter((h) => h.ticks >= 30);
  if (bh.length) {
    line(`    bots on terrain ${b.ticksOnTerrain} ticks / off terrain ${b.ticksOffTerrain} ticks`);
    line('      slope AHEAD°  ticks    frozen   frozen%');
    for (const h of bh) {
      line(
        `      ${String(h.aheadSlopeDeg).padEnd(12)} ${String(h.ticks).padStart(6)} ` +
          `${String(h.frozenTicks).padStart(9)} ${(h.frozenFraction * 100).toFixed(1).padStart(8)}%`,
      );
    }
  }
  const per = (b.perBot ?? []).slice(0, 8);
  if (per.length) {
    line('    slowest bots:');
    line('      entity  team         dist  max m/s  frozen  longest  target  behaviour');
    for (const t of per) {
      const top = Object.entries(t.behaviours ?? {}).sort((x, y) => y[1] - x[1])[0];
      line(
        `      ${String(t.entity).padEnd(7)} ${String(t.team).padEnd(11)} ` +
          `${String(t.distance).padStart(6)} ${String(t.maxSpeed).padStart(8)} ` +
          `${String(t.frozenTicks).padStart(7)} ${String(t.longestFreezeTicks).padStart(8)} ` +
          `${String(t.ticksWithTarget).padStart(7)}  ${top ? `${top[0]}×${top[1]}` : '—'}`,
      );
    }
  }

  line();
  line('  NAV');
  const n = r.nav ?? {};
  line(
    `    findPath ${n.findPath?.ok ?? 0}/${n.findPath?.calls ?? 0} ok · ` +
      `sample ${n.sample?.ok ?? 0}/${n.sample?.calls ?? 0} · ` +
      `raycastWalkable ${n.raycastWalkable?.ok ?? 0}/${n.raycastWalkable?.calls ?? 0}`,
  );
  const reasons = Object.entries(n.findPath?.failReasons ?? {});
  if (reasons.length) line(`    failures: ${reasons.map(([k, v]) => `${k}×${v}`).join(', ')}`);

  line();
  line('  COMBAT + MODE');
  const c = r.combat ?? {};
  line(
    `    shots ${c.shotsFired} (bots ${c.shotsByBots} / player ${c.shotsByPlayer}) · ` +
      `damage ${c.damageEvents} · kills ${c.kills}`,
  );
  line(
    `    phase ${r.mode?.phase} · tickets C ${r.mode?.tickets?.Coalition} / I ${r.mode?.tickets?.Insurgent} ` +
      `of ${r.mode?.tickets?.max} · ownership changes ${r.mode?.ownershipChanges} · ` +
      `progress events ${r.mode?.objectiveProgressEvents}`,
  );

  line();
  line('  LOCAL PLAYER (scripted forward walk)');
  const p = r.player ?? {};
  line(
    `    walk=${p.walk} yaw ${p.armedYawDeg ?? '—'}°  spawn slope ${p.spawnTerrainSlopeDeg ?? '—'}°  ` +
      `distance ${p.distance} m  max ${p.maxSpeed} m/s`,
  );
  if (p.capsule) {
    line(
      `    capsule  r ${p.capsule.radius}  h ${p.capsule.standHeight}  ` +
        `maxSlope ${p.capsule.maxSlopeDeg}°  step ${p.capsule.stepHeight}m  ` +
        `snap ${p.capsule.snapToGroundDistance}m  skin ${p.capsule.skinWidth}m`,
    );
  }
  line(
    `    stalled ${p.stuckTicks}/${p.forwardTicks} ticks (${((p.stuckFraction ?? 0) * 100).toFixed(1)}%)  ` +
      `episodes ${p.stallEpisodes}  longest ${p.longestStallSeconds}s  ` +
      `grounded ${p.groundedTicks}  air ${p.airTicks}  teleports ${p.teleports}` +
      (p.endedStalled ? '  [ENDED STALLED]' : ''),
  );
  const hist = (p.slopeHistogram ?? []).filter((h) => h.ticks >= 10);
  if (hist.length) {
    line('      slope AHEAD°  ticks   stalled   stall%   mean m/s');
    for (const h of hist) {
      line(
        `      ${String(h.aheadSlopeDeg).padEnd(12)} ${String(h.ticks).padStart(6)} ` +
          `${String(h.stuckTicks).padStart(9)} ${(h.stuckFraction * 100).toFixed(1).padStart(7)}% ` +
          `${String(h.meanSpeedMs).padStart(10)}`,
      );
    }
  }
  const worst = (p.worstStalls ?? []).slice(0, 5);
  if (worst.length) {
    line('      longest stalls:');
    for (const s of worst) {
      line(
        `        ${String(s.seconds).padStart(6)}s at t=${String(s.startTime).padStart(6)}s  ` +
          `pos ${s.position.map((v) => v.toFixed(1)).join(',')}  ahead ${s.aheadSlopeDeg}°  ` +
          `under ${s.terrainSlopeDeg}°  clearance ${s.terrainClearance}m` +
          (s.recovered ? '' : '  NEVER RECOVERED'),
      );
    }
  }

  line();
  line('  VERDICTS');
  for (const v of r.verdicts ?? []) line(`    [${bar(v.level)}] ${v.id}: ${v.message}`);
  for (const e of r.errors ?? []) line(`    [note] ${e}`);
  line('══════════════════════════════════════════════════════════════════');
  line();
}

function printCompare(before, after) {
  const rows = [
    ['bots seen', before.bots?.distinctEntitiesSeen, after.bots?.distinctEntitiesSeen],
    ['bots under 1 m', before.bots?.movedUnder1m, after.bots?.movedUnder1m],
    ['bot median dist (m)', before.bots?.medianDistance, after.bots?.medianDistance],
    ['bot max dist (m)', before.bots?.maxDistance, after.bots?.maxDistance],
    ['findPath ok', before.nav?.findPath?.ok, after.nav?.findPath?.ok],
    ['findPath calls', before.nav?.findPath?.calls, after.nav?.findPath?.calls],
    ['shots fired', before.combat?.shotsFired, after.combat?.shotsFired],
    ['kills', before.combat?.kills, after.combat?.kills],
    ['player dist (m)', before.player?.distance, after.player?.distance],
    ['player stall %', pct(before.player?.stuckFraction), pct(after.player?.stuckFraction)],
    ['ownership changes', before.mode?.ownershipChanges, after.mode?.ownershipChanges],
  ];
  console.log('  BEFORE → AFTER');
  for (const [label, b, a] of rows) {
    const delta = typeof b === 'number' && typeof a === 'number' ? ` (${a - b >= 0 ? '+' : ''}${round2(a - b)})` : '';
    console.log(`    ${label.padEnd(22)} ${String(b ?? '—').padStart(10)} → ${String(a ?? '—').padStart(10)}${delta}`);
  }
  console.log();
}

function pct(v) {
  return typeof v === 'number' ? Number((v * 100).toFixed(1)) : v;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

/* ---------------------------------------------------------- profile printing */

function printProfileSummary(r) {
  const line = (s = '') => console.log(s);
  const cfg = r.config ?? {};
  const eng = r.engine ?? {};
  const mem = r.memory ?? {};
  const ft = r.frameTime ?? {};
  const gc = r.gc ?? {};
  const res = r.resources ?? {};

  line();
  line('════════════════════════════ SOAK · PROFILE ════════════════════════════');
  line(
    `  ${cfg.minutes} min simulated · ${eng.tickAtEnd - eng.tickAtStart} ticks · ` +
      `${cfg.framesRendered} frame(s) rendered · seed ${cfg.seed} · tier ${eng.qualityTier}`,
  );
  line(
    `  precise-heap API ${eng.heapPreciseApi ? 'yes' : 'NO'} · forceable GC ${eng.gcExposed ? 'yes' : 'no'} · ` +
      `leak signal: ${r.leakSignal}`,
  );

  line();
  line('  MEMORY (JS heap, MiB)');
  line(
    `    start ${mem.startMB}  end ${mem.endMB}  peak ${mem.peakMB}  limit ${mem.limitMB}  ` +
      `delta ${fmtSigned(mem.deltaMB)}`,
  );
  line(
    `    LEAK TREND  ${fmtSigned(mem.growthMBPerMin)} MiB/min  (r²=${mem.trendR2}, ` +
      `${mem.trendPointCount} pts over ${mem.trendSpanMin} min)  →  ${fmtSigned(mem.projectedGrowthMB)} MiB across the fit`,
  );

  line();
  line('  FRAME TIME (CPU ms, rendered frames)');
  line(
    `    p50 ${ft.p50Ms}  p95 ${ft.p95Ms}  p99 ${ft.p99Ms}  max ${ft.maxMs}  mean ${ft.meanMs}  ` +
      `(${ft.framesTimed} frames)`,
  );
  line(`    hitches > ${ft.hitchMs} ms: ${ft.hitches}   p95 drift ${fmtSigned(ft.p95DriftMs)} ms (${ft.firstFifthP95Ms} → ${ft.lastFifthP95Ms})`);

  line();
  line('  GC + RESOURCES');
  line(
    `    forced collections ${gc.forcedCollections}  natural drops ${gc.naturalDrops}  ` +
      `reclaimed ${gc.totalReclaimedMB} MiB`,
  );
  line(
    `    geometries ${res.geometriesStart}→${res.geometriesEnd}  textures ${res.texturesStart}→${res.texturesEnd}  ` +
      `programs ${res.programsStart}→${res.programsEnd}  entities ${res.entitiesStart}→${res.entitiesEnd} (peak ${res.entitiesPeak})`,
  );

  const rows = r.samples ?? [];
  if (rows.length) {
    line();
    line('  TIMELINE (per sample window)');
    line('      t(min)   heapMB   geo   tex   ent  bots   fP50   fP95   fMax  gcDrops');
    const step = Math.max(1, Math.floor(rows.length / 14));
    for (let i = 0; i < rows.length; i += step) {
      const x = rows[i];
      line(
        `      ${String(x.tMin).padStart(6)} ${String(x.heapUsedMB).padStart(8)} ` +
          `${String(x.geometries).padStart(5)} ${String(x.textures).padStart(5)} ` +
          `${String(x.entities).padStart(5)} ${String(x.botsAlive).padStart(5)} ` +
          `${String(x.frameP50).padStart(6)} ${String(x.frameP95).padStart(6)} ${String(x.frameMax).padStart(6)} ` +
          `${String(x.gcDrops).padStart(8)}`,
      );
    }
  }

  line();
  line('  VERDICTS');
  for (const v of r.verdicts ?? []) line(`    [${bar(v.level)}] ${v.id}: ${v.message}`);
  for (const e of r.errors ?? []) line(`    [note] ${e}`);
  line('═════════════════════════════════════════════════════════════════════════');
  line();
}

function printProfileCompare(before, after) {
  const rows = [
    ['heap start (MiB)', before.memory?.startMB, after.memory?.startMB],
    ['heap end (MiB)', before.memory?.endMB, after.memory?.endMB],
    ['heap peak (MiB)', before.memory?.peakMB, after.memory?.peakMB],
    ['leak (MiB/min)', before.memory?.growthMBPerMin, after.memory?.growthMBPerMin],
    ['frame p95 (ms)', before.frameTime?.p95Ms, after.frameTime?.p95Ms],
    ['frame p99 (ms)', before.frameTime?.p99Ms, after.frameTime?.p99Ms],
    ['frame p95 drift', before.frameTime?.p95DriftMs, after.frameTime?.p95DriftMs],
    ['hitches', before.frameTime?.hitches, after.frameTime?.hitches],
    ['geometries end', before.resources?.geometriesEnd, after.resources?.geometriesEnd],
    ['textures end', before.resources?.texturesEnd, after.resources?.texturesEnd],
    ['entities end', before.resources?.entitiesEnd, after.resources?.entitiesEnd],
  ];
  console.log('  BEFORE → AFTER');
  for (const [label, b, a] of rows) {
    const delta = typeof b === 'number' && typeof a === 'number' ? ` (${a - b >= 0 ? '+' : ''}${round2(a - b)})` : '';
    console.log(`    ${label.padEnd(20)} ${String(b ?? '—').padStart(10)} → ${String(a ?? '—').padStart(10)}${delta}`);
  }
  console.log();
}

function fmtSigned(v) {
  if (typeof v !== 'number') return String(v ?? '—');
  return `${v >= 0 ? '+' : ''}${v}`;
}
