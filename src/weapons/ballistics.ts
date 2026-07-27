/**
 * BallisticsService — real projectiles, not hitscan. WEAPONS owns this file.
 *
 * Projectiles are POOLED ENTRIES IN FIXED-SIZE TYPED ARRAYS, integrated at tick
 * rate and swept with a shape cast. Never rapier dynamic bodies: at 650 rpm ×
 * 24 bots that is 260 body insertions a second, and rapier's determinism is
 * only guaranteed for identical INSERTION ORDER — which a body-per-bullet
 * design cannot promise. The pool also gives us CCD for free, because the sweep
 * is explicit rather than a solver setting.
 *
 * THE FLIGHT MODEL
 *   dv/dt = −k·|v|·v  +  g
 * `k` comes from `BallisticsDef.dragCoefficient`, which `defs/shared.ts` solves
 * from a retained-velocity figure. At 5.56 numbers that is ~0.34 s and ~1.1 m
 * of drop to 300 m, which is what makes leading and holdover real mechanics
 * rather than decoration.
 *
 * WHERE A BULLET STARTS. From the CAMERA, so the crosshair never lies, then
 * blended to the true muzzle over the first `MUZZLE_BLEND_M` metres. Starting
 * at the muzzle makes a shot taken past the corner of a wall hit the wall;
 * starting at the eye makes the tracer come out of the player's face. Every
 * shipped shooter does this and every one of them does it silently.
 */
import * as THREE from 'three';
import {
  LAYER_SHOOTABLE,
  Sim,
  TickPhase,
  type AssetRegistry,
  type BallisticsService,
  type BootContext,
  type DamageInfo,
  type EntityId,
  type ImpactEvent,
  type QualitySettings,
  type QueryFilter,
  type RayHit,
  type Services,
  type ShotRequest,
  type TickCtx,
  type TickSystem,
  type Vec3,
  type WeaponId,
} from '@/engine/types';
import { DamageKind, HitZone } from '@/engine/types';
import { bulletDamage, muzzleEnergyJ } from '@/weapons/damage';
import { makeHit, resolvePenetration, type PenetrationOutcome } from '@/weapons/penetration';
import { structuralDamage } from '@/weapons/structure';
import { armWeaponsProving, tickWeaponsProving } from '@/weapons/proving';

/** Hard ceiling on rounds in flight. 384 covers 24 shooters at full rate. */
const POOL = 384;
/** Metres over which the visual origin slides from the eye to the muzzle. */
const MUZZLE_BLEND_M = 3.2;
/** Sweep radius. Small enough to fit through a window, big enough not to tunnel. */
const SWEEP_RADIUS = 0.012;
/** A round is supersonic — and therefore cracks as it passes — above this. */
const SUPERSONIC = Sim.SPEED_OF_SOUND;
/** Whizbys inside this radius of the listener are reported. */
const WHIZBY_RADIUS = 4.0;

class IronBallistics implements BallisticsService, TickSystem {
  readonly name = 'weapons.ballistics';
  readonly phase = TickPhase.Ballistics;
  readonly order = 0;

  /* Structure-of-arrays, because this is the one gameplay loop in the lane
   * that runs hundreds of times per tick. */
  private readonly alive = new Uint8Array(POOL);
  private readonly px = new Float32Array(POOL);
  private readonly py = new Float32Array(POOL);
  private readonly pz = new Float32Array(POOL);
  private readonly vx = new Float32Array(POOL);
  private readonly vy = new Float32Array(POOL);
  private readonly vz = new Float32Array(POOL);
  /** Eye→muzzle correction still to be paid off, in metres. */
  private readonly ox = new Float32Array(POOL);
  private readonly oy = new Float32Array(POOL);
  private readonly oz = new Float32Array(POOL);
  private readonly travelled = new Float32Array(POOL);
  private readonly energy = new Float32Array(POOL);
  private readonly shooter = new Int32Array(POOL);
  private readonly team = new Int32Array(POOL);
  private readonly weaponIndex = new Int32Array(POOL);
  private readonly penetrations = new Int32Array(POOL);
  private nextSlot = 0;
  private liveCount = 0;

  /** WeaponId is a string union; the pool stores an index into this. */
  private readonly weaponIds: WeaponId[] = [];

