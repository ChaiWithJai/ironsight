#!/usr/bin/env node
/**
 * Blind A/B comparison sheet builder.
 *
 * Composites one of our captured frames beside a reference frame into a single
 * PNG, labelled only "A" and "B", with the left/right assignment randomised. The
 * answer key is written to a SEPARATE directory (tools/compare/.keys/) that
 * critics are instructed never to open, so a critic asked "which of these is the
 * shipped AAA frame?" is genuinely blind when they answer.
 *
 * This is the mechanism that keeps the critic loop honest: it is very easy to
 * rate your own work generously when you know which one is yours.
 *
 * Usage:
 *   ./tools/compare.sh --ours tools/shots/hero_ridge.png \
 *                      --ref  reference/battlefield/bf6_00.jpg \
 *                      --out  tools/compare/hero_ridge_vs_bf6.png
 *
 *   ./tools/compare.sh --reveal tools/compare/hero_ridge_vs_bf6.png
 *       -> prints which panel was ours (for use AFTER a verdict is recorded)
 *
 * Requires node >= 20; always invoke via tools/compare.sh.
 */
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

// ------------------------------------------------------------------- reveal
const reveal = opt('--reveal', null);
if (reveal) {
  const keyFile = join(dirname(resolve(ROOT, reveal)), '.keys', basename(reveal) + '.json');
  if (!existsSync(keyFile)) {
    console.error(`no answer key for ${reveal}`);
    process.exit(1);
  }
  console.log(readFileSync(keyFile, 'utf8'));
  process.exit(0);
}

const OURS = resolve(ROOT, opt('--ours', ''));
const REF = resolve(ROOT, opt('--ref', ''));
const OUT = resolve(ROOT, opt('--out', 'tools/compare/compare.png'));
const LAYOUT = opt('--layout', 'side'); // side | stack
const PANEL_W = Number(opt('--panel-width', 1280));

for (const [label, p] of [
  ['--ours', OURS],
  ['--ref', REF],
]) {
  if (!p || !existsSync(p)) {
    console.error(`${label}: file not found (${p})`);
    process.exit(1);
  }
}

const mime = (p) => (extname(p).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
const dataUri = async (p) => `data:${mime(p)};base64,${(await readFile(p)).toString('base64')}`;

// Randomise which side ours lands on, but derive it from a hash of the pair so a
// given comparison is stable across reruns — a critic re-reviewing the same sheet
// must not see the panels silently swap under them.
const h = createHash('sha256').update(`${basename(OURS)}|${basename(REF)}`).digest();
const oursIsA = (h[0] & 1) === 0;

const [oursUri, refUri] = await Promise.all([dataUri(OURS), dataUri(REF)]);
const panelA = oursIsA ? oursUri : refUri;
const panelB = oursIsA ? refUri : oursUri;

const gap = 8;
const isSide = LAYOUT === 'side';
// Both sources are 16:9; keep them at identical display size so neither gets a
// resolution or aspect advantage that would leak which is which.
const panelH = Math.round((PANEL_W * 9) / 16);
const pageW = isSide ? PANEL_W * 2 + gap * 3 : PANEL_W + gap * 2;
const pageH = isSide ? panelH + gap * 2 + 34 : panelH * 2 + gap * 3 + 68;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#000;width:${pageW}px;height:${pageH}px;
       display:grid;gap:${gap}px;padding:${gap}px;
       grid-template-columns:${isSide ? `repeat(2,${PANEL_W}px)` : `${PANEL_W}px`};
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  figure{display:flex;flex-direction:column;gap:6px}
  img{width:${PANEL_W}px;height:${panelH}px;object-fit:cover;display:block}
  figcaption{color:#e8e8e8;font-size:20px;letter-spacing:.24em;text-align:center}
</style></head><body>
  <figure><img src="${panelA}"><figcaption>A</figcaption></figure>
  <figure><img src="${panelB}"><figcaption>B</figcaption></figure>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: pageW, height: pageH }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())));
await mkdir(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
await browser.close();

await mkdir(join(dirname(OUT), '.keys'), { recursive: true });
await writeFile(
  join(dirname(OUT), '.keys', basename(OUT) + '.json'),
  JSON.stringify(
    {
      sheet: OUT.replace(ROOT + '/', ''),
      A: oursIsA ? 'IRONSIGHT (ours)' : `reference: ${basename(REF)}`,
      B: oursIsA ? `reference: ${basename(REF)}` : 'IRONSIGHT (ours)',
      oursPanel: oursIsA ? 'A' : 'B',
    },
    null,
    2,
  ),
);

console.log(`wrote ${OUT.replace(ROOT + '/', '')}  (key hidden in .keys/)`);
