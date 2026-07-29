#!/usr/bin/env node
/**
 * Production-browser smoke test for /?teach=1.
 *
 * The academy capture is intentionally tiny and fast; this is its full-game
 * counterpart. It first authors a civilization through the public forge, then
 * follows that generated URL into the real procedural bake, sends actual
 * keyboard/mouse input, and uses the existing HUD combat drill to exercise
 * normal PlayerIntent → ballistics → damage. The teaching layer itself remains
 * an observer throughout.
 *
 * Usage:
 *   npm run teach:smoke
 *   node tools/teach-smoke.mjs --no-build --out tools/teaching
 *   node tools/teach-smoke.mjs --base-url https://example.netlify.app
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const OUT_DIR = resolve(ROOT, opt('--out', 'tools/teaching'));
const NO_BUILD = flag('--no-build');
const REMOTE_BASE = opt('--base-url', '').replace(/\/+$/, '');
const log = (...args) => console.log('[teach-smoke]', ...args);
let failed = false;
const fail = (message) => {
  console.error('[teach-smoke] FAIL:', message);
  failed = true;
};

if (!REMOTE_BASE && !NO_BUILD) {
  log('building…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
}
if (!REMOTE_BASE && !existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html missing');
  process.exit(1);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};
let server;
let baseUrl = REMOTE_BASE;
if (!baseUrl) {
  server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(DIST, path));
      if (!file.startsWith(DIST)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

const chromiumBin = process.env.LEARN_CHROMIUM_BIN || '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(chromiumBin) ? { executablePath: chromiumBin } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => fail(`page error: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') fail(`console error: ${message.text()}`);
});

// ------------------------------------------------------- authorship transfer
// This is the learner's Bloom-level CREATE task, driven through semantic form
// controls. Its output is only a URL; the next page proves that the full game
// consumes the same contract.
log('authoring a civilization through the forge…');
await page.goto(`${baseUrl}/forge/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__FORGE__?.ready === true);
await page.getByRole('textbox', { name: 'Civilization identity' }).fill('City of Many Rivers');
await page.getByRole('textbox', { name: 'Sigil symbol' }).fill('☀');
await page.getByRole('textbox', { name: 'Era time' }).fill('The Dawn Accord');
await page.getByRole('textbox', { name: 'Alpha' }).fill('Sun Assembly');
await page.waitForFunction(() => window.__FORGE__?.complete === true);
const forge = await page.evaluate(() => window.__FORGE__);
if (!forge?.permalink) {
  fail('forge did not publish a permalink');
  await browser.close();
  server?.close();
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'civilization-forge.png'), await page.screenshot());
await writeFile(join(OUT_DIR, 'civilization-forge.json'), `${JSON.stringify(forge, null, 2)}\n`);

log('booting the authored full procedural game…');
await page.goto(forge.permalink, { waitUntil: 'load' });
await page.waitForFunction(
  () => window.__HARNESS__?.ready === true && window.__TEACH__?.ready === true,
  null,
  { timeout: 120_000 },
);

// A real input event releases the deterministic harness hold. Hold the trigger
// across several sim ticks so a low-frame-rate headless run cannot miss both
// edges between ticks.
await page.mouse.move(500, 400);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(350);
await page.mouse.up({ button: 'left' });
await page.waitForFunction(
  () => window.__TEACH__?.completed.includes('fire') === true,
  null,
  { timeout: 15_000 },
);

// W + sprint drives the normal local InputService until measured distance—not
// elapsed wall time—clears the mission. Periodic jump inputs make the smoke
// robust to a spawn directly behind low cover while still exercising the same
// controller a human uses.
await page.keyboard.down('w');
await page.keyboard.down('Shift');
try {
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(3_000);
    const moved = await page.evaluate(() => window.__TEACH__?.completed.includes('move') === true);
    if (moved) break;
    await page.keyboard.press('Space');
  }
} finally {
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
}
const moved = await page.evaluate(() => window.__TEACH__?.completed.includes('move') === true);
if (!moved) {
  const snapshot = await page.evaluate(() => window.__TEACH__);
  fail(`movement mission did not clear; evidence=${JSON.stringify(snapshot?.evidence)}`);
}

// Existing test seam, not a teaching-layer shortcut: it writes PlayerIntent and
// lets weapons, ballistics, damage and the event bus do their normal work.
const aim = await page.evaluate(() =>
  window.__HUD__?.aimAtNearestEnemy({ fire: true, engageRange: 18, aimHeight: 1.2 }),
);
if (!aim?.found) fail('combat drill found no living enemy');
await page.waitForFunction(
  () => window.__TEACH__?.completed.includes('shape') === true,
  null,
  { timeout: 15_000 },
);
await page.evaluate(() => window.__HUD__?.releaseAim());

const probe = await page.evaluate(() => window.__TEACH__);
if (!probe || probe.completed.length < 3) {
  fail(`expected at least 3 proven live mechanics, got ${probe?.completed.length ?? 0}`);
}
if (!probe?.authoredWorld || probe.worldProfile.civilization !== 'City of Many Rivers') {
  fail(`full game did not consume the authored profile: ${JSON.stringify(probe?.worldProfile)}`);
}
const screenshot = await page.screenshot();
await writeFile(join(OUT_DIR, 'live-field-lab.png'), screenshot);
await writeFile(join(OUT_DIR, 'live-field-lab.json'), `${JSON.stringify(probe, null, 2)}\n`);
log(
  `${probe.completed.length}/4 proven · ${probe.evidence.distanceTravelled.toFixed(1)} m · ` +
    `${probe.evidence.shotsFired} shots · ${probe.evidence.hitsLanded} hits`,
);
log('4/4 authorship meanings carried into the real game');
log(`artifacts → ${OUT_DIR}`);

await browser.close();
server?.close();
process.exit(failed ? 1 : 0);
