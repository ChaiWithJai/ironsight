/**
 * GAME — the locomotion integrator. ONE code path, for the local human and for
 * every bot (architecture decision #6).
 *
 * OWNER: GAME.
 *
 * WHAT THIS FILE IS
 * -----------------
 * `stepActor()` turns one `PlayerIntent` into one `CharacterController.move()`.
 * Everything between those two points — acceleration and friction curves, the
 * stance machine, jump arcs, vault and mantle, slide momentum, lean, stamina,
 * and the camera feel that falls out of all of it — lives here.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a collision solver. Rapier is a collide-and-slide SERVICE: we
 * integrate acceleration ourselves, ask for a delta, and apply WHAT COMES BACK.
 * No force is ever applied to a character body, and the returned translation —
 * not the requested one — is what velocity is reconciled against, so running
 * into a wall actually stops you instead of storing speed for the moment you
 * turn away.
 *
 * THE FEEL RULES, in the order they get broken
 * --------------------------------------------
 *  1. Acceleration and friction are separate curves. Stopping is snappier than
 *     starting, because stopping is a skill and starting is a decision.
 *  2. Air control may STEER but never ACCELERATE (`AIR_WISH_SPEED_CAP`). A jump
 *     commits you to your take-off vector.
 *  3. Every state change costs time. Stance transitions, slide entry, vault and
 *     the stand-up after prone are all real durations with real capsule sizes,
 *     never instant flag flips.
 *  4. The camera is a passenger. Eye height follows the capsule, the landing dip
 *     is a spring driven by impact speed, the step motion is sub-centimetre and
 *     the roll is barely a degree. If a viewer can describe the effect, it is
 *     too big.
 */
import * as THREE from 'three';
import {
  Btn,
  CollisionGroup,
  HitZone,
  LAYER_SOLID,
  MoveMode,
  Stance,
  SurfaceId,
  Sim,
  type BodyHandle,
  type CharacterConfig,
  type CharacterController,
  type EntityId,
  type IntentSource,
  type PlayerIntent,
  type PlayerState,
  type RayHit,
  type TickCtx,
  type Team,
  type Vec3,
} from '@/engine/types';
import { clamp, clamp01, damp, DEG2RAD, lerp } from '@/engine/math/curves';
import { impulse, integrateSpring, type Spring1 } from '@/engine/math/spring';
import {
  ADS_SPEED_SCALE,
  AIR_ACCEL,
  AIR_DRAG,
  AIR_WISH_SPEED_CAP,
  AUTO_VAULT_SPEED,
  BACKPEDAL_SCALE,
  CAPSULE,
  CAPSULE_HEIGHT,
  COYOTE_TICKS,
  EYE_DROP,
  GRAVITY_SCALE,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_BUFFER_TICKS,
  JUMP_COOLDOWN,
  JUMP_HEIGHT,
  JUMP_STAMINA_COST,
  LEAN_TIME,
  MANTLE_DURATION,
  MANTLE_EXIT_SPEED,
  MANTLE_MAX_HEIGHT,
  SLIDE_COOLDOWN,
  SLIDE_ENTRY_BOOST,
  SLIDE_ENTRY_SPEED,
  SLIDE_EXIT_SPEED,
  SLIDE_FRICTION,
  SLIDE_MAX_SPEED,
  SLIDE_MAX_TIME,
  SLIDE_SLOPE_ACCEL,
  SLIDE_STEER_RATE,
  SPRINT_MULTIPLIER,
  SPRINT_STAMINA_DRAIN,
  STAMINA_REGEN,
  STAMINA_REGEN_DELAY,
  STAMINA_SPRINT_UNLOCK,
  STANCE_SPEED,
  STANCE_TIME,
  STOP_SPEED,
  STRAFE_SCALE,
  SUPPRESSION_DECAY,
  TACTICAL_SPRINT_DELAY,
  TACTICAL_SPRINT_MULTIPLIER,
  TACTICAL_STAMINA_DRAIN,
  VAULT_DURATION,
  VAULT_EXIT_SPEED_SCALE,
  VAULT_LANDING_CLEARANCE,
  VAULT_MAX_HEIGHT,
  VAULT_MIN_HEIGHT,
  VAULT_REACH,
  VAULT_STAMINA_COST,
  VIEW,
} from '@/game/tuning';
import type { WorldProbe } from '@/game/probe';

/** Mutable mirror of the contract's read-only `PlayerState`. */
export type MutablePlayerState = { -readonly [K in keyof PlayerState]: PlayerState[K] };

/**
 * Pitch clamp. Not ±90°: at exactly vertical the yaw basis is degenerate and the
 * view rolls, which reads as a bug in whichever lane happens to be looking.
 */
const MAX_PITCH = 85 * DEG2RAD;

/** A traversal in flight. Vault and mantle differ only in numbers, not in code. */
interface Traverse {
  readonly kind: MoveMode.Vault | MoveMode.Mantle;
  t: number;
  readonly duration: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** Apex height above the higher of the two endpoints, metres. */
  readonly lift: number;
  readonly exitSpeed: number;
  readonly exitDir: Vec3;
}

/**
 * One controlled body. The local player and all 24 bots are the same struct in
 * the same array — that identity is the whole of decision #6, and every "why is
 * it different for bots" bug is prevented by there being nowhere for it to hide.
 */
export interface GameActor {
  readonly entity: EntityId;
  team: Team;
  source: IntentSource;
  readonly intent: PlayerIntent;
  readonly state: MutablePlayerState;
  readonly config: CharacterConfig;
  controller: CharacterController | null;

  /** Full 3D velocity, world space, metres/second. */
  readonly velocity: Vec3;
  /** Attach order index, so iteration and RNG draws are stable. */
  readonly slot: number;

  stance: Stance;
  stanceTarget: Stance;
  /** 0..1 through the current stance transition. 1 = settled. */
  stanceBlend: number;
  stanceFrom: Stance;
  capsuleHeight: number;

