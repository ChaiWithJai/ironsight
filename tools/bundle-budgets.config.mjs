/**
 * Per-entry compressed-size budgets. Owned by CORE (tools/**).
 *
 * These are the four Vite entries/chunks docs/BRIEF.md and the perf baseline
 * in issue #2 name explicitly: the game (`main`), its heaviest dependency
 * (`three`, split into its own `manualChunks` bucket in vite.config.ts so it
 * can be reasoned about independently), and the two teaching entries
 * (`learn`, `forge`) that must stay tiny and independently loadable.
 *
 * `budgetBytes` is a hard ceiling on gzip-compressed size, not a
 * baseline-plus-tolerance. That is a deliberate choice: a relative "fail if
 * >10% bigger than last measurement" budget silently ratchets upward one
 * small regression at a time and never gets revisited. A fixed ceiling means
 * every regression that matters shows up as a failing check, and the only way
 * past it is to edit this file — which puts the "why did the budget move" in
 * the PR diff and under review, which is what makes a regression "explained"
 * rather than "unexplained" per issue #2's wording.
 *
 * Measured baseline this file was set against (revision
 * 382ebabe684b18171e2d2b04a0dff51614c63891, 2026-07-29, see issue #2):
 *
 *   main-*.js   1,401.36 KiB gzip (Vite-reported)
 *   three-*.js    147.88 KiB gzip
 *   learn-*.js     15.15 KiB gzip
 *   forge-*.js      2.35 KiB gzip
 *
 * `tools/bundle-budgets.mjs` recomputes gzip itself (zlib, level 9) rather
 * than trusting Vite's own reported number, so the check does not depend on
 * Vite's internal compression settings ever staying the same. Budgets below
 * carry headroom over the measured baseline: enough that routine dependency
 * bumps and small feature additions do not flake the build, not so much that
 * a real regression (e.g. an accidental non-lazy import of `three` from the
 * `learn` or `forge` entries) goes unnoticed.
 */
export const BUNDLE_BUDGETS = {
  main: {
    // The game entry. Heaviest by far and the one most likely to regress
    // silently (a new subsystem's baked-in data, an accidental duplicate of
    // a dependency across chunks, a debug-only import that leaks into prod).
    filePrefix: 'main-',
    budgetBytes: 1_650_000, // ~1.57 MiB gzip; ~18% over the 1,401.36 KiB baseline
  },
  three: {
    // Pinned to its own manualChunks bucket in vite.config.ts specifically so
    // it can carry its own budget independent of game-code churn.
    filePrefix: 'three-',
    budgetBytes: 175_000, // ~171 KiB gzip; ~18% over the 147.88 KiB baseline
  },
  learn: {
    // The /learn/ academy entry. Must stay a small, independent Vite entry —
    // per docs/OWNERSHIP.md's boundary rules it cannot import three or rapier,
    // so any growth here is either real teaching content or a boundary leak.
    filePrefix: 'learn-',
    budgetBytes: 20_000, // ~19.5 KiB gzip; ~32% over the 15.15 KiB baseline
  },
  forge: {
    // The civilization forge entry. Smallest chunk; percentage headroom is
    // deliberately generous because a handful of bytes swings the percentage
    // wildly at this size, but the absolute ceiling still catches anything
    // that would actually matter (e.g. an accidental non-lazy dependency).
    filePrefix: 'forge-',
    budgetBytes: 4_000, // ~3.9 KiB gzip; ~66% over the 2.35 KiB baseline
  },
};
