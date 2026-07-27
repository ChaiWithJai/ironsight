/**
 * The WEAPONS proving ground: a real level wall, a real magazine, and a number
 * at the end. WEAPONS owns this file.
 *
 * WHY IT EXISTS
 * -------------
 * `src/weapons/ballistics.ts` now routes bullet impacts into
 * `DestructionService.applyDamage`. The project's standing lesson is that a
 * screenshot cannot tell you whether a mechanic is REACHABLE — twelve rounds of
 * visual critics scored a destruction frame no player could cause — so the claim
 * "firing at cover breaks it" has to arrive with a measurement, not a PNG.
 *
 * This arms a scenario that picks a REAL destructible out of HARBOUR REACH (not
 * a fixture built for the occasion), stands the local player in front of it, and
 * reports what the rounds actually did: health per round, rounds to breach,
 * chunks spawned, and a before/after sightline raycast. Run it with
 *
 *     CAPTURE_VERBOSE=1 ./tools/shoot.sh ballistics_breach
 *
 * and the `[weapons.proving]` lines are the proof.
 *
 * THE SEED PROTOCOL, borrowed wholesale from `physics/scenario.ts`. A shot file
 * may pose the camera and nothing else, so a lane that needs its own simulation
 * staged reaches itself through `ShotContext.seed(n)`, which runs the reset
 * chain and ends in this lane's `reset*` hook. A seed whose high sixteen bits
 * are 0x5745 ('WE') is a scenario selector; every other seed — including the
 * 0x1205 the harness resets with before every capture — tears the staging down
 * and puts the player back, so WEAPONS' furniture can never turn up in SKY's
 * frame.
 *
 * TWO THINGS THAT COST AN ITERATION EACH, WRITTEN DOWN SO THEY COST NOBODY ELSE
 * ONE
 *
 * 1. STAGING CANNOT HAPPEN INSIDE THE RESET CHAIN. `resetBallistics` runs in
 *    boot order, and GAME's `resetPlayer` runs after it — so a player teleported
 *    from the reset hook is put back on a spawn point microseconds later, the
 *    rounds fly off across the map, and the wall is never touched. Everything
 *    below therefore ARMS during reset and STAGES on the first tick afterwards.
 *
 * 2. `DestructionService.reset()` does not just heal the level's destructibles,
 *    it CLEARS THE REGISTRATION TABLE (`byEntity.clear()`), and the only thing
 *    that ever populates it for LEVEL's cover is `PhysicsService.addStatic`
 *    during world build. The reset chain runs at the top of every capture AND at
 *    the start of every `tools/soak.sh` run, so inside either instrument every
 *    wall in the map is an ordinary static collider that no amount of shooting
 *    can hurt. LIVE PLAY NEVER RESETS, so a human at the keyboard is unaffected
 *    — but both of the project's automated instruments are structurally blind to
 *    destruction until PHYS re-registers on reset. Rather than skip the proof,
 *    the staging below re-registers its own target through the public
 *    `DestructionService.register` seam, using the entity and body handles a
 *    raycast hands back. Called out in the lane report.
 */
import * as THREE from 'three';
import {
  LAYER_SOLID,
  NULL_ENTITY,
  SurfaceId,
  type DestructibleDef,
  type EntityId,
  type QueryFilter,
  type RayHit,
  type Services,
  type StaticColliderDef,
  type TickCtx,
  type Vec3,
} from '@/engine/types';
import { makeHit } from '@/weapons/penetration';

/** 'WE' in the high sixteen bits marks a seed as a WEAPONS scenario selector. */
const SCENARIO_TAG = 0x5745;

/** Stand in front of a real level wall and empty a magazine into it. */
export const SEED_BREACH = 0x57450001;

/** Metres between the shooter and the wall. Close enough that spread cannot miss. */
const STANDOFF_M = 7.5;
/** How far past the wall the sightline probe looks. */
const SIGHTLINE_M = 8;
/** Candidates to try before giving up. */
const MAX_CANDIDATES = 96;

/**
 * Masonry-family surfaces. A COVER WALL is the thing the brief asks about, and
 * ranking a timber crate first would prove the wiring while photographing the
 * least interesting object on the map.
 */
const WALL_SURFACES: readonly SurfaceId[] = [
  SurfaceId.Sandstone,
  SurfaceId.Stucco,
  SurfaceId.Concrete,
  SurfaceId.Rubble,
  SurfaceId.Plaster,
  SurfaceId.Sandbag,
];

