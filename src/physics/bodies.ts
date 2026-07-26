/**
 * `BodyDesc` → rapier, and the collider ↔ EntityId bookkeeping every query
 * result depends on. OWNER: PHYS.
 *
 * DETERMINISM: every body carries a monotonically increasing integer SPAWN KEY
 * and the table iterates in key order, never in rapier handle order and never
 * over a Map keyed by object identity. rapier's solver is reproducible for
 * identical input sequences but NOT across differing body-insertion order, and
 * destruction makes insertion order dynamic — so "spawn in a stable integer key
 * order" is not a style note, it is the reason two runs of `destruction_wall`
 * produce the same debris pile.
 *
 * Removals leave a tombstone and are compacted at the end of the tick, which
 * keeps the surviving records in their original relative order. Compacting
 * eagerly (swap-with-last) would reorder the array and silently change the
 * iteration sequence the next tick's impulses are applied in.
 */
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  CollisionGroup,
  HitZone,
  SurfaceId,
  type BodyDesc,
  type BodyHandle,
  type BodyMode,
  type ColliderShape,
  type EntityId,
  type Quat,
  type Vec3,
} from '@/engine/types';
import { interactionGroups, surfacePhysics } from '@/physics/layers';

export interface BodyRecord {
  /** Stable integer spawn key. The ONLY thing iteration order may depend on. */
  readonly key: number;
  readonly handle: BodyHandle;
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[];
  readonly entity: EntityId;
  readonly surface: SurfaceId;
  readonly group: CollisionGroup;
  readonly mode: BodyMode;
  readonly zone: HitZone;
  /** Simulation seconds at which this body self-destroys, or -1 for never. */
  expiresAt: number;
  alive: boolean;
  /** Called after the body leaves the world; debris uses it to drop its mesh. */
  onRemoved: ((record: BodyRecord) => void) | null;
}

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Build the rapier `ColliderDesc` for one of our shapes.
 *
 * Note what is NOT here: nothing ever converts render geometry into a collider.
 * Heightfield for terrain, boxes and convex hulls for ~90% of built geometry,
 * trimesh only for the freighter hull, the cranes and the fort ramparts —
 * colliders are a deliberate second representation (architecture §11.5).
 */
export function colliderDescOf(shape: ColliderShape): RAPIER.ColliderDesc {
  let desc: RAPIER.ColliderDesc | null;
  switch (shape.kind) {
    case 'box':
      desc = RAPIER.ColliderDesc.cuboid(shape.half.x, shape.half.y, shape.half.z);
      break;
    case 'sphere':
      desc = RAPIER.ColliderDesc.ball(shape.radius);
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      break;
    case 'convex':
      desc = RAPIER.ColliderDesc.convexHull(shape.points);
      break;
    case 'trimesh':
      desc = RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
      break;
    case 'heightfield':
      desc = RAPIER.ColliderDesc.heightfield(
        shape.rows,
        shape.cols,
        shape.heights,
        new RAPIER.Vector3(shape.scale.x, shape.scale.y, shape.scale.z),
      );
      break;
    default: {
      // Exhaustiveness: a new ColliderShape variant must be handled here rather
      // than silently becoming an invisible hole in the world.
      const never: never = shape;
      throw new Error(`PHYS: unhandled collider shape ${JSON.stringify(never)}`);
    }
  }
  if (!desc) {
    throw new Error(`PHYS: rapier rejected a "${shape.kind}" collider (degenerate point set?)`);
  }
  if ('offset' in shape && shape.offset) {
    desc.setTranslation(shape.offset.x, shape.offset.y, shape.offset.z);
  }
  if (shape.kind === 'box' && shape.rotation) {
    const r = shape.rotation;
    desc.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w });
  }
  return desc;
}

export class BodyTable {
  /** Insertion-ordered; tombstoned on destroy and compacted at end of tick. */
  private readonly records: BodyRecord[] = [];
  private readonly byHandle = new Map<number, BodyRecord>();
  private readonly byCollider = new Map<number, BodyRecord>();
  private nextKey = 1;
  private tombstones = 0;

  constructor(private readonly world: RAPIER.World) {}

  get count(): number {
    return this.records.length - this.tombstones;
  }

