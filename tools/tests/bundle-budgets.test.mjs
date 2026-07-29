import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { checkBudgets } from '../bundle-budgets.mjs';

async function withAssetsDir(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-budgets-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('passes when every entry is under its budget', async () => {
  const smallPayload = 'a'.repeat(100); // gzips to well under any of our budgets
  await withAssetsDir(
    {
      'main-abc123.js': smallPayload,
      'three-def456.js': smallPayload,
      'learn-ghi789.js': smallPayload,
      'forge-jkl012.js': smallPayload,
    },
    async (assetsDir) => {
      const { ok, results } = await checkBudgets({
        assetsDir,
        budgets: { main: { filePrefix: 'main-', budgetBytes: 1000 } },
      });
      assert.equal(ok, true);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true);
      assert.equal(results[0].file, 'main-abc123.js');
    },
  );
});

test('fails when an entry exceeds its budget', async () => {
  // Incompressible-ish payload so gzip doesn't shrink it below the budget.
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  await withAssetsDir({ 'main-abc123.js': bytes }, async (assetsDir) => {
    const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
    const { ok, results } = await checkBudgets({
      assetsDir,
      budgets: { main: { filePrefix: 'main-', budgetBytes: gzipBytes - 1 } },
    });
    assert.equal(ok, false);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].gzipBytes, gzipBytes);
  });
});

test('reports a clear error when no file matches the entry prefix', async () => {
  await withAssetsDir({ 'other-abc123.js': 'x' }, async (assetsDir) => {
    const { ok, results } = await checkBudgets({
      assetsDir,
      budgets: { main: { filePrefix: 'main-', budgetBytes: 1000 } },
    });
    assert.equal(ok, false);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /no file matching/);
  });
});

test('reports a clear error when the entry prefix is ambiguous', async () => {
  await withAssetsDir(
    { 'main-abc123.js': 'x', 'main-xyz999.js': 'y' },
    async (assetsDir) => {
      const { ok, results } = await checkBudgets({
        assetsDir,
        budgets: { main: { filePrefix: 'main-', budgetBytes: 1000 } },
      });
      assert.equal(ok, false);
      assert.match(results[0].error, /expected exactly one/);
    },
  );
});

test('reports a clear error when dist/assets does not exist at all', async () => {
  const { ok, results } = await checkBudgets({
    assetsDir: '/nonexistent/dist/assets/for/sure',
    budgets: { main: { filePrefix: 'main-', budgetBytes: 1000 } },
  });
  assert.equal(ok, false);
  assert.match(results[0].error, /dist\/assets not found/);
});

test('the real BUNDLE_BUDGETS config covers exactly main, three, learn, forge', async () => {
  const { BUNDLE_BUDGETS } = await import('../bundle-budgets.config.mjs');
  assert.deepEqual(Object.keys(BUNDLE_BUDGETS).sort(), ['forge', 'learn', 'main', 'three']);
  for (const [name, cfg] of Object.entries(BUNDLE_BUDGETS)) {
    assert.ok(cfg.filePrefix.endsWith('-'), `${name}.filePrefix should end with "-"`);
    assert.ok(cfg.budgetBytes > 0, `${name}.budgetBytes should be positive`);
  }
});
