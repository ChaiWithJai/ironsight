/**
 * CollisionGroup ↔ rapier InteractionGroups, and the physical constants that
 * come with a surface. OWNER: PHYS.
 *
 * rapier packs an interaction filter into one u32: the HIGH 16 bits are the
 * groups a collider BELONGS TO, the LOW 16 bits are the groups it INTERACTS
 * WITH. Two colliders interact only when the test passes BOTH ways:
 *
 *     (a.memberships & b.filter) != 0  &&  (b.memberships & a.filter) != 0
 *
 * That symmetry is the thing people get wrong. A bullet ray that "belongs to"
 * nothing can never hit anything, no matter what its filter says — so every
 * query in `queries.ts` declares full membership (`0xffff`) and narrows only its
 * filter, which is what makes `LAYER_SOLID` / `LAYER_SHOOTABLE` behave the way
 * the contract describes them.
 */
import { CollisionGroup, LAYER_SOLID, SurfaceId } from '@/engine/types';

/** Full membership. Queries belong to every group so only their filter matters. */
export const ALL_GROUPS = 0xffff;

/**
 * Pack membership + filter into rapier's u32. `>>> 0` because `0xffff << 16`
 * is a negative int32 in JS and wasm-bindgen wants an unsigned value.
 */
export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** The filter half of a body's groups, for the common cases. */
export function defaultCollidesWith(group: CollisionGroup): number {
  switch (group) {
    case CollisionGroup.Character:
      return LAYER_SOLID | CollisionGroup.Character;
    case CollisionGroup.Debris:
      // Debris ignores other debris on purpose. Chunk-on-chunk contact is where
      // a 256-piece collapse spends its entire solver budget, and the visual
      // difference at the moment of collapse is nil.
      return CollisionGroup.Terrain | CollisionGroup.StaticGeo | CollisionGroup.Prop | CollisionGroup.Vehicle;
    case CollisionGroup.Projectile:
      return LAYER_SOLID | CollisionGroup.Character | CollisionGroup.Hitbox;
    case CollisionGroup.Hitbox:
      return CollisionGroup.Projectile;
    case CollisionGroup.Foliage:
      return CollisionGroup.Projectile;
    case CollisionGroup.Trigger:
      return CollisionGroup.Character;
    default:
      return LAYER_SOLID | CollisionGroup.Character | CollisionGroup.Vehicle;
  }
}

/**
 * Per-surface contact constants. `MaterialFactory.profile()` is the canonical
 * table and PHYS reads it whenever the factory is live; this is the fallback for
 * the window before it is, and the place the two extra numbers rapier needs —
 * bulk density and a linear-damping hint — are kept.
 *
 * Densities are the real thing (kg/m³): concrete 2400, brick 1900, timber 650.
 * They are what makes a masonry chunk fall like masonry instead of like a prop
 * with a made-up mass.
 */
export interface SurfacePhysics {
  readonly friction: number;
  readonly restitution: number;
  readonly densityKgM3: number;
}

const DEFAULT_PHYSICS: SurfacePhysics = { friction: 0.82, restitution: 0.06, densityKgM3: 1800 };

const SURFACE_PHYSICS: Partial<Record<SurfaceId, SurfacePhysics>> = {
  [SurfaceId.Sandstone]: { friction: 0.88, restitution: 0.05, densityKgM3: 2200 },
  [SurfaceId.Stucco]: { friction: 0.9, restitution: 0.04, densityKgM3: 1600 },
  [SurfaceId.Concrete]: { friction: 0.86, restitution: 0.08, densityKgM3: 2400 },
  [SurfaceId.Rubble]: { friction: 0.95, restitution: 0.02, densityKgM3: 1500 },
  [SurfaceId.Plaster]: { friction: 0.86, restitution: 0.04, densityKgM3: 1300 },
  [SurfaceId.Tile]: { friction: 0.62, restitution: 0.12, densityKgM3: 2000 },
  [SurfaceId.Sand]: { friction: 1.0, restitution: 0.01, densityKgM3: 1600 },
  [SurfaceId.WetSand]: { friction: 1.0, restitution: 0.0, densityKgM3: 1900 },
  [SurfaceId.Dirt]: { friction: 0.94, restitution: 0.02, densityKgM3: 1500 },
  [SurfaceId.Gravel]: { friction: 0.98, restitution: 0.03, densityKgM3: 1700 },
  [SurfaceId.Cobble]: { friction: 0.8, restitution: 0.06, densityKgM3: 2300 },
  [SurfaceId.Wood]: { friction: 0.66, restitution: 0.16, densityKgM3: 650 },
  [SurfaceId.PaintedWood]: { friction: 0.58, restitution: 0.18, densityKgM3: 680 },
  [SurfaceId.PaintedMetal]: { friction: 0.42, restitution: 0.24, densityKgM3: 7800 },
  [SurfaceId.RustedMetal]: { friction: 0.62, restitution: 0.14, densityKgM3: 7600 },
  [SurfaceId.BareMetal]: { friction: 0.38, restitution: 0.3, densityKgM3: 7850 },
  [SurfaceId.Grating]: { friction: 0.7, restitution: 0.1, densityKgM3: 7800 },
  [SurfaceId.Glass]: { friction: 0.28, restitution: 0.1, densityKgM3: 2500 },
  [SurfaceId.Fabric]: { friction: 0.78, restitution: 0.0, densityKgM3: 300 },
  [SurfaceId.Tarp]: { friction: 0.7, restitution: 0.0, densityKgM3: 260 },
  [SurfaceId.Sandbag]: { friction: 1.0, restitution: 0.0, densityKgM3: 1750 },
  [SurfaceId.Rope]: { friction: 0.85, restitution: 0.0, densityKgM3: 900 },
  [SurfaceId.Rubber]: { friction: 1.1, restitution: 0.5, densityKgM3: 1100 },
  [SurfaceId.Foliage]: { friction: 0.6, restitution: 0.0, densityKgM3: 400 },
  [SurfaceId.Bark]: { friction: 0.8, restitution: 0.05, densityKgM3: 700 },
  [SurfaceId.Flesh]: { friction: 0.9, restitution: 0.0, densityKgM3: 1010 },
  [SurfaceId.Kevlar]: { friction: 0.7, restitution: 0.02, densityKgM3: 1440 },
};

export function surfacePhysics(id: SurfaceId): SurfacePhysics {
  return SURFACE_PHYSICS[id] ?? DEFAULT_PHYSICS;
}

/** Surfaces a ray passes THROUGH while attenuating, rather than stopping at. */
export function isAttenuatingSurface(id: SurfaceId): boolean {
  return id === SurfaceId.Foliage || id === SurfaceId.Tarp || id === SurfaceId.Fabric;
}