  private readonly hit: RayHit = makeHit();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpFrom = new THREE.Vector3();
  private readonly tmpTo = new THREE.Vector3();
  private readonly whizbyPoint = new THREE.Vector3();
  private whizbyDistance = -1;
  /**
   * Reused across every projectile sweep this tick — one allocation, not one per
   * bullet per frame. `excludeEntity` is rewritten per shot so a round cannot hit
   * the rifle that fired it, which means the local view must be mutable even
   * though the contract hands it out readonly.
   */
  private readonly filter: { -readonly [K in keyof QueryFilter]: QueryFilter[K] } = {
    groups: LAYER_SHOOTABLE,
    solid: true,
  };

  /** Not `private`: the lane's reset hook reaches `services` through it. */
  constructor(readonly ctx: BootContext) {}

  private get services(): Services {
    return this.ctx.services;
  }

  /* ------------------------------------------------------------------ fire -- */

  fire(request: ShotRequest, ctx: TickCtx): number {
    const def = this.services.weapons.def(request.weapon).ballistics;
    const spreadRad = (request.spreadDeg * Math.PI) / 180;
    const e0 = muzzleEnergyJ(def);
    let spawned = 0;

    for (let pellet = 0; pellet < Math.max(1, request.pellets); pellet++) {
      const slot = this.allocate();
      if (slot < 0) break;

      // Cone sampling from the SHOT SEED, not from an RNG stream: the contract
      // says a shot must be reproducible in isolation, and a stream would make
      // this pellet depend on how many rounds everyone else had fired.
      const s0 = hash2(request.seed, pellet * 2 + 1);
      const s1 = hash2(request.seed, pellet * 2 + 2);
      // Uniform inside the cone: sqrt on the radius, or the middle is denser
      // than the edge and every weapon shoots tighter than its stated cone.
      const r = Math.sqrt(s0) * Math.tan(spreadRad);
      const phi = s1 * Math.PI * 2;
      this.tmpDir.copy(request.direction).normalize();
      basisFrom(this.tmpDir, this.tmpA, this.tmpB);
      this.tmpDir
        .addScaledVector(this.tmpA, Math.cos(phi) * r)
        .addScaledVector(this.tmpB, Math.sin(phi) * r)
        .normalize();

      this.px[slot] = request.origin.x;
      this.py[slot] = request.origin.y;
      this.pz[slot] = request.origin.z;
      this.vx[slot] = this.tmpDir.x * def.muzzleVelocity;
      this.vy[slot] = this.tmpDir.y * def.muzzleVelocity;
      this.vz[slot] = this.tmpDir.z * def.muzzleVelocity;
      this.ox[slot] = request.muzzle.x - request.origin.x;
      this.oy[slot] = request.muzzle.y - request.origin.y;
      this.oz[slot] = request.muzzle.z - request.origin.z;
      this.travelled[slot] = 0;
      this.energy[slot] = e0;
      this.shooter[slot] = request.shooter as number;
      this.team[slot] = request.team;
      this.weaponIndex[slot] = this.weaponSlot(request.weapon);
      this.penetrations[slot] = 0;
      spawned++;

      // One tracer event per tracer ROUND, not per frame: VFX owns the ribbon
      // and needs to know where it will end and how long it has to get there.
      if (request.tracer && pellet === 0) {
        this.tmpTo.copy(request.muzzle);
        const range = this.predictImpact(request.origin, this.tmpDir, request.weapon, this.tmpTo)
          ? request.muzzle.distanceTo(this.tmpTo)
          : def.maxRange;
        ctx.fx.emit('tracer', {
          from: request.muzzle.clone(),
          to: this.tmpTo.clone(),
          weapon: request.weapon,
          travelTime: range / def.muzzleVelocity,
          visible: true,
        });
      }
    }
    return spawned;
  }

  /* ------------------------------------------------------------------ tick -- */

