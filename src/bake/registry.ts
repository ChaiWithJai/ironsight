/**
 * AssetRegistry — every byte of art in this game comes out of here.
 *
 * OWNER: BAKE. Day-0 stub: `NullAssetRegistry` from `src/bootstrap/nulls.ts`,
 * which already does the scheduling half of the job for real — declarations,
 * topological resolution over `dependsOn`, cost-weighted aggregate progress,
 * unit-ceiling enforcement by resolution degradation, and a frame yield between
 * steps. What it does NOT have is a GPU device, a worker pool, an IndexedDB
 * cache or CPU/GPU-matched noise.
 *
 * BAKE: replace the BODY of this file, keep these three exports, their
 * signatures and this path. You are Wave 1a and half the project is behind you.
 *
 * `assets` is the one descriptor constructed BEFORE the others, so `ctx.assets`
 * is deliberately unavailable inside `createAssetRegistry` — you are it. Every
 * other field of the `BootContext` is live.
 *
 * THE CONSTRAINT THAT SIZES YOUR WHOLE LANE: `tools/capture.mjs` hard-fails at
 * 300 s waiting for `ready`. Playwright uses a fresh profile per run, so
 * IndexedDB NEVER hits and captures ALWAYS COLD-BAKE — under SwiftShader, where
 * GPU bakes run 20–60× slower. The capture path, not the dev path, is what
 * sizes the budget. Enforce `BakeProfile.unitCeiling` from day one; do not
 * retrofit it after four lanes have each added 300 units of work.
 */
import type { AssetRegistry, BootContext, QualitySettings } from '@/engine/types';
import { NullAssetRegistry } from '@/bootstrap/nulls';
// `src/engine/clock.ts` is the project's ONE wall-clock source; boundary CI
// forbids `performance.now()` everywhere else, and bake duration reporting is
// not simulation, so importing it here is correct rather than a loophole.
import { nowMs } from '@/engine/clock';

export function createAssetRegistry(ctx: BootContext): AssetRegistry {
  return new NullAssetRegistry(
    ctx.renderer,
    () => ctx.quality.settings,
    ctx.rng.fork('bake'),
    nowMs,
  );
}

/**
 * BAKE's own steps: the noise basis volumes, the BRDF LUT, blue noise and the
 * grade LUT — everything §6.1 of the architecture lists with no owning lane.
 */
export function registerAssetsBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null registry has no steps of its own.
}

/**
 * Harness reset chain. Baked assets are immutable and must NOT be rebuilt here —
 * a rebake inside a capture blows the 300 s budget. Only per-capture scratch
 * (staging buffers, the GPU device's ping-pong targets) is dropped.
 */
export function resetAssets(_seed: number): void {
  // The null registry holds no per-capture scratch.
}
