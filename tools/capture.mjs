#!/usr/bin/env node
/**
 * IRONSIGHT deterministic screenshot harness.
 *
 * Builds the game, serves dist/ on an ephemeral port, drives it through headless
 * Chromium and writes one PNG per named "shot". Shots are declared by the game
 * itself via the window.__HARNESS__ contract (see src/engine/harness.ts), so the
 * capture tool never needs to know anything about scene internals.
 *
 * REQUIRES node >= 20. This repo's dev toolchain runs on node 18, so always
 * invoke through the wrapper, which pins the right runtime:
 *
 *     ./tools/shoot.sh                       # every registered shot
 *     ./tools/shoot.sh --list                # print shot names and exit
 *     ./tools/shoot.sh hero_ridge urban_dusk # a subset
 *     ./tools/shoot.sh --no-build            # reuse existing dist/
 *     ./tools/shoot.sh --out shots/round3    # alternate output dir
 *     ./tools/shoot.sh --width 2560 --height 1440
 *
 * Exit code is non-zero if the build fails, the harness never signals ready, a
 * shot throws, or the page logged an uncaught error — so it doubles as a smoke
 * test in CI-style loops.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
// Mirrors vite.config.ts: parallel lane agents isolate their build output via
// IRONSIGHT_DIST so concurrent verifies cannot clobber each other.
const DIST = resolve(ROOT, process.env.IRONSIGHT_DIST || 'dist');

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT_DIR = resolve(ROOT, opt('--out', 'tools/shots'));
const WIDTH = Number(opt('--width', 1920));
const HEIGHT = Number(opt('--height', 1080));
const LIST_ONLY = flag('--list');
const NO_BUILD = flag('--no-build');
const SHOT_TIMEOUT = Number(opt('--timeout', 240_000));
const requested = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !['--out', '--width', '--height', '--timeout'].includes(prev);
});

const log = (...a) => console.log('[capture]', ...a);
const fail = (msg) => {
  console.error('[capture] FAIL:', msg);
  process.exitCode = 1;
};

// ---------------------------------------------------------------------- build
if (!NO_BUILD) {
  log('building…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fail('vite build failed');
    process.exit(1);
  }
}
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html missing — run without --no-build');
  process.exit(1);
}

// ------------------------------------------------------------- static server
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
  '.ktx2': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
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
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;
log(`serving dist/ at ${BASE}`);

// ------------------------------------------------------------------- browser
// macOS headless has no usable GPU path, so we force ANGLE→SwiftShader. It is a
// complete, conformant WebGL2 implementation: slow, but pixel-accurate, which is
// exactly the tradeoff a screenshot harness wants. Frame budget is expressed in
// frames rendered (see harness.capture), never in wall-clock, so the software
// rasteriser cannot change what a shot looks like.
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--enable-webgl2-compute-context',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--js-flags=--max-old-space-size=8192',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--font-render-hinting=none',
  ],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  reducedMotion: 'no-preference',
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)));
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') consoleErrors.push(m.text());
  if (process.env.CAPTURE_VERBOSE) log(`console.${t}:`, m.text());
});
page.on('crash', () => pageErrors.push('PAGE CRASHED'));

log('loading…');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

// The game flips __HARNESS__.ready once every subsystem has finished its async
// warm-up (shader compiles, texture bakes, physics wasm, audio graph).
try {
  await page.waitForFunction(() => globalThis.__HARNESS__?.ready === true, null, {
    timeout: 300_000,
    polling: 250,
  });
} catch {
  const diag = await page.evaluate(() => ({
    harness: typeof globalThis.__HARNESS__,
    status: globalThis.__HARNESS__?.status ?? null,
    webgl: (() => {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl2') || c.getContext('webgl'));
      } catch (e) {
        return `err:${e}`;
      }
    })(),
  })).catch(() => ({}));
  fail(`harness never became ready. diag=${JSON.stringify(diag)}`);
  for (const e of [...pageErrors, ...consoleErrors].slice(0, 20)) console.error('  ', e);
  await browser.close();
  server.close();
  process.exit(1);
}
log('harness ready');

const available = await page.evaluate(() => globalThis.__HARNESS__.shots());
if (LIST_ONLY) {
  console.log(available.join('\n'));
  await browser.close();
  server.close();
  process.exit(0);
}

const targets = requested.length ? requested : available;
const unknown = targets.filter((t) => !available.includes(t));
if (unknown.length) {
  fail(`unknown shot(s): ${unknown.join(', ')}\n  available: ${available.join(', ')}`);
  await browser.close();
  server.close();
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
const manifest = [];

for (const name of targets) {
  const t0 = Date.now();
  process.stdout.write(`[capture] ${name} … `);
  try {
    const meta = await page.evaluate(
      async ([n, timeout]) => {
        const done = globalThis.__HARNESS__.capture(n);
        const guard = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('shot timed out in-page')), timeout - 5000),
        );
        return await Promise.race([done, guard]);
      },
      [name, SHOT_TIMEOUT],
      { timeout: SHOT_TIMEOUT },
    );
    const canvas = page.locator('canvas').first();
    const file = join(OUT_DIR, `${name}.png`);
    await canvas.screenshot({ path: file, animations: 'disabled', timeout: 120_000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`ok (${secs}s)`);
    manifest.push({ name, file, meta: meta ?? null, seconds: Number(secs) });
  } catch (e) {
    console.log('ERROR');
    fail(`shot "${name}": ${e?.message ?? e}`);
  }
}

if (pageErrors.length || consoleErrors.length) {
  fail(`${pageErrors.length} uncaught error(s), ${consoleErrors.length} console error(s)`);
  for (const e of [...pageErrors, ...consoleErrors].slice(0, 30)) console.error('  ', e);
}

await writeFile(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ width: WIDTH, height: HEIGHT, shots: manifest }, null, 2),
);
log(`wrote ${manifest.length} shot(s) → ${OUT_DIR}`);

await browser.close();
server.close();
