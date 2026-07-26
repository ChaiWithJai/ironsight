#!/usr/bin/env node
/**
 * Frame integrity check. Owned by CORE. Run it on any PNG from `tools/shots/`.
 *
 *     ./tools/check-frame.sh tools/shots/level_overview.png
 *     ./tools/check-frame.sh tools/shots/*.png --json
 *     ./tools/check-frame.sh a.png --max-stipple 0.4      # non-zero exit if over
 *
 * WHY THIS EXISTS, AND WHY A HISTOGRAM IS NOT ENOUGH
 * -------------------------------------------------
 * `level_overview` shipped a far-field z-fight for a whole review round because
 * the check that was run against it was a HISTOGRAM comparison, and the two
 * builds' histograms "matched to a digit". They would: z-fighting swaps which of
 * two surfaces wins on a per-pixel basis, and both surfaces are already in the
 * frame. It moves pixels around; it does not change how many of each value there
 * are. Any purely tonal metric — histogram, mean, percentiles, even SSIM against
 * a reference of a different scene — is structurally blind to it.
 *
 * What z-fighting DOES change is spatial: on a surface seen near edge-on (which
 * is every ground plane in a wide shot) the two contenders swap along SCANLINES,
 * because the rasteriser interpolates depth per scanline and the depth quantum is
 * crossed row by row. The result is a field of one-pixel-tall horizontal runs
 * whose value is an outlier against BOTH vertical neighbours while those
 * neighbours agree with each other. Real content — a roof edge, a wire, a wave
 * crest, film grain — does not do that: an edge makes the neighbours DISAGREE,
 * and grain is not horizontally coherent.
 *
 * So the metric is:
 *
 *   stipple(x,y) = |L - (L_up + L_down)/2| > HI          the pixel is an outlier
 *              AND |L_up - L_down|        < LO           …but its neighbours agree
 *              AND run length >= MIN_RUN horizontally    …and it is a RUN, not grain
 *
 * reported as a percentage of the frame, plus the same figure for the top third
 * (the far field in any wide shot, and where depth precision is worst).
 *
 * CALIBRATION — far-field figure, measured on this repo's own captures:
 *
 *   core 0.000 · terrain_headland 0.003 · level_charlie 0.007 · water_golden
 *   0.010 · hud_combat 0.012 · level_alpha 0.047        all structurally clean
 *   level_overview 1.541 (TAA on) · 6.651 (TAA off)     the far-field z-fight
 *
 * The default ceiling of 0.3 % sits an order of magnitude above every clean
 * frame and an order of magnitude below the broken one. It is deliberately NOT
 * set at the clean figure: this is a "the frame is structurally broken" alarm,
 * not a sharpness grader. Grain, dither and honest aliasing must never trip it
 * or it will start being ignored, which is the only way a check like this ever
 * fails.
 *
 * Zero dependencies beyond the playwright already used by `tools/compare.mjs` —
 * chromium is the PNG decoder, same as there.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const JSON_OUT = argv.includes('--json');
/**
 * Percent of the TOP THIRD of the frame. The far field is where depth precision
 * is worst and where every wide shot's z-fight lives, and it is also the part of
 * a frame with the least legitimate one-pixel detail — so it separates broken
 * from clean by 20x while the whole-frame figure only manages 2x.
 */
const MAX_STIPPLE = Number(opt('--max-stipple', 0.3));

const files = argv.filter((a, i) => !a.startsWith('--') && !['--max-stipple'].includes(argv[i - 1]));
if (files.length === 0) {
  console.error('usage: check-frame.sh <frame.png> [more.png…] [--json] [--max-stipple PCT]');
  process.exit(2);
}
for (const f of files) {
  if (!existsSync(resolve(ROOT, f))) {
    console.error(`not found: ${f}`);
    process.exit(2);
  }
}

/**
 * Runs in the page, on an ImageData of the frame.
 *
 * Thresholds are on 0–255 luma. HI = 10 is ~4 % of range: above 8-bit dither and
 * above this project's grain, and low enough to still catch a z-fight that TAA
 * has averaged down over an 8-frame history — which is the case that matters,
 * because every shipped frame has TAA on. LO = 6 keeps a genuine gradient (where
 * the vertical neighbours legitimately differ) out of the count.
 */
function analyse(data, width, height) {
  const HI = 10;
  const LO = 6;
  const MIN_RUN = 3;
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    // Rec.709 luma on the display-referred PNG. Exactness does not matter here;
    // consistency between the three samples does.
    lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }

  const flag = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const up = lum[i - width];
      const down = lum[i + width];
      if (Math.abs(up - down) >= LO) continue; // a real edge: neighbours disagree
      if (Math.abs(lum[i] - (up + down) * 0.5) <= HI) continue;
      flag[i] = 1;
    }
  }

  // Keep only horizontal runs: a z-fight paints scanline segments, grain does not.
  let count = 0;
  let farCount = 0;
  const farRows = Math.floor(height / 3);
  for (let y = 1; y < height - 1; y++) {
    let x = 0;
    while (x < width) {
      if (!flag[y * width + x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < width && flag[y * width + end]) end++;
      const run = end - x;
      if (run >= MIN_RUN) {
        count += run;
        if (y < farRows) farCount += run;
      }
      x = end;
    }
  }

  const total = width * height;
  const farTotal = width * farRows;
  return {
    width,
    height,
    stipplePct: (count / total) * 100,
    farFieldStipplePct: (farCount / farTotal) * 100,
    meanLuma: lum.reduce((a, b) => a + b, 0) / total,
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const results = [];
for (const f of files) {
  const abs = resolve(ROOT, f);
  const mime = extname(abs).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const uri = `data:${mime};base64,${(await readFile(abs)).toString('base64')}`;
  const r = await page.evaluate(
    async ({ uri, src }) => {
      const img = new Image();
      img.src = uri;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      // eslint-disable-next-line no-eval
      return eval(`(${src})`)(data, c.width, c.height);
    },
    { uri, src: analyse.toString() },
  );
  results.push({ file: relative(ROOT, abs), ...r });
}
await browser.close();

const failures = results.filter((r) => r.farFieldStipplePct > MAX_STIPPLE);

if (JSON_OUT) {
  console.log(JSON.stringify({ maxStipplePct: MAX_STIPPLE, results, ok: failures.length === 0 }, null, 2));
} else {
  const pad = Math.max(...results.map((r) => r.file.length));
  for (const r of results) {
    const bad = r.farFieldStipplePct > MAX_STIPPLE;
    console.log(
      `${r.file.padEnd(pad)}  stipple ${r.stipplePct.toFixed(3).padStart(7)}%` +
        `  far-field ${r.farFieldStipplePct.toFixed(3).padStart(7)}%` +
        `  mean-luma ${r.meanLuma.toFixed(1).padStart(5)}` +
        `  ${bad ? 'FAIL — structural artefact (z-fight / torn resolve)' : 'ok'}`,
    );
  }
}

process.exit(failures.length === 0 ? 0 : 1);
