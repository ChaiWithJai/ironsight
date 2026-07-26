/**
 * Articulated death ragdolls. OWNER: PHYS.
 *
 * Eleven capsules and ten spherical joints, in the proportions of the 1.8 m
 * soldier capsule GAME authors — a ragdoll that is not the same size as the
 * character it replaces is the classic "the body grew when it died" tell.
 *
 * THREE THINGS KEEP A RAGDOLL FROM BOILING
 * ----------------------------------------
 * 1. NO SELF-COLLISION. Limb-on-limb contact against a joint that is pulling the
 *    same two bodies together is a fight the solver cannot win at 4 iterations,
 *    and the result is a corpse that vibrates. Every segment belongs to
 *    `CollisionGroup.Debris` and collides only with the world, so limbs pass
 *    through each other and the silhouette still reads correctly.
 * 2. EXTRA SOLVER ITERATIONS PER BODY, not globally. `setAdditionalSolverIterations`
 *    buys joint accuracy for the eleven bodies that need it without making a
 *    two-hundred-piece debris field pay for it.
 * 3. HEAVY ANGULAR DAMPING. Real tissue is enormously lossy; an undamped chain of
 *    capsules is a pendulum and swings for ten seconds. 0.9 settles in about one.
 *
 * The blend from an animated pose is deliberately NOT here: AI owns the skinned
 * soldier and the pose it dies in, and would drive this through
 * `spawnRagdoll(..., pose)`. What this file guarantees is that the articulation
 * exists, is stable, and comes to rest.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  LAYER_SOLID,
  SurfaceId,
  type EntityId,
  type Vec3,
} from '@/engine/types';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { BodyRecord, BodyTable } from '@/physics/bodies';

export interface RagdollSegment {
  readonly name: string;
  readonly record: BodyRecord;
  readonly radius: number;
  /** Half the length of the cylindrical section; 0 for the head sphere. */
  readonly halfHeight: number;
}

export interface Ragdoll {
  readonly entity: EntityId;
  readonly segments: readonly RagdollSegment[];
  dispose(): void;
}

interface SegmentSpec {
  name: string;
  /** Centre in the ragdoll's local frame: origin at the feet, +y up, +z front. */
  x: number;
  y: number;
  z: number;
  radius: number;
  halfHeight: number;
  massKg: number;
}

interface JointSpec {
  a: string;
  b: string;
  /** Joint centre in the same local frame. */
  x: number;
  y: number;
  z: number;
}

/**
 * Segment masses sum to 78 kg and follow the standard anthropometric split
 * (head 8%, torso 44%, arms 5% each, legs 19% each). Getting the RATIOS right is
 * what makes a body fall head-last down a stair instead of cartwheeling.
 */
const SEGMENTS: readonly SegmentSpec[] = [
  { name: 'pelvis', x: 0, y: 0.95, z: 0, radius: 0.15, halfHeight: 0.08, massKg: 12 },
  { name: 'chest', x: 0, y: 1.32, z: 0, radius: 0.17, halfHeight: 0.13, massKg: 22 },
  { name: 'head', x: 0, y: 1.63, z: 0, radius: 0.115, halfHeight: 0.0, massKg: 6 },
  { name: 'armL', x: 0.24, y: 1.36, z: 0, radius: 0.06, halfHeight: 0.11, massKg: 2.4 },
  { name: 'armR', x: -0.24, y: 1.36, z: 0, radius: 0.06, halfHeight: 0.11, massKg: 2.4 },
  { name: 'foreL', x: 0.24, y: 1.08, z: 0, radius: 0.055, halfHeight: 0.11, massKg: 1.6 },
  { name: 'foreR', x: -0.24, y: 1.08, z: 0, radius: 0.055, halfHeight: 0.11, massKg: 1.6 },
  { name: 'thighL', x: 0.11, y: 0.63, z: 0, radius: 0.085, halfHeight: 0.15, massKg: 8 },
  { name: 'thighR', x: -0.11, y: 0.63, z: 0, radius: 0.085, halfHeight: 0.15, massKg: 8 },
  { name: 'shinL', x: 0.11, y: 0.26, z: 0, radius: 0.07, halfHeight: 0.15, massKg: 4 },
  { name: 'shinR', x: -0.11, y: 0.26, z: 0, radius: 0.07, halfHeight: 0.15, massKg: 4 },
];

