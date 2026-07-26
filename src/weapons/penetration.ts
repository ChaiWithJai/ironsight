/**
 * Penetration and ricochet. WEAPONS owns this file.
 *
 * A round that hits something asks two questions in order:
 *
 *  1. Is this a GLANCE? If the impact is shallower than the surface's
 *     `ricochetAngleDeg`, the round deflects along the surface, keeps
 *     `ricochetRestitution` of its energy and stays live. Steel plate at 12°
 *     is the case everyone recognises.
 *  2. Otherwise, how THICK is it? Measured for real, by casting BACK through
 *     the obstacle from beyond it — `RayHit.backface` exists for exactly this.
 *     The energy cost is `penetrationResistance` J per centimetre, so a 2 cm
 *     plank and a 40 cm sandstone wall are the same rule with different data.
 *
 * Nothing here is a special case for a named material. Every number comes from
 * `SurfaceProfile`, which RCORE owns, so adding a surface adds a penetration
 * behaviour for free and no two lanes can disagree about how hard concrete is.
 */
import * as THREE from 'three';
import {
  HitZone,
  LAYER_SOLID,
  SurfaceId,
  type BodyHandle,
  type EntityId,
  type MaterialFactory,
  type PhysicsService,
  type QueryFilter,
  type RayHit,
  type Vec3,
} from '@/engine/types';

/** The furthest we will look for a back face. Beyond this it is a wall, not cover. */
const MAX_PROBE_M = 0.9;

export interface PenetrationOutcome {
  /** 'stop' | 'through' | 'ricochet' */
  readonly kind: 'stop' | 'through' | 'ricochet';
  /** Where the round resumes (exit face, or the impact point for a ricochet). */
  readonly point: Vec3;
  /** Unit direction the round resumes along. */
  readonly direction: Vec3;
  /** Joules remaining. Zero for 'stop'. */
  readonly energyJ: number;
  /** Metres of material traversed. Zero for a ricochet. */
  readonly thicknessM: number;
}

const probeHit: RayHit = makeHit();
const outPoint = new THREE.Vector3();
const outDir = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpBack = new THREE.Vector3();
const tmpProbeOrigin = new THREE.Vector3();

/**
 * Resolve what happens to a round that just hit `hit` travelling along
 * `direction` with `energyJ` joules left.
 *
 * The returned object is REUSED between calls: copy anything you need to keep.
 * A per-bullet allocation at 650 rpm × 24 bots is 260 objects a second of pure
 * GC pressure in the middle of the frame budget.
 */
export function resolvePenetration(
  physics: PhysicsService,
  materials: MaterialFactory,
  hit: Readonly<RayHit>,
  direction: Vec3,
  energyJ: number,
  budgetJ: number,
  surface: SurfaceId,
): PenetrationOutcome {
  const profile = materials.profile(surface);
  tmpNormal.copy(hit.normal);
  // Always work with the face the round is arriving at.
  if (tmpNormal.dot(direction) > 0) tmpNormal.negate();

  /* ---- 1. glance ------------------------------------------------------- */
  // Angle measured FROM THE SURFACE PLANE, which is how `ricochetAngleDeg` is
  // specified: 0° is a perfect graze, 90° is dead-on.
  const cosIncidence = Math.min(1, Math.abs(direction.dot(tmpNormal)));
  const fromSurfaceDeg = 90 - Math.acos(cosIncidence) * (180 / Math.PI);
  if (fromSurfaceDeg < profile.ricochetAngleDeg && profile.ricochetRestitution > 0.05) {
    // Specular reflection, then pulled back toward the surface by the shallow
    // angle: a real ricochet leaves flatter than it arrived because the round
    // deforms and skips.
    outDir.copy(direction).addScaledVector(tmpNormal, -2 * direction.dot(tmpNormal)).normalize();
    outDir.addScaledVector(tmpNormal, -0.35 * (1 - fromSurfaceDeg / Math.max(1, profile.ricochetAngleDeg))).normalize();
    outPoint.copy(hit.point).addScaledVector(tmpNormal, 0.01);
    return {
      kind: 'ricochet',
      point: outPoint,
      direction: outDir,
      energyJ: energyJ * profile.ricochetRestitution,
      thicknessM: 0,
    };
  }

  /* ---- 2. thickness ---------------------------------------------------- */
  // Cast BACK through the obstacle from a point beyond it. The first thing we
  // hit coming the other way is the far face, and the arithmetic gives us the
  // true thickness along the bullet's actual line — not along the normal,
  // which is what makes a 20° shot through a wall cost more than a square one.
  const probe = MAX_PROBE_M;
  tmpProbeOrigin.copy(hit.point).addScaledVector(direction, probe);
  tmpBack.copy(direction).negate();
  const filter: QueryFilter = { groups: LAYER_SOLID, solid: false };
  const found = physics.raycast(tmpProbeOrigin, tmpBack, probe, filter, probeHit);
  const thickness = found ? Math.max(0.001, probe - probeHit.distance) : probe;

  // Energy cost. `penetrationResistance` is joules per CENTIMETRE.
  const costJ = profile.penetrationResistance * (thickness * 100);
  const remaining = Math.min(energyJ, budgetJ) - costJ;
  if (remaining <= 0 || !found) {
    outPoint.copy(hit.point);
    outDir.copy(direction);
    return { kind: 'stop', point: outPoint, direction: outDir, energyJ: 0, thicknessM: thickness };
  }

  // Exit a hair past the far face so the next sweep does not immediately
  // re-hit the surface we just came through.
  outPoint.copy(probeHit.point).addScaledVector(direction, 0.006);
  // Deflection through material, scaled by how much of the budget it ate: a
  // round that barely made it comes out tumbling, one that sailed through does
  // not. Deterministic in the impact geometry, so no RNG draw is needed.
  const spent = costJ / Math.max(1, budgetJ);
  const deflect = 0.04 * spent;
  outDir
    .copy(direction)
    .addScaledVector(tmpNormal, deflect * (0.5 - fromSurfaceDeg / 180))
    .normalize();

  return {
    kind: 'through',
    point: outPoint,
    direction: outDir,
    energyJ: Math.max(0, energyJ - costJ),
    thicknessM: thickness,
  };
}

/** A zeroed `RayHit` the physics service can fill in place. */
export function makeHit(): RayHit {
  return {
    hit: false,
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surface: SurfaceId.Sandstone,
    body: 0 as BodyHandle,
    entity: 0 as EntityId,
    zone: HitZone.None,
    backface: false,
  };
}