  mode: MoveMode;
  grounded: boolean;
  readonly groundNormal: Vec3;
  groundSurface: SurfaceId;
  coyote: number;
  jumpBuffer: number;
  jumpCooldown: number;
  airTime: number;

  sprintHeld: number;
  slideTimer: number;
  slideCooldown: number;
  readonly slideDir: Vec3;
  traverse: Traverse | null;

  lean: number;
  leanTarget: number;

  staminaDelay: number;

  /** Metres walked, for footfall cadence and head motion phase. */
  stepDistance: number;
  nextStepAt: number;

  /** Landing dip, metres (negative = eye drops). */
  readonly landDip: Spring1;
  viewRoll: number;
  /** Pending SIM aim punch, radians, applied at the top of the next tick. */
  punchPitch: number;
  punchYaw: number;

  /* --- life --------------------------------------------------------------- */
  downed: boolean;
  bleedout: number;
  reviveProgress: number;
  respawnAt: number;
  lastDamageTick: number;
  /** Attacker → damage dealt, for assist attribution. Small and short-lived. */
  readonly damagers: Map<number, number>;
  /**
   * Who earned an assist on THIS death, latched at the moment of the kill.
   * The sim bus is deferred, so the mode's `entity.killed` handler runs after
   * the ledger has been cleared; this is what it reads instead.
   */
  readonly assistCredit: EntityId[];
  lastKiller: EntityId;
}

const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_DELTA = new THREE.Vector3();

export function zeroIntent(): PlayerIntent {
  return {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    pressed: 0,
    released: 0,
    weaponSlot: -1,
    aimAt: null,
  };
}

/** Yaw basis. `+moveZ` is forward, `+moveX` is right — see `PlayerIntent`. */
export function forwardFromYaw(yaw: number, out: Vec3): Vec3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

export function rightFromYaw(yaw: number, out: Vec3): Vec3 {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw));
}

/** Full aim direction including pitch. Damage, vault probes and AI all use it. */
export function aimDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export function eyeHeightFor(capsuleHeight: number): number {
  return Math.max(0.24, capsuleHeight - EYE_DROP);
}

export function createActor(
  entity: EntityId,
  team: Team,
  source: IntentSource,
  slot: number,
  position: Vec3,
  yaw: number,
): GameActor {
  const capsuleHeight = CAPSULE.standHeight;
  return {
    entity,
    team,
    source,
    slot,
    intent: zeroIntent(),
    state: {
      entity,
      team,
      position: position.clone(),
      velocity: new THREE.Vector3(),
      eyeHeight: eyeHeightFor(capsuleHeight),
      yaw,
      pitch: 0,
      health: 100,
      stance: Stance.Stand,
      grounded: true,
      sprinting: false,
      alive: true,
      stamina: 1,
      suppression: 0,
      groundSpeed: 0,
      lean: 0,
      move: MoveMode.Idle,
      viewRoll: 0,
      downed: false,
      bleedout: 1,
    },
    config: {
      entity,
      radius: CAPSULE.radius,
      standHeight: CAPSULE.standHeight,
      crouchHeight: CAPSULE.crouchHeight,
      proneHeight: CAPSULE.proneHeight,
      position: position.clone(),
      skinWidth: CAPSULE.skinWidth,
      maxSlopeDeg: CAPSULE.maxSlopeDeg,
      stepHeight: CAPSULE.stepHeight,
      snapToGroundDistance: CAPSULE.snapToGroundDistance,
      group: CollisionGroup.Character,
      collidesWith: LAYER_SOLID,
    },
    controller: null,
    velocity: new THREE.Vector3(),
    stance: Stance.Stand,
    stanceTarget: Stance.Stand,
    stanceBlend: 1,
    stanceFrom: Stance.Stand,
    capsuleHeight,
    mode: MoveMode.Idle,
    grounded: true,
    groundNormal: new THREE.Vector3(0, 1, 0),
    groundSurface: SurfaceId.Sand,
    coyote: COYOTE_TICKS,
    jumpBuffer: 0,
    jumpCooldown: 0,
    airTime: 0,
    sprintHeld: 0,
    slideTimer: 0,
    slideCooldown: 0,
    slideDir: new THREE.Vector3(),
    traverse: null,
    lean: 0,
    leanTarget: 0,
    staminaDelay: 0,
    stepDistance: 0,
    nextStepAt: VIEW.strideWalk * 0.5,
    landDip: { value: 0, velocity: 0 },
    viewRoll: 0,
    punchPitch: 0,
    punchYaw: 0,
    downed: false,
    bleedout: 1,
    reviveProgress: 0,
    respawnAt: -1,
    lastDamageTick: -1000,
    damagers: new Map<number, number>(),
    assistCredit: [],
    lastKiller: 0 as EntityId,
  };
}

/** Reset an actor to a clean spawn state without reallocating it. */
export function respawnActor(actor: GameActor, position: Vec3, yaw: number): void {
  const s = actor.state;
  s.position.copy(position);
  s.velocity.set(0, 0, 0);
  s.yaw = yaw;
  s.pitch = 0;
  s.health = 100;
  s.alive = true;
  s.downed = false;
  s.bleedout = 1;
  s.stamina = 1;
  s.suppression = 0;
  s.groundSpeed = 0;
  s.lean = 0;
  s.stance = Stance.Stand;
  s.sprinting = false;
  s.grounded = true;
  s.move = MoveMode.Idle;
  s.viewRoll = 0;
  s.eyeHeight = eyeHeightFor(CAPSULE.standHeight);
  actor.velocity.set(0, 0, 0);
  actor.stance = Stance.Stand;
  actor.stanceTarget = Stance.Stand;
  actor.stanceFrom = Stance.Stand;
  actor.stanceBlend = 1;
  actor.capsuleHeight = CAPSULE.standHeight;
  actor.mode = MoveMode.Idle;
  actor.grounded = true;
  actor.groundNormal.set(0, 1, 0);
  actor.coyote = COYOTE_TICKS;
  actor.jumpBuffer = 0;
  actor.jumpCooldown = 0;
  actor.airTime = 0;
  actor.sprintHeld = 0;
  actor.slideTimer = 0;
  actor.slideCooldown = 0;
  actor.traverse = null;
  actor.lean = 0;
  actor.leanTarget = 0;
  actor.staminaDelay = 0;
  actor.stepDistance = 0;
  actor.nextStepAt = VIEW.strideWalk * 0.5;
  actor.landDip.value = 0;
  actor.landDip.velocity = 0;
  actor.viewRoll = 0;
  actor.punchPitch = 0;
  actor.punchYaw = 0;
  actor.downed = false;
  actor.bleedout = 1;
  actor.reviveProgress = 0;
  actor.respawnAt = -1;
  actor.damagers.clear();
  actor.assistCredit.length = 0;
  actor.controller?.teleport(position);
  actor.controller?.setHeight(CAPSULE.standHeight);
}

