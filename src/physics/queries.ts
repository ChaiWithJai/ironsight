/**
 * Raycasts, shape casts, overlaps and line-of-sight. OWNER: PHYS.
 *
 * THE THREE THINGS THAT MAKE A QUERY LAYER USEFUL RATHER THAN MERELY PRESENT
 * --------------------------------------------------------------------------
 * 1. THE SURFACE COMES BACK. A `RayHit` with a `SurfaceId` is what lets one
 *    bullet impact produce a stone chip decal, a stone impact cue, a stone
 *    debris burst and a stone penetration cost from four modules that have never
 *    heard of each other. A hit that reported only a position would push that
 *    decision back onto every caller. For the terrain body the surface is not a
 *    constant — it is resolved per hit point through the injected resolver, so a
 *    bullet into wet sand at the waterline and one into the town terrace do not
 *    report the same material.
 * 2. NOTHING ALLOCATES. Every entry point writes into a caller-owned `RayHit`,
 *    the rapier `Ray` is reused, and the filter predicate is a bound method that
 *    reads a field rather than a closure built per call. Ballistics fires
 *    several of these per projectile per tick.
 * 3. THE FILTER IS SYMMETRIC. rapier tests interaction groups BOTH ways, so a
 *    query that "belongs to" nothing can never hit anything. Every query below
 *    declares full membership and narrows only its filter half — see the header
 *    of `layers.ts`.
 *
 * `raycastAll` and `visibility` sort their hits by distance before returning:
 * rapier reports multi-hit callbacks in broad-phase order, which is stable for a
 * given build but is not near→far, and the penetration chain in WEAPONS is only
 * correct near→far.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  HitZone,
  NULL_ENTITY,
  SurfaceId,
  type BodyHandle,
  type EntityId,
  type QueryFilter,
  type RayHit,
  type Vec3,
} from '@/engine/types';
import { ALL_GROUPS, interactionGroups, isAttenuatingSurface } from '@/physics/layers';
import type { BodyRecord, BodyTable } from '@/physics/bodies';

/**
 * Resolves the material at a hit. The body's own `surface` for everything with a
 * single material; a position lookup for the terrain, whose material changes
 * from wet sand to dirt to rubble across the map.
 */
export type SurfaceResolver = (record: BodyRecord | undefined, x: number, y: number, z: number) => SurfaceId;

/** Fraction of line-of-sight surviving one layer of foliage/cloth. */
const ATTENUATION_PER_LAYER = 0.55;

/** Hard cap on hits walked by `raycastAll` / `visibility`. */
const MAX_CHAIN = 12;

interface ScratchHit {
  toi: number;
  nx: number;
  ny: number;
  nz: number;
  collider: number;
}

export function clearHit(out: RayHit): boolean {
  out.hit = false;
  out.distance = 0;
  out.surface = SurfaceId.Sand;
  out.body = 0 as BodyHandle;
  out.entity = NULL_ENTITY;
  out.zone = HitZone.None;
  out.backface = false;
  return false;
}

export class QueryService {
  private readonly ray = new RAPIER.Ray(new RAPIER.Vector3(0, 0, 0), new RAPIER.Vector3(0, -1, 0));
  private readonly shapePos = new RAPIER.Vector3(0, 0, 0);
  private readonly shapeVel = new RAPIER.Vector3(0, 0, 0);
  private readonly shapeRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly ball = new RAPIER.Ball(0.5);
  private readonly chain: ScratchHit[] = [];
  private readonly overlapKeys: number[] = [];
  private readonly overlapFound: BodyRecord[] = [];
  private readonly tmp = new THREE.Vector3();

  /** Live filter for `predicate`, so no closure is allocated per query. */
  private excludeEntity: EntityId = NULL_ENTITY;
  private excludeBody = -1;

  private readonly predicate = (collider: RAPIER.Collider): boolean => {
    if (this.excludeEntity === NULL_ENTITY && this.excludeBody < 0) return true;
    const record = this.table.recordOfCollider(collider.handle);
    if (!record) return true;
    if (this.excludeBody >= 0 && (record.handle as number) === this.excludeBody) return false;
    if (this.excludeEntity !== NULL_ENTITY && record.entity === this.excludeEntity) return false;
    return true;
  };

