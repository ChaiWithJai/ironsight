/**
 * The kinematic character controller. OWNER: PHYS.
 *
 * RAPIER IS A COLLIDE-AND-SLIDE SERVICE HERE, NOT A MOTION AUTHORITY. The caller
 * integrates acceleration, friction, gravity and air control itself, hands us a
 * desired delta, and applies what comes back. No force is ever applied to a
 * character body, which is why the player controller and the solver never fight.
 *
 * POSITION IS THE FEET. `CharacterController.position` is the point the capsule
 * stands on, not the capsule centre and not the eye. GAME derives eye height as
 * `position.y + capsuleHeight - EYE_DROP`, so anything else here puts the camera
 * inside the floor. The rigid body's origin is therefore at the feet too, and the
 * capsule collider carries a `+halfHeight + radius` offset — which also makes a
 * crouch resize trivial: change the collider, keep the body where it is, and the
 * feet do not move.
 *
 * THE FOUR THINGS THAT MAKE STAIRS FEEL RIGHT, AND THE ORDER THEY MATTER IN
 * ------------------------------------------------------------------------
 * 1. AUTOSTEP with a minimum landing width. Without the width test the capsule
 *    steps up onto a 4 cm ledge it cannot stand on and immediately falls off,
 *    which reads as jitter on every kerb in the map.
 * 2. SNAP-TO-GROUND on the way down. Walking off the top of a stair without it
 *    launches you into a ballistic arc down the whole flight; with it you stay
 *    glued and the camera stays level.
 * 3. A MAX CLIMB ANGLE and a slightly lower SLIDE angle. Equal angles make a
 *    capsule on a 50.0° face alternate between climbing and sliding every tick.
 *    The 6° hysteresis between them is what stops that oscillation.
 * 4. A NON-ZERO SKIN. rapier's `offset` is the gap kept between the capsule and
 *    the world; at zero the solver has no room to resolve and the capsule sticks
 *    in inside corners, at 10 cm the character visibly floats off walls. 2 cm.
 *
 * AND THE FIFTH, WHICH IS WHY THE PLAYER COULD NOT WALK UPHILL
 * -----------------------------------------------------------
 * A GROUNDED MOVE IS RE-AIMED ALONG THE FLOOR BEFORE THE SWEEP, AND THE CALLER'S
 * DOWNWARD GROUND-STICK IS NOT PASSED THROUGH. Both halves of that sentence are
 * load-bearing, and the second one is the bug a human found in ten minutes that
 * twelve rounds of screenshots could not.
 *
 * Callers integrate their own gravity and, while grounded, add a downward bias so
 * the capsule stays glued over a crest instead of launching off it. GAME's was
 * `snapToGroundDistance * 0.5` = 0.20 m PER TICK. Compare that with one tick of
 * walking: 3.34 m/s at 60 Hz is 0.056 m. The desired delta therefore pointed 74°
 * DOWNWARD, and collide-and-slide does exactly what it says — it projects that
 * vector onto the floor plane. On a slope of angle θ the downward part projects
 * to `stick·sin θ` pointing DOWNHILL, directly against the `h·cos θ` you asked
 * for. They cancel at `sin θ = h / stick` — 15.5° with those numbers.
 *
 * Measured in an isolated rapier rig with this exact capsule and config, metres
 * advanced in 2 s of holding forward (6.68 m is the request):
 *
 *     slope        0°    5°   10°   15°   20°   25°   30°   40°
 *     0.20 stick 6.71  4.56  2.41  0.28  0.04  0.04  0.03  0.02   <- shipped
 *     this file  6.68  6.57  6.40  6.37  6.29  6.21  6.14  6.06
 *
 * That is the whole reported bug: a wall you cannot see at a fifth of the 50°
 * the config advertises. It is NOT a tuning value, NOT a transposed heightfield
 * and NOT autostep — an isolated rapier world with one flat ramp and no terrain
 * at all reproduces it exactly.
 *
 * So while grounded on a climbable face we (a) rotate the horizontal request
 * onto the ground plane, which gives the sweep the vertical component it needs
 * to climb and makes a descent follow the ground instead of stepping off it,
 * and (b) replace whatever downward push the caller sent with ONE CENTIMETRE —
 * enough for rapier to register floor contact and to arm its own snap-to-ground
 * (which needs a downward remainder to fire, and which is the right tool for a
 * crest: it is a cast, not a slide, so it cannot steal horizontal speed).
 *
 * The same projection also fixes the mirror-image bug nobody reported: running
 * DOWNHILL, that 0.20 m stick projected into free speed. A 40° descent moved
 * 15.67 m in the 2 s a 6.68 m walk was asked for — 2.3× the sprint. It is now
 * 7.34 m.
 *
 * Two invariants this must not break, both verified in the same rig:
 *   · Faces steeper than `maxSlopeDeg` are left entirely alone, so they still
 *     slide the character down rather than becoming walkable cliffs.
 *   · A vertical wall still stops you dead, and a ledge still drops you.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  CollisionGroup,
  NULL_ENTITY,
  SurfaceId,
  type CharacterConfig,
  type CharacterController,
  type CharacterMoveResult,
  type EntityId,
  type QueryFilter,
  type RayHit,
  type Vec3,
} from '@/engine/types';
import { ALL_GROUPS, interactionGroups } from '@/physics/layers';
import type { BodyRecord, BodyTable } from '@/physics/bodies';
import type { QueryService } from '@/physics/queries';
import { freshRayHit } from '@/physics/bodies';

/** Below this cosine against up, a contact is a wall rather than a floor. */
const WALL_COS = 0.6;
/** Above this downward-facing cosine, a contact is a ceiling. */
const CEILING_COS = -0.5;