/* ========================================================================== *
 * THE TICK
 * ========================================================================== */

export interface LocomotionHooks {
  /** Camera trauma for the LOCAL player only — bots do not shake the camera. */
  trauma(actor: GameActor, amount: number, frequencyHz: number): void;
  /** Fall damage, resolved through the damage model so scoring stays in one place. */
  fallDamage(actor: GameActor, impactSpeed: number, ctx: TickCtx): void;
}

export function stepActor(actor: GameActor, ctx: TickCtx, probe: WorldProbe, hooks: LocomotionHooks): void {
  const dt = ctx.dt;
  const s = actor.state;
  const i = actor.intent;

  applyLook(actor, i, dt);

  // Suppression always decays, alive or not — a corpse is not suppressed.
  s.suppression = Math.max(0, s.suppression - SUPPRESSION_DECAY * dt);

  if (!s.alive) {
    actor.mode = MoveMode.Dead;
    s.move = MoveMode.Dead;
    s.groundSpeed = 0;
    actor.velocity.set(0, 0, 0);
    s.velocity.set(0, 0, 0);
    return;
  }

  if (actor.traverse) {
    stepTraverse(actor, ctx, probe);
    finaliseView(actor, ctx, probe, hooks);
    return;
  }

  actor.jumpCooldown = Math.max(0, actor.jumpCooldown - dt);
  actor.slideCooldown = Math.max(0, actor.slideCooldown - dt);
  actor.coyote = actor.grounded ? COYOTE_TICKS : Math.max(0, actor.coyote - 1);
  actor.jumpBuffer = Math.max(0, actor.jumpBuffer - 1);
  if ((i.pressed & Btn.Jump) !== 0) actor.jumpBuffer = JUMP_BUFFER_TICKS;

  updateStance(actor, i, probe, dt);

  // The wish direction, in world space, resolved AGAINST THIS TICK'S yaw so a
  // bot that turns and walks in the same tick goes where it is looking.
  const wish = TMP_A.set(0, 0, 0);
  let wishMagnitude = Math.hypot(i.moveX, i.moveZ);
  if (wishMagnitude > 1) {
    // Producers normalise to a unit disc; clamp defensively so a bad producer
    // cannot hand out a diagonal speed bonus.
    wishMagnitude = 1;
  }
  if (wishMagnitude > 1e-3) {
    const nx = i.moveX / Math.max(wishMagnitude, 1e-6);
    const nz = i.moveZ / Math.max(wishMagnitude, 1e-6);
    forwardFromYaw(s.yaw, TMP_B).multiplyScalar(nz);
    wish.copy(TMP_B);
    rightFromYaw(s.yaw, TMP_B).multiplyScalar(nx);
    wish.add(TMP_B);
    if (wish.lengthSq() > 1e-8) wish.normalize();
  }

  const forwardIntent = i.moveZ;
  const wantsSprint =
    (i.buttons & Btn.Sprint) !== 0 &&
    forwardIntent > 0.35 &&
    actor.stance === Stance.Stand &&
    !actor.downed &&
    s.stamina > (actor.mode === MoveMode.Sprint || actor.mode === MoveMode.TacticalSprint ? 0.001 : STAMINA_SPRINT_UNLOCK);

  actor.sprintHeld = wantsSprint ? actor.sprintHeld + dt : 0;
  const tactical = wantsSprint && actor.sprintHeld >= TACTICAL_SPRINT_DELAY && wishMagnitude > 0.9;

  maybeStartSlide(actor, i, wantsSprint, dt);
  maybeTraverse(actor, i, ctx, probe, wantsSprint);
  if (actor.traverse) {
    finaliseView(actor, ctx, probe, hooks);
    return;
  }

  const sliding = actor.slideTimer > 0;
  const speedTarget = targetSpeed(actor, i, wantsSprint, tactical, wishMagnitude);

  if (sliding) {
    stepSlide(actor, i, probe, dt);
  } else if (actor.grounded) {
    applyFriction(actor.velocity, GROUND_FRICTION, dt);
    accelerate(actor.velocity, wish, speedTarget, GROUND_ACCEL * speedTarget, dt);
  } else {
    // Air: steer only. `AIR_WISH_SPEED_CAP` is what makes a jump a commitment.
    accelerate(actor.velocity, wish, Math.min(speedTarget, AIR_WISH_SPEED_CAP), AIR_ACCEL * speedTarget, dt);
    actor.velocity.x -= actor.velocity.x * AIR_DRAG * dt;
    actor.velocity.z -= actor.velocity.z * AIR_DRAG * dt;
  }

  maybeJump(actor, hooks, dt);

  // Gravity. Never integrated while grounded, or the capsule accumulates
  // downward speed on a flat floor and the first step off a kerb is a plummet.
  if (!actor.grounded) {
    actor.velocity.y -= Sim.GRAVITY * GRAVITY_SCALE * dt;
  } else if (actor.velocity.y < 0) {
    actor.velocity.y = 0;
  }

  const wasGrounded = actor.grounded;
  const verticalBefore = actor.velocity.y;
  moveAndReconcile(actor, ctx, probe, dt);

  // Landing.
  if (!wasGrounded && actor.grounded) {
    const impactSpeed = -Math.min(0, verticalBefore);
    onLanded(actor, impactSpeed, ctx, hooks);
  }
  if (actor.grounded) actor.airTime = 0;
  else actor.airTime += dt;

  updateStamina(actor, wantsSprint, tactical, dt);
  updateLean(actor, i, dt);
  updateMode(actor, wantsSprint, tactical);
  updateFootsteps(actor, ctx, probe, dt);
  finaliseView(actor, ctx, probe, hooks);
}

