/**
 * AiService.
 *
 * OWNER: AI. Day-0 stub: the null AI service — no bots, and an intent source
 * that emits a zeroed `PlayerIntent`.
 *
 * AI: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * Bots emit `PlayerIntent` — the SAME struct humans produce — so they drive the
 * identical movement and fire-control code path. A feel change lands for 24 bots
 * and the player simultaneously, and a movement bug cannot manifest differently
 * for AI.
 *
 * THE ONE LINE THAT MAKES THAT TRUE, AND THE ONE THAT IS EASY TO MISS. Inside
 * `spawnBot`, after you have the entity:
 *
 *     ctx.services.player.attachController(entity, team, this.intentSource);
 *
 * GAME's single `TickPhase.Intent` system then calls
 * `intentSource.sample(entity, ctx, out)` for that entity, every tick, forever.
 * YOU NEVER CALL `sample()` YOURSELF and you never register a system at
 * `TickPhase.Intent` or `TickPhase.Movement` — those two phases belong to GAME
 * exclusively (architecture §3.4). A bot that is not attached is never sampled
 * and never moves, and nothing throws to tell you so.
 *
 * Your own systems go at `TickPhase.Ai`, which runs after Intent and before
 * Movement: read last tick's world, write only into the intent you are handed
 * next tick. Per-entity locomotion state is `services.player.stateOf(entity)`.
 *
 * Perception is round-robin over a fixed per-tick budget so cost is flat and
 * evaluation order is deterministic. `despawnAll()` is called by the harness
 * driver between captures — bot positions leaking across shots is one of the
 * easiest ways to make screenshots order-dependent.
 *
 * Procedural humans are the highest-variance deliverable in the brief: bias hard
 * toward silhouette and gear (helmets, packs, gloves, webbing, scarves) so the
 * skin-and-face problem is minimised, and LOD aggressively so only 2–4 bots are
 * ever close enough to scrutinise.
 */
import type {
  AiService,
  AssetRegistry,
  BootContext,
  QualitySettings,
} from '@/engine/types';
import { createNullAi, trackNull } from '@/bootstrap/nulls';

export function createAiService(_ctx: BootContext): AiService {
  return trackNull(createNullAi());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * Soldier mesh, rig and animation clips — step 10, 130 units in the worker
 * pool. LOD aggressively: only 2-4 bots are ever close enough to scrutinise.
 */
export function registerAiBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Bot positions, threat memory, squad orders and think-rate phase.
 * `despawnAll()` is also called explicitly earlier in the chain.
 */
export function resetAi(_seed: number): void {
  // The null service holds no transient state.
}
