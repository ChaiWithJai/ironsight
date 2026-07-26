/**
 * The per-bot hitbox stack — the only thing in the repo that can produce a
 * non-`None` `HitZone`.
 *
 * OWNER: AI, because AI owns the rig, and `types.ts` says so in as many words:
 * "Character rigs create ONE BODY PER ZONE at `CollisionGroup.Hitbox` and set
 * `BodyDesc.zone`. WITHOUT THIS NOTHING IN THE REPO CAN PRODUCE A NON-`None`
 * HIT ZONE, and `BallisticsDef.zoneMultipliers`, `DamageInfo.zone`, the
 * `entity.killed` headshot flag, the hitmarker and the killfeed all silently
 * stop working together."
 *
 * FIVE BODIES PER BOT, NOT THIRTEEN. One per zone the damage model actually
 * distinguishes, sized from GAME's `CharacterConfig` so the boxes and the
 * capsule can never drift apart. Arms are one box across the shoulders and legs
 * one box under the hips: a soldier is hit in "an arm", never in "the left
 * forearm", and 24 bots × 5 kinematic bodies is a cost the tick can carry where
 * 24 × 13 is not.
 *
 * The pose is ANALYTIC — position, yaw and stance, evaluated in the tick. It
 * deliberately does NOT read the rendered skeleton: that is posed at
 * `RenderStage.Animation` from interpolated presentation state, and a hitbox
 * driven from it would make where a bullet lands depend on frame rate.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  HitZone,
  Stance,
  SurfaceId,
  type BodyHandle,
  type CharacterConfig,
  type ColliderShape,
  type EntityId,
  type PhysicsService,
  type PlayerState,
} from '@/engine/types';

interface ZoneDesc {
  readonly zone: HitZone;
  /** Half-extents at the reference 1.8 m stand height, in metres. */
  readonly half: THREE.Vector3;
  /** Centre height as a FRACTION of the current capsule height. */
  readonly centre: number;
  /** Forward offset in body space; the chest sits proud of the spine. */
  readonly forward: number;
}

/**
 * Fractions rather than absolutes so crouch and prone shrink the stack with the
 * capsule instead of leaving a head floating where the bot used to be.
 */
const ZONES: readonly ZoneDesc[] = [
  { zone: HitZone.Head, half: new THREE.Vector3(0.105, 0.125, 0.115), centre: 0.935, forward: 0.0 },
  { zone: HitZone.Torso, half: new THREE.Vector3(0.215, 0.19, 0.135), centre: 0.755, forward: 0.01 },
  { zone: HitZone.Stomach, half: new THREE.Vector3(0.185, 0.13, 0.12), centre: 0.585, forward: 0.0 },
  // Across the shoulders and down to the elbow: the volume a rifle carry
  // actually occupies, which is why arm hits are common and cheap.
  { zone: HitZone.Arm, half: new THREE.Vector3(0.33, 0.155, 0.11), centre: 0.775, forward: 0.06 },
  { zone: HitZone.Leg, half: new THREE.Vector3(0.185, 0.26, 0.12), centre: 0.27, forward: 0.0 },
];

interface Entry {
  readonly entity: EntityId;
  readonly bodies: BodyHandle[];
  /** Reference height the shapes were built at; a stance change rebuilds them. */
  builtHeight: number;
}

const POS = new THREE.Vector3();
const ROT = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class HitboxStack {
  private readonly entries = new Map<number, Entry>();

  /**
   * Takes an ACCESSOR, not the service. `physics` is not one of AI's declared
   * `dependsOn` keys — the frozen descriptor table lists `nav`, `level` and
   * `player` — and `Services` throws on a read of anything not yet constructed.
   * Resolving it at call time keeps this legal no matter how the boot order
   * changes around us.
   */
  constructor(private readonly resolve: () => PhysicsService) {}

  private get physics(): PhysicsService {
    return this.resolve();
  }

  get bodyCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) n += entry.bodies.length;
    return n;
  }

  /**
   * Create the five bodies for `entity`. Idempotent, and a no-op while physics
   * is null — `sync` retries, so a bot that spawned before rapier came up gets
   * its hitboxes the first tick after it does.
   */
  private ensure(entity: EntityId, config: Readonly<CharacterConfig>, state: Readonly<PlayerState>): Entry | null {
    if (!this.physics.ready) return null;
    const existing = this.entries.get(entity as number);
    const height = capsuleHeight(config, state.stance);
    if (existing) {
      if (Math.abs(existing.builtHeight - height) < 0.02) return existing;
      // Stance changed enough to matter. Rapier colliders are not resizable
      // through this contract, so the stack is rebuilt — rare (a stance change
      // is a fraction of a Hz per bot) and exact, which beats a stale box.
      this.release(entity);
    }

    const scale = height / 1.8;
    const bodies: BodyHandle[] = [];
    for (const zone of ZONES) {
      const shape: ColliderShape = {
        kind: 'box',
        half: new THREE.Vector3(zone.half.x * scale, zone.half.y * scale, zone.half.z * scale),
      };
      bodies.push(
        this.physics.createBody({
          mode: 'kinematic',
          entity,
          position: state.position,
          shapes: [shape],
          surface: SurfaceId.Flesh,
          group: CollisionGroup.Hitbox,
          // Hitboxes stop bullets and nothing else. Colliding with anything
          // solid would make a soldier's own chest push him out of a doorway.
          collidesWith: CollisionGroup.Projectile,
          zone: zone.zone,
        }),
      );
    }
    const entry: Entry = { entity, bodies, builtHeight: height };
    this.entries.set(entity as number, entry);
    return entry;
  }

  /** Drive every zone to this tick's pose. Called from `TickPhase.PrePhysics`. */
  sync(entity: EntityId, config: Readonly<CharacterConfig>, state: Readonly<PlayerState>): void {
    if (!state.alive) {
      // A corpse is not shootable. Releasing rather than sinking the boxes
      // underground keeps the body count honest and the ray query cheap.
      this.release(entity);
      return;
    }
    const entry = this.ensure(entity, config, state);
    if (!entry) return;
    const height = entry.builtHeight;
    ROT.setFromAxisAngle(UP, state.yaw);
    // Body-space forward is −Z at yaw 0, matching `PlayerState.yaw`'s basis.
    const sin = Math.sin(state.yaw);
    const cos = Math.cos(state.yaw);
    for (let i = 0; i < ZONES.length; i++) {
      const zone = ZONES[i];
      POS.set(
        state.position.x - sin * zone.forward,
        state.position.y + zone.centre * height,
        state.position.z - cos * zone.forward,
      );
      this.physics.setKinematicTarget(entry.bodies[i], POS, ROT);
    }
  }

  release(entity: EntityId): void {
    const entry = this.entries.get(entity as number);
    if (!entry) return;
    for (const body of entry.bodies) this.physics.destroyBody(body);
    this.entries.delete(entity as number);
  }

  releaseAll(): void {
    for (const key of [...this.entries.keys()]) this.release(key as EntityId);
  }
}

function capsuleHeight(config: Readonly<CharacterConfig>, stance: Stance): number {
  return stance === Stance.Prone
    ? config.proneHeight
    : stance === Stance.Crouch
      ? config.crouchHeight
      : config.standHeight;
}