/* ------------------------------------------------------------------- look */

function applyLook(actor: GameActor, i: PlayerIntent, dt: number): void {
  const s = actor.state;
  if (i.aimAt) {
    // Bots aim at a world point. AUTHORITATIVE: no rate limit and no smoothing
    // here, because the producer owns every bit of aim dynamics. Two smoothers
    // in series is a reaction time nobody can find.
    const dx = i.aimAt.x - s.position.x;
    const dy = i.aimAt.y - (s.position.y + s.eyeHeight);
    const dz = i.aimAt.z - s.position.z;
    const flat = Math.hypot(dx, dz);
    s.yaw = Math.atan2(-dx, -dz);
    s.pitch = clamp(Math.atan2(dy, Math.max(1e-4, flat)), -MAX_PITCH, MAX_PITCH);
  } else {
    s.yaw += i.lookYaw;
    s.pitch = clamp(s.pitch + i.lookPitch, -MAX_PITCH, MAX_PITCH);
  }
  // SIM recoil, applied after look so a shot deflects the aim the player just
  // made rather than the one they are about to make.
  if (actor.punchPitch !== 0 || actor.punchYaw !== 0) {
    s.pitch = clamp(s.pitch + actor.punchPitch, -MAX_PITCH, MAX_PITCH);
    s.yaw += actor.punchYaw;
    actor.punchPitch = 0;
    actor.punchYaw = 0;
  }
  void dt;
}

/* ------------------------------------------------------------------ speed */

function targetSpeed(
  actor: GameActor,
  i: PlayerIntent,
  sprinting: boolean,
  tactical: boolean,
  wishMagnitude: number,
): number {
  let speed = STANCE_SPEED[actor.stance];
  if (actor.downed) return 0.62; // a crawl, and only forward

  // Stance transitions cost speed while they are in flight: you cannot be at
  // full standing speed halfway out of prone.
  if (actor.stanceBlend < 1) {
    speed = lerp(STANCE_SPEED[actor.stanceFrom], STANCE_SPEED[actor.stanceTarget], actor.stanceBlend) * 0.82;
  }

  if (sprinting) speed *= tactical ? TACTICAL_SPRINT_MULTIPLIER : SPRINT_MULTIPLIER;
  else if ((i.buttons & Btn.Ads) !== 0) speed *= ADS_SPEED_SCALE;

  // Directional penalty from the raw intent, not the world vector, so it is
  // frame-of-reference free.
  if (!sprinting) {
    const back = Math.max(0, -i.moveZ);
    const side = Math.abs(i.moveX);
    const scale = lerp(1, BACKPEDAL_SCALE, back) * lerp(1, STRAFE_SCALE, side * (1 - back));
    speed *= scale;
  }

  // Stamina exhaustion bleeds a little top speed even when walking; a spent
  // soldier is slower, and it is felt before it is read off a bar.
  if (actor.state.stamina < 0.15) speed *= lerp(0.86, 1, actor.state.stamina / 0.15);

  return speed * clamp01(wishMagnitude / 0.98);
}

/**
 * Quake-family acceleration: only ever ADDS the difference between the current
 * projected speed and the target, so approaching top speed is asymptotic and
 * a direction change is instant. Forty years of shooters land here for a reason.
 */
function accelerate(velocity: Vec3, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): void {
  if (wishSpeed <= 1e-4 || wishDir.lengthSq() < 1e-8) return;
  const current = velocity.x * wishDir.x + velocity.z * wishDir.z;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const step = Math.min(accel * dt, add);
  velocity.x += wishDir.x * step;
  velocity.z += wishDir.z * step;
}

/**
 * Friction with a stop-speed floor. Without the floor the exponential tail never
 * reaches zero and the player skates the last half metre per second — the single
 * most common "why does this feel like ice" bug.
 */
function applyFriction(velocity: Vec3, friction: number, dt: number): void {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 1e-4) {
    velocity.x = 0;
    velocity.z = 0;
    return;
  }
  const control = Math.max(speed, STOP_SPEED);
  const drop = control * friction * dt;
  const scale = Math.max(0, speed - drop) / speed;
  velocity.x *= scale;
  velocity.z *= scale;
}

/* ----------------------------------------------------------------- stance */

function stanceTime(from: Stance, to: Stance): number {
  return STANCE_TIME[`${from}>${to}`] ?? 0.25;
}

function updateStance(actor: GameActor, i: PlayerIntent, probe: WorldProbe, dt: number): void {
  if (actor.downed) {
    actor.stanceTarget = Stance.Prone;
  } else if (actor.slideTimer > 0) {
    actor.stanceTarget = Stance.Crouch;
  } else {
    // Prone is a TOGGLE on the press edge — holding a key to stay on the floor
    // for a two-minute overwatch is not a thing anyone wants to do. Crouch is
    // held, because it is a momentary posture.
    const proneNow = actor.stanceTarget === Stance.Prone;
    const wantProne = (i.pressed & Btn.Prone) !== 0 ? !proneNow : proneNow;
    const wantCrouch = (i.buttons & Btn.Crouch) !== 0;
    const desired = wantProne ? Stance.Prone : wantCrouch ? Stance.Crouch : Stance.Stand;
    if (desired !== actor.stanceTarget) {
      // Standing up needs headroom. Blocked ⇒ stay where you are, silently, and
      // try again next tick — exactly what a player expects under a table.
      const targetHeight = CAPSULE_HEIGHT[desired];
      if (targetHeight > actor.capsuleHeight && !canOccupy(actor, probe, targetHeight)) {
        return;
      }
      actor.stanceFrom = actor.stance;
      actor.stanceTarget = desired;
      actor.stanceBlend = 0;
    }
  }

  if (actor.stanceTarget !== actor.stance || actor.stanceBlend < 1) {
    const duration = Math.max(0.01, stanceTime(actor.stanceFrom, actor.stanceTarget));
    actor.stanceBlend = clamp01(actor.stanceBlend + dt / duration);
    actor.capsuleHeight = lerp(
      CAPSULE_HEIGHT[actor.stanceFrom],
      CAPSULE_HEIGHT[actor.stanceTarget],
      // Ease-out: the body drops fast and settles, rather than moving linearly
      // like a lift. This is the difference between "crouched" and "shrank".
      1 - (1 - actor.stanceBlend) * (1 - actor.stanceBlend),
    );
    if (actor.stanceBlend >= 1) actor.stance = actor.stanceTarget;
    actor.controller?.setHeight(actor.capsuleHeight);
  }
  actor.state.stance = actor.stance;
}

