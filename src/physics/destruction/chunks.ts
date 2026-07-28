/**
 * The debris chunk pool: spawn, budget, settle. OWNER: PHYS.
 *
 * THE BUDGET IS THE WHOLE DESIGN. A five-metre masonry wall fractures into
 * thirty shards; three walls and a floor is a hundred and twenty dynamic bodies,
 * all in one solver island, all in the same second. The tier's `maxChunks` is a
 * hard ceiling and the pool ENFORCES it by settling the oldest chunks early
 * rather than by refusing to spawn new ones — a collapse that visibly drops
 * fewer pieces than the last one reads as a bug, a pile that stopped moving a
 * second early does not.
 *
 * SETTLE-TO-STATIC IS LOAD-BEARING, NOT AN OPTIMISATION. A chunk that has been
 * asleep for `settleAfter` seconds gives up its rigid body entirely and keeps
 * only its mesh, frozen at the transform it came to rest in. Rubble therefore
 * accumulates across a whole match for the price of draw calls, while the solver
 * only ever carries the pieces that are actually moving. Without it, ten minutes
 * of Conquest ends with four hundred sleeping bodies that wake in a cascade the
 * moment a grenade lands.
 *
 * DETERMINISM: chunks are spawned in shard index order, retired in SPAWN KEY
 * order, and every impulse is drawn from a stream seeded per collapse. Two runs
 * of `destruction_wall` therefore produce the same pile, which is the only reason
 * the shot is reviewable at all.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  Sim,
  type ColliderShape,
  type EntityId,
  type Mat4,
  type QualitySettings,
  type Rng,
  type SurfaceId,
  type Vec3,
} from '@/engine/types';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { BodyRecord, BodyTable } from '@/physics/bodies';
import { defaultCollidesWith, surfacePhysics } from '@/physics/layers';
import type { PhysicsVisuals } from '@/physics/visuals';
import type { FractureShard } from '@/physics/destruction/fracture';

interface LiveChunk {
  readonly record: BodyRecord;
  readonly mesh: THREE.Mesh;
  readonly surface: SurfaceId;
  /** Simulation seconds at which the chunk first fell asleep, or -1. */
  asleepSince: number;
  settled: boolean;
}

export interface ChunkSpawnParams {
  readonly shards: readonly FractureShard[];
  /** World transform of the intact solid. */
  readonly matrix: Mat4;
  readonly surface: SurfaceId;
  readonly entity: EntityId;
  /** Where the damage landed, world space. Shards are thrown away from it. */
  readonly impactPoint: THREE.Vector3;
  /** Residual energy in joules; scales the outward impulse. */
  readonly energyJ: number;
  readonly lifetimeSeconds: number;
  readonly settleAfter: number;
  /**
   * PER-AXIS re-proportioning of shard CENTRES, so a shard set baked at one
   * size covers the footprint of the solid that actually broke. 1,1,1 when the
   * set was baked at this solid's own size.
   */
  readonly centreScale?: Vec3;
  /**
   * UNIFORM re-scale of shard SHAPES. Deliberately not per-axis: a 5 × 2.4 ×
   * 0.45 m wall scaled anisotropically off a unit fracture sheds 11:5:1 wafers,
   * which reads as torn paper rather than as masonry. Uniform keeps the shard
   * proportions the fracture produced and lets the centres do the spreading.
   */
  readonly shapeScale?: number;
}

/**
 * A uniformly scaled copy of a shard's collider. Convex hulls are the only kind
 * a fracture produces, but the switch is exhaustive so a future shard kind
 * cannot silently spawn at the wrong size.
 */
