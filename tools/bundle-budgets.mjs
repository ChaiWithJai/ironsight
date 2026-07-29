#!/usr/bin/env node
/**
 * Bundle-size budget gate. Owned by CORE (tools/**), part of `npm run verify`.
 *
 * Reads the already-built `dist/assets/` (this script does not build; run
 * `npm run build` first — `npm run verify` already does) and enforces a
 * checked-in gzip-compressed-size ceiling per entry from
 * `tools/bundle-budgets.config.mjs`, for exactly the four entries issue #2's
 * baseline calls out: `main` (the game), `three` (its own manualChunks
 * bucket), `learn` and `forge` (the teaching entries, which must stay tiny
 * and independently loadable).
 *
 * Why gzip and computed here, not read from Vite's own build log: Vite's
 * "gzip size" line is convenient for humans watching a build scroll by, but
 * it is not a machine-checkable artifact, and its compression settings are
 * an internal Vite implementation detail that could change under us between
 * versions. Recomputing with Node's own zlib at a fixed level makes the
 * check reproducible independent of Vite's internals, and gzip (rather than
 * brotli) is what `docs/BRIEF.md`'s baseline and most CDNs/browsers agree on
 * as the common denominator transfer encoding.
 *
 * Why a hard ceiling and not baseline-relative: see the comment at the top of
 * bundle-budgets.config.mjs. In short — a relative budget ratchets upward
 * silently; a fixed ceiling only moves when a human edits this file's config
 * in a reviewed diff, which is what makes a regression "explained" rather
 * than "unexplained".
 *
 * Usage:
 *   npm run build && npm run bundle:budgets
 *   node tools/bundle-budgets.mjs --json
 *   IRONSIGHT_DIST=dist-mylane node tools/bundle-budgets.mjs   (parallel lanes)
 *
 * Exit code 1 if any entry is missing, ambiguous (matches != 1 file) or over
 * budget, so it can gate `npm run verify`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_BUDGETS } from './bundle-budgets.config.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
// gzip level fixed at 9 (max compression) so the number is deterministic
// across Node versions and machines; it is not meant to match any single
// server's runtime compression, only to be a stable, comparable proxy.
const GZIP_LEVEL = 9;

async function findEntryFile(assetsDir, prefix) {
  let names;
  try {
    names = await readdir(assetsDir);
  } catch {
    return { error: `dist/assets not found at ${assetsDir} — run \`npm run build\` first` };
  }
  const matches = names.filter((n) => n.startsWith(prefix) && n.endsWith('.js'));
  if (matches.length === 0) {
    return { error: `no file matching "${prefix}*.js" in ${assetsDir}` };
  }
  if (matches.length > 1) {
    return {
      error: `expected exactly one "${prefix}*.js" chunk, found ${matches.length}: ${matches.join(', ')}`,
    };
  }
  return { file: matches[0] };
}

async function measure(assetsDir, name, cfg) {
  const found = await findEntryFile(assetsDir, cfg.filePrefix);
  if (found.error) {
    return { name, ok: false, error: found.error, budgetBytes: cfg.budgetBytes };
  }
  const path = join(assetsDir, found.file);
  const buf = await readFile(path);
  const rawBytes = buf.byteLength;
  const gzipBytes = gzipSync(buf, { level: GZIP_LEVEL }).byteLength;
  const overBudget = gzipBytes > cfg.budgetBytes;
  return {
    name,
    ok: !overBudget,
    file: found.file,
    rawBytes,
    gzipBytes,
    budgetBytes: cfg.budgetBytes,
    pctOfBudget: (gzipBytes / cfg.budgetBytes) * 100,
  };
}

/**
 * Pure(ish) check, exported for `tools/tests/bundle-budgets.test.mjs`: given a
 * `dist/assets`-shaped directory and a budgets map, measure every entry and
 * report pass/fail. No process.exit, no console output — the CLI wrapper
 * below owns those.
 */
export async function checkBudgets({ assetsDir, budgets = BUNDLE_BUDGETS }) {
  const results = await Promise.all(
    Object.entries(budgets).map(([name, cfg]) => measure(assetsDir, name, cfg)),
  );
  return { ok: results.every((r) => r.ok), results };
}

async function main() {
  const JSON_OUT = process.argv.includes('--json');
  // Matches the same override vite.config.ts honours, so parallel lane agents
  // checking their own isolated dist-<lane>/ get budget-checked against it too.
  const distDir = join(ROOT, process.env.IRONSIGHT_DIST || 'dist');
  const assetsDir = join(distDir, 'assets');

  // Fail fast and clearly if dist/ was never built, rather than reporting
  // every entry as individually missing.
  try {
    await stat(distDir);
  } catch {
    console.error(`[bundle-budgets] ${distDir} does not exist — run \`npm run build\` first.`);
    process.exit(1);
  }

  const { results } = await checkBudgets({ assetsDir });
  const failures = results.filter((r) => !r.ok);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
  } else {
    const rows = results.map((r) => {
      if (r.error) {
        return { entry: r.name, status: 'ERROR', detail: r.error };
      }
      const kib = (n) => `${(n / 1024).toFixed(2)} KiB`;
      return {
        entry: r.name,
        file: r.file,
        gzip: kib(r.gzipBytes),
        budget: kib(r.budgetBytes),
        '% of budget': `${r.pctOfBudget.toFixed(1)}%`,
        status: r.ok ? 'ok' : 'OVER BUDGET',
      };
    });
    console.table(rows);
  }

  if (failures.length > 0) {
    console.error(
      `\n[bundle-budgets] ${failures.length} of ${results.length} entries failed.\n` +
        `If this regression is real and explained (new required feature, a\n` +
        `dependency bump you have reviewed, etc.), raise the relevant budget in\n` +
        `tools/bundle-budgets.config.mjs in this PR and say why in the PR\n` +
        `description. Do not raise it to "make CI green" without that.\n`,
    );
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (`node tools/bundle-budgets.mjs`),
// not when `checkBudgets` is imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[bundle-budgets] unexpected failure:', err);
    process.exit(1);
  });
}