function canOccupy(actor: GameActor, probe: WorldProbe, height: number): boolean {
  const controller = actor.controller;
  if (controller && probe.physicsReady) {
    // The controller owns the authoritative answer once rapier exists: it can
    // try the resize in place and report whether it was refused. Put the
    // capsule back either way — this is a QUESTION, not a state change.
    if (!controller.setHeight(height)) return false;
    controller.setHeight(actor.capsuleHeight);
    return true;
  }
  return probe.capsuleFits(actor.state.position, CAPSULE.radius, height, actor.entity);
}

/* ------------------------------------------------------------------ jump */

function maybeJump(actor: GameActor, hooks: LocomotionHooks, dt: number): void {
  if (actor.jumpBuffer <= 0 || actor.jumpCooldown > 0 || actor.downed) return;
  if (!actor.grounded && actor.coyote <= 0) return;
  if (actor.stance === Stance.Prone && actor.stanceBlend >= 1) return;
  if (actor.state.stamina < JUMP_STAMINA_COST) return;

  // v = sqrt(2·g·h). Authoring the HEIGHT rather than the impulse means the arc
  // is stable if gravity is ever retuned.
  actor.velocity.y = Math.sqrt(2 * Sim.GRAVITY * GRAVITY_SCALE * JUMP_HEIGHT);
  actor.grounded = false;
  actor.coyote = 0;
  actor.jumpBuffer = 0;
  actor.jumpCooldown = JUMP_COOLDOWN;
  actor.state.stamina = Math.max(0, actor.state.stamina - JUMP_STAMINA_COST);
  actor.staminaDelay = STAMINA_REGEN_DELAY;
  actor.slideTimer = 0;
  void hooks;
  void dt;
}

function onLanded(actor: GameActor, impactSpeed: number, ctx: TickCtx, hooks: LocomotionHooks): void {
  actor.velocity.y = 0;
  if (impactSpeed <= VIEW.landThreshold) return;

  const force = clamp01((impactSpeed - VIEW.landThreshold) / (VIEW.landFullSpeed - VIEW.landThreshold));
  // Spring IMPULSE rather than a set value: the dip's depth and its recovery
  // both fall out of the impact, so a stumble off a kerb and a drop from a roof
  // are the same code with different energy.
  impulse(actor.landDip, -force * VIEW.landMaxDip * 12);
  hooks.trauma(actor, force * VIEW.landMaxTrauma, 26);
  hooks.fallDamage(actor, impactSpeed, ctx);

  ctx.fx.emit('footstep', {
    entity: actor.entity,
    position: actor.state.position.clone(),
    surface: actor.groundSurface,
    running: true,
  });
}

/* ----------------------------------------------------------------- slide */

function maybeStartSlide(actor: GameActor, i: PlayerIntent, sprinting: boolean, dt: number): void {
  if (actor.slideTimer > 0) return;
  if ((i.pressed & Btn.Crouch) === 0) return;
  if (!actor.grounded || actor.slideCooldown > 0 || actor.downed) return;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  if (!sprinting || speed < SLIDE_ENTRY_SPEED) return;

  actor.slideTimer = SLIDE_MAX_TIME;
  actor.slideDir.set(actor.velocity.x, 0, actor.velocity.z).normalize();
  // The entry BOOST is what makes a slide worth doing: it is briefly the fastest
  // you ever move, which is what turns it into a traversal tool instead of a
  // crouch animation.
  const boosted = Math.min(speed * SLIDE_ENTRY_BOOST, SLIDE_MAX_SPEED);
  actor.velocity.x = actor.slideDir.x * boosted;
  actor.velocity.z = actor.slideDir.z * boosted;
  actor.stanceFrom = actor.stance;
  actor.stanceTarget = Stance.Crouch;
  actor.stanceBlend = 0;
  impulse(actor.landDip, -0.5);
  void dt;
}

function stepSlide(actor: GameActor, i: PlayerIntent, probe: WorldProbe, dt: number): void {
  actor.slideTimer -= dt;

  // Steering: a slide may be curved, not turned. The direction rotates toward
  // the input at a fixed rate, which is what lets a player round a corner
  // without it becoming a strafe.
  if (Math.abs(i.moveX) > 0.05) {
    const turn = -i.moveX * SLIDE_STEER_RATE * dt;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const x = actor.slideDir.x * cos - actor.slideDir.z * sin;
    const z = actor.slideDir.x * sin + actor.slideDir.z * cos;
    actor.slideDir.set(x, 0, z).normalize();
  }

  let speed = Math.hypot(actor.velocity.x, actor.velocity.z);

  // Slope: a slide down a ramp genuinely accelerates. `groundNormal` points away
  // from the surface, so its horizontal part IS the downhill direction.
  const downhill = TMP_B.set(actor.groundNormal.x, 0, actor.groundNormal.z);
  const slope = downhill.length();
  if (slope > 1e-3) {
    downhill.multiplyScalar(1 / slope);
    const along = downhill.dot(actor.slideDir);
    speed += along * slope * SLIDE_SLOPE_ACCEL * dt;
  }
  speed -= SLIDE_FRICTION * dt;
  speed = clamp(speed, 0, SLIDE_MAX_SPEED);

  actor.velocity.x = actor.slideDir.x * speed;
  actor.velocity.z = actor.slideDir.z * speed;

  const jumpOut = actor.jumpBuffer > 0 && actor.jumpCooldown <= 0;
  if (speed < SLIDE_EXIT_SPEED || actor.slideTimer <= 0 || !actor.grounded || jumpOut) {
    actor.slideTimer = 0;
    actor.slideCooldown = SLIDE_COOLDOWN;
    // Exiting a slide leaves you crouched: standing back up is a separate,
    // interruptible decision, and that is where the cost of sliding lives.
    actor.stanceFrom = actor.stance;
    actor.stanceTarget = Stance.Crouch;
    actor.stanceBlend = actor.stance === Stance.Crouch ? 1 : 0;
  }
  void probe;
}