/**
 * Hysteresis between "climb this slope" and "slide down it", in degrees. Equal
 * angles make a capsule on a face at exactly the limit flip every tick.
 */
const SLIDE_HYSTERESIS_DEG = 6;

/**
 * How hard a grounded capsule is pressed into the floor, in metres per second.
 *
 * Expressed as a SPEED and multiplied by dt so the feel does not change with the
 * tick rate — a per-tick constant would be twice as strong at 30 Hz, which is
 * how a "works on my machine" slope bug is born. 0.6 m/s is 1 cm at 60 Hz.
 *
 * The floor on the useful range is set by rapier: with no downward remainder at
 * all its snap-to-ground never fires, and a sprint over a crest goes ballistic
 * (measured: 71 of 120 ticks airborne off a 40° brow at 7 m/s). The ceiling is
 * set by the slope projection above: every centimetre of stick costs
 * `sin θ` centimetres of forward travel on an uphill, so it must stay small
 * against one tick of walking (5.6 cm). 1 cm holds the capsule glued at 7 m/s
 * over a 40° crest — 0 airborne ticks — and costs 9% of top speed at 48°.
 */
const GROUND_STICK_SPEED = 0.6;
/** Clamps on the per-tick stick, so an absurd dt cannot unglue or wedge us. */
const GROUND_STICK_MIN = 0.005;
const GROUND_STICK_MAX = 0.02;

/** The one result object, mutable inside the lane and readonly outside it. */
type MutableMoveResult = { -readonly [K in keyof CharacterMoveResult]: CharacterMoveResult[K] };

export class KinematicCharacter implements CharacterController {
  readonly config: Readonly<CharacterConfig>;
  readonly position: Vec3;
  readonly groundNormal: Vec3 = new THREE.Vector3(0, 1, 0);

  grounded = false;
  groundSurface: SurfaceId = SurfaceId.Sand;

  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly record: BodyRecord;
  private readonly collider: RAPIER.Collider;
  private readonly filterGroups: number;
  private readonly result: MutableMoveResult;
  private readonly collision = new RAPIER.CharacterCollision();
  private readonly groundHit: RayHit = freshRayHit();
  private readonly groundFilter: QueryFilter;
  private readonly probeOrigin = new THREE.Vector3();
  private readonly probeDown = new THREE.Vector3(0, -1, 0);
  private readonly nextPos = new THREE.Vector3();
  private readonly desired = new RAPIER.Vector3(0, 0, 0);

  private height: number;
  private disposed = false;
  /**
   * Cosine of `maxSlopeDeg` against up. A face flatter than this is one we are
   * allowed to walk on, and therefore one whose plane we may re-aim a move onto.
   */
  private readonly climbCos: number;
  /**
   * Is `groundNormal` a normal we actually measured this tick, or the (0,1,0)
   * placeholder? Re-aiming a move onto a plane we only assumed is how a capsule
   * ends up walking on air across a gully, so the projection is skipped unless
   * either a contact or the ground probe below produced a real normal.
   */
  private groundNormalMeasured = false;