interface Staged {
  readonly entity: EntityId;
  readonly def: DestructibleDef;
  /** LEVEL's authored collider for the target, so teardown can put it back. */
  readonly collider: StaticColliderDef;
  /** Eye position of the shooter, for the sightline probe. */
  readonly eye: THREE.Vector3;
  readonly aim: THREE.Vector3;
  /** Metres from the eye to the intact wall's face, for the sightline compare. */
  readonly range: number;
  readonly startedTick: number;
  lastFraction: number;
  hits: number;
  breached: boolean;
}

interface Restore {
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
}

/** Set by the reset hook; consumed by the first tick afterwards. See note 1. */
let pending = false;
let staged: Staged | null = null;
let restore: Restore | null = null;

const probe: RayHit = makeHit();
const SOLID: QueryFilter = { groups: LAYER_SOLID, solid: true };

/* ------------------------------------------------------------------- arming */

export function armWeaponsProving(seed: number, services: Services | null): void {
  teardownWeaponsProving(services);
  if (!services) return;
  if ((seed >>> 16) !== SCENARIO_TAG) return;
  pending = seed === SEED_BREACH;
}

export function teardownWeaponsProving(services: Services | null): void {
  // `staged.breached`, NOT `destruction.isIntact` — the reset chain calls
  // `destruction.reset()` before it reaches this lane's hook, and reset clears
  // the registration table, so by the time we get here the service has never
  // heard of the entity and cheerfully reports it intact.
  if (services && staged?.breached) {
    // PUT THE WALL BACK. `DestructionService.reset()` restores health and
    // visibility but cannot undo `PhysicsService.destroyBody`, so a breached
    // LEVEL wall is gone from the collision world for the whole rest of the
    // session — and `tools/shoot.sh` captures 48 shots in ONE session. Without
    // this, running the sweep would quietly delete a wall out from under
    // whichever lane's frame it stands in, and the resulting diff would look
    // like that lane's bug. `addStatic` re-creates the collider from LEVEL's own
    // authored def and re-registers it with destruction on the way through.
    services.physics.addStatic(staged.collider);
  }
  if (restore && services) {
    services.player.teleport(services.player.localEntity, restore.position, restore.yaw, restore.pitch);
  }
  pending = false;
  staged = null;
  restore = null;
}

/* -------------------------------------------------------------- observation */

/**
 * Stages the scenario on its first call, then watches the target and prints what
 * the rounds did. Registered at boot and inert until a 'WE' seed arms it — the
 * same shape as PHYS's scenario tick.
 *
 * Runs at `TickPhase.Cleanup`, after `TickPhase.Destruction` has flushed, so a
 * wall that fell this tick is already reported as fallen.
 */
export function tickWeaponsProving(ctx: TickCtx): void {
  if (pending) {
    pending = false;
    stageBreach(ctx.services);
    return;
  }
  const s = staged;
  if (!s) return;

  const destruction = ctx.services.destruction;
  const fraction = destruction.healthFraction(s.entity);
  const elapsed = ctx.tick - s.startedTick;

  if (!destruction.isIntact(s.entity)) {
    if (s.breached) return;
    s.breached = true;
    // The sightline is the mechanical payoff: what used to stop a bullet at
    // `range` now does not. Reporting the NEW blocking distance rather than a
    // bare yes/no matters, because a wall on a street has a building behind it
    // and "still blocked, but 14 m further back" is the honest reading of a
    // breach — it says the near wall is gone.
    const reach = s.range + SIGHTLINE_M;
    const stillBlocked = blocked(ctx.services, s.eye, s.aim, reach);
    const at = stillBlocked ? probe.distance : reach;
    report(
      `BREACHED by round ${s.hits + 1} after ${elapsed} ticks (${fmt(elapsed / 60)} s of held trigger) — ` +
        `chunks live ${destruction.stats.chunksLive}, debris budget ${fmt(destruction.stats.budgetUsed01)} — ` +
        `sightline along the same aim stopped at ${fmt(s.range)} m before, ` +
        `${stillBlocked ? `now stops at ${fmt(at)} m` : `now reaches past ${fmt(reach)} m`}`,
    );
    return;
  }
  if (fraction >= s.lastFraction - 1e-9) return;

  s.hits++;
  const lost = (s.lastFraction - fraction) * s.def.health;
  s.lastFraction = fraction;
  report(
    `hit ${s.hits} at t+${elapsed}: −${fmt(lost)} hp, ${fmt(fraction * 100)}% of ${s.def.health} left ` +
      `(${s.def.material}, chip threshold ${s.def.chipThreshold})`,
  );
}

/* ------------------------------------------------------------------ staging */