/* ---------------------------------------------------------------- vault */

const PROBE_HIT: RayHit = {
  hit: false,
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  surface: SurfaceId.Concrete,
  body: 0 as BodyHandle,
  entity: 0 as EntityId,
  zone: HitZone.None,
  backface: false,
};

const PROBE_ORIGIN = new THREE.Vector3();
const PROBE_DIR = new THREE.Vector3();
const PROBE_LEDGE = new THREE.Vector3();

/**
 * Four rays, in this order, and the order matters:
 *
 *   1. FORWARD at shin height  — is there a face in front of me at all?
 *   2. DOWN from above the face — how high is its top edge?
 *   3. capsule fit ON the ledge — is there room to stand where I would land?
 *   4. capsule fit BEYOND it    — is there room to keep going, or is it a slot?
 *
 * Skipping 3 is how you mantle into a ceiling; skipping 4 is how you vault into
 * a one-brick-wide parapet with a fifty-metre drop behind it.
 */
function findLedge(actor: GameActor, probe: WorldProbe): { top: number; point: Vec3; mantle: boolean } | null {
  const s = actor.state;
  forwardFromYaw(s.yaw, PROBE_DIR);
  PROBE_ORIGIN.set(s.position.x, s.position.y + VAULT_MIN_HEIGHT * 0.6, s.position.z);
  if (!probe.raycast(PROBE_ORIGIN, PROBE_DIR, VAULT_REACH + CAPSULE.radius, PROBE_HIT, actor.entity)) return null;
  // A wall, not a ramp: a surface you can walk up is not a surface you vault.
  if (Math.abs(PROBE_HIT.normal.y) > 0.45) return null;

  const faceDistance = PROBE_HIT.distance;
  PROBE_LEDGE.set(
    s.position.x + PROBE_DIR.x * (faceDistance + CAPSULE.radius * 0.9),
    s.position.y + MANTLE_MAX_HEIGHT + 0.45,
    s.position.z + PROBE_DIR.z * (faceDistance + CAPSULE.radius * 0.9),
  );
  const down = TMP_B.set(0, -1, 0);
  if (!probe.raycast(PROBE_LEDGE, down, MANTLE_MAX_HEIGHT + 0.6, PROBE_HIT, actor.entity)) return null;

  const top = PROBE_HIT.point.y;
  const height = top - s.position.y;
  if (height < VAULT_MIN_HEIGHT || height > MANTLE_MAX_HEIGHT) return null;

  const landing = PROBE_HIT.point.clone();
  landing.y = top + 0.02;
  const standHeight = Math.max(CAPSULE.crouchHeight, actor.capsuleHeight);
  if (!probe.capsuleFits(landing, CAPSULE.radius * 0.9, standHeight, actor.entity)) return null;

  // Room to continue past the ledge. Half a metre is one more step.
  const beyond = landing.clone();
  beyond.x += PROBE_DIR.x * VAULT_LANDING_CLEARANCE;
  beyond.z += PROBE_DIR.z * VAULT_LANDING_CLEARANCE;
  if (!probe.capsuleFits(beyond, CAPSULE.radius * 0.8, CAPSULE.crouchHeight, actor.entity)) return null;

  return { top, point: landing, mantle: height > VAULT_MAX_HEIGHT };
}

function maybeTraverse(
  actor: GameActor,
  i: PlayerIntent,
  ctx: TickCtx,
  probe: WorldProbe,
  sprinting: boolean,
): void {
  if (actor.traverse || actor.downed) return;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  const pressedJump = actor.jumpBuffer > 0;
  const autoVault = sprinting && speed > AUTO_VAULT_SPEED && i.moveZ > 0.5;
  if (!pressedJump && !autoVault) return;
  if (i.moveZ <= 0.2) return; // you vault forwards, never sideways or backwards
  if (actor.state.stamina < VAULT_STAMINA_COST) return;

  const ledge = findLedge(actor, probe);
  if (!ledge) return;

  const mantle = ledge.mantle;
  const exitDir = forwardFromYaw(actor.state.yaw, new THREE.Vector3());
  const exitSpeed = mantle ? MANTLE_EXIT_SPEED : Math.max(speed * VAULT_EXIT_SPEED_SCALE, 2.4);
  const end = ledge.point.clone();
  end.x += exitDir.x * (mantle ? 0.32 : VAULT_LANDING_CLEARANCE);
  end.z += exitDir.z * (mantle ? 0.32 : VAULT_LANDING_CLEARANCE);

  actor.traverse = {
    kind: mantle ? MoveMode.Mantle : MoveMode.Vault,
    t: 0,
    duration: mantle ? MANTLE_DURATION : VAULT_DURATION,
    start: actor.state.position.clone(),
    end,
    // A vault ARCS: the body swings over the obstacle rather than teleporting
    // along a chord, and the lift is what sells the weight.
    lift: mantle ? 0.1 : 0.22,
    exitSpeed,
    exitDir,
  };
  actor.mode = actor.traverse.kind;
  actor.jumpBuffer = 0;
  actor.slideTimer = 0;
  actor.velocity.set(0, 0, 0);
  actor.state.stamina = Math.max(0, actor.state.stamina - VAULT_STAMINA_COST);
  actor.staminaDelay = STAMINA_REGEN_DELAY;
  ctx.fx.emit('footstep', {
    entity: actor.entity,
    position: actor.state.position.clone(),
    surface: actor.groundSurface,
    running: true,
  });
}