  tick(ctx: TickCtx): void {
    const dt = ctx.dt;
    const physics = ctx.services.physics;
    const listener = ctx.services.player.state;
    const listenerX = listener.position.x;
    const listenerY = listener.position.y + listener.eyeHeight;
    const listenerZ = listener.position.z;
    this.whizbyDistance = -1;

    for (let i = 0; i < POOL; i++) {
      if (this.alive[i] === 0) continue;
      const weapon = this.weaponIds[this.weaponIndex[i]!]!;
      const def = ctx.services.weapons.def(weapon).ballistics;

      /* --- integrate ---------------------------------------------------- */
      let vx = this.vx[i]!;
      let vy = this.vy[i]!;
      let vz = this.vz[i]!;
      const speed = Math.hypot(vx, vy, vz);
      // a = −k·|v|·v gives |a| = k·v², the standard quadratic drag law.
      const drag = def.dragCoefficient * speed;
      vx -= vx * drag * dt;
      vy -= vy * drag * dt + Sim.GRAVITY * def.gravityScale * dt;
      vz -= vz * drag * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      const step = Math.hypot(vx, vy, vz) * dt;
      const fromBlend = this.blend(i);
      this.tmpFrom.set(this.px[i]! + this.ox[i]! * fromBlend, this.py[i]! + this.oy[i]! * fromBlend, this.pz[i]! + this.oz[i]! * fromBlend);

      this.px[i] = this.px[i]! + vx * dt;
      this.py[i] = this.py[i]! + vy * dt;
      this.pz[i] = this.pz[i]! + vz * dt;
      this.travelled[i] = this.travelled[i]! + step;
      this.energy[i] = 0.5 * def.massKg * Math.hypot(vx, vy, vz) ** 2;

      const toBlend = this.blend(i);
      this.tmpTo.set(this.px[i]! + this.ox[i]! * toBlend, this.py[i]! + this.oy[i]! * toBlend, this.pz[i]! + this.oz[i]! * toBlend);

      /* --- whizby ------------------------------------------------------- */
      // Closest approach of the segment to the listener, not the endpoint
      // distance: at 880 m/s a round covers 14 m in a tick and would otherwise
      // "miss" a listener it passed straight through.
      const miss = segmentPointDistance(this.tmpFrom, this.tmpTo, listenerX, listenerY, listenerZ, this.tmpA);
      if (miss < WHIZBY_RADIUS && this.shooter[i] !== (listener.entity as number)) {
        if (this.whizbyDistance < 0 || miss < this.whizbyDistance) {
          this.whizbyDistance = miss;
          this.whizbyPoint.copy(this.tmpA);
        }
        ctx.fx.emit('whizby', {
          point: this.tmpA.clone(),
          missDistance: miss,
          supersonic: Math.hypot(vx, vy, vz) > SUPERSONIC,
        });
      }

      /* --- sweep -------------------------------------------------------- */
      this.tmpDir.copy(this.tmpTo).sub(this.tmpFrom);
      const segLength = this.tmpDir.length();
      if (segLength > 1e-6) {
        this.tmpDir.multiplyScalar(1 / segLength);
        this.filter.excludeEntity = this.shooter[i] as EntityId;
        if (physics.sphereCast(this.tmpFrom, this.tmpDir, SWEEP_RADIUS, segLength, this.filter, this.hit)) {
          this.onHit(i, ctx, weapon, def, this.tmpDir, this.hit);
          continue;
        }
      }

      /* --- retire ------------------------------------------------------- */
      if (this.travelled[i]! > def.maxRange || this.py[i]! < -80) this.kill(i);
    }
  }

  /** 0 at the muzzle-corrected start, 1 once the eye/muzzle offset is paid off. */
  private blend(i: number): number {
    const t = this.travelled[i]! / MUZZLE_BLEND_M;
    return t >= 1 ? 0 : 1 - t;
  }