  constructor(
    private readonly world: RAPIER.World,
    private readonly table: BodyTable,
    private readonly surfaceOf: SurfaceResolver,
  ) {
    for (let i = 0; i < MAX_CHAIN; i++) this.chain.push({ toi: 0, nx: 0, ny: 1, nz: 0, collider: -1 });
  }

  private arm(filter: QueryFilter): number {
    this.excludeEntity = filter.excludeEntity ?? NULL_ENTITY;
    this.excludeBody = filter.excludeBody !== undefined ? (filter.excludeBody as number) : -1;
    // Full membership, narrowed filter: see the layers.ts header for why the
    // membership half must be 0xffff on a query.
    return interactionGroups(ALL_GROUPS, filter.groups);
  }

  /** Fill `out` from a hit expressed as origin + dir * toi with world normal n. */
  private fill(
    out: RayHit,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    toi: number,
    nx: number,
    ny: number,
    nz: number,
    colliderHandle: number,
  ): void {
    const px = ox + dx * toi;
    const py = oy + dy * toi;
    const pz = oz + dz * toi;
    const record = this.table.recordOfCollider(colliderHandle);
    out.hit = true;
    out.distance = toi;
    out.point.set(px, py, pz);
    out.normal.set(nx, ny, nz);
    out.surface = this.surfaceOf(record, px, py, pz);
    out.body = record ? record.handle : (0 as BodyHandle);
    out.entity = record ? record.entity : NULL_ENTITY;
    out.zone = record ? record.zone : HitZone.None;
    // A normal pointing the same way we are travelling means we left the solid
    // rather than entered it — how penetration measures wall thickness.
    out.backface = nx * dx + ny * dy + nz * dz > 0;
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter, out: RayHit): boolean {
    const groups = this.arm(filter);
    const d = this.tmp.copy(direction);
    const len = d.length();
    if (len < 1e-6 || maxDistance <= 0) return clearHit(out);
    d.multiplyScalar(1 / len);
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = d.x;
    this.ray.dir.y = d.y;
    this.ray.dir.z = d.z;
    const hit = this.world.castRayAndGetNormal(
      this.ray,
      maxDistance,
      filter.solid ?? true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      undefined,
      undefined,
      this.predicate,
    );
    if (!hit) return clearHit(out);
    this.fill(
      out,
      origin.x,
      origin.y,
      origin.z,
      d.x,
      d.y,
      d.z,
      hit.timeOfImpact,
      hit.normal.x,
      hit.normal.y,
      hit.normal.z,
      hit.collider.handle,
    );
    return true;
  }

  /**
   * Every hit along the ray, near→far. Returns how many entries of `out` were
   * written, never more than `out.length` and never more than MAX_CHAIN.
   */
  raycastAll(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter, out: RayHit[]): number {
    const count = this.gather(origin, direction, maxDistance, filter);
    if (count === 0) return 0;
    const d = this.tmp;
    const limit = Math.min(count, out.length);
    for (let i = 0; i < limit; i++) {
      const h = this.chain[i];
      this.fill(out[i], origin.x, origin.y, origin.z, d.x, d.y, d.z, h.toi, h.nx, h.ny, h.nz, h.collider);
    }
    return limit;
  }