function stepTraverse(actor: GameActor, ctx: TickCtx, probe: WorldProbe): void {
  const t = actor.traverse;
  if (!t) return;
  t.t = Math.min(1, t.t + ctx.dt / t.duration);
  // Ease-in-out on the horizontal, so the hand-plant reads as a beat: fast off
  // the ground, slow over the top, fast down the far side.
  const e = t.t * t.t * (3 - 2 * t.t);
  const x = lerp(t.start.x, t.end.x, e);
  const z = lerp(t.start.z, t.end.z, e);
  const baseY = lerp(t.start.y, t.end.y, e);
  const arc = Math.sin(Math.PI * t.t) * t.lift;

  const s = actor.state;
  s.position.set(x, baseY + arc, z);
  // Root motion with collision suspended. The ledge probe already proved the
  // whole path is clear — asking collide-and-slide to carry the capsule THROUGH
  // the obstacle it is climbing is asking it to fail, which is why every shipped
  // game does this exact thing.
  actor.controller?.teleport(s.position);
  actor.config.position.copy(s.position);
  actor.grounded = false;
  actor.mode = t.kind;
  s.move = t.kind;
  s.grounded = false;
  s.groundSpeed = (t.start.distanceTo(t.end) / t.duration) * 0.6;

  if (t.t >= 1) {
    actor.velocity.set(t.exitDir.x * t.exitSpeed, 0, t.exitDir.z * t.exitSpeed);
    actor.traverse = null;
    actor.grounded = true;
    actor.coyote = COYOTE_TICKS;
    // A mantle leaves you crouched on the ledge; a vault leaves you running.
    if (t.kind === MoveMode.Mantle) {
      actor.stanceFrom = actor.stance;
      actor.stanceTarget = Stance.Crouch;
      actor.stanceBlend = 0;
    }
    impulse(actor.landDip, t.kind === MoveMode.Mantle ? -0.8 : -0.4);
    void probe;
  }
}

/* --------------------------------------------------------------- movement */

/**
 * The one call into PHYS, plus the reconciliation that follows it.
 *
 * `CharacterMoveResult.translation` is what rapier PERMITTED. Velocity is
 * rebuilt from it whenever a wall was hit, so pushing into a corner actually
 * costs you your speed instead of banking it for the moment you turn away —
 * the classic "stuck then slingshot" bug.
 */
function moveAndReconcile(actor: GameActor, ctx: TickCtx, probe: WorldProbe, dt: number): void {
  const s = actor.state;
  TMP_DELTA.copy(actor.velocity).multiplyScalar(dt);

  // Ground stick: while grounded, push slightly INTO the floor so a downhill
  // step does not launch the capsule off every crest.
  if (actor.grounded && actor.velocity.y <= 0) {
    TMP_DELTA.y -= CAPSULE.snapToGroundDistance * 0.5;
  }

  const controller = actor.controller;
  if (controller) {
    const result = controller.move(TMP_DELTA, dt);
    s.position.copy(controller.position);
    actor.grounded = result.grounded;
    actor.groundNormal.copy(result.groundNormal);
    actor.groundSurface = result.groundSurface;
    if (result.hitWall && dt > 0) {
      actor.velocity.x = result.translation.x / dt;
      actor.velocity.z = result.translation.z / dt;
    }
    if (result.ceilingHit && actor.velocity.y > 0) actor.velocity.y = 0;
  } else {
    s.position.add(TMP_DELTA);
  }

  if (!probe.physicsReady) {
    resolveAnalytic(actor, probe);
  }

  if (actor.grounded && actor.velocity.y < 0) actor.velocity.y = 0;
  actor.config.position.copy(s.position);
  s.velocity.copy(actor.velocity);
  s.groundSpeed = Math.hypot(actor.velocity.x, actor.velocity.z);
  s.grounded = actor.grounded;
  void ctx;
}

/**
 * Ground and obstacle resolution while `PhysicsService.ready` is false.
 *
 * The null character controller floors the capsule at y = 0 and knows nothing
 * about the map, so without this every actor stands in a hole wherever the
 * ground is not at sea level. Resolving against `MACRO_TERRAIN` and the demo box
 * set is exactly what the null `PlayerService` did, and it means a scenario
 * posed today is framed identically once rapier lands.
 */
function resolveAnalytic(actor: GameActor, probe: WorldProbe): void {
  const s = actor.state;

  // Horizontal push-out from analytic boxes, with a step-up allowance so a kerb
  // is climbed rather than treated as a wall.
  for (const box of probe.analyticBoxes) {
    const r = CAPSULE.radius;
    if (s.position.x + r <= box.min.x || s.position.x - r >= box.max.x) continue;
    if (s.position.z + r <= box.min.z || s.position.z - r >= box.max.z) continue;
    const top = box.max.y;
    if (s.position.y >= top - 0.01 || s.position.y + actor.capsuleHeight <= box.min.y) continue;
    if (top - s.position.y <= CAPSULE.stepHeight) continue; // step up, handled by the ground pass

    const penX = actor.velocity.x >= 0 ? box.min.x - (s.position.x + r) : box.max.x - (s.position.x - r);
    const penZ = actor.velocity.z >= 0 ? box.min.z - (s.position.z + r) : box.max.z - (s.position.z - r);
    if (Math.abs(penX) < Math.abs(penZ)) {
      s.position.x += penX;
      actor.velocity.x = 0;
    } else {
      s.position.z += penZ;
      actor.velocity.z = 0;
    }
  }

  const groundY = probe.groundHeightAt(s.position.x, s.position.z);
  if (s.position.y <= groundY + 0.02) {
    s.position.y = groundY;
    actor.grounded = true;
    actor.groundNormal.set(0, 1, 0);
    actor.groundSurface = probe.surfaceAt(s.position.x, s.position.z);
    if (actor.velocity.y < 0) actor.velocity.y = 0;
  } else if (s.position.y > groundY + 0.06) {
    actor.grounded = false;
  }
  actor.controller?.teleport(s.position);
}

