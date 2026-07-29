#!/usr/bin/env node
/**
 * Bundles `tools/tests/*.test.ts` into plain ESM under `tools/tests/.compiled/`
 * so `node --test` can run them directly.
 *
 * Why not run the `.ts` files straight through `node --test`, the way
 * `world-profile.test.mjs` does? Because that relies on Node's own
 * `--experimental-strip-types`, which only ERASES type syntax — it rejects
 * TypeScript enums and constructor parameter properties outright (both of
 * which `src/` uses throughout, per project convention). Vite's own esbuild
 * transform handles the full language and already owns the project's `@/`
 * alias (`vite.config.ts`), so reusing it here — rather than adding a test
 * framework or a second alias-resolution mechanism — is the smallest thing
 * that actually compiles a lane's real source for a test to import.
 */
import { build } from 'vite';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../../../');
const testDir = path.join(root, 'tools/tests');
const outDir = path.join(testDir, '.compiled');

const entries = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

if (entries.length === 0) {
  console.log('[compile] no .test.ts files found, nothing to do');
  process.exit(0);
}

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    lib: {
      entry: entries,
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      // node:test/node:assert plus anything else Node ships natively —
      // bundling those would be pointless and rollup can't anyway.
      external: (id) => id.startsWith('node:'),
    },
  },
});

for (const entry of entries) {
  console.log(`[compile] ${path.relative(root, entry)} -> ${path.relative(root, outDir)}/${path.basename(entry, '.ts')}.mjs`);
}