  /**
   * Collect up to MAX_CHAIN hits into `this.chain`, sorted near→far. Leaves the
   * normalised direction in `this.tmp` for the caller to reuse.
   */
  private gather(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter): number {
    const groups = this.arm(filter);
    const d = this.tmp.copy(direction);
    const len = d.length();
    if (len < 1e-6 || maxDistance <= 0) return 0;
    d.multiplyScalar(1 / len);
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = d.x;
    this.ray.dir.y = d.y;
    this.ray.dir.z = d.z;

    let n = 0;
    this.world.intersectionsWithRay(
      this.ray,
      maxDistance,
      filter.solid ?? true,
      (intersection) => {
        if (n < MAX_CHAIN) {
          const slot = this.chain[n++];
          slot.toi = intersection.timeOfImpact;
          slot.nx = intersection.normal.x;
          slot.ny = intersection.normal.y;
          slot.nz = intersection.normal.z;
          slot.collider = intersection.collider.handle;
        }
        return n < MAX_CHAIN;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      undefined,
      undefined,
      this.predicate,
    );
    // Insertion sort: n is at most 12 and the array is nearly sorted already,
    // so this beats Array.prototype.sort and allocates nothing.
    for (let i = 1; i < n; i++) {
      const item = this.chain[i];
      let j = i - 1;
      while (j >= 0 && this.chain[j].toi > item.toi) {
        this.chain[j + 1] = this.chain[j];
        j--;
      }
      this.chain[j + 1] = item;
    }
    return n;
  }

  /**
   * Swept sphere. The correct primitive for projectile CCD and grenade travel:
   * a ray tunnels through a 4 cm railing at 900 m/s, a swept sphere does not.
   */
  sphereCast(
    origin: Vec3,
    direction: Vec3,
    radius: number,
    maxDistance: number,
    filter: QueryFilter,
    out: RayHit,
  ): boolean {
    const groups = this.arm(filter);
    const d = this.tmp.copy(direction);
    const len = d.length();
    if (len < 1e-6 || maxDistance <= 0) return clearHit(out);
    d.multiplyScalar(1 / len);
    this.shapePos.x = origin.x;
    this.shapePos.y = origin.y;
    this.shapePos.z = origin.z;
    this.shapeVel.x = d.x;
    this.shapeVel.y = d.y;
    this.shapeVel.z = d.z;
    this.ball.radius = radius;
    const hit = this.world.castShape(
      this.shapePos,
      this.shapeRot,
      this.shapeVel,
      this.ball,
      0,
      maxDistance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      undefined,
      undefined,
      this.predicate,
    );
    if (!hit) return clearHit(out);
    // `normal1` is the outward normal ON THE CAST SPHERE at the contact, in the
    // sphere's local frame — and we cast with an identity rotation, so local is
    // world. The surface normal is its negation: the sphere's outward normal
    // points INTO the wall it just touched.
    const inv = -1;
    this.fill(
      out,
      origin.x,
      origin.y,
      origin.z,
      d.x,
      d.y,
      d.z,
      hit.time_of_impact,
      hit.normal1.x * inv,
      hit.normal1.y * inv,
      hit.normal1.z * inv,
      hit.collider.handle,
    );
    return true;
  }

  /**
   * Entities whose colliders touch the sphere, deduplicated and returned in
   * SPAWN-KEY ORDER. The order matters: explosion damage is applied in the order
   * this returns, and rapier's broad-phase order is an implementation detail
   * that must never reach gameplay.
   */
  overlapSphere(centre: Vec3, radius: number, filter: QueryFilter, out: EntityId[]): number {
    const groups = this.arm(filter);
    this.shapePos.x = centre.x;
    this.shapePos.y = centre.y;
    this.shapePos.z = centre.z;
    this.ball.radius = radius;
    const keys = this.overlapKeys;
    keys.length = 0;
    const found = this.overlapFound;
    found.length = 0;
    this.world.intersectionsWithShape(
      this.shapePos,
      this.shapeRot,
      this.ball,
      (collider) => {
        const record = this.table.recordOfCollider(collider.handle);
        if (record && !keys.includes(record.key)) {
          keys.push(record.key);
          found.push(record);
        }
        return found.length < out.length + 8;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      undefined,
      undefined,
      this.predicate,
    );
    found.sort((a, b) => a.key - b.key);
    const limit = Math.min(found.length, out.length);
    for (let i = 0; i < limit; i++) out[i] = found[i].entity;
    return limit;
  }

  /**
   * 0..1 line of sight. Solid geometry blocks outright; foliage, tarps and cloth
   * attenuate, which is what makes a bot behind a palm harder to see rather than
   * invisible, and what gives audio occlusion something between "clear" and
   * "muffled".
   */
  visibility(from: Vec3, to: Vec3, groups: number): number {
    const delta = this.tmp.copy(to).sub(from);
    const distance = delta.length();
    if (distance < 1e-4) return 1;
    const filter: QueryFilter = { groups, solid: true };
    // `gather` normalises into this.tmp, which is the same vector `delta` aliases.
    const count = this.gather(from, delta, distance, filter);
    let transmission = 1;
    for (let i = 0; i < count; i++) {
      const record = this.table.recordOfCollider(this.chain[i].collider);
      const surface = record ? record.surface : SurfaceId.Concrete;
      if (!isAttenuatingSurface(surface)) return 0;
      transmission *= ATTENUATION_PER_LAYER;
      if (transmission < 0.02) return 0;
    }
    return transmission;
  }
}
