/**
 * ViewmodelRig — THE one place sway, bob, ADS and kick are composed.
 *
 * OWNER: WEAPONS. Day-0 stub: the null rig, an empty group registered on the
 * viewmodel render layer so the overlay toggle and the separate near camera are
 * already wired and testable.
 *
 * WEAPONS: replace the BODY of this file, keep this signature and this path.
 *
 * The viewmodel gets its OWN camera (near 0.01 / far 6) with the depth range
 * remapped, so the weapon can never clip a wall and never eats world depth
 * precision. Its velocity comes from the VIEWMODEL RIG'S own previous
 * transform, not the camera's — use the camera's and TAA smears the gun every
 * time the player turns.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type AssetRegistry,
  type BootContext,
  type QualitySettings,
  type ViewmodelRig,
} from '@/engine/types';
import { createNullViewmodel, trackNull } from '@/bootstrap/nulls';

export function createViewmodelRig(ctx: BootContext): ViewmodelRig {
  const rig = trackNull(createNullViewmodel());
  const root = rig.root as THREE.Object3D;
  root.layers.set(RenderLayer.Viewmodel as number);
  root.traverse((o) => o.layers.set(RenderLayer.Viewmodel as number));
  ctx.services.scene.group(SceneGroup.Viewmodel).add(root);
  return rig;
}

/** Arms, gloves and the procedural reload/bolt/inspect clips. */
export function registerViewmodelBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null rig has no geometry.
}

/**
 * Harness reset chain. Sway, bob phase, kick springs and the ADS blend are all
 * transient, and the viewmodel's PREVIOUS transform feeds the velocity buffer —
 * carrying it across a capture boundary ghosts the gun on frame one.
 */
export function resetViewmodel(_seed: number): void {
  // The null rig holds no springs.
}
