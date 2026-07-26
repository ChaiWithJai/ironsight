/**
 * GAME — the world probe: the one place locomotion asks "what is in front of me
 * and where is the floor".
 *
 * OWNER: GAME.
 *
 * WHY THIS FILE EXISTS. Vault and mantle detection is a chain of four ray
 * queries per candidate ledge, and the answer has to be identical whether the
 * query lands in rapier or, before PHYS ships, in the analytic fallback. Putting
 * that degradation in one class means the vault STATE MACHINE never branches on
 * whether physics is real — it asks for a ledge and gets one or does not.
 *
 * THE FALLBACK IS NOT A STUB. `PhysicsService.ready` is false until PHYS lands
 * its rapier world, and the null character controller floors the capsule at
 * y = 0 with no knowledge of the map. So when physics is not ready we resolve
 * ground against `MACRO_TERRAIN` — the frozen analytic silhouette every lane
 * already agrees on, and exactly what the null `PlayerService` did — and resolve
 * obstacles against the box set the demo scenarios register. The moment
 * `physics.ready` flips, every query routes to rapier and nothing above this
 * file changes.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  LAYER_SOLID,
  HitZone,
  SurfaceId,
  type BodyHandle,
  type EntityId,
  type QueryFilter,
  type RayHit,
  type Services,
  type Vec3,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';

/** An axis-aligned analytic obstacle. Demo scenarios register these. */
export interface ProbeBox {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly surface: SurfaceId;
}

function freshHit(): RayHit {
  return {
    hit: false,
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surface: SurfaceId.Sand,
    body: 0 as BodyHandle,
    entity: 0 as EntityId,
    zone: HitZone.None,
    backface: false,
  };
}

const SOLID_FILTER: QueryFilter = { groups: LAYER_SOLID, solid: true };

export class WorldProbe {
  /** Analytic obstacles, used only while `PhysicsService.ready` is false. */
  private readonly boxes: ProbeBox[] = [];
  private readonly hitScratch = freshHit();
  private readonly tmpA = new THREE.Vector3();

  constructor(private readonly services: Services) {}

  get physicsReady(): boolean {
    return this.services.physics.ready;
  }

  addBox(box: ProbeBox): void {
    this.boxes.push(box);
  }

  clearBoxes(): void {
    this.boxes.length = 0;
  }

  get analyticBoxes(): readonly ProbeBox[] {
    return this.boxes;
  }

  /**
   * Ground height under a world point, ignoring the character's own capsule.
   *
   * TERRAIN's heightfield when it exists, the frozen macro silhouette when it
   * does not — the two agree to a couple of metres by contract, so a demo posed
   * against one is still framed correctly against the other.
   */
  groundHeightAt(x: number, z: number): number {
    const terrain = this.services.terrain;
    let h = terrain.ready ? terrain.heightAt(x, z) : MACRO_TERRAIN.height(x, z);
    // A box the player is standing on IS the ground for locomotion purposes.
    for (const box of this.boxes) {
      if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
      if (box.max.y > h) h = box.max.y;
    }
    return h;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    const terrain = this.services.terrain;
    return terrain.ready ? terrain.surfaceAt(x, z) : SurfaceId.Sand;
  }

