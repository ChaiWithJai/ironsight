/**
 * HudService.
 *
 * OWNER: HUD. Day-0 stub: the null HUD service.
 *
 * HUD: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * The HUD is rendered INTO THE WEBGL CANVAS as an orthographic pass AFTER
 * tonemapping, at NATIVE canvas resolution (never `renderScale`). There is no
 * DOM UI anywhere in this project: `tools/capture.mjs` screenshots the canvas
 * only, so a DOM HUD is invisible in every single shot. Drawing UI BEFORE
 * tonemap is the most common single giveaway that a frame came out of a hobby
 * post stack.
 *
 * You can build against `GameMode` today — the null returns a live-looking
 * match: ALPHA captured, BRAVO contested, CHARLIE hostile, tickets bleeding.
 */
import type {
  AssetRegistry,
  BootContext,
  HudService,
  QualitySettings,
} from '@/engine/types';
import { createNullHud, trackNull } from '@/bootstrap/nulls';

export function createHudService(_ctx: BootContext): HudService {
  return trackNull(createNullHud());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * The SDF font atlas, baked from code-defined glyph outlines — step 14. Reach
 * it later through `ctx.assets`; this is where the `AssetKey<BakedFont>` is
 * claimed, and `hud` declares `dependsOn: ['assets']` for exactly that reason.
 */
export function registerHudBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Kill feed entries, hit markers, damage indicators and any tweened widget.
 * A killfeed left over from the previous shot is the single most obvious
 * order-dependence in a review sheet.
 */
export function resetHud(_seed: number): void {
  // The null service holds no transient state.
}
