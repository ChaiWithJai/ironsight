/**
 * THE FRAG GRENADE. WEAPONS owns this file.
 *
 * `Btn.Grenade` has been bound to `G` in `src/engine/input.ts` and reaching
 * `PlayerIntent` for the whole life of this project with NOTHING READING IT.
 * This is the reader. It is deliberately wiring, not construction: destruction,
 * the explosion VFX, the blast audio, the clustered light and the damage model
 * are all built, tested and already exercised by their lanes' own shots — every
 * one of them was simply unreachable from a key press.
 *
 * THE ONE CODE PATH RULE. This reads `Btn.Grenade` out of
 * `PlayerService.intentOf(entity)` for EVERY entity in `PlayerService.controlled`
 * — the human and all 24 bots — exactly the way `weapons/system.ts` reads
 * `Btn.Fire` (architecture §3.4 rule 4). There is no player branch anywhere in
 * this file. `src/ai/brain.ts` already sets the bit for 0.85 s when a bot wants
 * to throw (`bot.throwingUntil`), so bots got grenades the moment this landed,
 * with a 0.85 s cook, from the same state machine, and a bug in the throw
 * cannot manifest differently for the two.
 *
 * WHAT HAPPENS WHEN IT GOES OFF, AND WHO OWNS EACH PIECE
 * ------------------------------------------------------
 *   fireball + smoke + ejecta   VFX     `FxEventMap['explosion']`
 *   scorch decal                VFX     same event
 *   world light                 LIGHT   VFX's recipe calls `lighting.flash()`
 *   near/far report + duck      AUDIO   same event
 *   soldier damage + kills      GAME    `SimEventMap['damage.applied']`
 *   breached cover + debris     PHYS    `DestructionService.applyDamage()`
 *   bots hearing it             AI      `SimEventMap['noise.emitted']`
 *   loose bodies thrown         PHYS    `applyRadialImpulse()`
 *
 * Not one of those is implemented here. This file decides WHO and HOW MUCH and
 * then says so on the two buses, which is the whole of WEAPONS' side of the seam.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG AND ARE WRITTEN DOWN HERE BECAUSE THEY
 * COST TIME:
 *
 *  1. LINE OF SIGHT IS NOT OPTIONAL. `PhysicsService.visibility(from, to,
 *     LAYER_SOLID)` returns 0 through a wall and attenuates through foliage and
 *     tarps. Without it a grenade in the street kills everyone in the building,
 *     which is the single loudest "this is a toy" tell an explosion can have.
 *     `LAYER_SOLID` deliberately excludes `CollisionGroup.Character`, so a
 *     soldier standing between the blast and another soldier does not shield him
 *     — bodies are not cover, and including them would make the query O(n²) in
 *     who happens to be standing where.
 *
 *  2. THE BURST ORIGIN IS LIFTED OFF THE BODY. A settled grenade's centre sits
 *     31 mm above the ground, and a visibility ray from there to a target's
 *     chest clips the ground plane at any range past a few metres — every
 *     target reads as occluded and the grenade does nothing at all. It is a
 *     total, silent failure that looks exactly like "the damage code is not
 *     called". `ThrowableDef.burstHeight` is the fix and the reason.
 *
 *  3. STRUCTURE AND PEOPLE GET DIFFERENT RADII AND DIFFERENT NUMBERS. See the
 *     header of `defs/frag-grenade.ts`.
 *
 * DETERMINISM. No RNG at all: a throw is a pure function of the aim basis, the
 * hold length and the thrower's velocity, and everything after release is
 * rapier. Grenades are iterated in ascending spawn key, never in Map order, so
 * two runs of the same shot detonate in the same sequence.
 */
import * as THREE from 'three';
import {
  Btn,
  CollisionGroup,
  DamageKind,
  HitZone,
  LAYER_SOLID,
  NULL_ENTITY,
  RenderLayer,
  RenderStage,
  SceneGroup,
  Sim,
  SurfaceId,
  Team,
  TickPhase,
  type BodyDesc,
  type BodyHandle,
  type BootContext,
  type EntityId,
  type FrameCtx,
  type QueryFilter,
  type RayHit,
  type Services,
  type ThrowableState,
  type TickCtx,
  type TickSystem,
  type Vec3,
} from '@/engine/types';
import { clamp, clamp01, DEG2RAD } from '@/engine/math/curves';
import { FRAG, type ThrowableDef } from '@/weapons/defs/frag-grenade';
import { buildFragMesh } from '@/weapons/models/frag';
import { viewmodelMaterials } from '@/weapons/viewmodel/materials';

/**
 * Grenades in flight, across every soldier on the map. 24 bots at two apiece is
 * 48 in theory and never more than a handful in practice, because the fuse is
 * 3.4 s. Over the cap a throw is refused and the unit stays in the pouch, which
 * is the only failure mode that does not lie to the player about their stock.
 */
const POOL = 32;
/** Meshes built. Past this a grenade is simulated but not drawn. */
const MESH_BUDGET = 16;
/** Scratch for `overlapSphere`. Sized well past what a 3.5 m sphere can hold. */
const OVERLAP_MAX = 96;
/** Half-extent of a grenade's culling box. The mesh is 62 x 71 mm. */
const MESH_HALF_EXTENT = 0.06;
/**
 * Where a mesh slot's bounds go when nothing is using it: a degenerate box a
 * kilometre under the sea floor, which no frustum this game builds can contain.
 */
const PARKED_Y = -4000;
/** Squared per-tick step under which a grenade counts as at rest. 0.3 m/s. */
const RESTING_STEP_SQ = (0.3 / Sim.TICK_HZ) ** 2;

function park(box: THREE.Box3): void {
  box.min.set(0, PARKED_Y, 0);
  box.max.set(0, PARKED_Y, 0);
}

/** Everything that touches STRUCTURE. Characters and debris are handled apart. */
const STRUCTURE_GROUPS = CollisionGroup.StaticGeo | CollisionGroup.Prop;
/** What a blast shoves: loose bodies, never a character capsule. */
const IMPULSE_GROUPS = CollisionGroup.Debris | CollisionGroup.Prop;