  /** Iterate live bodies in stable spawn-key order. */
  each(fn: (record: BodyRecord) => void): void {
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (r.alive) fn(r);
    }
  }

  record(handle: BodyHandle): BodyRecord | undefined {
    const r = this.byHandle.get(handle as number);
    return r?.alive ? r : undefined;
  }

  recordOfCollider(colliderHandle: number): BodyRecord | undefined {
    const r = this.byCollider.get(colliderHandle);
    return r?.alive ? r : undefined;
  }

  create(desc: BodyDesc, simSeconds: number): BodyRecord {
    const key = this.nextKey++;
    const rot = desc.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    const builder = rigidBodyDescOf(desc.mode)
      .setTranslation(desc.position.x, desc.position.y, desc.position.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(desc.linearDamping ?? 0.02)
      .setAngularDamping(desc.angularDamping ?? 0.28)
      // Sleeping is what keeps a settled debris field free. A body that cannot
      // sleep costs solver time for the rest of the match.
      .setCanSleep(desc.canSleep ?? true)
      .setCcdEnabled(desc.ccd === true);
    const body = this.world.createRigidBody(builder);

    const phys = surfacePhysics(desc.surface);
    const groups = interactionGroups(desc.group, desc.collidesWith);
    const colliders: RAPIER.Collider[] = [];
    for (const shape of desc.shapes) {
      const cd = colliderDescOf(shape)
        .setFriction(desc.friction ?? phys.friction)
        .setRestitution(desc.restitution ?? phys.restitution)
        .setCollisionGroups(groups);
      if (desc.mode === 'sensor') cd.setSensor(true);
      if (desc.massKg !== undefined) cd.setMass(desc.massKg / Math.max(1, desc.shapes.length));
      else cd.setDensity(phys.densityKgM3);
      colliders.push(this.world.createCollider(cd, body));
    }

    const record: BodyRecord = {
      key,
      handle: key as BodyHandle,
      body,
      colliders,
      entity: desc.entity,
      surface: desc.surface,
      group: desc.group,
      mode: desc.mode,
      zone: desc.zone ?? HitZone.None,
      expiresAt: desc.lifetimeSeconds !== undefined ? simSeconds + desc.lifetimeSeconds : -1,
      alive: true,
      onRemoved: null,
    };
    this.records.push(record);
    this.byHandle.set(key, record);
    for (const c of colliders) this.byCollider.set(c.handle, record);
    return record;
  }

  destroy(handle: BodyHandle): void {
    const record = this.byHandle.get(handle as number);
    if (!record || !record.alive) return;
    record.alive = false;
    this.tombstones++;
    for (const c of record.colliders) this.byCollider.delete(c.handle);
    this.byHandle.delete(handle as number);
    // `removeRigidBody` takes its colliders with it, so they are not removed
    // individually — doing both is a use-after-free inside the wasm heap.
    this.world.removeRigidBody(record.body);
    record.onRemoved?.(record);
  }

  /** Destroy every body whose lifetime has run out. Returns how many went. */
  expire(simSeconds: number): number {
    let removed = 0;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (r.alive && r.expiresAt >= 0 && simSeconds >= r.expiresAt) {
        this.destroy(r.handle);
        removed++;
      }
    }
    return removed;
  }

  /** Order-preserving compaction. Called once per tick, after the step. */
  compact(): void {
    if (this.tombstones === 0) return;
    let write = 0;
    for (let read = 0; read < this.records.length; read++) {
      const r = this.records[read];
      if (r.alive) this.records[write++] = r;
    }
    this.records.length = write;
    this.tombstones = 0;
  }

  clear(): void {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.alive) this.destroy(r.handle);
    }
    this.records.length = 0;
    this.byHandle.clear();
    this.byCollider.clear();
    this.tombstones = 0;
    // The key counter is NOT reset: a stale BodyHandle held by another lane
    // across a harness reset must fail to resolve rather than alias a new body.
  }

  readTransform(record: BodyRecord, outPos: Vec3, outRot: Quat): void {
    const t = record.body.translation();
    const r = record.body.rotation();
    outPos.set(t.x, t.y, t.z);
    outRot.set(r.x, r.y, r.z, r.w);
  }

  countAwake(): number {
    let awake = 0;
    this.each((r) => {
      if (!r.body.isSleeping() && r.body.isDynamic()) awake++;
    });
    return awake;
  }
}

function rigidBodyDescOf(mode: BodyMode): RAPIER.RigidBodyDesc {
  switch (mode) {
    case 'dynamic':
      return RAPIER.RigidBodyDesc.dynamic();
    case 'kinematic':
    case 'character':
      // Position-based, not velocity-based: we own the transform and rapier
      // pushes dynamics out of the way. A velocity-based kinematic body would
      // integrate its own motion and fight the controller's resolve.
      return RAPIER.RigidBodyDesc.kinematicPositionBased();
    case 'static':
    case 'sensor':
      return RAPIER.RigidBodyDesc.fixed();
    default: {
      const never: never = mode;
      throw new Error(`PHYS: unhandled body mode ${String(never)}`);
    }
  }
}

/** Scratch, module-scoped so the hot paths allocate nothing. */
export const SCRATCH_VEC = new THREE.Vector3();
export const SCRATCH_QUAT = new THREE.Quaternion();
export const IDENTITY_ROTATION = IDENTITY_ROT;
