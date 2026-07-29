#!/usr/bin/env node
/**
 * Deterministic screenshot harness for the /learn/ academy — the same idea as
 * tools/capture.mjs, scaled to the teaching lane: build, serve dist/, drive
 * headless Chromium to every chapter with ?frozen (which pins each demo to a
 * fixed, seeded state), and write one PNG per chapter.
 *
 *     ./tools/learn-shots.sh                 # all chapters
 *     ./tools/learn-shots.sh seed gate       # a subset
 *     ./tools/learn-shots.sh --no-build      # reuse existing dist/
 *
 * Exit code is non-zero if the build fails, the page never signals ready, or
 * the page logs ANY console error — so a green run doubles as a smoke test.
 * Because every demo is a pure function of (seed, tick), the PNGs are stable
 * and meaningfully diffable between commits.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const DIST = resolve(ROOT, process.env.IRONSIGHT_DIST || 'dist');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT_DIR = resolve(ROOT, opt('--out', 'tools/shots'));
const NO_BUILD = flag('--no-build');
const requested = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

const log = (...a) => console.log('[learn-shots]', ...a);
let failed = false;
const fail = (msg) => {
  console.error('[learn-shots] FAIL:', msg);
  failed = true;
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
if (!existsSync(join(DIST, 'learn', 'index.html'))) {
  fail('dist/learn/index.html missing — run without --no-build');
  process.exit(1);
}

// ------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const PORT = server.address().port;
log(`serving ${DIST} on :${PORT}`);

// -------------------------------------------------------------------- capture
// Prefer a pre-provisioned Chromium (e.g. remote agent containers expose one
// at /opt/pw-browsers/chromium) over Playwright's own download, which may not
// match the pinned playwright version on a fresh machine.
const CHROMIUM_BIN = process.env.LEARN_CHROMIUM_BIN || '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  existsSync(CHROMIUM_BIN) ? { executablePath: CHROMIUM_BIN } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') fail(`console error: ${m.text()}`);
});

await mkdir(OUT_DIR, { recursive: true });

// Ask the page itself which chapters exist — the tool knows nothing about them.
await page.goto(`http://127.0.0.1:${PORT}/learn/?frozen`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__LEARN__?.ready === true, null, { timeout: 30_000 });
const chapters = await page.evaluate(() => window.__LEARN__.chapters);
const wanted = requested.length ? chapters.filter((c) => requested.includes(c)) : chapters;
for (const miss of requested.filter((r) => !chapters.includes(r))) fail(`unknown chapter "${miss}"`);

for (const id of wanted) {
  await page.goto(`http://127.0.0.1:${PORT}/learn/?frozen#/${id}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__LEARN__?.ready === true, null, { timeout: 30_000 });
  const file = join(OUT_DIR, `learn_${id}.png`);
  const png = await page.screenshot({ fullPage: true });
  await writeFile(file, png);
  log(`captured ${id} → ${file} (${png.length.toLocaleString('en-US')} bytes)`);
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