  /**
   * One solid ray. Returns the hit in `out` (always written, `hit` false on a
   * miss) so the caller can pool a single `RayHit` for a whole vault probe.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, out: RayHit, exclude?: EntityId): boolean {
    if (this.services.physics.ready) {
      const filter: QueryFilter = exclude === undefined
        ? SOLID_FILTER
        : { groups: LAYER_SOLID, solid: true, excludeEntity: exclude };
      return this.services.physics.raycast(origin, direction, maxDistance, filter, out);
    }
    return this.analyticRaycast(origin, direction, maxDistance, out);
  }

  /**
   * Slab test against every analytic box plus the macro ground plane. Small N by
   * construction — the demo scenarios register a handful of crates and a wall —
   * so a linear sweep is both fastest and deterministic, which a spatial hash
   * keyed by object identity would not be.
   */
  private analyticRaycast(origin: Vec3, direction: Vec3, maxDistance: number, out: RayHit): boolean {
    out.hit = false;
    out.distance = maxDistance;
    out.backface = false;
    out.zone = HitZone.None;
    let best = maxDistance;

    for (const box of this.boxes) {
      let tMin = 0;
      let tMax = maxDistance;
      let axis = -1;
      let sign = 1;
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
        const d = a === 0 ? direction.x : a === 1 ? direction.y : direction.z;
        const lo = a === 0 ? box.min.x : a === 1 ? box.min.y : box.min.z;
        const hi = a === 0 ? box.max.x : a === 1 ? box.max.y : box.max.z;
        if (Math.abs(d) < 1e-8) {
          if (o < lo || o > hi) {
            tMin = Number.POSITIVE_INFINITY;
            break;
          }
          continue;
        }
        const inv = 1 / d;
        let t0 = (lo - o) * inv;
        let t1 = (hi - o) * inv;
        let s = -1;
        if (t0 > t1) {
          const t = t0;
          t0 = t1;
          t1 = t;
          s = 1;
        }
        if (t0 > tMin) {
          tMin = t0;
          axis = a;
          sign = s;
        }
        if (t1 < tMax) tMax = t1;
        if (tMin > tMax) {
          tMin = Number.POSITIVE_INFINITY;
          break;
        }
      }
      if (!Number.isFinite(tMin) || tMin < 0 || tMin >= best) continue;
      best = tMin;
      out.hit = true;
      out.distance = tMin;
      out.point.copy(direction).multiplyScalar(tMin).add(origin);
      out.normal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      out.surface = box.surface;
      out.entity = 0 as EntityId;
    }

    // The ground, as a plane at the macro height under the ray's end point. Only
    // downward rays can hit it, which is all locomotion ever asks it for.
    if (direction.y < -1e-4) {
      const groundY = this.groundHeightAt(
        origin.x + direction.x * best * 0.5,
        origin.z + direction.z * best * 0.5,
      );
      const t = (groundY - origin.y) / direction.y;
      if (t >= 0 && t < best) {
        out.hit = true;
        out.distance = t;
        out.point.copy(direction).multiplyScalar(t).add(origin);
        out.normal.set(0, 1, 0);
        out.surface = this.surfaceAt(out.point.x, out.point.z);
        out.entity = 0 as EntityId;
      }
    }
    return out.hit;
  }

  /**
   * Is there room for a capsule of `radius`/`height` standing at `foot`?
   * Used for vault landing validation and for stand-up blocking.
   */
  capsuleFits(foot: Vec3, radius: number, height: number, exclude?: EntityId): boolean {
    if (this.services.physics.ready) {
      const hits = this.services.physics.overlapSphere(
        this.tmpA.set(foot.x, foot.y + height * 0.5, foot.z),
        Math.max(radius, height * 0.5),
        exclude === undefined
          ? { groups: LAYER_SOLID }
          : { groups: LAYER_SOLID, excludeEntity: exclude },
        OVERLAP_SCRATCH,
      );
      return hits === 0;
    }
    const top = foot.y + height;
    for (const box of this.boxes) {
      if (foot.x + radius < box.min.x || foot.x - radius > box.max.x) continue;
      if (foot.z + radius < box.min.z || foot.z - radius > box.max.z) continue;
      if (top <= box.min.y || foot.y >= box.max.y) continue;
      return false;
    }
    return true;
  }

  /** Fraction of the line from `a` to `b` that is unobstructed. 1 = clear. */
  visibility(a: Vec3, b: Vec3): number {
    if (this.services.physics.ready) {
      return this.services.physics.visibility(a, b, LAYER_SOLID | CollisionGroup.Foliage);
    }
    const dir = this.tmpA.copy(b).sub(a);
    const distance = dir.length();
    if (distance < 1e-4) return 1;
    dir.multiplyScalar(1 / distance);
    return this.analyticRaycast(a, dir, distance, this.hitScratch) ? 0 : 1;
  }
}

/** Shared scratch for `overlapSphere`, which writes into a caller-owned array. */
const OVERLAP_SCRATCH: EntityId[] = [];