function makeHit(): RayHit {
  return {
    hit: false,
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surface: SurfaceId.Concrete,
    body: 0 as BodyHandle,
    entity: NULL_ENTITY,
    zone: HitZone.None,
    backface: false,
  };
}

/** One grenade in the world. Pooled; `active` is the only liveness test. */
interface Grenade {
  active: boolean;
  /** Ascending spawn key. THE iteration order — never Map order. */
  key: number;
  owner: EntityId;
  team: Team;
  body: BodyHandle;
  detonateAtTick: number;
  /** Sim transform, written at tick rate. */
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  /** Previous tick's, so the render side can interpolate by `FrameCtx.alpha`. */
  readonly prevPosition: THREE.Vector3;
  readonly prevRotation: THREE.Quaternion;
  /** Index into the mesh pool, or -1 when over `MESH_BUDGET`. */
  meshSlot: number;
  /** Release point, so a flight distance can be reported without a subscriber. */
  readonly origin: THREE.Vector3;
  /** Ticks whose position delta was under a millimetre. It has settled. */
  restingTicks: number;
}

/** One soldier's pouch. Created on demand for anything under locomotion control. */
interface Carrier {
  readonly entity: EntityId;
  count: number;
  cooking: boolean;
  /** Tick the pin came out. The fuse runs from here, not from the release. */
  pinTick: number;
  /** Tick after which another pin may be pulled. */
  readyTick: number;
  live: number;
  /** Alive last tick, so a respawn can restock without an event subscription. */
  wasAlive: boolean;
}

/** Counters the probe publishes. Diagnostics only; nothing reads them in-game. */
interface Counters {
  thrown: number;
  detonated: number;
  refusedEmpty: number;
  refusedPool: number;
  explosionsEmitted: number;
  soldiersDamaged: number;
  soldiersOccluded: number;
  damageDealt: number;
  destructiblesInBlast: number;
  destructiblesDestroyed: number;
  chunksSpawned: number;
  coverLost: number;
  /** Swept-guard interventions: fast legs rapier's own CCD would have missed. */
  tunnelsCaught: number;
  /** `LightingService.activeLights` sampled the tick after the last burst. */
  lightsAfterBurst: number;
  lastBurst: [number, number, number] | null;
  /** Release state of the most recent throw, for diagnosing a bad arc. */
  lastThrow: {
    origin: [number, number, number];
    velocity: [number, number, number];
    speed: number;
    cook: number;
    fuseTicks: number;
  } | null;
  /** Metres the last grenade travelled between release and detonation. */
  lastFlightDistance: number;
  /** Ticks the last grenade spent at rest (under 0.3 m/s) before it went off. */
  lastRestingTicks: number;
  /** Speed of the last grenade at the instant it detonated, m/s. */
  lastSpeedAtBurst: number;
}

export class Throwables implements TickSystem {
  readonly name = 'weapons.throwables';
  // AFTER `weapons.fireControl` (order 0) in the same phase, which is where a
  // throw belongs: it is the same trigger-reading step, and it must sit after
  // Physics (500) so a live grenade's transform is this tick's, not last's.
  readonly phase = TickPhase.Weapons;
  readonly order = 5;

  private readonly def: ThrowableDef = FRAG;

  private readonly pool: Grenade[] = [];
  private readonly carriers = new Map<number, Carrier>();
  /** Carrier iteration order. `PlayerService.controlled` is dense and stable. */
  private nextKey = 1;

  private readonly meshes: THREE.Object3D[] = [];
  /**
   * ONE `Box3` per mesh slot, registered with `addDynamic` and updated in place
   * every frame — which is how visibility is actually controlled here.
   *
   * `Object3D.visible` CANNOT be used for this and the failure is silent:
   * `src/engine/culling.ts` pass 3 writes `d.object.visible = d.visible` for
   * every registered dynamic on every frame, so a mesh hidden from this file is
   * un-hidden before it is drawn and a retired grenade hangs in the air at the
   * point it detonated, forever. Parking the bounds far below the world is the
   * supported way to tell the culler an entry is not there.
   */
  private readonly meshBounds: THREE.Box3[] = [];
  private meshesFailed = false;

  private readonly hit = makeHit();
  private readonly overlap: EntityId[] = new Array<EntityId>(OVERLAP_MAX).fill(NULL_ENTITY);
  private readonly filterSolid: QueryFilter = { groups: LAYER_SOLID, solid: true };
  private readonly filterStructure: QueryFilter = { groups: STRUCTURE_GROUPS, solid: true };
  /** `excludeEntity` is rewritten per throw, so this local view is mutable. */
  private readonly filterThrow: { -readonly [K in keyof QueryFilter]: QueryFilter[K] } = {
    groups: LAYER_SOLID,
    solid: true,
  };

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly down = new THREE.Vector3(0, -1, 0);

  /** Sampled one tick after a burst, so LIGHT has had a chance to see it. */
  private lightSampleTick = -1;

  readonly counters: Counters = freshCounters();

  constructor(private readonly ctx: BootContext) {
    for (let i = 0; i < POOL; i++) {
      this.pool.push({
        active: false,
        key: 0,
        owner: NULL_ENTITY,
        team: Team.Neutral,
        body: 0 as BodyHandle,
        detonateAtTick: 0,
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        prevPosition: new THREE.Vector3(),
        prevRotation: new THREE.Quaternion(),
        meshSlot: -1,
        origin: new THREE.Vector3(),
        restingTicks: 0,
      });
    }
  }

  /* ================================================================ contract */

  throwableOf(entity: EntityId): Readonly<ThrowableState> | null {
    const carrier = this.carriers.get(entity as number);
    if (!carrier) return null;
    const tick = this.ctx.services.clock.tick;
    const cook = carrier.cooking ? clamp01(((tick - carrier.pinTick) * Sim.TICK_DT) / this.def.maxCook) : 0;
    // 1 while empty, and a linear ramp back to ready through the refractory —
    // exactly `GadgetSlot.cooldown`'s 0=ready/1=unavailable convention, so the
    // HUD tile's hatch needs no arithmetic of its own.
    const refractoryTicks = Math.max(1, Math.round(this.def.refractorySeconds * Sim.TICK_HZ));
    const cooldown =
      carrier.count <= 0 ? 1 : clamp01((carrier.readyTick - tick) / refractoryTicks);
    return {
      id: this.def.id,
      count: carrier.count,
      capacity: this.def.capacity,
      cooldown,
      cook,
      cooking: carrier.cooking,
      live: carrier.live,
    };
  }