  private onHit(
    i: number,
    ctx: TickCtx,
    weapon: WeaponId,
    def: Readonly<{ penetrationEnergy: number; maxPenetrations: number; massKg: number; muzzleVelocity: number }>,
    direction: Vec3,
    hit: RayHit,
  ): void {
    const shooterId = this.shooter[i] as EntityId;
    const full = this.services.weapons.def(weapon).ballistics;
    const energyFraction = Math.max(0, Math.min(1, this.energy[i]! / muzzleEnergyJ(full)));
    const distance = this.travelled[i]!;

    const outcome = resolvePenetration(
      ctx.services.physics,
      ctx.services.materials,
      hit,
      direction,
      this.energy[i]!,
      def.penetrationEnergy,
      hit.surface,
    );

    const impact: ImpactEvent = {
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      incoming: direction.clone(),
      surface: hit.surface,
      energyJ: this.energy[i]!,
      shooter: shooterId,
      target: hit.entity,
      zone: hit.zone,
      weapon,
      distanceM: distance,
      penetrated: outcome.kind === 'through',
      ricochet: outcome.kind === 'ricochet',
    };
    ctx.sim.emit('projectile.impact', impact);
    ctx.fx.emit('impact', impact);
    ctx.sim.emit('noise.emitted', {
      position: hit.point.clone(),
      loudnessDb: ctx.services.materials.profile(hit.surface).impactLoudnessDb,
      team: this.team[i]!,
      source: shooterId,
      kind: 'impact',
    });

    // Everything above this line is the impact path that already worked: the
    // decal and the surface-keyed particle burst both hang off `fx.impact`, and
    // nothing below may pre-empt them. Cover damage is strictly ADDITIVE to it.
    if (hit.entity !== (0 as EntityId)) {
      // Only two kinds of thing carry an entity id into a ray hit: a soldier,
      // and a destructible solid (`PhysicsService.addStatic` mints one only when
      // the collider has a `DestructibleDef`). Ask destruction first — if it
      // took the damage, this was cover and not a person, and firing the
      // soldier path as well would put a false hitmarker on the HUD for every
      // round that hits a wall.
      if (!this.damageCover(i, ctx, direction, hit, outcome, weapon, shooterId)) {
        const amount = bulletDamage(full, distance, hit.zone, energyFraction);
        if (amount > 0) {
          const info: DamageInfo = {
            target: hit.entity,
            attacker: shooterId,
            amount,
            kind: DamageKind.Bullet,
            zone: hit.zone,
            point: hit.point.clone(),
            normal: hit.normal.clone(),
            direction: direction.clone(),
            surface: hit.surface,
            weapon,
            energyJ: this.energy[i]!,
            penetrated: outcome.kind === 'through',
          };
          ctx.sim.emit('damage.applied', info);
          ctx.fx.emit('hitmarker', {
            lethal: false,
            headshot: hit.zone === HitZone.Head,
            armour: energyFraction < 0.35,
          });
        }
      }
    }

    /* --- continue, deflect or stop --------------------------------------- */
    if (outcome.kind === 'stop' || this.penetrations[i]! >= def.maxPenetrations) {
      this.kill(i);
      return;
    }
    this.penetrations[i] = this.penetrations[i]! + 1;
    // The eye/muzzle correction is long since paid off by the time anything is
    // hit, so a re-spawned round starts exactly where it came out.
    this.ox[i] = 0;
    this.oy[i] = 0;
    this.oz[i] = 0;
    this.travelled[i] = Math.max(this.travelled[i]!, MUZZLE_BLEND_M);
    this.px[i] = outcome.point.x;
    this.py[i] = outcome.point.y;
    this.pz[i] = outcome.point.z;
    // Energy → speed, so a round that spent 60% of its energy in a wall leaves
    // at √0.4 of its speed. Losing energy without losing speed would let a
    // bullet through a bank vault arrive doing full damage.
    const newSpeed = Math.sqrt((2 * outcome.energyJ) / Math.max(1e-6, def.massKg));
    this.vx[i] = outcome.direction.x * newSpeed;
    this.vy[i] = outcome.direction.y * newSpeed;
    this.vz[i] = outcome.direction.z * newSpeed;
    this.energy[i] = outcome.energyJ;
  }