/**
 * Find the cheapest real destructible wall a shooter can actually stand in front
 * of, and stand in front of it.
 *
 * "Cheapest" is `DestructibleDef.health` ascending within the masonry family,
 * which is deterministic (LEVEL's collider list comes off a fixed-seed stream)
 * and keeps the capture inside a sane frame budget — a service rifle carries 30
 * rounds before a 2.95 s reload, and a proof that needs four magazines is a
 * proof nobody re-runs. Candidates are tried in that order and the first one
 * that passes a real raycast from a real standoff wins, so a wall sealed inside
 * a building cannot be chosen.
 */
function stageBreach(services: Services): void {
  const candidates: { def: StaticColliderDef; health: number; wall: boolean; index: number }[] = [];
  const colliders = services.level.collectColliders();
  for (let i = 0; i < colliders.length; i++) {
    const d = colliders[i]!;
    if (!d.destructible) continue;
    candidates.push({
      def: d,
      health: d.destructible.health,
      // A COVER WALL is the thing the brief asks about, and it has to be tall
      // enough to hold the aim: sustained fire climbs ~3.5° over a belt, which
      // at this standoff walks the point of impact half a metre up the face. A
      // 0.5 m sandbag course is off the top of itself by round twenty, and the
      // run then measures nothing while looking like it is working.
      wall: WALL_SURFACES.includes(d.surface) && halfHeightOf(d) >= 0.6,
      index: i,
    });
  }
  if (candidates.length === 0) {
    report(`FAIL: ${colliders.length} static colliders in the level, 0 of them destructible`);
    return;
  }
  // Walls before everything else, then weakest first, then collider order. Every
  // term is a stable integer or a boolean — no identity ordering anywhere.
  candidates.sort(
    (a, b) => Number(b.wall) - Number(a.wall) || a.health - b.health || a.index - b.index,
  );

  // Put EVERY destructible in the map back in the registration table, not only
  // the target — see note 2. Cover is built out of courses and bays, the aim
  // walks from one collider onto its neighbour under recoil, and a neighbour
  // that is a plain static reads as "the wall suddenly stopped taking damage".
  const restored = reregisterAll(candidates.map((c) => c.def), services);

  const centre = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const local = new THREE.Vector3();
  const inverse = new THREE.Matrix4();

  for (let n = 0; n < Math.min(candidates.length, MAX_CANDIDATES); n++) {
    const candidate = candidates[n]!;
    const collider = candidate.def;
    const destructible = collider.destructible!;
    collider.matrix.decompose(centre, quat, scale);
    inverse.copy(collider.matrix).invert();
    thinAxis(collider, normal).applyQuaternion(quat).normalize();
    // Aim at the LOWER HALF of the face, not the centre. Recoil is real here —
    // `aimPunch` deflects the rounds themselves, and the unrecovered share is
    // permanent climb the player would be pulling down against — so an aim
    // point at the centre walks off the top of the wall after twenty rounds and
    // the run silently stops measuring. Starting low turns the climb into a
    // stripe up the face, which is what sustained fire on a wall looks like.
    const aimAt = new THREE.Vector3(0, -halfHeightOf(collider) * 0.55, 0)
      .applyQuaternion(quat)
      .add(centre);

    // Both faces: a wall's thin axis has two sides and only one of them is
    // likely to be standable open ground.
    for (const sign of [1, -1]) {
      const stand = new THREE.Vector3().copy(aimAt).addScaledVector(normal, sign * STANDOFF_M);
      const ground = services.terrain.ready ? services.terrain.heightAt(stand.x, stand.z) : 0;
      const eye = new THREE.Vector3(stand.x, ground + services.player.state.eyeHeight, stand.z);
      const aim = new THREE.Vector3().copy(aimAt).sub(eye);
      const range = aim.length();
      if (range < 1e-3) continue;
      aim.multiplyScalar(1 / range);

      if (!services.physics.raycast(eye, aim, range + 1, SOLID, probe)) continue;
      if (probe.entity === NULL_ENTITY) continue;
      // The ray hit A destructible; make sure it hit THIS one, or the def of a
      // wall on the far side of the square would be registered onto the entity
      // of whatever happened to be in the way.
      local.copy(probe.point).applyMatrix4(inverse);
      if (!insideShape(collider, local)) continue;

      if (services.destruction.healthFraction(probe.entity) !== 1) continue;

      const local0 = services.player.localEntity;
      const before = services.player.state;
      restore = { position: before.position.clone(), yaw: before.yaw, pitch: before.pitch };
      services.player.teleport(
        local0,
        new THREE.Vector3(stand.x, ground, stand.z),
        yawOf(aim),
        pitchOf(aim),
      );
      staged = {
        entity: probe.entity,
        def: destructible,
        collider,
        eye,
        aim,
        range,
        startedTick: services.clock.tick,
        lastFraction: 1,
        hits: 0,
        breached: false,
      };
      report(
        `target "${destructible.id}" ${destructible.material} health=${destructible.health} ` +
          `chipThreshold=${destructible.chipThreshold} at (${fmt(centre.x)}, ${fmt(centre.y)}, ${fmt(centre.z)}); ` +
          `shooter ${fmt(range)} m away at (${fmt(eye.x)}, ${fmt(eye.y)}, ${fmt(eye.z)}); ` +
          `${restored}/${candidates.length} destructibles re-registered; ` +
          `sightline through the wall is ${blocked(services, eye, aim, STANDOFF_M + SIGHTLINE_M) ? 'BLOCKED' : 'open'}`,
      );
      return;
    }
  }
  report(`FAIL: none of ${candidates.length} destructibles had a standable firing position`);
}