  constructor(
    private readonly world: RAPIER.World,
    private readonly table: BodyTable,
    private readonly queries: QueryService,
    config: CharacterConfig,
    simSeconds: number,
  ) {
    this.config = config;
    this.position = config.position.clone();
    this.height = config.standHeight;
    this.groundFilter = {
      groups: config.collidesWith & ~CollisionGroup.Character,
      solid: true,
      excludeEntity: config.entity,
    };

    const radius = config.radius;
    this.climbCos = Math.cos(THREE.MathUtils.degToRad(config.maxSlopeDeg));
    const halfHeight = Math.max(0.02, (config.standHeight - radius * 2) * 0.5);
    this.record = table.create(
      {
        mode: 'character',
        entity: config.entity,
        position: this.position,
        shapes: [
          {
            kind: 'capsule',
            halfHeight,
            radius,
            // Body origin at the feet; the capsule sits entirely above it.
            offset: new THREE.Vector3(0, halfHeight + radius, 0),
          },
        ],
        surface: SurfaceId.Kevlar,
        group: config.group,
        collidesWith: config.collidesWith,
        canSleep: false,
      },
      simSeconds,
    );
    this.collider = this.record.colliders[0];
    this.filterGroups = interactionGroups(ALL_GROUPS, config.collidesWith);

    const ctrl = world.createCharacterController(config.skinWidth);
    ctrl.setUp({ x: 0, y: 1, z: 0 });
    ctrl.setSlideEnabled(true);
    ctrl.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(config.maxSlopeDeg));
    ctrl.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(Math.max(0, config.maxSlopeDeg - SLIDE_HYSTERESIS_DEG)));
    // The minimum landing width is the thing that stops stair jitter: a step is
    // only climbable if there is somewhere to stand at the top of it.
    ctrl.enableAutostep(config.stepHeight, config.radius * 0.7, true);
    ctrl.enableSnapToGround(config.snapToGroundDistance);
    ctrl.setApplyImpulsesToDynamicBodies(true);
    // 80 kg soldier. Debris the character walks into gets shoved rather than
    // acting as an immovable wall, which is what sells the two systems as one.
    ctrl.setCharacterMass(80);
    ctrl.setNormalNudgeFactor(1e-4);
    this.controller = ctrl;

    this.result = {
      translation: new THREE.Vector3(),
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundSurface: SurfaceId.Sand,
      groundEntity: NULL_ENTITY,
      hitWall: false,
      wallNormal: new THREE.Vector3(),
      slideRatio: 1,
      steppedUp: 0,
      ceilingHit: false,
    };
  }

  get body(): BodyRecord {
    return this.record;
  }

  move(desiredDelta: Vec3, dt: number): CharacterMoveResult {
    const r = this.result;
    if (this.disposed) {
      r.translation.set(0, 0, 0);
      return r;
    }
    this.aimAlongGround(desiredDelta, dt);

    this.controller.computeColliderMovement(
      this.collider,
      this.desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      this.filterGroups,
    );

    const moved = this.controller.computedMovement();
    r.translation.set(moved.x, moved.y, moved.z);
    this.position.add(r.translation);
    this.nextPos.copy(this.position);
    // Position-based kinematic: rapier interpolates the body to this target
    // during the step and pushes dynamics out of the way on the way.
    this.record.body.setNextKinematicTranslation(this.nextPos);

    r.grounded = this.controller.computedGrounded();
    r.hitWall = false;
    r.ceilingHit = false;
    r.wallNormal.set(0, 0, 0);
    r.groundNormal.set(0, 1, 0);

    let bestGroundY = WALL_COS;
    this.groundNormalMeasured = false;
    const collisions = this.controller.numComputedCollisions();
    for (let i = 0; i < collisions; i++) {
      const c = this.controller.computedCollision(i, this.collision);
      if (!c) continue;
      const n = c.normal1;
      if (n.y > bestGroundY) {
        bestGroundY = n.y;
        r.groundNormal.set(n.x, n.y, n.z);
        this.groundNormalMeasured = true;
      } else if (n.y < CEILING_COS) {
        r.ceilingHit = true;
      } else if (Math.abs(n.y) < WALL_COS && !r.hitWall) {
        r.hitWall = true;
        r.wallNormal.set(n.x, n.y, n.z);
      }
    }

    // Horizontal only: a grounded character always loses its vertical component
    // to the floor, and counting that as "blocked" would report a slide ratio of
    // zero every tick you spend standing still.
    const wantH = Math.hypot(desiredDelta.x, desiredDelta.z);
    const gotH = Math.hypot(r.translation.x, r.translation.z);
    r.slideRatio = wantH > 1e-5 ? Math.min(1, gotH / wantH) : 1;
    // Anything rapier gave us above what we asked for on Y came from autostep —
    // measured against what we ASKED FOR, which after `aimAlongGround` already
    // contains the rise of the slope, so climbing a ramp is not read as a step.
    r.steppedUp = r.grounded ? Math.max(0, r.translation.y - this.desired.y) : 0;

    this.grounded = r.grounded;
    this.groundNormal.copy(r.groundNormal);
    this.resolveGround(r);
    return r;
  }

  /**
   * Turn the caller's desired delta into the one we actually sweep with.
   *
   * See the header for why this exists. Three guards, each of which is a bug if
   * removed:
   *
   *   · NOT GROUNDED — in the air the caller's ballistic arc is the truth and
   *     there is no floor plane to aim along.
   *   · RISING — a jump must leave the ground, so anything with an upward
   *     component is passed through untouched.
   *   · TOO STEEP TO CLIMB — on a face beyond `maxSlopeDeg` the caller's push
   *     into the floor is exactly what makes rapier slide the character down it,
   *     and re-aiming there would turn a cliff into a staircase.
   *
   * `groundNormal` is last tick's, refreshed by `resolveGround` at the end of
   * every move, so it is the normal under the feet where they are standing now.
   * One tick of lag over a break in the ground is absorbed by snap-to-ground.
   */
  private aimAlongGround(d: Vec3, dt: number): void {
    this.desired.x = d.x;
    this.desired.y = d.y;
    this.desired.z = d.z;
    if (!this.grounded || !this.groundNormalMeasured || d.y > 0) return;
    const n = this.groundNormal;
    if (n.y <= this.climbCos) return;
    // The y that keeps the feet exactly on the plane through the current
    // contact: positive going uphill, negative going downhill, zero on the flat.
    const rise = -(d.x * n.x + d.z * n.z) / n.y;
    const stick = Math.min(GROUND_STICK_MAX, Math.max(GROUND_STICK_MIN, GROUND_STICK_SPEED * dt));
    this.desired.y = rise - stick;
  }

  /**
   * One short ray from just above the feet finds WHAT we are standing on. The
   * character controller reports a normal but not a material, and the material is
   * what makes a footstep on gravel sound different from one on a jetty.
   */
  private resolveGround(r: MutableMoveResult): void {
    if (!r.grounded) {
      r.groundSurface = this.groundSurface;
      r.groundEntity = NULL_ENTITY;
      return;
    }
    this.probeOrigin.copy(this.position);
    this.probeOrigin.y += this.config.skinWidth * 4;
    const reach = this.config.skinWidth * 4 + this.config.snapToGroundDistance + 0.05;
    if (this.queries.raycast(this.probeOrigin, this.probeDown, reach, this.groundFilter, this.groundHit)) {
      r.groundSurface = this.groundHit.surface;
      r.groundEntity = this.groundHit.entity;
      this.groundSurface = this.groundHit.surface;
      if (this.groundHit.normal.y > 0.2) {
        // Better than a contact normal for the slope projection too: a capsule
        // resting in the crease between two heightfield triangles reports the
        // normal of whichever one it happened to touch, while the probe reports
        // the surface directly under the feet.
        r.groundNormal.copy(this.groundHit.normal);
        this.groundNormal.copy(this.groundHit.normal);
        this.groundNormalMeasured = true;
      }
    } else {
      r.groundSurface = this.groundSurface;
      r.groundEntity = NULL_ENTITY;
    }
  }

  teleport(position: Vec3): void {
    this.position.copy(position);
    // Every entry point is disposal-safe. A stale controller reaching into the
    // wasm heap does not throw a JS error — it traps, kills the frame and takes
    // the capture with it, with a stack that names rapier rather than the caller.
    if (this.disposed) return;
    this.nextPos.copy(position);
    this.record.body.setTranslation(this.nextPos, true);
    this.record.body.setNextKinematicTranslation(this.nextPos);
    this.grounded = false;
    // The ground under the old feet says nothing about the ground under the new
    // ones, and a mantle ends with the capsule over a ledge it has never touched.
    this.groundNormalMeasured = false;
    this.groundNormal.set(0, 1, 0);
  }

  /**
   * Crouch / prone / stand resize, feet-anchored.
   *
   * GROWING IS A QUESTION, NOT A COMMAND: standing up under a table has to fail,
   * and it has to fail without having briefly put the capsule inside the table.
   * So the taller capsule is tested with an overlap query FIRST and the collider
   * is only touched once the answer is known.
   */
  setHeight(height: number): boolean {
    if (this.disposed) return false;
    const r = this.config.radius;
    const target = Math.max(r * 2 + 0.02, Math.min(this.config.standHeight, height));
    const newHalf = (target - r * 2) * 0.5;
    if (target > this.height + 1e-4 && !this.fits(newHalf, r)) return false;
    this.collider.setHalfHeight(newHalf);
    this.collider.setTranslationWrtParent({ x: 0, y: newHalf + r, z: 0 });
    this.height = target;
    return true;
  }

  /** Is there room for a capsule of this size, standing on our feet? */
  private fits(halfHeight: number, radius: number): boolean {
    const shape = new RAPIER.Capsule(halfHeight, radius);
    const pos = {
      x: this.position.x,
      y: this.position.y + halfHeight + radius,
      z: this.position.z,
    };
    const blocker = this.world.intersectionWithShape(
      pos,
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      interactionGroups(ALL_GROUPS, this.config.collidesWith & ~CollisionGroup.Character),
      this.collider,
      this.record.body,
    );
    return blocker === null;
  }

  get entity(): EntityId {
    return this.config.entity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.removeCharacterController(this.controller);
    this.table.destroy(this.record.handle);
  }
}