  /**
   * Route one impact into `DestructionService`. THE SEAM BETWEEN A BULLET AND A
   * WALL — before this existed, `applyDamage` was called from exactly one place
   * in the repo (PHYS's own proving-ground scenario) and shooting cover in-game
   * did nothing at all.
   *
   * Returns TRUE when the thing that was hit is a destructible solid, so the
   * caller can skip the soldier path. Two kinds of body carry an entity id into
   * a ray hit — a soldier, and a destructible, because `addStatic` mints an
   * entity only for a collider with a `DestructibleDef` — and telling them apart
   * matters for more than tidiness: without it every round that hits a wall
   * pops a hitmarker, which is a lie the HUD has no way to detect.
   *
   * HOW THE TWO ARE TOLD APART, using only the public contract. Destruction
   * exposes no "is this yours" predicate, and `applyDamage` on an unregistered
   * entity is a documented no-op that returns the same shape as a survived hit.
   * But `healthFraction` returns exactly 1 for anything it has never heard of,
   * so a value that MOVED, or that already sits below 1, is proof of
   * registration. Debris chunks inherit their parent's entity id and therefore
   * read as 0 — which is the right answer: rubble is cover, not a person.
   */
  private damageCover(
    i: number,
    ctx: TickCtx,
    direction: Vec3,
    hit: RayHit,
    outcome: Readonly<PenetrationOutcome>,
    weapon: WeaponId,
    shooter: EntityId,
  ): boolean {
    // A hit zone can only come from `BodyDesc.zone`, which only AI's hitbox rigs
    // set — so a non-`None` zone is a soldier and there is nothing to ask. Worth
    // the early-out: it keeps the common case allocation-free.
    if (hit.zone !== HitZone.None) return false;

    const destruction = ctx.services.destruction;
    const target = hit.entity;
    const energyJ = this.energy[i]!;
    // The round's REAL remaining energy at this range, off the same integrator
    // that decided where it landed — not a per-weapon constant. See
    // `structure.ts` for why bore depth rather than deposited energy.
    const amount = structuralDamage(ctx.services.materials.profile(hit.surface), energyJ, outcome);
    if (amount <= 0) return destruction.healthFraction(target) < 1;

    const info: DamageInfo = {
      target,
      attacker: shooter,
      amount,
      kind: DamageKind.Bullet,
      zone: hit.zone,
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      direction: direction.clone(),
      surface: hit.surface,
      weapon,
      energyJ,
      penetrated: outcome.kind === 'through',
    };

    const before = destruction.healthFraction(target);
    const result = destruction.applyDamage(info);
    const after = destruction.healthFraction(target);
    const weakened = after < before - 1e-6;
    if (!result.destroyed && !weakened) {
      // Nothing moved. Either a soldier, or cover that is already rubble.
      return after < 1;
    }

    // The contract's own "a solid took a hit and survived" event, which until now
    // had no producer anywhere in the repo. AI reads it to know its cover is
    // going, HUD to flash the crosshair on a solid it can actually break.
    ctx.sim.emit('prop.damaged', { entity: target, healthFraction: after, info });

    // `DestructionResult` says what actually happened, and the one case it
    // reports that nobody downstream can see is a collapse that spawned NO
    // chunks — the tier's debris budget was already full. PHYS's own dust column
    // still fires, but the shards that carry the read do not, so the breach
    // would land silently. Pay for it with a burst of the right surface.
    if (result.destroyed && result.chunksSpawned === 0) {
      ctx.fx.emit('debrisBurst', {
        point: result.position,
        normal: hit.normal.clone(),
        surface: result.surface,
        count: 24,
      });
    }
    return true;
  }

  /* ---------------------------------------------------------- predictions -- */

  /**
   * Where a shot lands, by integrating the SAME model the live rounds use at a
   * coarser step. AI aim solving and the HUD range readout both call it, and
   * both would be lying if it used a straight line.
   */
  predictImpact(origin: Vec3, direction: Vec3, weapon: WeaponId, out: Vec3): boolean {
    const def = this.services.weapons.def(weapon).ballistics;
    const physics = this.services.physics;
    // 4× the tick step: the trajectory is smooth, and a prediction that costs
    // as much as the simulation is a prediction nobody can afford to call.
    const dt = Sim.TICK_DT * 4;
    let x = origin.x;
    let y = origin.y;
    let z = origin.z;
    let vx = direction.x * def.muzzleVelocity;
    let vy = direction.y * def.muzzleVelocity;
    let vz = direction.z * def.muzzleVelocity;
    let travelled = 0;
    const filter: QueryFilter = { groups: LAYER_SHOOTABLE, solid: true };

    for (let step = 0; step < 220 && travelled < def.maxRange; step++) {
      const speed = Math.hypot(vx, vy, vz);
      const drag = def.dragCoefficient * speed;
      vx -= vx * drag * dt;
      vy -= vy * drag * dt + Sim.GRAVITY * def.gravityScale * dt;
      vz -= vz * drag * dt;
      const nx = x + vx * dt;
      const ny = y + vy * dt;
      const nz = z + vz * dt;
      this.tmpFrom.set(x, y, z);
      this.tmpDir.set(nx - x, ny - y, nz - z);
      const len = this.tmpDir.length();
      if (len > 1e-6) {
        this.tmpDir.multiplyScalar(1 / len);
        if (physics.raycast(this.tmpFrom, this.tmpDir, len, filter, this.hit)) {
          out.copy(this.hit.point);
          return true;
        }
      }
      x = nx;
      y = ny;
      z = nz;
      travelled += len;
    }
    out.set(x, y, z);
    return false;
  }

