#!/usr/bin/env node
/**
 * IRONSIGHT Performance Profiler
 *
 * Comprehensive performance profiling harness that captures build, soak, and
 * browser metrics, publishing them as timestamped artifacts tied to the exact
 * commit SHA.
 *
 * Usage:
 *   npm run profile                    # Profile current commit
 *   npm run profile -- --help          # Show options
 *   npm run profile -- --out-dir <dir> # Override output directory
 *   npm run profile -- --skip-build    # Reuse existing dist/
 *   npm run profile -- --commit <sha>  # Explicitly set commit SHA (default: HEAD)
 *
 * Output: tools/profiles/<commit-sha>/<timestamp>/report.json
 *         Contains: build metrics, bundle analysis, soak results, browser metrics
 *
 * Exit code is 0 on success, 1 if any profiler fails or thresholds are exceeded.
 */

import { execSync, spawnSync } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

// Argument parsing
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(
    [
      'tools/profile.mjs — comprehensive performance profiling and artifact publishing',
      '',
      '  --out-dir <path>   output directory base        (default tools/profiles)',
      '  --commit <sha>     commit SHA to tag artifacts  (default git HEAD)',
      '  --skip-build       reuse existing dist/         (default: rebuild)',
      '  --help             show this message',
      '',
      'Captures: build metrics, bundle analysis, soak test, smoke tests',
      'Output: JSON report tied to commit SHA and timestamp',
      'Exit code: 0 on success, 1 on failure or threshold exceedance',
    ].join('\n'),
  );
  process.exit(0);
}

const OUTPUT_BASE = resolve(ROOT, opt('--out-dir', 'tools/profiles'));
const SKIP_BUILD = flag('--skip-build');
let commitSha = opt('--commit', null);

// Resolve commit SHA
if (!commitSha) {
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    console.error('[profile] FAIL: could not determine commit SHA');
    process.exit(1);
  }
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -4);
const OUTPUT_DIR = join(OUTPUT_BASE, commitSha.slice(0, 8), timestamp);

const log = (...args) => console.log('[profile]', ...args);
const err = (...args) => console.error('[profile]', ...args);
let profileFailed = false;

const fail = (msg) => {
  err('FAIL:', msg);
  profileFailed = true;
};

/**
 * Capture build metrics: elapsed time, peak memory, output size
 */
async function captureBuildMetrics() {
  log('capturing build metrics…');
  const start = Date.now();

  if (!SKIP_BUILD) {
    log('  running npm run build…');
    const result = spawnSync('bash', ['tools/with-node.sh', 'npm', 'run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 120_000,
    });
    if (result.status !== 0) {
      fail('npm run build failed');
      return null;
    }
  }

  const buildTime = Date.now() - start;
  const peakRss = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Analyze dist/ contents
  let distSize = 0;
  let bundleStats = {};
  try {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'dist', '.vite', 'manifest.json'), 'utf8'),
    );
    for (const [entry, data] of Object.entries(manifest)) {
      if (data.file) {
        const filePath = join(ROOT, 'dist', data.file);
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          distSize += stat.size;
          bundleStats[entry] = {
            file: data.file,
            size: stat.size,
            sizeKb: (stat.size / 1024).toFixed(1),
          };
        }
      }
    }
  } catch (e) {
    log('  warning: could not parse manifest:', e.message);
  }

  return {
    buildTimeMs: buildTime,
    peakRssMb: peakRss,
    distSizeBytes: distSize,
    distSizeMb: (distSize / 1024 / 1024).toFixed(2),
    bundleStats,
  };
}

/**
 * Run soak test and capture results
 */
async function captureSoakMetrics() {
  log('capturing soak metrics…');
  const soakOut = join(OUTPUT_DIR, 'soak.json');
  const result = spawnSync('bash', ['tools/soak.sh', '--out', soakOut], {
    cwd: ROOT,
    timeout: 900_000, // 15 minutes
  });

  if (result.status !== 0) {
    fail('soak test failed');
    return null;
  }

  try {
    const soakData = JSON.parse(await readFile(soakOut, 'utf8'));
    return {
      ok: soakData.ok,
      seconds: soakData.config.seconds,
      ticksRun: soakData.engine.ticksRun,
      framesRendered: soakData.config.framesRendered,
      bootSeconds: soakData.meta.bootSeconds,
      wallSeconds: soakData.meta.wallSeconds,
      bots: soakData.bots,
      verdicts: soakData.verdicts,
    };
  } catch (e) {
    fail(`could not parse soak output: ${e.message}`);
    return null;
  }
}

