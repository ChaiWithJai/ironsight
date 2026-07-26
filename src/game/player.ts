/**
 * PlayerService — locomotion for EVERY intent-driven entity, and the dispatch
 * that makes bots and the human share one code path.
 *
 * OWNER: GAME. Day-0 stub: the null controller registry, with the local player
 * standing on the quay near BRAVO looking down the breakwater. That viewpoint is
 * deliberate — a lane whose shot forgets to pose the camera still gets a legible
 * frame instead of the inside of the ground.
 *
 * GAME: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * THIS LANE OWNS PER-ENTITY INTENT DISPATCH. Nobody else may register a system
 * at `TickPhase.Intent` or `TickPhase.Movement`. The two systems below are the
 * whole of it:
 *
 *   Intent    for each entity in `PlayerService.controlled`, in attach order,
 *             call `source.sample(entity, ctx, that entity's intent)`. The
 *             human's source is `InputService.source`; a bot's is
 *             `AiService.intentSource`, handed over by AI when it calls
 *             `attachController` inside `spawnBot`.
 *   Movement  intent → acceleration / friction / air control →
 *             `CharacterController.move()`, applying the translation rapier
 *             RETURNS, never the delta you asked for. No forces are ever applied
 *             to a character body.
 *
 * A bot is not a second kind of mover. It is an entity in the same table with a
 * different `IntentSource`, which is why a feel change lands for 24 bots and the
 * player at the same instant (architecture decision #6).
 */
import {
  TickPhase,
  type AssetRegistry,
  type BootContext,
  type PlayerService,
  type QualitySettings,
} from '@/engine/types';
import { createNullPlayer, trackNull, type NullPlayerService } from '@/bootstrap/nulls';
import { ActorTable } from '@/game/registry';

/**
 * Module-scoped so `resetPlayer` can reach the instance. `registerPlayerBakes`
 * runs before `createPlayerService`, and `reset` can fire before construction
 * too, so both hooks tolerate `null`. That is the shape of every lane entry file
 * in the repo — see `SubsystemDescriptor` in `src/engine/types.ts`.
 */
let instance: NullPlayerService | null = null;

/**
 * The lane-local actor table, for the two GAME files that need per-entity state
 * the `PlayerService` contract deliberately does not expose — `conquest.ts`
 * reads `assistCredit` off a victim at the moment of a kill, because the sim bus
 * is deferred and the damage ledger it came from is already cleared by the time
 * the event is delivered.
 *
 * Module-scoped rather than a contract method on purpose: no OTHER lane may
 * reach a `GameActor`. Anything cross-lane goes through `PlayerService`.
 *
 * Returns null until the service is constructed, which is a real state — `reset`
 * and `registerBakes` both run before `create`.
 */
export function laneActors(): ActorTable | null {
  return actorTable;
}

let actorTable: ActorTable | null = null;

export function createPlayerService(ctx: BootContext): PlayerService {
  const player = trackNull(createNullPlayer(ctx.services.input.source));
  instance = player;
  actorTable = new ActorTable();

  ctx.addTick({
    name: 'game.intent',
    phase: TickPhase.Intent,
    order: 0,
    tick: (tick) => player.sampleIntents(tick),
  });
  ctx.addTick({
    name: 'game.movement',
    phase: TickPhase.Movement,
    order: 0,
    tick: (tick) => player.stepLocomotion(tick),
  });

  return player;
}

/**
 * Soldier meshes, footstep surface tables and movement curve LUTs get declared
 * here. Runs after `assets` and before every other subsystem is constructed, so
 * there is no service to read — only the registry.
 */
export function registerPlayerBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null player bakes nothing.
}

/**
 * Harness reset chain. Everything transient about locomotion: position,
 * velocity, stance, stamina, suppression — and every controller AI attached
 * during the previous capture, or bots leak across shots as invisible movers.
 */
export function resetPlayer(_seed: number): void {
  actorTable?.clear?.();
  instance?.resetTransient();
}