/**
 * Put every destructible collider back in DESTRUCTION's registration table.
 *
 * The entity and body handles are not exposed anywhere in the contract, but a
 * ray hit carries both — so each collider is probed along its own thin axis from
 * just outside its own face, and whatever comes back, if the hit point really
 * lands on that collider, is that collider's body. Returns the count that took.
 *
 * ~260 short raycasts, once, at stage time. This is a harness workaround, not a
 * gameplay path: a live match never resets and never needs it.
 */
function reregisterAll(colliders: readonly StaticColliderDef[], services: Services): number {
  const centre = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const local = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  let count = 0;

  for (const collider of colliders) {
    const def = collider.destructible;
    if (!def) continue;
    collider.matrix.decompose(centre, quat, scale);
    inverse.copy(collider.matrix).invert();
    thinAxis(collider, normal).applyQuaternion(quat).normalize();
    for (const sign of [1, -1]) {
      const standoff = 0.75;
      from.copy(centre).addScaledVector(normal, sign * standoff);
      dir.copy(centre).sub(from).normalize();
      if (!services.physics.raycast(from, dir, standoff + 0.05, SOLID, probe)) continue;
      if (probe.entity === NULL_ENTITY) continue;
      local.copy(probe.point).applyMatrix4(inverse);
      if (!insideShape(collider, local)) continue;
      services.destruction.register(probe.entity, def, probe.body);
      count++;
      break;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ helpers */

/** Half the collider's own height, for placing an aim point low on its face. */
function halfHeightOf(def: StaticColliderDef): number {
  const shape = def.shape;
  if (shape.kind === 'box') return shape.half.y;
  if (shape.kind === 'cylinder') return shape.halfHeight;
  return 0;
}

/** The collider's own thinnest axis — the face a wall presents to a shooter. */
function thinAxis(def: StaticColliderDef, out: THREE.Vector3): THREE.Vector3 {
  const shape = def.shape;
  if (shape.kind === 'box') {
    const h = shape.half;
    if (h.z <= h.x && h.z <= h.y) return out.set(0, 0, 1);
    if (h.x <= h.y) return out.set(1, 0, 0);
    return out.set(0, 1, 0);
  }
  // A cylinder presents its curved side; any horizontal direction will do.
  return out.set(1, 0, 0);
}

/** Is `point`, already in the collider's local frame, on this collider? */
function insideShape(def: StaticColliderDef, point: Vec3): boolean {
  const shape = def.shape;
  const slack = 0.08;
  if (shape.kind === 'box') {
    return (
      Math.abs(point.x) <= shape.half.x + slack &&
      Math.abs(point.y) <= shape.half.y + slack &&
      Math.abs(point.z) <= shape.half.z + slack
    );
  }
  if (shape.kind === 'cylinder') {
    return (
      Math.hypot(point.x, point.z) <= shape.radius + slack &&
      Math.abs(point.y) <= shape.halfHeight + slack
    );
  }
  return false;
}

/** Is anything solid between `from` and `from + dir * distance`? */
function blocked(services: Services, from: Vec3, dir: Vec3, distance: number): boolean {
  return services.physics.raycast(from, dir, distance, SOLID, probe);
}

/** Inverse of the `YXZ` aim basis in `weapons/system.ts`. */
function yawOf(dir: Vec3): number {
  return Math.atan2(-dir.x, -dir.z);
}

function pitchOf(dir: Vec3): number {
  return Math.asin(Math.max(-1, Math.min(1, dir.y)));
}

function fmt(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2);
}

/**
 * The proving ground's only output channel. `tools/capture.mjs` surfaces page
 * logs under `CAPTURE_VERBOSE=1` and FAILS the run on any console error, so this
 * is deliberately `log` — a proof that broke the capture tool for the other
 * fifteen lanes would be worse than no proof.
 */
function report(line: string): void {
  console.log(`[weapons.proving] ${line}`);
}
