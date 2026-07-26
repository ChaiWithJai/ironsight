/**
 * VfxService.
 *
 * OWNER: VFX. Day-0 stub: the null VFX service — handles are issued, nothing is
 * drawn.
 *
 * VFX: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * Subscribe to `FxEventMap` in your constructor and nowhere else; gameplay never
 * calls you directly. One bullet impact produces a decal, a particle burst, a
 * sound and a hitmarker from four modules that have never heard of each other,
 * and that only works if you are event-driven.
 *
 * Over-budget requests are DROPPED BY PRIORITY — never throw, never stall.
 * `clearTransient()` is called by the harness driver between every capture.
 */
import type {
  AssetRegistry,
  BootContext,
  QualitySettings,
  VfxService,
} from '@/engine/types';
import { createNullVfx, trackNull } from '@/bootstrap/nulls';

export function createVfxService(_ctx: BootContext): VfxService {
  return trackNull(createNullVfx());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * Decal and particle atlases — step 11, 50 units on the GPU device.
 */
export function registerVfxBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Decal pools, particle state textures, tracer ribbons, live emitters.
 * `clearTransient()` is also called explicitly earlier in the chain; this hook
 * covers anything that is not "transient" by your own definition, because the
 * acceptance test is byte-identical PNGs, not a judgement call.
 */
export function resetVfx(_seed: number): void {
  // The null service holds no transient state.
}
