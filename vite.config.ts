import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Parallel lane agents each run `npm run verify` and `./tools/shoot.sh`. If
    // they all wrote to the same dist/ they would clobber each other's bundle
    // mid-build and produce failures that look like code bugs. Each agent sets
    // IRONSIGHT_DIST=dist-<lane> and gets an isolated output directory; the
    // capture tool reads the same variable so shoots stay isolated too.
    outDir: process.env.IRONSIGHT_DIST || 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  server: { port: 5173, strictPort: false },
  // Rapier ships wasm inlined in the -compat build; keep esbuild from choking on top-level await.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
