/**
 * VegetationService.
 *
 * OWNER: VEG. Day-0 stub: the null vegetation service, whose `windAt` is a real
 * coherent gust field so flora, cloth, particles and audio already agree on
 * phase — that shared field is the whole reason the service exists this early.
 *
 * VEG: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * Two warnings you inherit. First, anything you animate in a vertex shader MUST
 * go through `MaterialFactory.registerDeform()` and MUST expose
 * `IRON_PREV_POSITION`, or wind-blown fronds ghost and it gets blamed on TAA.
 * Second, half-res GTAO and SSR handle palm fronds worse than almost anything
 * else in the scene; budget real time for the bilateral upsample weights.
 */
import type {
  AssetRegistry,
  BootContext,
  QualitySettings,
  VegetationService,
} from '@/engine/types';
import { createNullVegetation, trackNull } from '@/bootstrap/nulls';

export function createVegetationService(_ctx: BootContext): VegetationService {
  return trackNull(createNullVegetation());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * Palm, shrub, succulent and grass meshes plus the octahedral impostor
 * atlases. Step 8 of the bake table; both devices, 180 units at `full`.
 */
export function registerVegetationBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Wind-field phase is the one thing here that MUST reset: it is latched once
 * per frame and feeds the vegetation velocity path, so a stale phase both
 * ghosts the fronds and desynchronises flora from cloth, particles and audio.
 */
export function resetVegetation(_seed: number): void {
  // The null service holds no transient state.
}