  restock(entity: EntityId): number {
    const carrier = this.carrier(entity);
    const added = Math.max(0, this.def.capacity - carrier.count);
    carrier.count = this.def.capacity;
    return added;
  }

  /** Diagnostics. See `ThrowableProbe`. */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < POOL; i++) if (this.pool[i]!.active) n++;
    return n;
  }

  /** Diagnostics. See `ThrowableProbe`. */
  get poolSize(): number {
    return POOL;
  }

  /** Diagnostics. See `ThrowableProbe.world`. */
  worldProbe(): {
    physicsReady: boolean;
    bodies: number;
    eye: [number, number, number];
    groundBelow: number;
    groundSurface: number;
    aim: [number, number, number];
    destructiblesNear: number;
    coverTarget: [number, number, number] | null;
  } {
    const services = this.ctx.services;
    const local = services.player.localEntity;
    services.weapons.aimBasis(local, this.tmpA, this.tmpDir);
    const ground = services.physics.raycast(this.tmpA, this.down, 500, this.filterSolid, this.hit)
      ? this.hit.distance
      : -1;
    // `PhysicsService.addStatic` mints an entity for a collider ONLY when it
    // carries a `DestructibleDef`, so a non-null entity on a static IS the
    // membership test — there is no other one on the contract.
    const overlaps = services.physics.overlapSphere(this.tmpA, 24, this.filterStructure, this.overlap);
    let breakable = 0;
    for (let i = 0; i < overlaps; i++) if (this.overlap[i] !== NULL_ENTITY) breakable++;
    return {
      physicsReady: services.physics.ready,
      bodies: services.physics.stats.bodies,
      eye: [this.tmpA.x, this.tmpA.y, this.tmpA.z],
      groundBelow: ground,
      groundSurface: ground >= 0 ? this.hit.surface : -1,
      aim: [this.tmpDir.x, this.tmpDir.y, this.tmpDir.z],
      destructiblesNear: breakable,
      coverTarget: this.findCoverTarget(this.tmpA),
    };
  }

  /**
   * Ring-scan for somewhere worth throwing a grenade. Diagnostics only.
   *
   * `overlapSphere` reports ENTITIES, not positions, and `PhysicsService` has no
   * entity->transform call, so a "where is the nearest breakable wall" question
   * cannot be answered directly. Sampling the same breach sphere the detonation
   * uses, on rings out from the player, answers the only form of it that matters:
   * a point that, if a grenade lands there, WILL breach something.
   */
  private findCoverTarget(eye: Vec3): [number, number, number] | null {
    const services = this.ctx.services;
    for (const range of [4, 8, 12, 16, 20]) {
      for (let b = 0; b < 16; b++) {
        const a = (b / 16) * Math.PI * 2;
        this.tmpB.set(eye.x + Math.cos(a) * range, eye.y - 1.0, eye.z + Math.sin(a) * range);
        const n = services.physics.overlapSphere(this.tmpB, this.def.breachRadius, this.filterStructure, this.overlap);
        for (let i = 0; i < n; i++) {
          if (this.overlap[i] !== NULL_ENTITY) return [this.tmpB.x, this.tmpB.y, this.tmpB.z];
        }
      }
    }
    return null;
  }

  /* ==================================================================== tick */

  tick(ctx: TickCtx): void {
    const services = ctx.services;

    /* -- 1. pouches, cooking, throwing ---------------------------------- */
    // `controlled` is dense and in attach order, so this walk is deterministic.
    for (const entity of services.player.controlled) {
      const carrier = this.carrier(entity);
      const state = services.player.stateOf(entity);
      const alive = state !== null && state.alive;

      // Restock on the dead -> alive edge. A respawn is the resupply nobody has
      // to implement; `restockThrowables` is the seam for a crate.
      if (alive && !carrier.wasAlive) {
        carrier.count = this.def.capacity;
        carrier.cooking = false;
      }
      carrier.wasAlive = alive;
      if (!alive || state === null) {
        carrier.cooking = false;
        continue;
      }

      const intent = services.player.intentOf(entity);
      const held = ((intent?.buttons ?? 0) & Btn.Grenade) !== 0;

      if (!carrier.cooking && held && ctx.tick >= carrier.readyTick) {
        if (carrier.count > 0) {
          carrier.cooking = true;
          carrier.pinTick = ctx.tick;
          // The spoon. 2D for the local player, positioned for everyone else, so
          // a bot cooking one behind you is a sound you can locate.
          const local = entity === services.player.localEntity;
          ctx.fx.emit('sound', {
            cue: this.def.pinSound,
            position: local ? null : state.position.clone(),
            desc: { gainDb: local ? -4 : -8 },
          });
        } else {
          // Empty. Counted rather than silent, because "I pressed G and nothing
          // happened" is indistinguishable from a broken binding otherwise, and
          // that is the exact confusion this whole task exists to remove.
          this.counters.refusedEmpty++;
          carrier.readyTick = ctx.tick + Math.round(0.25 * Sim.TICK_HZ);
        }
      }

      if (carrier.cooking) {
        const cook = (ctx.tick - carrier.pinTick) * ctx.dt;
        // Release, or a cook that has run out of rope. See the def's header for
        // why a full cook throws itself rather than killing the thrower.
        if (!held || cook >= this.def.maxCook) this.release(carrier, cook, ctx);
      }
    }

    /* -- 2. live grenades: transform readback, then the fuse ------------- */
    const physics = services.physics;
    for (let i = 0; i < POOL; i++) {
      const g = this.pool[i]!;
      if (!g.active) continue;
      g.prevPosition.copy(g.position);
      g.prevRotation.copy(g.rotation);
      if (!physics.bodyTransform(g.body, g.position, g.rotation)) {
        // The body went away under us (harness reset, world rebuild). Retire the
        // grenade rather than detonating at a stale position.
        this.retire(g);
        continue;
      }
      if (g.position.y < -80) {
        this.retire(g);
        continue;
      }
      this.tunnelGuard(g, ctx);
      // "Settled" as a NUMBER rather than a feeling: a grenade that never stops
      // moving before its fuse runs out has not bounced, it has fallen through
      // the world, and that is a distinction no screenshot can make. 0.3 m/s is
      // the bar — a body creeping slower than that has stopped for any purpose a
      // player cares about, and demanding exact stillness would only measure
      // whether rapier's sleep threshold happened to fire this tick.
      if (g.position.distanceToSquared(g.prevPosition) < RESTING_STEP_SQ) g.restingTicks++;
      if (ctx.tick >= g.detonateAtTick) this.detonate(g, ctx);
    }

    /* -- 3. the light probe --------------------------------------------- */
    // Sampled a tick LATE on purpose: the explosion goes on the FxBus, which
    // drains on the next render frame, so LIGHT cannot have seen it yet at the
    // instant of the burst.
    if (this.lightSampleTick >= 0 && ctx.tick >= this.lightSampleTick) {
      this.counters.lightsAfterBurst = services.lighting.activeLights;
      this.lightSampleTick = -1;
    }
  }

  /**
   * ANTI-TUNNELLING. A 31 mm sphere leaving the hand at 20.5 m/s advances 34 cm
   * per tick — eleven times its own diameter — and rapier's continuous collision
   * detection does not catch it here. MEASURED, not assumed: with `ccd: true`
   * and `maxCcdSubsteps = 2` already set on the world, grenades thrown at every
   * pitch from +50 deg to -74 deg passed straight through terrain that a raycast
   * from the same spot reports as solid 1.5 m below the thrower, and ended their
   * fuse at y = -20 to -76. Inflating the collider to 12 cm fixed it, which is
   * what identifies the mechanism as tunnelling rather than a collision-group or
   * a physics-not-ready problem.
   *
   * A 24 cm collider on a 6 cm object is not the fix — it floats visibly and it
   * catches on doorframes. So the sweep is done explicitly, with
   * `PhysicsService.sphereCast`: exactly the primitive `BallisticsService` uses,
   * for exactly this reason, documented in its own header as "the pool also
   * gives us CCD for free, because the sweep is explicit rather than a solver
   * setting".
   *
   * Only the fast leg is ever guarded. Below `2 x radius` of travel in a tick
   * rapier physically cannot tunnel, so every bounce, roll and settle after the
   * first impact is rapier's, untouched — which is what keeps the body a real
   * physics body rather than a hand-integrated one.
   */
  private tunnelGuard(g: Grenade, ctx: TickCtx): void {
    const def = this.def;
    const step = this.tmpC.copy(g.position).sub(g.prevPosition);
    const distance = step.length();
    if (distance <= def.radius * 2) return;

    // A RAY, not a shape cast. `PhysicsService.sphereCast` was tried first and
    // MEASURED at 7 hits in 182 sweeps down a column where a raycast from the
    // same origin reports solid ground 1.5 m away — rapier's `castShape` does
    // not see this world's static geometry the way its ray does. The 31 mm of
    // radius the ray gives up is smaller than the 340 mm step it is protecting
    // against, so the trade is free.
    const dir = step.multiplyScalar(1 / distance);
    this.filterThrow.excludeEntity = undefined;
    if (!ctx.services.physics.raycast(g.prevPosition, dir, distance + def.radius, this.filterThrow, this.hit)) {
      return;
    }
    // Did it end up BEHIND the surface it swept through? That is the whole test,
    // and it has to be a side-of-plane test rather than "did the sweep hit
    // something": rapier resolving the contact itself ALSO leaves a sweep hit
    // along the way, and a distance-based discriminator either fires on every
    // legitimate bounce or misses a pass-through that happened late in the tick.
    // Half a radius of slack keeps the guard off the solver's own resting
    // penetration.
    const behind = this.tmpB.copy(g.position).sub(this.hit.point).dot(this.hit.normal);
    if (behind > -def.radius * 0.5) return;

    const contact = this.tmpB.copy(this.hit.point).addScaledVector(this.hit.normal, def.radius * 1.05);
    const velocity = this.tmpD.copy(dir).multiplyScalar(distance / ctx.dt);
    // Reflect: reverse the normal component and scale it by restitution, then
    // shave the tangential component the way friction against a face does.
    const along = velocity.dot(this.hit.normal);
    velocity.addScaledVector(this.hit.normal, -(1 + def.restitution) * along);
    velocity.multiplyScalar(1 - def.friction * 0.5);

    // The body is REPLACED rather than teleported: `PhysicsService` exposes no
    // way to set a dynamic body's transform or velocity (`setKinematicTarget` is
    // kinematic-only, by design), and adding one is PHYS's call, not this
    // lane's. Replacement is deterministic — driven by the grenade's own spawn
    // key and the tick — and happens at most a handful of times per throw,
    // because the reflected speed is almost always below the guard threshold.
    ctx.services.physics.destroyBody(g.body);
    g.body = ctx.services.physics.createBody(this.bodyDesc(contact));
    ctx.services.physics.applyImpulse(g.body, velocity.multiplyScalar(def.massKg));
    g.position.copy(contact);
    this.counters.tunnelsCaught++;
  }

  /** The one description of a grenade body. Shared by the throw and the guard. */
  private bodyDesc(position: Vec3): BodyDesc {
    const def = this.def;
    return {
      mode: 'dynamic',
      entity: NULL_ENTITY,
      position,
      shapes: [{ kind: 'sphere', radius: def.radius }],
      surface: def.surface,
      group: CollisionGroup.Projectile,
      // LAYER_SOLID and not LAYER_SHOOTABLE: a grenade bounces off the world,
      // not off people. Colliding with character capsules makes a throw past a
      // squadmate's shoulder rebound into your own feet, and it is the reason
      // every shipped shooter's grenades pass through friendlies.
      collidesWith: LAYER_SOLID,
      massKg: def.massKg,
      restitution: def.restitution,
      friction: def.friction,
      linearDamping: def.linearDamping,
      angularDamping: def.angularDamping,
      // Kept on even though `tunnelGuard` is what actually saves the fast leg:
      // it costs nothing, and it is the correct declaration of intent for the
      // day rapier's own CCD starts working on a shape this small.
      ccd: true,
      canSleep: true,
    };
  }

  /* ================================================================== throw */

  private release(carrier: Carrier, cookSeconds: number, ctx: TickCtx): void {
    carrier.cooking = false;
    const def = this.def;
    const services = ctx.services;

    const slot = this.allocate();
    if (slot < 0) {
      // Nothing left to throw it into. The unit stays in the pouch: silently
      // consuming stock the player never got to use is worse than a dud press.
      this.counters.refusedPool++;
      carrier.readyTick = ctx.tick + Math.round(def.refractorySeconds * Sim.TICK_HZ);
      return;
    }

    carrier.count = Math.max(0, carrier.count - 1);
    carrier.readyTick = ctx.tick + Math.round(def.refractorySeconds * Sim.TICK_HZ);
    carrier.live++;

    /* --- where it comes from and where it is going --------------------- */
    // The aim basis AFTER aimPunch, the SAME one bullets use. A grenade that
    // ignored recoil would leave the hand somewhere the crosshair is not.
    services.weapons.aimBasis(carrier.entity, this.tmpA, this.tmpDir);
    this.tmpDir.normalize();

    // Loft: rotate the aim axis UP about the horizontal right vector. Near
    // vertical the cross product degenerates, so fall back to world +X.
    //
    // THE SIGN IS +, AND IT WAS WRONG THE FIRST TIME. `right = forward x up` is
    // +X for a forward of -Z, and a POSITIVE rotation about +X takes -Z toward
    // +Y — i.e. up. A negative one threw every grenade 14 degrees into the
    // ground, which read as "the throw is too flat" rather than as a sign error
    // because the arc still looked like an arc.
    this.tmpRight.copy(this.tmpDir).cross(this.up);
    if (this.tmpRight.lengthSq() < 1e-6) this.tmpRight.set(1, 0, 0);
    this.tmpRight.normalize();
    const launch = this.tmpB
      .copy(this.tmpDir)
      .applyAxisAngle(this.tmpRight, def.launchLoftDeg * DEG2RAD)
      .normalize();

    // Spawn a hand's length in front of the eye, dropped to chest height. Swept
    // first: throwing with your back against a wall must not spawn the body
    // inside it, where rapier resolves the overlap by launching it through.
    const spawn = this.tmpC
      .copy(this.tmpA)
      .addScaledVector(this.tmpDir, def.muzzleForward)
      .addScaledVector(this.up, -def.muzzleDrop);
    const reach = spawn.distanceTo(this.tmpA);
    if (reach > 1e-4) {
      const toSpawn = this.tmpD.copy(spawn).sub(this.tmpA).multiplyScalar(1 / reach);
      this.filterThrow.excludeEntity = carrier.entity;
      if (services.physics.sphereCast(this.tmpA, toSpawn, def.radius, reach, this.filterThrow, this.hit)) {
        spawn.copy(this.hit.point).addScaledVector(toSpawn, -def.radius * 1.5);
      }
    }

    const power =
      def.minPower + (1 - def.minPower) * clamp01(cookSeconds / Math.max(1e-3, def.chargeSeconds));
    const speed = def.throwSpeed * power;
    const velocity = new THREE.Vector3().copy(launch).multiplyScalar(speed);
    const state = services.player.stateOf(carrier.entity);
    if (state) velocity.addScaledVector(state.velocity, def.inheritVelocity);

    /* --- the body ------------------------------------------------------ */
    const g = this.pool[slot]!;
    g.key = this.nextKey++;
    g.owner = carrier.entity;
    g.team = services.mode.teamOf(carrier.entity);
    g.position.copy(spawn);
    g.prevPosition.copy(spawn);
    g.rotation.set(0, 0, 0, 1);
    g.prevRotation.set(0, 0, 0, 1);
    // The fuse started at the PIN, not here. Cooking is therefore a real choice
    // and not a wind-up: a 2 s cook lands with 1.4 s left on it.
    g.detonateAtTick = carrier.pinTick + Math.round(def.fuseSeconds * Sim.TICK_HZ);
    g.origin.copy(spawn);
    g.restingTicks = 0;
    g.active = true;

    g.body = services.physics.createBody(this.bodyDesc(spawn));

    // Applied OFF-CENTRE, at the top of the shell, which is what makes it
    // tumble. `applyImpulseAtPoint` adds the full linear impulse AND the torque
    // about the centre of mass, so this costs nothing in range.
    const impulse = velocity.clone().multiplyScalar(def.massKg);
    const atPoint = new THREE.Vector3()
      .copy(spawn)
      .addScaledVector(this.up, def.radius * 0.75)
      .addScaledVector(this.tmpRight, def.radius * 0.35);
    services.physics.applyImpulse(g.body, impulse, atPoint);

    this.counters.thrown++;
    this.counters.lastThrow = {
      origin: [spawn.x, spawn.y, spawn.z],
      velocity: [velocity.x, velocity.y, velocity.z],
      speed: velocity.length(),
      cook: cookSeconds,
      fuseTicks: g.detonateAtTick - ctx.tick,
    };
  }

  /* =============================================================== detonate */

  private detonate(g: Grenade, ctx: TickCtx): void {
    const def = this.def;
    const services = ctx.services;
    const physics = services.physics;

    // Lift the origin off the resting shell before anything queries from it.
    // See note 2 in the file header — this is the difference between a working
    // grenade and one that silently damages nobody.
    const burst = new THREE.Vector3().copy(g.position).addScaledVector(this.up, def.burstHeight);
    const owner = g.owner;
    const team = g.team;

    // Whatever it is lying on, for the ejecta colour and the noise cue.
    let ground = SurfaceId.Concrete;
    const groundNormal = new THREE.Vector3(0, 1, 0);
    if (physics.raycast(burst, this.down, def.burstHeight + 1.2, this.filterSolid, this.hit)) {
      ground = this.hit.surface;
      groundNormal.copy(this.hit.normal);
    }

    // Retire BEFORE the consequences: `applyRadialImpulse` walks every dynamic
    // body in range and the grenade's own is still one of them for as long as it
    // exists, so a burst would shove the corpse of the thing that caused it.
    this.retire(g);

    /* --- presentation, entirely through the buses ---------------------- */
    // `FxEventMap['explosion']` is the ONE event that drives the fireball, the
    // scorch decal, the near/far report, the hearing duck AND — through
    // `src/vfx/library.ts`'s `sink.emitter` -> `LightingService.flash()` — the
    // clustered local light that puts the burst on the surrounding geometry.
    // `radius` and `energyJ` are `VfxId 'explosion.large'`'s own arguments (12 m,
    // 900 kJ), so a thrown frag produces the identical recipe the VFX lane's
    // `vfx_explosion` hero shot captures.
    ctx.fx.emit('explosion', {
      point: burst.clone(),
      radius: def.vfxRadius,
      energyJ: def.vfxEnergyJ,
      source: owner,
    });
    ctx.fx.emit('debrisBurst', {
      point: g.position.clone(),
      normal: groundNormal.clone(),
      surface: ground,
      count: def.debrisCount,
    });
    const localState = services.player.state;
    const listener = this.tmpA.set(
      localState.position.x,
      localState.position.y + localState.eyeHeight,
      localState.position.z,
    );
    const shakeFalloff = 1 - clamp01(listener.distanceTo(burst) / (def.damageRadius * 2.5));
    if (shakeFalloff > 0) {
      ctx.fx.emit('cameraShake', {
        trauma: def.shakeTrauma * shakeFalloff * shakeFalloff,
        frequencyHz: def.shakeHz,
      });
    }
    ctx.sim.emit('noise.emitted', {
      position: burst.clone(),
      loudnessDb: def.loudnessDb,
      team,
      source: owner,
      kind: 'explosion',
    });
    this.counters.detonated++;
    this.counters.explosionsEmitted++;
    this.counters.lastFlightDistance = g.origin.distanceTo(g.position);
    this.counters.lastRestingTicks = g.restingTicks;
    this.counters.lastSpeedAtBurst = g.position.distanceTo(g.prevPosition) / ctx.dt;
    this.counters.lastBurst = [burst.x, burst.y, burst.z];
    this.lightSampleTick = ctx.tick + 2;

    /* --- loose bodies --------------------------------------------------- */
    physics.applyRadialImpulse(burst, def.damageRadius, def.impulseNs, IMPULSE_GROUPS);

    /* --- soldiers ------------------------------------------------------- */
    this.damageSoldiers(burst, owner, ctx);

    /* --- cover ---------------------------------------------------------- */
    this.breachCover(burst, owner, ground, ctx);
  }

  /**
   * Radial damage to every entity under locomotion control, with falloff and
   * line-of-sight occlusion.
   *
   * Iterating `PlayerService.controlled` rather than `overlapSphere` is
   * deliberate: `controlled` is the authoritative, dense, attach-ordered list of
   * everything that has a body and a health pool, whereas a character capsule's
   * overlap depends on which of AI's per-zone hitbox bodies happen to be inside
   * the sphere, which would double-count a soldier whose arm and torso both
   * qualify. Twenty-five distance tests is nothing.
   */
  private damageSoldiers(burst: Vec3, owner: EntityId, ctx: TickCtx): void {
    const def = this.def;
    const services = ctx.services;
    const span = Math.max(1e-3, def.damageRadius - def.lethalRadius);

    for (const entity of services.player.controlled) {
      const state = services.player.stateOf(entity);
      if (!state || !state.alive) continue;

      // Centre of mass, not the feet: a grenade on the far side of a low wall
      // should be blocked, and one at the same level should not.
      const centre = this.tmpB.set(
        state.position.x,
        state.position.y + state.eyeHeight * 0.58,
        state.position.z,
      );
      const distance = centre.distanceTo(burst);
      if (distance > def.damageRadius) continue;

      // Solid geometry returns 0 outright; foliage and tarps attenuate. This is
      // the whole of "do not damage through walls".
      const visibility = services.physics.visibility(burst, centre, LAYER_SOLID);
      if (visibility <= 0.02) {
        this.counters.soldiersOccluded++;
        continue;
      }

      const t = clamp01((distance - def.lethalRadius) / span);
      const falloff = Math.pow(1 - t, def.falloffExponent);
      const amount = def.peakDamage * falloff * visibility;
      if (amount <= 0.5) continue;

      const direction = this.tmpC.copy(centre).sub(burst);
      if (direction.lengthSq() < 1e-8) direction.copy(this.up);
      direction.normalize();

      ctx.sim.emit('damage.applied', {
        target: entity,
        attacker: owner,
        amount,
        kind: DamageKind.Explosion,
        // Explosions have no hit zone. `HitZone.None` keeps the headshot flag
        // off the killfeed, which is what it means: nobody headshots with a frag.
        zone: HitZone.None,
        point: burst.clone(),
        normal: direction.clone().multiplyScalar(-1),
        // Attacker -> victim, which is what drives the directional damage
        // indicator. For a blast that is the blast, not the thrower.
        direction: direction.clone(),
        surface: SurfaceId.Kevlar,
        weapon: null,
        energyJ: def.energyJ * falloff,
        penetrated: false,
      });
      this.counters.soldiersDamaged++;
      this.counters.damageDealt += amount;
    }
  }

  /**
   * `DestructionService.applyDamage()` against every destructible whose collider
   * overlaps the breach sphere.
   *
   * No line-of-sight test here, and no distance falloff, because the overlap IS
   * both: a collider only appears in this list if its geometry is physically
   * inside a 3.5 m ball centred on the burst, which is a far stricter test than
   * a ray to a centroid we do not have. Non-destructible geometry comes back in
   * the same list and `applyDamage` returns `destroyed: false` for it, so no
   * filtering is needed on this side.
   */
  private breachCover(burst: Vec3, owner: EntityId, ground: SurfaceId, ctx: TickCtx): void {
    const def = this.def;
    const destruction = ctx.services.destruction;
    const count = ctx.services.physics.overlapSphere(
      burst,
      def.breachRadius,
      this.filterStructure,
      this.overlap,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.overlap[i]!;
      if (entity === NULL_ENTITY) continue;
      const result = destruction.applyDamage({
        target: entity,
        attacker: owner,
        amount: def.structureDamage,
        // THE load-bearing field. `DestructionService.applyDamage` multiplies by
        // the material's `explosiveMultiplier` only for `DamageKind.Explosion`,
        // and bypasses `chipThreshold` only for an explosion. Send `Bullet` here
        // and a grenade chips masonry it should be removing.
        kind: DamageKind.Explosion,
        zone: HitZone.None,
        point: burst.clone(),
        normal: this.up.clone(),
        direction: this.down.clone(),
        surface: ground,
        weapon: null,
        energyJ: def.energyJ,
        penetrated: false,
      });
      this.counters.destructiblesInBlast++;
      this.counters.chunksSpawned += result.chunksSpawned;
      if (result.destroyed) this.counters.destructiblesDestroyed++;
      if (result.coverLost) this.counters.coverLost++;
    }
  }

  /* ================================================================== pool */

  private allocate(): number {
    for (let i = 0; i < POOL; i++) {
      if (!this.pool[i]!.active) return i;
    }
    return -1;
  }

  private retire(g: Grenade): void {
    if (!g.active) return;
    g.active = false;
    this.ctx.services.physics.destroyBody(g.body);
    const carrier = this.carriers.get(g.owner as number);
    if (carrier) carrier.live = Math.max(0, carrier.live - 1);
    if (g.meshSlot >= 0) {
      const bounds = this.meshBounds[g.meshSlot];
      if (bounds) park(bounds);
      g.meshSlot = -1;
    }
    // NOT counted as a detonation: `retire` also runs for a grenade that fell
    // out of the world or lost its body to a reset, and conflating the two would
    // let the probe report a burst that never happened. `detonate` counts.
  }

  private carrier(entity: EntityId): Carrier {
    let carrier = this.carriers.get(entity as number);
    if (!carrier) {
      carrier = {
        entity,
        count: this.def.capacity,
        cooking: false,
        pinTick: 0,
        readyTick: 0,
        live: 0,
        wasAlive: false,
      };
      this.carriers.set(entity as number, carrier);
    }
    return carrier;
  }

  /* ================================================================ render */

  /**
   * Transform sync, at `RenderStage.Animation` — the stage for "anything that
   * moves a vertex". Reads the tick-rate transform the simulation already
   * latched and interpolates it by `FrameCtx.alpha`; it never queries physics,
   * because presentation reading the sim mid-frame is how a frame ends up half a
   * tick ahead of the depth prepass and ghosts.
   */
  updateVisuals(ctx: FrameCtx): void {
    const meshes = this.ensureMeshes(ctx.services);
    if (meshes === null) return;
    const alpha = clamp(ctx.alpha, 0, 1);

    // Park every slot first, then un-park the live ones. Rewriting all sixteen
    // boxes is sixteen `set()` calls a frame and it means a slot can never be
    // left showing last life's grenade because of an early `continue`.
    for (let i = 0; i < this.meshBounds.length; i++) park(this.meshBounds[i]!);

    for (let i = 0; i < POOL; i++) {
      const g = this.pool[i]!;
      if (!g.active) continue;
      if (g.meshSlot < 0) {
        const slot = this.claimMesh();
        if (slot < 0) continue;
        g.meshSlot = slot;
      }
      const mesh = meshes[g.meshSlot]!;
      mesh.position.lerpVectors(g.prevPosition, g.position, alpha);
      mesh.quaternion.copy(g.prevRotation).slerp(g.rotation, alpha);
      mesh.updateMatrixWorld();
      const r = MESH_HALF_EXTENT;
      this.meshBounds[g.meshSlot]!.set(
        this.tmpA.set(mesh.position.x - r, mesh.position.y - r, mesh.position.z - r),
        this.tmpB.set(mesh.position.x + r, mesh.position.y + r, mesh.position.z + r),
      );
    }
  }

  /** Free mesh slot, or -1. Slots are claimed on first draw, never on throw. */
  private claimMesh(): number {
    const taken = new Set<number>();
    for (let i = 0; i < POOL; i++) {
      const g = this.pool[i]!;
      if (g.active && g.meshSlot >= 0) taken.add(g.meshSlot);
    }
    for (let i = 0; i < this.meshes.length; i++) {
      if (!taken.has(i)) return i;
    }
    return -1;
  }

  /**
   * Meshes are built on FIRST DRAW, not at construction.
   *
   * `weapons` declares `dependsOn: ['assets']` and `subsystems.ts` is frozen, so
   * a factory body that reached for `services.materials` or `services.scene`
   * would get the null one on any boot order where RCORE or CORE sorts later —
   * `addDynamic` would return normally, nothing would throw, and the grenade
   * would simply never appear. It also has to wait for the VIEWMODEL rig, whose
   * `build()` is what populates the material set this borrows.
   */
  private ensureMeshes(services: Services): THREE.Object3D[] | null {
    if (this.meshes.length > 0) return this.meshes;
    if (this.meshesFailed) return null;
    const roles = viewmodelMaterials();
    if (!roles) return null;

    const root = new THREE.Group();
    root.name = 'weapons.throwables';
    services.scene.group(SceneGroup.Props).add(root);

    const template = buildFragMesh(roles);
    for (let i = 0; i < MESH_BUDGET; i++) {
      const instance = i === 0 ? template.root : template.root.clone(true);
      // Belt and braces with the parked bounds below: the culler writes
      // `visible` from the box every frame and runs at `RenderStage.Scene`,
      // which is after this, so this only covers the single frame in which the
      // meshes are created.
      instance.visible = false;
      instance.matrixAutoUpdate = true;
      root.add(instance);
      this.meshes.push(instance);
      // Each instance registered SEPARATELY, with its own live `Box3`: the
      // culler reads the box every frame and writes `object.visible` from it,
      // which is both how a grenade gets frustum-culled and — parked below the
      // world — how a retired one stops being drawn. Registering the parent
      // group instead would give sixteen grenades one shared box and one shared
      // visibility, and `addDynamic` rewrites the layer mask of everything it
      // traverses, so the children would still all be on the same layer anyway.
      const bounds = new THREE.Box3();
      park(bounds);
      this.meshBounds.push(bounds);
      services.scene.addDynamic(instance, RenderLayer.WorldOpaque, bounds);
    }
    if (this.meshes.length === 0) this.meshesFailed = true;
    return this.meshes;
  }

  /* ================================================================= reset */

  /**
   * Harness reset, at the top of EVERY capture. A grenade left in flight from
   * the previous shot is an order-dependent screenshot, and a pouch left at zero
   * is a HUD readout that depends on capture order.
   */
  reset(): void {
    for (let i = 0; i < POOL; i++) {
      const g = this.pool[i]!;
      if (g.active) this.retire(g);
    }
    for (const carrier of this.carriers.values()) {
      carrier.count = this.def.capacity;
      carrier.cooking = false;
      carrier.pinTick = 0;
      carrier.readyTick = 0;
      carrier.live = 0;
      carrier.wasAlive = false;
    }
    for (const bounds of this.meshBounds) park(bounds);
    this.nextKey = 1;
    this.lightSampleTick = -1;
    resetCounters(this.counters);
  }
}

