/**
 * AUDIO — occlusion probing.
 *
 * OWNER: AUDIO. `PhysicsService.visibility(from, to, groups)` returns 0..1 line
 * of sight INCLUDING foliage attenuation, and is documented as the call AI and
 * audio share. Occlusion is `1 - visibility`, probed on a ROUND ROBIN rather
 * than per voice per frame: a raycast per voice at 96 voices and 60 fps is 5760
 * casts a second for information that changes on a walking-pace timescale.
 *
 * The probe is also SMOOTHED. Stepping from clear to fully occluded in one frame
 * as a bot crosses a doorway produces an audible zipper; a 180 ms time constant
 * tracks a sprint without any of that.
 *
 * DEBUG FALLBACK: `src/shots/audio.ts` has to prove the occlusion path visually,
 * and until PHYS lands `visibility()` always returns 1. When `physics.ready` is
 * false AND the audio debug scene has registered analytic blockers, the probe
 * falls through to those instead — and the overlay labels which source it used,
 * because a debug view that quietly lies about where its numbers came from is
 * worse than no debug view.
 */
import * as THREE from 'three';
import { LAYER_SOLID, type PhysicsService, type Vec3 } from '@/engine/types';

/** An axis-aligned acoustic blocker used only by the debug scene. */
export interface DebugBlocker {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  /** 0..1 how completely this blocker occludes. Sandbags leak; stone does not. */
  readonly opacity: number;
  readonly label: string;
}

const dir = new THREE.Vector3();
const inv = new THREE.Vector3();

/** Slab test. Returns true if the segment from → to intersects the box. */
export function segmentHitsBox(from: Vec3, to: Vec3, min: THREE.Vector3, max: THREE.Vector3): boolean {
  dir.subVectors(to, from);
  const len = dir.length();
  if (len < 1e-6) return false;
  dir.divideScalar(len);
  inv.set(
    dir.x !== 0 ? 1 / dir.x : Infinity,
    dir.y !== 0 ? 1 / dir.y : Infinity,
    dir.z !== 0 ? 1 / dir.z : Infinity,
  );
  let t0 = 0;
  let t1 = len;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? from.x : axis === 1 ? from.y : from.z;
    const i = axis === 0 ? inv.x : axis === 1 ? inv.y : inv.z;
    const lo = axis === 0 ? min.x : axis === 1 ? min.y : min.z;
    const hi = axis === 0 ? max.x : axis === 1 ? max.y : max.z;
    let near = (lo - o) * i;
    let far = (hi - o) * i;
    if (near > far) {
      const tmp = near;
      near = far;
      far = tmp;
    }
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}

export class OcclusionProbe {
  /** Populated only by the audio debug scene; empty in a real session. */
  readonly blockers: DebugBlocker[] = [];
  /** True when the last probe came from rapier rather than the debug boxes. */
  usedPhysics = false;

  constructor(private readonly physics: () => PhysicsService) {}

  clearBlockers(): void {
    this.blockers.length = 0;
  }

  /** Raw occlusion in 0..1 for one source. */
  probe(from: Vec3, to: Vec3): number {
    const phys = this.physics();
    if (phys.ready) {
      this.usedPhysics = true;
      return 1 - Math.min(1, Math.max(0, phys.visibility(from, to, LAYER_SOLID)));
    }
    this.usedPhysics = false;
    if (this.blockers.length === 0) return 0;
    // Blockers do not simply add: two walls behind each other are not twice
    // occluded. Multiply the transmissions, which is what actually happens.
    let transmission = 1;
    for (const b of this.blockers) {
      if (segmentHitsBox(from, to, b.min, b.max)) transmission *= 1 - b.opacity;
    }
    return 1 - transmission;
  }

  /**
   * Exponential smoothing toward the raw probe. `tau` is the 63% time; 0.18 s
   * tracks a sprint through a doorway with no zipper.
   */
  static smooth(current: number, target: number, dt: number, tau = 0.18): number {
    const k = 1 - Math.exp(-dt / tau);
    return current + (target - current) * k;
  }
}