function scaleCollider(shape: ColliderShape, s: number): ColliderShape {
  switch (shape.kind) {
    case 'convex': {
      const points = new Float32Array(shape.points.length);
      for (let i = 0; i < points.length; i++) points[i] = shape.points[i] * s;
      return { kind: 'convex', points, offset: shape.offset };
    }
    case 'box':
      return {
        kind: 'box',
        half: new THREE.Vector3(shape.half.x * s, shape.half.y * s, shape.half.z * s),
        offset: shape.offset,
        rotation: shape.rotation,
      };
    case 'sphere':
      return { kind: 'sphere', radius: shape.radius * s, offset: shape.offset };
    case 'capsule':
      return { kind: 'capsule', halfHeight: shape.halfHeight * s, radius: shape.radius * s, offset: shape.offset };
    case 'cylinder':
      return { kind: 'cylinder', halfHeight: shape.halfHeight * s, radius: shape.radius * s, offset: shape.offset };
    default:
      return shape;
  }
}

export class ChunkPool {
  private readonly live: LiveChunk[] = [];
  private settledCount = 0;
  /**
   * Unsettled chunk count, maintained incrementally. It was a `reduce` over the
   * whole list, which the spawn loop consults once PER SHARD — quadratic in the
   * size of a collapse, and a collapse is exactly when the frame is tightest.
   */
  private unsettled = 0;

  constructor(
    private readonly table: BodyTable,
    private readonly visuals: PhysicsVisuals,
    private readonly quality: () => Readonly<QualitySettings>,
  ) {}

  get liveCount(): number {
    return this.unsettled;
  }

  get settled(): number {
    return this.settledCount;
  }

  get budgetUsed01(): number {
    const max = Math.max(1, this.quality().destruction.maxChunks);
    return Math.min(1, this.liveCount / max);
  }

  /**
   * Spawn one collapse. Returns the number of chunks that actually became
   * bodies — the rest are dropped at the ceiling, deterministically, from the
   * back of the shard list.
   */
  spawn(params: ChunkSpawnParams, rng: Rng, simSeconds: number): number {
    const settings = this.quality();
    const budget = settings.destruction.maxChunks;
    // Make room BEFORE spawning, so a collapse never renders half a wall.
    this.retireOldest(Math.max(0, this.liveCount + params.shards.length - budget), simSeconds);

    const physics = surfacePhysics(params.surface);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    params.matrix.decompose(position, rotation, scale);

    const centre = new THREE.Vector3();
    const impulse = new THREE.Vector3();
    const cs = params.centreScale;
    const shape = params.shapeScale ?? 1;
    const shaped = Math.abs(shape - 1) > 1e-3;
    let spawned = 0;

    for (const shard of params.shards) {
      if (this.liveCount >= budget) break;
      centre.set(shard.centre.x, shard.centre.y, shard.centre.z);
      if (cs) centre.set(centre.x * cs.x, centre.y * cs.y, centre.z * cs.z);
      centre.applyQuaternion(rotation).add(position);

      const collider = shaped ? scaleCollider(shard.collider, shape) : shard.collider;
      const mass = Math.max(0.4, shard.volumeM3 * shape * shape * shape * physics.densityKgM3);
      const record = this.table.create(
        {
          mode: 'dynamic',
          entity: params.entity,
          position: centre,
          rotation,
          shapes: [collider],
          surface: params.surface,
          group: CollisionGroup.Debris,
          collidesWith: defaultCollidesWith(CollisionGroup.Debris),
          massKg: mass,
          linearDamping: 0.06,
          angularDamping: 0.35,
          canSleep: true,
          lifetimeSeconds: params.lifetimeSeconds,
        },
        simSeconds,
      );

      // Contact-force events are what let AUDIO hear masonry land and VFX puff
      // dust at the point of impact. Threshold high enough that resting contacts
      // in a settled pile never fire.
      for (const collider of record.colliders) {
        collider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        collider.setContactForceEventThreshold(mass * Sim.GRAVITY * 3);
      }

      // Away from the impact, with an upward bias so the pile spreads instead of
      // pancaking, and a small random component so no two shards fly in lockstep.
      impulse.copy(centre).sub(params.impactPoint);
      const distance = Math.max(0.25, impulse.length());
      impulse.multiplyScalar(1 / distance);
      impulse.y += 0.45;
      impulse.normalize();
      // Impulse falls off with distance from the blast, like a real pressure
      // front, and scales with the square root of energy rather than linearly —
      // a rocket should not throw a shard ten times further than a grenade.
      //
      // The coefficient is per unit MASS, so it reads directly as a muzzle
      // velocity for the shard: 0.018 × √42 kJ ≈ 3.7 m/s at one metre from the
      // charge. Masonry that leaves a wall faster than about 5 m/s stops looking
      // like a collapse and starts looking like confetti in a wind tunnel.
      const strength = (Math.sqrt(Math.max(0, params.energyJ)) * 0.018 * mass) / distance;
      impulse.multiplyScalar(strength);
      impulse.x += rng.range(-0.4, 0.4) * strength * 0.25;
      impulse.z += rng.range(-0.4, 0.4) * strength * 0.25;
      record.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
      record.body.setAngvel(
        { x: rng.range(-4, 4), y: rng.range(-4, 4), z: rng.range(-4, 4) },
        true,
      );

      const geometry = shard.geometry.clone();
      if (shaped) geometry.scale(shape, shape, shape);
      const mesh = this.visuals.addBodyMesh(record, geometry, params.surface);
      const chunk: LiveChunk = { record, mesh, surface: params.surface, asleepSince: -1, settled: false };
      record.onRemoved = () => {
        // The body may go before the chunk does — a lifetime expiry. Keep the
        // mesh where it stopped: that is the settle, arrived at from the other
        // direction.
        if (!chunk.settled) {
          chunk.settled = true;
          this.unsettled--;
          this.settledCount++;
        }
        chunk.asleepSince = -1;
      };
      this.live.push(chunk);
      this.unsettled++;
      spawned++;
    }
    return spawned;
  }