function freshCounters(): Counters {
  return {
    thrown: 0,
    detonated: 0,
    refusedEmpty: 0,
    refusedPool: 0,
    explosionsEmitted: 0,
    soldiersDamaged: 0,
    soldiersOccluded: 0,
    damageDealt: 0,
    destructiblesInBlast: 0,
    destructiblesDestroyed: 0,
    chunksSpawned: 0,
    coverLost: 0,
    tunnelsCaught: 0,
    lightsAfterBurst: 0,
    lastBurst: null,
    lastThrow: null,
    lastFlightDistance: 0,
    lastRestingTicks: 0,
    lastSpeedAtBurst: 0,
  };
}

function resetCounters(c: Counters): void {
  Object.assign(c, freshCounters());
}

/* ============================================================ lane exports == */

let instance: Throwables | null = null;

/**
 * Constructed from `createWeaponService`, not from its own descriptor:
 * `src/bootstrap/subsystems.ts` is frozen at 23 descriptors and cannot grow a
 * 24th, so a lane that needs a second system registers it from the factory it
 * already owns. Both hooks are `ctx.addTick`/`ctx.addRender`, which is exactly
 * what a descriptor would have done.
 */
export function installThrowables(ctx: BootContext): Throwables {
  const system = new Throwables(ctx);
  ctx.addTick(system);
  ctx.addRender({
    name: 'weapons.throwables.visuals',
    stage: RenderStage.Animation,
    order: 10,
    update: (frame) => system.updateVisuals(frame),
  });
  instance = system;
  return system;
}