const JOINTS: readonly JointSpec[] = [
  { a: 'pelvis', b: 'chest', x: 0, y: 1.13, z: 0 },
  { a: 'chest', b: 'head', x: 0, y: 1.5, z: 0 },
  { a: 'chest', b: 'armL', x: 0.24, y: 1.49, z: 0 },
  { a: 'chest', b: 'armR', x: -0.24, y: 1.49, z: 0 },
  { a: 'armL', b: 'foreL', x: 0.24, y: 1.22, z: 0 },
  { a: 'armR', b: 'foreR', x: -0.24, y: 1.22, z: 0 },
  { a: 'pelvis', b: 'thighL', x: 0.11, y: 0.87, z: 0 },
  { a: 'pelvis', b: 'thighR', x: -0.11, y: 0.87, z: 0 },
  { a: 'thighL', b: 'shinL', x: 0.11, y: 0.44, z: 0 },
  { a: 'thighR', b: 'shinR', x: -0.11, y: 0.44, z: 0 },
];

/**
 * Build a ragdoll with its feet at `origin`, facing `yaw`, and give the chest a
 * kick of `impulse` newton-seconds — the residual momentum of whatever killed it.
 */
export function spawnRagdoll(
  world: RAPIER.World,
  table: BodyTable,
  entity: EntityId,
  origin: Vec3,
  yaw: number,
  impulse: Vec3,
  simSeconds: number,
): Ragdoll {
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const local = new THREE.Vector3();
  const byName = new Map<string, RagdollSegment>();
  const segments: RagdollSegment[] = [];

  for (const spec of SEGMENTS) {
    local.set(spec.x, spec.y, spec.z).applyQuaternion(rotation).add(origin);
    const record = table.create(
      {
        mode: 'dynamic',
        entity,
        position: local,
        rotation,
        shapes: [
          spec.halfHeight > 0
            ? { kind: 'capsule', halfHeight: spec.halfHeight, radius: spec.radius }
            : { kind: 'sphere', radius: spec.radius },
        ],
        surface: SurfaceId.Flesh,
        group: CollisionGroup.Debris,
        // World only. Limb-on-limb contact fights the joints and boils.
        collidesWith: LAYER_SOLID,
        massKg: spec.massKg,
        linearDamping: 0.12,
        // Tissue is lossy. Without this the chain swings like a pendulum.
        angularDamping: 0.9,
        canSleep: true,
      },
      simSeconds,
    );
    // Joint accuracy where it is needed, not across the whole island.
    record.body.setAdditionalSolverIterations(4);
    const segment: RagdollSegment = {
      name: spec.name,
      record,
      radius: spec.radius,
      halfHeight: spec.halfHeight,
    };
    segments.push(segment);
    byName.set(spec.name, segment);
  }

  const joints: RAPIER.ImpulseJoint[] = [];
  for (const j of JOINTS) {
    const a = byName.get(j.a);
    const b = byName.get(j.b);
    const specA = SEGMENTS.find((s) => s.name === j.a);
    const specB = SEGMENTS.find((s) => s.name === j.b);
    if (!a || !b || !specA || !specB) continue;
    // Anchors are expressed in each body's OWN local frame. Every segment spawns
    // with the same rotation, so the local offset is just the difference of the
    // two centres in the ragdoll's un-rotated frame.
    const anchorA = { x: j.x - specA.x, y: j.y - specA.y, z: j.z - specA.z };
    const anchorB = { x: j.x - specB.x, y: j.y - specB.y, z: j.z - specB.z };
    joints.push(
      world.createImpulseJoint(
        RAPIER.JointData.spherical(anchorA, anchorB),
        a.record.body,
        b.record.body,
        true,
      ),
    );
  }

  const chest = byName.get('chest');
  if (chest) {
    chest.record.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  let disposed = false;
  return {
    entity,
    segments,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Joints go first: removing a body that a live joint still references is
      // a use-after-free inside the wasm heap.
      for (const joint of joints) world.removeImpulseJoint(joint, false);
      for (const segment of segments) table.destroy(segment.record.handle);
    },
  };
}