  /**
   * Aim direction that hits a target moving at `velocity`.
   *
   * Three fixed-point iterations, because time of flight depends on the lead
   * and the lead depends on the time of flight. Three is enough for the residual
   * to fall below the target's own width at any range this game has.
   */
  solveLead(origin: Vec3, target: Vec3, velocity: Vec3, weapon: WeaponId, out: Vec3): boolean {
    const def = this.services.weapons.def(weapon).ballistics;
    this.tmpA.copy(target);
    let flight = 0;
    for (let i = 0; i < 3; i++) {
      const dist = origin.distanceTo(this.tmpA);
      if (dist > def.maxRange) return false;
      // Closed form of v(t) = v0/(1+k·v0·t) integrated for distance, inverted:
      // t = (e^(k·d) − 1)/(k·v0). Exact for the drag model we integrate.
      const k = Math.max(1e-9, def.dragCoefficient);
      flight = (Math.exp(k * dist) - 1) / (k * def.muzzleVelocity);
      this.tmpA.copy(target).addScaledVector(velocity, flight);
    }
    // Gravity compensation: raise the aim point by the drop over the flight.
    const drop = 0.5 * Sim.GRAVITY * def.gravityScale * flight * flight;
    this.tmpA.y += drop;
    out.copy(this.tmpA).sub(origin).normalize();
    return true;
  }

  nearestWhizby(listener: Vec3, out: Vec3): number {
    void listener;
    if (this.whizbyDistance < 0) return -1;
    out.copy(this.whizbyPoint);
    return this.whizbyDistance;
  }

  get liveProjectiles(): number {
    return this.liveCount;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.nextSlot = 0;
    this.whizbyDistance = -1;
  }

  /* --------------------------------------------------------------- pooling -- */

  private allocate(): number {
    for (let n = 0; n < POOL; n++) {
      const i = (this.nextSlot + n) % POOL;
      if (this.alive[i] === 0) {
        this.alive[i] = 1;
        this.nextSlot = (i + 1) % POOL;
        this.liveCount++;
        return i;
      }
    }
    // Pool exhausted. Dropping the round is correct and silent: the alternative
    // is stealing a live one, which makes an existing bullet vanish mid-flight.
    return -1;
  }

  private kill(i: number): void {
    if (this.alive[i] === 0) return;
    this.alive[i] = 0;
    this.liveCount--;
  }

  private weaponSlot(id: WeaponId): number {
    let i = this.weaponIds.indexOf(id);
    if (i < 0) {
      i = this.weaponIds.length;
      this.weaponIds.push(id);
    }
    return i;
  }
}

/* ---------------------------------------------------------------- helpers -- */

/** Two orthonormal vectors perpendicular to `forward`. */
function basisFrom(forward: Vec3, outA: Vec3, outB: Vec3): void {
  // Pick the world axis least aligned with `forward`, or the cross product
  // degenerates when someone shoots straight up.
  if (Math.abs(forward.y) < 0.9) outA.set(0, 1, 0);
  else outA.set(1, 0, 0);
  outA.cross(forward).normalize();
  outB.copy(forward).cross(outA).normalize();
}

/** Deterministic [0,1) from a shot seed and an index. No stream, no state. */
function hash2(seed: number, index: number): number {
  let h = (seed ^ (index * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Distance from a point to a segment, with the closest point written to `out`. */
function segmentPointDistance(a: Vec3, b: Vec3, px: number, py: number, pz: number, out: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
  return Math.hypot(out.x - px, out.y - py, out.z - pz);
}

/* ============================================================ lane exports == */

let instance: IronBallistics | null = null;

export function createBallisticsService(ctx: BootContext): BallisticsService {
  const ballistics = new IronBallistics(ctx);
  ctx.addTick(ballistics);
  // The proving ground's observer. Inert until a 'WE' seed arms it, and at
  // Cleanup so it reads the world AFTER TickPhase.Destruction has flushed.
  ctx.addTick({
    name: 'weapons.proving',
    phase: TickPhase.Cleanup,
    tick: tickWeaponsProving,
  });
  instance = ballistics;
  return ballistics;
}

/** Nothing: projectiles are pooled typed-array entries, not assets. */
export function registerBallisticsBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Intentionally empty.
}

/**
 * Harness reset chain. `BallisticsService.clear()` is also called explicitly
 * earlier in the chain; this hook covers the case where the driver reaches the
 * descriptor table without having gone through the named services.
 */
export function resetBallistics(seed: number): void {
  instance?.clear();
  // Every seed passes through here, including the harness's own 0x1205, and a
  // non-'WE' seed tears the proving ground down. See `proving.ts`.
  armWeaponsProving(seed, instance?.ctx.services ?? null);
}
