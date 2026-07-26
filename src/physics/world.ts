/**
 * The rapier world: async init, fixed step, solver tuning, island management.
 * OWNER: PHYS.
 *
 * TWO THINGS IN HERE ARE LOAD-BEARING FOR THE WHOLE PROJECT.
 *
 * 1. `@dimforge/rapier3d-compat` needs an `await init()` before a single symbol
 *    of it is legal to touch — the wasm module is inlined as base64 and has to
 *    be instantiated. That await is declared as a BAKE STEP (see
 *    `registerPhysicsBakes`), not done lazily inside the factory, because bakes
 *    run to completion before any subsystem is constructed. Boot therefore waits
 *    for it in the one place that already knows how to wait for slow work and
 *    how to report progress, and `createPhysicsService` can be synchronous and
 *    total.
 *
 * 2. The world is stepped EXACTLY ONCE PER TICK at EXACTLY `Sim.TICK_DT`, from
 *    `TickPhase.Physics` and nowhere else. rapier's f32 solver is reproducible
 *    for identical input sequences; it is not reproducible across a varying dt,
 *    and a variable-dt physics step is the fastest way to make every destruction
 *    screenshot in the repo unreviewable.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { Sim, type QualitySettings, type Rng } from '@/engine/types';
import { createRng } from '@/engine/rng';

/**
 * A deterministic layout stream for anything PHYS builds, seeded from a FIXED
 * constant and never from the engine RNG. Pre-fracture patterns, proving-ground
 * geometry and debris impulses are lane DATA: they must not move because another
 * lane changed how many random numbers it draws — which is exactly what would
 * happen if they came off the shared stream. `createRng`'s label does not select
 * a sequence (only the seed does), so the label is folded into the seed here.
 */
export function physicsLayoutRng(label: string): Rng {
  let hash = 0x50485953;
  for (let i = 0; i < label.length; i++) {
    hash = Math.imul(hash ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return createRng(hash, `phys.${label}`);
}

let initPromise: Promise<void> | null = null;
let initialised = false;

/**
 * Idempotent rapier wasm init. Awaited from the `phys.rapier` bake step; safe
 * to await again from anywhere (the same promise is returned).
 */
export function initRapier(): Promise<void> {
  if (!initPromise) {
    initPromise = RAPIER.init().then(() => {
      initialised = true;
    });
  }
  return initPromise;
}

export function rapierReady(): boolean {
  return initialised;
}

/** The rapier namespace, for `PhysicsService.rapier`. */
export function rapierModule(): typeof RAPIER {
  return RAPIER;
}

/**
 * Solver configuration, chosen for a shooter rather than for a sandbox.
 *
 * `numSolverIterations` 4 is rapier's default and is enough for boxes and
 * chunks; the ragdolls carry their own extra iterations per body instead
 * (`setAdditionalSolverIterations`), so a pile of debris does not pay for the
 * one articulated body in the scene.
 *
 * `normalizedAllowedLinearError` is deliberately left at rapier's default: it is
 * the penetration slop the solver tolerates, and tightening it makes a settled
 * stack of masonry buzz instead of sleep.
 */
export function createRapierWorld(quality: Readonly<QualitySettings>): RAPIER.World {
  if (!initialised) {
    throw new Error(
      'PHYS: rapier wasm was not initialised. The `phys.rapier` bake step must run before ' +
        'createPhysicsService — check that registerPhysicsBakes ran.',
    );
  }
  const world = new RAPIER.World(new RAPIER.Vector3(0, -Sim.GRAVITY, 0));
  world.timestep = Sim.TICK_DT;
  world.integrationParameters.numSolverIterations = 4;
  world.integrationParameters.numInternalPgsIterations = Math.max(1, quality.physics.substeps);
  // Islands smaller than this are not split off. 128 keeps a collapsing wall in
  // ONE island: splitting it produces per-island solve order that depends on
  // body count, which is exactly the kind of thing that diverges between runs.
  world.integrationParameters.minIslandSize = 128;
  world.integrationParameters.maxCcdSubsteps = 2;
  return world;
}