  /**
   * Per-tick maintenance. Runs at `TickPhase.Destruction`, after the step, so
   * `isSleeping()` reflects this tick's solve.
   */
  tick(simSeconds: number, settleSecondsDefault: number): void {
    for (const chunk of this.live) {
      if (chunk.settled) continue;
      if (!chunk.record.alive) {
        chunk.settled = true;
        this.unsettled--;
        this.settledCount++;
        continue;
      }
      if (chunk.record.body.isSleeping()) {
        if (chunk.asleepSince < 0) chunk.asleepSince = simSeconds;
        else if (simSeconds - chunk.asleepSince >= settleSecondsDefault) this.settle(chunk);
      } else {
        chunk.asleepSince = -1;
      }
    }
    // A chunk whose body has gone and whose mesh is frozen costs nothing but a
    // draw call, so entries are kept; only the tracking list is compacted.
    if (this.live.length > 512) this.retireOldest(this.live.length - 512, simSeconds);
  }

  /** Free the body, keep the mesh exactly where it came to rest. */
  private settle(chunk: LiveChunk): void {
    if (chunk.settled) return;
    chunk.settled = true;
    this.unsettled--;
    this.settledCount++;
    // The mesh has already been synced onto the body this frame; dropping the
    // body leaves it frozen at that transform.
    if (chunk.record.alive) {
      chunk.record.onRemoved = null;
      this.table.destroy(chunk.record.handle);
    }
  }

  /** Settle the `count` oldest unsettled chunks. Spawn-key order, always. */
  private retireOldest(count: number, _simSeconds: number): void {
    if (count <= 0) return;
    let done = 0;
    for (const chunk of this.live) {
      if (done >= count) break;
      if (chunk.settled) continue;
      this.settle(chunk);
      done++;
    }
  }

  /** Drop everything: bodies, meshes, counters. Called from the reset chain. */
  clear(): void {
    for (const chunk of this.live) {
      chunk.record.onRemoved = null;
      if (chunk.record.alive) this.table.destroy(chunk.record.handle);
    }
    this.live.length = 0;
    this.settledCount = 0;
    this.unsettled = 0;
  }
}
