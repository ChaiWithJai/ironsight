/**
 * DestructionService.
 *
 * OWNER: PHYS. Day-0 stub: the null destruction service — nothing breaks,
 * everything reports intact.
 *
 * PHYS: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * Destruction is the most cross-cutting feature in the project. A destroyed wall
 * must leave its BatchedMesh WITHOUT a rebuild (`SceneGraph.hideBatchInstance`),
 * drop its collider, spawn chunks inside the tier's debris budget, invalidate
 * the `CoverSlot`s that referenced it, and re-open the navmesh via
 * `NavService.invalidate`. Scope it to pre-authored, PRE-FRACTURED cover pieces
 * baked at load time — runtime Voronoi fracture is a frame-hitch generator and
 * is banned.
 *
 * `reset()` is called by the harness driver between every capture. If damage
 * leaks across shots, screenshots start depending on capture ORDER.
 */
import type {
  AssetRegistry,
  BootContext,
  DestructionService,
  QualitySettings,
} from '@/engine/types';
import { createNullDestruction, trackNull } from '@/bootstrap/nulls';

export function createDestructionService(_ctx: BootContext): DestructionService {
  return trackNull(createNullDestruction());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * Voronoi pre-fracture: every `DestructibleDef.chunks` mesh set, baked at load
 * time. Runtime fracture is a frame-hitch generator and is banned.
 */
export function registerDestructionBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Damage state, live chunks, settled instanced batches and the debris budget.
 * `DestructionService.reset()` is ALSO called explicitly earlier in the chain;
 * this hook is for anything the interface method does not cover.
 */
export function resetDestruction(_seed: number): void {
  // The null service holds no transient state.
}