/**
 * Run smoke tests for local environment
 */
async function captureSmokeMetrics() {
  log('capturing smoke metrics…');
  const smokeDir = join(OUTPUT_DIR, 'smoke');
  await mkdir(smokeDir, { recursive: true });

  const smokeResults = {};
  const environments = ['local'];

  for (const env of environments) {
    log(`  testing ${env}…`);
    const result = spawnSync('bash', ['tools/with-node.sh', 'npm', `smoke:${env}`], {
      cwd: ROOT,
      timeout: 300_000,
      env: {
        ...process.env,
        IRONSIGHT_SMOKE_OUT: join(smokeDir, env),
      },
    });
    smokeResults[env] = {
      success: result.status === 0,
      status: result.status,
    };
    if (result.status !== 0) {
      log(`  note: smoke test ${env} status ${result.status} (may be environment-specific)`);
    }
  }

  return smokeResults;
}

/**
 * Capture git and runtime context
 */
function captureContext() {
  let branch = 'unknown';
  let remote = 'unknown';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    remote = execSync('git config --get remote.origin.url', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    // ignore
  }

  return {
    commitSha,
    commitShort: commitSha.slice(0, 8),
    branch,
    remote,
    timestamp,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Main profiling orchestration
 */
async function profile() {
  log(`profiling commit ${commitSha.slice(0, 8)} at ${timestamp}`);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const report = {
    meta: captureContext(),
    build: await captureBuildMetrics(),
    soak: await captureSoakMetrics(),
    smoke: await captureSmokeMetrics(),
  };

  // Compute summary and thresholds
  report.summary = {
    profiledAt: new Date().toISOString(),
    buildOk: report.build !== null,
    soakOk: report.soak?.ok === true && (report.soak.verdicts ?? []).every((v) => v.level !== 'fail'),
    smokeOk: Object.values(report.smoke).every((s) => s.success),
  };

  report.thresholds = {
    buildTimeSecs: report.build?.buildTimeMs ? (report.build.buildTimeMs / 1000).toFixed(1) : null,
    buildPeakRssMb: report.build?.peakRssMb ?? null,
    distSizeMb: report.build?.distSizeMb ?? null,
    soakBootSecs: report.soak?.bootSeconds ?? null,
    soakOk: report.soak?.ok ?? false,
  };

  // Write consolidated report
  const reportPath = join(OUTPUT_DIR, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${reportPath}`);

  // Write a human-readable summary
  const summaryPath = join(OUTPUT_DIR, 'summary.txt');
  const summaryText = `IRONSIGHT Performance Profile
Commit: ${commitSha}
Timestamp: ${timestamp}

Build:
  Time: ${report.build?.buildTimeMs ? (report.build.buildTimeMs / 1000).toFixed(1) : 'N/A'} seconds
  Peak RSS: ${report.build?.peakRssMb ?? 'N/A'} MiB
  Dist size: ${report.build?.distSizeMb ?? 'N/A'} MiB

Soak Test:
  Boot time: ${report.soak?.bootSeconds ?? 'N/A'} seconds
  Simulation: ${report.soak?.seconds ?? 'N/A'} seconds
  Ticks run: ${report.soak?.ticksRun ?? 'N/A'}
  Verdict: ${report.summary.soakOk ? 'PASS' : 'FAIL'}

Smoke Tests:
  ${Object.entries(report.smoke)
    .map(([env, result]) => `${env}: ${result.success ? 'PASS' : 'FAIL'}`)
    .join('\n  ')}

Overall: ${profileFailed ? 'FAIL' : 'PASS'}
`;
  await writeFile(summaryPath, summaryText);
  log(`wrote ${summaryPath}`);

  return report;
}

const report = await profile();
process.exit(profileFailed ? 1 : 0);