/* -------------------------------------------------------- stamina + lean */

function updateStamina(actor: GameActor, sprinting: boolean, tactical: boolean, dt: number): void {
  const s = actor.state;
  if (sprinting && s.groundSpeed > 1.5) {
    s.stamina = Math.max(0, s.stamina - (tactical ? TACTICAL_STAMINA_DRAIN : SPRINT_STAMINA_DRAIN) * dt);
    actor.staminaDelay = STAMINA_REGEN_DELAY;
  } else if (actor.staminaDelay > 0) {
    actor.staminaDelay -= dt;
  } else {
    s.stamina = clamp01(s.stamina + STAMINA_REGEN * dt);
  }
  s.sprinting = sprinting && s.groundSpeed > 1.5;
}

function updateLean(actor: GameActor, i: PlayerIntent, dt: number): void {
  const blocked = actor.state.sprinting || actor.slideTimer > 0 || actor.stance === Stance.Prone || !actor.grounded;
  const want = blocked
    ? 0
    : ((i.buttons & Btn.LeanRight) !== 0 ? 1 : 0) - ((i.buttons & Btn.LeanLeft) !== 0 ? 1 : 0);
  actor.leanTarget = want;
  const rate = dt / Math.max(0.01, LEAN_TIME);
  actor.lean += clamp(actor.leanTarget - actor.lean, -rate, rate);
  actor.state.lean = actor.lean;
}

function updateMode(actor: GameActor, sprinting: boolean, tactical: boolean): void {
  let mode: MoveMode;
  if (actor.downed) mode = MoveMode.Downed;
  else if (actor.slideTimer > 0) mode = MoveMode.Slide;
  else if (!actor.grounded) mode = MoveMode.Air;
  else if (actor.stance === Stance.Prone) mode = MoveMode.Prone;
  else if (actor.stance === Stance.Crouch) mode = MoveMode.Crouch;
  else if (sprinting && actor.state.groundSpeed > 1.5) mode = tactical ? MoveMode.TacticalSprint : MoveMode.Sprint;
  else if (actor.state.groundSpeed > 0.35) mode = MoveMode.Walk;
  else mode = MoveMode.Idle;
  actor.mode = mode;
  actor.state.move = mode;
}

/* ------------------------------------------------------------- footsteps */

function updateFootsteps(actor: GameActor, ctx: TickCtx, probe: WorldProbe, dt: number): void {
  if (!actor.grounded || actor.state.groundSpeed < 0.4) return;
  actor.stepDistance += actor.state.groundSpeed * dt;
  const stride = actor.state.sprinting
    ? VIEW.strideSprint
    : actor.stance === Stance.Stand
      ? VIEW.strideWalk
      : VIEW.strideWalk * 0.72;
  if (actor.stepDistance < actor.nextStepAt) return;
  actor.nextStepAt = actor.stepDistance + stride;
  ctx.fx.emit('footstep', {
    entity: actor.entity,
    position: actor.state.position.clone(),
    surface: actor.groundSurface,
    running: actor.state.sprinting,
  });
  ctx.sim.emit('noise.emitted', {
    position: actor.state.position.clone(),
    // A sprinting boot on stone is ~62 dB at 1 m; a crouched step is nearly
    // inaudible, which is the whole reason to crouch.
    loudnessDb: actor.state.sprinting ? 62 : actor.stance === Stance.Stand ? 52 : 38,
    team: actor.team,
    source: actor.entity,
    kind: 'footstep',
  });
  void probe;
}

/* ------------------------------------------------------------ camera feel */

/**
 * Everything the camera reads, composed once, at the end of the tick.
 *
 * The CameraRig owns the transform; this owns the SIGNALS. Eye height carries
 * the stance blend, the landing dip and the step motion, because they are all
 * genuinely "where is the head", not cosmetic overlays — a crouching player's
 * eye must be where the collider says the head is or they can see over a wall
 * they are hiding behind.
 */
function finaliseView(actor: GameActor, ctx: TickCtx, probe: WorldProbe, hooks: LocomotionHooks): void {
  const dt = ctx.dt;
  const s = actor.state;

  integrateSpring(actor.landDip, 0, VIEW.landSpring, dt);
  // Clamp: an absurd impulse (a 40 m fall) must not put the eye under the floor.
  actor.landDip.value = clamp(actor.landDip.value, -VIEW.landMaxDip * 1.4, VIEW.landMaxDip * 0.5);

  const base = eyeHeightFor(actor.capsuleHeight);
  const slideDrop = actor.slideTimer > 0 ? VIEW.slideDrop : 0;

  // Step motion: a phase driven by DISTANCE, not time, so it stays in step with
  // the footfalls at every speed and stops dead when the player does.
  const stride = actor.state.sprinting ? VIEW.strideSprint : VIEW.strideWalk;
  const phase = (actor.stepDistance / Math.max(0.2, stride)) * Math.PI;
  const bobAmp = actor.grounded
    ? lerp(VIEW.stepBobWalk, VIEW.stepBobSprint, clamp01((s.groundSpeed - 2) / 4.5))
    : 0;
  const bobY = -Math.abs(Math.sin(phase)) * bobAmp;

  s.eyeHeight = damp(s.eyeHeight, base - slideDrop + bobY + actor.landDip.value, VIEW.eyeHalfLife, dt);

  // Roll. Strafe roll comes from the INTENT, not the velocity, so it leads the
  // movement by a frame the way a real head does.
  const strafe = clamp(actor.intent.moveX, -1, 1);
  let rollTarget = -strafe * VIEW.strafeRoll - actor.lean * VIEW.leanRoll;
  if (actor.slideTimer > 0) rollTarget -= VIEW.slideRoll;
  actor.viewRoll = damp(actor.viewRoll, rollTarget, VIEW.rollHalfLife, dt);
  s.viewRoll = actor.viewRoll;

  s.downed = actor.downed;
  s.bleedout = actor.bleedout;
  void probe;
  void hooks;
}