export function throwablesInstance(): Throwables | null {
  return instance;
}

export function resetThrowables(): void {
  instance?.reset();
}

/* ------------------------------------------------------------------ probe -- */

/**
 * LANE-PRIVATE DIAGNOSTIC PROBE. Not gameplay, not the contract, not read by
 * anything in `src/`.
 *
 * It exists for one reason: the two instruments this repo has cannot see this
 * feature. `tools/shoot.sh` photographs a frame and is structurally blind to
 * behaviour (HANDOFF §2.2), and `tools/soak.sh` — which is CORE's file and which
 * this lane may not edit — counts `damage.applied` and `entity.killed` but has
 * no notion of a throwable. Without a readable counter, "pressing G throws a
 * grenade that detonates, damages and breaches cover" can only be ASSERTED, and
 * asserting it is the exact failure mode this whole task was queued to correct.
 *
 * Same shape and same rationale as CORE's `globalThis.__SOAK__`: a headless
 * driver presses a real `KeyG` on the page, steps the game, and reads back
 * numbers. `restock()` refills the local player so a proof run can throw more
 * than the two units a soldier carries — it refills stock and nothing else, so
 * every throw it enables is a real throw through the real state machine.
 */
export interface ThrowableProbe {
  readonly available: true;
  stats(): Counters & { pooled: number; live: number };
  local(): Readonly<ThrowableState> | null;
  restock(): number;
  reset(): void;
  /**
   * Is there a world for a grenade to land on?
   *
   * A thrown object that never stops moving is either badly tuned or standing in
   * a level with no collision, and those two have completely different owners.
   * This answers it in one call: `physicsReady` is `PhysicsService.ready`, which
   * `src/physics/system.ts` clears when the terrain heightfield fails its
   * row/column verification probe, and `groundBelow` is a real downward raycast
   * from the local player's eye.
   */
  world(): {
    physicsReady: boolean;
    bodies: number;
    eye: [number, number, number];
    groundBelow: number;
    groundSurface: number;
    aim: [number, number, number];
    /** Registered destructibles whose collider is within 24 m of the player. */
    destructiblesNear: number;
    /**
     * A world point a breach-radius sphere around which contains destructible
     * cover — i.e. somewhere worth throwing at. Nearest ring first, null when
     * there is nothing breakable in range.
     */
    coverTarget: [number, number, number] | null;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __THROWABLES__: ThrowableProbe | undefined;
}

export function installThrowableProbe(system: Throwables, services: () => Services): void {
  globalThis.__THROWABLES__ = {
    available: true,
    stats: () => ({ ...system.counters, pooled: system.poolSize, live: system.liveCount }),
    local: () => system.throwableOf(services().player.localEntity),
    restock: () => system.restock(services().player.localEntity),
    reset: () => system.reset(),
    world: () => system.worldProbe(),
  };
}
