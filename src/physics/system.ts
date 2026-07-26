/**
 * PhysicsService over rapier3d-compat.
 *
 * OWNER: PHYS. Day-0 stub: the null physics service — rays always miss, bodies
 * are handles that do nothing, and the character controller moves freely above a
 * hard floor at y = 0. `world` and `rapier` THROW on access, deliberately:
 * nothing outside this lane has any business touching the raw solver, and
 * handing back a fabricated object would hide that as a silent no-op.
 *
 * PHYS: replace the BODY of this file, keep these three exports, their
 * signatures and this path.
 *
 * DETERMINISM WARNING, non-negotiable: rapier's f32 solver is deterministic for
 * identical INPUT SEQUENCES but not across differing BODY-INSERTION ORDER — and
 * destruction makes insertion order dynamic. Every spawn and despawn must be
 * driven by a stable integer key and a deterministic sort, or two runs of the
 * same shot produce different debris piles and every destruction screenshot
 * becomes unreviewable.
 *
 * Also: heightfield for terrain, boxes and convex hulls for ~90% of built
 * geometry, trimesh ONLY for the freighter hull, the cranes and the fort
 * ramparts. Colliders are a deliberate second representation, never
 * `mesh.geometry`.
 */
import type {
  AssetRegistry,
  BootContext,
  PhysicsService,
  QualitySettings,
} from '@/engine/types';
import { createNullPhysics, trackNull } from '@/bootstrap/nulls';

export function createPhysicsService(_ctx: BootContext): PhysicsService {
  return trackNull(createNullPhysics());
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * Declare with `assets.define(...)`; never bake inside this function.
 *
 * Rapier collider construction is step 16 and runs on the MAIN thread, so it
 * is declared here but must stay inside its 70-unit slice.
 */
export function registerPhysicsBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null service declares no bake steps.
}

/**
 * Harness reset chain, at the top of EVERY capture. Drop transient state or
 * shot results start depending on capture ORDER.
 *
 * Every dynamic body, every character controller position, every contact. And
 * remember the determinism warning: respawn in a STABLE INTEGER KEY order, or
 * two runs of the same shot produce different debris piles.
 */
export function resetPhysics(_seed: number): void {
  // The null service holds no transient state.
}
